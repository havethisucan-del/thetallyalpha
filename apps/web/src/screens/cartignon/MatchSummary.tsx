import { useEffect, useRef } from 'react';
import { buttonClass, cardClass, mutedTextClass } from '../../components/ui';
import { colorInfo, type CartignonColor } from '../../match/cartignon/colors';
import type { MatchSummary, SummaryResult } from '../../match/cartignon/matchSummary';
import { SWATCH_BG } from './swatch';

/**
 * End-of-match summary panel on the Cartignon table (replaces the bare outcome card): headline,
 * the one-line conclusion and how the match was decided, final tokens, and the rounds: one line
 * each (who won and why), expandable to the step-by-step account. With Rematch / Change bot (solo
 * bot matches only) and Back to home.
 */

/**
 * Round edge, as the event history's actor edge: won = turn colour, lost = muted ink (>= 3:1 in
 * both themes), draw = none. The headline words always say the result.
 */
const RESULT_EDGE: Readonly<Record<SummaryResult, string>> = {
  win: 'border-turn',
  loss: 'border-ink-muted',
  draw: 'border-transparent',
};

function TokenRow({ label, colors }: { label: string; colors: readonly CartignonColor[] }) {
  const names = colors.map((color) => colorInfo(color).label).join(', ');
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <dt className="min-w-24 text-base">
        {label}: {colors.length}
      </dt>
      <dd className="flex flex-wrap items-center gap-1.5">
        {colors.length === 0 ? (
          <span className={`text-base ${mutedTextClass}`}>none</span>
        ) : (
          <>
            {colors.map((color) => (
              <span
                key={color}
                aria-hidden="true"
                className={`ink-line inline-block size-5 rounded-full ${SWATCH_BG[color]}`}
                title={colorInfo(color).label}
              />
            ))}
            <span className="sr-only">{names}</span>
          </>
        )}
      </dd>
    </div>
  );
}

export function MatchSummaryPanel({
  summary,
  onHome,
  onRematch,
  onChangeBot,
}: {
  summary: MatchSummary;
  onHome: () => void;
  onRematch?: (() => void) | undefined;
  onChangeBot?: (() => void) | undefined;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The panel appears when the match ends: move focus to its heading so keyboard and screen
  // reader users land on the result (the table's own controls are inert by then).
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const { tokens } = summary;
  return (
    <section
      className={`${cardClass} flex max-h-[80dvh] flex-col gap-3`}
      aria-labelledby="outcome-heading"
      data-testid="match-summary"
      data-result={summary.result}
    >
      <h2
        id="outcome-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-3xl leading-none focus:outline-none"
        data-testid="outcome"
      >
        {summary.headline}
      </h2>
      {(summary.conclusion ?? summary.decidedBy) !== null && (
        <p className="text-base">
          {summary.conclusion && (
            <span className="font-semibold" data-testid="summary-conclusion">
              {summary.conclusion}
            </span>
          )}
          {summary.conclusion && summary.decidedBy && ' '}
          {summary.decidedBy && <span data-testid="summary-decided">{summary.decidedBy}</span>}
        </p>
      )}

      {/* Only the details scroll: the headline and the buttons stay in view after a long match. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <section aria-labelledby="summary-tokens-heading">
          <h3 id="summary-tokens-heading" className="mb-1 text-lg leading-none">
            Final tokens
          </h3>
          <dl className="flex flex-col gap-1" data-testid="summary-tokens">
            <TokenRow label="You" colors={tokens.mine} />
            <TokenRow label="Opponent" colors={tokens.theirs} />
            {tokens.unclaimed.length > 0 && (
              <TokenRow label="Unclaimed" colors={tokens.unclaimed} />
            )}
          </dl>
        </section>

        <section aria-labelledby="summary-rounds-heading">
          <h3 id="summary-rounds-heading" className="mb-1 text-lg leading-none">
            <span data-testid="summary-rounds-played">
              {summary.roundsPlayed} {summary.roundsPlayed === 1 ? 'round' : 'rounds'} played
            </span>
          </h3>
          {summary.rounds.length > 0 && (
            <ol className="flex flex-col gap-1" data-testid="summary-rounds">
              {summary.rounds.map((round) => (
                <li
                  key={round.key}
                  // pr-1: room for the focus ring inside the scrolling box (which clips it).
                  className={`border-l-4 pr-1 pl-2 ${RESULT_EDGE[round.result]}`}
                  data-result={round.result}
                >
                  {/* Collapsed by default: one line per round; the why on expand (native
                      details/summary: keyboard and screen reader support built in). */}
                  <details className="ct-sum-round" data-testid="summary-round">
                    <summary className="flex cursor-pointer items-start gap-1.5 rounded-sm text-base leading-snug">
                      <span aria-hidden="true" className="ct-sum-chevron" />
                      <span className="min-w-0 break-words">
                        <span className="font-semibold">
                          {round.round === null ? 'Round' : `Round ${round.round}`}
                        </span>
                        {' — '}
                        {round.headline}
                      </span>
                    </summary>
                    <ul
                      className={`ct-log-details mt-1 mb-1 ml-5 flex flex-col gap-0.5 text-sm leading-snug ${mutedTextClass}`}
                    >
                      {round.details.map((detail, index) => (
                        // Details are sentences of one round; they do not reorder.
                        <li key={index}>{detail}</li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ol>
          )}
          {!summary.roundsComplete && (
            <p className={`mt-1 text-sm ${mutedTextClass}`}>Earlier rounds are not listed.</p>
          )}
        </section>
      </div>

      <div className="flex flex-wrap gap-2">
        {onRematch && (
          <button
            type="button"
            className={buttonClass.primary}
            onClick={onRematch}
            data-testid="rematch"
          >
            Rematch
          </button>
        )}
        {onChangeBot && (
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={onChangeBot}
            data-testid="change-bot"
          >
            Change bot
          </button>
        )}
        <button
          type="button"
          className={onRematch ? buttonClass.secondary : buttonClass.primary}
          onClick={onHome}
          data-testid="back-home"
        >
          Back to home
        </button>
      </div>
    </section>
  );
}
