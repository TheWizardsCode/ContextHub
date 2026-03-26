import { describe, it, expect, vi, beforeEach } from 'vitest';
import throttler from '../../src/github-throttler.js';
import * as githubSync from '../../src/github-sync.js';

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

    // Stub out github API helpers so the call flows but perform no network
    vi.spyOn(githubSync as any, 'createGithubIssueAsync').mockImplementation(async () => ({ number: 123, id: 99, updatedAt: new Date().toISOString() }));
    vi.spyOn(githubSync as any, 'updateGithubIssueAsync').mockImplementation(async () => ({ number: 123, id: 99, updatedAt: new Date().toISOString() }));
    vi.spyOn(githubSync as any, 'listGithubIssueCommentsAsync').mockImplementation(async () => []);
    vi.spyOn(githubSync as any, 'createGithubIssueCommentAsync').mockImplementation(async () => ({ id: 1, updatedAt: new Date().toISOString() }));
    vi.spyOn(githubSync as any, 'updateGithubIssueCommentAsync').mockImplementation(async () => ({ id: 1, updatedAt: new Date().toISOString() }));

    const config = { repo: 'owner/repo', labelPrefix: 'wl:' } as any;

    await githubSync.upsertIssuesFromWorkItems(items as any, comments as any, config);

    // Assert that throttle.schedule was used at least once (multiple callsites exist)
    expect(scheduleSpy).toHaveBeenCalled();
  });
});
