import type { ForfeitReason, PhaseInfo, Seat, TimeoutMode } from '@cartignon/game-core';
import type { ClockView } from '@cartignon/protocol';

/**
 * R7 match clock (docs/tasks/r7-cartignon-timers.md). Pure: no timers, no I/O; every function
 * takes the current time `now` and returns a new state. The state is plain JSON (remaining-time
 * based), so it can be persisted later and resumed after a restart.
 *
 * Time: `now` drives all accounting and should come from a monotonic source (the room uses
 * `performance.now()`), so a wall-clock jump never expires or extends a clock. `wallNow` (epoch
 * ms, defaults to `now`) is only recorded for the client view (`serverTime`, `deadline`).
 *
 * Rules:
 * - RD-25 / RD-33: the turn seat has a turn clock (`turnMs`) per turn; expiry skips the turn.
 * - RD-164: while a seat other than the turn seat must act (a nested choice), the turn clock is
 *   suspended and the chooser runs a choice clock (`choiceMs`, fresh for every prompt, i.e. every
 *   revision). Its expiry answers the choice and does not count toward RD-43.
 * - RD-165: a turn timeout answers the turn seat's pending choices and skips the turn. When the
 *   answer hands a choice to the other seat first, the skip is owed: once the turn seat acts
 *   again on the same turn, the clock wakes at once for the skip, which is not counted again
 *   (a turn counts at most one timeout; a skip that makes no progress is retried after a back-off).
 * - RD-41 / RD-46 / RD-166: while the seat whose clock runs is disconnected and has pause budget
 *   left, its clock stops and the budget drains instead (never during the other seat's clock).
 *   When the budget is used up the clock runs again; if a turn clock then expires and the seat
 *   played nothing this turn, the seat forfeits (`timeoutAfterPause`).
 * - RD-43: consecutive turn timeouts per seat; the second one forfeits (`turnTimeouts`). Any turn
 *   of that seat that ends other than by its own turn timeout resets its counter (its own action,
 *   the other seat answering a nested choice, or a choice clock expiring).
 */

export interface TurnClockConfig {
  readonly turnMs: number;
  readonly choiceMs: number;
  readonly pauseBudgetMs: number;
}

export type SeatPair<T> = readonly [T, T];

export interface TurnClock {
  /** Snapshot revision the clock was last reconciled with. */
  readonly revision: number;
  /** Time (`now` scale, monotonic) up to which the remaining times below are accounted. */
  readonly at: number;
  /** Epoch ms matching `at` (client view only). */
  readonly wallAt: number;
  readonly turnKey: string | null;
  readonly turnSeat: Seat | null;
  /** The seat that must act now; null = no clock runs. */
  readonly activeSeat: Seat | null;
  /** The turn seat's turn clock (suspended while a choice clock runs). */
  readonly turnRemainingMs: number;
  /** The choice clock of a non-turn seat that must act (RD-164); null otherwise. */
  readonly choiceRemainingMs: number | null;
  readonly pauseLeftMs: SeatPair<number>;
  readonly consecutiveTimeouts: SeatPair<number>;
  readonly connected: SeatPair<boolean>;
  /** The turn seat had an accepted action during this turn (RD-166). */
  readonly playedThisTurn: boolean;
  /** The turn seat's clock ran while it was disconnected without pause budget (RD-41). */
  readonly ranAfterPause: boolean;
  /**
   * The turn (`turnKey`) whose turn timeout was already counted (RD-43). While it equals
   * `turnKey`, the turn still owes its skip (RD-165) and ends "by timeout".
   */
  readonly timedOutTurnKey: string | null;
  /**
   * The owed skip of `timedOutTurnKey` may run at once (RD-165): true after the counted timeout
   * and after every hand-off to the other seat on that turn; false after an uncounted skip until
   * the next hand-off. A skip that made no progress therefore waits for a back-off (`stuck`)
   * instead of spinning the clock.
   */
  readonly skipReady: boolean;
}

/** Identifies what a scheduled wake-up was armed for; a mismatch makes the wake a no-op. */
export interface ClockToken {
  readonly revision: number;
  readonly turnKey: string | null;
  readonly seat: Seat;
  readonly mode: TimeoutMode;
}

export interface ReconcileInput {
  readonly phase: Pick<PhaseInfo, 'activeSeat' | 'turnSeat' | 'turnKey'>;
  readonly revision: number;
  readonly connected: SeatPair<boolean>;
  /** Monotonic time (ms). */
  readonly now: number;
  /** Epoch ms at `now` (client view only); defaults to `now`. */
  readonly wallNow?: number;
  /** The seat whose accepted action produced `phase` (omit for timeouts, joins, leaves). */
  readonly actor?: Seat;
}

export type WakeResult =
  /** The token no longer matches the clock: ignore. */
  | { readonly kind: 'stale' }
  /** Nothing expired yet (an early timer): store `clock`, re-arm. */
  | { readonly kind: 'early'; readonly clock: TurnClock }
  /** The pause budget ran out and the clock runs again: store, re-arm, announce. */
  | { readonly kind: 'resumed'; readonly clock: TurnClock }
  /**
   * Apply `stepTimeout(seat, mode)`, then store `clock` (it already counts the timeout).
   * `counted` is false for an owed skip (RD-165) whose timeout was counted before.
   */
  | {
      readonly kind: 'timeout';
      readonly seat: Seat;
      readonly mode: TimeoutMode;
      readonly counted: boolean;
      readonly clock: TurnClock;
    }
  /**
   * RD-165 anti-spin: the previous uncounted skip left the turn seat acting on the same turn
   * without any hand-off. Store `clock` (ready again), then run the skip after a back-off.
   */
  | { readonly kind: 'stuck'; readonly seat: Seat; readonly clock: TurnClock }
  /** Apply `forfeitMatch(seat, reason)`. */
  | {
      readonly kind: 'forfeit';
      readonly seat: Seat;
      readonly reason: ForfeitReason;
      readonly clock: TurnClock;
    };

/** RD-43: the second consecutive turn timeout forfeits. */
export const TURN_TIMEOUTS_TO_FORFEIT = 2;

function setSeat<T>(pair: SeatPair<T>, seat: Seat, value: T): SeatPair<T> {
  return seat === 0 ? [value, pair[1]] : [pair[0], value];
}

/** Whose clock runs and in which mode; null when nobody acts. */
export function clockSeat(clock: TurnClock): { seat: Seat; mode: TimeoutMode } | null {
  if (clock.activeSeat === null) return null;
  return {
    seat: clock.activeSeat,
    mode: clock.choiceRemainingMs !== null ? 'choice' : 'turn',
  };
}

function remainingOf(clock: TurnClock): number {
  return clock.choiceRemainingMs ?? clock.turnRemainingMs;
}

/**
 * RD-165: the turn seat acts on a turn whose timeout was already counted, so the turn still owes
 * its skip. A turn counts at most one timeout, however often the skip hands a choice off.
 */
export function owesSkip(clock: TurnClock): boolean {
  return (
    clock.activeSeat !== null &&
    clock.choiceRemainingMs === null &&
    clock.timedOutTurnKey !== null &&
    clock.timedOutTurnKey === clock.turnKey
  );
}

/** False while the clock's seat is disconnected and still has pause budget (RD-41). */
export function isRunning(clock: TurnClock): boolean {
  const active = clockSeat(clock);
  if (active === null) return false;
  if (owesSkip(clock)) return true; // already expired: a pause cannot hold it back
  return clock.connected[active.seat] || clock.pauseLeftMs[active.seat] <= 0;
}

/** Accounts the time between `clock.at` and `now` (pause budget first, then the clock). */
function advance(clock: TurnClock, now: number, wallNow: number): TurnClock {
  const elapsed = Math.max(0, now - clock.at);
  const timed: TurnClock = now >= clock.at ? { ...clock, at: now, wallAt: wallNow } : { ...clock };
  const active = clockSeat(clock);
  if (active === null || elapsed === 0 || owesSkip(clock)) return timed;
  let pauseLeftMs = clock.pauseLeftMs;
  let running = elapsed;
  if (!clock.connected[active.seat]) {
    const drained = Math.min(elapsed, pauseLeftMs[active.seat]);
    pauseLeftMs = setSeat(pauseLeftMs, active.seat, pauseLeftMs[active.seat] - drained);
    running = elapsed - drained;
  }
  const next: TurnClock = { ...timed, pauseLeftMs };
  if (running === 0) return next;
  return active.mode === 'choice'
    ? { ...next, choiceRemainingMs: Math.max(0, remainingOf(clock) - running) }
    : { ...next, turnRemainingMs: Math.max(0, clock.turnRemainingMs - running) };
}

/** RD-41: a turn clock running while its seat is disconnected without budget. */
function markAfterPause(clock: TurnClock): TurnClock {
  const active = clockSeat(clock);
  if (active?.mode !== 'turn' || clock.ranAfterPause) return clock;
  if (clock.connected[active.seat] || clock.pauseLeftMs[active.seat] > 0) return clock;
  return { ...clock, ranAfterPause: true };
}

/**
 * Brings the clock up to date with a new phase / revision / connection state. Call it at match
 * start (`clock` undefined), after every committed revision (with `actor` for accepted actions)
 * and on every join / leave while the match is active.
 */
export function reconcile(
  clock: TurnClock | undefined,
  input: ReconcileInput,
  config: TurnClockConfig,
): TurnClock {
  const { phase, now, actor } = input;
  const wallNow = input.wallNow ?? now;
  let next: TurnClock =
    clock === undefined
      ? {
          revision: input.revision,
          at: now,
          wallAt: wallNow,
          turnKey: null,
          turnSeat: null,
          activeSeat: null,
          turnRemainingMs: config.turnMs,
          choiceRemainingMs: null,
          pauseLeftMs: [config.pauseBudgetMs, config.pauseBudgetMs],
          consecutiveTimeouts: [0, 0],
          connected: input.connected,
          playedThisTurn: false,
          ranAfterPause: false,
          timedOutTurnKey: null,
          skipReady: false,
        }
      : advance(markAfterPause(clock), now, wallNow);
  next = markAfterPause(next);

  const turnSeat = phase.turnSeat ?? phase.activeSeat;
  const turnChanged = phase.turnKey !== next.turnKey || turnSeat !== next.turnSeat;
  if (actor !== undefined && actor === next.turnSeat) next = { ...next, playedThisTurn: true };
  if (turnChanged) {
    const previous = next.turnSeat;
    const endedByTimeout = next.timedOutTurnKey !== null && next.timedOutTurnKey === next.turnKey;
    const endedByOwnAction = actor !== undefined && actor === previous;
    // RD-43: only a turn that ended by its own timeout keeps the seat's count.
    if (previous !== null && (endedByOwnAction || !endedByTimeout)) {
      next = { ...next, consecutiveTimeouts: setSeat(next.consecutiveTimeouts, previous, 0) };
    }
    next = {
      ...next,
      turnKey: phase.turnKey,
      turnSeat,
      turnRemainingMs: config.turnMs,
      choiceRemainingMs: null,
      playedThisTurn: false,
      ranAfterPause: false,
      timedOutTurnKey: null,
      skipReady: false,
    };
  }

  const activeSeat = phase.turnKey === null ? null : phase.activeSeat;
  const choosing = activeSeat !== null && turnSeat !== null && activeSeat !== turnSeat;
  let choiceRemainingMs: number | null = null;
  if (choosing) {
    const sameChoice =
      next.choiceRemainingMs !== null &&
      next.activeSeat === activeSeat &&
      next.revision === input.revision;
    choiceRemainingMs = sameChoice ? next.choiceRemainingMs : config.choiceMs;
    // A hand-off on a timed-out turn is progress: the owed skip may run at once again.
    if (next.timedOutTurnKey !== null && next.timedOutTurnKey === phase.turnKey) {
      next = { ...next, skipReady: true };
    }
  }
  next = {
    ...next,
    revision: input.revision,
    activeSeat,
    choiceRemainingMs,
    connected: input.connected,
  };
  return markAfterPause(next);
}

/** The wake-up token for the clock as it is now; null when no clock runs. */
export function wakeToken(clock: TurnClock): ClockToken | null {
  const active = clockSeat(clock);
  if (active === null) return null;
  return { revision: clock.revision, turnKey: clock.turnKey, seat: active.seat, mode: active.mode };
}

/**
 * When the room must call `onWake` next (`now` scale): the clock's expiry, or the end of the
 * pause budget while paused (the clock then resumes). Null when no clock runs.
 */
export function nextWakeAt(clock: TurnClock): number | null {
  const active = clockSeat(clock);
  if (active === null) return null;
  if (!isRunning(clock)) return clock.at + clock.pauseLeftMs[active.seat];
  return clock.at + remainingOf(clock);
}

function sameToken(a: ClockToken, b: ClockToken | null): boolean {
  return (
    b !== null &&
    a.revision === b.revision &&
    a.turnKey === b.turnKey &&
    a.seat === b.seat &&
    a.mode === b.mode
  );
}

/** Decides what a timer wake-up armed with `token` means at `now` (`wallNow` defaults to it). */
export function onWake(
  clock: TurnClock,
  token: ClockToken,
  now: number,
  wallNow: number = now,
): WakeResult {
  if (!sameToken(token, wakeToken(clock))) return { kind: 'stale' };
  const { seat, mode } = token;
  if (owesSkip(clock)) {
    // RD-165: the counted timeout's skip, completed now that the turn seat acts again; never a
    // second count for the same turn.
    const advanced = advance(clock, now, wallNow);
    if (!clock.skipReady) return { kind: 'stuck', seat, clock: { ...advanced, skipReady: true } };
    return {
      kind: 'timeout',
      seat,
      mode,
      counted: false,
      clock: { ...advanced, skipReady: false },
    };
  }
  const wasRunning = isRunning(clock);
  const next = markAfterPause(advance(markAfterPause(clock), now, wallNow));
  if (remainingOf(next) > 0) {
    return { kind: !wasRunning && isRunning(next) ? 'resumed' : 'early', clock: next };
  }
  if (mode === 'choice') return { kind: 'timeout', seat, mode, counted: false, clock: next };
  if (next.ranAfterPause && !next.playedThisTurn) {
    return { kind: 'forfeit', seat, reason: 'timeoutAfterPause', clock: next };
  }
  const count = next.consecutiveTimeouts[seat] + 1;
  const counted: TurnClock = {
    ...next,
    consecutiveTimeouts: setSeat(next.consecutiveTimeouts, seat, count),
    timedOutTurnKey: next.turnKey,
    skipReady: true,
  };
  return count >= TURN_TIMEOUTS_TO_FORFEIT
    ? { kind: 'forfeit', seat, reason: 'turnTimeouts', clock: counted }
    : { kind: 'timeout', seat, mode, counted: true, clock: counted };
}

/** The public clock view (same for both seats) as of `clock.at`; null when no clock runs. */
export function clockView(clock: TurnClock): ClockView | null {
  const active = clockSeat(clock);
  if (active === null) return null;
  const running = isRunning(clock);
  const ms = (value: number): number => Math.max(0, Math.round(value));
  const remainingMs = ms(remainingOf(clock));
  const serverTime = ms(clock.wallAt);
  return {
    seat: active.seat,
    mode: active.mode,
    running,
    remainingMs,
    deadline: running ? serverTime + remainingMs : null,
    serverTime,
    pauseLeftMs: [ms(clock.pauseLeftMs[0]), ms(clock.pauseLeftMs[1])],
    consecutiveTimeouts: [clock.consecutiveTimeouts[0], clock.consecutiveTimeouts[1]],
  };
}
