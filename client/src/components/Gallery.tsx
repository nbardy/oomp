import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useFolderFilter } from '../hooks/useFolderFilter';
import { FolderFilter } from './FolderFilter';
import type { Conversation } from 'claude-web-view-shared';
import './Gallery.css';

// Viridis color palette - scientific visualization colormap
// Used for visual distinction between conversation cards
const VIRIDIS_COLORS = [
  '#440154', // dark purple
  '#482777', // purple
  '#3e4a89', // blue-purple
  '#31688e', // blue
  '#26828e', // teal
  '#1f9e89', // green-teal
  '#35b779', // green
];

// Get a consistent color index for a conversation ID using simple hash
function getColorIndex(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash) % VIRIDIS_COLORS.length;
}

// Project group interface for grouping conversations by working directory
interface ProjectGroup {
  directory: string;
  conversations: Conversation[];
}

// Number of conversations to show per project before "Show more" button
const CONVERSATIONS_PER_PROJECT = 10;

export function Gallery() {
  const { conversations } = useApp();
  const navigate = useNavigate();

  // Track which projects have "Show more" expanded (showing all conversations)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

  // Track which project sections are collapsed (header click collapses entire section)
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());

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

  // Folder filter hook - now uses pre-sorted conversations
  const { folders, selected, toggle, filtered } = useFolderFilter({
    items: sortedConversations,
    getFolder,
  });

  // Group filtered conversations by working directory
  const projectGroups = useMemo((): ProjectGroup[] => {
    const groups = new Map<string, Conversation[]>();

    // Group by working directory
    for (const conv of filtered) {
      const dir = conv.workingDirectory;
      if (!groups.has(dir)) {
        groups.set(dir, []);
      }
      groups.get(dir)!.push(conv);
    }

    // Convert to array of ProjectGroup objects
    const groupArray: ProjectGroup[] = Array.from(groups.entries()).map(([directory, convs]) => ({
      directory,
      conversations: convs, // Already sorted by createdAt from filtered
    }));

    // Sort groups by most recent conversation in each group (newest first)
    groupArray.sort((a, b) => {
      const aLatest = new Date(a.conversations[0].createdAt).getTime();
      const bLatest = new Date(b.conversations[0].createdAt).getTime();
      return bLatest - aLatest;
    });

    return groupArray;
  }, [filtered]);

  // Toggle "Show more" expanded state for a project
  const toggleExpanded = (dir: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
      }
      return next;
    });
  };

  // Toggle collapsed state for entire project section
  const toggleCollapsed = (dir: string) => {
    setCollapsedProjects(prev => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
      }
      return next;
    });
  };

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
        formatFolder={formatFolder}
      />
      <div className="gallery-content">
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

                      // Get state label
                      const getStateLabel = () => {
                        if (state === 'looping') {
                          return `Looping ${conv.loopConfig?.currentIteration}/${conv.loopConfig?.totalIterations}`;
                        }
                        if (state === 'running') return 'Running';
                        return 'Idle';
                      };

                      // Get viridis accent color based on conversation ID hash
                      const accentColor = VIRIDIS_COLORS[getColorIndex(conv.id)];

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
                              conv.messages.slice(-3).map((msg, i) => (
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
    </div>
  );
}
