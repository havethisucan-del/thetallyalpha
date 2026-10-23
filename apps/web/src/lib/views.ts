import type { MatchViewMessage } from '@cartignon/protocol';

/**
 * Decides whether an incoming view replaces the one on screen. Views can arrive out of order
 * around a rejoin, so a lower revision of the same match is stale and dropped. An equal revision
 * is accepted (a rejoin resends the current view). A different match always wins.
 */
export function shouldAcceptView(
  current: Pick<MatchViewMessage, 'matchId' | 'revision'> | null,
  next: Pick<MatchViewMessage, 'matchId' | 'revision'>,
): boolean {
  if (current === null) return true;
  if (current.matchId !== next.matchId) return true;
  return next.revision >= current.revision;
}

/** Bounded exponential backoff for rejoin attempts (1-based attempt number). */
export function rejoinDelayMs(attempt: number, baseMs = 500, maxMs = 8000): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
