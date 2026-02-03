import { create } from 'zustand';
import type { ClientMessage, Conversation, ModelId, Provider, ServerMessage } from '@claude-web-view/shared';
import { PENDING_CONVERSATIONS_KEY, DRAFT_KEY_PREFIX, useUIStore } from './uiStore';

// =============================================================================
// Chunk Buffer
//
// Text chunks from the CLI arrive 100-200 times per response (1-20 chars each).
// Without buffering, each chunk triggers: new Map → clone messages array →
// new message object → Zustand notify → React re-render → Markdown re-parse
// of ALL messages. On long threads this is catastrophic.
//
// Fix: accumulate chunks in a plain object (outside React state) and flush
// to Zustand once per animation frame (~60Hz). This collapses 100-200 state
// updates into ~3-10 updates for a typical response.
// =============================================================================

const chunkBuffer: Map<string, string> = new Map();
let chunkFlushScheduled = false;

function flushChunkBuffer(): void {
  chunkFlushScheduled = false;
  if (chunkBuffer.size === 0) return;

  // Snapshot and clear before the synchronous set() call
  const pending = new Map(chunkBuffer);
  chunkBuffer.clear();

  useConversationStore.setState((state) => {
    const conversations = new Map(state.conversations);
    let changed = false;

    for (const [conversationId, bufferedText] of pending) {
      const conv = conversations.get(conversationId);
      if (!conv || conv.messages.length === 0) continue;

      const lastMsg = conv.messages[conv.messages.length - 1];
      if (lastMsg.role !== 'assistant') continue;

      // Structural sharing: reuse the same array, only replace the last element
      const messages = conv.messages.slice();
      messages[messages.length - 1] = {
        ...lastMsg,
        content: lastMsg.content + bufferedText,
      };
      conversations.set(conversationId, { ...conv, messages });
      changed = true;
    }

    return changed ? { conversations } : state;
  });
}

function scheduleChunkFlush(): void {
  if (!chunkFlushScheduled) {
    chunkFlushScheduled = true;
    requestAnimationFrame(flushChunkBuffer);
  }
}

// =============================================================================
// Message Queue Types
// =============================================================================

/**
 * A message waiting in the queue to be sent.
 * ID is generated client-side for UI tracking and cancel operations.
 *
 * Status:
 * - 'pending': Message is waiting in queue
 * - 'sending': Message is currently being sent to server
 *
 * Loop entries (isLoop=true) are synthetic display-only entries created by
 * startLoop() to show the "Nx" countdown. The server drives actual loop
 * execution; these entries just give the UI visibility into pending iterations.
 * See docs/ralph_loop_design.md §Queue Integration.
 */
export interface QueuedMessage {
  id: string;
  content: string;
  queuedAt: Date;
  status: 'pending' | 'sending';
  isLoop?: boolean;
  loopIterationsTotal?: number;
  loopIterationsRemaining?: number;
}

// =============================================================================
// Pending Conversations Persistence
//
// Stub conversations created optimistically (before server round-trip) are saved
// to localStorage so they survive page refresh. On init, they're reconciled with
// server state: known ones are replaced, unknown ones are re-sent.
// =============================================================================

interface PendingConversation {
  id: string;
  workingDirectory: string;
  provider: 'claude' | 'codex';
  model?: ModelId;
  createdAt: string; // ISO string for JSON serialization
}

function loadPendingConversations(): PendingConversation[] {
  const raw = localStorage.getItem(PENDING_CONVERSATIONS_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as PendingConversation[];
}

function savePendingConversation(conv: PendingConversation): void {
  const pending = loadPendingConversations();
  pending.push(conv);
  localStorage.setItem(PENDING_CONVERSATIONS_KEY, JSON.stringify(pending));
}

function removePendingConversation(id: string): void {
  const pending = loadPendingConversations().filter((c) => c.id !== id);
  if (pending.length === 0) {
    localStorage.removeItem(PENDING_CONVERSATIONS_KEY);
  } else {
    localStorage.setItem(PENDING_CONVERSATIONS_KEY, JSON.stringify(pending));
  }
}

// =============================================================================
// Store Interface
// =============================================================================

interface ConversationStore {
  // State
  conversations: Map<string, Conversation>;
  activeConversationId: string | null;
  wsStatus: 'connecting' | 'connected' | 'disconnected';
  defaultCwd: string;
  queues: Map<string, QueuedMessage[]>;

  // Actions
  setActiveConversationId: (id: string | null) => void;
  createConversation: (workingDirectory: string, provider?: Provider, model?: ModelId) => void;
  deleteConversation: (id: string) => void;
  sendMessage: (conversationId: string, content: string) => void;
  stopConversation: (conversationId: string) => void;
  interruptAndSend: (conversationId: string, content: string) => void;
  startLoop: (conversationId: string, prompt: string, iterations: '5' | '10' | '20', clearContext: boolean) => void;
  cancelLoop: (conversationId: string) => void;
  queueMessage: (conversationId: string, content: string) => void;
  cancelQueuedMessage: (conversationId: string, messageId: string) => void;
  clearQueue: (conversationId: string) => void;
  getQueue: (conversationId: string) => QueuedMessage[];

  // Internal — called by WebSocket bridge, not by components directly
  _handleMessage: (data: ServerMessage) => void;
  _processQueue: (conversationId: string) => void;
  _setSend: (send: (msg: ClientMessage) => void) => void;
  _setWsStatus: (status: 'connecting' | 'connected' | 'disconnected') => void;

  // Internal send function stored by _setSend
  _send: (msg: ClientMessage) => void;
}

// =============================================================================
// Store Implementation
//
// KEY DIFFERENCE FROM AppContext:
// No refs needed. Zustand's get() always returns current state,
// eliminating stale closure bugs that required 5 refs in AppContext.
// =============================================================================

export const useConversationStore = create<ConversationStore>((set, get) => ({
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  conversations: new Map(),
  activeConversationId: null,
  wsStatus: 'connecting',
  defaultCwd: '',
  queues: new Map(),
  _send: () => {},

  // ---------------------------------------------------------------------------
  // Public Actions
  // ---------------------------------------------------------------------------

  setActiveConversationId: (id) => set({ activeConversationId: id }),

  createConversation: (workingDirectory, provider = 'claude', model) => {
    const id = crypto.randomUUID();

    // Optimistic insert: conversation appears in store immediately (before server round-trip).
    // isReady: false — user can see the conversation but can't send messages until server confirms.
    const stub: Conversation = {
      id,
      messages: [],
      isRunning: false,
      isReady: false,
      createdAt: new Date(),
      workingDirectory,
      provider,
      model,
      loopConfig: null,
      subAgents: [],
    };

    set((state) => {
      const conversations = new Map(state.conversations);
      conversations.set(id, stub);
      return { conversations, activeConversationId: id };
    });

    // Persist stub to localStorage so it survives page refresh before server confirms
    savePendingConversation({ id, workingDirectory, provider, model, createdAt: stub.createdAt.toISOString() });

    // Tell server to create the real conversation with this ID
    get()._send({ type: 'new_conversation', id, workingDirectory, provider, model });
  },

  deleteConversation: (id) => {
    get()._send({ type: 'delete_conversation', conversationId: id });
  },

  /**
   * Send a chat message to a conversation.
   * Always routes through the queue for consistent ordering.
   */
  sendMessage: (conversationId, content) => {
    const conv = get().conversations.get(conversationId);
    if (!conv) {
      console.warn(`[Send] Cannot send message: conversation ${conversationId} not found`);
      return;
    }
    get().queueMessage(conversationId, content);
  },

  /**
   * Stop a running conversation by killing its process.
   * Sends stop_conversation to the server which calls process.kill().
   */
  stopConversation: (conversationId) => {
    const conv = get().conversations.get(conversationId);
    if (!conv) return;
    get()._send({ type: 'stop_conversation', conversationId });
  },

  /**
   * Interrupt a running conversation and send a new message.
   * Kills the current process, clears any pending queue, then queues
   * a wrapped message that tells the agent to continue with the adjustment.
   *
   * KEY BEHAVIOR: Enter while running = interrupt + adjusted prompt.
   * The server will kill the process, then the queue will auto-process
   * the new message once the conversation becomes ready again.
   */
  interruptAndSend: (conversationId, content) => {
    const conv = get().conversations.get(conversationId);
    if (!conv) return;

    // Kill running process
    get()._send({ type: 'stop_conversation', conversationId });

    // Clear any pending queue entries — the interrupt supersedes them
    get().clearQueue(conversationId);

    // Queue the wrapped interrupt message. It will auto-process once
    // the server broadcasts ready + not running after the kill completes.
    const wrappedContent = `We interrupted, please continue from the last input but with the adjustment: "${content}"`;
    get().queueMessage(conversationId, wrappedContent);
  },

  // Loop execution is server-driven. The client creates a synthetic "loop"
  // queue entry for display only (the "Nx" counter). The server sends
  // loop_iteration_end events to decrement the counter. The entry is cleared
  // on loop_complete. Normal queue processing is paused during loops
  // (guarded in _processQueue by conv.loopConfig?.isLooping).
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

  cancelLoop: (conversationId) => {
    get()._send({ type: 'cancel_loop', conversationId });
  },

  // ---------------------------------------------------------------------------
  // Queue Operations
  // ---------------------------------------------------------------------------

  /**
   * Queue a new message for a conversation.
   * If the conversation is ready and not busy, it will be processed immediately.
   */
  queueMessage: (conversationId, content) => {
    const conv = get().conversations.get(conversationId);
    if (!conv) {
      console.warn(`[Queue] Cannot queue message: conversation ${conversationId} not found`);
      return;
    }

    const newMessage: QueuedMessage = {
      id: crypto.randomUUID(),
      content,
      queuedAt: new Date(),
      status: 'pending',
    };

    console.log(`[Queue] Queueing message for ${conversationId.substring(0, 8)}: "${content.substring(0, 30)}"`);

    set((state) => {
      const queues = new Map(state.queues);
      const queue = [...(queues.get(conversationId) || []), newMessage];
      queues.set(conversationId, queue);
      return { queues };
    });

    // If conversation is ready and not running, process immediately
    if (conv.isReady && !conv.isRunning && !conv.loopConfig?.isLooping) {
      setTimeout(() => get()._processQueue(conversationId), 0);
    }
  },

  /**
   * Cancel a queued message by its ID.
   * Cannot cancel messages that are currently being sent.
   */
  cancelQueuedMessage: (conversationId, messageId) => {
    set((state) => {
      const queues = new Map(state.queues);
      const queue = (queues.get(conversationId) || []).filter((m) => {
        if (m.id === messageId && m.status === 'pending') {
          console.log(`[Queue] Cancelled message ${messageId.substring(0, 8)} for ${conversationId.substring(0, 8)}`);
          return false;
        }
        return true;
      });
      queues.set(conversationId, queue);
      return { queues };
    });
  },

  /**
   * Clear all queued messages for a conversation.
   * Only clears pending messages; sending messages will complete.
   */
  clearQueue: (conversationId) => {
    set((state) => {
      const queues = new Map(state.queues);
      const queue = queues.get(conversationId) || [];
      const sendingMessages = queue.filter((m) => m.status === 'sending');
      console.log(`[Queue] Clearing queue for ${conversationId.substring(0, 8)}: removed ${queue.length - sendingMessages.length} messages`);
      queues.set(conversationId, sendingMessages);
      return { queues };
    });
  },

  /**
   * Get the current queue for a conversation.
   * Returns an empty array if no queue exists.
   */
  getQueue: (conversationId) => {
    return get().queues.get(conversationId) || [];
  },

  // ---------------------------------------------------------------------------
  // Internal — WebSocket bridge and queue processing
  // ---------------------------------------------------------------------------

  _setSend: (send) => set({ _send: send }),

  _setWsStatus: (status) => set({ wsStatus: status }),

  /**
   * Process the next queued message for a conversation.
   * Uses get() for fresh state — no stale closures.
   */
  _processQueue: (conversationId) => {
    const { queues, conversations, _send } = get();
    const queue = queues.get(conversationId) || [];
    const conv = conversations.get(conversationId);

    // Guard: only process if ready and not running
    if (!conv || !conv.isReady || conv.isRunning) {
      console.log(`[Queue] Cannot process queue for ${conversationId.substring(0, 8)}: not ready or running`);
      return;
    }

    // Guard: don't process queue during loop mode
    if (conv.loopConfig?.isLooping) {
      console.log(`[Queue] Queue paused for ${conversationId.substring(0, 8)}: loop mode active`);
      return;
    }

    if (queue.length === 0) {
      return;
    }

    const nextMessage = queue[0];

    // Don't re-send if already sending
    if (nextMessage.status === 'sending') {
      console.log(`[Queue] Message already sending for ${conversationId.substring(0, 8)}`);
      return;
    }

    console.log(`[Queue] Processing next message for ${conversationId.substring(0, 8)}: "${nextMessage.content.substring(0, 30)}"`);

    // Mark as sending in queue
    set((state) => {
      const queues = new Map(state.queues);
      const q = [...(queues.get(conversationId) || [])];
      if (q.length > 0) {
        q[0] = { ...q[0], status: 'sending' };
        queues.set(conversationId, q);
      }
      return { queues };
    });

    // Send via WebSocket
    _send({ type: 'send_message', conversationId, content: nextMessage.content });
  },

  /**
   * Handle incoming server messages.
   * All state reads use get() — always fresh, no refs needed.
   */
  _handleMessage: (data) => {
    switch (data.type) {
      case 'init': {
        console.log(`[WS] init: ${data.conversations.length} conversations`);
        data.conversations.forEach((conv) => {
          console.log(`[WS] init conv ${conv.id.substring(0, 8)}: ${conv.messages.length} messages`);
        });
        const convMap = new Map<string, Conversation>();
        data.conversations.forEach((conv) => convMap.set(conv.id, conv));

        // Reconcile pending conversations from localStorage.
        // Any that the server knows about are already in convMap — remove from pending.
        // Any the server doesn't know about: re-add stub + re-send new_conversation.
        const pending = loadPendingConversations();
        for (const pc of pending) {
          if (convMap.has(pc.id)) {
            // Server already has it — no longer pending
            removePendingConversation(pc.id);
          } else {
            // Server doesn't know about it — re-insert stub and re-send
            const stub: Conversation = {
              id: pc.id,
              messages: [],
              isRunning: false,
              isReady: false,
              createdAt: new Date(pc.createdAt),
              workingDirectory: pc.workingDirectory,
              provider: pc.provider,
              model: pc.model,
              loopConfig: null,
              subAgents: [],
            };
            convMap.set(pc.id, stub);
            // Re-send creation request after state is set (deferred so _send is available)
            setTimeout(() => {
              get()._send({ type: 'new_conversation', id: pc.id, workingDirectory: pc.workingDirectory, provider: pc.provider, model: pc.model });
            }, 0);
          }
        }

        set({ defaultCwd: data.defaultCwd, conversations: convMap });

        // Recreate synthetic loop queue entries for any conversations that are actively looping.
        // This handles WebSocket reconnect during an active loop — the server is still running
        // the loop, but the client lost its synthetic queue entry. Rebuild from loopConfig.
        for (const conv of convMap.values()) {
          if (conv.loopConfig?.isLooping) {
            set((state) => {
              const queues = new Map(state.queues);
              queues.set(conv.id, [{
                id: crypto.randomUUID(),
                content: conv.loopConfig?.prompt ?? '',
                queuedAt: new Date(),
                status: 'sending',
                isLoop: true,
                loopIterationsTotal: conv.loopConfig?.totalIterations ?? 0,
                loopIterationsRemaining: conv.loopConfig?.loopsRemaining ?? 0,
              }]);
              return { queues };
            });
          }
        }
        break;
      }

      case 'conversation_created':
        // Merge: conversation may already exist from optimistic insert in createConversation.
        // Server data wins (has validated workingDirectory, etc.), but don't reset activeConversationId
        // if user has already navigated away.
        set((state) => {
          const conversations = new Map(state.conversations);
          conversations.set(data.conversation.id, data.conversation);
          return { conversations };
        });
        // Server confirmed — no longer pending
        removePendingConversation(data.conversation.id);
        break;

      case 'conversation_deleted':
        set((state) => {
          const conversations = new Map(state.conversations);
          conversations.delete(data.conversationId);
          const queues = new Map(state.queues);
          queues.delete(data.conversationId);
          // Use get() for fresh activeConversationId — no ref needed
          const activeConversationId = state.activeConversationId === data.conversationId
            ? null
            : state.activeConversationId;
          return { conversations, queues, activeConversationId };
        });
        // Clean up localStorage: pending stub + draft
        removePendingConversation(data.conversationId);
        localStorage.removeItem(`${DRAFT_KEY_PREFIX}${data.conversationId}`);
        break;

      case 'message':
        console.log(`[WS] message event: role=${data.role}, content="${data.content.substring(0, 50)}"`);
        set((state) => {
          const conversations = new Map(state.conversations);
          const conv = conversations.get(data.conversationId);
          if (conv) {
            // DEDUP: Don't create another assistant message if last one is already assistant
            const lastMsg = conv.messages[conv.messages.length - 1];
            if (data.role === 'assistant' && lastMsg?.role === 'assistant') {
              console.log('[WS] Skipping duplicate assistant message');
              return state;
            }
            console.log(`[WS] Adding message #${conv.messages.length + 1} (role=${data.role})`);
            conversations.set(data.conversationId, {
              ...conv,
              messages: [
                ...conv.messages,
                {
                  role: data.role,
                  content: data.content,
                  timestamp: new Date(),
                },
              ],
            });
          }
          return { conversations };
        });
        break;

      case 'chunk':
        // Buffer chunks and flush once per animation frame (~60Hz).
        // See "Chunk Buffer" comment at top of file for rationale.
        if (data.text.length > 0) {
          const existing = chunkBuffer.get(data.conversationId) ?? '';
          chunkBuffer.set(data.conversationId, existing + data.text);
          scheduleChunkFlush();
        }
        break;

      case 'status':
        set((state) => {
          const conversations = new Map(state.conversations);
          const conv = conversations.get(data.conversationId);
          if (conv) {
            conversations.set(data.conversationId, { ...conv, isRunning: data.isRunning });
          }
          return { conversations };
        });
        // When status changes to not running, try processing queue
        if (!data.isRunning) {
          setTimeout(() => get()._processQueue(data.conversationId), 100);
        }
        break;

      case 'error':
        alert(data.message);
        break;

      case 'ready':
        set((state) => {
          const conversations = new Map(state.conversations);
          const conv = conversations.get(data.conversationId);
          if (conv) {
            conversations.set(data.conversationId, { ...conv, isReady: data.isReady });
          }
          return { conversations };
        });
        // When ready, try processing any queued messages
        if (data.isReady) {
          setTimeout(() => get()._processQueue(data.conversationId), 100);
        }
        break;

      case 'message_complete':
        // Flush any buffered chunks synchronously — message_complete can arrive
        // in the same event loop tick as the last chunk, before rAF fires.
        flushChunkBuffer();
        // Remove the first message from queue (it was the one that was sending)
        console.log(`[Queue] message_complete for ${data.conversationId.substring(0, 8)}`);
        set((state) => {
          const queues = new Map(state.queues);
          const queue = queues.get(data.conversationId) || [];
          if (queue.length > 0 && queue[0].status === 'sending') {
            queues.set(data.conversationId, queue.slice(1));
          }
          return { queues };
        });
        // Process next message after a brief delay to ensure state is updated
        setTimeout(() => get()._processQueue(data.conversationId), 100);
        break;

      case 'loop_iteration_start':
      case 'loop_iteration_end':
        set((state) => {
          // Update loopConfig on the conversation
          const conversations = new Map(state.conversations);
          const conv = conversations.get(data.conversationId);
          if (conv) {
            conversations.set(data.conversationId, {
              ...conv,
              loopConfig: {
                ...conv.loopConfig,
                totalIterations: data.totalIterations,
                currentIteration: data.currentIteration,
                loopsRemaining:
                  'loopsRemaining' in data
                    ? data.loopsRemaining
                    : (conv.loopConfig?.loopsRemaining ?? 0),
                clearContext: conv.loopConfig?.clearContext ?? false,
                prompt: conv.loopConfig?.prompt ?? '',
                isLooping: true,
              },
            });
          }

          // Decrement the synthetic loop queue counter on iteration_end
          if ('loopsRemaining' in data) {
            const queues = new Map(state.queues);
            const queue = queues.get(data.conversationId) || [];
            const updatedQueue = queue.map((m) =>
              m.isLoop ? { ...m, loopIterationsRemaining: data.loopsRemaining } : m
            );
            queues.set(data.conversationId, updatedQueue);
            return { conversations, queues };
          }

          return { conversations };
        });
        break;

      case 'loop_complete':
        set((state) => {
          const conversations = new Map(state.conversations);
          const conv = conversations.get(data.conversationId);
          if (conv) {
            conversations.set(data.conversationId, { ...conv, loopConfig: null });
          }

          // Clear the synthetic loop queue entry
          const queues = new Map(state.queues);
          queues.set(data.conversationId, []);

          return { conversations, queues };
        });
        // Resume normal queue processing after loop completes
        setTimeout(() => get()._processQueue(data.conversationId), 100);
        break;

      // File polling: server detected external changes to JSONL files
      case 'conversations_updated': {
        console.log(`[WS] conversations_updated: ${data.conversations.length} changed`);
        set((state) => {
          const conversations = new Map(state.conversations);
          for (const conv of data.conversations) {
            conversations.set(conv.id, conv);
          }
          return { conversations };
        });

        // NEW Badge Feature: Reset seen state to prevent stale indices after external
        // file modifications. If user manually edits JSONL files, message indices might
        // change (messages added/removed). Mark all messages as seen to avoid false
        // "NEW" badges. This is conservative — better to miss a badge than show incorrect.
        // See docs/new_badge_feature.md, section "Edge Cases Handled #5".
        const markMessagesSeen = useUIStore.getState().markMessagesSeen;
        for (const conv of data.conversations) {
          if (conv.messages.length > 0) {
            markMessagesSeen(conv.id, conv.messages.length - 1);
          }
        }
        break;
      }

      // Sub-agent events
      case 'subagent_start':
        console.log(`[WS] subagent_start: ${data.subAgent.id.substring(0, 8)} - "${data.subAgent.description.substring(0, 30)}"`);
        set((state) => {
          const conversations = new Map(state.conversations);
          const conv = conversations.get(data.conversationId);
          if (conv) {
            const subAgents = [...conv.subAgents, data.subAgent].slice(-10);
            conversations.set(data.conversationId, { ...conv, subAgents });
          }
          return { conversations };
        });
        break;

      case 'subagent_update':
        console.log(`[WS] subagent_update: ${data.subAgentId.substring(0, 8)} - action: ${data.currentAction || 'none'}`);
        set((state) => {
          const conversations = new Map(state.conversations);
          const conv = conversations.get(data.conversationId);
          if (conv) {
            const subAgents = conv.subAgents.map((agent) => {
              if (agent.id === data.subAgentId) {
                return {
                  ...agent,
                  toolUses: data.toolUses ?? agent.toolUses,
                  tokens: data.tokens ?? agent.tokens,
                  currentAction: data.currentAction ?? agent.currentAction,
                  status: data.status ?? agent.status,
                };
              }
              return agent;
            });
            conversations.set(data.conversationId, { ...conv, subAgents });
          }
          return { conversations };
        });
        break;

      case 'subagent_complete':
        console.log(`[WS] subagent_complete: ${data.subAgentId.substring(0, 8)} - status: ${data.status}`);
        set((state) => {
          const conversations = new Map(state.conversations);
          const conv = conversations.get(data.conversationId);
          if (conv) {
            const subAgents = conv.subAgents.map((agent) => {
              if (agent.id === data.subAgentId) {
                return {
                  ...agent,
                  status: data.status,
                  completedAt: data.completedAt,
                  currentAction: 'Done',
                };
              }
              return agent;
            });
            conversations.set(data.conversationId, { ...conv, subAgents });
          }
          return { conversations };
        });
        break;
    }
  },
}));
