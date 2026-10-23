import type { ClockView } from '@cartignon/protocol';
import { useEffect, useRef, useState } from 'react';
import type { Seat } from '../../lib/synthetic';
import { clockTicks, monotonicNow, readClock, type ClockReading } from './clock';

/** Display refresh interval: a 250 ms tick keeps an `m:ss` display within a quarter second. */
export const CLOCK_TICK_MS = 250;

export interface UseClockOptions {
  /** Local time source; must be the one that produced `receivedAt`. */
  now?: () => number;
  intervalMs?: number;
}

/**
 * Reads the match clock for display and re-renders while it changes over time (a running clock,
 * or a paused one whose pause budget drains). No timer runs for a static or absent clock; the
 * interval is cleared when the clock changes and on unmount.
 */
export function useClock(
  clock: ClockView | null,
  receivedAt: number | null,
  mySeat: Seat | null,
  options: UseClockOptions = {},
): ClockReading | null {
  const nowFn = options.now ?? monotonicNow;
  const intervalMs = options.intervalMs ?? CLOCK_TICK_MS;
  // Kept in a ref so an inline `now` function does not restart the interval on every render.
  const nowRef = useRef(nowFn);
  nowRef.current = nowFn;
  const [now, setNow] = useState(nowFn);
  const ticks = clockTicks(clock);

  useEffect(() => {
    // A new clock view starts from the current time, not from the last tick.
    setNow(nowRef.current());
    if (!ticks) return undefined;
    const id = setInterval(() => {
      setNow(nowRef.current());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [clock, receivedAt, ticks, intervalMs]);

  return readClock(clock, receivedAt, now, mySeat);
}
