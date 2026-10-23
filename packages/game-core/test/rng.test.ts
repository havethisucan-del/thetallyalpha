import { describe, expect, it } from 'vitest';
import {
  createRngFromSeedBytes,
  createRngFromState,
  createSeededRng,
  expandTestSeed,
  RNG_STATE_PATTERN,
} from '../src/index.js';

const draw = (rng: { nextInt(n: number): number }, count: number, max = 2 ** 32): number[] =>
  Array.from({ length: count }, () => rng.nextInt(max));

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe('xoshiro128** rng', () => {
  it('state is 32 lowercase hex chars and equals the hex of the seed bytes', () => {
    const seed = bytes(0xde, 0xad, 0xbe, 0xef, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xa, 0xb);
    const rng = createRngFromSeedBytes(seed);
    expect(rng.getState()).toBe('deadbeef000102030405060708090a0b');
    rng.nextInt(10);
    expect(rng.getState()).toMatch(RNG_STATE_PATTERN);
    expect(rng.getState()).not.toBe('deadbeef000102030405060708090a0b');
  });

  it('is deterministic from a state and resumes exactly from getState()', () => {
    const a = createSeededRng(42);
    draw(a, 5);
    const saved = a.getState();
    const continued = draw(a, 50, 1000);
    const resumed = createRngFromState(saved);
    expect(draw(resumed, 50, 1000)).toEqual(continued);
    expect(resumed.getState()).toBe(a.getState());
    expect(draw(createRngFromState(saved), 50, 1000)).toEqual(continued);
  });

  it('pins the output stream (regression guard for the transcribed algorithm)', () => {
    // Hand-computable first output: result = rotl(s1 * 5, 7) * 9 with s1 = 1 → rotl(5, 7) * 9.
    expect(createRngFromState('00000000000000010000000000000000').nextInt(2 ** 32)).toBe(
      (5 << 7) * 9,
    );
    // State after one step, by hand from the reference: t = 1 << 9; s = [1, 1, t, rotl(1, 11)].
    const r = createRngFromState('00000000000000010000000000000000');
    r.nextInt(2 ** 32);
    expect(r.getState()).toBe('00000001000000010000020000000800');
  });

  it('pins the first 8 outputs for a non-trivial state (independent reference vector)', () => {
    // Expected values computed with a standalone Python transcription of the reference C code
    // (https://prng.di.unimi.it/xoshiro128starstar.c), not with this module.
    // State words (big-endian hex): s0=0x01234567 s1=0x89abcdef s2=0xdeadbeef s3=0x0badf00d.
    const r = createRngFromState('0123456789abcdefdeadbeef0badf00d');
    expect(draw(r, 8)).toEqual([
      0x99998498, 0x4548108f, 0x61f0d4a8, 0xa54a1c55, 0x35ba6e75, 0x8b116ae7, 0x9f35ffbe,
      0x68070916,
    ]);
    expect(r.getState()).toBe('c0d927751a16412e6bde1d3914e3cf58');
  });

  it('pins the createSeededRng(0) stream (SplitMix64 expansion + xoshiro, independent reference)', () => {
    expect(draw(createSeededRng(0), 4)).toEqual([0x1e93e34b, 0xa6a5a9ba, 0x39fd860c, 0x51e719af]);
  });

  it('distinct seeds give distinct streams', () => {
    const streams = new Set<string>();
    for (let seed = 0; seed < 200; seed++) streams.add(draw(createSeededRng(seed), 4).join(','));
    expect(streams.size).toBe(200);
    const one = bytes(...new Array<number>(15).fill(0), 1);
    const two = bytes(...new Array<number>(15).fill(0), 2);
    expect(draw(createRngFromSeedBytes(one), 8)).not.toEqual(draw(createRngFromSeedBytes(two), 8));
  });

  it('expandTestSeed is deterministic, 16 bytes, and distinct per seed', () => {
    expect(expandTestSeed(7)).toEqual(expandTestSeed(7));
    expect(expandTestSeed(7)).toHaveLength(16);
    expect(expandTestSeed(7)).not.toEqual(expandTestSeed(8));
    expect(() => expandTestSeed(1.5)).toThrow(RangeError);
    // Known SplitMix64 outputs for seed 0 (first two values of the reference sequence).
    expect(createSeededRng(0).getState()).toBe('e220a8397b1dcdaf6e789e6aa1b965f4');
  });

  it('nextInt uses rejection sampling: results match the raw stream minus rejected draws', () => {
    const max = 2 ** 31 + 1; // limit = 2^31 + 1, so roughly half of the raw draws are rejected
    const limit = 2 ** 32 - (2 ** 32 % max);
    const state = createSeededRng(5).getState();
    const raw = createRngFromState(state); // nextInt(2^32) never rejects: identity on raw output
    const sampled = createRngFromState(state);
    let rawDraws = 0;
    for (let i = 0; i < 200; i++) {
      let x = raw.nextInt(2 ** 32);
      rawDraws++;
      while (x >= limit) {
        x = raw.nextInt(2 ** 32);
        rawDraws++;
      }
      const got = sampled.nextInt(max);
      expect(got).toBe(x % max);
      expect(got).toBeLessThan(max);
    }
    expect(rawDraws).toBeGreaterThan(200);
    expect(sampled.getState()).toBe(raw.getState());
  });

  it('nextInt stays in range and covers it for small ranges', () => {
    const rng = createSeededRng(9);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6000; i++) {
      const v = rng.nextInt(6);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    for (const c of counts) expect(c).toBeGreaterThan(800);
    expect(createSeededRng(1).nextInt(1)).toBe(0);
  });

  it('rejects invalid ranges', () => {
    for (const bad of [0, 1.5, -1, 2 ** 32 + 1, Number.NaN]) {
      expect(() => createSeededRng(1).nextInt(bad)).toThrow(RangeError);
    }
  });

  it('guards against the all-zero state and malformed input', () => {
    expect(() => createRngFromSeedBytes(new Uint8Array(16))).toThrow(RangeError);
    expect(() => createRngFromState('0'.repeat(32))).toThrow(RangeError);
    expect(() => createRngFromSeedBytes(new Uint8Array(15).fill(1))).toThrow(RangeError);
    expect(() => createRngFromSeedBytes(new Uint8Array(32).fill(1))).toThrow(RangeError);
    for (const bad of ['', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'g'.repeat(32)]) {
      expect(() => createRngFromState(bad)).toThrow(RangeError);
    }
  });
});
