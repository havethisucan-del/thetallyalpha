import { describe, expect, it } from 'vitest';
import {
  deckPileText,
  graveyardPileText,
  phaseText,
  roundOutcomeText,
  roundOverText,
  spellHintBadge,
  spellHintText,
  spellReasonText,
} from '../src/match/cartignon/labels';

/** Labels for RD-169 (single End Turn), RD-170 (piles) and RD-171 (spell hints). */

describe('round-over texts (RD-169)', () => {
  it('explains each reason from this seat', () => {
    expect(
      roundOverText({ reason: 'opponentAhead', endedBy: 'mine', iAmP1: true, atk: [5, 9] }),
    ).toBe('You ended the turn while behind (ATK 5 vs 9) — your opponent wins the round.');
    expect(
      roundOverText({ reason: 'equalStall', endedBy: 'theirs', iAmP1: true, atk: [6, 6] }),
    ).toBe(
      'Tie: your opponent ended the turn at equal ATK without playing (ATK 6 vs 6) — a tie-break decides the round.',
    );
    expect(roundOverText({ reason: 'p1NoBase', endedBy: 'mine', iAmP1: true, atk: [0, 0] })).toBe(
      'You (P1) had no Base creature to play — the round is a draw.',
    );
  });

  it('explains resolved rounds', () => {
    expect(
      roundOutcomeText({
        kind: 'win',
        winner: 'theirs',
        decidedBy: 'opponentAhead',
        atk: [4, 7],
        tieBreakIterations: 0,
      }),
    ).toBe('Your opponent won the round: you ended the turn while behind (ATK 4 vs 7).');
    expect(
      roundOutcomeText({
        kind: 'win',
        winner: 'mine',
        decidedBy: 'tieBreak',
        atk: [9, 6],
        tieBreakIterations: 1,
      }),
    ).toBe('You won the round on the tie-break (ATK 9 vs 6).');
    expect(
      roundOutcomeText({ kind: 'draw', reason: 'p1NoBase', atk: [0, 0], tieBreakIterations: 0 }),
    ).toBe('The round was a draw: P1 had no Base creature to play.');
  });

  it('has no fold phase any more', () => {
    expect(phaseText('turn')).toBe('Turn');
    expect(phaseText('roundOver')).toBe('Round over');
  });
});

describe('spell hints (RD-171)', () => {
  it('names the effect that fires now', () => {
    const primary = { branch: 'primary', castable: true, reason: null } as const;
    expect(spellHintBadge(primary)).toBe('Primary');
    expect(spellHintText(primary)).toBe('Cast now: primary effect.');
  });

  it('adds a readable reason when not castable', () => {
    const hint = { branch: 'secondary', castable: false, reason: 'NOT_YOUR_TURN' } as const;
    expect(spellHintBadge(hint)).toBe('Secondary');
    expect(spellHintText(hint)).toBe(
      'On this board: secondary effect. Not castable now: It is not your turn.',
    );
    expect(spellReasonText('SOMETHING_NEW')).toBe('Cannot be cast now (SOMETHING_NEW).');
  });

  it('marks spells this build cannot play', () => {
    const hint = { branch: null, castable: false, reason: 'SPELL_NOT_SUPPORTED' } as const;
    expect(spellHintBadge(hint)).toBe('Unavailable');
    expect(spellHintText(hint)).toBe('This spell cannot be played yet.');
  });
});

describe('pile texts (RD-170)', () => {
  it('counts cards', () => {
    expect(deckPileText(21)).toBe('Deck: 21 cards');
    expect(graveyardPileText(1)).toBe('Graveyard: 1 card');
  });
});
