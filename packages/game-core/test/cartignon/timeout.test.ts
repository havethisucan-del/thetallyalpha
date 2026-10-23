import {
  cartignonPrivateViewSchema,
  cartignonPublicViewSchema,
  cartignonSeatEventsSchema,
} from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import {
  eventsFor,
  forfeitMatch,
  step,
  stepTimeout,
  viewFor,
  type GameAction,
  type Seat,
  type Snapshot,
} from '../../src/index.js';
import {
  CARTIGNON_TIMEOUT_SKIP,
  createCartignonRules,
  createTokenSupply,
  toCartignonAction,
  type Board,
  type CardId,
  type CartignonMatchState,
  type CartignonPrivateView,
  type CartignonRules,
  type MatchEvent,
  type RoundCommand,
  type RoundState,
} from '../../src/cartignon/index.js';
import {
  catalog as kitCatalog,
  catalogWithModifiers,
  cr,
  ps,
  spell,
  stateOf,
} from './spell-kit.js';
import { deepFreeze } from './test-fixtures.js';

// R7: Cartignon timeout plans (RD-33, RD-163..RD-165), stepTimeout and forfeits.

const rules = createCartignonRules(kitCatalog);
const SKIP: GameAction = { type: CARTIGNON_TIMEOUT_SKIP, v: 1, payload: {} };

function snapshotOf(r: CartignonRules, round: RoundState, revision = 5): Snapshot {
  const match: CartignonMatchState = {
    round,
    roundNumber: 2,
    tokens: createTokenSupply(),
    finalRound: false,
    replays: 0,
    poolAfterCleanup: 54,
    roundsWithoutProgress: 0,
    lastOutcome: null,
    status: { kind: 'playing' },
  };
  return deepFreeze({
    rulesId: r.rulesId,
    rulesVersion: r.rulesVersion,
    revision,
    rngState: '0123456789abcdef0123456789abcdef',
    state: match,
  });
}

function mustStep(r: CartignonRules, s: Snapshot, seat: Seat, command: RoundCommand) {
  const result = step(r, s, seat, toCartignonAction(command), s.revision);
  if (!result.ok) throw new Error(`unexpected rejection ${result.code} ${result.reason ?? ''}`);
  return result;
}

function mustTimeout(
  r: CartignonRules,
  s: Snapshot,
  seat: Seat,
  mode: 'turn' | 'choice',
): { snapshot: Snapshot; events: readonly MatchEvent[] } {
  const before = JSON.stringify(s);
  const result = stepTimeout(r, s, seat, mode, s.revision);
  if (!result.ok) throw new Error(`unexpected rejection ${result.code} ${result.reason ?? ''}`);
  expect(JSON.stringify(s)).toBe(before);
  expect(result.snapshot.revision).toBe(s.revision + 1);
  for (const viewer of [0, 1] as const) {
    const view = viewFor(r, result.snapshot, viewer);
    expect(cartignonPublicViewSchema.safeParse(view.public).success).toBe(true);
    expect(cartignonPrivateViewSchema.safeParse(view.private).success).toBe(true);
    const events = cartignonSeatEventsSchema.safeParse(eventsFor(r, result.events, viewer));
    if (!events.success) expect.fail(events.error.message);
  }
  return { snapshot: result.snapshot, events: result.events as readonly MatchEvent[] };
}

const matchOf = (s: Snapshot) => s.state as CartignonMatchState;
const types = (events: readonly MatchEvent[]) => events.map((e) => e.type);

describe('timeoutAction and turnKey', () => {
  it('normal turn: End Turn for the seat on turn, none for the other seat', () => {
    const s = snapshotOf(rules, stateOf({ hands: [[cr('red', 2)], [cr('blue', 2)]] }));
    expect(rules.getPhase(matchOf(s)).turnKey).toBe('2.3');
    expect(rules.timeoutAction(matchOf(s), 0)).toEqual({
      kind: 'skip',
      action: { type: 'endTurn', v: 1, payload: {} },
    });
    expect(rules.timeoutAction(matchOf(s), 1)).toEqual({ kind: 'none' });
    const done = mustTimeout(rules, s, 0, 'turn');
    expect(types(done.events)).toEqual(['turnEnded', 'turnStarted']);
    expect(rules.getPhase(matchOf(done.snapshot))).toMatchObject({
      activeSeat: 1,
      turnSeat: 1,
      turnKey: '2.4',
    });
  });

  it('behind: the timeout End Turn ends the round, the opponent wins (RD-169)', () => {
    const round = stateOf({
      hands: [[cr('red', 3)], [cr('blue', 3)]],
      stacks: [[cr('red', 1)], [cr('blue', 1), cr('blue', 2)]],
      phase: { kind: 'turn', active: 0 },
    });
    const s = snapshotOf(rules, round);
    expect(rules.timeoutAction(matchOf(s), 0)).toMatchObject({
      kind: 'skip',
      action: { type: 'endTurn' },
    });
    const done = mustTimeout(rules, s, 0, 'turn');
    expect(types(done.events)).toContain('roundResolved');
    expect(matchOf(done.snapshot).roundNumber).toBe(3);
  });

  it('p2Opening without a play: End Turn (RD-169)', () => {
    const round = stateOf({
      hands: [[cr('red', 3)], [cr('orange', 1), cr('yellow', 1), cr('green', 1), cr('blue', 1)]],
      stacks: [[cr('red', 1)], []],
      phase: { kind: 'p2Opening', active: 1 },
    });
    const s = snapshotOf(rules, round);
    expect(rules.timeoutAction(matchOf(s), 1)).toMatchObject({
      kind: 'skip',
      action: { type: 'endTurn' },
    });
    expect(rules.timeoutAction(matchOf(s), 0)).toEqual({ kind: 'none' });
  });

  it('p2Opening after a spell: End Turn is legal, no internal skip (RD-169 removes RD-168)', () => {
    const round = stateOf({
      hands: [[cr('red', 3)], [cr('orange', 1), cr('yellow', 1), cr('green', 1), cr('blue', 1)]],
      stacks: [[cr('red', 1)], []],
      phase: { kind: 'p2Opening', active: 1 },
      playedThisTurn: true,
    });
    const s = snapshotOf(rules, round);
    const legal = (viewFor(rules, s, 1).private as CartignonPrivateView).legal;
    expect(legal.some((c) => c.type === 'playCreature')).toBe(true);
    expect(legal.some((c) => c.type === 'endTurn')).toBe(true);
    expect(rules.timeoutAction(matchOf(s), 1)).toMatchObject({
      kind: 'skip',
      action: { type: 'endTurn' },
    });
    const skip = SKIP as Parameters<CartignonRules['validateAction']>[2];
    expect(rules.validateAction(matchOf(s), 1, skip)).toMatchObject({ ok: false });
    // P1 (10) is ahead of P2 (0): the timeout End Turn ends the round.
    const done = mustTimeout(rules, s, 1, 'turn');
    expect(done.events.slice(0, 2)).toEqual([
      { type: 'turnEnded', seat: 1 },
      { type: 'roundOver', reason: 'opponentAhead', seat: 1, atk: [10, 0] },
    ]);
  });

  describe('P1 Base step (RD-163)', () => {
    const p1Base = (hand: CardId[]): RoundState => {
      const base = stateOf({
        hands: [hand, [cr('blue', 2)]],
        phase: { kind: 'p1Base', active: 0 },
      });
      return { ...base, baseLevel: null };
    };

    it('a creature in hand: the internal skip ends the round like RD-67 (draw, no tokens)', () => {
      const s = snapshotOf(rules, p1Base([cr('red', 2), cr('red', 4)]));
      expect(rules.timeoutAction(matchOf(s), 0)).toEqual({ kind: 'skip', action: SKIP });
      const legal = (viewFor(rules, s, 0).private as CartignonPrivateView).legal;
      expect(legal.map((c) => c.type)).not.toContain(CARTIGNON_TIMEOUT_SKIP);
      const done = mustTimeout(rules, s, 0, 'turn');
      expect(done.events.slice(0, 2)).toEqual([
        { type: 'turnEnded', seat: 0 },
        { type: 'roundOver', reason: 'p1NoBase', seat: 0, atk: [0, 0] },
      ]);
      const resolved = done.events.find((e) => e.type === 'roundResolved');
      expect(resolved).toMatchObject({ outcome: { kind: 'draw', reason: 'p1NoBase' } });
      expect(types(done.events)).not.toContain('tokenChanged');
      const after = matchOf(done.snapshot);
      expect(after.tokens).toEqual(createTokenSupply());
      expect(after.roundNumber).toBe(3);
      expect(after.round.p1).toBe(1);
    });

    it('no creature and no Mulligan: the ordinary RD-67 End Turn', () => {
      const s = snapshotOf(rules, p1Base([spell(10)]));
      expect(rules.timeoutAction(matchOf(s), 0)).toMatchObject({
        kind: 'skip',
        action: { type: 'endTurn' },
      });
    });
  });
});

describe('the internal timeout skip is not client-submittable', () => {
  const round = stateOf({ hands: [[cr('red', 2)], []], phase: { kind: 'p1Base', active: 0 } });
  const s = snapshotOf(rules, { ...round, baseLevel: null });

  it('step rejects it as MALFORMED before validation (parseAction never yields it)', () => {
    expect(step(rules, s, 0, SKIP, s.revision)).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(rules.parseAction(SKIP)).toMatchObject({ ok: false, code: 'MALFORMED' });
  });

  it('validateAction accepts it only where it applies', () => {
    const skip = SKIP as Parameters<CartignonRules['validateAction']>[2];
    expect(rules.validateAction(matchOf(s), 0, skip)).toEqual({ ok: true });
    expect(rules.validateAction(matchOf(s), 1, skip)).toMatchObject({ code: 'NOT_YOUR_TURN' });
    const turn = snapshotOf(rules, stateOf({ hands: [[cr('red', 2)], []] }));
    expect(rules.validateAction(matchOf(turn), 0, skip)).toMatchObject({
      code: 'ILLEGAL',
      reason: 'NOT_ALLOWED_IN_PHASE',
    });
  });
});

describe('choices (RD-164, RD-165)', () => {
  const choiceRules = createCartignonRules(
    catalogWithModifiers([['green', 2, ['buffSelf', 'drawDeck']]]),
  );
  const Y2 = cr('yellow', 2);
  const G2 = cr('green', 2);
  const round = stateOf({
    hands: [[spell(10), Y2, cr('red', 5), G2], [cr('violet', 1)]],
    stacks: [[cr('red', 1), cr('red', 2)], [cr('blue', 1)]],
    deck: [cr('yellow', 1), cr('yellow', 3)],
  });
  const played = mustStep(choiceRules, snapshotOf(choiceRules, round), 0, ps(spell(10)));
  const pending = played.snapshot;

  it('handCreature: the server answers with the first legal selection', () => {
    expect(choiceRules.getPhase(matchOf(pending))).toMatchObject({
      id: 'choosing',
      turnKey: '2.3',
    });
    expect(choiceRules.timeoutAction(matchOf(pending), 0)).toEqual({
      kind: 'answer',
      action: { type: 'chooseSpellOption', v: 1, payload: { choiceId: 1, selection: [Y2] } },
    });
    expect(choiceRules.timeoutAction(matchOf(pending), 1)).toEqual({ kind: 'none' });
  });

  it('choice mode answers once and keeps the turn', () => {
    const done = mustTimeout(choiceRules, pending, 0, 'choice');
    expect(types(done.events)).toContain('spellChoiceMade');
    expect(types(done.events)).not.toContain('turnEnded');
    expect(choiceRules.getPhase(matchOf(done.snapshot))).toMatchObject({
      id: 'turn',
      activeSeat: 0,
    });
  });

  it('turn mode answers the choice, then skips the turn, in one revision', () => {
    const done = mustTimeout(choiceRules, pending, 0, 'turn');
    const t = types(done.events);
    expect(t.indexOf('spellChoiceMade')).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('turnEnded')).toBeGreaterThan(t.indexOf('spellChoiceMade'));
    expect(choiceRules.getPhase(matchOf(done.snapshot))).toMatchObject({
      activeSeat: 1,
      turnKey: '2.4',
    });
  });

  it('rejects without a revision when the seat is not acting or has no choice', () => {
    expect(stepTimeout(choiceRules, pending, 1, 'turn', pending.revision)).toMatchObject({
      ok: false,
      code: 'NOT_YOUR_TURN',
    });
    const plain = snapshotOf(rules, stateOf({ hands: [[cr('red', 2)], []] }));
    expect(stepTimeout(rules, plain, 0, 'choice', plain.revision)).toMatchObject({
      ok: false,
      code: 'ILLEGAL',
      reason: 'NO_PENDING_CHOICE',
    });
    expect(stepTimeout(choiceRules, pending, 0, 'turn', pending.revision - 1)).toMatchObject({
      ok: false,
      code: 'STALE_REVISION',
    });
  });

  it('S-19 nested choice: the turn seat has no plan; the chooser gets a choice answer', () => {
    const S19 = spell(19);
    const S11 = spell(11);
    const base = stateOf({
      hands: [[S19], []],
      stacks: [[cr('red', 1), cr('red', 2)], [cr('blue', 1)]],
    });
    const z = base.board.zones;
    const board: Board = {
      ...base.board,
      zones: { ...z, deck: z.deck.filter((c) => c !== S11), graveyard: [S11] },
    };
    const nested = mustStep(rules, snapshotOf(rules, { ...base, board }), 0, ps(S19)).snapshot;
    expect(rules.getPhase(matchOf(nested))).toMatchObject({ activeSeat: 1, turnSeat: 0 });
    expect(rules.timeoutAction(matchOf(nested), 0)).toEqual({ kind: 'none' });
    expect(stepTimeout(rules, nested, 0, 'turn', nested.revision)).toMatchObject({
      ok: false,
      code: 'NOT_YOUR_TURN',
    });
    const done = mustTimeout(rules, nested, 1, 'choice');
    expect(types(done.events)).toContain('spellChoiceMade');
  });
});

describe('forfeit (RD-43, RD-41 / RD-46)', () => {
  const s = snapshotOf(rules, stateOf({ hands: [[cr('red', 2)], [cr('blue', 2)]] }));

  for (const [reason, endReason] of [
    ['turnTimeouts', 'forfeitTimeouts'],
    ['timeoutAfterPause', 'forfeitTimeoutAfterPause'],
  ] as const) {
    it(`${reason}: the other seat wins (${endReason}); later steps get MATCH_FINISHED`, () => {
      const result = forfeitMatch(rules, s, 0, reason);
      if (!result.ok) throw new Error(result.code);
      expect(result.snapshot.revision).toBe(s.revision + 1);
      expect(result.snapshot.rngState).toBe(s.rngState);
      expect(result.outcome).toEqual({ result: 'winner', winner: 1, reason: endReason });
      expect(result.events).toEqual([
        { type: 'matchOver', reason: endReason, winner: 1, tokenCounts: [0, 0] },
      ]);
      const done = result.snapshot;
      for (const viewer of [0, 1] as const) {
        const view = viewFor(rules, done, viewer);
        expect(view.phase).toEqual({
          id: 'matchOver',
          activeSeat: null,
          turnSeat: null,
          turnKey: null,
        });
        expect(cartignonPublicViewSchema.safeParse(view.public).success).toBe(true);
        expect(cartignonPrivateViewSchema.safeParse(view.private).success).toBe(true);
        expect(
          cartignonSeatEventsSchema.safeParse(eventsFor(rules, result.events, viewer)).success,
        ).toBe(true);
      }
      expect(rules.timeoutAction(matchOf(done), 1)).toEqual({ kind: 'none' });
      expect(
        step(rules, done, 1, toCartignonAction({ type: 'endTurn' }), done.revision),
      ).toMatchObject({ ok: false, code: 'MATCH_FINISHED' });
      expect(stepTimeout(rules, done, 1, 'turn', done.revision)).toMatchObject({
        ok: false,
        code: 'MATCH_FINISHED',
      });
      expect(forfeitMatch(rules, done, 1, reason)).toMatchObject({
        ok: false,
        code: 'MATCH_FINISHED',
      });
    });
  }
});
