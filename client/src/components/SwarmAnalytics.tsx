import type {
  Conversation,
  SwarmReviewLog,
  SwarmRunLog,
  SwarmRunSummary,
} from '@claude-web-view/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAtomValue } from 'jotai';
import { allConversationsAtom } from '../atoms/conversations';
import { useUIStore } from '../stores/uiStore';
import { getProjectColor } from '../utils/projectColors';
import { getProjectName, getProjectRoot } from '../utils/swarmUtils';
import { formatDuration, formatTimeAgo } from '../utils/time';
import './SwarmAnalytics.css';

// =============================================================================
// Types
// =============================================================================

interface SwarmProject {
  projectRoot: string;
  projectName: string;
  workers: Conversation[];
  swarmIds: Set<string>;
  accentColor: string;
}

interface RunData {
  swarmId: string;
  run: SwarmRunLog | null;
  summary: SwarmRunSummary | null;
  reviews: SwarmReviewLog[];
}

interface IterationSpan {
  id: string;
  workerId: string;
  iteration: number;
  startTime: number;
  endTime: number | null;
  status: 'running' | 'completed' | 'error' | 'pending';
  verdict: 'approved' | 'rejected' | 'needs-changes' | null;
  merges: number;
  reviewRounds: number;
  diffFiles: number;
  output?: string;
}

interface WorkerTimeline {
  workerId: string;
  model: string;
  harness: string;
  spans: IterationSpan[];
}

// =============================================================================
// Helper functions
// =============================================================================

function parseTimestamp(ts: string): number {
  return new Date(ts).getTime();
}

function shortWorkerId(id: string): string {
  // Extract short identifier from worker ID
  if (id.includes('-')) {
    return id.split('-').slice(-2).join('-');
  }
  return id.length > 12 ? id.slice(-12) : id;
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'var(--cyan)';
    case 'completed':
      return 'var(--green)';
    case 'error':
      return 'var(--red)';
    case 'pending':
      return 'var(--yellow)';
    default:
      return 'var(--text-muted)';
  }
}

function getVerdictColor(verdict: string | null): string {
  switch (verdict) {
    case 'approved':
      return 'var(--green)';
    case 'rejected':
      return 'var(--red)';
    case 'needs-changes':
      return 'var(--orange)';
    default:
      return 'transparent';
  }
}

function getVerdictIcon(verdict: string | null): string {
  switch (verdict) {
    case 'approved':
      return '✓';
    case 'rejected':
      return '✗';
    case 'needs-changes':
      return '~';
    default:
      return '?';
  }
}

// =============================================================================
// Timeline Chart Component
// =============================================================================

interface TimelineChartProps {
  runData: RunData;
  onWorkerClick?: (workerId: string) => void;
}

function TimelineChart({ runData, onWorkerClick }: TimelineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    span: IterationSpan;
    workerId: string;
  } | null>(null);

  // Build timeline data from run summary and reviews
  const { timelines, timeRange } = useMemo(() => {
    if (!runData.summary) return { timelines: [], timeRange: { start: 0, end: 0, duration: 0 } };

    const summary = runData.summary;
    const reviews = runData.reviews || [];
    const run = runData.run;

    // Get time range
    const startTime = run?.['started-at'] ? parseTimestamp(run['started-at']) : Date.now();
    const endTime = summary['finished-at'] ? parseTimestamp(summary['finished-at']) : Date.now();
    const duration = Math.max(endTime - startTime, 60000); // Minimum 1 minute

    // Build worker timelines
    const workerMap = new Map<string, WorkerTimeline>();

    // Initialize workers from summary
    for (const worker of summary.workers) {
      workerMap.set(worker.id, {
        workerId: worker.id,
        model: worker.model || 'unknown',
        harness: worker.harness || 'default',
        spans: [],
      });
    }

    // Group reviews by worker and iteration
    const reviewsByWorkerIter = new Map<string, Map<number, SwarmReviewLog[]>>();
    for (const review of reviews) {
      if (!reviewsByWorkerIter.has(review['worker-id'])) {
        reviewsByWorkerIter.set(review['worker-id'], new Map());
      }
      const workerReviews = reviewsByWorkerIter.get(review['worker-id'])!;
      if (!workerReviews.has(review.iteration)) {
        workerReviews.set(review.iteration, []);
      }
      workerReviews.get(review.iteration)!.push(review);
    }

    // Create iteration spans for each worker
    for (const worker of summary.workers) {
      const timeline = workerMap.get(worker.id);
      if (!timeline) continue;

      const workerReviews = reviewsByWorkerIter.get(worker.id);
      const iterations = Math.max(worker.iterations, worker.completed);

      for (let i = 1; i <= iterations; i++) {
        const iterationReviews = workerReviews?.get(i) || [];
        const latestReview = iterationReviews[iterationReviews.length - 1];

        // Estimate timing (distribute iterations across the time range)
        const iterDuration = duration / iterations;
        const iterStart = startTime + (i - 1) * iterDuration;
        const iterEnd = i <= worker.completed ? iterStart + iterDuration * 0.9 : null;

        const span: IterationSpan = {
          id: `${worker.id}-i${i}`,
          workerId: worker.id,
          iteration: i,
          startTime: iterStart,
          endTime: iterEnd,
          status:
            i <= worker.completed
              ? 'completed'
              : i === worker.completed + 1 && !summary['finished-at']
                ? 'running'
                : 'pending',
          verdict: (latestReview?.verdict as IterationSpan['verdict']) || null,
          merges: i <= worker.completed ? worker.merges / worker.completed : 0,
          reviewRounds: iterationReviews.length,
          diffFiles: latestReview?.['diff-files']?.length || 0,
          output: latestReview?.output,
        };

        timeline.spans.push(span);
      }
    }

    return {
      timelines: Array.from(workerMap.values()),
      timeRange: {
        start: startTime,
        end: endTime || Date.now(),
        duration: endTime - startTime || 60000,
      },
    };
  }, [runData]);

  // Chart dimensions
  const rowHeight = 40;
  const headerHeight = 30;
  const chartPadding = { top: 10, right: 20, bottom: 20, left: 150 };
  const chartHeight = Math.max(
    timelines.length * rowHeight + headerHeight + chartPadding.top + chartPadding.bottom,
    200
  );

  // Handle mouse events for tooltip
  const handleSpanHover = useCallback(
    (e: React.MouseEvent, span: IterationSpan, workerId: string) => {
      setTooltip({
        x: e.clientX + 10,
        y: e.clientY - 10,
        span,
        workerId,
      });
    },
    []
  );

  const handleSpanLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  if (timelines.length === 0) {
    return <div className="timeline-empty">No iteration data available</div>;
  }

  return (
    <div className="timeline-chart-container" ref={containerRef}>
      <div className="timeline-chart" style={{ height: chartHeight }}>
        {/* Worker labels */}
        <div className="timeline-labels" style={{ width: chartPadding.left }}>
          <div className="timeline-header" style={{ height: headerHeight }} />
          {timelines.map((timeline) => (
            <div
              key={timeline.workerId}
              className="timeline-worker-label"
              style={{ height: rowHeight }}
              onClick={() => onWorkerClick?.(timeline.workerId)}
            >
              <span className="worker-name">{shortWorkerId(timeline.workerId)}</span>
              <span className="worker-meta">{timeline.model}</span>
            </div>
          ))}
        </div>

        {/* Chart area */}
        <div className="timeline-chart-area">
          {/* Time axis */}
          <div className="timeline-axis" style={{ height: headerHeight }}>
            {Array.from({ length: 6 }).map((_, i) => {
              const pct = (i / 5) * 100;
              const timeOffset = (timeRange.duration * i) / 5;
              const timeLabel = formatDuration(timeOffset);
              return (
                <div key={i} className="timeline-tick" style={{ left: `${pct}%` }}>
                  <span className="tick-label">{timeLabel}</span>
                </div>
              );
            })}
          </div>

          {/* Spans */}
          <div className="timeline-spans">
            {timelines.map((timeline, workerIdx) => (
              <div
                key={timeline.workerId}
                className="timeline-worker-row"
                style={{
                  height: rowHeight,
                  top: headerHeight + workerIdx * rowHeight,
                }}
              >
                {/* Grid line */}
                <div className="timeline-grid-line" />

                {/* Iteration spans */}
                {timeline.spans.map((span) => {
                  const startPct = ((span.startTime - timeRange.start) / timeRange.duration) * 100;
                  const endPct = span.endTime
                    ? ((span.endTime - timeRange.start) / timeRange.duration) * 100
                    : ((Date.now() - timeRange.start) / timeRange.duration) * 100;
                  const widthPct = Math.max(endPct - startPct, 0.5);

                  return (
                    <div
                      key={span.id}
                      className={`timeline-span status-${span.status}`}
                      style={{
                        left: `${startPct}%`,
                        width: `${widthPct}%`,
                        backgroundColor: getStatusColor(span.status),
                        borderColor: getVerdictColor(span.verdict),
                      }}
                      onMouseEnter={(e) => handleSpanHover(e, span, timeline.workerId)}
                      onMouseLeave={handleSpanLeave}
                      onMouseMove={(e) => handleSpanHover(e, span, timeline.workerId)}
                    >
                      {span.verdict && (
                        <span
                          className="span-verdict"
                          style={{ backgroundColor: getVerdictColor(span.verdict) }}
                        >
                          {getVerdictIcon(span.verdict)}
                        </span>
                      )}
                      {span.reviewRounds > 1 && (
                        <span className="span-rounds">r{span.reviewRounds}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="timeline-tooltip"
          style={{
            left: tooltip.x,
            top: tooltip.y,
          }}
        >
          <div className="tooltip-header">
            <span className="tooltip-worker">{shortWorkerId(tooltip.workerId)}</span>
            <span className="tooltip-iteration">Iteration {tooltip.span.iteration}</span>
          </div>
          <div className="tooltip-body">
            <div className="tooltip-row">
              <span className="tooltip-label">Status:</span>
              <span className={`tooltip-status status-${tooltip.span.status}`}>
                {tooltip.span.status}
              </span>
            </div>
            {tooltip.span.verdict && (
              <div className="tooltip-row">
                <span className="tooltip-label">Verdict:</span>
                <span className={`tooltip-verdict verdict-${tooltip.span.verdict}`}>
                  {tooltip.span.verdict}
                </span>
              </div>
            )}
            {tooltip.span.diffFiles > 0 && (
              <div className="tooltip-row">
                <span className="tooltip-label">Files changed:</span>
                <span className="tooltip-value">{tooltip.span.diffFiles}</span>
              </div>
            )}
            {tooltip.span.reviewRounds > 0 && (
              <div className="tooltip-row">
                <span className="tooltip-label">Review rounds:</span>
                <span className="tooltip-value">{tooltip.span.reviewRounds}</span>
              </div>
            )}
            {tooltip.span.merges > 0 && (
              <div className="tooltip-row">
                <span className="tooltip-label">Merges:</span>
                <span className="tooltip-value merged">+{Math.round(tooltip.span.merges)}</span>
              </div>
            )}
          </div>
          {tooltip.span.output && (
            <div className="tooltip-output">
              <pre>
                {tooltip.span.output.slice(0, 200)}
                {tooltip.span.output.length > 200 ? '...' : ''}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Stats Panel Component
// =============================================================================

interface StatsPanelProps {
  runData: RunData;
}

function StatsPanel({ runData }: StatsPanelProps) {
  const stats = useMemo(() => {
    if (!runData.summary) return null;

    const summary = runData.summary;
    const totalMerges = summary.workers.reduce((s, w) => s + w.merges, 0);
    const totalRejections = summary.workers.reduce((s, w) => s + w.rejections, 0);
    const totalErrors = summary.workers.reduce((s, w) => s + w.errors, 0);
    const totalReviewRounds = summary.workers.reduce((s, w) => s + w['review-rounds-total'], 0);

    const completedWorkers = summary.workers.filter((w) => w.status === 'completed').length;
    const runningWorkers = summary.workers.filter((w) => w.status === 'running').length;
    const errorWorkers = summary.workers.filter((w) => w.status === 'error').length;

    return {
      totalWorkers: summary['total-workers'],
      completedIterations: summary['total-completed'],
      totalIterations: summary['total-iterations'],
      totalMerges,
      totalRejections,
      totalErrors,
      totalReviewRounds,
      completedWorkers,
      runningWorkers,
      errorWorkers,
      finishedAt: summary['finished-at'],
    };
  }, [runData]);

  if (!stats) return null;

  const completionRate =
    stats.totalIterations > 0
      ? Math.round((stats.completedIterations / stats.totalIterations) * 100)
      : 0;

  return (
    <div className="stats-panel">
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-value">
            {stats.completedIterations}/{stats.totalIterations}
          </span>
          <span className="stat-label">Iterations Done</span>
          <div className="stat-bar">
            <div
              className="stat-bar-fill"
              style={{ width: `${completionRate}%`, backgroundColor: 'var(--green)' }}
            />
          </div>
        </div>

        <div className="stat-card merges">
          <span className="stat-value merged">{stats.totalMerges}</span>
          <span className="stat-label">Total Merges</span>
        </div>

        <div className="stat-card rejections">
          <span className="stat-value rejected">{stats.totalRejections}</span>
          <span className="stat-label">Rejections</span>
        </div>

        <div className="stat-card reviews">
          <span className="stat-value">{stats.totalReviewRounds}</span>
          <span className="stat-label">Review Rounds</span>
        </div>

        <div className="stat-card workers">
          <span className="stat-value">{stats.totalWorkers}</span>
          <span className="stat-label">Workers</span>
          <div className="worker-breakdown">
            {stats.runningWorkers > 0 && (
              <span className="worker-count running">{stats.runningWorkers} running</span>
            )}
            {stats.completedWorkers > 0 && (
              <span className="worker-count completed">{stats.completedWorkers} done</span>
            )}
            {stats.errorWorkers > 0 && (
              <span className="worker-count error">{stats.errorWorkers} error</span>
            )}
          </div>
        </div>

        <div className="stat-card errors">
          <span className="stat-value">{stats.totalErrors}</span>
          <span className="stat-label">Errors</span>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Main SwarmAnalytics Component
// =============================================================================

export function SwarmAnalytics() {
  const navigate = useNavigate();
  const allConversations = useAtomValue(allConversationsAtom);
  const promotedWorkers = useUIStore((s) => s.promotedWorkers);
  const promotedSet = useMemo(() => new Set(promotedWorkers), [promotedWorkers]);

  // Project selection
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedSwarmId, setSelectedSwarmId] = useState<string | null>(null);

  // Run data state
  const [runsData, setRunsData] = useState<Map<string, RunData>>(new Map());
  const [loading, setLoading] = useState(true);

  // Group workers by project
  const projects = useMemo((): SwarmProject[] => {
    const groups = new Map<string, Conversation[]>();

    for (const conv of allConversations) {
      if (!conv.isWorker || promotedSet.has(conv.id)) continue;
      const root = getProjectRoot(conv.workingDirectory);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(conv);
    }

    return Array.from(groups.entries())
      .map(([projectRoot, workers]) => {
        const swarmIds = new Set<string>();
        for (const w of workers) {
          if (w.swarmId) swarmIds.add(w.swarmId);
        }

        return {
          projectRoot,
          projectName: getProjectName(projectRoot),
          workers,
          swarmIds,
          accentColor: getProjectColor(projectRoot),
        };
      })
      .sort((a, b) => b.workers.length - a.workers.length);
  }, [allConversations, promotedSet]);

  // Fetch runs data when project is selected
  useEffect(() => {
    if (!selectedProject) {
      setLoading(false);
      return;
    }

    setLoading(true);
    fetch(`/api/swarm-runs?dir=${encodeURIComponent(selectedProject)}`)
      .then((res) => res.json())
      .then(
        async (data: {
          runs: Array<{
            swarmId: string;
            run: SwarmRunLog | null;
            summary: SwarmRunSummary | null;
          }>;
        }) => {
          const runsMap = new Map<string, RunData>();

          // Fetch reviews for each run
          for (const run of data.runs) {
            try {
              const reviewsRes = await fetch(
                `/api/swarm-reviews?dir=${encodeURIComponent(selectedProject)}&swarmId=${encodeURIComponent(run.swarmId)}`
              );
              const reviewsData = await reviewsRes.json();

              runsMap.set(run.swarmId, {
                swarmId: run.swarmId,
                run: run.run,
                summary: run.summary,
                reviews: reviewsData.reviews || [],
              });
            } catch {
              runsMap.set(run.swarmId, {
                swarmId: run.swarmId,
                run: run.run,
                summary: run.summary,
                reviews: [],
              });
            }
          }

          setRunsData(runsMap);
          setLoading(false);

          // Auto-select first run if none selected
          if (!selectedSwarmId && data.runs.length > 0) {
            setSelectedSwarmId(data.runs[0].swarmId);
          }
        }
      )
      .catch(() => setLoading(false));
  }, [selectedProject, selectedSwarmId]);

  // Auto-select first project
  useEffect(() => {
    if (!selectedProject && projects.length > 0) {
      setSelectedProject(projects[0].projectRoot);
    }
  }, [projects, selectedProject]);

  // Get selected run data
  const selectedRun = selectedSwarmId ? runsData.get(selectedSwarmId) : null;

  return (
    <div className="swarm-analytics">
      {/* Header */}
      <div className="swarm-analytics-header">
        <div className="header-left">
          <button className="back-btn" onClick={() => navigate('/workers')}>
            ← Swarm Dashboard
          </button>
          <h2>Swarm Analytics</h2>
        </div>

        {/* Project selector */}
        <div className="project-selector">
          <label htmlFor="project-select">Project:</label>
          <select
            id="project-select"
            value={selectedProject || ''}
            onChange={(e) => {
              setSelectedProject(e.target.value);
              setSelectedSwarmId(null);
              setRunsData(new Map());
            }}
          >
            {projects.map((project) => (
              <option key={project.projectRoot} value={project.projectRoot}>
                {project.projectName} ({project.workers.length} sessions)
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Content */}
      <div className="swarm-analytics-content">
        {projects.length === 0 ? (
          <div className="empty-state">
            <p>No worker conversations found.</p>
            <p>Workers are detected by the [oompa] prefix in the first message.</p>
          </div>
        ) : loading ? (
          <div className="loading-state">
            <div className="loading-spinner" />
            <span>Loading swarm data...</span>
          </div>
        ) : (
          <>
            {/* Run selector */}
            {runsData.size > 0 && (
              <div className="run-selector-bar">
                <span className="selector-label">Swarm Run:</span>
                <div className="run-tabs">
                  {Array.from(runsData.values())
                    .sort((a, b) => {
                      const aTime = a.run?.['started-at'] || '';
                      const bTime = b.run?.['started-at'] || '';
                      return bTime.localeCompare(aTime);
                    })
                    .map((run) => (
                      <button
                        key={run.swarmId}
                        className={`run-tab ${selectedSwarmId === run.swarmId ? 'active' : ''}`}
                        onClick={() => setSelectedSwarmId(run.swarmId)}
                      >
                        <span className="run-id">{run.swarmId}</span>
                        {run.summary && (
                          <span className="run-progress">
                            {run.summary['total-completed']}/{run.summary['total-iterations']}
                          </span>
                        )}
                        {run.run?.['started-at'] && (
                          <span className="run-date">
                            {formatTimeAgo(new Date(run.run['started-at']))}
                          </span>
                        )}
                      </button>
                    ))}
                </div>
              </div>
            )}

            {/* Stats panel */}
            {selectedRun && <StatsPanel runData={selectedRun} />}

            {/* Timeline chart */}
            {selectedRun ? (
              <div className="timeline-section">
                <h3>Worker Iteration Timeline</h3>
                <TimelineChart runData={selectedRun} />
              </div>
            ) : runsData.size === 0 ? (
              <div className="empty-state">
                <p>No recorded runs for this project.</p>
                <p>Runs are recorded when oompa swarm data is available in the runs/ directory.</p>
              </div>
            ) : null}

            {/* Legend */}
            <div className="timeline-legend">
              <h4>Legend</h4>
              <div className="legend-items">
                <div className="legend-item">
                  <span className="legend-color" style={{ backgroundColor: 'var(--cyan)' }} />
                  <span>Running</span>
                </div>
                <div className="legend-item">
                  <span className="legend-color" style={{ backgroundColor: 'var(--green)' }} />
                  <span>Completed</span>
                </div>
                <div className="legend-item">
                  <span className="legend-color" style={{ backgroundColor: 'var(--red)' }} />
                  <span>Error</span>
                </div>
                <div className="legend-item">
                  <span className="legend-color" style={{ backgroundColor: 'var(--yellow)' }} />
                  <span>Pending</span>
                </div>
                <div className="legend-divider" />
                <div className="legend-item">
                  <span className="legend-badge approved">✓</span>
                  <span>Approved</span>
                </div>
                <div className="legend-item">
                  <span className="legend-badge rejected">✗</span>
                  <span>Rejected</span>
                </div>
                <div className="legend-item">
                  <span className="legend-badge needs-changes">~</span>
                  <span>Needs Changes</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
