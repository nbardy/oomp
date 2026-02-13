/**
 * Swarm utilities for extracting project roots from worker worktree paths.
 *
 * Oompa workers run in isolated git worktrees under the project root.
 * The working directory stored on each conversation is the worktree path,
 * not the project root. These utilities extract the project root so workers
 * from the same repo can be grouped together in the Swarm Dashboard.
 *
 * Worktree path patterns:
 *   ~/git/project/.wu5-i3           → ~/git/project
 *   ~/git/project/.ww3-i2           → ~/git/project
 *   ~/git/project/.workers/worker-0 → ~/git/project
 *
 * Non-worker paths pass through unchanged.
 */

/**
 * Strip worktree subfolder to get the project root directory.
 * Handles both oompa's `.w<id>-i<iter>` pattern and the `.workers/worker-N` pattern.
 */
export function getProjectRoot(workerDir: string): string {
  return workerDir
    .replace(/\/\.w[^/]+-i\d+$/, '')           // .wN-iN oompa worktree pattern
    .replace(/\/\.workers\/worker-\d+$/, '');   // .workers/worker-N worktree pattern
}

/**
 * Extract just the last path segment as a display-friendly project name.
 */
export function getProjectName(root: string): string {
  return root.split('/').filter(Boolean).pop() ?? root;
}
