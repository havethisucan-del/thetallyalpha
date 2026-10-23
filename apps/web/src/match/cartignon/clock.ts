import type { ClockView } from '@cartignon/protocol';
import type { Seat } from '../../lib/synthetic';

/**
 * Pure match-clock arithmetic for display (R8a, ADR-0010). The server is the only authority on
 * time. The client never compares its wall clock with `serverTime` / `deadline` (the two clocks
 * can differ by any amount); it only counts the local time elapsed since the clock view was
 * received. Network latency is not compensated, so the display can lag the server slightly.
 */

/** Below this many milliseconds left a clock is shown as a warning. */
export const CLOCK_WARN_MS = 10_000;

/**
 * The local time source used for `receivedAt` and `now`: monotonic milliseconds, so system clock
 * changes (NTP, manual edits, sleep) cannot make a clock jump. Both values must come from the
 * same source.
 */
export function monotonicNow(): number {
  return performance.now();
}

export interface ClockReading {
  /** Whose clock runs. */
  seat: Seat;
  mode: ClockView['mode'];
  /** True while the clock's seat is disconnected: the clock stops and its pause budget drains. */
  paused: boolean;
  /** Time left on the clock now; counts down only while running, never below 0. */
  remainingMs: number;
  /** Pause budget left now for the clock's seat; drains only while paused, never below 0. */
  pauseLeftMs: number;
  /** Pause budget left now per seat (index = seat); only the clock's seat drains. */
  pauseLeftBySeat: readonly [number, number];
  consecutiveTimeouts: readonly [number, number];
  /** The clock belongs to the given seat (false without a seat). */
  isMine: boolean;
  /** Under `CLOCK_WARN_MS` left. */
  warn: boolean;
  /** Nothing left; the server decides what happens next (no local prediction). */
  expired: boolean;
}

/**
 * Reads a clock view received at `receivedAt` as of `now` (both from `monotonicNow` or another
 * single source). Returns null when no clock runs.
 */
export function readClock(
  clock: ClockView | null,
  receivedAt: number | null,
  now: number,
  mySeat: Seat | null,
): ClockReading | null {
  if (clock === null) return null;
  const elapsed = receivedAt === null ? 0 : Math.max(0, now - receivedAt);
  const paused = !clock.running;
  const remainingMs = paused ? clock.remainingMs : Math.max(0, clock.remainingMs - elapsed);
  const drained = (seat: Seat) => {
    const left = clock.pauseLeftMs[seat];
    return paused && seat === clock.seat ? Math.max(0, left - elapsed) : left;
  };
  const pauseLeftBySeat = [drained(0), drained(1)] as const;
  return {
    seat: clock.seat,
    mode: clock.mode,
    paused,
    remainingMs,
    pauseLeftMs: pauseLeftBySeat[clock.seat],
    pauseLeftBySeat,
    consecutiveTimeouts: clock.consecutiveTimeouts,
    isMine: mySeat !== null && mySeat === clock.seat,
    warn: remainingMs < CLOCK_WARN_MS,
    expired: remainingMs === 0,
  };
}

/**
 * Whether a display of this clock changes over time: a running clock counts down, a paused one
 * drains the seat's pause budget. A paused clock without budget left is static until the server
 * sends the resume.
 */
export function clockTicks(clock: ClockView | null): boolean {
  if (clock === null) return false;
  if (clock.running) return clock.remainingMs > 0;
  return clock.pauseLeftMs[clock.seat] > 0;
}

/**
 * Formats milliseconds as `m:ss`, rounding up to the next whole second so `0:00` is shown only
 * when no time is left (a countdown convention). Invalid or negative input reads as `0:00`.
 */
export function formatClock(ms: number): string {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
