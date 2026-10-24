import {
  cartignonPrivateViewSchema,
  cartignonPublicViewSchema,
  cartignonSeatEventsSchema,
} from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildCardTables,
  createTokenSupply,
  projectCartignonEvents,
  projectCartignonPrivate,
  projectCartignonPublic,
  type CartignonMatchState,
  type RoundState,
} from '../../src/cartignon/index.js';
import { STACKS, apply, catalog, cr, ctx, ps, spell, stateOf } from './spell-kit.js';
import { deepFreeze } from './test-fixtures.js';

// RD-170 (public graveyard), spell hints (private view) and the narration data of S-02 events.

const tables = buildCardTables(catalog);

function matchOf(round: RoundState, over = false): CartignonMatchState {
  return deepFreeze({
    round,
    roundNumber: 2,
    tokens: createTokenSupply(),
    finalRound: false,
    replays: 0,
    poolAfterCleanup: 54,
    roundsWithoutProgress: 0,
    lastOutcome: null,
    status: over
      ? { kind: 'matchOver', reason: 'noProgress', winner: null, tokenCounts: [0, 0] }
      : { kind: 'playing' },
  });
}

describe('RD-170: the graveyard is public and ordered', () => {
  it('lists the graveyard oldest first, identical for both seats; the deck stays a count', () => {
    const s = stateOf({ hands: [[spell(8)], []], stacks: STACKS, deck: [cr('yellow', 1)] });
    const before = s.board.zones.graveyard;
    const after = apply(s, 0, ps(spell(8))).state; // S-08: the spell (and its target) to the grave
    const view = projectCartignonPublic(ctx, tables, matchOf(after));
    expect(view.graveyard).toEqual(after.board.zones.graveyard);
    expect(view.graveyard.slice(0, before.length)).toEqual(before);
    expect(view.graveyard.at(-1)).toBe(spell(8));
    expect(view.graveyardCount).toBe(view.graveyard.length);
    expect(view.deckCount).toBe(after.board.zones.deck.length);
    expect(JSON.stringify(view)).not.toContain('"deck"');
    expect(cartignonPublicViewSchema.safeParse(view).success).toBe(true);
  });
});

describe('spell hints (private view)', () => {
  it('primary / secondary from the engine condition; castable only on turn', () => {
    // S-02: d = opponent hand - own hand without the spell. Seat 0: 2 - 1 = 1 -> primary.
    const s = stateOf({
      hands: [
        [spell(2), cr('red', 5)],
        [cr('violet', 1), cr('violet', 2), spell(3)],
      ],
      stacks: STACKS,
      graveyard: [cr('green', 1)], // RD-175: S-02's Primary gains something
    });
    const own = projectCartignonPrivate(ctx, matchOf(s), 0);
    expect(own.spellHints).toEqual([
      { cardId: spell(2), branch: 'primary', castable: true, reason: null },
    ]);
    expect(cartignonPrivateViewSchema.safeParse(own).success).toBe(true);
    // Seat 1 is not on turn: the branch is still reported, with the rejection code.
    const other = projectCartignonPrivate(ctx, matchOf(s), 1);
    expect(other.spellHints).toEqual([
      expect.objectContaining({ cardId: spell(3), castable: false, reason: 'NOT_YOUR_TURN' }),
    ]);
    // Equal hands -> d = 0 -> the Secondary fires.
    const even = stateOf({ hands: [[spell(2), cr('red', 5)], [cr('violet', 1)]], stacks: STACKS });
    expect(projectCartignonPrivate(ctx, matchOf(even), 0).spellHints).toEqual([
      { cardId: spell(2), branch: 'secondary', castable: true, reason: null },
    ]);
  });

  it('matches what the resolution actually fires', () => {
    for (const opp of [[], [cr('violet', 1)], [cr('violet', 1), cr('violet', 2)]]) {
      const s = stateOf({
        hands: [[spell(2), cr('red', 5)], opp],
        stacks: STACKS,
        graveyard: [cr('green', 1)],
      });
      const hint = projectCartignonPrivate(ctx, matchOf(s), 0).spellHints[0];
      const played = apply(s, 0, ps(spell(2))).events[0];
      expect(played).toMatchObject({ type: 'spellPlayed', branch: hint?.branch });
    }
  });

  it('not castable in the P1 Base step, during a pending choice, or after the match', () => {
    const base: RoundState = deepFreeze({
      ...stateOf({ hands: [[spell(2), cr('red', 1)], []], phase: { kind: 'p1Base', active: 0 } }),
      baseLevel: null,
    });
    expect(projectCartignonPrivate(ctx, matchOf(base), 0).spellHints).toEqual([
      expect.objectContaining({ castable: false, reason: 'NOT_ALLOWED_IN_PHASE' }),
    ]);
    // S-01 suspends on a keepDrawn choice; the other spell in hand is not castable meanwhile.
    const looking = apply(
      stateOf({
        hands: [[spell(1), spell(2)], []],
        stacks: [[cr('red', 1), cr('red', 2), cr('red', 3)], [cr('blue', 1)]], // S-01: a level 3
        deck: [cr('yellow', 1), cr('yellow', 2), cr('yellow', 3)],
      }),
      0,
      ps(spell(1)),
    ).state;
    expect(looking.pendingChoice).toBeDefined();
    expect(projectCartignonPrivate(ctx, matchOf(looking), 0).spellHints).toEqual([
      expect.objectContaining({ cardId: spell(2), castable: false, reason: 'CHOICE_PENDING' }),
    ]);
    const s = stateOf({ hands: [[spell(2)], []], stacks: STACKS });
    expect(projectCartignonPrivate(ctx, matchOf(s, true), 0).spellHints).toEqual([
      expect.objectContaining({ castable: false, reason: 'MATCH_OVER' }),
    ]);
  });

  it('RD-175: a Secondary with no effect is reported as not castable (SPELL_NO_EFFECT)', () => {
    // Equal hands -> S-02 Secondary (buff own Leading); seat 0 has no stack -> no effect.
    const s = stateOf({
      hands: [[spell(2), cr('red', 5)], [cr('violet', 1)]],
      stacks: [[], [cr('blue', 1)]],
    });
    const own = projectCartignonPrivate(ctx, matchOf(s), 0);
    expect(own.spellHints).toEqual([
      { cardId: spell(2), branch: 'secondary', castable: false, reason: 'SPELL_NO_EFFECT' },
    ]);
    expect(own.legal).not.toContainEqual(ps(spell(2)));
    expect(cartignonPrivateViewSchema.safeParse(own).success).toBe(true);
    // A feasible Primary with an effect is castable, even when the Secondary would have no target.
    const primary = stateOf({
      hands: [
        [spell(2), cr('red', 5)],
        [cr('violet', 1), cr('violet', 2)],
      ],
      stacks: [[], [cr('blue', 1)]],
      graveyard: [cr('green', 1)],
    });
    expect(projectCartignonPrivate(ctx, matchOf(primary), 0).spellHints).toEqual([
      { cardId: spell(2), branch: 'primary', castable: true, reason: null },
    ]);
  });
});

describe('S-02 narration through the projected events (playtest report)', () => {
  it('seat 1 casts: seat 0 sees counts for seat 1 and ids for its own draw', () => {
    const s = stateOf({
      hands: [
        [cr('violet', 1), cr('violet', 2), cr('violet', 3)],
        [spell(2), cr('red', 5)],
      ],
      stacks: STACKS,
      deck: [cr('yellow', 1), cr('yellow', 2)],
      phase: { kind: 'turn', active: 1 },
    });
    const { state, events } = apply(s, 1, ps(spell(2)));
    const seen0 = projectCartignonEvents(events, 0);
    expect(seen0.filter((e) => e.type === 'cardsDrawn')).toEqual([
      { type: 'cardsDrawn', seat: 1, reason: 'spellGraveyard', count: 2 },
      { type: 'cardsDrawn', seat: 0, reason: 'spellDeck', cardIds: [cr('yellow', 1)] },
    ]);
    const drawnBy1 = state.board.zones.hands[1].slice(1);
    expect(JSON.stringify(seen0)).not.toMatch(new RegExp(drawnBy1.join('|')));
    expect(seen0).toContainEqual({
      type: 'spellDrawResolved',
      seat: 1,
      from: 'graveyard',
      requested: 2,
      drawn: 2,
    });
    const seen1 = projectCartignonEvents(events, 1);
    expect(seen1.filter((e) => e.type === 'cardsDrawn')).toEqual([
      { type: 'cardsDrawn', seat: 1, reason: 'spellGraveyard', cardIds: drawnBy1 },
      { type: 'cardsDrawn', seat: 0, reason: 'spellDeck', count: 1 },
    ]);
    expect(cartignonSeatEventsSchema.safeParse(seen0).success).toBe(true);
    expect(cartignonSeatEventsSchema.safeParse(seen1).success).toBe(true);
  });
});
