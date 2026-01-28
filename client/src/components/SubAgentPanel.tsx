import type { SubAgent } from '@claude-web-view/shared';
import { useState } from 'react';
import './SubAgentPanel.css';

interface SubAgentPanelProps {
  subAgents: SubAgent[];
}

/**
 * SubAgentPanel - Displays active Claude sub-agents (Task tool invocations)
 *
 * Shows a tree-like display of running sub-agents with:
 * - Description of the task
 * - Tool use count and token usage
 * - Current action being performed
 * - Status indicator (spinner for running, checkmark for done)
 *
 * Can be collapsed/expanded using Ctrl+O (matches Claude CLI)
 */
export function SubAgentPanel({ subAgents }: SubAgentPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  // Filter to show only active (running) sub-agents, plus recently completed ones
  const activeAgents = subAgents.filter(
    (a) => a.status === 'running' || a.status === 'pending'
  );
  const recentlyCompleted = subAgents.filter(
    (a) => a.status === 'completed' || a.status === 'error'
  ).slice(-3); // Show last 3 completed

  const displayAgents = [...activeAgents, ...recentlyCompleted];

  // Don't show if no agents
  if (displayAgents.length === 0) {
    return null;
  }

  const runningCount = activeAgents.length;

  const formatTokens = (tokens: number): string => {
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}k`;
    }
    return tokens.toString();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+O to toggle expansion (matches Claude CLI behavior)
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      setIsExpanded(!isExpanded);
    }
  };

  return (
    <div
      className="subagent-panel"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Header - always visible */}
      <div
        className="subagent-header"
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            setIsExpanded(!isExpanded);
          }
        }}
      >
        <span className={`subagent-indicator ${runningCount > 0 ? 'running' : 'done'}`} />
        <span className="subagent-summary">
          {runningCount > 0 ? (
            <>Running {runningCount} Task agent{runningCount !== 1 ? 's' : ''}...</>
          ) : (
            <>Task agents completed</>
          )}
        </span>
        <span className="subagent-shortcut">(ctrl+o to {isExpanded ? 'collapse' : 'expand'})</span>
      </div>

      {/* Tree view - collapsible */}
      {isExpanded && (
        <div className="subagent-tree">
          {displayAgents.map((agent, index) => {
            const isLast = index === displayAgents.length - 1;
            const isRunning = agent.status === 'running' || agent.status === 'pending';

            return (
              <div key={agent.id} className="subagent-item">
                {/* Tree connector */}
                <span className="tree-connector">
                  {isLast ? '\u2514\u2500' : '\u251C\u2500'}
                </span>

                {/* Status indicator */}
                <span className={`subagent-status ${agent.status}`}>
                  {isRunning ? (
                    <span className="status-spinner" />
                  ) : agent.status === 'completed' ? (
                    '\u2713'
                  ) : (
                    '\u2717'
                  )}
                </span>

                {/* Agent info */}
                <div className="subagent-info">
                  <span className="subagent-description">
                    {truncateDescription(agent.description)}
                  </span>
                  <span className="subagent-stats">
                    {agent.toolUses > 0 && (
                      <>
                        <span className="stat-divider">{'\u00B7'}</span>
                        <span className="stat">{agent.toolUses} tool use{agent.toolUses !== 1 ? 's' : ''}</span>
                      </>
                    )}
                    {agent.tokens > 0 && (
                      <>
                        <span className="stat-divider">{'\u00B7'}</span>
                        <span className="stat">{formatTokens(agent.tokens)} tokens</span>
                      </>
                    )}
                  </span>
                </div>

                {/* Current action (shown on second line for running agents) */}
                {agent.currentAction && (
                  <div className="subagent-current-action">
                    <span className="tree-connector-sub">
                      {isLast ? '   ' : '\u2502  '}
                    </span>
                    <span className="action-connector">{'\u2514'}</span>
                    <span className={`current-action ${isRunning ? 'active' : 'done'}`}>
                      {agent.currentAction}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Truncate long descriptions for display
 */
function truncateDescription(description: string, maxLength = 60): string {
  // Remove leading/trailing whitespace and normalize
  const normalized = description.trim().replace(/\s+/g, ' ');

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.substring(0, maxLength - 3)}...`;
}
