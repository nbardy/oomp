import type { OompaRuntimeSnapshot } from '@claude-web-view/shared';
import { useEffect, useMemo, useState } from 'react';

interface UseSwarmRuntimeSnapshotsOptions {
  pollMs?: number;
  enabled?: boolean;
}

const makeUnavailable = (reason: string): OompaRuntimeSnapshot => ({
  available: false,
  run: null,
  reason,
});

export function useSwarmRuntimeSnapshots(
  projectRoots: string[],
  options: UseSwarmRuntimeSnapshotsOptions = {}
): Record<string, OompaRuntimeSnapshot> {
  const { pollMs = 10_000, enabled = true } = options;
  const normalizedProjectRoots = useMemo(
    () => Array.from(new Set(projectRoots)).sort(),
    [projectRoots]
  );

  const [runtimeSnapshots, setRuntimeSnapshots] = useState<Record<string, OompaRuntimeSnapshot>>(
    {}
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || normalizedProjectRoots.length === 0) {
      return;
    }
    const id = setInterval(() => setTick((tick) => tick + 1), pollMs);
    return () => clearInterval(id);
  }, [enabled, normalizedProjectRoots.length, pollMs]);

  useEffect(() => {
    if (!enabled) {
      setRuntimeSnapshots({});
      return;
    }

    if (normalizedProjectRoots.length === 0) {
      setRuntimeSnapshots({});
      return;
    }

    const controller = new AbortController();

    const fetchRuntimeSnapshots = async () => {
      const entries = await Promise.all(
        normalizedProjectRoots.map(async (projectRoot) => {
          // Server requires an absolute path. Skip relative paths (e.g. Gemini
          // sessions whose .project_root file is missing — workingDirectory
          // falls back to a directory basename, not an absolute path).
          if (!projectRoot.startsWith('/')) {
            return { projectRoot, snapshot: makeUnavailable('No project root available') };
          }
          try {
            const response = await fetch(
              `/api/swarm-runtime?dir=${encodeURIComponent(projectRoot)}`,
              {
                signal: controller.signal,
              }
            );
            if (!response.ok) {
              return { projectRoot, snapshot: makeUnavailable(`HTTP ${response.status}`) };
            }
            const snapshot = (await response.json()) as OompaRuntimeSnapshot;
            return { projectRoot, snapshot };
          } catch {
            if (controller.signal.aborted) return null;
            return { projectRoot, snapshot: makeUnavailable('Failed to load runtime snapshot') };
          }
        })
      );

      if (controller.signal.aborted) return;
      const next: Record<string, OompaRuntimeSnapshot> = {};
      for (const entry of entries) {
        if (!entry) continue;
        next[entry.projectRoot] = entry.snapshot;
      }
      setRuntimeSnapshots(next);
    };

    void fetchRuntimeSnapshots();
    return () => controller.abort();
  }, [enabled, normalizedProjectRoots, tick]);

  return runtimeSnapshots;
}
