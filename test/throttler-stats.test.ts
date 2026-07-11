import { describe, it, expect } from 'vitest';
import { TokenBucketThrottler } from '../src/github-throttler.js';

class FakeClock {
  private t = 0;
  now() { return this.t; }
  advance(ms: number) { this.t += ms; }
}

describe('TokenBucketThrottler stats accessor', () => {
  it('exposes retryCount and errorCount and increments via methods', () => {
    const clock = new FakeClock();
    const t = new TokenBucketThrottler({ rate: 1, burst: 1, concurrency: 1, clock });
    const s0 = t.getStats();
    expect(typeof s0.retryCount).toBe('number');
    expect(typeof s0.errorCount).toBe('number');
    expect(s0.retryCount).toBe(0);
    expect(s0.errorCount).toBe(0);

    // bump counters via public methods
    (t as any).incrementRetry();
    (t as any).incrementError();
    const s1 = t.getStats();
    expect(s1.retryCount).toBe(1);
    expect(s1.errorCount).toBe(1);
  });

  it('increments errorCount when a scheduled task throws', async () => {
    const clock = new FakeClock();
    const t = new TokenBucketThrottler({ rate: 10, burst: 10, concurrency: 10, clock });
    // schedule a task that throws
    const p = t.schedule(async () => { throw new Error('boom'); });
    await expect(p).rejects.toThrow();
    const s = t.getStats();
    // error count should be at least 1
    expect(s.errorCount).toBeGreaterThanOrEqual(1);
  });
});
