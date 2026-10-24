import { useState } from 'react';
import { buttonClass } from '../../components/ui';

/**
 * A1 (2026-10-25): the final round made obvious. RD-22: a round is the final round when the deck
 * and both hands hold 18 or fewer cards after cleanup; RD-24: the match ends after it and the side
 * holding more tokens wins (RD-40: a tie replays it).
 *
 * - `FinalRoundNotice`: a prominent callout over the middle line when a final round (or a replay of
 *   it) starts. It stays until the player dismisses it or places their own first card (the
 *   stacks are empty at round start, so it covers nothing played yet); a later final-round replay
 *   shows it again. A polite live region, so screen readers hear it once.
 * - `FinalRoundMarker`: the compact, persistent marker by the round counter for the whole round.
 */

export function finalRoundTitle(replays: number): string {
  return replays > 0 ? `Final round · replay ${replays}` : 'Final round';
}

export function finalRoundBody(replays: number): string {
  const lead = replays > 0 ? 'The tokens were tied, so the final round is played again. ' : '';
  return `${lead}The match ends after this round. More tokens wins.`;
}

function tokensLine(mine: number, theirs: number): string {
  const plural = (n: number) => (n === 1 ? 'token' : 'tokens');
  return `You hold ${mine} ${plural(mine)}, your opponent ${theirs}.`;
}

export function FinalRoundNotice({
  round,
  replays,
  finalRound,
  finished,
  myStackEmpty,
  tokens,
}: {
  round: number;
  replays: number;
  finalRound: boolean;
  finished: boolean;
  /** The player has not placed a card yet this round. */
  myStackEmpty: boolean;
  tokens: { mine: number; theirs: number };
}) {
  const key = `${round}:${replays}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const shown = finalRound && !finished && myStackEmpty && dismissed !== key;
  return (
    // The live region stays mounted so the notice is announced when it appears.
    <div role="status" aria-live="polite" className="ct-final-live">
      {shown && (
        <section
          aria-labelledby="final-round-title"
          className="ct-final-notice ink-line flex flex-wrap items-end gap-x-3 gap-y-1.5 rounded-lg bg-paper-raised px-3 py-2.5 text-ink shadow-md"
          data-testid="final-round-notice"
        >
          <div className="min-w-48 flex-1">
            <h2 id="final-round-title" className="text-2xl leading-none text-rubric">
              {finalRoundTitle(replays)}
            </h2>
            <p className="mt-1 text-base leading-snug">{finalRoundBody(replays)}</p>
            <p className="text-base leading-snug text-ink-muted">
              {tokensLine(tokens.mine, tokens.theirs)}
            </p>
          </div>
          <button
            type="button"
            className={`${buttonClass.secondary} ml-auto min-h-11 px-3 text-base`}
            onClick={() => {
              setDismissed(key);
            }}
            data-testid="final-round-dismiss"
          >
            Got it
          </button>
        </section>
      )}
    </div>
  );
}

export function FinalRoundMarker({ replays }: { replays: number }) {
  return (
    <span
      className="ct-final-marker rounded-full px-2 py-0.5 text-sm leading-none"
      data-testid="final-round-marker"
      title="The match ends after this round. More tokens wins."
    >
      {finalRoundTitle(replays)}
    </span>
  );
}
