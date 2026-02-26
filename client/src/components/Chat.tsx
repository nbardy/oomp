import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
// Solarized Dark theme for syntax highlighting - matches app aesthetic
import 'highlight.js/styles/base16/solarized-dark.css';
import type { ModelId, ModelInfo } from '@claude-web-view/shared';
import { PROVIDER_OPTIONS } from '@claude-web-view/shared';
import { useDropzone } from 'react-dropzone';
import {
  cancelQueuedMessage,
  clearQueue,
  interruptAndSend,
  queueMessage,
  setActiveConversationId,
  setModel,
  setProvider,
} from '../atoms/actions';
import type { QueuedMessage } from '../atoms/actions';
import {
  childConversationsAtomFamily,
  conversationAtomFamily,
  conversationCountAtom,
  streamingAtomFamily,
} from '../atoms/conversations';
import { useSavedPrompts } from '../hooks/useSavedPrompts';
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

  // Per-ID atoms — only re-render when THIS conversation changes, not others
  const conversation = useAtomValue(conversationAtomFamily(id ?? ''));
  const streamingText = useAtomValue(streamingAtomFamily(id ?? ''));
  const childSessionConversations = useAtomValue(childConversationsAtomFamily(id ?? ''));
  const conversationCount = useAtomValue(conversationCountAtom);
  const queue = conversation?.queue?.length ? conversation.queue : EMPTY_QUEUE;

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
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const saveDraft = useCallback(() => {
    if (!id) return;
    const value = textareaRef.current?.value ?? '';
    if (value) {
      localStorage.setItem(`${DRAFT_KEY_PREFIX}${id}`, value);
    } else {
      localStorage.removeItem(`${DRAFT_KEY_PREFIX}${id}`);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const draft = localStorage.getItem(`${DRAFT_KEY_PREFIX}${id}`);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.value = draft ?? '';
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 300)}px`;
      setHasInput((draft ?? '').trim().length > 0);
      textarea.focus();
    }
  }, [id]);

  const [hasInput, setHasInput] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>(EMPTY_PENDING);
  const [isUploading, setIsUploading] = useState(false);

  const confirmed = conversation?.confirmed ?? false;
  const isRunning = conversation?.isRunning ?? false;
  const isStreaming = conversation?.isStreaming ?? false;
  const canChangeHarness =
    confirmed &&
    (conversation?.messages.length ?? 0) === 0 &&
    (conversation?.queue.length ?? 0) === 0 &&
    !isRunning &&
    !isStreaming;

  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  const canInput = confirmed;
  const availableProviders = PROVIDER_OPTIONS;

  const willQueue = confirmed && (isRunning || isStreaming);
  const hasContent = hasInput || pendingFiles.length > 0;
  const currentMessage = queue.find((m) => m.status === 'sending') ?? null;
  const pendingQueue = queue.filter((m) => m.status === 'pending');

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
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (id) {
      setActiveConversationId(id);
      setUIActiveId(id);
    }
    return () => {
      setActiveConversationId(null);
    };
  }, [id, setUIActiveId]);

  useEffect(() => {
    if (id && !conversation && conversationCount > 0) {
      navigate('/');
    }
  }, [id, conversation, conversationCount, navigate]);

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

  const handleScrollStateChange = useCallback((_isNearBottom: boolean, showButton: boolean) => {
    setShowScrollToBottom(showButton);
  }, []);

  const scrollToBottomRef = useRef<(() => void) | null>(null);

  const getInputValue = () => textareaRef.current?.value ?? '';

  const clearInput = () => {
    if (textareaRef.current) {
      textareaRef.current.value = '';
      textareaRef.current.style.height = 'auto';
    }
    setHasInput(false);
    for (const file of pendingFiles) {
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    }
    setPendingFiles(EMPTY_PENDING);
    if (id) localStorage.removeItem(`${DRAFT_KEY_PREFIX}${id}`);
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
  };

  const handleInput = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 300)}px`;

    const has = textarea.value.trim().length > 0;
    if (has !== hasInput) setHasInput(has);

    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(saveDraft, DRAFT_SAVE_DELAY_MS);
  };

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

  // IMPORTANT: All hooks must be called before any early return.
  const messageCount = conversation?.messages.length ?? 0;
  const lastMessageTime = useMemo(() => {
    if (!conversation || messageCount === 0) return undefined;
    const last = conversation.messages[messageCount - 1];
    return last.timestamp ? new Date(last.timestamp) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageCount]);

  const timeAgo = useTimeAgo(lastMessageTime);

  // Merge stable conversation messages with live streaming text for display.
  // conversation.messages is stable during streaming; streamingText changes per chunk.
  const conversationMessages = useMemo(() => {
    if (!conversation) return [];
    if (!streamingText) return conversation.messages;
    const messages = conversation.messages.slice();
    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant') return conversation.messages;
    messages[messages.length - 1] = { ...last, content: last.content + streamingText };
    return messages;
  }, [conversation?.messages, streamingText]);

  const messageGroups = useMemo((): MessageGroup[] => {
    if (!conversation) return [];
    const prefix = conversation.swarmDebugPrefix;
    return conversationMessages.map((msg, i) => {
      if (i === 0 && msg.role === 'user' && prefix && msg.content.startsWith(prefix)) {
        const stripped = msg.content.slice(prefix.length).replace(/^\n\n/, '');
        return { type: 'single' as const, messages: [{ ...msg, content: stripped }] };
      }
      return { type: 'single' as const, messages: [msg] };
    });
  }, [conversationMessages, conversation?.swarmDebugPrefix]);

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

  const handleRemoveFromQueue = (messageId: string) => {
    if (id) cancelQueuedMessage(id, messageId);
  };

  const handleClearQueue = () => {
    if (id) clearQueue(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && !e.shiftKey && hasContent && canInput) {
      e.preventDefault();
      handleQueue();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && hasContent && confirmed) {
      e.preventDefault();
      if (willQueue) {
        handleInterrupt();
      } else {
        handleQueue();
      }
    }
  };

  const handleSavePrompt = () => {
    const content = getInputValue().trim();
    if (content) savePrompt(content);
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
                  {availableProviders.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`provider-picker-option ${
                        p.id === conversation.provider ? 'selected' : ''
                      }`}
                      onClick={() => {
                        setProvider(conversation.id, p.id);
                        setProviderPickerOpen(false);
                      }}
                    >
                      {p.label}
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
                {models.find((m) => m.id === conversation.model)?.displayName ??
                  models.find((m) => m.isDefault)?.displayName ??
                  conversation.modelName ??
                  'default'}
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

      {unifiedSubAgents.length > 0 && (
        <SubAgentPanel
          subAgents={unifiedSubAgents}
          workingDirectory={conversation.workingDirectory}
        />
      )}

      {conversation.swarmDebugPrefix && (
        <div style={{ paddingBottom: conversation.messages.length === 0 ? '16px' : 0 }}>
          <SwarmConvoPrefix
            prefix={conversation.swarmDebugPrefix}
            swarmId={conversation.swarmId ?? null}
          />
        </div>
      )}

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
            key={id}
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
        {currentMessage && (
          <div className="current-message-indicator">
            <span className="current-message-label">Current message</span>
            <span className="current-message-content">{currentMessage.content}</span>
          </div>
        )}

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
              <svg
                className="save-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
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
