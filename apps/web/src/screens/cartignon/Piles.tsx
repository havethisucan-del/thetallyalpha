import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cardAriaLabel, deckPileText, graveyardPileText } from '../../match/cartignon/labels';
import type { TableCard } from '../../match/cartignon/tableModel';
import { CardBack } from './CardBack';
import { CardView } from './CardView';

/**
 * The two shared piles (RD-170) at the ends of the middle line (`.ct-pile*` in table.css): the
 * graveyard on the left, face up with its top card showing, and the face-down deck on the right,
 * both drawn as physical piles (a few offset layers under the top card, more for a thicker pile).
 * A small number under each pile gives the count. Each pile is a button: the deck toggles a small
 * note with the count, the graveyard a popover listing its cards, newest first. Escape closes an
 * open popover and returns focus to its pile.
 */

type Open = 'deck' | 'graveyard' | null;

const pileButton =
  'group relative block h-card-h w-card-w shrink-0 rounded-md focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2';

/* Hover / focus tooltip beside the pile, towards the table centre. */
const tooltip =
  'pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 whitespace-nowrap rounded bg-ink ' +
  'px-2 py-1 text-sm text-paper opacity-0 transition-opacity group-hover:opacity-100 ' +
  'group-focus-visible:opacity-100';

const panelClass = 'ct-popover ink-line rounded-md bg-paper-raised p-2 text-ink shadow-lg';

/** Layers under the top card: 0 to 2, so the pile looks as thick as it is. */
function underLayers(count: number): number {
  if (count <= 1) return 0;
  return count < 8 ? 1 : 2;
}

function PileButton({
  label,
  expanded,
  controls,
  onToggle,
  testId,
  tooltipSide,
  children,
}: {
  label: string;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  testId: string;
  tooltipSide: 'left' | 'right';
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={pileButton}
      // The tooltip repeats this text visually; the name carries it for assistive tech.
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      data-testid={testId}
    >
      {children}
      <span
        aria-hidden="true"
        className={`${tooltip} ${tooltipSide === 'right' ? 'left-full ml-2' : 'right-full mr-2'}`}
      >
        {label}
      </span>
    </button>
  );
}

export function Piles({
  deckCount,
  graveyard,
}: {
  deckCount: number;
  /** Oldest first, as the view sends it. */
  graveyard: readonly TableCard[];
}) {
  const [open, setOpen] = useState<Open>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const graveRef = useRef<HTMLDivElement>(null);
  const deckPanelId = useId();
  const gravePanelId = useId();
  const top = graveyard.at(-1) ?? null;
  const newestFirst = [...graveyard].reverse();

  const toggle = (which: Exclude<Open, null>) => {
    setOpen((current) => (current === which ? null : which));
  };

  // Escape closes the open panel and returns focus to its pile button.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || open === null) return;
    event.stopPropagation();
    const ref = open === 'deck' ? deckRef : graveRef;
    setOpen(null);
    ref.current?.querySelector('button')?.focus();
  };

  // Move focus into the graveyard panel when it opens (its close button), for keyboard users.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open === 'graveyard') closeRef.current?.focus();
  }, [open]);

  const layer = (index: number, children: ReactNode) => (
    <span
      key={index}
      aria-hidden="true"
      className="ct-pile-layer"
      style={{ transform: `translate(${index * -3}px, ${index * 3}px)` }}
    >
      {children}
    </span>
  );

  return (
    // No box of its own: the two piles sit at the two ends of the middle line.
    <div className="contents" onKeyDown={onKeyDown} data-testid="piles">
      <div ref={graveRef} className="ct-pile ct-pile-grave">
        <PileButton
          label={graveyardPileText(graveyard.length)}
          expanded={open === 'graveyard'}
          controls={gravePanelId}
          onToggle={() => {
            toggle('graveyard');
          }}
          testId="pile-graveyard"
          tooltipSide="right"
        >
          {Array.from({ length: underLayers(graveyard.length) }, (_, i) =>
            layer(
              underLayers(graveyard.length) - i,
              <span className="block h-full w-full rounded-md bg-paper-sunken ink-line" />,
            ),
          )}
          {layer(
            0,
            top ? (
              // Full opacity: a dimmed top card failed contrast on its own text.
              <CardView card={top} preview={false} />
            ) : (
              <span className="flex h-full w-full items-center justify-center rounded-md border-2 border-dashed border-ink-muted text-[10px] text-ink-muted">
                Empty
              </span>
            ),
          )}
        </PileButton>
        <span aria-hidden="true" className="ct-pile-count">
          {graveyard.length}
        </span>
        {open === 'graveyard' && (
          <section
            id={gravePanelId}
            aria-label={`${graveyardPileText(graveyard.length)}, newest first`}
            className={panelClass}
            data-testid="graveyard-panel"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                {graveyardPileText(graveyard.length)}{' '}
                <span className="font-normal text-ink-muted">(newest first)</span>
              </h3>
              <button
                ref={closeRef}
                type="button"
                className="ink-line min-h-target min-w-target rounded-md px-2 text-sm font-semibold"
                onClick={() => {
                  setOpen(null);
                  graveRef.current?.querySelector('button')?.focus();
                }}
                data-testid="graveyard-close"
              >
                Close
              </button>
            </div>
            {newestFirst.length === 0 ? (
              <p className="text-sm text-ink-muted">The graveyard is empty.</p>
            ) : (
              <ol className="flex flex-wrap gap-2 p-0.5" data-testid="graveyard-list">
                {newestFirst.map((card) => (
                  <li key={card.cardId} className="shrink-0">
                    <CardView card={card} ariaLabel={cardAriaLabel(card)} focusable />
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </div>

      <div ref={deckRef} className="ct-pile ct-pile-deck">
        <PileButton
          label={deckPileText(deckCount)}
          expanded={open === 'deck'}
          controls={deckPanelId}
          onToggle={() => {
            toggle('deck');
          }}
          testId="pile-deck"
          tooltipSide="left"
        >
          {deckCount === 0 ? (
            <span className="ct-pile-layer flex items-center justify-center border-2 border-dashed border-ink-muted text-[10px] text-ink-muted">
              Empty
            </span>
          ) : (
            Array.from({ length: underLayers(deckCount) + 1 }, (_, i) =>
              layer(underLayers(deckCount) - i, <CardBack className="rounded-md" />),
            )
          )}
        </PileButton>
        <span aria-hidden="true" className="ct-pile-count">
          {deckCount}
        </span>
        {open === 'deck' && (
          <p
            id={deckPanelId}
            role="status"
            className={`${panelClass} text-sm`}
            data-testid="deck-panel"
          >
            {deckPileText(deckCount)} (shared, face down).
          </p>
        )}
      </div>
    </div>
  );
}
