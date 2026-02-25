import type {
  ClientMessage,
  Conversation,
  ModelId,
  Provider,
  QueuedMessage,
  ServerMessage,
} from '@claude-web-view/shared';
import { enableMapSet, produce } from 'immer';
import { DRAFT_KEY_PREFIX, PENDING_CONVERSATIONS_KEY, useUIStore } from '../stores/uiStore';
import {
  activeConversationIdAtom,
  conversationsAtom,
  defaultCwdAtom,
  sendFnAtom,
  streamingContentAtom,
  wsStatusAtom,
} from './conversations';
import { jotaiStore } from './store';

// Enable Immer's Map/Set support — must be called once before any produce() on Maps.
enableMapSet();

// Re-export for downstream consumers that previously imported from conversationStore
export type { QueuedMessage } from '@claude-web-view/shared';

// =============================================================================
// Chunk Buffer
//
// Text chunks arrive 100-200x per response (1-20 chars each). Without buffering,
// each chunk would trigger a Jotai notification → React re-render → Markdown reparse.
// Instead, accumulate in a plain object outside state and flush once per animation
// frame (~60Hz). This collapses 100-200 updates into ~3-10 per response.
// =============================================================================

const chunkBuffer: Map<string, string> = new Map();
let chunkFlushScheduled = false;

function flushChunkBuffer(): void {
  chunkFlushScheduled = false;
  if (chunkBuffer.size === 0) return;

  const pending = new Map(chunkBuffer);
  chunkBuffer.clear();

  // Write to streamingContentAtom only — never to conversationsAtom.
  // Sidebar/Gallery subscribe to allConversationsAtom (derived from conversationsAtom)
  // and therefore never see chunk updates. Chat.tsx merges streamingContent at render time.
  const conversations = jotaiStore.get(conversationsAtom);
  const next = produce(jotaiStore.get(streamingContentAtom), (draft) => {
    for (const [id, text] of pending) {
      const conv = conversations.get(id);
      if (!conv || conv.messages.length === 0) continue;
      const lastMsg = conv.messages[conv.messages.length - 1];
      if (lastMsg.role !== 'assistant') continue;
      draft.set(id, (draft.get(id) ?? '') + text);
    }
  });

  // Only notify if something actually changed
  if (next !== jotaiStore.get(streamingContentAtom)) {
    jotaiStore.set(streamingContentAtom, next);
  }
}

function scheduleChunkFlush(): void {
  if (!chunkFlushScheduled) {
    chunkFlushScheduled = true;
    requestAnimationFrame(flushChunkBuffer);
  }
}

// =============================================================================
// Pending Conversations Persistence
//
// Optimistic stubs created before server confirms are saved to localStorage so
// they survive page refresh. Reconciled against server state on init.
// =============================================================================

interface PendingConversation {
  id: string;
  workingDirectory: string;
  provider: Provider;
  model?: ModelId;
  createdAt: string;
}

function normalizeWorkingDirectory(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('~')) {
    return trimmed.replace(/\/+$/, '') || '~';
  }

  const withSingleSlashes = trimmed.replace(/\/+/g, '/');
  const hasLeadingSlash = withSingleSlashes.startsWith('/');
  const segments = withSingleSlashes.split('/');
  const normalized: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (normalized.length > 0) {
        normalized.pop();
      }
      continue;
    }
    normalized.push(segment);
  }

  if (hasLeadingSlash) {
    const rootPath = `/${normalized.join('/')}`;
    return rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '');
  }

  const fallback = normalized.join('/');
  return fallback || '.';
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
// Helper: read the current send function
// =============================================================================

function send(msg: ClientMessage): void {
  jotaiStore.get(sendFnAtom).send(msg);
}

// =============================================================================
// WebSocket Status
// =============================================================================

export function setWsStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
  jotaiStore.set(wsStatusAtom, status);
}

export function setSendFn(fn: (msg: ClientMessage) => void): void {
  jotaiStore.set(sendFnAtom, { send: fn });
}

// =============================================================================
// Public Actions — called by React components
// =============================================================================

export function setActiveConversationId(id: string | null): void {
  jotaiStore.set(activeConversationIdAtom, id);
}

export function createConversation(
  workingDirectory: string,
  provider: Provider = 'claude',
  model?: ModelId,
  swarmDebugPrefix?: string
): string {
  const id = crypto.randomUUID();
  const normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory);

  const stub: Conversation = {
    id,
    messages: [],
    isRunning: false,
    isStreaming: false,
    confirmed: false,
    createdAt: new Date(),
    workingDirectory: normalizedWorkingDirectory,
    provider,
    model,
    subAgents: [],
    queue: [],
    isWorker: false,
    swarmId: null,
    workerId: null,
    workerRole: null,
    parentConversationId: null,
    modelName: null,
    swarmDebugPrefix: swarmDebugPrefix ?? null,
  };

  jotaiStore.set(
    conversationsAtom,
    produce(jotaiStore.get(conversationsAtom), (draft) => {
      draft.set(id, stub);
    })
  );
  jotaiStore.set(activeConversationIdAtom, id);

  savePendingConversation({
    id,
    workingDirectory: normalizedWorkingDirectory,
    provider,
    model,
    createdAt: stub.createdAt.toISOString(),
  });
  send({
    type: 'new_conversation',
    id,
    workingDirectory: normalizedWorkingDirectory,
    provider,
    model,
    swarmDebugPrefix,
  });

  return id;
}

export function deleteConversation(id: string): void {
  send({ type: 'delete_conversation', conversationId: id });
}

export function sendMessage(conversationId: string, content: string): void {
  const conv = jotaiStore.get(conversationsAtom).get(conversationId);
  if (!conv) {
    console.warn(`[Send] Cannot send message: conversation ${conversationId} not found`);
    return;
  }
  send({ type: 'queue_message', conversationId, content });
}

export function stopConversation(conversationId: string): void {
  const conv = jotaiStore.get(conversationsAtom).get(conversationId);
  if (!conv) return;
  send({ type: 'stop_conversation', conversationId });
}

export function interruptAndSend(conversationId: string, content: string): void {
  const conv = jotaiStore.get(conversationsAtom).get(conversationId);
  if (!conv) return;

  const pendingQueuedMessages = (conv.queue ?? []).filter((q) => q.status === 'pending');
  const hasPendingTasks = pendingQueuedMessages.length > 0;
  const pendingBlock = pendingQueuedMessages.map((q, i) => `${i + 1}. ${q.content}`).join('\n');

  send({ type: 'stop_conversation', conversationId });

  if (hasPendingTasks) {
    send({ type: 'clear_queue', conversationId });
  }

  const wrappedContent = hasPendingTasks
    ? [
        'We interrupted and flushed the pending tasks.',
        'Pending tasks flushed:',
        pendingBlock,
        '',
        `This final message was added as an interruption: "${content}"`,
      ].join('\n')
    : `Interrupted.\nThis final message was added as an interruption: "${content}"`;

  send({ type: 'queue_message', conversationId, content: wrappedContent });
}

export function setModel(conversationId: string, model: ModelId): void {
  send({ type: 'set_model', conversationId, model });
}

export function setProvider(conversationId: string, provider: Provider): void {
  send({ type: 'set_provider', conversationId, provider });
}

export function queueMessage(conversationId: string, content: string): void {
  send({ type: 'queue_message', conversationId, content });
}

export function cancelQueuedMessage(conversationId: string, messageId: string): void {
  send({ type: 'cancel_queued_message', conversationId, messageId });
}

export function clearQueue(conversationId: string): void {
  send({ type: 'clear_queue', conversationId });
}

export function getQueue(conversationId: string): QueuedMessage[] {
  return jotaiStore.get(conversationsAtom).get(conversationId)?.queue ?? [];
}

// =============================================================================
// WebSocket Message Handler
//
// Called by useWebSocket hook in App.tsx on every incoming server message.
// Uses jotaiStore.set + Immer produce for all state mutations.
// Immer's enableMapSet() (called at top of file) enables Map draft mutations.
// =============================================================================

export function handleMessage(data: ServerMessage): void {
  switch (data.type) {
    case 'init': {
      console.log(`[WS] init: ${data.conversations.length} conversations`);

      // Total wipe and replace. Server is the absolute epoch.
      const serverState = new Map<string, Conversation>();
      for (let i = 0; i < data.conversations.length; i++) {
        const conv = data.conversations[i];
        serverState.set(conv.id, conv);
      }

      // Reconcile pending stubs from localStorage
      for (const pc of loadPendingConversations()) {
        if (serverState.has(pc.id)) {
          removePendingConversation(pc.id);
        } else {
          const stub: Conversation = {
            id: pc.id,
            messages: [],
            isRunning: false,
            isStreaming: false,
            confirmed: false,
            createdAt: new Date(pc.createdAt),
            workingDirectory: normalizeWorkingDirectory(pc.workingDirectory),
            provider: pc.provider,
            model: pc.model,
            subAgents: [],
            queue: [],
            isWorker: false,
            swarmId: null,
            workerId: null,
            workerRole: null,
            parentConversationId: null,
            modelName: null,
          };
          serverState.set(pc.id, stub);
          const normalizedWorkingDirectory = normalizeWorkingDirectory(pc.workingDirectory);
          setTimeout(() => {
            send({
              type: 'new_conversation',
              id: pc.id,
              workingDirectory: normalizedWorkingDirectory,
              provider: pc.provider,
              model: pc.model,
            });
          }, 0);
        }
      }

      jotaiStore.set(defaultCwdAtom, data.defaultCwd);
      jotaiStore.set(conversationsAtom, serverState);
      
      // Drop stale streaming state from before this reconnect
      chunkBuffer.clear();
      jotaiStore.set(streamingContentAtom, new Map());
      break;
    }

    case 'conversation_created': {
      jotaiStore.set(
        conversationsAtom,
        produce(jotaiStore.get(conversationsAtom), (draft) => {
          const existing = draft.get(data.conversation.id);
          draft.set(data.conversation.id, {
            ...data.conversation,
            swarmDebugPrefix:
              data.conversation.swarmDebugPrefix ?? existing?.swarmDebugPrefix ?? null,
          });
        })
      );
      removePendingConversation(data.conversation.id);
      break;
    }

    case 'session_bound': {
      console.log(`[WS] session_bound: UI ${data.conversationId} -> CLI ${data.sessionId}`);
      jotaiStore.set(
        conversationsAtom,
        produce(jotaiStore.get(conversationsAtom), (draft) => {
          const conv = draft.get(data.conversationId);
          if (conv) conv.sessionId = data.sessionId;
        })
      );
      break;
    }

    case 'conversation_deleted': {
      jotaiStore.set(
        conversationsAtom,
        produce(jotaiStore.get(conversationsAtom), (draft) => {
          draft.delete(data.conversationId);
        })
      );
      const currentActive = jotaiStore.get(activeConversationIdAtom);
      if (currentActive === data.conversationId) {
        jotaiStore.set(activeConversationIdAtom, null);
      }
      removePendingConversation(data.conversationId);
      localStorage.removeItem(`${DRAFT_KEY_PREFIX}${data.conversationId}`);
      useUIStore.setState((s) => {
        const { [data.conversationId]: _, ...rest } = s.lastSeenMessageIndex;
        return { lastSeenMessageIndex: rest };
      });
      break;
    }

    case 'message': {
      console.log(
        `[WS] message event: role=${data.role}, content="${data.content.substring(0, 50)}"`
      );
      let newMessageIndex: number | null = null;

      jotaiStore.set(
        conversationsAtom,
        produce(jotaiStore.get(conversationsAtom), (draft) => {
          const conv = draft.get(data.conversationId);
          if (!conv) return;

          const lastMsg = conv.messages[conv.messages.length - 1];
          if (data.role === 'assistant' && lastMsg?.role === 'assistant') {
            console.log('[WS] Skipping duplicate assistant message');
            return;
          }

          newMessageIndex = conv.messages.length;
          console.log(`[WS] Adding message #${newMessageIndex + 1} (role=${data.role})`);
          conv.messages.push({ role: data.role, content: data.content, timestamp: new Date() });
        })
      );

      if (newMessageIndex !== null) {
        const activeId = useUIStore.getState().activeConversationId;
        if (activeId === data.conversationId) {
          useUIStore.getState().markMessagesSeen(data.conversationId, newMessageIndex);
        }
      }
      break;
    }

    case 'chunk': {
      if (data.text.length > 0) {
        chunkBuffer.set(
          data.conversationId,
          (chunkBuffer.get(data.conversationId) ?? '') + data.text
        );
        scheduleChunkFlush();
      }
      break;
    }

    case 'status': {
      const conversations = jotaiStore.get(conversationsAtom);
      const conv = conversations.get(data.conversationId);
      if (!conv) break;

      const streamingContent = jotaiStore.get(streamingContentAtom);

      jotaiStore.set(
        conversationsAtom,
        produce(conversations, (draft) => {
          const c = draft.get(data.conversationId);
          if (c) {
            c.isRunning = data.isRunning;
            c.isStreaming = data.isStreaming;
          }
        })
      );

      // If streaming stopped, nuke the transient streaming buffer. 
      // The committed truth will come via conversations_updated.
      if (!data.isStreaming && streamingContent.has(data.conversationId)) {
        jotaiStore.set(
          streamingContentAtom,
          produce(streamingContent, (draft) => {
            draft.delete(data.conversationId);
          })
        );
      }
      break;
    }

    case 'error': {
      console.error('Server error:', data.message);
      break;
    }

    case 'message_complete': {
      // Flush buffered chunks synchronously — message_complete can arrive in the same
      // event loop tick as the last chunk, before rAF fires.
      flushChunkBuffer();
      break;
    }

    case 'conversations_updated': {
      console.log(`[WS] conversations_updated: ${data.conversations.length} changed`);
      jotaiStore.set(
        conversationsAtom,
        produce(jotaiStore.get(conversationsAtom), (draft) => {
          for (const conv of data.conversations) {
            draft.set(conv.id, conv);
          }
        })
      );
      // Mark all updated conversations as seen to prevent stale NEW badges after
      // external JSONL edits. Conservative — better to miss a badge than show wrong one.
      useUIStore.setState((s) => {
        const updates: Record<string, number> = {};
        for (const conv of data.conversations) {
          if (conv.messages.length > 0) updates[conv.id] = conv.messages.length - 1;
        }
        return { lastSeenMessageIndex: { ...s.lastSeenMessageIndex, ...updates } };
      });
      break;
    }

    case 'queue_updated': {
      jotaiStore.set(
        conversationsAtom,
        produce(jotaiStore.get(conversationsAtom), (draft) => {
          const conv = draft.get(data.conversationId);
          if (conv) conv.queue = data.queue;
        })
      );
      break;
    }

    case 'subagent_start': {
      console.log(
        `[WS] subagent_start: ${data.subAgent.id.substring(0, 8)} - "${data.subAgent.description.substring(0, 30)}"`
      );
      jotaiStore.set(
        conversationsAtom,
        produce(jotaiStore.get(conversationsAtom), (draft) => {
          const conv = draft.get(data.conversationId);
          if (conv) {
            conv.subAgents = [...conv.subAgents, data.subAgent].slice(-10);
          }
        })
      );
      break;
    }

    case 'subagent_update': {
      console.log(
        `[WS] subagent_update: ${data.subAgentId.substring(0, 8)} - action: ${data.currentAction || 'none'}`
      );
      jotaiStore.set(
        conversationsAtom,
        produce(jotaiStore.get(conversationsAtom), (draft) => {
          const conv = draft.get(data.conversationId);
          if (!conv) return;
          const agent = conv.subAgents.find((a) => a.id === data.subAgentId);
          if (!agent) return;
          if (data.toolUses !== undefined) agent.toolUses = data.toolUses;
          if (data.tokens !== undefined) agent.tokens = data.tokens;
          if (data.currentAction !== undefined) agent.currentAction = data.currentAction;
          if (data.status !== undefined) agent.status = data.status;
        })
      );
      break;
    }

    case 'subagent_complete': {
      console.log(
        `[WS] subagent_complete: ${data.subAgentId.substring(0, 8)} - status: ${data.status}`
      );
      jotaiStore.set(
        conversationsAtom,
        produce(jotaiStore.get(conversationsAtom), (draft) => {
          const conv = draft.get(data.conversationId);
          if (!conv) return;
          const agent = conv.subAgents.find((a) => a.id === data.subAgentId);
          if (!agent) return;
          agent.status = data.status;
          agent.completedAt = data.completedAt;
          agent.currentAction = 'Done';
        })
      );
      break;
    }
  }
}
