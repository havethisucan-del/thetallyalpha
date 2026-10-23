import type { CartignonCommand } from '@cartignon/protocol';
import {
  cardAriaLabel,
  cardCommandText,
  choiceRangeText,
  globalCommandText,
  splitGlobalCommands,
} from '../../match/cartignon/labels';
import type { HandCard, LegalRef, MyChoice } from '../../match/cartignon/tableModel';

/**
 * Thumb-zone action bar (R8c). With a hand card selected, a first row offers only that card's
 * legal commands (server-listed `legal` entries, sent unchanged). The second row keeps the global
 * commands (Mulligan left, End turn right) and, while this seat has a pending choice whose
 * sheet is hidden, the button that reopens it. Rows wrap instead of overflowing.
 */

const buttonBase =
  'inline-flex min-h-bar min-w-target items-center justify-center rounded-md px-4 text-xl ' +
  'leading-none tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-50';
export const primaryButtonClass =
  `${buttonBase} ink-line bg-turn text-on-turn hover:bg-turn-hover ` + 'disabled:hover:bg-turn';
/* End turn is the one button every turn needs: bold, wider and set off on the right edge. */
const endTurnButtonClass = `${primaryButtonClass} min-w-32 font-bold tracking-wide`;
export const secondaryButtonClass =
  `${buttonBase} ink-line bg-paper-raised text-ink hover:bg-paper-sunken ` +
  'disabled:hover:bg-paper-raised';

export function ActionBar({
  commands,
  selectedCard,
  myChoice,
  choiceOpen,
  canAct,
  onCommand,
  onClearSelection,
  onOpenChoice,
}: {
  commands: readonly LegalRef[];
  /** The tapped hand card, or null. */
  selectedCard: HandCard | null;
  myChoice: MyChoice | null;
  /** Whether the choice sheet is shown (then the bar hides the "Choose" button). */
  choiceOpen: boolean;
  canAct: boolean;
  onCommand: (command: CartignonCommand) => void;
  onClearSelection: () => void;
  onOpenChoice: () => void;
}) {
  const showChoose = myChoice !== null && !choiceOpen;
  // Nothing to offer: no empty strip (the turn banner already says who acts).
  if (commands.length === 0 && !showChoose && selectedCard === null) return null;
  const { secondary, primary } = splitGlobalCommands(commands);
  const button = (ref: LegalRef, className: string) => (
    <button
      // Legal entries have no id of their own; the server-ordered index is stable per view.
      key={ref.index}
      type="button"
      className={className}
      disabled={!canAct}
      onClick={() => {
        onCommand(ref.command);
      }}
      data-testid={`global-${ref.command.type}`}
    >
      {globalCommandText(ref.command)}
    </button>
  );

  return (
    <div className="flex flex-col gap-2" data-testid="action-bar">
      {selectedCard && (
        <CardActions
          card={selectedCard}
          canAct={canAct}
          onCommand={onCommand}
          onClear={onClearSelection}
        />
      )}
      {(commands.length > 0 || showChoose) && (
        <div className="flex min-h-bar flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {secondary.map((ref) => button(ref, secondaryButtonClass))}
          </div>
          <div className="flex flex-wrap gap-2">
            {showChoose && (
              <button
                type="button"
                className={primaryButtonClass}
                onClick={onOpenChoice}
                // Mounted only after the player hides the sheet: focus returns here.
                autoFocus
                data-testid="open-choice"
              >
                {choiceRangeText(myChoice.min, myChoice.max)}…
              </button>
            )}
            {primary.map((ref) =>
              button(ref, ref.command.type === 'endTurn' ? endTurnButtonClass : primaryButtonClass),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The selected card's legal commands, or a note that it has none right now. */
function CardActions({
  card,
  canAct,
  onCommand,
  onClear,
}: {
  card: HandCard;
  canAct: boolean;
  onCommand: (command: CartignonCommand) => void;
  onClear: () => void;
}) {
  const name = cardAriaLabel(card);
  return (
    <div
      role="group"
      aria-label={`Actions for ${name}`}
      className="flex min-h-bar flex-wrap items-center justify-between gap-2"
      data-testid="card-actions"
    >
      <div className="flex flex-wrap items-center gap-2">
        {card.commands.length === 0 ? (
          <p className="text-sm text-ink-muted" data-testid="no-card-actions">
            No move for this card now.
          </p>
        ) : (
          card.commands.map((ref) => (
            <button
              key={ref.index}
              type="button"
              className={primaryButtonClass}
              disabled={!canAct}
              aria-label={`${cardCommandText(ref.command)} ${name}`}
              onClick={() => {
                onCommand(ref.command);
              }}
              data-testid={`card-${ref.command.type}`}
            >
              {cardCommandText(ref.command)}
            </button>
          ))
        )}
      </div>
      <button
        type="button"
        className={secondaryButtonClass}
        aria-label={`Deselect ${name}`}
        onClick={onClear}
        data-testid="card-deselect"
      >
        Deselect
      </button>
    </div>
  );
}
