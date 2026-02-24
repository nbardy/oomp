import type {
  ClientMessage,
  Conversation,
  ModelId,
  Provider,
  QueuedMessage,
  ServerMessage,
} from '@claude-web-view/shared';
import { create } from 'zustand';
import { DRAFT_KEY_PREFIX, PENDING_CONVERSATIONS_KEY, useUIStore } from './uiStore';

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

// Re-export QueuedMessage from shared types (server-owned, client mirrors)
export type { QueuedMessage } from '@claude-web-view/shared';

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
  provider: Provider;
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

  // Actions
  setActiveConversationId: (id: string | null) => void;
  createConversation: (workingDirectory: string, provider?: Provider, model?: ModelId, swarmDebugPrefix?: string) => string;
  deleteConversation: (id: string) => void;
  sendMessage: (conversationId: string, content: string) => void;
  stopConversation: (conversationId: string) => void;
  interruptAndSend: (conversationId: string, content: string) => void;
  setProvider: (conversationId: string, provider: Provider) => void;
  setModel: (conversationId: string, model: ModelId) => void;
  // Queue operations — thin wrappers that send WS commands to the server.
  // Server owns the queue; client mirrors it via queue_updated broadcasts.
  queueMessage: (conversationId: string, content: string) => void;
  cancelQueuedMessage: (conversationId: string, messageId: string) => void;
  clearQueue: (conversationId: string) => void;
  getQueue: (conversationId: string) => QueuedMessage[];

  // Internal — called by WebSocket bridge, not by components directly
  _handleMessage: (data: ServerMessage) => void;
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
  _send: () => {},

  // ---------------------------------------------------------------------------
  // Public Actions
  // ---------------------------------------------------------------------------

  setActiveConversationId: (id) => set({ activeConversationId: id }),

  createConversation: (workingDirectory, provider = 'claude', model, swarmDebugPrefix) => {
    const id = crypto.randomUUID();

    // Optimistic insert: conversation appears in store immediately (before server round-trip).
    // confirmed: false — user can see the conversation but can't send messages until server confirms.
    const stub: Conversation = {
      id,
      messages: [],
      isRunning: false,
      isStreaming: false,
      confirmed: false,
      createdAt: new Date(),
      workingDirectory,
      provider,
      model,
      subAgents: [],
      queue: [],
      isWorker: false, // User-created conversations are never workers
      swarmId: null,
      workerId: null,
      workerRole: null,
      parentConversationId: null,
      modelName: null,
      swarmDebugPrefix: swarmDebugPrefix ?? null,
    };

    set((state) => {
      const conversations = new Map(state.conversations);
      conversations.set(id, stub);
      return { conversations, activeConversationId: id };
    });

    // Persist stub to localStorage so it survives page refresh before server confirms
    savePendingConversation({
      id,
      workingDirectory,
      provider,
      model,
      createdAt: stub.createdAt.toISOString(),
    });

    // Tell server to create the real conversation with this ID
    // swarmDebugPrefix is included so the server can prepend it to the first CLI message.
    get()._send({ type: 'new_conversation', id, workingDirectory, provider, model, swarmDebugPrefix });

    return id;
  },

  deleteConversation: (id) => {
    get()._send({ type: 'delete_conversation', conversationId: id });
  },

  /**
   * Send a chat message to a conversation.
   * Routes through the server-side queue for consistent ordering.
   */
  sendMessage: (conversationId, content) => {
    const conv = get().conversations.get(conversationId);
    if (!conv) {
      console.warn(`[Send] Cannot send message: conversation ${conversationId} not found`);
      return;
    }
    get()._send({ type: 'queue_message', conversationId, content });
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
   * Kills the current process, then queues one wrapped message:
   * - If pending queue items exist: include a "flushed pending tasks" block.
   * - If no pending queue items: use a compact interruption-only format.
   * This keeps interrupt behavior deterministic and prevents a long pending list
   * from being replayed as many separate queue entries after resume.
   *
   * KEY BEHAVIOR: Enter while running = interrupt + adjusted prompt.
   * The server will kill the process, then the queue will auto-process
   * the new message once the conversation becomes ready again.
   */
  interruptAndSend: (conversationId, content) => {
    const conv = get().conversations.get(conversationId);
    if (!conv) return;

    const { _send } = get();
    const pendingQueuedMessages = (conv.queue ?? []).filter((q) => q.status === 'pending');
    const hasPendingTasks = pendingQueuedMessages.length > 0;
    const pendingBlock = pendingQueuedMessages
      .map((q, index) => `${index + 1}. ${q.content}`)
      .join('\n');

    // Kill running process
    _send({ type: 'stop_conversation', conversationId });

    // Merge pending queue items into the interrupt payload and clear them
    // so they are not replayed separately after the process exits.
    if (hasPendingTasks) {
      _send({ type: 'clear_queue', conversationId });
    }

    const wrappedContent = hasPendingTasks
      ? [
          'We interrupted and flushed the pending tasks.',
          'Pending tasks flushed:',
          pendingBlock,
          '',
          `This final message was added as an interruption: "${content}"`,
        ].join('\n')
      : `Interrupted.
This final message was added as an interruption: "${content}"`;
    _send({ type: 'queue_message', conversationId, content: wrappedContent });
  },

  setModel: (conversationId, model) => {
    get()._send({ type: 'set_model', conversationId, model });
  },

  setProvider: (conversationId, provider) => {
    get()._send({ type: 'set_provider', conversationId, provider });
  },

  // ---------------------------------------------------------------------------
  // Queue Operations — thin WS senders. Server owns the queue.
  // Client mirrors queue state via conversation.queue (set by queue_updated).
  // ---------------------------------------------------------------------------

  queueMessage: (conversationId, content) => {
    get()._send({ type: 'queue_message', conversationId, content });
  },

  cancelQueuedMessage: (conversationId, messageId) => {
    get()._send({ type: 'cancel_queued_message', conversationId, messageId });
  },

  clearQueue: (conversationId) => {
    get()._send({ type: 'clear_queue', conversationId });
  },

  getQueue: (conversationId) => {
    return get().conversations.get(conversationId)?.queue ?? [];
  },

  // ---------------------------------------------------------------------------
  // Internal — WebSocket bridge and queue processing
  // ---------------------------------------------------------------------------

  _setSend: (send) => set({ _send: send }),

  _setWsStatus: (status) => set({ wsStatus: status }),

  /**
   * Handle incoming server messages.
   * All state reads use get() — always fresh, no refs needed.
   */
  _handleMessage: (data) => {
    switch (data.type) {
      case 'init': {
        console.log(`[WS] init: ${data.conversations.length} conversations`);
        data.conversations.forEach((conv) => {
          console.log(
            `[WS] init conv ${conv.id.substring(0, 8)}: ${conv.messages.length} messages`
          );
        });
        // Merge into existing Map instead of replacing wholesale.
        // With progressive loading, conversations_updated batches may arrive before
        // init (race between the WS init microtask and broadcastToAll in onProgress).
        // Merging preserves any conversations already received via those early batches.
        const convMap = new Map(get().conversations);
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
              isStreaming: false,
              confirmed: false,
              createdAt: new Date(pc.createdAt),
              workingDirectory: pc.workingDirectory,
              provider: pc.provider,
              model: pc.model,
              subAgents: [],
              queue: [],
              isWorker: false, // Pending conversations from localStorage are never workers
              swarmId: null,
              workerId: null,
              workerRole: null,
              parentConversationId: null,
              modelName: null,
            };
            convMap.set(pc.id, stub);
            // Re-send creation request after state is set (deferred so _send is available)
            setTimeout(() => {
              get()._send({
                type: 'new_conversation',
                id: pc.id,
                workingDirectory: pc.workingDirectory,
                provider: pc.provider,
                model: pc.model,
              });
            }, 0);
          }
        }

        set({ defaultCwd: data.defaultCwd, conversations: convMap });
        // Queue state is included in each conversation's `queue` field from the init payload.
        // No client-side reconstruction needed — the server is the source of truth.
        break;
      }

      case 'conversation_created':
        // Merge: conversation may already exist from optimistic insert in createConversation.
        // Server data wins (has validated workingDirectory, etc.), but don't reset activeConversationId
        // if user has already navigated away.
        set((state) => {
          const conversations = new Map(state.conversations);
          const existing = conversations.get(data.conversation.id);
          conversations.set(data.conversation.id, {
            ...data.conversation,
            // Preserve client-only metadata from optimistic stub
            swarmDebugPrefix: data.conversation.swarmDebugPrefix ?? existing?.swarmDebugPrefix ?? null,
          });
          return { conversations };
        });
        // Server confirmed — no longer pending
        removePendingConversation(data.conversation.id);
        break;

      case 'conversation_deleted':
        set((state) => {
          const conversations = new Map(state.conversations);
          conversations.delete(data.conversationId);
          const activeConversationId =
            state.activeConversationId === data.conversationId ? null : state.activeConversationId;
          return { conversations, activeConversationId };
        });
        // Clean up localStorage: pending stub + draft
        removePendingConversation(data.conversationId);
        localStorage.removeItem(`${DRAFT_KEY_PREFIX}${data.conversationId}`);
        break;

      case 'message': {
        console.log(
          `[WS] message event: role=${data.role}, content="${data.content.substring(0, 50)}"`
        );
        let newMessageIndex: number | null = null;
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
            newMessageIndex = conv.messages.length;
            console.log(`[WS] Adding message #${newMessageIndex + 1} (role=${data.role})`);
            // isStreaming is server-authoritative — set via status broadcast,
            // which arrives in the same WS frame as this message event.
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

        // NEW Badge Fix: If this message is for the active conversation, mark it seen immediately.
        // User is viewing this thread — no badge should appear for messages they're watching stream in.
        if (newMessageIndex !== null) {
          const activeId = useUIStore.getState().activeConversationId;
          if (activeId === data.conversationId) {
            useUIStore.getState().markMessagesSeen(data.conversationId, newMessageIndex);
          }
        }
        break;
      }

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
            conversations.set(data.conversationId, {
              ...conv,
              isRunning: data.isRunning,
              isStreaming: data.isStreaming,
            });
          }
          return { conversations };
        });
        break;

      case 'error':
        // Validation errors are now shown in the UI (e.g., invalid directory)
        // Other errors are logged to console but not alerted to avoid popup spam
        console.error('Server error:', data.message);
        break;

      case 'message_complete':
        // Flush any buffered chunks synchronously — message_complete can arrive
        // in the same event loop tick as the last chunk, before rAF fires.
        flushChunkBuffer();
        // isStreaming is now server-authoritative — cleared by the status broadcast
        // that follows message_complete in the same WS frame. No client-side cleanup needed.
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
        // Batched into a single Zustand update to avoid 50+ set() calls per batch
        // during progressive loading (each would spread + notify subscribers).
        useUIStore.setState((s) => {
          const updates: Record<string, number> = {};
          for (const conv of data.conversations) {
            if (conv.messages.length > 0) {
              updates[conv.id] = conv.messages.length - 1;
            }
          }
          return { lastSeenMessageIndex: { ...s.lastSeenMessageIndex, ...updates } };
        });
        break;
      }

      // Sub-agent events
      // Server-owned queue update — mirror the queue state onto the conversation
      case 'queue_updated':
        set((state) => {
          const conversations = new Map(state.conversations);
          const conv = conversations.get(data.conversationId);
          if (conv) {
            conversations.set(data.conversationId, { ...conv, queue: data.queue });
          }
          return { conversations };
        });
        break;

      case 'subagent_start':
        console.log(
          `[WS] subagent_start: ${data.subAgent.id.substring(0, 8)} - "${data.subAgent.description.substring(0, 30)}"`
        );
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
        console.log(
          `[WS] subagent_update: ${data.subAgentId.substring(0, 8)} - action: ${data.currentAction || 'none'}`
        );
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
        console.log(
          `[WS] subagent_complete: ${data.subAgentId.substring(0, 8)} - status: ${data.status}`
        );
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
