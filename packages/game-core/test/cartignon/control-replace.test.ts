import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createRoundContext,
  enumerateSelections,
  isValidSelection,
  legalCommands,
  MAX_LISTED_SELECTIONS,
  replaceLeader,
  roundCardIds,
  takeControl,
  type Board,
  type CardId,
  type RoundCommand,
  type RoundState,
} from '../../src/cartignon/index.js';
import {
  ALL_SORTED,
  CATALOG_ORDER,
  END,
  apply,
  applyAnsweringSingle,
  catalogWithModifiers,
  cr,
  ctx,
  ps,
  rng,
  spell,
  stateOf,
  types,
} from './spell-kit.js';
import { deepFreeze } from './test-fixtures.js';

// R4c-3 review follow-ups: board-level `takeControl` / `replaceLeader` (RD-127, RD-131, RD-139,
// RD-146), bounded `legalCommands` for multi-select choices, replay-lock clearing (RD-145) and
// the RD-143 flag on stack-length-preserving changes.

const choose = (choiceId: number, selection: readonly CardId[]): RoundCommand => ({
  type: 'chooseSpellOption',
  choiceId,
  selection,
});
const play = (cardId: CardId): RoundCommand => ({ type: 'playCreature', cardId });

const R1 = cr('red', 1);
const R2 = cr('red', 2);
const R3 = cr('red', 3);
const B1 = cr('blue', 1);
const B2 = cr('blue', 2);
const B3 = cr('blue', 3);
const Y1 = cr('yellow', 1);
const Y2 = cr('yellow', 2);
const G4 = cr('green', 4);

/** A copy of `s` with board fields replaced (frozen). */
function withBoard(s: RoundState, patch: Partial<Board>): RoundState {
  return deepFreeze({ ...s, board: { ...s.board, ...patch } });
}

/** Armed Link Up for `seat` granted by `source`. */
function armed(seat: 0 | 1, source: CardId): Partial<Board> {
  return {
    linkUpPending: seat === 0 ? [true, false] : [false, true],
    linkUpSource: seat === 0 ? [source, null] : [null, source],
  };
}

/**
 * Attaches spell(2) (+30 effect and the card) and an S-06 copied buff (spell(6) as source) to
 * `target`; both spell cards are taken out of their zone, so card conservation still holds.
 */
function withAttachments(s: RoundState, target: CardId): RoundState {
  const z = s.board.zones;
  const out = (ids: readonly CardId[]) => ids.filter((c) => c !== spell(2));
  return withBoard(s, {
    zones: { ...z, deck: out(z.deck), graveyard: out(z.graveyard) },
    attachedEffects: [
      {
        effectId: 'e1',
        kind: 'atkDelta',
        amount: 30,
        sourceCardId: spell(2),
        targetCardId: target,
      },
    ],
    attachedSpells: [{ cardId: spell(2), seat: 1, targetCardId: target }],
    copiedModifiers: [
      { effectId: 'e2', kind: 'buffSelf', carrierCardId: target, sourceCardId: spell(6) },
    ],
    nextEffectSeq: 3,
  });
}

describe('board takeControl (RD-131, RD-146)', () => {
  const base = () =>
    stateOf({
      hands: [[], []],
      stacks: [
        [R1, R2],
        [B1, B2, B3],
      ],
    });

  it("uses up the taker's armed Link Up (viaLinkUp: true)", () => {
    const b = withBoard(base(), armed(0, R2)).board;
    const r = takeControl(ctx.cards, b, 0, B2);
    if (!r.ok) throw new Error(r.code);
    expect(r.events[0]).toMatchObject({ type: 'controlTaken', cardId: B2, viaLinkUp: true });
    expect(types(r.events)).toContain('linkUpConsumed');
    expect(r.board.linkUpPending).toEqual([false, false]);
    expect(r.board.zones.stacks).toEqual([
      [R1, R2, B2],
      [B1, B3],
    ]);
  });

  it("the previous controller's Link Up lapses when its source creature is taken", () => {
    const b = withBoard(base(), armed(1, B2)).board;
    const r = takeControl(ctx.cards, b, 0, B2);
    if (!r.ok) throw new Error(r.code);
    expect(r.events[0]).toMatchObject({ viaLinkUp: false });
    expect(r.events).toContainEqual({ type: 'linkUpLapsed', seat: 1, sourceCardId: B2 });
    expect(types(r.events)).not.toContain('linkUpConsumed');
    expect(r.board.linkUpPending).toEqual([false, false]);
    expect(r.board.linkUpSource).toEqual([null, null]);
  });

  it('attached effects, attached spells and copied modifiers stay on the taken creature', () => {
    const b = withAttachments(base(), B3).board;
    const r = takeControl(ctx.cards, b, 0, B3);
    if (!r.ok) throw new Error(r.code);
    expect(r.board.attachedEffects).toEqual(b.attachedEffects);
    expect(r.board.attachedSpells).toEqual(b.attachedSpells);
    expect(r.board.copiedModifiers).toEqual(b.copiedModifiers);
    expect(types(r.events)).not.toContain('effectDiscarded');
    expect(types(r.events)).not.toContain('attachedSpellDiscarded');
    expect(types(r.events)).not.toContain('copiedModifierDiscarded');
  });

  it("the previous controller's new Leading creature activates", () => {
    const drawCtx = createRoundContext(catalogWithModifiers([['blue', 2, ['drawDeck']]]));
    const r = takeControl(drawCtx.cards, base().board, 0, B3);
    if (!r.ok) throw new Error(r.code);
    expect(r.events).toContainEqual({
      type: 'modifierLive',
      seat: 1,
      cardId: B2,
      kind: 'drawDeck',
      position: 1,
    });
  });

  it('rejects a card that is not on the other stack', () => {
    expect(takeControl(ctx.cards, base().board, 0, R1)).toMatchObject({
      ok: false,
      code: 'CARD_NOT_ON_STACK',
    });
  });
});

describe('board replaceLeader (RD-127, RD-139)', () => {
  const base = () => stateOf({ hands: [[Y1], []], stacks: [[R1, R2, R3], [B1]] });
  const toHand = { zone: 'hand', seat: 0 } as const;

  it('the old Leader armed the Link Up: it lapses and nothing is consumed', () => {
    const b = withBoard(base(), armed(0, R3)).board;
    const r = replaceLeader(ctx.cards, b, 0, Y1, toHand);
    if (!r.ok) throw new Error(r.code);
    expect(r.events).toContainEqual({ type: 'linkUpLapsed', seat: 0, sourceCardId: R3 });
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'creatureStacked', cardId: Y1, viaLinkUp: false }),
    );
    expect(types(r.events)).not.toContain('linkUpConsumed');
    expect(r.board.linkUpPending).toEqual([false, false]);
    expect(r.board.zones.stacks[0]).toEqual([R1, R2, Y1]);
    expect(r.board.zones.hands[0]).toEqual([R3]);
  });

  it('a lower card armed the Link Up: the new Leader uses it up', () => {
    const b = withBoard(base(), armed(0, R2)).board;
    const r = replaceLeader(ctx.cards, b, 0, Y1, toHand);
    if (!r.ok) throw new Error(r.code);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'creatureStacked', cardId: Y1, viaLinkUp: true }),
    );
    expect(types(r.events)).toContain('linkUpConsumed');
    expect(types(r.events)).not.toContain('linkUpLapsed');
    expect(r.board.linkUpPending).toEqual([false, false]);
  });

  it('the creature below never activates (atomic, RD-127)', () => {
    const drawCtx = createRoundContext(catalogWithModifiers([['red', 2, ['drawDeck']]]));
    const r = replaceLeader(drawCtx.cards, base().board, 0, Y1, toHand);
    if (!r.ok) throw new Error(r.code);
    expect(types(r.events)).not.toContain('modifierLive');
  });
});

describe('round level: control and replacement edge cases', () => {
  it("S-13 uses up the caster's armed Link Up", () => {
    const s = withBoard(stateOf({ hands: [[spell(13), Y1], []], stacks: [[R1, R2], [B1]] }), {
      ...armed(0, R2),
    });
    const { state, events } = apply(s, 0, ps(spell(13)));
    expect(events[1]).toMatchObject({ type: 'controlTaken', cardId: B1, viaLinkUp: true });
    expect(state.board.linkUpPending).toEqual([false, false]);
  });

  it("S-13 taking the opponent's Link Up source: the opponent's Link Up lapses", () => {
    const s = withBoard(
      stateOf({ hands: [[spell(13), Y1], []], stacks: [[R1], [cr('blue', 5), B2]] }),
      armed(1, B2),
    );
    const { state, events } = apply(s, 0, ps(spell(13)));
    expect(events).toContainEqual({ type: 'linkUpLapsed', seat: 1, sourceCardId: B2 });
    expect(state.board.linkUpPending).toEqual([false, false]);
  });

  it('S-13: attachments travel with the taken creature (54 cards conserved)', () => {
    const s = withAttachments(
      stateOf({ hands: [[spell(13), Y1], []], stacks: [[R1], [cr('blue', 5), B3]] }),
      B3,
    );
    expect(roundCardIds(s).sort()).toEqual(ALL_SORTED);
    const { state } = apply(s, 0, ps(spell(13)));
    expect(state.board.zones.stacks[0]).toEqual([R1, B3]);
    expect(state.board.attachedSpells).toEqual(s.board.attachedSpells);
    expect(state.board.attachedEffects).toEqual(s.board.attachedEffects);
    expect(state.board.copiedModifiers).toEqual(s.board.copiedModifiers);
  });

  it("S-13: the opponent's new Leading creature fires its draw modifier for its own seat", () => {
    const drawCtx = createRoundContext(catalogWithModifiers([['blue', 2, ['drawDeck']]]));
    const s = stateOf({
      hands: [[spell(13), Y1], []],
      stacks: [[R1], [cr('blue', 5), B2, cr('blue', 4)]],
      deck: [Y2],
    });
    const { state, events } = apply(s, 0, ps(spell(13)), 1, drawCtx);
    expect(state.pendingChoice).toMatchObject({ kind: 'enemyCreature' });
    const done = apply(state, 0, choose(1, [cr('blue', 4)]), 1, drawCtx);
    expect(types(events)).not.toContain('cardsDrawn');
    expect(done.events).toContainEqual({
      type: 'cardsDrawn',
      seat: 1,
      reason: 'modifierDeck',
      cardIds: [Y2],
    });
  });

  it('S-07: old Leader armed the Link Up -> lapses; a lower card armed it -> consumed', () => {
    const s = stateOf({ hands: [[spell(7), G4], []], stacks: [[R1, R2, R3], [B1]] });
    const lapsed = applyAnsweringSingle(withBoard(s, armed(0, R3)), 0, ps(spell(7))).events;
    expect(lapsed).toContainEqual({ type: 'linkUpLapsed', seat: 0, sourceCardId: R3 });
    expect(lapsed).toContainEqual(expect.objectContaining({ cardId: G4, viaLinkUp: false }));
    expect(types(lapsed)).not.toContain('linkUpConsumed');
    const used = applyAnsweringSingle(withBoard(s, armed(0, R2)), 0, ps(spell(7))).events;
    expect(used).toContainEqual(expect.objectContaining({ cardId: G4, viaLinkUp: true }));
    expect(types(used)).toContain('linkUpConsumed');
    expect(types(used)).not.toContain('linkUpLapsed');
  });
});

describe('bounded legalCommands for multi-select choices (S-17 handToDeck)', () => {
  it('a 20-card hand with surplus 10: at most MAX_LISTED_SELECTIONS, all legal; any valid one is accepted', () => {
    const free = CATALOG_ORDER.filter((c) => ![R1, B1, spell(17)].includes(c));
    const own = free.slice(0, 20);
    const opp = free.slice(20, 30);
    const s = stateOf({ hands: [[spell(17), ...own], opp], stacks: [[R1], [B1]] });
    const mid = apply(s, 0, ps(spell(17))).state;
    const pending = mid.pendingChoice;
    expect(pending).toMatchObject({ kind: 'handToDeck', min: 10, max: 10 });
    if (pending === undefined) throw new Error('no pending choice');

    const started = performance.now();
    const legal = legalCommands(ctx, mid, 0);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(legal).toHaveLength(MAX_LISTED_SELECTIONS);
    expect(legal[0]).toEqual(choose(1, own.slice(0, 10))); // R7 timeout default: a legal answer
    for (const c of legal) {
      if (c.type !== 'chooseSpellOption') throw new Error('unexpected command');
      expect(isValidSelection(pending, c.selection)).toBe(true);
    }
    // A selection outside the listed prefix is still accepted (isValidSelection is the authority).
    const unlisted = own.slice(10);
    expect(legal).not.toContainEqual(choose(1, unlisted));
    const r = applyCommand(ctx, mid, 0, choose(1, unlisted), rng());
    expect(r.ok).toBe(true);
  });

  it('enumerateSelections honours the limit and stays complete without one', () => {
    const c = { options: ['a', 'b', 'c', 'd'], min: 2, max: 2 };
    expect(enumerateSelections(c)).toHaveLength(6);
    expect(enumerateSelections(c, 4)).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['a', 'd'],
      ['b', 'c'],
    ]);
    expect(enumerateSelections(c, 0)).toEqual([]);
  });
});

describe('replay locks are cleared at every turn end (RD-145)', () => {
  it('S-09 then a turn-ending S-07 in the same turn clears the lock', () => {
    const s = stateOf({
      hands: [[spell(9), spell(7), Y2, G4], []],
      stacks: [[R1, R2, R3], [B1]],
    });
    const locked = applyAnsweringSingle(s, 0, ps(spell(9))).state; // only Y2 is lower (RD-162: answered)
    expect(locked.turnLocks).toEqual([{ seat: 0, cardId: R3 }]);
    const { state } = applyAnsweringSingle(locked, 0, ps(spell(7))); // only G4 is placeable
    expect(state.phase).toEqual({ kind: 'turn', active: 1 });
    expect(state.turnLocks).toBeUndefined();
  });

  const lockedState = (stacks: readonly [CardId[], CardId[]]): RoundState =>
    deepFreeze({
      ...stateOf({ hands: [[R3], []], stacks }),
      turnLocks: [{ seat: 0, cardId: R3 }],
    });

  it('End Turn hand-over at equal ATK clears the lock', () => {
    const { state } = apply(lockedState([[R1], [B1]]), 0, END);
    expect(state.phase).toMatchObject({ kind: 'turn', active: 1 });
    expect(state.turnLocks).toBeUndefined();
  });

  it('End Turn with the opponent behind clears the lock', () => {
    const { state } = apply(lockedState([[R1, R2], [B1]]), 0, END);
    expect(state.phase).toMatchObject({ kind: 'turn', active: 1 });
    expect(state.turnLocks).toBeUndefined();
  });

  it('round end clears the lock', () => {
    const { state } = apply(lockedState([[R1], [B1, B2]]), 0, END);
    expect(state.phase.kind).toBe('roundOver');
    expect(state.turnLocks).toBeUndefined();
  });

  it('the lock is still in force within the turn after another, non-ending spell', () => {
    const s = stateOf({ hands: [[spell(9), spell(15), Y2], []], stacks: [[R1, R2, R3], [B1]] });
    const locked = applyAnsweringSingle(s, 0, ps(spell(9))).state;
    const after = apply(locked, 0, ps(spell(15))).state;
    expect(after.turnLocks).toEqual([{ seat: 0, cardId: R3 }]);
    expect(legalCommands(ctx, after, 0)).not.toContainEqual(play(R3));
    expect(apply(after, 0, END).state.turnLocks).toBeUndefined();
  });
});

describe("RD-143: the flag is set on any change of P1's stack", () => {
  it("S-07 replacing P1's single Base (same stack length)", () => {
    const s = stateOf({ hands: [[spell(7), G4], []], stacks: [[R1], [B1]] });
    const { state } = applyAnsweringSingle(s, 0, ps(spell(7)));
    expect(state.board.zones.stacks[0]).toEqual([G4]);
    expect(state.p1StackTouchedBySpell).toBe(true);
  });

  it("S-09 replacing P1's single Base (same stack length)", () => {
    const s = stateOf({ hands: [[spell(9), Y1], []], stacks: [[R3], [B1]] });
    const { state } = applyAnsweringSingle(s, 0, ps(spell(9)));
    expect(state.board.zones.stacks[0]).toEqual([Y1]);
    expect(state.p1StackTouchedBySpell).toBe(true);
  });

  it('S-03 swap', () => {
    const s = stateOf({
      hands: [[spell(3)], []],
      stacks: [
        [R1, R2, R3],
        [B1, B2, B3],
      ],
    });
    const { state } = apply(s, 0, ps(spell(3)));
    expect(state.board.zones.stacks[0]).toEqual([B1, B2, B3]);
    expect(state.p1StackTouchedBySpell).toBe(true);
  });

  it("S-18 cast by P2 returning one of P1's creatures", () => {
    const s = stateOf({
      hands: [[], [spell(18)]],
      stacks: [[R1, R2, R3], [B1]],
      phase: { kind: 'turn', active: 1 },
    });
    const mid = apply(s, 1, ps(spell(18))).state;
    const { state } = apply(mid, 1, choose(1, [R2])); // own creature B1: automatic
    expect(state.board.zones.stacks[0]).toEqual([R1, R3]);
    expect(state.p1StackTouchedBySpell).toBe(true);
  });
});
