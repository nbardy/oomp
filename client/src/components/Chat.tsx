import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
// Solarized Dark theme for syntax highlighting - matches app aesthetic
import 'highlight.js/styles/base16/solarized-dark.css';
import type { Conversation as SharedConversation, ModelId, ModelInfo, Provider } from '@claude-web-view/shared';
import { useDropzone } from 'react-dropzone';
import { useSavedPrompts } from '../hooks/useSavedPrompts';
import { useConversationStore } from '../stores/conversationStore';
import type { QueuedMessage } from '../stores/conversationStore';
import { DRAFT_KEY_PREFIX, useUIStore } from '../stores/uiStore';
import { buildUnifiedSubAgents } from '../utils/subAgents';
import { formatTimeAgo } from '../utils/time';
import { PromptPalette } from './PromptPalette';
import { SubAgentPanel } from './SubAgentPanel';
import { SwarmConvoPrefix } from './SwarmConvoPrefix';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import type { MessageGroup } from './VirtualizedMessageList';
import './Chat.css';

// Stable reference for empty queue — avoids new [] on every render triggering re-renders
const EMPTY_QUEUE: QueuedMessage[] = [];
const EMPTY_CHILD_CONVERSATIONS: SharedConversation[] = [];

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
  const queueMessage = useConversationStore((s) => s.queueMessage);
  const interruptAndSend = useConversationStore((s) => s.interruptAndSend);
  const cancelQueuedMessage = useConversationStore((s) => s.cancelQueuedMessage);
  const clearQueue = useConversationStore((s) => s.clearQueue);
  const setProvider = useConversationStore((s) => s.setProvider);

  const setModel = useConversationStore((s) => s.setModel);

  // Model picker: fetch available models for the conversation's provider
  const provider = conversation?.provider ?? 'claude';
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const providerPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/models?provider=${provider}`)
      .then((res) => res.json())
      .then((data: ModelInfo[]) => setModels(data))
      .catch(() => setModels([]));
  }, [provider]);

  // Click-outside to close pickers
  useEffect(() => {
    if (!modelPickerOpen && !providerPickerOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        modelPickerRef.current &&
        !modelPickerRef.current.contains(e.target as Node) &&
        providerPickerRef.current &&
        !providerPickerRef.current.contains(e.target as Node)
      ) {
        setModelPickerOpen(false);
        setProviderPickerOpen(false);
        return;
      }

      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
      }

      if (providerPickerRef.current && !providerPickerRef.current.contains(e.target as Node)) {
        setProviderPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [modelPickerOpen]);

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

  // Prompt palette state
  const [showPalette, setShowPalette] = useState(false);

  // Floating scroll-to-bottom arrow — visible when scrolled up 200px+
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // File upload state — pending files with preview URLs, cleared on send
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>(EMPTY_PENDING);
  const [isUploading, setIsUploading] = useState(false);

  // Derive state variables early (before effects and handlers that use them)
  const confirmed = conversation?.confirmed ?? false;
  const isRunning = conversation?.isRunning ?? false;
  // isStreaming: server-authoritative — assistant is actively producing content.
  // See state machine docs in shared/src/index.ts.
  const isStreaming = conversation?.isStreaming ?? false;
  const canChangeHarness =
    confirmed &&
    (conversation?.messages.length ?? 0) === 0 &&
    (conversation?.queue.length ?? 0) === 0 &&
    !isRunning &&
    !isStreaming;

  // Ref to track running state for cleanup — closures in useEffect capture stale values,
  // so we need a ref to read current isRunning when the cleanup function executes.
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  // Allow input if confirmed, even if running (messages will queue)
  const canInput = confirmed;
  const availableProviders: Array<{ id: Provider; label: string }> = [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' },
    { id: 'opencode', label: 'OpenCode' },
  ];

  // Messages will be queued if running or streaming
  const willQueue = confirmed && (isRunning || isStreaming);

  // File upload: send button enabled when there are files even without text
  const hasContent = hasInput || pendingFiles.length > 0;

  // Split queue: "sending" message is current (already visible in chat), only "pending" are truly queued.
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

  // Wrap messages into groups for VirtualizedMessageList.
  // Strip swarm debug prefix from first user message display —
  // the prefix was prepended server-side for the CLI but should not
  // appear in the chat UI. The SwarmConvoPrefix token shows it instead.
  const messageGroups = useMemo((): MessageGroup[] => {
    if (!conversation) return [];
    const prefix = conversation.swarmDebugPrefix;
    return conversation.messages.map((msg, i) => {
      if (i === 0 && msg.role === 'user' && prefix && msg.content.startsWith(prefix)) {
        const stripped = msg.content.slice(prefix.length).replace(/^\n\n/, '');
        return { type: 'single' as const, messages: [{ ...msg, content: stripped }] };
      }
      return { type: 'single' as const, messages: [msg] };
    });
  }, [conversation?.messages, conversation?.swarmDebugPrefix]);

  const unifiedSubAgents = useMemo(() => {
    if (!conversation) return [];
    return buildUnifiedSubAgents(conversation, childSessionConversations);
  }, [conversation, childSessionConversations]);

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
          {!canChangeHarness ? (
            <span className={`provider-badge provider-${conversation.provider || 'claude'}`}>
              {conversation.provider || 'claude'}
            </span>
          ) : (
            <div className="provider-picker" ref={providerPickerRef}>
              <button
                type="button"
                className={`provider-picker-trigger ${conversation.provider}`}
                onClick={() => {
                  setProviderPickerOpen((o) => !o);
                  setModelPickerOpen(false);
                }}
              >
                {conversation.provider || 'claude'}
                <span className="provider-picker-caret">&#x25BE;</span>
              </button>
              {providerPickerOpen && (
                <div className="provider-picker-menu">
                  {availableProviders.map((provider) => (
                    <button
                      key={provider.id}
                      type="button"
                      className={`provider-picker-option ${
                        provider.id === conversation.provider ? 'selected' : ''
                      }`}
                      onClick={() => {
                        setProvider(conversation.id, provider.id);
                        setProviderPickerOpen(false);
                      }}
                    >
                      {provider.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {models.length > 0 && (
            <div className="model-picker" ref={modelPickerRef}>
              <button
                type="button"
                className="model-picker-trigger"
                onClick={() => {
                  setModelPickerOpen((o) => !o);
                  setProviderPickerOpen(false);
                }}
              >
                {models.find((m) => m.id === conversation.model)?.displayName
                  ?? models.find((m) => m.isDefault)?.displayName
                  ?? conversation.modelName
                  ?? 'default'}
                <span className="model-picker-caret">&#x25BE;</span>
              </button>
              {modelPickerOpen && (
                <div className="model-picker-menu">
                  {models.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`model-picker-option ${
                        m.id === (conversation.model ?? models.find((d) => d.isDefault)?.id)
                          ? 'selected'
                          : ''
                      }`}
                      onClick={() => {
                        setModel(conversation.id, m.id as ModelId);
                        setModelPickerOpen(false);
                      }}
                    >
                      {m.displayName}
                      {m.isDefault && <span className="model-default-tag">default</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
          {conversation.swarmDebugPrefix && (
            <SwarmConvoPrefix
              prefix={conversation.swarmDebugPrefix}
              swarmId={conversation.swarmId ?? null}
            />
          )}
          <VirtualizedMessageList
            messageGroups={messageGroups}
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
              <svg className="save-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
            </button>
            <button
              type="button"
              className={`send-btn ${willQueue ? 'interrupt-mode' : ''}`}
              onClick={willQueue ? handleInterrupt : handleSend}
              disabled={!confirmed || !hasContent}
              title={
                willQueue ? 'Enter: Interrupt & send | Tab: Queue' : 'Enter: Send | Tab: Queue'
              }
            >
              {willQueue ? 'Interrupt' : 'Send'}
            </button>
          </div>
        </div>

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
