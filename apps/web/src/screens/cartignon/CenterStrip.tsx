import {
  liveModifierText,
  phaseText,
  roundOutcomeText,
  roundOverText,
} from '../../match/cartignon/labels';
import type { TableCenter } from '../../match/cartignon/tableModel';
import { Piles } from './Piles';
import { TableDivider } from './TableDivider';

/**
 * The middle line of the table (`.ct-mid` in table.css): the divider placeholder, the graveyard
 * (left) and deck (right) piles, and while a round is over the reason it ended (RD-169) as a
 * small callout just above the line. The tokens lie on this line too but are drawn by
 * `TokenTrack` (they travel to the corners). Phase, the previous round's result and the live
 * modifiers are given to assistive tech only (the cards show the modifiers themselves).
 */
export function CenterStrip({ center }: { center: TableCenter }) {
  return (
    <section aria-label="Table center" className="ct-mid" data-testid="center-strip">
      <TableDivider />
      <p className="sr-only">
        Round {center.round}
        {center.finalRound ? ' (final)' : ''}, turn {center.turn}, {phaseText(center.phaseKind)}
        {center.replays > 0 ? `, ${center.replays} replays` : ''}.
      </p>
      {center.roundOver ? (
        <p
          role="status"
          className="ct-round-over rounded-md border-l-4 border-warn bg-paper-raised px-2 py-1 text-base leading-snug text-ink shadow-md"
          data-testid="round-over"
        >
          {roundOverText(center.roundOver)}
        </p>
      ) : (
        center.lastOutcome && (
          <p className="sr-only" data-testid="last-outcome">
            Last round: {roundOutcomeText(center.lastOutcome)}
          </p>
        )
      )}
      <Piles deckCount={center.deckCount} graveyard={center.graveyard} />
      {center.liveModifiers.length > 0 && (
        <ul aria-label="Live modifiers" className="sr-only">
          {center.liveModifiers.map((modifier) => (
            <li key={`${modifier.seat}:${modifier.cardId}:${modifier.kind}`}>
              {liveModifierText(modifier)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
