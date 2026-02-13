import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Conversation } from '@claude-web-view/shared';
import { useConversationStore } from '../stores/conversationStore';
import { useUIStore } from '../stores/uiStore';
import { getProjectRoot, getProjectName } from '../utils/swarmUtils';
import { getProjectColor } from '../utils/projectColors';
import { formatTimeAgo, getLastMessageTime } from '../utils/time';
import './SwarmDashboard.css';

interface SwarmProject {
  projectRoot: string;
  projectName: string;
  workers: Conversation[];
  runningCount: number;
  idleCount: number;
  latestActivity: Date | undefined;
  accentColor: string;
  swarmIds: Set<string>;
}

type OompaWorkerStatus = 'starting' | 'idle' | 'running' | 'done' | 'error';

interface OompaRuntimeWorker {
  id: string;
  status: OompaWorkerStatus;
  lastEvent: string;
}

interface OompaRuntimeRun {
  runId: string;
  swarmId: string | null;
  isRunning: boolean;
  totalWorkers: number;
  activeWorkers: number;
  doneWorkers: number;
  configPath: string | null;
  logFile: string | null;
  workers: OompaRuntimeWorker[];
}

interface OompaRuntimeSnapshot {
  available: boolean;
  run: OompaRuntimeRun | null;
  reason: string | null;
}

export function SwarmDashboard() {
  const conversations = useConversationStore((s) => s.conversations);
  const navigate = useNavigate();
  const promotedWorkers = useUIStore((s) => s.promotedWorkers);
  const promotedSet = useMemo(() => new Set(promotedWorkers), [promotedWorkers]);
  const [runtimeSnapshots, setRuntimeSnapshots] = useState<Record<string, OompaRuntimeSnapshot>>({});
  const [runtimeTick, setRuntimeTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setRuntimeTick((tick) => tick + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  // Tick every 30s to keep time-ago displays current
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Group workers by project root
  const swarmProjects = useMemo((): SwarmProject[] => {
    const groups = new Map<string, Conversation[]>();

    for (const conv of conversations.values()) {
      if (!conv.isWorker || promotedSet.has(conv.id)) continue;
      const root = getProjectRoot(conv.workingDirectory);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(conv);
    }

    return Array.from(groups.entries())
      .map(([projectRoot, workers]) => {
        const runningCount = workers.filter((w) => w.isRunning).length;
        const runtime = runtimeSnapshots[projectRoot];
        const runtimeRun = runtime?.available ? runtime.run : null;
        const totalWorkers = runtimeRun?.totalWorkers
          ? Math.max(runtimeRun.totalWorkers, workers.length)
          : workers.length;
        const liveRunningCount = runtimeRun ? Math.min(runtimeRun.activeWorkers, totalWorkers) : runningCount;
        const swarmIds = new Set<string>();
        let latestActivity: Date | undefined;

        for (const w of workers) {
          if (w.swarmId) swarmIds.add(w.swarmId);
          const lastTime = getLastMessageTime(w.messages);
          if (lastTime && (!latestActivity || lastTime > latestActivity)) {
            latestActivity = lastTime;
          }
        }

        return {
          projectRoot,
          projectName: getProjectName(projectRoot),
          workers,
          runningCount: runtimeRun ? liveRunningCount : runningCount,
          idleCount: Math.max(totalWorkers - (runtimeRun ? liveRunningCount : runningCount), 0),
          latestActivity,
          accentColor: getProjectColor(projectRoot),
          swarmIds,
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
  }, [conversations, promotedSet, runtimeSnapshots]);

  const runtimeProjectRoots = useMemo(() => {
    return [...new Set(swarmProjects.map((project) => project.projectRoot))].sort();
  }, [swarmProjects]);

  useEffect(() => {
    if (runtimeProjectRoots.length === 0) {
      setRuntimeSnapshots({});
      return;
    }

    const controller = new AbortController();
    const fetchRuntime = async () => {
      const entries = await Promise.all(
        runtimeProjectRoots.map(async (projectRoot) => {
          try {
            const response = await fetch(`/api/swarm-runtime?dir=${encodeURIComponent(projectRoot)}`, {
              signal: controller.signal,
            });
            if (!response.ok) return { projectRoot, snapshot: null };
            const snapshot = (await response.json()) as OompaRuntimeSnapshot;
            return { projectRoot, snapshot };
          } catch {
            return { projectRoot, snapshot: null };
          }
        }),
      );

      if (controller.signal.aborted) return;
      const next: Record<string, OompaRuntimeSnapshot> = {};
      for (const { projectRoot, snapshot } of entries) {
        if (!snapshot) continue;
        next[projectRoot] = snapshot;
      }
      setRuntimeSnapshots(next);
    };

    void fetchRuntime();
    return () => controller.abort();
  }, [runtimeProjectRoots, runtimeTick]);

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
            No worker conversations. Workers are detected by the [oompa] prefix in the first message.
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
        <h2>Swarm Dashboard ({swarmProjects.reduce((n, p) => n + p.workers.length, 0)} workers)</h2>
      </div>
      <div className="swarm-dashboard-content">
        {swarmProjects.map((project) => (
          <div
            key={project.projectRoot}
            className={`swarm-project-card ${project.runningCount > 0 ? 'has-running' : ''}`}
            style={{ borderLeftColor: project.accentColor }}
            onClick={() => navigate(`/workers/detail?project=${encodeURIComponent(project.projectRoot)}`)}
          >
            <div className="swarm-project-info">
              <div className="swarm-project-name">{project.projectName}</div>
              <div className="swarm-project-path">
                {project.projectRoot.replace(/^\/Users\/[^/]+/, '~')}
              </div>
              <div className="swarm-project-stats">
                <span className="swarm-stat">
                  <span className="swarm-stat-value">{project.workers.length}</span>
                  worker{project.workers.length !== 1 ? 's' : ''}
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
                {project.swarmIds.size > 1 && (
                  <>
                    <span className="swarm-stat-divider" />
                    <span className="swarm-stat">
                      <span className="swarm-stat-value">{project.swarmIds.size}</span>
                      swarm runs
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
