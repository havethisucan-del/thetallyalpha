/**
 * Randomness abstraction. Rules draw randomness only through this interface so matches are
 * reproducible from a persisted snapshot: the RNG state is saved with the game state.
 */
export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /**
   * Serializable internal state (`RNG_STATE_PATTERN`: 32 lowercase hex chars = 128 bits), to
   * persist alongside the snapshot. Server-only: never reveal it to clients.
   */
  getState(): string;
}

/** Number of seed bytes `createRngFromSeedBytes` requires (= state size). */
export const RNG_SEED_BYTES = 16;

/** Format of `Rng.getState()`: four 32-bit words, big-endian, as 32 lowercase hex chars. */
export const RNG_STATE_PATTERN = /^[0-9a-f]{32}$/;

type State = [number, number, number, number];

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

function toHex(s: State): string {
  return s.map((w) => w.toString(16).padStart(8, '0')).join('');
}

function assertNonZero(s: State): void {
  // xoshiro's all-zero state is a fixed point (it would emit only zeros).
  if ((s[0] | s[1] | s[2] | s[3]) === 0) throw new RangeError('RNG state must not be all zero');
}

/**
 * xoshiro128** 1.1 (128-bit state, period 2^128 - 1), transcribed from the reference
 * implementation by David Blackman and Sebastiano Vigna, https://prng.di.unimi.it/xoshiro128starstar.c
 * (public domain). Not cryptographically secure: unpredictability comes from the 128-bit CSPRNG
 * seed (not brute-forceable) and from the state never leaving the server.
 */
function xoshiro128ss(initial: State): Rng {
  assertNonZero(initial);
  const s: State = [initial[0] >>> 0, initial[1] >>> 0, initial[2] >>> 0, initial[3] >>> 0];
  const nextUint32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] = (s[2] ^ s[0]) >>> 0;
    s[3] = (s[3] ^ s[1]) >>> 0;
    s[1] = (s[1] ^ s[2]) >>> 0;
    s[0] = (s[0] ^ s[3]) >>> 0;
    s[2] = (s[2] ^ t) >>> 0;
    s[3] = rotl(s[3], 11);
    return result;
  };
  return {
    nextInt(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 2 ** 32) {
        throw new RangeError(`maxExclusive must be an integer in [1, 2^32], got ${maxExclusive}`);
      }
      // Rejection sampling avoids modulo bias.
      const limit = 2 ** 32 - (2 ** 32 % maxExclusive);
      let x = nextUint32();
      while (x >= limit) x = nextUint32();
      return x % maxExclusive;
    },
    getState: () => toHex(s),
  };
}

/** Resumes an RNG from a persisted `getState()` value. Throws on a malformed or all-zero state. */
export function createRngFromState(state: string): Rng {
  if (!RNG_STATE_PATTERN.test(state)) {
    throw new RangeError('RNG state must be 32 lowercase hex characters');
  }
  const words: State = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) words[i] = Number.parseInt(state.slice(i * 8, i * 8 + 8), 16);
  return xoshiro128ss(words);
}

/**
 * Creates a fresh RNG from exactly 16 bytes of seed material. Production callers must pass
 * CSPRNG output (the server uses `node:crypto` `randomBytes(16)`); game-core has no I/O.
 * The resulting state's hex equals the hex of the bytes.
 */
export function createRngFromSeedBytes(bytes: Uint8Array): Rng {
  if (bytes.length !== RNG_SEED_BYTES) {
    throw new RangeError(`seed must be exactly ${RNG_SEED_BYTES} bytes, got ${bytes.length}`);
  }
  const words: State = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const o = i * 4;
    words[i] =
      (((bytes[o] ?? 0) << 24) |
        ((bytes[o + 1] ?? 0) << 16) |
        ((bytes[o + 2] ?? 0) << 8) |
        (bytes[o + 3] ?? 0)) >>>
      0;
  }
  return xoshiro128ss(words);
}

/**
 * TESTS / DEV TOOLS ONLY. Expands a small integer seed into 16 seed bytes with SplitMix64
 * (Vigna, https://prng.di.unimi.it/splitmix64.c — the generator recommended for seeding xoshiro).
 * A small seed is brute-forceable, so production code must never use this path.
 */
export function expandTestSeed(seed: number): Uint8Array {
  if (!Number.isSafeInteger(seed)) throw new RangeError(`seed must be a safe integer, got ${seed}`);
  let x = BigInt.asUintN(64, BigInt(seed));
  const out = new Uint8Array(RNG_SEED_BYTES);
  for (let half = 0; half < 2; half++) {
    x = BigInt.asUintN(64, x + 0x9e3779b97f4a7c15n);
    let z = x;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    z = z ^ (z >> 31n);
    for (let b = 0; b < 8; b++) out[half * 8 + b] = Number((z >> BigInt(56 - b * 8)) & 0xffn);
  }
  return out;
}

/**
 * TESTS / DEV TOOLS ONLY: an RNG from a small integer seed (see `expandTestSeed`). Production
 * code uses `createRngFromSeedBytes` (fresh match) or `createRngFromState` (resume).
 */
export function createSeededRng(seed: number): Rng {
  return createRngFromSeedBytes(expandTestSeed(seed));
}
