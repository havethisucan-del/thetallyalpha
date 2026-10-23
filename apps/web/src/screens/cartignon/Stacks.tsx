import type { CSSProperties } from 'react';
import { cardAriaLabel, stackAriaLabel } from '../../match/cartignon/labels';
import type { ModifierGlow } from '../../match/cartignon/modifierGlow';
import type { SeatArea, TrapCard } from '../../match/cartignon/tableModel';
import { CardView, EmptySlot } from './CardView';

/**
 * A seat's stack as a physical pile (`.ct-stack` in table.css): bottom to top, each card lying
 * over the previous one with an offset, so earlier cards peek out (own stack: left and top; the
 * opponent's, mirrored across the middle line: left and bottom) and the Leading (top) card is
 * whole. Every card is a tab stop; hover, focus, long-press or a tap opens the enlarged preview
 * (both seats' stacks are public). Armed traps are public too (RD-130; S-12 / S-16), drawn
 * face-up and smaller beside the stack; the accessible name says whose trap it is.
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
  const count = area.stack.length;
  const lastIndex = count - 1;

  return (
    <>
      <section aria-labelledby={headingId} data-testid={`${area.side}-stack`}>
        <h2 id={headingId} className="sr-only">
          {mine ? 'Your stack' : 'Opponent stack'}
        </h2>
        {count === 0 ? (
          <EmptySlot text="Empty" />
        ) : (
          <ol
            aria-label={stackAriaLabel(area.side, count)}
            className="ct-stack"
            style={{ '--stack-n': count } as CSSProperties}
            data-side={area.side}
          >
            {area.stack.map((card) => {
              const leading = card.position === lastIndex;
              return (
                <li
                  key={card.cardId}
                  style={{ '--k': card.position, '--z': card.position + 1 } as CSSProperties}
                  data-leading={leading ? 'true' : undefined}
                >
                  <CardView
                    card={card}
                    glow={glows.get(card.cardId) ?? null}
                    leading={leading}
                    focusable
                    tapPreview
                  />
                  {leading && <span className="sr-only">Leading</span>}
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {area.traps.length > 0 && (
        <ul
          aria-label={mine ? 'Your armed traps' : 'Opponent armed traps'}
          className="ct-traps flex gap-1.5"
          data-testid={`${area.side}-traps`}
        >
          {area.traps.map((trap) => (
            <li key={trap.cardId} className="flex flex-col items-center gap-0.5">
              <CardView card={trap} ariaLabel={trapLabel(trap, mine)} trap />
              <span
                aria-hidden="true"
                className="text-[11px] leading-3 whitespace-nowrap text-ink-muted"
              >
                {trap.dormant ? `${trap.spellId} dormant` : trap.spellId}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
