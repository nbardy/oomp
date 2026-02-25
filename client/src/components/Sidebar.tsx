import { PROVIDER_OPTIONS } from '@claude-web-view/shared';
import type { Conversation, ModelId, ModelInfo, Provider } from '@claude-web-view/shared';
import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { createConversation } from '../atoms/actions';
import {
  activeConversationIdAtom,
  allConversationsAtom,
  defaultCwdAtom,
  wsStatusAtom,
} from '../atoms/conversations';
import { jotaiStore } from '../atoms/store';
import { useSwarmRuntimeSnapshots } from '../hooks/useSwarmRuntimeSnapshots';
import { useUIStore } from '../stores/uiStore';
import { getProjectColor } from '../utils/projectColors';
import { getProjectRoot } from '../utils/swarmUtils';
import { getWorkerVisibilitySummary } from '../utils/swarmWorkerVisibility';
import { formatTimeAgo, getConversationLastActivity, getMinutesElapsed } from '../utils/time';
import { PathAutocomplete } from './PathAutocomplete';
import { SearchPalette } from './SearchPalette';
import './Sidebar.css';

const RECENT_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;
const ROOT_PLACEHOLDER = '/';

interface FolderGroup {
  directory: string;
  conversations: Conversation[];
  lastMessageTime: number;
}

function normalizeFolderDirectory(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return ROOT_PLACEHOLDER;
  const withoutTrailingSlashes = trimmed.replace(/\/+$/, '');
  return withoutTrailingSlashes || ROOT_PLACEHOLDER;
}

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
  const allConversations = useAtomValue(allConversationsAtom);
  const activeConversationId = useAtomValue(activeConversationIdAtom);
  const defaultCwd = useAtomValue(defaultCwdAtom);
  const wsStatus = useAtomValue(wsStatusAtom);

  const lastWorkingDirectory = useUIStore((s) => s.lastWorkingDirectory);
  const setLastWorkingDirectory = useUIStore((s) => s.setLastWorkingDirectory);
  const doneConversations = useUIStore((s) => s.doneConversations);
  const markDone = useUIStore((s) => s.markDone);
  const hasUnseenMessages = useUIStore((s) => s.hasUnseenMessages);
  const promotedWorkers = useUIStore((s) => s.promotedWorkers);
  const sidebarViewMode = useUIStore((s) => s.sidebarViewMode);
  const setSidebarViewMode = useUIStore((s) => s.setSidebarViewMode);
  const galleryCollapsedProjects = useUIStore((s) => s.galleryCollapsedProjects);
  const toggleGalleryCollapsed = useUIStore((s) => s.toggleGalleryCollapsed);

  // Tick every 30s to keep time-ago displays current
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const promotedSet = useMemo(() => new Set(promotedWorkers), [promotedWorkers]);

  // allConversations is already sorted newest-first by allConversationsAtom
  const workerConversationsByProject = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const conv of allConversations) {
      if (!conv.isWorker || promotedSet.has(conv.id)) continue;
      const projectRoot = getProjectRoot(conv.workingDirectory);
      const existing = map.get(projectRoot);
      if (existing) {
        existing.push(conv);
      } else {
        map.set(projectRoot, [conv]);
      }
    }
    return map;
  }, [allConversations, promotedSet]);

  const workerProjectRoots = useMemo(
    () => Array.from(workerConversationsByProject.keys()),
    [workerConversationsByProject]
  );
  const runtimeSnapshots = useSwarmRuntimeSnapshots(workerProjectRoots);

  const visibleConversations = useMemo(
    () =>
      allConversations.filter(
        (conv) =>
          !doneConversations.includes(conv.id) &&
          // Hide workers unless promoted to main view
          !(conv.isWorker && !promotedSet.has(conv.id))
      ),
    [allConversations, doneConversations, promotedSet]
  );

  const conversationIds = useMemo(
    () => new Set(allConversations.map((c) => c.id)),
    [allConversations]
  );

  const topLevelConversations = useMemo(
    () =>
      visibleConversations.filter(
        (conv) => !(conv.parentConversationId && conversationIds.has(conv.parentConversationId))
      ),
    [visibleConversations, conversationIds]
  );

  // Grouped view: split conversations into recent (48h, by folder) + older (flat)
  const { recentGroups, olderConversations } = useMemo(() => {
    if (sidebarViewMode !== 'grouped') {
      return { recentGroups: [] as FolderGroup[], olderConversations: [] as Conversation[] };
    }

    const now = Date.now();
    const recentMap = new Map<string, Conversation[]>();
    const older: Conversation[] = [];

    for (const conv of topLevelConversations) {
      const lastTime = getConversationLastActivity(conv);
      const isRecent = now - lastTime.getTime() < RECENT_CUTOFF_MS;
      const folderDirectory = normalizeFolderDirectory(conv.workingDirectory);

      if (isRecent) {
        const existing = recentMap.get(folderDirectory);
        if (existing) {
          existing.push(conv);
        } else {
          recentMap.set(folderDirectory, [conv]);
        }
      } else {
        older.push(conv);
      }
    }

    const groups: FolderGroup[] = Array.from(recentMap.entries()).map(([directory, convs]) => ({
      directory,
      conversations: convs,
      lastMessageTime: Math.max(...convs.map((c) => getConversationLastActivity(c).getTime())),
    }));
    groups.sort((a, b) => b.lastMessageTime - a.lastMessageTime);

    return { recentGroups: groups, olderConversations: older };
  }, [topLevelConversations, sidebarViewMode]);

  const collapsedSet = useMemo(() => new Set(galleryCollapsedProjects), [galleryCollapsedProjects]);

  // Count active workers (isRunning && isWorker && not promoted) for the sidebar nav button
  const { hasWorkers } = useMemo(() => {
    let nextActive = 0;
    let nextTotal = 0;
    let nextHasWorkers = false;

    for (const projectRoot of workerProjectRoots) {
      const workers = workerConversationsByProject.get(projectRoot) ?? [];
      const visibility = getWorkerVisibilitySummary(workers, runtimeSnapshots[projectRoot]);
      nextActive += visibility.runningWorkers;
      nextTotal += visibility.totalWorkers;
      if (visibility.hasWorkers) {
        nextHasWorkers = true;
      }
    }

    return {
      hasWorkers: nextHasWorkers,
      activeWorkerCount: nextActive,
      totalWorkerCount: nextTotal,
    };
  }, [runtimeSnapshots, workerConversationsByProject, workerProjectRoots]);

  // Deduplicated working directories from all conversations — fed to PathAutocomplete for fuzzy matching
  const recentDirectories = useMemo(() => {
    const dirs = new Set<string>();
    for (const conv of allConversations) {
      dirs.add(normalizeFolderDirectory(conv.workingDirectory));
    }
    return Array.from(dirs);
  }, [allConversations]);

  const [showSearch, setShowSearch] = useState(false);
  const [searchFilterDir, setSearchFilterDir] = useState<string | undefined>(undefined);
  const [showPicker, setShowPicker] = useState(false);
  const [directory, setDirectory] = useState('');
  const [hasPendingDefault, setHasPendingDefault] = useState(false);
  const [isDirectoryValid, setIsDirectoryValid] = useState(true);
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
    const latestConv = allConversations[0];
    const lastDir = latestConv?.workingDirectory ?? lastWorkingDirectory ?? defaultCwd ?? '/';
    setDirectory(lastDir);
    setHasPendingDefault(true);
    setShowPicker(true);
  }, [allConversations, lastWorkingDirectory, defaultCwd]);

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

  // Cmd+K / Ctrl+K global shortcut to open search palette.
  // Skipped when focus is in an input/textarea so it doesn't hijack typing.
  useEffect(() => {
    const handleSearchShortcut = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'k') return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      setSearchFilterDir(undefined);
      setShowSearch(true);
    };
    window.addEventListener('keydown', handleSearchShortcut);
    return () => window.removeEventListener('keydown', handleSearchShortcut);
  }, []);

  const handleConfirm = () => {
    if (directory.trim()) {
      setLastWorkingDirectory(directory);
      createConversation(directory, provider, model);
      setShowPicker(false);
      // createConversation inserts the stub synchronously and sets activeConversationId.
      // Read it from the store to navigate immediately — no pendingNav dance needed.
      const newId = jotaiStore.get(activeConversationIdAtom);
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
        {/* ── Conversations Section ── */}
        <div className="nav-section">
          <div className="nav-section-header" style={{ justifyContent: 'space-between' }}>
            <button type="button" className="nav-section-label" onClick={() => navigate('/')}>
              Conversations
            </button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className="nav-create-btn"
                onClick={() => {
                  setSearchFilterDir(undefined);
                  setShowSearch(true);
                }}
                title="Search conversations (Cmd+K)"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="2" />
                  <line
                    x1="11"
                    y1="11"
                    x2="14.5"
                    y2="14.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="nav-create-btn"
                onClick={handleNewConversation}
                title="New conversation (Shift+Space)"
              >
                +
              </button>
            </div>
          </div>
        </div>

        {/* ── Swarms Section ── */}
        {hasWorkers && (
          <div className="nav-section">
            <div className="nav-section-header" style={{ justifyContent: 'space-between' }}>
              <button
                type="button"
                className="nav-section-label"
                onClick={() => navigate('/workers')}
              >
                Swarms
              </button>
              <button
                type="button"
                className="nav-create-btn nav-create-btn--swarm"
                onClick={() => navigate('/workers')}
                title="View swarms"
              >
                +
              </button>
            </div>
          </div>
        )}

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
                onValidationChange={setIsDirectoryValid}
                autoFocus
              />
              <label className="new-conv-label">Provider</label>
              <div className="provider-selector">
                {PROVIDER_OPTIONS.map((option) => (
                  <label
                    className={`provider-option ${provider === option.id ? 'selected' : ''}`}
                    key={option.id}
                  >
                    <input
                      type="radio"
                      name="provider"
                      value={option.id}
                      checked={provider === option.id}
                      onChange={() => setProvider(option.id)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              <label className="new-conv-label">Model</label>
              <div className="model-selector">
                {models.map((m) => (
                  <label key={m.id} className={`model-option ${model === m.id ? 'selected' : ''}`}>
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
                  className="dir-action-btn dir-confirm-btn"
                  onClick={handleConfirm}
                  disabled={wsStatus !== 'connected' || !isDirectoryValid}
                  title={
                    wsStatus !== 'connected'
                      ? 'Server disconnected'
                      : !isDirectoryValid
                        ? 'Invalid directory'
                        : 'Create conversation (Shift+Enter)'
                  }
                >
                  Create
                  <kbd className="btn-shortcut">⇧↵</kbd>
                </button>
              </div>
            </div>
          </div>
        )}

        <SearchPalette
          isOpen={showSearch}
          onClose={() => setShowSearch(false)}
          onSelectConversation={(id) => {
            navigate(`/chat/${id}`);
          }}
          filterDirectory={searchFilterDir}
        />
      </div>

      <div className="conversations-list">
        {(topLevelConversations.length > 0) && (
          <div className="sidebar-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span>{sidebarViewMode === 'list' ? 'All Conversations' : 'Recent Projects'}</span>
            <div className="view-mode-toggle">
              <button
                type="button"
                className={`view-mode-btn ${sidebarViewMode === 'grouped' ? 'active' : ''}`}
                onClick={() => setSidebarViewMode('grouped')}
                title="Grouped by folder"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect x="1" y="1" width="12" height="3" rx="1" fill="currentColor" opacity="0.5" />
                  <rect x="3" y="5.5" width="10" height="2" rx="0.5" fill="currentColor" />
                  <rect x="3" y="8.5" width="10" height="2" rx="0.5" fill="currentColor" />
                  <rect x="1" y="11.5" width="12" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" />
                </svg>
              </button>
              <button
                type="button"
                className={`view-mode-btn ${sidebarViewMode === 'list' ? 'active' : ''}`}
                onClick={() => setSidebarViewMode('list')}
                title="Flat list"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect x="1" y="1" width="12" height="2" rx="0.5" fill="currentColor" />
                  <rect x="1" y="4.5" width="12" height="2" rx="0.5" fill="currentColor" />
                  <rect x="1" y="8" width="12" height="2" rx="0.5" fill="currentColor" />
                  <rect x="1" y="11.5" width="12" height="2" rx="0.5" fill="currentColor" />
                </svg>
              </button>
            </div>
          </div>
        )}
        {sidebarViewMode === 'list' ? (
          topLevelConversations.map((conv) => (
            <ConversationItem
              key={conv.id}
              conv={conv}
              isActive={conv.id === activeConversationId}
              hasUnseen={hasUnseenMessages(conv.id, conv.messages.length)}
              showFolderBadge
              onSelect={handleSelectConversation}
              onDone={handleDone}
            />
          ))
        ) : (
          <>
            {recentGroups.length > 0 && (
              <div className="sidebar-section">
                {recentGroups.map((group) => {
                  const isCollapsed = collapsedSet.has(group.directory);
                  const dirDisplay = group.directory.replace(/^\/Users\/[^/]+/, '~');
                  const projectColor = getProjectColor(group.directory);

                  return (
                    <div key={group.directory} className="folder-group">
                      <div
                        className="folder-group-header"
                        onClick={() => toggleGalleryCollapsed(group.directory)}
                        style={{ borderLeftColor: projectColor }}
                      >
                        <span className={`folder-chevron ${isCollapsed ? 'collapsed' : ''}`}>
                          &#x25BC;
                        </span>
                        <span className="folder-group-name" title={group.directory}>
                          {dirDisplay}
                        </span>
                        <button
                          type="button"
                          className="folder-group-add-btn"
                          title={`Search in ${dirDisplay}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSearchFilterDir(group.directory);
                            setShowSearch(true);
                          }}
                        >
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="2" />
                            <line
                              x1="11"
                              y1="11"
                              x2="14.5"
                              y2="14.5"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="folder-group-add-btn"
                          title={`New conversation in ${dirDisplay}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDirectory(group.directory);
                            setHasPendingDefault(false);
                            setShowPicker(true);
                          }}
                        >
                          +
                        </button>
                        <span className="folder-group-count">{group.conversations.length}</span>
                      </div>
                      {!isCollapsed &&
                        group.conversations.map((conv) => (
                          <ConversationItem
                            key={conv.id}
                            conv={conv}
                            isActive={conv.id === activeConversationId}
                            hasUnseen={hasUnseenMessages(conv.id, conv.messages.length)}
                            showFolderBadge={false}
                            onSelect={handleSelectConversation}
                            onDone={handleDone}
                          />
                        ))}
                    </div>
                  );
                })}
              </div>
            )}

            {olderConversations.length > 0 && (
              <div className="sidebar-section">
                <div className="sidebar-section-header">Older</div>
                {olderConversations.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conv={conv}
                    isActive={conv.id === activeConversationId}
                    hasUnseen={hasUnseenMessages(conv.id, conv.messages.length)}
                    showFolderBadge
                    onSelect={handleSelectConversation}
                    onDone={handleDone}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Extracted conversation item — avoids duplicating JSX across list/grouped modes.
 * showFolderBadge=false in grouped mode since the folder header already shows the path.
 */
function ConversationItem({
  conv,
  isActive,
  hasUnseen,
  showFolderBadge,
  onSelect,
  onDone,
}: {
  conv: Conversation;
  isActive: boolean;
  hasUnseen: boolean;
  showFolderBadge: boolean;
  onSelect: (id: string) => void;
  onDone: (id: string, e: React.MouseEvent) => void;
}) {
  const workingDirectory = normalizeFolderDirectory(conv.workingDirectory);
  const projectColor = getProjectColor(workingDirectory);
  const dirDisplay = workingDirectory.replace(/^\/Users\/[^/]+/, '~');
  const folderName = workingDirectory.split('/').filter(Boolean).pop() ?? dirDisplay;
  const preview =
    conv.messages.length > 0
      ? conv.messages[conv.messages.length - 1].content.substring(0, 120)
      : 'New conversation';

  const lastTime = getConversationLastActivity(conv);
  const timeAgo = lastTime ? formatTimeAgo(lastTime) : null;
  const timeColor = lastTime ? timeAgoColor(getMinutesElapsed(lastTime)) : undefined;

  return (
    <div
      className={`conversation-item ${isActive ? 'active' : ''}`}
      onClick={() => onSelect(conv.id)}
      style={{ borderLeftColor: projectColor }}
    >
      <div className={`conversation-header ${showFolderBadge ? '' : 'no-badge'}`}>
        {showFolderBadge && (
          <span
            className="folder-badge"
            style={{
              background: `color-mix(in srgb, ${projectColor} 25%, transparent)`,
              color: projectColor,
            }}
            title={dirDisplay}
          >
            {folderName}
          </span>
        )}
        <div className="conversation-header-right">
          {hasUnseen && <span className="new-badge">NEW</span>}
          {timeAgo && (
            <span className="conversation-time-ago" style={{ color: timeColor }}>
              {timeAgo}
            </span>
          )}
          <div className={`status-indicator ${conv.isRunning ? 'running' : ''}`} />
        </div>
      </div>
      <div className="conversation-preview">{preview}</div>
      <button type="button" className="done-btn" onClick={(e) => onDone(conv.id, e)}>
        Done
      </button>
    </div>
  );
}
