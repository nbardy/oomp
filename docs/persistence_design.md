# Client-Side Persistence & Chat State Design

## Problem Statement

Two state-loss bugs on page refresh / accidental navigation:

1. **Draft message loss** — Whatever the user has typed in the textarea is gone on refresh. Each conversation should independently preserve its unsent draft.
2. **New conversation loss** — A freshly created conversation (before the first message is sent) exists only in server memory. On refresh, the server reloads from JSONL files, and since no file was written yet, the conversation vanishes — along with any draft the user was composing.

## Current Data Flow

```
[New Conversation Button]
  → Sidebar sends WS { type: 'new_conversation', workingDirectory, provider }
  → Server creates in-memory Conversation instance (NO file on disk)
  → Server responds WS { type: 'conversation_created', conversation }
  → Store adds to conversations Map
  → Router navigates to /chat/{id}
  → User types in textarea (uncontrolled — value lives in DOM only)
  → User sends first message
  → Server spawns CLI process → CLI writes JSONL file
  → Now conversation is durable
```

**Gap:** Between "conversation_created" and "first message sent", the conversation and any draft text exist nowhere durable. A refresh kills both.

## Design

### 1. Draft Message Persistence (per conversation)

**Storage key:** `draft:{conversationId}` in localStorage.

**Write:** Debounced (500ms) on every `input` event in the Chat textarea. The textarea is uncontrolled (value lives in DOM, not React state), so the save function reads from `textareaRef.current.value` directly.

**Read:** On Chat mount (when `id` changes), load the draft from localStorage into `textareaRef.current.value`. Set `hasInput` boolean accordingly. Trigger the auto-grow height calculation.

**Delete:** When a message is sent (textarea cleared), remove the draft key.

**Why per-conversation keys instead of one big object?**
- Avoids serializing/deserializing all drafts on every keystroke
- Each `localStorage.setItem` is a single small write
- Cleanup is trivial: `localStorage.removeItem('draft:' + id)`
- No cross-conversation interference

**Integration with uncontrolled textarea pattern:**
The Chat component uses an uncontrolled textarea (per `CLAUDE.md` rules) to avoid re-render competition with streaming chunks. Draft persistence fits naturally — we read/write the DOM value directly via ref, and only touch React state for the `hasInput` boolean (at most two flips: empty↔non-empty).

```
Chat mount (id changes)
  → Read localStorage['draft:{id}']
  → If found: set textareaRef.current.value, update hasInput, trigger auto-grow
  → If not: clear textarea (different conversation may have had a draft)

Textarea input event (debounced 500ms)
  → Save textareaRef.current.value to localStorage['draft:{id}']

Message sent (textarea cleared)
  → localStorage.removeItem('draft:{id}')
```

### 2. Stub Conversation on Create (Optimistic Client-Side)

**Problem:** Currently `createConversation` only sends a WebSocket message and waits for the server to respond with `conversation_created`. The conversation doesn't exist in the store until the server responds. If the server is slow or the page refreshes mid-flight, the user sees nothing.

**Solution:** Create the conversation object **immediately in the Zustand store** before (or alongside) the WebSocket message. This is an optimistic update.

**Store change — `createConversation` action:**
```typescript
createConversation: (workingDirectory, provider = 'claude') => {
  const id = crypto.randomUUID();
  const stub: Conversation = {
    id,
    messages: [],
    isRunning: false,
    isReady: false,  // Not ready until server confirms
    createdAt: new Date(),
    workingDirectory,
    provider,
    loopConfig: null,
    subAgents: [],
  };

  // Optimistic: add to store immediately
  set((state) => {
    const conversations = new Map(state.conversations);
    conversations.set(id, stub);
    return { conversations, activeConversationId: id };
  });

  // Tell server to create the real conversation with this ID
  get()._send({ type: 'new_conversation', id, workingDirectory, provider });
},
```

**Server change:** Accept the optional `id` field from `new_conversation`. If provided, use it instead of generating a new UUID. This keeps client and server in sync.

**`conversation_created` handler:** When the server responds, the conversation already exists in the store. The handler updates it in-place (merging server-provided fields like `isReady`) rather than inserting a new entry.

```typescript
case 'conversation_created':
  set((state) => {
    const conversations = new Map(state.conversations);
    // Merge: server data wins, but conversation already exists from optimistic insert
    conversations.set(data.conversation.id, data.conversation);
    return { conversations };
  });
  break;
```

**Sidebar change:** No more `pendingNav` dance. The conversation is in the store immediately, so the Sidebar can navigate to it in the same tick as creation.

### 3. Persist Stub Conversations in localStorage

**Storage key:** `pendingConversations` — a JSON array of stub Conversation objects.

**Write:** When a stub is created (in `createConversation`), also write it to localStorage.

**Read:** On app startup, before the WebSocket `init` message arrives, load pending conversations from localStorage and pre-populate the store. When `init` arrives from the server, merge: any pending conversation that the server already knows about (it was persisted before refresh) gets replaced by the server version. Any pending conversation the server doesn't know about gets re-sent as a `new_conversation` message.

**Delete:** When the server confirms a conversation (via `conversation_created` or when it appears in `init`), remove it from the `pendingConversations` list.

**Flow on refresh:**
```
Page load
  → Load pendingConversations from localStorage
  → Add them to Zustand store (user sees their conversation immediately)
  → Restore activeConversationId from localStorage (existing feature)
  → Navigate to /chat/{id} (existing feature)
  → Draft textarea restored from localStorage['draft:{id}']
  → WebSocket connects, init message arrives
  → For each pending conversation:
      If server has it (in init.conversations): replace stub with server version, remove from pending
      If server doesn't have it: re-send new_conversation message
  → Once all pending conversations are confirmed, clear pendingConversations from localStorage
```

### 4. localStorage Key Summary

| Key | Type | Lifecycle |
|-----|------|-----------|
| `activeConversationId` | `string` | Written on tab switch. Read on app load. Existing. |
| `draft:{conversationId}` | `string` | Written on input (debounced). Deleted on send. Read on Chat mount. |
| `pendingConversations` | `Conversation[]` (JSON) | Written on stub create. Deleted when server confirms. Read on app load. |
| `claudeWorkingDirectory` | `string` | Existing — last directory for new conversation dialog. |

### 5. Cleanup

- **Draft cleanup:** Drafts for deleted conversations are orphaned but harmless (small strings). Optionally clean up in the `conversation_deleted` handler.
- **Pending conversation cleanup:** Cleared as soon as server confirms. If a conversation is never confirmed (server restarted, conversation truly lost), the pending entry stays. On next app load, it gets re-sent to the server.

## Interaction with Existing Patterns

**Uncontrolled textarea (CLAUDE.md rule):** Draft persistence reads/writes DOM directly via ref. No new React state for text content. The `hasInput` boolean is set once on restore — same as existing behavior.

**Zustand targeted selectors (CLAUDE.md rule):** No new selectors needed. The existing `conversation` selector in Chat already pulls the right data. The draft is managed outside the store (localStorage + ref).

**Hooks before early returns (CLAUDE.md rule):** Draft restore runs in a `useEffect` (a hook), which is already declared before the early return in Chat. No new hooks are added after the early return.

**One clean path, no fallbacks (CLAUDE.md rule):** If localStorage read fails (corrupted data, quota exceeded), we don't silently fall back. The draft is simply empty — same as a fresh page load. No try/catch wrapping reads.

## Implementation Order

1. **Draft persistence** — Smallest change, immediate user value. Only touches `Chat.tsx`.
2. **Optimistic stub creation** — Changes `conversationStore.ts` createConversation action, `Sidebar.tsx` (removes pendingNav), server `new_conversation` handler (accept optional id), `shared/src/index.ts` (add id to NewConversationMessage).
3. **Persist pending conversations** — Adds localStorage read/write in store, merge logic in `init` handler.
