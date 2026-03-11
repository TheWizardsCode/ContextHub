import { describe, it, expect } from 'vitest';
import { TokenBucketThrottler, makeThrottlerFromEnv } from '../src/github-throttler.js';

// Fake clock that we can advance manually
class FakeClock {
  private t = 0;
  now() { return this.t; }
  advance(ms: number) { this.t += ms; }
}

describe('TokenBucketThrottler - basic token semantics', () => {
  it('starts with burst tokens and consumes one per scheduled task', async () => {
    const clock = new FakeClock();
    const t = new TokenBucketThrottler({ rate: 1, burst: 2, concurrency: 10, clock });
    let ran = 0;
    await Promise.all([
      t.schedule(async () => { ran += 1; return 1; }),
      t.schedule(async () => { ran += 1; return 2; }),
    ]);
    expect(ran).toBe(2);
  });

  it('refills tokens over time according to rate', async () => {
    const clock = new FakeClock();
    const t = new TokenBucketThrottler({ rate: 1, burst: 2, concurrency: 10, clock });
    // consume burst
    await t.schedule(() => 1);
    await t.schedule(() => 2);
    // schedule a third task which will wait for a token
    const p = t.schedule(() => 3);
    // advance clock less than required -> still pending
    clock.advance(500);
    // allow event loop to process any timers
    await new Promise(r => setTimeout(r, 0));
    // not resolved yet
    let resolved = false;
    p.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 0));
    expect(resolved).toBe(false);
    // advance one second to refill 1 token
    clock.advance(500);
    await new Promise(r => setTimeout(r, 0));
    await p;
    expect(resolved).toBe(true);
  });
});

describe('TokenBucketThrottler - concurrency cap', () => {
  it('enforces concurrency cap', async () => {
    const clock = new FakeClock();
    const t = new TokenBucketThrottler({ rate: 10, burst: 10, concurrency: 1, clock });
    let running = 0;
    const tasks = Array.from({ length: 3 }, () => t.schedule(async () => {
      running += 1;
      // hang until we advance clock (simulate async work)
      await new Promise(r => setTimeout(r, 0));
      running -= 1;
      return true;
    }));
    // allow tasks to start
    await new Promise(r => setTimeout(r, 0));
    // only one should be running due to concurrency cap
    expect(running).toBeLessThanOrEqual(1);
    await Promise.all(tasks);
  });
});
