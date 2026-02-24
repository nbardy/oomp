import type { Conversation } from '@claude-web-view/shared';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSwarmRuntimeSnapshots } from '../hooks/useSwarmRuntimeSnapshots';
import { useAtomValue } from 'jotai';
import { allConversationsAtom } from '../atoms/conversations';
import { useUIStore } from '../stores/uiStore';
import { getProjectColor } from '../utils/projectColors';
import { getProjectName, getProjectRoot } from '../utils/swarmUtils';
import { getWorkerVisibilitySummary } from '../utils/swarmWorkerVisibility';
import { formatTimeAgo, getLastMessageTime } from '../utils/time';
import './SwarmDashboard.css';

interface SwarmProject {
  projectRoot: string;
  projectName: string;
  /** Historical JSONL session files (one per worker iteration) */
  sessions: Conversation[];
  /** Configured worker slots (from runtime or distinct workerIds) */
  workerCount: number;
  runningCount: number;
  idleCount: number;
  /** Recorded swarm runs (from runtime runCount or distinct swarmIds) */
  runCount: number;
  latestActivity: Date | undefined;
  accentColor: string;
}

export function SwarmDashboard() {
  const allConversations = useAtomValue(allConversationsAtom);
  const navigate = useNavigate();
  const promotedWorkers = useUIStore((s) => s.promotedWorkers);
  const promotedSet = useMemo(() => new Set(promotedWorkers), [promotedWorkers]);
  const workerConversationsByProject = useMemo(() => {
    const groups = new Map<string, Conversation[]>();

    for (const conv of allConversations) {
      if (!conv.isWorker || promotedSet.has(conv.id)) continue;
      const root = getProjectRoot(conv.workingDirectory);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(conv);
    }

    return groups;
  }, [allConversations, promotedSet]);
  const runtimeProjectRoots = useMemo(
    () => Array.from(workerConversationsByProject.keys()).sort(),
    [workerConversationsByProject]
  );
  const runtimeSnapshots = useSwarmRuntimeSnapshots(runtimeProjectRoots);

  // Tick every 30s to keep time-ago displays current
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Group worker sessions by project root
  const swarmProjects = useMemo((): SwarmProject[] => {
    return Array.from(workerConversationsByProject.entries())
      .map(([projectRoot, sessions]) => {
        const runtime = runtimeSnapshots[projectRoot];
        const runtimeRun = runtime?.available ? runtime.run : null;
        const visibility = getWorkerVisibilitySummary(
          sessions,
          runtime,
          (worker) => worker.isRunning
        );

        // Run count: from runtime (disk), fallback to distinct swarmIds from sessions
        const distinctSwarmIds = new Set(sessions.map((s) => s.swarmId).filter(Boolean));
        const runCount = runtimeRun?.runCount ?? distinctSwarmIds.size;

        let latestActivity: Date | undefined;
        for (const w of sessions) {
          const lastTime = getLastMessageTime(w.messages);
          if (lastTime && (!latestActivity || lastTime > latestActivity)) {
            latestActivity = lastTime;
          }
        }

        return {
          projectRoot,
          projectName: getProjectName(projectRoot),
          sessions,
          workerCount: visibility.totalWorkers,
          runningCount: visibility.runningWorkers,
          idleCount: Math.max(visibility.totalWorkers - visibility.runningWorkers, 0),
          runCount,
          latestActivity,
          accentColor: getProjectColor(projectRoot),
        };
      })
      .sort((a, b) => {
        // Running projects first, then by latest activity
        if (a.runningCount > 0 && b.runningCount === 0) return -1;
        if (b.runningCount > 0 && a.runningCount === 0) return 1;
        const aTime = a.latestActivity?.getTime() ?? 0;
        const bTime = b.latestActivity?.getTime() ?? 0;
        return bTime - aTime;
      });
  }, [runtimeSnapshots, workerConversationsByProject]);

  if (swarmProjects.length === 0) {
    return (
      <div className="swarm-dashboard">
        <div className="swarm-dashboard-header">
          <button className="back-to-gallery-btn" onClick={() => navigate('/')}>
            &#8592; Gallery
          </button>
          <h2>Swarm Dashboard</h2>
        </div>
        <div className="swarm-dashboard-content">
          <div className="empty-state">
            No worker conversations. Workers are detected by the [oompa] prefix in the first
            message.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="swarm-dashboard">
      <div className="swarm-dashboard-header">
        <button className="back-to-gallery-btn" onClick={() => navigate('/')}>
          &#8592; Gallery
        </button>
        <h2>Swarm Dashboard</h2>
      </div>
      <div className="swarm-dashboard-content">
        {swarmProjects.map((project) => (
          <div
            key={project.projectRoot}
            className={`swarm-project-card ${project.runningCount > 0 ? 'has-running' : ''}`}
            style={{ borderLeftColor: project.accentColor }}
            onClick={() =>
              navigate(`/workers/detail?project=${encodeURIComponent(project.projectRoot)}`)
            }
          >
            <div className="swarm-project-info">
              <div className="swarm-project-name">{project.projectName}</div>
              <div className="swarm-project-path">
                {project.projectRoot.replace(/^\/Users\/[^/]+/, '~')}
              </div>
              <div className="swarm-project-stats">
                <span className="swarm-stat">
                  <span className="swarm-stat-value">{project.sessions.length}</span>
                  session{project.sessions.length !== 1 ? 's' : ''}
                </span>
                <span className="swarm-stat-divider" />
                {project.runningCount > 0 && (
                  <span className="swarm-stat">
                    <span className="swarm-stat-value running">{project.runningCount}</span>
                    running
                  </span>
                )}
                {project.idleCount > 0 && (
                  <span className="swarm-stat">
                    <span className="swarm-stat-value idle">{project.idleCount}</span>
                    idle
                  </span>
                )}
                {project.runCount > 1 && (
                  <>
                    <span className="swarm-stat-divider" />
                    <span className="swarm-stat">
                      <span className="swarm-stat-value">{project.runCount}</span>
                      swarm run{project.runCount !== 1 ? 's' : ''}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="swarm-project-right">
              {project.latestActivity && (
                <span className="swarm-time-ago">{formatTimeAgo(project.latestActivity)}</span>
              )}
              <button
                className="swarm-open-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/workers/detail?project=${encodeURIComponent(project.projectRoot)}`);
                }}
              >
                Open Swarm &#8594;
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
