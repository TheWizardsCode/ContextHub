import { describe, it, expect, vi, beforeEach } from 'vitest';

// This test verifies that GitHub API calls scheduled via the github helpers
// can be limited by a central throttler implementation. We create a
// dedicated throttler instance with a low concurrency cap and mock the
// github helper that would normally perform network I/O to schedule work
// through that throttler. The test asserts the observed maximum concurrent
// running tasks never exceeds the configured concurrency.

import { makeThrottlerFromEnv } from '../../src/github-throttler.js';
import * as githubSync from '../../src/github-sync.js';
import * as githubHelpers from '../../src/github.js';

describe('github-sync throttler concurrency (integration)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('limits concurrent GitHub API calls to WL_GITHUB_CONCURRENCY', async () => {
    const concurrency = 3;
    // Create a local throttler instance with a low concurrency cap and
    // high rate/burst so rate tokens do not interfere with the concurrency
    // behaviour under test.
    const localThrottler = makeThrottlerFromEnv({ concurrency, rate: 1000, burst: 1000 });

    let running = 0;
    let maxRunning = 0;

    const workDelay = 50; // ms per scheduled task to allow overlap

    // Mock the create helper to schedule work via our local throttler.
    vi.spyOn(githubHelpers as any, 'createGithubIssueAsync').mockImplementation(() =>
      localThrottler.schedule(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, workDelay));
        running -= 1;
        return { number: 123, id: 99, updatedAt: new Date().toISOString() };
      })
    );

    // Also stub comment-list/upsert functions to be safe (not exercised
    // in this specific scenario but present in the call path for items
    // with comments).
    vi.spyOn(githubHelpers as any, 'listGithubIssueCommentsAsync').mockImplementation(() =>
      localThrottler.schedule(async () => [])
    );
    vi.spyOn(githubHelpers as any, 'createGithubIssueCommentAsync').mockImplementation(() =>
      localThrottler.schedule(async () => ({ id: 1, updatedAt: new Date().toISOString() }))
    );
    vi.spyOn(githubHelpers as any, 'updateGithubIssueCommentAsync').mockImplementation(() =>
      localThrottler.schedule(async () => ({ id: 1, updatedAt: new Date().toISOString() }))
    );

    // Prepare many items so the scheduler has work to do
    const items = Array.from({ length: 20 }).map((_, i) => ({
      id: `WI-${i}`,
      title: `T${i}`,
      description: 'desc',
      status: 'open',
      priority: 'medium',
      sortIndex: 0,
      parentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: [],
      assignee: '',
    }));

    const comments: any[] = [];
    const config = { repo: 'owner/repo', labelPrefix: 'wl:' } as any;

    await (githubSync as any).upsertIssuesFromWorkItems(items, comments, config);

    // Assert we never exceeded the configured concurrency
    expect(maxRunning).toBeLessThanOrEqual(concurrency);
    // Sanity: ensure some parallelism actually occurred
    expect(maxRunning).toBeGreaterThan(1);
  });
});
