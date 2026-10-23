export interface RateLimit {
  /** Burst size: requests allowed at once from a full bucket. */
  readonly burst: number;
  /** Sustained rate: tokens added per minute. */
  readonly perMinute: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export const DEFAULT_MAX_KEYS = 100_000;

/**
 * In-memory token bucket keyed by an arbitrary string (IP key, identity). Single process
 * only; a horizontally scaled deployment needs a shared store instead.
 *
 * Memory is bounded: at `maxKeys` tracked keys, full buckets are swept and, if the map is
 * still full, new keys are refused (fail closed) while known keys keep working.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;
  private readonly limit: RateLimit;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(limit: RateLimit, now: () => number = Date.now, maxKeys = DEFAULT_MAX_KEYS) {
    this.limit = limit;
    this.now = now;
    this.maxKeys = maxKeys;
    this.refillPerMs = limit.perMinute / 60_000;
  }

  /** Takes one token for `key`; false means the caller is over the limit. */
  take(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) {
        this.sweep();
        if (this.buckets.size >= this.maxKeys) return false;
      }
      bucket = { tokens: this.limit.burst, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      const refilled = bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs;
      bucket.tokens = Math.min(this.limit.burst, refilled);
      bucket.updatedAt = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Drops buckets that have refilled completely (they carry no information). */
  sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      const tokens = bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs;
      if (tokens >= this.limit.burst) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
