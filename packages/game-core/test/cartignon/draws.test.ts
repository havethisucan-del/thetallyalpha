import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSeededRng, type Rng, type Seat } from '../../src/index.js';
import {
  COLORS,
  applyCommand,
  applyMatchCommand,
  applyModifierDraws,
  activeSeat,
  boardCardIds,
  roundCardIds,
  buildCatalog,
  createBoard,
  createRoundContext,
  createZones,
  legalMatchCommands,
  removeFromStack,
  resolveRound,
  startCartignonMatch,
  type CardCatalog,
  type CardDef,
  type CardId,
  type Color,
  type CreatureLevel,
  type ModifierKind,
  type RoundCommand,
  type RoundEvent,
  type RoundState,
} from '../../src/cartignon/index.js';
import { deepFreeze, placeholderCatalog } from './test-fixtures.js';

// Creature draw modifiers (RD-98) executed by the round layer, and the real catalog in play.

function id(n: number): CardId {
  return `c${String(n).padStart(2, '0')}`;
}
function cr(color: Color, level: CreatureLevel): CardId {
  return id(COLORS.indexOf(color) * 5 + level);
}
const rng = (seed = 1): Rng => createSeededRng(seed);

/** Placeholder catalog with draw modifiers on a few red creatures. */
const OVERRIDES: Partial<Record<CardId, readonly ModifierKind[]>> = {
  [cr('red', 1)]: ['drawDeck'], // only ever the Base here: never fires
  [cr('red', 2)]: ['drawDeck'],
  [cr('red', 3)]: ['buffSelf', 'drawGrave'],
  [cr('red', 4)]: ['drawDeck', 'drawDeck', 'drawDeck'],
};
const catalog: CardCatalog = placeholderCatalog().map((d, i): CardDef => {
  const mods = OVERRIDES[id(i + 1)];
  return mods !== undefined && d.kind === 'creature' ? { ...d, modifiers: mods } : d;
});
const ctx = createRoundContext(catalog);
const ALL = createZones(catalog).deck;

/**
 * Seat 0 on turn with the given stack/hand; `deck` and `graveyard` as given; seat 1 has a blue-1
 * Base and every remaining card in hand (conservation holds).
 */
function turnState(
  stack0: CardId[],
  hand0: CardId[],
  deck: CardId[],
  graveyard: CardId[] = [],
): RoundState {
  const used = new Set([...stack0, ...hand0, ...deck, ...graveyard, cr('blue', 1)]);
  const hand1 = ALL.filter((c) => !used.has(c));
  const board = createBoard({
    deck,
    graveyard,
    hands: [hand0, hand1],
    stacks: [stack0, [cr('blue', 1)]],
  });
  return deepFreeze({
    board,
    p1: 0,
    baseLevel: 1,
    turnNumber: 3,
    playedThisTurn: false,
    phase: { kind: 'turn', active: 0 },
  });
}

function playCreature(state: RoundState, cardId: CardId, seed = 1) {
  const r = applyCommand(ctx, state, 0, { type: 'playCreature', cardId }, rng(seed));
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  expect(boardCardIds(r.state.board).sort()).toEqual([...ALL].sort());
  return r;
}

function draws(events: readonly RoundEvent[]) {
  return events.filter((e) => e.type === 'cardsDrawn');
}

describe('creature draw modifiers (RD-98, RD-48, RD-23)', () => {
  const X = cr('orange', 5);
  const Y = cr('yellow', 5);

  it('drawDeck: going live at its position draws the top deck card for the controller', () => {
    const r = playCreature(turnState([cr('orange', 1)], [cr('red', 2)], [X, Y]), cr('red', 2));
    const i = r.events.findIndex((e) => e.type === 'modifierLive');
    expect(r.events[i]).toEqual({
      type: 'modifierLive',
      seat: 0,
      cardId: cr('red', 2),
      kind: 'drawDeck',
      position: 1,
    });
    expect(r.events[i + 1]).toEqual({
      type: 'cardsDrawn',
      seat: 0,
      reason: 'modifierDeck',
      cardIds: [X],
    });
    expect(r.state.board.zones.hands[0]).toEqual([X]);
    expect(r.state.board.zones.deck).toEqual([Y]);
  });

  it('drawDeck with an empty deck draws nothing (RD-48)', () => {
    const r = playCreature(turnState([cr('orange', 1)], [cr('red', 2)], []), cr('red', 2));
    expect(draws(r.events)).toEqual([
      { type: 'cardsDrawn', seat: 0, reason: 'modifierDeck', cardIds: [] },
    ]);
    expect(r.state.board.zones.hands[0]).toEqual([]);
  });

  it('drawGrave: shuffles the graveyard and draws 1; deterministic per seed (RD-23)', () => {
    const state = turnState(
      [cr('orange', 1), cr('orange', 2)],
      [cr('red', 3)],
      [X],
      [Y, cr('green', 5)],
    );
    const a = playCreature(state, cr('red', 3), 7);
    const b = playCreature(state, cr('red', 3), 7);
    expect(a).toEqual(b);
    const [drawn] = draws(a.events);
    expect(drawn).toMatchObject({ seat: 0, reason: 'modifierGraveyard' });
    const cardIds = drawn?.cardIds ?? [];
    expect(cardIds).toHaveLength(1);
    expect([Y, cr('green', 5)]).toContain(cardIds[0]);
    expect(a.state.board.zones.graveyard).toHaveLength(1);
    expect(a.state.board.zones.deck).toEqual([X]);
  });

  it('drawGrave with an empty graveyard draws nothing', () => {
    const r = playCreature(
      turnState([cr('orange', 1), cr('orange', 2)], [cr('red', 3)], [X]),
      cr('red', 3),
    );
    expect(draws(r.events)).toEqual([
      { type: 'cardsDrawn', seat: 0, reason: 'modifierGraveyard', cardIds: [] },
    ]);
  });

  it('only the entry for the current position fires (RD-97)', () => {
    // red-3 at position 1 has buffSelf there, not drawGrave.
    const r = playCreature(turnState([cr('orange', 2)], [cr('red', 3)], [X], [Y]), cr('red', 3));
    expect(draws(r.events)).toEqual([]);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: 'modifierLive', kind: 'buffSelf' }),
    );
  });

  it('a Base Minion never draws (RD-35)', () => {
    const state = turnState([], [cr('red', 1)], [X]);
    const base: RoundState = { ...state, phase: { kind: 'p1Base', active: 0 }, baseLevel: null };
    const r = applyCommand(
      ctx,
      deepFreeze(base),
      0,
      { type: 'playCreature', cardId: cr('red', 1) },
      rng(),
    );
    if (!r.ok) throw new Error(r.code);
    expect(draws(r.events)).toEqual([]);
  });

  it('re-fires when the card becomes Leading again after the card above leaves (RD-57/RD-60)', () => {
    const state = turnState([cr('orange', 1), cr('red', 2), cr('orange', 4)], [], [X, Y]);
    const removed = removeFromStack(ctx.cards, state.board, cr('orange', 4), { zone: 'graveyard' });
    if (!removed.ok) throw new Error(removed.code);
    const r = applyModifierDraws(removed.board, removed.events, rng());
    expect(r.events.map((e) => e.type)).toEqual(['creatureRemoved', 'modifierLive', 'cardsDrawn']);
    expect(r.board.zones.hands[0]).toEqual([X]);
  });

  it('a shift that changes the Leading card position activates the new entry (RD-105)', () => {
    // red-4 at position 3 (drawDeck); the Base dies -> position 2 (drawDeck again: a new edge).
    const state = turnState(
      [cr('orange', 1), cr('orange', 2), cr('orange', 3), cr('red', 4)],
      [],
      [X, Y],
    );
    const removed = removeFromStack(ctx.cards, state.board, cr('orange', 1), { zone: 'graveyard' });
    if (!removed.ok) throw new Error(removed.code);
    const r = applyModifierDraws(removed.board, removed.events, rng());
    expect(r.board.zones.stacks[0]).toEqual([cr('orange', 2), cr('orange', 3), cr('red', 4)]);
    expect(r.events.map((e) => e.type)).toEqual([
      'creatureRemoved',
      'modifierSilenced',
      'modifierLive',
      'cardsDrawn',
    ]);
    expect(r.board.zones.hands[0]).toEqual([X]);
  });

  it('a removal below shifts a Leading draw card to a legal position: it draws once (RD-105); no events -> board unchanged', () => {
    const state = turnState([cr('orange', 1), cr('orange', 2), cr('red', 2)], [], [X]);
    const removed = removeFromStack(ctx.cards, state.board, cr('orange', 2), { zone: 'graveyard' });
    if (!removed.ok) throw new Error(removed.code);
    // red-2 moves to position 1, where its drawDeck is legal: RD-105 says it activates.
    const r = applyModifierDraws(removed.board, removed.events, rng());
    expect(draws(r.events)).toHaveLength(1);
    const unchanged = applyModifierDraws(state.board, [], rng());
    expect(unchanged.board).toBe(state.board);
  });

  it('placed via an armed Link Up: Link Up consumed and the draw fired in the same play', () => {
    // red-4 (level 4) on orange-2 is legal only through Link Up; at position 2 it has drawDeck.
    const state = turnState([cr('orange', 1), cr('orange', 2)], [cr('red', 4)], [X, Y]);
    const armed = deepFreeze({
      ...state,
      board: { ...state.board, linkUpPending: [true, false] as const },
    });
    const r = playCreature(armed, cr('red', 4));
    expect(r.events.filter((e) => e.type !== 'creaturePlayed')).toEqual([
      { type: 'creatureStacked', seat: 0, cardId: cr('red', 4), position: 2, viaLinkUp: true },
      { type: 'linkUpConsumed', seat: 0 },
      { type: 'modifierLive', seat: 0, cardId: cr('red', 4), kind: 'drawDeck', position: 2 },
      { type: 'cardsDrawn', seat: 0, reason: 'modifierDeck', cardIds: [X] },
    ]);
    expect(r.state.board.linkUpPending).toEqual([false, false]);
    expect(r.state.board.zones.hands[0]).toEqual([X]);
  });

  it('fires on a tie-break link (RD-19 link, RD-98; RD-122)', () => {
    // Equal stacks (10 vs 10). Tie-break: P1 (seat 0) reveals red-2 and links it at position 1
    // (drawDeck -> draws the spell now on top), then P2 reveals and links green-3.
    const S = id(36);
    const deck = [cr('red', 2), S, cr('green', 3), cr('green', 4)];
    const used = new Set([...deck, cr('orange', 1), cr('yellow', 1)]);
    const board = createBoard({
      deck,
      graveyard: ALL.filter((c) => !used.has(c)),
      hands: [[], []],
      stacks: [[cr('orange', 1)], [cr('yellow', 1)]],
    });
    const state: RoundState = deepFreeze({
      board,
      p1: 0,
      baseLevel: 1,
      turnNumber: 4,
      playedThisTurn: false,
      phase: { kind: 'roundOver', reason: 'equalStall', seat: 0, atk: [10, 10] },
    });
    const r = resolveRound(ctx, state, rng());
    if (!r.ok) throw new Error(r.code);
    const i = r.events.findIndex((e) => e.type === 'modifierLive');
    expect(r.events[i]).toEqual({
      type: 'modifierLive',
      seat: 0,
      cardId: cr('red', 2),
      kind: 'drawDeck',
      position: 1,
    });
    expect(r.events[i + 1]).toEqual({
      type: 'cardsDrawn',
      seat: 0,
      reason: 'modifierDeck',
      cardIds: [S],
    });
    expect(r.board.zones.hands[0]).toEqual([S]);
    expect(r.board.zones.stacks).toEqual([
      [cr('orange', 1), cr('red', 2)],
      [cr('yellow', 1), cr('green', 3)],
    ]);
    expect(r.outcome).toMatchObject({ kind: 'win', winner: 1, decidedBy: 'tieBreak' });
  });
});

// ---------------------------------------------------------------------------------------------
// The real creature data (data/cards.json via buildCatalog) in random play. Spells stay the
// provisional placeholder spells until R4c.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('random matches with the real creature catalog', () => {
  it('300 random matches all reach matchOver and conserve all 54 cards', () => {
    const built = buildCatalog(
      read('../../../../docs/cards/creatures.csv'),
      read('../../../../docs/cards/spells.csv'),
    );
    const real: CardCatalog = [
      ...built.creatures,
      ...placeholderCatalog().filter((d) => d.kind === 'spell'),
    ];
    const realCtx = createRoundContext(real);
    const all = [...createZones(real).deck].sort();
    let modifierDraws = 0;
    const trapEvents = { trapArmed: 0, trapTriggered: 0, trapLapsed: 0 };
    // R4c-5: S-19 (Gambit Prism) is in the spell catalog and must really run in random play.
    const gambit = { creature: 0, spell: 0, empty: 0, nestedPlays: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const started = startCartignonMatch(real, r);
      if (!started.ok) throw new Error('start failed');
      let match = started.state;
      let steps = 0;
      while (match.status.kind === 'playing') {
        const phase = match.round.phase;
        if (phase.kind === 'roundOver') throw new Error('round left in roundOver');
        const seat = activeSeat(match.round) as Seat;
        const options = legalMatchCommands(realCtx, match, seat);
        if (options.length === 0) throw new Error(`seed ${seed}: no legal command`);
        const command = options[r.nextInt(options.length)] as RoundCommand;
        const result = applyMatchCommand(realCtx, match, seat, command, r);
        if (!result.ok) throw new Error(`seed ${seed}: legal command rejected: ${result.code}`);
        match = result.state;
        for (const e of result.events) {
          if (e.type === 'trapArmed' || e.type === 'trapTriggered' || e.type === 'trapLapsed') {
            trapEvents[e.type]++;
          }
          if (e.type === 'gambitDrawn') gambit[e.drawnKind ?? 'empty']++;
          if (e.type === 'spellPlayed' && e.playedVia !== undefined) gambit.nestedPlays++;
          if (
            e.type === 'cardsDrawn' &&
            (e.reason === 'modifierDeck' || e.reason === 'modifierGraveyard')
          ) {
            modifierDraws++;
          }
        }
        if (JSON.stringify(roundCardIds(match.round).sort()) !== JSON.stringify(all)) {
          throw new Error(`seed ${seed}: card conservation broken`);
        }
        if (++steps > 20000) throw new Error(`seed ${seed}: match did not terminate`);
      }
      expect(match.status.kind).toBe('matchOver');
    }
    expect(modifierDraws).toBeGreaterThan(300); // non-vacuous: draw modifiers really fire
    // Non-vacuous for R4c-4: traps are armed, trigger and lapse in random play.
    expect(Object.values(trapEvents).every((n) => n > 0)).toBe(true);
    // Non-vacuous for R4c-5: S-19 draws creatures and spells, and the opponent plays the spells.
    expect(gambit.creature).toBeGreaterThan(0);
    expect(gambit.spell).toBeGreaterThan(0);
    expect(gambit.nestedPlays).toBeGreaterThanOrEqual(gambit.spell);
    // Heavy property run: exceeds the 5 s default under full-suite load.
  }, 30_000);
});
