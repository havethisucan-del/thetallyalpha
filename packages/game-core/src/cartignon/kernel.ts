import type { Rng } from '../rng.js';
import type { Seat } from '../rules.js';
import {
  ownerOf,
  placeBySpell,
  removeFromStacks as removeBoardCards,
  replaceLeader as replaceBoardLeader,
  swapStacks as swapBoardStacks,
  takeControl as takeBoardControl,
  type AttachedEffect,
  type Board,
  type BoardEvent,
  type CardIndex,
  type CopiedModifier,
  type StackEffect,
} from './board.js';
import type { ModifierKind, SecondarySpec, SpellDrawSource } from './cards.js';
import type { RoundEvent } from './round.js';
import {
  drawCards,
  drawFromGraveyard,
  findCard,
  shuffleDeck,
  type CardId,
  type Zones,
} from './zones.js';

/**
 * Spell kernel (ADR-0007 section 2, R4c-1): the typed primitives spell handlers use to change the
 * board. The kernel, not the handler, owns every invariant:
 * - Activation edges (ADR-0007 section 4): every stack-changing primitive goes through the board
 *   layer, which compares each stack's live (Leading card, position) before and after the
 *   operation (`settleLiveness` in board.ts). On a new edge the Leading card's
 *   `modifiers[pos - 1]` activates: Link Up arms in the board layer, and draw modifiers are
 *   executed here by `applyModifierDraws` right after the primitive. A handler cannot skip or
 *   reorder that, because it never sees board operations or the RNG.
 * - RNG: only the kernel (round layer) calls it; handlers receive primitives, never `rng`.
 * - Purity: the input board is never mutated; each primitive replaces the session's board.
 */

/**
 * RD-98: executes the creature draw modifiers that just went live in `boardEvents` (the
 * activation edges of one board operation, see board.ts). For each `modifierLive` of kind
 * drawDeck / drawGrave, the stack's controller draws 1 card (RD-123): deck (empty -> nothing,
 * RD-48) or graveyard (shuffled first, empty -> nothing, RD-23). Returns the board events in their
 * order with a `cardsDrawn` event right after each draw activation. The only RNG use is the
 * graveyard shuffle, so replays stay deterministic. Shared by normal plays, nullify, the spell
 * kernel and the match layer (RD-19 tie-break links, RD-122).
 */
export function applyModifierDraws(
  board: Board,
  boardEvents: readonly BoardEvent[],
  rng: Rng,
): { readonly board: Board; readonly events: readonly RoundEvent[] } {
  let zones = board.zones;
  const events: RoundEvent[] = [];
  for (const e of boardEvents) {
    events.push(e);
    if (e.type !== 'modifierLive' || (e.kind !== 'drawDeck' && e.kind !== 'drawGrave')) continue;
    const from = e.kind === 'drawDeck' ? 'deck' : 'graveyard';
    const r = drawCards(zones, e.seat, from, 1, rng);
    zones = r.zones;
    events.push({
      type: 'cardsDrawn',
      seat: e.seat,
      reason: from === 'deck' ? 'modifierDeck' : 'modifierGraveyard',
      cardIds: r.drawn,
    });
  }
  const next = zones === board.zones ? board : { ...board, zones };
  return { board: pruneNegated(next, boardEvents), events };
}

/**
 * RD-109 (S-12): a negated activation lasts only while its card stays Leading at that position.
 * Every stack change reports a silenced card with `modifierSilenced`, so those entries go here.
 */
function pruneNegated(board: Board, boardEvents: readonly BoardEvent[]): Board {
  const negated = board.negatedModifiers;
  if (negated === undefined) return board;
  const silenced = new Set(
    boardEvents.flatMap((e) => (e.type === 'modifierSilenced' ? [e.cardId] : [])),
  );
  const kept = negated.filter((n) => !silenced.has(n.cardId));
  if (kept.length === negated.length) return board;
  return withNegatedModifiers(board, kept);
}

/** `board` with `negatedModifiers` set; an empty list removes the field. */
export function withNegatedModifiers(board: Board, negated: Board['negatedModifiers']): Board {
  const rest: { -readonly [K in keyof Board]: Board[K] } = { ...board };
  delete rest.negatedModifiers;
  return negated === undefined || negated.length === 0
    ? rest
    : { ...rest, negatedModifiers: negated };
}

/** RD-115: runs a Secondary with fixed targets through `k`; a missing target does nothing. */
export function runSecondary(k: SpellKernel, spec: SecondarySpec): void {
  switch (spec.kind) {
    case 'none':
      return;
    case 'buffOwnLeader': {
      const leader = k.board.zones.stacks[k.caster].at(-1);
      if (leader !== undefined) k.attachAtk(leader, spec.amount);
      return;
    }
    case 'nerfEnemyLeader': {
      const leader = k.board.zones.stacks[k.opponent].at(-1);
      if (leader !== undefined) k.attachAtk(leader, -spec.amount);
      return;
    }
    case 'draw':
      k.draw(k.caster, spec.from, spec.count);
      return;
  }
}

/**
 * The result of settling one creature placement (`PlacementSettler`): the board and events after
 * the activation edge (draw modifiers) and any trap the placement triggered (R4c-4), plus replay
 * locks the traps made (S-16, already announced by a `replayLocked` event).
 */
export interface PlacementOutcome {
  readonly board: Board;
  readonly events: readonly RoundEvent[];
  readonly locks: readonly TurnLock[];
}

/**
 * Settles a placement of `cardId` on `placer`'s stack (`boardEvents` = the board operation's
 * events). The default is `applyModifierDraws`; the round layer injects the trap-aware version
 * (traps.ts `settlePlacement`) so the kernel itself does not depend on trap rules.
 */
export type PlacementSettler = (
  board: Board,
  boardEvents: readonly BoardEvent[],
  placer: Seat,
  cardId: CardId,
) => PlacementOutcome;

/**
 * Where a creature removed by a spell goes. `ownerHand`: its owner's hand (RD-104), i.e. the hand
 * of the seat whose stack it was on (RD-131 / RD-135: ownership follows the stack).
 */
export type KernelExit = 'graveyard' | 'ownerHand';

/** Where a replaced Leading creature goes (`replaceLeader`): S-07 deck, S-09 owner's hand. */
export type LeaderExit = KernelExit | 'deck';

/**
 * ADR-0007 `turnLocks` (RD-117, S-09): `seat` may not play `cardId` until the current turn ends.
 * Stored in `RoundState.turnLocks`; cleared whenever a turn ends.
 */
export interface TurnLock {
  readonly seat: Seat;
  readonly cardId: CardId;
}

/**
 * What a spell handler may do. `board` is read-only and always current (the spell itself is in
 * resolution, in no zone).
 */
export interface SpellKernel {
  readonly cards: CardIndex;
  readonly caster: Seat;
  readonly opponent: Seat;
  readonly board: Board;
  /**
   * The caster's replay-locked cards (`turnLocks`, including locks made by this spell). RD-145
   * (Proposed): a spell does not place a locked card either.
   */
  readonly locked: readonly CardId[];
  /** RD-93: `count` single draws for `seat`; a graveyard draw shuffles first (RD-23). */
  draw(seat: Seat, from: SpellDrawSource, count: number): readonly CardId[];
  /**
   * RD-105 / RD-104: removes the creatures (either stack) as ONE primitive: the cards above shift
   * down, and the activation edge is evaluated once, after the last removal.
   */
  removeFromStacks(cardIds: readonly CardId[], to: KernelExit): void;
  /**
   * RD-114 (S-01): moves up to `count` cards from the top of the deck into the caster's hidden
   * "looking at" area (`Board.lookingAt`, not the hand). An empty deck gives fewer (RD-48).
   */
  lookAtDeck(count: number): readonly CardId[];
  /**
   * RD-114 (S-01): ends looking: `keep` (a subset of the looked-at cards) enters the caster's hand,
   * the rest goes back into the deck, which is then shuffled. Nothing returned -> no shuffle
   * (RD-140, Proposed).
   */
  settleLookedAt(keep: readonly CardId[]): void;
  /**
   * ADR-0007 "Placement by a spell" (RD-108 / RD-117): places a creature from the caster's hand on
   * the caster's stack like a normal play (Link Up used up, activation edge), ignoring the level.
   */
  placeOnStack(cardId: CardId): void;
  /**
   * RD-127 / RD-108 (S-07, S-09): atomically replaces `seat`'s Leading creature with `newCardId`
   * from `seat`'s hand (board.ts `replaceLeader`). `deck` puts the old creature at the bottom of
   * the deck; the handler shuffles with `shuffleDeck`.
   */
  replaceLeader(seat: Seat, newCardId: CardId, oldTo: LeaderExit): void;
  /** RD-106 / RD-131 (S-13, S-17): the caster takes control of an enemy creature. */
  takeControl(cardId: CardId): void;
  /** RD-110 (S-13): cards from `seat`'s hand to the graveyard. */
  discard(seat: Seat, cardIds: readonly CardId[]): void;
  /** RD-110 (S-17): cards from `seat`'s hand to the bottom of the deck (no shuffle). */
  returnHandCards(seat: Seat, cardIds: readonly CardId[]): void;
  /** Shuffles the deck (round RNG; the kernel owns it). */
  shuffleDeck(): void;
  /**
   * RD-117 (S-09), RD-172 (S-04, S-11, S-18): `seat` may not play `cardId` again this turn
   * (`turnLocks`).
   */
  lockReplay(seat: Seat, cardId: CardId): void;
  /** RD-107: whole stacks change sides; no activation edge. */
  swapStacks(): void;
  /** RD-12 / RD-55: an ATK change attached to a creature on a stack until round end. */
  attachAtk(cardId: CardId, amount: number): void;
  /** S-15: an ATK change on `seat`'s whole stack until round end. */
  addStackAtk(seat: Seat, amount: number): void;
  /** RD-111: fires a copy of `kind` (taken from `sourceCardId`) for the caster at once. */
  fireCopiedModifier(kind: ModifierKind, sourceCardId: CardId): void;
  /**
   * ADR-0007 `armTrap` (RD-101, S-12 / S-16): when the spell finishes it is armed on `seat`'s side
   * (`Board.armedTraps`) instead of going to the graveyard.
   */
  armTrap(seat: Seat): void;
  /**
   * S-19 (R4c-5, RD-158): draws 1 random card from the graveyard (RD-23: shuffled first, round RNG)
   * into no zone, revealed to both seats (`gambitDrawn`). The handler must then place it
   * (`placeOnStack`, a creature) or hand it to the opponent (`playForOpponent`, a spell). An empty
   * graveyard gives undefined (`gambitDrawn` without `drawnCardId`).
   */
  drawRandomFromGraveyard(): CardId | undefined;
  /**
   * S-19 (RD-112, R4c-5): the revealed spell `cardId` is played at once by the caster's opponent in
   * best-effort mode; spells.ts starts that nested resolution when this session finishes.
   */
  playForOpponent(cardId: CardId): void;
}

export interface KernelOutcome {
  readonly board: Board;
  readonly events: readonly RoundEvent[];
  /** The first creature this spell attached an effect to, if any (RD-12 / RD-14 destination). */
  readonly attachedTo: CardId | null;
  /**
   * Replay locks made in this session (`lockReplay`, and S-16 traps fired by its placements); the
   * round layer stores them.
   */
  readonly locks: readonly TurnLock[];
  /** `armTrap`: the side the finished spell is armed on, or null (R4c-4). */
  readonly armedOn: Seat | null;
  /** `playForOpponent` (S-19, R4c-5): the revealed spell the opponent now plays, or null. */
  readonly handedOff: CardId | null;
}

function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

/**
 * Session flags that outlive a suspension (R4c-2): restored from the pending choice's
 * continuation when a handler resumes, so a suspend/resume boundary changes nothing.
 */
export interface KernelCarry {
  readonly attachedTo: CardId | null;
  /** `armTrap` (R4c-4). Absent = null. */
  readonly armedOn?: Seat | null;
}

/**
 * Opens a kernel session for one spell resolution (or one resumed segment of it, `carry`).
 * `board` must already have the spell out of its owner's hand. `finish` returns the resulting
 * board and the ordered events of this session. `onPlacement` settles every placement on the
 * caster's stack (`placeOnStack`, `replaceLeader`, `takeControl`); default `applyModifierDraws`.
 */
export function createSpellKernel(
  cards: CardIndex,
  board: Board,
  caster: Seat,
  spellCardId: CardId,
  rng: Rng,
  carry: KernelCarry = { attachedTo: null },
  locked: readonly CardId[] = [],
  onPlacement?: PlacementSettler,
): { readonly kernel: SpellKernel; finish(): KernelOutcome } {
  let current = board;
  const events: RoundEvent[] = [];
  let attachedTo: CardId | null = carry.attachedTo;
  let armedOn: Seat | null = carry.armedOn ?? null;
  const opponent = otherSeat(caster);
  const locks: TurnLock[] = [];
  let casterLocked: readonly CardId[] = [...locked];
  /** S-19: the card drawn by `drawRandomFromGraveyard`, in no zone until placed or handed off. */
  let revealed: CardId | null = null;
  let handedOff: CardId | null = null;

  /** Moves cards out of `seat`'s hand (programmer error if one is not there). */
  const takeFromHand = (seat: Seat, cardIds: readonly CardId[]): Zones => {
    const hand = current.zones.hands[seat];
    if (new Set(cardIds).size !== cardIds.length || cardIds.some((c) => !hand.includes(c))) {
      throw new Error(`spell handler bug: cards not in seat ${seat}'s hand`);
    }
    const rest = hand.filter((c) => !cardIds.includes(c));
    const hands = current.zones.hands;
    return { ...current.zones, hands: seat === 0 ? [rest, hands[1]] : [hands[0], rest] };
  };

  /** Every stack change ends here: the activation edges' draws are not optional. */
  const commit = (next: Board, boardEvents: readonly BoardEvent[]): void => {
    const r = applyModifierDraws(next, boardEvents, rng);
    current = r.board;
    events.push(...r.events);
  };

  /** A placement of `cardId` on the caster's stack: activation edge plus traps (R4c-4). */
  const commitPlacement = (next: Board, boardEvents: readonly BoardEvent[], cardId: CardId) => {
    if (onPlacement === undefined) {
      commit(next, boardEvents);
      return;
    }
    const r = onPlacement(next, boardEvents, caster, cardId);
    current = r.board;
    events.push(...r.events);
    for (const lock of r.locks) {
      locks.push(lock);
      if (lock.seat === caster) casterLocked = [...casterLocked, lock.cardId];
    }
  };

  const nextEffectId = (): string => {
    const id = `e${current.nextEffectSeq}`;
    current = { ...current, nextEffectSeq: current.nextEffectSeq + 1 };
    return id;
  };

  const kernel: SpellKernel = {
    cards,
    caster,
    opponent,
    get board(): Board {
      return current;
    },
    get locked(): readonly CardId[] {
      return casterLocked;
    },
    draw(seat, from, count) {
      const r = drawCards(current.zones, seat, from, count, rng);
      current = { ...current, zones: r.zones };
      events.push(
        {
          type: 'cardsDrawn',
          seat,
          reason: from === 'deck' ? 'spellDeck' : 'spellGraveyard',
          cardIds: r.drawn,
        },
        { type: 'spellDrawResolved', seat, from, requested: count, drawn: r.drawn.length },
      );
      return r.drawn;
    },
    lookAtDeck(count) {
      if (current.lookingAt !== undefined) {
        throw new Error('spell handler bug: already looking at cards');
      }
      const cardIds = current.zones.deck.slice(0, Math.max(0, count));
      const zones = { ...current.zones, deck: current.zones.deck.slice(cardIds.length) };
      current = { ...current, zones };
      if (cardIds.length > 0) current = { ...current, lookingAt: { seat: caster, cardIds } };
      // No `spellDrawResolved`: nothing enters the hand; `cardsLookedAt` carries the count.
      events.push({ type: 'cardsLookedAt', seat: caster, cardIds });
      return cardIds;
    },
    settleLookedAt(keep) {
      const looked = current.lookingAt?.cardIds ?? [];
      if (keep.some((id) => !looked.includes(id))) {
        throw new Error('spell handler bug: kept card was not looked at');
      }
      const kept = looked.filter((id) => keep.includes(id));
      const returned = looked.filter((id) => !keep.includes(id));
      const rest: { -readonly [K in keyof Board]: Board[K] } = { ...current };
      delete rest.lookingAt;
      const hands = current.zones.hands;
      const hand = [...hands[caster], ...kept];
      let zones: Zones = {
        ...current.zones,
        deck: [...current.zones.deck, ...returned],
        hands: caster === 0 ? ([hand, hands[1]] as const) : ([hands[0], hand] as const),
      };
      // RD-114: the returned card goes into the deck, which is shuffled (RNG: kernel only).
      // RD-140 (Proposed): nothing returned -> the deck is not shuffled.
      const deckShuffled = returned.length > 0;
      if (deckShuffled) zones = shuffleDeck(zones, rng);
      current = { ...rest, zones };
      events.push({ type: 'lookedAtSettled', seat: caster, kept, returned, deckShuffled });
    },
    placeOnStack(cardId) {
      let from = current;
      if (cardId === revealed) {
        // S-19 (RD-120): the revealed creature is placed like a hand creature (no hand event).
        revealed = null;
        const hands = current.zones.hands;
        const hand = [...hands[caster], cardId];
        from = {
          ...current,
          zones: {
            ...current.zones,
            hands: caster === 0 ? [hand, hands[1]] : [hands[0], hand],
          },
        };
      }
      const r = placeBySpell(cards, from, caster, cardId);
      if (!r.ok) throw new Error(`spell handler bug: ${r.message}`);
      commitPlacement(r.board, r.events, cardId);
    },
    removeFromStacks(cardIds, to) {
      const removals = cardIds.map((cardId) => {
        if (to === 'graveyard') return { cardId, to: { zone: 'graveyard' } as const };
        const owner = ownerOf(current, cardId);
        if (owner === undefined) throw new Error(`spell handler bug: ${cardId} is not on a stack`);
        return { cardId, to: { zone: 'hand', seat: owner } as const };
      });
      const r = removeBoardCards(cards, current, removals);
      if (!r.ok) throw new Error(`spell handler bug: ${r.message}`);
      commit(r.board, r.events);
    },
    replaceLeader(seat, newCardId, oldTo) {
      const to =
        oldTo === 'deck'
          ? ({ zone: 'deck' } as const)
          : oldTo === 'graveyard'
            ? ({ zone: 'graveyard' } as const)
            : ({ zone: 'hand', seat } as const); // RD-135: owner = the stack's seat.
      const r = replaceBoardLeader(cards, current, seat, newCardId, to);
      if (!r.ok) throw new Error(`spell handler bug: ${r.message}`);
      // The new Leading creature is placed on `seat`'s stack (only the caster's in practice).
      if (seat === caster) commitPlacement(r.board, r.events, newCardId);
      else commit(r.board, r.events);
    },
    takeControl(cardId) {
      const r = takeBoardControl(cards, current, caster, cardId);
      if (!r.ok) throw new Error(`spell handler bug: ${r.message}`);
      // RD-146: a normal placement for the taker (RD-152: it can trigger the opponent's traps).
      commitPlacement(r.board, r.events, cardId);
    },
    discard(seat, cardIds) {
      const zones = takeFromHand(seat, cardIds);
      current = { ...current, zones: { ...zones, graveyard: [...zones.graveyard, ...cardIds] } };
      events.push({ type: 'cardsDiscarded', seat, cardIds: [...cardIds] });
    },
    returnHandCards(seat, cardIds) {
      const zones = takeFromHand(seat, cardIds);
      current = { ...current, zones: { ...zones, deck: [...zones.deck, ...cardIds] } };
      events.push({ type: 'handCardsReturned', seat, cardIds: [...cardIds] });
    },
    shuffleDeck() {
      current = { ...current, zones: shuffleDeck(current.zones, rng) };
      events.push({ type: 'deckShuffled', seat: caster });
    },
    lockReplay(seat, cardId) {
      locks.push({ seat, cardId });
      if (seat === caster) casterLocked = [...casterLocked, cardId];
      events.push({ type: 'replayLocked', seat, cardId });
    },
    swapStacks() {
      const r = swapBoardStacks(current);
      commit(r.board, r.events);
    },
    attachAtk(cardId, amount) {
      if (findCard(current.zones, cardId)?.zone !== 'stack') {
        throw new Error(`spell handler bug: ${cardId} is not on a stack`);
      }
      const effect: AttachedEffect = {
        effectId: nextEffectId(),
        kind: 'atkDelta',
        amount,
        sourceCardId: spellCardId,
        targetCardId: cardId,
      };
      current = { ...current, attachedEffects: [...current.attachedEffects, effect] };
      events.push({ type: 'effectAttached', effect });
      attachedTo ??= cardId;
    },
    addStackAtk(seat, amount) {
      const effect: StackEffect = {
        effectId: nextEffectId(),
        kind: 'stackAtkDelta',
        seat,
        amount,
        sourceCardId: spellCardId,
      };
      current = { ...current, stackEffects: [...current.stackEffects, effect] };
      events.push({ type: 'stackEffectAdded', effect });
    },
    fireCopiedModifier(kind, sourceCardId) {
      events.push({ type: 'modifierCopied', seat: caster, sourceCardId, kind });
      const ownLeader = current.zones.stacks[caster].at(-1);
      switch (kind) {
        case 'buffSelf':
        case 'nerfEnemyLeader':
          // RD-133: a positional-style modifier carried by the caster's Leading creature for the
          // rest of the round; liveness is derived (board.ts `isCopyLive`). The S-06 card
          // attaches to the carrier.
          if (ownLeader !== undefined) {
            const modifier: CopiedModifier = {
              effectId: nextEffectId(),
              kind,
              carrierCardId: ownLeader,
              sourceCardId: spellCardId,
            };
            current = { ...current, copiedModifiers: [...current.copiedModifiers, modifier] };
            events.push({ type: 'copiedModifierAdded', modifier });
            attachedTo ??= ownLeader;
          }
          break;
        case 'linkUp':
          // RD-111: the caster gets a legally active Link Up (RD-10, RD-51: no double arming).
          // RD-133: already armed -> the Primary still ran; Link Up stays a single armed one.
          if (!current.linkUpPending[caster] && ownLeader !== undefined) {
            const linkUpPending: [boolean, boolean] = [
              current.linkUpPending[0],
              current.linkUpPending[1],
            ];
            linkUpPending[caster] = true;
            // RD-139: the carrier (the caster's Leading creature) owns this Link Up.
            const linkUpSource: [CardId | null, CardId | null] = [
              current.linkUpSource[0],
              current.linkUpSource[1],
            ];
            linkUpSource[caster] = ownLeader;
            current = { ...current, linkUpPending, linkUpSource };
            events.push({ type: 'linkUpArmed', seat: caster, sourceCardId: ownLeader });
          }
          break;
        case 'drawDeck':
        case 'drawGrave': {
          // RD-111: the caster draws 1 from that source (RD-48 / RD-23).
          const from = kind === 'drawDeck' ? 'deck' : 'graveyard';
          const r = drawCards(current.zones, caster, from, 1, rng);
          current = { ...current, zones: r.zones };
          events.push({
            type: 'cardsDrawn',
            seat: caster,
            reason: from === 'deck' ? 'modifierDeck' : 'modifierGraveyard',
            cardIds: r.drawn,
          });
          break;
        }
      }
    },
    armTrap(seat) {
      armedOn = seat;
    },
    drawRandomFromGraveyard() {
      if (revealed !== null || handedOff !== null) {
        throw new Error('spell handler bug: a revealed graveyard card is still unresolved');
      }
      // RD-23 / RD-158: the same pick as every graveyard draw (shuffle, then the top card).
      const r = drawFromGraveyard(current.zones, caster, rng);
      if (!r.drawn) {
        events.push({ type: 'gambitDrawn', seat: caster, cardId: spellCardId });
        return undefined;
      }
      // Out of the hand again at once: the card is revealed, in no zone (never a hand card).
      const hands = r.zones.hands;
      const hand = hands[caster].filter((c) => c !== r.cardId);
      current = {
        ...current,
        zones: { ...r.zones, hands: caster === 0 ? [hand, hands[1]] : [hands[0], hand] },
      };
      revealed = r.cardId;
      events.push({
        type: 'gambitDrawn',
        seat: caster,
        cardId: spellCardId,
        drawnCardId: r.cardId,
        drawnKind: cards[r.cardId]?.kind === 'creature' ? 'creature' : 'spell',
      });
      return r.cardId;
    },
    playForOpponent(cardId) {
      if (cardId !== revealed || cards[cardId]?.kind !== 'spell') {
        throw new Error(`spell handler bug: ${cardId} is not the revealed spell`);
      }
      revealed = null;
      handedOff = cardId;
    },
  };

  return {
    kernel,
    finish: () => {
      if (revealed !== null) throw new Error('spell handler bug: revealed card left unresolved');
      return { board: current, events, attachedTo, locks, armedOn, handedOff };
    },
  };
}
