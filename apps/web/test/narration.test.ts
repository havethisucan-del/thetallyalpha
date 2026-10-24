import type { CartignonPublicView, CartignonSeatEvent } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import type { EventLogEntry } from '../src/lib/cartignon';
import { narrateEvents, narrationCardName } from '../src/match/cartignon/narration';
import {
  DRAW_NO_TOKENS,
  RULE_BEHIND,
  RULE_STALL,
  RULE_TIE_BREAK,
} from '../src/match/cartignon/roundAccount';

/** Only the card tables matter for narration; the rest of the view is unused. */
const pub = {
  cardDefs: { c01: 'orange-3', c05: 'bargain', c06: 'prism', c07: 'blue-2' },
  defs: {
    'orange-3': { kind: 'creature', color: 'orange', level: 3, atk: 4, modifiers: [] },
    'blue-2': { kind: 'creature', color: 'blue', level: 2, atk: 3, modifiers: [] },
    bargain: { kind: 'spell', name: 'Grave Bargain' },
    prism: { kind: 'spell', name: 'Gambit Prism' },
  },
} as unknown as CartignonPublicView;

function log(...steps: CartignonSeatEvent[][]): EventLogEntry[] {
  return steps.flatMap((events, step) =>
    events.map((event, index) => ({ key: `${step + 1}:${index}`, revision: step + 1, event })),
  );
}

function texts(entries: EventLogEntry[], seat: 0 | 1 = 0): string[] {
  return narrateEvents(entries, pub, seat).map((line) => line.text);
}

describe('narrateEvents', () => {
  it('names cards briefly', () => {
    expect(narrationCardName(pub, 'c01')).toBe('Orange 3 (ATK 4)');
    expect(narrationCardName(pub, 'c05')).toBe('"Grave Bargain"');
    expect(narrationCardName(pub, 'c99')).toBe('card c99');
  });

  it('folds spell draws into the spell sentence, naming only own drawn cards', () => {
    const entries = log([
      { type: 'spellPlayed', seat: 0, cardId: 'c05', branch: 'primary' },
      { type: 'cardsDrawn', seat: 0, reason: 'spellGraveyard', cardIds: [] },
      { type: 'spellDrawResolved', seat: 0, from: 'graveyard', requested: 2, drawn: 0 },
      { type: 'cardsDrawn', seat: 1, reason: 'spellDeck', count: 1 },
      { type: 'spellDrawResolved', seat: 1, from: 'deck', requested: 1, drawn: 1 },
      { type: 'spellResolved', seat: 0, cardId: 'c05', destination: 'graveyard' },
    ]);
    expect(texts(entries)).toEqual([
      'You cast "Grave Bargain" (primary effect): you drew 0 of 2 from the graveyard ' +
        '(graveyard empty); opponent drew 1 card from the deck.',
    ]);
  });

  it('names own drawn cards and says when the source ran short', () => {
    const entries = log([
      { type: 'spellPlayed', seat: 0, cardId: 'c05', branch: 'secondary' },
      { type: 'cardsDrawn', seat: 0, reason: 'spellGraveyard', cardIds: ['c07'] },
      { type: 'spellDrawResolved', seat: 0, from: 'graveyard', requested: 2, drawn: 1 },
    ]);
    expect(texts(entries)).toEqual([
      'You cast "Grave Bargain" (secondary effect): you drew 1 of 2 from the graveyard ' +
        '(graveyard ran out) — Blue 2 (ATK 3).',
    ]);
  });

  it('tells the opponent side without revealing their drawn cards', () => {
    const entries = log([
      { type: 'spellPlayed', seat: 1, cardId: 'c05', branch: 'primary' },
      // A malformed id-carrying event for the other seat must still not be named.
      { type: 'cardsDrawn', seat: 1, reason: 'spellDeck', cardIds: ['c07'] },
      { type: 'spellDrawResolved', seat: 1, from: 'deck', requested: 1, drawn: 1 },
    ]);
    const [line] = narrateEvents(entries, pub, 0);
    expect(line?.text).toBe(
      'Opponent cast "Grave Bargain" (primary effect): opponent drew 1 card from the deck.',
    );
    expect(line?.actor).toBe('theirs');
    expect(line?.text).not.toContain('Blue');
  });

  it('narrates a spell cast through Gambit Prism', () => {
    const entries = log([
      { type: 'spellPlayed', seat: 0, cardId: 'c06', branch: 'primary' },
      { type: 'spellPlayed', seat: 1, cardId: 'c05', branch: 'primary', playedVia: 'c06' },
      { type: 'spellDrawResolved', seat: 1, from: 'graveyard', requested: 2, drawn: 2 },
    ]);
    expect(texts(entries)).toEqual([
      'You cast "Gambit Prism" (primary effect).',
      'Opponent cast "Grave Bargain" through your "Gambit Prism" (primary effect): ' +
        'opponent drew 2 cards from the graveyard.',
    ]);
  });

  it('explains End Turn and the round result in plain words (RD-169)', () => {
    const entries = log(
      [{ type: 'creaturePlayed', seat: 0, cardId: 'c01', role: 'stack' }],
      [
        { type: 'turnEnded', seat: 1 },
        { type: 'roundOver', reason: 'opponentAhead', seat: 1, atk: [9, 5] },
        {
          type: 'roundResolved',
          outcome: {
            kind: 'win',
            winner: 0,
            decidedBy: 'opponentAhead',
            atk: [9, 5],
            tieBreakIterations: 0,
          },
        },
        {
          type: 'tokenChanged',
          change: { seat: 0, color: 'orange', kind: 'awarded', leadingCardId: 'c01' },
        },
      ],
    );
    expect(texts(entries)).toEqual([
      'You played Orange 3 (ATK 4) onto your stack.',
      'Opponent ended their turn.',
      // `roundResolved` repeats what `roundOver` already said, so it is not narrated.
      'Your opponent ended the turn while behind (ATK 9 vs 5) — you win the round.',
      'You won the Orange token.',
    ]);
  });

  it('keeps the round result after a tie-break, where roundOver left the winner open', () => {
    const entries = log(
      [],
      [
        { type: 'roundOver', reason: 'equalStall', seat: 1, atk: [6, 6] },
        {
          type: 'roundResolved',
          outcome: {
            kind: 'win',
            winner: 0,
            decidedBy: 'tieBreak',
            atk: [9, 6],
            tieBreakIterations: 1,
          },
        },
      ],
    );
    expect(texts(entries)).toEqual([
      'Tie: your opponent ended the turn at equal ATK without playing (ATK 6 vs 6) — a tie-break decides the round.',
      'You won the round on the tie-break (ATK 9 vs 6).',
    ]);
  });

  it('explains why the round ended under the round-end lines (same wording as the summary)', () => {
    const behind = log([
      { type: 'roundOver', reason: 'opponentAhead', seat: 0, atk: [41, 76] },
      {
        type: 'roundResolved',
        outcome: {
          kind: 'win',
          winner: 1,
          decidedBy: 'opponentAhead',
          atk: [41, 76],
          tieBreakIterations: 0,
        },
      },
      {
        type: 'tokenChanged',
        change: { seat: 1, color: 'red', kind: 'stolen', leadingCardId: 'c01' },
      },
    ]);
    const [over, token] = narrateEvents(behind, pub, 0);
    expect(over?.text).toBe(
      'You ended the turn while behind (ATK 41 vs 76) — your opponent wins the round.',
    );
    expect(over?.details).toEqual([
      'You ended your turn at ATK 41 while your opponent had 76.',
      RULE_BEHIND,
    ]);
    expect(token?.text).toBe('Opponent took the Red token from you.');
    expect(token?.details).toEqual([
      "The winner takes the token of their Leading card's colour; the loser held it, so it changed hands.",
    ]);

    const stall = log(
      [{ type: 'roundOver', reason: 'equalStall', seat: 1, atk: [6, 6] }],
      [
        { type: 'tieBreakStarted', iteration: 1, atk: [6, 6] },
        {
          type: 'roundResolved',
          outcome: {
            kind: 'win',
            winner: 0,
            decidedBy: 'tieBreak',
            atk: [9, 6],
            tieBreakIterations: 1,
          },
        },
      ],
      [{ type: 'roundOver', reason: 'p1NoBase', seat: 1, atk: [0, 0] }],
      [
        {
          type: 'roundResolved',
          outcome: { kind: 'draw', reason: 'p1NoBase', atk: [0, 0], tieBreakIterations: 0 },
        },
      ],
    );
    const lines = narrateEvents(stall, pub, 0);
    expect(lines.map((line) => line.details)).toEqual([
      [
        'Equal-ATK stall: your opponent ended their turn at ATK 6 vs 6 without playing a card, right after your End Turn at equal ATK.',
        RULE_STALL,
      ],
      undefined,
      [
        RULE_TIE_BREAK,
        'Both searched for a creature once; final ATK: you 9, opponent 6 — you win the round.',
      ],
      // The no-Base result is not repeated; its detail joins the round-over line.
      [
        'Your opponent was P1 and had no creature to play as the Base, so the round ended as a draw.',
        DRAW_NO_TOKENS,
      ],
    ]);
  });

  it('narrates a P1 no-Base draw and an equal stall from the right side', () => {
    const entries = log(
      [{ type: 'roundOver', reason: 'p1NoBase', seat: 1, atk: [0, 0] }],
      [{ type: 'roundOver', reason: 'equalStall', seat: 0, atk: [6, 6] }],
    );
    expect(texts(entries)).toEqual([
      'Your opponent (P1) had no Base creature to play — the round is a draw.',
      'Tie: you ended the turn at equal ATK without playing (ATK 6 vs 6) — a tie-break decides the round.',
    ]);
  });

  it('narrates a creature modifier draw, skips noise and keeps the last N lines', () => {
    const entries = log(
      [
        { type: 'turnStarted', seat: 0, turnNumber: 3 },
        { type: 'cardsDrawn', seat: 1, reason: 'modifierGraveyard', count: 0 },
        { type: 'deckShuffled', seat: 0 },
      ],
      [{ type: 'turnEnded', seat: 0 }],
    );
    expect(texts(entries)).toEqual([
      'Opponent drew 0 of 1 from the graveyard (graveyard empty) (creature effect).',
      'You ended your turn.',
    ]);
    expect(narrateEvents(entries, pub, 0, 1).map((line) => line.text)).toEqual([
      'You ended your turn.',
    ]);
  });

  it('adds what a play triggered as details: activation and silencing (same step)', () => {
    const entries = log(
      [{ type: 'turnStarted', seat: 0, turnNumber: 2 }],
      [
        { type: 'creaturePlayed', seat: 0, cardId: 'c01', role: 'stack' },
        { type: 'modifierSilenced', seat: 0, cardId: 'c07', kind: 'drawDeck', position: 1 },
        { type: 'modifierLive', seat: 0, cardId: 'c01', kind: 'buffSelf', position: 2 },
      ],
      // A silencing with nothing of its own step to explain it (e.g. cleanup) is not a line.
      [{ type: 'modifierSilenced', seat: 1, cardId: 'c07', kind: 'drawDeck', position: 1 }],
    );
    const lines = narrateEvents(entries, pub, 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('You played Orange 3 (ATK 4) onto your stack.');
    expect(lines[0]?.turn).toEqual({ number: 2, side: 'mine' });
    expect(lines[0]?.details).toEqual([
      'Silenced: your Blue 2 (ATK 3) — Draw Deck.',
      expect.stringMatching(/^Activated: your Orange 3 \(ATK 4\) — Buff \+\d+ ATK\.$/),
    ]);
  });

  it('notes a replay lock (RD-172) once, as a detail of the step that returned the card', () => {
    const entries = log(
      [
        { type: 'spellPlayed', seat: 0, cardId: 'c05', branch: 'primary' },
        {
          type: 'creatureRemoved',
          seat: 1,
          cardId: 'c07',
          position: 0,
          to: { zone: 'hand', seat: 1 },
        },
        { type: 'replayLocked', seat: 1, cardId: 'c07' },
        { type: 'spellResolved', seat: 0, cardId: 'c05', destination: 'graveyard' },
      ],
      // Without a line of its own step it still gets a sentence.
      [{ type: 'replayLocked', seat: 0, cardId: 'c01' }],
    );
    const lines = narrateEvents(entries, pub, 0);
    expect(lines.map((line) => line.text)).toEqual([
      'You cast "Grave Bargain" (primary effect).',
      "Blue 2 (ATK 3) left opponent's stack to opponent's hand.",
      "Your Orange 3 (ATK 4) can't be played again this turn.",
    ]);
    expect(lines[1]?.details).toEqual([
      "Opponent's Blue 2 (ATK 3) can't be played again this turn.",
    ]);
  });

  it("states the spell's Condition verdict and which effect fired", () => {
    const entries = log(
      [{ type: 'spellPlayed', seat: 1, cardId: 'c05', branch: 'secondary' }],
      [{ type: 'spellPlayed', seat: 0, cardId: 'c06', branch: 'primary' }],
    );
    const [first, second] = narrateEvents(entries, pub, 0);
    expect(first?.details?.[0]).toMatch(/^Condition not met: Secondary fired/);
    expect(second?.details?.[0]).toMatch(/^Condition met: Primary fired/);
  });

  it('marks round starts and the round-result group', () => {
    const entries = log(
      [{ type: 'roundStarted', p1: 0 }],
      [{ type: 'roundOver', reason: 'p1NoBase', seat: 1, atk: [0, 0] }],
    );
    const [start, over] = narrateEvents(entries, pub, 0);
    expect(start?.startsRound).toBe(true);
    expect(over?.turn).toBe('end');
  });
});
