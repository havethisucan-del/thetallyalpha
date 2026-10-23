import type { NarrationLine } from '../../match/cartignon/narration';

/**
 * Compact action log on the table: narrated events (`narrateEvents`), newest first, in a short
 * box that scrolls internally (it never widens the layout; long sentences wrap). Own actions are
 * marked with a turn-coloured edge, the opponent's with a neutral one. `role="log"` lets screen
 * readers follow new lines; the box is focusable so keyboard users can scroll it.
 */
export function ActionLog({ lines }: { lines: readonly NarrationLine[] }) {
  const newestFirst = [...lines].reverse();
  return (
    <section
      aria-labelledby="action-log-heading"
      className="ink-line rounded-md bg-paper-raised p-2"
      data-testid="action-log"
    >
      <h2
        id="action-log-heading"
        className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted"
      >
        Log <span className="font-normal normal-case">(newest first)</span>
      </h2>
      {newestFirst.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing has happened yet.</p>
      ) : (
        <ol
          role="log"
          aria-labelledby="action-log-heading"
          // Focusable scroll box (keyboard scrolling); about four lines tall.
          tabIndex={0}
          className="flex max-h-24 flex-col gap-1 overflow-y-auto text-sm leading-snug break-words md:max-h-36"
          data-testid="action-log-list"
        >
          {newestFirst.map((line, index) => (
            <li
              key={line.key}
              className={`border-l-4 pl-2 ${
                line.actor === 'mine'
                  ? 'border-turn'
                  : line.actor === 'theirs'
                    ? // >= 3:1 against the log surface in both themes (WCAG 1.4.11).
                      'border-ink-muted'
                    : 'border-transparent'
              } ${index === 0 ? 'font-semibold' : ''}`}
              data-actor={line.actor ?? 'table'}
            >
              {line.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
