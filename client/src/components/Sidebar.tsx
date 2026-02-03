import type { ModelId, ModelInfo, Provider } from '@claude-web-view/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useConversationStore } from '../stores/conversationStore';
import { useUIStore } from '../stores/uiStore';
import { formatTimeAgo, getLastMessageTime, getMinutesElapsed } from '../utils/time';
import { getProjectColor } from '../utils/projectColors';
import { PathAutocomplete } from './PathAutocomplete';
import './Sidebar.css';

/**
 * Exponential decay for time-ago text brightness.
 * Recent ("just now") = near-white, older = fades toward muted grey.
 *
 * Uses color-mix to blend between --text-bright (near-white) and --text-muted (grey).
 * The mix percentage decays exponentially: 100% bright at 0min, ~40% at 30min, ~15% at 60min.
 * Decay constant 0.03 gives a natural half-life of ~23 minutes.
 */
function timeAgoColor(minutesElapsed: number): string {
  const brightPct = Math.round(100 * Math.exp(-0.03 * minutesElapsed));
  return `color-mix(in oklch, var(--text-bright) ${brightPct}%, var(--text-muted))`;
}

export function Sidebar() {
  const conversations = useConversationStore((s) => s.conversations);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const createConversation = useConversationStore((s) => s.createConversation);
  const defaultCwd = useConversationStore((s) => s.defaultCwd);
  const wsStatus = useConversationStore((s) => s.wsStatus);

  const lastWorkingDirectory = useUIStore((s) => s.lastWorkingDirectory);
  const setLastWorkingDirectory = useUIStore((s) => s.setLastWorkingDirectory);
  const doneConversations = useUIStore((s) => s.doneConversations);
  const markDone = useUIStore((s) => s.markDone);
  const hasUnseenMessages = useUIStore((s) => s.hasUnseenMessages);

  // Tick every 30s to keep time-ago displays current
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Sort conversations by most recent message (latest first), fallback to createdAt
  const sortedConversations = useMemo(() => {
    return Array.from(conversations.values()).sort((a, b) => {
      const aTime = getLastMessageTime(a.messages)?.getTime() ?? new Date(a.createdAt).getTime();
      const bTime = getLastMessageTime(b.messages)?.getTime() ?? new Date(b.createdAt).getTime();
      return bTime - aTime;
    });
  }, [conversations]);

  // Deduplicated working directories from all conversations — fed to PathAutocomplete for fuzzy matching
  const recentDirectories = useMemo(() => {
    const dirs = new Set<string>();
    for (const conv of conversations.values()) {
      dirs.add(conv.workingDirectory);
    }
    return Array.from(dirs);
  }, [conversations]);

  const [showPicker, setShowPicker] = useState(false);
  const [directory, setDirectory] = useState('');
  const [hasPendingDefault, setHasPendingDefault] = useState(false);
  const [provider, setProvider] = useState<Provider>('claude');
  const [model, setModel] = useState<ModelId | undefined>(undefined);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const navigate = useNavigate();
  const location = useLocation();

  // Fetch available models when provider changes
  useEffect(() => {
    fetch(`/api/models?provider=${provider}`)
      .then((res) => res.json())
      .then((data: ModelInfo[]) => {
        setModels(data);
        const defaultModel = data.find((m) => m.isDefault);
        setModel(defaultModel?.id);
      });
  }, [provider]);

  const handleNewConversation = useCallback(() => {
    // Default to the most recently active conversation's working directory,
    // then uiStore fallback, then server cwd.
    const latestConv = sortedConversations[0];
    const lastDir = latestConv?.workingDirectory
      ?? lastWorkingDirectory
      ?? defaultCwd
      ?? '/';
    setDirectory(lastDir);
    setHasPendingDefault(true);
    setShowPicker(true);
  }, [sortedConversations, lastWorkingDirectory, defaultCwd]);

  // Shift+Space global shortcut to open "New Conversation" dialog.
  // Skipped when focus is in an input/textarea so it doesn't hijack typing.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.code !== 'Space') return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      handleNewConversation();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNewConversation]);

  const handleConfirm = () => {
    if (directory.trim()) {
      setLastWorkingDirectory(directory);
      createConversation(directory, provider, model);
      setShowPicker(false);
      // createConversation inserts the stub synchronously and sets activeConversationId.
      // Read it from the store to navigate immediately — no pendingNav dance needed.
      const newId = useConversationStore.getState().activeConversationId;
      if (newId) navigate(`/chat/${newId}`);
    }
  };

  const handleCancel = () => {
    setShowPicker(false);
  };

  const handleSelectConversation = (id: string) => {
    navigate(`/chat/${id}`);
  };

  const handleDone = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    markDone(id);
    if (location.pathname.includes(id)) {
      navigate('/');
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button type="button" className="gallery-btn" onClick={() => navigate('/')}>
          <span>◫</span>
          <span>Gallery</span>
        </button>
        <button type="button" className="new-chat-btn" onClick={handleNewConversation}>
          <span>+</span>
          <span>New Conversation</span>
          <kbd className="shortcut-hint">Shift Space</kbd>
        </button>

        {showPicker && (
          <div className="new-conv-overlay" onClick={handleCancel}>
            <div className="new-conv-modal" onClick={(e) => e.stopPropagation()}>
              <h3 className="new-conv-title">New Conversation</h3>
              <label className="new-conv-label">Working Directory</label>
              <PathAutocomplete
                value={directory}
                onChange={setDirectory}
                recentDirectories={recentDirectories}
                placeholder="Search recent or type a path..."
                className="directory-input"
                hasPendingDefault={hasPendingDefault}
                onClearDefault={() => setHasPendingDefault(false)}
                onConfirm={handleConfirm}
                autoFocus
              />
              <label className="new-conv-label">Provider</label>
              <div className="provider-selector">
                <label className={`provider-option ${provider === 'claude' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="provider"
                    value="claude"
                    checked={provider === 'claude'}
                    onChange={() => setProvider('claude')}
                  />
                  Claude
                </label>
                <label className={`provider-option ${provider === 'codex' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="provider"
                    value="codex"
                    checked={provider === 'codex'}
                    onChange={() => setProvider('codex')}
                  />
                  Codex
                </label>
              </div>
              <label className="new-conv-label">Model</label>
              <div className="model-selector">
                {models.map((m) => (
                  <label
                    key={m.id}
                    className={`model-option ${model === m.id ? 'selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="model"
                      value={m.id}
                      checked={model === m.id}
                      onChange={() => setModel(m.id)}
                    />
                    {m.displayName}
                  </label>
                ))}
              </div>
              <div className="directory-actions">
                <button
                  type="button"
                  className="dir-action-btn dir-cancel-btn"
                  onClick={handleCancel}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="dir-action-btn dir-confirm-btn"
                  onClick={handleConfirm}
                  disabled={wsStatus !== 'connected'}
                  title={wsStatus !== 'connected' ? 'Server disconnected' : 'Create conversation (Shift+Enter)'}
                >
                  Create
                  <kbd className="btn-shortcut">⇧↵</kbd>
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="ws-status">
          <span className={`status-dot ${wsStatus}`} />
          {wsStatus}
        </div>
      </div>

      <div className="conversations-list">
        {sortedConversations.filter((conv) => !doneConversations.includes(conv.id)).map((conv) => {
          const isActive = conv.id === activeConversationId;
          const projectColor = getProjectColor(conv.workingDirectory);
          const dirDisplay = conv.workingDirectory.replace(/^\/Users\/[^/]+/, '~');
          // Show just the last folder name as a short badge label
          const folderName = conv.workingDirectory.split('/').filter(Boolean).pop() ?? dirDisplay;
          const preview =
            conv.messages.length > 0
              ? `${conv.messages[conv.messages.length - 1].content.substring(0, 50)}...`
              : 'New conversation';

          const lastTime = getLastMessageTime(conv.messages);
          const timeAgo = lastTime ? formatTimeAgo(lastTime) : null;
          const timeColor = lastTime ? timeAgoColor(getMinutesElapsed(lastTime)) : undefined;
          // NEW Badge Feature: Show badge if user hasn't seen the latest messages.
          // Badge shows when lastSeenIndex < messages.length - 1.
          // See docs/new_badge_feature.md
          const hasUnseen = hasUnseenMessages(conv.id, conv.messages.length);

          return (
            <div
              key={conv.id}
              className={`conversation-item ${isActive ? 'active' : ''}`}
              onClick={() => handleSelectConversation(conv.id)}
              style={{ borderLeftColor: projectColor }}
            >
              <div className="conversation-header">
                <span
                  className="folder-badge"
                  style={{ background: `color-mix(in srgb, ${projectColor} 25%, transparent)`, color: projectColor }}
                  title={dirDisplay}
                >
                  {folderName}
                </span>
                <div className="conversation-header-right">
                  {hasUnseen && <span className="new-badge">NEW</span>}
                  {timeAgo && <span className="conversation-time-ago" style={{ color: timeColor }}>{timeAgo}</span>}
                  <div className={`status-indicator ${conv.isRunning ? 'running' : ''}`} />
                </div>
              </div>
              <div className="conversation-preview">{preview}</div>
              <button
                type="button"
                className="done-btn"
                onClick={(e) => handleDone(conv.id, e)}
              >
                Done
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
