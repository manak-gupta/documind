// Sliding-window rate limiter: at most `max` units in any `windowMs` period.
//
// Gemini's free tier allows 100 embedding requests per minute, and every text inside a batch
// call counts as one request. Without pacing, indexing a 100-page PDF hits the limit and the
// job fails. With it, big documents just take a little longer.
//
// Single-process by design: one worker process owns the quota. With several workers, the
// window would need to live in Postgres or Redis instead.
export class RateLimiter {
  private readonly events: { at: number; units: number }[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: { max: number; windowMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
    this.max = opts.max;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // Waits until `units` more can be spent without exceeding the limit, then records them.
  async acquire(units: number): Promise<void> {
    if (units > this.max) throw new Error(`Cannot acquire ${units} units: limit is ${this.max} per window`);
    for (;;) {
      const now = this.now();
      while (this.events.length && this.events[0]!.at <= now - this.windowMs) this.events.shift();
      const used = this.events.reduce((s, e) => s + e.units, 0);
      if (used + units <= this.max) {
        this.events.push({ at: now, units });
        return;
      }
      // Wait until the oldest spend leaves the window, then re-check.
      await this.sleep(this.events[0]!.at + this.windowMs - now + 50);
    }
  }
}
