import { expect } from 'vitest';
import { createSeededRng, type Rng, type Seat } from '../../src/index.js';
import {
  COLORS,
  applyCommand,
  roundCardIds,
  createBoard,
  createRoundContext,
  createZones,
  legalCommands,
  resolveSpell,
  type Board,
  type CardCatalog,
  type CardId,
  type Color,
  type CreatureLevel,
  type ModifierKind,
  type RoundCommand,
  type RoundContext,
  type RoundErrorCode,
  type RoundEvent,
  type RoundPhase,
  type RoundState,
} from '../../src/cartignon/index.js';
import { deepFreeze, placeholderCatalog } from './test-fixtures.js';

/**
 * Shared helpers for the spell tests. Placeholder creatures c01..c35 (color order x level 1..5,
 * atk = level * 10; orange-3 [buffSelf, linkUp], blue-4 [nerf, nerf, buffSelf]) and the REAL
 * spells S-01..S-19 as c36..c54 = spell(1..19).
 */

export const catalog = placeholderCatalog();
export const ctx = createRoundContext(catalog);
export const CATALOG_ORDER = createZones(catalog).deck;
export const ALL_SORTED = [...CATALOG_ORDER].sort();

export function id(n: number): CardId {
  return `c${String(n).padStart(2, '0')}`;
}
export function cr(color: Color, level: CreatureLevel): CardId {
  return id(COLORS.indexOf(color) * 5 + level);
}
/** spell(n) is S-0n / S-n. */
export function spell(n: number): CardId {
  return id(35 + n);
}

export const rng = (seed = 1): Rng => createSeededRng(seed);

/** The catalog with other modifiers on some placeholder creatures (same ids). */
export function catalogWithModifiers(
  mods: readonly (readonly [Color, CreatureLevel, readonly ModifierKind[]])[],
): CardCatalog {
  return catalog.map((d) => {
    if (d.kind !== 'creature') return d;
    const hit = mods.find(([color, level]) => d.color === color && d.level === level);
    return hit === undefined ? d : { ...d, modifiers: hit[2] };
  });
}

export interface StateOpts {
  readonly hands: readonly [CardId[], CardId[]];
  readonly stacks?: readonly [CardId[], CardId[]];
  /** Explicit deck (top first); every unplaced card then goes to the graveyard. */
  readonly deck?: CardId[];
  /**
   * Explicit graveyard (with no explicit `deck`): these cards start in the graveyard and every
   * other unplaced card goes to the deck.
   */
  readonly graveyard?: CardId[];
  readonly phase?: RoundPhase;
  readonly p1?: Seat;
  readonly playedThisTurn?: boolean;
  readonly board?: Partial<Pick<Board, 'linkUpPending'>>;
}

/** A round state built from plain data; default phase: seat 0's normal turn. */
export function stateOf(o: StateOpts): RoundState {
  const stacks = o.stacks ?? [[], []];
  const used = new Set([
    ...stacks[0],
    ...stacks[1],
    ...o.hands[0],
    ...o.hands[1],
    ...(o.deck ?? []),
    ...(o.graveyard ?? []),
  ]);
  const rest = CATALOG_ORDER.filter((c) => !used.has(c));
  const board = createBoard({
    deck: o.deck ?? rest,
    graveyard: o.deck === undefined ? (o.graveyard ?? []) : [...(o.graveyard ?? []), ...rest],
    hands: [o.hands[0], o.hands[1]],
    stacks: [stacks[0], stacks[1]],
  });
  return deepFreeze({
    board: { ...board, ...o.board },
    p1: o.p1 ?? 0,
    baseLevel: 1,
    turnNumber: 3,
    playedThisTurn: o.playedThisTurn ?? false,
    phase: o.phase ?? { kind: 'turn', active: 0 },
  });
}

export const ps = (cardId: CardId): RoundCommand => ({ type: 'playSpell', cardId });
export const MULLIGAN: RoundCommand = { type: 'mulligan' };
export const END: RoundCommand = { type: 'endTurn' };

/** Applies a legal command; checks no input mutation, 54-card conservation and JSON state. */
export function apply(
  state: RoundState,
  seat: Seat,
  command: RoundCommand,
  seed = 1,
  context: RoundContext = ctx,
) {
  const before = JSON.stringify(state);
  expect(legalCommands(context, state, seat)).toContainEqual(command);
  const r = applyCommand(context, deepFreeze(state), seat, command, rng(seed));
  if (!r.ok) throw new Error(`unexpected rejection ${r.code}: ${r.message}`);
  expect(JSON.stringify(state)).toBe(before);
  expect(roundCardIds(r.state).sort()).toEqual(ALL_SORTED);
  expect(JSON.parse(JSON.stringify(r.state))).toEqual(r.state);
  return { state: deepFreeze(r.state), events: r.events };
}

/**
 * RD-162: `handCreature` choices are never answered automatically, even with a single option.
 * Applies `command` (as `apply`), then answers every resulting single-option `handCreature` choice
 * with its only option (as the chooser). Returns the final state and all events in order.
 */
export function applyAnsweringSingle(
  state: RoundState,
  seat: Seat,
  command: RoundCommand,
  seed = 1,
  context: RoundContext = ctx,
) {
  let r = apply(state, seat, command, seed, context);
  const events: RoundEvent[] = [...r.events];
  let pending = r.state.pendingChoice;
  while (pending?.kind === 'handCreature' && pending.options.length === 1) {
    const answer: RoundCommand = {
      type: 'chooseSpellOption',
      choiceId: pending.choiceId,
      selection: [...pending.options],
    };
    r = apply(r.state, pending.seat, answer, seed, context);
    events.push(...r.events);
    pending = r.state.pendingChoice;
  }
  return { state: r.state, events };
}

/** Event types without the RD-162 single-option `handCreature` request/answer pair. */
export function typesWithoutHandCreatureChoice(events: readonly RoundEvent[]): string[] {
  return events
    .filter(
      (e) =>
        !(
          (e.type === 'spellChoiceRequested' || e.type === 'spellChoiceMade') &&
          e.kind === 'handCreature'
        ),
    )
    .map((e) => e.type);
}

export function expectReject(
  state: RoundState,
  seat: Seat,
  command: RoundCommand,
  code: RoundErrorCode,
) {
  const before = JSON.stringify(state);
  expect(applyCommand(ctx, state, seat, command, rng())).toMatchObject({ ok: false, code });
  expect(JSON.stringify(state)).toBe(before);
  expect(legalCommands(ctx, state, seat)).not.toContainEqual(command);
}

/**
 * RD-175: resolves `cardId` straight through `resolveSpell` (no play check), as the S-19
 * best-effort path and a defensive caller would: the card leaves `seat`'s hand first.
 */
export function resolveDirect(state: RoundState, seat: Seat, cardId: CardId, seed = 1) {
  const hands = state.board.zones.hands;
  const hand = hands[seat].filter((c) => c !== cardId);
  const board: Board = {
    ...state.board,
    zones: { ...state.board.zones, hands: seat === 0 ? [hand, hands[1]] : [hands[0], hand] },
  };
  return resolveSpell(ctx.cards, board, seat, cardId, rng(seed), state.turnLocks ?? []);
}

export function types(events: readonly RoundEvent[]): string[] {
  return events.map((e) => e.type);
}

/** Two stacks: seat 0 red-1 (10) + red-2 (20); seat 1 blue-1 (10). */
export const STACKS: [CardId[], CardId[]] = [[cr('red', 1), cr('red', 2)], [cr('blue', 1)]];
