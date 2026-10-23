import type { ClockView } from '@cartignon/protocol';
import { describe, expect, it } from 'vitest';
import { CLOCK_WARN_MS, clockTicks, formatClock, readClock } from '../src/match/cartignon/clock';

function clock(overrides: Partial<ClockView> = {}): ClockView {
  return {
    seat: 0,
    mode: 'turn',
    running: true,
    remainingMs: 60_000,
    deadline: 1_000_060_000,
    serverTime: 1_000_000_000,
    pauseLeftMs: [180_000, 180_000],
    consecutiveTimeouts: [0, 1],
    ...overrides,
  };
}

describe('readClock', () => {
  it('returns null without a clock', () => {
    expect(readClock(null, null, 0, 0)).toBeNull();
    expect(readClock(null, 5, 10, 1)).toBeNull();
  });

  it('counts down by local elapsed time while running, clamped at 0', () => {
    const view = clock();
    expect(readClock(view, 1000, 1000, 0)?.remainingMs).toBe(60_000);
    expect(readClock(view, 1000, 3500, 0)?.remainingMs).toBe(57_500);
    const late = readClock(view, 1000, 100_000, 0);
    expect(late?.remainingMs).toBe(0);
    expect(late?.expired).toBe(true);
  });

  it('ignores serverTime and deadline (no wall-clock offset)', () => {
    const skewed = clock({ serverTime: 5, deadline: 60_005 });
    expect(readClock(skewed, 1000, 2000, 0)?.remainingMs).toBe(59_000);
  });

  it('never counts up when now precedes receipt', () => {
    expect(readClock(clock(), 1000, 500, 0)?.remainingMs).toBe(60_000);
  });

  it('holds the clock and drains the clock seat pause budget while paused', () => {
    const paused = clock({ seat: 1, running: false, deadline: null, pauseLeftMs: [100, 5000] });
    const reading = readClock(paused, 0, 2000, 0);
    expect(reading).toMatchObject({
      paused: true,
      remainingMs: 60_000,
      pauseLeftMs: 3000,
      pauseLeftBySeat: [100, 3000],
      seat: 1,
      isMine: false,
    });
    expect(readClock(paused, 0, 9000, 1)?.pauseLeftMs).toBe(0);
  });

  it('does not drain the pause budget while running', () => {
    const reading = readClock(clock(), 0, 2000, 0);
    expect(reading?.paused).toBe(false);
    expect(reading?.pauseLeftBySeat).toEqual([180_000, 180_000]);
  });

  it('reports mode, ownership and warning', () => {
    const choice = clock({ seat: 1, mode: 'choice', remainingMs: CLOCK_WARN_MS });
    expect(readClock(choice, 0, 0, 1)).toMatchObject({ mode: 'choice', isMine: true, warn: false });
    expect(readClock(choice, 0, 1, 1)?.warn).toBe(true);
    expect(readClock(choice, 0, 0, 0)?.isMine).toBe(false);
    expect(readClock(choice, 0, 0, null)?.isMine).toBe(false);
    expect(readClock(choice, 0, 0, 0)?.consecutiveTimeouts).toEqual([0, 1]);
  });

  it('treats a missing receipt time as zero elapsed', () => {
    expect(readClock(clock(), null, 99_999, 0)?.remainingMs).toBe(60_000);
  });
});

describe('clockTicks', () => {
  it('ticks while running or while a pause budget drains', () => {
    expect(clockTicks(null)).toBe(false);
    expect(clockTicks(clock())).toBe(true);
    expect(clockTicks(clock({ remainingMs: 0 }))).toBe(false);
    expect(clockTicks(clock({ running: false, deadline: null }))).toBe(true);
    expect(clockTicks(clock({ running: false, deadline: null, pauseLeftMs: [0, 9] }))).toBe(false);
  });
});

describe('formatClock', () => {
  it('formats m:ss, rounding up to whole seconds', () => {
    expect(formatClock(900_000)).toBe('15:00');
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(59_001)).toBe('1:00');
    expect(formatClock(9_500)).toBe('0:10');
    expect(formatClock(1)).toBe('0:01');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});
