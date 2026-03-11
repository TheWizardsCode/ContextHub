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

  constructor(opts: ThrottlerOptions) {
    this.rate = opts.rate;
    this.burst = Math.max(1, Math.floor(opts.burst));
    this.concurrency = opts.concurrency <= 0 ? Infinity : Math.floor(opts.concurrency);
    this.clock = opts.clock || { now: () => Date.now() };

    // start full
    this.tokens = this.burst;
    this.lastRefill = this.clock.now();
  }

  schedule<T>(fn: () => Promise<T> | T): Promise<T> {
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
    if (this.queue.length === 0) return;

    // If we have no tokens, compute next token arrival and schedule
    if (this.tokens < 1) {
      const missing = 1 - this.tokens;
      const msUntil = (missing / this.rate) * 1000;
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

    // Execute task
    Promise.resolve()
      .then(() => task.fn())
      .then((res) => {
        this.active -= 1;
        (task.resolve as (v: unknown) => void)(res);
        // process more tasks (immediately) - may schedule next refill internally
        this.processQueue();
      })
      .catch((err) => {
        this.active -= 1;
        task.reject(err);
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
  const rate = Number(process.env.WL_GITHUB_RATE || '6');
  const burst = Number(process.env.WL_GITHUB_BURST || '12');
  const concurrency = Number(process.env.WL_GITHUB_CONCURRENCY || String(6));

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
