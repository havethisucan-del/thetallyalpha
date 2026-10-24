import type { Rng } from '../rng.js';
import type { Seat } from '../rules.js';
import { linkCreature, stackAtk, type Board } from './board.js';
import type { CardCatalog } from './cards.js';
import { COLORS, type Color } from './colors.js';
import { spellCanDrawFromGraveyard } from './spells.js';
import { applyModifierDraws } from './kernel.js';
import {
  applyCommand,
  applyTimeoutSkip,
  legalCommands,
  roundCatalogIssues,
  startFirstRound,
  startRound,
  type RoundCommand,
  type RoundContext,
  type RoundErrorCode,
  type RoundEvent,
  type RoundResult,
  type RoundState,
} from './round.js';
import {
  dealFinalHands,
  DEALING_RULES,
  refillHands,
  refillHandsFromAvailable,
  shuffleDeck,
  type CardId,
  type Zones,
} from './zones.js';

/**
 * Match layer (R5): round resolution, tokens, cleanup, next-round setup and match end.
 *
 * Flow after a round reaches `roundOver` (R3), see `finishRound`:
 *   1. `resolveRound`     End Turn outcome (RD-169: opponent ahead wins; equal-ATK stall goes to
 *                         the tie-break RD-19, RD-38, RD-42, RD-72), draw on a P1 Base-step End
 *                         Turn (RD-67).
 *   2. `awardToken`       RD-03 / RD-26 (winner's Leading Minion color; supply / steal / protect).
 *   3. `cleanupRound`     RD-20 / RD-58 bulk cleanup, drawn round RD-71, attached spells RD-82.
 *   4. `evaluateMatchEnd` RD-24 (all 7 tokens held, or final round played), RD-40 replay with
 *                         the RD-81 cap.
 *   5. `setupNextRound`   RD-36 / RD-22 final-round check (RD-87 pool <= 18), RD-21 / RD-32
 *                         refill, RD-76 re-deal, RD-04 P1 alternation, RD-70 clean start.
 *
 * Hand limit (RD-77, corrected 2026-10-18): no DEAL here gives a hand more than
 * `DEALING_RULES.handSize` (9). During a round hands may exceed 9 (spell draws); a refill then
 * gives that hand 0 cards and never discards.
 *
 * RNG consumption order in `finishRound` (part of determinism): tie-break returns (one shuffle per
 * seat search that set cards aside, RD-38), cleanup deck shuffle (RD-20), first-receiving seat
 * (RD-32), then either the final-hand shuffle (RD-22) or, for an RD-76 re-deal, its shuffle and
 * its own first-receiving seat. Within the tie-break, each seat's search does its set-aside
 * shuffle first, then the graveyard shuffle of a drawGrave modifier that goes live on its link
 * (RD-98, RD-23; `applyModifierDraws`). A drawDeck link consumes no randomness.
 *
 * All functions are pure: inputs are never mutated; state is JSON-serializable. Rule violations
 * return `{ ok: false, code, message }`; throws are reserved for programmer errors (broken
 * invariants).
 */

/** RD-22 / RD-36 / RD-87: the final round happens when the pool after cleanup is <= 18. */
export const FINAL_ROUND_MAX_CARDS = 2 * DEALING_RULES.handSize;

/** RD-81: at most 2 replays of the final round on a token tie; then the match is a draw. */
export const MAX_FINAL_ROUND_REPLAYS = 2;

/**
 * RD-89: N consecutive rounds without progress end the match by token count. N = 7 was set by the
 * user on 2026-10-19 after the R5b self-play (RD-90, RQ-35).
 */
export const NO_PROGRESS_ROUND_LIMIT = 7;

// ---------------------------------------------------------------------------------------------
// Types

/** RD-03: a token is held by a seat or still in the supply (null). */
export type TokenHolder = Seat | null;
export type TokenMap = Readonly<Record<Color, TokenHolder>>;

/** RD-26: what the round winner's token claim did. */
export type TokenChangeKind = 'awarded' | 'stolen' | 'protected';

export interface TokenChange {
  readonly seat: Seat;
  readonly color: Color;
  readonly kind: TokenChangeKind;
  /** The winner's Leading Minion that decided the color. */
  readonly leadingCardId: CardId;
}

/** RD-169: `opponentAhead` (the ending seat was behind) or the equal-ATK stall's `tieBreak`. */
export type RoundDecision = 'opponentAhead' | 'tieBreak';

export type RoundOutcome =
  | {
      readonly kind: 'win';
      readonly winner: Seat;
      readonly decidedBy: RoundDecision;
      /** Final stack ATK per seat (after any tie-break links). */
      readonly atk: readonly [number, number];
      readonly tieBreakIterations: number;
    }
  | {
      readonly kind: 'draw';
      readonly reason: 'p1NoBase' | 'tieBreakDeckOut';
      readonly atk: readonly [number, number];
      readonly tieBreakIterations: number;
    };

/**
 * - allTokensHeld / finalRoundPlayed: RD-24, winner = more tokens.
 * - replaysExhausted: RD-81, still tied after the 2nd replay -> draw.
 * - replayImpossible: RD-75, the replay hands hold no creature -> draw.
 * - noCreaturesLeft: RD-84, no creature in deck + hands at an RD-76 re-deal AND no card there
 *   that could still draw one back from the graveyard; winner = more tokens, tie = draw.
 * - noProgress: RD-89, `NO_PROGRESS_ROUND_LIMIT` consecutive rounds without the deck + hands
 *   count decreasing; winner = more tokens, tie = draw.
 * - forfeitTimeouts: R7 / RD-43, two consecutive turn timeouts by the loser.
 * - forfeitTimeoutAfterPause: R7 / RD-41 / RD-46, the loser's clock expired after its pause budget
 *   ran out and it played nothing that turn.
 * The forfeit reasons are decided by the server room (RD-66) via `forfeitMatch`.
 */
export type MatchEndReason =
  | 'allTokensHeld'
  | 'finalRoundPlayed'
  | 'replaysExhausted'
  | 'replayImpossible'
  | 'noCreaturesLeft'
  | 'noProgress'
  | 'forfeitTimeouts'
  | 'forfeitTimeoutAfterPause';

/** R7: the match end reasons a forfeit can have. */
export type ForfeitEndReason = Extract<
  MatchEndReason,
  'forfeitTimeouts' | 'forfeitTimeoutAfterPause'
>;

export type MatchStatus =
  | { readonly kind: 'playing' }
  | {
      readonly kind: 'matchOver';
      readonly reason: MatchEndReason;
      /** null = the match is drawn (RD-75, RD-81, RD-84, RD-89). Forfeits always have a winner. */
      readonly winner: Seat | null;
      readonly tokenCounts: readonly [number, number];
    };

export interface CartignonMatchState {
  readonly round: RoundState;
  /** 1-based; replays (RD-40) count as rounds. */
  readonly roundNumber: number;
  readonly tokens: TokenMap;
  /** RD-22: the current round is the final round (pool <= 18, or an RD-40 replay). */
  readonly finalRound: boolean;
  /** RD-40 / RD-81: how many times the final round has been replayed (max 2). */
  readonly replays: number;
  /** RD-89: deck + hands count after the last cleanup (match start: after the initial deal). */
  readonly poolAfterCleanup: number;
  /** RD-89: consecutive rounds whose cleanup did not decrease `poolAfterCleanup`. */
  readonly roundsWithoutProgress: number;
  readonly lastOutcome: RoundOutcome | null;
  readonly status: MatchStatus;
}

/**
 * Match events: every round event plus R5 events. HIDDEN INFORMATION: as in R3, only
 * `cardsDrawn.cardIds` reveals hand contents (show to `seat` only, RD-29). Tie-break cards that
 * return to the deck and cleanup moves are reported as counts only (deck order is hidden, RD-29 /
 * RD-45; the graveyard contents are public in the view since RD-170, not in these events).
 */
export type MatchEvent =
  | RoundEvent
  | {
      readonly type: 'tieBreakStarted';
      readonly iteration: number;
      readonly atk: readonly [number, number];
    }
  | { readonly type: 'tieBreakCardsReturned'; readonly seat: Seat; readonly count: number }
  | { readonly type: 'tieBreakDeckOut'; readonly seat: Seat }
  | { readonly type: 'roundResolved'; readonly round: number; readonly outcome: RoundOutcome }
  | { readonly type: 'tokenChanged'; readonly change: TokenChange }
  | { readonly type: 'roundCleanedUp'; readonly toGraveyard: number; readonly toDeck: number }
  | {
      readonly type: 'deckExhausted';
      /** `finalRound`: RD-22 (pool <= 18); `finalRoundReplay`: RD-40 / RD-74 replay. */
      readonly reason: 'finalRound' | 'finalRoundReplay';
      readonly returnedFromHands: number;
      readonly perSeat: number;
      readonly toGraveyard: number;
    }
  | { readonly type: 'handsRefilled'; readonly firstSeat: Seat; readonly packetSize: number }
  | {
      /** RD-76: no creature in either hand and no Mulligan possible -> hands re-dealt to 9. */
      readonly type: 'handsRedealt';
      readonly firstSeat: Seat;
      readonly returnedFromHands: number;
    }
  | { readonly type: 'finalRoundReplay'; readonly replay: number }
  | {
      readonly type: 'matchOver';
      readonly reason: MatchEndReason;
      readonly winner: Seat | null;
      readonly tokenCounts: readonly [number, number];
    };

/** INVALID_CATALOG: `startCartignonMatch` got card data that fails `roundCatalogIssues`. */
export type MatchErrorCode = RoundErrorCode | 'MATCH_OVER' | 'ROUND_NOT_OVER' | 'INVALID_CATALOG';

export interface MatchRejection {
  readonly ok: false;
  readonly code: MatchErrorCode;
  readonly message: string;
}

export type MatchResult =
  | {
      readonly ok: true;
      readonly state: CartignonMatchState;
      readonly events: readonly MatchEvent[];
    }
  | MatchRejection;

function reject(code: MatchErrorCode, message: string): MatchRejection {
  return { ok: false, code, message };
}

function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

function randomSeat(rng: Rng): Seat {
  return rng.nextInt(2) === 0 ? 0 : 1;
}

function atkOf(ctx: RoundContext, board: Board): readonly [number, number] {
  return [stackAtk(ctx.cards, board, 0), stackAtk(ctx.cards, board, 1)];
}

function hasCreature(ctx: RoundContext, ids: readonly CardId[]): boolean {
  return ids.some((id) => ctx.cards[id]?.kind === 'creature');
}

/**
 * RD-22 / RD-36 / RD-87: the pool counted after cleanup = deck (which by then holds the winning
 * stack of the previous round) + the cards both players left unplayed in hand. The losing stack
 * has gone to the graveyard and is not counted. Also the RD-89 progress measure.
 */
export function poolAfterCleanup(zones: Zones): number {
  return zones.deck.length + zones.hands[0].length + zones.hands[1].length;
}

/**
 * RD-84: can a creature still come back into play? True while any card in deck + hands is a spell
 * whose Primary or Secondary can draw from the graveyard (RD-84 names Secondary; Primary counts
 * per the RD-54 change of 2026-10-18; see `spellCanDrawFromGraveyard`).
 */
export function canStillReachCreature(ctx: RoundContext, zones: Zones): boolean {
  const cards = [...zones.deck, ...zones.hands[0], ...zones.hands[1]];
  return cards.some((id) => {
    const def = ctx.cards[id];
    return def?.kind === 'spell' && spellCanDrawFromGraveyard(def);
  });
}

// ---------------------------------------------------------------------------------------------
// Tokens (RD-03, RD-26)

/** RD-03: exactly one token per color, all in the supply at match start. */
export function createTokenSupply(): TokenMap {
  const tokens = {} as Record<Color, TokenHolder>;
  for (const color of COLORS) tokens[color] = null;
  return tokens;
}

/** Tokens held per seat. */
export function tokenCounts(tokens: TokenMap): readonly [number, number] {
  let a = 0;
  let b = 0;
  for (const color of COLORS) {
    if (tokens[color] === 0) a++;
    else if (tokens[color] === 1) b++;
  }
  return [a, b];
}

/** RD-03 / RD-24: "all 7 tokens won" = every token is held by a player (none in the supply). */
export function allTokensHeld(tokens: TokenMap): boolean {
  return COLORS.every((color) => tokens[color] !== null);
}

/**
 * RD-03 / RD-26: the winner claims the token of its Leading Minion's color (top of its stack,
 * RD-09; after a tie-break that is the last linked creature). Supply -> awarded; held by the
 * opponent -> stolen; already held by the winner -> protected (no change).
 * The winner always has a Leading Minion (strictly higher ATK or a tie-break link); an empty
 * stack is a broken invariant and throws.
 */
export function awardToken(
  ctx: RoundContext,
  tokens: TokenMap,
  board: Board,
  winner: Seat,
): { readonly tokens: TokenMap; readonly change: TokenChange } {
  const leadingCardId = board.zones.stacks[winner].at(-1);
  const def = leadingCardId === undefined ? undefined : ctx.cards[leadingCardId];
  if (leadingCardId === undefined || def?.kind !== 'creature') {
    throw new Error(`round winner ${winner} has no Leading Minion`);
  }
  const color = def.color;
  const holder = tokens[color];
  const kind: TokenChangeKind =
    holder === winner ? 'protected' : holder === null ? 'awarded' : 'stolen';
  return {
    tokens: { ...tokens, [color]: winner },
    change: { seat: winner, color, kind, leadingCardId },
  };
}

// ---------------------------------------------------------------------------------------------
// Round resolution (RD-17, RD-18, RD-19, RD-38, RD-42, RD-67, RD-68, RD-69, RD-72, RD-85)

type TieBreakDraw = { readonly found: boolean; readonly board: Board };

/**
 * RD-19 / RD-38 / RD-72: `seat` reveals cards from the top of the deck until a Creature. Drawn
 * non-creatures are set aside and, once this seat's search ends, go back into the deck, which is
 * shuffled (setting aside guarantees termination). The Creature is linked onto the seat's stack
 * ignoring level (`linkCreature`; liveness rules apply). Deck runs out first -> `found: false`.
 */
function tieBreakDraw(
  ctx: RoundContext,
  board: Board,
  seat: Seat,
  rng: Rng,
  events: MatchEvent[],
): TieBreakDraw {
  const deck = [...board.zones.deck];
  const setAside: CardId[] = [];
  let creature: CardId | undefined;
  while (deck.length > 0) {
    const top = deck.shift() as CardId;
    if (ctx.cards[top]?.kind === 'creature') {
      creature = top;
      break;
    }
    setAside.push(top);
  }
  const hands = board.zones.hands;
  let zones: Zones = {
    ...board.zones,
    deck,
    hands:
      creature === undefined
        ? hands
        : seat === 0
          ? [[...hands[0], creature], hands[1]]
          : [hands[0], [...hands[1], creature]],
  };
  if (setAside.length > 0) {
    // RD-38: drawn non-creatures go back into the deck; the deck is shuffled.
    zones = shuffleDeck({ ...zones, deck: [...zones.deck, ...setAside] }, rng);
    events.push({ type: 'tieBreakCardsReturned', seat, count: setAside.length });
  }
  if (creature === undefined) return { found: false, board: { ...board, zones } };
  const link = linkCreature(ctx.cards, { ...board, zones }, seat, creature);
  if (!link.ok) throw new Error(`unreachable: tie-break link rejected (${link.code})`);
  // RD-122 (Proposed) / RD-98: a linked creature follows the normal liveness rules, so a draw
  // modifier that goes live on the link fires here too.
  const linked = applyModifierDraws(link.board, link.events, rng);
  events.push(...linked.events);
  return { found: true, board: linked.board };
}

/** RD-19: repeat while tied. Each iteration removes >= 1 creature from the deck, so it ends. */
function runTieBreak(
  ctx: RoundContext,
  board: Board,
  p1: Seat,
  rng: Rng,
  events: MatchEvent[],
): { readonly board: Board; readonly outcome: RoundOutcome } {
  let current = board;
  let iterations = 0;
  for (;;) {
    const atk = atkOf(ctx, current);
    if (atk[0] !== atk[1]) {
      return {
        board: current,
        outcome: {
          kind: 'win',
          winner: atk[0] > atk[1] ? 0 : 1,
          decidedBy: 'tieBreak',
          atk,
          tieBreakIterations: iterations,
        },
      };
    }
    iterations++;
    events.push({ type: 'tieBreakStarted', iteration: iterations, atk });
    // RD-72: the round's P1 draws first, then P2 (P1 is fixed for the whole round, RD-74).
    for (const seat of [p1, otherSeat(p1)] as const) {
      const drawn = tieBreakDraw(ctx, current, seat, rng, events);
      current = drawn.board;
      if (!drawn.found) {
        // RD-42: the deck ran out during the tie-break -> the round is a draw.
        events.push({ type: 'tieBreakDeckOut', seat });
        return {
          board: current,
          outcome: {
            kind: 'draw',
            reason: 'tieBreakDeckOut',
            atk: atkOf(ctx, current),
            tieBreakIterations: iterations,
          },
        };
      }
    }
  }
}

export type ResolveRoundResult =
  | {
      readonly ok: true;
      readonly outcome: RoundOutcome;
      /** The board after any tie-break links (cleanup has NOT happened yet). */
      readonly board: Board;
      readonly events: readonly MatchEvent[];
    }
  | MatchRejection;

/**
 * Decides a round that reached `roundOver` (R3). Consumes randomness only in a tie-break.
 * - `p1NoBase`: RD-67, draw; no ATK comparison.
 * - `opponentAhead`: RD-169, the ending seat's opponent was strictly ahead (RD-69) and wins.
 * - `equalStall`: RD-169, two consecutive turn ends at equal ATK, the second without a play ->
 *   tie-break (RD-19). ATK is equal by construction (same board as the round end).
 */
export function resolveRound(
  ctx: RoundContext,
  state: RoundState,
  rng: Rng,
  roundNumber: number,
): ResolveRoundResult {
  if (state.pendingChoice !== undefined || state.board.lookingAt !== undefined) {
    throw new Error('resolveRound called with a pending spell choice');
  }
  if ((state.board.armedTraps?.length ?? 0) > 0) {
    // R4c-4: the round layer lapses every trap when the round ends (RD-129).
    throw new Error('resolveRound called with armed traps');
  }
  const phase = state.phase;
  if (phase.kind !== 'roundOver') return reject('ROUND_NOT_OVER', 'the round is not over');
  const events: MatchEvent[] = [];
  const atk = atkOf(ctx, state.board);
  let board = state.board;
  let outcome: RoundOutcome;
  if (phase.reason === 'p1NoBase') {
    outcome = { kind: 'draw', reason: 'p1NoBase', atk, tieBreakIterations: 0 };
  } else if (phase.reason === 'opponentAhead') {
    outcome = {
      kind: 'win',
      winner: otherSeat(phase.seat),
      decidedBy: 'opponentAhead',
      atk,
      tieBreakIterations: 0,
    };
  } else {
    if (atk[0] !== atk[1]) throw new Error('unreachable: equalStall with unequal ATK');
    const tie = runTieBreak(ctx, board, state.p1, rng, events);
    board = tie.board;
    outcome = tie.outcome;
  }
  events.push({ type: 'roundResolved', round: roundNumber, outcome });
  return { ok: true, outcome, board, events };
}

// ---------------------------------------------------------------------------------------------
// Cleanup (RD-12, RD-20, RD-58, RD-59, RD-71, RD-82)

/**
 * RD-20 / RD-58: bulk cleanup with NO modifier activation or liveness events (cards are moved as
 * whole stacks, not via `removeFromStack`). Win: losing stack -> graveyard, winning stack ->
 * deck. Draw (RD-42, RD-67): both stacks -> deck (RD-71). Then the deck is shuffled (RD-20).
 * Attached effects end with the round (RD-12) and an unused Link Up expires (RD-59). Unused hand
 * cards stay in hand (RD-20).
 * RD-82: every attached spell card goes to the GRAVEYARD, also when its creature returns to the
 * deck (winning stack or drawn round). `toGraveyard` in the event counts them.
 */
export function cleanupRound(
  board: Board,
  outcome: RoundOutcome,
  rng: Rng,
): { readonly board: Board; readonly events: readonly MatchEvent[] } {
  if (board.lookingAt !== undefined) {
    throw new Error('cleanupRound called with looked-at cards (a spell choice was left pending)');
  }
  if ((board.armedTraps?.length ?? 0) > 0) {
    // R4c-4: armed traps lapse at round end (RD-129); cleanup would otherwise lose their cards.
    throw new Error('cleanupRound called with armed traps');
  }
  const { stacks } = board.zones;
  // RD-82: attached spells -> graveyard (before the deck shuffle).
  const toGraveyard: CardId[] = board.attachedSpells.map((s) => s.cardId);
  const toDeck: CardId[] = [];
  if (outcome.kind === 'win') {
    toGraveyard.push(...stacks[otherSeat(outcome.winner)]);
    toDeck.push(...stacks[outcome.winner]);
  } else {
    // RD-71: after a drawn round both stacks return to the deck.
    toDeck.push(...stacks[0], ...stacks[1]);
  }
  const zones = shuffleDeck(
    {
      deck: [...board.zones.deck, ...toDeck],
      graveyard: [...board.zones.graveyard, ...toGraveyard],
      hands: board.zones.hands,
      stacks: [[], []],
    },
    rng,
  );
  return {
    board: {
      zones,
      attachedEffects: [],
      attachedSpells: [],
      linkUpPending: [false, false],
      linkUpSource: [null, null],
      nextEffectSeq: board.nextEffectSeq,
      stackEffects: [],
      copiedModifiers: [],
    },
    events: [{ type: 'roundCleanedUp', toGraveyard: toGraveyard.length, toDeck: toDeck.length }],
  };
}

// ---------------------------------------------------------------------------------------------
// Next round (RD-04, RD-21, RD-22, RD-32, RD-36, RD-70, RD-76, RD-77, RD-84)

export type NextRoundSetup =
  | {
      readonly kind: 'started';
      readonly state: RoundState;
      readonly finalRound: boolean;
      readonly events: readonly MatchEvent[];
    }
  /** RD-84: RD-76 would re-deal, no creature is in deck + hands and none can be drawn back. */
  | { readonly kind: 'noCreaturesLeft' };

/**
 * Prepares and starts the next round on a cleaned-up board (empty stacks).
 * - RD-36 / RD-22 (changed): checked here (cleanup is immediately followed by this round start,
 *   so the "after cleanup" and "at round start" checks are the same check). If the RD-87 pool
 *   (deck incl. the returned winning stack + unplayed hand cards) is <= 18, all hand cards return
 *   to the deck, it is shuffled and dealt evenly (so at most 9 each); an odd leftover card goes to
 *   the graveyard. That round is the final round.
 * - `replay` (RD-40 / RD-74): the same RD-22 re-deal, always; the round is final. Spell draws
 *   during the final round can grow the pool above 18; then each seat gets 9 and the rest stays
 *   in the deck (RD-96, Proposed). No deal exceeds 9 (RD-77).
 * - Otherwise RD-21 refill alternately 1 card at a time up to 9, first seat random (RD-32). A
 *   hand already at or above 9 gets nothing; a deck that falls short is dealt out (RD-95).
 * - RD-76: if after the refill neither hand holds a creature and neither seat can Mulligan
 *   (RD-16), all hand cards return to the deck, it is shuffled and 9 each are dealt again
 *   (alternately, new random first seat); the rest stays in the deck. Not a final round.
 *   RD-84: if deck + hands hold no creature and `canStillReachCreature` is false,
 *   `noCreaturesLeft` is returned; otherwise the re-deal happens anyway (spells may still draw a
 *   creature back from the graveyard).
 * - RD-70: `startRound` requires empty stacks and clears the armed Link Up.
 */
export function setupNextRound(
  ctx: RoundContext,
  board: Board,
  p1: Seat,
  rng: Rng,
  replay = false,
): NextRoundSetup {
  const dealt = dealNextRound(ctx, board.zones, rng, replay);
  if (dealt === null) return { kind: 'noCreaturesLeft' };
  return { kind: 'started', ...startDealt(board, dealt, p1), finalRound: dealt.finalRound };
}

interface NextDeal {
  readonly zones: Zones;
  readonly events: readonly MatchEvent[];
  readonly finalRound: boolean;
}

/** The dealing part of `setupNextRound` (no round start); null = RD-84. */
function dealNextRound(
  ctx: RoundContext,
  before: Zones,
  rng: Rng,
  replay: boolean,
): NextDeal | null {
  const firstSeat = randomSeat(rng);
  // RD-77 (corrected 2026-10-18): hands may exceed 9 during a round (spell draws), never through a
  // deal. Spell draws can therefore grow the pool above 18 during the final round; such a replay
  // deals 9 each and leaves the rest in the deck (RD-96, Proposed, in `dealFinalHands`).
  const total = poolAfterCleanup(before);
  if (replay || total <= FINAL_ROUND_MAX_CARDS) {
    const reason = replay ? 'finalRoundReplay' : 'finalRound';
    // `force`: the RD-22 threshold here is the <= 18 pool, not "deck cannot refill".
    const dealt = dealFinalHands(before, firstSeat, rng, true);
    if (!dealt.ok) throw new Error(`unreachable: ${dealt.code}`);
    const zones = dealt.zones;
    const events: MatchEvent[] = [
      {
        type: 'deckExhausted',
        reason,
        returnedFromHands: before.hands[0].length + before.hands[1].length,
        perSeat: zones.hands[0].length,
        toGraveyard: zones.graveyard.length - before.graveyard.length,
      },
    ];
    for (const seat of [firstSeat, otherSeat(firstSeat)] as const) {
      events.push({ type: 'cardsDrawn', seat, reason: 'finalDeal', cardIds: zones.hands[seat] });
    }
    return { zones, events, finalRound: true };
  }
  // RD-21 refill. A hand already at or above 9 (in-round draws, RD-77 as corrected) receives 0
  // cards and is never trimmed. If such a hand leaves the deck short of a full refill while the
  // pool is still > 18, the deck is dealt out as far as it goes (RD-95, Proposed).
  const refilled = refillHands(before, firstSeat);
  const zones = refilled.ok ? refilled.zones : refillHandsFromAvailable(before, firstSeat);
  if (isDeadlocked(ctx, zones)) return redeal(ctx, zones, rng);
  const events: MatchEvent[] = [
    { type: 'handsRefilled', firstSeat, packetSize: DEALING_RULES.refillPacketSize },
  ];
  for (const seat of [firstSeat, otherSeat(firstSeat)] as const) {
    const drawn = zones.hands[seat].slice(before.hands[seat].length);
    if (drawn.length > 0)
      events.push({ type: 'cardsDrawn', seat, reason: 'refill', cardIds: drawn });
  }
  return { zones, events, finalRound: false };
}

/** RD-76: no creature in either hand and no Mulligan possible for either seat. */
function isDeadlocked(ctx: RoundContext, zones: Zones): boolean {
  const canMulligan = (seat: Seat): boolean =>
    zones.hands[seat].length >= DEALING_RULES.mulliganMinHand &&
    zones.deck.length >= DEALING_RULES.mulliganMinDeck;
  return (
    !hasCreature(ctx, zones.hands[0]) &&
    !hasCreature(ctx, zones.hands[1]) &&
    !canMulligan(0) &&
    !canMulligan(1)
  );
}

/**
 * RD-76: all hand cards return to the deck, the deck is shuffled, and 9 each are dealt 1 at a
 * time alternately from a new random first seat (RD-21 / RD-32 style); the rest stays in the
 * deck. Refill events are dropped (every hand card is re-dealt). A re-deal may again hold no
 * creature: that round is then an RD-67 draw and the next round start re-deals again.
 * RD-84: "Let it be played with spells. You can always draw from the graveyard. But if there is
 * no such possibility at all (...), the match ends." With no creature in deck + hands the re-deal
 * still happens while a card there could draw one back (`canStillReachCreature`); otherwise null.
 */
function redeal(ctx: RoundContext, zones: Zones, rng: Rng): NextDeal | null {
  const pool = [...zones.deck, ...zones.hands[0], ...zones.hands[1]];
  if (!hasCreature(ctx, pool) && !canStillReachCreature(ctx, zones)) return null;
  const returned = zones.hands[0].length + zones.hands[1].length;
  const pooled = shuffleDeck(
    { ...zones, deck: [...zones.deck, ...zones.hands[0], ...zones.hands[1]], hands: [[], []] },
    rng,
  );
  const firstSeat = randomSeat(rng);
  const dealt = refillHands(pooled, firstSeat);
  if (!dealt.ok) throw new Error(`unreachable: ${dealt.code}`);
  const events: MatchEvent[] = [{ type: 'handsRedealt', firstSeat, returnedFromHands: returned }];
  for (const seat of [firstSeat, otherSeat(firstSeat)] as const) {
    events.push({ type: 'cardsDrawn', seat, reason: 'redeal', cardIds: dealt.zones.hands[seat] });
  }
  return { zones: dealt.zones, events, finalRound: false };
}

/** RD-70: starts the round on the dealt zones; deal events go between roundStarted/turnStarted. */
function startDealt(
  board: Board,
  dealt: NextDeal,
  p1: Seat,
): { readonly state: RoundState; readonly events: readonly MatchEvent[] } {
  const started = startRound({ ...board, zones: dealt.zones }, p1);
  return {
    state: started.state,
    events: [started.events[0] as RoundEvent, ...dealt.events, ...started.events.slice(1)],
  };
}

// ---------------------------------------------------------------------------------------------
// Match end (RD-24, RD-40, RD-81)

export type MatchEndCheck =
  | { readonly kind: 'continue' }
  | { readonly kind: 'over'; readonly reason: MatchEndReason; readonly winner: Seat | null }
  | { readonly kind: 'replay' };

/**
 * RD-24: the match ends (only between rounds) when all 7 tokens are held, or the final round has
 * been played. The seat with more tokens wins. RD-40: tied token counts -> the final round is
 * replayed; RD-81: at most `MAX_FINAL_ROUND_REPLAYS` times, then the match is a draw.
 * (With 7 tokens all held a tie is impossible.)
 */
export function evaluateMatchEnd(
  tokens: TokenMap,
  finalRoundPlayed: boolean,
  replays = 0,
): MatchEndCheck {
  const allHeld = allTokensHeld(tokens);
  if (!allHeld && !finalRoundPlayed) return { kind: 'continue' };
  const [a, b] = tokenCounts(tokens);
  if (a === b) {
    return replays >= MAX_FINAL_ROUND_REPLAYS
      ? { kind: 'over', reason: 'replaysExhausted', winner: null }
      : { kind: 'replay' };
  }
  return {
    kind: 'over',
    reason: allHeld ? 'allTokensHeld' : 'finalRoundPlayed',
    winner: a > b ? 0 : 1,
  };
}

/** More tokens wins; equal token counts -> null (draw). */
function winnerByTokens(tokens: TokenMap): Seat | null {
  const [a, b] = tokenCounts(tokens);
  return a === b ? null : a > b ? 0 : 1;
}

function matchOver(
  match: CartignonMatchState,
  reason: MatchEndReason,
  winner: Seat | null,
  events: MatchEvent[],
): CartignonMatchState {
  const counts = tokenCounts(match.tokens);
  events.push({ type: 'matchOver', reason, winner, tokenCounts: counts });
  return { ...match, status: { kind: 'matchOver', reason, winner, tokenCounts: counts } };
}

/**
 * Runs steps 1-5 (see the file header) on a match whose round is `roundOver`. On match end the
 * returned `round` keeps its `roundOver` phase with the cleaned-up board, and no round-start
 * events are emitted.
 */
export function finishRound(ctx: RoundContext, match: CartignonMatchState, rng: Rng): MatchResult {
  if (match.status.kind === 'matchOver') return reject('MATCH_OVER', 'the match is over');
  const resolved = resolveRound(ctx, match.round, rng, match.roundNumber);
  if (!resolved.ok) return resolved;
  const events: MatchEvent[] = [...resolved.events];
  const { outcome } = resolved;
  let tokens = match.tokens;
  if (outcome.kind === 'win') {
    const award = awardToken(ctx, tokens, resolved.board, outcome.winner);
    tokens = award.tokens;
    events.push({ type: 'tokenChanged', change: award.change });
  }
  // RD-42 / RD-67: a drawn round changes no tokens.
  const cleaned = cleanupRound(resolved.board, outcome, rng);
  events.push(...cleaned.events);
  // RD-89: progress = the deck + hands count after cleanup decreased compared with the previous
  // round (some card left deck + hands for good).
  const pool = poolAfterCleanup(cleaned.board.zones);
  const roundsWithoutProgress = pool < match.poolAfterCleanup ? 0 : match.roundsWithoutProgress + 1;
  const done: CartignonMatchState = {
    ...match,
    round: { ...match.round, board: cleaned.board },
    tokens,
    lastOutcome: outcome,
    poolAfterCleanup: pool,
    roundsWithoutProgress,
  };
  const end = evaluateMatchEnd(tokens, match.finalRound, match.replays);
  if (end.kind === 'over') {
    return { ok: true, state: matchOver(done, end.reason, end.winner, events), events };
  }
  if (end.kind === 'continue' && roundsWithoutProgress >= NO_PROGRESS_ROUND_LIMIT) {
    // RD-89 / RD-90: N consecutive rounds without progress -> the match ends by token count
    // (more tokens wins, equal is a draw). Not applied to the final round and its replays, which
    // end by RD-24 / RD-81.
    return {
      ok: true,
      state: matchOver(done, 'noProgress', winnerByTokens(tokens), events),
      events,
    };
  }
  // RD-40 replay, capped at 2 by RD-81 (handled in `evaluateMatchEnd`).
  const replay = end.kind === 'replay';
  const dealt = dealNextRound(ctx, cleaned.board.zones, rng, replay);
  if (dealt === null) {
    // RD-84: no creature in deck + hands and no card left that could draw one back from the
    // graveyard -> no round can ever be won. Ends by token count (more tokens wins, tie = draw).
    return {
      ok: true,
      state: matchOver(done, 'noCreaturesLeft', winnerByTokens(tokens), events),
      events,
    };
  }
  const { hands } = dealt.zones;
  if (replay && !hasCreature(ctx, hands[0]) && !hasCreature(ctx, hands[1])) {
    // RD-75: no creature can be played in the replay -> the match is a draw. Detected before the
    // replay starts: the deal is discarded, `round` stays the finished round (roundOver,
    // cleaned-up board) and no replay/round-start events are emitted.
    return { ok: true, state: matchOver(done, 'replayImpossible', null, events), events };
  }
  const replays = replay ? match.replays + 1 : match.replays;
  if (replay) events.push({ type: 'finalRoundReplay', replay: replays });
  // RD-04 / RD-74: P1 alternates every round (replays included).
  const started = startDealt(cleaned.board, dealt, otherSeat(match.round.p1));
  events.push(...started.events);
  // RD-141: choice ids are unique per match, so the counter carries over into the next round.
  const nextChoiceId = match.round.nextChoiceId;
  return {
    ok: true,
    state: {
      ...done,
      round: nextChoiceId === undefined ? started.state : { ...started.state, nextChoiceId },
      roundNumber: match.roundNumber + 1,
      finalRound: dealt.finalRound,
      replays,
    },
    events,
  };
}

// ---------------------------------------------------------------------------------------------
// Match entry points

/** Round 1 of a match (RD-02, RD-04, RD-21, RD-32 via `startFirstRound`), tokens in supply. */
export function startCartignonMatch(
  catalog: CardCatalog,
  rng: Rng,
):
  | {
      readonly ok: true;
      readonly state: CartignonMatchState;
      readonly events: readonly MatchEvent[];
    }
  | MatchRejection {
  // Shape check of the card data before anything is dealt; consumes no RNG.
  const issues = roundCatalogIssues(catalog);
  if (issues.length > 0) {
    return reject('INVALID_CATALOG', issues.map((i) => i.message).join('; '));
  }
  const first = startFirstRound(catalog, rng);
  if (!first.ok) return first;
  return {
    ok: true,
    state: {
      round: first.state,
      roundNumber: 1,
      tokens: createTokenSupply(),
      finalRound: false,
      replays: 0,
      poolAfterCleanup: poolAfterCleanup(first.state.board.zones),
      roundsWithoutProgress: 0,
      lastOutcome: null,
      status: { kind: 'playing' },
    },
    events: first.events,
  };
}

/** Legal round commands for `seat`; none once the match is over. */
export function legalMatchCommands(
  ctx: RoundContext,
  match: CartignonMatchState,
  seat: Seat,
): RoundCommand[] {
  if (match.status.kind === 'matchOver') return [];
  return legalCommands(ctx, match.round, seat);
}

/**
 * Applies a round command (R3 `applyCommand`); when the round ends, the round is resolved and the
 * match advances automatically (`finishRound`). Never throws for rule violations and never
 * mutates `match`.
 */
export function applyMatchCommand(
  ctx: RoundContext,
  match: CartignonMatchState,
  seat: Seat,
  command: RoundCommand,
  rng: Rng,
): MatchResult {
  if (match.status.kind === 'matchOver') return reject('MATCH_OVER', 'the match is over');
  return advanceMatch(ctx, match, applyCommand(ctx, match.round, seat, command, rng), rng);
}

/**
 * R7 / RD-163: the internal timeout skip of P1's Base step (`applyTimeoutSkip`): the round ends
 * like RD-67 and the match advances as after any round end. Server-only: no client command maps
 * to it. Never throws for rule violations and never mutates `match`.
 */
export function applyMatchTimeoutSkip(
  ctx: RoundContext,
  match: CartignonMatchState,
  seat: Seat,
  rng: Rng,
): MatchResult {
  if (match.status.kind === 'matchOver') return reject('MATCH_OVER', 'the match is over');
  return advanceMatch(ctx, match, applyTimeoutSkip(ctx, match.round, seat, rng), rng);
}

/**
 * R7 (RD-43, RD-41 / RD-46): `loser` forfeits; the other seat wins immediately. The round is left
 * as it is (no resolution, cleanup or token change) and a public `matchOver` event is emitted.
 * Consumes no randomness; never mutates `match`.
 */
export function forfeitCartignonMatch(
  match: CartignonMatchState,
  loser: Seat,
  reason: ForfeitEndReason,
): MatchResult {
  if (match.status.kind === 'matchOver') return reject('MATCH_OVER', 'the match is over');
  const events: MatchEvent[] = [];
  const state = matchOver(match, reason, otherSeat(loser), events);
  return { ok: true, state, events };
}

/** Shared tail of the match entry points: a round that reached `roundOver` is finished. */
function advanceMatch(
  ctx: RoundContext,
  match: CartignonMatchState,
  result: RoundResult,
  rng: Rng,
): MatchResult {
  if (!result.ok) return result;
  const advanced: CartignonMatchState = { ...match, round: result.state };
  if (result.state.phase.kind !== 'roundOver') {
    return { ok: true, state: advanced, events: result.events };
  }
  const finished = finishRound(ctx, advanced, rng);
  if (!finished.ok) return finished;
  return { ok: true, state: finished.state, events: [...result.events, ...finished.events] };
}
