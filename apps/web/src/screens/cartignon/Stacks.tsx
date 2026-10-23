import { cardAriaLabel, stackAriaLabel } from '../../match/cartignon/labels';
import type { ModifierGlow } from '../../match/cartignon/modifierGlow';
import type { SeatArea, TrapCard } from '../../match/cartignon/tableModel';
import { CardView, EmptySlot } from './CardView';

/**
 * A seat's stack (bottom to top; the top card is the Leading creature, ringed and labelled) and
 * its armed traps. Armed traps are public (RD-130; S-12 / S-16 "visible to your opponent"), so
 * both seats' traps are drawn face-up with name and id, under a visible "Your traps" /
 * "Opponent's traps" caption; the accessible name says whose trap it is.
 */

function trapLabel(trap: TrapCard, mine: boolean): string {
  const dormant = trap.dormant ? ', dormant' : '';
  const owner = mine ? 'Your trap' : "Opponent's trap";
  return `${owner} ${trap.spellId}: ${cardAriaLabel(trap)}${dormant}`;
}

export function SeatStack({
  area,
  glows = new Map(),
}: {
  area: SeatArea;
  /** Modifier glow per card id (`modifierGlows`). */
  glows?: ReadonlyMap<string, ModifierGlow>;
}) {
  const mine = area.side === 'mine';
  const headingId = `${area.side}-stack-heading`;
  const lastIndex = area.stack.length - 1;

  return (
    <section aria-labelledby={headingId} data-testid={`${area.side}-stack`}>
      {/* The seat bar above already names the seat; the heading is for assistive tech. */}
      <h2 id={headingId} className="sr-only">
        {mine ? 'Your stack' : 'Opponent stack'}
      </h2>
      <div className="flex items-start gap-3">
        {area.stack.length === 0 ? (
          <EmptySlot text="Empty" />
        ) : (
          <ol
            aria-label={stackAriaLabel(area.side, area.stack.length)}
            // No sideways scrolling: like the hand, each slot may shrink (the card overflows it),
            // so a long stack overlaps to the left and the Leading card (last) is always whole.
            className="flex min-w-0 flex-1 gap-2.5 px-1.5 pb-1"
          >
            {area.stack.map((card) => {
              const leading = card.position === lastIndex;
              return (
                <li
                  key={card.cardId}
                  // The Leading (top) card gets a high-contrast ring plus a filled label, so it is
                  // found without reading every card; colour is never the only cue.
                  className="isolate flex min-w-0 flex-[0_1_var(--card-w)] flex-col items-start gap-1 pt-1 last:flex-none last:items-center"
                  data-leading={leading ? 'true' : undefined}
                >
                  <span
                    className={`block rounded-md ${
                      leading ? 'ring-3 ring-ink ring-offset-2 ring-offset-paper' : ''
                    }`}
                  >
                    <CardView
                      card={card}
                      glow={glows.get(card.cardId) ?? null}
                      leading={leading}
                      focusable
                    />
                  </span>
                  {leading ? (
                    <span className="ink-line mt-0.5 rounded-full bg-ink px-1.5 text-xs leading-3.5 text-paper">
                      Leading
                    </span>
                  ) : (
                    <span className="mt-0.5 text-[11px] font-semibold leading-4 text-ink-muted">
                      {card.position === 0 ? 'Base' : ' '}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {area.traps.length > 0 && (
          <div className="ink-line-l flex shrink-0 flex-col gap-0.5 pl-3">
            <span
              aria-hidden="true"
              className="text-[11px] font-bold uppercase leading-4 tracking-wide text-ink-muted"
            >
              {mine ? 'Your traps' : "Opponent's traps"}
            </span>
            <ul
              aria-label={mine ? 'Your armed traps' : 'Opponent armed traps'}
              className="flex gap-1.5"
              data-testid={`${area.side}-traps`}
            >
              {area.traps.map((trap) => (
                <li key={trap.cardId} className="flex flex-col items-center gap-1">
                  <CardView card={trap} ariaLabel={trapLabel(trap, mine)} trap />
                  <span className="mt-0.5 text-[11px] font-semibold leading-4 text-ink-muted">
                    {trap.dormant ? `${trap.spellId} dormant` : trap.spellId}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
