import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import {
  canConfirmChoice,
  choiceInputMode,
  choiceOffersNone,
  choiceOptionLocked,
  pickChoiceOption,
} from '../../match/cartignon/interaction';
import { choiceCounterText, choiceKindText } from '../../match/cartignon/labels';
import type { MyChoice } from '../../match/cartignon/tableModel';
import { primaryButtonClass, secondaryButtonClass } from './ActionBar';
import { CardView, CheckBadge, selectedRingClass } from './CardView';

/**
 * Bottom sheet for this seat's pending choice (R8c, RD-151): a `<fieldset>` built from the view's
 * `options`/`min`/`max` with a live counter. Radio buttons when `max = 1` (plus an explicit "None"
 * when `min = 0`), checkboxes otherwise; unchecked boxes lock at `max`. Nothing is sent until
 * Confirm, which stays disabled outside `min..max`. For `handCreature` the options are the
 * player's own hand cards, shown as such. The parent keys it by `choiceId`, so a new choice starts
 * with an empty selection.
 */

const tileBase =
  'relative block cursor-pointer rounded-md has-disabled:cursor-not-allowed ' +
  'has-disabled:opacity-50 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 ' +
  'has-focus-visible:outline-focus';

export function ChoiceSheet({
  choice,
  hidden,
  canAct,
  onConfirm,
  onHide,
}: {
  choice: MyChoice;
  /** Kept mounted while hidden so the selection survives a look at the table. */
  hidden: boolean;
  canAct: boolean;
  onConfirm: (selection: string[]) => void;
  onHide: () => void;
}) {
  const [selection, setSelection] = useState<string[]>([]);
  const legendRef = useRef<HTMLLegendElement>(null);
  const name = useId();
  const mode = choiceInputMode(choice);
  const ready = canConfirmChoice(selection, choice);

  // Move focus into the sheet whenever it is shown (a new choice or reopened after hiding).
  useEffect(() => {
    if (!hidden) legendRef.current?.focus();
  }, [hidden]);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (canAct && ready) onConfirm(selection);
  };

  return (
    <section
      hidden={hidden}
      aria-label="Your choice"
      className="ink-line rounded-lg bg-paper-raised p-3"
      data-testid="choice-sheet"
      data-choice-id={choice.choiceId}
    >
      <form onSubmit={submit} className="flex flex-col gap-2">
        <fieldset className="min-w-0">
          <legend
            ref={legendRef}
            tabIndex={-1}
            className="text-base font-semibold"
            data-testid="choice-legend"
          >
            {choiceKindText(choice.kind, 'mine')}
          </legend>
          <p
            aria-live="polite"
            className="text-sm text-ink-muted tabular-nums"
            data-testid="choice-counter"
          >
            {choiceCounterText(choice.min, choice.max, selection.length)}
          </p>
          {/* Padding keeps the selection ring inside the scroll box. */}
          <div className="flex max-h-[40dvh] flex-wrap gap-2 overflow-y-auto p-1.5">
            {choiceOffersNone(choice) && (
              <label
                className={`${tileBase} ${selection.length === 0 ? selectedRingClass : ''}`}
                data-testid="choice-option-none"
                data-selected={selection.length === 0 ? 'true' : 'false'}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name={name}
                  value=""
                  checked={selection.length === 0}
                  disabled={!canAct}
                  onChange={() => {
                    setSelection(pickChoiceOption(selection, null, choice));
                  }}
                />
                <span className="flex h-card-h w-card-w items-center justify-center ink-line rounded-md border-dashed text-sm font-semibold">
                  None
                </span>
                {selection.length === 0 && <CheckBadge />}
              </label>
            )}
            {choice.options.map((option) => {
              const checked = selection.includes(option.cardId);
              return (
                <label
                  key={option.cardId}
                  className={`${tileBase} ${checked ? selectedRingClass : ''}`}
                  data-testid={`choice-option-${option.cardId}`}
                  data-selected={checked ? 'true' : 'false'}
                >
                  <input
                    type={mode}
                    className="sr-only"
                    name={name}
                    value={option.cardId}
                    checked={checked}
                    disabled={!canAct || choiceOptionLocked(selection, option.cardId, choice)}
                    onChange={() => {
                      setSelection(pickChoiceOption(selection, option.cardId, choice));
                    }}
                  />
                  <CardView card={option} />
                  {checked && <CheckBadge />}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="flex flex-wrap justify-between gap-2">
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={onHide}
            data-testid="choice-hide"
          >
            Hide
          </button>
          <button
            type="submit"
            className={primaryButtonClass}
            disabled={!canAct || !ready}
            data-testid="choice-confirm"
          >
            Confirm
          </button>
        </div>
      </form>
    </section>
  );
}
