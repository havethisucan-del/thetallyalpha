import type { Rng } from '../rng.js';
import type { Seat } from '../rules.js';
import type { Board } from './board.js';
import { projectPendingChoice, type PendingChoiceView } from './choices.js';
import type { CartignonMatchState } from './match.js';
import type { RoundState } from './round.js';
import type { CardId, Zones } from './zones.js';

/**
 * ADR-0016 (AI-M1): what one seat may know of a match, as a redacted, canonical match state for
 * bots, plus `determinize`, which samples the hidden cards back in.
 *
 * Hidden from `seat` (same table as projection.ts): the opponent's hand, the deck order and
 * contents, the opponent's looked-at cards (S-01) and the internals of the opponent's pending
 * choice. Everything else in `CartignonMatchState` is public or the seat's own (own hand, own
 * looked-at cards, own pending choice), and is kept as is.
 *
 * Own pending choice continuations were checked (spells.ts `ContinuationScratch`, spell-handlers.ts):
 * they hold the caster seat, `attachedTo` (a stack card), S-19 frames (played spell cards, public
 * through `spellPlayed`), the resolving spell (public) and S-18's chosen enemy (a stack card). No
 * continuation references a card hidden from its chooser, so the own choice needs no remapping.
 * The opponent's pending choice is replaced by its `PendingChoiceView` (options, for the
 * `handCreature` kind even their count, are hidden) and cannot be determinized.
 *
 * Canonical: two matches that differ only in which hidden card sits in which hidden slot give
 * deep-equal observations (the unknown pool is sorted; hidden slots keep only their sizes).
 */

export interface HiddenCounts {
  /** Opponent hand size, including `known.opponentHand`. */
  readonly opponentHand: number;
  /** Deck size, including `known.deck`. */
  readonly deck: number;
  /** The opponent's looked-at cards (S-01); only non-zero while it has a pending choice. */
  readonly opponentLookingAt: number;
}

export interface SeatObservation {
  readonly seat: Seat;
  /**
   * The match with every hidden card removed: the opponent's hand and the deck are empty arrays,
   * the opponent's looked-at cards and pending choice are absent. Not a playable state: sample a
   * complete one with `determinize`.
   */
  readonly match: CartignonMatchState;
  readonly hidden: HiddenCounts;
  /**
   * Cards in a hidden zone whose zone is public anyway: replay-locked cards (`turnLocks`, S-09 /
   * S-16 return a creature to its owner's hand, RD-117). Sorted by id. Their order within the zone
   * stays unknown.
   */
  readonly known: { readonly opponentHand: readonly CardId[]; readonly deck: readonly CardId[] };
  /**
   * Every card `seat` cannot locate, sorted by id: the cards of the hidden slots minus `known`.
   */
  readonly unknown: readonly CardId[];
  /** The opponent's pending choice as `seat` sees it (`pendingChoiceView`), else null. */
  readonly opponentChoice: PendingChoiceView | null;
}

/** Thrown by `determinize` for an observation it cannot complete (see there). */
export class UndeterminizableObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndeterminizableObservationError';
  }
}

function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

function sortedIds(ids: readonly CardId[]): CardId[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function shuffled(ids: readonly CardId[], rng: Rng): CardId[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const a = out[i] as CardId;
    out[i] = out[j] as CardId;
    out[j] = a;
  }
  return out;
}

function withHand(hands: Zones['hands'], seat: Seat, hand: readonly CardId[]): Zones['hands'] {
  return seat === 0 ? [hand, hands[1]] : [hands[0], hand];
}

/** The redacted, canonical observation of `match` for `seat` (pure; `match` is not mutated). */
export function observeForSeat(match: CartignonMatchState, seat: Seat): SeatObservation {
  const opponent = otherSeat(seat);
  const round = match.round;
  const board = round.board;
  const zones = board.zones;
  const opponentLooking = board.lookingAt?.seat === opponent ? board.lookingAt.cardIds : [];
  const locked = new Set((round.turnLocks ?? []).map((l) => l.cardId));
  const knownHand = sortedIds(zones.hands[opponent].filter((id) => locked.has(id)));
  const knownDeck = sortedIds(zones.deck.filter((id) => locked.has(id)));
  const unknown = sortedIds(
    [...zones.hands[opponent], ...zones.deck, ...opponentLooking].filter((id) => !locked.has(id)),
  );

  const redactedZones: Zones = {
    deck: [],
    graveyard: zones.graveyard,
    hands: withHand(zones.hands, opponent, []),
    stacks: zones.stacks,
  };
  const redactedBoard: { -readonly [K in keyof Board]: Board[K] } = {
    ...board,
    zones: redactedZones,
  };
  if (opponentLooking.length > 0) delete redactedBoard.lookingAt;

  const pending = round.pendingChoice;
  const opponentChoice =
    pending !== undefined && pending.seat !== seat ? projectPendingChoice(pending, seat) : null;
  const redactedRound: { -readonly [K in keyof RoundState]: RoundState[K] } = {
    ...round,
    board: redactedBoard,
  };
  if (opponentChoice !== null) delete redactedRound.pendingChoice;

  return {
    seat,
    match: { ...match, round: redactedRound },
    hidden: {
      opponentHand: zones.hands[opponent].length,
      deck: zones.deck.length,
      opponentLookingAt: opponentLooking.length,
    },
    known: { opponentHand: knownHand, deck: knownDeck },
    unknown,
    opponentChoice,
  };
}

/**
 * Samples a complete match consistent with `obs`: the unknown cards are shuffled uniformly with
 * `rng` and fill the opponent's hand (after its `known` cards), then the deck (`known` deck cards
 * are shuffled in with the rest; sizes from `obs.hidden`). It uses no
 * inference from the opponent's past behaviour. Throws `UndeterminizableObservationError` while
 * the opponent has a pending choice: its options depend on the opponent's hidden hand or
 * looked-at cards. A bot only decides when it is the acting seat, and then any pending choice is
 * its own, so this never happens at a bot decision point.
 */
export function determinize(obs: SeatObservation, rng: Rng): CartignonMatchState {
  if (obs.opponentChoice !== null || obs.hidden.opponentLookingAt > 0) {
    throw new UndeterminizableObservationError(
      "cannot determinize while the opponent's pending choice hides its options",
    );
  }
  const known = obs.known;
  const handFill = obs.hidden.opponentHand - known.opponentHand.length;
  if (handFill < 0 || handFill + obs.hidden.deck - known.deck.length !== obs.unknown.length) {
    throw new UndeterminizableObservationError('hidden slot sizes do not match the unknown pool');
  }
  const pool = shuffled(obs.unknown, rng);
  const hand = [...known.opponentHand, ...pool.slice(0, handFill)];
  const deck = shuffled([...known.deck, ...pool.slice(handFill)], rng);
  const opponent = otherSeat(obs.seat);
  const round = obs.match.round;
  const zones = round.board.zones;
  return {
    ...obs.match,
    round: {
      ...round,
      board: {
        ...round.board,
        zones: {
          ...zones,
          hands: withHand(zones.hands, opponent, hand),
          deck,
        },
      },
    },
  };
}
