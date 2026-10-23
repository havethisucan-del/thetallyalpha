import type { MatchSnapshot } from '../net/matchSource';

/**
 * Leaving needs a confirmation only while a match is in progress: there is a view, it has no
 * outcome, and the room is not finished. Lobby and finished matches leave in one click.
 */
export function shouldConfirmLeave(snapshot: Pick<MatchSnapshot, 'view' | 'room'>): boolean {
  const view = snapshot.view;
  if (!view || view.outcome) return false;
  const phase = snapshot.room?.phase;
  return phase !== 'finished' && phase !== 'lobby';
}
