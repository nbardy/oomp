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
 * Worker cycle event. One complete work unit. File: runs/{swarm-id}/cycles/{worker-id}-c{N}.json
 */
export interface OompaCycle {
  'worker-id': string;
  cycle: number;
  outcome: 'merged' | 'rejected' | 'error' | 'done' | 'executor-done' | 'no-changes' | 'working';
  timestamp: string;
  'duration-ms': number;
  /**
   * Task IDs claimed via CLAIM signal during this cycle
   */
  'claimed-task-ids'?: string[];
  'recycled-tasks': string[];
  'error-snippet'?: string | null;
  'review-rounds': number;
}

/**
 * Review log written after each review round. File: runs/{swarm-id}/reviews/{worker-id}-c{N}-r{round}.json
 */
export interface OompaReviewLog {
  'worker-id': string;
  cycle: number;
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
 * Swarm started event. Written once at swarm start. File: runs/{swarm-id}/started.json
 */
export interface OompaStarted {
  'swarm-id': string;
  'started-at': string;
  /**
   * Orchestrator process ID for liveness checks
   */
  pid: number;
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
  planner?: {
    harness: 'codex' | 'claude' | 'opencode' | 'gemini';
    model: string;
    prompts: string[];
    'max-pending': number;
  } | null;
  reviewer?: {
    harness: 'codex' | 'claude' | 'opencode' | 'gemini';
    model: string;
    prompts: string[];
  } | null;
}

/**
 * Swarm stopped event. Written once at clean exit. File: runs/{swarm-id}/stopped.json
 */
export interface OompaStopped {
  'swarm-id': string;
  'stopped-at': string;
  reason: 'completed' | 'interrupted' | 'error';
  error?: string | null;
}

