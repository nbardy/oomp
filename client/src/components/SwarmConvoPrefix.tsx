import { useMemo, useState } from 'react';
import './SwarmConvoPrefix.css';

interface SwarmConvoPrefixProps {
  prefix: string;
  swarmId: string | null;
}

/** Parse key stats from the prefix text for the collapsed summary line. */
function parseStatsFromPrefix(prefix: string): {
  project: string | null;
  completed: string | null;
  iterations: string | null;
  merges: string | null;
  rejections: string | null;
  errors: string | null;
  started: string | null;
  runsDir: string | null;
} {
  const get = (label: string): string | null => {
    const match = prefix.match(new RegExp(`^- ${label}:\\s*(.+)$`, 'm'));
    return match?.[1]?.trim() ?? null;
  };
  const runsMatch = prefix.match(/^Oompa run files are saved to:\s*(.+)$/m);
  return {
    project: get('Project'),
    completed: get('Completed'),
    iterations: get('Total Iterations'),
    merges: get('Merges'),
    rejections: get('Rejections'),
    errors: get('Errors'),
    started: get('Started'),
    runsDir: runsMatch?.[1]?.trim() ?? null,
  };
}

/** Parse the worker table from the prefix text. */
function parseWorkerTable(prefix: string): {
  headers: string[];
  rows: string[][];
} | null {
  const sectionMatch = prefix.match(/## Worker Status\n([\s\S]*?)(?=\n##|\n\nGiven|$)/);
  if (!sectionMatch) return null;

  const lines = sectionMatch[1].trim().split('\n').filter((l) => l.trim() && !l.startsWith('---'));
  if (lines.length < 2) return null;

  const headers = lines[0].split('|').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => line.split('|').map((c) => c.trim()));
  return { headers, rows };
}

export function SwarmConvoPrefix({ prefix, swarmId }: SwarmConvoPrefixProps) {
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo(() => parseStatsFromPrefix(prefix), [prefix]);
  const workerTable = useMemo(() => parseWorkerTable(prefix), [prefix]);
  const label = swarmId ?? 'debug';

  // Build a compact stats summary for the collapsed state
  const statChips: Array<{ label: string; value: string; kind: string }> = [];
  if (stats.completed) statChips.push({ label: 'Done', value: stats.completed, kind: 'neutral' });
  if (stats.merges) statChips.push({ label: 'Merges', value: stats.merges, kind: 'success' });
  if (stats.rejections && stats.rejections !== '0') statChips.push({ label: 'Rej', value: stats.rejections, kind: 'warning' });
  if (stats.errors && stats.errors !== '0') statChips.push({ label: 'Err', value: stats.errors, kind: 'error' });

  return (
    <div className="swarm-convo-prefix">
      <button
        type="button"
        className={`swarm-prefix-token ${expanded ? 'expanded' : 'collapsed'}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="swarm-prefix-indicator">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span className="swarm-prefix-label">SWARM DEBUG</span>
        <span className="swarm-prefix-id">{label}</span>
        {statChips.length > 0 && (
          <span className="swarm-prefix-stats">
            {statChips.map((chip) => (
              <span key={chip.label} className={`swarm-stat-chip chip-${chip.kind}`}>
                {chip.value} {chip.label}
              </span>
            ))}
          </span>
        )}
        {stats.started && <span className="swarm-prefix-time">{stats.started}</span>}
      </button>
      {expanded && (
        <div className="swarm-prefix-content">
          {/* Structured summary card */}
          <div className="swarm-prefix-summary">
            {stats.project && (
              <div className="swarm-prefix-row">
                <span className="swarm-prefix-key">Project</span>
                <code className="swarm-prefix-val">{stats.project}</code>
              </div>
            )}
            {stats.started && (
              <div className="swarm-prefix-row">
                <span className="swarm-prefix-key">Started</span>
                <span className="swarm-prefix-val">{stats.started}</span>
              </div>
            )}
            {stats.runsDir && (
              <div className="swarm-prefix-row">
                <span className="swarm-prefix-key">Run Artifacts</span>
                <code className="swarm-prefix-val">{stats.runsDir}</code>
              </div>
            )}
          </div>

          {/* Stats grid */}
          {stats.iterations && (
            <div className="swarm-prefix-stat-grid">
              <div className="swarm-prefix-stat">
                <span className="swarm-prefix-stat-value">{stats.completed ?? '—'}</span>
                <span className="swarm-prefix-stat-label">Completed</span>
              </div>
              <div className="swarm-prefix-stat">
                <span className="swarm-prefix-stat-value">{stats.iterations}</span>
                <span className="swarm-prefix-stat-label">Total Iters</span>
              </div>
              <div className="swarm-prefix-stat">
                <span className="swarm-prefix-stat-value stat-success">{stats.merges ?? '0'}</span>
                <span className="swarm-prefix-stat-label">Merges</span>
              </div>
              <div className="swarm-prefix-stat">
                <span className="swarm-prefix-stat-value stat-warning">{stats.rejections ?? '0'}</span>
                <span className="swarm-prefix-stat-label">Rejections</span>
              </div>
              <div className="swarm-prefix-stat">
                <span className="swarm-prefix-stat-value stat-error">{stats.errors ?? '0'}</span>
                <span className="swarm-prefix-stat-label">Errors</span>
              </div>
            </div>
          )}

          {/* Worker table */}
          {workerTable && (
            <div className="swarm-prefix-workers">
              <table className="swarm-prefix-table">
                <thead>
                  <tr>
                    {workerTable.headers.map((h, i) => (
                      <th key={i}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {workerTable.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} className={ci === 0 ? 'worker-id-cell' : undefined}>
                          {ci === 2 ? (
                            <span className={`swarm-prefix-status status-${cell}`}>{cell}</span>
                          ) : (
                            cell
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Raw prefix text (collapsible) */}
          <details className="swarm-prefix-raw">
            <summary>Raw CLI Context</summary>
            <pre className="swarm-prefix-text">{prefix}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
