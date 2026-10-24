import { describe, expect, it } from 'vitest';
import {
  boardCardIds,
  cleanupRound,
  createRoundContext,
  creatureAtk,
  legalCommands,
  loadCatalog,
  parseCatalog,
  removeFromStack,
  setupNextRound,
  stackAtk,
  startCartignonMatch,
  validateCatalog,
  DEFAULT_DECK_COMPOSITION,
  InvalidCatalogError,
  type Board,
  type CardId,
  type RoundPhase,
} from '../../src/cartignon/index.js';
import {
  ALL_SORTED,
  CATALOG_ORDER,
  END,
  MULLIGAN,
  STACKS,
  apply,
  catalog,
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

// Spell framework (R4c-1): legality, resolution, attached effects, draws, catalog data. The
// per-spell Primary tests are in spell-handlers.test.ts. Secondary paths used here (real spells,
// ADR-0007): S-15 / S-02 infeasible -> buff own Leading +30; S-14 / S-06 infeasible -> nerf the
// opponent's Leading -30; S-04 / S-08 infeasible -> draw 1 from the deck; S-03 infeasible -> draw
// 1 from the graveyard.

describe('playSpell legality (RD-14, RD-83, RD-88, RD-115)', () => {
  it('is rejected in the P1 Base step: creature only (RD-83, RD-137)', () => {
    // Every spell, the traps (S-12, S-16) and S-04 included: only a creature or a Mulligan.
    const s = stateOf({
      hands: [[spell(8), spell(4), spell(12), spell(16), cr('red', 1)], []],
      phase: { kind: 'p1Base', active: 0 },
    });
    for (const n of [8, 4, 12, 16]) expectReject(s, 0, ps(spell(n)), 'NOT_ALLOWED_IN_PHASE');
    expect(legalCommands(ctx, s, 0).some((c) => c.type === 'playSpell')).toBe(false);
  });

  it('is legal in P2 opening and normal turns', () => {
    const phases: RoundPhase[] = [
      { kind: 'p2Opening', active: 0 },
      { kind: 'turn', active: 0 },
      { kind: 'turn', active: 0, equalEndBy: 1 },
    ];
    for (const phase of phases) {
      const s = stateOf({ hands: [[spell(8)], []], stacks: [[], [cr('blue', 1)]], phase, p1: 1 });
      const { state } = apply(s, 0, ps(spell(8)));
      expect(state.phase).toEqual(phase); // RD-14: the player stays on turn
    }
  });

  it('rejects unknown cards, cards not in hand, creatures and the wrong seat', () => {
    const s = stateOf({ hands: [[spell(8), cr('red', 3)], [spell(2)]], stacks: STACKS });
    expectReject(s, 0, ps('c99'), 'UNKNOWN_CARD');
    expectReject(s, 0, ps(spell(2)), 'CARD_NOT_IN_HAND');
    expectReject(s, 0, ps(cr('red', 3)), 'NOT_A_SPELL');
    expectReject(s, 1, ps(spell(2)), 'NOT_YOUR_TURN');
  });

  it('offers one command per spell with an effect (no targets, RD-115, RD-175)', () => {
    // R4c-5: every spell is supported (S-19 included); SPELL_NOT_SUPPORTED remains for catalogs
    // with spells ahead of their handlers.
    const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    // Both stacks empty, empty graveyard, full deck: every infeasible Primary falls to a Secondary,
    // and only the deck-draw Secondaries (S-04, S-08, S-17) have an effect; the traps (S-12, S-16)
    // arm. S-19's Primary would draw from the empty graveyard: no effect (RD-175, like the rest).
    const s = stateOf({
      hands: [all.map(spell), []],
      phase: { kind: 'p2Opening', active: 0 },
      p1: 1,
    });
    const playable = [4, 8, 12, 16, 17];
    expect(legalCommands(ctx, s, 0).filter((c) => c.type === 'playSpell')).toEqual(
      playable.map((n) => ps(spell(n))),
    );
    for (const n of all.filter((x) => !playable.includes(x))) {
      expectReject(s, 0, ps(spell(n)), 'SPELL_NO_EFFECT');
    }
  });

  it('counts as a play (RD-88); Mulligan and End Turn stay available (RD-169)', () => {
    const s = stateOf({ hands: [[spell(8), spell(14), spell(15)], []], stacks: STACKS });
    const { state } = apply(s, 0, ps(spell(8)));
    expect(state.playedThisTurn).toBe(true);
    expect(legalCommands(ctx, state, 0)).toEqual(
      expect.arrayContaining([ps(spell(14)), MULLIGAN, END]),
    );
    // A Mulligan is not a play (RD-88).
    expect(apply(s, 0, MULLIGAN).state.playedThisTurn).toBe(false);
  });

  it('RQ-33 / RD-169: in P2 opening, End Turn stays legal after spells (no deadlock)', () => {
    // P2 (seat 1) holds two spells and no creature; the deck is empty, so no Mulligan, and S-08's
    // deck-draw Secondary would draw nothing (RD-175: not playable).
    const base = stateOf({
      hands: [[], [spell(14), spell(8)]],
      stacks: [[cr('yellow', 5)], []],
      deck: [],
      phase: { kind: 'p2Opening', active: 1 },
    });
    expect(legalCommands(ctx, base, 1)).toEqual([ps(spell(14)), END]);
    expectReject(base, 1, ps(spell(8)), 'SPELL_NO_EFFECT');
    const one = apply(base, 1, ps(spell(14))).state; // Secondary: nerf yellow-5 by 30
    // Spells no longer block the escape (RQ-33).
    expect(legalCommands(ctx, one, 1)).toEqual([END]);
    const ended = apply(one, 1, END).state;
    expect(ended.phase).toMatchObject({ kind: 'roundOver', reason: 'opponentAhead', seat: 1 });
  });
});

describe('RD-175: a spell whose branch would do nothing cannot be played', () => {
  it('buffOwnLeader Secondary without an own Leading creature (S-02, S-05, S-09, S-13, S-15)', () => {
    // Enemy blue-5 only (S-13 needs level 1-4, S-15 a 125 lead); seat 0 holds no creature.
    const buffs = [2, 5, 9, 13, 15];
    const s = stateOf({ hands: [buffs.map(spell), []], stacks: [[], [cr('blue', 5)]] });
    for (const n of buffs) expectReject(s, 0, ps(spell(n)), 'SPELL_NO_EFFECT');
    expect(legalCommands(ctx, s, 0).some((c) => c.type === 'playSpell')).toBe(false);
    expect(legalCommands(ctx, s, 0)).toContainEqual(END);
  });

  it('nerfEnemyLeader Secondary without an enemy Leading creature (S-01, S-06, S-14)', () => {
    const s = stateOf({
      hands: [[spell(1), spell(6), spell(14)], []],
      stacks: [[cr('red', 1)], []],
    });
    for (const n of [1, 6, 14]) expectReject(s, 0, ps(spell(n)), 'SPELL_NO_EFFECT');
  });

  it('the same Secondaries are castable once their target exists', () => {
    const s = stateOf({ hands: [[spell(14), spell(15)], []], stacks: STACKS });
    expect(legalCommands(ctx, s, 0)).toEqual(
      expect.arrayContaining([ps(spell(14)), ps(spell(15))]),
    );
    const { events } = apply(s, 0, ps(spell(15)));
    expect(events[0]).toMatchObject({ type: 'spellPlayed', branch: 'secondary' });
  });

  it('a feasible Primary is always an effect, whatever the Secondary (S-02, S-19 none)', () => {
    // S-02: d = 2 - 0 >= 1 -> Primary, although its buff Secondary would have no target.
    // S-19's Secondary is `none`, but its Primary is always feasible (RD-119) and has an effect
    // with a card in the graveyard.
    const s = stateOf({
      hands: [
        [spell(2), spell(19)],
        [cr('violet', 1), cr('violet', 2), cr('violet', 3)],
      ],
      stacks: [[], []],
      graveyard: [cr('green', 1)],
    });
    expect(legalCommands(ctx, s, 0)).toEqual(expect.arrayContaining([ps(spell(2)), ps(spell(19))]));
  });
});

describe('RD-175: a feasible Primary that would change nothing cannot be played', () => {
  it('S-02: d >= 1 but an empty graveyard gains the caster nothing; one grave card is enough', () => {
    const hands: [CardId[], CardId[]] = [[spell(2)], [cr('violet', 1)]]; // d = 1 - 0
    // Deck full, graveyard empty: the opponent's deck draw alone does not count (RD-175).
    const empty = stateOf({ hands, stacks: STACKS });
    expect(empty.board.zones.graveyard).toEqual([]);
    expectReject(empty, 0, ps(spell(2)), 'SPELL_NO_EFFECT');
    // One card in the graveyard.
    const one = stateOf({ hands, stacks: STACKS, graveyard: [cr('green', 1)] });
    expect(legalCommands(ctx, one, 0)).toContainEqual(ps(spell(2)));
  });
});

describe('resolution (RD-14, RD-119): Primary or Secondary, then graveyard or attach', () => {
  it('Secondary buff: attached to the own Leading creature, the spell attaches to it (RD-115)', () => {
    const s = stateOf({ hands: [[spell(15)], []], stacks: STACKS });
    const { state, events } = apply(s, 0, ps(spell(15)));
    expect(events).toEqual([
      { type: 'spellPlayed', seat: 0, cardId: spell(15), branch: 'secondary' },
      {
        type: 'effectAttached',
        effect: {
          effectId: 'e1',
          kind: 'atkDelta',
          amount: 30,
          sourceCardId: spell(15),
          targetCardId: cr('red', 2),
        },
      },
      {
        type: 'spellResolved',
        seat: 0,
        cardId: spell(15),
        destination: 'attached',
        targetCardId: cr('red', 2),
      },
    ]);
    expect(state.board.attachedSpells).toEqual([
      { cardId: spell(15), seat: 0, targetCardId: cr('red', 2), branch: 'secondary' },
    ]);
    expect(state.board.zones.graveyard).not.toContain(spell(15));
    expect(state.board.zones.hands[0]).toEqual([]);
    expect(state.board.nextEffectSeq).toBe(2);
  });

  it('Secondary nerf goes to the opponent Leading creature (RD-115)', () => {
    const s = stateOf({ hands: [[spell(14)], []], stacks: STACKS });
    const { state, events } = apply(s, 0, ps(spell(14)));
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(state.board.attachedEffects).toMatchObject([
      { amount: -30, targetCardId: cr('blue', 1) },
    ]);
    expect(creatureAtk(ctx.cards, state.board, cr('blue', 1))).toBe(0); // 10 - 30 -> 0
  });

  it('Secondary draw, then the graveyard', () => {
    const s = stateOf({ hands: [[spell(8)], []], stacks: STACKS });
    const deckTop = s.board.zones.deck[0] as CardId;
    const { state, events } = apply(s, 0, ps(spell(8)));
    expect(types(events)).toEqual([
      'spellPlayed',
      'cardsDrawn',
      'spellDrawResolved',
      'spellResolved',
    ]);
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(state.board.attachedEffects).toEqual([]);
    expect(state.board.zones.hands[0]).toEqual([deckTop]);
    expect(state.board.zones.graveyard).toEqual([spell(8)]);
    expect(events.at(-1)).toEqual({
      type: 'spellResolved',
      seat: 0,
      cardId: spell(8),
      destination: 'graveyard',
    });
  });

  it('RD-175: a Secondary with a missing fixed target makes the spell unplayable', () => {
    // Seat 1 has no creature: S-14's nerf has no target (RD-115), so it cannot be cast.
    const s = stateOf({ hands: [[spell(14)], []], stacks: [[cr('red', 1)], []] });
    expectReject(s, 0, ps(spell(14)), 'SPELL_NO_EFFECT');
  });
});

describe('attached ATK effects (RD-12, RD-44, RD-55, RD-61)', () => {
  it('buff and nerf count in creatureAtk and stackAtk', () => {
    let s = stateOf({ hands: [[spell(15), spell(14)], []], stacks: STACKS });
    s = apply(s, 0, ps(spell(15))).state;
    expect(creatureAtk(ctx.cards, s.board, cr('red', 2))).toBe(50);
    expect(stackAtk(ctx.cards, s.board, 0)).toBe(60);
    s = apply(s, 0, ps(spell(14))).state;
    expect(creatureAtk(ctx.cards, s.board, cr('blue', 1))).toBe(0);
    expect(s.board.attachedSpells.map((a) => a.cardId)).toEqual([spell(15), spell(14)]);
  });

  it('floor applies once to the sum (RD-61): 10 - 30 - 30 + 30 = -20 -> 0', () => {
    let s = stateOf({ hands: [[spell(14), spell(6)], [spell(15)]], stacks: STACKS });
    s = apply(s, 0, ps(spell(14))).state; // nerf blue-1
    s = apply(s, 0, ps(spell(6))).state; // no live modifier on blue-1 -> nerf blue-1
    s = apply(s, 0, END).state;
    s = apply(s, 1, ps(spell(15))).state; // buff own Leading blue-1
    expect(s.board.attachedEffects.map((e) => e.amount)).toEqual([-30, -30, 30]);
    expect(creatureAtk(ctx.cards, s.board, cr('blue', 1))).toBe(0); // stepwise flooring: 30
  });

  it('spell effects are not silenced when the target is no longer Leading (RD-55)', () => {
    let s = stateOf({ hands: [[spell(15), cr('red', 3)], []], stacks: STACKS });
    s = apply(s, 0, ps(spell(15))).state;
    s = apply(s, 0, { type: 'playCreature', cardId: cr('red', 3) }).state;
    expect(creatureAtk(ctx.cards, s.board, cr('red', 2))).toBe(50);
  });

  it('removed with the creature on any exit; the spell card goes to the graveyard (RD-50)', () => {
    let s = stateOf({ hands: [[spell(15), spell(14)], []], stacks: STACKS });
    s = apply(s, 0, ps(spell(15))).state; // on red-2
    s = apply(s, 0, ps(spell(14))).state; // on blue-1
    for (const to of [
      { zone: 'deck' },
      { zone: 'hand', seat: 1 },
      { zone: 'graveyard' },
    ] as const) {
      const board = deepFreeze(s.board);
      const r = removeFromStack(ctx.cards, board, cr('red', 2), to);
      if (!r.ok) throw new Error(r.code);
      expect(r.board.attachedEffects.map((e) => e.sourceCardId)).toEqual([spell(14)]);
      expect(r.board.attachedSpells.map((a) => a.cardId)).toEqual([spell(14)]);
      expect(r.board.zones.graveyard).toContain(spell(15));
      expect(r.events).toContainEqual({
        type: 'attachedSpellDiscarded',
        cardId: spell(15),
        targetCardId: cr('red', 2),
      });
      expect(boardCardIds(r.board).sort()).toEqual(ALL_SORTED);
    }
  });

  it('nullify: a spell attached to the nullified P1 Base Minion goes to the graveyard', () => {
    // P1 (seat 0) yellow-3 base; P2 nerfs it with S-14 (P1 has 1 creature -> Secondary), then
    // nullifies it with orange-1.
    const s = stateOf({
      hands: [[], [spell(14), cr('orange', 1)]],
      stacks: [[cr('yellow', 3)], []],
      phase: { kind: 'p2Opening', active: 1 },
    });
    const nerfed = apply(s, 1, ps(spell(14))).state;
    expect(stackAtk(ctx.cards, nerfed.board, 0)).toBe(0);
    const { state, events } = apply(nerfed, 1, { type: 'nullify', cardId: cr('orange', 1) });
    expect(state.board.zones.graveyard).toEqual(
      expect.arrayContaining([cr('yellow', 3), cr('orange', 1), spell(14)]),
    );
    expect(state.board.attachedSpells).toEqual([]);
    expect(state.board.attachedEffects).toEqual([]);
    expect(types(events)).toContain('attachedSpellDiscarded');
  });
});

describe('RD-82: attached spells go to the graveyard at cleanup', () => {
  function withAttached(): Board {
    let s = stateOf({ hands: [[spell(15), spell(14)], []], stacks: STACKS });
    s = apply(s, 0, ps(spell(15))).state; // on the winner's stack (red-2)
    s = apply(s, 0, ps(spell(14))).state; // on the loser's stack (blue-1)
    return deepFreeze(s.board);
  }

  it("win: winner's creatures -> deck, loser's -> graveyard, both spells -> graveyard", () => {
    const board = withAttached();
    const outcome = {
      kind: 'win',
      winner: 0,
      decidedBy: 'opponentAhead',
      atk: [60, 0],
      tieBreakIterations: 0,
    } as const;
    const r = cleanupRound(board, outcome, rng());
    const z = r.board.zones;
    expect(z.deck).toEqual(expect.arrayContaining([cr('red', 1), cr('red', 2)]));
    expect(z.deck).not.toContain(spell(15));
    expect(z.graveyard).toEqual(expect.arrayContaining([cr('blue', 1), spell(15), spell(14)]));
    expect(r.board.attachedSpells).toEqual([]);
    expect(r.board.attachedEffects).toEqual([]);
    expect(r.events).toEqual([{ type: 'roundCleanedUp', toGraveyard: 3, toDeck: 2 }]);
    expect(boardCardIds(r.board).sort()).toEqual(ALL_SORTED);
  });

  it('drawn round: both stacks -> deck, attached spells still -> graveyard', () => {
    const outcome = {
      kind: 'draw',
      reason: 'tieBreakDeckOut',
      atk: [0, 0],
      tieBreakIterations: 1,
    } as const;
    const r = cleanupRound(withAttached(), outcome, rng());
    expect(r.board.zones.graveyard).toEqual([spell(15), spell(14)]);
    expect(r.events).toEqual([{ type: 'roundCleanedUp', toGraveyard: 2, toDeck: 3 }]);
    expect(boardCardIds(r.board).sort()).toEqual(ALL_SORTED);
  });
});

describe('draw primitives (RD-23, RD-48, RD-93; RD-77 corrected: no in-round cap)', () => {
  it('a deck draw can take a hand above 9 during a round', () => {
    const hand = [spell(8), ...CATALOG_ORDER.slice(0, 10)]; // 11 cards
    const s = stateOf({ hands: [hand, []], stacks: [[], [cr('blue', 1)]] });
    const { state, events } = apply(s, 0, ps(spell(8)));
    expect(state.board.zones.hands[0]).toHaveLength(11);
    expect(events).toContainEqual({
      type: 'spellDrawResolved',
      seat: 0,
      from: 'deck',
      requested: 1,
      drawn: 1,
    });
  });

  it('empty deck: a deck-draw Secondary would draw nothing, so it is unplayable (RD-48, RD-175)', () => {
    const empty = stateOf({ hands: [[spell(8)], []], stacks: STACKS, deck: [] });
    expectReject(empty, 0, ps(spell(8)), 'SPELL_NO_EFFECT');
  });

  it('graveyard draw: shuffled before every draw, seeded; the spell cannot draw itself', () => {
    // S-02 Primary with d = 3 - 0 >= 2: two graveyard draws, then the opponent draws 1 from deck.
    const s = stateOf({
      hands: [[spell(2)], [cr('violet', 1), cr('violet', 2), cr('violet', 3)]],
      stacks: STACKS,
      deck: CATALOG_ORDER.slice(0, 15),
    });
    const before = s.board.zones.graveyard;
    const { state, events } = apply(s, 0, ps(spell(2)), 7);
    const drawn = state.board.zones.hands[0];
    expect(drawn).toHaveLength(2);
    for (const c of drawn) expect(before).toContain(c);
    expect(drawn).not.toContain(spell(2));
    expect(state.board.zones.graveyard).toHaveLength(before.length - 2 + 1);
    expect(state.board.zones.graveyard).toContain(spell(2));
    expect(events).toContainEqual({
      type: 'cardsDrawn',
      seat: 0,
      reason: 'spellGraveyard',
      cardIds: drawn,
    });
    // Deterministic for a seed.
    expect(JSON.stringify(apply(s, 0, ps(spell(2)), 7))).toBe(JSON.stringify({ state, events }));
  });

  it('empty graveyard: a grave-draw Secondary is unplayable; one card is enough (RD-93, RD-175)', () => {
    const s = stateOf({ hands: [[spell(3)], []], stacks: STACKS });
    expect(s.board.zones.graveyard).toEqual([]);
    expectReject(s, 0, ps(spell(3)), 'SPELL_NO_EFFECT'); // S-03 infeasible -> grave draw 1
    // One card in the graveyard: the draw has an effect and takes it.
    const one = stateOf({ hands: [[spell(3)], []], stacks: STACKS, graveyard: [cr('red', 3)] });
    expect(one.board.zones.graveyard).toEqual([cr('red', 3)]);
    const { state } = apply(one, 0, ps(spell(3)));
    expect(state.board.zones.hands[0]).toEqual([cr('red', 3)]);
    expect(state.board.zones.graveyard).toEqual([spell(3)]);
  });

  it('graveyard draw can take a hand above 9', () => {
    const hand = [spell(3), ...CATALOG_ORDER.slice(0, 10)];
    const s = stateOf({ hands: [hand, []], stacks: STACKS, deck: CATALOG_ORDER.slice(10, 15) });
    expect(apply(s, 0, ps(spell(3))).state.board.zones.hands[0]).toHaveLength(11);
  });
});

describe('dealing after hands grew above 9 (RD-77 corrected, RD-87, RD-95, RD-96)', () => {
  function boardOf(hands: [CardId[], CardId[]], deck: CardId[]): Board {
    return stateOf({ hands, deck }).board;
  }
  const H = (from: number, n: number) => CATALOG_ORDER.slice(from, from + n);

  it('refill gives a hand above 9 nothing and never trims it', () => {
    const r = setupNextRound(ctx, boardOf([H(0, 12), H(12, 3)], H(15, 10)), 0, rng());
    if (r.kind !== 'started') throw new Error(r.kind);
    expect(r.finalRound).toBe(false);
    expect(r.state.board.zones.hands.map((h) => h.length)).toEqual([12, 9]);
    expect(r.state.board.zones.deck).toHaveLength(4);
  });

  it('RD-95 (Proposed): pool > 18 but the deck is short -> the deck is dealt out', () => {
    const r = setupNextRound(ctx, boardOf([H(0, 14), H(14, 2)], H(16, 4)), 0, rng());
    if (r.kind !== 'started') throw new Error(r.kind);
    expect(r.finalRound).toBe(false);
    expect(r.state.board.zones.hands.map((h) => h.length)).toEqual([14, 6]);
    expect(r.state.board.zones.deck).toEqual([]);
  });

  it('pool <= 18 with a hand above 9: the final deal evens the hands (RD-22, RD-87)', () => {
    const r = setupNextRound(ctx, boardOf([H(0, 12), H(12, 3)], []), 0, rng());
    if (r.kind !== 'started') throw new Error(r.kind);
    expect(r.finalRound).toBe(true);
    expect(r.state.board.zones.hands.map((h) => h.length)).toEqual([7, 7]);
  });

  it('RD-96 (Proposed): a replay with a pool above 18 deals 9 each; the rest stays in the deck', () => {
    const board = boardOf([H(0, 12), H(12, 10)], []);
    const r = setupNextRound(ctx, board, 0, rng(), true);
    if (r.kind !== 'started') throw new Error(r.kind);
    const z = r.state.board.zones;
    expect(z.hands.map((h) => h.length)).toEqual([9, 9]);
    expect(z.deck).toHaveLength(4);
    expect(z.graveyard).toHaveLength(board.zones.graveyard.length);
  });
});

describe('spell data (ADR-0007 section 1: text + SecondarySpec)', () => {
  const text = { condition: 'c', primary: 'p', secondary: 's' };
  const base = { defId: 's', kind: 'spell', name: 'n', text, secondary: { kind: 'none' } };

  it('round-trips the catalog with the real spells', () => {
    const json: unknown = JSON.parse(JSON.stringify(catalog));
    expect(loadCatalog(json)).toEqual({ ok: true, value: catalog });
  });

  it('accepts every SecondarySpec shape', () => {
    for (const secondary of [
      { kind: 'none' },
      { kind: 'buffOwnLeader', amount: 30 },
      { kind: 'nerfEnemyLeader', amount: 30 },
      { kind: 'draw', from: 'deck', count: 1 },
      { kind: 'draw', from: 'graveyard', count: 2 },
    ]) {
      expect(parseCatalog([{ ...base, secondary }])).toMatchObject({ ok: true });
    }
  });

  it.each([
    ['an unknown secondary kind', { secondary: { kind: 'heal' } }],
    ['amount 0', { secondary: { kind: 'buffOwnLeader', amount: 0 } }],
    ['a missing amount', { secondary: { kind: 'nerfEnemyLeader' } }],
    ['draw count 0', { secondary: { kind: 'draw', from: 'deck', count: 0 } }],
    ['draw source', { secondary: { kind: 'draw', from: 'hand', count: 1 } }],
    ['extra keys on a secondary', { secondary: { kind: 'none', amount: 1 } }],
    ['a missing text', { text: undefined }],
    ['a text field that is not a string', { text: { ...text, primary: 1 } }],
    ['the provisional effect list', { primary: [{ kind: 'buffTarget' }] }],
  ])('rejects %s', (_, extra) => {
    expect(parseCatalog([{ ...base, ...extra }])).toMatchObject({
      ok: false,
      issues: [{ code: 'MALFORMED' }],
    });
  });

  it('validateCatalog also checks spell data of catalogs built in code', () => {
    const bad = catalog.map((d) =>
      d.defId === 'S-02' ? ({ ...d, secondary: { kind: 'heal' } } as unknown as typeof d) : d,
    );
    const r = validateCatalog(bad, DEFAULT_DECK_COMPOSITION);
    expect(r).toMatchObject({ ok: false, issues: [{ code: 'MALFORMED' }] });
  });
});

describe('catalog validation at context / match creation', () => {
  const malformed = catalog.map((d) =>
    d.defId === 'S-02' ? ({ ...d, secondary: { kind: 'heal' } } as unknown as typeof d) : d,
  );
  const unknownSpell = catalog.map((d) => (d.defId === 'S-02' ? { ...d, defId: 'S-99' } : d));

  it('createRoundContext throws a typed InvalidCatalogError', () => {
    for (const [bad, code] of [
      [malformed, 'MALFORMED'],
      [unknownSpell, 'UNKNOWN_SPELL'],
    ] as const) {
      expect(() => createRoundContext(bad)).toThrow(InvalidCatalogError);
      try {
        createRoundContext(bad);
      } catch (e) {
        expect((e as InvalidCatalogError).issues).toMatchObject([{ code }]);
      }
    }
  });

  it('startCartignonMatch rejects with INVALID_CATALOG', () => {
    for (const bad of [malformed, unknownSpell]) {
      expect(startCartignonMatch(bad, rng())).toMatchObject({ ok: false, code: 'INVALID_CATALOG' });
    }
  });
});
