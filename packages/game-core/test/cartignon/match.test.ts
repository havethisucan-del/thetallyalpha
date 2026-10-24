import { describe, expect, it } from 'vitest';
import { createSeededRng, type Rng, type Seat } from '../../src/index.js';
import {
  COLORS,
  activeSeat,
  applyMatchCommand,
  boardCardIds,
  roundCardIds,
  awardToken,
  canStillReachCreature,
  cleanupRound,
  createBoard,
  createRoundContext,
  createTokenSupply,
  createZones,
  evaluateMatchEnd,
  finishRound,
  legalMatchCommands,
  NO_PROGRESS_ROUND_LIMIT,
  resolveRound,
  setupNextRound,
  stackAtk,
  startCartignonMatch,
  startRound,
  tokenCounts,
  type Board,
  type CardId,
  type CartignonMatchState,
  type Color,
  type CreatureLevel,
  type MatchEvent,
  type NextRoundSetup,
  type RoundCommand,
  type RoundOverReason,
  type RoundState,
  type TokenMap,
} from '../../src/cartignon/index.js';
import { deepFreeze, placeholderCatalog } from './test-fixtures.js';

// Placeholder catalog ids: creatures c01..c35 (color order × level 1..5, atk = level*10;
// orange-3 modifiers [buffSelf, linkUp], blue-4 [nerf, nerf, buffSelf]), spells c36..c54.

const catalog = placeholderCatalog();
const ctx = createRoundContext(catalog);
const CATALOG_ORDER = createZones(catalog).deck;
const ALL_SORTED = [...CATALOG_ORDER].sort();

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

/** Two full hands of spells only (no creature). */
const SPELL_HANDS: [CardId[], CardId[]] = [
  Array.from({ length: 9 }, (_, i) => spell(i + 1)),
  Array.from({ length: 9 }, (_, i) => spell(i + 10)),
];
function creatureDeck(n: number): CardId[] {
  return CATALOG_ORDER.filter((c) => ctx.cards[c]?.kind === 'creature').slice(0, n);
}

/** All 54 ids: zones plus attached spell cards (RD-02 conservation). */
function sortedIds(board: Board): string[] {
  return boardCardIds(board).sort();
}

/**
 * RD-77 (corrected 2026-10-18): the 9-card limit applies to DEALING only. After a step that dealt
 * (final deal / re-deal: hands rebuilt; refill: hands only grow), no deal pushed a hand above 9;
 * a hand that was already above 9 is never trimmed by a refill. In-round draws are uncapped.
 */
function expectDealsWithinLimit(
  events: readonly MatchEvent[],
  before: readonly number[],
  match: CartignonMatchState,
): void {
  const kinds = new Set(events.map((e) => e.type));
  const hands = match.round.board.zones.hands;
  if (kinds.has('deckExhausted') || kinds.has('handsRedealt')) {
    for (const hand of hands) expect(hand.length).toBeLessThanOrEqual(9);
  } else if (kinds.has('handsRefilled')) {
    hands.forEach((hand, seat) => {
      const was = before[seat] ?? 0;
      expect(hand.length).toBeLessThanOrEqual(Math.max(9, was));
      expect(hand.length).toBeGreaterThanOrEqual(was);
    });
  }
}

interface BoardOpts {
  readonly stacks?: readonly [CardId[], CardId[]];
  readonly hands?: readonly [CardId[], CardId[]];
  /** Explicit deck (top first); every unplaced card then goes to the graveyard. */
  readonly deck?: CardId[];
}

function boardOf(o: BoardOpts): Board {
  const stacks = o.stacks ?? [[], []];
  const hands = o.hands ?? [[], []];
  const used = new Set([...stacks[0], ...stacks[1], ...hands[0], ...hands[1], ...(o.deck ?? [])]);
  const rest = CATALOG_ORDER.filter((c) => !used.has(c));
  return createBoard({
    deck: o.deck ?? rest,
    graveyard: o.deck === undefined ? [] : rest,
    hands: [hands[0], hands[1]],
    stacks: [stacks[0], stacks[1]],
  });
}

interface OverOpts extends BoardOpts {
  readonly p1?: Seat;
  readonly reason?: RoundOverReason;
  /** The seat whose turn end ended the round (default: the seat behind, else 1). */
  readonly seat?: Seat;
}

/** A round state in `roundOver` built directly from plain data. */
function overState(o: OverOpts): RoundState {
  const board = boardOf(o);
  const atk = [stackAtk(ctx.cards, board, 0), stackAtk(ctx.cards, board, 1)] as const;
  // RD-169: unequal ATK -> the seat behind ended its turn (`opponentAhead`); equal -> `equalStall`.
  const reason = o.reason ?? (atk[0] === atk[1] ? 'equalStall' : 'opponentAhead');
  const behind: Seat = atk[0] < atk[1] ? 0 : 1;
  return deepFreeze({
    board,
    p1: o.p1 ?? 0,
    baseLevel: null,
    turnNumber: 5,
    playedThisTurn: false,
    phase: { kind: 'roundOver', reason, seat: o.seat ?? behind, atk },
  });
}

function matchOf(round: RoundState, extra: Partial<CartignonMatchState> = {}): CartignonMatchState {
  return deepFreeze({
    round,
    roundNumber: 3,
    tokens: createTokenSupply(),
    finalRound: false,
    replays: 0,
    poolAfterCleanup: 54,
    roundsWithoutProgress: 0,
    lastOutcome: null,
    status: { kind: 'playing' },
    ...extra,
  });
}

function tokensWith(held: Partial<Record<Color, Seat>>): TokenMap {
  return deepFreeze({ ...createTokenSupply(), ...held });
}

function finish(match: CartignonMatchState, seed = 1) {
  const before = JSON.stringify(match);
  const r = finishRound(ctx, match, rng(seed));
  if (!r.ok) throw new Error(`unexpected rejection ${r.code}`);
  expect(JSON.stringify(match)).toBe(before);
  return r;
}

function resolve(round: RoundState, seed = 1) {
  const before = JSON.stringify(round);
  const r = resolveRound(ctx, round, rng(seed), 1);
  if (!r.ok) throw new Error(`unexpected rejection ${r.code}`);
  expect(JSON.stringify(round)).toBe(before);
  return r;
}

function started(setup: NextRoundSetup) {
  if (setup.kind !== 'started') throw new Error(`unexpected ${setup.kind}`);
  for (const hand of setup.state.board.zones.hands) expect(hand.length).toBeLessThanOrEqual(9);
  return setup;
}

function types(events: readonly MatchEvent[]): string[] {
  return events.map((e) => e.type);
}

// ---------------------------------------------------------------------------------------------

describe('resolveRound: ATK comparison (RD-17, RD-18, RD-67, RD-68, RD-69)', () => {
  it('rejects a round that is not over', () => {
    const state = startRound(boardOf({ hands: [[cr('red', 1)], []] }), 0).state;
    expect(resolveRound(ctx, state, rng(), 1)).toMatchObject({ ok: false, code: 'ROUND_NOT_OVER' });
  });

  it('opponentAhead: the ending seat was behind, its opponent wins (RD-169, RD-69)', () => {
    const r = resolve(overState({ stacks: [[cr('yellow', 3)], [cr('blue', 1)]] }));
    expect(r.outcome).toEqual({
      kind: 'win',
      winner: 0,
      decidedBy: 'opponentAhead',
      atk: [30, 10],
      tieBreakIterations: 0,
    });
    const other = resolve(overState({ stacks: [[cr('blue', 1)], [cr('yellow', 3)]] }));
    expect(other.outcome).toMatchObject({ kind: 'win', winner: 1, decidedBy: 'opponentAhead' });
  });

  it('equalStall with unequal ATK is a broken invariant (throws)', () => {
    const forged = overState({
      stacks: [[cr('yellow', 3)], [cr('blue', 1)]],
      reason: 'equalStall',
    });
    expect(() => resolveRound(ctx, forged, rng(), 1)).toThrow(/equalStall/);
  });

  it('an End Turn in the P1 Base step is a draw without comparison (RD-67)', () => {
    const r = resolve(overState({ reason: 'p1NoBase', seat: 0 }));
    expect(r.outcome).toEqual({
      kind: 'draw',
      reason: 'p1NoBase',
      atk: [0, 0],
      tieBreakIterations: 0,
    });
  });
});

describe('resolveRound: tie-break (RD-19, RD-38, RD-42, RD-72)', () => {
  const TIED: readonly [CardId[], CardId[]] = [[cr('yellow', 3)], [cr('green', 3)]];

  it('links the first drawn creature, P1 first; higher ATK wins', () => {
    const r = resolve(overState({ stacks: TIED, deck: [cr('red', 2), cr('violet', 1)] }));
    expect(r.outcome).toEqual({
      kind: 'win',
      winner: 0,
      decidedBy: 'tieBreak',
      atk: [50, 40],
      tieBreakIterations: 1,
    });
    expect(r.board.zones.stacks).toEqual([
      [cr('yellow', 3), cr('red', 2)],
      [cr('green', 3), cr('violet', 1)],
    ]);
    expect(r.board.zones.deck).toEqual([]);
    expect(types(r.events)).toEqual([
      'tieBreakStarted',
      'creatureLinked',
      'creatureLinked',
      'roundResolved',
    ]);
    expect(sortedIds(r.board)).toEqual(ALL_SORTED);
  });

  it('P1 of the round draws first (RD-72)', () => {
    const r = resolve(overState({ stacks: TIED, p1: 1, deck: [cr('red', 2), cr('violet', 1)] }));
    expect(r.outcome).toMatchObject({ kind: 'win', winner: 1, atk: [40, 50] });
  });

  it('repeats while tied; the last linked creature is Leading', () => {
    const deck = [cr('red', 2), cr('violet', 2), cr('red', 1), cr('indigo', 3)];
    const r = resolve(overState({ stacks: TIED, deck }));
    expect(r.outcome).toMatchObject({ kind: 'win', winner: 1, atk: [60, 80] });
    expect(r.outcome.tieBreakIterations).toBe(2);
    expect(r.board.zones.stacks[1].at(-1)).toBe(cr('indigo', 3));
    const award = awardToken(ctx, createTokenSupply(), r.board, 1);
    expect(award.change).toMatchObject({ color: 'indigo', kind: 'awarded' });
  });

  it('drawn non-creatures go back into the deck, which is shuffled (RD-38)', () => {
    const deck = [spell(1), spell(2), cr('red', 2), cr('violet', 1)];
    const r = resolve(overState({ stacks: TIED, deck }));
    expect(r.outcome).toMatchObject({ kind: 'win', winner: 0 });
    expect(r.events).toContainEqual({ type: 'tieBreakCardsReturned', seat: 0, count: 2 });
    expect(r.board.zones.stacks[0]).toEqual([cr('yellow', 3), cr('red', 2)]);
    expect(r.board.zones.stacks[1]).toEqual([cr('green', 3), cr('violet', 1)]);
    expect([...r.board.zones.deck].sort()).toEqual([spell(1), spell(2)]);
    expect(r.board.zones.hands).toEqual([[], []]);
    expect(sortedIds(r.board)).toEqual(ALL_SORTED);
  });

  it('deck runs out during the first search: drawn round (RD-42)', () => {
    const r = resolve(overState({ stacks: TIED, deck: [spell(1)] }));
    expect(r.outcome).toEqual({
      kind: 'draw',
      reason: 'tieBreakDeckOut',
      atk: [30, 30],
      tieBreakIterations: 1,
    });
    expect(r.events).toContainEqual({ type: 'tieBreakDeckOut', seat: 0 });
    expect(r.board.zones.deck).toEqual([spell(1)]);
  });

  it('deck runs out for the second seat: still a draw even if ATK now differs (RD-42)', () => {
    const r = resolve(overState({ stacks: TIED, deck: [cr('red', 2), spell(1)] }));
    expect(r.outcome).toMatchObject({ kind: 'draw', reason: 'tieBreakDeckOut', atk: [50, 30] });
    expect(r.events).toContainEqual({ type: 'tieBreakDeckOut', seat: 1 });
  });

  it('an empty deck at a tie is an immediate draw', () => {
    const r = resolve(overState({ stacks: TIED, deck: [] }));
    expect(r.outcome).toMatchObject({ kind: 'draw', reason: 'tieBreakDeckOut' });
  });

  it('is deterministic for a seed', () => {
    const deck = [spell(1), spell(2), spell(3), cr('red', 2), spell(4), cr('violet', 1)];
    const a = resolve(overState({ stacks: TIED, deck }), 7);
    const b = resolve(overState({ stacks: TIED, deck }), 7);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('awardToken (RD-03, RD-26)', () => {
  const board = boardOf({ stacks: [[cr('yellow', 1), cr('red', 2)], [cr('blue', 1)]] });

  it('takes the Leading Minion color token from the supply', () => {
    const r = awardToken(ctx, createTokenSupply(), board, 0);
    expect(r.change).toEqual({
      seat: 0,
      color: 'red',
      kind: 'awarded',
      leadingCardId: cr('red', 2),
    });
    expect(r.tokens.red).toBe(0);
    expect(tokenCounts(r.tokens)).toEqual([1, 0]);
  });

  it('steals the token from the opponent', () => {
    const r = awardToken(ctx, tokensWith({ red: 1, blue: 1 }), board, 0);
    expect(r.change.kind).toBe('stolen');
    expect(tokenCounts(r.tokens)).toEqual([1, 1]);
  });

  it('protects a token the winner already holds (no change)', () => {
    const tokens = tokensWith({ red: 0 });
    const r = awardToken(ctx, tokens, board, 0);
    expect(r.change.kind).toBe('protected');
    expect(r.tokens).toEqual(tokens);
  });
});

describe('cleanupRound (RD-12, RD-20, RD-58, RD-59, RD-71)', () => {
  // orange-3 (linkUp@2) sits silenced at position 2 under yellow-4: removing yellow-4 one by one
  // would make it live again and arm Link Up. Bulk cleanup must not.
  const winnerStack = [cr('yellow', 1), cr('yellow', 2), cr('orange', 3), cr('yellow', 4)];
  const base = boardOf({ stacks: [winnerStack, [cr('blue', 1)]], hands: [[spell(1)], []] });
  const board: Board = deepFreeze({
    ...base,
    linkUpPending: [true, true],
    attachedEffects: [
      {
        effectId: 'e1',
        kind: 'atkDelta',
        amount: 30,
        sourceCardId: spell(2),
        targetCardId: cr('blue', 1),
      },
    ],
    nextEffectSeq: 2,
  });
  const win = {
    kind: 'win',
    winner: 0,
    decidedBy: 'opponentAhead',
    atk: [100, 40],
    tieBreakIterations: 0,
  } as const;

  it('losing stack -> graveyard, winning stack -> deck, shuffled; no activation', () => {
    const r = cleanupRound(board, win, rng());
    const z = r.board.zones;
    expect(z.stacks).toEqual([[], []]);
    expect(z.graveyard).toEqual([cr('blue', 1)]);
    expect(z.deck).toHaveLength(base.zones.deck.length + 4);
    for (const c of winnerStack) expect(z.deck).toContain(c);
    expect(z.deck).not.toEqual([...base.zones.deck, ...winnerStack]);
    expect(z.hands).toEqual([[spell(1)], []]);
    expect(r.board.linkUpPending).toEqual([false, false]);
    expect(r.board.attachedEffects).toEqual([]);
    expect(r.board.nextEffectSeq).toBe(2);
    expect(r.events).toEqual([{ type: 'roundCleanedUp', toGraveyard: 1, toDeck: 4 }]);
    expect(sortedIds(r.board)).toEqual(ALL_SORTED);
  });

  const draw = {
    kind: 'draw',
    reason: 'tieBreakDeckOut',
    atk: [0, 0],
    tieBreakIterations: 1,
  } as const;

  it('drawn round: both stacks -> deck, shuffled (RD-71)', () => {
    const r = cleanupRound(board, draw, rng());
    const z = r.board.zones;
    expect(z.graveyard).toEqual([]);
    expect(z.deck).toHaveLength(base.zones.deck.length + 5);
    for (const c of [...winnerStack, cr('blue', 1)]) expect(z.deck).toContain(c);
    expect(z.deck).not.toEqual([...base.zones.deck, ...winnerStack, cr('blue', 1)]);
    expect(r.events).toEqual([{ type: 'roundCleanedUp', toGraveyard: 0, toDeck: 5 }]);
    expect(sortedIds(r.board)).toEqual(ALL_SORTED);
  });
});

describe('setupNextRound (RD-04, RD-21, RD-22, RD-32, RD-36, RD-70)', () => {
  const hands: [CardId[], CardId[]] = [CATALOG_ORDER.slice(0, 7), CATALOG_ORDER.slice(7, 15)];

  function firstSeatFor(seed: number): Seat {
    return createSeededRng(seed).nextInt(2) === 0 ? 0 : 1;
  }

  it('refills 1 by 1 to 9, starting with a seeded random seat', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const seen = new Set<Seat>();
    for (const seed of seeds) {
      const board = boardOf({ hands });
      const r = started(setupNextRound(ctx, board, 1, rng(seed)));
      const first = firstSeatFor(seed);
      seen.add(first);
      const z = r.state.board.zones;
      expect(z.hands[0]).toHaveLength(9);
      expect(z.hands[1]).toHaveLength(9);
      expect(z.deck).toHaveLength(board.zones.deck.length - 3);
      // 1 card at a time: the first deck card goes to the first seat, the second to the other.
      expect(z.hands[first]).toContain(board.zones.deck[0]);
      expect(z.hands[first === 0 ? 1 : 0]).toContain(board.zones.deck[1]);
      expect(r.events[1]).toEqual({ type: 'handsRefilled', firstSeat: first, packetSize: 1 });
      expect(r.events[2]).toMatchObject({ type: 'cardsDrawn', seat: first, reason: 'refill' });
      expect(r.finalRound).toBe(false);
      expect(JSON.stringify(setupNextRound(ctx, board, 1, rng(seed)))).toBe(JSON.stringify(r));
    }
    expect(seen).toEqual(new Set([0, 1]));
  });

  it('starts the round clean with the given P1 (RD-04, RD-70)', () => {
    const board = deepFreeze({ ...boardOf({ hands }), linkUpPending: [true, false] as const });
    const r = started(setupNextRound(ctx, board, 1, rng()));
    expect(r.state.p1).toBe(1);
    expect(r.state.phase).toEqual({ kind: 'p1Base', active: 1 });
    expect(r.state.board.linkUpPending).toEqual([false, false]);
    expect(types(r.events)[0]).toBe('roundStarted');
    expect(types(r.events).at(-1)).toBe('turnStarted');
  });

  it('deck + hands <= 18: final hands split evenly, odd card to the graveyard (RD-22, RD-36)', () => {
    const board = boardOf({
      hands: [
        [cr('red', 1), cr('red', 2), spell(1)],
        [cr('blue', 1), spell(2)],
      ],
      deck: [cr('green', 1), cr('green', 2), spell(3), spell(4)],
    });
    const r = started(setupNextRound(ctx, board, 0, rng()));
    const z = r.state.board.zones;
    expect(r.finalRound).toBe(true);
    expect(z.hands[0]).toHaveLength(4);
    expect(z.hands[1]).toHaveLength(4);
    expect(z.deck).toEqual([]);
    expect(z.graveyard).toHaveLength(board.zones.graveyard.length + 1);
    expect(r.events).toContainEqual({
      type: 'deckExhausted',
      reason: 'finalRound',
      returnedFromHands: 5,
      perSeat: 4,
      toGraveyard: 1,
    });
    expect(r.events.filter((e) => e.type === 'cardsDrawn')).toHaveLength(2);
    expect(sortedIds(r.state.board)).toEqual(ALL_SORTED);
  });

  it('exactly 18 cards is already the final round, even though a refill would fit (RD-22)', () => {
    const board = boardOf({
      hands: [CATALOG_ORDER.slice(0, 5), CATALOG_ORDER.slice(5, 9)],
      deck: CATALOG_ORDER.slice(9, 18),
    });
    const r = started(setupNextRound(ctx, board, 0, rng()));
    expect(r.finalRound).toBe(true);
    expect(r.state.board.zones.hands.map((h) => h.length)).toEqual([9, 9]);
    expect(r.state.board.zones.deck).toEqual([]);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'deckExhausted', reason: 'finalRound', toGraveyard: 0 }),
    );
  });

  it('19 cards: a normal refill, not the final round (RD-22)', () => {
    const board = boardOf({
      hands: [CATALOG_ORDER.slice(0, 5), CATALOG_ORDER.slice(5, 9)],
      deck: CATALOG_ORDER.slice(9, 19),
    });
    const r = started(setupNextRound(ctx, board, 0, rng()));
    expect(r.finalRound).toBe(false);
    expect(r.state.board.zones.hands.map((h) => h.length)).toEqual([9, 9]);
    expect(r.state.board.zones.deck).toHaveLength(1);
  });

  it('no creature in hand and no Mulligan: hands re-dealt to 9, not final (RD-76, RD-77)', () => {
    const board = boardOf({ hands: SPELL_HANDS, deck: creatureDeck(6) });
    const r = started(setupNextRound(ctx, board, 0, rng()));
    const z = r.state.board.zones;
    expect(r.finalRound).toBe(false);
    expect(z.hands.map((h) => h.length)).toEqual([9, 9]);
    expect(z.deck).toHaveLength(6);
    expect(types(r.events)).toEqual([
      'roundStarted',
      'handsRedealt',
      'cardsDrawn',
      'cardsDrawn',
      'turnStarted',
    ]);
    expect(r.events[1]).toMatchObject({ type: 'handsRedealt', returnedFromHands: 18 });
    expect(r.events[2]).toMatchObject({ type: 'cardsDrawn', reason: 'redeal' });
    expect(sortedIds(r.state.board)).toEqual(ALL_SORTED);
    expect(JSON.stringify(started(setupNextRound(ctx, board, 0, rng())))).toBe(JSON.stringify(r));
  });

  it('no creature in deck + hands but spells left: the re-deal still happens (RD-84)', () => {
    const board = boardOf({ hands: SPELL_HANDS, deck: [spell(19)] });
    const r = started(setupNextRound(ctx, board, 0, rng()));
    expect(types(r.events)).toContain('handsRedealt');
    expect(r.finalRound).toBe(false);
  });

  it('RD-84 end branch: no creature and nothing that can draw one back (regression guard for R4)', () => {
    // A context whose cards resolve to neither kind: no creature and no possible graveyard draw.
    const blind = { ...ctx, cards: {} };
    const board = boardOf({ hands: SPELL_HANDS, deck: [spell(19)] });
    expect(setupNextRound(blind, board, 0, rng())).toEqual({ kind: 'noCreaturesLeft' });
    const match = matchOf(
      overState({
        reason: 'p1NoBase',
        seat: 0,
        hands: SPELL_HANDS,
        deck: [spell(19)],
      }),
      { tokens: tokensWith({ red: 1 }) },
    );
    const r = finishRound(blind, match, rng());
    if (!r.ok) throw new Error(r.code);
    expect(r.state.status).toEqual({
      kind: 'matchOver',
      reason: 'noCreaturesLeft',
      winner: 1,
      tokenCounts: [0, 1],
    });
    expect(r.state.round.phase.kind).toBe('roundOver');
  });

  it('canStillReachCreature: a graveyard draw in the Primary or the Secondary counts (RD-84, RD-54)', () => {
    const zones = (deck: CardId[], hands: [CardId[], CardId[]]) => boardOf({ deck, hands }).zones;
    // Graveyard drawers: S-02 and S-19 (Primary, R4c-5), S-03, S-07, S-11 and S-18 (Secondary).
    for (const n of [2, 3, 7, 11, 18, 19]) {
      expect(canStillReachCreature(ctx, zones([spell(n)], [[], []]))).toBe(true);
    }
    expect(canStillReachCreature(ctx, zones([], [[], [spell(3)]]))).toBe(true);
    expect(canStillReachCreature(ctx, zones([spell(19)], [[], [spell(19)]]))).toBe(true);
    // (Since R4c-5 no catalog spell is `notYetSupported`; such a spell would never count.)
    // Buffs, nerfs, deck draws and 'none' do not count.
    const others = [spell(1), spell(4), spell(5), spell(6), spell(8), spell(9), spell(10)];
    const more = [spell(12), spell(13), spell(14), spell(15), spell(16), spell(17)];
    expect(canStillReachCreature(ctx, zones(others, [more, []]))).toBe(false);
    expect(canStillReachCreature(ctx, zones([cr('red', 1)], [[cr('red', 2)], []]))).toBe(false);
    expect(canStillReachCreature(ctx, zones([], [[], []]))).toBe(false);
  });

  it('RD-84 end branch: no creature and no graveyard-draw spell left', () => {
    const board = boardOf({ hands: SPELL_HANDS, deck: [spell(19)] });
    // Every spell is S-08 (Secondary deck draw, no graveyard draw at all).
    const s08 = catalog.find((d) => d.defId === 'S-08');
    if (s08 === undefined) throw new Error('S-08 missing');
    const noGraveDraws = createRoundContext(catalog.map((d) => (d.kind === 'spell' ? s08 : d)));
    expect(setupNextRound(noGraveDraws, board, 0, rng())).toEqual({ kind: 'noCreaturesLeft' });
    // With the real spells (S-19 draws from the graveyard) the re-deal happens.
    expect(types(started(setupNextRound(ctx, board, 0, rng())).events)).toContain('handsRedealt');
  });

  it('no deadlock while a Mulligan is still possible', () => {
    const r = started(
      setupNextRound(ctx, boardOf({ hands: SPELL_HANDS, deck: creatureDeck(9) }), 0, rng()),
    );
    expect(r.finalRound).toBe(false);
    expect(r.state.board.zones.hands).toEqual(SPELL_HANDS);
  });
});

describe('evaluateMatchEnd (RD-24, RD-40)', () => {
  it('continues while tokens remain in the supply and the round was not final', () => {
    expect(evaluateMatchEnd(tokensWith({ red: 0 }), false)).toEqual({ kind: 'continue' });
  });
  it('ends when all 7 tokens are held; more tokens wins', () => {
    const t = tokensWith({ orange: 0, yellow: 0, green: 0, blue: 0, indigo: 1, violet: 1, red: 1 });
    expect(evaluateMatchEnd(t, false)).toEqual({
      kind: 'over',
      reason: 'allTokensHeld',
      winner: 0,
    });
  });
  it('ends after the final round; a token tie means replay', () => {
    expect(evaluateMatchEnd(tokensWith({ red: 1 }), true)).toEqual({
      kind: 'over',
      reason: 'finalRoundPlayed',
      winner: 1,
    });
    expect(evaluateMatchEnd(tokensWith({ red: 1, blue: 0 }), true)).toEqual({ kind: 'replay' });
    expect(evaluateMatchEnd(createTokenSupply(), true)).toEqual({ kind: 'replay' });
  });
  it('at most 2 replays; still tied after the 2nd -> draw (RD-81)', () => {
    const tied = tokensWith({ red: 1, blue: 0 });
    expect(evaluateMatchEnd(tied, true, 1)).toEqual({ kind: 'replay' });
    expect(evaluateMatchEnd(tied, true, 2)).toEqual({
      kind: 'over',
      reason: 'replaysExhausted',
      winner: null,
    });
  });
});

describe('finishRound: match flow', () => {
  it('awards the token, cleans up and starts the next round with P1 alternated', () => {
    const match = matchOf(
      overState({ stacks: [[cr('yellow', 3)], [cr('blue', 1)]], hands: [[spell(1)], []] }),
    );
    const r = finish(match);
    expect(r.state.tokens.yellow).toBe(0);
    expect(r.state.round.p1).toBe(1);
    expect(r.state.roundNumber).toBe(4);
    expect(r.state.status).toEqual({ kind: 'playing' });
    expect(r.state.lastOutcome).toMatchObject({ kind: 'win', winner: 0 });
    expect(r.state.round.board.zones.hands.map((h) => h.length)).toEqual([9, 9]);
    expect(r.state.round.board.zones.hands[0]).toContain(spell(1));
    expect(r.state.round.board.zones.graveyard).toEqual([cr('blue', 1)]);
    expect(types(r.events)).toEqual([
      'roundResolved',
      'tokenChanged',
      'roundCleanedUp',
      'roundStarted',
      'handsRefilled',
      'cardsDrawn',
      'cardsDrawn',
      'turnStarted',
    ]);
    expect(sortedIds(r.state.round.board)).toEqual(ALL_SORTED);
    expect(JSON.parse(JSON.stringify(r.state))).toEqual(r.state);
  });

  it('a drawn round changes no tokens (RD-42, RD-67)', () => {
    const tokens = tokensWith({ red: 1 });
    const match = matchOf(overState({ reason: 'p1NoBase', seat: 0 }), {
      tokens,
    });
    const r = finish(match);
    expect(r.state.tokens).toEqual(tokens);
    expect(types(r.events)).not.toContain('tokenChanged');
    expect(r.state.round.p1).toBe(1);
  });

  it('ends the match when all 7 tokens are held (RD-24)', () => {
    const tokens = tokensWith({ orange: 0, yellow: 0, green: 0, blue: 0, indigo: 1, violet: 1 });
    const match = matchOf(overState({ stacks: [[cr('blue', 1)], [cr('red', 2)]] }), { tokens });
    const r = finish(match);
    expect(r.state.tokens.red).toBe(1);
    // Seat 1 won the round, but seat 0 holds more tokens (4 vs 3).
    expect(r.state.status).toEqual({
      kind: 'matchOver',
      reason: 'allTokensHeld',
      winner: 0,
      tokenCounts: [4, 3],
    });
    expect(r.events.at(-1)).toMatchObject({ type: 'matchOver', winner: 0 });
    expect(r.state.round.board.zones.stacks).toEqual([[], []]);
    expect(legalMatchCommands(ctx, r.state, 0)).toEqual([]);
    expect(applyMatchCommand(ctx, r.state, 0, { type: 'endTurn' }, rng())).toMatchObject({
      ok: false,
      code: 'MATCH_OVER',
    });
  });

  it('ends the match after the final round (RD-24)', () => {
    const match = matchOf(overState({ stacks: [[cr('yellow', 3)], [cr('blue', 1)]], deck: [] }), {
      tokens: tokensWith({ yellow: 0 }),
      finalRound: true,
    });
    const r = finish(match);
    expect(r.state.status).toMatchObject({
      kind: 'matchOver',
      reason: 'finalRoundPlayed',
      winner: 0,
      tokenCounts: [1, 0],
    });
  });

  it('a token tie after the final round replays it (RD-40, RD-74)', () => {
    const match = matchOf(
      overState({
        stacks: [[cr('yellow', 3)], [cr('blue', 2), cr('blue', 3)]],
        hands: [[cr('orange', 1), spell(1)], [cr('green', 1)]],
        deck: [],
      }),
      { tokens: tokensWith({ yellow: 0 }), finalRound: true },
    );
    const r = finish(match);
    expect(tokenCounts(r.state.tokens)).toEqual([1, 1]);
    expect(r.state.status).toEqual({ kind: 'playing' });
    expect(r.state.finalRound).toBe(true);
    expect(r.state.replays).toBe(1);
    expect(r.state.round.p1).toBe(1);
    expect(r.events).toContainEqual({ type: 'finalRoundReplay', replay: 1 });
    // 3 hand cards + 2 from the winning stack = 5 -> 2 each, 1 to the graveyard (RD-22).
    expect(r.state.round.board.zones.hands.map((h) => h.length)).toEqual([2, 2]);
    expect(sortedIds(r.state.round.board)).toEqual(ALL_SORTED);
  });

  it('a replay that cannot contain a creature ends the match without a winner (RD-75)', () => {
    const match = matchOf(overState({ stacks: [[cr('yellow', 1)], [cr('blue', 3)]], deck: [] }), {
      tokens: tokensWith({ yellow: 0 }),
      finalRound: true,
    });
    const r = finish(match);
    expect(r.state.status).toEqual({
      kind: 'matchOver',
      reason: 'replayImpossible',
      winner: null,
      tokenCounts: [1, 1],
    });
    // Detected before the replay starts: no phantom round, the finished round is kept.
    expect(types(r.events)).toEqual([
      'roundResolved',
      'tokenChanged',
      'roundCleanedUp',
      'matchOver',
    ]);
    expect(r.state.round.phase.kind).toBe('roundOver');
    expect(r.state.round.p1).toBe(0);
    expect(r.state.roundNumber).toBe(3);
    expect(r.state.replays).toBe(0);
    expect(r.state.round.board.zones.stacks).toEqual([[], []]);
    expect(r.state.round.board.zones.deck).toEqual([cr('blue', 3)]);
    expect(r.state.round.board.zones.hands).toEqual([[], []]);
    expect(sortedIds(r.state.round.board)).toEqual(ALL_SORTED);
  });

  it('a replay always re-deals with RD-22, even with full hands; max 9 each (RD-74, RD-77)', () => {
    const match = matchOf(
      overState({
        reason: 'p1NoBase',
        seat: 0,
        hands: [CATALOG_ORDER.slice(0, 9), CATALOG_ORDER.slice(9, 18)],
        deck: [],
      }),
      { finalRound: true },
    );
    const r = finish(match);
    const z = r.state.round.board.zones;
    expect(r.state.replays).toBe(1);
    expect(r.state.finalRound).toBe(true);
    expect(r.state.round.p1).toBe(1);
    expect(z.hands.map((h) => h.length)).toEqual([9, 9]);
    expect(z.deck).toEqual([]);
    expect(r.events).toContainEqual({
      type: 'deckExhausted',
      reason: 'finalRoundReplay',
      returnedFromHands: 18,
      perSeat: 9,
      toGraveyard: 0,
    });
    expect(types(r.events)).not.toContain('handsRefilled');
    expect(sortedIds(r.state.round.board)).toEqual(ALL_SORTED);
  });

  it('a drawn round returns both stacks to the deck before the replay deal (RD-71, RD-74)', () => {
    const match = matchOf(
      overState({
        stacks: [[cr('yellow', 3)], [cr('green', 3)]],
        hands: [[spell(1)], [spell(2)]],
        deck: [],
      }),
      { finalRound: true },
    );
    const r = finish(match);
    expect(r.state.lastOutcome).toMatchObject({ kind: 'draw', reason: 'tieBreakDeckOut' });
    // 2 hand cards + 2 returned stack cards = 4 -> 2 each, nothing to the graveyard.
    expect(r.state.round.board.zones.hands.map((h) => h.length)).toEqual([2, 2]);
    expect(r.events).toContainEqual(
      expect.objectContaining({
        type: 'deckExhausted',
        reason: 'finalRoundReplay',
        toGraveyard: 0,
      }),
    );
  });

  it('no creature left but spells remain: play continues (RD-84)', () => {
    const match = matchOf(
      overState({
        reason: 'p1NoBase',
        seat: 0,
        hands: SPELL_HANDS,
        deck: [spell(19)],
      }),
      { tokens: tokensWith({ red: 0 }), poolAfterCleanup: 30 },
    );
    const r = finish(match);
    expect(r.state.status).toEqual({ kind: 'playing' });
    expect(types(r.events)).toContain('handsRedealt');
  });

  it('N rounds without the deck + hands count decreasing end the match by tokens (RD-89, RD-90)', () => {
    expect(NO_PROGRESS_ROUND_LIMIT).toBe(7);
    const drawn = () => overState({ reason: 'p1NoBase', seat: 0 });
    // Pool after cleanup stays 54 (nothing goes to the graveyard): no progress.
    const second = finish(matchOf(drawn(), { roundsWithoutProgress: NO_PROGRESS_ROUND_LIMIT - 2 }));
    expect(second.state.roundsWithoutProgress).toBe(NO_PROGRESS_ROUND_LIMIT - 1);
    expect(second.state.poolAfterCleanup).toBe(54);
    expect(second.state.status).toEqual({ kind: 'playing' });
    const third = finish(
      matchOf(drawn(), {
        roundsWithoutProgress: NO_PROGRESS_ROUND_LIMIT - 1,
        tokens: tokensWith({ red: 1 }),
      }),
    );
    expect(third.state.status).toEqual({
      kind: 'matchOver',
      reason: 'noProgress',
      winner: 1,
      tokenCounts: [0, 1],
    });
    expect(types(third.events)).toEqual(['roundResolved', 'roundCleanedUp', 'matchOver']);
    expect(third.state.round.phase.kind).toBe('roundOver');
    const tied = finish(matchOf(drawn(), { roundsWithoutProgress: NO_PROGRESS_ROUND_LIMIT - 1 }));
    expect(tied.state.status).toMatchObject({ reason: 'noProgress', winner: null });
  });

  it('a card leaving deck + hands resets the no-progress count (RD-89)', () => {
    // The losing stack goes to the graveyard: the pool decreases.
    const won = overState({ stacks: [[cr('yellow', 3)], [cr('blue', 1)]] });
    const r = finish(matchOf(won, { roundsWithoutProgress: 2 }));
    expect(r.state.poolAfterCleanup).toBe(53);
    expect(r.state.roundsWithoutProgress).toBe(0);
    expect(r.state.status).toEqual({ kind: 'playing' });
  });

  it('a token tie after the final round replays even without progress (RD-40 before RD-89)', () => {
    const match = matchOf(
      overState({
        reason: 'p1NoBase',
        seat: 0,
        hands: [CATALOG_ORDER.slice(0, 9), CATALOG_ORDER.slice(9, 18)],
        deck: [],
      }),
      { finalRound: true, roundsWithoutProgress: 5 },
    );
    const r = finish(match);
    expect(r.state.status).toEqual({ kind: 'playing' });
    expect(r.state.replays).toBe(1);
    expect(r.events).toContainEqual({ type: 'finalRoundReplay', replay: 1 });
  });

  it('the no-progress counter from a real match start: N rounds where nothing leaves play', () => {
    const started = startCartignonMatch(catalog, rng(42));
    if (!started.ok) throw new Error(started.code);
    let match = started.state;
    expect(match.poolAfterCleanup).toBe(54);
    expect(match.roundsWithoutProgress).toBe(0);
    for (let round = 1; round <= NO_PROGRESS_ROUND_LIMIT; round++) {
      const p1 = match.round.p1;
      const p2: Seat = p1 === 0 ? 1 : 0;
      const base = legalMatchCommands(ctx, match, p1).find((c) => c.type === 'playCreature');
      if (base === undefined) throw new Error('P1 has no creature for this seed');
      // P1 places a Base Minion, P2 ends its turn at once: P1 wins (RD-169), its stack returns to
      // the deck and nothing goes to the graveyard (RD-20), so deck + hands stays 54.
      for (const [seat, command] of [
        [p1, base],
        [p2, { type: 'endTurn' }],
      ] as const) {
        const r = applyMatchCommand(ctx, match, seat, command, rng(round));
        if (!r.ok) throw new Error(r.code);
        match = r.state;
      }
      expect(match.poolAfterCleanup).toBe(54);
      if (round < NO_PROGRESS_ROUND_LIMIT) {
        expect(match.roundsWithoutProgress).toBe(round);
        expect(match.status).toEqual({ kind: 'playing' });
      }
    }
    expect(match.status).toMatchObject({ kind: 'matchOver', reason: 'noProgress' });
  });

  it('the final round ends by RD-24 even without progress (RD-89 does not apply)', () => {
    const match = matchOf(overState({ stacks: [[cr('yellow', 3)], [cr('blue', 1)]], deck: [] }), {
      tokens: tokensWith({ yellow: 0 }),
      finalRound: true,
      roundsWithoutProgress: 5,
    });
    expect(finish(match).state.status).toMatchObject({ reason: 'finalRoundPlayed', winner: 0 });
  });

  it('a protected token keeps the tie: 2 replays, then the match is a draw (RD-26, RD-81)', () => {
    const tokens = tokensWith({ yellow: 0, blue: 1 });
    const replayRound = (): RoundState =>
      overState({
        stacks: [[cr('yellow', 3)], [cr('blue', 1)]],
        hands: [[cr('orange', 1)], [cr('green', 1)]],
        deck: [],
      });
    const first = finish(matchOf(replayRound(), { tokens, finalRound: true }));
    expect(first.events).toContainEqual({
      type: 'tokenChanged',
      change: { seat: 0, color: 'yellow', kind: 'protected', leadingCardId: cr('yellow', 3) },
    });
    expect(first.state.replays).toBe(1);
    const second = finish(deepFreeze({ ...first.state, round: replayRound() }));
    expect(second.state.tokens).toEqual(tokens);
    expect(second.state.status).toEqual({ kind: 'playing' });
    expect(second.state.replays).toBe(2);
    expect(second.events).toContainEqual({ type: 'finalRoundReplay', replay: 2 });
    const third = finish(deepFreeze({ ...second.state, round: replayRound() }));
    expect(third.state.status).toEqual({
      kind: 'matchOver',
      reason: 'replaysExhausted',
      winner: null,
      tokenCounts: [1, 1],
    });
    expect(types(third.events)).not.toContain('finalRoundReplay');
    expect(third.state.round.phase.kind).toBe('roundOver');
  });
});

describe('applyMatchCommand / startCartignonMatch', () => {
  it('starts a match with every token in the supply, deterministically', () => {
    const a = startCartignonMatch(catalog, rng(42));
    const b = startCartignonMatch(catalog, rng(42));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    if (!a.ok) throw new Error('start failed');
    expect(tokenCounts(a.state.tokens)).toEqual([0, 0]);
    expect(a.state.roundNumber).toBe(1);
    expect(a.state.finalRound).toBe(false);
  });

  it('advances to the next round automatically when a round ends', () => {
    const p1Hand = [cr('yellow', 3), spell(1)];
    const p2Hand = [cr('blue', 1), spell(2)];
    let match = matchOf(startRound(boardOf({ hands: [p1Hand, p2Hand] }), 0).state, {
      roundNumber: 1,
    });
    const play = (seat: Seat, command: RoundCommand) => {
      const r = applyMatchCommand(ctx, deepFreeze(match), seat, command, rng());
      if (!r.ok) throw new Error(`unexpected rejection ${r.code}`);
      match = deepFreeze(r.state);
      return r.events;
    };
    expect(applyMatchCommand(ctx, match, 1, { type: 'endTurn' }, rng())).toMatchObject({
      ok: false,
      code: 'NOT_YOUR_TURN',
    });
    play(0, { type: 'playCreature', cardId: cr('yellow', 3) });
    play(1, { type: 'playCreature', cardId: cr('blue', 1) });
    const events = play(1, { type: 'endTurn' }); // seat 0 is ahead (30 > 10): round over (RD-169)
    expect(types(events)).toContain('roundOver');
    expect(types(events)).toContain('roundResolved');
    expect(match.tokens.yellow).toBe(0);
    expect(match.roundNumber).toBe(2);
    expect(match.round.p1).toBe(1);
    expect(match.round.phase).toEqual({ kind: 'p1Base', active: 1 });
    expect(match.round.board.zones.hands.map((h) => h.length)).toEqual([9, 9]);
  });

  it('equal-ATK stall goes to the tie-break end to end (RD-169, RD-19)', () => {
    const hands: [CardId[], CardId[]] = [
      [cr('yellow', 3), spell(1)],
      [cr('indigo', 3), spell(2)],
    ];
    let match = matchOf(startRound(boardOf({ hands }), 0).state, { roundNumber: 1 });
    const play = (seat: Seat, command: RoundCommand) => {
      const r = applyMatchCommand(ctx, deepFreeze(match), seat, command, rng());
      if (!r.ok) throw new Error(`unexpected rejection ${r.code}`);
      match = deepFreeze(r.state);
      return r.events;
    };
    play(0, { type: 'playCreature', cardId: cr('yellow', 3) });
    play(1, { type: 'playCreature', cardId: cr('indigo', 3) }); // 30 vs 30
    play(1, { type: 'endTurn' }); // equal: the turn passes (RD-169)
    expect(match.round.phase).toEqual({ kind: 'turn', active: 0, equalEndBy: 1 });
    const events = play(0, { type: 'endTurn' }); // no play, still equal: equal-ATK stall
    expect(types(events)).toContain('tieBreakStarted');
    // Deck in catalog order: P1 links orange-1 (40), P2 links orange-2 (50).
    expect(match.lastOutcome).toMatchObject({ kind: 'win', winner: 1, decidedBy: 'tieBreak' });
    expect(match.tokens.orange).toBe(1);
    expect(match.roundNumber).toBe(2);
  });

  it('an RD-76 re-deal may again hold no creature: RD-67 draw, then another re-deal', () => {
    const x = cr('red', 5);
    const base = matchOf(
      overState({
        reason: 'p1NoBase',
        seat: 0,
        hands: SPELL_HANDS,
        deck: [spell(19), x],
      }),
    );
    let stuck: CartignonMatchState | undefined;
    for (let seed = 1; seed <= 200 && stuck === undefined; seed++) {
      const r = finish(base, seed);
      expect(types(r.events)).toContain('handsRedealt');
      const { hands } = r.state.round.board.zones;
      if (![...hands[0], ...hands[1]].includes(x)) stuck = r.state;
    }
    if (stuck === undefined) throw new Error('no seed left the creature in the deck');
    const p1 = stuck.round.p1;
    // P1 has no creature and cannot Mulligan (deck of 2): only End Turn is legal (RD-63).
    expect(legalMatchCommands(ctx, stuck, p1)).toEqual([{ type: 'endTurn' }]);
    const r = applyMatchCommand(ctx, deepFreeze(stuck), p1, { type: 'endTurn' }, rng(5));
    if (!r.ok) throw new Error(r.code);
    expect(r.state.lastOutcome).toMatchObject({ kind: 'draw', reason: 'p1NoBase' });
    expect(types(r.events)).toContain('handsRedealt');
    expect(r.state.status).toEqual({ kind: 'playing' });
    expect(r.state.round.p1).toBe(p1 === 0 ? 1 : 0);
    expect(r.state.finalRound).toBe(false);
  });

  // RD-89 guarantees termination (seed 1 used to stall before it, RQ-31).
  it('random legal play (spells included) always reaches matchOver, conserving all 54 cards', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = rng(seed);
      const started = startCartignonMatch(catalog, r);
      if (!started.ok) throw new Error('start failed');
      let match = started.state;
      let steps = 0;
      while (match.status.kind === 'playing') {
        const phase = match.round.phase;
        if (phase.kind === 'roundOver') throw new Error('round left in roundOver');
        // R4c-5 (RD-160): a choice of a spell played through S-19 belongs to the other seat.
        const seat = activeSeat(match.round) as Seat;
        const options = legalMatchCommands(ctx, match, seat);
        expect(options.length).toBeGreaterThan(0);
        const command = options[r.nextInt(options.length)] as RoundCommand;
        const before = match.round.board.zones.hands.map((h) => h.length);
        const result = applyMatchCommand(ctx, match, seat, command, r);
        if (!result.ok) throw new Error(`legal command rejected: ${result.code}`);
        match = result.state;
        expect(roundCardIds(match.round).sort()).toEqual(ALL_SORTED);
        expectDealsWithinLimit(result.events, before, match);
        steps++;
        if (steps > 20000) throw new Error('match did not terminate');
      }
      expect(match.status.kind).toBe('matchOver');
    }
  });
});
