import type { CSSProperties } from 'react';
import type { HandCard } from '../../match/cartignon/tableModel';
import { SelectableCard } from './CardView';

/** Above this many cards a portrait hand fans in two levels (table.css). */
export const ONE_ROW_MAX = 5;

/** Two-level layout of a portrait hand: the back row (raised) takes the first half. */
export function handRows(count: number): { two: boolean; back: number; perRow: number } {
  const two = count > ONE_ROW_MAX;
  const back = two ? Math.ceil(count / 2) : count;
  return { two, back, perRow: back };
}

/** Per-card CSS variables: single-row place `--t`, two-level place `--t2` / row `--r`, z-order. */
export function handCardVars(index: number, count: number): CSSProperties {
  const { two, back } = handRows(count);
  const inBack = !two || index < back;
  const rowIndex = inBack ? index : index - back;
  const rowCount = inBack ? back : count - back;
  return {
    '--t': index - (count - 1) / 2,
    '--z': index + 1,
    '--t2': rowIndex - (rowCount - 1) / 2,
    '--r': two && inBack ? 1 : 0,
    // The front row lies over the back row.
    '--z2': inBack ? index + 1 : 20 + index,
  } as CSSProperties;
}

/**
 * The own hand at the bottom of the table, face up, fanned in an arc (`.ct-hand` in table.css):
 * card `i` of `n` sits at `t = i - (n - 1) / 2` card pitches from the centre, turned `t` fan steps
 * and lowered onto the matching circle, so the ends dip and turn outwards. The pitch shrinks so up
 * to nine cards always fit the width (no sideways scrolling); later cards cover the right part of
 * earlier ones, so each card's left edge (level, ATK, the start of the spell hint) stays visible.
 * In portrait a hand of more than five cards fans in two levels (back row raised), so the cards
 * can be larger and every card's centre stays clear for a tap (`handCardVars`).
 * Hovering, focusing or selecting a card lifts it to the front so it reads in full; the slot stays
 * put, so the pointer does not lose the card while it lifts.
 * R8c: every card is a toggle button (tap selects, tap again clears); the dock then offers that
 * card's legal commands. Cards are buttons in hand order, so Tab walks the hand left to right.
 */
export function HandRow({
  hand,
  selectedId,
  onTap,
  active = false,
}: {
  hand: readonly HandCard[];
  selectedId: string | null;
  onTap: (cardId: string) => void;
  /** This seat acts now (turn cue glow under the hand). */
  active?: boolean;
}) {
  return (
    <section
      aria-labelledby="hand-heading"
      className="ct-hand"
      data-testid="hand"
      data-active={active ? 'true' : 'false'}
    >
      <h2 id="hand-heading" className="sr-only">
        Your hand ({hand.length})
      </h2>
      {hand.length === 0 ? (
        <p className="absolute inset-x-0 bottom-[var(--hand-pad)] text-center text-sm text-ink-muted">
          No cards in hand.
        </p>
      ) : (
        <ul aria-labelledby="hand-heading" className="ct-hand-cards" data-testid="hand-row">
          {hand.map((card, index) => {
            const selected = card.cardId === selectedId;
            return (
              <li
                key={card.cardId}
                className="ct-hand-card"
                style={handCardVars(index, hand.length)}
                data-selected={selected ? 'true' : 'false'}
              >
                <div className="ct-hand-lift">
                  <SelectableCard
                    card={card}
                    selected={selected}
                    onTap={() => {
                      onTap(card.cardId);
                    }}
                    testId={`hand-card-${card.cardId}`}
                    hint={card.spellHint}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
