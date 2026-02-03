/**
 * Format a Date as a relative time string ("just now", "3m ago", "2h ago", "5d ago").
 * Pure function — no hooks, no side effects.
 */
export function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Returns minutes elapsed since the given date.
 * Used to drive the exponential color-fade on sidebar time-ago labels.
 */
export function getMinutesElapsed(date: Date): number {
  return (Date.now() - date.getTime()) / 60_000;
}

/**
 * Get the timestamp of the last message in a conversation's messages array.
 * Returns undefined if there are no messages or no timestamp.
 */
export function getLastMessageTime(messages: { timestamp?: Date | string }[]): Date | undefined {
  if (messages.length === 0) return undefined;
  const last = messages[messages.length - 1];
  return last.timestamp ? new Date(last.timestamp) : undefined;
}
