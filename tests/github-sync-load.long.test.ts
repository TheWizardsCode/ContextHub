import { describe, it, expect, vi, beforeEach } from 'vitest';
import throttler from '../src/github-throttler.js';
import { describeLong, itLong } from './test-utils.js';

// Long-running load simulation for github-sync. This should be gated and
// will be skipped in CI unless WL_RUN_LONG_TESTS=true is set.

describeLong('github-sync long load simulations (gated)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  itLong('schedules many calls through throttler under simulated load', async () => {
    // This is intentionally small here; real load sims would create many
    // items and assert throttler behaviour and backoff. Keep it gated.
    const scheduleSpy = vi.spyOn(throttler, 'schedule');

    // Create many scheduled tasks (do not actually call network).
    const tasks: Array<Promise<any>> = [];
    for (let i = 0; i < 200; i += 1) {
      tasks.push(throttler.schedule(async () => ({ ok: true, i })));
    }

    const results = await Promise.all(tasks);
    expect(results.length).toBe(200);
    // Ensure scheduler was exercised.
    expect(scheduleSpy).toHaveBeenCalled();
  });
});
