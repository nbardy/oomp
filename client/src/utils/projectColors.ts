// Project accent colors derived from the current palette's 8 accent CSS variables.
// Color is determined by hashing the workingDirectory so all conversations
// in the same project share one consistent accent color.
//
// These read from --pal-* at call time, so they adapt when the user switches themes.

const ACCENT_VARS = [
  '--pal-blue',
  '--pal-cyan',
  '--pal-green',
  '--pal-yellow',
  '--pal-orange',
  '--pal-red',
  '--pal-magenta',
  '--pal-violet',
] as const;

/**
 * Simple string hash → index into ACCENT_VARS.
 * Deterministic: same string always returns same index.
 */
function hashToIndex(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash) % ACCENT_VARS.length;
}

/**
 * Get the palette accent color for a project directory.
 * Reads the computed CSS variable at call time, so it adapts to theme switches.
 * All conversations sharing the same workingDirectory get the same color.
 */
export function getProjectColor(workingDirectory: string): string {
  const varName = ACCENT_VARS[hashToIndex(workingDirectory)];
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}
