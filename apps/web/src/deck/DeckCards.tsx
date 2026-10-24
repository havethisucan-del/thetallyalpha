import { CardView } from '../screens/cartignon/CardView';
import type { TableCard } from '../match/cartignon/tableModel';
import { deckSpells, minionsByLevel } from './catalog';

/**
 * Deck screen, Cards tab: every catalog card for study, in two plain pools (Minions grouped by
 * level, then Spells). No panels or frames: headings and the cards themselves, drawn by the table's
 * own `CardView`. Each card is a tab stop; hover, keyboard focus, a tap or click (and on touch a
 * long-press or double tap) opens the same enlarged preview as on the table (`useCardPreview`).
 * Colours follow the palette setting through the `--cartignon-color-*` tokens, as on the table.
 */

/**
 * Cards a little larger than table size; the faces scale from `--card-w` (container units). At
 * 360px (328px of content) three cards fit a row; in the full page column (736px) a whole level
 * (seven colours) fits one row.
 */
const POOL_CLASS =
  'grid grid-cols-[repeat(auto-fill,var(--card-w))] gap-3 ' +
  '[--card-w:88px] [--card-h:calc(var(--card-w)*1.4125)]';

function CardPool({ cards, label }: { cards: readonly TableCard[]; label: string }) {
  return (
    <ul className={POOL_CLASS} aria-label={label}>
      {cards.map((card) => (
        <li key={card.cardId} className="flex">
          <CardView card={card} focusable tapPreview />
        </li>
      ))}
    </ul>
  );
}

export function DeckCards() {
  return (
    <div className="flex flex-col gap-8" data-testid="deck-cards">
      <section aria-labelledby="deck-minions" className="flex flex-col gap-5">
        <h2 id="deck-minions" className="text-3xl leading-none">
          Minions
        </h2>
        {minionsByLevel().map((group) => (
          <section
            key={group.level}
            aria-labelledby={`deck-level-${group.level}`}
            className="flex flex-col gap-3"
            data-testid={`deck-level-${group.level}`}
          >
            <h3 id={`deck-level-${group.level}`} className="text-2xl leading-none">
              Level {group.level}
            </h3>
            <CardPool cards={group.cards} label={`Level ${group.level} minions`} />
          </section>
        ))}
      </section>
      <section
        aria-labelledby="deck-spells"
        className="flex flex-col gap-3"
        data-testid="deck-spells"
      >
        <h2 id="deck-spells" className="text-3xl leading-none">
          Spells
        </h2>
        <CardPool cards={deckSpells()} label="Spells" />
      </section>
    </div>
  );
}
