import { describe, expect, it } from 'vitest';
import {
  cleanupRound,
  createRoundContext,
  setupNextRound,
  creatureAtk,
  legalCommands,
  ownerOf,
  removeFromStacks,
  stackAtk,
  swapStacks,
  takeControl,
  type CardId,
  type RoundEvent,
} from '../../src/cartignon/index.js';
import {
  STACKS,
  apply,
  catalogWithModifiers,
  cr,
  ctx,
  expectReject,
  resolveDirect,
  ps,
  rng,
  spell,
  stateOf,
  types,
} from './spell-kit.js';
import { deepFreeze } from './test-fixtures.js';

// Per-spell Primary tests (ADR-0007 mapping table, R4c-1): feasible path, infeasible -> Secondary
// path (RD-14 / RD-119), and the activation edge where relevant (ADR-0007 section 4).
// Placeholder creatures have atk = level * 10.

const drawn = (events: readonly RoundEvent[]) =>
  events.filter((e) => e.type === 'cardsDrawn').map((e) => [e.seat, e.reason, e.cardIds.length]);

describe('S-02 (RD-102): hand difference draws from the graveyard', () => {
  it('d >= 2: caster draws 2 from the graveyard, the opponent 1 from the deck', () => {
    const s = stateOf({
      hands: [
        [spell(2), cr('red', 5)],
        [cr('violet', 1), cr('violet', 2), cr('violet', 3)],
      ],
      stacks: STACKS,
      deck: [cr('yellow', 1), cr('yellow', 2)],
    });
    const { state, events } = apply(s, 0, ps(spell(2)));
    expect(events[0]).toMatchObject({ branch: 'primary' });
    expect(drawn(events)).toEqual([
      [0, 'spellGraveyard', 2],
      [1, 'spellDeck', 1],
    ]);
    expect(state.board.zones.hands[0]).toHaveLength(3);
    expect(state.board.zones.hands[1]).toEqual([
      cr('violet', 1),
      cr('violet', 2),
      cr('violet', 3),
      cr('yellow', 1),
    ]);
    expect(state.board.zones.graveyard).toContain(spell(2));
  });

  it('d = 1 (counted without the spell, RD-116): draws 1 from the graveyard', () => {
    // Own hand 2 incl. the spell -> 1; opponent 2 -> d = 1.
    const s = stateOf({
      hands: [
        [spell(2), cr('red', 5)],
        [cr('violet', 1), cr('violet', 2)],
      ],
      stacks: STACKS,
      deck: [cr('yellow', 1)],
    });
    const { events } = apply(s, 0, ps(spell(2)));
    expect(drawn(events)).toEqual([
      [0, 'spellGraveyard', 1],
      [1, 'spellDeck', 1],
    ]);
  });

  it('d <= 0 -> Secondary: buff the own Leading creature +30', () => {
    const s = stateOf({ hands: [[spell(2), cr('red', 5)], [cr('violet', 1)]], stacks: STACKS });
    const { state, events } = apply(s, 0, ps(spell(2)));
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(drawn(events)).toEqual([]);
    expect(creatureAtk(ctx.cards, state.board, cr('red', 2))).toBe(50);
  });

  it('an empty graveyard keeps the Primary feasible but unplayable (RD-93, RD-175)', () => {
    const s = stateOf({ hands: [[spell(2)], [cr('violet', 1), cr('violet', 2)]], stacks: STACKS });
    expect(s.board.zones.graveyard).toEqual([]);
    // RD-175: the caster would gain nothing (the opponent's draw alone does not count).
    expectReject(s, 0, ps(spell(2)), 'SPELL_NO_EFFECT');
    // Resolved directly (as through S-19): the Primary still runs and draws nothing.
    const { events } = resolveDirect(s, 0, spell(2));
    expect(events[0]).toMatchObject({ branch: 'primary' });
    expect(drawn(events)).toEqual([
      [0, 'spellGraveyard', 0],
      [1, 'spellDeck', 1],
    ]);
  });

  it('seat 1 as caster: seat 1 draws from the graveyard, seat 0 (the opponent) from the deck', () => {
    // Seat 1 on turn: own hand 2 incl. the spell -> 1; seat 0 holds 3 -> d = 2.
    const s = stateOf({
      hands: [
        [cr('violet', 1), cr('violet', 2), cr('violet', 3)],
        [spell(2), cr('red', 5)],
      ],
      stacks: STACKS,
      deck: [cr('yellow', 1), cr('yellow', 2)],
      phase: { kind: 'turn', active: 1 },
    });
    const graveyard = s.board.zones.graveyard;
    const { state, events } = apply(s, 1, ps(spell(2)));
    expect(events[0]).toEqual({
      type: 'spellPlayed',
      seat: 1,
      cardId: spell(2),
      branch: 'primary',
    });
    expect(drawn(events)).toEqual([
      [1, 'spellGraveyard', 2],
      [0, 'spellDeck', 1],
    ]);
    expect(events.filter((e) => e.type === 'spellDrawResolved')).toEqual([
      { type: 'spellDrawResolved', seat: 1, from: 'graveyard', requested: 2, drawn: 2 },
      { type: 'spellDrawResolved', seat: 0, from: 'deck', requested: 1, drawn: 1 },
    ]);
    const hand1 = state.board.zones.hands[1];
    expect(hand1).toHaveLength(3);
    expect(hand1.slice(1).every((id) => graveyard.includes(id))).toBe(true);
    expect(state.board.zones.hands[0]).toEqual([
      cr('violet', 1),
      cr('violet', 2),
      cr('violet', 3),
      cr('yellow', 1),
    ]);
  });

  it('empty graveyard (resolved directly): requested 2, drawn 0; the opponent still draws 1', () => {
    const s = stateOf({
      hands: [[spell(2)], [cr('violet', 1), cr('violet', 2), cr('violet', 3)]],
      stacks: STACKS,
    });
    expect(s.board.zones.graveyard).toEqual([]);
    // Not playable (RD-175); resolved as through S-19 to check the reporting.
    const { board, events } = resolveDirect(s, 0, spell(2));
    const state = { board };
    expect(events[0]).toMatchObject({ type: 'spellPlayed', seat: 0, branch: 'primary' });
    expect(events.filter((e) => e.type === 'spellDrawResolved')).toEqual([
      { type: 'spellDrawResolved', seat: 0, from: 'graveyard', requested: 2, drawn: 0 },
      { type: 'spellDrawResolved', seat: 1, from: 'deck', requested: 1, drawn: 1 },
    ]);
    expect(state.board.zones.hands[0]).toEqual([]);
    expect(state.board.zones.hands[1]).toHaveLength(4);
  });
});

describe('S-03 (RD-107): stack swap', () => {
  // Seat 0: red-1..3 (60); seat 1: blue-1..3 (60). blue-3 sits at position 2 with drawDeck there.
  const drawCtx = createRoundContext(catalogWithModifiers([['blue', 3, ['buffSelf', 'drawDeck']]]));
  const own = [cr('red', 1), cr('red', 2), cr('red', 3)];
  const opp = [cr('blue', 1), cr('blue', 2), cr('blue', 3)];

  it('equal counts >= 3: stacks change sides; -100 on the caster Leading; nothing activates', () => {
    const s = stateOf({
      hands: [[spell(3)], []],
      stacks: [own, opp],
      board: { linkUpPending: [false, true] },
    });
    const { state, events } = apply(s, 0, ps(spell(3)), 1, drawCtx);
    expect(types(events)).toEqual([
      'spellPlayed',
      'stacksSwapped',
      'effectAttached',
      'spellResolved',
    ]);
    expect(state.board.zones.stacks).toEqual([opp, own]);
    // Link Up state travels with its stack (RD-107, Proposed).
    expect(state.board.linkUpPending).toEqual([true, false]);
    // The caster's Leading after the swap is blue-3 (30); -100 floors it at 0 (RD-61).
    expect(state.board.attachedSpells).toEqual([
      { cardId: spell(3), seat: 0, targetCardId: cr('blue', 3), branch: 'primary' },
    ]);
    expect(creatureAtk(drawCtx.cards, state.board, cr('blue', 3))).toBe(0);
    // Ownership moves with the stack (RD-135).
    expect(ownerOf(state.board, cr('blue', 3))).toBe(0);
    expect(ownerOf(state.board, cr('red', 1))).toBe(1);
  });

  it('unequal counts or fewer than 3 -> Secondary: draw 1 from the graveyard', () => {
    for (const stacks of [
      [own, opp.slice(0, 2)],
      [own.slice(0, 2), opp.slice(0, 2)],
    ] as const) {
      // RD-175: a non-empty graveyard, else the Secondary would draw nothing (unplayable).
      const s = stateOf({
        hands: [[spell(3)], []],
        stacks: [[...stacks[0]], [...stacks[1]]],
        graveyard: [cr('green', 1)],
      });
      const { state, events } = apply(s, 0, ps(spell(3)));
      expect(events[0]).toMatchObject({ branch: 'secondary' });
      expect(drawn(events)).toEqual([[0, 'spellGraveyard', 1]]);
      expect(state.board.zones.stacks).toEqual(stacks);
    }
  });

  it('board swap: stack effects travel with the stack', () => {
    const s = stateOf({ hands: [[], []], stacks: [own, opp] });
    const board = deepFreeze({
      ...s.board,
      stackEffects: [
        { effectId: 'e1', kind: 'stackAtkDelta', seat: 1, amount: -50, sourceCardId: spell(15) },
      ],
    } as const);
    const r = swapStacks(board);
    expect(r.board.stackEffects).toMatchObject([{ seat: 0, amount: -50 }]);
    expect(swapStacks(r.board).board).toEqual(board);
  });

  it('S-03 then S-04 by commands: returned cards go to the seat that holds the stack (RD-135)', () => {
    // 3 + 3 is the minimum for S-03, and no R4c-1 spell can bring 6 down to exactly 3, so after
    // the swap the board is trimmed directly (removing whole cards from both stacks).
    const s = stateOf({ hands: [[spell(3), spell(4)], []], stacks: [own, opp] });
    const swapped = apply(s, 0, ps(spell(3))).state;
    expect(swapped.board.zones.stacks).toEqual([opp, own]);
    const trimmed = removeFromStacks(ctx.cards, swapped.board, [
      { cardId: cr('blue', 3), to: { zone: 'graveyard' } },
      { cardId: cr('red', 3), to: { zone: 'graveyard' } },
      { cardId: cr('red', 2), to: { zone: 'graveyard' } },
    ]);
    if (!trimmed.ok) throw new Error(trimmed.code);
    const before = deepFreeze({ ...swapped, board: trimmed.board });
    // Seat 0 now holds blue-1, blue-2 (from seat 1's former stack); seat 1 holds red-1.
    const { state } = apply(before, 0, ps(spell(4)));
    expect(state.board.zones.hands).toEqual([[cr('blue', 1), cr('blue', 2)], [cr('red', 1)]]);
  });
});

describe('S-04: exactly 3 creatures return to their owners, replay-locked (RD-172)', () => {
  it('returns all three in one step; the caster stays on turn; locks clear at End Turn', () => {
    // Seat 0: red-1, red-2 (red-2 carries drawDeck at position 1); seat 1: blue-1.
    const c = createRoundContext(catalogWithModifiers([['red', 2, ['drawDeck']]]));
    const s = stateOf({
      hands: [[spell(4)], [cr('violet', 4)]],
      stacks: [[cr('red', 1), cr('red', 2)], [cr('blue', 1)]],
    });
    const { state, events } = apply(s, 0, ps(spell(4)), 1, c);
    expect(types(events)).toEqual([
      'spellPlayed',
      'creatureRemoved',
      'creatureRemoved',
      'creatureRemoved',
      'modifierSilenced',
      'replayLocked',
      'replayLocked',
      'replayLocked',
      'spellResolved',
    ]);
    expect(state.board.zones.stacks).toEqual([[], []]);
    expect(state.board.zones.hands).toEqual([
      [cr('red', 1), cr('red', 2)],
      [cr('violet', 4), cr('blue', 1)],
    ]);
    // RD-172: the turn does not end; each returned creature is locked for its owner (RD-135).
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
    expect(state.turnLocks).toEqual([
      { seat: 0, cardId: cr('red', 1) },
      { seat: 0, cardId: cr('red', 2) },
      { seat: 1, cardId: cr('blue', 1) },
    ]);
    expect(state.stackEmptiedBySpell).toBe(true);
    expectReject(state, 0, { type: 'playCreature', cardId: cr('red', 1) }, 'CARD_REPLAY_LOCKED');
    expect(legalCommands(c, state, 0).some((x) => x.type === 'playCreature')).toBe(false);
    const ended = apply(state, 0, { type: 'endTurn' }, 1, c).state;
    expect(ended.phase).toEqual({ kind: 'turn', active: 1, equalEndBy: 0 }); // 0 = 0 (RD-169)
    expect(ended.turnLocks).toBeUndefined();
    // RD-105: any creature becomes the new Base (no RD-07 limits, no p2Opening, no nulling).
    const next = apply(ended, 1, { type: 'playCreature', cardId: cr('violet', 4) }, 1, c);
    expect(next.events[0]).toMatchObject({ type: 'creaturePlayed', role: 'midRoundBase' });
    expect(legalCommands(c, next.state, 1).some((x) => x.type === 'nullify')).toBe(false);
  });

  it('cast by P2 in p2Opening: P2 stays on turn in a normal turn; never re-enters p2Opening', () => {
    // P1 (seat 0) has 3 creatures; P2 (seat 1) has no Base yet.
    const s = stateOf({
      hands: [[cr('green', 4)], [spell(4), cr('orange', 1)]],
      stacks: [[cr('red', 1), cr('red', 2), cr('red', 3)], []],
      phase: { kind: 'p2Opening', active: 1 },
    });
    const { state } = apply(s, 1, ps(spell(4)));
    // RD-172: P2 keeps the turn; P1 lost its Base, so p2Opening is over (RD-144).
    expect(state.phase).toEqual({ kind: 'turn', active: 1 });
    expect(state.stackEmptiedBySpell).toBe(true);
    expect(state.board.zones.hands[0]).toEqual([
      cr('green', 4),
      cr('red', 1),
      cr('red', 2),
      cr('red', 3),
    ]);
    expect(legalCommands(ctx, state, 1).some((x) => x.type === 'nullify')).toBe(false);
    const passed = apply(state, 1, { type: 'endTurn' }).state;
    expect(passed.phase).toEqual({ kind: 'turn', active: 0, equalEndBy: 1 }); // 0 = 0 (RD-169)
    expect(passed.turnLocks).toBeUndefined();
    const based = apply(passed, 0, { type: 'playCreature', cardId: cr('green', 4) });
    expect(based.events[0]).toMatchObject({ role: 'midRoundBase' });
    const p2 = apply(based.state, 0, { type: 'endTurn' }).state;
    expect(p2.phase).toEqual({ kind: 'turn', active: 1 });
    expect(legalCommands(ctx, p2, 1).some((x) => x.type === 'nullify')).toBe(false);
    expectReject(p2, 1, { type: 'nullify', cardId: cr('orange', 1) }, 'NOT_ALLOWED_IN_PHASE');
  });

  it('RD-138 (user): only the emptied seat places the new Base, in its own turn', () => {
    // Seat 0's S-11 returns seat 1's only creature (RD-118); seat 0 stays on turn (RD-172).
    const s = stateOf({
      hands: [[spell(11), cr('blue', 2)], [cr('green', 4)]],
      stacks: [[cr('blue', 1)], [cr('red', 2)]],
    });
    const emptied = apply(s, 0, ps(spell(11))).state;
    expect(emptied.board.zones.stacks[1]).toEqual([]);
    expect(emptied.phase).toEqual({ kind: 'turn', active: 0 });
    // Seat 0's next play goes onto its OWN stack, never onto the emptied one.
    const own = apply(emptied, 0, { type: 'playCreature', cardId: cr('blue', 2) });
    expect(own.events[0]).toMatchObject({ seat: 0, role: 'stack' });
    expect(own.state.board.zones.stacks).toEqual([[cr('blue', 1), cr('blue', 2)], []]);
    // Seat 1, in its own turn, places the new Base (any creature, RD-105).
    const back = apply(own.state, 0, { type: 'endTurn' }).state;
    const based = apply(back, 1, { type: 'playCreature', cardId: cr('green', 4) });
    expect(based.events[0]).toMatchObject({ seat: 1, role: 'midRoundBase' });
    expect(based.state.board.zones.stacks).toEqual([
      [cr('blue', 1), cr('blue', 2)],
      [cr('green', 4)],
    ]);
  });

  it('stackEmptiedBySpell does not survive into the next round', () => {
    const s = stateOf({
      hands: [[spell(4)], []],
      stacks: [[cr('red', 1), cr('red', 2)], [cr('blue', 1)]],
    });
    const { state } = apply(s, 0, ps(spell(4)));
    expect(state.stackEmptiedBySpell).toBe(true);
    const outcome = {
      kind: 'draw',
      reason: 'tieBreakDeckOut',
      atk: [0, 0],
      tieBreakIterations: 0,
    } as const;
    const cleaned = cleanupRound(state.board, outcome, rng());
    const next = setupNextRound(ctx, cleaned.board, 1, rng());
    if (next.kind !== 'started') throw new Error(next.kind);
    expect(next.state.stackEmptiedBySpell).toBeUndefined();
    expect(next.state.board.copiedModifiers).toEqual([]);
  });

  it('not exactly 3 -> Secondary: draw 1 from the deck; the turn goes on', () => {
    const s = stateOf({ hands: [[spell(4)], []], stacks: STACKS });
    const four = stateOf({
      hands: [[spell(4)], []],
      stacks: [
        [cr('red', 1), cr('red', 2)],
        [cr('blue', 1), cr('blue', 2)],
      ],
    });
    expect(apply(s, 0, ps(spell(4))).events[0]).toMatchObject({ branch: 'primary' });
    const { state, events } = apply(four, 0, ps(spell(4)));
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(drawn(events)).toEqual([[0, 'spellDeck', 1]]);
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
  });

  it('RD-172: no forced End Turn; the later End Turn at 0 = 0 passes the turn (RD-169)', () => {
    const s = stateOf({
      hands: [[spell(4)], []],
      stacks: [[cr('red', 1)], [cr('blue', 1), cr('blue', 2)]],
    });
    const { state, events } = apply(s, 0, ps(spell(4)));
    expect(types(events)).not.toContain('turnEnded');
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
    const ended = apply(state, 0, { type: 'endTurn' }).state;
    expect(ended.phase).toEqual({ kind: 'turn', active: 1, equalEndBy: 0 });
  });

  it('removeFromStacks compares liveness once: no intermediate activation', () => {
    const c = createRoundContext(catalogWithModifiers([['red', 2, ['drawDeck']]]));
    const board = stateOf({
      hands: [[], []],
      stacks: [[cr('red', 1), cr('red', 2), cr('red', 3)], []],
    }).board;
    // One by one, removing red-3 first would make red-2 Leading at position 1 (drawDeck).
    const r = removeFromStacks(c.cards, board, [
      { cardId: cr('red', 3), to: { zone: 'graveyard' } },
      { cardId: cr('red', 2), to: { zone: 'graveyard' } },
    ]);
    if (!r.ok) throw new Error(r.code);
    expect(types(r.events)).toEqual(['creatureRemoved', 'creatureRemoved']);
  });
});

describe('S-06 (RD-111): copy the opponent Leading creature live modifier', () => {
  const own: CardId[] = [cr('red', 1), cr('red', 2)];

  it('buffSelf copy: +30 on the caster Leading creature (the carrier) while live', () => {
    // orange-3 at position 1: buffSelf live.
    const s = stateOf({
      hands: [[spell(6)], []],
      stacks: [own, [cr('violet', 1), cr('orange', 3)]],
    });
    const { state, events } = apply(s, 0, ps(spell(6)));
    expect(events[0]).toMatchObject({ branch: 'primary' });
    expect(events[1]).toEqual({
      type: 'modifierCopied',
      seat: 0,
      sourceCardId: cr('orange', 3),
      kind: 'buffSelf',
    });
    expect(creatureAtk(ctx.cards, state.board, cr('red', 2))).toBe(50);
    expect(state.board.attachedSpells).toMatchObject([{ targetCardId: cr('red', 2) }]);
  });

  it('nerf copy: -30 on the opponent Leading creature while the carrier is live', () => {
    // blue-4 at position 1: nerfEnemyLeader live (it already nerfs red-2 by 30).
    const s = stateOf({ hands: [[spell(6)], []], stacks: [own, [cr('violet', 1), cr('blue', 4)]] });
    const { state } = apply(s, 0, ps(spell(6)));
    expect(creatureAtk(ctx.cards, state.board, cr('blue', 4))).toBe(10);
  });

  it('Link Up copy: the caster gets an armed Link Up', () => {
    // orange-3 at position 2: linkUp live.
    const s = stateOf({
      hands: [[spell(6), cr('green', 5)], []],
      stacks: [own, [cr('violet', 1), cr('violet', 2), cr('orange', 3)]],
    });
    const { state, events } = apply(s, 0, ps(spell(6)));
    expect(events).toContainEqual({ type: 'linkUpArmed', seat: 0, sourceCardId: cr('red', 2) });
    expect(state.board.linkUpPending).toEqual([true, false]);
    // RD-10: any level may now be placed (green-5 onto red-2).
    apply(state, 0, { type: 'playCreature', cardId: cr('green', 5) });
  });

  it('draw copy: the caster draws 1 from that source', () => {
    const c = createRoundContext(catalogWithModifiers([['violet', 2, ['drawGrave']]]));
    const s = stateOf({
      hands: [[spell(6)], []],
      stacks: [own, [cr('violet', 1), cr('violet', 2)]],
      deck: [cr('green', 1)],
    });
    const { events } = apply(s, 0, ps(spell(6)), 1, c);
    expect(drawn(events)).toEqual([[0, 'modifierGraveyard', 1]]);
  });

  it('no live modifier, or no own Leading creature -> Secondary: nerf the opponent Leading', () => {
    const cases: [CardId[], CardId[]][] = [
      [own, [cr('violet', 1)]], // the Base is never live
      [[], [cr('violet', 1), cr('orange', 3)]], // no own Leading creature
    ];
    for (const stacks of cases) {
      const s = stateOf({ hands: [[spell(6)], []], stacks });
      const { state, events } = apply(s, 0, ps(spell(6)));
      expect(events[0]).toMatchObject({ branch: 'secondary' });
      const leader = stacks[1].at(-1);
      expect(state.board.attachedEffects).toMatchObject([{ amount: -30, targetCardId: leader }]);
    }
  });
});

describe('S-08 (RD-60): the opponent Leading creature dies', () => {
  const opp = [cr('blue', 1), cr('blue', 2), cr('blue', 3), cr('blue', 5)];

  it('>= 4 creatures: Leading -> graveyard; the new Leading creature activates (RD-124)', () => {
    // blue-3 back at position 2 carries drawDeck there; seat 1 (the controller) draws (RD-123).
    const c = createRoundContext(catalogWithModifiers([['blue', 3, ['buffSelf', 'drawDeck']]]));
    const s = stateOf({ hands: [[spell(8)], []], stacks: [[cr('red', 1)], opp] });
    const { state, events } = apply(s, 0, ps(spell(8)), 1, c);
    expect(types(events)).toEqual([
      'spellPlayed',
      'creatureRemoved',
      'modifierLive',
      'cardsDrawn',
      'spellResolved',
    ]);
    expect(events[2]).toMatchObject({
      seat: 1,
      cardId: cr('blue', 3),
      kind: 'drawDeck',
      position: 2,
    });
    expect(drawn(events)).toEqual([[1, 'modifierDeck', 1]]);
    expect(state.board.zones.stacks[1]).toEqual(opp.slice(0, 3));
    expect(state.board.zones.graveyard).toEqual([cr('blue', 5), spell(8)]);
  });

  it('fewer than 4 -> Secondary: draw 1 from the deck', () => {
    const s = stateOf({ hands: [[spell(8)], []], stacks: [[cr('red', 1)], opp.slice(0, 3)] });
    const { state, events } = apply(s, 0, ps(spell(8)));
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(state.board.zones.stacks[1]).toEqual(opp.slice(0, 3));
  });
});

describe('S-14 (RD-113): the first linked card (position 1) dies; the rest shift down', () => {
  it('a shifted Leading creature activates at its new position (RD-105, RD-124)', () => {
    // green-3 carries drawDeck at position 1; it moves from position 2 to 1.
    const c = createRoundContext(catalogWithModifiers([['green', 3, ['drawDeck', 'buffSelf']]]));
    const opp = [cr('blue', 1), cr('blue', 2), cr('green', 3)];
    const s = stateOf({ hands: [[spell(14)], []], stacks: [[cr('red', 1)], opp] });
    const { state, events } = apply(s, 0, ps(spell(14)), 1, c);
    expect(types(events)).toEqual([
      'spellPlayed',
      'creatureRemoved',
      'modifierSilenced',
      'modifierLive',
      'cardsDrawn',
      'spellResolved',
    ]);
    expect(events[1]).toMatchObject({
      cardId: cr('blue', 2),
      position: 1,
      to: { zone: 'graveyard' },
    });
    expect(events[3]).toMatchObject({ cardId: cr('green', 3), kind: 'drawDeck', position: 1 });
    expect(state.board.zones.stacks[1]).toEqual([cr('blue', 1), cr('green', 3)]);
  });

  it('a 2-card stack: the Leading creature dies, the Base is Leading and never live', () => {
    const s = stateOf({
      hands: [[spell(14)], []],
      stacks: [[cr('red', 1)], [cr('violet', 1), cr('orange', 3)]],
    });
    const { state, events } = apply(s, 0, ps(spell(14)));
    expect(types(events)).toEqual([
      'spellPlayed',
      'creatureRemoved',
      'modifierSilenced',
      'spellResolved',
    ]);
    expect(state.board.zones.stacks[1]).toEqual([cr('violet', 1)]);
  });

  it('fewer than 2 -> Secondary: nerf the opponent Leading creature', () => {
    const s = stateOf({ hands: [[spell(14)], []], stacks: [[cr('red', 1)], [cr('violet', 3)]] });
    const { state, events } = apply(s, 0, ps(spell(14)));
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(creatureAtk(ctx.cards, state.board, cr('violet', 3))).toBe(0);
  });
});

describe('S-15: -50 on the opponent whole stack until round end', () => {
  // Opponent red-1..5 = 150.
  const strong = [cr('red', 1), cr('red', 2), cr('red', 3), cr('red', 4), cr('red', 5)];

  it('>= 125 behind: a stack effect, independent of the Leading creature', () => {
    const s = stateOf({ hands: [[spell(15)], [spell(8)]], stacks: [[cr('blue', 1)], strong] });
    const { state, events } = apply(s, 0, ps(spell(15)));
    expect(events).toEqual([
      { type: 'spellPlayed', seat: 0, cardId: spell(15), branch: 'primary' },
      {
        type: 'stackEffectAdded',
        effect: {
          effectId: 'e1',
          kind: 'stackAtkDelta',
          seat: 1,
          amount: -50,
          sourceCardId: spell(15),
        },
      },
      { type: 'spellResolved', seat: 0, cardId: spell(15), destination: 'graveyard' },
    ]);
    expect(stackAtk(ctx.cards, state.board, 1)).toBe(100);
    expect(state.board.attachedSpells).toEqual([]);
    // The effect stays when the Leading creature changes: remove red-5.
    const r = removeFromStacks(ctx.cards, state.board, [
      { cardId: cr('red', 5), to: { zone: 'graveyard' } },
    ]);
    if (!r.ok) throw new Error(r.code);
    expect(stackAtk(ctx.cards, r.board, 1)).toBe(50); // 100 - 50
  });

  it('the stack total is floored at 0 (Proposed)', () => {
    const s = stateOf({ hands: [[spell(15)], []], stacks: [[cr('blue', 1)], strong] });
    const board = apply(s, 0, ps(spell(15))).state.board;
    const r = removeFromStacks(
      ctx.cards,
      board,
      strong.slice(1).map((cardId) => ({ cardId, to: { zone: 'graveyard' } as const })),
    );
    if (!r.ok) throw new Error(r.code);
    expect(stackAtk(ctx.cards, r.board, 1)).toBe(0); // 10 - 50
  });

  it('RD-134 (user): the effect ends when its stack becomes completely empty', () => {
    const s = stateOf({ hands: [[spell(15)], []], stacks: [[cr('blue', 1)], strong] });
    const board = apply(s, 0, ps(spell(15))).state.board;
    const effect = board.stackEffects[0];
    // Removing all but one keeps it; removing the last one ends it.
    const four = removeFromStacks(
      ctx.cards,
      board,
      strong.slice(1).map((cardId) => ({ cardId, to: { zone: 'graveyard' } as const })),
    );
    if (!four.ok) throw new Error(four.code);
    expect(four.board.stackEffects).toEqual([effect]);
    expect(types(four.events)).not.toContain('stackEffectEnded');
    const all = removeFromStacks(ctx.cards, four.board, [
      { cardId: cr('red', 1), to: { zone: 'graveyard' } },
    ]);
    if (!all.ok) throw new Error(all.code);
    expect(all.board.stackEffects).toEqual([]);
    expect(all.events.at(-1)).toEqual({ type: 'stackEffectEnded', effect });
    // The S-15 card was already in the graveyard (RD-134: it never attaches).
    expect(all.board.zones.graveyard).toContain(spell(15));
    // After a swap the effect travels; taking the last creature empties the stack too.
    const swapped = swapStacks(four.board).board;
    expect(swapped.stackEffects).toEqual([{ ...effect, seat: 0 }]);
    const taken = takeControl(ctx.cards, swapped, 1, cr('red', 1));
    if (!taken.ok) throw new Error(taken.code);
    expect(taken.board.stackEffects).toEqual([]);
    expect(types(taken.events)).toContain('stackEffectEnded');
  });

  it('RD-134 (user): a new Base on the emptied stack starts without -50', () => {
    // Seat 1's single creature carries the S-15 stack effect (S-15 in the graveyard); seat 0's
    // S-11 returns it to the hand (RD-118); seat 0 then ends its turn (RD-172).
    const base = stateOf({
      hands: [[spell(11)], []],
      stacks: [[cr('blue', 1)], [cr('red', 2)]],
      deck: [cr('red', 4)],
    });
    const effect = {
      effectId: 'e1',
      kind: 'stackAtkDelta',
      seat: 1,
      amount: -50,
      sourceCardId: spell(15),
    } as const;
    const s = deepFreeze({ ...base, board: { ...base.board, stackEffects: [effect] } });
    expect(stackAtk(ctx.cards, s.board, 1)).toBe(0);
    const { state, events } = apply(s, 0, ps(spell(11)));
    expect(events).toContainEqual({ type: 'stackEffectEnded', effect });
    expect(state.board.stackEffects).toEqual([]);
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
    // The lock on red-2 (seat 1's, RD-172) clears with seat 0's End Turn.
    const back = apply(state, 0, { type: 'endTurn' }).state;
    const based = apply(back, 1, { type: 'playCreature', cardId: cr('red', 2) });
    expect(based.events[0]).toMatchObject({ role: 'midRoundBase' });
    expect(stackAtk(ctx.cards, based.state.board, 1)).toBe(20);
  });

  it('less than 125 behind -> Secondary: buff the own Leading creature', () => {
    const s = stateOf({ hands: [[spell(15)], []], stacks: [[cr('blue', 3)], strong] });
    const { state, events } = apply(s, 0, ps(spell(15))); // 150 - 30 = 120
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(state.board.stackEffects).toEqual([]);
    expect(creatureAtk(ctx.cards, state.board, cr('blue', 3))).toBe(60);
  });
});

describe('determinism and validation', () => {
  it('the same seed gives the same result', () => {
    const s = stateOf({
      hands: [[spell(2)], [cr('violet', 1), cr('violet', 2), cr('violet', 3)]],
      stacks: STACKS,
      deck: [cr('yellow', 1)],
    });
    expect(JSON.stringify(apply(s, 0, ps(spell(2)), 5))).toBe(
      JSON.stringify(apply(s, 0, ps(spell(2)), 5)),
    );
  });

  it('a creature id is never a spell', () => {
    const s = stateOf({ hands: [[cr('red', 3)], []], stacks: STACKS });
    expectReject(s, 0, ps(cr('red', 3)), 'NOT_A_SPELL');
  });
});

describe('RD-133: copied Buff/Nerf behave like a positional modifier of the carrier', () => {
  const own: CardId[] = [cr('red', 1), cr('red', 2)];

  it('silenced when a creature is linked on top, live again when the carrier leads again', () => {
    const s = stateOf({
      hands: [[spell(6), cr('red', 3)], []],
      stacks: [own, [cr('violet', 1), cr('orange', 3)]],
    });
    const copied = apply(s, 0, ps(spell(6)));
    expect(types(copied.events)).toEqual([
      'spellPlayed',
      'modifierCopied',
      'copiedModifierAdded',
      'spellResolved',
    ]);
    expect(copied.state.board.copiedModifiers).toEqual([
      { effectId: 'e1', kind: 'buffSelf', carrierCardId: cr('red', 2), sourceCardId: spell(6) },
    ]);
    const covered = apply(copied.state, 0, { type: 'playCreature', cardId: cr('red', 3) }).state;
    expect(creatureAtk(ctx.cards, covered.board, cr('red', 2))).toBe(20); // silenced
    const r = removeFromStacks(ctx.cards, covered.board, [
      { cardId: cr('red', 3), to: { zone: 'graveyard' } },
    ]);
    if (!r.ok) throw new Error(r.code);
    expect(creatureAtk(ctx.cards, r.board, cr('red', 2))).toBe(50); // live again
  });

  it('a copied nerf is silenced with its carrier', () => {
    const s = stateOf({
      hands: [[spell(6), cr('red', 3)], []],
      stacks: [own, [cr('violet', 1), cr('blue', 4)]],
    });
    const copied = apply(s, 0, ps(spell(6))).state;
    expect(creatureAtk(ctx.cards, copied.board, cr('blue', 4))).toBe(10);
    const covered = apply(copied, 0, { type: 'playCreature', cardId: cr('red', 3) }).state;
    expect(creatureAtk(ctx.cards, covered.board, cr('blue', 4))).toBe(40);
  });

  it('leaves with its carrier; the S-06 card goes to the graveyard', () => {
    const s = stateOf({
      hands: [[spell(6)], []],
      stacks: [own, [cr('violet', 1), cr('orange', 3)]],
    });
    const board = apply(s, 0, ps(spell(6))).state.board;
    const r = removeFromStacks(ctx.cards, board, [{ cardId: cr('red', 2), to: { zone: 'deck' } }]);
    if (!r.ok) throw new Error(r.code);
    expect(r.board.copiedModifiers).toEqual([]);
    expect(r.board.attachedSpells).toEqual([]);
    expect(r.board.zones.graveyard).toContain(spell(6));
    expect(types(r.events)).toContain('copiedModifierDiscarded');
  });

  it('caster already armed: no effect, so not playable (RD-175); resolved: Link Up stays single', () => {
    const s = stateOf({
      hands: [[spell(6)], []],
      stacks: [own, [cr('violet', 1), cr('violet', 2), cr('orange', 3)]],
      board: { linkUpPending: [true, false] },
    });
    expectReject(s, 0, ps(spell(6)), 'SPELL_NO_EFFECT');
    // Resolved directly (as through S-19): the Primary runs, no Secondary, nothing changes.
    const { board, events } = resolveDirect(s, 0, spell(6));
    expect(types(events)).toEqual(['spellPlayed', 'modifierCopied', 'spellResolved']);
    expect(events[0]).toMatchObject({ branch: 'primary' });
    expect(board.linkUpPending).toEqual([true, false]);
    expect(board.attachedEffects).toEqual([]);
    expect(board.zones.graveyard).toContain(spell(6));
  });

  it('RD-175: a copied draw from an empty pile has no effect, so S-06 is not playable', () => {
    // orange-3 at position 2 carries drawGrave there (copied by S-06 when it is live).
    const c = createRoundContext(catalogWithModifiers([['orange', 3, ['buffSelf', 'drawGrave']]]));
    const stacks: [CardId[], CardId[]] = [own, [cr('violet', 1), cr('violet', 2), cr('orange', 3)]];
    const empty = stateOf({ hands: [[spell(6)], []], stacks });
    expect(empty.board.zones.graveyard).toEqual([]);
    expect(legalCommands(c, empty, 0)).not.toContainEqual(ps(spell(6)));
    const one = stateOf({ hands: [[spell(6)], []], stacks, graveyard: [cr('green', 1)] });
    expect(legalCommands(c, one, 0)).toContainEqual(ps(spell(6)));
  });

  it('a copied Link Up belongs to the carrier and lapses with it (RD-139)', () => {
    const s = stateOf({
      hands: [[spell(6)], []],
      stacks: [own, [cr('violet', 1), cr('violet', 2), cr('orange', 3)]],
    });
    const board = apply(s, 0, ps(spell(6))).state.board;
    expect(board.linkUpSource).toEqual([cr('red', 2), null]);
    const r = removeFromStacks(ctx.cards, board, [
      { cardId: cr('red', 2), to: { zone: 'graveyard' } },
    ]);
    if (!r.ok) throw new Error(r.code);
    expect(r.board.linkUpPending).toEqual([false, false]);
  });
});

describe('RD-139: an armed Link Up lapses when its creature leaves the field', () => {
  it('S-08 removing the granting Leading creature clears the pending Link Up', () => {
    // Seat 1's Link Up was granted by its Leading creature violet-4 (armed by hand here).
    const opp = [cr('violet', 1), cr('violet', 2), cr('violet', 3), cr('violet', 4)];
    const s = stateOf({ hands: [[spell(8)], []], stacks: [[cr('red', 1)], opp] });
    const armed = deepFreeze({
      ...s,
      board: { ...s.board, linkUpPending: [false, true], linkUpSource: [null, cr('violet', 4)] },
    } as const);
    const { state, events } = apply(armed, 0, ps(spell(8)));
    expect(events).toContainEqual({ type: 'linkUpLapsed', seat: 1, sourceCardId: cr('violet', 4) });
    expect(state.board.linkUpPending).toEqual([false, false]);
    expect(state.board.linkUpSource).toEqual([null, null]);
  });

  it('S-08 re-arms from the newly Leading creature own Link Up (RD-57)', () => {
    // orange-3 at position 2 carries linkUp; violet-4 above it is removed.
    const opp = [cr('violet', 1), cr('violet', 2), cr('orange', 3), cr('violet', 4)];
    const s = stateOf({ hands: [[spell(8)], []], stacks: [[cr('red', 1)], opp] });
    const { state, events } = apply(s, 0, ps(spell(8)));
    expect(types(events)).toEqual([
      'spellPlayed',
      'creatureRemoved',
      'modifierLive',
      'linkUpArmed',
      'spellResolved',
    ]);
    expect(state.board.linkUpPending).toEqual([false, true]);
    expect(state.board.linkUpSource).toEqual([null, cr('orange', 3)]);
  });

  it('S-04 with an armed Link Up: it lapses; the next mid-round Base does not consume one', () => {
    // red-2 (Leading, position 1) granted seat 0's Link Up.
    const c = createRoundContext(catalogWithModifiers([['red', 2, ['linkUp']]]));
    const s = stateOf({
      hands: [[spell(4), cr('green', 5)], [cr('violet', 1)]],
      stacks: [[cr('red', 1), cr('red', 2)], [cr('blue', 1)]],
    });
    const armed = deepFreeze({
      ...s,
      board: { ...s.board, linkUpPending: [true, false], linkUpSource: [cr('red', 2), null] },
    } as const);
    const after = apply(armed, 0, ps(spell(4)), 1, c);
    expect(after.events).toContainEqual({
      type: 'linkUpLapsed',
      seat: 0,
      sourceCardId: cr('red', 2),
    });
    expect(after.state.board.linkUpPending).toEqual([false, false]);
    // RD-172: seat 0 stays on turn and places its mid-round Base at once (green-5 is not locked).
    const based = apply(after.state, 0, { type: 'playCreature', cardId: cr('green', 5) }, 1, c);
    expect(types(based.events)).not.toContain('linkUpConsumed');
    expect(based.events).toContainEqual(
      expect.objectContaining({ type: 'creatureStacked', viaLinkUp: false }),
    );
  });
});

describe('determinism across seeds (2+ graveyard cards)', () => {
  it('different seeds can draw different graveyard cards; each seed is reproducible', () => {
    const s = stateOf({
      hands: [[spell(2)], [cr('violet', 1), cr('violet', 2), cr('violet', 3)]],
      stacks: STACKS,
      deck: [cr('yellow', 1)],
    });
    expect(s.board.zones.graveyard.length).toBeGreaterThan(2);
    const hands = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      const a = apply(s, 0, ps(spell(2)), seed);
      expect(JSON.stringify(apply(s, 0, ps(spell(2)), seed))).toBe(JSON.stringify(a));
      hands.add(JSON.stringify(a.state.board.zones.hands[0]));
    }
    expect(hands.size).toBeGreaterThan(1);
  });
});
