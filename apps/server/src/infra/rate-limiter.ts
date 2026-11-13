import type { RateLimiterPort, RateLimitRule } from "../domain/index.ts";

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

const STALE_BUCKET_TTL_MS = 10 * 60 * 1000;
const SWEEP_OP_INTERVAL = 1_024;
const SWEEP_SIZE_THRESHOLD = 2_048;

export class InMemoryRateLimiter implements RateLimiterPort {
  private readonly buckets = new Map<string, BucketState>();
  private opCounter = 0;

  consume(
    key: string,
    rule: RateLimitRule,
    nowMs: number = Date.now(),
  ): boolean {
    if (++this.opCounter >= SWEEP_OP_INTERVAL) {
      this.opCounter = 0;
      if (this.buckets.size >= SWEEP_SIZE_THRESHOLD) {
        this.sweepStale(nowMs);
      }
    }

    if (rule.capacity < 1) {
      return false;
    }

    const existing = this.buckets.get(key);
    if (!existing) {
      this.buckets.set(key, {
        tokens: rule.capacity - 1,
        lastRefillMs: nowMs,
      });
      return true;
    }

    const elapsedSeconds = Math.max(0, (nowMs - existing.lastRefillMs) / 1000);
    const refilled = Math.min(
      rule.capacity,
      existing.tokens + elapsedSeconds * rule.refillPerSecond,
    );

    if (refilled < 1) {
      existing.tokens = refilled;
      existing.lastRefillMs = nowMs;
      return false;
    }

    existing.tokens = refilled - 1;
    existing.lastRefillMs = nowMs;
    return true;
  }

  resetKey(key: string): void {
    this.buckets.delete(key);
  }

  private sweepStale(nowMs: number): void {
    for (const [key, state] of this.buckets.entries()) {
      if (nowMs - state.lastRefillMs > STALE_BUCKET_TTL_MS) {
        this.buckets.delete(key);
      }
    }
  }
}
