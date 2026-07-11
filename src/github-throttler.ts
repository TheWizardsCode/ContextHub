/**
 * Small token-bucket throttler with optional concurrency cap.
 * - Rate: tokens per second
 * - Burst: bucket capacity (initial tokens = burst)
 * - Concurrency: max number of concurrent running tasks
 *
 * The implementation keeps a FIFO queue of pending tasks and attempts to
 * dispatch them when both a token is available and concurrency allows.
 * The clock is injectable to allow deterministic unit tests.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type Clock = { now(): number };

export type ThrottlerOptions = {
  rate: number; // tokens per second
  burst: number; // bucket capacity
  concurrency: number; // max concurrent tasks (0 or Infinity = unlimited)
  clock?: Clock;
};

type Task<T> = {
  fn: () => Promise<T> | T;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

export class TokenBucketThrottler {
  private rate: number;
  private burst: number;
  private concurrency: number;
  private clock: Clock;

  private tokens: number;
  private lastRefill: number; // ms
  private active = 0;
  private queue: Array<Task<unknown>> = [];
  private debug = false;

  // Low-contention counters for instrumentation. Incrementing these
  // fields is intentionally lock-free to avoid impacting throttler
  // throughput. The accessor below exposes these values for diagnostics.
  private retryCount = 0;
  private errorCount = 0;

  // Marks execution that already runs inside this throttler so nested
  // schedule() calls can run inline without deadlocking on concurrency.
  private readonly taskContext = new AsyncLocalStorage<boolean>();

  // Expose simple stats without blocking the throttler operation
  getStats() {
    return {
      active: this.active,
      queueLength: this.queue.length,
      tokens: this.tokens,
      rate: this.rate,
      burst: this.burst,
      concurrency: this.concurrency,
      retryCount: this.retryCount,
      errorCount: this.errorCount,
    };
  }

  incrementRetry() { this.retryCount += 1; }
  incrementError() { this.errorCount += 1; }

  constructor(opts: ThrottlerOptions) {
    this.rate = opts.rate;
    this.burst = Math.max(1, Math.floor(opts.burst));
    this.concurrency = opts.concurrency <= 0 ? Infinity : Math.floor(opts.concurrency);
    this.clock = opts.clock || { now: () => Date.now() };

    // start full
    this.tokens = this.burst;
    this.lastRefill = this.clock.now();
    // Enable throttler debug logging only when explicitly requested.
    // Tying this to global `--verbose` causes console.debug output to interfere
    // with full-screen TUI rendering during GitHub push operations.
    this.debug = Boolean(process.env.WL_GITHUB_THROTTLER_DEBUG);
  }

  /**
   * Wait for the throttler to become idle (no active tasks and empty queue).
   * Resolves true if the throttler drained within the grace period, false
   * if the grace period elapsed while it remained busy.
   *
   * This helper is intended for test harnesses and debugging to avoid
   * races where background tasks continue after callers close shared
   * resources (e.g. database connections).
   */
  async waitForIdle(graceMs: number = 10000, pollInterval = 100): Promise<boolean> {
    const isBusy = () => this.active > 0 || this.queue.length > 0;
    if (!isBusy()) return true;
    const start = this.clock.now();
    // Poll until drained or timeout
    return new Promise<boolean>((resolve) => {
      const check = () => {
        try {
          if (!isBusy()) return resolve(true);
          if (this.clock.now() - start >= graceMs) return resolve(false);
        } catch (_) {
          return resolve(false);
        }
        setTimeout(check, pollInterval);
      };
      check();
    });
  }

  schedule<T>(fn: () => Promise<T> | T): Promise<T> {
    // Reentrant path: if we are already inside a scheduled task for this
    // throttler instance, execute inline to avoid self-deadlock when the
    // outer task has consumed available concurrency slots.
    if (this.taskContext.getStore()) {
      return Promise.resolve().then(fn);
    }

    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = { fn, resolve, reject } as Task<T>;
      this.queue.push(task as Task<unknown>);
      // try dispatch immediately
      this.processQueue();
    });
  }

  private refillTokens(): void {
    const now = this.clock.now();
    if (now <= this.lastRefill) return;
    const elapsedMs = now - this.lastRefill;
    const toAdd = (elapsedMs / 1000) * this.rate;
    if (toAdd <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + toAdd);
    this.lastRefill = now;
  }

  private scheduleProcess(delayMs: number): void {
    // schedule a future attempt to process the queue
    setTimeout(() => this.processQueue(), Math.max(0, Math.floor(delayMs)));
  }

  private processQueue(): void {
    // refill using clock
    this.refillTokens();

    // If no queued tasks, nothing to do
    if (this.queue.length === 0) {
      // Keep quiet when idle to avoid noisy logs during normal operation/testing.
      return;
    }

    // If we have no tokens, compute next token arrival and schedule
    if (this.tokens < 1) {
      const missing = 1 - this.tokens;
      const msUntil = (missing / this.rate) * 1000;
      if (this.debug) console.debug(`[throttler] no-tokens tokens=${this.tokens.toFixed(2)} msUntil=${Math.ceil(msUntil)} queue=${this.queue.length} active=${this.active}`);
      this.scheduleProcess(msUntil);
      return;
    }

    // If concurrency limit reached, wait for running tasks to complete
    if (this.active >= this.concurrency) return;

    // Pop next task and run it consuming one token
    const task = this.queue.shift() as Task<unknown> | undefined;
    if (!task) return;

    // consume one token
    this.tokens -= 1;
    // Ensure tokens not negative
    if (this.tokens < 0) this.tokens = 0;

    this.active += 1;
    if (this.debug) console.debug(`[throttler] dispatch active=${this.active} tokens=${this.tokens.toFixed(2)} queue=${this.queue.length}`);

    // Execute task
    Promise.resolve()
      .then(() => this.taskContext.run(true, () => task.fn()))
      .then((res) => {
        this.active -= 1;
        (task.resolve as (v: unknown) => void)(res);
        if (this.debug) console.debug(`[throttler] complete active=${this.active} tokens=${this.tokens.toFixed(2)} queue=${this.queue.length}`);
        // process more tasks (immediately) - may schedule next refill internally
        this.processQueue();
      })
      .catch((err) => {
        this.active -= 1;
        // record error occurrence for diagnostics
        try { this.incrementError(); } catch (_) {}
        task.reject(err);
        if (this.debug) console.debug(`[throttler] error active=${this.active} tokens=${this.tokens.toFixed(2)} queue=${this.queue.length} err=${String(err?.message ?? err)}`);
        this.processQueue();
      });

    // After starting one, attempt to start more if possible
    // Use setImmediate style to avoid deep recursion
    if (typeof setImmediate !== 'undefined') setImmediate(() => this.processQueue());
    else this.scheduleProcess(0);
  }
}

/**
 * Make a throttler instance from environment variables (or provided overrides)
 */
export function makeThrottlerFromEnv(overrides?: Partial<ThrottlerOptions>): TokenBucketThrottler {
  // Runtime defaults intentionally set to conservative values that balance
  // parallelism and token refill to avoid accidental secondary rate limits
  // during normal usage. The defaults can be overridden by environment
  // variables (WL_GITHUB_RATE, WL_GITHUB_BURST, WL_GITHUB_CONCURRENCY) or
  // by passing `overrides` for tests.
  const rate = Number(process.env.WL_GITHUB_RATE || '6');
  const burst = Number(process.env.WL_GITHUB_BURST || '12');
  // Default concurrency is 6 when the env var is not explicitly provided so
  // the throttler enforces a reasonable concurrency cap out-of-the-box.
  const concurrency = process.env.WL_GITHUB_CONCURRENCY !== undefined
    ? Number(process.env.WL_GITHUB_CONCURRENCY)
    : 6;

  const opts: ThrottlerOptions = {
    rate: overrides?.rate ?? rate,
    burst: overrides?.burst ?? burst,
    concurrency: overrides?.concurrency ?? concurrency,
    clock: overrides?.clock,
  } as ThrottlerOptions;

  return new TokenBucketThrottler(opts);
}

// Default shared instance
export const throttler = makeThrottlerFromEnv();

export default throttler;
