# Claude Web View — Project Rules

## React Hooks: Never Call Hooks After Early Returns

**Rule:** ALL hooks (`useState`, `useEffect`, `useMemo`, `useRef`, custom hooks) MUST be called before any conditional `return` statement.

**Why:** React requires hooks to be called in the same order every render. If a component has an early return (e.g. `if (!data) return <Loading />`) and hooks are called after it, the hook count changes when `data` transitions from null to non-null. This crashes React with **Error #310** ("Rendered more hooks than during the previous render").

**This is especially common when:**
- A component reads from a store/context that starts `null` before async data arrives
- `conversation`, `user`, or similar state starts empty and populates after WebSocket/fetch
- New hooks are added to a component without checking where early returns are

**Example — BAD:**
```tsx
function Chat() {
  const data = useStore((s) => s.data);

  if (!data) return <div>Loading...</div>;  // early return

  // CRASH: these hooks only run when data is non-null
  const derived = useMemo(() => compute(data), [data]);
  const timeAgo = useTimeAgo(derived.date);

  return <div>{timeAgo}</div>;
}
```

**Example — GOOD:**
```tsx
function Chat() {
  const data = useStore((s) => s.data);

  // ALL hooks before any early return — use null-safe access
  const derived = useMemo(() => {
    if (!data) return undefined;
    return compute(data);
  }, [data]);
  const timeAgo = useTimeAgo(derived?.date);

  if (!data) return <div>Loading...</div>;

  return <div>{timeAgo}</div>;
}
```

**How to spot this during review:**
- Search for `return` statements inside component bodies that appear before the closing `return`
- If any `useMemo`, `useState`, `useEffect`, or custom `use*` hook appears after such a return, it's a bug
- The bug may not crash immediately — it only crashes when the condition flips (null → non-null or vice versa)

---

## Provider Pattern: One Interface, Two Modes

All CLI agent integrations (Claude, Codex, future agents) implement the `Provider` interface in `server/src/providers/index.ts`.

**Two usage modes:**
1. **Conversation mode** — `getSpawnConfig()` + `parseOutput()` + `formatInput()` for stateful, streaming multi-turn sessions
2. **Single-shot mode** — `getSingleShotConfig(prompt)` for one-off tasks (palette generation, summarization, etc.)

**Adding a new provider:**
1. Create `server/src/providers/{name}.ts` implementing `Provider`
2. Add to `ProviderSchema` in `shared/src/index.ts`: `z.enum([..., '{name}'])`
3. Register in the `providers` record in `server/src/providers/index.ts`
4. See `docs/agent_client_spec.md` for the full protocol specification

---

## State: Jotai Atom Architecture

### Why this architecture

Jotai notifies every subscriber when an atom changes. During streaming, the server sends ~60 text chunks/sec. If those chunks landed in `conversationsAtom`, every component subscribed to the conversation list (Sidebar, Gallery, SearchPalette) would re-render at 60Hz — saturating the main thread and hanging the UI during conversation switches.

The core invariant: **update frequency must match atom frequency.**

```
WS message → handleMessage() in actions.ts → jotaiStore.set(rightAtom) → only affected atoms notify
                                                         ↓                    ↓
                                               streamingContentAtom      conversationsAtom
                                               (60Hz during streaming)   (structural only — human timescale)
                                                         ↓                    ↓
                                               Chat.tsx merges at        Sidebar/Gallery/SearchPalette
                                               render time               re-render only on add/remove/status
```

### Files and their roles

| File | Role | Who writes | Who reads |
|------|------|------------|-----------|
| `atoms/conversations.ts` | Atom definitions + derived atoms + atomFamily | — | Components via `useAtomValue` |
| `atoms/actions.ts` | All mutations + WS handler + chunk buffer | WS events, UI event handlers | Components import plain functions |
| `atoms/store.ts` | Vanilla `jotaiStore` for use outside React | — | `actions.ts`, `App.tsx` |
| `stores/uiStore.ts` | Persisted UI prefs (Zustand — versioned migration) | Components | Components |

**`<Provider store={jotaiStore}>` wraps the app in `App.tsx`** so `useAtomValue` hooks and `jotaiStore.get/set` always share the same store.

### Atoms and their re-render contracts

```ts
// STRUCTURAL atoms — update at human timescale (message complete, status change, add/delete)
conversationsAtom           // Map<string, Conversation> — NEVER write at >1Hz
allConversationsAtom        // Conversation[] sorted newest-first — derived, auto-recomputes
allConversationIdsAtom      // string[] — stable, changes only on add/delete/reorder
conversationCountAtom       // number

// Per-item atomFamily — one memoized derived atom per ID
conversationAtomFamily(id)        // Conversation | null — re-renders ONLY when this conv changes
childConversationsAtomFamily(id)  // Conversation[] — sub-agent panel

// HIGH-FREQUENCY atoms — safe to write at 60Hz because only Chat.tsx subscribes
streamingContentAtom        // Map<string, string> — chunk buffer, flushed on stream end
streamingAtomFamily(id)     // string — live chunk text, merge into display at render time
```

### State consumers: reading state in components

Pick the narrowest atom that gives you what you need. Wider atoms = more re-renders.

```ts
import { useAtomValue } from 'jotai';
import {
  conversationAtomFamily,   // single conv — re-renders only on THIS conv's structural changes
  streamingAtomFamily,      // chunk text — re-renders at 60Hz, use ONLY in Chat.tsx
  allConversationsAtom,     // sorted list — use in Sidebar, Gallery, SearchPalette
  allConversationIdsAtom,   // IDs only — combine with React.memo on item component
  conversationCountAtom,    // number — count badge, header
} from '../atoms/conversations';

// Single conversation (Chat.tsx, SwarmDetail item)
const conv = useAtomValue(conversationAtomFamily(id ?? ''));

// Streaming text — ONLY in Chat.tsx, merged at render time
const streamingText = useAtomValue(streamingAtomFamily(id ?? ''));
// Merge pattern: don't store merged result in state, do it inline
const displayMessages = streamingText
  ? [...(conv?.messages ?? []), { role: 'assistant' as const, content: streamingText }]
  : (conv?.messages ?? []);

// List views — structural updates only, quiet during streaming
const list = useAtomValue(allConversationsAtom);

// Virtualized list — stable IDs prevent full remounts on unrelated updates
const ids = useAtomValue(allConversationIdsAtom);
// Then: ids.map(id => <React.memo'd Item key={id} id={id} />)
```

**Decision guide — which atom?**

| I need... | Use |
|-----------|-----|
| One specific conversation's data | `conversationAtomFamily(id)` |
| Streaming text for active chat | `streamingAtomFamily(id)` — Chat.tsx only |
| Sorted list of all conversations | `allConversationsAtom` |
| Just IDs for a virtualised list | `allConversationIdsAtom` + `React.memo` on item |
| Total count | `conversationCountAtom` |
| A filtered/transformed view | Add a derived atom (see below) |

### Action callers: triggering mutations from components

Actions are plain functions exported from `atoms/actions.ts` — **no hooks, no `useCallback`, no stale closure risk**. Import and call directly from any event handler.

```ts
import { createConversation, queueMessage, stopConversation, deleteConversation } from '../atoms/actions';

// In an event handler — reference is stable, no useCallback needed
const handleSend = () => queueMessage(conversationId, text);
const handleStop = () => stopConversation(conversationId);
```

**Never call `jotaiStore.set` directly from a component.** All writes go through `atoms/actions.ts` — this keeps mutations traceable and ensures the chunk buffer, WS protocol, and frequency rules are respected.

### State updaters: writing new mutations in actions.ts

Every mutation follows the same shape: `jotaiStore.set(atom, produce(current, draft => { ... }))`.

```ts
// Template — add to atoms/actions.ts
export function myAction(conversationId: string, value: string): void {
  jotaiStore.set(
    conversationsAtom,
    produce(jotaiStore.get(conversationsAtom), (draft) => {
      const conv = draft.get(conversationId);
      if (conv) conv.someField = value;
    })
  );
}
```

**Which atom to write?**

| I'm updating... | Write to |
|-----------------|----------|
| Conversation structure (messages, status, queue) | `conversationsAtom` via `produce()` |
| Active streaming text chunk | `streamingContentAtom` via `produce()` |
| Active conversation ID | `jotaiStore.set(activeConversationIdAtom, id)` |
| WS connection status | `jotaiStore.set(wsStatusAtom, status)` |
| >10Hz (animation, progress) | New atom alongside `streamingContentAtom` — never `conversationsAtom` |

**Frequency rule — the one invariant you must not break:**
`conversationsAtom` must only be written at structural event boundaries (`message_complete`, `status`, conversation created/deleted). Writing it during chunk streaming triggers `allConversationsAtom`, `allConversationIdsAtom`, and `conversationCountAtom` to recompute — and every Sidebar/Gallery/SearchPalette subscriber to re-render.

### Adding a new derived view

Add one atom to `client/src/atoms/conversations.ts`. Jotai tracks dependencies automatically.

```ts
// Filter — auto-recomputes when allConversationsAtom changes
export const claudeConversationsAtom = atom((get) =>
  get(allConversationsAtom).filter((c) => c.provider === 'claude')
);

// Lookup — recomputes only when conversationsAtom changes
export const conversationByIdAtom = (id: string) => atom((get) =>
  get(conversationsAtom).get(id) ?? null
);
```

Then in the component: `const filtered = useAtomValue(claudeConversationsAtom)`. No subscribe, no recompute, no seed call.

### Stable empty references

Module-level constants prevent new object references triggering re-renders on stable data:

```ts
const EMPTY_QUEUE: QueuedMessage[] = [];
const EMPTY_MESSAGES: Message[] = [];

// In component — if queue is empty, always returns the same [] reference
const queue = conv?.queue?.length ? conv.queue : EMPTY_QUEUE;
```

---

## Race Conditions with setState Closures

**Rule:** After calling a state setter (`setState`, `setCustomPalettes`, etc.), the *current* closure still holds the old value. Don't look up data by key from state you just updated — pass the value directly.

```tsx
// BAD: addCustomPalette updates state, but previewPalette reads stale closure
addCustomPalette(key, palette);
previewPalette(key);  // looks up key in stale customPalettes — not found!

// GOOD: pass the palette object directly
addCustomPalette(key, palette);
applyPalette(palette);  // uses the value we already have
```

---

## Uncontrolled Textareas for Streaming UIs

When a component re-renders frequently (e.g. streaming message chunks), use uncontrolled textareas (read value from `ref.current.value`) instead of controlled (`value={state}`). A controlled textarea re-renders on every keystroke, competing with streaming re-renders and causing input lag.

Only sync a boolean (`hasInput`) to React state for button disabled states — flip it at most twice (empty↔non-empty), not on every keystroke.
