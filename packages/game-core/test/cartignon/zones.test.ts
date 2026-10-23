import { describe, expect, it } from 'vitest';
import { createSeededRng, type Rng, type Seat } from '../../src/index.js';
import {
  allCardIds,
  canRefillBoth,
  createCardInstances,
  createZones,
  dealFinalHands,
  dealInitial,
  drawFromDeck,
  drawFromGraveyard,
  findCard,
  moveCard,
  mulligan,
  refillHands,
  shuffleDeck,
  type CardId,
  type ZoneRef,
  type Zones,
} from '../../src/cartignon/index.js';
import { deepFreeze, placeholderCatalog } from './test-fixtures.js';

const CATALOG = placeholderCatalog();
const ALL_IDS = createCardInstances(CATALOG).map((c) => c.id);

function fresh(): Zones {
  return createZones(CATALOG);
}

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`unexpected rejection: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

/** Builds a state by moving the first N deck cards into the given zones (keeps conservation). */
function arrange(spec: {
  hand0?: number;
  hand1?: number;
  graveyard?: number;
  stack0?: number;
}): Zones {
  let z = fresh();
  const put = (n: number, to: ZoneRef) => {
    for (let i = 0; i < n; i++)
      z = ok(moveCard(z, z.deck[0] as CardId, { zone: 'deck' }, to)).zones;
  };
  put(spec.hand0 ?? 0, { zone: 'hand', seat: 0 });
  put(spec.hand1 ?? 0, { zone: 'hand', seat: 1 });
  put(spec.graveyard ?? 0, { zone: 'graveyard' });
  put(spec.stack0 ?? 0, { zone: 'stack', seat: 0 });
  return z;
}

function expectConserved(z: Zones): void {
  const ids = allCardIds(z);
  expect(ids).toHaveLength(ALL_IDS.length);
  expect([...ids].sort()).toEqual([...ALL_IDS].sort());
}

describe('card instances and zones', () => {
  it('assigns deterministic ids c01..c54 in catalog order, all in the deck', () => {
    const instances = createCardInstances(CATALOG);
    expect(instances[0]).toEqual({ id: 'c01', defId: CATALOG[0]?.defId });
    expect(instances[53]?.id).toBe('c54');
    const z = fresh();
    expect(z.deck).toEqual(ALL_IDS);
    expect(z).toEqual({ deck: ALL_IDS, graveyard: [], hands: [[], []], stacks: [[], []] });
  });

  it('state is JSON-serializable without loss', () => {
    const z = ok(dealInitial(shuffleDeck(fresh(), createSeededRng(1)), 0)).zones;
    expect(JSON.parse(JSON.stringify(z))).toEqual(z);
  });

  it('shuffle is a deterministic permutation', () => {
    const a = shuffleDeck(fresh(), createSeededRng(5));
    const b = shuffleDeck(fresh(), createSeededRng(5));
    expect(a).toEqual(b);
    expect(a.deck).not.toEqual(ALL_IDS);
    expectConserved(a);
  });

  it('moveCard checks the source zone', () => {
    const z = fresh();
    expect(moveCard(z, 'c01', { zone: 'graveyard' }, { zone: 'deck' })).toMatchObject({
      ok: false,
      code: 'CARD_NOT_IN_ZONE',
    });
    expect(moveCard(z, 'c01', { zone: 'deck' }, { zone: 'deck' })).toMatchObject({
      ok: false,
      code: 'SAME_ZONE',
    });
    const moved = ok(moveCard(z, 'c05', { zone: 'deck' }, { zone: 'stack', seat: 1 })).zones;
    expect(findCard(moved, 'c05')).toEqual({ zone: 'stack', seat: 1 });
    // Same zone kind, different seat is a legal move.
    const handed = ok(
      moveCard(moved, 'c05', { zone: 'stack', seat: 1 }, { zone: 'stack', seat: 0 }),
    );
    expect(handed.zones.stacks).toEqual([['c05'], []]);
  });

  it('drawFromDeck takes from the top and rejects when the deck is short', () => {
    const r = ok(drawFromDeck(fresh(), 1, 2));
    expect(r.drawn).toEqual(['c01', 'c02']);
    expect(r.zones.hands[1]).toEqual(['c01', 'c02']);
    expect(r.zones.deck[0]).toBe('c03');
    expect(drawFromDeck(fresh(), 0, 55)).toMatchObject({ ok: false, code: 'DECK_TOO_SMALL' });
    expect(() => drawFromDeck(fresh(), 0, -1)).toThrow(RangeError);
  });
});

describe('graveyard (RD-23)', () => {
  it('empty graveyard draws nothing, no error, no randomness consumed', () => {
    const z = fresh();
    const rng = createSeededRng(3);
    const before = rng.getState();
    const r = drawFromGraveyard(z, 0, rng);
    expect(r).toEqual({ drawn: false, zones: z });
    expect(rng.getState()).toBe(before);
  });

  it('shuffles before every draw', () => {
    const z = arrange({ graveyard: 10 });
    expect(z.graveyard).toEqual(ALL_IDS.slice(0, 10));
    const drawnBySeed = new Set<CardId>();
    for (let seed = 0; seed < 50; seed++) {
      const r = drawFromGraveyard(z, 1, createSeededRng(seed));
      if (!r.drawn) throw new Error('expected a draw');
      // Equivalent to: shuffle the graveyard with the same RNG, then take the first card.
      const expected = shuffleDeck({ ...z, deck: z.graveyard }, createSeededRng(seed)).deck;
      expect(r.cardId).toBe(expected[0]);
      expect(r.zones.graveyard).toEqual(expected.slice(1));
      expect(r.zones.hands[1]).toEqual([r.cardId]);
      drawnBySeed.add(r.cardId);
    }
    // Not always the same (top or bottom) card.
    expect(drawnBySeed.size).toBeGreaterThan(3);
  });
});

describe('dealing (RD-21)', () => {
  it.each([0, 1] as const)('initial deal: 3 at a time alternating, firstSeat %i first', (first) => {
    const r = ok(dealInitial(fresh(), first));
    const second: Seat = first === 0 ? 1 : 0;
    const packets = (starts: number[]) => starts.flatMap((s) => ALL_IDS.slice(s, s + 3));
    expect(r.zones.hands[first]).toEqual(packets([0, 6, 12]));
    expect(r.zones.hands[second]).toEqual(packets([3, 9, 15]));
    expect(r.zones.deck).toEqual(ALL_IDS.slice(18));
  });

  it('refill: 1 at a time alternating, skipping full hands', () => {
    // seat 0 has 6, seat 1 has 8 -> order: s0, s1, s0, s0
    const z = arrange({ hand0: 6, hand1: 8 });
    const top = z.deck.slice(0, 4);
    const r = ok(refillHands(z, 0));
    expect(r.zones.hands[0].slice(6)).toEqual([top[0], top[2], top[3]]);
    expect(r.zones.hands[1].slice(8)).toEqual([top[1]]);
    expect(r.zones.hands.map((h) => h.length)).toEqual([9, 9]);
  });

  it('refill respects firstSeat', () => {
    const z = arrange({ hand0: 7, hand1: 7 });
    const top = z.deck.slice(0, 4);
    const r = ok(refillHands(z, 1));
    expect(r.zones.hands[1].slice(7)).toEqual([top[0], top[2]]);
    expect(r.zones.hands[0].slice(7)).toEqual([top[1], top[3]]);
  });

  it('canRefillBoth and rejection when the deck is short', () => {
    // Empty hands need 18 cards; leave the deck exactly one short.
    const short = arrange({ graveyard: 54 - 17 });
    expect(canRefillBoth(short)).toBe(false);
    expect(refillHands(short, 0)).toMatchObject({ ok: false, code: 'DECK_TOO_SMALL' });
    expect(dealInitial(short, 0)).toMatchObject({ ok: false, code: 'DECK_TOO_SMALL' });
    expect(canRefillBoth(arrange({ graveyard: 54 - 18 }))).toBe(true);
  });
});

describe('final hands on deck exhaustion (RD-22)', () => {
  it('even total: hands returned, shuffled and split evenly', () => {
    // hands 3 + 4, deck 5 -> 12 cards -> 6 each, nothing to graveyard.
    const z = arrange({ hand0: 3, hand1: 4, graveyard: 54 - 12 });
    const r = ok(dealFinalHands(z, 0, createSeededRng(9))).zones;
    expect(r.hands.map((h) => h.length)).toEqual([6, 6]);
    expect(r.deck).toEqual([]);
    expect(r.graveyard).toEqual(z.graveyard);
    expectConserved(r);
  });

  it('odd total: leftover card goes to the graveyard', () => {
    const z = arrange({ hand0: 2, hand1: 2, graveyard: 54 - 11 });
    const r = ok(dealFinalHands(z, 1, createSeededRng(9))).zones;
    expect(r.hands.map((h) => h.length)).toEqual([5, 5]);
    expect(r.deck).toEqual([]);
    expect(r.graveyard).toHaveLength(z.graveyard.length + 1);
    expectConserved(r);
  });

  it('deals 1 at a time alternating from firstSeat after the shuffle', () => {
    const z = arrange({ hand0: 1, hand1: 1, graveyard: 54 - 7 });
    const shuffled = shuffleDeck(
      { ...z, deck: [...z.deck, ...z.hands[0], ...z.hands[1]] },
      createSeededRng(4),
    ).deck;
    const r = ok(dealFinalHands(z, 1, createSeededRng(4))).zones;
    expect(r.hands[1]).toEqual([shuffled[0], shuffled[2], shuffled[4]]);
    expect(r.hands[0]).toEqual([shuffled[1], shuffled[3], shuffled[5]]);
    expect(r.graveyard.at(-1)).toBe(shuffled[6]);
  });

  it('is rejected while the deck can still refill both hands', () => {
    // Hands 7 + 7 need 4; deck of exactly 4 is still enough.
    const z = arrange({ hand0: 7, hand1: 7, graveyard: 54 - 18 });
    expect(z.deck).toHaveLength(4);
    expect(canRefillBoth(z)).toBe(true);
    expect(dealFinalHands(z, 0, createSeededRng(1))).toMatchObject({
      ok: false,
      code: 'DECK_NOT_EXHAUSTED',
    });
    expect(dealFinalHands(fresh(), 0, createSeededRng(1)).ok).toBe(false);
  });
});

describe('mulligan (RD-16)', () => {
  it.each([
    [9, 5],
    [7, 4],
    [3, 2],
    [2, 1],
  ])('hand %i -> draws %i', (handSize, expected) => {
    const z = arrange({ hand0: handSize, hand1: 9 });
    const r = ok(mulligan(z, 0, createSeededRng(handSize)));
    expect(r.zones.hands[0]).toHaveLength(expected);
    expect(r.drawn).toEqual(r.zones.hands[0]);
    expect(r.zones.hands[1]).toEqual(z.hands[1]);
    expect(r.zones.deck).toHaveLength(z.deck.length + handSize - expected);
    expectConserved(r.zones);
  });

  it('shuffles the deck (with the hand returned) before drawing', () => {
    const z = arrange({ hand0: 7, hand1: 9 });
    for (let seed = 0; seed < 20; seed++) {
      const r = ok(mulligan(z, 0, createSeededRng(seed)));
      // Equivalent to: return hand to the deck, shuffle with the same RNG, draw from the top.
      const expected = shuffleDeck(
        { ...z, deck: [...z.deck, ...z.hands[0]] },
        createSeededRng(seed),
      ).deck;
      expect(r.drawn).toEqual(expected.slice(0, 4));
      expect(r.zones.deck).toEqual(expected.slice(4));
    }
  });

  it('is repeatable', () => {
    let z = arrange({ hand0: 9 });
    const sizes: number[] = [];
    const rng = createSeededRng(2);
    for (let i = 0; i < 3; i++) {
      z = ok(mulligan(z, 0, rng)).zones;
      sizes.push(z.hands[0].length);
    }
    expect(sizes).toEqual([5, 3, 2]);
  });

  it('rejects hand < 2', () => {
    expect(mulligan(arrange({ hand0: 1 }), 0, createSeededRng(1))).toMatchObject({
      ok: false,
      code: 'MULLIGAN_HAND_TOO_SMALL',
    });
    expect(mulligan(fresh(), 0, createSeededRng(1))).toMatchObject({
      ok: false,
      code: 'MULLIGAN_HAND_TOO_SMALL',
    });
  });

  it('rejects deck < 9 (deck size measured before the hand returns)', () => {
    const z = arrange({ hand0: 7, graveyard: 54 - 7 - 8 });
    expect(z.deck).toHaveLength(8);
    expect(mulligan(z, 0, createSeededRng(1))).toMatchObject({
      ok: false,
      code: 'MULLIGAN_DECK_TOO_SMALL',
    });
    const z9 = arrange({ hand0: 7, graveyard: 54 - 7 - 9 });
    expect(mulligan(z9, 0, createSeededRng(1)).ok).toBe(true);
  });
});

/** One random operation; rejected operations leave the state unchanged. */
function randomOp(z: Zones, rng: Rng): Zones {
  const seat: Seat = rng.nextInt(2) === 0 ? 0 : 1;
  switch (rng.nextInt(9)) {
    case 0:
      return shuffleDeck(z, rng);
    case 1: {
      const r = drawFromDeck(z, seat, rng.nextInt(5));
      return r.ok ? r.zones : z;
    }
    case 2:
      return drawFromGraveyard(z, seat, rng).zones;
    case 3:
    case 4: {
      const refs: ZoneRef[] = [
        { zone: 'deck' },
        { zone: 'graveyard' },
        { zone: 'hand', seat: 0 },
        { zone: 'hand', seat: 1 },
        { zone: 'stack', seat: 0 },
        { zone: 'stack', seat: 1 },
      ];
      const ids = allCardIds(z);
      const cardId = ids[rng.nextInt(ids.length)] as CardId;
      const from = refs[rng.nextInt(refs.length)] as ZoneRef;
      const to = refs[rng.nextInt(refs.length)] as ZoneRef;
      const r = moveCard(z, cardId, from, to);
      return r.ok ? r.zones : z;
    }
    case 5: {
      const r = mulligan(z, seat, rng);
      return r.ok ? r.zones : z;
    }
    case 6: {
      const r = refillHands(z, seat);
      return r.ok ? r.zones : z;
    }
    case 7: {
      const r = dealInitial(z, seat);
      return r.ok ? r.zones : z;
    }
    default: {
      const r = dealFinalHands(z, seat, rng);
      return r.ok ? r.zones : z;
    }
  }
}

function runSequence(seed: number, steps: number, check?: (z: Zones) => void): Zones {
  const rng = createSeededRng(seed);
  let z = deepFreeze(fresh());
  for (let i = 0; i < steps; i++) {
    const before = JSON.stringify(z);
    const next = randomOp(z, rng);
    // Inputs are deep-frozen (mutation would throw) and must also be unchanged.
    expect(JSON.stringify(z)).toBe(before);
    z = deepFreeze(next);
    check?.(z);
  }
  return z;
}

describe('properties over many seeds', () => {
  it('conserves all 54 card ids, each in exactly one zone', () => {
    for (let seed = 0; seed < 200; seed++) {
      runSequence(seed, 60, (z) => {
        const ids = allCardIds(z);
        if (ids.length !== 54 || new Set(ids).size !== 54) {
          throw new Error(`seed ${seed}: conservation broken`);
        }
        for (const id of ALL_IDS) {
          if (findCard(z, id) === null) throw new Error(`seed ${seed}: ${id} lost`);
        }
      });
    }
  });

  it('is deterministic: same seed -> identical state', () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(runSequence(seed, 60)).toEqual(runSequence(seed, 60));
    }
  });

  it('different seeds diverge', () => {
    expect(runSequence(1, 60)).not.toEqual(runSequence(2, 60));
  });
});
