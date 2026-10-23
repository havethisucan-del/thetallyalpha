import { useEffect, useRef } from 'react';
import { buttonClass, cardClass, mutedTextClass } from '../../components/ui';
import { colorInfo, type CartignonColor } from '../../match/cartignon/colors';
import type { MatchSummary, SummaryResult } from '../../match/cartignon/matchSummary';
import { SWATCH_BG } from './swatch';

/**
 * End-of-match summary panel on the Cartignon table (replaces the bare outcome card): headline,
 * how the match was decided, final tokens, rounds played and the round results, with Rematch /
 * Change bot (solo bot matches only) and Back to home.
 */

const ROUND_RESULT_TEXT: Readonly<Record<SummaryResult, string>> = {
  win: 'Won',
  loss: 'Lost',
  draw: 'Draw',
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
      {summary.decidedBy && (
        <p className="text-base" data-testid="summary-decided">
          {summary.decidedBy}
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
            <ol className="flex flex-col gap-1.5" data-testid="summary-rounds">
              {summary.rounds.map((round) => (
                <li key={round.key} className="text-base" data-result={round.result}>
                  <span className="font-semibold">
                    {round.round === null ? 'Round' : `Round ${round.round}`} ·{' '}
                    {ROUND_RESULT_TEXT[round.result]}
                  </span>
                  <span className={`block text-sm ${mutedTextClass}`}>
                    {round.text}
                    {round.token && ` ${round.token}`}
                  </span>
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
