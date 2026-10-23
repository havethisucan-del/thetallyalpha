import type { Rng } from '../rng.js';
import type { Seat } from '../rules.js';
import type { CardCatalog } from './cards.js';

/**
 * Deck manager: card zones as plain JSON data plus pure, non-mutating operations.
 *
 * Ordering conventions (every zone is an array of card instance ids):
 * - `deck`: index 0 is the TOP; draws take from index 0.
 * - `graveyard`: order is irrelevant for play (it is shuffled before every draw, RD-23); new
 *   cards are appended.
 * - `hands[seat]`: drawn cards are appended.
 * - `stacks[seat]`: ordered bottom -> top; index 0 is the bottom. No legality here (RD-09 later).
 *
 * Rule violations return `{ ok: false, code, message }`; nothing here throws for game-rule
 * reasons. Throws are reserved for programmer errors (e.g. a negative draw count), consistent
 * with `Rng.nextInt`.
 */

export type CardId = string;

/** A physical card in this match; `id` is stable for the whole match. */
export interface CardInstance {
  readonly id: CardId;
  readonly defId: string;
}

export interface Zones {
  readonly deck: readonly CardId[];
  readonly graveyard: readonly CardId[];
  readonly hands: readonly [readonly CardId[], readonly CardId[]];
  readonly stacks: readonly [readonly CardId[], readonly CardId[]];
}

export type ZoneRef =
  | { readonly zone: 'deck' }
  | { readonly zone: 'graveyard' }
  | { readonly zone: 'hand'; readonly seat: Seat }
  | { readonly zone: 'stack'; readonly seat: Seat };

/** Dealing constants (RD-16, RD-21), kept as data. */
export const DEALING_RULES = Object.freeze({
  handSize: 9,
  initialPacketSize: 3,
  refillPacketSize: 1,
  mulliganMinHand: 2,
  mulliganMinDeck: 9,
});

export type ZoneErrorCode =
  | 'CARD_NOT_IN_ZONE'
  | 'SAME_ZONE'
  | 'DECK_TOO_SMALL'
  | 'DECK_NOT_EXHAUSTED'
  | 'MULLIGAN_HAND_TOO_SMALL'
  | 'MULLIGAN_DECK_TOO_SMALL';

export interface ZoneRejection<C extends ZoneErrorCode = ZoneErrorCode> {
  readonly ok: false;
  readonly code: C;
  readonly message: string;
}

export type ZoneResult<C extends ZoneErrorCode, TExtra = unknown> =
  ({ readonly ok: true; readonly zones: Zones } & TExtra) | ZoneRejection<C>;

/** Outcome of a graveyard draw: an empty graveyard is a normal "nothing drawn" result. */
export type GraveyardDrawResult =
  | { readonly drawn: true; readonly cardId: CardId; readonly zones: Zones }
  | { readonly drawn: false; readonly zones: Zones };

type MutableZones = {
  deck: CardId[];
  graveyard: CardId[];
  hands: [CardId[], CardId[]];
  stacks: [CardId[], CardId[]];
};

function copyZones(z: Zones): MutableZones {
  return {
    deck: [...z.deck],
    graveyard: [...z.graveyard],
    hands: [[...z.hands[0]], [...z.hands[1]]],
    stacks: [[...z.stacks[0]], [...z.stacks[1]]],
  };
}

function reject<C extends ZoneErrorCode>(code: C, message: string): ZoneRejection<C> {
  return { ok: false, code, message };
}

function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

function zoneArray(z: MutableZones, ref: ZoneRef): CardId[] {
  switch (ref.zone) {
    case 'deck':
      return z.deck;
    case 'graveyard':
      return z.graveyard;
    case 'hand':
      return z.hands[ref.seat];
    case 'stack':
      return z.stacks[ref.seat];
  }
}

function sameZone(a: ZoneRef, b: ZoneRef): boolean {
  if (a.zone !== b.zone) return false;
  return !('seat' in a) || !('seat' in b) || a.seat === b.seat;
}

/** In-place Fisher-Yates on a private copy. */
function shuffleInPlace(cards: CardId[], rng: Rng): void {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const a = cards[i] as CardId;
    cards[i] = cards[j] as CardId;
    cards[j] = a;
  }
}

/** Deterministic ids from catalog order: c01..c54 (zero-padded to at least two digits). */
export function createCardInstances(catalog: CardCatalog): readonly CardInstance[] {
  const width = Math.max(2, String(catalog.length).length);
  return catalog.map((def, i) => ({
    id: `c${String(i + 1).padStart(width, '0')}`,
    defId: def.defId,
  }));
}

/** RD-02: every card instance starts in the (unshuffled) deck, in catalog order. */
export function createZones(catalog: CardCatalog): Zones {
  return {
    deck: createCardInstances(catalog).map((c) => c.id),
    graveyard: [],
    hands: [[], []],
    stacks: [[], []],
  };
}

/** Every card id across all zones, in a fixed zone order. */
export function allCardIds(zones: Zones): CardId[] {
  return [
    ...zones.deck,
    ...zones.graveyard,
    ...zones.hands[0],
    ...zones.hands[1],
    ...zones.stacks[0],
    ...zones.stacks[1],
  ];
}

/** Where a card currently is, or null if it is not in any zone. */
export function findCard(zones: Zones, cardId: CardId): ZoneRef | null {
  if (zones.deck.includes(cardId)) return { zone: 'deck' };
  if (zones.graveyard.includes(cardId)) return { zone: 'graveyard' };
  for (const seat of [0, 1] as const) {
    if (zones.hands[seat].includes(cardId)) return { zone: 'hand', seat };
    if (zones.stacks[seat].includes(cardId)) return { zone: 'stack', seat };
  }
  return null;
}

export function shuffleDeck(zones: Zones, rng: Rng): Zones {
  const z = copyZones(zones);
  shuffleInPlace(z.deck, rng);
  return z;
}

/** Draws `n` cards from the top of the deck into `seat`'s hand; rejects if the deck is short. */
export function drawFromDeck(
  zones: Zones,
  seat: Seat,
  n: number,
): ZoneResult<'DECK_TOO_SMALL', { readonly drawn: readonly CardId[] }> {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`n must be a non-negative integer`);
  if (zones.deck.length < n) {
    return reject('DECK_TOO_SMALL', `cannot draw ${n}, deck has ${zones.deck.length}`);
  }
  const z = copyZones(zones);
  const drawn = z.deck.splice(0, n);
  z.hands[seat].push(...drawn);
  return { ok: true, zones: z, drawn };
}

/**
 * RD-23: the graveyard is ALWAYS shuffled before a draw from it (the shuffled order is kept in
 * the returned state). An empty graveyard draws nothing and consumes no randomness.
 */
export function drawFromGraveyard(zones: Zones, seat: Seat, rng: Rng): GraveyardDrawResult {
  if (zones.graveyard.length === 0) return { drawn: false, zones };
  const z = copyZones(zones);
  shuffleInPlace(z.graveyard, rng);
  const cardId = z.graveyard.shift() as CardId;
  z.hands[seat].push(cardId);
  return { drawn: true, cardId, zones: z };
}

/**
 * RD-93: `count` single draws for an effect (spell or creature modifier). Deck: an empty deck
 * draws nothing (RD-48), so a short deck gives fewer cards. Graveyard: shuffled before every
 * single draw, empty draws nothing (RD-23). No hand cap during a round (RD-77 as corrected).
 */
export function drawCards(
  zones: Zones,
  seat: Seat,
  from: 'deck' | 'graveyard',
  count: number,
  rng: Rng,
): { readonly zones: Zones; readonly drawn: readonly CardId[] } {
  let current = zones;
  const drawn: CardId[] = [];
  for (let i = 0; i < count; i++) {
    if (from === 'deck') {
      if (current.deck.length === 0) break; // RD-48
      const r = drawFromDeck(current, seat, 1);
      if (!r.ok) throw new Error(`unreachable: ${r.code}`);
      current = r.zones;
      drawn.push(...r.drawn);
    } else {
      const r = drawFromGraveyard(current, seat, rng); // RD-23
      if (!r.drawn) break;
      current = r.zones;
      drawn.push(r.cardId);
    }
  }
  return { zones: current, drawn };
}

/**
 * Moves one card between zones. The card goes to the end of the target array: top of a stack,
 * end of a hand/graveyard, and BOTTOM of the deck (callers shuffle when the rules require it).
 */
export function moveCard(
  zones: Zones,
  cardId: CardId,
  from: ZoneRef,
  to: ZoneRef,
): ZoneResult<'CARD_NOT_IN_ZONE' | 'SAME_ZONE'> {
  if (sameZone(from, to)) return reject('SAME_ZONE', 'source and target zone are the same');
  const z = copyZones(zones);
  const source = zoneArray(z, from);
  const index = source.indexOf(cardId);
  if (index === -1) return reject('CARD_NOT_IN_ZONE', `${cardId} is not in ${from.zone}`);
  source.splice(index, 1);
  zoneArray(z, to).push(cardId);
  return { ok: true, zones: z };
}

function cardsNeeded(zones: Zones): number {
  const { handSize } = DEALING_RULES;
  return (
    Math.max(0, handSize - zones.hands[0].length) + Math.max(0, handSize - zones.hands[1].length)
  );
}

/** RD-22: true when the deck can bring both hands up to the hand size. */
export function canRefillBoth(zones: Zones): boolean {
  return zones.deck.length >= cardsNeeded(zones);
}

/** Alternates packets of up to `packetSize` cards, starting with `firstSeat`, until both are full. */
function dealAlternating(
  zones: Zones,
  firstSeat: Seat,
  packetSize: number,
): ZoneResult<'DECK_TOO_SMALL'> {
  if (!canRefillBoth(zones)) {
    return reject(
      'DECK_TOO_SMALL',
      `need ${cardsNeeded(zones)} cards to fill both hands, deck has ${zones.deck.length}`,
    );
  }
  const { handSize } = DEALING_RULES;
  const z = copyZones(zones);
  let seat = firstSeat;
  while (z.hands[0].length < handSize || z.hands[1].length < handSize) {
    const take = Math.min(packetSize, Math.max(0, handSize - z.hands[seat].length));
    z.hands[seat].push(...z.deck.splice(0, take));
    seat = otherSeat(seat);
  }
  return { ok: true, zones: z };
}

/**
 * RD-21 round 1: deal alternately 3 cards at a time, starting with `firstSeat`, until both hands
 * hold 9. Which seat starts is decided by the caller.
 */
export function dealInitial(zones: Zones, firstSeat: Seat): ZoneResult<'DECK_TOO_SMALL'> {
  return dealAlternating(zones, firstSeat, DEALING_RULES.initialPacketSize);
}

/** RD-21 later rounds: refill alternately 1 card at a time until both hands hold 9. */
export function refillHands(zones: Zones, firstSeat: Seat): ZoneResult<'DECK_TOO_SMALL'> {
  return dealAlternating(zones, firstSeat, DEALING_RULES.refillPacketSize);
}

/**
 * RD-22 deck exhaustion: all hand cards return to the deck, the deck is shuffled and dealt
 * 1 at a time alternately (starting with `firstSeat`) so both seats get half; an odd leftover
 * card goes to the graveyard (pool > 18: RD-96, see below). Stacks are not touched. Applies only when the deck cannot refill
 * both hands; otherwise rejected with DECK_NOT_EXHAUSTED, unless `force` is set. The match layer
 * forces it because its final-round threshold is deck + hands <= 18 (RD-22 / RD-36 as changed
 * 2026-10-18, which also keeps every hand <= 9, RD-77) and for RD-40 replays (RD-74).
 */
export function dealFinalHands(
  zones: Zones,
  firstSeat: Seat,
  rng: Rng,
  force = false,
): ZoneResult<'DECK_NOT_EXHAUSTED'> {
  if (!force && canRefillBoth(zones)) {
    return reject('DECK_NOT_EXHAUSTED', 'the deck can still refill both hands');
  }
  const z = copyZones(zones);
  z.deck.push(...z.hands[0], ...z.hands[1]);
  z.hands = [[], []];
  shuffleInPlace(z.deck, rng);
  const { handSize } = DEALING_RULES;
  const pool = z.deck.length;
  // RD-77: a deal never gives a hand more than 9 cards.
  const perSeat = Math.min(Math.floor(pool / 2), handSize);
  let seat = firstSeat;
  for (let i = 0; i < perSeat * 2; i++) {
    z.hands[seat].push(z.deck.shift() as CardId);
    seat = otherSeat(seat);
  }
  if (pool <= 2 * handSize) {
    // RD-22: the odd leftover card goes to the graveyard.
    z.graveyard.push(...z.deck);
    z.deck = [];
  }
  // else RD-96 (Proposed): only reachable for an RD-40 replay after in-round draws grew the pool
  // above 18 during the final round (RD-77 as corrected allows hands above 9 in a round). Each
  // seat gets 9 and the rest stays in the (shuffled) deck.
  return { ok: true, zones: z };
}

/**
 * RD-95 (Proposed): refill used when the RD-87 pool is > 18 but the deck cannot bring both hands
 * to 9 because a hand grew above 9 during the round (RD-77 as corrected). Deals alternately 1 at
 * a time from `firstSeat` exactly like `refillHands`, but stops when the deck is empty. Never
 * takes cards from a hand and never deals a hand above 9 (RD-77).
 */
export function refillHandsFromAvailable(zones: Zones, firstSeat: Seat): Zones {
  const { handSize } = DEALING_RULES;
  const z = copyZones(zones);
  let seat = firstSeat;
  while (z.deck.length > 0 && (z.hands[0].length < handSize || z.hands[1].length < handSize)) {
    if (z.hands[seat].length < handSize) z.hands[seat].push(z.deck.shift() as CardId);
    seat = otherSeat(seat);
  }
  return z;
}

/**
 * RD-16 mulligan: requires hand >= 2 and deck >= 9 (checked before the hand is returned).
 * The whole hand returns to the deck, the deck is shuffled, and ceil(previousHandSize / 2)
 * cards are drawn (7 -> 4, 3 -> 2, 2 -> 1).
 */
export function mulligan(
  zones: Zones,
  seat: Seat,
  rng: Rng,
): ZoneResult<
  'MULLIGAN_HAND_TOO_SMALL' | 'MULLIGAN_DECK_TOO_SMALL',
  { readonly drawn: readonly CardId[] }
> {
  const hand = zones.hands[seat];
  if (hand.length < DEALING_RULES.mulliganMinHand) {
    return reject('MULLIGAN_HAND_TOO_SMALL', `hand has ${hand.length} card(s)`);
  }
  if (zones.deck.length < DEALING_RULES.mulliganMinDeck) {
    return reject('MULLIGAN_DECK_TOO_SMALL', `deck has ${zones.deck.length} card(s)`);
  }
  const z = copyZones(zones);
  z.deck.push(...z.hands[seat]);
  z.hands[seat] = [];
  shuffleInPlace(z.deck, rng);
  const drawn = z.deck.splice(0, Math.ceil(hand.length / 2));
  z.hands[seat].push(...drawn);
  return { ok: true, zones: z, drawn };
}
