import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  beatenBy,
  createRoundContext,
  DEFAULT_COLOR_RULES,
  legalCommands,
  ownerOf,
  pendingChoiceView,
  type CardId,
  type RoundCommand,
  type RoundState,
} from '../../src/cartignon/index.js';
import {
  END,
  apply,
  applyAnsweringSingle,
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

// R4c-3: placement, replacement and control spells (S-05, S-07, S-09, S-13, S-17, S-18), replay
// locks (`turnLocks`), RD-143 (Nullify ban) and review finding 4 (leaving `p2Opening`).
// Placeholder creatures have atk = level * 10 and no modifiers unless stated.

const choose = (choiceId: number, selection: readonly CardId[]): RoundCommand => ({
  type: 'chooseSpellOption',
  choiceId,
  selection,
});
const play = (cardId: CardId): RoundCommand => ({ type: 'playCreature', cardId });
const nullify = (cardId: CardId): RoundCommand => ({ type: 'nullify', cardId });

const R1 = cr('red', 1);
const R2 = cr('red', 2);
const R3 = cr('red', 3);
const B1 = cr('blue', 1);
const B2 = cr('blue', 2);
const B3 = cr('blue', 3);
const B5 = cr('blue', 5);
const Y1 = cr('yellow', 1);
const Y2 = cr('yellow', 2);
const Y3 = cr('yellow', 3);
const Y4 = cr('yellow', 4);
const G4 = cr('green', 4);
const G5 = cr('green', 5);
const V1 = cr('violet', 1);

describe('S-05 Wild Link (RD-117, RD-108)', () => {
  it('opponent has a level 5: the caster chooses a hand creature; linked ignoring the level', () => {
    const s = stateOf({ hands: [[spell(5), Y2, G4], [V1]], stacks: [[R1], [B5]] });
    const played = apply(s, 0, ps(spell(5)));
    expect(played.state.pendingChoice).toMatchObject({
      kind: 'handCreature',
      options: [Y2, G4],
      min: 1,
      max: 1,
    });
    const { state, events } = apply(played.state, 0, choose(1, [G4]));
    expect(types(events)).toEqual(['spellChoiceMade', 'creatureStacked', 'spellResolved']);
    expect(events[1]).toMatchObject({ seat: 0, cardId: G4, position: 1, viaLinkUp: false });
    expect(state.board.zones.stacks[0]).toEqual([R1, G4]);
    expect(state.phase).toEqual(s.phase);
  });

  it('no creature of the caster on the field: the placed creature becomes the Base', () => {
    const s = stateOf({ hands: [[spell(5), G4], []], stacks: [[], [B5]], p1: 1 });
    const { state, events } = applyAnsweringSingle(s, 0, ps(spell(5)));
    expect(types(events)).toEqual([
      'spellPlayed',
      'spellChoiceRequested', // RD-162: even with a single candidate
      'spellChoiceMade',
      'creatureStacked',
      'spellResolved',
    ]);
    expect(events[3]).toMatchObject({ cardId: G4, position: 0 });
    expect(state.board.zones.stacks[0]).toEqual([G4]);
  });

  it('no enemy level 5 (or no hand creature) -> Secondary: buff +30 on the own Leader', () => {
    for (const [hand, opp] of [
      [[spell(5), G4], [B3]],
      [[spell(5)], [B5]],
    ] as const) {
      const s = stateOf({ hands: [[...hand], []], stacks: [[R1, R2], [...opp]] });
      const { events } = apply(s, 0, ps(spell(5)));
      expect(events[0]).toMatchObject({ branch: 'secondary' });
      expect(events[1]).toMatchObject({ effect: { amount: 30, targetCardId: R2 } });
    }
  });
});

describe('S-07 Changing of the Guard (RD-108, RD-127, RD-172)', () => {
  it('old Leader into the deck (shuffled), chosen creature in its place; the turn goes on', () => {
    const s = stateOf({
      hands: [[spell(7), Y2, G4], [V1]],
      stacks: [[R1, R2], [B1]],
      deck: [Y1, Y3],
    });
    const played = apply(s, 0, ps(spell(7)));
    expect(played.state.pendingChoice).toMatchObject({ kind: 'handCreature', options: [Y2, G4] });
    const { state, events } = apply(played.state, 0, choose(1, [G4]));
    expect(types(events)).toEqual([
      'spellChoiceMade',
      'creatureRemoved',
      'creatureStacked',
      'deckShuffled',
      'spellResolved',
    ]);
    expect(events[1]).toEqual({
      type: 'creatureRemoved',
      seat: 0,
      cardId: R2,
      position: 1,
      to: { zone: 'deck' },
    });
    expect(events[2]).toMatchObject({ cardId: G4, position: 1 });
    expect(state.board.zones.stacks[0]).toEqual([R1, G4]);
    expect([...state.board.zones.deck].sort()).toEqual([R2, Y1, Y3].sort());
    // RD-172: the turn does not end; nothing returned to a hand, so nothing is locked.
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
    expect(state.turnNumber).toBe(s.turnNumber);
    expect(state.turnLocks).toBeUndefined();
  });

  it('RD-127: atomic; the creature below never activates, only the new Leader does', () => {
    const edgeCtx = createRoundContext(
      catalogWithModifiers([
        ['red', 2, ['drawDeck']],
        ['green', 4, ['buffSelf', 'drawDeck']],
      ]),
    );
    const s = stateOf({ hands: [[spell(7), G4], []], stacks: [[R1, R2, R3], [B1]], deck: [Y1] });
    const { state, events } = applyAnsweringSingle(s, 0, ps(spell(7)), 1, edgeCtx);
    const live = events.filter((e) => e.type === 'modifierLive');
    expect(live).toEqual([
      { type: 'modifierLive', seat: 0, cardId: G4, kind: 'drawDeck', position: 2 },
    ]);
    expect(events.filter((e) => e.type === 'cardsDrawn')).toEqual([
      { type: 'cardsDrawn', seat: 0, reason: 'modifierDeck', cardIds: [Y1] },
    ]);
    expect(state.board.zones.stacks[0]).toEqual([R1, R2, G4]);
    expect(state.board.zones.hands[0]).toEqual([Y1]);
  });

  it('no hand creature -> Secondary: grave draw; the turn does not end', () => {
    const s = stateOf({ hands: [[spell(7)], []], stacks: [[R1], [B1]], deck: [Y1] });
    const { state, events } = apply(s, 0, ps(spell(7)));
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(events[1]).toMatchObject({ type: 'cardsDrawn', reason: 'spellGraveyard' });
    expect(state.phase).toEqual(s.phase);
  });
});

describe('S-09 Tactical Retreat and replay locks (RD-117, RD-127, RD-145)', () => {
  const retreat = (): RoundState =>
    stateOf({ hands: [[spell(9), Y1, Y2, G4], [V1]], stacks: [[R1, R2, R3], [B1]] });

  it('Leader to hand, a lower-level creature in its place; the returned one is locked', () => {
    const played = apply(retreat(), 0, ps(spell(9)));
    expect(played.state.pendingChoice).toMatchObject({ kind: 'handCreature', options: [Y1, Y2] });
    const { state, events } = apply(played.state, 0, choose(1, [Y2]));
    expect(types(events)).toEqual([
      'spellChoiceMade',
      'creatureRemoved',
      'creatureStacked',
      'replayLocked',
      'spellResolved',
    ]);
    expect(events[1]).toMatchObject({ cardId: R3, to: { zone: 'hand', seat: 0 } });
    expect(events[3]).toEqual({ type: 'replayLocked', seat: 0, cardId: R3 });
    expect(state.board.zones.stacks[0]).toEqual([R1, R2, Y2]);
    expect(state.board.zones.hands[0]).toEqual([Y1, G4, R3]);
    expect(state.turnLocks).toEqual([{ seat: 0, cardId: R3 }]);
    expect(state.phase).toEqual({ kind: 'turn', active: 0 }); // the turn goes on
  });

  it('the locked creature is rejected and not offered until the turn ends', () => {
    // Seat 1 can overtake (B3: 60 vs 50), so both End Turns pass the turn (RD-169).
    const s = stateOf({
      hands: [[spell(9), Y1, Y2, G4], [B3]],
      stacks: [
        [R1, R2, R3],
        [B1, B2],
      ],
    });
    const played = apply(s, 0, ps(spell(9)));
    const locked = apply(played.state, 0, choose(1, [Y2])).state;
    // R3 (level 3) would otherwise follow the Leader Y2 (level 2).
    expectReject(locked, 0, play(R3), 'CARD_REPLAY_LOCKED');
    const passed = apply(locked, 0, END).state;
    expect(passed.turnLocks).toBeUndefined();
    const back = apply(apply(passed, 1, play(B3)).state, 1, END).state;
    expect(legalCommands(ctx, back, 0)).toContainEqual(play(R3));
  });

  it('RD-145: a later spell in the same turn does not place the locked creature', () => {
    const s = stateOf({ hands: [[spell(9), spell(5), Y1], []], stacks: [[R1, R2], [B5]] });
    const after = applyAnsweringSingle(s, 0, ps(spell(9))).state; // single candidate Y1
    expect(after.turnLocks).toEqual([{ seat: 0, cardId: R2 }]);
    // S-05: R2 is the only hand creature, but locked -> infeasible -> Secondary.
    const { state, events } = apply(after, 0, ps(spell(5)));
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(state.board.zones.hands[0]).toEqual([R2]);
  });

  it('no lower-level hand creature -> Secondary: buff +30', () => {
    const s = stateOf({ hands: [[spell(9), G4], []], stacks: [[R1, R2], [B1]] });
    const { state, events } = apply(s, 0, ps(spell(9)));
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(state.turnLocks).toBeUndefined();
  });
});

describe('S-13 Defection (RD-106, RD-131, RD-110): two chained choices end to end', () => {
  it('take an enemy creature, then discard; both answered through chooseSpellOption', () => {
    const s = stateOf({
      hands: [[spell(13), Y1, G5], [V1]],
      stacks: [
        [R1, R2],
        [B1, B2, B3],
      ],
    });
    const first = apply(s, 0, ps(spell(13)));
    expect(first.state.pendingChoice).toMatchObject({
      choiceId: 1,
      kind: 'enemyCreature',
      options: [B1, B2, B3],
    });
    expect(legalCommands(ctx, first.state, 0)).toEqual([
      choose(1, [B1]),
      choose(1, [B2]),
      choose(1, [B3]),
    ]);

    const second = apply(first.state, 0, choose(1, [B2]));
    expect(types(second.events)).toEqual([
      'spellChoiceMade',
      'controlTaken',
      'spellChoiceRequested',
    ]);
    expect(second.events[1]).toEqual({
      type: 'controlTaken',
      seat: 0,
      from: 1,
      cardId: B2,
      fromPosition: 1,
      position: 2,
      viaLinkUp: false,
    });
    expect(second.events[2]).toEqual({
      type: 'spellChoiceRequested',
      seat: 0,
      spellId: 'S-13',
      cardId: spell(13),
      kind: 'handDiscard',
      optionCount: 2,
    });
    const mid = second.state;
    expect(mid.pendingChoice).toMatchObject({
      choiceId: 2,
      kind: 'handDiscard',
      options: [Y1, G5],
    });
    expect(mid.board.zones.stacks).toEqual([
      [R1, R2, B2],
      [B1, B3],
    ]);
    // RD-131: ownership follows the stack.
    expect(ownerOf(mid.board, B2)).toBe(0);
    // The stale first answer is rejected now.
    expect(applyCommand(ctx, mid, 0, choose(1, [Y1]), rng())).toMatchObject({
      ok: false,
      code: 'CHOICE_ID_MISMATCH',
    });

    const done = apply(mid, 0, choose(2, [G5]));
    expect(types(done.events)).toEqual(['spellChoiceMade', 'cardsDiscarded', 'spellResolved']);
    expect(done.events[1]).toEqual({ type: 'cardsDiscarded', seat: 0, cardIds: [G5] });
    const z = done.state.board.zones;
    expect(z.hands[0]).toEqual([Y1]);
    expect(z.graveyard).toEqual(expect.arrayContaining([G5, spell(13)]));
    expect(done.state.pendingChoice).toBeUndefined();
    expect(done.state.nextChoiceId).toBe(3);
    expect(done.state.phase).toEqual(s.phase);
  });

  it('a JSON round-trip between the two choices resumes identically', () => {
    const s = stateOf({ hands: [[spell(13), Y1, G5], []], stacks: [[R1], [B1, B2]] });
    const mid = apply(apply(s, 0, ps(spell(13))).state, 0, choose(1, [B1])).state;
    const copy = deepFreeze(JSON.parse(JSON.stringify(mid)) as RoundState);
    expect(applyCommand(ctx, copy, 0, choose(2, [Y1]), rng(4))).toEqual(
      applyCommand(ctx, mid, 0, choose(2, [Y1]), rng(4)),
    );
  });

  it('taking the Base: position 1 becomes the new Base; a single hand card is discarded automatically', () => {
    const s = stateOf({ hands: [[spell(13), Y1], []], stacks: [[R1], [B1, B5]] });
    const { state, events } = apply(s, 0, ps(spell(13))); // B1 is the only level 1-4 target
    expect(types(events)).toEqual([
      'spellPlayed',
      'controlTaken',
      'cardsDiscarded',
      'spellResolved',
    ]);
    expect(state.board.zones.stacks).toEqual([[R1, B1], [B5]]);
    expect(state.board.zones.hands[0]).toEqual([]);
  });

  it('no level 1-4 enemy, or no other hand card -> Secondary: buff +30', () => {
    for (const [hand, opp] of [
      [[spell(13), Y1], [B5]],
      [[spell(13)], [B1]],
    ] as const) {
      const s = stateOf({ hands: [[...hand], []], stacks: [[R1], [...opp]] });
      const { events } = apply(s, 0, ps(spell(13)));
      expect(events[0]).toMatchObject({ branch: 'secondary' });
      expect(events[1]).toMatchObject({ effect: { amount: 30, targetCardId: R1 } });
    }
  });
});

describe('S-17 Hostile Takeover (RD-110, RD-131): two chained choices end to end', () => {
  it('surplus to the deck (hidden), shuffle, then take an enemy creature', () => {
    const s = stateOf({
      hands: [
        [spell(17), Y1, Y2, Y3, Y4],
        [V1, cr('violet', 2)],
      ],
      stacks: [[R1], [B1, B2]],
      deck: [cr('orange', 1)],
    });
    const first = apply(s, 0, ps(spell(17)));
    expect(first.state.pendingChoice).toMatchObject({
      kind: 'handToDeck',
      options: [Y1, Y2, Y3, Y4],
      min: 2,
      max: 2,
    });
    expect(pendingChoiceView(first.state, 1)).toEqual({
      seat: 0,
      kind: 'handToDeck',
      spellId: 'S-17',
      optionCount: 4,
      min: 2,
      max: 2,
    });

    const second = apply(first.state, 0, choose(1, [Y1, Y3]));
    expect(types(second.events)).toEqual([
      'spellChoiceMade',
      'handCardsReturned',
      'deckShuffled',
      'spellChoiceRequested',
    ]);
    expect(second.events[1]).toEqual({ type: 'handCardsReturned', seat: 0, cardIds: [Y1, Y3] });
    expect(second.events[3]).toMatchObject({ kind: 'enemyCreature', optionCount: 2 });
    const mid = second.state;
    expect(mid.board.zones.hands[0]).toEqual([Y2, Y4]);
    expect([...mid.board.zones.deck].sort()).toEqual([cr('orange', 1), Y1, Y3].sort());

    const done = apply(mid, 0, choose(2, [B1]));
    expect(types(done.events)).toEqual(['spellChoiceMade', 'controlTaken', 'spellResolved']);
    expect(done.state.board.zones.stacks).toEqual([[R1, B1], [B2]]);
    expect(done.state.board.zones.hands[0]).toHaveLength(2);
    expect(done.state.pendingChoice).toBeUndefined();
  });

  it('surplus < 2, or no enemy creature -> Secondary: deck draw', () => {
    for (const [hand, opp] of [
      [[spell(17), Y1, Y2], [B1]],
      [[spell(17), Y1, Y2, Y3], []],
    ] as const) {
      const s = stateOf({ hands: [[...hand], [V1]], stacks: [[R1], [...opp]] });
      const { events } = apply(s, 0, ps(spell(17)));
      expect(events[0]).toMatchObject({ branch: 'secondary' });
      expect(events[1]).toMatchObject({ type: 'cardsDrawn', reason: 'spellDeck' });
    }
  });
});

describe('S-18 Mutual Withdrawal (RD-119, RD-172)', () => {
  it('enemy then own creature; both return at once, replay-locked; the turn goes on', () => {
    const s = stateOf({
      hands: [[spell(18)], []],
      stacks: [
        [R1, R2],
        [B1, B2, B3, B5],
      ],
    });
    const first = apply(s, 0, ps(spell(18)));
    expect(first.state.pendingChoice).toMatchObject({ kind: 'enemyCreature' });
    const second = apply(first.state, 0, choose(1, [B3]));
    expect(second.state.pendingChoice).toMatchObject({ kind: 'ownCreature', options: [R1, R2] });
    const { state, events } = apply(second.state, 0, choose(2, [R1]));
    expect(types(events)).toEqual([
      'spellChoiceMade',
      'creatureRemoved',
      'creatureRemoved',
      'replayLocked',
      'replayLocked',
      'spellResolved',
    ]);
    expect(state.board.zones.stacks).toEqual([[R2], [B1, B2, B5]]);
    expect(state.board.zones.hands).toEqual([[R1], [B3]]);
    // RD-172: seat 0 keeps the turn (even while behind, 20 vs 80); both returned are locked.
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
    expect(state.turnLocks).toEqual([
      { seat: 0, cardId: R1 },
      { seat: 1, cardId: B3 },
    ]);
    expectReject(state, 0, play(R1), 'CARD_REPLAY_LOCKED');
    expect(legalCommands(ctx, state, 0).some((c) => c.type === 'playCreature')).toBe(false);
    // Ending the turn while behind ends the round (RD-169).
    const ended = apply(state, 0, END).state;
    expect(ended.phase).toMatchObject({ kind: 'roundOver', reason: 'opponentAhead', seat: 0 });
  });

  it('RD-172 / RD-145: a later spell in the same turn does not place the returned creature', () => {
    const s = stateOf({
      hands: [[spell(18), spell(5)], []],
      stacks: [
        [R1, R2],
        [B1, B2, B3, B5],
      ],
    });
    const second = apply(apply(s, 0, ps(spell(18))).state, 0, choose(1, [B3])).state;
    const after = apply(second, 0, choose(2, [R1])).state;
    expect(after.board.zones.hands[0]).toEqual([spell(5), R1]);
    // S-05 (enemy level 5 present): R1 is the only hand creature, but locked -> Secondary.
    const { state, events } = apply(after, 0, ps(spell(5)));
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(state.board.zones.hands[0]).toEqual([R1]);
  });

  it('a single own creature is chosen automatically after the enemy choice', () => {
    const s = stateOf({ hands: [[spell(18)], []], stacks: [[R1], [B1, B2, B3]] });
    const first = apply(s, 0, ps(spell(18)));
    const { state, events } = apply(first.state, 0, choose(1, [B1]));
    expect(types(events).slice(0, 3)).toEqual([
      'spellChoiceMade',
      'creatureRemoved',
      'creatureRemoved',
    ]);
    expect(state.board.zones.stacks).toEqual([[], [B2, B3]]);
    expect(state.stackEmptiedBySpell).toBe(true);
  });

  it('no own creature, or not 2 more enemy creatures -> Secondary: grave draw', () => {
    for (const stacks of [
      [[], [B1, B2]],
      [[R1], [B1, B2]],
    ] as const) {
      const s = stateOf({ hands: [[spell(18)], []], stacks: [[...stacks[0]], [...stacks[1]]] });
      const { state, events } = apply(s, 0, ps(spell(18)), 1);
      expect(events[0]).toMatchObject({ branch: 'secondary' });
      expect(state.phase).toEqual(s.phase);
    }
  });
});

describe('RD-142: no option count for handCreature in the public data', () => {
  it('the event and the non-chooser view omit the count; the chooser sees the options', () => {
    const s = stateOf({ hands: [[spell(5), Y2, G4], [V1]], stacks: [[R1], [B5]] });
    const { state, events } = apply(s, 0, ps(spell(5)));
    const requested = events.at(-1);
    expect(requested).toMatchObject({ type: 'spellChoiceRequested', kind: 'handCreature' });
    expect(requested).not.toHaveProperty('optionCount');
    expect(pendingChoiceView(state, 1)).toEqual({
      seat: 0,
      kind: 'handCreature',
      spellId: 'S-05',
      min: 1,
      max: 1,
    });
    expect(pendingChoiceView(state, 0)).toMatchObject({ options: [Y2, G4] });
  });
});

describe('RD-143: a spell that touched P1 stack bans Nullify for the round', () => {
  const nullifier = cr(beatenBy(DEFAULT_COLOR_RULES, 'red'), 2);

  /** P2 (seat 1) in a reopened opening response: S-11 removes P1's Base; P2 keeps the turn. */
  function reopened(): RoundState {
    const s = stateOf({
      hands: [[], [spell(11), nullifier]],
      stacks: [[R1, R2], []],
      phase: { kind: 'p2Opening', active: 1 },
    });
    const mid = apply(s, 1, ps(spell(11))).state;
    const afterRepel = apply(mid, 1, choose(1, [R1])).state;
    expect(afterRepel.p1StackTouchedBySpell).toBe(true);
    // RD-172: the turn does not end; P1 still has a Base, so P2 stays in p2Opening (RD-144).
    expect(afterRepel.phase).toEqual({ kind: 'p2Opening', active: 1 });
    expect(afterRepel.board.zones.stacks[0]).toEqual([R2]); // RD-79 alone would allow Nullify now
    return afterRepel;
  }

  it('flag set -> Nullify rejected with NULLIFY_NOT_ALLOWED and not offered', () => {
    expectReject(reopened(), 1, nullify(nullifier), 'NULLIFY_NOT_ALLOWED');
  });

  it('control: the same state without the flag allows Nullify', () => {
    const rest: { -readonly [K in keyof RoundState]: RoundState[K] } = { ...reopened() };
    delete rest.p1StackTouchedBySpell;
    expect(legalCommands(ctx, deepFreeze(rest), 1)).toContainEqual(nullify(nullifier));
  });

  it("a spell that leaves P1's stack alone does not set the flag", () => {
    const s = stateOf({
      hands: [[cr('red', 4)], [spell(2), nullifier]],
      stacks: [[R1], []],
      phase: { kind: 'p2Opening', active: 1 },
    });
    const { state } = apply(s, 1, ps(spell(2)));
    expect(state.p1StackTouchedBySpell).toBeUndefined();
    expect(legalCommands(ctx, state, 1)).toContainEqual(nullify(nullifier));
  });
});

describe('review finding 4 / RD-144: a spell that gives P2 a stack ends p2Opening', () => {
  it('S-05 in p2Opening: the placed creature is the Base; phase turn, End Turn legal', () => {
    const s = stateOf({
      hands: [[], [spell(5), G5]],
      stacks: [[B5], []],
      phase: { kind: 'p2Opening', active: 1 },
    });
    const { state } = applyAnsweringSingle(s, 1, ps(spell(5))); // single option, answered (RD-162)
    expect(state.board.zones.stacks[1]).toEqual([G5]); // level 5 > Base Level: no RD-07 limits
    expect(state.phase).toEqual({ kind: 'turn', active: 1 });
    expect(legalCommands(ctx, state, 1)).toContainEqual(END);
    // RD-143: placing on P2's own stack does not touch P1's.
    expect(state.p1StackTouchedBySpell).toBeUndefined();
  });

  it("S-13 taking P1's only Base in p2Opening: no throw, normal turn for P2", () => {
    const s = stateOf({
      hands: [[], [spell(13), Y3, G5]],
      stacks: [[R2], []],
      phase: { kind: 'p2Opening', active: 1 },
    });
    const mid = apply(s, 1, ps(spell(13))).state; // R2 is the only target: automatic
    expect(mid.pendingChoice).toMatchObject({ kind: 'handDiscard', options: [Y3, G5] });
    expect(mid.phase).toEqual({ kind: 'p2Opening', active: 1 }); // unchanged while pending
    const { state } = apply(mid, 1, choose(1, [G5]));
    expect(state.board.zones.stacks).toEqual([[], [R2]]);
    expect(state.phase).toEqual({ kind: 'turn', active: 1 });
    expect(state.stackEmptiedBySpell).toBe(true);
    expect(state.p1StackTouchedBySpell).toBe(true);
    const legal = legalCommands(ctx, state, 1);
    expect(legal).toContainEqual(play(Y3));
    expect(legal).toContainEqual(END);
  });

  it('defensive p1BaseDef guard: p2Opening without a P1 Base never throws', () => {
    const s = stateOf({
      hands: [[], [Y3, nullifierFor()]],
      phase: { kind: 'p2Opening', active: 1 },
    });
    expect(() => legalCommands(ctx, s, 1)).not.toThrow();
    expect(legalCommands(ctx, s, 1).filter((c) => c.type === 'nullify')).toEqual([]);
    expect(legalCommands(ctx, s, 1)).toContainEqual(play(Y3));
  });
});

function nullifierFor(): CardId {
  return cr(beatenBy(DEFAULT_COLOR_RULES, 'red'), 1);
}
