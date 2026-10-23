import {
  activeSeat,
  applyMatchCommand,
  createRngFromState,
  legalMatchCommands,
  type CartignonMatchState,
  type RoundCommand,
  type RoundContext,
  type Rng,
  type Seat,
} from '@cartignon/game-core';

/**
 * Simulation helpers shared by every level (ADR-0016). Everything here works on COMPLETE match
 * states (a real match in tests, or a `determinize` sample inside a bot); a bot never sees the
 * real hidden cards.
 */

/** ADR-0016 runtime: at most this many plays (cards played, Mulligans) per turn for L2-L5. */
export const MAX_PLAYS_PER_TURN = 12;

/** Upper bound on commands in one simulated playout (a safety net; real rounds are far shorter). */
export const MAX_PLAYOUT_STEPS = 400;

export function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

/** Commands that count against the per-turn play cap (choices and End Turn do not). */
export function isPlay(command: RoundCommand): boolean {
  return command.type !== 'endTurn' && command.type !== 'chooseSpellOption';
}

/** Identifies the turn in progress: plays are counted per turn key. */
export function turnKey(match: CartignonMatchState): string {
  return `${match.roundNumber}:${match.round.turnNumber}`;
}

/** The seat that must act, or null when the match is over. */
export function actingSeat(match: CartignonMatchState): Seat | null {
  if (match.status.kind !== 'playing') return null;
  return activeSeat(match.round);
}

/**
 * Applies a command that came from `legalMatchCommands`. A rejection here is a bug (the legal list
 * and the engine disagree, or a bot built an illegal command), so it throws.
 */
export function applyLegal(
  ctx: RoundContext,
  match: CartignonMatchState,
  seat: Seat,
  command: RoundCommand,
  rng: Rng,
): CartignonMatchState {
  const result = applyMatchCommand(ctx, match, seat, command, rng);
  if (!result.ok) {
    throw new Error(`bot applied an illegal command ${JSON.stringify(command)}: ${result.code}`);
  }
  return result.state;
}

/**
 * The per-turn play cap and loop guard: once `plays` reached `cap` (or a loop was detected), only
 * non-play commands remain, if there are any (in the P1 Base step a creature may be mandatory).
 */
export function restrictPlays(
  legal: readonly RoundCommand[],
  plays: number,
  cap: number,
  loop = false,
): readonly RoundCommand[] {
  if (plays < cap && !loop) return legal;
  const calm = legal.filter((c) => !isPlay(c));
  return calm.length > 0 ? calm : legal;
}

/** Legal commands for the acting seat of a complete state (empty when the match is over). */
export function legalFor(ctx: RoundContext, match: CartignonMatchState): readonly RoundCommand[] {
  const seat = actingSeat(match);
  return seat === null ? [] : legalMatchCommands(ctx, match, seat);
}

/** A uniformly random element (throws on an empty list: a caller bug). */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick from an empty list');
  return items[rng.nextInt(items.length)] as T;
}

/**
 * An independent RNG derived from `rng` (consumes 4 draws). Used to give each simulation its own
 * stream, so the bot's decisions stay deterministic for a given seed and budget in playouts.
 */
export function forkRng(rng: Rng): Rng {
  let hex = '';
  for (let i = 0; i < 4; i++) {
    hex += rng
      .nextInt(2 ** 32)
      .toString(16)
      .padStart(8, '0');
  }
  // xoshiro's all-zero state is invalid; the chance is 2^-128, but stay total.
  return createRngFromState(/^0+$/.test(hex) ? '00000000000000000000000000000001' : hex);
}

/** A stable key for comparing commands. */
export function commandKey(command: RoundCommand): string {
  switch (command.type) {
    case 'playCreature':
    case 'nullify':
    case 'playSpell':
      return `${command.type}:${command.cardId}`;
    case 'chooseSpellOption':
      return `choose:${command.choiceId}:${command.selection.join(',')}`;
    default:
      return command.type;
  }
}
