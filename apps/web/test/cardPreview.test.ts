import { describe, expect, it } from 'vitest';
import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  isDoubleTap,
  type Tap,
} from '../src/match/cartignon/cardPreview';

const first: Tap = { x: 100, y: 700, time: 1000 };

describe('isDoubleTap', () => {
  it('needs a previous tap', () => {
    expect(isDoubleTap(null, first)).toBe(false);
  });

  it('accepts a second tap close in time and place', () => {
    expect(isDoubleTap(first, { x: 104, y: 690, time: 1000 + 120 })).toBe(true);
    expect(isDoubleTap(first, { x: 100, y: 700, time: 1000 + DOUBLE_TAP_MS })).toBe(true);
  });

  it('rejects a slow second tap', () => {
    expect(isDoubleTap(first, { x: 100, y: 700, time: 1000 + DOUBLE_TAP_MS + 1 })).toBe(false);
  });

  it('rejects a second tap too far away (another card)', () => {
    expect(isDoubleTap(first, { x: 100 + DOUBLE_TAP_SLOP_PX + 1, y: 700, time: 1100 })).toBe(false);
  });

  it('tolerates the lift of a selected hand card (about 16px)', () => {
    expect(isDoubleTap(first, { x: 100, y: 716, time: 1150 })).toBe(true);
  });

  it('rejects taps out of order', () => {
    expect(isDoubleTap(first, { x: 100, y: 700, time: 900 })).toBe(false);
  });

  it('takes custom limits', () => {
    expect(isDoubleTap(first, { x: 100, y: 700, time: 1400 }, 500)).toBe(true);
    expect(isDoubleTap(first, { x: 130, y: 700, time: 1100 }, 300, 40)).toBe(true);
  });
});
