import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cardAriaLabel, deckPileText, graveyardPileText } from '../../match/cartignon/labels';
import type { TableCard } from '../../match/cartignon/tableModel';
import { CardBack } from './CardBack';
import { CardView } from './CardView';

/**
 * The two shared piles (RD-170): the face-down deck and the face-up graveyard, as card-sized
 * buttons. Hover or focus shows the count in a tooltip. The deck button toggles a small note with
 * the count (the deck stays count-only); the graveyard button toggles an inline panel listing its
 * cards, newest first. Escape closes an open panel and returns focus to its pile. Panels are
 * inline (not floating) so they never overflow a 375px screen.
 */

type Open = 'deck' | 'graveyard' | null;

const pileButton =
  'group relative block h-card-h w-card-w shrink-0 rounded-md focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2';

/* Count badge (always visible, so the count is never hover-only): an ink-lined paper disc in the
   caption row under the pile, clear of the card face (it used to overlap the card corner). */
const countBadge =
  'inline-flex min-w-7 items-center justify-center ink-line rounded-full bg-paper-raised px-1.5 ' +
  'text-sm leading-5 text-ink tabular-nums';

/* Visible caption under each pile: name + count badge (decorative: the button's name carries
   both). */
const pileCaption = 'flex items-center gap-1.5 text-base leading-5 text-ink';

function PileCaption({ name, count }: { name: string; count: number }) {
  return (
    <span aria-hidden="true" className={pileCaption}>
      {name}
      <span className={countBadge}>{count}</span>
    </span>
  );
}

/* Hover / focus tooltip above the pile. */
const tooltip =
  'pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap ' +
  'rounded bg-ink px-2 py-1 text-sm text-paper opacity-0 transition-opacity ' +
  'group-hover:opacity-100 group-focus-visible:opacity-100';

const panelClass = 'ink-line rounded-md bg-paper p-2';

function PileButton({
  label,
  expanded,
  controls,
  onToggle,
  testId,
  children,
}: {
  label: string;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  testId: string;
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
      <span aria-hidden="true" className={tooltip}>
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

  return (
    <div
      // An open panel takes the whole row of the center strip.
      className={`flex flex-col gap-2 ${open === null ? '' : 'basis-full'}`}
      onKeyDown={onKeyDown}
      data-testid="piles"
    >
      <div className="flex items-end gap-5 pt-1">
        <div ref={deckRef} className="flex flex-col items-center gap-1">
          <PileButton
            label={deckPileText(deckCount)}
            expanded={open === 'deck'}
            controls={deckPanelId}
            onToggle={() => {
              toggle('deck');
            }}
            testId="pile-deck"
          >
            {/* Face-down pile: an offset card back under the top back (the button names it). */}
            <span aria-hidden="true" className="absolute inset-0 translate-x-1 -translate-y-1">
              <CardBack className="rounded-md" />
            </span>
            <span aria-hidden="true" className="absolute inset-0">
              <CardBack className="rounded-md" />
            </span>
          </PileButton>
          <PileCaption name="Deck" count={deckCount} />
        </div>
        <div ref={graveRef} className="flex flex-col items-center gap-1">
          <PileButton
            label={graveyardPileText(graveyard.length)}
            expanded={open === 'graveyard'}
            controls={gravePanelId}
            onToggle={() => {
              toggle('graveyard');
            }}
            testId="pile-graveyard"
          >
            <span aria-hidden="true" className="absolute inset-0">
              {top ? (
                // Full opacity: a dimmed top card failed contrast on its own text.
                <span className="block">
                  <CardView card={top} preview={false} />
                </span>
              ) : (
                <span className="flex h-card-h w-card-w items-center justify-center ink-line rounded-md border-dashed text-[10px] text-ink-muted">
                  Empty
                </span>
              )}
            </span>
          </PileButton>
          <PileCaption name="Graveyard" count={graveyard.length} />
        </div>
      </div>

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
            <ol
              className="flex max-h-60 flex-wrap gap-2 overflow-y-auto p-0.5"
              data-testid="graveyard-list"
            >
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
  );
}
