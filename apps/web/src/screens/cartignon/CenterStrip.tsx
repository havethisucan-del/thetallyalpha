import {
  liveModifierText,
  phaseText,
  roundOutcomeText,
  roundOverText,
} from '../../match/cartignon/labels';
import type { TableCenter } from '../../match/cartignon/tableModel';
import { Piles } from './Piles';
import { TokenTrack } from './TokenTrack';

/**
 * Shared table state between the two stacks: round, turn, round result, tokens, the deck and
 * graveyard piles, live modifiers.
 */
export function CenterStrip({ center }: { center: TableCenter }) {
  const item = 'flex items-baseline gap-1';
  const term = 'text-sm text-ink-muted';
  const value = 'font-bold tabular-nums';
  return (
    <section
      aria-label="Table center"
      className="ink-line flex flex-col gap-2 rounded-md bg-paper-raised p-2"
      data-testid="center-strip"
    >
      <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <div className={item}>
          <dt className={term}>Round</dt>
          <dd className={value} data-testid="table-round">
            {center.round}
            {center.finalRound ? ' (final)' : ''}
          </dd>
        </div>
        <div className={item}>
          <dt className={term}>Turn</dt>
          <dd className={value}>{center.turn}</dd>
        </div>
        <div className={item}>
          <dt className={term}>Phase</dt>
          <dd className="font-semibold">{phaseText(center.phaseKind)}</dd>
        </div>
        {center.replays > 0 && (
          <div className={item}>
            <dt className={term}>Replays</dt>
            <dd className={value}>{center.replays}</dd>
          </div>
        )}
      </dl>
      {/* Why the round ended (RD-169), else the previous round's result. */}
      {center.roundOver ? (
        // Callout: warn-coloured edge on a light surface, body text at full contrast.
        <p
          role="status"
          className="rounded-md border-l-4 border-warn bg-paper-sunken px-2 py-1.5 text-lg text-ink"
          data-testid="round-over"
        >
          {roundOverText(center.roundOver)}
        </p>
      ) : (
        center.lastOutcome && (
          <p className="text-sm text-ink-muted" data-testid="last-outcome">
            Last round: {roundOutcomeText(center.lastOutcome)}
          </p>
        )
      )}
      {/* The match tokens sit in the middle of the field, between the two stacks. */}
      <div className="py-1">
        <TokenTrack tokens={center.tokens} />
      </div>
      <Piles deckCount={center.deckCount} graveyard={center.graveyard} />
      {center.liveModifiers.length > 0 && (
        <ul aria-label="Live modifiers" className="flex flex-wrap gap-1 text-xs">
          {center.liveModifiers.map((modifier) => (
            <li
              key={`${modifier.seat}:${modifier.cardId}:${modifier.kind}`}
              className="ink-line rounded px-1.5 py-0.5 font-semibold"
            >
              {liveModifierText(modifier)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
