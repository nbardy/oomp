import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
// Solarized Dark theme for syntax highlighting - matches app aesthetic
import 'highlight.js/styles/base16/solarized-dark.css';
import type { Conversation as SharedConversation } from '@claude-web-view/shared';
import { useDropzone } from 'react-dropzone';
import { useSavedPrompts } from '../hooks/useSavedPrompts';
import { useConversationStore } from '../stores/conversationStore';
import type { QueuedMessage } from '../stores/conversationStore';
import { DRAFT_KEY_PREFIX, useUIStore } from '../stores/uiStore';
import { buildUnifiedSubAgents } from '../utils/subAgents';
import { formatTimeAgo } from '../utils/time';
import { PromptPalette } from './PromptPalette';
import { SubAgentPanel } from './SubAgentPanel';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import type { MessageGroup } from './VirtualizedMessageList';
import './Chat.css';

// Stable reference for empty queue — avoids new [] on every render triggering re-renders
const EMPTY_QUEUE: QueuedMessage[] = [];
const EMPTY_CHILD_CONVERSATIONS: SharedConversation[] = [];

/** Shorten model names for badge display: "claude-sonnet-4-5-20250929" → "sonnet-4.5" */
function shortModelName(modelName: string | null | undefined): string | null {
  if (!modelName) return null;
  // Claude models - try different patterns
  // Pattern 1: claude-{variant}-{major}-{minor}-{date} (e.g., claude-opus-4-5-20250929)
  const claudeMatch1 = modelName.match(/claude-(\w+)-(\d+)-(\d+)-/);
  if (claudeMatch1) return `${claudeMatch1[1]}-${claudeMatch1[2]}.${claudeMatch1[3]}`;
  // Pattern 2: claude-{number}-{variant}-{date} (e.g., claude-3-opus-20240229)
  const claudeMatch2 = modelName.match(/claude-(\d+)-(\w+)-\d{8}/);
  if (claudeMatch2) return `${claudeMatch2[2]}-${claudeMatch2[1]}`;
  // Pattern 3: claude-{variant}-{number} (e.g., claude-opus-4)
  const claudeMatch3 = modelName.match(/claude-(\w+)-(\d+)$/);
  if (claudeMatch3) return `${claudeMatch3[1]}-${claudeMatch3[2]}`;
  // Codex models: gpt-{variant}
  if (modelName.includes('codex') || modelName.includes('gpt')) {
    const parts = modelName.split('-');
    return parts.slice(0, 3).join('-');
  }
  return modelName.length > 20 ? modelName.substring(0, 20) : modelName;
}

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

// =============================================================================
// Memoized Message and Markdown components moved to VirtualizedMessageList.tsx
// See that file for the MemoizedMessage component and markdownComponents.
// =============================================================================

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

  // Select active conversation + only its linked child sessions needed for
  // unified sub-agent rendering (avoids subscribing to all conversations).
  const conversation = useConversationStore((s) => (id ? (s.conversations.get(id) ?? null) : null));
  const childSessionConversations = useConversationStore(
    useShallow((s) => {
      if (!id) return EMPTY_CHILD_CONVERSATIONS;
      const children: SharedConversation[] = [];
      for (const candidate of s.conversations.values()) {
        if (candidate.parentConversationId === id) {
          children.push(candidate);
        }
      }
      children.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      return children;
    })
  );
  const conversationCount = useConversationStore((s) => s.conversations.size);
  const queue = useConversationStore((s) => {
    if (!id) return EMPTY_QUEUE;
    const conv = s.conversations.get(id);
    return conv?.queue?.length ? conv.queue : EMPTY_QUEUE;
  });

  // Actions are stable function references — never trigger re-renders
  const setActiveConversationId = useConversationStore((s) => s.setActiveConversationId);
  const startLoop = useConversationStore((s) => s.startLoop);
  const cancelLoop = useConversationStore((s) => s.cancelLoop);
  const queueMessage = useConversationStore((s) => s.queueMessage);
  const interruptAndSend = useConversationStore((s) => s.interruptAndSend);
  const cancelQueuedMessage = useConversationStore((s) => s.cancelQueuedMessage);
  const clearQueue = useConversationStore((s) => s.clearQueue);

  const { savePrompt } = useSavedPrompts();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // NEW Badge Feature: IntersectionObserver ref to detect when last message is visible.
  // When 50%+ of last message enters viewport, mark all messages as seen.
  // See docs/new_badge_feature.md for design rationale.
  const lastMessageRef = useRef<HTMLDivElement>(null);
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
      textarea.style.height = `${Math.min(textarea.scrollHeight, 300)}px`;
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
  const confirmed = conversation?.confirmed ?? false;
  const isRunning = conversation?.isRunning ?? false;
  // isStreaming: server-authoritative — assistant is actively producing content.
  // See state machine docs in shared/src/index.ts.
  const isStreaming = conversation?.isStreaming ?? false;

  // Ref to track running state for cleanup — closures in useEffect capture stale values,
  // so we need a ref to read current isRunning when the cleanup function executes.
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  // Allow input if confirmed, even if running (messages will queue)
  const canInput = confirmed && !isLooping;
  // Messages will be queued if running or streaming
  const willQueue = confirmed && (isRunning || isStreaming);

  // File upload: send button enabled when there are files even without text
  const hasContent = hasInput || pendingFiles.length > 0;

  // Split queue: "sending" message is current (already visible in chat), only "pending" are truly queued.
  // Loop state is read from loopConfig directly — not stored in the queue.
  const currentMessage = queue.find((m) => m.status === 'sending') ?? null;
  const pendingQueue = queue.filter((m) => m.status === 'pending');

  // Upload files immediately on drop/select — returns absolute paths from server
  const handleFilesUpload = useCallback(
    async (acceptedFiles: File[]) => {
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

      const result = (await response.json()) as {
        files: Array<{
          originalName: string;
          absolutePath: string;
          mimeType: string;
          size: number;
        }>;
      };
      const withPreviews: PendingFile[] = result.files.map((uploaded, i) => ({
        ...uploaded,
        previewUrl: acceptedFiles[i].type.startsWith('image/')
          ? URL.createObjectURL(acceptedFiles[i])
          : null,
      }));

      setPendingFiles((prev) => [...prev, ...withPreviews]);
      setIsUploading(false);
    },
    [id]
  );

  const {
    getRootProps,
    getInputProps,
    isDragActive,
    open: openFilePicker,
  } = useDropzone({
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
    // Cleanup when navigating away: clear active ID but do NOT kill the process.
    // Processes are spawned detached (detached: true, unref()) and designed to
    // complete independently. Killing on navigation causes the bug where switching
    // tabs too quickly after sending a message terminates the CLI mid-response.
    // Users can explicitly stop via the stop button if needed.
    return () => {
      setActiveConversationId(null);
    };
  }, [id, setActiveConversationId, setUIActiveId]);

  // Auto-scroll is now handled by VirtualizedMessageList component

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

  // NEW Badge Feature: IntersectionObserver is now handled by VirtualizedMessageList
  // See VirtualizedMessageList.tsx for implementation details.

  // Scroll state callback from VirtualizedMessageList
  const handleScrollStateChange = useCallback((_isNearBottom: boolean, showButton: boolean) => {
    setShowScrollToBottom(showButton);
  }, []);

  // Ref for VirtualizedMessageList to call scroll-to-bottom
  const scrollToBottomRef = useRef<(() => void) | null>(null);

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
    textarea.style.height = `${Math.min(textarea.scrollHeight, 300)}px`;

    // Only trigger React re-render when the boolean flips
    const has = textarea.value.trim().length > 0;
    if (has !== hasInput) setHasInput(has);

    // Debounced draft save — restart timer on each keystroke
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(saveDraft, DRAFT_SAVE_DELAY_MS);
  };

  // Handle pasted images from clipboard — extract File objects and process like dropped files
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      await handleFilesUpload(files);
    }
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
  const messageGroups = useMemo((): MessageGroup[] => {
    if (!conversation) return [];
    const groups: MessageGroup[] = [];
    let currentLoopGroup: MessageGroup | null = null;

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

  const unifiedSubAgents = useMemo(() => {
    if (!conversation) return [];
    return buildUnifiedSubAgents(conversation, childSessionConversations);
  }, [conversation, childSessionConversations]);

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
    if ((!textContent && pendingFiles.length === 0) || !id || !confirmed) return;

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

    if (e.key === 'Enter' && !e.shiftKey && hasContent && confirmed) {
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
    <div className={`chat-view${isDragActive ? ' drag-active' : ''}`} {...getRootProps()}>
      <input {...getInputProps()} />
      {isDragActive && (
        <div className="dropzone-overlay">
          <div className="dropzone-overlay-content">
            <span className="dropzone-overlay-icon">&#x1F4CE;</span>
            <span className="dropzone-overlay-text">Drop files here</span>
          </div>
        </div>
      )}
      <div className="chat-header">
        <div className="chat-title">
          <span className="chat-id">{conversation.id.substring(0, 8)}</span>
          <span className={`provider-badge provider-${conversation.provider || 'claude'}`}>
            {conversation.provider || 'claude'}
          </span>
          {shortModelName(conversation.modelName) && (
            <span className="model-badge">{shortModelName(conversation.modelName)}</span>
          )}
          <Link
            className="chat-dir"
            to={`/?folders=${encodeURIComponent(conversation.workingDirectory)}`}
          >
            {dirDisplay}
          </Link>
          {timeAgo && <span className="chat-time-ago">{timeAgo}</span>}
        </div>
        <div className="header-status">
          {!confirmed && <div className="ready-badge waiting">Starting...</div>}
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
          <div className={`status-indicator ${isRunning || isStreaming ? 'running' : ''}`} />
        </div>
      </div>

      {/* Unified Sub-Agent Panel: provider Task-tool subagents + linked child sessions */}
      {unifiedSubAgents.length > 0 && <SubAgentPanel subAgents={unifiedSubAgents} />}

      {conversation.messages.length === 0 ? (
        <div className="messages-container">
          <div className="empty-state">
            {confirmed
              ? 'Send a message to start the conversation.'
              : `Waiting for ${conversation.provider || 'claude'} to be ready...`}
          </div>
        </div>
      ) : (
        <div className="messages-container-wrapper">
          <VirtualizedMessageList
            messageGroups={messageGroups}
            collapsedIterations={collapsedIterations}
            toggleIterationCollapse={toggleIterationCollapse}
            isRunning={isStreaming}
            lastMessageRef={lastMessageRef}
            onScrollStateChange={handleScrollStateChange}
            conversationId={id!}
            markMessagesSeen={markMessagesSeen}
            totalMessageCount={conversation.messages.length}
            scrollToBottomRef={scrollToBottomRef}
            workingDirectory={conversation.workingDirectory}
          />
          {isStreaming && (
            <div className="typing-indicator-overlay">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          )}
          {showScrollToBottom && (
            <button
              type="button"
              className="scroll-to-bottom-btn"
              onClick={() => scrollToBottomRef.current?.()}
              aria-label="Scroll to bottom"
            >
              &#x25BC;
            </button>
          )}
        </div>
      )}

      <div className="input-container">
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
                {conversation.loopConfig?.loopsRemaining ?? 0}x remaining
              </span>
              <span className="loop-active-prompt">
                {conversation.loopConfig?.prompt?.substring(0, 60) ?? ''}
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
                  <img
                    className="pending-file-thumb"
                    src={file.previewUrl}
                    alt={file.originalName}
                  />
                ) : (
                  <span className="pending-file-icon">&#x1F4C4;</span>
                )}
                <span className="pending-file-name">{file.originalName}</span>
                <button
                  type="button"
                  className="pending-file-remove"
                  onClick={() =>
                    setPendingFiles((prev) =>
                      prev.filter((f) => f.absolutePath !== file.absolutePath)
                    )
                  }
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
            onPaste={handlePaste}
            placeholder={
              !confirmed
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
              disabled={!confirmed || !hasContent || isLooping}
              title={
                willQueue ? 'Enter: Interrupt & send | Tab: Queue' : 'Enter: Send | Tab: Queue'
              }
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
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 300)}px`;
            setHasInput(content.trim().length > 0);
          }
        }}
      />
    </div>
  );
}
