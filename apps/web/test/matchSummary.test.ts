import type {
  CartignonPublicView,
  CartignonSeatEvent,
  MatchViewMessage,
} from '@cartignon/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EventLogEntry } from '../src/lib/cartignon';
import {
  buildMatchSummary,
  collectRoundEvents,
  EMPTY_ROUND_EVENTS,
  type MatchSummary,
} from '../src/match/cartignon/matchSummary';
import {
  DRAW_NO_TOKENS,
  RULE_BEHIND,
  RULE_STALL,
  RULE_TIE_BREAK,
} from '../src/match/cartignon/roundAccount';
import { MatchSummaryPanel } from '../src/screens/cartignon/MatchSummary';

type MatchState = CartignonPublicView['match'];
type Outcome = MatchViewMessage['outcome'];

function entry(revision: number, index: number, event: CartignonSeatEvent): EventLogEntry {
  return { key: `${revision}:${index}`, revision, event };
}

function resolvedWin(revision: number, winner: 0 | 1, atk: [number, number]): EventLogEntry {
  return entry(revision, 0, {
    type: 'roundResolved',
    outcome: { kind: 'win', winner, decidedBy: 'opponentAhead', atk, tieBreakIterations: 0 },
  });
}

function token(
  revision: number,
  seat: 0 | 1,
  color: 'orange' | 'red' | 'green',
  kind: 'awarded' | 'stolen' | 'protected' = 'awarded',
): EventLogEntry {
  return entry(revision, 1, {
    type: 'tokenChanged',
    change: { seat, color, kind, leadingCardId: 'c01' },
  });
}

function matchState(overrides: Partial<MatchState> = {}): MatchState {
  return {
    roundNumber: 3,
    tokens: {
      orange: 0,
      yellow: null,
      green: 0,
      blue: null,
      indigo: null,
      violet: null,
      red: 1,
    },
    finalRound: true,
    replays: 0,
    status: { kind: 'matchOver', reason: 'finalRoundPlayed', winner: 0, tokenCounts: [2, 1] },
    lastOutcome: null,
    ...overrides,
  };
}

const WIN_SEAT_0: Outcome = { result: 'winner', winner: 0, reason: 'finalRoundPlayed' };

const ROUNDS: EventLogEntry[] = [
  resolvedWin(10, 0, [9, 7]),
  token(10, 0, 'orange'),
  resolvedWin(20, 1, [4, 8]),
  token(20, 1, 'red'),
  entry(30, 0, {
    type: 'roundResolved',
    outcome: { kind: 'draw', reason: 'p1NoBase', atk: [0, 0], tieBreakIterations: 0 },
  }),
];

describe('collectRoundEvents', () => {
  it('keeps only round result events and returns the same object when nothing is new', () => {
    const log = [entry(5, 0, { type: 'turnEnded', seat: 0 }), ...ROUNDS.slice(0, 2)];
    const first = collectRoundEvents(EMPTY_ROUND_EVENTS, 'm1', log);
    expect(first.entries.map((e) => e.key)).toEqual(['10:0', '10:1']);
    expect(collectRoundEvents(first, 'm1', log)).toBe(first);
  });

  it('keeps results that dropped out of the rolling log', () => {
    const first = collectRoundEvents(EMPTY_ROUND_EVENTS, 'm1', ROUNDS.slice(0, 2));
    const next = collectRoundEvents(first, 'm1', ROUNDS.slice(2));
    expect(next.entries.map((e) => e.key)).toEqual(['10:0', '10:1', '20:0', '20:1', '30:0']);
  });

  it('starts over when the match changes', () => {
    const first = collectRoundEvents(EMPTY_ROUND_EVENTS, 'm1', ROUNDS.slice(0, 2));
    const next = collectRoundEvents(first, 'm2', ROUNDS.slice(4));
    expect(next).toEqual({ matchId: 'm2', entries: [ROUNDS[4]] });
  });
});

describe('buildMatchSummary', () => {
  it('returns null while the match runs', () => {
    expect(buildMatchSummary(null, matchState({ status: { kind: 'playing' } }), 0, [])).toBeNull();
  });

  it("summarises a won match from the winner's seat", () => {
    const summary = buildMatchSummary(WIN_SEAT_0, matchState(), 0, ROUNDS);
    expect(summary).toEqual({
      result: 'win',
      headline: 'You won',
      decidedBy: 'The final round was played; the side holding more tokens wins.',
      conclusion: 'You hold 2 tokens, your opponent 1, after 3 rounds.',
      tokens: {
        mine: ['orange', 'green'],
        theirs: ['red'],
        unclaimed: ['yellow', 'blue', 'indigo', 'violet'],
      },
      roundsPlayed: 3,
      rounds: [
        {
          key: '10:0',
          round: 1,
          result: 'win',
          headline: 'You won: opponent ended their turn behind (9 vs 7)',
          details: [
            'Your opponent ended their turn at ATK 7 while you had 9.',
            RULE_BEHIND,
            "You won the Orange token. The winner takes the token of their Leading card's colour; it was still in the supply.",
          ],
          token: 'You won the Orange token.',
        },
        {
          key: '20:0',
          round: 2,
          result: 'loss',
          headline: 'Opponent won: you ended your turn behind (4 vs 8)',
          details: [
            'You ended your turn at ATK 4 while your opponent had 8.',
            RULE_BEHIND,
            "Your opponent won the Red token. The winner takes the token of their Leading card's colour; it was still in the supply.",
          ],
          token: 'Your opponent won the Red token.',
        },
        {
          key: '30:0',
          round: 3,
          result: 'draw',
          headline: 'Draw: P1 had no Base creature',
          details: [
            'P1 had no creature to play as the Base, so the round ended as a draw.',
            DRAW_NO_TOKENS,
          ],
          token: null,
        },
      ],
      roundsComplete: true,
    });
  });

  it('swaps the perspective for the other seat', () => {
    const summary = buildMatchSummary(WIN_SEAT_0, matchState(), 1, ROUNDS);
    expect(summary?.headline).toBe('Your opponent won');
    expect(summary?.result).toBe('loss');
    expect(summary?.tokens.mine).toEqual(['red']);
    expect(summary?.rounds.map((r) => r.result)).toEqual(['loss', 'win', 'draw']);
    expect(summary?.rounds[1]?.token).toBe('You won the Red token.');
  });

  it('describes stolen and protected tokens', () => {
    const rounds = [resolvedWin(10, 1, [3, 6]), token(10, 1, 'green', 'stolen')];
    const summary = buildMatchSummary(WIN_SEAT_0, matchState({ roundNumber: 1 }), 0, rounds);
    expect(summary?.rounds[0]?.token).toBe('Your opponent took the Green token from you.');
    const kept = buildMatchSummary(WIN_SEAT_0, matchState({ roundNumber: 1 }), 0, [
      resolvedWin(10, 0, [6, 3]),
      token(10, 0, 'green', 'protected'),
    ]);
    expect(kept?.rounds[0]?.token).toBe('You kept the Green token.');
  });

  it('numbers a partial round list back from the last round', () => {
    const summary = buildMatchSummary(WIN_SEAT_0, matchState({ roundNumber: 5 }), 0, ROUNDS);
    expect(summary?.rounds.map((r) => r.round)).toEqual([3, 4, 5]);
    expect(summary?.roundsComplete).toBe(false);
  });

  it('reports a draw', () => {
    const summary = buildMatchSummary(
      { result: 'draw', reason: 'replaysExhausted' },
      matchState({
        status: {
          kind: 'matchOver',
          reason: 'replaysExhausted',
          winner: null,
          tokenCounts: [2, 2],
        },
      }),
      0,
      [],
    );
    expect(summary?.headline).toBe('Draw');
    expect(summary?.result).toBe('draw');
    expect(summary?.decidedBy).toBe('The tokens were still tied after the final round replays.');
    expect(summary?.rounds).toEqual([]);
  });

  it('counts only resolved rounds on a forfeit and names who forfeited', () => {
    const forfeit = matchState({
      roundNumber: 4,
      status: { kind: 'matchOver', reason: 'forfeitTimeouts', winner: 0, tokenCounts: [2, 1] },
    });
    const mine = buildMatchSummary(WIN_SEAT_0, forfeit, 0, ROUNDS);
    expect(mine?.roundsPlayed).toBe(3);
    expect(mine?.rounds.map((r) => r.round)).toEqual([1, 2, 3]);
    expect(mine?.decidedBy).toBe('Your opponent forfeited after two turn timeouts in a row.');
    const theirs = buildMatchSummary(WIN_SEAT_0, forfeit, 1, ROUNDS);
    expect(theirs?.decidedBy).toBe('You forfeited after two turn timeouts in a row.');
  });

  it('explains an equal-ATK stall and the tie-break from roundOver + roundResolved', () => {
    const rounds = [
      entry(40, 0, { type: 'roundOver', reason: 'equalStall', seat: 0, atk: [30, 30] }),
      entry(41, 0, { type: 'tieBreakStarted', iteration: 1, atk: [30, 30] }),
      entry(41, 1, {
        type: 'roundResolved',
        outcome: {
          kind: 'win',
          winner: 1,
          decidedBy: 'tieBreak',
          atk: [35, 42],
          tieBreakIterations: 1,
        },
      }),
      entry(41, 2, {
        type: 'tokenChanged',
        change: { seat: 1, color: 'green', kind: 'stolen', leadingCardId: 'c02' },
      }),
    ];
    const collected = collectRoundEvents(EMPTY_ROUND_EVENTS, 'm1', rounds);
    // tieBreakStarted is narration only; the summary keeps the events it explains rounds with.
    expect(collected.entries.map((e) => e.event.type)).toEqual([
      'roundOver',
      'roundResolved',
      'tokenChanged',
    ]);
    const summary = buildMatchSummary(
      WIN_SEAT_0,
      matchState({ roundNumber: 1 }),
      0,
      collected.entries,
    );
    expect(summary?.rounds).toEqual([
      {
        key: '41:1',
        round: 1,
        result: 'loss',
        headline: 'Opponent won on the tie-break (35 vs 42)',
        details: [
          "Equal-ATK stall: you ended your turn at ATK 30 vs 30 without playing a card, right after your opponent's End Turn at equal ATK.",
          RULE_STALL,
          RULE_TIE_BREAK,
          'Both searched for a creature once; final ATK: you 35, opponent 42 — your opponent wins the round.',
          "Your opponent took the Green token from you. The winner takes the token of their Leading card's colour; the loser held it, so it changed hands.",
        ],
        token: 'Your opponent took the Green token from you.',
      },
    ]);
  });

  it('explains a tie-break deck-out draw and names P1 for a missing Base', () => {
    const rounds = [
      entry(50, 0, { type: 'roundOver', reason: 'equalStall', seat: 1, atk: [12, 12] }),
      entry(51, 0, { type: 'tieBreakDeckOut', seat: 1 }),
      entry(51, 1, {
        type: 'roundResolved',
        outcome: { kind: 'draw', reason: 'tieBreakDeckOut', atk: [20, 12], tieBreakIterations: 2 },
      }),
      entry(60, 0, { type: 'roundOver', reason: 'p1NoBase', seat: 0, atk: [0, 0] }),
      entry(61, 0, {
        type: 'roundResolved',
        outcome: { kind: 'draw', reason: 'p1NoBase', atk: [0, 0], tieBreakIterations: 0 },
      }),
    ];
    const summary = buildMatchSummary(
      WIN_SEAT_0,
      matchState({ roundNumber: 2 }),
      0,
      collectRoundEvents(EMPTY_ROUND_EVENTS, 'm1', rounds).entries,
    );
    const [deckOut, noBase] = summary?.rounds ?? [];
    expect(deckOut?.headline).toBe('Draw: the deck ran out in the tie-break');
    expect(deckOut?.details).toEqual([
      'Equal-ATK stall: your opponent ended their turn at ATK 12 vs 12 without playing a card, right after your End Turn at equal ATK.',
      RULE_STALL,
      RULE_TIE_BREAK,
      "The deck ran out in the tie-break during your opponent's search, so the round is a draw (ATK 20 vs 12).",
      DRAW_NO_TOKENS,
    ]);
    expect(noBase?.headline).toBe('Draw: you (P1) had no Base creature');
    expect(noBase?.details[0]).toBe(
      'You were P1 and had no creature to play as the Base, so the round ended as a draw.',
    );
  });

  it('still explains a tie-break win when its roundOver was not seen (after a reload)', () => {
    const summary = buildMatchSummary(WIN_SEAT_0, matchState({ roundNumber: 1 }), 0, [
      entry(70, 0, {
        type: 'roundResolved',
        outcome: {
          kind: 'win',
          winner: 0,
          decidedBy: 'tieBreak',
          atk: [9, 4],
          tieBreakIterations: 3,
        },
      }),
    ]);
    expect(summary?.rounds[0]?.details).toEqual([
      'Equal-ATK stall: two End Turns in a row at equal ATK, the second without playing a card.',
      RULE_TIE_BREAK,
      'Both searched for a creature 3 times; final ATK: you 9, opponent 4 — you win the round.',
    ]);
  });

  it('describes a kept token and gives no conclusion on a forfeit', () => {
    const summary = buildMatchSummary(
      WIN_SEAT_0,
      matchState({
        roundNumber: 2,
        status: { kind: 'matchOver', reason: 'forfeitTimeouts', winner: 0, tokenCounts: [1, 0] },
      }),
      0,
      [resolvedWin(10, 0, [6, 3]), token(10, 0, 'green', 'protected')],
    );
    expect(summary?.conclusion).toBeNull();
    expect(summary?.rounds[0]?.details.at(-1)).toBe(
      "You kept the Green token. The winner takes the token of their Leading card's colour; the winner already held it, so it stays.",
    );
  });

  it('leaves "decided by" empty when the view does not say', () => {
    const summary = buildMatchSummary(
      WIN_SEAT_0,
      matchState({ status: { kind: 'playing' } }),
      0,
      [],
    );
    expect(summary?.decidedBy).toBeNull();
  });
});

describe('MatchSummaryPanel', () => {
  const noop = () => undefined;
  function summary(): MatchSummary {
    const built = buildMatchSummary(WIN_SEAT_0, matchState(), 0, ROUNDS);
    if (!built) throw new Error('no summary');
    return built;
  }

  it('renders the headline, decision, tokens and rounds under one labelled section', () => {
    const html = renderToStaticMarkup(
      createElement(MatchSummaryPanel, { summary: summary(), onHome: noop }),
    );
    expect(html).toMatch(/^<section[^>]*aria-labelledby="outcome-heading"/);
    expect(html).toMatch(/<h2 id="outcome-heading"[^>]*data-testid="outcome">You won<\/h2>/);
    expect(html).toContain('The final round was played');
    expect(html).toContain('Orange, Green');
    expect(html).toContain('3 rounds played');
    expect(html).toContain('You hold 2 tokens, your opponent 1, after 3 rounds.');
    // One collapsed details element per round; the headline in its summary, the why inside.
    expect(html.match(/<details class="ct-sum-round"/g)).toHaveLength(3);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toMatch(
      /<summary[^>]*>[\s\S]*Round 2<\/span> — Opponent won: you ended your turn behind \(4 vs 8\)/,
    );
    expect(html).toContain('You won the Orange token.');
    expect(html).not.toContain('Earlier rounds are not listed.');
  });

  it('shows Rematch and Change bot only when given; Back to home always', () => {
    const plain = renderToStaticMarkup(
      createElement(MatchSummaryPanel, { summary: summary(), onHome: noop }),
    );
    expect(plain).toContain('data-testid="back-home"');
    expect(plain).not.toContain('data-testid="rematch"');
    expect(plain).not.toContain('data-testid="change-bot"');
    const bot = renderToStaticMarkup(
      createElement(MatchSummaryPanel, {
        summary: summary(),
        onHome: noop,
        onRematch: noop,
        onChangeBot: noop,
      }),
    );
    expect(bot).toMatch(
      /data-testid="rematch"[\s\S]*data-testid="change-bot"[\s\S]*data-testid="back-home"/,
    );
  });
});
