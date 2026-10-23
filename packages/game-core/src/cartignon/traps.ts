import type { Rng } from '../rng.js';
import type { Seat } from '../rules.js';
import {
  removeFromStacks,
  type ArmedTrap,
  type Board,
  type BoardEvent,
  type CardIndex,
  type NegatedModifier,
} from './board.js';
import type { ModifierKind } from './cards.js';
import {
  applyModifierDraws,
  createSpellKernel,
  runSecondary,
  withNegatedModifiers,
  type PlacementOutcome,
  type TurnLock,
} from './kernel.js';
import type { RoundEvent } from './round.js';
import { findCard, type CardId } from './zones.js';

/**
 * Armed traps (ADR-0007 section 4 "Traps", R4c-4): S-12 Null Snare and S-16 Recoil Snare.
 *
 * - Arming (RD-101): both are always playable; instead of resolving they are armed on the caster's
 *   side (`Board.armedTraps`, in no zone, public with identity, RD-130).
 * - Window: the opponent's next turn. A trap triggers only on placements of the seat whose turn is
 *   in progress, on that seat's own stack, while the trap belongs to the other seat (RD-152). Every
 *   placement path counts: normal play, spell placement (`placeOnStack`), `replaceLeader` and
 *   `takeControl` (RD-146), each settled through `settlePlacement`.
 * - S-12 (RD-128 / RD-109): the first such placement. Level 2-4: that one activation of the
 *   creature's modifier is negated (no draw, no Link Up arming, no buff / nerf while it stays
 *   Leading at that position, `Board.negatedModifiers`). Level 1 or 5: the Secondary (draw 1 from
 *   the deck for the trap's owner) fires after the placement's own activation. Consumed either way.
 * - S-16 (RD-104, RD-154): the first such placement of a level >= 3 creature, BEFORE its
 *   activation edge: the creature never activates (no draw, no Link Up arming, no buff / nerf),
 *   returns to its owner's hand (the placer, RD-135) and is replay-locked for the rest of that
 *   turn (`turnLocks`). The card below becomes Leading again and re-activates (RD-57 / RD-60).
 *   A Link Up the placement used up stays used up (the placement happened). Consumed.
 * - Both on one placement (RD-154): S-12 first, then S-16; both are consumed, and S-12's level
 *   1 / 5 Secondary draw still happens.
 * - Lapse (RD-129): when the window turn ends, or the round ends first, every trap still armed
 *   lapses and its Secondary fires (`lapseTraps`, called by the round layer). A trap whose primary
 *   fired is gone already, so it never gives a lapse Secondary. Timing is "lapse first, then
 *   decide" (RD-156, round.ts `withWindowLapse`).
 * - RD-157 (user, 2026-10-19; implemented with S-19 in R4c-5): a trap armed through S-19
 *   (RD-112) has the S-19 caster's NEXT turn as its window; it skips the current turn. It is armed
 *   `dormant` (spells.ts `finishSpell`: armed on the side of the seat not on turn): it does not
 *   trigger (`trapAgainst`) and does not lapse; the end of the current turn wakes it
 *   (`wakeDormantTraps`, called by the round layer's `lapseWindow`). From then on it is an ordinary
 *   armed trap of its owner: idle in its owner's turn, live in the S-19 caster's next turn, lapsing
 *   when that turn ends, or at an earlier round end (RD-156).
 *
 * Destination (RD-153, user 2026-10-19): a trap whose Secondary gave an effect to a creature
 * (S-16 lapse: -30 on the enemy Leading creature) attaches to that creature like an attached
 * spell (`Board.attachedSpells`, RD-12 / RD-82: graveyard with the creature or at cleanup).
 * Otherwise (a fired primary, a draw Secondary, a Secondary without a target) it goes to the
 * graveyard. Pure functions; the RNG is only passed through to the kernel (draws).
 */

/** S-12 Null Snare. */
export const NULL_SNARE = 'S-12';
/** S-16 Recoil Snare. */
export const RECOIL_SNARE = 'S-16';
/** S-12 negates the activation of a level 2..4 creature (RD-128); level 1 / 5 -> Secondary. */
export const S12_NEGATE_MIN_LEVEL = 2;
export const S12_NEGATE_MAX_LEVEL = 4;
/** S-16 triggers on a creature of at least this level. */
export const S16_MIN_LEVEL = 3;

/**
 * Trap events. PUBLIC (RD-130): armed traps are visible with identity to both seats.
 * - `trapArmed`: `seat` armed `cardId` (`spellId`) on its side.
 * - `trapTriggered`: the trap of `seat` fired on the placement of `triggerCardId` by `targetSeat`.
 *   `negated` (S-12, level 2..4; `negatedKind` = the modifier that did not activate, absent when
 *   the placement activated nothing), `secondary` (S-12, level 1 / 5) or `returned` (S-16).
 * - `trapLapsed`: the trap expired untriggered (RD-129); its Secondary's events follow.
 *   `attachedTo` (RD-153): the creature the trap card attached to because its Secondary gave that
 *   creature an effect; absent = the card went to the graveyard.
 */
export type TrapEvent =
  | {
      readonly type: 'trapArmed';
      readonly seat: Seat;
      readonly cardId: CardId;
      readonly spellId: string;
      /** RD-157 (R4c-5): armed through S-19, its window starts after the current turn. */
      readonly dormant?: true;
    }
  | {
      /** RD-157 (R4c-5): the current turn ended; the dormant trap's window is the next turn. */
      readonly type: 'trapWindowOpened';
      readonly seat: Seat;
      readonly cardId: CardId;
      readonly spellId: string;
    }
  | {
      readonly type: 'trapTriggered';
      readonly seat: Seat;
      readonly cardId: CardId;
      readonly spellId: string;
      readonly targetSeat: Seat;
      readonly triggerCardId: CardId;
      readonly outcome: 'negated' | 'secondary' | 'returned';
      readonly negatedKind?: ModifierKind;
    }
  | {
      readonly type: 'trapLapsed';
      readonly seat: Seat;
      readonly cardId: CardId;
      readonly spellId: string;
      readonly attachedTo?: CardId;
    };

/** True for the trap spells (they arm instead of resolving). */
export function isTrapSpell(spellId: string): boolean {
  return spellId === NULL_SNARE || spellId === RECOIL_SNARE;
}

/** `board` with `armedTraps` set; an empty list removes the field. */
function withArmedTraps(board: Board, traps: readonly ArmedTrap[]): Board {
  const rest: { -readonly [K in keyof Board]: Board[K] } = { ...board };
  delete rest.armedTraps;
  return traps.length === 0 ? rest : { ...rest, armedTraps: traps };
}

/** Arms `trap` (its card must be in no zone, i.e. the spell in resolution). */
export function armTrap(board: Board, trap: ArmedTrap): Board {
  return withArmedTraps(board, [...(board.armedTraps ?? []), trap]);
}

/** Takes `trap` off the board's armed list (its card is then in no zone). */
function disarm(board: Board, trap: ArmedTrap): Board {
  return withArmedTraps(
    board,
    (board.armedTraps ?? []).filter((t) => t.cardId !== trap.cardId),
  );
}

function toGraveyard(board: Board, cardId: CardId): Board {
  return { ...board, zones: { ...board.zones, graveyard: [...board.zones.graveyard, cardId] } };
}

/**
 * The first armed trap `spellId` that belongs to the other seat than `placer`. A dormant trap
 * (RD-157) is not in its window yet and never triggers.
 */
function trapAgainst(board: Board, placer: Seat, spellId: string): ArmedTrap | undefined {
  return board.armedTraps?.find(
    (t) => t.spellId === spellId && t.seat !== placer && t.dormant !== true,
  );
}

/**
 * RD-157: `endingSeat`'s turn ends, so the dormant traps armed against it (through S-19, on the
 * other seat's side) leave dormancy: their window is `endingSeat`'s next turn. Emits
 * `trapWindowOpened` per trap, in arming order. Never lapses anything.
 */
export function wakeDormantTraps(
  board: Board,
  endingSeat: Seat,
): { readonly board: Board; readonly events: readonly RoundEvent[] } {
  const traps = board.armedTraps ?? [];
  const waking = traps.filter((t) => t.dormant === true && t.seat !== endingSeat);
  if (waking.length === 0) return { board, events: [] };
  const woken = traps.map((t) => {
    if (!waking.includes(t)) return t;
    const rest: { -readonly [K in keyof ArmedTrap]: ArmedTrap[K] } = { ...t };
    delete rest.dormant;
    return rest;
  });
  return {
    board: withArmedTraps(board, woken),
    events: waking.map((t) => ({
      type: 'trapWindowOpened',
      seat: t.seat,
      cardId: t.cardId,
      spellId: t.spellId,
    })),
  };
}

/**
 * Runs the trap's data Secondary for its owner (RD-115 fixed targets) in a kernel session and puts
 * the trap card where it belongs (RD-153): attached to the creature the Secondary gave an effect
 * to (still on a stack), otherwise the graveyard. The card must already be disarmed.
 */
function fireSecondary(
  cards: CardIndex,
  board: Board,
  trap: ArmedTrap,
  rng: Rng,
): {
  readonly board: Board;
  readonly events: readonly RoundEvent[];
  readonly attachedTo: CardId | null;
} {
  const def = cards[trap.cardId];
  if (def?.kind !== 'spell') throw new Error(`armed trap ${trap.cardId} is not a spell`);
  const session = createSpellKernel(cards, board, trap.seat, trap.cardId, rng);
  runSecondary(session.kernel, def.secondary);
  const done = session.finish();
  const target = done.attachedTo;
  if (target === null || findCard(done.board.zones, target)?.zone !== 'stack') {
    return { board: toGraveyard(done.board, trap.cardId), events: done.events, attachedTo: null };
  }
  const attached = { cardId: trap.cardId, seat: trap.seat, targetCardId: target };
  return {
    board: { ...done.board, attachedSpells: [...done.board.attachedSpells, attached] },
    events: done.events,
    attachedTo: target,
  };
}

/**
 * RD-109: removes the activation of `cardId` on `placer`'s stack from one placement's board events
 * before they are settled: its `modifierLive` (so no draw runs) and a Link Up it armed
 * (re-disarmed). Returns the negation entry; the caller records it only AFTER the events are
 * settled, because the same events may hold an earlier `modifierSilenced` for `cardId` (a
 * `takeControl` silences it on the old seat first), which `applyModifierDraws` would otherwise
 * treat as the end of the fresh negation.
 *
 * Note for R6 (projection): after a negation the event stream has no `modifierLive` for the card,
 * but a later `modifierSilenced` for it can still follow when it is covered or leaves; clients
 * must tolerate a silence without a preceding live event.
 */
function negateActivation(
  board: Board,
  boardEvents: readonly BoardEvent[],
  placer: Seat,
  cardId: CardId,
): {
  readonly board: Board;
  readonly events: readonly BoardEvent[];
  readonly negated?: NegatedModifier;
  readonly kind?: ModifierKind;
} {
  const live = boardEvents.find(
    (e) => e.type === 'modifierLive' && e.cardId === cardId && e.seat === placer,
  );
  if (live?.type !== 'modifierLive') return { board, events: boardEvents };
  const armed = boardEvents.find((e) => e.type === 'linkUpArmed' && e.sourceCardId === cardId);
  let next = board;
  if (armed?.type === 'linkUpArmed') {
    const pending: [boolean, boolean] = [board.linkUpPending[0], board.linkUpPending[1]];
    const source: [CardId | null, CardId | null] = [board.linkUpSource[0], board.linkUpSource[1]];
    pending[armed.seat] = false;
    source[armed.seat] = null;
    next = { ...next, linkUpPending: pending, linkUpSource: source };
  }
  return {
    board: next,
    events: boardEvents.filter((e) => e !== live && e !== armed),
    negated: { cardId, position: live.position },
    kind: live.kind,
  };
}

/** `PlacementOutcome` plus whether an S-16 trap sent the placed creature back to the hand. */
export interface TrapPlacementOutcome extends PlacementOutcome {
  readonly returned: boolean;
}

/**
 * Settles one placement of `cardId` on `placer`'s stack (`boardEvents` = the board operation's
 * events, not yet settled): the activation edge (`applyModifierDraws`) plus the traps it triggers.
 * `turnSeat` is the seat whose turn is in progress; traps trigger only when `placer` is that seat
 * (RD-152). Without a triggered trap this is exactly `applyModifierDraws`.
 */
export function settlePlacement(
  cards: CardIndex,
  board: Board,
  boardEvents: readonly BoardEvent[],
  placer: Seat,
  cardId: CardId,
  turnSeat: Seat,
  rng: Rng,
): TrapPlacementOutcome {
  const def = cards[cardId];
  const level = def?.kind === 'creature' ? def.level : 0;
  const armed = placer === turnSeat && (board.armedTraps?.length ?? 0) > 0;
  const s12 = armed ? trapAgainst(board, placer, NULL_SNARE) : undefined;
  const negates =
    s12 !== undefined && level >= S12_NEGATE_MIN_LEVEL && level <= S12_NEGATE_MAX_LEVEL;
  // RD-154 (user, 2026-10-19): S-16 resolves before the activation edge, so a returned creature
  // never activates. Decided on the placement board (S-12 never removes the creature).
  const s16 =
    armed && level >= S16_MIN_LEVEL && board.zones.stacks[placer].includes(cardId)
      ? trapAgainst(board, placer, RECOIL_SNARE)
      : undefined;
  let current = board;
  let pending = boardEvents;
  let negatedKind: ModifierKind | undefined;
  let negated: NegatedModifier | undefined;
  if (negates || s16 !== undefined) {
    const n = negateActivation(current, pending, placer, cardId);
    current = n.board;
    pending = n.events;
    if (negates) negatedKind = n.kind;
    // A returned creature leaves the field: no negation entry to keep.
    if (negates && s16 === undefined) negated = n.negated;
  }
  const settled = applyModifierDraws(current, pending, rng);
  current = settled.board;
  if (negated !== undefined) {
    // Recorded after settling (see negateActivation): this placement's own silence events for
    // the card (old seat, takeControl) must not prune the fresh negation.
    current = withNegatedModifiers(current, [...(current.negatedModifiers ?? []), negated]);
  }
  const events: RoundEvent[] = [...settled.events];
  if (s12 !== undefined) {
    current = disarm(current, s12);
    events.push({
      type: 'trapTriggered',
      seat: s12.seat,
      cardId: s12.cardId,
      spellId: s12.spellId,
      targetSeat: placer,
      triggerCardId: cardId,
      outcome: negates ? 'negated' : 'secondary',
      ...(negatedKind === undefined ? {} : { negatedKind }),
    });
    if (negates) {
      current = toGraveyard(current, s12.cardId);
    } else {
      // Level 1 / 5: the draw Secondary; the card goes to the graveyard (RD-153).
      const fired = fireSecondary(cards, current, s12, rng);
      current = fired.board;
      events.push(...fired.events);
    }
  }
  const locks: TurnLock[] = [];
  if (s16 === undefined) return { board: current, events, locks, returned: false };
  current = disarm(current, s16);
  events.push({
    type: 'trapTriggered',
    seat: s16.seat,
    cardId: s16.cardId,
    spellId: s16.spellId,
    targetSeat: placer,
    triggerCardId: cardId,
    outcome: 'returned',
  });
  // RD-104 / RD-135: back to its owner's hand (the stack's seat); the card below may re-activate.
  const removed = removeFromStacks(cards, current, [
    { cardId, to: { zone: 'hand', seat: placer } },
  ]);
  if (!removed.ok) throw new Error(`unreachable: ${removed.code}`);
  // It never went live (stripped above), so its silence is not reported either.
  const removalEvents = removed.events.filter(
    (e) => !(e.type === 'modifierSilenced' && e.cardId === cardId && e.seat === placer),
  );
  const after = applyModifierDraws(removed.board, removalEvents, rng);
  events.push(...after.events, { type: 'replayLocked', seat: placer, cardId });
  locks.push({ seat: placer, cardId });
  return { board: toGraveyard(after.board, s16.cardId), events, locks, returned: true };
}

/**
 * RD-129: `traps` (armed on `board`) lapse in arming order: each Secondary fires for its owner
 * (S-12: draw 1 from the deck; S-16: -30 ATK on the opponent's Leading creature, nothing without
 * one, RD-115). RD-153: the S-16 card then attaches to that creature (`trapLapsed.attachedTo`);
 * otherwise the card goes to the graveyard. No choice and no looked-at cards can result.
 */
export function lapseTraps(
  cards: CardIndex,
  board: Board,
  traps: readonly ArmedTrap[],
  rng: Rng,
): { readonly board: Board; readonly events: readonly RoundEvent[] } {
  let current = board;
  const events: RoundEvent[] = [];
  for (const trap of traps) {
    current = disarm(current, trap);
    const fired = fireSecondary(cards, current, trap, rng);
    events.push(
      {
        type: 'trapLapsed',
        seat: trap.seat,
        cardId: trap.cardId,
        spellId: trap.spellId,
        ...(fired.attachedTo === null ? {} : { attachedTo: fired.attachedTo }),
      },
      ...fired.events,
    );
    current = fired.board;
  }
  return { board: current, events };
}
