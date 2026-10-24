import { describe, expect, it } from 'vitest';
import {
  COLORS,
  DEFAULT_COLOR_RULES,
  NULL_SNARE,
  RECOIL_SNARE,
  applyMatchCommand,
  beats,
  cleanupRound,
  createRoundContext,
  createTokenSupply,
  resolveRound,
  roundCardIds,
  stackAtk,
  startRound,
  type Board,
  type CardId,
  type CartignonMatchState,
  type RoundCommand,
  type RoundEvent,
  type RoundState,
} from '../../src/cartignon/index.js';
import type { Seat } from '../../src/index.js';
import {
  END,
  apply,
  catalogWithModifiers,
  cr,
  ctx,
  expectReject,
  ps,
  rng,
  spell,
  stateOf,
  types,
} from './spell-kit.js';
import { deepFreeze } from './test-fixtures.js';

// R4c-4: armed traps S-12 Null Snare and S-16 Recoil Snare (RD-101, RD-104, RD-109, RD-128..RD-130,
// RD-143, RD-152..RD-156). Placeholder creatures have atk = level * 10 and no modifiers unless
// stated (orange-3: [buffSelf, linkUp]).

const S12 = spell(12);
const S16 = spell(16);
const play = (cardId: CardId): RoundCommand => ({ type: 'playCreature', cardId });
const choose = (choiceId: number, selection: readonly CardId[]): RoundCommand => ({
  type: 'chooseSpellOption',
  choiceId,
  selection,
});

const R1 = cr('red', 1);
const R2 = cr('red', 2);
const R3 = cr('red', 3);
const R4 = cr('red', 4);
const B1 = cr('blue', 1);
const B2 = cr('blue', 2);
const B3 = cr('blue', 3);
const B4 = cr('blue', 4);
const B5 = cr('blue', 5);
const Y2 = cr('yellow', 2);
const Y3 = cr('yellow', 3);
const Y4 = cr('yellow', 4);
const G4 = cr('green', 4);
const G5 = cr('green', 5);
const O3 = cr('orange', 3);

/** `s` with traps armed on the board (their cards taken out of the deck / graveyard). */
function withTraps(s: RoundState, traps: readonly (readonly [CardId, Seat])[]): RoundState {
  const ids = new Set(traps.map(([c]) => c));
  const z = s.board.zones;
  const board: Board = {
    ...s.board,
    zones: {
      ...z,
      deck: z.deck.filter((c) => !ids.has(c)),
      graveyard: z.graveyard.filter((c) => !ids.has(c)),
    },
    armedTraps: traps.map(([cardId, seat]) => ({
      cardId,
      seat,
      spellId: cardId === S12 ? NULL_SNARE : RECOIL_SNARE,
    })),
  };
  return deepFreeze({ ...s, board });
}

function find(events: readonly RoundEvent[], type: RoundEvent['type']) {
  return events.filter((e) => e.type === type);
}

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

describe('arming (RD-101) and visibility (RD-130)', () => {
  it('S-12 and S-16 are always playable and arm on the caster side, in no zone', () => {
    // P2 (seat 0) in its opening response without a stack: still playable.
    const s = stateOf({
      hands: [[S12, S16], []],
      stacks: [[], [B1]],
      phase: { kind: 'p2Opening', active: 0 },
      p1: 1,
    });
    const first = apply(s, 0, ps(S12));
    expect(types(first.events)).toEqual(['spellPlayed', 'trapArmed', 'spellResolved']);
    expect(first.events[1]).toEqual({ type: 'trapArmed', seat: 0, cardId: S12, spellId: 'S-12' });
    expect(first.events[2]).toMatchObject({ destination: 'armed' });
    const { state } = apply(first.state, 0, ps(S16));
    expect(state.board.armedTraps).toEqual([
      { cardId: S12, seat: 0, spellId: 'S-12' },
      { cardId: S16, seat: 0, spellId: 'S-16' },
    ]);
    const z = state.board.zones;
    for (const id of [S12, S16]) {
      expect([...z.deck, ...z.graveyard, ...z.hands[0], ...z.hands[1]]).not.toContain(id);
      // Card conservation (RD-02): armed traps are counted.
      expect(roundCardIds(state)).toContain(id);
    }
    expect(state.phase).toEqual(s.phase);
    expect(state.playedThisTurn).toBe(true);
  });

  it('the trap does not lapse at the end of the caster own turn (its window is the next one)', () => {
    const s = stateOf({ hands: [[S12], []], stacks: [[R1], [B1]] });
    const armed = apply(s, 0, ps(S12)).state;
    const { state, events } = apply(armed, 0, END);
    expect(types(events)).toEqual(['turnEnded', 'turnStarted']);
    expect(state.board.armedTraps).toHaveLength(1);
  });

  it('the caster own placements never trigger its trap', () => {
    const s = withTraps(stateOf({ hands: [[R3], []], stacks: [[R1, R2], [B1]] }), [[S16, 0]]);
    const { state, events } = apply(s, 0, play(R3));
    expect(find(events, 'trapTriggered')).toEqual([]);
    expect(state.board.zones.stacks[0]).toEqual([R1, R2, R3]);
    expect(state.board.armedTraps).toHaveLength(1);
  });
});

describe('S-12 Null Snare (RD-128, RD-109)', () => {
  const turn1 = { kind: 'turn', active: 1 } as const;

  it('level 2-4: that one activation is negated (buff off), and it re-activates later', () => {
    const ctxM = createRoundContext(
      catalogWithModifiers([['yellow', 3, ['buffSelf', 'buffSelf']]]),
    );
    const s = withTraps(
      stateOf({ hands: [[spell(8)], [Y3, Y4]], stacks: [[R1], [B1, B2]], phase: turn1 }),
      [[S12, 0]],
    );
    const placed = apply(s, 1, play(Y3), 1, ctxM);
    expect(find(placed.events, 'trapTriggered')).toEqual([
      {
        type: 'trapTriggered',
        seat: 0,
        cardId: S12,
        spellId: 'S-12',
        targetSeat: 1,
        triggerCardId: Y3,
        outcome: 'negated',
        negatedKind: 'buffSelf',
      },
    ]);
    expect(find(placed.events, 'modifierLive')).toEqual([]);
    // 10 + 20 + 30, no +30 buff.
    expect(stackAtk(ctxM.cards, placed.state.board, 1)).toBe(60);
    expect(placed.state.board.negatedModifiers).toEqual([{ cardId: Y3, position: 2 }]);
    expect(placed.state.board.armedTraps).toBeUndefined();
    expect(placed.state.board.zones.graveyard.at(-1)).toBe(S12);

    // Y4 on top silences Y3: the negation is gone. S-08 removes Y4: Y3 re-activates (RD-109).
    const covered = apply(placed.state, 1, play(Y4), 1, ctxM);
    expect(covered.state.board.negatedModifiers).toBeUndefined();
    const passed = apply(covered.state, 1, END, 1, ctxM).state;
    const removed = apply(passed, 0, ps(spell(8)), 1, ctxM);
    expect(removed.state.board.zones.stacks[1]).toEqual([B1, B2, Y3]);
    expect(stackAtk(ctxM.cards, removed.state.board, 1)).toBe(90);
  });

  it('level 2-4: a draw modifier draws nothing and an armed Link Up is not armed', () => {
    const ctxD = createRoundContext(
      catalogWithModifiers([['yellow', 3, ['drawDeck', 'drawDeck']]]),
    );
    const s = withTraps(stateOf({ hands: [[], [Y3]], stacks: [[R1], [B1, B2]], phase: turn1 }), [
      [S12, 0],
    ]);
    const drawn = apply(s, 1, play(Y3), 1, ctxD);
    expect(find(drawn.events, 'cardsDrawn')).toEqual([]);
    expect(drawn.state.board.zones.hands).toEqual([[], []]);
    expect(find(drawn.events, 'trapTriggered')[0]).toMatchObject({ negatedKind: 'drawDeck' });

    const t = withTraps(stateOf({ hands: [[], [O3]], stacks: [[R1], [B1, B2]], phase: turn1 }), [
      [S12, 0],
    ]);
    const linked = apply(t, 1, play(O3));
    expect(find(linked.events, 'linkUpArmed')).toEqual([]);
    expect(linked.state.board.linkUpPending).toEqual([false, false]);
    expect(find(linked.events, 'trapTriggered')[0]).toMatchObject({ negatedKind: 'linkUp' });
  });

  it('level 5: the Secondary fires instead (trap owner draws 1 from the deck); consumed', () => {
    const s = withTraps(
      stateOf({
        hands: [[], [G5]],
        stacks: [[R1], [B1, B2, B3, B4]],
        deck: [R4, Y2],
        phase: turn1,
      }),
      [[S12, 0]],
    );
    const { state, events } = apply(s, 1, play(G5));
    const t = types(events);
    expect(t.slice(t.indexOf('trapTriggered'))).toEqual([
      'trapTriggered',
      'cardsDrawn',
      'spellDrawResolved',
    ]);
    expect(find(events, 'trapTriggered')[0]).toMatchObject({ outcome: 'secondary' });
    expect(state.board.zones.hands[0]).toEqual([R4]);
    expect(state.board.zones.stacks[1].at(-1)).toBe(G5);
    expect(state.board.armedTraps).toBeUndefined();
    expect(state.board.zones.graveyard).toContain(S12);
    // Primary fired: no lapse Secondary at the end of the turn.
    const ended = apply(state, 1, END);
    expect(find(ended.events, 'trapLapsed')).toEqual([]);
    expect(ended.state.board.zones.hands[0]).toEqual([R4]);
  });

  it('level 1 (a Base placement) also gives the Secondary', () => {
    const p2Color = COLORS.find((c) => c !== 'red' && !beats(DEFAULT_COLOR_RULES, 'red', c));
    if (p2Color === undefined) throw new Error('no color for the P2 Base');
    const base = cr(p2Color, 1);
    const s = withTraps(
      stateOf({
        hands: [[], [base]],
        stacks: [[R1], []],
        deck: [R4],
        phase: { kind: 'p2Opening', active: 1 },
      }),
      [[S12, 0]],
    );
    const { state, events } = apply(s, 1, play(base));
    expect(find(events, 'trapTriggered')[0]).toMatchObject({ outcome: 'secondary' });
    expect(state.board.zones.hands[0]).toEqual([R4]);
    expect(state.phase).toEqual({ kind: 'turn', active: 1 });
  });

  it('untriggered: lapses at the end of the opponent turn and its Secondary fires (RD-129)', () => {
    const s = withTraps(
      stateOf({ hands: [[], [Y2]], stacks: [[R1], [B1]], deck: [R4], phase: turn1 }),
      [[S12, 0]],
    );
    const { state, events } = apply(s, 1, END);
    // RD-156: lapse first, then the End Turn itself.
    expect(types(events)).toEqual([
      'trapLapsed',
      'cardsDrawn',
      'spellDrawResolved',
      'turnEnded',
      'turnStarted',
    ]);
    expect(events[0]).toEqual({ type: 'trapLapsed', seat: 0, cardId: S12, spellId: 'S-12' });
    expect(state.board.zones.hands[0]).toEqual([R4]);
    expect(state.board.armedTraps).toBeUndefined();
    expect(state.board.zones.graveyard).toContain(S12);
    expect(state.pendingChoice).toBeUndefined();
  });
});

describe('S-16 Recoil Snare (RD-104, RD-143)', () => {
  it('a level >= 3 placement returns to its owner hand, replay-locked; RD-143 flag for P1', () => {
    const s = withTraps(
      stateOf({
        hands: [[], [Y3, R4]],
        stacks: [[R1], [B1, B2]],
        phase: { kind: 'turn', active: 1 },
        p1: 1,
      }),
      [[S16, 0]],
    );
    const { state, events } = apply(s, 1, play(Y3));
    expect(types(events)).toEqual([
      'creaturePlayed',
      'creatureStacked',
      'trapTriggered',
      'creatureRemoved',
      'replayLocked',
    ]);
    expect(events[2]).toEqual({
      type: 'trapTriggered',
      seat: 0,
      cardId: S16,
      spellId: 'S-16',
      targetSeat: 1,
      triggerCardId: Y3,
      outcome: 'returned',
    });
    expect(state.board.zones.stacks[1]).toEqual([B1, B2]);
    expect(state.board.zones.hands[1]).toEqual([R4, Y3]);
    expect(state.turnLocks).toEqual([{ seat: 1, cardId: Y3 }]);
    expect(state.p1StackTouchedBySpell).toBe(true);
    expect(state.playedThisTurn).toBe(true);
    expect(state.board.armedTraps).toBeUndefined();
    expect(state.board.zones.graveyard.at(-1)).toBe(S16);
    expectReject(state, 1, play(Y3), 'CARD_REPLAY_LOCKED');

    // Primary fired: no lapse Secondary; the lock ends with the turn.
    const ended = apply(state, 1, END);
    expect(find(ended.events, 'trapLapsed')).toEqual([]);
    expect(ended.state.turnLocks).toBeUndefined();
    expect(stackAtk(ctx.cards, ended.state.board, 1)).toBe(30);
  });

  it('returning a creature from the non-P1 stack does not set the RD-143 flag', () => {
    const s = withTraps(
      stateOf({ hands: [[], [Y3]], stacks: [[R1], [B1, B2]], phase: { kind: 'turn', active: 1 } }),
      [[S16, 0]],
    );
    const { state } = apply(s, 1, play(Y3));
    expect(state.board.zones.hands[1]).toEqual([Y3]);
    expect(state.p1StackTouchedBySpell).toBeUndefined();
  });

  it('a level < 3 placement does not trigger it; it lapses with -30 on the enemy Leading', () => {
    const s = withTraps(
      stateOf({ hands: [[], [Y2]], stacks: [[R1], [B1]], phase: { kind: 'turn', active: 1 } }),
      [[S16, 0]],
    );
    const placed = apply(s, 1, play(Y2));
    expect(find(placed.events, 'trapTriggered')).toEqual([]);
    expect(placed.state.board.armedTraps).toHaveLength(1);
    const { state, events } = apply(placed.state, 1, END);
    expect(types(events)).toEqual(['trapLapsed', 'effectAttached', 'turnEnded', 'turnStarted']);
    expect(events[0]).toEqual({
      type: 'trapLapsed',
      seat: 0,
      cardId: S16,
      spellId: 'S-16',
      attachedTo: Y2,
    });
    expect(events[1]).toMatchObject({
      effect: { amount: -30, sourceCardId: S16, targetCardId: Y2 },
    });
    expect(stackAtk(ctx.cards, state.board, 1)).toBe(10); // 10 + max(0, 20 - 30), floor per creature
    expect(state.board.armedTraps).toBeUndefined();
    // RD-153 (user): the Secondary gave Y2 an effect, so the trap card attaches to Y2.
    expect(state.board.zones.graveyard).not.toContain(S16);
    expect(state.board.attachedSpells).toEqual([
      { cardId: S16, seat: 0, targetCardId: Y2, branch: 'secondary' },
    ]);

    // It goes to the graveyard with its creature (RD-12 / RD-50): S-11 returns Y2 to the hand.
    const t: RoundState = deepFreeze({
      ...state,
      board: {
        ...state.board,
        zones: {
          ...state.board.zones,
          hands: [[spell(11)], state.board.zones.hands[1]] as const,
          graveyard: state.board.zones.graveyard.filter((c) => c !== spell(11)),
          deck: state.board.zones.deck.filter((c) => c !== spell(11)),
        },
      },
    });
    const asked = apply(t, 0, ps(spell(11)));
    expect(asked.state.pendingChoice).toMatchObject({ options: [B1, Y2] });
    const repelled = apply(asked.state, 0, choose(1, [Y2]));
    expect(repelled.state.board.zones.hands[1]).toContain(Y2);
    expect(repelled.state.board.attachedSpells).toEqual([]);
    expect(repelled.state.board.zones.graveyard).toContain(S16);
    expect(find(repelled.events, 'attachedSpellDiscarded')).toEqual([
      { type: 'attachedSpellDiscarded', cardId: S16, targetCardId: Y2 },
    ]);
  });

  it('RD-153: a lapse without an enemy Leading creature sends the card to the graveyard', () => {
    // Seat 1 is on turn with a stack a spell emptied (RD-105); seat 0's S-16 nerfs nothing.
    const s = withTraps(
      deepFreeze({
        ...stateOf({ hands: [[], []], stacks: [[R1], []], phase: { kind: 'turn', active: 1 } }),
        stackEmptiedBySpell: true,
      }),
      [[S16, 0]],
    );
    const { state, events } = apply(s, 1, END);
    expect(events[0]).toEqual({ type: 'trapLapsed', seat: 0, cardId: S16, spellId: 'S-16' });
    expect(find(events, 'effectAttached')).toEqual([]);
    expect(state.board.zones.graveyard).toContain(S16);
    expect(state.board.attachedSpells).toEqual([]);
  });

  it('fires on a Link Up placement (played or linked)', () => {
    const s = withTraps(
      stateOf({
        hands: [[], [G5]],
        stacks: [[R1], [B1, B2, O3]],
        phase: { kind: 'turn', active: 1 },
        board: { linkUpPending: [false, true] },
      }),
      [[S16, 0]],
    );
    const { state, events } = apply(s, 1, play(G5));
    expect(find(events, 'creatureStacked')[0]).toMatchObject({ cardId: G5, viaLinkUp: true });
    expect(find(events, 'trapTriggered')[0]).toMatchObject({ outcome: 'returned' });
    expect(state.board.zones.stacks[1]).toEqual([B1, B2, O3]);
    expect(state.board.zones.hands[1]).toEqual([G5]);
    // The Link Up was used up; O3 is Leading again at position 2 and re-activates it (RD-60).
    expect(find(events, 'linkUpConsumed')).toHaveLength(1);
    expect(find(events, 'linkUpArmed')).toEqual([
      { type: 'linkUpArmed', seat: 1, sourceCardId: O3 },
    ]);
    expect(state.board.linkUpPending).toEqual([false, true]);
  });

  it('RD-155: a P1 Base returned in the Base step keeps the phase; P1 places another Base', () => {
    const s = withTraps(
      deepFreeze({
        ...stateOf({ hands: [[Y3, R1], []], phase: { kind: 'p1Base', active: 0 } }),
        baseLevel: null,
      }),
      [[S16, 1]],
    );
    const returned = apply(s, 0, play(Y3));
    expect(find(returned.events, 'trapTriggered')[0]).toMatchObject({ outcome: 'returned' });
    expect(returned.state.phase).toEqual({ kind: 'p1Base', active: 0 });
    expect(returned.state.baseLevel).toBeNull();
    expect(returned.state.p1StackTouchedBySpell).toBe(true);
    expectReject(returned.state, 0, play(Y3), 'CARD_REPLAY_LOCKED');
    const { state } = apply(returned.state, 0, play(R1));
    expect(state.phase).toEqual({ kind: 'p2Opening', active: 1 });
    expect(state.baseLevel).toBe(1);
    expect(state.turnLocks).toBeUndefined();
  });

  it("RD-155: P2's opening Base returned keeps p2Opening; P2 places another Base", () => {
    const p2Color = COLORS.find((c) => c !== 'red' && !beats(DEFAULT_COLOR_RULES, 'red', c));
    if (p2Color === undefined) throw new Error('no color for the P2 Base');
    const high = cr(p2Color, 3);
    const low = cr(p2Color, 1);
    // RD-07: P1's Base is R3 (Base Level 3), so a level-3 P2 Base is legal.
    const s = withTraps(
      deepFreeze({
        ...stateOf({
          hands: [[], [high, low]],
          stacks: [[R3], []],
          phase: { kind: 'p2Opening', active: 1 },
        }),
        baseLevel: 3,
      }),
      [[S16, 0]],
    );
    const returned = apply(s, 1, play(high));
    expect(find(returned.events, 'trapTriggered')[0]).toMatchObject({ outcome: 'returned' });
    expect(returned.state.phase).toEqual({ kind: 'p2Opening', active: 1 });
    expect(returned.state.board.zones.stacks[1]).toEqual([]);
    expect(returned.state.board.zones.hands[1]).toEqual([low, high]);
    expect(returned.state.playedThisTurn).toBe(true);
    // Returned from the non-P1 stack: no RD-143 flag.
    expect(returned.state.p1StackTouchedBySpell).toBeUndefined();
    expectReject(returned.state, 1, play(high), 'CARD_REPLAY_LOCKED');
    const { state } = apply(returned.state, 1, play(low));
    expect(state.phase).toEqual({ kind: 'turn', active: 1 });
    expect(state.board.zones.stacks[1]).toEqual([low]);
  });
});

describe('both traps, spell placements and pending choices', () => {
  it('RD-154: S-12 then S-16 on the same placement; both consumed', () => {
    const s = withTraps(
      stateOf({ hands: [[], [O3]], stacks: [[R1], [B1, B2]], phase: { kind: 'turn', active: 1 } }),
      [
        [S12, 0],
        [S16, 0],
      ],
    );
    const { state, events } = apply(s, 1, play(O3));
    expect(find(events, 'trapTriggered').map((e) => 'outcome' in e && e.outcome)).toEqual([
      'negated',
      'returned',
    ]);
    expect(state.board.armedTraps).toBeUndefined();
    expect(state.board.zones.graveyard.slice(-2)).toEqual([S12, S16]);
    expect(state.board.zones.hands[1]).toEqual([O3]);
    expect(state.board.negatedModifiers).toBeUndefined();
  });

  it('RD-154 (user): S-16 resolves before the activation edge: no draw, no Link Up arming', () => {
    const ctxD = createRoundContext(
      catalogWithModifiers([['yellow', 3, ['drawDeck', 'drawDeck']]]),
    );
    const s = withTraps(
      stateOf({ hands: [[], [Y3]], stacks: [[R1], [B1, B2]], phase: { kind: 'turn', active: 1 } }),
      [[S16, 0]],
    );
    const drew = apply(s, 1, play(Y3), 1, ctxD);
    expect(types(drew.events)).toEqual([
      'creaturePlayed',
      'creatureStacked',
      'trapTriggered',
      'creatureRemoved',
      'replayLocked',
    ]);
    expect(drew.state.board.zones.hands).toEqual([[], [Y3]]);

    // O3 at position 2 would arm a Link Up: it never does, so nothing lapses either.
    const t = withTraps(
      stateOf({ hands: [[], [O3]], stacks: [[R1], [B1, B2]], phase: { kind: 'turn', active: 1 } }),
      [[S16, 0]],
    );
    const linked = apply(t, 1, play(O3));
    expect(find(linked.events, 'linkUpArmed')).toEqual([]);
    expect(find(linked.events, 'linkUpLapsed')).toEqual([]);
    expect(find(linked.events, 'modifierLive')).toEqual([]);
    expect(linked.state.board.linkUpPending).toEqual([false, false]);
    expect(linked.state.board.linkUpSource).toEqual([null, null]);
  });

  it('RD-154 (user): S-12 + S-16 on a level 5: the S-12 draw happens, the creature draws nothing', () => {
    const ctxD = createRoundContext(
      catalogWithModifiers([['green', 5, ['drawDeck', 'drawDeck', 'drawDeck', 'drawDeck']]]),
    );
    const s = withTraps(
      stateOf({
        hands: [[], [G5]],
        stacks: [[R1], [B1, B2, B3, B4]],
        deck: [R4, Y2],
        phase: { kind: 'turn', active: 1 },
      }),
      [
        [S12, 0],
        [S16, 0],
      ],
    );
    const { state, events } = apply(s, 1, play(G5), 1, ctxD);
    expect(find(events, 'trapTriggered').map((e) => 'outcome' in e && e.outcome)).toEqual([
      'secondary',
      'returned',
    ]);
    // Only the trap owner's S-12 Secondary draw; G5's drawDeck never activates.
    expect(find(events, 'cardsDrawn')).toEqual([
      { type: 'cardsDrawn', seat: 0, reason: 'spellDeck', cardIds: [R4] },
    ]);
    expect(state.board.zones.hands).toEqual([[R4], [G5]]);
    expect(state.board.zones.stacks[1]).toEqual([B1, B2, B3, B4]);
    // B4 (position 3: buffSelf) is Leading again and re-activates (RD-57 / RD-60).
    expect(find(events, 'modifierLive')).toEqual([
      expect.objectContaining({ seat: 1, cardId: B4, kind: 'buffSelf' }),
    ]);
    expect(state.board.zones.graveyard.slice(-2)).toEqual([S12, S16]);
    expect(state.board.armedTraps).toBeUndefined();
  });

  it('a spell placement after a choice triggers S-16; End Turn waits for the choice', () => {
    // S-05: the opponent (seat 0) has a level 5, seat 1 chooses a hand creature to link.
    const s = withTraps(
      stateOf({
        hands: [[], [spell(5), G4, R2]],
        stacks: [[B5], [B1]],
        phase: { kind: 'turn', active: 1 },
      }),
      [[S16, 0]],
    );
    const played = apply(s, 1, ps(spell(5)));
    expect(played.state.pendingChoice).toMatchObject({ kind: 'handCreature', options: [G4, R2] });
    expectReject(played.state, 1, END, 'CHOICE_PENDING');
    expect(played.state.board.armedTraps).toHaveLength(1);

    const chosen = apply(played.state, 1, choose(1, [G4]));
    expect(types(chosen.events)).toEqual([
      'spellChoiceMade',
      'creatureStacked',
      'trapTriggered',
      'creatureRemoved',
      'replayLocked',
      'spellResolved',
    ]);
    expect(chosen.state.pendingChoice).toBeUndefined();
    expect(chosen.state.board.zones.hands[1]).toEqual([R2, G4]);
    expect(chosen.state.turnLocks).toEqual([{ seat: 1, cardId: G4 }]);
    expect(chosen.state.board.armedTraps).toBeUndefined();

    // Choosing the level-2 creature instead: no trigger; the trap lapses at the turn end.
    const low = apply(played.state, 1, choose(1, [R2]));
    expect(find(low.events, 'trapTriggered')).toEqual([]);
    const ended = apply(low.state, 1, END);
    expect(find(ended.events, 'trapLapsed')).toHaveLength(1);
    expect(ended.state.pendingChoice).toBeUndefined();
  });
});

describe('S-12 on replaceLeader / takeControl placements (RD-152, RD-109; review finding 1)', () => {
  const ctxM = createRoundContext(catalogWithModifiers([['yellow', 3, ['buffSelf', 'buffSelf']]]));
  const turn1 = { kind: 'turn', active: 1 } as const;

  /** Applies `command`, answering one pending choice with `answer` if the spell asks. */
  function applyAnswering(s: RoundState, command: RoundCommand, answer: readonly CardId[]) {
    const first = apply(s, 1, command, 1, ctxM);
    const pending = first.state.pendingChoice;
    if (pending === undefined) return first;
    const second = apply(first.state, 1, choose(pending.choiceId, answer), 1, ctxM);
    return { state: second.state, events: [...first.events, ...second.events] };
  }

  it('takeControl (S-13): the old-seat silence does not prune the fresh negation', () => {
    // Y3 is Leading on seat 0 at position 1 (its buff is live there); seat 1 takes it.
    const s = withTraps(
      stateOf({
        hands: [[], [spell(13), R2]],
        stacks: [
          [R1, Y3],
          [B1, B2],
        ],
        phase: turn1,
      }),
      [[S12, 0]],
    );
    const { state, events } = applyAnswering(s, ps(spell(13)), [Y3]);
    expect(state.pendingChoice).toBeUndefined();
    expect(state.board.zones.stacks).toEqual([[R1], [B1, B2, Y3]]);
    expect(find(events, 'trapTriggered')).toEqual([
      expect.objectContaining({ outcome: 'negated', negatedKind: 'buffSelf', triggerCardId: Y3 }),
    ]);
    expect(state.board.negatedModifiers).toEqual([{ cardId: Y3, position: 2 }]);
    // 10 + 20 + 30, no +30 buff.
    expect(stackAtk(ctxM.cards, state.board, 1)).toBe(60);
  });

  it('replaceLeader (S-09): the new Leading creature activation is negated', () => {
    const s = withTraps(
      stateOf({ hands: [[], [spell(9), Y3]], stacks: [[R1], [B1, Y4]], phase: turn1 }),
      [[S12, 0]],
    );
    const { state, events } = applyAnswering(s, ps(spell(9)), [Y3]);
    expect(state.board.zones.stacks[1]).toEqual([B1, Y3]);
    expect(state.board.zones.hands[1]).toContain(Y4);
    expect(find(events, 'trapTriggered')).toEqual([
      expect.objectContaining({ outcome: 'negated', negatedKind: 'buffSelf', triggerCardId: Y3 }),
    ]);
    expect(state.board.negatedModifiers).toEqual([{ cardId: Y3, position: 1 }]);
    expect(stackAtk(ctxM.cards, state.board, 1)).toBe(40);
  });
});

describe('lapse paths (RD-129, RD-156: lapse first, then decide)', () => {
  it('a Nullify lapses P1 traps before the nullify itself', () => {
    const color = COLORS.find((c) => beats(DEFAULT_COLOR_RULES, c, 'red'));
    if (color === undefined) throw new Error('no color beats red');
    const nuller = cr(color, 2);
    const s = withTraps(
      stateOf({
        hands: [[], [nuller]],
        stacks: [[R1], []],
        deck: [R4],
        phase: { kind: 'p2Opening', active: 1 },
      }),
      [[S12, 0]],
    );
    const { state, events } = apply(s, 1, { type: 'nullify', cardId: nuller });
    expect(types(events).slice(0, 4)).toEqual([
      'trapLapsed',
      'cardsDrawn',
      'spellDrawResolved',
      'nullified',
    ]);
    expect(state.board.zones.hands[0]).toEqual([R4]);
    expect(state.board.armedTraps).toBeUndefined();
    expect(state.phase).toEqual({ kind: 'p1Base', active: 0 });
  });

  it('a trap of P2 that survived its Nullify lapses at the P1 Base step hand-over', () => {
    const s = withTraps(
      deepFreeze({
        ...stateOf({ hands: [[R2], []], stacks: [[], []], phase: { kind: 'p1Base', active: 0 } }),
        baseLevel: null,
      }),
      [[S16, 1]],
    );
    const { state, events } = apply(s, 0, play(R2));
    // Level 2: S-16 does not trigger; P1's turn ends, so the trap lapses (-30 on P1's Base).
    expect(types(events)).toEqual([
      'creaturePlayed',
      'creatureStacked',
      'trapLapsed',
      'effectAttached',
      'turnEnded',
      'turnStarted',
    ]);
    expect(state.board.armedTraps).toBeUndefined();
    expect(stackAtk(ctx.cards, state.board, 0)).toBe(0);
    expect(state.phase).toEqual({ kind: 'p2Opening', active: 1 });
  });

  it('S-11 no longer ends the turn (RD-172): the window traps lapse only at the End Turn', () => {
    const s = withTraps(
      stateOf({
        hands: [[], [spell(11)]],
        // Seat 1 stays ahead (60 vs 40) so the turn passes (RD-169).
        stacks: [
          [R1, R4],
          [B1, B2, B3],
        ],
        deck: [Y4],
        phase: { kind: 'turn', active: 1 },
      }),
      [[S12, 0]],
    );
    const cast = apply(s, 1, ps(spell(11)));
    expect(types(cast.events)).not.toContain('trapLapsed');
    expect(cast.state.board.armedTraps).toHaveLength(1);
    expect(cast.state.phase).toEqual({ kind: 'turn', active: 1 });
    const { state, events } = apply(cast.state, 1, END);
    expect(types(events)).toEqual([
      'trapLapsed',
      'cardsDrawn',
      'spellDrawResolved',
      'turnEnded',
      'turnStarted',
    ]);
    expect(state.board.zones.hands[0]).toEqual([R1, Y4]);
    expect(state.board.armedTraps).toBeUndefined();
    expect(state.phase).toMatchObject({ kind: 'turn', active: 0 });
  });

  it('traps of both seats live at once: only the window traps lapse; the other one waits', () => {
    const s = withTraps(
      stateOf({
        hands: [[R2], [Y2]],
        stacks: [[R1], [B1]],
        phase: { kind: 'turn', active: 1 },
      }),
      [
        [S16, 0],
        [S12, 1],
      ],
    );
    const placed = apply(s, 1, play(Y2));
    expect(find(placed.events, 'trapTriggered')).toEqual([]);
    const ended = apply(placed.state, 1, END);
    expect(find(ended.events, 'trapLapsed')).toEqual([
      { type: 'trapLapsed', seat: 0, cardId: S16, spellId: 'S-16', attachedTo: Y2 },
    ]);
    expect(ended.state.board.armedTraps).toEqual([{ cardId: S12, seat: 1, spellId: 'S-12' }]);
    // Seat 1's S-12 now watches seat 0's turn.
    const { state, events } = apply(ended.state, 0, play(R2));
    expect(find(events, 'trapTriggered')).toEqual([
      expect.objectContaining({ seat: 1, targetSeat: 0, triggerCardId: R2, outcome: 'negated' }),
    ]);
    expect(state.board.armedTraps).toBeUndefined();
  });

  describe('End Turn after a window lapse (RD-156, RD-169)', () => {
    const turn1 = { kind: 'turn', active: 1 } as const;

    it('a window lapse that equalizes ATK passes the turn (equal hand-over)', () => {
      // Seat 1 ends its turn ahead 60 vs 30; seat 0's S-16 lapses first: 30 vs 30.
      const s = withTraps(
        stateOf({
          hands: [[], []],
          stacks: [
            [R1, R2],
            [B1, Y2, Y3],
          ],
          phase: turn1,
        }),
        [[S16, 0]],
      );
      const { state, events } = apply(s, 1, END);
      expect(types(events)).toEqual(['trapLapsed', 'effectAttached', 'turnEnded', 'turnStarted']);
      expect(state.phase).toEqual({ kind: 'turn', active: 0, equalEndBy: 1 });
      expect(stackAtk(ctx.cards, state.board, 1)).toBe(30);
    });

    it('a window lapse that puts the ending seat behind ends the round', () => {
      // 60 vs 40 before the lapse; 30 vs 40 after it.
      const s = withTraps(
        stateOf({
          hands: [[], []],
          stacks: [
            [R1, R3],
            [B1, Y2, Y3],
          ],
          phase: turn1,
        }),
        [[S16, 0]],
      );
      const { state, events } = apply(s, 1, END);
      expect(types(events)).toEqual(['trapLapsed', 'effectAttached', 'turnEnded', 'roundOver']);
      expect(state.phase).toEqual({
        kind: 'roundOver',
        reason: 'opponentAhead',
        seat: 1,
        atk: [40, 30],
      });
      expect(resolveRound(ctx, state, rng(), 1)).toMatchObject({
        ok: true,
        outcome: { kind: 'win', winner: 0, decidedBy: 'opponentAhead', atk: [40, 30] },
      });
    });
  });
});

describe('lapse at an earlier round end (RD-129) and the match guards', () => {
  /** Seat 1 on turn, behind (10 vs 30), with seat 0's S-16 armed. */
  const armedRound = (): RoundState =>
    withTraps(
      stateOf({ hands: [[], [Y2]], stacks: [[R1, R2], [B1]], phase: { kind: 'turn', active: 1 } }),
      [[S16, 0]],
    );

  it('End Turn lapses the trap first and is decided on the post-lapse ATK (RD-156)', () => {
    const { state, events } = apply(armedRound(), 1, END);
    expect(types(events)).toEqual(['trapLapsed', 'effectAttached', 'turnEnded', 'roundOver']);
    expect(state.phase).toEqual({
      kind: 'roundOver',
      reason: 'opponentAhead',
      seat: 1,
      atk: [30, 0],
    });
    expect(events.at(-1)).toMatchObject({ type: 'roundOver', atk: [30, 0] });
    expect(state.board.armedTraps).toBeUndefined();
    expect(resolveRound(ctx, state, rng(), 1)).toMatchObject({ ok: true });
  });

  it('an End Turn whose own-trap lapse flips the outcome (ahead / equal, RD-156)', () => {
    // Seat 1 ends behind (30 vs 40) with its own S-16 armed this turn: the round would end, so
    // the trap lapses (-30 on seat 0's Leading R3) and the End Turn is decided again on 10 vs 30.
    const turn1 = { kind: 'turn', active: 1 } as const;
    const ahead = withTraps(
      stateOf({
        hands: [[], []],
        stacks: [
          [R1, R3],
          [B1, Y2],
        ],
        phase: turn1,
      }),
      [[S16, 1]],
    );
    const flipped = apply(ahead, 1, END);
    expect(types(flipped.events)).toEqual([
      'trapLapsed',
      'effectAttached',
      'turnEnded',
      'turnStarted',
    ]);
    expect(flipped.state.phase).toEqual({ kind: 'turn', active: 0 });
    expect(flipped.state.board.armedTraps).toBeUndefined();
    expect(flipped.state.board.attachedSpells).toEqual([
      { cardId: S16, seat: 1, targetCardId: R3, branch: 'secondary' },
    ]);

    // 40 vs 10 -> 10 vs 10 after the lapse: the turn passes and remembers the ending seat.
    const equal = withTraps(stateOf({ hands: [[], []], stacks: [[R1, R3], [B1]], phase: turn1 }), [
      [S16, 1],
    ]);
    const passed = apply(equal, 1, END);
    expect(passed.state.phase).toEqual({ kind: 'turn', active: 0, equalEndBy: 1 });
    expect(passed.state.board.armedTraps).toBeUndefined();
  });

  it('after S-11 (no turn end, RD-172) the End Turn ends the round while the own trap is armed', () => {
    // Seat 1 (behind) casts S-11 on R3 (the only level <= 3): 90 vs 30, so its End Turn ends
    // the round (RD-169); seat 1's own S-16 lapses (-30 on R5) and it ends on 60 vs 30.
    const s = withTraps(
      stateOf({
        hands: [[], [spell(11)]],
        stacks: [
          [R3, R4, cr('red', 5)],
          [B1, B2],
        ],
        phase: { kind: 'turn', active: 1 },
      }),
      [[S16, 1]],
    );
    const cast = apply(s, 1, ps(spell(11)));
    expect(cast.state.phase).toEqual({ kind: 'turn', active: 1 });
    const { state, events } = apply(cast.state, 1, END);
    expect(types(events)).toEqual(['trapLapsed', 'effectAttached', 'turnEnded', 'roundOver']);
    expect(state.phase).toMatchObject({
      kind: 'roundOver',
      reason: 'opponentAhead',
      atk: [60, 30],
    });
    expect(state.board.armedTraps).toBeUndefined();
    expect(resolveRound(ctx, state, rng(), 1)).toMatchObject({
      ok: true,
      outcome: { kind: 'win', winner: 0, atk: [60, 30] },
    });
  });

  it('a p1NoBase End Turn lapses the armed traps of P2 first (RD-67, RD-156)', () => {
    const s = withTraps(
      deepFreeze({
        ...stateOf({ hands: [[spell(1)], []], deck: [R4], phase: { kind: 'p1Base', active: 0 } }),
        baseLevel: null,
      }),
      [
        [S12, 1],
        [S16, 1],
      ],
    );
    const { state, events } = apply(s, 0, END);
    // S-16's nerf finds no Leading creature on seat 0: nothing attached, graveyard (RD-153).
    expect(types(events)).toEqual([
      'trapLapsed',
      'cardsDrawn',
      'spellDrawResolved',
      'trapLapsed',
      'turnEnded',
      'roundOver',
    ]);
    expect(state.phase).toMatchObject({ kind: 'roundOver', reason: 'p1NoBase' });
    expect(state.board.zones.hands[1]).toEqual([R4]);
    expect(state.board.armedTraps).toBeUndefined();
    expect(state.board.zones.graveyard).toEqual(expect.arrayContaining([S12, S16]));
    expect(resolveRound(ctx, state, rng(), 1)).toMatchObject({ ok: true });
  });

  it('the match layer resolves and cleans up the round with every card conserved', () => {
    const r = applyMatchCommand(ctx, matchOf(armedRound()), 1, END, rng(3));
    if (!r.ok) throw new Error(r.code);
    expect(r.state.roundNumber).toBe(4);
    expect(r.state.round.board.armedTraps).toBeUndefined();
    expect(r.state.round.board.zones.graveyard).toContain(S16);
    const all = Object.keys(ctx.cards).sort();
    expect(roundCardIds(r.state.round).sort()).toEqual(all);
  });

  it('resolveRound, cleanupRound and startRound throw with armed traps (programmer errors)', () => {
    const s = armedRound();
    const over: RoundState = deepFreeze({
      ...s,
      phase: { kind: 'roundOver', reason: 'opponentAhead', seat: 1, atk: [30, 10] },
    });
    expect(() => resolveRound(ctx, over, rng(), 1)).toThrow(/armed traps/);
    const outcome = {
      kind: 'draw',
      reason: 'p1NoBase',
      atk: [0, 0],
      tieBreakIterations: 0,
    } as const;
    expect(() => cleanupRound(s.board, outcome, rng())).toThrow(/armed traps/);
    const empty: Board = { ...s.board, zones: { ...s.board.zones, stacks: [[], []] } };
    expect(() => startRound(empty, 0)).toThrow(/armed traps/);
  });
});
