import type { ReactNode } from 'react';
import { groupHistory } from '../../match/cartignon/logHistory';
import type { NarrationLine } from '../../match/cartignon/narration';

/** Actor edge of a log entry: own = turn colour, opponent = muted ink, table = none. */
function actorEdge(line: NarrationLine): string {
  if (line.actor === 'mine') return 'border-turn';
  // >= 3:1 against the log surface in both themes (WCAG 1.4.11).
  if (line.actor === 'theirs') return 'border-ink-muted';
  return 'border-transparent';
}

/**
 * The detailed event history (corner log, pinned open): every narrated line the table has seen,
 * grouped by round and turn, newest first at every level, each with what it triggered (`details`:
 * the spell's Condition verdict and effect, modifier activations and silencing). Own actions carry
 * a turn-coloured edge, the opponent's a muted one, table events none; the words always say who.
 * The list scrolls inside its box (never widens the layout); it is focusable for keyboard
 * scrolling. `role="log"` lets screen readers follow it.
 */
export function ActionLog({
  lines,
  currentRound = 1,
  action,
}: {
  /** The history, oldest first. */
  lines: readonly NarrationLine[];
  /** The round in progress (numbers the round groups). */
  currentRound?: number;
  /** A control beside the heading (the panel's Close button). */
  action?: ReactNode;
}) {
  const rounds = groupHistory(lines, currentRound);
  const newestKey = lines.at(-1)?.key;
  return (
    <section aria-labelledby="action-log-heading" data-testid="action-log">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2
          id="action-log-heading"
          className="text-sm font-semibold uppercase tracking-wide text-ink-muted"
        >
          Event history <span className="font-normal normal-case">(newest first)</span>
        </h2>
        {action}
      </div>
      {rounds.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing has happened yet.</p>
      ) : (
        <div
          role="log"
          aria-labelledby="action-log-heading"
          // Focusable scroll box (keyboard scrolling).
          tabIndex={0}
          className="ct-log-scroll flex flex-col gap-2 overflow-y-auto overscroll-contain text-sm leading-snug break-words"
          data-testid="action-log-list"
        >
          {rounds.map((round) => (
            <section key={round.key} aria-label={round.round ? `Round ${round.round}` : 'Earlier'}>
              <h3 className="ct-log-round ink-line-t sticky top-0 z-1 bg-paper-raised pt-1 text-xs font-semibold uppercase tracking-wide text-ink">
                {round.round ? `Round ${round.round}` : 'Earlier'}
              </h3>
              {round.turns.map((turn) => (
                <div key={turn.key} className="mt-1">
                  <h4 className="text-xs text-ink-muted">{turn.label}</h4>
                  <ol className="mt-0.5 flex flex-col gap-1">
                    {turn.lines.map((line) => (
                      <li
                        key={line.key}
                        className={`border-l-4 pl-2 ${actorEdge(line)} ${
                          line.key === newestKey ? 'font-semibold' : ''
                        }`}
                        data-actor={line.actor ?? 'table'}
                      >
                        {line.text}
                        {line.details && line.details.length > 0 && (
                          <ul className="ct-log-details mt-0.5 flex flex-col gap-0.5 text-[0.8125rem] font-normal text-ink-muted">
                            {line.details.map((detail, index) => (
                              // Details may repeat (two cards silenced alike): the index is the key.
                              <li key={index}>{detail}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The hover preview of the log (pointer devices): the newest few lines, flat, newest first. Purely
 * a glance; the pinned panel has the full history.
 */
export function RecentLog({
  lines,
  count = 5,
}: {
  lines: readonly NarrationLine[];
  count?: number;
}) {
  const recent = lines.slice(-count).reverse();
  return (
    <section aria-label="Recent events" data-testid="recent-log">
      {recent.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing has happened yet.</p>
      ) : (
        <ol className="flex flex-col gap-1 text-sm leading-snug break-words">
          {recent.map((line, index) => (
            <li
              key={line.key}
              className={`border-l-4 pl-2 ${actorEdge(line)} ${index === 0 ? 'font-semibold' : ''}`}
              data-actor={line.actor ?? 'table'}
            >
              {line.text}
            </li>
          ))}
        </ol>
      )}
      <p className="ink-line-t mt-1.5 pt-1 text-xs text-ink-muted">Click for the full history</p>
    </section>
  );
}
