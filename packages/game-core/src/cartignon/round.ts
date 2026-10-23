import type { Rng } from '../rng.js';
import type { Seat } from '../rules.js';
import {
  boardCardIds,
  canStack,
  createBoard,
  createCardIndex,
  removeFromStack,
  stackAtk,
  stackCreature,
  type Board,
  type BoardEvent,
  type CardIndex,
} from './board.js';
import {
  parseCatalog,
  type CardCatalog,
  type CatalogIssue,
  type CreatureDef,
  type CreatureLevel,
} from './cards.js';
import {
  enumerateSelections,
  hidesOptionCount,
  isValidSelection,
  MAX_LISTED_SELECTIONS,
  projectPendingChoice,
  type PendingChoice,
  type PendingChoiceView,
} from './choices.js';
import { beats, DEFAULT_COLOR_RULES, type ColorRules } from './colors.js';
import { applyModifierDraws, type PlacementSettler, type TurnLock } from './kernel.js';
import {
  isSpellSupported,
  resolveSpell,
  resolvingCardIds,
  resumeSpell,
  spellEntry,
  type SpellEvent,
  type SpellOutcome,
} from './spells.js';
import { lapseTraps, settlePlacement, wakeDormantTraps, type TrapEvent } from './traps.js';
import {
  createZones,
  dealInitial,
  DEALING_RULES,
  mulligan as zonesMulligan,
  moveCard,
  shuffleDeck,
  type CardId,
} from './zones.js';

/**
 * Round state machine (R3): one round from the P1 Base step up to `roundOver`.
 *
 * Phases (RD-05, RD-62..RD-64), an explicit discriminated union:
 * - `p1Base`      active = P1. Play any creature as the P1 Base Minion (sets `baseLevel`) or
 *                 Mulligan (RD-63). End Turn only if P1 has no creature in hand and cannot
 *                 Mulligan; it ends the round immediately (RD-67, reason `p1NoBase`).
 *                 Placing the Base Minion passes the turn to P2 automatically.
 * - `p2Opening`   active = P2, P2 has no Base Minion yet (RD-64). Nullify (RD-06, RD-27),
 *                 place the P2 Base Minion (RD-07), Mulligan, End Turn (RD-169).
 *                 After the P2 Base Minion is placed the phase becomes `turn` (same turn, P2
 *                 keeps stacking); a nullify returns to `p1Base`.
 * - `turn`        normal alternating turns (P1 response, then P2, P1, ...): play creature (RD-09,
 *                 RD-10; colors irrelevant, RD-08), Mulligan (RD-16, RD-30), End Turn.
 * - `roundOver`   terminal for this layer. Winner, tokens, tie-break and cleanup are R5.
 *
 * End Turn (RD-169; Fold and End Turn are one action, RQ-36) is the only way to end a turn. It is
 * evaluated on the post-lapse board (RD-156): the opponent strictly ahead -> the round ends and the
 * opponent wins (`opponentAhead`); equal ATK, the previous turn also ended at equal ATK and no card
 * was played this turn -> the round ends with the tie-break (`equalStall`, RD-19); otherwise the
 * turn passes. Turn-ending spells (RD-121) and the turn timeout (RD-33) use the same evaluation.
 *
 * Spells (R4c, spells.ts): `playSpell` in every phase except `p1Base` (RD-83); the player stays on
 * turn and the phase does not change (RD-14), unless the spell ends the turn (RD-121); it counts
 * as a play (`playedThisTurn`, RD-88). A stack emptied by a spell takes a new mid-round Base on its
 * owner's next play (RD-105).
 *
 * Pending choice (R4c-2, ADR-0007 section 4): a spell that needs a real answer suspends and the
 * state holds `pendingChoice`. The phase does not change; `activeSeat` is the choosing seat, and
 * `chooseSpellOption` from that seat is the only legal command (everything else: CHOICE_PENDING).
 * After the answer the spell resumes and the turn continues (or ends, RD-121).
 *
 * R4c-3: `turnLocks` (S-09 replay lock, cleared at every turn end), `p1StackTouchedBySpell`
 * (RD-143 Nullify ban) and leaving `p2Opening` when a spell gives P2 a stack (RD-144).
 *
 * R4c-4 (traps.ts): armed traps (`Board.armedTraps`, public, RD-130) trigger on placements of the
 * seat on turn: every normal play and every spell placement is settled by `settlePlacement`.
 * A creature that S-16 returns undoes its play for the phase: no Base step hand-over, no leaving
 * `p2Opening` (RD-155). Lapse (RD-129, RD-156, "lapse first, then decide"): a command that ends a
 * turn first lapses the traps whose window that turn was (armed by the other seat) with their
 * Secondary, and is evaluated on the resulting board; if the round would end, the ending seat's
 * own traps lapse too and the command is evaluated again (`withWindowLapse`). The automatic P1
 * Base step hand-over lapses P2's traps the same way. No lapse creates a choice or looked-at
 * cards, and no round ends with armed traps, so the `roundOver` guards of match.ts hold.
 *
 * R4c-5 (S-19, spells.ts): a spell drawn by S-19 is played by the opponent of the seat on turn; a
 * choice it needs is answered by that opponent (`activeSeat` = the chooser, RD-160), and its
 * turn-ending request ends the turn in progress (RD-121). A trap it arms is dormant until the
 * turn in progress ends (RD-157); `lapseWindow` then opens its window instead of lapsing it.
 *
 * Out of scope: resolution/cleanup/next round (R5, match.ts), adapter/projection (R6),
 * timers/pause (R7, RD-66).
 *
 * All functions are pure: inputs are never mutated; state is JSON-serializable. Rule violations
 * return `{ ok: false, code, message }`; throws are reserved for programmer errors.
 */

/** Definition lookup and color rules: match context, not state (never changes in a match). */
export interface RoundContext {
  readonly cards: CardIndex;
  readonly colorRules: ColorRules;
}

/**
 * Thrown by `createRoundContext` for a catalog whose card data fails the shape check
 * (`parseCatalog`) or that has a spell without a handler registry entry (`roundCatalogIssues`).
 * Typed so callers can tell configuration errors apart; `issues` lists every problem.
 */
export class InvalidCatalogError extends Error {
  readonly issues: readonly CatalogIssue[];
  constructor(issues: readonly CatalogIssue[]) {
    super(`invalid card catalog: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'InvalidCatalogError';
    this.issues = issues;
  }
}

/**
 * Every reason `catalog` cannot be used for a round: shape issues (`parseCatalog`) first; if the
 * shape is fine, spells without an entry in the handler registry (ADR-0007, `UNKNOWN_SPELL`).
 * Deck composition (RD-02) is not checked here (`validateCatalog` / `loadCatalog`).
 */
export function roundCatalogIssues(catalog: CardCatalog): readonly CatalogIssue[] {
  const parsed = parseCatalog(catalog);
  if (!parsed.ok) return parsed.issues;
  return parsed.value
    .filter((d) => d.kind === 'spell' && spellEntry(d) === undefined)
    .map((d) => ({ code: 'UNKNOWN_SPELL', message: `spell ${d.defId} has no handler entry` }));
}

/**
 * Builds the match context. An invalid catalog (`roundCatalogIssues`) throws
 * `InvalidCatalogError`, so rules code never meets malformed card data or an unknown spell.
 */
export function createRoundContext(
  catalog: CardCatalog,
  colorRules: ColorRules = DEFAULT_COLOR_RULES,
): RoundContext {
  const issues = roundCatalogIssues(catalog);
  if (issues.length > 0) throw new InvalidCatalogError(issues);
  return { cards: createCardIndex(catalog), colorRules };
}

/**
 * RD-169 (End Turn; replaces the Fold reasons):
 * - opponentAhead: the seat that ended its turn was strictly behind (RD-69); its opponent wins.
 * - equalStall: equal ATK, the previous turn also ended at equal ATK and the ending seat played
 *   nothing this turn (as old RD-85); R5 runs the tie-break (RD-19).
 * - p1NoBase: RD-67 / RD-163, P1's Base step ended without a Base Minion; draw-type outcome,
 *   R5 applies "no token change". No ATK comparison.
 */
export type RoundOverReason = 'opponentAhead' | 'equalStall' | 'p1NoBase';

export type RoundPhase =
  | { readonly kind: 'p1Base'; readonly active: Seat }
  | {
      readonly kind: 'p2Opening';
      readonly active: Seat;
      /** RD-169: as `turn.equalEndBy` (P2 back in its opening response, RD-79). */
      readonly equalEndBy?: Seat;
    }
  | {
      readonly kind: 'turn';
      readonly active: Seat;
      /**
       * RD-169 (equal-ATK stall): set when this turn was handed over by an End Turn at equal ATK
       * (the ending seat). If the active seat ends this turn without having played a card while
       * ATK is still equal, the round ends with the tie-break (`equalStall`). Absent otherwise.
       */
      readonly equalEndBy?: Seat;
    }
  | {
      readonly kind: 'roundOver';
      readonly reason: RoundOverReason;
      /** The seat whose turn end ended the round. */
      readonly seat: Seat;
      /** Stack ATK per seat at the moment the round ended (input for R5). */
      readonly atk: readonly [number, number];
    };

export interface RoundState {
  readonly board: Board;
  /** RD-04: P1 of this round. */
  readonly p1: Seat;
  /** RD-05: level of the current P1 Base Minion; null while P1 has none. */
  readonly baseLevel: CreatureLevel | null;
  /** Count of turns started this round (the P1 Base step is turn 1). */
  readonly turnNumber: number;
  /**
   * True once the active player has played a card in the current turn (RD-169: only a turn
   * without a play can end the round at equal ATK). A Mulligan does not count as playing (RD-88).
   * Reset whenever a new turn starts.
   */
  readonly playedThisTurn: boolean;
  /**
   * RD-105: set once a spell has emptied a stack this round. From then on an empty stack takes a
   * mid-round Base in a normal turn (never `p2Opening` again, so no more nulling). Absent = false.
   */
  readonly stackEmptiedBySpell?: boolean;
  readonly phase: RoundPhase;
  /**
   * R4c-2: a spell suspended on a choice (ADR-0007 section 4). Absent = none. The resolving spell
   * is in no zone meanwhile. HIDDEN: project it per seat with `pendingChoiceView`; the
   * continuation is never exposed.
   */
  readonly pendingChoice?: PendingChoice;
  /**
   * R4c-2: the id the next pending choice gets; unique per match (the match layer carries it into
   * the next round, RD-141). Deterministic counter, no RNG. Absent = 1.
   */
  readonly nextChoiceId?: number;
  /**
   * R4c-3 (ADR-0007 `turnLocks`, RD-117): cards a seat may not play until the current turn ends
   * (S-09's returned creature): `playCreature` / `nullify` reject them with `CARD_REPLAY_LOCKED`
   * and spells do not place them (RD-145). Cleared whenever a turn ends. Absent = none. Public.
   */
  readonly turnLocks?: readonly TurnLock[];
  /**
   * RD-143: set once a spell has removed, shifted, placed on or changed control of a card in P1's
   * stack this round (any change of that stack by a spell). From then on Nullify is rejected with
   * `NULLIFY_NOT_ALLOWED` for the rest of the round. Absent = false.
   */
  readonly p1StackTouchedBySpell?: boolean;
}

export type RoundCommand =
  | { readonly type: 'playCreature'; readonly cardId: CardId }
  | { readonly type: 'nullify'; readonly cardId: CardId }
  /** RD-14 / RD-83. No target: Secondaries have fixed targets (RD-115). */
  | { readonly type: 'playSpell'; readonly cardId: CardId }
  | { readonly type: 'mulligan' }
  /** RD-169: the single way to end a turn (Fold and End Turn are one action). */
  | { readonly type: 'endTurn' }
  /** R4c-2: the answer to `RoundState.pendingChoice` (the only legal command while it exists). */
  | {
      readonly type: 'chooseSpellOption';
      readonly choiceId: number;
      readonly selection: readonly CardId[];
    };

/**
 * Ordered plain-data events. HIDDEN INFORMATION (RD-29, RD-114): the R6 projection must show
 * these card ids to `seat` only (opponent: counts only):
 * - `cardsDrawn.cardIds` (including the spell draw variant in `SpellEvent`);
 * - `cardsLookedAt.cardIds` and `lookedAtSettled.kept` / `.returned` (S-01);
 * - `spellChoiceMade.selection` when `kind` is `keepDrawn` or `handToDeck`;
 * - `handCardsReturned.cardIds` (S-17).
 * Every other event carries only public data (played cards, board cards, counts);
 * `spellChoiceRequested` omits the count for `handCreature` (RD-142).
 */
export type RoundEvent =
  | { readonly type: 'roundStarted'; readonly p1: Seat }
  | { readonly type: 'handsDealt'; readonly firstSeat: Seat; readonly packetSize: number }
  | {
      readonly type: 'cardsDrawn';
      readonly seat: Seat;
      /**
       * `refill` / `finalDeal` / `redeal` come from the match layer (R5: RD-21, RD-22, RD-76).
       * `modifierDeck` / `modifierGraveyard`: a creature draw modifier went live (RD-98); the
       * preceding `modifierLive` event names the source card. `cardIds` may be empty (RD-48 /
       * RD-23: empty source).
       */
      readonly reason:
        | 'deal'
        | 'mulligan'
        | 'refill'
        | 'finalDeal'
        | 'redeal'
        | 'modifierDeck'
        | 'modifierGraveyard';
      readonly cardIds: readonly CardId[];
    }
  | { readonly type: 'turnStarted'; readonly seat: Seat; readonly turnNumber: number }
  | { readonly type: 'turnEnded'; readonly seat: Seat }
  | {
      readonly type: 'creaturePlayed';
      readonly seat: Seat;
      readonly cardId: CardId;
      /** `midRoundBase`: onto a stack a spell emptied (RD-105). */
      readonly role: 'p1Base' | 'p2Base' | 'stack' | 'midRoundBase';
    }
  | {
      readonly type: 'nullified';
      readonly seat: Seat;
      readonly cardId: CardId;
      readonly nullifiedCardId: CardId;
    }
  | {
      readonly type: 'mulliganed';
      readonly seat: Seat;
      readonly returned: number;
      readonly drawnCount: number;
    }
  | {
      readonly type: 'roundOver';
      readonly reason: RoundOverReason;
      /** The seat whose turn end ended the round (`turnEnded` of that seat precedes). */
      readonly seat: Seat;
      readonly atk: readonly [number, number];
    }
  | SpellEvent
  | TrapEvent
  | BoardEvent;

export type RoundErrorCode =
  | 'ROUND_OVER'
  | 'NOT_YOUR_TURN'
  | 'UNKNOWN_COMMAND'
  | 'NOT_ALLOWED_IN_PHASE'
  | 'UNKNOWN_CARD'
  | 'CARD_NOT_IN_HAND'
  | 'NOT_A_CREATURE'
  | 'NOT_A_SPELL'
  /** The spell's handler belongs to a later milestone (ADR-0007; see `SPELL_REGISTRY`). */
  | 'SPELL_NOT_SUPPORTED'
  | 'LEVEL_NOT_NEXT'
  | 'STACK_EMPTY'
  | 'NULLIFY_COLOR_MISMATCH'
  | 'NULLIFY_NOT_ALLOWED'
  | 'BASE_ALREADY_PLACED'
  | 'BASE_LEVEL_TOO_HIGH'
  | 'BASE_COLOR_BEATEN'
  /** RD-63 / RD-169: End Turn in the P1 Base step while a Base Minion or Mulligan is possible. */
  | 'END_TURN_NOT_ALLOWED'
  | 'MULLIGAN_HAND_TOO_SMALL'
  | 'MULLIGAN_DECK_TOO_SMALL'
  | 'DECK_TOO_SMALL'
  /** R4c-2: a pending choice must be answered first (`chooseSpellOption`). */
  | 'CHOICE_PENDING'
  /** R4c-2: `chooseSpellOption` without a pending choice. */
  | 'NO_PENDING_CHOICE'
  /** R4c-2: `choiceId` is not the pending choice's id (stale or mismatched). */
  | 'CHOICE_ID_MISMATCH'
  /** R4c-2: the selection is not a duplicate-free subset of the options with a size in [min, max]. */
  | 'INVALID_CHOICE'
  /** R4c-3 (S-09, RD-117): the card is replay-locked until the current turn ends (`turnLocks`). */
  | 'CARD_REPLAY_LOCKED';

export interface RoundRejection {
  readonly ok: false;
  readonly code: RoundErrorCode;
  readonly message: string;
}

export type RoundResult =
  | { readonly ok: true; readonly state: RoundState; readonly events: readonly RoundEvent[] }
  | RoundRejection;

type Check = { readonly ok: true } | RoundRejection;

const OK: Check = { ok: true };

function reject(code: RoundErrorCode, message: string): RoundRejection {
  return { ok: false, code, message };
}

function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

function atkOf(ctx: RoundContext, board: Board): readonly [number, number] {
  return [stackAtk(ctx.cards, board, 0), stackAtk(ctx.cards, board, 1)];
}

// ---------------------------------------------------------------------------------------------
// Round start

/**
 * Seam for R5: enters the P1 Base step on an already prepared board (hands dealt). Consumes no
 * randomness. Both stacks must be empty (cleanup is R5's job, RD-20 / RD-58): a non-empty stack
 * is a programmer error and throws. RD-59: an unused armed Link Up does not survive into the new
 * round, so `linkUpPending` is reset.
 */
export function startRound(board: Board, p1: Seat): { state: RoundState; events: RoundEvent[] } {
  if (board.lookingAt !== undefined) {
    throw new Error('startRound requires no looked-at cards (a spell choice was left pending)');
  }
  if ((board.armedTraps?.length ?? 0) > 0) {
    throw new Error('startRound requires no armed traps (they lapse at round end, RD-129)');
  }
  if (board.zones.stacks[0].length > 0 || board.zones.stacks[1].length > 0) {
    throw new Error('startRound requires both stacks to be empty');
  }
  const fresh: { -readonly [K in keyof Board]: Board[K] } = {
    ...board,
    linkUpPending: [false, false],
    linkUpSource: [null, null],
  };
  // RD-109: an S-12 negation never outlives its round (the stacks are empty now).
  delete fresh.negatedModifiers;
  return {
    state: {
      board: fresh,
      p1,
      baseLevel: null,
      turnNumber: 1,
      playedThisTurn: false,
      phase: { kind: 'p1Base', active: p1 },
    },
    events: [
      { type: 'roundStarted', p1 },
      { type: 'turnStarted', seat: p1, turnNumber: 1 },
    ],
  };
}

/**
 * Round 1 of a match: shuffles the deck (RD-02), chooses P1 randomly (RD-04), deals 3 at a time
 * alternately starting with a randomly chosen seat (RD-21, RD-32), then enters the P1 Base step.
 * RNG draw order (part of determinism): shuffle, P1 seat, first-receiving seat.
 */
export function startFirstRound(
  catalog: CardCatalog,
  rng: Rng,
):
  | { readonly ok: true; readonly state: RoundState; readonly events: readonly RoundEvent[] }
  | RoundRejection {
  const shuffled = shuffleDeck(createZones(catalog), rng);
  const p1: Seat = rng.nextInt(2) === 0 ? 0 : 1;
  const firstSeat: Seat = rng.nextInt(2) === 0 ? 0 : 1;
  const dealt = dealInitial(shuffled, firstSeat);
  if (!dealt.ok) return reject('DECK_TOO_SMALL', dealt.message);
  const started = startRound(createBoard(dealt.zones), p1);
  const events: RoundEvent[] = [
    started.events[0] as RoundEvent,
    { type: 'handsDealt', firstSeat, packetSize: DEALING_RULES.initialPacketSize },
    ...([firstSeat, otherSeat(firstSeat)] as const).map((seat): RoundEvent => ({
      type: 'cardsDrawn',
      seat,
      reason: 'deal',
      cardIds: dealt.zones.hands[seat],
    })),
    ...started.events.slice(1),
  ];
  return { ok: true, state: started.state, events };
}

// ---------------------------------------------------------------------------------------------
// Queries

export function phaseOf(state: RoundState): RoundPhase {
  return state.phase;
}

/** The seat that may act (the choosing seat during a pending choice), or null once over. */
export function activeSeat(state: RoundState): Seat | null {
  if (state.phase.kind === 'roundOver') return null;
  return state.pendingChoice?.seat ?? state.phase.active;
}

/**
 * RD-114 / RD-142: what `seat` may see of the pending choice. Null when there is none; the
 * choosing seat gets `{ choiceId, seat, kind, spellId, options, min, max }`, the other seat
 * `{ seat, kind, spellId, optionCount, min, max }`, without `optionCount` for `handCreature`
 * (RD-142). The continuation is never exposed.
 */
export function pendingChoiceView(state: RoundState, seat: Seat): PendingChoiceView | null {
  return projectPendingChoice(state.pendingChoice, seat);
}

/**
 * Every card id of the round: `boardCardIds` plus the spell in resolution while a choice is
 * pending. The 54-card conservation invariant (RD-02) is `roundCardIds(state)` = all instance ids.
 */
export function roundCardIds(state: RoundState): CardId[] {
  // R4c-5: plus the S-19 cards waiting for the nested spell (`resolvingCardIds`).
  const resolving = state.pendingChoice === undefined ? [] : resolvingCardIds(state.pendingChoice);
  return [...boardCardIds(state.board), ...resolving];
}

/** A creature `seat` could place: replay-locked ones (S-09, S-16) do not count (RD-155). */
function hasCreatureInHand(ctx: RoundContext, state: RoundState, seat: Seat): boolean {
  return state.board.zones.hands[seat].some(
    (id) => ctx.cards[id]?.kind === 'creature' && !isReplayLocked(state, seat, id),
  );
}

/** Hand creature lookup shared by playCreature and nullify. */
function handCreature(
  ctx: RoundContext,
  state: RoundState,
  seat: Seat,
  cardId: CardId,
): { readonly ok: true; readonly def: CreatureDef } | RoundRejection {
  const def = ctx.cards[cardId];
  if (def === undefined) return reject('UNKNOWN_CARD', `unknown card ${cardId}`);
  if (!state.board.zones.hands[seat].includes(cardId)) {
    return reject('CARD_NOT_IN_HAND', `${cardId} is not in seat ${seat}'s hand`);
  }
  if (def.kind !== 'creature') return reject('NOT_A_CREATURE', `${cardId} is not a creature`);
  if (isReplayLocked(state, seat, cardId)) {
    return reject('CARD_REPLAY_LOCKED', `${cardId} cannot be played again this turn`);
  }
  return { ok: true, def };
}

/** RD-117 (S-09): `seat` may not play `cardId` until the current turn ends. */
function isReplayLocked(state: RoundState, seat: Seat, cardId: CardId): boolean {
  return state.turnLocks?.some((l) => l.seat === seat && l.cardId === cardId) === true;
}

/**
 * The P1 Base Minion's definition, or undefined when P1's stack is empty. Review finding 4: a
 * spell can change the stacks during `p2Opening`; `afterSpellSegment` then leaves `p2Opening`
 * (RD-144), so callers treat a missing Base defensively instead of throwing.
 */
function p1BaseDef(ctx: RoundContext, state: RoundState): CreatureDef | undefined {
  const id = state.board.zones.stacks[state.p1][0];
  const def = id === undefined ? undefined : ctx.cards[id];
  return def?.kind === 'creature' ? def : undefined;
}

function checkMulligan(state: RoundState, seat: Seat): Check {
  const { hands, deck } = state.board.zones;
  if (hands[seat].length < DEALING_RULES.mulliganMinHand) {
    return reject('MULLIGAN_HAND_TOO_SMALL', `hand has ${hands[seat].length} card(s)`);
  }
  if (deck.length < DEALING_RULES.mulliganMinDeck) {
    return reject('MULLIGAN_DECK_TOO_SMALL', `deck has ${deck.length} card(s)`);
  }
  return OK;
}

function checkPlayCreature(
  ctx: RoundContext,
  state: RoundState,
  seat: Seat,
  cardId: CardId,
): Check {
  const found = handCreature(ctx, state, seat, cardId);
  if (!found.ok) return found;
  const phase = state.phase.kind;
  if (phase === 'p1Base' || phase === 'p2Opening') {
    // Hardening: a Base Minion is only placed on an empty own stack (never reach `mustStack`
    // with an illegal placement).
    if (state.board.zones.stacks[seat].length > 0) {
      return reject('BASE_ALREADY_PLACED', `seat ${seat} already has a Base Minion`);
    }
  }
  if (phase === 'p1Base') return OK; // RD-63: any creature may be the P1 Base Minion.
  if (phase === 'p2Opening') {
    // RD-07 / RD-64: P2 Base Minion: level <= Base Level, color not beaten by P1's Base Minion.
    const p1Base = p1BaseDef(ctx, state);
    // Defensive (RD-144): without a P1 Base there is nothing to answer; any creature is a Base.
    if (p1Base === undefined) return OK;
    if (state.baseLevel === null || found.def.level > state.baseLevel) {
      return reject(
        'BASE_LEVEL_TOO_HIGH',
        `level ${found.def.level} exceeds Base Level ${String(state.baseLevel)}`,
      );
    }
    if (beats(ctx.colorRules, p1Base.color, found.def.color)) {
      return reject('BASE_COLOR_BEATEN', `${found.def.color} is beaten by ${p1Base.color}`);
    }
    return OK;
  }
  // `turn`: normal stacking (RD-08, RD-09, RD-10). An empty own stack is only reachable after a
  // spell emptied it (RD-67 ends the round on a P1 Base-step End Turn): any creature
  // becomes the new Base; RD-07 limits do not apply (RD-105). `canStack` allows that.
  return canStack(ctx.cards, state.board, seat, cardId);
}

function checkNullify(ctx: RoundContext, state: RoundState, seat: Seat, cardId: CardId): Check {
  // RD-34: only P2 nulls, and only in its opening response before it has a Base Minion (RD-64).
  if (state.phase.kind !== 'p2Opening') {
    return reject('NOT_ALLOWED_IN_PHASE', `nullify is not allowed in ${state.phase.kind}`);
  }
  // RD-79: in a reopened opening response (RD-86) Nullify is not allowed once P1's stack holds
  // more than the Base Minion.
  if (state.board.zones.stacks[state.p1].length > 1) {
    return reject('NULLIFY_NOT_ALLOWED', 'P1 has stacked onto its Base Minion');
  }
  // RD-143: once a spell has touched P1's stack this round, Nullify is gone for the round.
  if (state.p1StackTouchedBySpell === true) {
    return reject('NULLIFY_NOT_ALLOWED', "a spell has changed P1's stack this round");
  }
  const found = handCreature(ctx, state, seat, cardId);
  if (!found.ok) return found;
  const p1Base = p1BaseDef(ctx, state);
  if (p1Base === undefined) return reject('NULLIFY_NOT_ALLOWED', 'P1 has no Base Minion');
  // RD-06: any level; the color must beat the P1 Base Minion's color.
  if (!beats(ctx.colorRules, found.def.color, p1Base.color)) {
    return reject('NULLIFY_COLOR_MISMATCH', `${found.def.color} does not beat ${p1Base.color}`);
  }
  return OK;
}

function checkPlaySpell(ctx: RoundContext, state: RoundState, seat: Seat, cardId: CardId): Check {
  // RD-83: spells are always playable except in P1's Base step (creature only, RD-63).
  if (state.phase.kind === 'p1Base') {
    return reject('NOT_ALLOWED_IN_PHASE', 'only a creature may be played in the P1 Base step');
  }
  const def = ctx.cards[cardId];
  if (def === undefined) return reject('UNKNOWN_CARD', `unknown card ${cardId}`);
  if (!state.board.zones.hands[seat].includes(cardId)) {
    return reject('CARD_NOT_IN_HAND', `${cardId} is not in seat ${seat}'s hand`);
  }
  if (def.kind !== 'spell') return reject('NOT_A_SPELL', `${cardId} is not a spell`);
  // RD-14 / RD-119: a supported spell is always playable (Primary or Secondary).
  if (!isSpellSupported(def)) {
    return reject('SPELL_NOT_SUPPORTED', `spell ${def.defId} is not implemented yet`);
  }
  return OK;
}

function checkChoice(
  state: RoundState,
  seat: Seat,
  command: Extract<RoundCommand, { readonly type: 'chooseSpellOption' }>,
): Check {
  const pending = state.pendingChoice;
  if (pending === undefined) return reject('NO_PENDING_CHOICE', 'there is no pending choice');
  if (seat !== pending.seat) return reject('NOT_YOUR_TURN', `seat ${seat} is not choosing`);
  if (command.choiceId !== pending.choiceId) {
    return reject('CHOICE_ID_MISMATCH', `choice ${pending.choiceId} is pending`);
  }
  if (!isValidSelection(pending, command.selection)) {
    return reject('INVALID_CHOICE', 'selection is not a legal answer');
  }
  return OK;
}

/**
 * RD-169: End Turn is legal whenever the seat is on turn without a pending choice (checked by
 * `validateCommand`), also in `p2Opening` and after a play. Only exception, RD-63: in the P1 Base
 * step the Base Minion is mandatory, so End Turn needs no placeable creature and no Mulligan.
 */
function checkEndTurn(ctx: RoundContext, state: RoundState, seat: Seat): Check {
  if (state.phase.kind === 'p1Base') {
    if (hasCreatureInHand(ctx, state, seat) || checkMulligan(state, seat).ok) {
      return reject('END_TURN_NOT_ALLOWED', 'P1 must place a Base Minion or Mulligan');
    }
  }
  return OK;
}

/** Full validation of `command` by `seat`; `applyCommand` accepts exactly what this accepts. */
export function validateCommand(
  ctx: RoundContext,
  state: RoundState,
  seat: Seat,
  command: RoundCommand,
): Check {
  if (state.phase.kind === 'roundOver') return reject('ROUND_OVER', 'the round is over');
  // R4c-2: while a choice is pending, only its answer is legal (from the choosing seat).
  if (state.pendingChoice !== undefined) {
    if (command.type !== 'chooseSpellOption') {
      return reject('CHOICE_PENDING', 'a spell choice must be answered first');
    }
    return checkChoice(state, seat, command);
  }
  if (seat !== state.phase.active) return reject('NOT_YOUR_TURN', `seat ${seat} is not active`);
  switch (command.type) {
    case 'playCreature':
      return checkPlayCreature(ctx, state, seat, command.cardId);
    case 'nullify':
      return checkNullify(ctx, state, seat, command.cardId);
    case 'playSpell':
      return checkPlaySpell(ctx, state, seat, command.cardId);
    case 'mulligan':
      return checkMulligan(state, seat);
    case 'endTurn':
      return checkEndTurn(ctx, state, seat);
    case 'chooseSpellOption':
      return checkChoice(state, seat, command);
    default:
      return reject('UNKNOWN_COMMAND', 'unknown command type');
  }
}

/** Candidate commands per hand card (hand order): playCreature, nullify, playSpell. */
function cardCandidates(ctx: RoundContext, state: RoundState, seat: Seat): RoundCommand[] {
  const candidates: RoundCommand[] = [];
  for (const cardId of state.board.zones.hands[seat]) {
    candidates.push({ type: 'playCreature', cardId }, { type: 'nullify', cardId });
    if (ctx.cards[cardId]?.kind === 'spell') candidates.push({ type: 'playSpell', cardId });
  }
  return candidates;
}

/**
 * Every concrete command `seat` may issue now (for UIs and tests). Order: per hand card (hand
 * order) playCreature, nullify, playSpell; then mulligan, endTurn. During a pending choice:
 * one `chooseSpellOption` per legal selection, at most `MAX_LISTED_SELECTIONS` of them (a bounded
 * prefix for multi-select kinds such as S-17's `handToDeck`; every listed one is legal, and any
 * other selection `isValidSelection` accepts is accepted by `applyCommand` too).
 */
export function legalCommands(ctx: RoundContext, state: RoundState, seat: Seat): RoundCommand[] {
  const pending = state.pendingChoice;
  if (pending !== undefined) {
    // R4c-2: legal selections (`enumerateSelections` order), from the choosing seat only.
    if (state.phase.kind === 'roundOver' || seat !== pending.seat) return [];
    return enumerateSelections(pending, MAX_LISTED_SELECTIONS).map((selection) => ({
      type: 'chooseSpellOption',
      choiceId: pending.choiceId,
      selection,
    }));
  }
  const candidates: RoundCommand[] = [
    ...cardCandidates(ctx, state, seat),
    { type: 'mulligan' },
    { type: 'endTurn' },
  ];
  return candidates.filter((c) => validateCommand(ctx, state, seat, c).ok);
}

// ---------------------------------------------------------------------------------------------
// Transitions

/** ADR-0007 section 4: replay locks (`turnLocks`) are cleared whenever a turn ends. */
function withoutTurnLocks(state: RoundState): RoundState {
  if (state.turnLocks === undefined) return state;
  const rest: { -readonly [K in keyof RoundState]: RoundState[K] } = { ...state };
  delete rest.turnLocks;
  return rest;
}

/**
 * Hands the turn from `from` to the other seat. `equalEndBy` (RD-169) marks a hand-over by an End
 * Turn at equal ATK. Note: an End Turn only passes the turn when the ending seat is not behind, so
 * an endless exchange needs every turn to overtake or to equalise with a play; the equal-ATK stall
 * rule ends the round when nobody plays. Remaining long exchanges are left to the turn timers (R7).
 */
function passTurn(
  input: RoundState,
  from: Seat,
  events: RoundEvent[],
  equalEndBy?: Seat,
): RoundState {
  const state = withoutTurnLocks(input);
  const to = otherSeat(from);
  const turnNumber = state.turnNumber + 1;
  events.push({ type: 'turnEnded', seat: from }, { type: 'turnStarted', seat: to, turnNumber });
  // RD-64: P2 is in its opening response while it has no Base Minion. Besides the normal P1 Base
  // step -> P2 hand-over, this is reached when P2 ended its turn in `p2Opening` with equal ATK
  // (RD-169) and gets the turn back without a Base Minion (RD-79 / RD-86: it replays its opening
  // response; Nullify only while P1's stack holds just the Base Minion, see checkNullify).
  // RD-105: once a spell has emptied a stack, an empty stack means a mid-round Base instead.
  const p2WithoutBase =
    to !== state.p1 &&
    state.board.zones.stacks[to].length === 0 &&
    state.stackEmptiedBySpell !== true;
  const marker = equalEndBy === undefined ? {} : { equalEndBy };
  const phase: RoundPhase =
    state.phase.kind === 'p1Base' || p2WithoutBase
      ? { kind: 'p2Opening', active: to, ...marker }
      : { kind: 'turn', active: to, ...marker };
  return { ...state, turnNumber, playedThisTurn: false, phase };
}

/** A validated normal play, settled with its activation edge and the traps it triggers. */
function mustStack(ctx: RoundContext, state: RoundState, seat: Seat, cardId: CardId, rng: Rng) {
  const r = stackCreature(ctx.cards, state.board, seat, cardId);
  if (!r.ok) throw new Error(`unreachable: validated play rejected (${r.code})`);
  return settlePlacement(ctx.cards, r.board, r.events, seat, cardId, activeOf(state), rng);
}

/** R4c-4: the trap-aware placement settler for the spell kernel (seat on turn = `turnSeat`). */
function placementSettler(ctx: RoundContext, turnSeat: Seat, rng: Rng): PlacementSettler {
  return (board, boardEvents, placer, cardId) =>
    settlePlacement(ctx.cards, board, boardEvents, placer, cardId, turnSeat, rng);
}

/** Adds replay locks to `turnLocks`. */
function withLocks(state: RoundState, locks: readonly TurnLock[]): RoundState {
  if (locks.length === 0) return state;
  return { ...state, turnLocks: [...(state.turnLocks ?? []), ...locks] };
}

/** RD-143: an S-16 trap returned a creature from P1's stack during these events. */
function trapTouchedP1(state: RoundState, events: readonly RoundEvent[]): boolean {
  return events.some(
    (e) => e.type === 'trapTriggered' && e.outcome === 'returned' && e.targetSeat === state.p1,
  );
}

function applyPlayCreature(
  ctx: RoundContext,
  state: RoundState,
  seat: Seat,
  cardId: CardId,
  rng: Rng,
): RoundResult {
  const events: RoundEvent[] = [];
  const placed = mustStack(ctx, state, seat, cardId, rng);
  const def = ctx.cards[cardId] as CreatureDef;
  const kind = state.phase.kind;
  const role =
    kind === 'p1Base'
      ? 'p1Base'
      : kind === 'p2Opening'
        ? 'p2Base'
        : state.board.zones.stacks[seat].length === 0
          ? 'midRoundBase'
          : 'stack';
  events.push({ type: 'creaturePlayed', seat, cardId, role }, ...placed.events);
  let next: RoundState = withLocks(
    { ...state, board: placed.board, playedThisTurn: true },
    placed.locks,
  );
  if (placed.returned) {
    // RD-155: S-16 sent the creature back: the play counts (RD-88) but changes no phase; RD-143.
    if (trapTouchedP1(state, placed.events)) next = { ...next, p1StackTouchedBySpell: true };
    return { ok: true, state: next, events };
  }
  if (kind === 'p1Base') {
    // RD-05 / RD-62: the P1 Base Minion sets the Base Level; the turn passes to P2. That ends
    // P1's turn, so P2's traps lapse (RD-129; armed in `p2Opening` before a Nullify).
    const lapsed = lapseWindow(ctx, next.board, seat, rng);
    events.push(...lapsed.events);
    next = passTurn({ ...next, board: lapsed.board, baseLevel: def.level }, seat, events);
  } else if (kind === 'p2Opening') {
    // RD-64: P2 continues its turn with normal stacking.
    next = { ...next, phase: { kind: 'turn', active: seat } };
  }
  return { ok: true, state: next, events };
}

function applyNullify(
  ctx: RoundContext,
  state: RoundState,
  seat: Seat,
  cardId: CardId,
  rng: Rng,
): RoundResult {
  // RD-06 / RD-27: both cards to the graveyard; P1 plays again as if playing first.
  const events: RoundEvent[] = [];
  const baseId = state.board.zones.stacks[state.p1][0] as CardId;
  events.push({ type: 'nullified', seat, cardId, nullifiedCardId: baseId });
  const r = removeFromStack(ctx.cards, state.board, baseId, { zone: 'graveyard' });
  if (!r.ok) throw new Error(`unreachable: ${r.code}`);
  // RD-79: P1's stack holds only the Base, so no edge can occur; routed for uniformity.
  const removed = applyModifierDraws(r.board, r.events, rng);
  events.push(...removed.events);
  const moved = moveCard(
    removed.board.zones,
    cardId,
    { zone: 'hand', seat },
    { zone: 'graveyard' },
  );
  if (!moved.ok) throw new Error(`unreachable: ${moved.code}`);
  const turnNumber = state.turnNumber + 1;
  events.push({ type: 'turnEnded', seat }, { type: 'turnStarted', seat: state.p1, turnNumber });
  return {
    ok: true,
    state: {
      ...withoutTurnLocks(state),
      board: { ...removed.board, zones: moved.zones },
      baseLevel: null,
      turnNumber,
      playedThisTurn: false,
      phase: { kind: 'p1Base', active: state.p1 },
    },
    events,
  };
}

function applyPlaySpell(
  ctx: RoundContext,
  state: RoundState,
  seat: Seat,
  cardId: CardId,
  rng: Rng,
): RoundResult {
  // RD-14: resolve immediately; the player stays on turn and the phase does not change.
  // RD-88: a spell is a played card (`playedThisTurn`, RD-169 stall rule).
  const r = resolveSpell(
    ctx.cards,
    state.board,
    seat,
    cardId,
    rng,
    state.turnLocks ?? [], // RD-145: both seats' locks (a spell may be played through S-19).
    placementSettler(ctx, seat, rng),
  );
  return afterSpellSegment(ctx, { ...state, playedThisTurn: true }, seat, r, rng);
}

function applyChooseSpellOption(
  ctx: RoundContext,
  state: RoundState,
  selection: readonly CardId[],
  rng: Rng,
): RoundResult {
  // R4c-2: the answer is part of the same spell play (no change to `playedThisTurn`).
  const pending = state.pendingChoice as PendingChoice;
  const r = resumeSpell(
    ctx.cards,
    state.board,
    pending,
    selection,
    rng,
    state.turnLocks ?? [],
    placementSettler(ctx, activeOf(state), rng),
  );
  const rest: { -readonly [K in keyof RoundState]: RoundState[K] } = { ...state };
  delete rest.pendingChoice;
  // The turn belongs to the phase's active seat. R4c-2: also the chooser; R4c-5 (RD-160): not
  // for a spell played through S-19, whose chooser is the opponent of the seat on turn.
  return afterSpellSegment(ctx, rest, activeOf(state), r, rng);
}

/** The phase's active seat; only called outside `roundOver`. */
function activeOf(state: RoundState): Seat {
  if (state.phase.kind === 'roundOver') throw new Error('unreachable: round is over');
  return state.phase.active;
}

/**
 * Applies one spell segment (a play, or a resumed choice) to the round: RD-105 emptied stacks;
 * RD-143 (a changed P1 stack bans Nullify); replay locks (`turnLocks`); a suspension becomes
 * `pendingChoice` (with the next deterministic choice id and a public `spellChoiceRequested`
 * event, RD-142: no count for `handCreature`); a finished spell leaves `p2Opening` when the stacks
 * no longer fit it (RD-144) and may end the turn (RD-121). `seat` is the seat whose turn is in
 * progress.
 */
function afterSpellSegment(
  ctx: RoundContext,
  state: RoundState,
  seat: Seat,
  r: SpellOutcome,
  rng: Rng,
): RoundResult {
  const before = state.board.zones.stacks;
  const after = r.board.zones.stacks;
  const emptied = ([0, 1] as const).some((s) => before[s].length > 0 && after[s].length === 0);
  const events: RoundEvent[] = [...r.events];
  let next: RoundState = { ...state, board: r.board };
  if (emptied) next = { ...next, stackEmptiedBySpell: true };
  // RD-143: any change of P1's stack (removal, shift, placement, control change, swap), and an
  // S-16 trap returning a creature from it (even when the stack ends as it started).
  if (!sameCards(before[state.p1], after[state.p1]) || trapTouchedP1(state, r.events))
    next = { ...next, p1StackTouchedBySpell: true };
  next = withLocks(next, r.locks);
  if (r.suspended !== undefined) {
    const choiceId = state.nextChoiceId ?? 1;
    const pendingChoice: PendingChoice = { choiceId, ...r.suspended };
    const { kind } = pendingChoice;
    events.push({
      type: 'spellChoiceRequested',
      seat: pendingChoice.seat,
      spellId: pendingChoice.spellId,
      cardId: pendingChoice.cardId,
      kind,
      // RD-142: the count would reveal hand contents for `handCreature`; omitted there.
      ...(hidesOptionCount(kind) ? {} : { optionCount: pendingChoice.options.length }),
    });
    return { ok: true, state: { ...next, pendingChoice, nextChoiceId: choiceId + 1 }, events };
  }
  next = leaveStaleOpening(next);
  if (!r.endTurnRequested) return { ok: true, state: next, events };
  // RD-121 / RD-169 (Proposed): the turn in progress ends right after the spell resolved, exactly
  // like End Turn: the trap lapse (RD-156), then the opponent-ahead check (round over) or the
  // hand-over. Legal in every phase a spell can be played in (also `p2Opening`, RD-137).
  const ended = withWindowLapse(ctx, next, seat, rng, (s) => applyEndTurn(ctx, s, seat));
  if (!ended.ok) return ended;
  return { ok: true, state: ended.state, events: [...events, ...ended.events] };
}

function sameCards(a: readonly CardId[], b: readonly CardId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Review finding 4 / RD-144 (Proposed): `p2Opening` means "P2 answers P1's Base without a Base of
 * its own". When a finished spell gives P2 (the active seat) a stack, or leaves P1 without one, the
 * opening response is over: the phase becomes a normal `turn` for P2 (same turn, no End Turn
 * consequences). Nulling is then gone (phase), and the spell-placed creature is P2's Base without
 * RD-07 limits (as a mid-round Base, RD-105).
 */
function leaveStaleOpening(state: RoundState): RoundState {
  if (state.phase.kind !== 'p2Opening') return state;
  const { stacks } = state.board.zones;
  const p2HasStack = stacks[state.phase.active].length > 0;
  const p1HasBase = stacks[state.p1].length > 0;
  if (!p2HasStack && p1HasBase) return state;
  return { ...state, phase: { kind: 'turn', active: state.phase.active } };
}

function applyMulligan(state: RoundState, seat: Seat, rng: Rng): RoundResult {
  // RD-16 / RD-30: does not end the turn and does not change the phase.
  const returned = state.board.zones.hands[seat].length;
  const r = zonesMulligan(state.board.zones, seat, rng);
  if (!r.ok) throw new Error(`unreachable: ${r.code}`);
  return {
    ok: true,
    state: { ...state, board: { ...state.board, zones: r.zones } },
    events: [
      { type: 'mulliganed', seat, returned, drawnCount: r.drawn.length },
      { type: 'cardsDrawn', seat, reason: 'mulligan', cardIds: r.drawn },
    ],
  };
}

/** Ends the round after `seat`'s turn end: `turnEnded`, then `roundOver`. */
function endRound(
  state: RoundState,
  reason: RoundOverReason,
  seat: Seat,
  atk: readonly [number, number],
): RoundResult {
  return {
    ok: true,
    state: { ...withoutTurnLocks(state), phase: { kind: 'roundOver', reason, seat, atk } },
    events: [
      { type: 'turnEnded', seat },
      { type: 'roundOver', reason, seat, atk },
    ],
  };
}

/**
 * RD-169: `seat` ends its turn (End Turn, a turn-ending spell, RD-121, or the turn timeout, RD-33),
 * evaluated on the post-lapse board (`withWindowLapse`, RD-156). Never uses `rng`.
 * - P1 Base step (RD-63 / RD-67 / RD-163): no Base Minion was placed -> the round ends as a draw
 *   (`p1NoBase`), no ATK comparison.
 * - The opponent strictly ahead (RD-69) -> the round ends and the opponent wins (`opponentAhead`).
 * - Equal ATK, this turn was handed over by an End Turn at equal ATK and `seat` played nothing this
 *   turn (a Mulligan is not a play, RD-88) -> the round ends with the tie-break (`equalStall`).
 * - Otherwise the turn passes; at equal ATK the new turn remembers `seat` (`equalEndBy`). P2 without
 *   a Base Minion gets its opening response again on its next turn (RD-79).
 */
function applyEndTurn(ctx: RoundContext, state: RoundState, seat: Seat): RoundResult {
  const atk = atkOf(ctx, state.board);
  const phase = state.phase;
  if (phase.kind === 'p1Base') return endRound(state, 'p1NoBase', seat, atk);
  const opponent = otherSeat(seat);
  if (atk[opponent] > atk[seat]) return endRound(state, 'opponentAhead', seat, atk);
  const equal = atk[0] === atk[1];
  const handedOverEqual =
    (phase.kind === 'turn' || phase.kind === 'p2Opening') && phase.equalEndBy === opponent;
  if (equal && handedOverEqual && !state.playedThisTurn) {
    return endRound(state, 'equalStall', seat, atk);
  }
  const events: RoundEvent[] = [];
  return { ok: true, state: passTurn(state, seat, events, equal ? seat : undefined), events };
}

/**
 * Validates and applies `command` by `seat`. Never throws for rule violations and never mutates
 * `state`. `rng` is consumed only by Mulligan and by graveyard draws (spells and creature
 * drawGrave modifiers, RD-23), always through the round layer or the spell kernel.
 */
export function applyCommand(
  ctx: RoundContext,
  state: RoundState,
  seat: Seat,
  command: RoundCommand,
  rng: Rng,
): RoundResult {
  const check = validateCommand(ctx, state, seat, command);
  if (!check.ok) return check;
  const result = dispatch(ctx, state, seat, command, rng);
  if (
    result.ok &&
    result.state.phase.kind === 'roundOver' &&
    (result.state.board.armedTraps?.length ?? 0) > 0
  ) {
    // RD-129 / RD-156: every round end goes through `withWindowLapse`, which lapses all traps.
    // R4c-5 re-check (RD-157): a dormant trap armed through S-19 is always on the side of the seat
    // NOT on turn, while the ending seat is always the seat on turn, so `lapseWindow` wakes it
    // before the round-end lapse, which then takes it with the ending seat's own traps (RD-159).
    // A spell suspended on a choice never ends the round. So this stays unreachable.
    throw new Error('unreachable: the round ended with armed traps');
  }
  return result;
}

/**
 * R7: whether `seat`'s turn timeout must use the internal timeout skip: `seat` is on turn with no
 * pending choice and End Turn is not legal. Since RD-169 that happens only in P1's Base step while
 * a Base Minion or Mulligan is still possible (RD-63; RD-163). Everywhere else the timeout uses
 * End Turn (RD-169; the old RD-168 `p2Opening` case no longer exists).
 * Not a `RoundCommand`: it is never in `legalCommands` and `applyCommand` cannot reach it.
 */
export function checkTimeoutSkip(ctx: RoundContext, state: RoundState, seat: Seat): Check {
  if (state.phase.kind === 'roundOver') return reject('ROUND_OVER', 'the round is over');
  if (state.pendingChoice !== undefined) {
    return reject('CHOICE_PENDING', 'a spell choice must be answered first');
  }
  if (seat !== state.phase.active) return reject('NOT_YOUR_TURN', `seat ${seat} is not active`);
  if (checkEndTurn(ctx, state, seat).ok) {
    return reject('NOT_ALLOWED_IN_PHASE', 'the timeout uses End Turn here');
  }
  return OK;
}

/**
 * R7 / RD-163: the internal turn-timeout skip of P1's Base step (`checkTimeoutSkip`). The turn ends
 * exactly like an End Turn there (RD-169): through `withWindowLapse` (RD-129 / RD-156), and since
 * the mandatory Base Minion (RD-63) was not played, the round ends like RD-67 (`roundOver` reason
 * `p1NoBase`: draw, no ATK comparison, no token change). Events: `turnEnded`, then `roundOver`
 * (`seat` = the skipped seat). Server-only entry point (the Cartignon adapter's internal
 * `timeoutSkip` action); never mutates `state`.
 */
export function applyTimeoutSkip(
  ctx: RoundContext,
  state: RoundState,
  seat: Seat,
  rng: Rng,
): RoundResult {
  const check = checkTimeoutSkip(ctx, state, seat);
  if (!check.ok) return check;
  return withWindowLapse(ctx, state, seat, rng, (s) => applyEndTurn(ctx, s, seat));
}

function dispatch(
  ctx: RoundContext,
  state: RoundState,
  seat: Seat,
  command: RoundCommand,
  rng: Rng,
): RoundResult {
  switch (command.type) {
    case 'playCreature':
      return applyPlayCreature(ctx, state, seat, command.cardId, rng);
    case 'nullify':
      return withWindowLapse(ctx, state, seat, rng, (s) =>
        applyNullify(ctx, s, seat, command.cardId, rng),
      );
    case 'playSpell':
      return applyPlaySpell(ctx, state, seat, command.cardId, rng);
    case 'mulligan':
      return applyMulligan(state, seat, rng);
    case 'endTurn':
      return withWindowLapse(ctx, state, seat, rng, (s) => applyEndTurn(ctx, s, seat));
    case 'chooseSpellOption':
      return applyChooseSpellOption(ctx, state, command.selection, rng);
  }
}

/**
 * RD-129: the traps whose window is `endingSeat`'s turn (armed by the other seat) lapse because
 * that turn ends: each goes to the graveyard and its Secondary fires. No choice can result.
 * RD-157 (R4c-5): a dormant trap (armed through S-19 during this turn) is not lapsed; its window
 * opens instead (`wakeDormantTraps`): `endingSeat`'s next turn.
 */
function lapseWindow(
  ctx: RoundContext,
  board: Board,
  endingSeat: Seat,
  rng: Rng,
): { readonly board: Board; readonly events: readonly RoundEvent[] } {
  const expired = (board.armedTraps ?? []).filter(
    (t) => t.seat !== endingSeat && t.dormant !== true,
  );
  const lapsed =
    expired.length === 0
      ? { board, events: [] as readonly RoundEvent[] }
      : lapseTraps(ctx.cards, board, expired, rng);
  const woken = wakeDormantTraps(lapsed.board, endingSeat);
  return { board: woken.board, events: [...lapsed.events, ...woken.events] };
}

/**
 * RD-129 / RD-156 (lapse first, then decide): every command that ends `endingSeat`'s turn (End
 * Turn, Nullify, a turn-ending spell, RD-121, the timeout skip) first lapses the traps whose window
 * this turn is (`lapseWindow`). Only then is the command evaluated, so the RD-169 ATK checks see
 * the post-lapse board.
 *
 * If that evaluation ends the round while traps are still armed (`endingSeat`'s own, armed in this
 * turn, and RD-157 traps armed through S-19 this turn, just woken by `lapseWindow`; the window of
 * both, a next turn, never comes), those lapse too and the command is evaluated
 * once more on the resulting board; that second evaluation is final, so the `roundOver` ATK
 * snapshot, the RD-169 decision and R5's winner all use the same post-lapse board. When the
 * second evaluation does not end the round (an S-16 lapse nerf made ATK equal: the turn passes),
 * the lapse still stands. Lapse events precede the command's own events. Only End Turn
 * (`applyEndTurn`) can end the round, so only it is ever evaluated twice, and it does not use
 * `rng`; evaluating twice does not change the random sequence. (Nullify does draw through
 * `applyModifierDraws`, but it never ends the round, so it is evaluated once.)
 */
function withWindowLapse(
  ctx: RoundContext,
  state: RoundState,
  endingSeat: Seat,
  rng: Rng,
  apply: (state: RoundState) => RoundResult,
): RoundResult {
  const window = lapseWindow(ctx, state.board, endingSeat, rng);
  const first = apply({ ...state, board: window.board });
  if (!first.ok) return first;
  const own = window.board.armedTraps ?? [];
  if (own.length === 0 || first.state.phase.kind !== 'roundOver') {
    return { ok: true, state: first.state, events: [...window.events, ...first.events] };
  }
  const roundEnd = lapseTraps(ctx.cards, window.board, own, rng);
  const second = apply({ ...state, board: roundEnd.board });
  if (!second.ok) return second;
  return {
    ok: true,
    state: second.state,
    events: [...window.events, ...roundEnd.events, ...second.events],
  };
}
