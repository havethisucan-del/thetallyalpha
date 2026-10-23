import {
  applyMatchCommand,
  observeForSeat,
  startCartignonMatch,
  type CardCatalog,
  type MatchEndReason,
  type RoundCommand,
  type RoundContext,
  type Rng,
  type Seat,
} from '@cartignon/game-core';
import type { Bot, SearchBudget } from './bot.js';
import { actingSeat } from './sim.js';

/**
 * Bot-vs-bot matches (tests, the tournament harness). Each seat's bot only ever receives
 * `observeForSeat(match, seat)`; the engine uses its own RNG.
 */

export interface ArenaSeat {
  readonly bot: Bot;
  readonly rng: Rng;
  readonly budget?: SearchBudget;
}

export interface DecisionRecord {
  readonly seat: Seat;
  readonly ms: number;
}

export interface ArenaResult {
  readonly end: MatchEndReason | 'stepCap';
  readonly winner: Seat | null;
  readonly tokenCounts: readonly [number, number];
  readonly steps: number;
  readonly rounds: number;
}

/** A bot produced a command the engine rejected (must never happen). */
export class IllegalBotCommandError extends Error {
  readonly command: RoundCommand;
  constructor(seat: Seat, command: RoundCommand, code: string) {
    super(`seat ${seat} bot played an illegal command ${JSON.stringify(command)}: ${code}`);
    this.name = 'IllegalBotCommandError';
    this.command = command;
  }
}

export interface ArenaOptions {
  readonly maxSteps?: number;
  /** Clock for decision timing (default `Date.now`). */
  readonly now?: () => number;
  readonly onDecision?: (record: DecisionRecord) => void;
}

/** Plays one full match between `seats[0]` and `seats[1]`. Throws `IllegalBotCommandError`. */
export function playBotMatch(
  ctx: RoundContext,
  catalog: CardCatalog,
  engineRng: Rng,
  seats: readonly [ArenaSeat, ArenaSeat],
  options: ArenaOptions = {},
): ArenaResult {
  const started = startCartignonMatch(catalog, engineRng);
  if (!started.ok) throw new Error(`match did not start: ${started.code}`);
  let match = started.state;
  const maxSteps = options.maxSteps ?? 5_000;
  const now = options.now ?? (() => Date.now());
  let steps = 0;
  let rounds = 0;
  while (match.status.kind === 'playing') {
    if (steps >= maxSteps) {
      return { end: 'stepCap', winner: null, tokenCounts: [0, 0], steps, rounds };
    }
    const seat = actingSeat(match);
    if (seat === null) throw new Error('playing match without an acting seat');
    const player = seats[seat];
    const t0 = now();
    const command = player.bot.chooseCommand(
      observeForSeat(match, seat),
      player.rng,
      player.budget,
    );
    options.onDecision?.({ seat, ms: now() - t0 });
    const result = applyMatchCommand(ctx, match, seat, command, engineRng);
    if (!result.ok) throw new IllegalBotCommandError(seat, command, result.code);
    steps++;
    rounds += result.events.filter((e) => e.type === 'roundResolved').length;
    match = result.state;
  }
  const status = match.status;
  return {
    end: status.reason,
    winner: status.winner,
    tokenCounts: status.tokenCounts,
    steps,
    rounds,
  };
}
