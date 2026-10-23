import {
  activeSeat,
  determinize,
  legalMatchCommands,
  type CardId,
  type RoundCommand,
  type RoundContext,
  type Rng,
  type SeatObservation,
} from '@cartignon/game-core';
import { DEFAULT_WEIGHTS, type EvalWeights } from './evaluate.js';
import {
  EXPERT_MC,
  MASTER_MC,
  monteCarloScores,
  type MonteCarloConfig,
  type SearchBudget,
} from './montecarlo.js';
import {
  CASUAL_TEMPERATURE,
  NOVICE_PLAY_CAP,
  noviceCommand,
  oneStepScores,
  softmaxIndex,
} from './policies.js';
import { SKILLED_BEAM, skilledScores, type BeamConfig, type ScoredCommand } from './search.js';
import { forkRng, isPlay, MAX_PLAYS_PER_TURN, restrictPlays } from './sim.js';

/**
 * ADR-0016 bot API. A bot sees only a `SeatObservation` (game-core `observeForSeat`) and returns
 * one legal `RoundCommand` for the observed seat, which must be the acting seat.
 *
 * Determinism: for a given observation, RNG state, budget of kind `playouts` and memory, the
 * command is always the same. A `time` budget (the browser bot) makes L4 / L5 depend on the machine.
 *
 * Per-turn play cap and loop guard (all levels): `TurnMemory` counts the bot's plays in the
 * current turn and remembers the observation signatures it decided on; a repeated signature (a
 * Grave Draw loop: two spells drawing each other back, see game-core self-play `eagerPlayBudget`)
 * or the cap (L1: 3, else `MAX_PLAYS_PER_TURN`) leaves only non-play commands (End Turn / choice).
 */

export type BotLevel = 1 | 2 | 3 | 4 | 5;

export const BOT_LEVELS: readonly BotLevel[] = [1, 2, 3, 4, 5];

export const BOT_LEVEL_NAMES: Readonly<Record<BotLevel, string>> = {
  1: 'Novice',
  2: 'Casual',
  3: 'Skilled',
  4: 'Expert',
  5: 'Master',
};

export function isBotLevel(value: unknown): value is BotLevel {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/**
 * Default think time per decision (ms) for the browser bot; L1-L3 have a fixed amount of work.
 * Chosen so the time budgets keep about the playout ratio the tournament tuned (120 : 400).
 */
export const DEFAULT_TIME_BUDGET_MS: Readonly<Record<BotLevel, number>> = {
  1: 0,
  2: 0,
  3: 0,
  4: 300,
  5: 1000,
};

/** Deterministic playout budgets of roughly the same strength (tests and the tournament). */
export const DEFAULT_PLAYOUT_BUDGET: Readonly<Record<BotLevel, number>> = {
  1: 0,
  2: 0,
  3: 0,
  4: 120,
  5: 400,
};

export type { SearchBudget } from './montecarlo.js';

/** What a bot remembers between its decisions within one turn (plain data, serializable). */
export interface TurnMemory {
  /** `${roundNumber}:${turnNumber}` of the turn the counters belong to. */
  readonly turnKey: string;
  readonly plays: number;
  /** Signatures of the observations already decided on in this turn. */
  readonly seen: readonly string[];
}

export const EMPTY_TURN_MEMORY: TurnMemory = { turnKey: '', plays: 0, seen: [] };

export interface BotDecision {
  readonly command: RoundCommand;
  /** Pass this back with the next decision (same bot, same match). */
  readonly memory: TurnMemory;
  /** The loop guard fired (the observation repeated within this turn). */
  readonly loopDetected: boolean;
}

export interface DecideOptions {
  /** L4 / L5 only; default `{ kind: 'time', ms: DEFAULT_TIME_BUDGET_MS[level] }`. */
  readonly budget?: SearchBudget;
  readonly memory?: TurnMemory;
  /** Advanced: evaluation and search settings (tuning, the tournament harness). */
  readonly tuning?: BotTuning;
}

/** Overrides of a level's settings (plain data). Absent fields keep the level's defaults. */
export interface BotTuning {
  readonly weights?: EvalWeights;
  /** L3 (and L4 / L5 ranking when `mc.rank` is not overridden). */
  readonly beam?: BeamConfig;
  /** L4 / L5. Partial: merged over the level's `EXPERT_MC` / `MASTER_MC`. */
  readonly mc?: Partial<MonteCarloConfig>;
}

/** Thrown when the observed seat is not the one that must act now. */
export class NotBotsTurnError extends Error {
  constructor() {
    super('the observed seat is not the acting seat');
    this.name = 'NotBotsTurnError';
  }
}

function sortedIds(ids: readonly CardId[]): CardId[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Loop-detection signature: the seat's view with zone contents as multisets. */
export function observationSignature(obs: SeatObservation): string {
  const round = obs.match.round;
  const board = round.board;
  const zones = board.zones;
  return JSON.stringify([
    sortedIds(zones.hands[obs.seat]),
    sortedIds(zones.graveyard),
    zones.stacks,
    obs.hidden,
    board.attachedEffects.length,
    board.stackEffects.length,
    board.armedTraps?.length ?? 0,
    round.pendingChoice?.choiceId ?? null,
  ]);
}

const PLAY_CAP: Readonly<Record<BotLevel, number>> = {
  1: NOVICE_PLAY_CAP,
  2: MAX_PLAYS_PER_TURN,
  3: MAX_PLAYS_PER_TURN,
  4: MAX_PLAYS_PER_TURN,
  5: MAX_PLAYS_PER_TURN,
};

/** L2: determinize samples averaged per command. */
const CASUAL_SAMPLES = 2;

const MC_CONFIG: Readonly<Record<4 | 5, MonteCarloConfig>> = { 4: EXPERT_MC, 5: MASTER_MC };
const BEAM: BeamConfig = SKILLED_BEAM;

/**
 * Chooses the command for `obs.seat` at `level`. Pure apart from consuming `rng` (and reading the
 * clock for a `time` budget). Throws `NotBotsTurnError` when `obs.seat` is not the acting seat.
 */
export function decideCommand(
  level: BotLevel,
  ctx: RoundContext,
  obs: SeatObservation,
  rng: Rng,
  options: DecideOptions = {},
): BotDecision {
  const match = obs.match;
  if (match.status.kind !== 'playing' || activeSeat(match.round) !== obs.seat) {
    throw new NotBotsTurnError();
  }
  const key = `${match.roundNumber}:${match.round.turnNumber}`;
  const before = options.memory?.turnKey === key ? options.memory : { ...EMPTY_TURN_MEMORY };
  const signature = observationSignature(obs);
  const loopDetected = before.seen.includes(signature);
  // The acting seat's legal commands depend only on what it can see plus hidden zone SIZES (e.g.
  // the Mulligan deck minimum), so any sample gives the same list (game-core observation tests).
  const legal = legalMatchCommands(ctx, determinize(obs, rng), obs.seat);
  const allowed = restrictPlays(legal, before.plays, PLAY_CAP[level], loopDetected);
  const command =
    allowed.length === 1
      ? (allowed[0] as RoundCommand)
      : chooseAmong(level, ctx, obs, allowed, before.plays, rng, options.budget, options.tuning);
  return {
    command,
    loopDetected,
    memory: {
      turnKey: key,
      plays: before.plays + (isPlay(command) ? 1 : 0),
      seen: [...before.seen, signature],
    },
  };
}

function chooseAmong(
  level: BotLevel,
  ctx: RoundContext,
  obs: SeatObservation,
  allowed: readonly RoundCommand[],
  plays: number,
  rng: Rng,
  budget: SearchBudget | undefined,
  tuning: BotTuning | undefined,
): RoundCommand {
  const weights = tuning?.weights ?? DEFAULT_WEIGHTS;
  switch (level) {
    case 1: {
      const world = determinize(obs, rng);
      return noviceCommand(ctx, world, obs.seat, allowed, plays, rng);
    }
    case 2: {
      const totals = allowed.map(() => 0);
      for (let k = 0; k < CASUAL_SAMPLES; k++) {
        const world = determinize(obs, rng);
        const scores = oneStepScores(ctx, world, obs.seat, allowed, forkRng(rng), weights);
        scores.forEach((s, i) => (totals[i] = (totals[i] ?? 0) + s / CASUAL_SAMPLES));
      }
      return allowed[softmaxIndex(totals, CASUAL_TEMPERATURE, rng)] as RoundCommand;
    }
    case 3:
      return (
        skilledScores(
          ctx,
          obs,
          allowed,
          plays,
          rng,
          tuning?.beam ?? BEAM,
          weights,
        )[0] as ScoredCommand
      ).command;
    case 4:
    case 5: {
      const spend = budget ?? { kind: 'time', ms: DEFAULT_TIME_BUDGET_MS[level] };
      const ranked = monteCarloScores(
        ctx,
        obs,
        allowed,
        plays,
        rng,
        spend,
        { ...MC_CONFIG[level], ...tuning?.mc },
        weights,
      );
      return (ranked[0] as ScoredCommand).command;
    }
  }
}

/** A stateful bot for one seat of one match: it keeps its `TurnMemory` between decisions. */
export interface Bot {
  readonly level: BotLevel;
  chooseCommand(obs: SeatObservation, rng: Rng, budget?: SearchBudget): RoundCommand;
}

export function createBot(level: BotLevel, ctx: RoundContext, tuning?: BotTuning): Bot {
  let memory: TurnMemory = EMPTY_TURN_MEMORY;
  return {
    level,
    chooseCommand(obs, rng, budget) {
      const decision = decideCommand(level, ctx, obs, rng, {
        memory,
        ...(budget === undefined ? {} : { budget }),
        ...(tuning === undefined ? {} : { tuning }),
      });
      memory = decision.memory;
      return decision.command;
    },
  };
}
