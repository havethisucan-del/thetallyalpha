import {
  determinize,
  type CartignonMatchState,
  type RoundCommand,
  type RoundContext,
  type Rng,
  type Seat,
  type SeatObservation,
} from '@cartignon/game-core';
import { DEFAULT_WEIGHTS, evaluate, type EvalWeights } from './evaluate.js';
import {
  actingSeat,
  applyLegal,
  forkRng,
  isPlay,
  legalFor,
  MAX_PLAYS_PER_TURN,
  restrictPlays,
} from './sim.js';

/**
 * ADR-0016 L3 Skilled: a beam search over the seat's own turn (its commands until the turn passes
 * or the round ends), on K `determinize` samples. A line that hands the turn over is scored after
 * the opponent's best single reply; a line cut off by the depth limit gets the static evaluation.
 * Scores per first command are averaged over the samples.
 */

export interface BeamConfig {
  readonly width: number;
  readonly depth: number;
  readonly samples: number;
}

/** ADR-0016 L3: beam width 8, depth 4, K = 4 samples. */
export const SKILLED_BEAM: BeamConfig = { width: 8, depth: 4, samples: 4 };

export interface ScoredCommand {
  readonly command: RoundCommand;
  readonly score: number;
}

interface Node {
  readonly state: CartignonMatchState;
  readonly first: number;
  readonly plays: number;
  readonly score: number;
}

/**
 * The value of a line that ended `seat`'s turn: the opponent answers with the single command that
 * is worst for `seat` (one ply). Round or match end: the plain evaluation.
 */
export function replyScore(
  ctx: RoundContext,
  state: CartignonMatchState,
  seat: Seat,
  roundNumber: number,
  rng: Rng,
  weights: EvalWeights,
): number {
  const actor = actingSeat(state);
  if (actor === null || actor === seat || state.roundNumber !== roundNumber) {
    return evaluate(ctx, state, seat, weights);
  }
  const replies = restrictPlays(legalFor(ctx, state), 0, MAX_PLAYS_PER_TURN);
  let worst = Infinity;
  for (const reply of replies) {
    const next = applyLegal(ctx, state, actor, reply, forkRng(rng));
    worst = Math.min(worst, evaluate(ctx, next, seat, weights));
  }
  return worst === Infinity ? evaluate(ctx, state, seat, weights) : worst;
}

/**
 * Best line value per root command for one complete `root` state (`commands` = the root's allowed
 * commands). Commands whose every line was pruned keep the value of their best evaluated node.
 */
export function beamOnState(
  ctx: RoundContext,
  root: CartignonMatchState,
  seat: Seat,
  commands: readonly RoundCommand[],
  plays: number,
  config: BeamConfig,
  rng: Rng,
  weights: EvalWeights = DEFAULT_WEIGHTS,
): number[] {
  const best = commands.map(() => -Infinity);
  const roundNumber = root.roundNumber;
  const turnOver = (s: CartignonMatchState): boolean =>
    actingSeat(s) !== seat || s.roundNumber !== roundNumber;

  const expand = (
    state: CartignonMatchState,
    command: RoundCommand,
    first: number,
    nodePlays: number,
    lastDepth: boolean,
  ): Node | null => {
    const next = applyLegal(ctx, state, seat, command, forkRng(rng));
    const p = nodePlays + (isPlay(command) ? 1 : 0);
    if (turnOver(next)) {
      const s = replyScore(ctx, next, seat, roundNumber, rng, weights);
      if (s > (best[first] ?? -Infinity)) best[first] = s;
      return null;
    }
    const s = evaluate(ctx, next, seat, weights);
    if (lastDepth) {
      if (s > (best[first] ?? -Infinity)) best[first] = s;
      return null;
    }
    return { state: next, first, plays: p, score: s };
  };

  let frontier: Node[] = [];
  commands.forEach((command, i) => {
    const node = expand(root, command, i, plays, config.depth <= 1);
    if (node !== null) frontier.push(node);
  });
  for (let depth = 2; depth <= config.depth && frontier.length > 0; depth++) {
    frontier = selectBeam(frontier, config.width);
    const next: Node[] = [];
    for (const node of frontier) {
      const allowed = restrictPlays(legalFor(ctx, node.state), node.plays, MAX_PLAYS_PER_TURN);
      for (const command of allowed) {
        const child = expand(node.state, command, node.first, node.plays, depth === config.depth);
        if (child !== null) next.push(child);
      }
      // A pruned subtree still has a value: its best static evaluation.
      if (node.score > (best[node.first] ?? -Infinity) && allowed.length === 0) {
        best[node.first] = node.score;
      }
    }
    frontier = next;
  }
  // Nodes left in a frontier that was never expanded further (depth limit already applied above).
  for (const node of frontier) {
    if (node.score > (best[node.first] ?? -Infinity)) best[node.first] = node.score;
  }
  return best.map((b) => (b === -Infinity ? -1e9 : b));
}

/** The top `width` nodes by score, plus the best node of every first command (diversity). */
function selectBeam(nodes: readonly Node[], width: number): Node[] {
  const sorted = [...nodes].sort((a, b) => b.score - a.score);
  const kept = sorted.slice(0, width);
  const firsts = new Set(kept.map((n) => n.first));
  for (const node of sorted.slice(width)) {
    if (!firsts.has(node.first)) {
      firsts.add(node.first);
      kept.push(node);
    }
  }
  return kept;
}

/**
 * ADR-0016 L3 over an observation: every allowed root command scored by the beam on
 * `config.samples` determinizations (common samples for all commands), sorted best first.
 */
export function skilledScores(
  ctx: RoundContext,
  obs: SeatObservation,
  commands: readonly RoundCommand[],
  plays: number,
  rng: Rng,
  config: BeamConfig = SKILLED_BEAM,
  weights: EvalWeights = DEFAULT_WEIGHTS,
): ScoredCommand[] {
  const totals = commands.map(() => 0);
  for (let k = 0; k < config.samples; k++) {
    const root = determinize(obs, rng);
    const scores = beamOnState(ctx, root, obs.seat, commands, plays, config, forkRng(rng), weights);
    scores.forEach((s, i) => {
      totals[i] = (totals[i] ?? 0) + s;
    });
  }
  return commands
    .map((command, i) => ({ command, score: (totals[i] ?? 0) / config.samples, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ command, score }) => ({ command, score }));
}
