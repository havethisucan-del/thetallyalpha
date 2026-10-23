import { describe, expect, it } from 'vitest';
import {
  canConfirmChoice,
  choiceInputMode,
  choiceOffersNone,
  choiceOptionLocked,
  pickChoiceOption,
  selectedHandCard,
  tapHandCard,
} from '../src/match/cartignon/interaction';
import type { HandCard, MyChoice, TableCard } from '../src/match/cartignon/tableModel';

function card(cardId: string): TableCard {
  return { cardId, label: cardId, defId: null, summary: null, color: null };
}

function choice(min: number, max: number, ids = ['c01', 'c02', 'c03']) {
  return { options: ids.map(card), min, max } satisfies Pick<MyChoice, 'options' | 'min' | 'max'>;
}

const hand: HandCard[] = [
  {
    ...card('c01'),
    commands: [{ index: 0, command: { type: 'playCreature', cardId: 'c01' } }],
    spellHint: null,
  },
  { ...card('c02'), commands: [], spellHint: null },
];

describe('tap-select', () => {
  it('selects a card, clears it on a second tap and switches to another card', () => {
    expect(tapHandCard(null, 'c01')).toBe('c01');
    expect(tapHandCard('c01', 'c01')).toBeNull();
    expect(tapHandCard('c01', 'c02')).toBe('c02');
  });

  it('resolves the selected card from the hand; a card that left the hand selects nothing', () => {
    expect(selectedHandCard(hand, 'c01')?.commands).toHaveLength(1);
    expect(selectedHandCard(hand, 'c09')).toBeNull();
    expect(selectedHandCard(hand, null)).toBeNull();
  });
});

describe('choice selection', () => {
  it('uses radio buttons when max is 1 and checkboxes otherwise', () => {
    expect(choiceInputMode({ max: 1 })).toBe('radio');
    expect(choiceInputMode({ max: 2 })).toBe('checkbox');
  });

  it('replaces the selection in radio mode', () => {
    const single = choice(1, 1);
    expect(pickChoiceOption([], 'c02', single)).toEqual(['c02']);
    expect(pickChoiceOption(['c02'], 'c03', single)).toEqual(['c03']);
  });

  it('toggles in option order in checkbox mode and never grows beyond max', () => {
    const multi = choice(1, 2);
    expect(pickChoiceOption(['c03'], 'c01', multi)).toEqual(['c01', 'c03']);
    expect(pickChoiceOption(['c01', 'c03'], 'c02', multi)).toEqual(['c01', 'c03']);
    expect(pickChoiceOption(['c01', 'c03'], 'c01', multi)).toEqual(['c03']);
  });

  it('ignores cards that are not offered and clears on the "none" radio', () => {
    expect(pickChoiceOption(['c01'], 'c99', choice(1, 2))).toEqual(['c01']);
    expect(pickChoiceOption(['c01'], null, choice(0, 1))).toEqual([]);
  });

  it('locks unchecked boxes at max, never radios', () => {
    expect(choiceOptionLocked(['c01', 'c02'], 'c03', choice(1, 2))).toBe(true);
    expect(choiceOptionLocked(['c01', 'c02'], 'c01', choice(1, 2))).toBe(false);
    expect(choiceOptionLocked(['c01'], 'c03', choice(1, 2))).toBe(false);
    expect(choiceOptionLocked(['c01'], 'c02', choice(1, 1))).toBe(false);
  });

  it('allows Confirm only within min..max', () => {
    const range = choice(1, 2);
    expect(canConfirmChoice([], range)).toBe(false);
    expect(canConfirmChoice(['c01'], range)).toBe(true);
    expect(canConfirmChoice(['c01', 'c02'], range)).toBe(true);
    expect(canConfirmChoice(['c01', 'c02', 'c03'], range)).toBe(false);
    expect(canConfirmChoice(['c99'], range)).toBe(false);
    expect(canConfirmChoice([], choice(0, 1))).toBe(true);
  });

  it('offers an explicit "none" only for optional single choices', () => {
    expect(choiceOffersNone({ min: 0, max: 1 })).toBe(true);
    expect(choiceOffersNone({ min: 1, max: 1 })).toBe(false);
    expect(choiceOffersNone({ min: 0, max: 2 })).toBe(false);
  });
});
