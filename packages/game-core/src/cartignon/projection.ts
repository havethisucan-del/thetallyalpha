import type { Seat } from '../rules.js';
import {
  activeModifierOf,
  isCopyLive,
  stackAtk,
  type AttachedEffect,
  type CopiedModifier,
  type LiveModifier,
  type StackEffect,
} from './board.js';
import type { CardCatalog, CreatureLevel, ModifierKind } from './cards.js';
import type { ChoiceKind, PendingChoiceView } from './choices.js';
import { COLORS, type Color } from './colors.js';
import type {
  MatchEndReason,
  MatchEvent,
  CartignonMatchState,
  MatchStatus,
  RoundOutcome,
} from './match.js';
import {
  activeSeat,
  legalCommands,
  pendingChoiceView,
  validateCommand,
  type RoundCommand,
  type RoundContext,
  type RoundEvent,
  type RoundOverReason,
  type RoundPhase,
  type RoundState,
} from './round.js';
import { isSpellSupported, spellBranch, type SpellBranch, type SpellEvent } from './spells.js';
import { createCardInstances, type CardId } from './zones.js';

/**
 * R6: per-seat projection of a Cartignon match (ADR-0004 per-seat views, RD-29, RD-45, RD-114,
 * RD-142). Everything here is ALLOWLIST-BUILT: every output object is a new object built field by
 * field; state objects are never spread or passed through. Hidden information:
 *
 * | Data                                         | Owner             | Opponent              |
 * |----------------------------------------------|-------------------|-----------------------|
 * | rngState, nextChoiceId, nextEffectSeq,       | -                 | -                     |
 * | choice continuation / scratch                |                   |                       |
 * | deck order / ids                             | count             | count                 |
 * | graveyard contents (ordered, oldest first)   | public            | public                |
 * | hand, lookingAt                              | ids               | count                 |
 * | pending choice                               | pendingChoiceView | seat/kind/spellId/min/ |
 * |                                              |                   | max (+optionCount)    |
 * | stacks, attachments, traps, locks, negations | public            | public                |
 * | legal commands                               | acting seat only  | -                     |
 * | spell hints (own hand spells)                | own               | -                     |
 *
 * Events: the opponent of the event's `seat` gets counts instead of ids for `cardsDrawn`,
 * `cardsLookedAt`, `lookedAtSettled`, `spellChoiceMade` (kinds `keepDrawn` / `handToDeck`) and
 * `handCardsReturned`. Every other event carries only public data and is copied as is.
 */

// ---------------------------------------------------------------------------------------------
// Public view

/** Public card data per definition (the client needs `modifiers[]` to explain liveness). */
export type CartignonCardSummary =
  | {
      readonly kind: 'creature';
      readonly color: Color;
      readonly level: CreatureLevel;
      readonly atk: number;
      readonly modifiers: readonly ModifierKind[];
    }
  | { readonly kind: 'spell'; readonly name: string };

export type CartignonPhaseView =
  | { readonly kind: 'p1Base'; readonly active: Seat }
  | { readonly kind: 'p2Opening'; readonly active: Seat; readonly equalEndBy: Seat | null }
  | { readonly kind: 'turn'; readonly active: Seat; readonly equalEndBy: Seat | null }
  | {
      readonly kind: 'roundOver';
      readonly reason: RoundOverReason;
      readonly seat: Seat;
      readonly atk: readonly [number, number];
    };

export interface CartignonPublicView {
  readonly match: {
    readonly roundNumber: number;
    readonly tokens: Readonly<Record<Color, Seat | null>>;
    readonly finalRound: boolean;
    readonly replays: number;
    readonly status: MatchStatus;
    readonly lastOutcome: RoundOutcome | null;
  };
  readonly round: {
    readonly p1: Seat;
    readonly phase: CartignonPhaseView;
    readonly baseLevel: CreatureLevel | null;
    readonly turnNumber: number;
    readonly playedThisTurn: boolean;
    readonly stackEmptiedBySpell: boolean;
    readonly p1StackTouchedBySpell: boolean;
    readonly turnLocks: readonly { readonly seat: Seat; readonly cardId: CardId }[];
  };
  readonly board: {
    readonly stacks: readonly [readonly CardId[], readonly CardId[]];
    readonly attachedEffects: readonly AttachedEffect[];
    readonly attachedSpells: readonly {
      readonly cardId: CardId;
      readonly seat: Seat;
      readonly targetCardId: CardId;
    }[];
    readonly stackEffects: readonly StackEffect[];
    /** RD-133: `live` is derived (no event reports it). */
    readonly copiedModifiers: readonly (CopiedModifier & { readonly live: boolean })[];
    readonly linkUp: {
      readonly pending: readonly [boolean, boolean];
      readonly source: readonly [CardId | null, CardId | null];
    };
    /** RD-130: armed traps are fully public. */
    readonly armedTraps: readonly {
      readonly cardId: CardId;
      readonly seat: Seat;
      readonly spellId: string;
      readonly dormant: boolean;
    }[];
    readonly negatedModifiers: readonly { readonly cardId: CardId; readonly position: number }[];
  };
  /** Per seat the modifier that actually takes effect (S-12 negation aware). */
  readonly liveModifiers: readonly LiveModifier[];
  readonly atk: readonly [number, number];
  readonly handCounts: readonly [number, number];
  readonly deckCount: number;
  readonly graveyardCount: number;
  /**
   * The shared graveyard, in order (oldest first; the last entry is the most recent). Public: every
   * card reaches it face up (played, nullified, discarded, cleaned up). Map ids with `cardDefs`.
   */
  readonly graveyard: readonly CardId[];
  readonly lookingAt: { readonly seat: Seat; readonly count: number } | null;
  /** Instance id -> definition id for all cards (ids are assigned in catalog order, public). */
  readonly cardDefs: Readonly<Record<CardId, string>>;
  /** Definition id -> public card data. */
  readonly defs: Readonly<Record<string, CartignonCardSummary>>;
}

export interface CartignonPrivateView {
  readonly seat: Seat;
  readonly hand: readonly CardId[];
  /** Own looked-at cards (S-01), null when this seat is not looking at cards. */
  readonly lookingAt: readonly CardId[] | null;
  readonly pendingChoiceView: PendingChoiceView | null;
  /** Legal commands of the acting seat (empty for the other seat). */
  readonly legal: readonly RoundCommand[];
  /** One entry per spell in the own hand (hand order), see `SpellHint`. */
  readonly spellHints: readonly SpellHint[];
}

/**
 * Which effect a spell in the own hand would fire if cast now, from the engine's own condition
 * check (`spellBranch`, the same `feasible` the resolution uses; RD-14 / RD-119, RD-116: counted
 * without the spell itself). A trap (S-12, S-16) always reports `primary` (it arms).
 * - `branch`: `primary` / `secondary`; null only for a spell this build cannot play.
 * - `castable`: `playSpell` with this card is legal right now (own turn, no pending choice, not the
 *   P1 Base step, RD-83).
 * - `reason`: the rejection code when not castable (e.g. `NOT_YOUR_TURN`, `NOT_ALLOWED_IN_PHASE`,
 *   `CHOICE_PENDING`, `SPELL_NOT_SUPPORTED`, `MATCH_OVER`), else null.
 * `branch` is reported even when not castable (it is what would fire on the current board).
 */
export interface SpellHint {
  readonly cardId: CardId;
  readonly branch: SpellBranch | null;
  readonly castable: boolean;
  readonly reason: string | null;
}

/** Precomputed, catalog-derived public tables. */
export interface CartignonCardTables {
  readonly cardDefs: Readonly<Record<CardId, string>>;
  readonly defs: Readonly<Record<string, CartignonCardSummary>>;
}

export function buildCardTables(catalog: CardCatalog): CartignonCardTables {
  const cardDefs: Record<CardId, string> = {};
  for (const instance of createCardInstances(catalog)) cardDefs[instance.id] = instance.defId;
  const defs: Record<string, CartignonCardSummary> = {};
  for (const def of catalog) {
    defs[def.defId] =
      def.kind === 'creature'
        ? {
            kind: 'creature',
            color: def.color,
            level: def.level,
            atk: def.atk,
            modifiers: [...def.modifiers],
          }
        : { kind: 'spell', name: def.name };
  }
  return { cardDefs, defs };
}

function pair<T>(a: T, b: T): readonly [T, T] {
  return [a, b];
}

function phaseView(phase: RoundPhase): CartignonPhaseView {
  switch (phase.kind) {
    case 'p1Base':
      return { kind: 'p1Base', active: phase.active };
    case 'p2Opening':
    case 'turn':
      return { kind: phase.kind, active: phase.active, equalEndBy: phase.equalEndBy ?? null };
    case 'roundOver':
      return {
        kind: 'roundOver',
        reason: phase.reason,
        seat: phase.seat,
        atk: pair(phase.atk[0], phase.atk[1]),
      };
  }
}

function statusView(status: MatchStatus): MatchStatus {
  if (status.kind === 'playing') return { kind: 'playing' };
  const reason: MatchEndReason = status.reason;
  return {
    kind: 'matchOver',
    reason,
    winner: status.winner,
    tokenCounts: pair(status.tokenCounts[0], status.tokenCounts[1]),
  };
}

function outcomeView(outcome: RoundOutcome | null): RoundOutcome | null {
  if (outcome === null) return null;
  const atk = pair(outcome.atk[0], outcome.atk[1]);
  if (outcome.kind === 'win') {
    return {
      kind: 'win',
      winner: outcome.winner,
      decidedBy: outcome.decidedBy,
      atk,
      tieBreakIterations: outcome.tieBreakIterations,
    };
  }
  return {
    kind: 'draw',
    reason: outcome.reason,
    atk,
    tieBreakIterations: outcome.tieBreakIterations,
  };
}

function effectView(e: AttachedEffect): AttachedEffect {
  return {
    effectId: e.effectId,
    kind: e.kind,
    amount: e.amount,
    sourceCardId: e.sourceCardId,
    targetCardId: e.targetCardId,
  };
}

function stackEffectView(e: StackEffect): StackEffect {
  return {
    effectId: e.effectId,
    kind: e.kind,
    seat: e.seat,
    amount: e.amount,
    sourceCardId: e.sourceCardId,
  };
}

function liveView(m: LiveModifier): LiveModifier {
  return { seat: m.seat, cardId: m.cardId, kind: m.kind, position: m.position };
}

/** Information both seats may see. */
export function projectCartignonPublic(
  ctx: RoundContext,
  tables: CartignonCardTables,
  match: CartignonMatchState,
): CartignonPublicView {
  const round = match.round;
  const board = round.board;
  const zones = board.zones;
  const tokens = {} as Record<Color, Seat | null>;
  for (const color of COLORS) tokens[color] = match.tokens[color];
  const liveModifiers: LiveModifier[] = [];
  for (const seat of [0, 1] as const) {
    const live = activeModifierOf(ctx.cards, board, seat);
    if (live !== null) liveModifiers.push(liveView(live));
  }
  const lookingAt = board.lookingAt;
  return {
    match: {
      roundNumber: match.roundNumber,
      tokens,
      finalRound: match.finalRound,
      replays: match.replays,
      status: statusView(match.status),
      lastOutcome: outcomeView(match.lastOutcome),
    },
    round: {
      p1: round.p1,
      phase: phaseView(round.phase),
      baseLevel: round.baseLevel,
      turnNumber: round.turnNumber,
      playedThisTurn: round.playedThisTurn,
      stackEmptiedBySpell: round.stackEmptiedBySpell === true,
      p1StackTouchedBySpell: round.p1StackTouchedBySpell === true,
      turnLocks: (round.turnLocks ?? []).map((l) => ({ seat: l.seat, cardId: l.cardId })),
    },
    board: {
      stacks: pair([...zones.stacks[0]], [...zones.stacks[1]]),
      attachedEffects: board.attachedEffects.map(effectView),
      attachedSpells: board.attachedSpells.map((s) => ({
        cardId: s.cardId,
        seat: s.seat,
        targetCardId: s.targetCardId,
      })),
      stackEffects: board.stackEffects.map(stackEffectView),
      copiedModifiers: board.copiedModifiers.map((m) => ({
        effectId: m.effectId,
        kind: m.kind,
        carrierCardId: m.carrierCardId,
        sourceCardId: m.sourceCardId,
        live: isCopyLive(board, m),
      })),
      linkUp: {
        pending: pair(board.linkUpPending[0], board.linkUpPending[1]),
        source: pair(board.linkUpSource[0], board.linkUpSource[1]),
      },
      armedTraps: (board.armedTraps ?? []).map((t) => ({
        cardId: t.cardId,
        seat: t.seat,
        spellId: t.spellId,
        dormant: t.dormant === true,
      })),
      negatedModifiers: (board.negatedModifiers ?? []).map((n) => ({
        cardId: n.cardId,
        position: n.position,
      })),
    },
    liveModifiers,
    atk: pair(stackAtk(ctx.cards, board, 0), stackAtk(ctx.cards, board, 1)),
    handCounts: pair(zones.hands[0].length, zones.hands[1].length),
    deckCount: zones.deck.length,
    graveyardCount: zones.graveyard.length,
    graveyard: [...zones.graveyard],
    lookingAt:
      lookingAt === undefined ? null : { seat: lookingAt.seat, count: lookingAt.cardIds.length },
    cardDefs: { ...tables.cardDefs },
    defs: { ...tables.defs },
  };
}

// ---------------------------------------------------------------------------------------------
// Private view

function choiceView(view: PendingChoiceView | null): PendingChoiceView | null {
  if (view === null) return null;
  if ('options' in view) {
    return {
      choiceId: view.choiceId,
      seat: view.seat,
      kind: view.kind,
      spellId: view.spellId,
      options: [...view.options],
      min: view.min,
      max: view.max,
    };
  }
  const base = { seat: view.seat, kind: view.kind, spellId: view.spellId };
  return view.optionCount === undefined
    ? { ...base, min: view.min, max: view.max }
    : { ...base, optionCount: view.optionCount, min: view.min, max: view.max };
}

function commandView(c: RoundCommand): RoundCommand {
  switch (c.type) {
    case 'playCreature':
    case 'nullify':
    case 'playSpell':
      return { type: c.type, cardId: c.cardId };
    case 'mulligan':
    case 'endTurn':
      return { type: c.type };
    case 'chooseSpellOption':
      return { type: c.type, choiceId: c.choiceId, selection: [...c.selection] };
  }
}

/** `SpellHint`s for the spells in `seat`'s hand (hand order). */
export function spellHints(
  ctx: RoundContext,
  round: RoundState,
  seat: Seat,
  matchOver: boolean,
): SpellHint[] {
  const locked = (round.turnLocks ?? []).filter((l) => l.seat === seat).map((l) => l.cardId);
  const hints: SpellHint[] = [];
  for (const cardId of round.board.zones.hands[seat]) {
    const def = ctx.cards[cardId];
    if (def?.kind !== 'spell') continue;
    const branch = isSpellSupported(def)
      ? spellBranch(ctx.cards, round.board, seat, cardId, locked)
      : null;
    const check = matchOver
      ? { ok: false as const, code: 'MATCH_OVER' }
      : validateCommand(ctx, round, seat, { type: 'playSpell', cardId });
    hints.push({
      cardId,
      branch,
      castable: check.ok,
      reason: check.ok ? null : check.code,
    });
  }
  return hints;
}

/** Information only `seat` may see (its own hidden data). */
export function projectCartignonPrivate(
  ctx: RoundContext,
  match: CartignonMatchState,
  seat: Seat,
): CartignonPrivateView {
  const round = match.round;
  const lookingAt = round.board.lookingAt;
  const acting = match.status.kind === 'playing' && activeSeat(round) === seat;
  return {
    seat,
    hand: [...round.board.zones.hands[seat]],
    lookingAt: lookingAt?.seat === seat ? [...lookingAt.cardIds] : null,
    pendingChoiceView: choiceView(pendingChoiceView(round, seat)),
    legal: acting ? legalCommands(ctx, round, seat).map(commandView) : [],
    spellHints: spellHints(ctx, round, seat, match.status.kind !== 'playing'),
  };
}

// ---------------------------------------------------------------------------------------------
// Events

type DrawReason = Extract<RoundEvent | SpellEvent, { type: 'cardsDrawn' }>['reason'];

/** The opponent's redacted versions of the hidden-information events (ids -> counts). */
export type RedactedCartignonEvent =
  | {
      readonly type: 'cardsDrawn';
      readonly seat: Seat;
      readonly reason: DrawReason;
      readonly count: number;
    }
  | { readonly type: 'cardsLookedAt'; readonly seat: Seat; readonly count: number }
  | {
      readonly type: 'lookedAtSettled';
      readonly seat: Seat;
      readonly keptCount: number;
      readonly returnedCount: number;
      readonly deckShuffled: boolean;
    }
  | {
      readonly type: 'spellChoiceMade';
      readonly seat: Seat;
      readonly choiceId: number;
      readonly kind: ChoiceKind;
      readonly selectionCount: number;
    }
  | { readonly type: 'handCardsReturned'; readonly seat: Seat; readonly count: number };

/** An event as one seat receives it. */
export type CartignonSeatEvent = MatchEvent | RedactedCartignonEvent;

/** Kinds whose `spellChoiceMade.selection` is hidden from the other seat. */
function hidesSelection(kind: ChoiceKind): boolean {
  return kind === 'keepDrawn' || kind === 'handToDeck';
}

function redact(event: MatchEvent, viewer: Seat): CartignonSeatEvent | null {
  switch (event.type) {
    case 'cardsDrawn':
      if (event.seat === viewer) return null;
      return {
        type: 'cardsDrawn',
        seat: event.seat,
        reason: event.reason,
        count: event.cardIds.length,
      };
    case 'cardsLookedAt':
      if (event.seat === viewer) return null;
      return { type: 'cardsLookedAt', seat: event.seat, count: event.cardIds.length };
    case 'lookedAtSettled':
      if (event.seat === viewer) return null;
      return {
        type: 'lookedAtSettled',
        seat: event.seat,
        keptCount: event.kept.length,
        returnedCount: event.returned.length,
        deckShuffled: event.deckShuffled,
      };
    case 'spellChoiceMade':
      if (event.seat === viewer || !hidesSelection(event.kind)) return null;
      return {
        type: 'spellChoiceMade',
        seat: event.seat,
        choiceId: event.choiceId,
        kind: event.kind,
        selectionCount: event.selection.length,
      };
    case 'handCardsReturned':
      if (event.seat === viewer) return null;
      return { type: 'handCardsReturned', seat: event.seat, count: event.cardIds.length };
    default:
      return null;
  }
}

/**
 * The events `viewer` may see: hidden-information events of the other seat redacted to counts,
 * everything else copied (plain JSON copy, so no state object is shared with the output).
 */
export function projectCartignonEvents(
  events: readonly MatchEvent[],
  viewer: Seat,
): CartignonSeatEvent[] {
  return events.map(
    (event) => redact(event, viewer) ?? (JSON.parse(JSON.stringify(event)) as MatchEvent),
  );
}
