import { describe, expect, it } from 'vitest';
import { createSeededRng, type Rng, type Seat } from '../../src/index.js';
import {
  allCardIds,
  canStack,
  createBoard,
  createCardIndex,
  createZones,
  creatureAtk,
  dealInitial,
  drawFromDeck,
  drawFromGraveyard,
  linkCreature,
  liveModifiers,
  moveCard,
  refillHands,
  removeFromStack,
  shuffleDeck,
  stackAtk,
  stackCreature,
  type AttachedEffect,
  type Board,
  type BoardEvent,
  type CardDef,
  type CardId,
  type CardIndex,
  type Color,
  type CreatureLevel,
  type ModifierKind,
  type LiveModifier,
  type StackExit,
} from '../../src/cartignon/index.js';
import { deepFreeze, placeholderCatalog } from './test-fixtures.js';

// ---------------------------------------------------------------------------------------------
// Helpers: small hand-built catalogs. Instance ids follow catalog order (c01, c02, ...).

function creature(
  level: CreatureLevel,
  opts: { atk?: number; color?: Color; modifiers?: readonly ModifierKind[] } = {},
): CardDef {
  return {
    defId: 'renamed-by-setup',
    kind: 'creature',
    color: opts.color ?? 'red',
    level,
    atk: opts.atk ?? level * 10,
    modifiers: opts.modifiers ?? [],
  };
}

function spell(): CardDef {
  return {
    defId: 'renamed-by-setup',
    kind: 'spell',
    name: 's',
    text: { condition: '', primary: '', secondary: '' },
    secondary: { kind: 'none' },
  };
}

// RD-97: entry i-1 = stack position i. Earlier entries are fillers for positions the card never
// occupies in that test.
const BUFF1: readonly ModifierKind[] = ['buffSelf'];
const NERF1: readonly ModifierKind[] = ['nerfEnemyLeader'];
const LINK1: readonly ModifierKind[] = ['linkUp'];

function id(n: number): CardId {
  return `c${String(n).padStart(2, '0')}`;
}

interface Setup {
  cards: CardIndex;
  board: Board;
}

/**
 * Builds a board: cards listed in `hand0`/`hand1`/`stack0`/`stack1`/`graveyard` (by 1-based
 * catalog position) go there; every other card stays in the deck in catalog order. Stacks built
 * this way start with linkUpPending false, whatever their live modifiers are.
 */
function setup(
  defs: CardDef[],
  place: {
    hand0?: number[];
    hand1?: number[];
    stack0?: number[];
    stack1?: number[];
    graveyard?: number[];
  },
): Setup {
  const catalog = defs.map((d, i) => ({ ...d, defId: `d${i + 1}` }));
  const cards = createCardIndex(catalog);
  const used = new Set(Object.values(place).flat());
  const ids = (ns: number[] | undefined) => (ns ?? []).map(id);
  const board = createBoard({
    deck: createZones(catalog).deck.filter((_, i) => !used.has(i + 1)),
    graveyard: ids(place.graveyard),
    hands: [ids(place.hand0), ids(place.hand1)],
    stacks: [ids(place.stack0), ids(place.stack1)],
  });
  expect(allCardIds(board.zones).sort()).toEqual(createZones(catalog).deck.slice().sort());
  return { cards, board: deepFreeze(board) };
}

function mustStack(s: Setup, seat: Seat, cardId: CardId): readonly BoardEvent[] {
  const r = stackCreature(s.cards, s.board, seat, cardId);
  if (!r.ok) throw new Error(`unexpected rejection ${r.code}: ${r.message}`);
  s.board = deepFreeze(r.board);
  return r.events;
}

function mustRemove(s: Setup, cardId: CardId, to: StackExit = { zone: 'graveyard' }) {
  const r = removeFromStack(s.cards, s.board, cardId, to);
  if (!r.ok) throw new Error(`unexpected rejection ${r.code}`);
  s.board = deepFreeze(r.board);
  return r.events;
}

function types(events: readonly BoardEvent[]): string[] {
  return events.map((e) => e.type);
}

function atk(s: Setup, n: number): number {
  return creatureAtk(s.cards, s.board, id(n));
}

// ---------------------------------------------------------------------------------------------

describe('stacking legality (RD-09, RD-08)', () => {
  it('accepts exactly +1 from the Leading Minion', () => {
    const s = setup([creature(1), creature(2), creature(3)], { hand0: [1, 2, 3] });
    mustStack(s, 0, id(1)); // empty stack: allowed at this layer (Base Minion rules are R3)
    mustStack(s, 0, id(2));
    mustStack(s, 0, id(3));
    expect(s.board.zones.stacks[0]).toEqual([id(1), id(2), id(3)]);
    expect(s.board.zones.hands[0]).toEqual([]);
  });

  it.each([
    ['level skip 1 -> 3', [1, 3]],
    ['same level 2 -> 2', [2, 2]],
    ['descending 3 -> 2', [3, 2]],
  ] as const)('rejects %s', (_label, [lead, next]) => {
    const s = setup([creature(lead), creature(next)], { stack0: [1], hand0: [2] });
    expect(canStack(s.cards, s.board, 0, id(2))).toMatchObject({
      ok: false,
      code: 'LEVEL_NOT_NEXT',
    });
    expect(stackCreature(s.cards, s.board, 0, id(2))).toMatchObject({
      ok: false,
      code: 'LEVEL_NOT_NEXT',
    });
  });

  it('a level-5 Leading Minion allows nothing more', () => {
    const defs = [creature(4), creature(5), ...([1, 2, 3, 4, 5] as const).map((l) => creature(l))];
    const s = setup(defs, { stack0: [1, 2], hand0: [3, 4, 5, 6, 7] });
    for (const n of [3, 4, 5, 6, 7]) {
      expect(canStack(s.cards, s.board, 0, id(n)).ok).toBe(false);
    }
  });

  it('color is irrelevant (RD-08)', () => {
    const s = setup(
      [
        creature(1, { color: 'orange' }),
        creature(2, { color: 'orange' }), // same color
        creature(3, { color: 'red' }), // red beats orange in the default cycle: still irrelevant
        creature(4, { color: 'yellow' }),
      ],
      { hand0: [1, 2, 3, 4] },
    );
    for (const n of [1, 2, 3, 4]) mustStack(s, 0, id(n));
    expect(s.board.zones.stacks[0]).toHaveLength(4);
  });

  it('rejects unknown cards, spells and cards not in that seat hand', () => {
    const s = setup([creature(1), spell(), creature(1)], { hand0: [1, 2], hand1: [3] });
    expect(canStack(s.cards, s.board, 0, 'c99')).toMatchObject({ code: 'UNKNOWN_CARD' });
    expect(canStack(s.cards, s.board, 0, id(2))).toMatchObject({ code: 'NOT_A_CREATURE' });
    expect(canStack(s.cards, s.board, 0, id(3))).toMatchObject({ code: 'CARD_NOT_IN_HAND' });
    expect(canStack(s.cards, s.board, 1, id(1))).toMatchObject({ code: 'CARD_NOT_IN_HAND' });
  });

  it('stacks are per seat', () => {
    const s = setup([creature(3), creature(1)], { stack0: [1], hand1: [2] });
    mustStack(s, 1, id(2));
    expect(s.board.zones.stacks).toEqual([[id(1)], [id(2)]]);
  });
});

describe('Link Up (RD-10, RD-51)', () => {
  it('going live arms Link Up; any level next; then +1 resumes from the linked level', () => {
    const s = setup(
      [creature(1), creature(2, { modifiers: LINK1 }), creature(4), creature(3), creature(5)],
      { hand0: [1, 2, 3, 4, 5] },
    );
    mustStack(s, 0, id(1));
    expect(mustStack(s, 0, id(2))).toEqual([
      { type: 'creatureStacked', seat: 0, cardId: id(2), position: 1, viaLinkUp: false },
      { type: 'modifierLive', seat: 0, cardId: id(2), kind: 'linkUp', position: 1 },
      { type: 'linkUpArmed', seat: 0, sourceCardId: id(2) },
    ]);
    expect(s.board.linkUpPending).toEqual([true, false]);
    expect(mustStack(s, 0, id(3))).toEqual([
      { type: 'creatureStacked', seat: 0, cardId: id(3), position: 2, viaLinkUp: true },
      { type: 'linkUpConsumed', seat: 0 },
      { type: 'modifierSilenced', seat: 0, cardId: id(2), kind: 'linkUp', position: 1 },
    ]);
    expect(s.board.linkUpPending).toEqual([false, false]);
    expect(canStack(s.cards, s.board, 0, id(4))).toMatchObject({ code: 'LEVEL_NOT_NEXT' }); // 3
    mustStack(s, 0, id(5)); // 5 follows linked 4
  });

  it('bypasses the level-5 cap', () => {
    const s = setup([creature(5), creature(1)], { stack0: [1], hand0: [2] });
    const board: Board = { ...s.board, linkUpPending: [true, false] };
    expect(canStack(s.cards, board, 0, id(2)).ok).toBe(true);
  });

  it('chains when the linked card itself has a live Link Up', () => {
    const s = setup(
      [
        creature(1),
        creature(2, { modifiers: LINK1 }),
        creature(5, { modifiers: ['buffSelf', 'linkUp'] }),
        creature(1),
      ],
      { hand0: [1, 2, 3, 4] },
    );
    mustStack(s, 0, id(1));
    mustStack(s, 0, id(2));
    expect(types(mustStack(s, 0, id(3)))).toEqual([
      'creatureStacked',
      'linkUpConsumed',
      'modifierSilenced',
      'modifierLive',
      'linkUpArmed',
    ]);
    expect(s.board.linkUpPending).toEqual([true, false]);
    mustStack(s, 0, id(4)); // level 1 on top of level 5
  });

  it('a linked card whose Link Up is at another index does not chain', () => {
    const s = setup(
      [
        creature(1),
        creature(2, { modifiers: LINK1 }),
        creature(4, { modifiers: ['buffSelf', 'buffSelf', 'buffSelf', 'linkUp'] }),
      ],
      { hand0: [1, 2, 3] },
    );
    mustStack(s, 0, id(1));
    mustStack(s, 0, id(2));
    mustStack(s, 0, id(3));
    expect(s.board.linkUpPending).toEqual([false, false]);
  });

  it('armed Link Up belongs to one seat only', () => {
    const s = setup([creature(1), creature(3)], { stack1: [1], hand1: [2] });
    const board: Board = { ...s.board, linkUpPending: [true, false] };
    expect(canStack(s.cards, board, 1, id(2))).toMatchObject({ code: 'LEVEL_NOT_NEXT' });
  });

  it('RD-139 (refines RD-51): lapses when the card that armed it is removed', () => {
    const s = setup([creature(1), creature(2, { modifiers: LINK1 }), creature(4)], {
      hand0: [1, 2, 3],
    });
    mustStack(s, 0, id(1));
    mustStack(s, 0, id(2));
    expect(s.board.linkUpSource).toEqual([id(2), null]);
    expect(mustRemove(s, id(2))).toEqual([
      { type: 'creatureRemoved', seat: 0, cardId: id(2), position: 1, to: { zone: 'graveyard' } },
      { type: 'linkUpLapsed', seat: 0, sourceCardId: id(2) },
      { type: 'modifierSilenced', seat: 0, cardId: id(2), kind: 'linkUp', position: 1 },
    ]);
    expect(s.board.linkUpPending).toEqual([false, false]);
    expect(s.board.linkUpSource).toEqual([null, null]);
    expect(canStack(s.cards, s.board, 0, id(3))).toMatchObject({ code: 'LEVEL_NOT_NEXT' }); // 4 on 1
  });

  it('RD-139: removing another card keeps the Link Up armed', () => {
    const s = setup([creature(1), creature(2, { modifiers: LINK1 })], { hand0: [1, 2] });
    mustStack(s, 0, id(1));
    mustStack(s, 0, id(2));
    expect(types(mustRemove(s, id(1)))).not.toContain('linkUpLapsed');
    expect(s.board.linkUpPending).toEqual([true, false]);
  });

  it('re-arms when a Link Up card becomes Leading again after a removal', () => {
    const s = setup([creature(1), creature(2, { modifiers: LINK1 }), creature(3)], {
      stack0: [1, 2, 3],
    });
    expect(s.board.linkUpPending).toEqual([false, false]);
    expect(types(mustRemove(s, id(3)))).toEqual(['creatureRemoved', 'modifierLive', 'linkUpArmed']);
    expect(s.board.linkUpPending).toEqual([true, false]);
  });
});

describe('linkCreature (for the RD-19 tie-break)', () => {
  it('ignores level and does not use an armed Link Up', () => {
    const s = setup([creature(5), creature(2)], { stack0: [1], hand0: [2] });
    const board: Board = deepFreeze({ ...s.board, linkUpPending: [true, false] });
    const r = linkCreature(s.cards, board, 0, id(2));
    if (!r.ok) throw new Error(r.code);
    expect(r.board.zones.stacks[0]).toEqual([id(1), id(2)]);
    expect(r.board.linkUpPending).toEqual([true, false]);
    expect(r.events).toEqual([{ type: 'creatureLinked', seat: 0, cardId: id(2), position: 1 }]);
  });

  it('still requires a creature in hand, and liveness still applies', () => {
    const s = setup([creature(5), creature(1, { atk: 5, modifiers: BUFF1 }), spell()], {
      stack0: [1],
      hand0: [2, 3],
    });
    expect(linkCreature(s.cards, s.board, 0, id(3))).toMatchObject({ code: 'NOT_A_CREATURE' });
    const r = linkCreature(s.cards, s.board, 0, id(2));
    if (!r.ok) throw new Error(r.code);
    expect(types(r.events)).toEqual(['creatureLinked', 'modifierLive']);
    expect(creatureAtk(s.cards, r.board, id(2))).toBe(35);
  });
});

describe('silenced model: liveness (RD-47, RD-53, RD-35)', () => {
  it('is live only at its own position (entry i-1 = position i, RD-97)', () => {
    const s = setup([creature(1), creature(2), creature(3, { atk: 30, modifiers: BUFF1 })], {
      hand0: [1, 2, 3],
    });
    mustStack(s, 0, id(1));
    mustStack(s, 0, id(2));
    expect(types(mustStack(s, 0, id(3)))).toEqual(['creatureStacked']); // position 2: no entry
    expect(atk(s, 3)).toBe(30);
    expect(liveModifiers(s.cards, s.board.zones)).toEqual([]);
  });

  it('never live at position 0 (Base Minion), whatever its modifiers', () => {
    const s = setup([creature(1, { modifiers: BUFF1 })], { hand0: [1] });
    expect(types(mustStack(s, 0, id(1)))).toEqual(['creatureStacked']);
    expect(atk(s, 1)).toBe(10);
  });

  it('liveness depends on position, not level', () => {
    const s = setup(
      [
        creature(1),
        creature(2, { modifiers: LINK1 }),
        creature(5, { atk: 50, modifiers: ['nerfEnemyLeader', 'buffSelf'] }),
      ],
      { hand0: [1, 2, 3] },
    );
    mustStack(s, 0, id(1));
    mustStack(s, 0, id(2));
    expect(mustStack(s, 0, id(3))).toContainEqual({
      type: 'modifierLive',
      seat: 0,
      cardId: id(3),
      kind: 'buffSelf',
      position: 2,
    });
    expect(atk(s, 3)).toBe(80);
  });

  it('buffSelf counts only while Leading: covered -> silenced, uncovered -> live again (+30 once)', () => {
    const s = setup([creature(1), creature(2, { atk: 20, modifiers: BUFF1 }), creature(3)], {
      hand0: [1, 2, 3],
    });
    mustStack(s, 0, id(1));
    expect(types(mustStack(s, 0, id(2)))).toEqual(['creatureStacked', 'modifierLive']);
    expect(atk(s, 2)).toBe(50);
    expect(stackAtk(s.cards, s.board, 0)).toBe(10 + 50);

    expect(types(mustStack(s, 0, id(3)))).toEqual(['creatureStacked', 'modifierSilenced']);
    expect(atk(s, 2)).toBe(20);

    expect(types(mustRemove(s, id(3)))).toEqual(['creatureRemoved', 'modifierLive']);
    expect(atk(s, 2)).toBe(50); // not 80: nothing accumulates
    expect(s.board.attachedEffects).toEqual([]);
  });

  it('nerfEnemyLeader: -30 on the enemy Leading Minion only; silenced when its source is covered', () => {
    const s = setup(
      [
        creature(1),
        creature(2, { modifiers: NERF1 }),
        creature(3),
        creature(1, { atk: 15 }),
        creature(2, { atk: 100 }),
      ],
      { stack0: [1], hand0: [2, 3], stack1: [4, 5] },
    );
    mustStack(s, 0, id(2));
    expect(atk(s, 5)).toBe(70);
    expect(atk(s, 4)).toBe(15); // not Leading: unaffected
    expect(stackAtk(s.cards, s.board, 1)).toBe(85);
    expect(atk(s, 2)).toBe(20); // the nerf does not touch its own side
    mustStack(s, 0, id(3));
    expect(atk(s, 5)).toBe(100);
  });

  it('RD-53 interpretation — confirm: the nerf follows the enemy CURRENT Leading Minion', () => {
    const s = setup(
      [
        creature(1),
        creature(2, { modifiers: NERF1 }),
        creature(1, { atk: 100 }),
        creature(2, { atk: 50 }),
        creature(3, { atk: 60 }),
      ],
      { stack0: [1, 2], stack1: [3, 4], hand1: [5] },
    );
    expect(atk(s, 4)).toBe(20);
    mustStack(s, 1, id(5)); // a new enemy Leading Minion takes the nerf
    expect([atk(s, 4), atk(s, 5)]).toEqual([50, 30]);
    mustRemove(s, id(5));
    mustRemove(s, id(4)); // the next card down becomes Leading and takes it
    expect(atk(s, 3)).toBe(70);
  });

  it('RD-49: enemy stack empty -> the nerf affects nothing', () => {
    const s = setup([creature(1), creature(2, { modifiers: NERF1 })], {
      stack0: [1],
      hand0: [2],
    });
    expect(types(mustStack(s, 0, id(2)))).toEqual(['creatureStacked', 'modifierLive']);
    expect(stackAtk(s.cards, s.board, 0)).toBe(30);
    expect(stackAtk(s.cards, s.board, 1)).toBe(0);
    expect(s.board.attachedEffects).toEqual([]);
  });

  it('a live buff and an enemy live nerf on the same Leading Minion cancel out', () => {
    const s = setup(
      [
        creature(1),
        creature(2, { atk: 20, modifiers: BUFF1 }),
        creature(1),
        creature(2, { modifiers: NERF1 }),
      ],
      { stack0: [1, 2], stack1: [3, 4] },
    );
    // Both modifiers really are live, so the cancellation is not vacuous.
    expect(liveModifiers(s.cards, s.board.zones)).toEqual([
      { seat: 0, cardId: id(2), kind: 'buffSelf', position: 1 },
      { seat: 1, cardId: id(4), kind: 'nerfEnemyLeader', position: 1 },
    ]);
    expect(atk(s, 2)).toBe(20);
    expect(atk(s, 4)).toBe(20); // the nerf card itself is not buffed by anyone
    // Each modifier alone does change ATK: buff only (enemy nerf covered) and nerf only.
    const buffOnly = setup(
      [
        creature(1),
        creature(2, { atk: 20, modifiers: BUFF1 }),
        creature(1),
        creature(2, { modifiers: NERF1 }),
        creature(3),
      ],
      { stack0: [1, 2], stack1: [3, 4, 5] },
    );
    expect(atk(buffOnly, 2)).toBe(50);
    const nerfOnly = setup(
      [creature(1), creature(2, { atk: 50 }), creature(1), creature(2, { modifiers: NERF1 })],
      { stack0: [1, 2], stack1: [3, 4] },
    );
    expect(atk(nerfOnly, 2)).toBe(20);
  });
});

describe('review additions: Link Up edge cases and floor order', () => {
  it('linkUpArmed is emitted only on false -> true (no duplicate when already armed)', () => {
    const s = setup([creature(5), creature(1, { modifiers: LINK1 })], {
      stack0: [1],
      hand0: [2],
    });
    const armed: Board = deepFreeze({ ...s.board, linkUpPending: [true, false] });
    const r = linkCreature(s.cards, armed, 0, id(2));
    if (!r.ok) throw new Error(r.code);
    expect(types(r.events)).toEqual(['creatureLinked', 'modifierLive']);
    expect(r.board.linkUpPending).toEqual([true, false]);
    // Same placement from unarmed: armed once.
    const r2 = linkCreature(s.cards, s.board, 0, id(2));
    if (!r2.ok) throw new Error(r2.code);
    expect(types(r2.events)).toEqual(['creatureLinked', 'modifierLive', 'linkUpArmed']);
  });

  it('RQ-27 current behavior — Open: Link Up is used even when the card would be a legal +1', () => {
    const s = setup([creature(1), creature(2, { modifiers: LINK1 }), creature(3)], {
      hand0: [1, 2, 3],
    });
    mustStack(s, 0, id(1));
    mustStack(s, 0, id(2));
    expect(mustStack(s, 0, id(3))).toEqual([
      { type: 'creatureStacked', seat: 0, cardId: id(3), position: 2, viaLinkUp: true },
      { type: 'linkUpConsumed', seat: 0 },
      { type: 'modifierSilenced', seat: 0, cardId: id(2), kind: 'linkUp', position: 1 },
    ]);
    expect(s.board.linkUpPending).toEqual([false, false]);
  });

  it('RD-53 literal — confirm: a spent Link Up re-arms when its card becomes Leading again', () => {
    const s = setup([creature(1), creature(2, { modifiers: LINK1 }), creature(5), creature(3)], {
      hand0: [1, 2, 3, 4],
    });
    mustStack(s, 0, id(1));
    mustStack(s, 0, id(2)); // armed
    mustStack(s, 0, id(3)); // spent on the level-5 card
    expect(s.board.linkUpPending).toEqual([false, false]);
    expect(types(mustRemove(s, id(3)))).toEqual(['creatureRemoved', 'modifierLive', 'linkUpArmed']);
    expect(s.board.linkUpPending).toEqual([true, false]);
  });

  it('RD-44 order — confirm: spell effect + buff/nerf are summed, then floored once', () => {
    const s = setup(
      [
        creature(1),
        creature(2, { atk: 10, modifiers: BUFF1 }),
        creature(1),
        creature(2, { modifiers: NERF1 }),
      ],
      { stack0: [1, 2], stack1: [3, 4] },
    );
    const withSpell = (amount: number): Board =>
      deepFreeze({
        ...s.board,
        attachedEffects: [
          { effectId: 'e1', kind: 'atkDelta', amount, sourceCardId: id(9), targetCardId: id(2) },
        ],
        nextEffectSeq: 2,
      });
    // Live buff (+30) and enemy nerf (-30) on c02 (ATK 10), plus a spell delta:
    expect(creatureAtk(s.cards, withSpell(-50), id(2))).toBe(0); // 10 + 30 - 30 - 50 = -40 -> 0
    expect(creatureAtk(s.cards, withSpell(-5), id(2))).toBe(5); // 10 + 30 - 30 - 5 = 5
    expect(creatureAtk(s.cards, withSpell(40), id(2))).toBe(50); // 10 + 30 - 30 + 40
  });

  it('RD-44 order — confirm: the floor is not applied step by step', () => {
    // Nerfed Leading Minion (ATK 10) with a +30 spell. Summed once: 10 - 30 + 30 = 10.
    // Flooring after the nerf first would give max(0, 10 - 30) + 30 = 30.
    const s = setup(
      [creature(1), creature(2, { atk: 10 }), creature(1), creature(2, { modifiers: NERF1 })],
      { stack0: [1, 2], stack1: [3, 4] },
    );
    const board: Board = deepFreeze({
      ...s.board,
      attachedEffects: [
        { effectId: 'e1', kind: 'atkDelta', amount: 30, sourceCardId: id(9), targetCardId: id(2) },
      ],
      nextEffectSeq: 2,
    });
    expect(creatureAtk(s.cards, s.board, id(2))).toBe(0); // nerf alone: 10 - 30 -> 0
    expect(creatureAtk(s.cards, board, id(2))).toBe(10);
  });
});

describe('ATK (RD-18, RD-37, RD-44)', () => {
  it('nerf floor is per creature: 10-ATK creature nerfed to 0, not -20', () => {
    const s = setup(
      [
        creature(1),
        creature(2, { modifiers: NERF1 }),
        creature(1, { atk: 40 }),
        creature(2, { atk: 10 }),
      ],
      { stack0: [1], hand0: [2], stack1: [3, 4] },
    );
    mustStack(s, 0, id(2));
    expect(atk(s, 4)).toBe(0);
    // Stack total loses only that creature's 10, never more.
    expect(stackAtk(s.cards, s.board, 1)).toBe(40);
  });

  it('sums definition ATK of the whole stack; empty stack is 0', () => {
    const s = setup([creature(1, { atk: 7 }), creature(2, { atk: 0 }), creature(3, { atk: 253 })], {
      stack0: [1, 2, 3],
    });
    expect(stackAtk(s.cards, s.board, 0)).toBe(260);
    expect(stackAtk(s.cards, s.board, 1)).toBe(0);
  });
});

describe('mid-stack removal (RD-52)', () => {
  it('cards above join down, liveness is re-derived, levels are not re-validated', () => {
    const s = setup(
      [
        creature(1),
        creature(2),
        creature(3, { atk: 30, modifiers: BUFF1 }),
        creature(4),
        creature(2),
      ],
      { stack0: [1, 2, 3], hand0: [4, 5] },
    );
    expect(atk(s, 3)).toBe(30); // position 2, wants 1: silenced
    expect(mustRemove(s, id(2))).toEqual([
      { type: 'creatureRemoved', seat: 0, cardId: id(2), position: 1, to: { zone: 'graveyard' } },
      { type: 'modifierLive', seat: 0, cardId: id(3), kind: 'buffSelf', position: 1 },
    ]);
    expect(s.board.zones.stacks[0]).toEqual([id(1), id(3)]); // "modified stack" 1 -> 3 kept
    expect(atk(s, 3)).toBe(60);
    // Next level follows the current Leading Minion (level 3).
    expect(canStack(s.cards, s.board, 0, id(5))).toMatchObject({ code: 'LEVEL_NOT_NEXT' });
    expect(canStack(s.cards, s.board, 0, id(4)).ok).toBe(true);
  });

  it('RD-105: the Base dies -> position 1 becomes the new Base (never live)', () => {
    const s = setup([creature(1), creature(2, { atk: 20, modifiers: BUFF1 })], {
      stack0: [1, 2],
    });
    expect(atk(s, 2)).toBe(50);
    expect(types(mustRemove(s, id(1)))).toEqual(['creatureRemoved', 'modifierSilenced']);
    expect(s.board.zones.stacks[0]).toEqual([id(2)]);
    expect(atk(s, 2)).toBe(20);
  });

  it('RD-105: after a shift, the modifier legal at the new position activates', () => {
    const s = setup(
      [
        creature(1),
        creature(2),
        creature(3),
        creature(4, { atk: 40, modifiers: ['linkUp', 'buffSelf', 'nerfEnemyLeader'] }),
      ],
      { stack0: [1, 2, 3, 4] },
    );
    expect(liveModifiers(s.cards, s.board.zones)).toEqual([
      { seat: 0, cardId: id(4), kind: 'nerfEnemyLeader', position: 3 },
    ]);
    expect(mustRemove(s, id(1))).toEqual([
      { type: 'creatureRemoved', seat: 0, cardId: id(1), position: 0, to: { zone: 'graveyard' } },
      { type: 'modifierSilenced', seat: 0, cardId: id(4), kind: 'nerfEnemyLeader', position: 3 },
      { type: 'modifierLive', seat: 0, cardId: id(4), kind: 'buffSelf', position: 2 },
    ]);
    expect(atk(s, 4)).toBe(70);
    expect(types(mustRemove(s, id(2)))).toEqual([
      'creatureRemoved',
      'modifierSilenced',
      'modifierLive',
      'linkUpArmed',
    ]);
  });

  it('removing a card below a non-modifier Leading Minion emits only the removal', () => {
    const s = setup([creature(1, { modifiers: BUFF1 }), creature(2), creature(3)], {
      stack0: [1, 2, 3],
    });
    expect(types(mustRemove(s, id(2)))).toEqual(['creatureRemoved']);
  });
});

describe('attached effects (RD-12, RD-50, RD-55) — spells create them in R4; seeded here', () => {
  const effect = (n: number, target: number, amount: number): AttachedEffect => ({
    effectId: `e${n}`,
    kind: 'atkDelta',
    amount,
    sourceCardId: id(9),
    targetCardId: id(target),
  });

  function seeded(): Setup {
    const s = setup([creature(1), creature(2, { atk: 20 }), creature(3, { atk: 30 })], {
      stack0: [1, 2],
      stack1: [3],
    });
    s.board = deepFreeze({
      ...s.board,
      attachedEffects: [effect(1, 2, -50), effect(2, 1, 5)],
      nextEffectSeq: 3,
    });
    return s;
  }

  it('count toward ATK (floored at 0 per creature), on any stacked creature', () => {
    const s = seeded();
    expect(atk(s, 2)).toBe(0);
    expect(atk(s, 1)).toBe(15);
    expect(stackAtk(s.cards, s.board, 0)).toBe(15);
  });

  it('are discarded when their target leaves the stack, to any zone', () => {
    for (const to of [
      { zone: 'graveyard' },
      { zone: 'deck' },
      { zone: 'hand', seat: 1 },
    ] as const) {
      const s = seeded();
      expect(mustRemove(s, id(2), to)).toEqual([
        { type: 'creatureRemoved', seat: 0, cardId: id(2), position: 1, to },
        { type: 'effectDiscarded', effect: effect(1, 2, -50) },
      ]);
      expect(s.board.attachedEffects).toEqual([effect(2, 1, 5)]);
      expect(s.board.nextEffectSeq).toBe(3);
    }
  });

  it('stay when another creature leaves', () => {
    const s = seeded();
    mustRemove(s, id(3));
    expect(s.board.attachedEffects).toHaveLength(2);
  });
});

describe('removal targets', () => {
  it("removes to the opponent's hand", () => {
    const s = setup([creature(1), creature(2)], { stack0: [1, 2] });
    expect(mustRemove(s, id(2), { zone: 'hand', seat: 1 })).toEqual([
      {
        type: 'creatureRemoved',
        seat: 0,
        cardId: id(2),
        position: 1,
        to: { zone: 'hand', seat: 1 },
      },
    ]);
    expect(s.board.zones.hands).toEqual([[], [id(2)]]);
    expect(s.board.zones.stacks).toEqual([[id(1)], []]);
  });

  it('removes to the bottom of the deck', () => {
    const s = setup([creature(1), creature(2), creature(3), creature(4)], { stack1: [1, 2] });
    expect(s.board.zones.deck).toEqual([id(3), id(4)]);
    mustRemove(s, id(2), { zone: 'deck' });
    expect(s.board.zones.deck).toEqual([id(3), id(4), id(2)]);
    expect(s.board.zones.stacks[1]).toEqual([id(1)]);
  });

  it('rejects removing a card that is not on a stack', () => {
    const s = setup([creature(1)], { hand0: [1] });
    expect(removeFromStack(s.cards, s.board, id(1), { zone: 'graveyard' })).toMatchObject({
      ok: false,
      code: 'CARD_NOT_ON_STACK',
    });
  });
});

describe('seat symmetry', () => {
  it.each([0, 1] as const)('seat %i: the same scenario gives mirrored results', (seat) => {
    const enemy: Seat = seat === 0 ? 1 : 0;
    const defs = [
      creature(1),
      creature(2, { atk: 20, modifiers: BUFF1 }),
      creature(3, { modifiers: ['buffSelf', 'nerfEnemyLeader'] }),
      creature(4, { modifiers: ['buffSelf', 'buffSelf', 'linkUp'] }),
      creature(2), // linked any-level card
      creature(1, { atk: 10 }), // enemy Leading Minion
      creature(5), // stays in the deck
    ];
    const mine = [1, 2, 3, 4, 5];
    const s = setup(defs, seat === 0 ? { hand0: mine, stack1: [6] } : { hand1: mine, stack0: [6] });
    mustStack(s, seat, id(1));
    mustStack(s, seat, id(2));
    expect(atk(s, 2)).toBe(50);
    mustStack(s, seat, id(3));
    expect([atk(s, 2), atk(s, 6)]).toEqual([20, 0]);
    mustStack(s, seat, id(4));
    expect(atk(s, 6)).toBe(10);
    expect(s.board.linkUpPending[seat]).toBe(true);
    expect(s.board.linkUpPending[enemy]).toBe(false);
    expect(mustStack(s, seat, id(5))).toEqual([
      { type: 'creatureStacked', seat, cardId: id(5), position: 4, viaLinkUp: true },
      { type: 'linkUpConsumed', seat },
      { type: 'modifierSilenced', seat, cardId: id(4), kind: 'linkUp', position: 3 },
    ]);
    expect(s.board.zones.stacks[seat]).toEqual([id(1), id(2), id(3), id(4), id(5)]);
    expect(stackAtk(s.cards, s.board, seat)).toBe(10 + 20 + 30 + 40 + 20);
    expect(stackAtk(s.cards, s.board, enemy)).toBe(10);
    expect(canStack(s.cards, s.board, enemy, id(7))).toMatchObject({ code: 'CARD_NOT_IN_HAND' });
  });
});

// ---------------------------------------------------------------------------------------------
// Properties over many seeds, on the placeholder 54-card catalog with modifiers of every kind.

function richCatalog(): CardDef[] {
  const kinds = ['buffSelf', 'nerfEnemyLeader', 'linkUp'] as const;
  return placeholderCatalog().map((d, i) => {
    if (d.kind !== 'creature' || d.level === 1) return d;
    const kind = kinds[i % kinds.length] ?? 'buffSelf';
    // One kind at every position 1..level-1, so it is live on a normal 1 -> 2 -> ... stack.
    return { ...d, modifiers: Array.from({ length: d.level - 1 }, () => kind) };
  });
}

const RICH = richCatalog();
const RICH_CARDS = createCardIndex(RICH);
const EXITS: StackExit[] = [
  { zone: 'graveyard' },
  { zone: 'deck' },
  { zone: 'hand', seat: 0 },
  { zone: 'hand', seat: 1 },
];

function pick<T>(items: readonly T[], rng: Rng): T | undefined {
  return items.length === 0 ? undefined : items[rng.nextInt(items.length)];
}

function randomBoardOp(b: Board, rng: Rng): { board: Board; events: readonly BoardEvent[] } {
  const seat: Seat = rng.nextInt(2) === 0 ? 0 : 1;
  const same = { board: b, events: [] };
  const withZones = (zones: Board['zones']) => ({ board: { ...b, zones }, events: [] });
  switch (rng.nextInt(8)) {
    case 0:
    case 1:
    case 2: {
      const cardId = pick(b.zones.hands[seat], rng);
      if (cardId === undefined) return same;
      const r = stackCreature(RICH_CARDS, b, seat, cardId);
      return r.ok ? r : same;
    }
    case 3: {
      const cardId = pick(b.zones.hands[seat], rng);
      if (cardId === undefined || rng.nextInt(3) !== 0) return same;
      const r = linkCreature(RICH_CARDS, b, seat, cardId);
      return r.ok ? r : same;
    }
    case 4: {
      const cardId = pick([...b.zones.stacks[0], ...b.zones.stacks[1]], rng);
      const to = pick(EXITS, rng);
      if (cardId === undefined || to === undefined) return same;
      const r = removeFromStack(RICH_CARDS, b, cardId, to);
      return r.ok ? r : same;
    }
    case 5: {
      const cardId = pick(b.zones.hands[seat], rng);
      if (cardId === undefined) return same;
      const r = moveCard(b.zones, cardId, { zone: 'hand', seat }, { zone: 'graveyard' });
      return r.ok ? withZones(r.zones) : same;
    }
    case 6: {
      const r = refillHands(b.zones, seat);
      if (r.ok) return withZones(r.zones);
      const d = drawFromDeck(b.zones, seat, 1);
      return d.ok ? withZones(d.zones) : same;
    }
    default:
      return withZones(drawFromGraveyard(b.zones, seat, rng).zones);
  }
}

function key(m: LiveModifier): string {
  return `${m.seat}/${m.cardId}/${m.position}`;
}

function runBoard(
  seed: number,
  steps: number,
  check?: (b: Board, prev: Board, ev: readonly BoardEvent[]) => void,
) {
  const rng = createSeededRng(seed);
  const dealt = dealInitial(shuffleDeck(createZones(RICH), rng), 0);
  if (!dealt.ok) throw new Error('deal failed');
  let b = deepFreeze(createBoard(dealt.zones));
  const log: BoardEvent[] = [];
  for (let i = 0; i < steps; i++) {
    const before = JSON.stringify(b);
    const next = randomBoardOp(b, rng);
    expect(JSON.stringify(b)).toBe(before); // input unchanged (and frozen: mutation would throw)
    const prev = b;
    b = deepFreeze(next.board);
    log.push(...next.events);
    check?.(b, prev, next.events);
  }
  return { board: b, log };
}

describe('board properties over many seeds', () => {
  it('conserves cards; liveness is consistent with events; ATK never negative', () => {
    const all = createZones(RICH).deck.slice().sort();
    let liveEvents = 0;
    let silencedEvents = 0;
    for (let seed = 0; seed < 200; seed++) {
      const { log } = runBoard(seed, 80, (b, prev, events) => {
        const ids = allCardIds(b.zones);
        if (ids.length !== 54 || JSON.stringify(ids.slice().sort()) !== JSON.stringify(all)) {
          throw new Error(`seed ${seed}: conservation broken`);
        }
        // Liveness: at most one per seat, always the Leading Minion.
        const live = liveModifiers(RICH_CARDS, b.zones);
        for (const m of live) {
          if (b.zones.stacks[m.seat].at(-1) !== m.cardId) throw new Error('live non-leader');
          // A live Link Up has always armed its seat (only placement on that seat clears it,
          // and that placement covers the source).
          if (m.kind === 'linkUp' && !b.linkUpPending[m.seat]) throw new Error('unarmed linkUp');
        }
        // Events replayed on the previous live set give the current live set.
        const replay = new Set(liveModifiers(RICH_CARDS, prev.zones).map(key));
        for (const e of events) {
          if (e.type === 'modifierLive') replay.add(key(e));
          if (e.type === 'modifierSilenced') replay.delete(key(e));
        }
        expect([...replay].sort()).toEqual(live.map(key).sort());
        // Nothing in R2 creates attached effects (RD-55).
        if (b.attachedEffects.length !== 0) throw new Error('unexpected attached effect');
        for (const seatStack of b.zones.stacks) {
          for (const cardId of seatStack) {
            if (RICH_CARDS[cardId]?.kind !== 'creature') throw new Error('non-creature stacked');
            if (creatureAtk(RICH_CARDS, b, cardId) < 0) throw new Error('negative ATK');
          }
        }
      });
      liveEvents += log.filter((e) => e.type === 'modifierLive').length;
      silencedEvents += log.filter((e) => e.type === 'modifierSilenced').length;
    }
    // Guard against a vacuous property: the random walk really exercises liveness.
    expect(liveEvents).toBeGreaterThan(50);
    expect(silencedEvents).toBeGreaterThan(50);
  });

  it('is deterministic: same seed -> identical board and events', () => {
    for (let seed = 0; seed < 30; seed++) {
      expect(runBoard(seed, 80)).toEqual(runBoard(seed, 80));
    }
  });

  it('board state is JSON-serializable without loss', () => {
    const { board } = runBoard(7, 80);
    expect(JSON.parse(JSON.stringify(board))).toEqual(board);
  });
});
