import {
  stackAtk,
  tokenCounts,
  type CardId,
  type CartignonMatchState,
  type RoundContext,
  type Seat,
} from '@cartignon/game-core';
import { otherSeat } from './sim.js';

/**
 * ADR-0016: the one evaluation every level shares. Score from `seat`'s point of view in TOKEN
 * units x 100 (one token of lead = 100). Components:
 * - match over: +/- WIN (a draw is 0), plus the token difference as a tie-breaker;
 * - tokens held (difference);
 * - the round in progress: the chance to win it (stack ATK, who must act, what each hand can
 *   still add) times what winning or losing it is worth in tokens for the current Leading
 *   Minions (award 1, steal 2, protect 0);
 * - hand quality vs the opponent's (cards in hand outlive the round; spent cards are replaced by
 *   random deck cards), worth nothing in the final round.
 * It reads complete states: inside a bot that is a `determinize` sample.
 */

export const TOKEN = 100;
const WIN = 10_000;
/** Weight of one unit of hand value (a mid-level creature is about 1 unit). */
const HAND_WEIGHT = 9;
/** ATK-equivalent of a spell in hand when estimating what a seat can still add this round. */
const SPELL_REACH = 25;
/** Logistic scale of the reach difference (ATK). */
const REACH_SCALE = 70;

/** Tunable weights (the tournament harness may compare variants). */
export interface EvalWeights {
  readonly hand: number;
  readonly reachScale: number;
}

export const DEFAULT_WEIGHTS: EvalWeights = { hand: HAND_WEIGHT, reachScale: REACH_SCALE };

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Value of one card in hand (unit: roughly one average card). */
export function cardValue(ctx: RoundContext, id: CardId): number {
  const def = ctx.cards[id];
  if (def === undefined) return 0;
  if (def.kind === 'spell') return 0.9;
  return 0.35 + def.atk / 200;
}

/**
 * How much ATK `seat` could still add this round from its hand: the best chain of consecutive
 * levels above its Leading Minion (any start level on an empty stack or with an armed Link Up),
 * plus a little per spell.
 */
export function reachFromHand(ctx: RoundContext, match: CartignonMatchState, seat: Seat): number {
  const board = match.round.board;
  const best: number[] = [0, 0, 0, 0, 0, 0];
  let spells = 0;
  for (const id of board.zones.hands[seat]) {
    const def = ctx.cards[id];
    if (def === undefined) continue;
    if (def.kind === 'spell') {
      spells++;
      continue;
    }
    if (def.atk > (best[def.level] ?? 0)) best[def.level] = def.atk;
  }
  const stack = board.zones.stacks[seat];
  const leadId = stack.at(-1);
  const lead = leadId === undefined ? undefined : ctx.cards[leadId];
  const leadLevel = lead?.kind === 'creature' ? lead.level : 0;
  const free = leadLevel === 0 || board.linkUpPending[seat];
  let reach = 0;
  const startLevels = free ? [1, 2, 3, 4, 5] : [leadLevel + 1];
  for (const start of startLevels) {
    let sum = 0;
    for (let level = start; level <= 5; level++) {
      const atk = best[level] ?? 0;
      if (atk === 0) break;
      sum += atk;
    }
    if (sum > reach) reach = sum;
  }
  return reach + Math.min(spells, 2) * SPELL_REACH;
}

/** Tokens (in token units) `seat` gains if it wins the round with its current Leading Minion. */
function stakeOf(ctx: RoundContext, match: CartignonMatchState, seat: Seat): number {
  const leadId = match.round.board.zones.stacks[seat].at(-1);
  const lead = leadId === undefined ? undefined : ctx.cards[leadId];
  if (lead?.kind !== 'creature') return 1;
  const holder = match.tokens[lead.color];
  return holder === seat ? 0.25 : holder === null ? 1 : 2;
}

/** Probability that `seat` wins the round in progress (a heuristic, not a measurement). */
export function roundWinChance(
  ctx: RoundContext,
  match: CartignonMatchState,
  seat: Seat,
  weights: EvalWeights = DEFAULT_WEIGHTS,
): number {
  const round = match.round;
  if (round.phase.kind === 'roundOver') return 0.5;
  const opp = otherSeat(seat);
  const board = round.board;
  const atk = [stackAtk(ctx.cards, board, 0), stackAtk(ctx.cards, board, 1)] as const;
  const reach = [
    atk[0] + reachFromHand(ctx, match, 0),
    atk[1] + reachFromHand(ctx, match, 1),
  ] as const;
  const active = round.pendingChoice?.seat ?? round.phase.active;
  // The acting seat that is behind and cannot catch up loses at its End Turn.
  const passive = otherSeat(active);
  if (round.phase.kind !== 'p1Base' && atk[active] < atk[passive] && reach[active] < atk[passive]) {
    return active === seat ? 0.04 : 0.96;
  }
  const p = sigmoid((reach[seat] - reach[opp]) / weights.reachScale);
  return Math.min(0.97, Math.max(0.03, p));
}

/** Hand quality of `seat` (sum of `cardValue`). */
export function handValue(ctx: RoundContext, match: CartignonMatchState, seat: Seat): number {
  let sum = 0;
  for (const id of match.round.board.zones.hands[seat]) sum += cardValue(ctx, id);
  return sum;
}

/** ADR-0016 shared evaluation, see the file header. Higher is better for `seat`. */
export function evaluate(
  ctx: RoundContext,
  match: CartignonMatchState,
  seat: Seat,
  weights: EvalWeights = DEFAULT_WEIGHTS,
): number {
  const opp = otherSeat(seat);
  const counts = tokenCounts(match.tokens);
  const tokenDiff = counts[seat] - counts[opp];
  if (match.status.kind === 'matchOver') {
    const winner = match.status.winner;
    const base = winner === null ? 0 : winner === seat ? WIN : -WIN;
    return base + tokenDiff * TOKEN;
  }
  let score = tokenDiff * TOKEN;
  const p = roundWinChance(ctx, match, seat, weights);
  score += TOKEN * (p * stakeOf(ctx, match, seat) - (1 - p) * stakeOf(ctx, match, opp));
  if (!match.finalRound) {
    score += weights.hand * (handValue(ctx, match, seat) - handValue(ctx, match, opp));
  }
  return score;
}
