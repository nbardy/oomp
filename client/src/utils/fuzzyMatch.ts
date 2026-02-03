/**
 * Ctrl+P style fuzzy matching.
 *
 * Characters in the query must appear in order in the target, but not
 * necessarily contiguously. Scoring rewards:
 *   - Consecutive character matches (biggest bonus)
 *   - Matches at the start of the string or after a separator (/, -, _)
 *   - Earlier matches in the string
 *
 * Returns null if the query does not match, otherwise returns a
 * FuzzyResult with the score and the indices of matched characters
 * (for highlighting).
 */

export interface FuzzyResult {
  /** Higher is better */
  score: number;
  /** Indices into the target string that matched */
  matches: number[];
}

const SEPARATOR = new Set(['/', '-', '_', '.', ' ']);

/**
 * Fuzzy match `query` against `target`.
 * Returns null if no match, otherwise { score, matches }.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (q.length === 0) return { score: 0, matches: [] };
  if (q.length > t.length) return null;

  // Find matching character indices greedily with best-path scoring.
  // We use a two-pass approach:
  //   Pass 1: greedy left-to-right to check feasibility and build initial matches
  //   Pass 2: greedy right-to-left, then pick whichever pass scores higher
  // This is the same approach used by fzf / VS Code's fuzzy scorer.

  const forwardMatches = greedyMatch(q, t, true);
  if (!forwardMatches) return null;

  const backwardMatches = greedyMatch(q, t, false);
  if (!backwardMatches) return null;

  const forwardScore = scoreMatches(forwardMatches, t);
  const backwardScore = scoreMatches(backwardMatches, t);

  if (forwardScore >= backwardScore) {
    return { score: forwardScore, matches: forwardMatches };
  }
  return { score: backwardScore, matches: backwardMatches };
}

function greedyMatch(query: string, target: string, forward: boolean): number[] | null {
  const matches: number[] = [];

  if (forward) {
    let ti = 0;
    for (let qi = 0; qi < query.length; qi++) {
      while (ti < target.length && target[ti] !== query[qi]) ti++;
      if (ti >= target.length) return null;
      matches.push(ti);
      ti++;
    }
  } else {
    let ti = target.length - 1;
    for (let qi = query.length - 1; qi >= 0; qi--) {
      while (ti >= 0 && target[ti] !== query[qi]) ti--;
      if (ti < 0) return null;
      matches.push(ti);
      ti--;
    }
    matches.reverse();
  }

  return matches;
}

function scoreMatches(matches: number[], target: string): number {
  let score = 0;

  for (let i = 0; i < matches.length; i++) {
    const idx = matches[i];

    // Bonus for consecutive matches (the key Ctrl+P behavior)
    if (i > 0 && matches[i] === matches[i - 1] + 1) {
      score += 8;
    }

    // Bonus for matching at string start
    if (idx === 0) {
      score += 6;
    }

    // Bonus for matching right after a separator (word boundary)
    if (idx > 0 && SEPARATOR.has(target[idx - 1])) {
      score += 5;
    }

    // Small bonus for earlier positions
    score += Math.max(0, 4 - Math.floor(idx / 10));

    // Base score per matched character
    score += 1;
  }

  // Penalty for longer targets (prefer shorter, more specific matches)
  score -= Math.floor(target.length / 10);

  return score;
}

/**
 * Render a target string with matched indices wrapped in <mark> tags.
 * Returns an array of React-compatible elements (strings and JSX).
 */
export function highlightMatches(target: string, matches: number[]): (string | { highlighted: string; key: number })[] {
  const matchSet = new Set(matches);
  const parts: (string | { highlighted: string; key: number })[] = [];
  let current = '';
  let inMatch = false;
  let key = 0;

  for (let i = 0; i < target.length; i++) {
    const isMatch = matchSet.has(i);
    if (isMatch !== inMatch) {
      if (current) {
        parts.push(inMatch ? { highlighted: current, key: key++ } : current);
        current = '';
      }
      inMatch = isMatch;
    }
    current += target[i];
  }
  if (current) {
    parts.push(inMatch ? { highlighted: current, key: key++ } : current);
  }

  return parts;
}
