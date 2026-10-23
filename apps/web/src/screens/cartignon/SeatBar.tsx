import type { SeatArea } from '../../match/cartignon/tableModel';
import { CardBack } from './CardBack';

/** At most this many card backs are drawn for the opponent's hand (the number says the rest). */
const MAX_HAND_BACKS = 6;

/** This seat's stack ATK compared with the other seat's (display only). */
export type AtkStanding = 'ahead' | 'tied' | 'behind';

/**
 * Compact seat summary bar (opponent bar at the top, own bar above the own stack): hand size,
 * stack ATK, tokens held and armed traps. Readability pass: the ATK total is the largest figure,
 * the seat with more ATK carries a "Leads" chip (both say "Tied" when equal), and the seat whose
 * turn it is gets a turn-coloured ring plus an "On turn" chip (text, never colour alone).
 */
export function SeatBar({
  area,
  tokens,
  onTurn = false,
  standing = null,
  name,
}: {
  area: SeatArea;
  /** Seat name; default "You" / "Opponent". */
  name?: string;
  tokens: number;
  /** It is this seat's turn. */
  onTurn?: boolean;
  /** Compared with the other seat; null hides the chip. */
  standing?: AtkStanding | null;
}) {
  const mine = area.side === 'mine';
  const label = name ?? (mine ? 'You' : 'Opponent');
  const term = 'text-sm text-ink-muted';
  return (
    <section
      aria-label={mine ? 'Your summary' : 'Opponent summary'}
      className={`ink-line flex min-h-bar shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md bg-paper-sunken px-3 py-1 text-ink ${
        // Inset: the scroll area would clip an outer ring on the top bar.
        onTurn ? 'ring-3 ring-inset ring-turn' : ''
      }`}
      data-testid={`${area.side}-bar`}
      data-on-turn={onTurn ? 'true' : 'false'}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-lg leading-tight">{label}</h2>
        {onTurn && (
          <span className="ink-line rounded-full bg-turn px-2 text-xs font-bold leading-4 text-on-turn">
            On turn
          </span>
        )}
      </div>
      <dl className="flex flex-wrap items-center justify-end gap-x-3 text-sm">
        <div className="flex items-baseline gap-1">
          <dt className={term}>Hand</dt>
          <dd className="flex items-center gap-1.5 self-center font-bold tabular-nums">
            {!mine && area.handCount > 0 && (
              // The opponent's hand, face down: a small overlapping fan of card backs
              // (decorative; the number carries the count).
              <span aria-hidden="true" className="flex" data-testid="opponent-hand-backs">
                {Array.from({ length: Math.min(area.handCount, MAX_HAND_BACKS) }, (_, index) => (
                  <span key={index} className={`block w-3.5 ${index > 0 ? '-ml-2.5' : ''}`}>
                    <CardBack className="rounded-[2px]" />
                  </span>
                ))}
              </span>
            )}
            {area.handCount}
          </dd>
        </div>
        <div className="flex items-baseline gap-1">
          <dt className={term}>Tokens</dt>
          <dd className="font-bold tabular-nums">{tokens}</dd>
        </div>
        {area.armedTrapCount > 0 && (
          <div className="flex items-baseline gap-1">
            <dt className={term}>Traps</dt>
            <dd className="font-bold tabular-nums">{area.armedTrapCount}</dd>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <dt className="text-xs font-bold uppercase tracking-wide text-ink-muted">ATK</dt>
          <dd className="flex items-center gap-1.5">
            <span
              className="text-2xl font-black leading-none tabular-nums"
              data-testid={`${area.side}-atk`}
            >
              {area.atk}
            </span>
            {standing === 'ahead' && (
              <span
                className="ink-line rounded-full bg-ahead px-2 text-xs font-bold leading-4 text-on-ahead"
                data-testid={`${area.side}-leads`}
              >
                Leads
              </span>
            )}
            {standing === 'tied' && (
              <span className="ink-line rounded-full px-2 text-xs font-bold leading-4 text-ink">
                Tied
              </span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
