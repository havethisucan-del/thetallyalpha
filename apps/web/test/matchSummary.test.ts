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
          text: 'You won the round: your opponent ended the turn while behind (ATK 9 vs 7).',
          token: 'You won the Orange token.',
        },
        {
          key: '20:0',
          round: 2,
          result: 'loss',
          text: 'Your opponent won the round: you ended the turn while behind (ATK 4 vs 8).',
          token: 'Your opponent won the Red token.',
        },
        {
          key: '30:0',
          round: 3,
          result: 'draw',
          text: 'The round was a draw: P1 had no Base creature to play.',
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
    expect(html).toContain('Round 2 · Lost');
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
