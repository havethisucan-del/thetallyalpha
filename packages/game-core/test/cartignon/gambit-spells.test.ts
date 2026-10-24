import { describe, expect, it } from 'vitest';
import {
  NULL_SNARE,
  RECOIL_SNARE,
  activeSeat,
  applyCommand,
  createRoundContext,
  legalCommands,
  pendingChoiceView,
  roundCardIds,
  type Board,
  type CardId,
  type RoundCommand,
  type RoundContext,
  type RoundEvent,
  type RoundState,
} from '../../src/cartignon/index.js';
import type { Seat } from '../../src/index.js';
import {
  ALL_SORTED,
  END,
  apply,
  applyAnsweringSingle,
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

// R4c-5: S-19 Gambit Prism (RD-108, RD-112, RD-119, RD-120, RD-152, RD-156..RD-161, RD-172).
// Placeholder creatures have atk = level * 10 and no modifiers unless stated.

const S19 = spell(19);
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
const G1 = cr('green', 1);
const G5 = cr('green', 5);

/**
 * `s` with exactly `cards` in the graveyard: they are taken out of the deck, and the previous
 * graveyard cards go to the bottom of the deck (all 54 cards stay in play).
 */
function withGraveyard(s: RoundState, cards: readonly CardId[]): RoundState {
  const ids = new Set(cards);
  const z = s.board.zones;
  const displaced = z.graveyard.filter((c) => !ids.has(c));
  const board: Board = {
    ...s.board,
    zones: {
      ...z,
      deck: [...z.deck.filter((c) => !ids.has(c)), ...displaced],
      graveyard: [...cards],
    },
  };
  return deepFreeze({ ...s, board });
}

/** RD-02: every one of the 54 cards exactly once (no duplicates, nothing missing). */
function expectConserved(state: RoundState): void {
  const ids = roundCardIds(state);
  expect(ids).toHaveLength(54);
  expect(new Set(ids).size).toBe(54);
  expect([...ids].sort()).toEqual(ALL_SORTED);
}

// A second S-19 instance: c36 (normally S-01) carries the S-19 definition.
const S19_DEF = catalog.find((d) => d.defId === 'S-19');
const twin: RoundContext = createRoundContext(
  catalog.map((d) => (d.defId === 'S-01' && S19_DEF !== undefined ? S19_DEF : d)),
);
const S19B = spell(1);

/** The first seed whose S-19 (`cardId`, seat 0) draws `wanted` out of the graveyard. */
function seedDrawing(s: RoundState, cardId: CardId, wanted: CardId): number {
  for (let seed = 1; seed <= 100; seed++) {
    const r = applyCommand(twin, s, 0, ps(cardId), rng(seed));
    if (!r.ok) throw new Error(r.code);
    const drawn = r.events.find((e) => e.type === 'gambitDrawn');
    if (drawn?.type === 'gambitDrawn' && drawn.drawnCardId === wanted) return seed;
  }
  throw new Error(`no seed draws ${wanted}`);
}

/** `s` with traps armed on the board (their cards taken out of the deck). */
function withTraps(s: RoundState, traps: readonly (readonly [CardId, Seat])[]): RoundState {
  const ids = new Set(traps.map(([c]) => c));
  const z = s.board.zones;
  const board: Board = {
    ...s.board,
    zones: { ...z, deck: z.deck.filter((c) => !ids.has(c)) },
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

/** Seat 0 on turn, `hand0` in hand, the given stacks and graveyard. */
function gambit(
  graveyard: readonly CardId[],
  stacks: [CardId[], CardId[]] = [[R1, R2], [B1]],
  hand0: CardId[] = [S19],
  hand1: CardId[] = [],
): RoundState {
  return withGraveyard(stateOf({ hands: [hand0, hand1], stacks }), graveyard);
}

describe('S-19 draw (RD-158)', () => {
  it('empty graveyard: still playable, nothing happens, S-19 goes to the graveyard', () => {
    const s = gambit([]);
    expect(legalCommands(ctx, s, 0)).toContainEqual(ps(S19));
    const { state, events } = apply(s, 0, ps(S19));
    expect(types(events)).toEqual(['spellPlayed', 'gambitDrawn', 'spellResolved']);
    expect(events[0]).toEqual({ type: 'spellPlayed', seat: 0, cardId: S19, branch: 'primary' });
    expect(events[1]).toEqual({ type: 'gambitDrawn', seat: 0, cardId: S19 });
    expect(state.board.zones.graveyard).toEqual([S19]);
    expect(state.board.zones.stacks).toEqual(s.board.zones.stacks);
    expect(state.phase).toEqual(s.phase);
    expect(state.playedThisTurn).toBe(true);
  });

  it('S-19 never draws itself: it is in resolution during the draw', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { events, state } = apply(gambit([G5]), 0, ps(S19), seed);
      expect(find(events, 'gambitDrawn')).toEqual([
        { type: 'gambitDrawn', seat: 0, cardId: S19, drawnCardId: G5, drawnKind: 'creature' },
      ]);
      expect(state.board.zones.graveyard).toEqual([S19]);
    }
  });

  it('the pick is random through the round RNG and deterministic per seed', () => {
    const picks = new Set<CardId>();
    for (let seed = 1; seed <= 30; seed++) {
      const s = gambit([G1, G5, B3]);
      const once = apply(s, 0, ps(S19), seed);
      const again = apply(s, 0, ps(S19), seed);
      expect(again).toEqual(once);
      const drawn = find(once.events, 'gambitDrawn')[0];
      if (drawn?.type === 'gambitDrawn' && drawn.drawnCardId !== undefined) {
        picks.add(drawn.drawnCardId);
      }
    }
    expect(picks.size).toBeGreaterThan(1);
  });
});

describe('S-19 creature (RD-108, RD-120, RD-152)', () => {
  it('links it onto the Leading creature ignoring level and colour, as a normal placement', () => {
    const { state, events } = apply(gambit([G5]), 0, ps(S19));
    expect(state.board.zones.stacks[0]).toEqual([R1, R2, G5]);
    expect(find(events, 'creatureStacked')).toEqual([
      { type: 'creatureStacked', seat: 0, cardId: G5, position: 2, viaLinkUp: false },
    ]);
    expect(state.board.zones.graveyard).toEqual([S19]);
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
  });

  it('uses up an armed Link Up of the caster (RD-108)', () => {
    const s = withGraveyard(
      stateOf({
        hands: [[S19], []],
        stacks: [[R1, R2], [B1]],
        board: { linkUpPending: [true, false] },
      }),
      [G5],
    );
    const { state, events } = apply(s, 0, ps(S19));
    expect(find(events, 'creatureStacked')).toEqual([
      { type: 'creatureStacked', seat: 0, cardId: G5, position: 2, viaLinkUp: true },
    ]);
    expect(find(events, 'linkUpConsumed')).toEqual([{ type: 'linkUpConsumed', seat: 0 }]);
    expect(state.board.linkUpPending).toEqual([false, false]);
  });

  it('becomes the Base without a creature of the caster on the field (RD-120, RD-144)', () => {
    // P2 (seat 0) in its opening response: the Base leaves p2Opening (RD-144).
    const s = withGraveyard(
      stateOf({
        hands: [[S19], []],
        stacks: [[], [B1]],
        phase: { kind: 'p2Opening', active: 0 },
        p1: 1,
      }),
      [G5],
    );
    const { state } = apply(s, 0, ps(S19));
    expect(state.board.zones.stacks[0]).toEqual([G5]);
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
  });

  it('is a placement of the seat on turn: the opponent armed trap triggers (RD-152)', () => {
    const s = withTraps(gambit([R4]), [[S16, 1]]);
    const { state, events } = apply(s, 0, ps(S19));
    expect(find(events, 'trapTriggered')).toMatchObject([
      { seat: 1, cardId: S16, targetSeat: 0, triggerCardId: R4, outcome: 'returned' },
    ]);
    expect(state.board.zones.stacks[0]).toEqual([R1, R2]);
    expect(state.board.zones.hands[0]).toEqual([R4]);
    expect(state.turnLocks).toEqual([{ seat: 0, cardId: R4 }]);
    expect(state.board.zones.graveyard).toEqual([S16, S19]);
    expect(state.board.armedTraps).toBeUndefined();
    expectConserved(state);
  });
});

describe('S-19 and replay locks of the nested caster (RD-145)', () => {
  it('a creature locked for the opponent earlier in the turn is not placed by its nested spell', () => {
    // 1. Seat 0's S-19 hands seat 1 an S-09: B2 returns to seat 1's hand, locked (RD-160).
    const S09 = spell(9);
    const S05 = spell(5);
    const s = gambit(
      [S09],
      [
        [R1, R2],
        [B1, B2],
      ],
      [S19, S19B],
      [G1],
    );
    //    RD-162: seat 1 still answers its single-candidate (G1) handCreature choice.
    const first = applyAnsweringSingle(s, 0, ps(S19), 1, twin);
    expect(first.state.board.zones.stacks[1]).toEqual([B1, G1]);
    expect(first.state.board.zones.hands[1]).toEqual([B2]);
    expect(first.state.turnLocks).toEqual([{ seat: 1, cardId: B2 }]);
    // 2. In the same turn seat 0's second S-19 hands seat 1 an S-05 (place a hand creature):
    //    B2 is its only creature and is locked, so nothing is placed.
    const second = apply(withGraveyard(first.state, [S05]), 0, ps(S19B), 1, twin);
    expect(second.state.pendingChoice).toBeUndefined();
    expect(second.state.board.zones.stacks[1]).toEqual([B1, G1]);
    expect(second.state.board.zones.hands[1]).toEqual([B2]);
    expect(find(second.events, 'creatureStacked')).toEqual([]);
    expectConserved(second.state);
  });
});

describe('S-19 spell: the opponent plays it (RD-112, RD-119)', () => {
  it('roles swap, the condition is ignored, and S-19 goes to the graveyard last', () => {
    // S-08 needs >= 4 enemy creatures; ignored: seat 1 topples seat 0's Leading creature.
    const S08 = spell(8);
    const { state, events } = apply(gambit([S08]), 0, ps(S19));
    expect(find(events, 'gambitDrawn')).toEqual([
      { type: 'gambitDrawn', seat: 0, cardId: S19, drawnCardId: S08, drawnKind: 'spell' },
    ]);
    expect(find(events, 'spellPlayed')).toEqual([
      { type: 'spellPlayed', seat: 0, cardId: S19, branch: 'primary' },
      { type: 'spellPlayed', seat: 1, cardId: S08, branch: 'primary', playedVia: S19 },
    ]);
    expect(find(events, 'spellResolved')).toEqual([
      { type: 'spellResolved', seat: 1, cardId: S08, destination: 'graveyard' },
      { type: 'spellResolved', seat: 0, cardId: S19, destination: 'graveyard' },
    ]);
    expect(state.board.zones.stacks).toEqual([[R1], [B1]]);
    expect(state.board.zones.graveyard).toEqual([R2, S08, S19]);
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
  });

  it('never runs the Secondary: a Primary with nothing to do does nothing (RD-119)', () => {
    // S-14 removes position 1 of the enemy stack; seat 0 has only a Base. No -30 nerf.
    const S14 = spell(14);
    const { state, events } = apply(gambit([S14], [[R1], [B1]]), 0, ps(S19));
    expect(find(events, 'effectAttached')).toEqual([]);
    expect(state.board.zones.stacks).toEqual([[R1], [B1]]);
    expect(state.board.attachedSpells).toEqual([]);
    expect(state.board.zones.graveyard).toEqual([S14, S19]);
  });

  it('best-effort S-02 with d <= 0: no graveyard draw, the opponent (seat 0) draws 1 (RD-161)', () => {
    // Seat 1 is S-02's caster: d = seat 0's hand (0) - seat 1's hand (2) = -2.
    const S02 = spell(2);
    const s = gambit([S02], [[R1], [B1]], [S19], [G1, G5]);
    const { state, events } = apply(s, 0, ps(S19));
    // Narration (playtest report): the caster of S-02 is seat 1, played via seat 0's S-19.
    expect(find(events, 'spellPlayed')).toEqual([
      { type: 'spellPlayed', seat: 0, cardId: S19, branch: 'primary' },
      { type: 'spellPlayed', seat: 1, cardId: S02, branch: 'primary', playedVia: S19 },
    ]);
    expect(find(events, 'spellDrawResolved')).toEqual([
      { type: 'spellDrawResolved', seat: 0, from: 'deck', requested: 1, drawn: 1 },
    ]);
    expect(state.board.zones.hands[0]).toHaveLength(1);
    expect(state.board.zones.hands[1]).toEqual([G1, G5]);
  });

  it('best-effort S-07 without a Leading creature: no replacement; the turn goes on (RD-172)', () => {
    const S07 = spell(7);
    const s = gambit([S07], [[R1], []], [S19], [B3]);
    const { state, events } = apply(s, 0, ps(S19));
    expect(state.pendingChoice).toBeUndefined();
    expect(state.board.zones.hands[1]).toEqual([B3]);
    expect(types(events)).not.toContain('turnEnded');
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
  });
});

describe('S-19 spell with a choice (RD-160)', () => {
  it('the nested spell caster chooses; the returned creature is locked for the seat on turn', () => {
    // S-11: seat 1 returns an enemy (seat 0) level 1-3 creature; two candidates -> a choice.
    const S11 = spell(11);
    const played = apply(gambit([S11]), 0, ps(S19));
    const pending = played.state.pendingChoice;
    expect(pending).toMatchObject({ seat: 1, spellId: 'S-11', cardId: S11, kind: 'enemyCreature' });
    expect(pending?.options).toEqual([R1, R2]);
    expect(activeSeat(played.state)).toBe(1);
    expect(played.state.phase).toEqual({ kind: 'turn', active: 0 });
    expect(find(played.events, 'spellChoiceRequested')).toMatchObject([{ seat: 1, cardId: S11 }]);
    // Both S-11 and S-19 are in resolution (no zone) and still counted.
    expect(roundCardIds(played.state)).toEqual(expect.arrayContaining([S11, S19]));
    expectConserved(played.state);
    expect(played.state.board.zones.graveyard).toEqual([]);
    expect(pendingChoiceView(played.state, 1)).toMatchObject({ options: [R1, R2] });
    expectReject(played.state, 0, END, 'CHOICE_PENDING');
    expectReject(played.state, 0, choose(pending?.choiceId ?? 0, [R1]), 'NOT_YOUR_TURN');

    const { state, events } = apply(played.state, 1, choose(pending?.choiceId ?? 0, [R1]));
    expect(state.board.zones.stacks[0]).toEqual([R2]);
    expect(state.board.zones.hands[0]).toEqual([R1]);
    expect(types(events)[0]).toBe('spellChoiceMade');
    expect(find(events, 'spellChoiceMade')).toMatchObject([{ seat: 1, selection: [R1] }]);
    expect(types(events).slice(-3)).toEqual(['replayLocked', 'spellResolved', 'spellResolved']);
    expect(find(events, 'spellResolved')).toEqual([
      { type: 'spellResolved', seat: 1, cardId: S11, destination: 'graveyard' },
      { type: 'spellResolved', seat: 0, cardId: S19, destination: 'graveyard' },
    ]);
    // RD-172: the turn in progress (seat 0's) goes on; R1 is locked for its owner, seat 0, even
    // though the kernel caster was seat 1.
    expect(find(events, 'turnEnded')).toEqual([]);
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
    expect(state.turnLocks).toEqual([{ seat: 0, cardId: R1 }]);
    expectReject(state, 0, play(R1), 'CARD_REPLAY_LOCKED');
    expect(legalCommands(ctx, state, 0)).not.toContainEqual(play(R1));
    expect(state.board.zones.graveyard).toEqual([S11, S19]);
    // The lock clears with seat 0's End Turn (20 vs 10: the turn passes).
    const ended = apply(state, 0, END).state;
    expect(ended.phase).toEqual({ kind: 'turn', active: 1 });
    expect(ended.turnLocks).toBeUndefined();
  });

  it('S-04 drawn through S-19: whatever the field count; both seats locked, turn goes on', () => {
    const S04 = spell(4);
    const { state, events } = apply(
      gambit(
        [S04],
        [
          [R1, R2],
          [B1, B2],
        ],
      ),
      0,
      ps(S19),
    );
    expect(state.board.zones.stacks).toEqual([[], []]);
    expect(state.board.zones.hands[0]).toEqual(expect.arrayContaining([R1, R2]));
    expect(state.board.zones.hands[1]).toEqual(expect.arrayContaining([B1, B2]));
    expect(find(events, 'turnEnded')).toEqual([]);
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
    // RD-172: the S-04 caster is seat 1 (its stack first); every creature locked for its owner.
    expect(state.turnLocks).toEqual([
      { seat: 1, cardId: B1 },
      { seat: 1, cardId: B2 },
      { seat: 0, cardId: R1 },
      { seat: 0, cardId: R2 },
    ]);
    expectReject(state, 0, play(R1), 'CARD_REPLAY_LOCKED');
    expect(legalCommands(ctx, state, 0).some((c) => c.type === 'playCreature')).toBe(false);
    // 0 = 0 after the field is emptied: End Turn is an equal hand-over (RD-169); locks clear.
    const ended = apply(state, 0, END).state;
    expect(ended.phase).toEqual({ kind: 'turn', active: 1, equalEndBy: 0 });
    expect(ended.turnLocks).toBeUndefined();
  });
});

describe('S-19 trap window (RD-112, RD-157, RD-159)', () => {
  it('S-16 arms dormant on the opponent side: no trigger and no lapse in the current turn', () => {
    const played = apply(gambit([S16], [[R1, R2], [B1]], [S19, R3, R4], [B2, B3]), 0, ps(S19));
    expect(find(played.events, 'trapArmed')).toEqual([
      { type: 'trapArmed', seat: 1, cardId: S16, spellId: 'S-16', dormant: true },
    ]);
    expect(find(played.events, 'spellResolved')).toEqual([
      { type: 'spellResolved', seat: 1, cardId: S16, destination: 'armed' },
      { type: 'spellResolved', seat: 0, cardId: S19, destination: 'graveyard' },
    ]);
    expect(played.state.board.armedTraps).toEqual([
      { cardId: S16, seat: 1, spellId: 'S-16', dormant: true },
    ]);
    // The caster's own placement in the current turn does not trigger it.
    const placed = apply(played.state, 0, play(R3));
    expect(find(placed.events, 'trapTriggered')).toEqual([]);
    expect(placed.state.board.zones.stacks[0]).toEqual([R1, R2, R3]);
    // The end of the current turn opens its window instead of lapsing it.
    const ended = apply(placed.state, 0, END);
    expect(types(ended.events)).toEqual(['trapWindowOpened', 'turnEnded', 'turnStarted']);
    expect(ended.state.board.armedTraps).toEqual([{ cardId: S16, seat: 1, spellId: 'S-16' }]);
    // Seat 1's own turn: its placements never trigger its trap; its End Turn lapses nothing.
    const own = apply(ended.state, 1, play(B2));
    expect(find(own.events, 'trapTriggered')).toEqual([]);
    // Seat 1 equalizes (60 vs 60), so its End Turn passes the turn (RD-169).
    const back = apply(apply(own.state, 1, play(B3)).state, 1, END);
    expect(types(back.events)).toEqual(['turnEnded', 'turnStarted']);
    // The S-19 caster's NEXT turn is the window: R4 (level 4) triggers it.
    const hit = apply(back.state, 0, play(R4));
    expect(find(hit.events, 'trapTriggered')).toMatchObject([
      { seat: 1, cardId: S16, triggerCardId: R4, outcome: 'returned' },
    ]);
    expect(hit.state.board.armedTraps).toBeUndefined();
  });

  it('S-12 dormant: untriggered, it lapses at the end of the caster NEXT turn (RD-129)', () => {
    // 10 vs 10; seat 1 plays B2 in its turn so that both End Turns pass the turn (RD-169).
    const played = apply(gambit([S12], [[R1], [B1]], [S19], [B2]), 0, ps(S19));
    expect(played.state.board.armedTraps).toEqual([
      { cardId: S12, seat: 1, spellId: 'S-12', dormant: true },
    ]);
    const first = apply(played.state, 0, END);
    expect(find(first.events, 'trapLapsed')).toEqual([]);
    const second = apply(apply(first.state, 1, play(B2)).state, 1, END);
    expect(find(second.events, 'trapLapsed')).toEqual([]);
    const third = apply(second.state, 0, END);
    expect(types(third.events).slice(0, 3)).toEqual([
      'trapLapsed',
      'cardsDrawn',
      'spellDrawResolved',
    ]);
    expect(find(third.events, 'trapLapsed')).toEqual([
      { type: 'trapLapsed', seat: 1, cardId: S12, spellId: 'S-12' },
    ]);
    expect(third.state.board.armedTraps).toBeUndefined();
  });

  it('a round end in the current turn lapses the dormant trap before the decision (RD-156)', () => {
    // Seat 0 (behind) plays S-19, draws S-16, then ends its turn while behind (RD-169).
    const s = withGraveyard(
      stateOf({
        hands: [[S19], []],
        stacks: [
          [R1, R2],
          [B1, B2, B3],
        ],
        phase: { kind: 'turn', active: 0 },
        playedThisTurn: false,
      }),
      [S16],
    );
    const played = apply(s, 0, ps(S19));
    const { state, events } = apply(played.state, 0, END);
    expect(types(events)).toEqual([
      'trapWindowOpened',
      'trapLapsed',
      'effectAttached',
      'turnEnded',
      'roundOver',
    ]);
    // The S-16 lapse nerf (-30) hits seat 0's Leading creature (R2, 20 -> 0): 10 vs 60. The
    // roundOver snapshot is taken after the lapse.
    expect(find(events, 'roundOver')).toEqual([
      { type: 'roundOver', reason: 'opponentAhead', seat: 0, atk: [10, 60] },
    ]);
    expect(find(events, 'trapLapsed')).toEqual([
      { type: 'trapLapsed', seat: 1, cardId: S16, spellId: 'S-16', attachedTo: R2 },
    ]);
    expect(state.board.armedTraps).toBeUndefined();
    expect(state.phase.kind).toBe('roundOver');
  });
});

describe('S-19 drawn by S-19 (nested frames)', () => {
  const seedDrawingTwin = (s: RoundState): number => seedDrawing(s, S19, S19B);

  it('a choice suspended two frames deep is answered by the nested caster', () => {
    // Seat 0's S-19 draws S-19B; seat 1 plays it and draws S-11; seat 0 plays S-11 (roles swap
    // twice) and chooses among seat 1's level 1-3 creatures.
    const S11 = spell(11);
    const s = gambit(
      [S19B, S11],
      [
        [R1, R2],
        [B1, B2],
      ],
    );
    const seed = seedDrawingTwin(s);
    const played = apply(s, 0, ps(S19), seed, twin);
    const pending = played.state.pendingChoice;
    expect(pending).toMatchObject({ seat: 0, cardId: S11, kind: 'enemyCreature' });
    expect(pending?.options).toEqual([B1, B2]);
    const via = (pending?.continuation.scratch as { via?: unknown[] }).via;
    expect(via).toEqual([
      { cardId: S19, caster: 0 },
      { cardId: S19B, caster: 1 },
    ]);
    expect(activeSeat(played.state)).toBe(0);
    // All three spells are in resolution; every card exactly once.
    expect(played.state.board.zones.graveyard).toEqual([]);
    expectConserved(played.state);
    const choiceId = pending?.choiceId ?? 0;
    const wrongSeat = applyCommand(twin, played.state, 1, choose(choiceId, [B2]), rng());
    expect(wrongSeat).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });

    const { state, events } = apply(played.state, 0, choose(choiceId, [B2]), 1, twin);
    expect(state.board.zones.stacks[1]).toEqual([B1]);
    expect(state.board.zones.hands[1]).toEqual([B2]);
    expect(
      find(events, 'spellResolved').map((e) => e.type === 'spellResolved' && e.cardId),
    ).toEqual([S11, S19B, S19]);
    // RD-172: S-11 does not end the turn in progress (seat 0's); B2 is locked for seat 1.
    expect(find(events, 'turnEnded')).toEqual([]);
    expect(state.turnLocks).toEqual([{ seat: 1, cardId: B2 }]);
    expect(state.pendingChoice).toBeUndefined();
    expect(activeSeat(state)).toBe(0);
    expectConserved(state);
  });

  it('the opponent S-19 draws a creature: it goes onto the opponent stack', () => {
    const s = gambit([S19B, B3]);
    const seed = seedDrawingTwin(s);
    const { state, events } = apply(s, 0, ps(S19), seed, twin);
    expect(find(events, 'spellPlayed')).toEqual([
      { type: 'spellPlayed', seat: 0, cardId: S19, branch: 'primary' },
      { type: 'spellPlayed', seat: 1, cardId: S19B, branch: 'primary', playedVia: S19 },
    ]);
    expect(state.board.zones.stacks).toEqual([
      [R1, R2],
      [B1, B3],
    ]);
    expect(state.board.zones.graveyard).toEqual([S19B, S19]);
  });

  it('the opponent S-19 draws a spell: the original caster plays it; frames close inside out', () => {
    const S08 = spell(8);
    const s = gambit([S19B, S08]);
    const seed = seedDrawingTwin(s);
    const { state, events } = apply(s, 0, ps(S19), seed, twin);
    expect(find(events, 'spellPlayed')).toEqual([
      { type: 'spellPlayed', seat: 0, cardId: S19, branch: 'primary' },
      { type: 'spellPlayed', seat: 1, cardId: S19B, branch: 'primary', playedVia: S19 },
      { type: 'spellPlayed', seat: 0, cardId: S08, branch: 'primary', playedVia: S19B },
    ]);
    // Seat 0 is S-08's caster again: seat 1's Leading creature (its Base) goes.
    expect(state.board.zones.stacks).toEqual([[R1, R2], []]);
    expect(
      find(events, 'spellResolved').map((e) => e.type === 'spellResolved' && e.cardId),
    ).toEqual([S08, S19B, S19]);
    expect(state.board.zones.graveyard).toEqual([B1, S08, S19B, S19]);
  });

  it('a trap armed by the S-19 caster itself (twice nested) is not dormant (RD-159)', () => {
    const s = gambit([S19B, S16]);
    const seed = seedDrawingTwin(s);
    const { state } = apply(s, 0, ps(S19), seed, twin);
    // Armed on seat 0's side, the seat on turn: its window is seat 1's next turn as usual.
    expect(state.board.armedTraps).toEqual([{ cardId: S16, seat: 0, spellId: 'S-16' }]);
  });
});
