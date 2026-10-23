import {
  stackAtk,
  type CartignonMatchState,
  type RoundCommand,
  type RoundContext,
  type Rng,
  type Seat,
} from '@cartignon/game-core';
import { DEFAULT_WEIGHTS, evaluate, TOKEN, type EvalWeights } from './evaluate.js';
import { applyLegal, forkRng, isPlay, otherSeat, pick, restrictPlays } from './sim.js';

/**
 * Single-step policies on COMPLETE states (ADR-0016 L1 and L2). Bots run them on `determinize`
 * samples; playouts (L4, L5) run them for both seats.
 */

/** ADR-0016 L1: at most this many plays per turn. */
export const NOVICE_PLAY_CAP = 3;

/** Plays per turn before the simulated policies stop playing (the loop guard in playouts). */
export const MAX_PLAYS_FOR_POLICIES = 8;

/** ADR-0016 L2: softmax temperature, in token units. */
export const CASUAL_TEMPERATURE = 0.5;

/** True when `seat` ending its turn now would lose the round (the opponent strictly ahead). */
export function endTurnLosesRound(
  ctx: RoundContext,
  match: CartignonMatchState,
  seat: Seat,
): boolean {
  const round = match.round;
  if (round.phase.kind === 'p1Base' || round.phase.kind === 'roundOver') return false;
  const board = round.board;
  return stackAtk(ctx.cards, board, otherSeat(seat)) > stackAtk(ctx.cards, board, seat);
}

/**
 * ADR-0016 L1 Novice on a complete state: a random legal command (play cap 3), except that it
 * does not end its turn into a lost round while some play would stop it from being behind.
 */
export function noviceCommand(
  ctx: RoundContext,
  match: CartignonMatchState,
  seat: Seat,
  legal: readonly RoundCommand[],
  plays: number,
  rng: Rng,
): RoundCommand {
  const allowed = restrictPlays(legal, plays, NOVICE_PLAY_CAP);
  const choice = pick(rng, allowed);
  if (choice.type !== 'endTurn' || !endTurnLosesRound(ctx, match, seat)) return choice;
  const rescues = allowed.filter((c) => {
    if (!isPlay(c) || c.type === 'mulligan') return false;
    const next = applyLegal(ctx, match, seat, c, forkRng(rng));
    if (next.roundNumber !== match.roundNumber || next.status.kind !== 'playing') return false;
    return !endTurnLosesRound(ctx, next, seat);
  });
  return rescues.length > 0 ? pick(rng, rescues) : choice;
}

/** One-step scores of `commands` for `seat` (each applied once with its own RNG stream). */
export function oneStepScores(
  ctx: RoundContext,
  match: CartignonMatchState,
  seat: Seat,
  commands: readonly RoundCommand[],
  rng: Rng,
  weights: EvalWeights = DEFAULT_WEIGHTS,
): number[] {
  return commands.map((c) =>
    evaluate(ctx, applyLegal(ctx, match, seat, c, forkRng(rng)), seat, weights),
  );
}

/** Softmax pick over `scores` (evaluation units) at `temperature` token units. */
export function softmaxIndex(scores: readonly number[], temperature: number, rng: Rng): number {
  const top = Math.max(...scores);
  const weights = scores.map((s) => Math.exp((s - top) / (TOKEN * temperature)));
  const total = weights.reduce((a, b) => a + b, 0);
  // Integer resolution keeps the pick on the engine's `Rng` interface (no floats needed).
  let r = (rng.nextInt(1_000_000) / 1_000_000) * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i] ?? 0;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

export function argmax(scores: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < scores.length; i++) {
    if ((scores[i] ?? -Infinity) > (scores[best] ?? -Infinity)) best = i;
  }
  return best;
}

/**
 * ADR-0016 L2 Casual on a complete state: every allowed command is simulated one step and
 * evaluated; the pick is a softmax at `temperature` (0 = greedy argmax).
 */
export function casualCommand(
  ctx: RoundContext,
  match: CartignonMatchState,
  seat: Seat,
  legal: readonly RoundCommand[],
  plays: number,
  rng: Rng,
  temperature = CASUAL_TEMPERATURE,
  weights: EvalWeights = DEFAULT_WEIGHTS,
): RoundCommand {
  const allowed = restrictPlays(legal, plays, MAX_PLAYS_FOR_POLICIES);
  if (allowed.length === 1) return allowed[0] as RoundCommand;
  const scores = oneStepScores(ctx, match, seat, allowed, rng, weights);
  const index = temperature <= 0 ? argmax(scores) : softmaxIndex(scores, temperature, rng);
  return allowed[index] as RoundCommand;
}
