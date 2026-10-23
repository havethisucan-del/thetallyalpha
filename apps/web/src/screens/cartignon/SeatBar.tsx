import type { SeatArea } from '../../match/cartignon/tableModel';

/** This seat's stack ATK compared with the other seat's (display only). */
export type AtkStanding = 'ahead' | 'tied' | 'behind';

/**
 * The seat's small badge beside its stack (`.ct-badge` in table.css): the stack ATK total, with
 * a "Leads" chip on the seat with more ATK (both say "Tied" when equal). Text, never colour
 * alone. Hand size, tokens and traps are shown by the table itself (the hand arcs, the token
 * corners, the trap cards); they are repeated here for assistive tech only.
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
  return (
    <section
      aria-label={mine ? 'Your summary' : 'Opponent summary'}
      className="ct-badge text-ink"
      data-testid={`${area.side}-bar`}
      data-on-turn={onTurn ? 'true' : 'false'}
    >
      <h2 className="sr-only">{label}</h2>
      <p className="sr-only">
        {onTurn ? 'On turn. ' : ''}Hand {area.handCount}. Tokens {tokens}.
        {area.armedTrapCount > 0 ? ` Traps ${area.armedTrapCount}.` : ''}
      </p>
      <span className="flex items-baseline gap-1">
        <span className="text-xs uppercase tracking-wide text-ink-muted">ATK</span>
        <span className="ct-atk" data-testid={`${area.side}-atk`}>
          {area.atk}
        </span>
      </span>
      {standing === 'ahead' && (
        <span
          className="ink-line rounded-full bg-ahead px-1.5 text-[11px] leading-4 text-on-ahead"
          data-testid={`${area.side}-leads`}
        >
          Leads
        </span>
      )}
      {standing === 'tied' && (
        <span className="ink-line rounded-full px-1.5 text-[11px] leading-4 text-ink">Tied</span>
      )}
    </section>
  );
}
