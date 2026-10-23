import type { CSSProperties } from 'react';
import type { SeatArea } from '../../match/cartignon/tableModel';
import { CardBack } from './CardBack';

/** At most this many backs are drawn (the hand size is 9; a few effects can exceed it). */
export const MAX_HAND_BACKS = 12;

/**
 * The opponent's hand at the top of the table: one card back per card, fanned in an arc that
 * mirrors the own hand (`.ct-opp-hand` in table.css). Hidden information: backs only, no preview,
 * not interactive. The count is in the visually hidden heading; the name sits under the arc.
 */
export function OpponentHand({
  area,
  name,
  active,
}: {
  area: SeatArea;
  name: string;
  /** This seat acts now (turn cue glow). */
  active: boolean;
}) {
  const count = Math.min(area.handCount, MAX_HAND_BACKS);
  const half = (count - 1) / 2;
  return (
    <section
      aria-labelledby="opponent-hand-heading"
      className="ct-opp-hand"
      style={{ '--opp-n': Math.max(count, 1) } as CSSProperties}
      data-testid="theirs-hand"
      data-active={active ? 'true' : 'false'}
    >
      <h2 id="opponent-hand-heading" className="sr-only">
        {name}: {area.handCount} {area.handCount === 1 ? 'card' : 'cards'} in hand
      </h2>
      <ul aria-hidden="true" className="relative h-full" data-testid="opponent-hand-backs">
        {Array.from({ length: count }, (_, index) => (
          <li key={index} className="ct-opp-card" style={{ '--t': index - half } as CSSProperties}>
            <CardBack className="rounded-md" />
          </li>
        ))}
      </ul>
      <p aria-hidden="true" className="ct-opp-name text-sm leading-tight text-ink-muted">
        {name}
      </p>
    </section>
  );
}
