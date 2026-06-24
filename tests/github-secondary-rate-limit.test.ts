import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as github from '../src/github.js';
import throttler from '../src/github-throttler.js';

describe('fetchLabelEventsAsync handles SecondaryRateLimitError', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array when underlying API call throws SecondaryRateLimitError', async () => {
    // Mock throttler.schedule to throw a SecondaryRateLimitError to simulate
    // GitHub reporting a secondary rate limit / abuse detection response.
    vi.spyOn(throttler as any, 'schedule').mockImplementation(async (fn: any) => {
      throw new github.SecondaryRateLimitError('secondary rate limit simulated', { stdout: '', stderr: 'secondary rate limit detected' });
    });

    const cache = new github.LabelEventCache();
    const config = { repo: 'owner/repo', labelPrefix: 'wl:' } as any;
    const events = await github.fetchLabelEventsAsync(config, 12345, cache);

    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBe(0);
    // Ensure the result was cached to avoid repeated failing calls during the same run
    expect(cache.has(12345)).toBe(true);
  });
});
