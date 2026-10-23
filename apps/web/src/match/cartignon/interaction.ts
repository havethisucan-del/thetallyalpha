import { toggleSelection, validateSelection } from '../../lib/cartignon';
import type { HandCard, MyChoice } from './tableModel';

/**
 * Pure interaction helpers for the Cartignon table (R8c): tap-select of hand cards and the choice
 * sheet's selection. No rules are computed here: card commands come from `private.legal` (via the
 * table model) and a choice selection is only checked against the view's `options`/`min`/`max`;
 * the server validates every command again.
 */

/** The selected hand card, or null when nothing is selected or the card left the hand. */
export function selectedHandCard(
  hand: readonly HandCard[],
  selectedId: string | null,
): HandCard | null {
  if (selectedId === null) return null;
  return hand.find((card) => card.cardId === selectedId) ?? null;
}

/** Tap on a hand card: selects it, or clears the selection when it was already selected. */
export function tapHandCard(selectedId: string | null, cardId: string): string | null {
  return selectedId === cardId ? null : cardId;
}

type ChoiceShape = Pick<MyChoice, 'options' | 'min' | 'max'>;

function optionIds(choice: ChoiceShape): string[] {
  return choice.options.map((option) => option.cardId);
}

/** Radio buttons when at most one card may be chosen, checkboxes otherwise (RD-151). */
export function choiceInputMode(choice: Pick<MyChoice, 'max'>): 'radio' | 'checkbox' {
  return choice.max <= 1 ? 'radio' : 'checkbox';
}

/**
 * The selection after picking `cardId` (null = the explicit "none" radio). Radio mode replaces the
 * selection; checkbox mode toggles the card, keeps option order and never grows beyond `max`.
 */
export function pickChoiceOption(
  selection: readonly string[],
  cardId: string | null,
  choice: ChoiceShape,
): string[] {
  const ids = optionIds(choice);
  if (cardId === null) return [];
  if (!ids.includes(cardId)) return [...selection];
  if (choiceInputMode(choice) === 'radio') return [cardId];
  const next = toggleSelection(selection, cardId, ids);
  return next.length > choice.max ? [...selection] : next;
}

/** Whether an unselected option is disabled because the selection is already at `max`. */
export function choiceOptionLocked(
  selection: readonly string[],
  cardId: string,
  choice: ChoiceShape,
): boolean {
  return (
    choiceInputMode(choice) === 'checkbox' &&
    !selection.includes(cardId) &&
    selection.length >= choice.max
  );
}

/** Confirm is enabled only for a selection of offered cards whose size is within `min..max`. */
export function canConfirmChoice(selection: readonly string[], choice: ChoiceShape): boolean {
  return (
    validateSelection(selection, {
      options: optionIds(choice),
      min: choice.min,
      max: choice.max,
    }) === null
  );
}

/** Radio mode with `min = 0` offers an explicit "none" option (a radio cannot be unticked). */
export function choiceOffersNone(choice: Pick<MyChoice, 'min' | 'max'>): boolean {
  return choice.min === 0 && choice.max <= 1;
}
