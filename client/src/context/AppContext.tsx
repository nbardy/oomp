import type { ClientMessage, Conversation, Provider, ServerMessage } from '@claude-web-view/shared';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

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
 */
export interface QueuedMessage {
  id: string;
  content: string;
  queuedAt: Date;
  status: 'pending' | 'sending';
}

interface AppContextValue {
  conversations: Map<string, Conversation>;
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  createConversation: (workingDirectory: string, provider?: Provider) => void;
  deleteConversation: (id: string) => void;
  sendMessage: (conversationId: string, content: string) => void;
  startLoop: (
    conversationId: string,
    prompt: string,
    iterations: '5' | '10' | '20',
    clearContext: boolean
  ) => void;
  cancelLoop: (conversationId: string) => void;
  wsStatus: 'connecting' | 'connected' | 'disconnected';
  defaultCwd: string;
  // Message queue operations
  queueMessage: (conversationId: string, content: string) => void;
  cancelQueuedMessage: (conversationId: string, messageId: string) => void;
  clearQueue: (conversationId: string) => void;
  getQueue: (conversationId: string) => QueuedMessage[];
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<Map<string, Conversation>>(new Map());
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [defaultCwd, setDefaultCwd] = useState<string>('');
  // Ref to track activeConversationId without causing callback recreation
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  // =============================================================================
  // Message Queue State
  // Key: conversationId, Value: QueuedMessage[]
  // This is client-side only - server remains stateless about queued messages
  // =============================================================================
  const [queues, setQueues] = useState<Map<string, QueuedMessage[]>>(new Map());

  // Ref to access conversations in processQueue without causing recreations
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // Ref to access queues in processQueue without causing recreations
  const queuesRef = useRef(queues);
  queuesRef.current = queues;

  // Ref to store send function for use in processQueue (avoids circular dependency)
  const sendRef = useRef<(msg: ClientMessage) => void>(() => {});

  // =============================================================================
  // Queue Processing Logic
  // Checks if conversation is ready and not running, then sends the first queued message
  // =============================================================================
  const processQueue = useCallback((conversationId: string) => {
    const queue = queuesRef.current.get(conversationId) || [];
    const conv = conversationsRef.current.get(conversationId);

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
    setQueues((prev) => {
      const next = new Map(prev);
      const q = [...(next.get(conversationId) || [])];
      if (q.length > 0) {
        q[0] = { ...q[0], status: 'sending' };
        next.set(conversationId, q);
      }
      return next;
    });

    // Send via WebSocket
    sendRef.current({ type: 'send_message', conversationId, content: nextMessage.content });
  }, []);

  // Ref to store processQueue for use in handleMessage
  const processQueueRef = useRef(processQueue);
  processQueueRef.current = processQueue;

  const handleMessage = useCallback(
    (data: ServerMessage) => {
      switch (data.type) {
        case 'init': {
          console.log(`[WS] init: ${data.conversations.length} conversations`);
          data.conversations.forEach((conv) => {
            console.log(`[WS] init conv ${conv.id.substring(0, 8)}: ${conv.messages.length} messages`);
          });
          setDefaultCwd(data.defaultCwd);
          const convMap = new Map<string, Conversation>();
          data.conversations.forEach((conv) => convMap.set(conv.id, conv));
          setConversations(convMap);
          break;
        }

        case 'conversation_created':
          setConversations((prev) => {
            const next = new Map(prev);
            next.set(data.conversation.id, data.conversation);
            return next;
          });
          setActiveConversationId(data.conversation.id);
          break;

        case 'conversation_deleted':
          setConversations((prev) => {
            const next = new Map(prev);
            next.delete(data.conversationId);
            return next;
          });
          // Clean up queue for deleted conversation
          setQueues((prev) => {
            const next = new Map(prev);
            next.delete(data.conversationId);
            return next;
          });
          // Use ref to avoid dependency on activeConversationId
          if (activeConversationIdRef.current === data.conversationId) {
            setActiveConversationId(null);
          }
          break;

        case 'message':
          console.log(`[WS] message event: role=${data.role}, content="${data.content.substring(0, 50)}"`);
          setConversations((prev) => {
            const next = new Map(prev);
            const conv = next.get(data.conversationId);
            if (conv) {
              // DEDUP: Don't create another assistant message if last one is already assistant
              // This prevents duplicates from init sync + streaming race conditions
              const lastMsg = conv.messages[conv.messages.length - 1];
              if (data.role === 'assistant' && lastMsg?.role === 'assistant') {
                console.log('[WS] Skipping duplicate assistant message');
                return prev; // Don't modify - assistant message already exists
              }
              console.log(`[WS] Adding message #${conv.messages.length + 1} (role=${data.role})`);
              next.set(data.conversationId, {
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
            return next;
          });
          break;

        case 'chunk':
          // Only log first 30 chars to avoid spam
          if (data.text.length > 0) {
            console.log(`[WS] chunk: "${data.text.substring(0, 30).replace(/\n/g, '\\n')}"`);
          }
          setConversations((prev) => {
            const next = new Map(prev);
            const conv = next.get(data.conversationId);
            if (conv && conv.messages.length > 0) {
              const messages = [...conv.messages];
              const lastMsg = messages[messages.length - 1];
              if (lastMsg.role === 'assistant') {
                const newContent = lastMsg.content + data.text;
                console.log(`[WS] assistant content now ${newContent.length} chars`);
                messages[messages.length - 1] = {
                  ...lastMsg,
                  content: newContent,
                };
                next.set(data.conversationId, { ...conv, messages });
              }
            }
            return next;
          });
          break;

        case 'status':
          setConversations((prev) => {
            const next = new Map(prev);
            const conv = next.get(data.conversationId);
            if (conv) {
              next.set(data.conversationId, { ...conv, isRunning: data.isRunning });
            }
            return next;
          });
          // When status changes to not running, try processing queue
          // Use setTimeout to ensure state updates are applied first
          if (!data.isRunning) {
            setTimeout(() => processQueueRef.current(data.conversationId), 100);
          }
          break;

        case 'error':
          alert(data.message);
          break;

        case 'ready':
          setConversations((prev) => {
            const next = new Map(prev);
            const conv = next.get(data.conversationId);
            if (conv) {
              next.set(data.conversationId, { ...conv, isReady: data.isReady });
            }
            return next;
          });
          // When ready, try processing any queued messages
          if (data.isReady) {
            setTimeout(() => processQueueRef.current(data.conversationId), 100);
          }
          break;

        case 'message_complete':
          // Message has been fully received from server
          // Remove the first message from queue (it was the one that was sending)
          // and process the next one
          console.log(`[Queue] message_complete for ${data.conversationId.substring(0, 8)}`);
          setQueues((prev) => {
            const next = new Map(prev);
            const queue = next.get(data.conversationId) || [];
            // Remove first message (the one that was sending)
            if (queue.length > 0 && queue[0].status === 'sending') {
              next.set(data.conversationId, queue.slice(1));
            }
            return next;
          });
          // Process next message after a brief delay to ensure state is updated
          setTimeout(() => processQueueRef.current(data.conversationId), 100);
          break;

        case 'loop_iteration_start':
        case 'loop_iteration_end':
          setConversations((prev) => {
            const next = new Map(prev);
            const conv = next.get(data.conversationId);
            if (conv) {
              next.set(data.conversationId, {
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
            return next;
          });
          break;

        case 'loop_complete':
          setConversations((prev) => {
            const next = new Map(prev);
            const conv = next.get(data.conversationId);
            if (conv) {
              next.set(data.conversationId, {
                ...conv,
                loopConfig: null,
              });
            }
            return next;
          });
          break;

        // Sub-agent events
        case 'subagent_start':
          console.log(`[WS] subagent_start: ${data.subAgent.id.substring(0, 8)} - "${data.subAgent.description.substring(0, 30)}"`);
          setConversations((prev) => {
            const next = new Map(prev);
            const conv = next.get(data.conversationId);
            if (conv) {
              // Add new sub-agent, keeping only recent ones (limit to 10)
              const subAgents = [...conv.subAgents, data.subAgent].slice(-10);
              next.set(data.conversationId, { ...conv, subAgents });
            }
            return next;
          });
          break;

        case 'subagent_update':
          console.log(`[WS] subagent_update: ${data.subAgentId.substring(0, 8)} - action: ${data.currentAction || 'none'}`);
          setConversations((prev) => {
            const next = new Map(prev);
            const conv = next.get(data.conversationId);
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
              next.set(data.conversationId, { ...conv, subAgents });
            }
            return next;
          });
          break;

        case 'subagent_complete':
          console.log(`[WS] subagent_complete: ${data.subAgentId.substring(0, 8)} - status: ${data.status}`);
          setConversations((prev) => {
            const next = new Map(prev);
            const conv = next.get(data.conversationId);
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
              next.set(data.conversationId, { ...conv, subAgents });
            }
            return next;
          });
          break;
      }
    },
    [] // No dependencies - uses refs for external state
  );

  const wsUrl = `ws://${window.location.hostname}:3000`;
  const { send, status } = useWebSocket<ServerMessage>(wsUrl, handleMessage);

  // Update sendRef so processQueue can use send
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  // =============================================================================
  // Queue Functions
  // =============================================================================

  /**
   * Queue a new message for a conversation.
   * If the conversation is ready and not busy, it will be processed immediately.
   */
  const queueMessage = useCallback(
    (conversationId: string, content: string) => {
      const conv = conversationsRef.current.get(conversationId);
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

      setQueues((prev) => {
        const next = new Map(prev);
        const queue = [...(next.get(conversationId) || []), newMessage];
        next.set(conversationId, queue);
        return next;
      });

      // If conversation is ready and not running, process immediately
      // Defer to next tick to ensure queue state is updated
      if (conv.isReady && !conv.isRunning && !conv.loopConfig?.isLooping) {
        setTimeout(() => processQueue(conversationId), 0);
      }
    },
    [processQueue]
  );

  /**
   * Cancel a queued message by its ID.
   * Cannot cancel messages that are currently being sent.
   */
  const cancelQueuedMessage = useCallback((conversationId: string, messageId: string) => {
    setQueues((prev) => {
      const next = new Map(prev);
      const queue = (next.get(conversationId) || []).filter((m) => {
        // Only allow canceling pending messages, not ones being sent
        if (m.id === messageId && m.status === 'pending') {
          console.log(`[Queue] Cancelled message ${messageId.substring(0, 8)} for ${conversationId.substring(0, 8)}`);
          return false;
        }
        return true;
      });
      next.set(conversationId, queue);
      return next;
    });
  }, []);

  /**
   * Clear all queued messages for a conversation.
   * Only clears pending messages; sending messages will complete.
   */
  const clearQueue = useCallback((conversationId: string) => {
    setQueues((prev) => {
      const next = new Map(prev);
      const queue = next.get(conversationId) || [];
      // Keep only messages that are currently sending
      const sendingMessages = queue.filter((m) => m.status === 'sending');
      console.log(`[Queue] Clearing queue for ${conversationId.substring(0, 8)}: removed ${queue.length - sendingMessages.length} messages`);
      next.set(conversationId, sendingMessages);
      return next;
    });
  }, []);

  /**
   * Get the current queue for a conversation.
   * Returns an empty array if no queue exists.
   */
  const getQueue = useCallback(
    (conversationId: string): QueuedMessage[] => {
      return queues.get(conversationId) || [];
    },
    [queues]
  );

  // =============================================================================
  // Conversation Actions
  // =============================================================================

  const createConversation = useCallback(
    (workingDirectory: string, provider?: Provider) => {
      const msg: ClientMessage = { type: 'new_conversation', workingDirectory, provider };
      send(msg);
    },
    [send]
  );

  const deleteConversation = useCallback(
    (id: string) => {
      const msg: ClientMessage = { type: 'delete_conversation', conversationId: id };
      send(msg);
    },
    [send]
  );

  /**
   * Send a chat message to a conversation.
   * If the conversation is busy (isRunning), the message will be queued.
   * If ready, it will be sent immediately (via the queue for consistency).
   */
  const sendChatMessage = useCallback(
    (conversationId: string, content: string) => {
      const conv = conversationsRef.current.get(conversationId);
      if (!conv) {
        console.warn(`[Send] Cannot send message: conversation ${conversationId} not found`);
        return;
      }

      // Always use the queue for sending messages
      // This ensures consistent behavior and proper ordering
      queueMessage(conversationId, content);
    },
    [queueMessage]
  );

  const startLoop = useCallback(
    (
      conversationId: string,
      prompt: string,
      iterations: '5' | '10' | '20',
      clearContext: boolean
    ) => {
      const msg: ClientMessage = {
        type: 'start_loop',
        conversationId,
        prompt,
        iterations,
        clearContext,
      };
      send(msg);
    },
    [send]
  );

  const cancelLoop = useCallback(
    (conversationId: string) => {
      const msg: ClientMessage = { type: 'cancel_loop', conversationId };
      send(msg);
    },
    [send]
  );

  return (
    <AppContext.Provider
      value={{
        conversations,
        activeConversationId,
        setActiveConversationId,
        createConversation,
        deleteConversation,
        sendMessage: sendChatMessage,
        startLoop,
        cancelLoop,
        wsStatus: status,
        defaultCwd,
        // Message queue operations
        queueMessage,
        cancelQueuedMessage,
        clearQueue,
        getQueue,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}
