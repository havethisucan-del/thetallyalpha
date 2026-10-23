import { describe, expect, it } from 'vitest';
import {
  actionResultAnnouncement,
  cardCommandText,
  choiceCounterText,
  choiceKindText,
  choiceRangeText,
  commandDescription,
  opponentChoosingText,
} from '../src/match/cartignon/labels';
import type { OpponentChoice, TableCard } from '../src/match/cartignon/tableModel';

const actionId = '6f1c2b8e-3d4a-4f5b-8c9d-0e1f2a3b4c5d';

const orange = {
  cardId: 'c05',
  label: 'c05 orange L3 ATK 4',
  defId: 'C-A3',
  color: 'orange',
  summary: { kind: 'creature', color: 'orange', level: 3, atk: 4, modifiers: [] },
} as TableCard;

function opponent(overrides: Partial<OpponentChoice> = {}): OpponentChoice {
  return {
    seat: 1,
    kind: 'enemyCreature',
    spellId: 'S-01',
    min: 1,
    max: 1,
    optionCount: 3,
    ...overrides,
  };
}

describe('R8c labels', () => {
  it('names card commands and falls back to global command text', () => {
    expect(cardCommandText({ type: 'playCreature', cardId: 'c05' })).toBe('Play');
    expect(cardCommandText({ type: 'nullify', cardId: 'c05' })).toBe('Nullify');
    expect(cardCommandText({ type: 'playSpell', cardId: 'c05' })).toBe('Cast');
    expect(cardCommandText({ type: 'endTurn' })).toBe('End turn');
  });

  it('describes sent commands', () => {
    expect(commandDescription({ type: 'playCreature', cardId: 'c05' }, orange)).toBe(
      'Play Orange 3, ATK 4',
    );
    expect(commandDescription({ type: 'nullify', cardId: 'c07' }, null)).toBe('Nullify card c07');
    expect(commandDescription({ type: 'endTurn' }, null)).toBe('End turn');
    expect(
      commandDescription({ type: 'chooseSpellOption', choiceId: 2, selection: ['c01'] }, null),
    ).toBe('Choice: 1 selected');
    expect(
      commandDescription({ type: 'chooseSpellOption', choiceId: 2, selection: [] }, null),
    ).toBe('Choice: nothing selected');
  });

  it('formats the selection range and live counter', () => {
    expect(choiceRangeText(1, 1)).toBe('Choose 1');
    expect(choiceRangeText(0, 2)).toBe('Choose up to 2');
    expect(choiceRangeText(1, 3)).toBe('Choose 1–3');
    expect(choiceCounterText(1, 3, 2)).toBe('Choose 1–3 (2 selected)');
  });

  it('words choice kinds from each side', () => {
    expect(choiceKindText('handCreature', 'mine')).toBe('A creature from your hand');
    expect(choiceKindText('enemyCreature', 'theirs')).toBe('one of your creatures');
  });

  it('describes the opponent choosing, with the option count when known', () => {
    expect(opponentChoosingText(opponent())).toBe(
      'Opponent is choosing 1 of 3 options: one of your creatures.',
    );
    expect(opponentChoosingText(opponent({ min: 0, max: 2, optionCount: null }))).toBe(
      'Opponent is choosing up to 2: one of your creatures.',
    );
  });

  it('never shows an option count for handCreature (RD-142)', () => {
    const text = opponentChoosingText(opponent({ kind: 'handCreature', optionCount: 4 }));
    expect(text).toBe('Opponent is choosing 1: a creature from their hand.');
    expect(text).not.toMatch(/\d+ option/);
  });

  it('announces results politely and rejections assertively with readable reasons', () => {
    expect(
      actionResultAnnouncement({ status: 'accepted', actionId, revision: 8 }, 'End turn'),
    ).toEqual({ politeness: 'polite', text: 'End turn: done.' });
    expect(actionResultAnnouncement({ status: 'duplicate', actionId, revision: 8 }, null)).toEqual({
      politeness: 'polite',
      text: 'Action: already applied.',
    });
    expect(
      actionResultAnnouncement(
        { status: 'rejected', actionId, code: 'STALE_REVISION', message: 'stale' },
        'End turn',
      ),
    ).toEqual({
      politeness: 'assertive',
      text: 'End turn: rejected. The table changed before your action arrived. Check the table and try again.',
    });
    expect(
      actionResultAnnouncement(
        { status: 'rejected', actionId, code: 'SOMETHING_NEW', message: 'Server says no.' },
        null,
      ),
    ).toEqual({ politeness: 'assertive', text: 'Action: rejected. Server says no.' });
  });
});
