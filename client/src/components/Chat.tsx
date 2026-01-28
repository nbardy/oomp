import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
// Solarized Dark theme for syntax highlighting - matches app aesthetic
import 'highlight.js/styles/base16/solarized-dark.css';
import { useApp } from '../context/AppContext';
import { useSavedPrompts } from '../hooks/useSavedPrompts';
import { PromptPalette } from './PromptPalette';
import { SubAgentPanel } from './SubAgentPanel';
import './Chat.css';

export function Chat() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    conversations,
    setActiveConversationId,
    startLoop,
    cancelLoop,
    // Centralized queue functions from AppContext
    queueMessage,
    cancelQueuedMessage,
    clearQueue,
    getQueue,
  } = useApp();
  const { savePrompt } = useSavedPrompts();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Loop popup state
  const [showLoopPopup, setShowLoopPopup] = useState(false);
  const [loopCount, setLoopCount] = useState<'5' | '10' | '20'>('5');
  const [clearContext, setClearContext] = useState(true);

  // Prompt palette state
  const [showPalette, setShowPalette] = useState(false);

  // Get queue from centralized context (replaces local queuedMessages state)
  const queue = id ? getQueue(id) : [];

  const conversation = id ? conversations.get(id) : null;

  // Derive state variables early (before effects and handlers that use them)
  const isLooping = conversation?.loopConfig?.isLooping ?? false;
  const isReady = conversation?.isReady ?? false;
  const isRunning = conversation?.isRunning ?? false;
  // Allow input if ready, even if running (messages will queue)
  const canInput = isReady && !isLooping;
  // Messages will be queued if running
  const willQueue = isReady && isRunning;

  useEffect(() => {
    if (id) {
      setActiveConversationId(id);
    }
    return () => setActiveConversationId(null);
  }, [id, setActiveConversationId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: We want to scroll when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation?.messages]);

  // If conversation doesn't exist and we have conversations, go to gallery
  useEffect(() => {
    if (id && !conversation && conversations.size > 0) {
      navigate('/');
    }
  }, [id, conversation, conversations.size, navigate]);

  // Ctrl+P listener for prompt palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setShowPalette(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Auto-grow textarea based on content
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = 'auto';
    // Set to scrollHeight, but respect max-height (600px)
    const newHeight = Math.min(textarea.scrollHeight, 600);
    textarea.style.height = `${newHeight}px`;
  }, []);

  // Adjust height when input changes
  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  // NOTE: Auto-send logic is now handled in AppContext.
  // The context watches for message_complete and status changes to process the queue.

  if (!conversation) {
    return (
      <div className="chat-view">
        <div className="chat-header">
          <div className="chat-title">Select a conversation</div>
        </div>
        <div className="messages-container">
          <div className="empty-state">
            Select a conversation from the sidebar or create a new one.
          </div>
        </div>
      </div>
    );
  }

  const dirDisplay = conversation.workingDirectory.replace(/^\/Users\/[^/]+/, '~');

  // Queue a message - context handles whether to send immediately or queue
  const handleQueue = () => {
    const content = input.trim();
    if (!content || !id || !canInput) return;

    // Context's queueMessage handles the logic:
    // - If not running, sends immediately
    // - If running, queues for later
    queueMessage(id, content);
    setInput('');
    // Reset textarea height after clearing
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  // Alias for backwards compatibility - both Enter and Tab use handleQueue now
  const handleSend = handleQueue;

  // Remove a message from the queue by ID
  const handleRemoveFromQueue = (messageId: string) => {
    if (id) {
      cancelQueuedMessage(id, messageId);
    }
  };

  // Clear all queued messages
  const handleClearQueue = () => {
    if (id) {
      clearQueue(id);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Tab key: queue message (or send immediately if Claude is ready)
    if (e.key === 'Tab' && !e.shiftKey && input.trim() && canInput) {
      e.preventDefault(); // Prevent default tab behavior (focus change)
      handleQueue();
      return;
    }

    // Enter key: also uses handleQueue (context decides send vs queue)
    if (e.key === 'Enter' && !e.shiftKey && canInput && input.trim()) {
      e.preventDefault();
      handleQueue();
    }
  };

  const handleStartLoop = () => {
    if (input.trim() && id) {
      startLoop(id, input.trim(), loopCount, clearContext);
      setInput('');
      setShowLoopPopup(false);
    }
  };

  const handleCancelLoop = () => {
    if (id) {
      cancelLoop(id);
    }
  };

  const handleSavePrompt = () => {
    if (input.trim()) {
      savePrompt(input.trim());
    }
  };

  return (
    <div className="chat-view">
      <div className="chat-header">
        <div className="chat-title">
          <span className="chat-id">{conversation.id.substring(0, 8)}</span>
          <span className={`provider-badge provider-${conversation.provider || 'claude'}`}>
            {conversation.provider || 'claude'}
          </span>
          <span className="chat-dir">{dirDisplay}</span>
        </div>
        <div className="header-status">
          {!isReady && (
            <div className="ready-badge waiting">Starting...</div>
          )}
          {isLooping && (
            <div className="loop-badge">
              {conversation.loopConfig?.currentIteration}/{conversation.loopConfig?.totalIterations}
            </div>
          )}
          {queue.length > 0 && (
            <div className="queue-badge" title="Messages waiting to send">
              {queue.length} queued
              <button
                type="button"
                className="clear-queue-btn"
                onClick={handleClearQueue}
                title="Clear queue"
              >
                Clear
              </button>
            </div>
          )}
          <div className={`status-indicator ${conversation.isRunning ? 'running' : ''}`} />
        </div>
      </div>

      {/* Sub-Agent Panel - shows when sub-agents are active */}
      {conversation.subAgents && conversation.subAgents.length > 0 && (
        <SubAgentPanel subAgents={conversation.subAgents} />
      )}

      <div className="messages-container">
        {conversation.messages.length === 0 ? (
          <div className="empty-state">
            {isReady
              ? 'Send a message to start the conversation.'
              : `Waiting for ${conversation.provider || 'claude'} to be ready...`}
          </div>
        ) : (
          <>
            {conversation.messages.map((msg, i) => (
              <div key={i} className={`message ${msg.role} ${msg.isLoopMarker ? 'loop-marker' : ''}`}>
                {msg.role !== 'system' && (
                  <div className={`message-role ${msg.role}`}>{msg.role}</div>
                )}
                <div className="message-content">
                  {msg.role === 'assistant' ? (
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                    >
                      {msg.content || '...'}
                    </Markdown>
                  ) : (
                    msg.content || '...'
                  )}
                </div>
              </div>
            ))}
            {conversation.isRunning && (
              <div className="typing-indicator">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-container">
        {isLooping && (
          <button type="button" className="cancel-loop-btn" onClick={handleCancelLoop}>
            Cancel Loop ({conversation.loopConfig?.loopsRemaining} remaining)
          </button>
        )}

        {/* Queued messages display */}
        {queue.length > 0 && (
          <div className="queued-messages">
            <div className="queued-messages-header">
              <span className="queued-badge">Queued ({queue.length})</span>
              <button
                type="button"
                className="clear-queue-header-btn"
                onClick={handleClearQueue}
                title="Clear all queued messages"
              >
                Clear All
              </button>
            </div>
            <ul className="queued-messages-list">
              {queue.map((qm, index) => (
                <li key={qm.id} className={`queued-message-item ${qm.status}`}>
                  <span className="queued-message-content">{qm.content}</span>
                  <span className="queued-message-status">
                    {qm.status === 'sending' ? 'Sending...' : `#${index + 1} in queue`}
                  </span>
                  {qm.status === 'pending' && (
                    <button
                      type="button"
                      className="queued-message-remove"
                      onClick={() => handleRemoveFromQueue(qm.id)}
                      title="Remove from queue"
                    >
                      &times;
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="input-wrapper">
          <textarea
            ref={textareaRef}
            className={`message-input ${willQueue ? 'queue-mode' : ''}`}
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
          <div className="input-actions">
            <button
              type="button"
              className="save-prompt-btn"
              onClick={handleSavePrompt}
              title="Save prompt (Ctrl+P to recall)"
              disabled={!input.trim()}
            >
              <img src="/icons/save-prompt.png" alt="Save" className="save-icon" />
            </button>
            <button
              type="button"
              className="loop-btn"
              onClick={() => setShowLoopPopup(!showLoopPopup)}
              disabled={!canInput || !input.trim() || willQueue}
              title="Ralph Wiggum Loop"
            >
              <img src="/icons/ralph-wiggum.png" alt="Loop" className="loop-icon" />
            </button>
            <button
              type="button"
              className={`send-btn ${willQueue ? 'queue-mode' : ''}`}
              onClick={handleSend}
              disabled={!canInput || !input.trim()}
            >
              {willQueue ? 'Queue' : 'Send'}
            </button>
          </div>
        </div>

        {showLoopPopup && (
          <div className="loop-popup">
            <div className="loop-header">Loop Options</div>
            <div className="loop-options">
              {(['5', '10', '20'] as const).map((n) => (
                <label key={n} className={`loop-option ${loopCount === n ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="loopCount"
                    value={n}
                    checked={loopCount === n}
                    onChange={() => setLoopCount(n)}
                  />
                  {n}x
                </label>
              ))}
            </div>
            <label className="clear-context-option">
              <input
                type="checkbox"
                checked={clearContext}
                onChange={(e) => setClearContext(e.target.checked)}
              />
              Clear context between iterations
            </label>
            <button type="button" className="start-loop-btn" onClick={handleStartLoop}>
              Start Loop
            </button>
          </div>
        )}
      </div>

      <PromptPalette
        isOpen={showPalette}
        onClose={() => setShowPalette(false)}
        onSelect={(content) => setInput(content)}
      />
    </div>
  );
}
