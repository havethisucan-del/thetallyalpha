import {
  createRngFromState,
  determinize,
  type CartignonMatchState,
  type RoundCommand,
  type RoundContext,
  type Rng,
  type Seat,
  type SeatObservation,
} from '@cartignon/game-core';
import { DEFAULT_WEIGHTS, evaluate, type EvalWeights } from './evaluate.js';
import { casualCommand, MAX_PLAYS_FOR_POLICIES } from './policies.js';
import { beamOnState, skilledScores, type BeamConfig, type ScoredCommand } from './search.js';
import {
  actingSeat,
  applyLegal,
  forkRng,
  isPlay,
  legalFor,
  MAX_PLAYOUT_STEPS,
  restrictPlays,
  turnKey,
} from './sim.js';

/**
 * ADR-0016 L4 Expert and L5 Master: flat Monte Carlo over the best L3 candidates. Each playout
 * samples a `determinize` world, applies the candidate and lets a policy play both seats to a
 * horizon; the candidate with the best mean evaluation wins. Budgets are a playout count
 * (deterministic: tests, tournament) or wall-clock milliseconds (the browser bot).
 */

/** Playout count (deterministic) or a time limit in milliseconds. */
export type SearchBudget =
  | { readonly kind: 'playouts'; readonly playouts: number }
  | { readonly kind: 'time'; readonly ms: number; readonly now?: () => number };

export interface MonteCarloConfig {
  /** How many L3 candidates are compared (ADR-0016 proposed 6; tuned to 3). */
  readonly candidates: number;
  /** L3 settings used to rank the candidates. */
  readonly rank: BeamConfig;
  /** Playouts end after the current round (0) or after the next one too (1, L5 lookahead). */
  readonly extraRounds: number;
  /** L5: decisions per playout made by a small beam (L3-guided) before the L2 policy takes over. */
  readonly guidedDecisions: number;
  readonly guide: BeamConfig;
  /** Softmax temperature of the L2 playout policy (token units). */
  readonly temperature: number;
  /** Weight of the L3 score as a prior, in playouts. */
  readonly priorPlayouts: number;
}

export const EXPERT_MC: MonteCarloConfig = {
  // Tuned 2026-10-22 (tournament, 400 games vs L3, seed 1, 120 playouts): 6 candidates won
  // 56.7 %, priorPlayouts 15 58.9 %, 4 candidates + prior 10 59.1 %, 3 candidates 62.5 % (more
  // playouts per candidate). Validated on seed 2, see ADR-0016 Results.
  candidates: 3,
  rank: { width: 8, depth: 4, samples: 4 },
  extraRounds: 0,
  guidedDecisions: 0,
  guide: { width: 3, depth: 2, samples: 1 },
  temperature: 0.5,
  priorPlayouts: 6,
};

/**
 * L5: the L4 search with more playouts (`DEFAULT_PLAYOUT_BUDGET`, time budget) over 4 candidates.
 * An earlier, unrecorded tuning run found the next-round lookahead and L3-guided playouts weaker.
 * Measured 2026-10-22 vs the tuned L4 (400 games, seed 1, 400 playouts): 3 candidates 52.0 %
 * (seed 2), 4 candidates 56.6 %, 5 candidates 50.6 %, 6 candidates 51.0 %. Below the 58 % target;
 * see ADR-0016 Results.
 */
export const MASTER_MC: MonteCarloConfig = { ...EXPERT_MC, candidates: 4 };
/**
 * One playout from a complete state: both seats play the L2 policy (the first
 * `guidedDecisions` decisions use a small beam on the playout's own world) until the horizon
 * round has ended, the match is over or the step cap is hit. Returns the end state.
 */
export function playout(
  ctx: RoundContext,
  start: CartignonMatchState,
  config: MonteCarloConfig,
  rng: Rng,
  weights: EvalWeights = DEFAULT_WEIGHTS,
): CartignonMatchState {
  const horizon = start.roundNumber + config.extraRounds;
  let state = start;
  let key = '';
  let plays = 0;
  let guided = config.guidedDecisions;
  for (let step = 0; step < MAX_PLAYOUT_STEPS; step++) {
    if (state.status.kind !== 'playing' || state.roundNumber > horizon) break;
    const seat = actingSeat(state);
    if (seat === null) break;
    const k = turnKey(state);
    if (k !== key) {
      key = k;
      plays = 0;
    }
    const legal = legalFor(ctx, state);
    let command: RoundCommand;
    if (guided > 0 && legal.length > 1) {
      guided--;
      const allowed = restrictPlays(legal, plays, MAX_PLAYS_FOR_POLICIES);
      const scores = beamOnState(ctx, state, seat, allowed, plays, config.guide, rng, weights);
      let best = 0;
      scores.forEach((s, i) => {
        if (s > (scores[best] ?? -Infinity)) best = i;
      });
      command = allowed[best] as RoundCommand;
    } else {
      command = casualCommand(ctx, state, seat, legal, plays, rng, config.temperature, weights);
    }
    if (isPlay(command)) plays++;
    state = applyLegal(ctx, state, seat, command, rng);
  }
  return state;
}

interface Arm {
  readonly command: RoundCommand;
  readonly prior: number;
  total: number;
  count: number;
}

function mean(arm: Arm, priorWeight: number): number {
  return (arm.total + arm.prior * priorWeight) / (arm.count + priorWeight);
}

/**
 * ADR-0016 L4 / L5: ranks the allowed commands with L3, keeps the top `config.candidates` and
 * spends the budget on playouts, in rounds of one playout per candidate (common random numbers).
 * Returns them best first (mean evaluation, the L3 score acting as a prior of `priorPlayouts`
 * playouts).
 */
export function monteCarloScores(
  ctx: RoundContext,
  obs: SeatObservation,
  commands: readonly RoundCommand[],
  plays: number,
  rng: Rng,
  budget: SearchBudget,
  config: MonteCarloConfig,
  weights: EvalWeights = DEFAULT_WEIGHTS,
): ScoredCommand[] {
  // A time budget covers the whole decision, the L3 ranking included.
  const now = budget.kind === 'time' ? (budget.now ?? (() => Date.now())) : null;
  const deadline = budget.kind === 'time' && now !== null ? now() + budget.ms : 0;
  const ranked = skilledScores(ctx, obs, commands, plays, rng, config.rank, weights);
  const arms: Arm[] = ranked
    .slice(0, config.candidates)
    .map((r) => ({ command: r.command, prior: r.score, total: 0, count: 0 }));
  if (arms.length <= 1) return ranked;
  const seat: Seat = obs.seat;
  // Common random numbers: every candidate is played out in the same sampled world with the same
  // playout RNG stream, so the comparison between candidates is not drowned by deal variance.
  const rounds =
    budget.kind === 'playouts'
      ? Math.ceil(budget.playouts / arms.length)
      : Number.POSITIVE_INFINITY;
  for (let n = 0; n < rounds; n++) {
    // Time budgets: every candidate gets at least one playout.
    if (now !== null && n >= 1 && now() >= deadline) break;
    const world = determinize(obs, rng);
    const stream = forkRng(rng).getState();
    for (const arm of arms) {
      const playoutRng = createRngFromState(stream);
      const first = applyLegal(ctx, world, seat, arm.command, playoutRng);
      const end = playout(ctx, first, config, playoutRng, weights);
      arm.total += evaluate(ctx, end, seat, weights);
      arm.count++;
    }
  }
  return arms
    .map((arm, i) => ({ command: arm.command, score: mean(arm, config.priorPlayouts), i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ command, score }) => ({ command, score }));
}
