import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConversationStore } from '../stores/conversationStore';
import { useUIStore } from '../stores/uiStore';
import { useFolderFilter } from '../hooks/useFolderFilter';
import { useUrlFolderSelection } from '../hooks/useUrlFolderSelection';
import { formatTimeAgo, getLastMessageTime } from '../utils/time';
import { getProjectColor } from '../utils/projectColors';
import { FolderFilter } from './FolderFilter';
import type { Conversation, Message } from '@claude-web-view/shared';
import './Gallery.css';

/**
 * Detect if a working directory is a temporary/ephemeral path.
 * macOS uses /private/var/folders/ for temp directories.
 * These are legitimate sessions but clutter the Gallery.
 */
function isTempDirectory(workingDirectory: string): boolean {
  return (
    workingDirectory.includes('/private/var/folders/') ||
    workingDirectory.includes('/var/folders/') ||
    workingDirectory.includes('/tmp/') ||
    workingDirectory.includes('/temp/')
  );
}

// Project group interface for grouping conversations by working directory
interface ProjectGroup {
  directory: string;
  conversations: Conversation[];
}

// Number of conversations to show per project before "Show more" button
const CONVERSATIONS_PER_PROJECT = 10;

export function Gallery() {
  const conversations = useConversationStore((s) => s.conversations);
  const navigate = useNavigate();

  // Tick every 30s to keep time-ago displays current
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Persisted Gallery UI state via uiStore (Zustand + persist middleware)
  const galleryExpandedProjects = useUIStore((s) => s.galleryExpandedProjects);
  const galleryCollapsedProjects = useUIStore((s) => s.galleryCollapsedProjects);
  const showTempSessions = useUIStore((s) => s.showTempSessions);
  const setShowTempSessions = useUIStore((s) => s.setShowTempSessions);
  const toggleExpanded = useUIStore((s) => s.toggleGalleryExpanded);
  const toggleCollapsed = useUIStore((s) => s.toggleGalleryCollapsed);
  const showDoneConversations = useUIStore((s) => s.showDoneConversations);
  const setShowDoneConversations = useUIStore((s) => s.setShowDoneConversations);
  const doneConversations = useUIStore((s) => s.doneConversations);
  const unmarkDone = useUIStore((s) => s.unmarkDone);

  // Derived Sets for O(1) lookup
  const expandedProjects = useMemo(() => new Set(galleryExpandedProjects), [galleryExpandedProjects]);
  const collapsedProjects = useMemo(() => new Set(galleryCollapsedProjects), [galleryCollapsedProjects]);
  const doneSet = useMemo(() => new Set(doneConversations), [doneConversations]);

  // Convert Map to array and sort by createdAt (newest first)
  const sortedConversations = useMemo(() => {
    return Array.from(conversations.values()).sort((a, b) => {
      const dateA = new Date(a.createdAt).getTime();
      const dateB = new Date(b.createdAt).getTime();
      return dateB - dateA; // Descending order (newest first)
    });
  }, [conversations]);

  // Get folder from conversation
  const getFolder = useCallback((conv: { workingDirectory: string }) => conv.workingDirectory, []);

  // Format folder for display (shorten home directory)
  const formatFolder = useCallback((folder: string) => {
    return folder.replace(/^\/Users\/[^/]+/, '~');
  }, []);

  // Folder selection state lives in URL query params (?folders=...)
  const [selectedFolders, setSelectedFolders] = useUrlFolderSelection();

  // Folder filter hook — pure computation, caller owns state
  const { folders: allFolders, selected, toggle, clear, filtered } = useFolderFilter({
    items: sortedConversations,
    getFolder,
    selected: selectedFolders,
    setSelected: setSelectedFolders,
  });

  // Filter temp directories and sort folders by most recent conversation (not alphabetical)
  const folders = useMemo(() => {
    const nonTemp = allFolders.filter(folder => !isTempDirectory(folder));

    // Build a map of folder -> most recent conversation date
    const folderRecency = new Map<string, number>();
    for (const conv of sortedConversations) {
      const dir = conv.workingDirectory;
      if (!folderRecency.has(dir)) {
        // First encounter is the newest since sortedConversations is newest-first
        folderRecency.set(dir, new Date(conv.createdAt).getTime());
      }
    }

    // Sort by most recent conversation descending
    return nonTemp.sort((a, b) => {
      const aTime = folderRecency.get(a) ?? 0;
      const bTime = folderRecency.get(b) ?? 0;
      return bTime - aTime;
    });
  }, [allFolders, sortedConversations]);

  // Group filtered conversations by working directory, separating temp/done from real
  const { projectGroups, tempGroups, tempSessionCount, doneGroups, doneSessionCount } = useMemo(() => {
    const realGroups = new Map<string, Conversation[]>();
    const tempGroupsMap = new Map<string, Conversation[]>();
    const doneGroupsMap = new Map<string, Conversation[]>();

    // Group by working directory, separating done → temp → real
    for (const conv of filtered) {
      const dir = conv.workingDirectory;
      if (doneSet.has(conv.id)) {
        if (!doneGroupsMap.has(dir)) doneGroupsMap.set(dir, []);
        doneGroupsMap.get(dir)!.push(conv);
      } else if (isTempDirectory(dir)) {
        if (!tempGroupsMap.has(dir)) tempGroupsMap.set(dir, []);
        tempGroupsMap.get(dir)!.push(conv);
      } else {
        if (!realGroups.has(dir)) realGroups.set(dir, []);
        realGroups.get(dir)!.push(conv);
      }
    }

    // Convert to array of ProjectGroup objects
    const toGroupArray = (groups: Map<string, Conversation[]>): ProjectGroup[] => {
      const groupArray: ProjectGroup[] = Array.from(groups.entries()).map(([directory, convs]) => ({
        directory,
        conversations: convs,
      }));

      // Sort groups by most recent conversation in each group (newest first)
      groupArray.sort((a, b) => {
        const aLatest = new Date(a.conversations[0].createdAt).getTime();
        const bLatest = new Date(b.conversations[0].createdAt).getTime();
        return bLatest - aLatest;
      });

      return groupArray;
    };

    // Count total temp sessions
    let tempCount = 0;
    for (const convs of tempGroupsMap.values()) {
      tempCount += convs.length;
    }

    // Count total done sessions
    let doneCount = 0;
    for (const convs of doneGroupsMap.values()) {
      doneCount += convs.length;
    }

    return {
      projectGroups: toGroupArray(realGroups),
      tempGroups: toGroupArray(tempGroupsMap),
      tempSessionCount: tempCount,
      doneGroups: toGroupArray(doneGroupsMap),
      doneSessionCount: doneCount,
    };
  }, [filtered, doneSet]);

  if (conversations.size === 0) {
    return (
      <div className="gallery-view">
        <div className="empty-state">
          No conversations yet. Click "+ New Conversation" to start.
        </div>
      </div>
    );
  }

  return (
    <div className="gallery-view">
      <FolderFilter
        folders={folders}
        selected={selected}
        onToggle={toggle}
        onClear={clear}
        formatFolder={formatFolder}
        conversations={sortedConversations}
        onSelectConversation={(id) => navigate(`/chat/${id}`)}
      />
      <div className="gallery-content">
        {/* Regular project groups */}
        {projectGroups.map((group) => {
          const isCollapsed = collapsedProjects.has(group.directory);
          const isExpanded = expandedProjects.has(group.directory);
          const dirDisplay = formatFolder(group.directory);
          const totalCount = group.conversations.length;
          const hiddenCount = totalCount - CONVERSATIONS_PER_PROJECT;
          const showMoreButton = totalCount > CONVERSATIONS_PER_PROJECT && !isExpanded;
          const visibleConversations = isExpanded
            ? group.conversations
            : group.conversations.slice(0, CONVERSATIONS_PER_PROJECT);

          return (
            <div key={group.directory} className="project-section">
              <div
                className="project-header"
                onClick={() => toggleCollapsed(group.directory)}
              >
                <div className="project-header-left">
                  <span className={`project-chevron ${isCollapsed ? 'collapsed' : ''}`}>
                    &#9660;
                  </span>
                  <span className="project-path">{dirDisplay}</span>
                </div>
                <span className="project-count">
                  {totalCount} conversation{totalCount !== 1 ? 's' : ''}
                </span>
              </div>

              {!isCollapsed && (
                <>
                  <div className="project-grid">
                    {visibleConversations.map((conv) => {
                      // Determine conversation state
                      const getState = () => {
                        if (conv.loopConfig?.isLooping) return 'looping';
                        if (conv.isRunning) return 'running';
                        return 'idle';
                      };
                      const state = getState();

                      // Get state label with time-ago for idle conversations
                      const getStateLabel = () => {
                        if (state === 'looping') {
                          return `Looping ${conv.loopConfig?.currentIteration}/${conv.loopConfig?.totalIterations}`;
                        }
                        if (state === 'running') return 'Running';
                        const lastTime = getLastMessageTime(conv.messages);
                        return lastTime ? `Idle · ${formatTimeAgo(lastTime)}` : 'Idle';
                      };

                      // Get viridis accent color based on project directory
                      const accentColor = getProjectColor(conv.workingDirectory);

                      return (
                        <div
                          key={conv.id}
                          className="gallery-card"
                          onClick={() => navigate(`/chat/${conv.id}`)}
                          style={{ borderTopColor: accentColor }}
                        >
                          <div className="gallery-card-header">
                            <div className="gallery-card-id">
                              {conv.id.substring(0, 8)}
                              <span className={`provider-badge provider-${conv.provider || 'claude'}`}>
                                {conv.provider || 'claude'}
                              </span>
                            </div>
                            <div className="gallery-card-status">
                              <div className={`state-badge state-${state}`}>
                                <div className="state-indicator" />
                                <span className="state-label">{getStateLabel()}</span>
                              </div>
                            </div>
                          </div>
                          <div>{conv.messages.length} messages</div>
                          <div className="gallery-messages">
                            {conv.messages.length === 0 ? (
                              <div className="empty-state">No messages yet</div>
                            ) : (
                              conv.messages.slice(-3).map((msg: Message, i: number) => (
                                <div key={i} className={`gallery-message ${msg.role}`}>
                                  <strong>{msg.role}:</strong> {msg.content.substring(0, 100)}
                                  {msg.content.length > 100 ? '...' : ''}
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {showMoreButton && (
                    <button
                      className="show-more-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(group.directory);
                      }}
                    >
                      Show more... ({hiddenCount} hidden)
                    </button>
                  )}

                  {isExpanded && totalCount > CONVERSATIONS_PER_PROJECT && (
                    <button
                      className="show-more-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(group.directory);
                      }}
                    >
                      Show less
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}

        {/* Temp sessions toggle and groups */}
        {tempSessionCount > 0 && (
          <div className="temp-sessions-section">
            <button
              className="temp-sessions-toggle"
              onClick={() => setShowTempSessions(!showTempSessions)}
            >
              <span className={`project-chevron ${!showTempSessions ? 'collapsed' : ''}`}>
                &#9660;
              </span>
              {showTempSessions ? 'Hide' : 'Show'} {tempSessionCount} temporary session{tempSessionCount !== 1 ? 's' : ''}
              <span className="temp-sessions-hint">
                (sessions from /tmp, /var/folders, etc.)
              </span>
            </button>

            {showTempSessions && tempGroups.map((group) => {
              const isCollapsed = collapsedProjects.has(group.directory);
              const isExpanded = expandedProjects.has(group.directory);
              // Shorten temp directory display
              const dirDisplay = group.directory.includes('/T/tmp')
                ? `[Temp] ${group.directory.match(/tmp[A-Za-z0-9_-]*/)?.[0] || 'session'}`
                : formatFolder(group.directory);
              const totalCount = group.conversations.length;
              const hiddenCount = totalCount - CONVERSATIONS_PER_PROJECT;
              const showMoreButton = totalCount > CONVERSATIONS_PER_PROJECT && !isExpanded;
              const visibleConversations = isExpanded
                ? group.conversations
                : group.conversations.slice(0, CONVERSATIONS_PER_PROJECT);

              return (
                <div key={group.directory} className="project-section temp-project">
                  <div
                    className="project-header"
                    onClick={() => toggleCollapsed(group.directory)}
                  >
                    <div className="project-header-left">
                      <span className={`project-chevron ${isCollapsed ? 'collapsed' : ''}`}>
                        &#9660;
                      </span>
                      <span className="project-path">{dirDisplay}</span>
                    </div>
                    <span className="project-count">
                      {totalCount} conversation{totalCount !== 1 ? 's' : ''}
                    </span>
                  </div>

                  {!isCollapsed && (
                    <>
                      <div className="project-grid">
                        {visibleConversations.map((conv) => {
                          const getState = () => {
                            if (conv.loopConfig?.isLooping) return 'looping';
                            if (conv.isRunning) return 'running';
                            return 'idle';
                          };
                          const state = getState();
                          const getStateLabel = () => {
                            if (state === 'looping') {
                              return `Looping ${conv.loopConfig?.currentIteration}/${conv.loopConfig?.totalIterations}`;
                            }
                            if (state === 'running') return 'Running';
                            const lastTime = getLastMessageTime(conv.messages);
                            return lastTime ? `Idle · ${formatTimeAgo(lastTime)}` : 'Idle';
                          };
                          const accentColor = getProjectColor(conv.workingDirectory);

                          return (
                            <div
                              key={conv.id}
                              className="gallery-card"
                              onClick={() => navigate(`/chat/${conv.id}`)}
                              style={{ borderTopColor: accentColor }}
                            >
                              <div className="gallery-card-header">
                                <div className="gallery-card-id">
                                  {conv.id.substring(0, 8)}
                                  <span className={`provider-badge provider-${conv.provider || 'claude'}`}>
                                    {conv.provider || 'claude'}
                                  </span>
                                </div>
                                <div className="gallery-card-status">
                                  <div className={`state-badge state-${state}`}>
                                    <div className="state-indicator" />
                                    <span className="state-label">{getStateLabel()}</span>
                                  </div>
                                </div>
                              </div>
                              <div>{conv.messages.length} messages</div>
                              <div className="gallery-messages">
                                {conv.messages.length === 0 ? (
                                  <div className="empty-state">No messages yet</div>
                                ) : (
                                  conv.messages.slice(-3).map((msg: Message, i: number) => (
                                    <div key={i} className={`gallery-message ${msg.role}`}>
                                      <strong>{msg.role}:</strong> {msg.content.substring(0, 100)}
                                      {msg.content.length > 100 ? '...' : ''}
                                    </div>
                                  ))
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {showMoreButton && (
                        <button
                          className="show-more-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpanded(group.directory);
                          }}
                        >
                          Show more... ({hiddenCount} hidden)
                        </button>
                      )}

                      {isExpanded && totalCount > CONVERSATIONS_PER_PROJECT && (
                        <button
                          className="show-more-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpanded(group.directory);
                          }}
                        >
                          Show less
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Done conversations toggle and groups */}
        {doneSessionCount > 0 && (
          <div className="done-sessions-section">
            <button
              className="done-sessions-toggle"
              onClick={() => setShowDoneConversations(!showDoneConversations)}
            >
              <span className={`project-chevron ${!showDoneConversations ? 'collapsed' : ''}`}>
                &#9660;
              </span>
              {showDoneConversations ? 'Hide' : 'Show'} {doneSessionCount} done conversation{doneSessionCount !== 1 ? 's' : ''}
            </button>

            {showDoneConversations && doneGroups.map((group) => {
              const isCollapsed = collapsedProjects.has(group.directory);
              const isExpanded = expandedProjects.has(group.directory);
              const dirDisplay = formatFolder(group.directory);
              const totalCount = group.conversations.length;
              const hiddenCount = totalCount - CONVERSATIONS_PER_PROJECT;
              const showMoreButton = totalCount > CONVERSATIONS_PER_PROJECT && !isExpanded;
              const visibleConversations = isExpanded
                ? group.conversations
                : group.conversations.slice(0, CONVERSATIONS_PER_PROJECT);

              return (
                <div key={group.directory} className="project-section done-project">
                  <div
                    className="project-header"
                    onClick={() => toggleCollapsed(group.directory)}
                  >
                    <div className="project-header-left">
                      <span className={`project-chevron ${isCollapsed ? 'collapsed' : ''}`}>
                        &#9660;
                      </span>
                      <span className="project-path">{dirDisplay}</span>
                    </div>
                    <span className="project-count">
                      {totalCount} conversation{totalCount !== 1 ? 's' : ''}
                    </span>
                  </div>

                  {!isCollapsed && (
                    <>
                      <div className="project-grid">
                        {visibleConversations.map((conv) => {
                          const getState = () => {
                            if (conv.loopConfig?.isLooping) return 'looping';
                            if (conv.isRunning) return 'running';
                            return 'idle';
                          };
                          const state = getState();
                          const getStateLabel = () => {
                            if (state === 'looping') {
                              return `Looping ${conv.loopConfig?.currentIteration}/${conv.loopConfig?.totalIterations}`;
                            }
                            if (state === 'running') return 'Running';
                            const lastTime = getLastMessageTime(conv.messages);
                            return lastTime ? `Idle · ${formatTimeAgo(lastTime)}` : 'Idle';
                          };
                          const accentColor = getProjectColor(conv.workingDirectory);

                          return (
                            <div
                              key={conv.id}
                              className="gallery-card done-card"
                              onClick={() => navigate(`/chat/${conv.id}`)}
                              style={{ borderTopColor: accentColor }}
                            >
                              <div className="gallery-card-header">
                                <div className="gallery-card-id">
                                  {conv.id.substring(0, 8)}
                                  <span className={`provider-badge provider-${conv.provider || 'claude'}`}>
                                    {conv.provider || 'claude'}
                                  </span>
                                </div>
                                <div className="gallery-card-status">
                                  <button
                                    className="undo-done-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      unmarkDone(conv.id);
                                    }}
                                  >
                                    Restore
                                  </button>
                                  <div className={`state-badge state-${state}`}>
                                    <div className="state-indicator" />
                                    <span className="state-label">{getStateLabel()}</span>
                                  </div>
                                </div>
                              </div>
                              <div>{conv.messages.length} messages</div>
                              <div className="gallery-messages">
                                {conv.messages.length === 0 ? (
                                  <div className="empty-state">No messages yet</div>
                                ) : (
                                  conv.messages.slice(-3).map((msg: Message, i: number) => (
                                    <div key={i} className={`gallery-message ${msg.role}`}>
                                      <strong>{msg.role}:</strong> {msg.content.substring(0, 100)}
                                      {msg.content.length > 100 ? '...' : ''}
                                    </div>
                                  ))
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {showMoreButton && (
                        <button
                          className="show-more-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpanded(group.directory);
                          }}
                        >
                          Show more... ({hiddenCount} hidden)
                        </button>
                      )}

                      {isExpanded && totalCount > CONVERSATIONS_PER_PROJECT && (
                        <button
                          className="show-more-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpanded(group.directory);
                          }}
                        >
                          Show less
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
