import { describe, expect, it } from 'vitest';
import {
  activeSeat,
  applyCommand,
  autoSelection,
  createRoundContext,
  enumerateSelections,
  isValidSelection,
  legalCommands,
  pendingChoiceView,
  type CardId,
  type RoundCommand,
  type RoundEvent,
  type RoundState,
} from '../../src/cartignon/index.js';
import {
  END,
  MULLIGAN,
  apply,
  catalogWithModifiers,
  cr,
  ctx,
  expectReject,
  ps,
  resolveDirect,
  rng,
  spell,
  stateOf,
  types,
} from './spell-kit.js';
import { deepFreeze } from './test-fixtures.js';

// R4c-2: pending choices (ADR-0007 section 4) and the spells S-01, S-10, S-11.
// Placeholder creatures have atk = level * 10.

const choose = (choiceId: number, selection: readonly CardId[]): RoundCommand => ({
  type: 'chooseSpellOption',
  choiceId,
  selection,
});

const attachedSpellTargets = (s: RoundState) =>
  s.board.attachedSpells.map((a) => [a.cardId, a.targetCardId]);

const Y1 = cr('yellow', 1);
const Y2 = cr('yellow', 2);
const Y3 = cr('yellow', 3);
const OWN3 = [cr('red', 1), cr('red', 2), cr('red', 3)];

/** S-01 feasible (own level 3 on the field); deck top first. */
function foresight(deck: CardId[], hand: CardId[] = [spell(1), cr('red', 5)]): RoundState {
  return stateOf({ hands: [hand, [cr('violet', 1)]], stacks: [OWN3, [cr('blue', 1)]], deck });
}

describe('S-01 Foresight (RD-114, RD-116)', () => {
  it('deck >= 2: looks at 2 (not the hand), hidden keepDrawn choice; keep 1, other to deck', () => {
    const s = foresight([Y1, Y2, Y3]);
    const played = apply(s, 0, ps(spell(1)));
    expect(types(played.events)).toEqual(['spellPlayed', 'cardsLookedAt', 'spellChoiceRequested']);
    expect(played.events[0]).toMatchObject({ branch: 'primary' });
    expect(played.events.at(-1)).toEqual({
      type: 'spellChoiceRequested',
      seat: 0,
      spellId: 'S-01',
      cardId: spell(1),
      kind: 'keepDrawn',
      optionCount: 2,
    });
    const mid = played.state;
    expect(mid.pendingChoice).toMatchObject({
      choiceId: 1,
      seat: 0,
      spellId: 'S-01',
      cardId: spell(1),
      kind: 'keepDrawn',
      options: [Y1, Y2],
      min: 1,
      max: 1,
    });
    // Looked-at cards are in no zone: not in the hand (RD-116 counts), not in the deck.
    expect(mid.board.zones.hands[0]).toEqual([cr('red', 5)]);
    expect(mid.board.zones.deck).toEqual([Y3]);
    expect(mid.board.lookingAt).toEqual({ seat: 0, cardIds: [Y1, Y2] });
    expect(mid.phase).toEqual(s.phase);
    expect(mid.playedThisTurn).toBe(true);

    const done = apply(mid, 0, choose(1, [Y2]));
    expect(types(done.events)).toEqual(['spellChoiceMade', 'lookedAtSettled', 'spellResolved']);
    expect(done.events[1]).toEqual({
      type: 'lookedAtSettled',
      seat: 0,
      kept: [Y2],
      returned: [Y1],
      deckShuffled: true,
    });
    const z = done.state.board.zones;
    expect(z.hands[0]).toEqual([cr('red', 5), Y2]);
    expect([...z.deck].sort()).toEqual([Y1, Y3].sort());
    expect(z.graveyard).toContain(spell(1));
    expect(done.state.pendingChoice).toBeUndefined();
    expect(done.state.board.lookingAt).toBeUndefined();
    // The turn resumes: same phase; End Turn is available.
    expect(done.state.phase).toEqual(s.phase);
    expect(legalCommands(ctx, done.state, 0)).toContainEqual(END);
  });

  it('deck = 1: that card is kept automatically (no pending choice, no shuffle)', () => {
    const { state, events } = apply(foresight([Y1]), 0, ps(spell(1)));
    expect(types(events)).toEqual([
      'spellPlayed',
      'cardsLookedAt',
      'lookedAtSettled',
      'spellResolved',
    ]);
    expect(events[2]).toMatchObject({ kept: [Y1], returned: [], deckShuffled: false });
    expect(state.pendingChoice).toBeUndefined();
    expect(state.board.zones.hands[0]).toEqual([cr('red', 5), Y1]);
    expect(state.board.zones.deck).toEqual([]);
  });

  it('deck empty: no effect, so not playable (RD-175); the resolution itself does nothing', () => {
    expectReject(foresight([]), 0, ps(spell(1)), 'SPELL_NO_EFFECT');
    // Resolved directly (as through S-19, RD-161): the Primary runs and does nothing.
    const { board, events, suspended } = resolveDirect(foresight([]), 0, spell(1));
    expect(types(events)).toEqual(['spellPlayed', 'cardsLookedAt', 'spellResolved']);
    expect(events[0]).toMatchObject({ branch: 'primary' });
    expect(events[1]).toEqual({ type: 'cardsLookedAt', seat: 0, cardIds: [] });
    expect(suspended).toBeUndefined();
    expect(board.lookingAt).toBeUndefined();
  });

  it("an opponent's level 3 also counts; no level 3 -> Secondary: nerf -30", () => {
    const opp = stateOf({
      hands: [[spell(1)], []],
      stacks: [[cr('red', 1)], [cr('blue', 1), cr('blue', 2), cr('blue', 3)]],
      deck: [Y1, Y2],
    });
    expect(apply(opp, 0, ps(spell(1))).events[0]).toMatchObject({ branch: 'primary' });

    const none = stateOf({
      hands: [[spell(1)], []],
      stacks: [[cr('red', 1)], [cr('blue', 1), cr('blue', 2)]],
      deck: [Y1, Y2],
    });
    const { state, events } = apply(none, 0, ps(spell(1)));
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(events[1]).toMatchObject({
      type: 'effectAttached',
      effect: { amount: -30, targetCardId: cr('blue', 2) },
    });
    expect(attachedSpellTargets(state)).toEqual([[spell(1), cr('blue', 2)]]);
    expect(state.pendingChoice).toBeUndefined();
  });

  it('hidden information: looked-at ids appear only in the seat-filterable hidden events', () => {
    const played = apply(foresight([Y1, Y2, Y3]), 0, ps(spell(1)));
    const done = apply(played.state, 0, choose(1, [Y1]));
    const all: RoundEvent[] = [...played.events, ...done.events];
    const revealing = all.filter((e) => [Y1, Y2].some((c) => JSON.stringify(e).includes(c)));
    expect(types(revealing)).toEqual(['cardsLookedAt', 'spellChoiceMade', 'lookedAtSettled']);
    for (const e of revealing) expect(e).toMatchObject({ seat: 0 });
    expect(done.events[0]).toMatchObject({ type: 'spellChoiceMade', kind: 'keepDrawn' });
  });

  it('choice ids increase per round state (two S-01 in one turn)', () => {
    const s = foresight([Y1, Y2, Y3, cr('yellow', 4)], [spell(1), spell(10)]);
    // Reuse S-01 twice by putting the S-01 card back into the hand via a fresh state copy.
    const first = apply(s, 0, ps(spell(1)));
    const after = apply(first.state, 0, choose(1, [Y1])).state;
    const again = deepFreeze({
      ...after,
      board: {
        ...after.board,
        zones: {
          ...after.board.zones,
          graveyard: after.board.zones.graveyard.filter((c) => c !== spell(1)),
          hands: [[...after.board.zones.hands[0], spell(1)], after.board.zones.hands[1]] as const,
        },
      },
    });
    const second = apply(again, 0, ps(spell(1)));
    expect(second.state.pendingChoice?.choiceId).toBe(2);
    expect(second.state.nextChoiceId).toBe(3);
  });
});

describe('S-10 Kindred Link (RD-117, RD-108)', () => {
  const own = [cr('red', 1), cr('red', 2)];
  // green-2 at position 2 draws 1 from the deck there (activation edge after placement).
  const drawCtx = createRoundContext(
    catalogWithModifiers([['green', 2, ['buffSelf', 'drawDeck']]]),
  );

  it('several candidates: handCreature choice; placement activates the modifier', () => {
    const s = stateOf({
      hands: [[spell(10), cr('yellow', 2), cr('red', 5), cr('green', 2)], [cr('violet', 1)]],
      stacks: [own, [cr('blue', 1)]],
      deck: [Y1, Y3],
    });
    const played = apply(s, 0, ps(spell(10)), 1, drawCtx);
    expect(played.state.pendingChoice).toMatchObject({
      kind: 'handCreature',
      options: [cr('yellow', 2), cr('green', 2)],
      min: 1,
      max: 1,
    });
    expect(legalCommands(drawCtx, played.state, 0)).toEqual([
      choose(1, [cr('yellow', 2)]),
      choose(1, [cr('green', 2)]),
    ]);
    const { state, events } = apply(played.state, 0, choose(1, [cr('green', 2)]), 1, drawCtx);
    expect(types(events)).toEqual([
      'spellChoiceMade',
      'creatureStacked',
      'modifierLive',
      'cardsDrawn',
      'spellResolved',
    ]);
    expect(events[1]).toMatchObject({ cardId: cr('green', 2), position: 2, viaLinkUp: false });
    expect(events[3]).toMatchObject({ seat: 0, reason: 'modifierDeck', cardIds: [Y1] });
    expect(state.board.zones.stacks[0]).toEqual([...own, cr('green', 2)]);
    expect(state.board.zones.hands[0]).toEqual([cr('yellow', 2), cr('red', 5), Y1]);
    expect(state.phase).toEqual(s.phase);
  });

  it('single candidate: still a pending choice (RD-162); an armed Link Up is used up', () => {
    const s = stateOf({
      hands: [[spell(10), cr('green', 2), cr('red', 5)], []],
      stacks: [own, [cr('blue', 1)]],
      board: { linkUpPending: [true, false] },
    });
    // RD-162: a hidden-count choice is never auto-answered, so the opponent cannot tell one
    // eligible hand creature from several (no optionCount either, RD-142).
    const played = apply(s, 0, ps(spell(10)));
    expect(types(played.events)).toEqual(['spellPlayed', 'spellChoiceRequested']);
    // Same public event and opponent view as with two candidates (RD-142 test below).
    expect(played.events[1]).toEqual({
      type: 'spellChoiceRequested',
      seat: 0,
      spellId: 'S-10',
      cardId: spell(10),
      kind: 'handCreature',
    });
    expect(played.state.pendingChoice).toMatchObject({
      kind: 'handCreature',
      options: [cr('green', 2)],
    });
    expect(pendingChoiceView(played.state, 1)).toEqual({
      seat: 0,
      kind: 'handCreature',
      spellId: 'S-10',
      min: 1,
      max: 1,
    });
    expect(legalCommands(ctx, played.state, 0)).toEqual([choose(1, [cr('green', 2)])]);
    const { state, events } = apply(played.state, 0, choose(1, [cr('green', 2)]));
    expect(types(events)).toEqual([
      'spellChoiceMade',
      'creatureStacked',
      'linkUpConsumed',
      'spellResolved',
    ]);
    expect(events[1]).toMatchObject({ cardId: cr('green', 2), viaLinkUp: true });
    expect(state.board.linkUpPending).toEqual([false, false]);
    expect(state.pendingChoice).toBeUndefined();
  });

  it('no same-level hand creature, or no Leading creature -> Secondary: nerf -30', () => {
    for (const stacks of [
      [own, [cr('blue', 3)]],
      [[], [cr('blue', 3)]],
    ] as const) {
      const s = stateOf({
        hands: [[spell(10), cr('green', 3)], []],
        stacks: [[...stacks[0]], [...stacks[1]]],
        p1: 1,
      });
      const { state, events } = apply(s, 0, ps(spell(10)));
      expect(events[0]).toMatchObject({ branch: 'secondary' });
      expect(state.board.zones.stacks[0]).toEqual(stacks[0]);
      expect(attachedSpellTargets(state)).toEqual([[spell(10), cr('blue', 3)]]);
    }
  });
});

describe('S-11 Repel (RD-118, RD-105, RD-172)', () => {
  const opp = [cr('blue', 1), cr('blue', 2), cr('blue', 4)];

  it('choice among level 1-3 (Base allowed); Base removed -> position 1 is the new Base; locked', () => {
    const own = [...OWN3, cr('red', 4)];
    const s = stateOf({ hands: [[spell(11)], [cr('violet', 1)]], stacks: [own, opp] });
    const played = apply(s, 0, ps(spell(11)));
    expect(played.state.pendingChoice).toMatchObject({
      kind: 'enemyCreature',
      options: [cr('blue', 1), cr('blue', 2)],
    });
    expect(activeSeat(played.state)).toBe(0);
    const { state, events } = apply(played.state, 0, choose(1, [cr('blue', 1)]));
    expect(events[1]).toEqual({
      type: 'creatureRemoved',
      seat: 1,
      cardId: cr('blue', 1),
      position: 0,
      to: { zone: 'hand', seat: 1 },
    });
    expect(types(events).slice(-2)).toEqual(['replayLocked', 'spellResolved']);
    expect(state.board.zones.stacks[1]).toEqual([cr('blue', 2), cr('blue', 4)]);
    expect(state.board.zones.hands[1]).toEqual([cr('violet', 1), cr('blue', 1)]);
    // RD-172: the caster keeps the turn; the returned creature is locked for its owner.
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
    expect(state.turnNumber).toBe(s.turnNumber);
    expect(state.turnLocks).toEqual([{ seat: 1, cardId: cr('blue', 1) }]);
    const ended = apply(state, 0, END).state;
    expect(ended.phase).toMatchObject({ kind: 'turn', active: 1 });
    expect(ended.turnLocks).toBeUndefined();
  });

  it('single target: automatic; emptying the stack sets stackEmptiedBySpell (RD-105)', () => {
    const s = stateOf({ hands: [[spell(11)], []], stacks: [OWN3, [cr('blue', 2)]] });
    const { state, events } = apply(s, 0, ps(spell(11)));
    expect(types(events)).toEqual([
      'spellPlayed',
      'creatureRemoved',
      'replayLocked',
      'spellResolved',
    ]);
    expect(state.pendingChoice).toBeUndefined();
    expect(state.stackEmptiedBySpell).toBe(true);
    expect(state.phase).toEqual({ kind: 'turn', active: 0 });
  });

  it('no level 1-3 enemy creature -> Secondary: grave draw 1; the turn does not end', () => {
    const s = stateOf({
      hands: [[spell(11)], []],
      stacks: [OWN3, [cr('blue', 4), cr('blue', 5)]],
      deck: [Y1],
    });
    const { state, events } = apply(s, 0, ps(spell(11)));
    expect(events[0]).toMatchObject({ branch: 'secondary' });
    expect(events[1]).toMatchObject({ type: 'cardsDrawn', reason: 'spellGraveyard' });
    expect(state.phase).toEqual(s.phase);
  });
});

describe('pending-choice gating (R4c-2)', () => {
  const pending = (): RoundState =>
    apply(
      stateOf({
        hands: [[spell(10), cr('yellow', 2), cr('green', 2), cr('red', 3), spell(8)], [spell(2)]],
        stacks: [[cr('red', 1), cr('red', 2)], [cr('blue', 1)]],
      }),
      0,
      ps(spell(10)),
    ).state;

  it('every other command is rejected with CHOICE_PENDING, from either seat', () => {
    const s = pending();
    const others: RoundCommand[] = [
      { type: 'playCreature', cardId: cr('red', 3) },
      { type: 'nullify', cardId: cr('red', 3) },
      ps(spell(8)),
      MULLIGAN,
      END,
    ];
    for (const c of others) expectReject(s, 0, c, 'CHOICE_PENDING');
    expectReject(s, 1, ps(spell(2)), 'CHOICE_PENDING');
    expectReject(s, 1, END, 'CHOICE_PENDING');
  });

  it('wrong seat, stale id and invalid selections are rejected', () => {
    const s = pending();
    expectReject(s, 1, choose(1, [cr('yellow', 2)]), 'NOT_YOUR_TURN');
    expectReject(s, 0, choose(2, [cr('yellow', 2)]), 'CHOICE_ID_MISMATCH');
    expectReject(s, 0, choose(0, [cr('yellow', 2)]), 'CHOICE_ID_MISMATCH');
    for (const selection of [
      [],
      [cr('yellow', 2), cr('yellow', 2)],
      [cr('red', 3)],
      [cr('yellow', 2), cr('green', 2)],
      ['c99'],
    ]) {
      expectReject(s, 0, choose(1, selection), 'INVALID_CHOICE');
    }
  });

  it('chooseSpellOption without a pending choice -> NO_PENDING_CHOICE', () => {
    const s = stateOf({ hands: [[spell(10)], []], stacks: [[cr('red', 1)], [cr('blue', 1)]] });
    expectReject(s, 0, choose(1, [cr('red', 1)]), 'NO_PENDING_CHOICE');
  });

  it('legalCommands: one per option for the chooser, nothing for the other seat', () => {
    const s = pending();
    expect(legalCommands(ctx, s, 0)).toEqual([
      choose(1, [cr('yellow', 2)]),
      choose(1, [cr('green', 2)]),
    ]);
    expect(legalCommands(ctx, s, 1)).toEqual([]);
    expect(activeSeat(s)).toBe(0);
  });
});

describe('pendingChoiceView (RD-114)', () => {
  it('chooser sees the options; the other seat sees counts only; never the continuation', () => {
    const s = foresight([Y1, Y2, Y3]);
    expect(pendingChoiceView(s, 0)).toBeNull();
    const mid = apply(s, 0, ps(spell(1))).state;
    expect(pendingChoiceView(mid, 0)).toEqual({
      choiceId: 1,
      seat: 0,
      kind: 'keepDrawn',
      spellId: 'S-01',
      options: [Y1, Y2],
      min: 1,
      max: 1,
    });
    const other = pendingChoiceView(mid, 1);
    expect(other).toEqual({
      seat: 0,
      kind: 'keepDrawn',
      spellId: 'S-01',
      optionCount: 2,
      min: 1,
      max: 1,
    });
    expect(JSON.stringify(other)).not.toMatch(new RegExp(`${Y1}|${Y2}|continuation`));
  });

  it('RD-142: handCreature hides the count from the other seat (view and event)', () => {
    const s = stateOf({
      hands: [[spell(10), cr('yellow', 2), cr('green', 2)], [cr('violet', 1)]],
      stacks: [[cr('red', 1), cr('red', 2)], [cr('blue', 1)]],
    });
    const { state, events } = apply(s, 0, ps(spell(10)));
    const requested = events.at(-1);
    expect(requested).toEqual({
      type: 'spellChoiceRequested',
      seat: 0,
      spellId: 'S-10',
      cardId: spell(10),
      kind: 'handCreature',
    });
    expect(requested).not.toHaveProperty('optionCount');
    expect(pendingChoiceView(state, 1)).toEqual({
      seat: 0,
      kind: 'handCreature',
      spellId: 'S-10',
      min: 1,
      max: 1,
    });
    expect(pendingChoiceView(state, 1)).not.toHaveProperty('optionCount');
    expect(pendingChoiceView(state, 0)).toMatchObject({
      options: [cr('yellow', 2), cr('green', 2)],
    });
  });

  it('RD-142: other kinds keep the public count (enemyCreature)', () => {
    const s = stateOf({
      hands: [[spell(11)], []],
      stacks: [OWN3, [cr('blue', 1), cr('blue', 2)]],
    });
    const { state, events } = apply(s, 0, ps(spell(11)));
    expect(events.at(-1)).toMatchObject({ kind: 'enemyCreature', optionCount: 2 });
    expect(pendingChoiceView(state, 1)).toMatchObject({ kind: 'enemyCreature', optionCount: 2 });
  });
});

describe('serialisation and determinism', () => {
  it('a JSON round-trip mid-choice resumes to an identical result', () => {
    const mid = apply(foresight([Y1, Y2, Y3, cr('yellow', 4)]), 0, ps(spell(1))).state;
    const copy = deepFreeze(JSON.parse(JSON.stringify(mid)) as RoundState);
    expect(copy).toEqual(mid);
    const a = applyCommand(ctx, mid, 0, choose(1, [Y2]), rng(5));
    const b = applyCommand(ctx, copy, 0, choose(1, [Y2]), rng(5));
    expect(b).toEqual(a);
  });

  it('same seed -> same result; the shuffle uses the round RNG', () => {
    const run = (seed: number) => {
      const s = foresight([Y1, Y2, Y3, cr('yellow', 4), cr('yellow', 5)]);
      const mid = applyCommand(ctx, s, 0, ps(spell(1)), rng(seed));
      if (!mid.ok) throw new Error(mid.code);
      return applyCommand(ctx, mid.state, 0, choose(1, [Y1]), rng(seed));
    };
    expect(run(3)).toEqual(run(3));
    const decks = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) => {
        const r = run(seed);
        return r.ok ? r.state.board.zones.deck.join() : '';
      }),
    );
    expect(decks.size).toBeGreaterThan(1);
  });
});

describe('choice helpers', () => {
  const req = (n: number, min: number, max: number) => ({
    kind: 'handCreature' as const,
    options: ['a', 'b', 'c'].slice(0, n),
    min,
    max,
    step: 's',
    scratch: null,
  });

  it('autoSelection: only a single legal answer is automatic', () => {
    expect(autoSelection(req(1, 1, 1))).toEqual(['a']);
    expect(autoSelection(req(2, 2, 2))).toEqual(['a', 'b']);
    expect(autoSelection(req(1, 1, 3))).toEqual(['a']);
    expect(autoSelection(req(0, 0, 1))).toEqual([]);
    expect(autoSelection(req(2, 0, 0))).toEqual([]);
    expect(autoSelection(req(2, 1, 1))).toBeNull();
    expect(autoSelection(req(2, 0, 1))).toBeNull();
  });

  it('enumerateSelections / isValidSelection agree', () => {
    const c = { options: ['a', 'b', 'c'], min: 1, max: 2 };
    const all = enumerateSelections(c);
    expect(all).toEqual([['a'], ['b'], ['c'], ['a', 'b'], ['a', 'c'], ['b', 'c']]);
    for (const sel of all) expect(isValidSelection(c, sel)).toBe(true);
    expect(isValidSelection(c, [])).toBe(false);
    expect(isValidSelection(c, ['a', 'a'])).toBe(false);
    expect(isValidSelection(c, ['a', 'b', 'c'])).toBe(false);
    expect(isValidSelection(c, ['d'])).toBe(false);
  });
});

describe('review follow-ups: edges and serialisation across the suspend boundary', () => {
  /** Applies `command` to `state` and to its JSON copy; both results must be identical. */
  function resumeBoth(state: RoundState, command: RoundCommand, context = ctx) {
    const copy = deepFreeze(JSON.parse(JSON.stringify(state)) as RoundState);
    expect(copy).toEqual(state);
    const a = applyCommand(context, state, 0, command, rng(9));
    const b = applyCommand(context, copy, 0, command, rng(9));
    expect(b).toEqual(a);
    if (!a.ok) throw new Error(a.code);
    return a;
  }

  it('S-10 with an armed Link Up and 2 candidates: JSON round-trip, Link Up used, edge fires', () => {
    const drawCtx = createRoundContext(
      catalogWithModifiers([['green', 2, ['buffSelf', 'drawDeck']]]),
    );
    const s = stateOf({
      hands: [[spell(10), cr('yellow', 2), cr('green', 2)], []],
      stacks: [[cr('red', 1), cr('red', 2)], [cr('blue', 1)]],
      deck: [Y1, Y3],
      board: { linkUpPending: [true, false] },
    });
    const mid = apply(s, 0, ps(spell(10)), 1, drawCtx).state;
    expect(mid.pendingChoice?.kind).toBe('handCreature');
    expect(mid.board.linkUpPending).toEqual([true, false]);
    const r = resumeBoth(mid, choose(1, [cr('green', 2)]), drawCtx);
    expect(types(r.events)).toEqual([
      'spellChoiceMade',
      'creatureStacked',
      'linkUpConsumed',
      'modifierLive',
      'cardsDrawn',
      'spellResolved',
    ]);
    expect(r.events[1]).toMatchObject({ cardId: cr('green', 2), viaLinkUp: true });
    expect(r.events[3]).toMatchObject({ seat: 0, cardId: cr('green', 2), kind: 'drawDeck' });
    expect(r.events[4]).toMatchObject({ seat: 0, reason: 'modifierDeck', cardIds: [Y1] });
    expect(r.state.board.linkUpPending).toEqual([false, false]);
  });

  it('S-11 removing the Leading creature: silenced/live edge; the new Leader draws for its seat', () => {
    const edgeCtx = createRoundContext(
      catalogWithModifiers([
        ['blue', 2, ['drawDeck']],
        ['blue', 3, ['buffSelf', 'buffSelf']],
      ]),
    );
    const s = stateOf({
      hands: [[spell(11)], [cr('violet', 1)]],
      stacks: [OWN3, [cr('blue', 1), cr('blue', 2), cr('blue', 3)]],
      deck: [Y1, Y2],
    });
    const mid = apply(s, 0, ps(spell(11)), 1, edgeCtx).state;
    expect(mid.pendingChoice?.options).toEqual([cr('blue', 1), cr('blue', 2), cr('blue', 3)]);
    const r = resumeBoth(mid, choose(1, [cr('blue', 3)]), edgeCtx);
    expect(types(r.events)).toEqual([
      'spellChoiceMade',
      'creatureRemoved',
      'modifierSilenced',
      'modifierLive',
      'cardsDrawn',
      'replayLocked',
      'spellResolved',
    ]);
    expect(r.events[2]).toMatchObject({ seat: 1, cardId: cr('blue', 3), position: 2 });
    expect(r.events[3]).toMatchObject({ seat: 1, cardId: cr('blue', 2), kind: 'drawDeck' });
    expect(r.events[4]).toMatchObject({ seat: 1, reason: 'modifierDeck', cardIds: [Y1] });
    expect(r.state.board.zones.hands[1]).toEqual([cr('violet', 1), cr('blue', 3), Y1]);
  });

  it('S-11 removing the creature that armed a Link Up: the Link Up lapses (RD-139)', () => {
    const base = stateOf({
      hands: [[spell(11)], []],
      stacks: [OWN3, [cr('blue', 1), cr('blue', 2), cr('orange', 3)]],
    });
    const s = deepFreeze({
      ...base,
      board: {
        ...base.board,
        linkUpPending: [false, true] as const,
        linkUpSource: [null, cr('orange', 3)] as const,
      },
    });
    const mid = apply(s, 0, ps(spell(11))).state;
    const r = resumeBoth(mid, choose(1, [cr('orange', 3)]));
    expect(r.events).toContainEqual({
      type: 'linkUpLapsed',
      seat: 1,
      sourceCardId: cr('orange', 3),
    });
    expect(r.state.board.linkUpPending).toEqual([false, false]);
    expect(r.state.board.linkUpSource).toEqual([null, null]);
  });

  it('S-11 mid-choice JSON round-trip keeps the outcome (caster on turn, lock, RD-172)', () => {
    const s = stateOf({
      hands: [[spell(11)], []],
      stacks: [OWN3, [cr('blue', 1), cr('blue', 2)]],
    });
    const mid = apply(s, 0, ps(spell(11))).state;
    const r = resumeBoth(mid, choose(1, [cr('blue', 2)]));
    expect(r.state.phase).toEqual({ kind: 'turn', active: 0 });
    expect(r.state.turnLocks).toEqual([{ seat: 1, cardId: cr('blue', 2) }]);
  });

  it('RD-172: a stored pre-RD-172 continuation with endTurnRequested is tolerated and ignored', () => {
    const s = stateOf({
      hands: [[spell(11)], []],
      stacks: [OWN3, [cr('blue', 1), cr('blue', 2)]],
    });
    const mid = apply(s, 0, ps(spell(11))).state;
    expect(mid.pendingChoice).toBeDefined();
    const raw = JSON.parse(JSON.stringify(mid)) as {
      pendingChoice: { continuation: { scratch: Record<string, unknown> } };
    };
    raw.pendingChoice.continuation.scratch['endTurnRequested'] = true;
    const legacy = deepFreeze(raw as unknown as RoundState);
    const r = applyCommand(ctx, legacy, 0, choose(1, [cr('blue', 2)]), rng(9));
    if (!r.ok) throw new Error(r.code);
    expect(types(r.events)).not.toContain('turnEnded');
    expect(r.state.phase).toEqual({ kind: 'turn', active: 0 });
  });
});
