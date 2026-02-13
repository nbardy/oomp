import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Conversation, Message } from '@claude-web-view/shared';
import { useConversationStore } from '../stores/conversationStore';
import { useUIStore } from '../stores/uiStore';
import { getProjectRoot, getProjectName } from '../utils/swarmUtils';
import { formatTimeAgo, getLastMessageTime } from '../utils/time';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import type { MessageGroup } from './VirtualizedMessageList';
import './SwarmDetail.css';

// =============================================================================
// Types for server API responses
// =============================================================================

interface GitLogEntry {
  hash: string;
  message: string;
  date: string;
  author: string;
}

interface OompaWorkerConfig {
  model: string;
  prompt?: string | string[];
  iterations?: number;
  count?: number;
  can_plan?: boolean;
}

interface OompaConfig {
  workers: OompaWorkerConfig[];
  reviewer?: { model: string; prompt?: string | string[] };
  _source?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Shorten model names for badge display: "claude-sonnet-4-5-20250929" → "sonnet-4.5" */
function shortModelName(modelName: string | null | undefined): string | null {
  if (!modelName) return null;
  // Claude models: claude-{variant}-{major}-{minor}-{date}
  const claudeMatch = modelName.match(/claude-(\w+)-(\d+)-(\d+)/);
  if (claudeMatch) return `${claudeMatch[1]}-${claudeMatch[2]}.${claudeMatch[3]}`;
  // Codex models: gpt-{variant}
  if (modelName.includes('codex') || modelName.includes('gpt')) {
    const parts = modelName.split('-');
    return parts.slice(0, 3).join('-');
  }
  return modelName.length > 20 ? modelName.substring(0, 20) : modelName;
}

const ROLE_LABELS: Record<string, string> = {
  work: 'exec',
  review: 'review',
  fix: 'fix',
};

/** Extract verdict from a review conversation's assistant messages */
function extractVerdict(conv: Conversation): 'approved' | 'needs-changes' | 'rejected' | 'pending' {
  for (const msg of conv.messages) {
    if (msg.role !== 'assistant') continue;
    if (msg.content.includes('VERDICT: APPROVED')) return 'approved';
    if (msg.content.includes('VERDICT: NEEDS_CHANGES')) return 'needs-changes';
    if (msg.content.includes('VERDICT: REJECTED')) return 'rejected';
  }
  return conv.isRunning ? 'pending' : 'pending';
}

type SwarmTab = 'workers' | 'runs';

// =============================================================================
// ExecGroup: An exec worker paired with its temporally-adjacent reviews/fixes.
// Within the same swarmId, reviews/fixes are matched to the exec worker whose
// last message timestamp is closest before the review/fix was created.
// =============================================================================

interface ExecGroup {
  exec: Conversation;
  reviews: Conversation[];  // review + fix sessions matched to this exec, newest first
}

// =============================================================================
// Types for swarm run persistence data (from oompa agentnet.runs)
// =============================================================================

interface SwarmRunWorker {
  id: string;
  harness: string;
  model: string;
  status: string;
  completed: number;
  iterations: number;
  merges: number;
  rejections: number;
  errors: number;
  'review-rounds-total': number;
}

interface SwarmRunSummary {
  'swarm-id': string;
  'finished-at': string;
  'total-workers': number;
  'total-completed': number;
  'total-iterations': number;
  'status-counts': Record<string, number>;
  workers: SwarmRunWorker[];
}

interface SwarmRunLog {
  'swarm-id': string;
  'started-at': string;
  'config-file': string;
  workers: Array<{
    id: string;
    harness: string;
    model: string;
    iterations: number;
  }>;
}

interface SwarmReviewLog {
  'worker-id': string;
  iteration: number;
  round: number;
  verdict: string;
  timestamp: string;
  output: string;
  'diff-files': string[];
}

interface SwarmRun {
  swarmId: string;
  run: SwarmRunLog | null;
  summary: SwarmRunSummary | null;
}

// =============================================================================
// WorkerChatPane — renders one worker's messages in a mini Chat view
// =============================================================================

const EMPTY_COLLAPSED = new Set<number>();
const NO_OP_TOGGLE = () => {};
const NO_OP_SCROLL = () => {};

function WorkerChatPane({
  conversationId,
  label,
  accentColor,
}: {
  conversationId: string | null;
  label: string;
  accentColor: 'cyan' | 'magenta';
}) {
  const conversation = useConversationStore((s) =>
    conversationId ? s.conversations.get(conversationId) ?? null : null,
  );
  const isStreaming = conversation?.isStreaming ?? false;

  // ALL hooks before any early return (React hook ordering rule)
  const messageGroups = useMemo((): MessageGroup[] => {
    if (!conversation) return [];
    return conversation.messages.map((msg: Message) => ({
      type: 'single' as const,
      messages: [msg],
    }));
  }, [conversation]);

  const lastMessageRef = useRef<HTMLDivElement>(null);
  const scrollToBottomRef = useRef<(() => void) | null>(null);
  const markMessagesSeen = useUIStore((s) => s.markMessagesSeen);
  const workingDirectory = conversation?.workingDirectory ?? '';

  if (!conversationId || !conversation) {
    return (
      <div className="worker-chat-pane empty">
        <div className="empty-state">No {label.toLowerCase()} log</div>
      </div>
    );
  }

  const role = conversation.workerRole ?? 'work';
  const model = shortModelName(conversation.modelName);

  return (
    <div className="worker-chat-pane">
      <div className={`worker-pane-header pane-${accentColor}`}>
        <span className={`pane-label ${accentColor}`}>{label}</span>
        <span className="worker-pane-id">{conversationId.substring(0, 8)}</span>
        <span className={`role-badge role-${role}`}>{ROLE_LABELS[role]}</span>
        {model && (
          <span className={`worker-pane-provider provider-${conversation.provider || 'claude'}`}>
            {model}
          </span>
        )}
        <div className={`state-badge state-${conversation.isRunning ? 'running' : 'idle'}`}>
          <div className="state-indicator" />
          <span className="state-label">{conversation.isRunning ? 'Running' : 'Idle'}</span>
        </div>
      </div>
      <div className="worker-pane-messages">
        <VirtualizedMessageList
          messageGroups={messageGroups}
          collapsedIterations={EMPTY_COLLAPSED}
          toggleIterationCollapse={NO_OP_TOGGLE}
          isRunning={isStreaming}
          lastMessageRef={lastMessageRef}
          onScrollStateChange={NO_OP_SCROLL}
          conversationId={conversationId}
          markMessagesSeen={markMessagesSeen}
          totalMessageCount={conversation.messages.length}
          scrollToBottomRef={scrollToBottomRef}
          workingDirectory={workingDirectory}
        />
      </div>
    </div>
  );
}

// =============================================================================
// GitLogPanel — fetches and displays recent commits for a project
// =============================================================================

function GitLogPanel({ projectRoot }: { projectRoot: string }) {
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/git-log?dir=${encodeURIComponent(projectRoot)}`)
      .then((res) => res.json())
      .then((data: GitLogEntry[]) => {
        setCommits(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [projectRoot]);

  return (
    <div className="swarm-bottom-panel">
      <div className="swarm-panel-header">Recent Commits</div>
      <div className="swarm-panel-content">
        {loading && <div className="panel-loading">Loading commits...</div>}
        {!loading && commits.length === 0 && <div className="panel-empty">No commits found</div>}
        {commits.map((c) => (
          <div key={c.hash} className="git-log-entry">
            <code className="git-hash">{c.hash.substring(0, 7)}</code>
            <span className="git-message">{c.message}</span>
            <span className="git-author">{c.author}</span>
            <span className="git-date">{formatTimeAgo(new Date(c.date))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// OompaConfigPanel — reads and displays the oompa.json config for a project
// =============================================================================

function OompaConfigPanel({ projectRoot }: { projectRoot: string }) {
  const [config, setConfig] = useState<OompaConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedPrompts, setExpandedPrompts] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    fetch(`/api/oompa-config?dir=${encodeURIComponent(projectRoot)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: OompaConfig) => setConfig(data))
      .catch((e: Error) => setError(e.message));
  }, [projectRoot]);

  const togglePrompt = useCallback((promptPath: string) => {
    setExpandedPrompts((prev) => {
      const next = new Map(prev);
      if (next.has(promptPath)) {
        next.delete(promptPath);
        return next;
      }
      const absolutePath = promptPath.startsWith('/')
        ? promptPath
        : `${projectRoot}/${promptPath}`;
      fetch(`/api/read-file?path=${encodeURIComponent(absolutePath)}`)
        .then((res) => res.json())
        .then((data: { content: string }) => {
          setExpandedPrompts((p) => new Map(p).set(promptPath, data.content));
        })
        .catch(() => {
          setExpandedPrompts((p) => new Map(p).set(promptPath, '(failed to load)'));
        });
      next.set(promptPath, 'Loading...');
      return next;
    });
  }, [projectRoot]);

  return (
    <div className="swarm-bottom-panel">
      <div className="swarm-panel-header">Swarm Config</div>
      <div className="swarm-panel-content">
        {error && <div className="panel-error">No oompa config found</div>}
        {!config && !error && <div className="panel-loading">Loading config...</div>}
        {config && (
          <div className="config-summary">
            {config.workers.map((w, i) => {
              const prompts = Array.isArray(w.prompt) ? w.prompt : w.prompt ? [w.prompt] : [];
              return (
                <div key={i}>
                  <div className="config-worker-row">
                    <span className="config-model-badge">{w.model}</span>
                    <span className="config-count">
                      x{w.count ?? 1} &middot; {w.iterations ?? '?'} iterations
                      {w.can_plan === false && ' (executor)'}
                    </span>
                  </div>
                  {prompts.map((p, pIdx) => (
                    <div key={`${i}-${pIdx}`}>
                      <span className="config-prompt-path" onClick={() => togglePrompt(p)}>
                        {expandedPrompts.has(p) ? '▼' : '▶'} {p}
                      </span>
                      {expandedPrompts.has(p) && (
                        <div className="config-prompt-content">{expandedPrompts.get(p)}</div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
            {config.reviewer && (
              <div className="config-worker-row">
                <span className="config-model-badge">{config.reviewer.model}</span>
                <span className="config-count">reviewer</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// SwarmRunsPanel — shows structured run history from runs/{swarm-id}/ files
// =============================================================================

function SwarmRunsPanel({ projectRoot }: { projectRoot: string }) {
  const [runs, setRuns] = useState<SwarmRun[]>([]);
  const [reviews, setReviews] = useState<SwarmReviewLog[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [expandedReview, setExpandedReview] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/swarm-runs?dir=${encodeURIComponent(projectRoot)}`)
      .then((res) => res.json())
      .then((data: { runs: SwarmRun[] }) => {
        setRuns(data.runs);
        if (data.runs.length > 0) {
          setSelectedRunId(data.runs[0].swarmId);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [projectRoot]);

  // Fetch reviews when a run is selected
  useEffect(() => {
    if (!selectedRunId) return;
    fetch(`/api/swarm-reviews?dir=${encodeURIComponent(projectRoot)}&swarmId=${encodeURIComponent(selectedRunId)}`)
      .then((res) => res.json())
      .then((data: { reviews: SwarmReviewLog[] }) => setReviews(data.reviews))
      .catch(() => setReviews([]));
  }, [projectRoot, selectedRunId]);

  if (loading) return <div className="empty-state">Loading run history...</div>;
  if (runs.length === 0) return <div className="empty-state">No runs recorded yet</div>;

  const selectedRun = runs.find((r) => r.swarmId === selectedRunId);
  const summary = selectedRun?.summary;
  const runLog = selectedRun?.run;

  return (
    <div className="swarm-runs-panel">
      {/* Run selector */}
      <div className="runs-selector">
        {runs.map((r) => (
          <button
            key={r.swarmId}
            className={`run-selector-btn ${r.swarmId === selectedRunId ? 'active' : ''}`}
            onClick={() => setSelectedRunId(r.swarmId)}
          >
            <span className="run-id">{r.swarmId}</span>
            {r.run && (
              <span className="run-time">{new Date(r.run['started-at']).toLocaleDateString()}</span>
            )}
            {r.summary && (
              <span className={`run-status-badge ${r.summary['total-completed'] > 0 ? 'has-completions' : ''}`}>
                {r.summary['total-completed']}/{r.summary['total-iterations']}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Selected run details */}
      {summary && (
        <div className="run-summary">
          <div className="run-summary-header">
            <h4>Summary</h4>
            {runLog && <span className="run-started">Started {new Date(runLog['started-at']).toLocaleString()}</span>}
            {summary['finished-at'] && (
              <span className="run-finished">Finished {new Date(summary['finished-at']).toLocaleString()}</span>
            )}
          </div>
          <div className="run-summary-stats">
            <div className="run-stat">
              <span className="run-stat-value">{summary['total-completed']}</span>
              <span className="run-stat-label">Completed</span>
            </div>
            <div className="run-stat">
              <span className="run-stat-value">{summary['total-iterations']}</span>
              <span className="run-stat-label">Total Iters</span>
            </div>
            <div className="run-stat">
              <span className="run-stat-value">{summary.workers.reduce((s, w) => s + w.merges, 0)}</span>
              <span className="run-stat-label">Merges</span>
            </div>
            <div className="run-stat">
              <span className="run-stat-value">{summary.workers.reduce((s, w) => s + w.rejections, 0)}</span>
              <span className="run-stat-label">Rejections</span>
            </div>
            <div className="run-stat">
              <span className="run-stat-value">{summary.workers.reduce((s, w) => s + w.errors, 0)}</span>
              <span className="run-stat-label">Errors</span>
            </div>
          </div>

          {/* Per-worker table */}
          <table className="run-workers-table">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Harness</th>
                <th>Status</th>
                <th>Done</th>
                <th>Merges</th>
                <th>Rej</th>
                <th>Err</th>
                <th>Reviews</th>
              </tr>
            </thead>
            <tbody>
              {summary.workers.map((w) => (
                <tr key={w.id}>
                  <td className="worker-id-cell">{w.id}</td>
                  <td>{w.harness}:{w.model ?? 'default'}</td>
                  <td><span className={`worker-status-badge status-${w.status}`}>{w.status}</span></td>
                  <td>{w.completed}/{w.iterations}</td>
                  <td>{w.merges}</td>
                  <td>{w.rejections}</td>
                  <td>{w.errors}</td>
                  <td>{w['review-rounds-total']}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Review logs */}
      {reviews.length > 0 && (
        <div className="run-reviews">
          <h4>Review Log ({reviews.length} reviews)</h4>
          <div className="run-reviews-list">
            {reviews.map((r, i) => {
              const key = `${r['worker-id']}-i${r.iteration}-r${r.round}`;
              const isExpanded = expandedReview === key;
              return (
                <div key={i} className="run-review-entry">
                  <div
                    className="run-review-header"
                    onClick={() => setExpandedReview(isExpanded ? null : key)}
                  >
                    <span className="run-review-worker">{r['worker-id']}</span>
                    <span className="run-review-iter">i{r.iteration} r{r.round}</span>
                    <span className={`verdict-badge verdict-${r.verdict}`}>
                      {r.verdict.toUpperCase().replace('-', ' ')}
                    </span>
                    <span className="run-review-files">
                      {r['diff-files']?.length ?? 0} files
                    </span>
                    <span className="run-review-time">
                      {new Date(r.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="expand-indicator">{isExpanded ? '\u25BC' : '\u25B6'}</span>
                  </div>
                  {isExpanded && (
                    <div className="run-review-output">
                      <pre>{r.output}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// SwarmDetail — main component for the /workers/detail?project=<path> route
// =============================================================================

export function SwarmDetail() {
  const [searchParams] = useSearchParams();
  const projectRoot = searchParams.get('project') ?? '';
  const navigate = useNavigate();

  const conversations = useConversationStore((s) => s.conversations);
  const promotedWorkers = useUIStore((s) => s.promotedWorkers);
  const promotedSet = useMemo(() => new Set(promotedWorkers), [promotedWorkers]);

  // Tick every 30s for time-ago
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Tab state
  const [activeTab, setActiveTab] = useState<SwarmTab>('workers');

  // Filter workers belonging to this project, build exec groups with paired reviews/fixes.
  // Reviews/fixes are matched to exec workers by time proximity within the same swarmId.
  const { execGroups, allWorkers, workCount, reviewCount, fixCount } = useMemo(() => {
    const execs: Conversation[] = [];
    const reviewsAndFixes: Conversation[] = [];

    for (const conv of conversations.values()) {
      if (!conv.isWorker || promotedSet.has(conv.id)) continue;
      if (getProjectRoot(conv.workingDirectory) !== projectRoot) continue;

      if (conv.workerRole === 'review' || conv.workerRole === 'fix') {
        reviewsAndFixes.push(conv);
      } else {
        execs.push(conv);
      }
    }

    // Sort execs: running first, then by most recent activity
    const sortByActivity = (a: Conversation, b: Conversation) => {
      if (a.isRunning && !b.isRunning) return -1;
      if (!a.isRunning && b.isRunning) return 1;
      const aTime = getLastMessageTime(a.messages)?.getTime() ?? 0;
      const bTime = getLastMessageTime(b.messages)?.getTime() ?? 0;
      return bTime - aTime;
    };
    execs.sort(sortByActivity);

    // Pair reviews/fixes to exec workers by time: assign each review/fix to the exec
    // (within the same swarmId) whose last message is closest before the review/fix was created.
    const groups: ExecGroup[] = execs.map((exec) => ({ exec, reviews: [] }));
    for (const rf of reviewsAndFixes) {
      const rfCreated = new Date(rf.createdAt).getTime();
      let bestGroup: ExecGroup | null = null;
      let bestDelta = Infinity;
      for (const g of groups) {
        // Must share swarmId (or both null)
        if (g.exec.swarmId !== rf.swarmId) continue;
        const execTime = getLastMessageTime(g.exec.messages)?.getTime() ?? new Date(g.exec.createdAt).getTime();
        const delta = Math.abs(rfCreated - execTime);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestGroup = g;
        }
      }
      if (bestGroup) {
        bestGroup.reviews.push(rf);
      }
      // Orphan reviews (no matching exec) are dropped — they'd only appear if exec was promoted
    }

    // Sort reviews within each group: newest first
    for (const g of groups) {
      g.reviews.sort(sortByActivity);
    }

    const all = [...execs, ...reviewsAndFixes];

    return {
      execGroups: groups,
      allWorkers: all,
      workCount: execs.length,
      reviewCount: reviewsAndFixes.filter((r) => r.workerRole === 'review').length,
      fixCount: reviewsAndFixes.filter((r) => r.workerRole === 'fix').length,
    };
  }, [conversations, promotedSet, projectRoot]);

  // Selected exec group — click a worker to show task log (left) + review (right)
  const [selectedGroupIdx, setSelectedGroupIdx] = useState<number>(0);

  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || execGroups.length === 0) return;
    didInit.current = true;
    // Prefer running exec for initial selection
    const runningIdx = execGroups.findIndex((g) => g.exec.isRunning);
    if (runningIdx >= 0) setSelectedGroupIdx(runningIdx);
  }, [execGroups]);

  // Derive pane IDs from selected group
  const selectedGroup = execGroups[selectedGroupIdx] ?? null;
  const taskPaneId = selectedGroup?.exec.id ?? null;
  // Show the most recent review for this exec group
  const reviewPaneId = selectedGroup?.reviews[0]?.id ?? null;

  // Computed stats
  const runningCount = useMemo(() => allWorkers.filter((w) => w.isRunning).length, [allWorkers]);
  const earliestCreated = useMemo(() => {
    let earliest: Date | undefined;
    for (const w of allWorkers) {
      const d = new Date(w.createdAt);
      if (!earliest || d < earliest) earliest = d;
    }
    return earliest;
  }, [allWorkers]);

  const projectName = getProjectName(projectRoot);
  const displayPath = projectRoot.replace(/^\/Users\/[^/]+/, '~');

  if (!projectRoot) {
    return (
      <div className="swarm-detail">
        <div className="swarm-detail-header">
          <button className="back-to-gallery-btn" onClick={() => navigate('/workers')}>
            &#8592; Swarm Dashboard
          </button>
          <h2>No project selected</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="swarm-detail">
      {/* Header */}
      <div className="swarm-detail-header">
        <button className="back-to-gallery-btn" onClick={() => navigate('/workers')}>
          &#8592; Swarm Dashboard
        </button>
        <h2>{projectName}</h2>
        <span className="swarm-detail-path">{displayPath}</span>
        <div className="swarm-detail-header-stats">
          <div className={`state-badge state-${runningCount > 0 ? 'running' : 'idle'}`}>
            <div className="state-indicator" />
            <span className="state-label">
              {runningCount > 0 ? `${runningCount} running` : 'All idle'}
            </span>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {workCount} exec &middot; {reviewCount} review &middot; {fixCount} fix
          </span>
          {earliestCreated && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Started {formatTimeAgo(earliestCreated)}
            </span>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="swarm-tabs">
        <button
          className={`swarm-tab ${activeTab === 'workers' ? 'active' : ''}`}
          onClick={() => setActiveTab('workers')}
        >
          Workers ({allWorkers.length})
        </button>
        <button
          className={`swarm-tab ${activeTab === 'runs' ? 'active' : ''}`}
          onClick={() => setActiveTab('runs')}
        >
          Run History
        </button>
      </div>

      {/* Workers tab: roster (exec groups with nested reviews) + parallel panes */}
      {activeTab === 'workers' && (
        <div className="swarm-detail-body">
          {/* Worker Roster sidebar — exec workers with reviews nested below */}
          <div className="swarm-roster">
            <div className="swarm-roster-header">Workers ({allWorkers.length})</div>
            <div className="swarm-roster-list">
              {execGroups.map((group, groupIdx) => {
                const w = group.exec;
                const isSelected = groupIdx === selectedGroupIdx;
                const model = shortModelName(w.modelName);
                // Aggregate verdict from most recent review
                const latestVerdict = group.reviews.length > 0 && group.reviews[0].workerRole === 'review'
                  ? extractVerdict(group.reviews[0])
                  : null;
                return (
                  <div
                    key={w.id}
                    className={`roster-exec-group ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedGroupIdx(groupIdx)}
                  >
                    <div className={`roster-worker ${isSelected ? 'selected' : ''}`}>
                      <span className={`roster-status-dot ${w.isRunning ? 'running' : 'idle'}`} />
                      <span className="roster-worker-id">
                        {w.workerId ?? w.id.substring(0, 8)}
                      </span>
                      <span className="role-badge role-work">{ROLE_LABELS.work}</span>
                      {model && <span className="roster-model">{model}</span>}
                      <span className="roster-worker-msgs">{w.messages.length}m</span>
                      {group.reviews.length > 0 && (
                        <span className="roster-review-count">{group.reviews.length}r</span>
                      )}
                      {latestVerdict && (
                        <span className={`verdict-pip verdict-${latestVerdict}`} title={latestVerdict} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="roster-stats">
              <div className="roster-stat-row">
                <span>Running</span>
                <span className="roster-stat-value">{runningCount}</span>
              </div>
              <div className="roster-stat-row">
                <span>Idle</span>
                <span className="roster-stat-value">{allWorkers.length - runningCount}</span>
              </div>
              {earliestCreated && (
                <div className="roster-stat-row">
                  <span>Duration</span>
                  <span className="roster-stat-value">{formatTimeAgo(earliestCreated)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Task log (left) + Review (right) panes for selected worker */}
          <div className="swarm-panes">
            <WorkerChatPane conversationId={taskPaneId} label="Task Log" accentColor="cyan" />
            <WorkerChatPane conversationId={reviewPaneId} label="Review" accentColor="magenta" />
          </div>
        </div>
      )}

      {/* Runs tab: structured run history with reviews and metrics */}
      {activeTab === 'runs' && (
        <div className="swarm-runs-body">
          <SwarmRunsPanel projectRoot={projectRoot} />
        </div>
      )}

      {/* Bottom panels: git log + config */}
      <div className="swarm-bottom-panels">
        <GitLogPanel projectRoot={projectRoot} />
        <OompaConfigPanel projectRoot={projectRoot} />
      </div>
    </div>
  );
}
