import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
// Solarized Dark theme for syntax highlighting - matches app aesthetic
import 'highlight.js/styles/base16/solarized-dark.css';
import type { Components } from 'react-markdown';
import type { Message } from '@claude-web-view/shared';
import { FilePreview, getPreviewType } from './FilePreview';
import { useConversationStore } from '../stores/conversationStore';
import type { QueuedMessage } from '../stores/conversationStore';
import { useUIStore, DRAFT_KEY_PREFIX } from '../stores/uiStore';
import { useSavedPrompts } from '../hooks/useSavedPrompts';
import { formatTimeAgo } from '../utils/time';
import { PromptPalette } from './PromptPalette';
import { SubAgentPanel } from './SubAgentPanel';
import { useDropzone } from 'react-dropzone';
import './Chat.css';

// Stable reference for empty queue — avoids new [] on every render triggering re-renders
const EMPTY_QUEUE: QueuedMessage[] = [];

// Draft persistence: debounce delay for saving textarea content to localStorage
const DRAFT_SAVE_DELAY_MS = 500;

interface PendingFile {
  originalName: string;
  absolutePath: string;
  mimeType: string;
  size: number;
  previewUrl: string | null;
}

const EMPTY_PENDING: PendingFile[] = [];

// Stable reference — module-level so react-markdown doesn't re-mount on every render.
// Overrides inline `code` to render file path previews for image/HTML paths.
const markdownComponents: Components = {
  code({ children, className, ...rest }) {
    // Code blocks have className from rehype-highlight — pass through
    if (className) return <code className={className} {...rest}>{children}</code>;

    // Check if inline code content is a previewable file path
    const text = typeof children === 'string' ? children.trim() : null;
    if (!text) return <code {...rest}>{children}</code>;

    const previewType = getPreviewType(text);
    if (!previewType) return <code {...rest}>{children}</code>;

    return <FilePreview path={text} type={previewType} />;
  },
};

// =============================================================================
// Memoized Message Rendering
//
// During streaming, each chunk causes Chat to re-render. Without memoization,
// EVERY message re-parses through react-markdown + rehype-highlight — even
// completed messages whose content hasn't changed. On a 50-message thread with
// 100 chunks, that's 5,000 Markdown parse cycles.
//
// MemoizedMessage skips re-render when content/role/isLoopMarker are unchanged.
// Only the actively-streaming message (whose content grows each frame) re-renders.
// =============================================================================

interface MemoizedMessageProps {
  msg: Message;
  className: string;
  forwardedRef?: React.RefObject<HTMLDivElement | null>;
}

const MemoizedMessage = memo(function MemoizedMessage({ msg, className, forwardedRef }: MemoizedMessageProps) {
  return (
    <div className={className} ref={forwardedRef}>
      {msg.role !== 'system' && (
        <div className={`message-role ${msg.role}`}>{msg.role}</div>
      )}
      <div className="message-content">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={markdownComponents}
        >
          {msg.content || '...'}
        </Markdown>
      </div>
    </div>
  );
}, (prev, next) => {
  // Skip re-render if content and role haven't changed
  return prev.msg.content === next.msg.content
    && prev.msg.role === next.msg.role
    && prev.className === next.className
    && prev.forwardedRef === next.forwardedRef;
});

/**
 * Returns a live-updating "time ago" string for a Date.
 * Ticks every 30s to stay reasonably current without excessive renders.
 */
function useTimeAgo(date: Date | undefined): string | null {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!date) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [date]);

  if (!date) return null;
  return formatTimeAgo(date);
}

export function Chat() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Targeted selectors: only re-render when THIS conversation or its queue changes,
  // not when any other conversation in the Map updates.
  const conversation = useConversationStore((s) => id ? s.conversations.get(id) ?? null : null);
  const conversationCount = useConversationStore((s) => s.conversations.size);
  const queue = useConversationStore((s) => (id ? s.queues.get(id) : undefined) ?? EMPTY_QUEUE);

  // Actions are stable function references — never trigger re-renders
  const setActiveConversationId = useConversationStore((s) => s.setActiveConversationId);
  const startLoop = useConversationStore((s) => s.startLoop);
  const cancelLoop = useConversationStore((s) => s.cancelLoop);
  const queueMessage = useConversationStore((s) => s.queueMessage);
  const interruptAndSend = useConversationStore((s) => s.interruptAndSend);
  const cancelQueuedMessage = useConversationStore((s) => s.cancelQueuedMessage);
  const clearQueue = useConversationStore((s) => s.clearQueue);

  const { savePrompt } = useSavedPrompts();
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // NEW Badge Feature: IntersectionObserver ref to detect when last message is visible.
  // When 50%+ of last message enters viewport, mark all messages as seen.
  // See docs/new_badge_feature.md for design rationale.
  const lastMessageRef = useRef<HTMLDivElement>(null);
  // Track whether user is near the bottom — only auto-scroll if they haven't scrolled up
  const isNearBottomRef = useRef(true);
  // Debounce timer for draft saves — cleared on each keystroke, fires after DRAFT_SAVE_DELAY_MS
  const draftTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Save draft to localStorage, debounced. Reads directly from DOM (uncontrolled textarea).
  const saveDraft = useCallback(() => {
    if (!id) return;
    const value = textareaRef.current?.value ?? '';
    if (value) {
      localStorage.setItem(`${DRAFT_KEY_PREFIX}${id}`, value);
    } else {
      localStorage.removeItem(`${DRAFT_KEY_PREFIX}${id}`);
    }
  }, [id]);

  // Restore draft from localStorage when switching conversations.
  // Runs after the textarea DOM element is mounted and conversation changes.
  useEffect(() => {
    if (!id) return;
    const draft = localStorage.getItem(`${DRAFT_KEY_PREFIX}${id}`);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.value = draft ?? '';
      // Trigger auto-grow height calculation
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 600)}px`;
      setHasInput((draft ?? '').trim().length > 0);
      // Focus the textarea so the user can start typing immediately
      textarea.focus();
    }
  }, [id]);

  // PERF: Uncontrolled textarea — text lives in the DOM, not React state.
  // During streaming, chunks update the conversation object dozens of times per second,
  // causing Chat to re-render (to show new message content + Markdown re-parse).
  // A controlled textarea (value={input} + onChange) would pipe every keystroke through
  // React's render cycle, competing with those chunk re-renders and causing severe input lag.
  // Instead, we read the value directly from textareaRef.current.value on submit.
  // Only this boolean syncs to React (for button disabled states) — it flips at most twice
  // (empty→non-empty, non-empty→empty), not on every keystroke.
  const [hasInput, setHasInput] = useState(false);

  // Loop popup state
  const [showLoopPopup, setShowLoopPopup] = useState(false);
  const [loopCount, setLoopCount] = useState<'5' | '10' | '20'>('5');
  const [clearContext, setClearContext] = useState(true);

  // Prompt palette state
  const [showPalette, setShowPalette] = useState(false);

  // Floating scroll-to-bottom arrow — visible when scrolled up 200px+
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // File upload state — pending files with preview URLs, cleared on send
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>(EMPTY_PENDING);
  const [isUploading, setIsUploading] = useState(false);

  // Derive state variables early (before effects and handlers that use them)
  const isLooping = conversation?.loopConfig?.isLooping ?? false;
  const isReady = conversation?.isReady ?? false;
  const isRunning = conversation?.isRunning ?? false;
  // Allow input if ready, even if running (messages will queue)
  const canInput = isReady && !isLooping;
  // Messages will be queued if running
  const willQueue = isReady && isRunning;

  // File upload: send button enabled when there are files even without text
  const hasContent = hasInput || pendingFiles.length > 0;

  // Split queue: "sending" message is current (already visible in chat), only "pending" are truly queued.
  // For loop entries, the "sending" entry IS the loop countdown — show it separately.
  const loopQueueEntry = queue.find((m) => m.isLoop) ?? null;
  const currentMessage = queue.find((m) => m.status === 'sending' && !m.isLoop) ?? null;
  const pendingQueue = queue.filter((m) => m.status === 'pending' && !m.isLoop);

  // Upload files immediately on drop/select — returns absolute paths from server
  const handleFilesUpload = useCallback(async (acceptedFiles: File[]) => {
    if (!id || acceptedFiles.length === 0) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append('conversationId', id);
    for (const file of acceptedFiles) {
      formData.append('files', file);
    }

    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      setIsUploading(false);
      throw new Error(`Upload failed: ${error.error}`);
    }

    const result = await response.json() as { files: Array<{ originalName: string; absolutePath: string; mimeType: string; size: number }> };
    const withPreviews: PendingFile[] = result.files.map((uploaded, i) => ({
      ...uploaded,
      previewUrl: acceptedFiles[i].type.startsWith('image/')
        ? URL.createObjectURL(acceptedFiles[i])
        : null,
    }));

    setPendingFiles((prev) => [...prev, ...withPreviews]);
    setIsUploading(false);
  }, [id]);

  const { getRootProps, getInputProps, isDragActive, open: openFilePicker } = useDropzone({
    onDrop: handleFilesUpload,
    noClick: true,
    noKeyboard: true,
  });

  // Cleanup object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      for (const file of pendingFiles) {
        if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      }
    };
  }, [pendingFiles]);

  const setUIActiveId = useUIStore((s) => s.setActiveConversationId);
  const markMessagesSeen = useUIStore((s) => s.markMessagesSeen);

  useEffect(() => {
    if (id) {
      setActiveConversationId(id);
      setUIActiveId(id);
    }
    return () => setActiveConversationId(null);
  }, [id, setActiveConversationId, setUIActiveId]);

  // Auto-scroll: during streaming, chunks flush ~60Hz via rAF. Using
  // 'smooth' scrollIntoView would queue an animated scroll per frame,
  // fighting the browser's layout engine. Use 'instant' when running
  // (actively streaming) and 'smooth' only for discrete new messages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: We want to scroll when messages change
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({
        behavior: isRunning ? 'instant' : 'smooth',
      });
    }
  }, [conversation?.messages, isRunning]);

  // If conversation doesn't exist and we have conversations, go to gallery
  useEffect(() => {
    if (id && !conversation && conversationCount > 0) {
      navigate('/');
    }
  }, [id, conversation, conversationCount, navigate]);

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

  // NEW Badge Feature: IntersectionObserver to detect when last message is visible.
  // When 50%+ of last message enters viewport → mark all messages as seen → badge disappears.
  // Uses hardware-accelerated IntersectionObserver (no manual scroll listeners needed).
  // Dependencies: [id, messages.length, markMessagesSeen] — only recreate observer when
  // conversation changes or new message arrives.
  useEffect(() => {
    if (!id || !conversation || conversation.messages.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            markMessagesSeen(id, conversation.messages.length - 1);
          }
        }
      },
      { threshold: 0.5 } // 50% of element must be visible
    );

    if (lastMessageRef.current) {
      observer.observe(lastMessageRef.current);
    }

    return () => observer.disconnect();
  }, [id, conversation?.messages.length, markMessagesSeen]);

  // Track scroll position: if user is within 150px of the bottom, auto-scroll.
  // Otherwise they've scrolled up to read — leave them alone.
  // Also show/hide the floating scroll-to-bottom arrow at 200px threshold.
  const handleScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 150;
    setShowScrollToBottom(distanceFromBottom >= 200);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Read textarea value from DOM — never goes through React state
  const getInputValue = () => textareaRef.current?.value ?? '';

  // Clear textarea, reset height, and remove draft from localStorage
  const clearInput = () => {
    if (textareaRef.current) {
      textareaRef.current.value = '';
      textareaRef.current.style.height = 'auto';
    }
    setHasInput(false);
    // Revoke object URLs to prevent memory leaks, then clear pending files
    for (const file of pendingFiles) {
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    }
    setPendingFiles(EMPTY_PENDING);
    if (id) localStorage.removeItem(`${DRAFT_KEY_PREFIX}${id}`);
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
  };

  // Handle input events directly on the DOM element.
  // Only flips the hasInput boolean when it actually changes — no re-render per keystroke.
  // Also debounces draft save to localStorage.
  const handleInput = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Auto-grow: imperative DOM mutation, no React render
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 600)}px`;

    // Only trigger React re-render when the boolean flips
    const has = textarea.value.trim().length > 0;
    if (has !== hasInput) setHasInput(has);

    // Debounced draft save — restart timer on each keystroke
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(saveDraft, DRAFT_SAVE_DELAY_MS);
  };

  // NOTE: Auto-send logic is handled in the Zustand store (conversationStore).
  // The store watches for message_complete and status changes to process the queue.

  // IMPORTANT: All hooks must be called before any early return.
  // React requires hooks to be called in the same order every render.
  // conversation may be null on initial render (before WebSocket init arrives),
  // then non-null on subsequent renders — varying hook count would crash.
  // Only recompute when a NEW message is added (length changes), not when
  // the streaming message's content grows. Chunks don't change the timestamp.
  const messageCount = conversation?.messages.length ?? 0;
  const lastMessageTime = useMemo(() => {
    if (!conversation || messageCount === 0) return undefined;
    const last = conversation.messages[messageCount - 1];
    return last.timestamp ? new Date(last.timestamp) : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageCount]);

  const timeAgo = useTimeAgo(lastMessageTime);

  // Track which loop iteration groups are collapsed (default: expanded)
  const [collapsedIterations, setCollapsedIterations] = useState<Set<number>>(new Set());

  // Group messages by loop iteration for collapsible display.
  // Non-loop messages are wrapped in { type: 'single' } groups.
  // Loop iterations are wrapped in { type: 'loop-group' } with iteration metadata.
  const messageGroups = useMemo(() => {
    if (!conversation) return [];
    type MsgGroup = {
      type: 'single' | 'loop-group';
      iteration?: number;
      total?: number;
      messages: Message[];
      isRunning?: boolean; // true if this iteration is currently streaming
    };
    const groups: MsgGroup[] = [];
    let currentLoopGroup: MsgGroup | null = null;

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
      } else if (msg.isLoopMarker && msg.content.includes('Error')) {
        // Error markers — add to current group if open, otherwise standalone
        if (currentLoopGroup) {
          currentLoopGroup.messages.push(msg);
        } else {
          groups.push({ type: 'single', messages: [msg] });
        }
      } else if (currentLoopGroup) {
        currentLoopGroup.messages.push(msg);
      } else {
        groups.push({ type: 'single', messages: [msg] });
      }
    }

    // Mark the last loop-group as "running" if the conversation is still looping
    if (isLooping && groups.length > 0) {
      const lastGroup = groups[groups.length - 1];
      if (lastGroup.type === 'loop-group') {
        lastGroup.isRunning = true;
      }
    }

    return groups;
  }, [conversation?.messages, isLooping]);

  const toggleIterationCollapse = useCallback((iteration: number) => {
    setCollapsedIterations((prev) => {
      const next = new Set(prev);
      if (next.has(iteration)) {
        next.delete(iteration);
      } else {
        next.add(iteration);
      }
      return next;
    });
  }, []);

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

  // Queue a message — prepends uploaded file paths to content
  const handleQueue = () => {
    const textContent = getInputValue().trim();
    if ((!textContent && pendingFiles.length === 0) || !id || !canInput) return;

    let content = '';
    if (pendingFiles.length > 0) {
      content += '[Attached files]\n';
      for (const file of pendingFiles) {
        content += `${file.absolutePath}\n`;
      }
      if (textContent) content += '\n';
    }
    content += textContent;

    queueMessage(id, content);
    clearInput();
  };

  // Interrupt: kill running job, send wrapped message with user's adjustment
  const handleInterrupt = () => {
    const textContent = getInputValue().trim();
    if ((!textContent && pendingFiles.length === 0) || !id || !isReady) return;

    let content = '';
    if (pendingFiles.length > 0) {
      content += '[Attached files]\n';
      for (const file of pendingFiles) {
        content += `${file.absolutePath}\n`;
      }
      if (textContent) content += '\n';
    }
    content += textContent;

    interruptAndSend(id, content);
    clearInput();
  };

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

  // KEY BINDINGS:
  // Enter (not running) = send immediately
  // Enter (running)     = interrupt running job + send adjusted prompt
  // Tab                 = queue message (waits for current job to finish)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && !e.shiftKey && hasContent && canInput) {
      e.preventDefault();
      handleQueue();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && hasContent && isReady) {
      e.preventDefault();
      if (willQueue) {
        // Running — interrupt and send adjusted prompt
        handleInterrupt();
      } else {
        // Idle — send normally
        handleQueue();
      }
    }
  };

  const handleStartLoop = () => {
    const content = getInputValue().trim();
    if (content && id) {
      startLoop(id, content, loopCount, clearContext);
      clearInput();
      setShowLoopPopup(false);
    }
  };

  const handleCancelLoop = () => {
    if (id) {
      cancelLoop(id);
    }
  };

  const handleSavePrompt = () => {
    const content = getInputValue().trim();
    if (content) {
      savePrompt(content);
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
          <Link
            className="chat-dir"
            to={`/?folders=${encodeURIComponent(conversation.workingDirectory)}`}
          >
            {dirDisplay}
          </Link>
          {timeAgo && <span className="chat-time-ago">{timeAgo}</span>}
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
          {currentMessage && (
            <div className="current-message-badge" title="Currently processing">
              Current
            </div>
          )}
          {pendingQueue.length > 0 && (
            <div className="queue-badge" title="Messages waiting to send">
              {pendingQueue.length} queued
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

      <div className="messages-container" ref={messagesContainerRef} onScroll={handleScroll}>
        {conversation.messages.length === 0 ? (
          <div className="empty-state">
            {isReady
              ? 'Send a message to start the conversation.'
              : `Waiting for ${conversation.provider || 'claude'} to be ready...`}
          </div>
        ) : (
          <>
            {messageGroups.map((group, gi) => {
              const isLastGroup = gi === messageGroups.length - 1;

              if (group.type === 'loop-group' && group.iteration != null) {
                const isCollapsed = collapsedIterations.has(group.iteration);
                return (
                  <div key={`loop-${group.iteration}`} className={`loop-iteration-group ${group.isRunning ? 'running' : ''}`}>
                    <div
                      className="loop-iteration-header"
                      onClick={() => toggleIterationCollapse(group.iteration!)}
                    >
                      <span className="loop-iteration-chevron">
                        {isCollapsed ? '\u25B6' : '\u25BC'}
                      </span>
                      <span className="loop-iteration-label">
                        Loop {group.iteration}/{group.total}
                      </span>
                      {group.isRunning && (
                        <span className="loop-iteration-running">running...</span>
                      )}
                      {isCollapsed && (
                        <span className="loop-iteration-collapsed-hint">
                          {group.messages.length} message{group.messages.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    {!isCollapsed && group.messages.map((msg, mi) => {
                      const isLastMessage = isLastGroup && mi === group.messages.length - 1;
                      return (
                        <MemoizedMessage
                          key={mi}
                          msg={msg}
                          className={`message ${msg.role} ${msg.isLoopMarker ? 'loop-marker' : ''}`}
                          forwardedRef={isLastMessage ? lastMessageRef : undefined}
                        />
                      );
                    })}
                  </div>
                );
              }
              // Single (non-loop) messages
              return group.messages.map((msg, mi) => {
                const isLastMessage = isLastGroup && mi === group.messages.length - 1;
                return (
                  <MemoizedMessage
                    key={`${gi}-${mi}`}
                    msg={msg}
                    className={`message ${msg.role} ${msg.isLoopMarker ? 'loop-marker' : ''}`}
                    forwardedRef={isLastMessage ? lastMessageRef : undefined}
                  />
                );
              });
            })}
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
        {showScrollToBottom && (
          <button
            type="button"
            className="scroll-to-bottom-btn"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
          >
            &#x25BC;
          </button>
        )}
      </div>

      <div className={`input-container${isDragActive ? ' drag-active' : ''}`} {...getRootProps()}>
        <input {...getInputProps()} />
        {/* RALPH LOOP STATUS — shows Nx countdown and cancel button during active loop.
            Popup offers 5x/10x/20x counts + clearContext toggle.
            On "Start Loop", sends start_loop to server which orchestrates
            all iterations. The queue area shows "Nx" countdown.
            See docs/ralph_loop_design.md for full spec. */}
        {isLooping && (
          <div className="loop-active-bar">
            <div className="loop-active-info">
              <img src="/icons/ralph-wiggum.png" alt="" className="loop-active-icon" />
              <span className="loop-active-count">
                {loopQueueEntry?.loopIterationsRemaining ?? conversation.loopConfig?.loopsRemaining ?? 0}x remaining
              </span>
              <span className="loop-active-prompt">
                {loopQueueEntry?.content.substring(0, 60) ?? conversation.loopConfig?.prompt?.substring(0, 60) ?? ''}
              </span>
            </div>
            <button type="button" className="cancel-loop-btn" onClick={handleCancelLoop}>
              Cancel
            </button>
          </div>
        )}

        {/* Current message indicator — the "sending" message is already in chat, just label it */}
        {currentMessage && (
          <div className="current-message-indicator">
            <span className="current-message-label">Current message</span>
            <span className="current-message-content">{currentMessage.content}</span>
          </div>
        )}

        {/* Queued messages display — only pending messages, not the current one */}
        {pendingQueue.length > 0 && (
          <div className="queued-messages">
            <div className="queued-messages-header">
              <span className="queued-badge">Queued ({pendingQueue.length})</span>
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
              {pendingQueue.map((qm, index) => (
                <li key={qm.id} className="queued-message-item pending">
                  <span className="queued-message-content">{qm.content}</span>
                  <span className="queued-message-status">#{index + 1} in queue</span>
                  <button
                    type="button"
                    className="queued-message-remove"
                    onClick={() => handleRemoveFromQueue(qm.id)}
                    title="Remove from queue"
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {pendingFiles.length > 0 && (
          <div className="pending-files">
            {pendingFiles.map((file) => (
              <div key={file.absolutePath} className="pending-file-item">
                {file.previewUrl ? (
                  <img className="pending-file-thumb" src={file.previewUrl} alt={file.originalName} />
                ) : (
                  <span className="pending-file-icon">&#x1F4C4;</span>
                )}
                <span className="pending-file-name">{file.originalName}</span>
                <button
                  type="button"
                  className="pending-file-remove"
                  onClick={() => setPendingFiles((prev) => prev.filter((f) => f.absolutePath !== file.absolutePath))}
                  title="Remove file"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="input-wrapper">
          <textarea
            ref={textareaRef}
            className={`message-input ${willQueue ? 'interrupt-mode' : ''}`}
            defaultValue=""
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={
              !isReady
                ? `Waiting for ${conversation.provider || 'claude'}...`
                : willQueue
                  ? 'Enter to interrupt, Tab to queue...'
                  : 'Type your message...'
            }
            disabled={!canInput}
          />
          <div className="input-actions">
            <button
              type="button"
              className="upload-btn"
              onClick={openFilePicker}
              disabled={!canInput || isUploading}
              title="Attach files (drag & drop also supported)"
            >
              <span className="upload-icon">&#x1F4CE;</span>
            </button>
            <button
              type="button"
              className="save-prompt-btn"
              onClick={handleSavePrompt}
              title="Save prompt (Ctrl+P to recall)"
              disabled={!hasInput}
            >
              <img src="/icons/save-prompt.png" alt="Save" className="save-icon" />
            </button>
            <button
              type="button"
              className="loop-btn"
              onClick={() => setShowLoopPopup(!showLoopPopup)}
              disabled={!canInput || !hasInput || willQueue}
              title="Ralph Wiggum Loop"
            >
              <img src="/icons/ralph-wiggum.png" alt="Loop" className="loop-icon" />
            </button>
            <button
              type="button"
              className={`send-btn ${willQueue ? 'interrupt-mode' : ''}`}
              onClick={willQueue ? handleInterrupt : handleSend}
              disabled={!isReady || !hasContent || isLooping}
              title={willQueue ? 'Enter: Interrupt & send | Tab: Queue' : 'Enter: Send | Tab: Queue'}
            >
              {willQueue ? 'Interrupt' : 'Send'}
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
        onSelect={(content) => {
          if (textareaRef.current) {
            textareaRef.current.value = content;
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 600)}px`;
            setHasInput(content.trim().length > 0);
          }
        }}
      />
    </div>
  );
}
