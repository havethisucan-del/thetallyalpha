import { describe, expect, it } from 'vitest';
import {
  applyMatchCommand,
  cleanupRound,
  createTokenSupply,
  resolveRound,
  setupNextRound,
  startRound,
  type Board,
  type CardId,
  type CartignonMatchState,
  type MatchEvent,
  type RoundCommand,
  type RoundState,
} from '../../src/cartignon/index.js';
import { apply, cr, ctx, ps, rng, spell, stateOf } from './spell-kit.js';
import { deepFreeze } from './test-fixtures.js';

// R4c-2 review follow-ups at the match layer: guards against a pending choice, a turn end that
// finishes the round after a choice (RD-169), and match-unique choice ids (RD-141).

const types = (events: readonly MatchEvent[]) => events.map((e) => e.type);

const choose = (choiceId: number, selection: readonly CardId[]): RoundCommand => ({
  type: 'chooseSpellOption',
  choiceId,
  selection,
});

function matchOf(round: RoundState): CartignonMatchState {
  return deepFreeze({
    round,
    roundNumber: 3,
    tokens: createTokenSupply(),
    finalRound: false,
    replays: 0,
    poolAfterCleanup: 54,
    roundsWithoutProgress: 0,
    lastOutcome: null,
    status: { kind: 'playing' },
  });
}

/** S-01 suspended mid-choice (looked-at cards held in `board.lookingAt`). */
function lookingState(): RoundState {
  const s = stateOf({
    hands: [[spell(1)], []],
    stacks: [[cr('red', 1), cr('red', 2), cr('red', 3)], [cr('blue', 1)]],
    deck: [cr('yellow', 1), cr('yellow', 2), cr('yellow', 3)],
  });
  return apply(s, 0, ps(spell(1))).state;
}

describe('guards: no round end, cleanup or start with a pending choice (programmer errors)', () => {
  it('resolveRound throws while a choice is pending', () => {
    expect(() => resolveRound(ctx, lookingState(), rng(), 1)).toThrow(/pending spell choice/);
  });

  it('cleanupRound throws with looked-at cards on the board', () => {
    const outcome = {
      kind: 'draw',
      reason: 'p1NoBase',
      atk: [0, 0],
      tieBreakIterations: 0,
    } as const;
    expect(() => cleanupRound(lookingState().board, outcome, rng())).toThrow(/looked-at/);
  });

  it('startRound and setupNextRound (startDealt) throw with looked-at cards', () => {
    const b = lookingState().board;
    const empty: Board = deepFreeze({ ...b, zones: { ...b.zones, stacks: [[], []] as const } });
    expect(() => startRound(empty, 0)).toThrow(/looked-at/);
    expect(() => setupNextRound(ctx, empty, 0, rng())).toThrow(/looked-at/);
  });
});

describe('RD-172: S-11 never ends the turn; the later End Turn finishes the round', () => {
  it('no roundOver after chooseSpellOption; End Turn while behind ends it; choice ids carry', () => {
    // Seat 0 is behind. S-11 no longer ends the turn (RD-172); seat 0's End Turn while still
    // behind ends the round (RD-169).
    const round = stateOf({
      hands: [[spell(11), cr('green', 1)], [cr('violet', 1)]],
      stacks: [[cr('red', 1)], [cr('blue', 1), cr('blue', 2), cr('blue', 3)]],
      phase: { kind: 'turn', active: 0 },
    });
    const played = applyMatchCommand(ctx, matchOf(round), 0, ps(spell(11)), rng(4));
    if (!played.ok) throw new Error(played.code);
    expect(played.state.round.pendingChoice?.choiceId).toBe(1);
    expect(played.state.round.phase.kind).toBe('turn');
    expect(types(played.events)).not.toContain('roundOver');
    expect(played.state.status).toEqual({ kind: 'playing' });

    const chosen = applyMatchCommand(ctx, played.state, 0, choose(1, [cr('blue', 3)]), rng(4));
    if (!chosen.ok) throw new Error(chosen.code);
    expect(types(chosen.events)[0]).toBe('spellChoiceMade');
    expect(types(chosen.events)).not.toContain('roundOver');
    expect(chosen.state.round.phase).toEqual({ kind: 'turn', active: 0 });
    const done = applyMatchCommand(ctx, chosen.state, 0, { type: 'endTurn' }, rng(4));
    if (!done.ok) throw new Error(done.code);
    const t = types(done.events);
    expect(t.indexOf('roundOver')).toBeGreaterThan(t.indexOf('turnEnded'));
    expect(t.indexOf('roundResolved')).toBeGreaterThan(t.indexOf('roundOver'));
    expect(done.events).toContainEqual(
      expect.objectContaining({ type: 'roundOver', reason: 'opponentAhead', seat: 0 }),
    );
    expect(done.state.roundNumber).toBe(4);
    expect(done.state.round.pendingChoice).toBeUndefined();
    expect(done.state.round.board.lookingAt).toBeUndefined();
    // RD-141: the counter carries over, so the next round's first choice gets id 2, not 1 again.
    expect(done.state.round.nextChoiceId).toBe(2);
    const next = stateOf({
      hands: [[spell(11)], []],
      stacks: [[cr('red', 1)], [cr('blue', 1), cr('blue', 2)]],
    });
    const carried = { ...next, nextChoiceId: done.state.round.nextChoiceId };
    const again = apply(carried, 0, ps(spell(11))).state;
    expect(again.pendingChoice?.choiceId).toBe(2);
  });
});
