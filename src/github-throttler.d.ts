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
export type Clock = {
    now(): number;
};
export type ThrottlerOptions = {
    rate: number;
    burst: number;
    concurrency: number;
    clock?: Clock;
};
export declare class TokenBucketThrottler {
    private rate;
    private burst;
    private concurrency;
    private clock;
    private tokens;
    private lastRefill;
    private active;
    private queue;
    private debug;
    private retryCount;
    private errorCount;
    private readonly taskContext;
    getStats(): {
        active: number;
        queueLength: number;
        tokens: number;
        rate: number;
        burst: number;
        concurrency: number;
        retryCount: number;
        errorCount: number;
    };
    incrementRetry(): void;
    incrementError(): void;
    constructor(opts: ThrottlerOptions);
    /**
     * Wait for the throttler to become idle (no active tasks and empty queue).
     * Resolves true if the throttler drained within the grace period, false
     * if the grace period elapsed while it remained busy.
     *
     * This helper is intended for test harnesses and debugging to avoid
     * races where background tasks continue after callers close shared
     * resources (e.g. database connections).
     */
    waitForIdle(graceMs?: number, pollInterval?: number): Promise<boolean>;
    schedule<T>(fn: () => Promise<T> | T): Promise<T>;
    private refillTokens;
    private scheduleProcess;
    private processQueue;
}
/**
 * Make a throttler instance from environment variables (or provided overrides)
 */
export declare function makeThrottlerFromEnv(overrides?: Partial<ThrottlerOptions>): TokenBucketThrottler;
export declare const throttler: TokenBucketThrottler;
export default throttler;
//# sourceMappingURL=github-throttler.d.ts.map