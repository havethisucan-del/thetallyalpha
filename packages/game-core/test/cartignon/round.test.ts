import { describe, expect, it } from 'vitest';
import { createSeededRng, type Rng, type Seat } from '../../src/index.js';
import {
  COLORS,
  activeSeat,
  allCardIds,
  applyCommand,
  roundCardIds,
  createBoard,
  createRoundContext,
  createZones,
  legalCommands,
  shuffleDeck,
  startFirstRound,
  startRound,
  type CardId,
  type Color,
  type CreatureLevel,
  type RoundCommand,
  type RoundErrorCode,
  type RoundEvent,
  type RoundState,
} from '../../src/cartignon/index.js';
import { deepFreeze, placeholderCatalog } from './test-fixtures.js';

// ---------------------------------------------------------------------------------------------
// Helpers. Placeholder catalog ids: creatures c01..c35 (color order × level 1..5, atk = level*10;
// orange-3 modifiers [buffSelf, linkUp], blue-4 [nerf, nerf, buffSelf]), spells c36..c54.
// Default color cycle: orange > yellow > green > blue > indigo > violet > red > orange.

const catalog = placeholderCatalog();
const ctx = createRoundContext(catalog);
const ALL_IDS = createZones(catalog).deck.slice().sort();

function id(n: number): CardId {
  return `c${String(n).padStart(2, '0')}`;
}
function cr(color: Color, level: CreatureLevel): CardId {
  return id(COLORS.indexOf(color) * 5 + level);
}
function spell(n: number): CardId {
  return id(35 + n);
}

const rng = (seed = 1): Rng => createSeededRng(seed);

/**
 * A round in the P1 Base step with the given hands; every other card is in the deck (catalog
 * order) unless `deckSize` is given, in which case the rest go to the graveyard.
 */
function setup(hand0: CardId[], hand1: CardId[], p1: Seat = 0, deckSize?: number): RoundState {
  const used = new Set([...hand0, ...hand1]);
  const rest = createZones(catalog).deck.filter((c) => !used.has(c));
  const deck = deckSize === undefined ? rest : rest.slice(0, deckSize);
  const graveyard = deckSize === undefined ? [] : rest.slice(deckSize);
  const board = createBoard({ deck, graveyard, hands: [hand0, hand1], stacks: [[], []] });
  return deepFreeze(startRound(board, p1).state);
}

function apply(state: RoundState, seat: Seat, command: RoundCommand, r: Rng = rng()) {
  const result = applyCommand(ctx, deepFreeze(state), seat, command, r);
  if (!result.ok) throw new Error(`unexpected rejection ${result.code}: ${result.message}`);
  return { state: deepFreeze(result.state), events: result.events };
}

function play(state: RoundState, seat: Seat, command: RoundCommand): RoundState {
  return apply(state, seat, command).state;
}

function expectReject(
  state: RoundState,
  seat: Seat,
  command: RoundCommand,
  code: RoundErrorCode,
): void {
  const before = JSON.stringify(state);
  const result = applyCommand(ctx, deepFreeze(state), seat, command, rng());
  expect(result).toMatchObject({ ok: false, code });
  expect(JSON.stringify(state)).toBe(before);
  expect(legalCommands(ctx, state, seat)).not.toContainEqual(command);
}

const pc = (cardId: CardId): RoundCommand => ({ type: 'playCreature', cardId });
const nu = (cardId: CardId): RoundCommand => ({ type: 'nullify', cardId });
const MULLIGAN: RoundCommand = { type: 'mulligan' };
const END: RoundCommand = { type: 'endTurn' };

function types(events: readonly RoundEvent[]): string[] {
  return events.map((e) => e.type);
}

// Standard opening: P1 (seat 0) yellow-3 base; P2 (seat 1) holds a mix of candidates.
const P1_HAND = [cr('yellow', 3), cr('yellow', 2), cr('red', 4), cr('red', 1), spell(1)];
const P2_HAND = [
  cr('orange', 1), // beats yellow: nullify OR base (level 1 <= 3)
  cr('orange', 5), // beats yellow, level 5: nullify only
  cr('green', 1), // beaten by yellow: neither
  cr('blue', 1), // neutral: base only
  cr('blue', 4), // neutral but level 4 > 3: neither
  cr('violet', 2), // neutral: base or +1 after blue-1
  cr('indigo', 3),
  spell(2),
];

function afterP1Base(): RoundState {
  return play(setup(P1_HAND, P2_HAND), 0, pc(cr('yellow', 3)));
}

/** P1 yellow-3 (30 ATK), P2 blue-1 + violet-2 + indigo-3 (60 ATK), P2 ended: P1 to respond. */
function inP1Response(): RoundState {
  let s = afterP1Base();
  for (const c of [cr('blue', 1), cr('violet', 2), cr('indigo', 3)]) s = play(s, 1, pc(c));
  return play(s, 1, END);
}

// ---------------------------------------------------------------------------------------------

describe('round 1 initialization (RD-02, RD-04, RD-21, RD-32)', () => {
  it('conserves 54 cards and deals 9 + 9 with 36 left in the deck', () => {
    const r = startFirstRound(catalog, rng(7));
    if (!r.ok) throw new Error(r.code);
    const z = r.state.board.zones;
    expect(allCardIds(z).sort()).toEqual(ALL_IDS);
    expect(z.hands[0]).toHaveLength(9);
    expect(z.hands[1]).toHaveLength(9);
    expect(z.deck).toHaveLength(36);
    expect(z.graveyard).toEqual([]);
    expect(z.stacks).toEqual([[], []]);
    expect(r.state.phase).toEqual({ kind: 'p1Base', active: r.state.p1 });
    expect(r.state.baseLevel).toBeNull();
    expect(r.state.turnNumber).toBe(1);
    expect(types(r.events)).toEqual([
      'roundStarted',
      'handsDealt',
      'cardsDrawn',
      'cardsDrawn',
      'turnStarted',
    ]);
  });

  it('is deterministic per seed, and P1 / first-receiving seat are random across seeds', () => {
    expect(startFirstRound(catalog, rng(42))).toEqual(startFirstRound(catalog, rng(42)));
    const p1s = new Set<Seat>();
    const firsts = new Set<Seat>();
    for (let seed = 0; seed < 50; seed++) {
      const r = startFirstRound(catalog, rng(seed));
      if (!r.ok) throw new Error(r.code);
      p1s.add(r.state.p1);
      const dealt = r.events.find((e) => e.type === 'handsDealt');
      if (dealt?.type === 'handsDealt') firsts.add(dealt.firstSeat);
    }
    expect([...p1s].sort()).toEqual([0, 1]);
    expect([...firsts].sort()).toEqual([0, 1]);
  });

  it('deals 3 at a time alternately starting with the first-receiving seat', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      // Reproduce the documented RNG order: shuffle, P1 seat, first-receiving seat.
      const shadow = rng(seed);
      const deck = shuffleDeck(createZones(catalog), shadow).deck;
      shadow.nextInt(2);
      const first: Seat = shadow.nextInt(2) === 0 ? 0 : 1;
      const r = startFirstRound(catalog, rng(seed));
      if (!r.ok) throw new Error(r.code);
      const packets = (start: number) =>
        [0, 6, 12].flatMap((o) => deck.slice(start + o, start + o + 3));
      expect(r.state.board.zones.hands[first]).toEqual(packets(0));
      expect(r.state.board.zones.hands[first === 0 ? 1 : 0]).toEqual(packets(3));
      expect(r.state.board.zones.deck).toEqual(deck.slice(18));
    }
  });

  it('rejects a catalog too small to deal', () => {
    expect(startFirstRound(catalog.slice(0, 10), rng())).toMatchObject({
      ok: false,
      code: 'DECK_TOO_SMALL',
    });
  });
});

describe('P1 Base step (RD-05, RD-63 delegated)', () => {
  it('accepts any creature as the P1 Base Minion and passes the turn to P2', () => {
    const s0 = setup([cr('red', 5), spell(1)], [cr('blue', 1)]);
    const { state, events } = apply(s0, 0, pc(cr('red', 5)));
    expect(state.board.zones.stacks[0]).toEqual([cr('red', 5)]);
    expect(state.baseLevel).toBe(5);
    expect(state.phase).toEqual({ kind: 'p2Opening', active: 1 });
    expect(state.turnNumber).toBe(2);
    expect(types(events)).toEqual([
      'creaturePlayed',
      'creatureStacked',
      'turnEnded',
      'turnStarted',
    ]);
    expect(events[0]).toEqual({
      type: 'creaturePlayed',
      seat: 0,
      cardId: cr('red', 5),
      role: 'p1Base',
    });
  });

  it('allows mulligan without ending the step (RD-30)', () => {
    const s0 = setup(P1_HAND, P2_HAND);
    const { state, events } = apply(s0, 0, MULLIGAN);
    expect(state.phase).toEqual({ kind: 'p1Base', active: 0 });
    expect(state.board.zones.hands[0]).toHaveLength(3); // ceil(5 / 2)
    expect(events[0]).toEqual({ type: 'mulliganed', seat: 0, returned: 5, drawnCount: 3 });
    expect(events[1]).toMatchObject({ type: 'cardsDrawn', seat: 0, reason: 'mulligan' });
    expect(allCardIds(state.board.zones).sort()).toEqual(ALL_IDS);
  });

  it('rejects spells, endTurn, nullify and any P2 command', () => {
    const s = setup(P1_HAND, P2_HAND);
    expectReject(s, 0, pc(spell(1)), 'NOT_A_CREATURE');
    expectReject(s, 0, pc(cr('orange', 1)), 'CARD_NOT_IN_HAND');
    expectReject(s, 0, pc('c99'), 'UNKNOWN_CARD');
    expectReject(s, 0, END, 'END_TURN_NOT_ALLOWED');
    expectReject(s, 0, nu(cr('yellow', 3)), 'NOT_ALLOWED_IN_PHASE'); // RD-34
    for (const c of [pc(cr('orange', 1)), nu(cr('orange', 1)), MULLIGAN, END]) {
      expectReject(s, 1, c, 'NOT_YOUR_TURN');
    }
  });

  it('RD-63 / RD-169: End Turn only when P1 has no creature AND cannot mulligan', () => {
    // Has no creature but can mulligan: End Turn rejected.
    expectReject(setup([spell(1), spell(2)], [cr('blue', 1)]), 0, END, 'END_TURN_NOT_ALLOWED');
    // Has a creature but cannot mulligan (hand 1): End Turn rejected.
    expectReject(setup([cr('red', 1)], [cr('blue', 1)]), 0, END, 'END_TURN_NOT_ALLOWED');
    // No creature, hand < 2.
    const a = setup([spell(1)], [cr('blue', 1)]);
    expect(legalCommands(ctx, a, 0)).toEqual([END]);
    // No creature, deck < 9.
    const b = setup([spell(1), spell(2), spell(3)], [cr('blue', 1)], 0, 8);
    expect(legalCommands(ctx, b, 0)).toEqual([END]);
  });

  it('RD-67 (delegated): that End Turn ends the round immediately as p1NoBase', () => {
    for (const s of [
      setup([spell(1)], [cr('blue', 1), cr('red', 2)]),
      setup([spell(1), spell(2), spell(3)], [cr('blue', 1)], 0, 8),
    ]) {
      const { state, events } = apply(s, 0, END);
      expect(state.phase).toEqual({ kind: 'roundOver', reason: 'p1NoBase', seat: 0, atk: [0, 0] });
      expect(events).toEqual([
        { type: 'turnEnded', seat: 0 },
        { type: 'roundOver', reason: 'p1NoBase', seat: 0, atk: [0, 0] },
      ]);
      expect(activeSeat(state)).toBeNull();
      expectReject(state, 1, pc(cr('blue', 1)), 'ROUND_OVER');
    }
  });
});

describe('startRound preconditions (R5 seam)', () => {
  it('throws on non-empty stacks (programmer error: cleanup is R5)', () => {
    const z = createZones(catalog);
    const zones = { ...z, deck: z.deck.slice(1), stacks: [[z.deck[0] as CardId], []] as const };
    expect(() => startRound(createBoard(zones), 0)).toThrow(/stacks/);
  });

  it('RD-59 (delegated): resets an unused armed Link Up', () => {
    const board = deepFreeze({
      ...createBoard(createZones(catalog)),
      linkUpPending: [true, true] as const,
    });
    const { state, events } = startRound(board, 1);
    expect(state.board.linkUpPending).toEqual([false, false]);
    expect(board.linkUpPending).toEqual([true, true]); // input untouched
    expect(state.phase).toEqual({ kind: 'p1Base', active: 1 });
    expect(types(events)).toEqual(['roundStarted', 'turnStarted']);
  });
});

describe('nulling (RD-06, RD-27, RD-34, RD-64 delegated)', () => {
  it('a creature whose color beats the P1 Base Minion nulls it at any level', () => {
    for (const card of [cr('orange', 1), cr('orange', 5)]) {
      const { state, events } = apply(afterP1Base(), 1, nu(card));
      expect(state.board.zones.stacks).toEqual([[], []]);
      expect([...state.board.zones.graveyard].sort()).toEqual([cr('yellow', 3), card].sort());
      expect(state.board.zones.hands[1]).not.toContain(card);
      expect(state.phase).toEqual({ kind: 'p1Base', active: 0 });
      expect(state.baseLevel).toBeNull();
      expect(types(events)).toEqual(['nullified', 'creatureRemoved', 'turnEnded', 'turnStarted']);
      expect(events[0]).toEqual({
        type: 'nullified',
        seat: 1,
        cardId: card,
        nullifiedCardId: cr('yellow', 3),
      });
      expect(allCardIds(state.board.zones).sort()).toEqual(ALL_IDS);
    }
  });

  it('rejects colors that do not beat the P1 Base Minion (neutral or beaten)', () => {
    const s = afterP1Base();
    expectReject(s, 1, nu(cr('blue', 1)), 'NULLIFY_COLOR_MISMATCH'); // neutral
    expectReject(s, 1, nu(cr('green', 1)), 'NULLIFY_COLOR_MISMATCH'); // yellow beats green
    expectReject(s, 1, nu(spell(2)), 'NOT_A_CREATURE');
    expectReject(s, 1, nu(cr('yellow', 2)), 'CARD_NOT_IN_HAND');
  });

  it('RD-27: repeats; P1 plays again as if first, with a new Base Level', () => {
    let s = afterP1Base();
    s = play(s, 1, nu(cr('orange', 5)));
    s = play(s, 0, pc(cr('yellow', 2)));
    expect(s.baseLevel).toBe(2);
    expect(s.phase).toEqual({ kind: 'p2Opening', active: 1 });
    s = play(s, 1, nu(cr('orange', 1)));
    expect(s.board.zones.graveyard).toHaveLength(4);
    expect(s.phase).toEqual({ kind: 'p1Base', active: 0 });
    // P1 replays; P2 has no orange left and must use another legal option.
    s = play(s, 0, pc(cr('red', 1)));
    expect(s.baseLevel).toBe(1);
    // Base Level 1: violet-2 is rejected for its level only (violet beats red, which would be
    // allowed as a base at a valid level, RD-07); level 1 blue is neutral -> allowed.
    expectReject(s, 1, pc(cr('violet', 2)), 'BASE_LEVEL_TOO_HIGH');
    expect(play(s, 1, pc(cr('blue', 1))).phase).toEqual({ kind: 'turn', active: 1 });
  });

  it('is not allowed once P2 has a Base Minion, and P1 can never nullify (RD-34)', () => {
    let s = play(afterP1Base(), 1, pc(cr('blue', 1)));
    expectReject(s, 1, nu(cr('orange', 1)), 'NOT_ALLOWED_IN_PHASE');
    s = play(play(s, 1, pc(cr('violet', 2))), 1, END); // 30 vs 30: the turn passes
    // P1 response turn: nullify is rejected by phase, whatever the card.
    expectReject(s, 0, nu(cr('red', 4)), 'NOT_ALLOWED_IN_PHASE');
    const p1WithBeater = play(
      play(
        play(setup([cr('red', 1), cr('green', 2)], [cr('blue', 1)]), 0, pc(cr('red', 1))),
        1,
        pc(cr('blue', 1)),
      ),
      1,
      END,
    );
    expect(p1WithBeater.phase).toEqual({ kind: 'turn', active: 0, equalEndBy: 1 });
    expectReject(p1WithBeater, 0, nu(cr('green', 2)), 'NOT_ALLOWED_IN_PHASE'); // green beats blue
  });
});

describe('P2 Base Minion (RD-07, RD-64 delegated)', () => {
  it('rejects level above Base Level and colors beaten by the P1 Base Minion', () => {
    const s = afterP1Base(); // base yellow-3
    expectReject(s, 1, pc(cr('blue', 4)), 'BASE_LEVEL_TOO_HIGH');
    expectReject(s, 1, pc(cr('orange', 5)), 'BASE_LEVEL_TOO_HIGH');
    expectReject(s, 1, pc(cr('green', 1)), 'BASE_COLOR_BEATEN');
  });

  it('accepts neutral colors and beating colors at level <= Base Level', () => {
    const s = afterP1Base();
    const legal = legalCommands(ctx, s, 1);
    expect(legal).toContainEqual(pc(cr('blue', 1)));
    expect(legal).toContainEqual(pc(cr('indigo', 3))); // level equal to Base Level
    // One card qualifying for both: both commands are enumerated separately.
    expect(legal).toContainEqual(pc(cr('orange', 1)));
    expect(legal).toContainEqual(nu(cr('orange', 1)));
    const { state, events } = apply(s, 1, pc(cr('orange', 1)));
    expect(state.board.zones.stacks[1]).toEqual([cr('orange', 1)]);
    expect(state.board.zones.stacks[0]).toEqual([cr('yellow', 3)]);
    expect(state.phase).toEqual({ kind: 'turn', active: 1 });
    expect(events[0]).toMatchObject({ type: 'creaturePlayed', role: 'p2Base' });
  });

  it('a color beating the P1 Base Minion at a valid level is accepted as P2 base (RD-07)', () => {
    let s = setup([cr('red', 2)], [cr('violet', 1), cr('violet', 3)]);
    s = play(s, 0, pc(cr('red', 2))); // Base Level 2; violet beats red
    expect(legalCommands(ctx, s, 1)).toEqual([
      pc(cr('violet', 1)),
      nu(cr('violet', 1)),
      nu(cr('violet', 3)), // level 3 > Base Level: nullify only
      MULLIGAN,
      END,
    ]);
    const { state, events } = apply(s, 1, pc(cr('violet', 1)));
    expect(state.board.zones.stacks).toEqual([[cr('red', 2)], [cr('violet', 1)]]);
    expect(state.board.zones.graveyard).toEqual([]);
    expect(state.phase).toEqual({ kind: 'turn', active: 1 });
    expect(events[0]).toMatchObject({ type: 'creaturePlayed', role: 'p2Base' });
  });

  it('after the Base Minion P2 continues stacking +1 in the same turn (RD-09)', () => {
    let s = play(afterP1Base(), 1, pc(cr('blue', 1)));
    expectReject(s, 1, pc(cr('indigo', 3)), 'LEVEL_NOT_NEXT');
    s = play(s, 1, pc(cr('violet', 2))); // any color (RD-08)
    s = play(s, 1, pc(cr('indigo', 3)));
    expect(s.board.zones.stacks[1]).toEqual([cr('blue', 1), cr('violet', 2), cr('indigo', 3)]);
    expect(s.phase).toEqual({ kind: 'turn', active: 1 });
  });

  it('P2 may mulligan in its opening response without ending it', () => {
    const m = play(afterP1Base(), 1, MULLIGAN);
    expect(m.phase).toEqual({ kind: 'p2Opening', active: 1 });
    expect(m.board.zones.hands[1]).toHaveLength(4); // ceil(8 / 2)
  });

  it('RD-169: P2 may End Turn before placing a Base Minion; P1 ahead -> P1 wins', () => {
    const { state, events } = apply(afterP1Base(), 1, END);
    expect(state.phase).toEqual({
      kind: 'roundOver',
      reason: 'opponentAhead',
      seat: 1,
      atk: [30, 0],
    });
    expect(types(events)).toEqual(['turnEnded', 'roundOver']);
  });

  it('RD-169: End Turn in the opening response is also legal after a Mulligan', () => {
    const s = play(afterP1Base(), 1, MULLIGAN);
    expect(play(s, 1, END).phase).toMatchObject({ kind: 'roundOver', reason: 'opponentAhead' });
  });
});

describe('main loop', () => {
  it('End Turn by a seat that is not behind passes the turn (RD-169)', () => {
    let s = inP1Response(); // P1 30 vs P2 60
    expect(s.phase).toEqual({ kind: 'turn', active: 0 });
    s = play(s, 0, pc(cr('red', 4))); // 70 vs 60
    expectReject(s, 1, END, 'NOT_YOUR_TURN');
    const ended = apply(s, 0, END);
    expect(types(ended.events)).toEqual(['turnEnded', 'turnStarted']);
    expect(ended.state.phase).toEqual({ kind: 'turn', active: 1 });
    expect(ended.state.turnNumber).toBe(s.turnNumber + 1);
    s = play(ended.state, 1, pc(cr('blue', 4))); // 70 vs 100
    s = play(s, 1, END);
    expect(s.phase).toEqual({ kind: 'turn', active: 0 });
  });

  it('stacking is +1 only, colors irrelevant (RD-08, RD-09)', () => {
    const s = inP1Response(); // P1 leading yellow-3
    expectReject(s, 0, pc(cr('red', 1)), 'LEVEL_NOT_NEXT');
    expectReject(s, 0, pc(cr('yellow', 2)), 'LEVEL_NOT_NEXT');
    expectReject(s, 0, pc(spell(1)), 'NOT_A_CREATURE');
    const { state, events } = apply(s, 0, pc(cr('red', 4)));
    expect(state.board.zones.stacks[0]).toEqual([cr('yellow', 3), cr('red', 4)]);
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
    expect(events[0]).toEqual({
      type: 'creaturePlayed',
      seat: 0,
      cardId: cr('red', 4),
      role: 'stack',
    });
  });

  it('mulligan does not end the turn and repeats until hand < 2 (RD-16, RD-30)', () => {
    let s = inP1Response(); // P1 hand: 4 cards
    const sizes: number[] = [];
    while (legalCommands(ctx, s, 0).some((c) => c.type === 'mulligan')) {
      s = play(s, 0, MULLIGAN);
      expect(s.phase).toEqual({ kind: 'turn', active: 0 });
      sizes.push(s.board.zones.hands[0].length);
    }
    expect(sizes).toEqual([2, 1]);
    expectReject(s, 0, MULLIGAN, 'MULLIGAN_HAND_TOO_SMALL');
  });

  it('mulligan needs a deck of at least 9', () => {
    let s = setup(P1_HAND, P2_HAND, 0, 8);
    s = play(s, 0, pc(cr('yellow', 3)));
    expectReject(s, 1, MULLIGAN, 'MULLIGAN_DECK_TOO_SMALL');
  });
});

describe('End Turn (RD-169; Fold and End Turn are one action)', () => {
  it('the opponent strictly ahead: the round ends and the opponent wins', () => {
    const { state, events } = apply(inP1Response(), 0, END); // P1 30 vs P2 60
    expect(state.phase).toEqual({
      kind: 'roundOver',
      reason: 'opponentAhead',
      seat: 0,
      atk: [30, 60],
    });
    expect(events).toEqual([
      { type: 'turnEnded', seat: 0 },
      { type: 'roundOver', reason: 'opponentAhead', seat: 0, atk: [30, 60] },
    ]);
    expect(activeSeat(state)).toBeNull();
    for (const seat of [0, 1] as const) {
      expect(legalCommands(ctx, state, seat)).toEqual([]);
      expectReject(state, seat, END, 'ROUND_OVER');
    }
  });

  it('user example: lead and end; the opponent overtakes and ends; the first plays again', () => {
    let s = afterP1Base(); // P1 30
    s = play(s, 1, pc(cr('blue', 1)));
    s = play(s, 1, pc(cr('violet', 2)));
    s = play(s, 1, pc(cr('indigo', 3))); // P2 leads 60 vs 30
    s = play(s, 1, END);
    expect(s.phase).toEqual({ kind: 'turn', active: 0 });
    s = play(s, 0, pc(cr('red', 4))); // P1 overtakes 70 vs 60
    s = play(s, 0, END);
    expect(s.phase).toEqual({ kind: 'turn', active: 1 }); // no final one-exchange round
  });

  it('End Turn is legal after playing (no Fold ban; RD-68 / RD-88 / RD-94 moot)', () => {
    const s = play(inP1Response(), 0, pc(cr('red', 4)));
    expect(s.playedThisTurn).toBe(true);
    expect(legalCommands(ctx, s, 0)).toContainEqual(END);
    expect(play(s, 0, END).playedThisTurn).toBe(false); // the next turn starts fresh
  });

  /** P1 yellow-3 vs P2 indigo-3 (30 vs 30): P2 placed its Base and ended its turn at equal ATK. */
  function equalOnP1Turn(): RoundState {
    return play(play(afterP1Base(), 1, pc(cr('indigo', 3))), 1, END);
  }

  it('equal ATK: the turn passes and remembers the ending seat', () => {
    const s = play(afterP1Base(), 1, pc(cr('indigo', 3)));
    const { state, events } = apply(s, 1, END);
    expect(types(events)).toEqual(['turnEnded', 'turnStarted']);
    expect(state.phase).toEqual({ kind: 'turn', active: 0, equalEndBy: 1 });
  });

  it('equal-ATK stall: the receiver ends without playing at still equal ATK -> tie-break', () => {
    const { state, events } = apply(equalOnP1Turn(), 0, END);
    expect(state.phase).toEqual({
      kind: 'roundOver',
      reason: 'equalStall',
      seat: 0,
      atk: [30, 30],
    });
    expect(types(events)).toEqual(['turnEnded', 'roundOver']);
  });

  it('a Mulligan does not count as playing for the stall (RD-88)', () => {
    const s = play(equalOnP1Turn(), 0, MULLIGAN);
    expect(s.playedThisTurn).toBe(false);
    expect(play(s, 0, END).phase).toMatchObject({ kind: 'roundOver', reason: 'equalStall' });
  });

  it('the receiver of an equal hand-over plays and leads: the turn passes normally', () => {
    let s = play(equalOnP1Turn(), 0, pc(cr('red', 4))); // 70 vs 30
    s = play(s, 0, END);
    expect(s.phase).toEqual({ kind: 'turn', active: 1 });
  });
});

describe('reopened P2 opening response (0-ATK P1 Base Minion; RD-79, RD-86, RD-169)', () => {
  // Variant of the placeholder catalog: red-1 has 0 ATK (RD-37 allows 0).
  const zeroCatalog = placeholderCatalog().map((d) =>
    d.kind === 'creature' && d.color === 'red' && d.level === 1 ? { ...d, atk: 0 } : d,
  );
  const zctx = createRoundContext(zeroCatalog);
  const hands: [CardId[], CardId[]] = [
    [cr('red', 1), cr('red', 2)],
    [cr('blue', 1), cr('violet', 1)], // violet beats red: a Nullify candidate
  ];
  function zeroStart(): RoundState {
    const used = new Set([...hands[0], ...hands[1]]);
    const board = createBoard({
      ...createZones(zeroCatalog),
      deck: createZones(zeroCatalog).deck.filter((c) => !used.has(c)),
      hands,
    });
    return deepFreeze(startRound(board, 0).state);
  }
  function must(s: RoundState, seat: Seat, c: RoundCommand): RoundState {
    const r = applyCommand(zctx, deepFreeze(s), seat, c, rng());
    if (!r.ok) throw new Error(r.code);
    return deepFreeze(r.state);
  }
  /** P1 base red-1 (0 ATK), P2 ends its opening response at 0 vs 0. */
  function afterEqualOpeningEnd(): RoundState {
    return must(must(zeroStart(), 0, pc(cr('red', 1))), 1, END);
  }

  it('P2 ends at equal ATK: the turn passes; P2 reopens its opening response', () => {
    const s = afterEqualOpeningEnd();
    expect(s.phase).toEqual({ kind: 'turn', active: 0, equalEndBy: 1 });
    expect(applyCommand(zctx, s, 1, END, rng())).toMatchObject({ code: 'NOT_YOUR_TURN' });
    const t = must(s, 0, pc(cr('red', 2)));
    expect(t.phase).toEqual({ kind: 'turn', active: 0, equalEndBy: 1 });
    expect(must(t, 0, END).phase).toEqual({ kind: 'p2Opening', active: 1 });
  });

  it('P1 ending without a play at still equal ATK is a stall (tie-break)', () => {
    expect(must(afterEqualOpeningEnd(), 0, END).phase).toEqual({
      kind: 'roundOver',
      reason: 'equalStall',
      seat: 0,
      atk: [0, 0],
    });
  });

  it('no Nullify once P1 has stacked onto its Base Minion; every legal command applies', () => {
    const s = must(must(afterEqualOpeningEnd(), 0, pc(cr('red', 2))), 0, END);
    expect(s.phase).toEqual({ kind: 'p2Opening', active: 1 });
    const result = applyCommand(zctx, s, 1, nu(cr('violet', 1)), rng());
    expect(result).toMatchObject({ ok: false, code: 'NULLIFY_NOT_ALLOWED' });
    const legal = legalCommands(zctx, s, 1);
    expect(legal).not.toContainEqual(nu(cr('violet', 1)));
    expect(legal).toContainEqual(pc(cr('blue', 1)));
    for (const c of legal) expect(applyCommand(zctx, s, 1, c, rng()).ok).toBe(true);
  });

  it('Nullify stays allowed in a reopened opening while P1 has only its Base Minion', () => {
    // Reachable when P1 played a spell that left its stack alone; forged here.
    const s = afterEqualOpeningEnd();
    const forged: RoundState = { ...s, phase: { kind: 'p2Opening', active: 1, equalEndBy: 0 } };
    expect(legalCommands(zctx, forged, 1)).toContainEqual(nu(cr('violet', 1)));
  });

  it('in the reopened opening P1 is ahead: End Turn by P2 ends the round', () => {
    const s = must(must(afterEqualOpeningEnd(), 0, pc(cr('red', 2))), 0, END); // 20 vs 0
    expect(must(s, 1, END).phase).toMatchObject({ kind: 'roundOver', reason: 'opponentAhead' });
  });

  it('a Base Minion is never placed on a non-empty stack (hardening)', () => {
    const s = afterEqualOpeningEnd();
    const forged: RoundState = { ...s, phase: { kind: 'p1Base', active: 0 } };
    expect(applyCommand(zctx, forged, 0, pc(cr('red', 2)), rng())).toMatchObject({
      ok: false,
      code: 'BASE_ALREADY_PLACED',
    });
  });
});

// ---------------------------------------------------------------------------------------------

interface Playthrough {
  final: RoundState;
  log: RoundEvent[][];
  steps: number;
}

function randomPlaythrough(seed: number, maxSteps = 300): Playthrough {
  const game = rng(seed);
  const picker = rng(seed + 100_000);
  const start = startFirstRound(catalog, game);
  if (!start.ok) throw new Error(start.code);
  let s = deepFreeze(start.state);
  const log: RoundEvent[][] = [[...start.events]];
  let steps = 0;
  while (s.phase.kind !== 'roundOver' && steps < maxSteps) {
    const seat = activeSeat(s);
    if (seat === null) throw new Error('no active seat before roundOver');
    const other: Seat = seat === 0 ? 1 : 0;
    expect(legalCommands(ctx, s, other)).toEqual([]);
    const legal = legalCommands(ctx, s, seat);
    expect(legal.length).toBeGreaterThan(0);

    // Every non-enumerated candidate is rejected (sample one per step).
    const candidates: RoundCommand[] = [
      ...ALL_IDS.flatMap((c) => [pc(c), nu(c), { type: 'playSpell', cardId: c } as const]),
      MULLIGAN,
      END,
    ].filter((c) => !legal.some((l) => JSON.stringify(l) === JSON.stringify(c)));
    const bad = candidates[picker.nextInt(candidates.length)] as RoundCommand;
    expect(applyCommand(ctx, s, seat, bad, rng(0)).ok).toBe(false);
    expect(applyCommand(ctx, s, other, legal[0] as RoundCommand, rng(0))).toMatchObject({
      ok: false,
      code: 'NOT_YOUR_TURN',
    });

    const before = JSON.stringify(s);
    const command = legal[picker.nextInt(legal.length)] as RoundCommand;
    const r = applyCommand(ctx, s, seat, command, game); // s is frozen: mutation would throw
    if (!r.ok) throw new Error(`seed ${seed}: legal ${command.type} rejected: ${r.code}`);
    expect(JSON.stringify(s)).toBe(before);
    // Conservation includes attached spell cards (they are in no zone).
    expect(roundCardIds(r.state).sort()).toEqual(ALL_IDS);
    expect(JSON.parse(JSON.stringify(r.state))).toEqual(r.state);
    s = deepFreeze(r.state);
    log.push([...r.events]);
    steps++;
  }
  return { final: s, log, steps };
}

describe('random playthroughs (legalCommands soundness and invariants)', () => {
  it('200 seeds: every enumerated command is accepted; invariants hold', () => {
    const phasesSeen = new Set<string>();
    let roundsOver = 0;
    for (let seed = 0; seed < 200; seed++) {
      const p = randomPlaythrough(seed);
      for (const step of p.log)
        for (const e of step) if (e.type === 'roundOver') phasesSeen.add(e.reason);
      if (p.final.phase.kind === 'roundOver') roundsOver++;
    }
    expect(roundsOver).toBeGreaterThan(150);
    expect([...phasesSeen]).toEqual(expect.arrayContaining(['opponentAhead']));
    // Heavy property run: exceeds the 5 s default under full-suite load.
  }, 30_000);

  it('is deterministic for a given seed', () => {
    for (const seed of [3, 17, 99]) {
      expect(randomPlaythrough(seed)).toEqual(randomPlaythrough(seed));
    }
  });
});
