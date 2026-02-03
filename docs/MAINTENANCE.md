# Maintenance Guide — Claude Web View

This document tracks key implementation patterns, edge cases, and maintenance notes for the Claude Web View codebase. Add entries when implementing tricky features or discovering non-obvious behaviors.

---

## State Management Patterns

### localStorage via zustand-persist

**Where**: `client/src/stores/uiStore.ts`

**What persists**:
- UI preferences (active conversation, gallery expanded/collapsed, show/hide toggles)
- Done conversations list
- Last working directory for "New Conversation" dialog
- **NEW**: Last seen message index per conversation (for NEW badge feature)

**Adding new persisted state**:
1. Add field to `UIState` interface
2. Initialize in store creation `(set, get) => ({ ... })`
3. Add to `partialize` function (line 133-142)
4. Bump `version` (currently 2)
5. Add migration in `migrate` function if shape changed

**Example** (from NEW badge feature):
```typescript
// 1. Add to interface
interface UIState {
  lastSeenMessageIndex: Record<string, number>;
  markMessagesSeen: (conversationId: string, messageIndex: number) => void;
}

// 2. Initialize
lastSeenMessageIndex: {},

// 3. Add to partialize
partialize: (state) => ({
  ...
  lastSeenMessageIndex: state.lastSeenMessageIndex,
}),

// 4. Bump version + migrate
version: 2,
migrate: (persistedState, version) => {
  if (version === 1) {
    return { ...persistedState, lastSeenMessageIndex: {} };
  }
  return persistedState;
}
```

---

## React Hooks: Call Order is Critical

**Rule**: ALL hooks must be called BEFORE any conditional `return` statement.

**Why**: React requires hooks to be called in the same order every render. If a hook is called after an early return, the hook count changes when the condition flips, causing React Error #310.

**Example — BAD**:
```tsx
function Chat() {
  const data = useStore((s) => s.data);

  if (!data) return <Loading />;  // early return

  // CRASH: these hooks only run when data is non-null
  const derived = useMemo(() => compute(data), [data]);
  return <div>{derived}</div>;
}
```

**Example — GOOD**:
```tsx
function Chat() {
  const data = useStore((s) => s.data);

  // ALL hooks before any early return
  const derived = useMemo(() => {
    if (!data) return undefined;
    return compute(data);
  }, [data]);

  if (!data) return <Loading />;
  return <div>{derived}</div>;
}
```

**How to spot during review**:
- Search for `return` statements inside component bodies that appear before the final `return`
- If any hook (`useState`, `useEffect`, `useMemo`, `useRef`, custom `use*`) appears after such a return, it's a bug

**Where this matters**:
- Components reading from stores that start `null` before async data arrives
- Components with loading states or permission checks

---

## IntersectionObserver Best Practices

**Use case**: Detecting when elements enter/exit viewport (e.g., NEW badge feature marks messages as seen when visible)

**Pattern** (from Chat.tsx):
```typescript
const elementRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) {
        // Element is visible
        onVisible();
      }
    },
    { threshold: 0.5 } // 50% of element must be visible
  );

  if (elementRef.current) {
    observer.observe(elementRef.current);
  }

  return () => observer.disconnect();
}, [dependencies]);
```

**Key points**:
- **Threshold**: `0.5` = 50% visible, `1.0` = fully visible, `0.0` = any pixel visible
- **Cleanup**: Always `disconnect()` in the return function
- **Ref check**: Guard `elementRef.current` before observing (might be null during first render)
- **Dependencies**: Include anything that changes what you're observing or what `onVisible` does

**When to use**:
- Lazy loading images
- Infinite scroll
- View tracking / analytics
- "Mark as read" functionality

**When NOT to use**:
- Measuring element dimensions → use `ResizeObserver` instead
- Tracking scroll position → use scroll events (but consider if you really need this)

---

## Zustand Store Best Practices

### Targeted Selectors (Avoid Unnecessary Re-renders)

**BAD** — re-renders on ANY store change:
```tsx
const store = useConversationStore();
```

**GOOD** — re-renders only when THIS field changes:
```tsx
const conversation = useConversationStore((s) => s.conversations.get(id) ?? null);
```

**EVEN BETTER** — use module-level constant for stable fallback:
```tsx
const EMPTY_QUEUE: QueuedMessage[] = [];
const queue = useConversationStore((s) => s.queues.get(id) ?? EMPTY_QUEUE);
```

### Race Condition with setState Closures

**Problem**: After calling `setState`, the current closure still holds the old value.

**BAD**:
```tsx
// addCustomPalette updates state, but previewPalette reads stale closure
addCustomPalette(key, palette);
previewPalette(key);  // looks up key in stale customPalettes — not found!
```

**GOOD**:
```tsx
// Pass the value directly, don't look it up from state
addCustomPalette(key, palette);
applyPalette(palette);  // uses the value we already have
```

**Alternative** — use `get()` in Zustand store actions:
```typescript
const useStore = create((set, get) => ({
  addAndPreview: (key, palette) => {
    set((state) => ({ palettes: { ...state.palettes, [key]: palette } }));
    // get() always returns current state, no stale closures
    const current = get().palettes[key];
    previewPalette(current);
  },
}));
```

---

## WebSocket Message Handling

### Chunk Buffering for Performance

**Problem**: Text chunks arrive 100-200 times per response (1-20 chars each). Each chunk triggers React re-render → Markdown re-parse of ALL messages. On long threads this is catastrophic.

**Solution** (conversationStore.ts, lines 16-59): Accumulate chunks in a plain object outside React state, flush to Zustand once per animation frame (~60Hz). This collapses 100-200 updates into ~3-10 updates.

**Key code**:
```typescript
const chunkBuffer: Map<string, string> = new Map();
let chunkFlushScheduled = false;

function scheduleChunkFlush(): void {
  if (!chunkFlushScheduled) {
    chunkFlushScheduled = true;
    requestAnimationFrame(flushChunkBuffer);
  }
}

// In message handler
case 'chunk':
  chunkBuffer.set(data.conversationId, existing + data.text);
  scheduleChunkFlush();
  break;
```

**Maintenance note**: If streaming feels laggy, check if `requestAnimationFrame` is being blocked by long synchronous work elsewhere.

---

## NEW Badge Feature (Added 2026-02-02)

### Quick Reference

**Where state lives**: `uiStore.lastSeenMessageIndex: Record<conversationId, messageIndex>`

**How it works**:
1. IntersectionObserver in Chat.tsx watches last message element
2. When 50%+ visible → calls `markMessagesSeen(id, messages.length - 1)`
3. Sidebar checks `hasUnseenMessages(id, messages.length)` → shows badge if `lastSeenIndex < messages.length - 1`

**Edge cases handled**:
- Empty conversations → no badge
- First visit → treat as all seen (conservative default)
- Active conversation receives message → auto-marks seen if scrolled
- External file edit → resets seen state (in `conversations_updated` handler)

**Full details**: See `docs/new_badge_feature.md`

### If Badge Shows Incorrectly

**Symptom**: Badge persists after viewing, or shows when it shouldn't

**Diagnosis checklist**:
1. Check browser console for IntersectionObserver errors
2. Verify `lastMessageRef` is attached to last message element in Chat.tsx
3. Check if CSS `overflow: hidden` or `visibility: hidden` blocks observer
4. Inspect localStorage: `JSON.parse(localStorage.getItem('claude-web-view-ui')).lastSeenMessageIndex`

**Quick fix** (reset seen state for one conversation):
```typescript
useUIStore.getState().markMessagesSeen(conversationId, messages.length - 1);
```

**Nuclear option** (reset all seen state):
```typescript
localStorage.setItem('claude-web-view-ui', JSON.stringify({
  ...JSON.parse(localStorage.getItem('claude-web-view-ui')),
  lastSeenMessageIndex: {}
}));
```

---

## File Structure Notes

### External localStorage Keys (Not in Zustand)

Some keys can't live in Zustand persist because they're accessed in non-React contexts:

**`draft:{conversationId}`**:
- Written from uncontrolled textarea via refs in Chat.tsx
- Must bypass React render cycle for performance
- Location: Chat.tsx, lines ~200-220

**`pendingConversations`**:
- Read/written inside conversationStore.ts during WebSocket init
- Tracks optimistically created conversations before server confirms
- Location: conversationStore.ts, lines 104-123

**Documented in**: `uiStore.ts`, lines 15-23

---

## Common Pitfalls

### 1. Uncontrolled Textareas for Streaming UIs

**When**: Component re-renders frequently (e.g., streaming message chunks)

**Problem**: Controlled textarea (`value={state}`) re-renders on every keystroke AND every chunk, causing input lag.

**Solution**: Use uncontrolled textarea, read value from `ref.current.value`. Only sync a boolean `hasInput` to React state for button disabled states.

**Example** (Chat.tsx):
```tsx
const textareaRef = useRef<HTMLTextAreaElement>(null);
const [hasInput, setHasInput] = useState(false);

// Sync hasInput on input event (max 2 updates: empty↔non-empty)
const handleInput = () => {
  const isEmpty = !textareaRef.current?.value.trim();
  setHasInput(!isEmpty);
};

// Read actual value only on submit
const handleSubmit = () => {
  const content = textareaRef.current?.value ?? '';
  // ...
};
```

### 2. Provider Pattern for CLI Agents

All CLI agent integrations (Claude, Codex) implement the `Provider` interface in `server/src/providers/index.ts`.

**Two usage modes**:
1. **Conversation mode**: `getSpawnConfig()` + `parseOutput()` + `formatInput()` for stateful streaming sessions
2. **Single-shot mode**: `getSingleShotConfig(prompt)` for one-off tasks (palette generation, etc.)

**Adding a new provider**:
1. Create `server/src/providers/{name}.ts` implementing `Provider`
2. Add to `ProviderSchema` in `shared/src/index.ts`
3. Register in the `providers` record in `server/src/providers/index.ts`
4. See `docs/agent_client_spec.md` for protocol spec

---

## Build & Performance Notes

### Current Build Stats (2026-02-02)

- **Build time**: ~874ms (TypeScript + Vite)
- **Bundle size**: 703KB uncompressed (214KB gzipped)
- **Warning**: Chunk size > 500KB (Vite warning, not blocking)

### If Build Time Increases Significantly

**Check**:
1. Did someone add a large dependency? Run `npm ls` and check for new packages
2. TypeScript compilation slow? Check for circular imports or overly complex types
3. Vite transform slow? Check Vite config for custom plugins

**Investigate with**:
```bash
cd client
npm run build -- --debug
```

### If Bundle Size Explodes

**Analyze with**:
```bash
cd client
npm run build -- --analyze
```

**Common culprits**:
- Full Lodash import instead of individual functions
- Moment.js instead of date-fns or native Intl
- Heavy markdown parser (we use react-markdown, already included)

---

## When to Move to a Database

**Currently**: localStorage for UI state, JSONL files for conversation history

**Consider a DB when**:
- 10,000+ conversations (localStorage size limits)
- Need relational queries ("find all conversations with tag X from last week")
- Multi-device sync requirements
- Transactional consistency needs
- Shared state between multiple processes

**Good DB choices for this use case**:
- **SQLite**: Local, zero-config, perfect for desktop apps
- **IndexedDB**: Browser-native, async, handles larger datasets than localStorage
- **PouchDB**: Sync-capable, CouchDB-compatible, good for offline-first

**Migration path**:
1. Keep localStorage for fast UI state (theme, expanded projects, etc.)
2. Move conversation history to DB
3. Keep JSONL as export format (human-readable backup)

---

## Testing Notes

### Manual Testing Checklist (NEW Badge Feature)

See `docs/new_badge_feature.md`, section "Testing Scenarios"

### Future Automated Testing Ideas

**Unit tests**:
- Zustand store actions (`markMessagesSeen`, `hasUnseenMessages`)
- localStorage persistence/migration
- Provider parsers (Claude CLI output → events)

**Integration tests**:
- WebSocket message handling end-to-end
- Conversation creation → message send → response flow

**E2E tests** (Playwright/Cypress):
- Open conversation → send message → verify response renders
- IntersectionObserver badge behavior

**Currently**: No test suite (manual testing only)

---

## Contact / Questions

If you're working on this codebase and have questions about design decisions:

1. Check `CLAUDE.md` for project-wide rules
2. Check `docs/` for feature-specific design docs
3. Check file-level comments (especially `conversationStore.ts`, `uiStore.ts`)
4. For NEW badge feature: See `docs/new_badge_feature.md`

**Key design principles**:
- One clean path, no fallbacks (see CLAUDE.md)
- Fail eagerly with clear error messages
- Targeted Zustand selectors, avoid unnecessary re-renders
- Conservative defaults (prefer false negatives over false positives)
