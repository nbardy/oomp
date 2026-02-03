# Ralph Loop — Comprehensive Design Document

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Audit](#current-state-audit)
3. [What's Broken and Why](#whats-broken-and-why)
4. [Desired Behavior (User Story)](#desired-behavior-user-story)
5. [Architecture: Sub-Conversations vs Single Thread](#architecture-sub-conversations-vs-single-thread)
6. [Detailed Design](#detailed-design)
7. [Message Protocol](#message-protocol)
8. [UI Specification](#ui-specification)
9. [Server-Side Loop Engine](#server-side-loop-engine)
10. [Sub-Conversation Lifecycle](#sub-conversation-lifecycle)
11. [Queue Integration](#queue-integration)
12. [Persistence & History](#persistence--history)
13. [File Inventory](#file-inventory)
14. [Implementation Plan](#implementation-plan)
15. [Edge Cases & Failure Modes](#edge-cases--failure-modes)
16. [Comments & Stability Notes](#comments--stability-notes)

---

## Executive Summary

**Ralph Loop** (branded with a Ralph Wiggum icon) is a feature that lets users fire the same prompt N times in succession, optionally clearing context between each iteration. Each iteration spawns a fresh Claude CLI process (a "sub-conversation") that appears as a child within the same UI conversation thread — not as a new conversation in the sidebar.

**Current status:** The feature is ~70% implemented. The popup UI, shared types, server-side loop engine, and client-side store handlers all exist. However, the feature **does not work end-to-end** due to several critical bugs in the interaction between the loop engine, process spawning, and the sub-conversation model.

---

## Current State Audit

### What EXISTS today (code is written and present):

| Layer | File | What's There |
|-------|------|-------------|
| **Shared Types** | `shared/src/index.ts` | `LoopConfig`, `StartLoopMessage`, `CancelLoopMessage`, `LoopIterationStart/End/Complete` messages, `isLoopMarker` on Message |
| **Client Store** | `client/src/stores/conversationStore.ts` | `startLoop()`, `cancelLoop()`, handlers for `loop_iteration_start`, `loop_iteration_end`, `loop_complete` |
| **Client UI** | `client/src/components/Chat.tsx` | Loop popup (5x/10x/20x radio + clear context checkbox + Start Loop button), Ralph Wiggum button, loop badge in header, cancel loop button |
| **Client CSS** | `client/src/components/Chat.css` | `.loop-popup`, `.loop-btn`, `.loop-icon`, `.loop-badge`, `.loop-option`, `.clear-context-option`, `.start-loop-btn`, `.cancel-loop-btn`, `.message.loop-marker` |
| **Gallery CSS** | `client/src/components/Gallery.css` | `.state-badge.state-looping` with magenta pulsing animation |
| **Server** | `server/src/server.ts` | `runLoop()`, `sendAndWaitForComplete()`, `cancelLoop()`, `Conversation.resetProcess()`, `Conversation.loopConfig` field, WebSocket `start_loop`/`cancel_loop` handlers |
| **Icon** | `client/public/icons/ralph-wiggum.png` | Ralph Wiggum circular badge image |
| **Colors** | `client/src/index.css` + `docs/color_palette.md` | `--accent-loop: var(--magenta)` mapped to `#d33682`/`#dd459d` |

### What DOES NOT EXIST (gaps):

| Missing Piece | Impact |
|---------------|--------|
| **Sub-conversation model** | No parent/child relationship between loop iterations and the main conversation. Each `clearContext` reset just kills the process and starts fresh, but all messages dump into the same flat `conversation.messages[]` array. |
| **"Looped" queue message type** | Messages aren't queued with a "looped" status. The loop bypasses the queue entirely via `sendAndWaitForComplete()`. No "Nx" pending indicator in the UI for loop iterations. |
| **Process readiness after reset** | `resetProcess()` sets `isReady = false` but the loop engine doesn't wait for readiness. The broadcast of `isReady: false` confuses the client. |
| **Loop iteration visibility** | No "20x" or "Nx" badge for pending loop iterations in the queue display. The queue system is entirely bypassed. |
| **Sub-conversation UI grouping** | No visual grouping of iterations. Loop markers (`=== Loop 1/10 Start ===`) are plain system messages with no collapsibility or tree structure. |
| **Iteration countdown in sidebar/gallery** | Gallery shows `.state-looping` CSS but doesn't display remaining count on the card. |

---

## What's Broken and Why

### Bug 1: `resetProcess()` leaves `isReady = false`

**File:** `server/src/server.ts:477-488`

```typescript
resetProcess(): void {
  if (this.process) {
    this.process.kill();
    this.process = null;
    this.isRunning = false;
    this.isReady = false;  // <-- BUG: Set to false
  }
  this.claudeSessionId = uuidv4();
  this._hasStartedSession = false;
}
```

After `resetProcess()`, `isReady` is `false`. The loop engine then calls `conv.sendMessage()` which calls `spawnForMessage()`. `spawnForMessage()` only checks `this.isRunning` (not `this.isReady`), so the spawn succeeds. But `isReady = false` was already broadcast to the client via `broadcastStatus()` somewhere in the chain.

**Impact:** The client UI thinks the conversation is not ready. The client store's `_processQueue()` guard `!conv.isReady` prevents queue processing. The loop iteration handlers in the store may not update correctly because the conversation appears in a "not ready" state. The loop _may_ work server-side but the client shows incorrect state.

**Root cause:** `isReady` was designed for long-lived CLI processes that need time to initialize. In the spawn-per-message model, the conversation is always conceptually "ready" — we spawn fresh for each message.

**Fix:** Do NOT set `isReady = false` in `resetProcess()`. The conversation is always ready in spawn-per-message mode.

### Bug 2: `sendAndWaitForComplete` monkey-patches `handleOutput`

**File:** `server/src/server.ts:653-672`

```typescript
function sendAndWaitForComplete(conv: Conversation, prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const originalHandler = conv.handleOutput.bind(conv);
    conv.handleOutput = (json: unknown): void => {
      originalHandler(json);
      if (conv['_lastEvent']?.type === 'message_complete') {
        conv.handleOutput = originalHandler;
        conv['_lastEvent'] = null;
        setTimeout(resolve, 500);
      }
    };
    conv.sendMessage(prompt);
  });
}
```

Problems:

1. **Process `close` race condition:** `spawnForMessage()` sets `process.on('close')` which sets `isRunning = false`. If the process exits before `message_complete` is fully parsed, the monkey-patched handler may never see `message_complete`. The Promise hangs forever, stalling the entire loop.

2. **No timeout:** If Claude CLI crashes, hangs, or produces malformed output, the Promise never resolves. The loop is stuck permanently with no recovery.

3. **`_lastEvent` access via bracket notation:** `conv['_lastEvent']` accesses a private field — fragile and easy to break during refactoring.

4. **Handler restoration race:** If `handleOutput` is called concurrently (shouldn't happen but defensive code elsewhere might try), the handler chain corrupts.

**Fix:** Make `Conversation` extend `EventEmitter`. Emit `'iteration_complete'` from `handleOutput()` when `message_complete` is received. Listen for the event in the loop engine with a timeout.

### Bug 3: Loop bypasses the queue entirely

The loop sends messages via `conv.sendMessage()` directly on the server, bypassing the client's queue system. This means:

- No "Nx pending" indicator in the UI
- No ability to see/cancel individual pending iterations from the queue
- The queue guard `conv.loopConfig?.isLooping` pauses normal queue processing, but the loop itself doesn't use the queue at all
- If a user queues messages *before* starting a loop, those queued messages are stuck until the entire loop finishes
- There is zero visual feedback in the input area about what the loop is doing

### Bug 4: No sub-conversation isolation in the UI

When `clearContext = true`, `resetProcess()` generates a new `claudeSessionId`. This correctly gives Claude fresh context per the CLI's `--session-id` flag.

**However:** All messages (from all 20 iterations) dump into the same `conversation.messages[]` array. The only visual separation is `isLoopMarker` system messages (`=== Loop 3/20 Start ===`). There are no:
- Collapsible iteration groups
- Separate message arrays per iteration
- Sub-conversation IDs for tracking
- Ways to distinguish iteration 3's assistant response from iteration 7's

### Bug 5: Loop button disabled state is confusing

```tsx
// Chat.tsx:486
disabled={!canInput || !hasInput || willQueue}
```

The button requires `canInput` (`isReady && !isLooping`) AND `hasInput` AND `!willQueue`. But:
- If the textarea is empty, the button is grayed out with only a generic title tooltip
- There's no feedback explaining "type a prompt first"
- `willQueue` disables the loop button while a message is processing, but the user might want to queue a loop

---

## Desired Behavior (User Story)

### Happy Path Flow:

1. User types a prompt in the textarea (e.g., "Build me a widget")
2. User clicks the Ralph Wiggum button (🔄 icon)
3. **Popup appears** with:
   - Loop count selector: `[ 5x ] [ 10x ] [ 20x ]` (radio buttons)
   - `☑ Clear context on each loop` checkbox (default: ON)
   - `[ Start Loop ]` button
4. User selects 20x, leaves clear context on, clicks "Start Loop"
5. **UI immediately shows:**
   - Textarea is cleared
   - In the queue area: `🔁 20x | "Build me a widget"` with a Cancel button
   - Loop badge in header: `1/20` (magenta, pulsing)
   - Input is disabled (grayed out)
6. **Server begins executing iterations:**
   - For each iteration, spawns a new Claude process
   - Messages stream into the chat
   - Each iteration is visually grouped with a collapsible header: `▼ Loop 1/20`
   - The queue counter decrements: `19x`, `18x`, `17x`...
7. **Each iteration completion** updates the badge (`2/20`, `3/20`...) and decrements the counter
8. **User can cancel** via "Cancel Loop (17 remaining)" button → loop stops after current iteration finishes
9. **On completion:** loop badge disappears, queue counter clears, input re-enables

### Sub-Conversation Behavior:

**When `clearContext = true`:**
- Each iteration is a separate Claude session (new `--session-id`)
- Claude has NO memory of previous iterations
- Messages appear grouped in collapsible sections within the same chat thread
- These are NOT separate conversations in the sidebar

**When `clearContext = false`:**
- All iterations share the same Claude session (`--resume`)
- Claude sees the full conversation history (prompt + all prior responses)
- Messages appear in one continuous thread with loop markers separating iterations

---

## Architecture: Sub-Conversations vs Single Thread

### Option A: True Sub-Conversations (V2)

Each loop iteration with `clearContext = true` creates a child `Conversation` object:

```
Main Conversation (id: abc-123)
  ├── Iteration 1 (session: xyz-001) — messages: [user, assistant]
  ├── Iteration 2 (session: xyz-002) — messages: [user, assistant]
  └── Iteration 3 (session: xyz-003) — messages: [user, assistant]
```

**Pros:** Clean separation, re-runnable iterations, maps to sub-agent UI pattern
**Cons:** Complex model changes, persistence rework, sidebar filtering needed

### Option B: Flat Messages with Loop Groups (V1 — Recommended)

Keep all messages in one flat array. Add metadata to group them:

```typescript
interface Message {
  // ... existing fields
  loopIteration?: number;   // Which iteration (1-based)
  loopTotal?: number;       // Total iterations in this loop run
}
```

**Pros:** Minimal model changes, already partially working, simple persistence
**Cons:** Grouping depends on correct marker placement, no per-iteration re-run

### Decision: **Option B for V1, Option A for V2**

Option B gets the feature working with minimal changes. Option A is the right long-term architecture but requires significant refactoring.

---

## Detailed Design

### 6.1 Shared Types Changes (`shared/src/index.ts`)

**MessageSchema — add loop metadata:**
```typescript
export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.coerce.date(),
  isLoopMarker: z.boolean().optional(),
  loopIteration: z.number().int().positive().optional(),  // NEW
  loopTotal: z.number().int().positive().optional(),       // NEW
});
```

**LoopConfigSchema — add loopId:**
```typescript
export const LoopConfigSchema = z.object({
  loopId: z.string().uuid(),                    // NEW: unique ID for this loop run
  totalIterations: z.number().int().positive(),
  currentIteration: z.number().int().nonnegative(),
  loopsRemaining: z.number().int().nonnegative(),
  clearContext: z.boolean(),
  prompt: z.string(),
  isLooping: z.boolean(),
});
```

### 6.2 Server Changes (`server/src/server.ts`)

**Fix `resetProcess()`:**
```typescript
resetProcess(): void {
  if (this.process) {
    this.process.kill();
    this.process = null;
    this.isRunning = false;
    // NOTE: Do NOT set isReady = false. We spawn per message, always ready.
    // See docs/ralph_loop_design.md §Bug 1.
  }
  this.claudeSessionId = uuidv4();
  this._hasStartedSession = false;
}
```

**Make Conversation extend EventEmitter:**
```typescript
import { EventEmitter } from 'events';

class Conversation extends EventEmitter {
  // ... existing fields and methods

  handleOutput(json: unknown): void {
    // ... existing switch cases
    case 'message_complete': {
      // ... existing logic
      this.emit('iteration_complete');  // NEW: emit for loop engine
      break;
    }
  }
}
```

**Replace `sendAndWaitForComplete()`:**
```typescript
function sendMessageAndWait(conv: Conversation, prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per iteration

    const cleanup = () => {
      conv.removeListener('iteration_complete', onComplete);
      conv.removeListener('close', onClose); // process close fallback
      clearTimeout(timer);
    };

    const onComplete = () => {
      cleanup();
      setTimeout(resolve, 500); // Brief delay before next iteration
    };

    const onClose = () => {
      // Process closed without message_complete — treat as complete
      cleanup();
      setTimeout(resolve, 500);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Loop iteration timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    conv.on('iteration_complete', onComplete);
    conv.sendMessage(prompt);
  });
}
```

**Tag messages with loop metadata:**
```typescript
// New fields on Conversation class:
_currentLoopIteration: number | null = null;
_currentLoopTotal: number | null = null;

// In handleOutput(), when creating assistant messages:
case 'text_delta': {
  const lastMsg = this.messages[this.messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'assistant') {
    const newMsg: Message = {
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      loopIteration: this._currentLoopIteration ?? undefined,
      loopTotal: this._currentLoopTotal ?? undefined,
    };
    this.messages.push(newMsg);
    // ... broadcast
  }
}
```

### 6.3 Client Store Changes (`conversationStore.ts`)

**Extend QueuedMessage:**
```typescript
export interface QueuedMessage {
  id: string;
  content: string;
  queuedAt: Date;
  status: 'pending' | 'sending';
  isLoop?: boolean;                    // NEW
  loopIterationsTotal?: number;        // NEW
  loopIterationsRemaining?: number;    // NEW
}
```

**Update `startLoop()`:**
```typescript
startLoop: (conversationId, prompt, iterations, clearContext) => {
  const total = Number.parseInt(iterations, 10);

  // Create synthetic loop queue entry for UI display
  set((state) => {
    const queues = new Map(state.queues);
    queues.set(conversationId, [{
      id: crypto.randomUUID(),
      content: prompt,
      queuedAt: new Date(),
      status: 'sending',
      isLoop: true,
      loopIterationsTotal: total,
      loopIterationsRemaining: total,
    }]);
    return { queues };
  });

  get()._send({ type: 'start_loop', conversationId, prompt, iterations, clearContext });
},
```

**Update `loop_iteration_end` handler:**
```typescript
case 'loop_iteration_end':
  set((state) => {
    // Update loopConfig
    const conversations = new Map(state.conversations);
    const conv = conversations.get(data.conversationId);
    if (conv) {
      conversations.set(data.conversationId, {
        ...conv,
        loopConfig: {
          ...conv.loopConfig!,
          currentIteration: data.currentIteration,
          loopsRemaining: data.loopsRemaining,
          isLooping: true,
        },
      });
    }

    // Decrement loop queue counter
    const queues = new Map(state.queues);
    const queue = queues.get(data.conversationId) || [];
    const updatedQueue = queue.map((m) =>
      m.isLoop ? { ...m, loopIterationsRemaining: data.loopsRemaining } : m
    );
    queues.set(data.conversationId, updatedQueue);

    return { conversations, queues };
  });
  break;
```

**Update `loop_complete` handler:**
```typescript
case 'loop_complete':
  set((state) => {
    const conversations = new Map(state.conversations);
    const conv = conversations.get(data.conversationId);
    if (conv) {
      conversations.set(data.conversationId, { ...conv, loopConfig: null });
    }

    // Clear loop queue entry
    const queues = new Map(state.queues);
    queues.set(data.conversationId, []);

    return { conversations, queues };
  });
  break;
```

### 6.4 UI Changes (`Chat.tsx`)

**Queue display for loop entries:**
```tsx
{/* In the queue display area */}
{pendingQueue.map((msg, index) => (
  <div key={msg.id} className={`queued-message ${msg.isLoop ? 'loop-queued' : ''}`}>
    {msg.isLoop ? (
      <div className="loop-queue-entry">
        <img src="/icons/ralph-wiggum.png" className="loop-queue-icon" />
        <span className="loop-queue-count">{msg.loopIterationsRemaining}x</span>
        <span className="loop-queue-prompt">{msg.content.substring(0, 50)}</span>
      </div>
    ) : (
      <div className="queued-message-content">
        <span>#{index + 1} in queue</span>
        <span>{msg.content.substring(0, 50)}</span>
      </div>
    )}
  </div>
))}
```

**Collapsible loop iteration groups (new):**
```tsx
// useMemo to group messages by loop iteration
const messageGroups = useMemo(() => {
  if (!conversation) return [];
  const groups: Array<{
    type: 'single' | 'loop-group';
    iteration?: number;
    total?: number;
    messages: Message[];
  }> = [];

  let currentLoopGroup: typeof groups[0] | null = null;

  for (const msg of conversation.messages) {
    if (msg.isLoopMarker && msg.content.includes('Start')) {
      currentLoopGroup = {
        type: 'loop-group',
        iteration: msg.loopIteration,
        total: msg.loopTotal,
        messages: [],
      };
      groups.push(currentLoopGroup);
    } else if (msg.isLoopMarker && msg.content.includes('End')) {
      currentLoopGroup = null;
    } else if (currentLoopGroup) {
      currentLoopGroup.messages.push(msg);
    } else {
      groups.push({ type: 'single', messages: [msg] });
    }
  }
  return groups;
}, [conversation?.messages]);
```

---

## Message Protocol

### Client -> Server (existing, no changes)

| Type | Fields | When |
|------|--------|------|
| `start_loop` | `conversationId`, `prompt`, `iterations` ('5'/'10'/'20'), `clearContext` | User clicks "Start Loop" |
| `cancel_loop` | `conversationId` | User clicks "Cancel Loop" |

### Server -> Client (existing, minor enhancements)

| Type | Fields | When |
|------|--------|------|
| `loop_iteration_start` | `conversationId`, `currentIteration`, `totalIterations` | Before each iteration begins |
| `loop_iteration_end` | `conversationId`, `currentIteration`, `totalIterations`, `loopsRemaining` | After each iteration completes |
| `loop_complete` | `conversationId`, `totalIterations` | After all iterations finish or cancelled |
| `message` | role=`system`, isLoopMarker=`true` | Start/end markers for each iteration |
| `status` | `isRunning: true` | At loop start |
| `status` | `isRunning: false` | At loop end |

---

## UI Specification

### Loop Popup (existing, works correctly)

```
┌─────────────────────────────┐
│  Loop Options               │
│                             │
│  ○ 5x   ● 10x   ○ 20x     │
│                             │
│  ☑ Clear context between    │
│    iterations               │
│                             │
│  [ Start Loop ]             │
└─────────────────────────────┘
```

### Loop Active State (target layout)

```
┌──────────────────────────────────────────────────┐
│ abc12345 | claude | ~/project | Loop: 3/20 ●     │
├──────────────────────────────────────────────────┤
│                                                   │
│  ▼ Loop 1/20 ───────────────────────────────      │
│    [user] Build me a widget                       │
│    [assistant] Here's your widget...              │
│                                                   │
│  ▼ Loop 2/20 ───────────────────────────────      │
│    [user] Build me a widget                       │
│    [assistant] I'll create a widget...            │
│                                                   │
│  ▶ Loop 3/20 (running...) ──────────────────      │
│    [user] Build me a widget                       │
│    [assistant] ███ (streaming)                    │
│                                                   │
├──────────────────────────────────────────────────┤
│  [Cancel Loop (17 remaining)]                     │
│                                                   │
│  🔁 17x remaining │ "Build me a widget"           │
│                                                   │
│  ┌──────────────────────────────────────────┐     │
│  │ (input disabled during loop)             │     │
│  └──────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
```

### Queue Display During Loop

```
┌──────────────────────────────────────┐
│ 🔁 17x │ "Build me a widget"  [✕]   │
└──────────────────────────────────────┘
```

The `17x` decrements as iterations complete. Ralph icon replaces queue position number. `[✕]` cancels the loop.

### Gallery Card During Loop

```
┌────────────────────────────┐
│ abc12345 │ claude           │
│ ● Looping 3/20             │  ← magenta pulsing badge
│ 47 messages                 │
│ "Build me a widget..."      │
└────────────────────────────┘
```

---

## Server-Side Loop Engine

### Current Flow (buggy):

```
Client → WS: start_loop(convId, prompt, '20', true)
Server → runLoop(conv, prompt, '20', true)
  → conv.loopConfig = { totalIterations: 20, isLooping: true }
  → broadcast status(isRunning: true)
  → for i = 1..20:
      → cancel check
      → if clearContext && i>1: conv.resetProcess()  ← BUG: isReady=false
      → broadcast loop_iteration_start(i, 20)
      → add start marker message
      → sendAndWaitForComplete(conv, prompt)  ← BUG: monkey-patches handleOutput
        → conv.sendMessage(prompt)
          → spawnForMessage(prompt) → spawn CLI
        → waits for _lastEvent === 'message_complete' (may hang)
      → add end marker message
      → broadcast loop_iteration_end(i, 20, 20-i)
  → conv.loopConfig = null
  → broadcast loop_complete(20)
```

### Fixed Flow:

```
Client → WS: start_loop(convId, prompt, '20', true)
Server → runLoop(conv, prompt, '20', true)
  → conv.loopConfig = { loopId: uuid(), totalIterations: 20, isLooping: true }
  → broadcast status(isRunning: true)
  → for i = 1..20:
      → cancel check (if !conv.loopConfig.isLooping: break)
      → if clearContext && i>1:
          → conv.resetProcess()    // FIXED: does NOT set isReady=false
      → conv._currentLoopIteration = i
      → conv._currentLoopTotal = 20
      → broadcast loop_iteration_start(i, 20)
      → add start marker (tagged with loopIteration=i)
      → try:
          → await sendMessageAndWait(conv, prompt)  // FIXED: EventEmitter + timeout
        catch timeout:
          → log error, broadcast error, continue or break
      → add end marker
      → broadcast loop_iteration_end(i, 20, 20-i)
  → conv.loopConfig = null
  → conv._currentLoopIteration = null
  → broadcast loop_complete(20)
```

### Key Fixes:

1. **`resetProcess()`** — `isReady` stays `true`
2. **`sendMessageAndWait()`** — Uses EventEmitter, not monkey-patching. Has 5-minute timeout.
3. **Messages tagged** — `loopIteration` and `loopTotal` on every message created during loop
4. **Error handling** — Timeout catches hung iterations, loop can continue or abort gracefully

---

## Sub-Conversation Lifecycle

### When `clearContext = true`:

```
Conversation abc-123
  claudeSessionId: sess-001  (initial)

  Loop starts (20 iterations):
    Iteration 1: session = sess-001
      → spawn claude --session-id sess-001 --print --output-format stream-json
      → process exits after response

    Iteration 2: resetProcess() → session = sess-002 (new UUID)
      → spawn claude --session-id sess-002 --print --output-format stream-json
      → process exits after response

    ... (18 more, each with fresh session ID)

  Loop complete:
    claudeSessionId = sess-020 (last iteration)
    _hasStartedSession = true

  Next manual message:
    → spawn claude --resume sess-020 ...
    → (resumes LAST iteration's context)
```

**Post-loop context note:** After a `clearContext` loop, the conversation resumes the LAST iteration's session. The user continues where iteration 20 left off. If they want fresh context, they need to manually use the existing session reset mechanism (or we add a "reset context" button).

### When `clearContext = false`:

```
Conversation abc-123
  claudeSessionId: sess-001  (stays the same throughout)

  Iteration 1: --session-id sess-001 (first use)
  Iteration 2: --resume sess-001
  Iteration 3: --resume sess-001
  ... (17 more, all --resume sess-001)

  Next manual message: --resume sess-001 (continues same context)
```

All iterations build on each other. Claude sees the full history.

### Sidebar/Gallery Visibility:

Sub-conversations (loop iterations) MUST NOT appear as separate entries. The `conversations` Map on the server contains only top-level conversations. Loop iterations are managed within `runLoop()` and share the parent conversation's `id`. No new entries are added to the map. **This is already correct in the current implementation.**

---

## Queue Integration

### Problem:

The loop engine calls `conv.sendMessage()` directly server-side, bypassing the client queue. The client has zero visibility into pending iterations.

### Solution: Synthetic Loop Queue Entry

The server drives loop execution. The client creates a display-only "loop" queue entry:

1. **`startLoop()`** — Creates a `QueuedMessage` with `isLoop: true, loopIterationsTotal: 20, loopIterationsRemaining: 20`
2. **`loop_iteration_end`** — Store handler decrements `loopIterationsRemaining`
3. **`loop_complete`** — Store handler clears the queue entry
4. **Queue display** — Shows `🔁 17x` instead of `#1 in queue`

### Queue vs Loop Ordering:

If messages are queued before a loop starts, the loop starts immediately (server-side). Existing queued messages are paused (`conv.loopConfig?.isLooping` guard in `_processQueue`). After the loop completes, the queue resumes normally. This is the simplest correct behavior.

---

## Persistence & History

### Current State:

- Messages stored in `conversation.messages[]` (in-memory)
- Claude provider: persisted via CLI's own JSONL files in `~/.claude/projects/.../sessions/`
- Codex provider: persisted via adapter's JSONL writer
- Loop markers are system messages with `isLoopMarker: true`
- On reload: messages reconstructed from JSONL files

### Required Changes for V1:

1. **Loop metadata persists with messages** — `loopIteration` and `loopTotal` are included in message objects
2. **`loopConfig` is NOT persisted** — Transient in-memory state. Server restart = loop lost. Acceptable for V1.
3. **JSONL file management** — With `clearContext = true`, each iteration creates a separate JSONL file (different session ID). These files are independent on disk and currently unlinked to each other.

### Risk: Server Restart During Loop

If the server restarts during a 20x loop:
- `loopConfig` is lost (in-memory only)
- Individual JSONL sessions remain on disk
- They'll appear as separate conversations on next load (each session file = one conversation)
- No way to re-correlate them to the original parent conversation

**V2 mitigation:** Persist loop metadata (parent conversation ID, iteration index) in a sidecar file or within the JSONL entries.

---

## File Inventory

### Files to MODIFY:

| File | Changes Needed |
|------|----------------|
| `shared/src/index.ts` | Add `loopIteration`, `loopTotal` to `MessageSchema`. Add `loopId` to `LoopConfigSchema`. |
| `server/src/server.ts` | Fix `resetProcess()` (don't set isReady=false). Make `Conversation` extend `EventEmitter`. Replace `sendAndWaitForComplete()` with EventEmitter-based `sendMessageAndWait()`. Add `_currentLoopIteration`/`_currentLoopTotal` fields. Tag messages with loop metadata. Add timeout per iteration. |
| `client/src/stores/conversationStore.ts` | Add `isLoop`/`loopIterationsTotal`/`loopIterationsRemaining` to `QueuedMessage`. Update `startLoop()` to create synthetic queue entry. Update loop event handlers to decrement. Update `loop_complete` to clear queue. |
| `client/src/components/Chat.tsx` | Display loop queue entries with "Nx" counter and Ralph icon. Group messages by loop iteration with collapsible headers. |
| `client/src/components/Chat.css` | New styles: `.loop-queued`, `.loop-queue-entry`, `.loop-queue-count`, `.loop-queue-icon`, `.loop-iteration-group`, `.loop-iteration-header` |
| `client/src/components/Gallery.tsx` | Show loop iteration count on `.state-looping` badge (e.g., "Looping 3/20") |

### Files that DON'T need changes:

| File | Why |
|------|-----|
| `client/src/components/SubAgentPanel.tsx` | Sub-agents track Task tool invocations, not loop iterations. Keep separate. |
| `server/src/providers/claude.ts` | Provider interface unchanged. Loop is server-level orchestration. |
| `server/src/providers/codex.ts` | Same — provider-agnostic. |
| `server/src/adapters/jsonl.ts` | V1: no persistence changes needed. |

---

## Implementation Plan

### Phase 1: Fix Core Bugs (get basic loop working end-to-end)

1. **Fix `resetProcess()`** — Remove `this.isReady = false` line
2. **Make `Conversation` extend `EventEmitter`** — Import EventEmitter, extend class
3. **Emit `'iteration_complete'`** — From `handleOutput()` when `message_complete` case fires
4. **Replace `sendAndWaitForComplete()`** — New `sendMessageAndWait()` using `conv.on('iteration_complete', ...)` with 5-minute timeout
5. **Test:** Start 3x loop with `clearContext=true`, verify all 3 iterations complete and messages appear in chat

### Phase 2: Queue Integration (show Nx counter in UI)

1. Add `isLoop`, `loopIterationsTotal`, `loopIterationsRemaining` fields to `QueuedMessage` interface
2. Update `startLoop()` in store to create synthetic loop queue entry
3. Update `loop_iteration_end` handler to decrement `loopIterationsRemaining`
4. Update `loop_complete` handler to clear loop queue entry
5. Update Chat.tsx queue display to render loop entries with Ralph icon and "Nx" counter
6. **Test:** Verify counter decrements live as iterations complete

### Phase 3: Message Grouping (collapsible iteration sections)

1. Add `loopIteration`, `loopTotal` to shared `MessageSchema`
2. Server tags messages with loop metadata during loop execution
3. Add `useMemo` grouping logic in Chat.tsx to cluster messages by iteration
4. Render iteration groups with collapsible headers (expand/collapse state)
5. Style iteration headers (magenta accent, iteration label, expand arrow)
6. **Test:** Verify messages group correctly, collapse/expand works

### Phase 4: Polish

1. Gallery card: show "Looping 3/20" with iteration numbers on badge
2. Sidebar: loop indicator on active conversation
3. Handle WebSocket reconnect during loop (recreate synthetic queue entry from `loopConfig`)
4. Add Ctrl+Shift+L keyboard shortcut to open loop popup

---

## Edge Cases & Failure Modes

| Scenario | Current Behavior | Desired Behavior |
|----------|-----------------|------------------|
| Process crash mid-iteration | `sendAndWaitForComplete` hangs forever | Timeout after 5 min. Log error. Skip to next iteration or abort loop. |
| User cancels loop | `isLooping = false`, checked at loop top | Same + broadcast `loop_complete` with actual completed count. Clear synthetic queue entry. |
| Server restart during loop | Loop state lost entirely | Accept for V1. Individual JSONL sessions survive. User sees them as separate convos on reload. |
| WebSocket disconnect during loop | Loop continues server-side. Client reconnects, gets `init`. | `init` includes `loopConfig`. Client should recreate synthetic queue entry from config. |
| Start loop while queue has pending messages | Queue paused during loop | Correct — existing guard works. Queue resumes after loop. |
| Double-start loop | Guard: `!conv.loopConfig?.isLooping` prevents | Correct. |
| clearContext=false + 20 iterations | Context grows each iteration | Works but may hit Claude token limits. No automatic handling needed. |
| Loop with Codex provider | Uses same engine. `resetProcess()` works. | Works. Codex is stateless so clearContext is effectively always true. |
| Very long response mid-loop | Iteration takes a long time | 5-min timeout per iteration. If hit, treats as error. Could make configurable. |

---

## Comments & Stability Notes

### Critical Code Comments to Add

**`server/src/server.ts` — `resetProcess()`:**
```typescript
// IMPORTANT: Do NOT set isReady = false here. We spawn a fresh process per
// message (spawnForMessage), so the conversation is always conceptually "ready."
// Setting isReady = false broadcasts a false "not ready" state to the client,
// which breaks the loop engine. See docs/ralph_loop_design.md §Bug 1.
```

**`server/src/server.ts` — `runLoop()`:**
```typescript
// RALPH LOOP ENGINE: Executes the same prompt N times in sequence.
// Each iteration spawns a new CLI process via sendMessage().
// When clearContext=true, resetProcess() generates a new session ID.
// All messages stay in conversation.messages[] — iterations are separated
// by isLoopMarker messages and tagged with loopIteration metadata.
// Loop iterations do NOT appear as separate conversations in the sidebar.
// See docs/ralph_loop_design.md for full architecture.
```

**`client/src/stores/conversationStore.ts` — `startLoop()`:**
```typescript
// Loop execution is server-driven. The client creates a synthetic "loop"
// queue entry for display only (the "Nx" counter). The server sends
// loop_iteration_end events to decrement the counter. The entry is cleared
// on loop_complete. Normal queue processing is paused during loops
// (guarded in _processQueue by conv.loopConfig?.isLooping).
```

**`client/src/components/Chat.tsx` — loop popup:**
```tsx
{/* RALPH LOOP POPUP — Configures and launches the loop feature.
    Popup offers 5x/10x/20x counts + clearContext toggle.
    On "Start Loop", sends start_loop to server which orchestrates
    all iterations. The queue area shows "Nx" countdown.
    See docs/ralph_loop_design.md for full spec. */}
```

### Stability Risks

1. **Process accumulation:** 20x loop = 20 sequential Claude CLI spawns. If any hang, the timeout (5 min) catches it but that's a long wait. Monitor process cleanup.

2. **Memory growth:** 20 iterations of long responses = potentially hundreds of messages. Consider virtualizing the message list for conversations > 200 messages.

3. **JSONL sprawl:** `clearContext=true` with 20 iterations = 20 JSONL session files in `~/.claude/projects/`. No cleanup mechanism exists. Acceptable for now.

4. **Race: process.close vs message_complete:** If the process exits before emitting `message_complete`, the EventEmitter listener won't fire. The `sendMessageAndWait` implementation should ALSO listen for process exit as a fallback completion signal.

5. **Client reconnect:** If WebSocket drops and reconnects mid-loop, the `init` message includes `loopConfig`. The client must recreate the synthetic queue entry from `loopConfig.loopsRemaining` to show the correct "Nx" counter.

---

## Appendix: Code Location Reference

### Server (`server/src/server.ts`):
- **Lines 90-138:** `Conversation` class fields (`loopConfig`, `_lastEvent`, etc.)
- **Lines 145-217:** `spawnForMessage()` — spawns CLI per message
- **Lines 230-430:** `handleOutput()` — parses provider events, broadcasts to clients
- **Lines 433-463:** `sendMessage()` — adds user message, calls spawnForMessage
- **Lines 477-488:** `resetProcess()` — kills process, new session ID (**BUG: isReady=false**)
- **Lines 530-646:** `runLoop()` — main loop engine
- **Lines 653-672:** `sendAndWaitForComplete()` — monkey-patches handleOutput (**BUG: fragile**)
- **Lines 675-681:** `cancelLoop()` — sets isLooping=false
- **Lines 852-863:** WebSocket handlers for `start_loop`, `cancel_loop`

### Client Store (`stores/conversationStore.ts`):
- **Lines 16-21:** `QueuedMessage` interface
- **Lines 78-79:** `startLoop()`, `cancelLoop()` signatures
- **Lines 133:** `loopConfig: null` in optimistic conversation stub
- **Lines 167-173:** `startLoop()`, `cancelLoop()` implementations
- **Lines 207:** Queue guard: `!conv.loopConfig?.isLooping`
- **Lines 266-310:** `_processQueue()` with loop guard at line 278
- **Lines 491-526:** Handlers for `loop_iteration_start/end`, `loop_complete`

### Client UI (`components/Chat.tsx`):
- **Lines 122-125:** Loop popup state (`showLoopPopup`, `loopCount`, `clearContext`)
- **Lines 131:** `isLooping` derived state
- **Lines 135:** `canInput` depends on `!isLooping`
- **Lines 293-300:** `handleStartLoop()` handler
- **Lines 302-306:** `handleCancelLoop()` handler
- **Lines 335-339:** Loop badge in header
- **Lines 409-412:** Cancel loop button
- **Lines 482-490:** Ralph Wiggum button
- **Lines 502-531:** Loop popup modal
