/**
 * AUTO-GENERATED — do not edit by hand.
 *
 * Source: oompa_loompas/schemas/*.schema.json
 * Generator: npx tsx tools/gen-oompa-types.ts
 *
 * These are the RAW JSON file shapes written by oompa_loompas runs.clj.
 * For the DERIVED view types the server constructs, see OompaRuntime* in index.ts.
 */

/**
 * Iteration event log written at the end of each worker iteration. File: runs/{swarm-id}/iterations/{worker-id}-i{N}.json
 */
export interface OompaIterationLog {
  'worker-id': string;
  iteration: number;
  outcome: 'merged' | 'rejected' | 'error' | 'done' | 'executor-done' | 'no-changes' | 'working';
  /**
   * ISO-8601 instant when the iteration completed
   */
  timestamp: string;
  /**
   * Wall-clock duration of the iteration in milliseconds
   */
  'duration-ms': number;
  /**
   * ID of the first claimed task, or null if none claimed
   */
  'task-id'?: string | null;
  /**
   * Task IDs recycled back to pending (empty array when none)
   */
  'recycled-tasks': string[];
  /**
   * First ~200 chars of agent output on error, null otherwise
   */
  'error-snippet'?: string | null;
  /**
   * Number of review rounds for this iteration (0 when no review)
   */
  'review-rounds': number;
  /**
   * Cumulative worker metrics snapshot at iteration end
   */
  metrics?: {
    merges: number;
    rejections: number;
    errors: number;
    recycled: number;
    'review-rounds-total': number;
  } | null;
}

/**
 * Live summary snapshot written after each iteration. File: runs/{swarm-id}/live-summary.json
 */
export interface OompaLiveSummary {
  /**
   * Unique identifier for this swarm run
   */
  'swarm-id': string;
  /**
   * ISO-8601 instant of the last update
   */
  'updated-at': string;
  /**
   * Map from worker-id to its latest metrics snapshot
   */
  workers: {
    /**
     * Per-worker live metrics (base metrics map plus iteration/status/updated-at)
     */
    [k: string]: {
      merges: number;
      rejections: number;
      errors: number;
      recycled: number;
      'review-rounds-total': number;
      iteration: number;
      /**
       * Outcome of the most recent iteration
       */
      status: 'merged' | 'rejected' | 'error' | 'done' | 'executor-done' | 'no-changes' | 'working';
      /**
       * ISO-8601 instant when this worker's metrics were last updated
       */
      'updated-at': string;
    };
  };
}

/**
 * Review log written after each review round. File: runs/{swarm-id}/reviews/{worker-id}-i{N}-r{round}.json
 */
export interface OompaReviewLog {
  'worker-id': string;
  iteration: number;
  /**
   * Review round number (1-indexed, matches review-loop! attempt counter)
   */
  round: number;
  /**
   * Review verdict from schema.clj review-verdicts
   */
  verdict: 'approved' | 'needs-changes' | 'rejected';
  /**
   * ISO-8601 instant when the review completed
   */
  timestamp: string;
  /**
   * Full reviewer agent output (null if process failed before producing output)
   */
  output: string | null;
  /**
   * List of files in the diff that was reviewed
   */
  'diff-files': string[];
}

/**
 * Run log written at swarm start. File: runs/{swarm-id}/run.json
 */
export interface OompaRunLog {
  /**
   * Unique identifier for this swarm run
   */
  'swarm-id': string;
  /**
   * ISO-8601 instant when the swarm started
   */
  'started-at': string;
  /**
   * Path to the oompa.json config file used
   */
  'config-file': string;
  workers: {
    id: string;
    harness: 'codex' | 'claude' | 'opencode' | 'gemini';
    model: string;
    reasoning?: string | null;
    iterations: number;
    'can-plan': boolean;
    prompts: string[];
  }[];
  /**
   * Planner config, null when no planner is configured
   */
  planner?: {
    harness: 'codex' | 'claude' | 'opencode' | 'gemini';
    model: string;
    prompts: string[];
    'max-pending': number;
  } | null;
  /**
   * Reviewer config, null when no reviewer is configured
   */
  reviewer?: {
    harness: 'codex' | 'claude' | 'opencode' | 'gemini';
    model: string;
    prompts: string[];
  } | null;
}

/**
 * Final swarm summary written when all workers complete. File: runs/{swarm-id}/summary.json
 */
export interface OompaSwarmSummary {
  'swarm-id': string;
  /**
   * ISO-8601 instant when the swarm finished
   */
  'finished-at': string;
  'total-workers': number;
  /**
   * Sum of completed iterations across all workers
   */
  'total-completed': number;
  /**
   * Sum of all iterations (configured max) across all workers
   */
  'total-iterations': number;
  /**
   * Frequency map of worker final statuses (e.g. {"done": 2, "exhausted": 1})
   */
  'status-counts': {
    [k: string]: number;
  };
  workers: {
    id: string;
    harness: 'codex' | 'claude' | 'opencode' | 'gemini';
    model: string;
    /**
     * Worker final status
     */
    status: 'done' | 'exhausted' | 'error' | 'idle';
    /**
     * Number of successfully completed iterations
     */
    completed: number;
    /**
     * Configured max iterations for this worker
     */
    iterations: number;
    merges: number;
    rejections: number;
    errors: number;
    recycled: number;
    'review-rounds-total': number;
  }[];
}

