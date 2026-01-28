# Message Queue System Design

## Overview

This document describes the design for a message queue system that allows users to queue multiple messages while Claude (or other providers) is processing a response. Messages are queued on the client side and automatically sent when the current response completes.

**Key Design Decision:** The queue is managed **client-side** in React state. The server remains stateless regarding queued messages - it only processes one message at a time per conversation. This keeps the server simple and puts queue management responsibility where the UI state already lives.

---

## Current Architecture Summary

### Client (`AppContext.tsx`)
- Maintains `Map<string, Conversation>` with all conversation state
- Uses WebSocket to send `ClientMessage` types to server
- Handles `ServerMessage` events to update local state
- `sendMessage(conversationId, content)` sends immediately via WebSocket

### Server (`server.ts`)
- `Conversation` class manages CLI process spawning
- `sendMessage()` rejects if `isRunning` is true (line 267-269)
- Broadcasts `status` events with `isRunning` flag
- Broadcasts `message_complete` when response finishes

### Shared Types (`shared/src/index.ts`)
- Zod schemas for all message types
- `Conversation` type includes `isRunning`, `isReady`, `messages[]`

---

## Data Model Changes

### 1. New Types in `shared/src/index.ts`

```typescript
// =============================================================================
// Message Queue Types
// =============================================================================

/**
 * A message waiting in the queue to be sent.
 * ID is generated client-side for UI tracking and cancel operations.
 */
export const QueuedMessageSchema = z.object({
  id: z.string().uuid(),           // Client-generated UUID for tracking
  content: z.string().min(1),
  queuedAt: z.coerce.date(),
  status: z.enum(['pending', 'sending']),  // 'sending' = currently being processed
});

export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

// Add to ConversationSchema
export const ConversationSchema = z.object({
  id: z.string().uuid(),
  messages: z.array(MessageSchema),
  isRunning: z.boolean(),
  isReady: z.boolean().default(false),
  createdAt: z.coerce.date(),
  workingDirectory: z.string(),
  loopConfig: LoopConfigSchema.nullable().optional(),
  provider: ProviderSchema.default('claude'),
  // NEW: Message queue (client-side only, not serialized to server)
  messageQueue: z.array(QueuedMessageSchema).optional(),
});
```

### 2. New Server-to-Client Message Types

```typescript
// Optional: Server acknowledgment that queue processing can continue
// This provides explicit signal vs inferring from status changes
export const QueueReadyMessageSchema = z.object({
  type: z.literal('queue_ready'),
  conversationId: z.string().uuid(),
});

export type QueueReadyMessage = z.infer<typeof QueueReadyMessageSchema>;

// Add to ServerMessageSchema discriminated union
export const ServerMessageSchema = z.discriminatedUnion('type', [
  // ... existing types ...
  QueueReadyMessageSchema,
]);
```

**Note:** The `queue_ready` message is optional. The client can also use the existing `message_complete` event (which already exists) as the signal to send the next queued message. However, an explicit `queue_ready` provides cleaner separation of concerns.

### 3. Client State Changes in `AppContext.tsx`

```typescript
interface AppContextValue {
  // ... existing fields ...

  // New queue operations
  queueMessage: (conversationId: string, content: string) => void;
  cancelQueuedMessage: (conversationId: string, messageId: string) => void;
  clearQueue: (conversationId: string) => void;
  getQueue: (conversationId: string) => QueuedMessage[];
}
```

---

## WebSocket Protocol Changes

### Existing Messages (No Changes Needed)

The current protocol already has the signals we need:

| Message | Direction | When Sent | Queue Use |
|---------|-----------|-----------|-----------|
| `send_message` | Client -> Server | User sends message | Send next queued message |
| `status` | Server -> Client | `isRunning` changes | Detect when response starts/ends |
| `message_complete` | Server -> Client | CLI response finished | Trigger next message send |

### Optional New Message

```typescript
// Server -> Client: Explicit "ready for next message" signal
{
  type: 'queue_ready',
  conversationId: string
}
```

**Recommendation:** Start without `queue_ready`. Use the existing `status` message with `isRunning: false` as the trigger. Add `queue_ready` only if edge cases emerge.

---

## Implementation Details

### Client-Side Queue Manager

Add a custom hook or integrate into `AppContext`:

```typescript
// In AppContext.tsx

export function AppProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<Map<string, Conversation>>(new Map());

  // Track queues separately for cleaner state management
  // Key: conversationId, Value: QueuedMessage[]
  const [queues, setQueues] = useState<Map<string, QueuedMessage[]>>(new Map());

  // Process queue when conversation becomes ready
  const processQueue = useCallback((conversationId: string) => {
    const queue = queues.get(conversationId) || [];
    const conv = conversations.get(conversationId);

    // Guard: only process if ready and not running
    if (!conv || !conv.isReady || conv.isRunning) return;
    if (queue.length === 0) return;

    const nextMessage = queue[0];

    // Mark as sending in queue
    setQueues(prev => {
      const next = new Map(prev);
      const q = [...(next.get(conversationId) || [])];
      q[0] = { ...q[0], status: 'sending' };
      next.set(conversationId, q);
      return next;
    });

    // Send via WebSocket
    send({ type: 'send_message', conversationId, content: nextMessage.content });
  }, [queues, conversations, send]);

  // Queue a new message
  const queueMessage = useCallback((conversationId: string, content: string) => {
    const conv = conversations.get(conversationId);
    if (!conv) return;

    const newMessage: QueuedMessage = {
      id: crypto.randomUUID(),
      content,
      queuedAt: new Date(),
      status: 'pending',
    };

    setQueues(prev => {
      const next = new Map(prev);
      const queue = [...(next.get(conversationId) || []), newMessage];
      next.set(conversationId, queue);
      return next;
    });

    // If conversation is ready and not running, send immediately
    if (conv.isReady && !conv.isRunning) {
      // Defer to next tick to ensure queue state is updated
      setTimeout(() => processQueue(conversationId), 0);
    }
  }, [conversations, processQueue]);

  // Cancel a queued message
  const cancelQueuedMessage = useCallback((conversationId: string, messageId: string) => {
    setQueues(prev => {
      const next = new Map(prev);
      const queue = (next.get(conversationId) || []).filter(m => m.id !== messageId);
      next.set(conversationId, queue);
      return next;
    });
  }, []);

  // Clear all queued messages for a conversation
  const clearQueue = useCallback((conversationId: string) => {
    setQueues(prev => {
      const next = new Map(prev);
      next.set(conversationId, []);
      return next;
    });
  }, []);

  // Handle server messages - trigger queue processing on completion
  const handleMessage = useCallback((data: ServerMessage) => {
    switch (data.type) {
      // ... existing cases ...

      case 'message_complete':
        // Remove the sent message from queue
        setQueues(prev => {
          const next = new Map(prev);
          const queue = next.get(data.conversationId) || [];
          // Remove first message (the one that was sending)
          next.set(data.conversationId, queue.slice(1));
          return next;
        });
        // Process next message after a brief delay
        setTimeout(() => processQueue(data.conversationId), 100);
        break;

      case 'status':
        setConversations(prev => {
          // ... existing status handling ...
        });
        // When status changes to not running, try processing queue
        if (!data.isRunning) {
          setTimeout(() => processQueue(data.conversationId), 100);
        }
        break;
    }
  }, [processQueue]);

  // ... rest of provider
}
```

### Updated sendMessage Logic

Modify `sendMessage` to use the queue:

```typescript
// The exposed sendMessage now always queues
const sendChatMessage = useCallback((conversationId: string, content: string) => {
  const conv = conversations.get(conversationId);
  if (!conv) return;

  // Always queue the message
  queueMessage(conversationId, content);
}, [conversations, queueMessage]);
```

---

## UI/UX Design

### Queued Messages Display

Show queued messages in the chat with a distinct visual treatment:

```tsx
// In Chat.tsx

const queue = queues.get(conversation.id) || [];

// After existing messages, show queued messages
{queue.map((qm) => (
  <div key={qm.id} className={`message user queued ${qm.status}`}>
    <div className="message-role user">
      you (queued)
      {qm.status === 'pending' && (
        <button
          className="cancel-queue-btn"
          onClick={() => cancelQueuedMessage(conversation.id, qm.id)}
          title="Cancel this message"
        >
          x
        </button>
      )}
    </div>
    <div className="message-content">{qm.content}</div>
    <div className="queue-indicator">
      {qm.status === 'sending' ? 'Sending...' : `#${queue.indexOf(qm) + 1} in queue`}
    </div>
  </div>
))}
```

### CSS Styling

```css
/* In Chat.css */

/* Queued message styling */
.message.queued {
  opacity: 0.7;
  border-left: 3px solid #888;
}

.message.queued.sending {
  opacity: 0.85;
  border-left-color: #4a9eff;
  animation: pulse 1.5s infinite;
}

.message.queued .queue-indicator {
  font-size: 0.75rem;
  color: #888;
  margin-top: 4px;
}

.cancel-queue-btn {
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  padding: 2px 6px;
  margin-left: 8px;
  font-size: 0.8rem;
  border-radius: 3px;
}

.cancel-queue-btn:hover {
  background: #ff4444;
  color: white;
}

@keyframes pulse {
  0%, 100% { opacity: 0.85; }
  50% { opacity: 0.6; }
}
```

### Input Area Changes

Allow input while running (queue mode):

```tsx
// In Chat.tsx - update the canSend logic

const isLooping = conversation.loopConfig?.isLooping ?? false;
const isReady = conversation.isReady ?? false;

// Allow input if ready, even if running (messages will queue)
const canInput = isReady && !isLooping;
const willQueue = isReady && conversation.isRunning;

// Update textarea placeholder
<textarea
  className="message-input"
  value={input}
  onChange={(e) => setInput(e.target.value)}
  onKeyDown={handleKeyDown}
  placeholder={
    !isReady
      ? `Waiting for ${conversation.provider || 'claude'}...`
      : willQueue
        ? 'Type to queue a message...'
        : 'Type your message...'
  }
  disabled={!canInput}
/>

// Update send button
<button
  type="button"
  className={`send-btn ${willQueue ? 'queue-mode' : ''}`}
  onClick={handleSend}
  disabled={!canInput || !input.trim()}
>
  {willQueue ? 'Queue' : 'Send'}
</button>
```

### Queue Status Indicator

Show queue status in header:

```tsx
// In Chat.tsx header

<div className="header-status">
  {queue.length > 0 && (
    <div className="queue-badge" title="Messages waiting to send">
      {queue.length} queued
      <button
        className="clear-queue-btn"
        onClick={() => clearQueue(conversation.id)}
        title="Clear queue"
      >
        Clear
      </button>
    </div>
  )}
  {/* existing status indicators */}
</div>
```

---

## Edge Cases and Error Handling

### 1. WebSocket Disconnect During Queue Processing

```typescript
// In useWebSocket.ts - save queue state before reconnect
ws.onclose = () => {
  // Queue state is in React state, persists across reconnects
  // No special handling needed - queue will process when reconnected
};
```

### 2. Server Rejects Message (e.g., isRunning check)

If the server still has `isRunning` guard:

```typescript
// Server might broadcast an error - handle it
case 'error':
  // Check if this is a "already running" error
  if (data.message.includes('already processing')) {
    // Re-queue the message? Or just wait for status change?
    // Recommendation: Just wait - don't retry immediately
    console.warn('Server busy, waiting for status change');
  } else {
    alert(data.message);
  }
  break;
```

**Recommendation:** Update server to queue or accept messages even if running, since the client now manages queuing. Or remove the `isRunning` guard on server since client handles it.

### 3. Conversation Deleted While Queue Non-Empty

```typescript
case 'conversation_deleted':
  // Clean up queue for deleted conversation
  setQueues(prev => {
    const next = new Map(prev);
    next.delete(data.conversationId);
    return next;
  });
  // ... existing handling
  break;
```

### 4. Loop Mode Interaction

When loop mode is active, the queue should be paused:

```typescript
const processQueue = useCallback((conversationId: string) => {
  const conv = conversations.get(conversationId);

  // Don't process queue during loop mode
  if (conv?.loopConfig?.isLooping) return;

  // ... rest of processing
}, [/* deps */]);
```

---

## Implementation Steps

### Phase 1: Core Queue Logic (Client Only)

1. **Add queue state to AppContext**
   - Add `queues` Map state
   - Add `queueMessage`, `cancelQueuedMessage`, `clearQueue` functions
   - Add `processQueue` internal function

2. **Wire up message handling**
   - Update `handleMessage` to trigger queue processing on `message_complete`
   - Update `handleMessage` to trigger queue processing when `status.isRunning` becomes false

3. **Update sendMessage**
   - Change `sendChatMessage` to queue messages instead of sending directly

### Phase 2: UI Changes

4. **Update Chat.tsx**
   - Display queued messages with visual distinction
   - Add cancel button for pending messages
   - Add queue status indicator in header
   - Update input placeholder for queue mode

5. **Update Chat.css**
   - Style queued messages (opacity, border, animation)
   - Style queue indicators and cancel buttons

### Phase 3: Polish

6. **Add clear queue functionality**
   - Clear queue button in header
   - Keyboard shortcut (Ctrl+Shift+Q?)

7. **Handle edge cases**
   - Conversation deletion cleanup
   - Loop mode pausing
   - Error recovery

### Phase 4: Optional Server Changes

8. **Remove server-side isRunning guard** (optional)
   - Server currently rejects if `isRunning` (line 267-269 in server.ts)
   - Either remove this check or keep it as fallback safety

9. **Add queue_ready message** (optional)
   - Only if edge cases require explicit signaling

---

## Testing Checklist

- [ ] Queue message while Claude is responding
- [ ] Queue multiple messages in sequence
- [ ] Cancel queued message before it sends
- [ ] Clear entire queue
- [ ] Queue persists across minor UI updates (no state loss)
- [ ] Queue works with different providers (claude, codex)
- [ ] Queue respects loop mode (paused during loops)
- [ ] Queue handles WebSocket reconnection gracefully
- [ ] Queue handles conversation deletion
- [ ] Queue handles rapid message_complete events
- [ ] Visual indicators show correct queue position
- [ ] "Sending..." state shows during transition

---

## Future Enhancements

1. **Queue Persistence**: Save queue to localStorage for browser refresh recovery
2. **Queue Reordering**: Drag-and-drop to reorder pending messages
3. **Queue Editing**: Edit queued messages before they send
4. **Priority Queue**: Mark certain messages as high priority
5. **Queue Analytics**: Show estimated wait time based on recent response times
6. **Server-Side Queue**: Move queue to server for multi-client sync (significant architecture change)

---

## Summary

This design adds message queueing with minimal changes to the existing architecture:

- **Client-side queue management** in React state
- **No new WebSocket message types required** (uses existing `message_complete` and `status`)
- **UI shows queued messages** with visual distinction and cancel capability
- **Automatic processing** when responses complete
- **Clean separation**: Server remains stateless about queue, client owns queue logic

The implementation is incremental - Phase 1 and 2 provide full functionality, Phase 3-4 are polish.
