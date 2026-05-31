/**
 * Simple async token-bucket rate limiter. Centralises outbound throughput so we
 * never blow past either API's documented per-minute limit. One instance per
 * upstream (Aircall, JobNimbus).
 */
export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill: number;
  private queue: Array<() => void> = [];

  constructor(perMinute: number) {
    this.capacity = Math.max(1, perMinute);
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 60_000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /** Resolve once a token is available, then consume it. */
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait for the next token to refill.
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      setTimeout(() => {
        const next = this.queue.shift();
        if (next) next();
      }, waitMs);
    });
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}
