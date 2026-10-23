import { describe, expect, it } from 'vitest';
import type { ClockReading } from '../src/match/cartignon/clock';
import {
  cardAriaLabel,
  clockAriaLabel,
  clockText,
  clockWarn,
  globalCommandText,
  liveModifierText,
  phaseText,
  scrollEdges,
  spellNameSize,
  splitGlobalCommands,
  stackAriaLabel,
  tokenAriaLabel,
  tokenCount,
  tokenOwnerText,
  turnBannerText,
} from '../src/match/cartignon/labels';
import type { LegalRef, TableCard, TokenView } from '../src/match/cartignon/tableModel';

function creature(modifiers: string[] = []): TableCard {
  return {
    cardId: 'c05',
    label: 'c05 orange L3 ATK 4',
    color: 'orange',
    summary: { kind: 'creature', color: 'orange', level: 3, atk: 4, modifiers },
  } as TableCard;
}

function reading(overrides: Partial<ClockReading> = {}): ClockReading {
  return {
    seat: 0,
    mode: 'turn',
    paused: false,
    remainingMs: 52_000,
    pauseLeftMs: 60_000,
    pauseLeftBySeat: [60_000, 60_000],
    consecutiveTimeouts: [0, 0],
    isMine: true,
    warn: false,
    expired: false,
    ...overrides,
  };
}

describe('Cartignon table labels', () => {
  it('names creature cards by color, letter, level and ATK', () => {
    expect(cardAriaLabel(creature())).toBe('Orange 3, ATK 4');
    expect(cardAriaLabel(creature(['buffSelf', 'linkUp']))).toBe(
      'Orange 3, ATK 4, Buff self, Link up',
    );
  });

  it('names spells and unknown cards', () => {
    const spell = {
      cardId: 'c02',
      label: 'c02 spell "Swap"',
      color: null,
      summary: { kind: 'spell', name: 'Swap' },
    } as TableCard;
    expect(cardAriaLabel(spell)).toBe('Spell Swap');
    expect(cardAriaLabel({ ...spell, summary: { kind: 'spell', name: '' } })).toBe('Spell');
    expect(
      cardAriaLabel({ cardId: 'c99', label: 'c99', defId: null, color: null, summary: null }),
    ).toBe('Card c99');
  });

  it('describes stacks with their size and reading order', () => {
    expect(stackAriaLabel('mine', 0)).toBe('Your stack, empty');
    expect(stackAriaLabel('theirs', 1)).toBe('Opponent stack, 1 card, bottom to top');
    expect(stackAriaLabel('mine', 3)).toBe('Your stack, 3 cards, bottom to top');
  });

  it('names tokens and counts them per side', () => {
    const tokens: TokenView[] = [
      { color: 'orange', owner: 0, side: 'mine' },
      { color: 'green', owner: 1, side: 'theirs' },
      { color: 'red', owner: null, side: null },
      { color: 'blue', owner: 0, side: 'mine' },
    ];
    expect(tokens.map(tokenAriaLabel)).toEqual([
      'Orange token, yours',
      "Green token, opponent's",
      'Red token, unclaimed',
      'Blue token, yours',
    ]);
    expect(tokens.map((token) => tokenOwnerText(token.side))).toEqual([
      'You',
      'Opp',
      'Free',
      'You',
    ]);
    expect(tokenCount(tokens, 'mine')).toBe(2);
    expect(tokenCount(tokens, 'theirs')).toBe(1);
  });

  it('labels phases and live modifiers', () => {
    expect(phaseText('p2Opening')).toBe('Opening');
    expect(phaseText('roundOver')).toBe('Round over');
    expect(
      liveModifierText({ seat: 1, side: 'theirs', cardId: 'c22', kind: 'buffSelf', position: 2 }),
    ).toBe('Opponent Buff self (c22)');
    expect(
      liveModifierText({ seat: 0, side: 'mine', cardId: 'c10', kind: 'drawGrave', position: 0 }),
    ).toBe('Your Draw from graveyard (c10)');
  });

  it('labels global commands and puts End turn on the primary side', () => {
    const refs: LegalRef[] = [
      { index: 0, command: { type: 'endTurn' } },
      { index: 1, command: { type: 'mulligan' } },
    ];
    expect(refs.map((ref) => globalCommandText(ref.command))).toEqual(['End turn', 'Mulligan']);
    const { secondary, primary } = splitGlobalCommands(refs);
    expect(secondary.map((ref) => ref.index)).toEqual([1]);
    expect(primary.map((ref) => ref.index)).toEqual([0]);
  });

  it('says who must act in the turn banner', () => {
    const base = {
      finished: false,
      myAction: false,
      myChoice: null,
      activeSeat: null,
      opponentChoosing: null,
    } as const;
    const choice = { choiceId: 1, kind: 'keepDrawn', spellId: 'S-01', options: [], min: 1, max: 1 };
    const theirs = { seat: 1, kind: 'handCreature', spellId: 'S-10', min: 1, max: 1 };
    expect(turnBannerText({ ...base, finished: true, myAction: true })).toBe('Match over');
    expect(turnBannerText({ ...base, myAction: true, activeSeat: 0 })).toBe('Your turn');
    expect(
      turnBannerText({ ...base, myAction: true, activeSeat: 0, myChoice: choice } as never),
    ).toBe('Your choice');
    expect(turnBannerText(base)).toBe('Waiting');
    expect(turnBannerText({ ...base, activeSeat: 1 })).toBe("Opponent's turn");
    expect(
      turnBannerText({
        ...base,
        activeSeat: 1,
        opponentChoosing: { ...theirs, optionCount: null },
      } as never),
    ).toBe('Opponent is choosing');
  });

  it('formats the clock and its accessible name', () => {
    expect(clockText(reading())).toBe('0:52');
    expect(clockAriaLabel(reading())).toBe('Your turn clock, 0:52 left');
    expect(clockAriaLabel(reading({ isMine: false, mode: 'choice' }))).toBe(
      'Opponent choice clock, 0:52 left',
    );
    const paused = reading({ paused: true, isMine: false, pauseLeftMs: 45_000 });
    expect(clockText(paused)).toBe('Paused 0:45');
    expect(clockAriaLabel(paused)).toBe(
      'Opponent turn clock paused while disconnected, 0:45 pause left',
    );
  });

  it('warns on the displayed value: remaining time, or the pause budget while paused', () => {
    expect(clockWarn(reading({ warn: true, remainingMs: 9_000 }))).toBe(true);
    expect(clockWarn(reading())).toBe(false);
    expect(clockWarn(reading({ paused: true, warn: true, pauseLeftMs: 30_000 }))).toBe(false);
    expect(clockWarn(reading({ paused: true, pauseLeftMs: 5_000 }))).toBe(true);
  });

  it('sizes spell names so long words shrink instead of breaking mid-word', () => {
    expect(spellNameSize('Swap')).toBe('normal');
    expect(spellNameSize('Mirror Ward')).toBe('normal');
    expect(spellNameSize('Undermine')).toBe('small');
    expect(spellNameSize("Underdog's Stand")).toBe('small');
    expect(spellNameSize('Last-minute')).toBe('normal');
    expect(spellNameSize('One two three four five six')).toBe('small');
    expect(spellNameSize('')).toBe('normal');
  });

  it('reports which scroller edges hide content', () => {
    expect(scrollEdges(0, 300, 300)).toEqual({ start: false, end: false });
    expect(scrollEdges(0, 500, 300)).toEqual({ start: false, end: true });
    expect(scrollEdges(100, 500, 300)).toEqual({ start: true, end: true });
    expect(scrollEdges(200, 500, 300)).toEqual({ start: true, end: false });
    expect(scrollEdges(199.5, 500, 300)).toEqual({ start: true, end: false });
  });
});
