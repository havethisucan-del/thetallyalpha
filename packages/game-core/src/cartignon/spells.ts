import type { Rng } from '../rng.js';
import type { Seat } from '../rules.js';
import type { AttachedEffect, Board, CardIndex } from './board.js';
import type { ModifierKind, SpellDef, SpellDrawSource } from './cards.js';
import {
  assertWellFormedChoice,
  autoSelection,
  hidesOptionCount,
  type ChoiceKind,
  type JsonValue,
  type PendingChoice,
  type SpellChoiceRequest,
} from './choices.js';
import {
  createSpellKernel,
  runSecondary,
  type KernelCarry,
  type PlacementSettler,
  type SpellKernel,
  type TurnLock,
} from './kernel.js';
import type { RoundEvent } from './round.js';
import { SPELL_REGISTRY, type SpellHandler, type SpellRegistryEntry } from './spell-handlers.js';
import { armTrap } from './traps.js';
import { findCard, type CardId, type Zones } from './zones.js';

/**
 * Spell resolution (ADR-0007, R4c-1): RD-14 / RD-119 / RD-115 / RD-116.
 *
 *   1. The spell leaves its owner's hand and is "in resolution": in no zone, so it can neither be
 *      drawn back by its own effects nor counted as a hand card (RD-116).
 *   2. `feasible` of its registry handler is evaluated on that board. True -> the Primary runs;
 *      otherwise the Secondary (`SpellDef.secondary`) runs; `none` does nothing (RD-119).
 *   3. If the spell attached an ATK effect to a creature that is still on a stack, the spell card
 *      is attached to it (`Board.attachedSpells`, RD-12); otherwise it goes to the graveyard.
 *      This holds for the Secondary too (RD-153). A stack-level effect (S-15, RD-134) does not
 *      attach the card; it goes to the graveyard.
 *      A trap (S-12, S-16; kernel `armTrap`) is armed instead (`Board.armedTraps`, traps.ts).
 *   4. The player stays on turn (RD-14), unless the Primary requested End Turn (RD-121); the
 *      round layer applies that.
 *
 * S-19 Gambit Prism (R4c-5, RD-112, RD-119, RD-120, RD-121, RD-157..RD-161): its Primary draws
 * a random graveyard card (kernel `drawRandomFromGraveyard`). A creature is placed on the caster's
 * stack (`placeOnStack`). A spell is handed to the opponent (`playForOpponent`), who plays it at
 * once as a nested frame: caster and opponent swap roles, best-effort mode (condition ignored,
 * Primary as far as possible, never the Secondary). The S-19 card waits in no zone (`GambitFrame`
 * in the continuation) until the nested spell has finished, then goes to the graveyard. A nested
 * choice is answered by the nested spell's caster; its turn-ending request ends the current turn;
 * a trap it arms on the seat not on turn is dormant until that turn ends (RD-157).
 *
 * All functions are pure: inputs are never mutated; state is JSON-serializable.
 */

export type SpellBranch = 'primary' | 'secondary';

/**
 * Spell events. HIDDEN INFORMATION (RD-29, RD-114): `cardsDrawn.cardIds`, `cardsLookedAt.cardIds`,
 * `lookedAtSettled.kept/returned`, `handCardsReturned.cardIds` and `spellChoiceMade.selection` of
 * a `keepDrawn` / `handToDeck` choice reveal hidden cards and must be shown to `seat` only
 * (opponent: counts only). Everything else is public (`spellChoiceRequested` carries at most a
 * count, none for `handCreature`, RD-142).
 */
export type SpellEvent =
  | {
      readonly type: 'spellPlayed';
      readonly seat: Seat;
      readonly cardId: CardId;
      readonly branch: SpellBranch;
      /**
       * R4c-5 (RD-112): the S-19 card through which `seat` plays this spell (drawn from the
       * graveyard by the opponent's S-19): best-effort mode, always `primary` (RD-119 exception).
       * Absent for a spell played from the hand.
       */
      readonly playedVia?: CardId;
    }
  | {
      /**
       * R4c-5 (S-19, RD-158): the S-19 `cardId` of `seat` drew `drawnCardId` at random from the
       * graveyard. Public: the card is placed or played at once. Without `drawnCardId` the
       * graveyard was empty and nothing happens.
       */
      readonly type: 'gambitDrawn';
      readonly seat: Seat;
      readonly cardId: CardId;
      readonly drawnCardId?: CardId;
      readonly drawnKind?: 'creature' | 'spell';
    }
  | { readonly type: 'effectAttached'; readonly effect: AttachedEffect }
  | {
      readonly type: 'cardsDrawn';
      readonly seat: Seat;
      readonly reason: 'spellDeck' | 'spellGraveyard';
      readonly cardIds: readonly CardId[];
    }
  | {
      /**
       * Public count summary of one draw primitive (RD-45: counts are visible): `drawn` cards
       * entered `seat`'s hand. Not emitted for an S-01 look-at (`cardsLookedAt`), whose cards
       * reach the hand only through `lookedAtSettled.kept`.
       */
      readonly type: 'spellDrawResolved';
      readonly seat: Seat;
      readonly from: SpellDrawSource;
      readonly requested: number;
      readonly drawn: number;
    }
  | {
      /** RD-111 (S-06): `seat` fires a copy of `kind`, taken from `sourceCardId`. */
      readonly type: 'modifierCopied';
      readonly seat: Seat;
      readonly sourceCardId: CardId;
      readonly kind: ModifierKind;
    }
  | {
      /**
       * RD-114 (S-01): `seat` looks at `cardIds` from the top of the deck (into `Board.lookingAt`,
       * not the hand). HIDDEN: the opponent sees the count only. May be empty (empty deck).
       */
      readonly type: 'cardsLookedAt';
      readonly seat: Seat;
      readonly cardIds: readonly CardId[];
    }
  | {
      /**
       * RD-114 (S-01): looking ends; `kept` entered `seat`'s hand, `returned` went into the deck
       * (shuffled when `deckShuffled`). HIDDEN: opponent sees the counts and `deckShuffled`.
       */
      readonly type: 'lookedAtSettled';
      readonly seat: Seat;
      readonly kept: readonly CardId[];
      readonly returned: readonly CardId[];
      readonly deckShuffled: boolean;
    }
  | {
      /**
       * R4c-2: the spell is suspended until `seat` answers `RoundState.pendingChoice`. Public (the
       * option ids are only in the per-seat pending-choice view). Not emitted for a choice that is
       * answered automatically (single legal answer, ADR-0007 section 4). RD-162: always emitted
       * for kinds that hide their option count (`handCreature`), which are never auto-answered.
       */
      readonly type: 'spellChoiceRequested';
      readonly seat: Seat;
      readonly spellId: string;
      readonly cardId: CardId;
      readonly kind: ChoiceKind;
      /** RD-142: omitted for kinds that hide it (`hidesOptionCount`, i.e. `handCreature`). */
      readonly optionCount?: number;
    }
  | {
      /**
       * R4c-2: `seat` answered choice `choiceId`. HIDDEN for kinds `keepDrawn` and `handToDeck`:
       * the selection is shown to `seat` only.
       */
      readonly type: 'spellChoiceMade';
      readonly seat: Seat;
      readonly choiceId: number;
      readonly kind: ChoiceKind;
      readonly selection: readonly CardId[];
    }
  | {
      /** R4c-3 (S-13, RD-110): cards from `seat`'s hand went to the graveyard. Public. */
      readonly type: 'cardsDiscarded';
      readonly seat: Seat;
      readonly cardIds: readonly CardId[];
    }
  | {
      /**
       * R4c-3 (S-17, RD-110): cards from `seat`'s hand went into the deck. HIDDEN: the ids are
       * shown to `seat` only (opponent: the count).
       */
      readonly type: 'handCardsReturned';
      readonly seat: Seat;
      readonly cardIds: readonly CardId[];
    }
  | {
      /** R4c-3 (S-07, S-17): a spell of `seat` shuffled the deck (round RNG). Public. */
      readonly type: 'deckShuffled';
      readonly seat: Seat;
    }
  | {
      /**
       * R4c-3 (S-09, RD-117): `seat` may not play `cardId` again until the current turn ends
       * (`RoundState.turnLocks`). Public (the card was on the field).
       */
      readonly type: 'replayLocked';
      readonly seat: Seat;
      readonly cardId: CardId;
    }
  | {
      readonly type: 'spellResolved';
      readonly seat: Seat;
      readonly cardId: CardId;
      /** `armed`: a trap (S-12, S-16) now armed on `seat`'s side (R4c-4, `trapArmed` precedes). */
      readonly destination: 'graveyard' | 'attached' | 'armed';
      readonly targetCardId?: CardId;
    };

/** The registry entry of a spell definition, or undefined for an unknown `defId`. */
export function spellEntry(def: SpellDef): SpellRegistryEntry | undefined {
  return Object.hasOwn(SPELL_REGISTRY, def.defId) ? SPELL_REGISTRY[def.defId] : undefined;
}

/** True when the spell can be played in this build (its handler is implemented). */
export function isSpellSupported(def: SpellDef): boolean {
  return spellEntry(def)?.status === 'supported';
}

/**
 * RD-84: true when the spell can draw from the graveyard: its Primary (registry metadata) or its
 * Secondary (data). Spells that are not supported yet (`isSpellSupported`) never count.
 */
export function spellCanDrawFromGraveyard(def: SpellDef): boolean {
  // A spell that cannot be played yet cannot draw anything (review finding 3).
  if (!isSpellSupported(def)) return false;
  const secondary = def.secondary.kind === 'draw' && def.secondary.from === 'graveyard';
  return secondary || spellEntry(def)?.primaryDrawsFromGraveyard === true;
}

/** Step 1: the board with the spell taken out of `seat`'s hand (in resolution). */
function inResolution(board: Board, seat: Seat, cardId: CardId): Board {
  const hands = board.zones.hands;
  const hand = hands[seat].filter((id) => id !== cardId);
  const zones: Zones = { ...board.zones, hands: seat === 0 ? [hand, hands[1]] : [hands[0], hand] };
  return { ...board, zones };
}

function supportedHandler(cards: CardIndex, cardId: CardId) {
  const def = cards[cardId];
  if (def?.kind !== 'spell') throw new Error(`${cardId} is not a spell`);
  const entry = spellEntry(def);
  if (entry?.status !== 'supported') throw new Error(`spell ${def.defId} is not supported`);
  return { def, handler: entry.handler };
}

/**
 * Steps 1-2 without side effects: which branch would run if `seat` played `cardId` now. The card
 * must be a supported spell in `seat`'s hand (checked by the caller).
 */
export function spellBranch(
  cards: CardIndex,
  board: Board,
  seat: Seat,
  cardId: CardId,
  locked: readonly CardId[] = [],
): SpellBranch {
  const { handler } = supportedHandler(cards, cardId);
  const opponent: Seat = seat === 0 ? 1 : 0;
  const view = { cards, board: inResolution(board, seat, cardId), caster: seat, opponent, locked };
  return handler.feasible(view) ? 'primary' : 'secondary';
}

/**
 * The outcome of one spell segment: either the spell finished (`suspended` absent), or it is
 * waiting for a choice (`suspended` set; the round layer turns it into `RoundState.pendingChoice`
 * and assigns the choice id). `endTurnRequested` is meaningful only when finished.
 */
export interface SpellOutcome {
  readonly board: Board;
  readonly events: readonly RoundEvent[];
  readonly endTurnRequested: boolean;
  readonly suspended?: Omit<PendingChoice, 'choiceId'>;
  /** Replay locks made in this segment (S-09); the round layer adds them to `turnLocks`. */
  readonly locks: readonly TurnLock[];
}

/**
 * Kernel and caster data kept in the continuation next to the handler's own scratch, so that a
 * suspend/resume boundary loses nothing. Internal to this module; never projected.
 */
interface ContinuationScratch {
  readonly handler: JsonValue;
  readonly caster: Seat;
  readonly endTurnRequested: boolean;
  readonly attachedTo: CardId | null;
  /** `armTrap` before the suspension (R4c-4). Absent = null. */
  readonly armedOn?: Seat;
  /** R4c-5: the suspended spell was played through S-19 (best-effort mode). Absent = false. */
  readonly bestEffort?: true;
  /** R4c-5: the enclosing S-19 frames, outermost first. Absent = none. */
  readonly via?: readonly GambitFrame[];
}

/**
 * R4c-5 (RD-112, RD-158): an S-19 resolution waiting for the spell it handed to its caster's
 * opponent. The S-19 card stays in no zone until that spell has finished; it then goes to the
 * graveyard. A type alias (not an interface) so it stays assignable to `JsonValue`.
 */
type GambitFrame = { readonly cardId: CardId; readonly caster: Seat };

/** How a spell frame runs: best-effort (through S-19) and its enclosing S-19 frames. */
interface FrameMode {
  readonly bestEffort: boolean;
  readonly via: readonly GambitFrame[];
}

/** Context shared by every frame of one spell segment. */
interface SegmentContext {
  readonly cards: CardIndex;
  readonly rng: Rng;
  readonly onPlacement: PlacementSettler | undefined;
  /** The seat whose turn is in progress: the root caster (RD-157 dormancy). */
  readonly turnSeat: Seat;
  /**
   * RD-145: the replay locks of BOTH seats (`RoundState.turnLocks` plus those made earlier in this
   * segment). A spell played through S-19 has the other seat as caster, whose locks (e.g. from an
   * earlier nested S-09 in the same turn) must hold too.
   */
  readonly locks: readonly TurnLock[];
}

const NORMAL_MODE: FrameMode = { bestEffort: false, via: [] };

/** RD-145: `seat`'s replay-locked cards. */
function lockedFor(sc: SegmentContext, seat: Seat): readonly CardId[] {
  return sc.locks.filter((l) => l.seat === seat).map((l) => l.cardId);
}

function isContinuationScratch(value: JsonValue): value is JsonValue & ContinuationScratch {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'caster' in value;
}

/**
 * R4c-5: every spell card in resolution (in no zone) while `pending` waits: the suspended spell
 * and the S-19 cards whose hand-off it belongs to. Used for card conservation (`roundCardIds`).
 */
export function resolvingCardIds(pending: PendingChoice): CardId[] {
  const scratch = pending.continuation.scratch;
  const via = isContinuationScratch(scratch) ? (scratch.via ?? []) : [];
  return [pending.cardId, ...via.map((f) => f.cardId)];
}

/**
 * Runs the handler's step machine from `first` until it finishes or yields a choice that needs a
 * real answer. A single legal answer is given automatically (ADR-0007 section 4), except for kinds
 * whose option count is hidden (RD-162): suspending only when there were 2+ options would reveal
 * the count to the other seat, so those always suspend.
 */
function drive(
  handler: SpellHandler,
  kernel: SpellKernel,
  first: SpellChoiceRequest | undefined,
): SpellChoiceRequest | undefined {
  let step = first;
  while (step !== undefined) {
    assertWellFormedChoice(step);
    const auto = hidesOptionCount(step.kind) ? null : autoSelection(step);
    if (auto === null) return step;
    if (handler.resume === undefined) throw new Error('spell handler bug: yield without resume');
    step = handler.resume(kernel, step.step, step.scratch, auto);
  }
  return undefined;
}

/**
 * Steps 3-4: puts the finished spell where it belongs and emits `spellResolved`. An armed trap
 * (`armTrap`, R4c-4) goes to `Board.armedTraps` instead (RD-101). RD-157 (R4c-5): a trap armed on
 * the side of the seat NOT on turn (`turnSeat`; only possible through S-19, RD-112) is armed
 * `dormant`: its window is the turn seat's next turn, not the rest of the current one.
 */
function finishSpell(
  done: {
    readonly board: Board;
    readonly attachedTo: CardId | null;
    readonly armedOn: Seat | null;
  },
  seat: Seat,
  cardId: CardId,
  events: RoundEvent[],
  def: SpellDef,
  turnSeat: Seat,
): Board {
  if (done.armedOn !== null) {
    // RD-101 / RD-130: armed on that side, in no zone, visible with identity.
    const armedOn = done.armedOn;
    const dormant = armedOn !== turnSeat ? ({ dormant: true } as const) : {};
    events.push(
      { type: 'trapArmed', seat: armedOn, cardId, spellId: def.defId, ...dormant },
      { type: 'spellResolved', seat, cardId, destination: 'armed' },
    );
    return armTrap(done.board, { cardId, seat: armedOn, spellId: def.defId, ...dormant });
  }
  const target =
    done.attachedTo !== null && findCard(done.board.zones, done.attachedTo)?.zone === 'stack'
      ? done.attachedTo
      : null;
  if (target !== null) {
    // RD-12 / RD-14: an attached spell stays with its creature (graveyard: RD-50 / RD-82).
    events.push({
      type: 'spellResolved',
      seat,
      cardId,
      destination: 'attached',
      targetCardId: target,
    });
    return {
      ...done.board,
      attachedSpells: [...done.board.attachedSpells, { cardId, seat, targetCardId: target }],
    };
  }
  // RD-14: spent spell -> graveyard.
  const zones = done.board.zones;
  events.push({ type: 'spellResolved', seat, cardId, destination: 'graveyard' });
  return { ...done.board, zones: { ...zones, graveyard: [...zones.graveyard, cardId] } };
}

/**
 * R4c-5 (RD-158): the spell of the innermost frame has finished, so every enclosing S-19 frame
 * finishes too, innermost first: each S-19 card goes to the graveyard (S-19 has no Secondary and
 * attaches nothing).
 */
function finishGambitFrames(
  board: Board,
  via: readonly GambitFrame[],
  events: RoundEvent[],
): Board {
  let current = board;
  for (const frame of [...via].reverse()) {
    events.push({
      type: 'spellResolved',
      seat: frame.caster,
      cardId: frame.cardId,
      destination: 'graveyard',
    });
    const zones = current.zones;
    current = { ...current, zones: { ...zones, graveyard: [...zones.graveyard, frame.cardId] } };
  }
  return current;
}

/**
 * Ends a kernel session: packages a suspension, starts the spell an S-19 handed to the opponent
 * (R4c-5, nested frame), or finishes the spell and every enclosing S-19 frame.
 */
function settle(
  sc: SegmentContext,
  def: SpellDef,
  session: ReturnType<typeof createSpellKernel>,
  caster: Seat,
  cardId: CardId,
  yielded: SpellChoiceRequest | undefined,
  mode: FrameMode,
  events: RoundEvent[],
): SpellOutcome {
  const done = session.finish();
  events.push(...done.events);
  if (yielded !== undefined) {
    const scratch: ContinuationScratch = {
      handler: yielded.scratch,
      caster,
      endTurnRequested: done.endTurnRequested,
      attachedTo: done.attachedTo,
      ...(done.armedOn === null ? {} : { armedOn: done.armedOn }),
      ...(mode.bestEffort ? { bestEffort: true } : {}),
      ...(mode.via.length === 0 ? {} : { via: mode.via }),
    };
    return {
      board: done.board,
      events,
      endTurnRequested: false,
      locks: done.locks,
      suspended: {
        // R4c-2: the caster always answers. R4c-5 (RD-160): through S-19 that is the caster of
        // the nested spell, i.e. the S-19 caster's opponent.
        seat: caster,
        spellId: def.defId,
        cardId,
        kind: yielded.kind,
        options: [...yielded.options],
        min: yielded.min,
        max: yielded.max,
        continuation: { step: yielded.step, scratch: { ...scratch } },
      },
    };
  }
  if (done.handedOff !== null) {
    // RD-112: S-19 drew a spell: the opponent plays it at once, best-effort, as its caster. This
    // S-19 frame waits (its card in no zone) until that spell has finished (RD-158).
    const inner = runFrame(
      { ...sc, locks: [...sc.locks, ...done.locks] },
      done.board,
      caster === 0 ? 1 : 0,
      done.handedOff,
      { bestEffort: true, via: [...mode.via, { cardId, caster }] },
      events,
    );
    return {
      ...inner,
      endTurnRequested: inner.endTurnRequested || done.endTurnRequested,
      locks: [...done.locks, ...inner.locks],
    };
  }
  const finished = finishSpell(done, caster, cardId, events, def, sc.turnSeat);
  const board = finishGambitFrames(finished, mode.via, events);
  return { board, events, endTurnRequested: done.endTurnRequested, locks: done.locks };
}

/**
 * Runs one spell frame from its start: `cardId` (already in no zone) is played by `caster`.
 * Normal mode (RD-14 / RD-119): `feasible` picks the Primary or the Secondary. Best-effort mode
 * (through S-19, RD-112 / RD-119 exception): the printed condition is ignored, the Primary always
 * runs and does as much as it can, and the Secondary never runs.
 */
function runFrame(
  sc: SegmentContext,
  board: Board,
  caster: Seat,
  cardId: CardId,
  mode: FrameMode,
  events: RoundEvent[],
): SpellOutcome {
  const { def, handler } = supportedHandler(sc.cards, cardId);
  const opponent: Seat = caster === 0 ? 1 : 0;
  const locked = lockedFor(sc, caster);
  const feasible =
    mode.bestEffort || handler.feasible({ cards: sc.cards, board, caster, opponent, locked });
  const branch: SpellBranch = feasible ? 'primary' : 'secondary';
  const session = createSpellKernel(
    sc.cards,
    board,
    caster,
    cardId,
    sc.rng,
    undefined,
    locked,
    sc.onPlacement,
  );
  const via = mode.via.at(-1);
  events.push({
    type: 'spellPlayed',
    seat: caster,
    cardId,
    branch,
    ...(mode.bestEffort && via !== undefined ? { playedVia: via.cardId } : {}),
  });
  let yielded: SpellChoiceRequest | undefined;
  if (branch === 'primary') {
    yielded = drive(handler, session.kernel, handler.primary(session.kernel));
  } else {
    runSecondary(session.kernel, def.secondary);
  }
  return settle(sc, def, session, caster, cardId, yielded, mode, events);
}

/**
 * Resolves a spell `seat` plays from its hand. The caller (round layer) has validated that the
 * card is a supported spell in `seat`'s hand. `rng` goes to the kernel only (shuffles, graveyard
 * draws, the S-19 pick); handlers never see it. The result may be suspended on a choice
 * (`suspended`). `locks`: the replay locks of both seats (`RoundState.turnLocks`, RD-145); each
 * frame uses its own caster's. `seat` is the seat on turn (spells are only played in the own
 * turn, RD-101).
 */
export function resolveSpell(
  cards: CardIndex,
  board: Board,
  seat: Seat,
  cardId: CardId,
  rng: Rng,
  locks: readonly TurnLock[] = [],
  onPlacement?: PlacementSettler,
): SpellOutcome {
  const sc: SegmentContext = { cards, rng, onPlacement, turnSeat: seat, locks };
  return runFrame(sc, inResolution(board, seat, cardId), seat, cardId, NORMAL_MODE, []);
}

/**
 * Resumes a suspended spell with a validated `selection` for `pending` (R4c-2). The board is the
 * one stored with the pending choice (the spell still in no zone). Emits `spellChoiceMade` first;
 * the handler may finish or yield again (chaining). R4c-5: a spell played through S-19 resumes in
 * best-effort mode and finishes its enclosing S-19 frames when it is done. `locks`: the replay
 * locks of both seats (`RoundState.turnLocks`, RD-145).
 */
export function resumeSpell(
  cards: CardIndex,
  board: Board,
  pending: PendingChoice,
  selection: readonly CardId[],
  rng: Rng,
  locks: readonly TurnLock[] = [],
  onPlacement?: PlacementSettler,
): SpellOutcome {
  const { def, handler } = supportedHandler(cards, pending.cardId);
  const scratch = pending.continuation.scratch;
  if (!isContinuationScratch(scratch)) throw new Error('corrupt spell continuation');
  if (handler.resume === undefined) throw new Error('spell handler bug: no resume entry');
  const via = scratch.via ?? [];
  const sc: SegmentContext = {
    cards,
    rng,
    onPlacement,
    turnSeat: via[0]?.caster ?? scratch.caster,
    locks,
  };
  const carry: KernelCarry = {
    endTurnRequested: scratch.endTurnRequested,
    attachedTo: scratch.attachedTo,
    armedOn: scratch.armedOn ?? null,
  };
  const session = createSpellKernel(
    cards,
    board,
    scratch.caster,
    pending.cardId,
    rng,
    carry,
    lockedFor(sc, scratch.caster),
    onPlacement,
  );
  const events: RoundEvent[] = [
    {
      type: 'spellChoiceMade',
      seat: pending.seat,
      choiceId: pending.choiceId,
      kind: pending.kind,
      selection: [...selection],
    },
  ];
  const next = handler.resume(
    session.kernel,
    pending.continuation.step,
    scratch.handler,
    selection,
  );
  const yielded = drive(handler, session.kernel, next);
  const mode: FrameMode = { bestEffort: scratch.bestEffort === true, via };
  return settle(sc, def, session, scratch.caster, pending.cardId, yielded, mode, events);
}
