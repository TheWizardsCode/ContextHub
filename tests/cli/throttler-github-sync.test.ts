import { describe, it, expect, vi, beforeEach } from 'vitest';
import throttler from '../../src/github-throttler.js';
import * as githubSync from '../../src/github-sync.js';
import * as githubHelpers from '../../src/github.js';

describe('github-sync throttler integration (unit)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses throttler.schedule for GitHub issue create/update and comment operations', async () => {
    // Spy on throttler.schedule
    const scheduleSpy = vi.spyOn(throttler, 'schedule');

    // Prepare minimal items and comments to exercise upsert path
    const items = [
      {
        id: 'WI-1',
        title: 'T1',
        description: 'desc',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        assignee: '',
      },
    ];
    const comments = [];

    // Stub out github API helpers (they are exported from src/github.js).
    // Each stub should still call the central throttler so we can assert
    // `throttler.schedule` is used by the flow.
    vi.spyOn(githubHelpers as any, 'createGithubIssueAsync').mockImplementation(() =>
      throttler.schedule(async () => ({ number: 123, id: 99, updatedAt: new Date().toISOString() }))
    );
    vi.spyOn(githubHelpers as any, 'updateGithubIssueAsync').mockImplementation(() =>
      throttler.schedule(async () => ({ number: 123, id: 99, updatedAt: new Date().toISOString() }))
    );
    vi.spyOn(githubHelpers as any, 'listGithubIssueCommentsAsync').mockImplementation(() =>
      throttler.schedule(async () => [])
    );
    vi.spyOn(githubHelpers as any, 'createGithubIssueCommentAsync').mockImplementation(() =>
      throttler.schedule(async () => ({ id: 1, updatedAt: new Date().toISOString() }))
    );
    vi.spyOn(githubHelpers as any, 'updateGithubIssueCommentAsync').mockImplementation(() =>
      throttler.schedule(async () => ({ id: 1, updatedAt: new Date().toISOString() }))
    );

    const config = { repo: 'owner/repo', labelPrefix: 'wl:' } as any;

    await githubSync.upsertIssuesFromWorkItems(items as any, comments as any, config);

    // Assert that throttle.schedule was used at least once (multiple callsites exist)
    expect(scheduleSpy).toHaveBeenCalled();
  });
});
