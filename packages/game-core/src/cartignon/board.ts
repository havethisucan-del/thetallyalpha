import type { Seat } from '../rules.js';
import {
  LEADER_MODIFIER_AMOUNT,
  type CardCatalog,
  type CardDef,
  type ModifierKind,
} from './cards.js';
import {
  allCardIds,
  createCardInstances,
  findCard,
  moveCard,
  type CardId,
  type ZoneRef,
  type Zones,
} from './zones.js';

/**
 * Board layer (R2): stacking legality (RD-09, RD-10), positional modifiers under the silenced
 * model (RD-47, RD-53, RD-54), attached effects (RD-12, RD-50, RD-55) and ATK (RD-18, RD-37,
 * RD-44).
 *
 * Silenced model (RD-53, RD-97): the modifier of a card at stack position p >= 1 is
 * `modifiers[p - 1]`; it is LIVE iff the card is the Leading Minion (top) of its stack. Position 0
 * (Base Minion) is never live (RD-35). Liveness is DERIVED from the stacks at read time; buff/nerf
 * are never stored as state, so nothing can accumulate.
 *
 * Activation edge (ADR-0007 section 4): a live modifier is identified by (seat, cardId,
 * position), i.e. by the Leading card and its position. `settleLiveness` compares the live set
 * before and after every stack change; a `modifierLive` event is exactly an activation edge (a
 * new Leading card, or the same card at a new position after a shift, RD-105). One-shot kinds act
 * on that edge: Link Up arms `linkUpPending` (RD-10, stays armed until used, RD-51, but lapses
 * when its granting creature leaves the field, RD-139), and
 * drawDeck / drawGrave are executed by the round layer, which owns the RNG (RD-98,
 * `applyModifierDraws` in kernel.ts). Re-activation after the card above leaves is a new edge, so
 * it fires again (RD-57, RD-60, RD-98).
 *
 * Out of scope here (phase layer, later milestones): Opening Loop / Base Minion constraints
 * (RD-05..RD-07), color checks (RD-08: color plays no role in stacking), spells, combat, cleanup.
 *
 * All functions are pure: they never mutate their inputs and return new JSON-serializable state.
 * Rule violations return `{ ok: false, code, message }`; throws are reserved for programmer errors.
 */

/**
 * An effect attached to a creature for the rest of the round (RD-12). Only spells create these
 * (RD-55, R4); nothing in R2 does. Discriminated on `kind` so R4 can add further kinds.
 */
export type AttachedEffect = {
  readonly effectId: string;
  readonly kind: 'atkDelta';
  readonly amount: number;
  readonly sourceCardId: CardId;
  readonly targetCardId: CardId;
};

/**
 * A played spell card that stays attached to a creature (RD-12, RD-14) because its executed
 * effects attached to that creature. While attached the card is in NO zone (it is not in the
 * deck, a hand, a stack or the graveyard); `boardCardIds` includes it so the 54-card total holds.
 * It goes to the graveyard when its creature leaves the stack (RD-12 / RD-50, see
 * `removeFromStack`) and always at round cleanup (RD-82).
 */
export interface AttachedSpell {
  readonly cardId: CardId;
  /** The seat that played the spell. */
  readonly seat: Seat;
  readonly targetCardId: CardId;
  /**
   * The effect that attached the card (RD-174): the Primary or the Secondary (a trap's lapse or
   * fired Secondary). Absent only on boards saved before this field existed.
   */
  readonly branch?: 'primary' | 'secondary';
}

/**
 * An ATK change on a whole stack until the end of the round (S-15, R4c-1, RD-134). It belongs to
 * the stack, not to any creature: it applies whichever creature is Leading, survives every removal
 * that leaves at least one creature, and travels with the stack on a swap (S-03). When the stack
 * becomes completely empty it ends (`stackEffectEnded`): a new Base there starts without it.
 * Created only by spells.
 */
export interface StackEffect {
  readonly effectId: string;
  readonly kind: 'stackAtkDelta';
  /** The seat whose stack it applies to. */
  readonly seat: Seat;
  readonly amount: number;
  readonly sourceCardId: CardId;
}

/**
 * RD-133 (S-06): a copied Buff or Nerf, carried by the caster's Leading creature at the time of
 * the copy for the rest of the round. It behaves like a positional modifier of the carrier
 * (RD-53/RD-57): live while the carrier is the Leading card of its stack (whatever its position),
 * silenced while a creature is linked on top of it, live again when the carrier becomes Leading
 * again. Liveness is derived, never stored. It leaves with the carrier (like RD-50).
 * - buffSelf: +LEADER_MODIFIER_AMOUNT on the carrier while live.
 * - nerfEnemyLeader: -LEADER_MODIFIER_AMOUNT on the Leading creature of the other stack while
 *   live.
 */
export interface CopiedModifier {
  readonly effectId: string;
  readonly kind: 'buffSelf' | 'nerfEnemyLeader';
  readonly carrierCardId: CardId;
  /** The S-06 card that made the copy. */
  readonly sourceCardId: CardId;
}

export interface Board {
  readonly zones: Zones;
  readonly attachedEffects: readonly AttachedEffect[];
  /** RD-12 / RD-82: spell cards attached to creatures (R4). Public information (played cards). */
  readonly attachedSpells: readonly AttachedSpell[];
  /** RD-10 / RD-51: per seat, true while an armed Link Up is unused. */
  readonly linkUpPending: readonly [boolean, boolean];
  /**
   * RD-139 (refines RD-51): per seat, the creature that granted the armed Link Up. The armed Link
   * Up belongs to it and lapses when it leaves the field (any zone). `null` while nothing is armed;
   * the engine always records the source when it arms (a hand-built state may arm with `null`,
   * which then never lapses).
   */
  readonly linkUpSource: readonly [CardId | null, CardId | null];
  /** Deterministic counter for effect ids (`e1`, `e2`, ...), used by spells (R4). */
  readonly nextEffectSeq: number;
  /** Stack-level ATK effects until round end (S-15). Cleared at round cleanup. */
  readonly stackEffects: readonly StackEffect[];
  /** RD-133: buff/nerf modifiers copied by S-06, carried by a creature. Cleared at cleanup. */
  readonly copiedModifiers: readonly CopiedModifier[];
  /**
   * RD-114 (S-01, R4c-2): cards drawn from the deck "to look at" during a pending choice. They
   * are in no zone (not in the hand, so hand sizes and RD-116 counts are unaffected) and only
   * exist while the choice is pending. HIDDEN: the ids are visible to `seat` only. Absent = none.
   */
  readonly lookingAt?: { readonly seat: Seat; readonly cardIds: readonly CardId[] };
  /**
   * R4c-4 (RD-101, RD-128..RD-130): traps (S-12, S-16) armed on `seat`'s side, in arming order.
   * An armed trap card is in no zone. PUBLIC: both seats see the trap with its identity (RD-130).
   * Absent = none. They always lapse at round end, so a cleaned-up board never has any.
   */
  readonly armedTraps?: readonly ArmedTrap[];
  /**
   * R4c-4 (S-12, RD-109): activations negated by S-12, by (Leading card, position). While the card
   * stays the Leading card at that position its modifier counts as not live (`activeModifierOf`);
   * the entry is dropped as soon as the card is silenced (any `modifierSilenced` for it, see
   * `applyModifierDraws`), so a later re-activation (RD-57 / RD-60 / RD-105) works normally.
   * Public. Absent = none.
   */
  readonly negatedModifiers?: readonly NegatedModifier[];
}

/** R4c-4: an armed trap (RD-101). `seat` is the side it is armed on (its caster, RD-112). */
export interface ArmedTrap {
  readonly cardId: CardId;
  readonly seat: Seat;
  /** The trap spell's `defId` (`S-12` or `S-16`). */
  readonly spellId: string;
  /**
   * R4c-5 (RD-157): armed through S-19 on the side of the seat that is NOT on turn. Its window is
   * the S-19 caster's NEXT turn, so during the current turn it neither triggers nor lapses; the
   * end of the current turn clears the flag (traps.ts `wakeDormantTraps`, event
   * `trapWindowOpened`). A round end lapses it like any other trap (RD-156). Absent = false.
   */
  readonly dormant?: true;
}

/** R4c-4 (RD-109): one negated activation: `cardId`'s modifier for `position`. */
export interface NegatedModifier {
  readonly cardId: CardId;
  readonly position: number;
}

/** Card definitions per instance id. Context, not state (definitions never change in a match). */
export type CardIndex = Readonly<Record<CardId, CardDef>>;

/** A modifier that is currently live (RD-53). At most one per seat: only the Leading Minion. */
export interface LiveModifier {
  readonly seat: Seat;
  readonly cardId: CardId;
  readonly kind: ModifierKind;
  readonly position: number;
}

/** Where a creature can go when it leaves a stack. */
export type StackExit = Exclude<ZoneRef, { readonly zone: 'stack' }>;

type LivenessEvent = { readonly type: 'modifierLive' | 'modifierSilenced' } & LiveModifier;

/**
 * Ordered, plain-data record of what an operation did, for clients and logs. Liveness events are
 * derived by comparing live modifiers before and after the operation.
 */
export type BoardEvent =
  | {
      readonly type: 'creatureStacked';
      readonly seat: Seat;
      readonly cardId: CardId;
      readonly position: number;
      readonly viaLinkUp: boolean;
    }
  | {
      readonly type: 'creatureLinked';
      readonly seat: Seat;
      readonly cardId: CardId;
      readonly position: number;
    }
  | {
      readonly type: 'creatureRemoved';
      readonly seat: Seat;
      readonly cardId: CardId;
      readonly position: number;
      readonly to: StackExit;
    }
  | {
      /**
       * RD-131 (S-13, S-17): `seat` took control of `cardId` from `from`'s stack (position
       * `fromPosition`); it now sits on top of `seat`'s stack at `position` (0 = new Base).
       */
      readonly type: 'controlTaken';
      readonly seat: Seat;
      readonly from: Seat;
      readonly cardId: CardId;
      readonly fromPosition: number;
      readonly position: number;
      readonly viaLinkUp: boolean;
    }
  | { readonly type: 'linkUpConsumed'; readonly seat: Seat }
  | { readonly type: 'linkUpArmed'; readonly seat: Seat; readonly sourceCardId: CardId }
  /** RD-139: the creature that granted the armed Link Up left the field; the Link Up is lost. */
  | { readonly type: 'linkUpLapsed'; readonly seat: Seat; readonly sourceCardId: CardId }
  | { readonly type: 'effectDiscarded'; readonly effect: AttachedEffect }
  /** RD-133 (S-06): a copied Buff/Nerf now rides on `modifier.carrierCardId`. */
  | { readonly type: 'copiedModifierAdded'; readonly modifier: CopiedModifier }
  /** RD-133: a copied modifier left the round with its carrier. */
  | { readonly type: 'copiedModifierDiscarded'; readonly modifier: CopiedModifier }
  /** RD-107 (S-03): the two stacks changed sides as a whole. No liveness event follows. */
  | { readonly type: 'stacksSwapped' }
  | { readonly type: 'stackEffectAdded'; readonly effect: StackEffect }
  /** RD-134: its stack became completely empty, so the stack effect ended (RD-105 / RD-138). */
  | { readonly type: 'stackEffectEnded'; readonly effect: StackEffect }
  /** RD-12 / RD-50: an attached spell card went to the graveyard with its creature's exit. */
  | {
      readonly type: 'attachedSpellDiscarded';
      readonly cardId: CardId;
      readonly targetCardId: CardId;
    }
  | LivenessEvent;

export type BoardErrorCode =
  'UNKNOWN_CARD' | 'CARD_NOT_IN_HAND' | 'NOT_A_CREATURE' | 'LEVEL_NOT_NEXT' | 'CARD_NOT_ON_STACK';

export interface BoardRejection<C extends BoardErrorCode = BoardErrorCode> {
  readonly ok: false;
  readonly code: C;
  readonly message: string;
}

export type BoardResult<C extends BoardErrorCode> =
  | { readonly ok: true; readonly board: Board; readonly events: readonly BoardEvent[] }
  | BoardRejection<C>;

export type StackCheck<C extends BoardErrorCode> = { readonly ok: true } | BoardRejection<C>;

type PlaceErrorCode = 'UNKNOWN_CARD' | 'CARD_NOT_IN_HAND' | 'NOT_A_CREATURE';

const SEATS = [0, 1] as const;

function reject<C extends BoardErrorCode>(code: C, message: string): BoardRejection<C> {
  return { ok: false, code, message };
}

function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

function leadingOf(zones: Zones, seat: Seat): CardId | undefined {
  return zones.stacks[seat].at(-1);
}

/** Builds the definition lookup for the instance ids assigned by `createZones` (c01..). */
export function createCardIndex(catalog: CardCatalog): CardIndex {
  const defs = new Map(catalog.map((d) => [d.defId, d]));
  const out: Record<CardId, CardDef> = {};
  for (const instance of createCardInstances(catalog)) {
    const def = defs.get(instance.defId);
    if (def !== undefined) out[instance.id] = def;
  }
  return out;
}

export function createBoard(zones: Zones): Board {
  return {
    zones,
    attachedEffects: [],
    attachedSpells: [],
    linkUpPending: [false, false],
    linkUpSource: [null, null],
    nextEffectSeq: 1,
    stackEffects: [],
    copiedModifiers: [],
  };
}

/**
 * RD-104 / RD-131 / RD-135: the owner of a creature on a stack is always the seat whose stack it
 * is on (control changes and stack swaps transfer ownership). Undefined off the stacks.
 */
export function ownerOf(board: Board, cardId: CardId): Seat | undefined {
  const where = findCard(board.zones, cardId);
  return where?.zone === 'stack' ? where.seat : undefined;
}

/**
 * Every card id on the board: all zones plus attached spell cards, cards being looked at and armed
 * traps (all three in no zone). The 54-card conservation invariant (RD-02) is
 * `boardCardIds(board)` = all instance ids, except for a spell in resolution during a pending
 * choice (see `roundCardIds`).
 */
export function boardCardIds(board: Board): CardId[] {
  return [
    ...allCardIds(board.zones),
    ...board.attachedSpells.map((s) => s.cardId),
    ...(board.lookingAt?.cardIds ?? []),
    ...(board.armedTraps ?? []).map((t) => t.cardId),
  ];
}

/**
 * RD-53 / RD-97: the live modifier of `seat`'s stack, if any: entry `position - 1` of the Leading
 * Minion's `modifiers`. Position 0 (Base Minion) is never live (RD-35); a position beyond the
 * list has no modifier.
 */
export function liveModifierOf(cards: CardIndex, zones: Zones, seat: Seat): LiveModifier | null {
  const stack = zones.stacks[seat];
  const cardId = stack.at(-1);
  if (cardId === undefined) return null;
  const position = stack.length - 1;
  const def = cards[cardId];
  if (def?.kind !== 'creature' || position === 0) return null;
  const kind = def.modifiers[position - 1];
  if (kind === undefined) return null;
  return { seat, cardId, kind, position };
}

/**
 * The live modifier of `seat`'s stack that actually takes effect: `liveModifierOf`, unless S-12
 * negated that activation (`Board.negatedModifiers`, RD-109). Use this for effects (buff, nerf,
 * S-06's "active modifier"); activation edges keep using the structural `liveModifiers`.
 */
export function activeModifierOf(cards: CardIndex, board: Board, seat: Seat): LiveModifier | null {
  const live = liveModifierOf(cards, board.zones, seat);
  if (live === null) return null;
  const negated = board.negatedModifiers?.some(
    (n) => n.cardId === live.cardId && n.position === live.position,
  );
  return negated === true ? null : live;
}

/** Live modifiers of both seats, seat 0 first. */
export function liveModifiers(cards: CardIndex, zones: Zones): LiveModifier[] {
  return SEATS.flatMap((seat) => {
    const live = liveModifierOf(cards, zones, seat);
    return live === null ? [] : [live];
  });
}

/** Shared precondition for placing: a known creature in `seat`'s hand. */
function checkPlaceable(
  cards: CardIndex,
  board: Board,
  seat: Seat,
  cardId: CardId,
): StackCheck<PlaceErrorCode> {
  const def = cards[cardId];
  if (def === undefined) return reject('UNKNOWN_CARD', `unknown card ${cardId}`);
  if (def.kind !== 'creature') return reject('NOT_A_CREATURE', `${cardId} is not a creature`);
  if (!board.zones.hands[seat].includes(cardId)) {
    return reject('CARD_NOT_IN_HAND', `${cardId} is not in seat ${seat}'s hand`);
  }
  return { ok: true };
}

/**
 * Stacking legality for `stackCreature`.
 * - Empty stack: allowed at this layer. Base Minion constraints (RD-05..RD-07) belong to the
 *   phase layer (R3) and are deliberately not checked here.
 * - RD-10 / RD-51: with Link Up armed for `seat`, any level is allowed.
 * - RD-09: otherwise level must be exactly Leading Minion level + 1, regardless of color (RD-08).
 *   A level-5 Leading Minion therefore allows nothing more. After a mid-stack removal (RD-52) the
 *   current Leading Minion's level is what counts.
 */
export function canStack(
  cards: CardIndex,
  board: Board,
  seat: Seat,
  cardId: CardId,
): StackCheck<PlaceErrorCode | 'LEVEL_NOT_NEXT'> {
  const base = checkPlaceable(cards, board, seat, cardId);
  if (!base.ok) return base;
  const leading = leadingOf(board.zones, seat);
  if (leading === undefined || board.linkUpPending[seat]) return { ok: true };
  const leadDef = cards[leading];
  const def = cards[cardId];
  if (leadDef?.kind !== 'creature' || def?.kind !== 'creature') {
    throw new Error(`stack of seat ${seat} holds a non-creature or unknown card`);
  }
  if (def.level !== leadDef.level + 1) {
    return reject(
      'LEVEL_NOT_NEXT',
      `level ${def.level} cannot follow Leading Minion level ${leadDef.level}`,
    );
  }
  return { ok: true };
}

function sameLive(a: LiveModifier, b: LiveModifier): boolean {
  return a.seat === b.seat && a.cardId === b.cardId && a.position === b.position;
}

/**
 * Emits liveness changes between `before` and the current zones (silenced first, then live, seat
 * order), and arms Link Up when a linkUp modifier just became live and the seat was not armed.
 */
/** Mutable working copy of a board's Link Up fields during one operation. */
interface LinkUpState {
  readonly pending: [boolean, boolean];
  readonly source: [CardId | null, CardId | null];
}

function linkUpOf(board: Board): LinkUpState {
  return {
    pending: [board.linkUpPending[0], board.linkUpPending[1]],
    source: [board.linkUpSource[0], board.linkUpSource[1]],
  };
}

function settleLiveness(
  cards: CardIndex,
  before: readonly LiveModifier[],
  zones: Zones,
  linkUp: LinkUpState,
  events: BoardEvent[],
): void {
  const after = liveModifiers(cards, zones);
  for (const m of before) {
    if (!after.some((x) => sameLive(x, m))) events.push({ type: 'modifierSilenced', ...m });
  }
  for (const m of after) {
    if (before.some((x) => sameLive(x, m))) continue;
    events.push({ type: 'modifierLive', ...m });
    // `linkUpArmed` is emitted only on a false -> true change: no duplicate when already armed.
    if (m.kind === 'linkUp' && !linkUp.pending[m.seat]) {
      linkUp.pending[m.seat] = true;
      linkUp.source[m.seat] = m.cardId;
      events.push({ type: 'linkUpArmed', seat: m.seat, sourceCardId: m.cardId });
    }
  }
}

function place(
  cards: CardIndex,
  board: Board,
  seat: Seat,
  cardId: CardId,
  mode: 'stack' | 'link',
): BoardResult<never> {
  const events: BoardEvent[] = [];
  const before = liveModifiers(cards, board.zones);
  const linkUp = linkUpOf(board);
  const viaLinkUp = mode === 'stack' && linkUp.pending[seat];
  const moved = moveCard(board.zones, cardId, { zone: 'hand', seat }, { zone: 'stack', seat });
  if (!moved.ok) throw new Error(`unreachable: ${moved.code}`);
  const zones = moved.zones;
  const position = zones.stacks[seat].length - 1;
  if (mode === 'link') {
    events.push({ type: 'creatureLinked', seat, cardId, position });
  } else {
    events.push({ type: 'creatureStacked', seat, cardId, position, viaLinkUp });
  }
  if (viaLinkUp) {
    // RD-10: placing the next creature uses the armed Link Up. If the placed card's own Link Up
    // goes live, settleLiveness arms it again: that is how chaining works.
    linkUp.pending[seat] = false;
    linkUp.source[seat] = null;
    events.push({ type: 'linkUpConsumed', seat });
  }
  settleLiveness(cards, before, zones, linkUp, events);
  return {
    ok: true,
    board: {
      ...board,
      zones,
      linkUpPending: linkUp.pending,
      linkUpSource: linkUp.source,
      attachedEffects: [...board.attachedEffects],
    },
    events,
  };
}

/** RD-09 / RD-10: stacks a creature from `seat`'s hand onto `seat`'s stack. */
export function stackCreature(
  cards: CardIndex,
  board: Board,
  seat: Seat,
  cardId: CardId,
): BoardResult<PlaceErrorCode | 'LEVEL_NOT_NEXT'> {
  const check = canStack(cards, board, seat, cardId);
  if (!check.ok) return check;
  return place(cards, board, seat, cardId, 'stack');
}

/**
 * Links a creature from `seat`'s hand onto `seat`'s stack ignoring level (used by the tie-break,
 * RD-19). Does not require or use an armed Link Up; liveness rules still apply.
 */
export function linkCreature(
  cards: CardIndex,
  board: Board,
  seat: Seat,
  cardId: CardId,
): BoardResult<PlaceErrorCode> {
  const check = checkPlaceable(cards, board, seat, cardId);
  if (!check.ok) return check;
  return place(cards, board, seat, cardId, 'link');
}

/**
 * ADR-0007 section 4 "Placement by a spell" (RD-108, RD-117; S-10): places a creature from
 * `seat`'s hand on top of `seat`'s stack ignoring the level rule (the spell's own condition
 * replaces RD-09), but otherwise exactly like a normal play: an armed Link Up is used up (RD-10)
 * and the activation edge fires. An empty stack takes it as a Base (RD-105 / RD-106).
 */
export function placeBySpell(
  cards: CardIndex,
  board: Board,
  seat: Seat,
  cardId: CardId,
): BoardResult<PlaceErrorCode> {
  const check = checkPlaceable(cards, board, seat, cardId);
  if (!check.ok) return check;
  return place(cards, board, seat, cardId, 'stack');
}

/** One creature leaving a stack and where it goes. */
export interface StackRemoval {
  readonly cardId: CardId;
  readonly to: StackExit;
}

/**
 * Removes a creature from whichever stack holds it and moves it to `to` (deck: bottom).
 * - RD-12 / RD-50: every effect attached to it is discarded.
 * - RD-52 / RD-105: removing from the middle lets the cards above shift down one position
 *   ("modified stack"); levels are not re-validated. If the Base (position 0) leaves while the
 *   stack has other cards, the card at position 1 becomes the new Base (never live). Liveness is
 *   re-derived from the new positions (RD-53/RD-97), so a modifier that is legal at the Leading
 *   card's new position activates (once — nothing accumulates). The destination is the caller's
 *   choice (RD-105 "dies" = graveyard is a spell-level rule).
 * - RD-139 (refines RD-51): an armed Link Up lapses when the card that armed it is removed.
 * - RD-12 / RD-50 (R4): spell cards attached to it go to the GRAVEYARD, whatever `to` is
 *   (RD-12: "the attached spell/effect goes with it"; RD-82: attached spells never return to the
 *   deck). Graveyard order is irrelevant (RD-23).
 */
export function removeFromStack(
  cards: CardIndex,
  board: Board,
  cardId: CardId,
  to: StackExit,
): BoardResult<'CARD_NOT_ON_STACK'> {
  return removeFromStacks(cards, board, [{ cardId, to }]);
}

/**
 * Removes several creatures (from either stack) as ONE operation: the same rules as
 * `removeFromStack`, applied in list order, but liveness is compared only once, before the first
 * and after the last removal. Intermediate Leading cards therefore never activate (used by S-04,
 * which returns all creatures at once). Rejects without change if any card is not on a stack.
 */
export function removeFromStacks(
  cards: CardIndex,
  board: Board,
  removals: readonly StackRemoval[],
): BoardResult<'CARD_NOT_ON_STACK'> {
  const events: BoardEvent[] = [];
  const before = liveModifiers(cards, board.zones);
  const work = startWork(board);
  const rejected = leaveField(work, removals, events);
  if (rejected !== null) return rejected;
  settleLiveness(cards, before, work.zones, work.linkUp, events);
  return { ok: true, board: endEmptiedStackEffects(finishWork(board, work), events), events };
}

/**
 * RD-134 (user, 2026-10-19): a stack effect (S-15) ends when its stack becomes completely empty
 * (RD-105 / RD-138); a new Base on that stack starts without it. The S-15 card is already in the
 * graveyard (it never attaches). Events follow the operation's own events.
 */
function endEmptiedStackEffects(board: Board, events: BoardEvent[]): Board {
  const ended = board.stackEffects.filter((e) => board.zones.stacks[e.seat].length === 0);
  if (ended.length === 0) return board;
  for (const effect of ended) events.push({ type: 'stackEffectEnded', effect });
  return { ...board, stackEffects: board.stackEffects.filter((e) => !ended.includes(e)) };
}

/** Mutable working copy of the stack-related board fields during one operation. */
interface BoardWork {
  zones: Zones;
  attachedEffects: readonly AttachedEffect[];
  attachedSpells: readonly AttachedSpell[];
  copiedModifiers: readonly CopiedModifier[];
  readonly linkUp: LinkUpState;
}

function startWork(board: Board): BoardWork {
  return {
    zones: board.zones,
    attachedEffects: board.attachedEffects,
    attachedSpells: board.attachedSpells,
    copiedModifiers: board.copiedModifiers,
    linkUp: linkUpOf(board),
  };
}

function finishWork(board: Board, work: BoardWork): Board {
  return {
    ...board,
    zones: work.zones,
    attachedEffects: work.attachedEffects,
    attachedSpells: work.attachedSpells,
    linkUpPending: work.linkUp.pending,
    linkUpSource: work.linkUp.source,
    copiedModifiers: work.copiedModifiers,
  };
}

/**
 * The removal part of `removeFromStacks` WITHOUT the liveness comparison (callers settle once,
 * which is what makes `replaceLeader` atomic): moves the creatures off the field, discards what is
 * attached to them (RD-12 / RD-50 / RD-133) and lets an armed Link Up they granted lapse (RD-139).
 * Returns a rejection (and leaves `work` in an unspecified state) if a card is not on a stack.
 */
function leaveField(
  work: BoardWork,
  removals: readonly StackRemoval[],
  events: BoardEvent[],
): BoardRejection<'CARD_NOT_ON_STACK'> | null {
  for (const { cardId, to } of removals) {
    const where = findCard(work.zones, cardId);
    if (where?.zone !== 'stack') return reject('CARD_NOT_ON_STACK', `${cardId} is not on a stack`);
    const seat = where.seat;
    const position = work.zones.stacks[seat].indexOf(cardId);
    const moved = moveCard(work.zones, cardId, where, to);
    if (!moved.ok) throw new Error(`unreachable: ${moved.code}`);
    work.zones = moved.zones;
    const keptCopies: CopiedModifier[] = [];
    for (const modifier of work.copiedModifiers) {
      if (modifier.carrierCardId === cardId) {
        events.push({ type: 'copiedModifierDiscarded', modifier });
      } else {
        keptCopies.push(modifier);
      }
    }
    work.copiedModifiers = keptCopies;
    events.push({ type: 'creatureRemoved', seat, cardId, position, to });
    const keptEffects: AttachedEffect[] = [];
    for (const effect of work.attachedEffects) {
      if (effect.targetCardId === cardId) events.push({ type: 'effectDiscarded', effect });
      else keptEffects.push(effect);
    }
    work.attachedEffects = keptEffects;
    const keptSpells: AttachedSpell[] = [];
    const discardedSpells: CardId[] = [];
    for (const spell of work.attachedSpells) {
      if (spell.targetCardId === cardId) {
        discardedSpells.push(spell.cardId);
        events.push({ type: 'attachedSpellDiscarded', cardId: spell.cardId, targetCardId: cardId });
      } else {
        keptSpells.push(spell);
      }
    }
    work.attachedSpells = keptSpells;
    if (discardedSpells.length > 0) {
      work.zones = { ...work.zones, graveyard: [...work.zones.graveyard, ...discardedSpells] };
    }
  }
  // RD-139: an armed Link Up lapses when the creature that granted it leaves the field. This runs
  // before the new liveness, so a newly Leading creature's own Link Up can arm again (RD-57).
  for (const seat of SEATS) {
    const source = work.linkUp.source[seat];
    if (source !== null && removals.some((r) => r.cardId === source)) {
      lapseLinkUp(work.linkUp, seat, source, events);
    }
  }
  return null;
}

function lapseLinkUp(linkUp: LinkUpState, seat: Seat, source: CardId, events: BoardEvent[]) {
  linkUp.pending[seat] = false;
  linkUp.source[seat] = null;
  events.push({ type: 'linkUpLapsed', seat, sourceCardId: source });
}

/** RD-10 / RD-108: a placement on `seat`'s stack uses up an armed Link Up. Returns `viaLinkUp`. */
function consumeLinkUp(linkUp: LinkUpState, seat: Seat, events: BoardEvent[]): boolean {
  if (!linkUp.pending[seat]) return false;
  linkUp.pending[seat] = false;
  linkUp.source[seat] = null;
  events.push({ type: 'linkUpConsumed', seat });
  return true;
}

/**
 * ADR-0007 `replaceLeader` (S-07, S-09; RD-127, RD-108): ONE atomic step. `seat`'s Leading
 * creature leaves the field to `oldTo` (deck: bottom, the caller shuffles; hand: `seat`'s hand,
 * the owner per RD-135) with the usual removal consequences (attached effects and spells, copied
 * modifiers, RD-139 Link Up lapse), and `newCardId` from `seat`'s hand takes its position as a
 * normal placement (an armed Link Up still pending after the lapse is used up, RD-10). Liveness is
 * compared once, before and after, so the creature below never becomes Leading and never
 * activates; only the new Leading creature's modifier for that position does (an exception to
 * RD-124). Events: `creatureRemoved`, `creatureStacked`, then the liveness changes.
 */
export function replaceLeader(
  cards: CardIndex,
  board: Board,
  seat: Seat,
  newCardId: CardId,
  oldTo: StackExit,
): BoardResult<PlaceErrorCode | 'CARD_NOT_ON_STACK'> {
  const check = checkPlaceable(cards, board, seat, newCardId);
  if (!check.ok) return check;
  const old = leadingOf(board.zones, seat);
  if (old === undefined) return reject('CARD_NOT_ON_STACK', `seat ${seat} has no Leading creature`);
  const events: BoardEvent[] = [];
  const before = liveModifiers(cards, board.zones);
  const work = startWork(board);
  const rejected = leaveField(work, [{ cardId: old, to: oldTo }], events);
  if (rejected !== null) return rejected;
  const moved = moveCard(work.zones, newCardId, { zone: 'hand', seat }, { zone: 'stack', seat });
  if (!moved.ok) throw new Error(`unreachable: ${moved.code}`);
  work.zones = moved.zones;
  const position = work.zones.stacks[seat].length - 1;
  const stacked: BoardEvent[] = [];
  const viaLinkUp = consumeLinkUp(work.linkUp, seat, stacked);
  events.push(
    { type: 'creatureStacked', seat, cardId: newCardId, position, viaLinkUp },
    ...stacked,
  );
  settleLiveness(cards, before, work.zones, work.linkUp, events);
  return { ok: true, board: finishWork(board, work), events };
}

/**
 * ADR-0007 `takeControl` (S-13, S-17; RD-106, RD-131, RD-108): the creature leaves the other
 * seat's stack (the cards above shift down, RD-105) and is placed on top of `taker`'s stack as its
 * new Leading creature, or as its Base when that stack is empty. Ownership transfers (owner = the
 * seat whose stack it is on, RD-131). It counts as a normal placement for the taker: an armed Link
 * Up is used up (RD-10) and the activation edges of both stacks are evaluated once, after the move.
 * RD-146 (Proposed): the creature stays on the field, so its attached effects and spells and the
 * copied modifiers it carries stay with it; an armed Link Up it granted to the previous controller
 * lapses (RD-139).
 */
export function takeControl(
  cards: CardIndex,
  board: Board,
  taker: Seat,
  cardId: CardId,
): BoardResult<'CARD_NOT_ON_STACK'> {
  const from = otherSeat(taker);
  const fromPosition = board.zones.stacks[from].indexOf(cardId);
  if (fromPosition === -1) {
    return reject('CARD_NOT_ON_STACK', `${cardId} is not on seat ${from}'s stack`);
  }
  const events: BoardEvent[] = [];
  const before = liveModifiers(cards, board.zones);
  const work = startWork(board);
  const moved = moveCard(
    work.zones,
    cardId,
    { zone: 'stack', seat: from },
    { zone: 'stack', seat: taker },
  );
  if (!moved.ok) throw new Error(`unreachable: ${moved.code}`);
  work.zones = moved.zones;
  const position = work.zones.stacks[taker].length - 1;
  const after: BoardEvent[] = [];
  if (work.linkUp.source[from] === cardId) lapseLinkUp(work.linkUp, from, cardId, after);
  const viaLinkUp = consumeLinkUp(work.linkUp, taker, after);
  events.push(
    { type: 'controlTaken', seat: taker, from, cardId, fromPosition, position, viaLinkUp },
    ...after,
  );
  settleLiveness(cards, before, work.zones, work.linkUp, events);
  // Taking the last creature empties the previous controller's stack (RD-134).
  return { ok: true, board: endEmptiedStackEffects(finishWork(board, work), events), events };
}

/**
 * RD-107 (S-03): the two players swap whole stacks. Everything that belongs to a stack travels
 * with it: positions, attached effects and spells (keyed by creature), stack effects, and the
 * armed Link Up state (RD-107, Link Up: Proposed). Each stack keeps its Leading card at the same
 * position, so this is not an activation edge and no liveness event is emitted (ADR-0007
 * section 4). Ownership moves with the stack (RD-135): the new holder owns its creatures.
 */
export function swapStacks(board: Board): {
  readonly board: Board;
  readonly events: readonly BoardEvent[];
} {
  const { stacks } = board.zones;
  return {
    board: {
      ...board,
      zones: { ...board.zones, stacks: [stacks[1], stacks[0]] },
      linkUpPending: [board.linkUpPending[1], board.linkUpPending[0]],
      linkUpSource: [board.linkUpSource[1], board.linkUpSource[0]],
      stackEffects: board.stackEffects.map((e) => ({ ...e, seat: otherSeat(e.seat) })),
    },
    events: [{ type: 'stacksSwapped' }],
  };
}

/** RD-133: true while the carrier of a copied modifier is the Leading card of its stack. */
export function isCopyLive(board: Board, modifier: CopiedModifier): boolean {
  const where = findCard(board.zones, modifier.carrierCardId);
  return where?.zone === 'stack' && leadingOf(board.zones, where.seat) === modifier.carrierCardId;
}

/** RD-133: ATK change on `cardId` from live copied modifiers (buff on the carrier, nerf across). */
function copiedModifierDelta(board: Board, cardId: CardId): number {
  if (board.copiedModifiers.length === 0) return 0;
  const where = findCard(board.zones, cardId);
  if (where?.zone !== 'stack' || leadingOf(board.zones, where.seat) !== cardId) return 0;
  const enemyLeader = leadingOf(board.zones, otherSeat(where.seat));
  let delta = 0;
  for (const m of board.copiedModifiers) {
    if (m.kind === 'buffSelf' && m.carrierCardId === cardId) delta += LEADER_MODIFIER_AMOUNT;
    if (m.kind === 'nerfEnemyLeader' && m.carrierCardId === enemyLeader) {
      delta -= LEADER_MODIFIER_AMOUNT;
    }
  }
  return delta;
}

/**
 * RD-53 / RD-44 / RD-37: current ATK of a creature, floored at 0 per creature:
 * definition ATK
 *   + LEADER_MODIFIER_AMOUNT if its own buffSelf is live,
 *   - LEADER_MODIFIER_AMOUNT if it is the Leading Minion of its stack and the opponent's live
 *     modifier is nerfEnemyLeader (empty enemy stack: no effect, RD-49),
 *   + attached effects targeting it (spells, RD-55),
 *   +/- live copied modifiers (S-06, RD-133: buff on its carrier, nerf on the enemy Leading).
 */
export function creatureAtk(cards: CardIndex, board: Board, cardId: CardId): number {
  const def = cards[cardId];
  if (def?.kind !== 'creature') throw new Error(`${cardId} is not a known creature`);
  let total = def.atk;
  const where = findCard(board.zones, cardId);
  if (where?.zone === 'stack' && leadingOf(board.zones, where.seat) === cardId) {
    // RD-109: an activation negated by S-12 gives neither its buff nor its nerf.
    if (activeModifierOf(cards, board, where.seat)?.kind === 'buffSelf') {
      total += LEADER_MODIFIER_AMOUNT;
    }
    if (activeModifierOf(cards, board, otherSeat(where.seat))?.kind === 'nerfEnemyLeader') {
      total -= LEADER_MODIFIER_AMOUNT;
    }
  }
  for (const effect of board.attachedEffects) {
    // Only 'atkDelta' exists so far; R4 spell effect kinds must be handled here explicitly.
    if (effect.targetCardId === cardId) total += effect.amount;
  }
  total += copiedModifierDelta(board, cardId);
  return Math.max(0, total);
}

/**
 * RD-18: sum of the (floored) ATK of every creature on `seat`'s stack, plus the stack effects on
 * that stack (S-15).
 * Proposed: the stack total is floored at 0 once, after the stack effects (as RD-61 does for one
 * creature).
 */
export function stackAtk(cards: CardIndex, board: Board, seat: Seat): number {
  const creatures = board.zones.stacks[seat].reduce(
    (sum, id) => sum + creatureAtk(cards, board, id),
    0,
  );
  const delta = board.stackEffects.reduce((sum, e) => (e.seat === seat ? sum + e.amount : sum), 0);
  return delta === 0 ? creatures : Math.max(0, creatures + delta);
}
