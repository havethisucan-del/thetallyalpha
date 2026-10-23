import type { HandCard } from '../../match/cartignon/tableModel';
import { SelectableCard } from './CardView';

/**
 * The own hand, always fully visible in one fanned row: no sideways scrolling (playtest
 * feedback). Cards keep their normal 64x90 size. Each card sits in a slot that may shrink
 * (`flex: 0 1 var(--card-w)`, `min-width: 0`) while the card itself stays full size and overflows
 * its slot, so when the row is too narrow the slots shrink evenly and the cards overlap just
 * enough to fit; the last card is shown whole. Later cards cover the right part of earlier ones,
 * so each card's left edge (level, ATK, the start of the spell hint) stays
 * visible. Hovering, focusing or selecting a card lifts it to the front so it reads in full.
 * R8c: every card is a toggle button (tap selects, tap again clears); the action bar then offers
 * that card's legal commands.
 */
export function HandRow({
  hand,
  selectedId,
  onTap,
}: {
  hand: readonly HandCard[];
  selectedId: string | null;
  onTap: (cardId: string) => void;
}) {
  return (
    <section aria-labelledby="hand-heading" data-testid="hand">
      {/* The own seat bar shows the hand size; the heading is for assistive tech. */}
      <h2 id="hand-heading" className="sr-only">
        Your hand ({hand.length})
      </h2>
      {hand.length === 0 ? (
        <p className="text-sm text-ink-muted">No cards in hand.</p>
      ) : (
        <ul
          aria-labelledby="hand-heading"
          // Top padding leaves room for the lift and the "Selected" label; side padding for the
          // selection ring.
          className="flex justify-center gap-1.5 px-1.5 pt-4 pb-1.5"
          data-testid="hand-row"
        >
          {hand.map((card) => {
            const selected = card.cardId === selectedId;
            return (
              <li
                key={card.cardId}
                className={`relative isolate min-w-0 flex-[0_1_var(--card-w)] transition-transform last:flex-none hover:z-30 hover:-translate-y-1.5 focus-within:z-30 focus-within:-translate-y-1.5 ${
                  selected ? 'z-20 -translate-y-1.5' : ''
                }`}
              >
                <SelectableCard
                  card={card}
                  selected={selected}
                  onTap={() => {
                    onTap(card.cardId);
                  }}
                  testId={`hand-card-${card.cardId}`}
                  hint={card.spellHint}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
