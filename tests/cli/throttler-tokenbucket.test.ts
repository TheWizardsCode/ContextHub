import { describe, it, expect, vi } from 'vitest';
import { TokenBucketThrottler } from '../../src/github-throttler.js';
import { makeDeterministicClock } from '../test-helpers.js';

describe('TokenBucketThrottler (unit, deterministic)', () => {
  it('supports burst tokens and deterministic refill using injectable clock', async () => {
    const clock = makeDeterministicClock(0);

    const t = new TokenBucketThrottler({ rate: 1, burst: 2, concurrency: Infinity, clock });

    // Start full (burst)
    expect((t as any).tokens).toBe(2);

    // Consume two tokens immediately
    const v1 = await t.schedule(() => 'a');
    const v2 = await t.schedule(() => 'b');
    expect(v1).toBe('a');
    expect(v2).toBe('b');

    // Tokens should be depleted
    expect((t as any).tokens).toBe(0);

    // Schedule a third task which should be queued (no tokens)
    const p3 = t.schedule(() => 'c');
    // queue length should be 1 (task queued)
    expect((t as any).queue.length).toBe(1);

    // Advance clock by 1 second -> 1 token should be added
    clock.advance(1000);
    // Manually invoke processQueue to simulate timer tick driven by the injectable clock
    (t as any).processQueue();

    const v3 = await p3;
    expect(v3).toBe('c');

    // Ensure tokens never exceed burst after a long pause
    clock.advance(5000); // 5s would yield 5 tokens if unbounded
    (t as any).refillTokens();
    expect((t as any).tokens).toBeLessThanOrEqual(2);
  });

  it('enforces concurrency cap (max active tasks)', async () => {
    const t = new TokenBucketThrottler({ rate: 1000, burst: 1000, concurrency: 3 });

    let running = 0;
    let maxRunning = 0;

    const workDelay = 30; // ms

    const makeTask = () => t.schedule(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      // allow overlap
      await new Promise((r) => setTimeout(r, workDelay));
      running -= 1;
      return true;
    });

    // Schedule several tasks
    const promises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i += 1) promises.push(makeTask());

    await Promise.all(promises);

    // We should have seen some parallelism but never exceeded concurrency
    expect(maxRunning).toBeGreaterThan(1);
    expect(maxRunning).toBeLessThanOrEqual(3);
  });

  it('waitForIdle resolves when throttler drains within grace period', async () => {
    const t = new TokenBucketThrottler({ rate: 1000, burst: 1000, concurrency: 1 });
    // schedule a short task
    await t.schedule(async () => { await new Promise(r => setTimeout(r, 5)); return true; });
    const drained = await t.waitForIdle(1000, 10);
    expect(drained).toBe(true);
  });
});
