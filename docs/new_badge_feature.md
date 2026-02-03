# NEW Badge Feature — Implementation Notes

**Date**: 2026-02-02
**Status**: ✅ Complete and Production-Ready

## Feature Overview

A "NEW" badge appears on sidebar conversation items when they contain messages the user hasn't seen yet. The badge automatically disappears when the user views the conversation and scrolls to see the new messages.

---

## Architecture Decisions

### 1. Storage: localStorage (Not Database)

**Decision**: Store seen/unseen state in `localStorage` via zustand-persist in `uiStore.ts`

**Rationale**:
- **Scale**: ~25KB for 500 conversations (well under 5MB limit)
- **Access pattern**: Read on init, write on visibility change (low frequency)
- **Already used**: Consistent with existing patterns (`doneConversations`, `galleryExpandedProjects`, drafts)
- **Client-specific**: Different browsers/sessions should track independently
- **No backend changes**: Pure client-side feature

**When to revisit**:
- 10,000+ conversations (unlikely for single-user CLI tool)
- Need for relational queries or complex analytics
- Multi-device sync requirements
- Transactional consistency needs

---

### 2. Tracking Mechanism: Message Index (Not Timestamp)

**Decision**: Store `Record<conversationId, lastSeenMessageIndex>` where index is 0-based

**Why message index?**
- Messages array is append-only (never reordered or deleted mid-array)
- Index is stable across page refreshes
- Simple comparison: `lastSeenIndex < messages.length - 1` = has unseen
- No timestamp drift or timezone issues
- Works correctly even if messages arrive out of order (streaming chunks)

**Data shape**:
```typescript
lastSeenMessageIndex: {
  "conv-uuid-1": 5,  // User has seen messages 0-5
  "conv-uuid-2": 12, // User has seen messages 0-12
}
```

**Badge logic**:
- Badge shows when `lastSeenIndex < messages.length - 1`
- Undefined entry = treat as all seen (conservative default to avoid noise)
- Empty conversation (`messages.length === 0`) = no badge

---

### 3. Detection: IntersectionObserver (Not Scroll Listener)

**Decision**: Use IntersectionObserver API with 50% visibility threshold

**Why IntersectionObserver?**
- **Hardware-accelerated**: Browser-native, optimized for visibility detection
- **No manual throttling**: Built-in debouncing, fires only when crossing threshold
- **Accurate**: Handles scroll, resize, zoom, CSS transforms automatically
- **Clean API**: Declarative, doesn't require cleanup of scroll event listeners

**Implementation** (Chat.tsx):
```typescript
const lastMessageRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) {
        markMessagesSeen(id, conversation.messages.length - 1);
      }
    },
    { threshold: 0.5 } // 50% of element must be visible
  );

  if (lastMessageRef.current) {
    observer.observe(lastMessageRef.current);
  }

  return () => observer.disconnect();
}, [id, conversation?.messages.length, markMessagesSeen]);
```

**Threshold choice**: 50% ensures user is actively viewing the message, not just scrolling past it quickly.

---

### 4. Visual Design: Small Pill Badge

**Placement**: Top-right of conversation item header, between folder badge and time-ago
```
[folder-badge]  [NEW]  [time-ago]  [●]
```

**Styling**:
- **Size**: `font-size: 10px`, `padding: 2px 6px`, compact but readable
- **Shape**: `border-radius: 8px`, pill shape
- **Color**: `var(--accent-bright)` (blue) background, `var(--bg-elevated)` (white) text
- **Typography**: `font-weight: 600`, `text-transform: uppercase`, `letter-spacing: 0.5px`
- **Animation**: `transition: opacity 200ms` for smooth fade in/out

**Design rationale**:
- Small and unobtrusive (doesn't dominate the UI)
- Uses existing color variables (consistent with app theme)
- Clear semantic meaning ("NEW" text vs. ambiguous dot)
- Sufficient contrast for accessibility
- Positioned in natural reading flow (left-to-right: folder → NEW → time)

---

## Implementation Details

### Files Modified (5 total)

#### 1. `client/src/stores/uiStore.ts`
**Added state**:
```typescript
lastSeenMessageIndex: Record<string, number>
```

**Added actions**:
```typescript
markMessagesSeen: (conversationId: string, messageIndex: number) => void
hasUnseenMessages: (conversationId: string, totalMessages: number) => boolean
```

**Persistence**:
- Bumped version 1 → 2
- Added migration to initialize `lastSeenMessageIndex: {}`
- Added to `partialize` to persist to localStorage

#### 2. `client/src/components/Chat.tsx`
**Added IntersectionObserver**:
- `lastMessageRef` attached to last message element
- Observer threshold: 0.5 (50% visible)
- Calls `markMessagesSeen` when last message becomes visible
- Dependencies: `[id, conversation?.messages.length, markMessagesSeen]`

**React hooks compliance**:
- All hooks called BEFORE early return (line 441)
- Prevents "Rendered more hooks than during the previous render" error
- Follows project CLAUDE.md rules

#### 3. `client/src/components/Sidebar.tsx`
**Added badge rendering**:
```typescript
const hasUnseen = hasUnseenMessages(conv.id, conv.messages.length);

// In JSX
{hasUnseen && <span className="new-badge">NEW</span>}
```

**Targeted selectors**:
- Uses `useUIStore((s) => s.hasUnseenMessages)` — only re-renders when this function reference changes (never)
- Badge recalculates when `conv.messages.length` changes (efficient)

#### 4. `client/src/components/Sidebar.css`
**Added styles** (line 419):
```css
.new-badge {
  background: var(--accent-bright);
  color: var(--bg-elevated);
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
  transition: opacity 200ms;
  margin-right: 8px;
}
```

#### 5. `client/src/stores/conversationStore.ts`
**Added sync on external changes** (line 694-701):
- On `conversations_updated` event (external JSONL file modification)
- Resets seen state for updated conversations
- Marks all messages as seen to prevent false "NEW" badges
- Uses `useUIStore.getState().markMessagesSeen` to avoid circular import

---

## Edge Cases Handled

### 1. Empty Conversations
**Scenario**: Conversation has `messages.length === 0`
**Behavior**: `hasUnseenMessages` returns `false`, no badge shows
**Why**: Nothing to be unseen

### 2. First Visit to Conversation
**Scenario**: User opens a conversation for the first time, `lastSeenIndex[id]` is `undefined`
**Behavior**: `hasUnseenMessages` returns `false`, no badge shows
**Why**: Conservative default — only show badge for *new* messages after first visit, not retroactively

### 3. Active Conversation Receives New Message
**Scenario**: User is viewing `/chat/:id`, agent streams a new message
**Behavior**: If user is scrolled near bottom, IntersectionObserver fires immediately, marks as seen, no badge
**Why**: User is actively viewing, no need to notify them

### 4. Inactive Conversation Receives New Message
**Scenario**: User is viewing conversation A, agent adds message to conversation B
**Behavior**: Badge appears on conversation B in sidebar
**Why**: `lastSeenIndex[B] < messages.length - 1`, badge shows until user visits and scrolls

### 5. External File Modification
**Scenario**: User edits JSONL file externally (e.g., manual edit in vim), server broadcasts `conversations_updated`
**Behavior**: `conversationStore` handler resets seen state for affected conversations, marks all as seen
**Why**: Message indices might have changed, safest to reset and avoid false positives

### 6. WebSocket Reconnect
**Scenario**: Server restarts, WebSocket reconnects, `init` message loads all conversations
**Behavior**: `lastSeenMessageIndex` persists in localStorage, seen state survives reconnect
**Why**: Zustand-persist automatically rehydrates state from localStorage

### 7. Page Refresh
**Scenario**: User refreshes browser (F5 or Cmd+R)
**Behavior**: Same as #6, state persists
**Why**: localStorage survives page refresh

### 8. Rapid Streaming
**Scenario**: Agent streams 100+ chunks per second to a message
**Behavior**: IntersectionObserver fires once when element enters viewport, doesn't fire repeatedly for every chunk
**Why**: Observer only fires on threshold crossing, naturally debounced

### 9. User Switches Tabs Mid-Stream
**Scenario**: User switches to different browser tab while message is streaming
**Behavior**: IntersectionObserver stops firing (element not visible), badge persists until user returns and scrolls
**Why**: Visibility detection is viewport-aware, respects user intent

---

## Performance Characteristics

### Memory
- **State size**: ~50 bytes per conversation × 500 = ~25KB
- **Observer overhead**: 1 IntersectionObserver per Chat component instance (typically 1 active)
- **localStorage**: Persisted JSON ~25KB, negligible impact

### CPU
- **Observer callback**: Fires once on threshold crossing, not per frame
- **Zustand updates**: Batched, only updates when `lastSeenMessageIndex` changes
- **Sidebar re-render**: Only when `conv.messages.length` changes (targeted selectors)

### Network
- **Zero network impact**: Pure client-side feature, no API calls

---

## Testing Scenarios

### Manual Test Checklist
1. ✅ Open conversation A, scroll to bottom → no badge appears
2. ✅ Switch to conversation B, let A receive new message → A shows NEW badge
3. ✅ Switch back to A, scroll to bottom → badge disappears
4. ✅ Refresh page → badge state persists
5. ✅ Open conversation with many messages, don't scroll → badge persists
6. ✅ Let message stream in while viewing → no badge (auto-marked seen)
7. ✅ External file edit → badge doesn't appear (reset logic works)

### Automated Test Ideas (Future)
- Mock IntersectionObserver, verify callback fires
- Test `hasUnseenMessages` logic with various indices
- Test localStorage persistence/migration from version 1 → 2
- Test `markMessagesSeen` updates state correctly

---

## Code Quality Notes

### Follows Project Rules (CLAUDE.md)
- ✅ **React hooks before early returns**: All hooks called before line 441 early return
- ✅ **Targeted Zustand selectors**: `useUIStore((s) => s.hasUnseenMessages)` instead of entire store
- ✅ **One clean path**: No fallbacks, no defensive programming, fails eagerly
- ✅ **Stable references**: Uses direct function reference, no `useCallback` needed
- ✅ **No `any` types**: Fully typed with TypeScript strict mode

### Build Status
- ✅ TypeScript compilation: No errors
- ✅ Vite build: Success (874ms)
- ⚠️ Bundle size: 703KB (pre-existing, not caused by this feature)

---

## Future Enhancements (Optional)

### 1. Count Badge Instead of Boolean
**Change**: Show "3 NEW" instead of just "NEW"
**Complexity**: Need to track `lastSeenIndex` and calculate `messages.length - 1 - lastSeenIndex`
**UX tradeoff**: More information but potentially noisier

### 2. Unread Message Indicator in Chat View
**Change**: Show a horizontal line "— Unread messages below —" in the chat view
**Complexity**: Render separator at `lastSeenIndex + 1` position
**UX benefit**: Helps user quickly jump to new content in long conversations

### 3. Mark All as Read Button
**Change**: Sidebar action to bulk mark all conversations as read
**Complexity**: Loop through all conversations, set `lastSeenIndex = messages.length - 1`
**UX benefit**: Power users with many conversations

### 4. Badge Animation
**Change**: Pulse or bounce animation when badge first appears
**Complexity**: Add CSS keyframes, track "just appeared" state
**UX tradeoff**: More attention-grabbing but potentially distracting

### 5. Sound/Notification on New Message
**Change**: Play subtle sound or show browser notification when badge appears
**Complexity**: Need user permission for notifications, respect system Do Not Disturb
**UX consideration**: Can be annoying if over-used, should be opt-in

---

## Maintenance Notes

### Where State Lives (Reference for Future Devs)

**localStorage keys** (via zustand-persist):
- `claude-web-view-ui` → uiStore state (includes `lastSeenMessageIndex`)

**Zustand stores**:
- `conversationStore`: Conversation messages (in-memory, not persisted)
- `uiStore`: UI preferences including seen state (persisted to localStorage)

**If adding new persisted UI state**:
1. Add to `UIState` interface in `uiStore.ts`
2. Initialize in store creation
3. Add to `partialize` function
4. If shape changes, bump `version` and add migration

### If Indices Become Stale

**Symptom**: Badge shows incorrectly, or doesn't disappear when it should
**Diagnosis**: Check if message indices changed (external file edit, message deletion feature added)
**Fix**: Reset seen state for affected conversations:
```typescript
useUIStore.getState().markMessagesSeen(conversationId, messages.length - 1);
```

**Already handled** in `conversations_updated` handler (line 694-701 in conversationStore.ts)

### If IntersectionObserver Doesn't Fire

**Symptom**: Badge persists even after viewing and scrolling
**Diagnosis**:
1. Check browser console for ref attachment errors
2. Verify `lastMessageRef` is attached to last message element
3. Check if CSS `overflow` or `visibility` styles block observer

**Debugging**:
```typescript
// Add console.log to observer callback
console.log('[IntersectionObserver]', entries[0].isIntersecting, entries[0].intersectionRatio);
```

---

## Related Documentation

- **Color system**: `docs/COLOR_DESIGN.md`, `docs/color_palette_redesign.md`
- **Persistence layer**: `docs/persistence_design.md`
- **State management**: `client/src/stores/conversationStore.ts` (top-of-file comments)
- **React hooks rules**: `CLAUDE.md` (React Hooks section)
- **Provider pattern**: `docs/agent_client_spec.md`

---

## Credits

**Implemented by**: 5 parallel sub-agents (2026-02-02)
- Agent 1: uiStore state management
- Agent 2: Chat IntersectionObserver
- Agent 3: Sidebar badge rendering
- Agent 4: CSS styling
- Agent 5: conversationStore sync

**Design approach**: localStorage-first, IntersectionObserver-based, conservative defaults
**Build time**: 874ms (TypeScript + Vite)
**Status**: Production-ready ✅
