import { describe, it, expect, vi, beforeEach } from 'vitest';
import throttler from '../../src/github-throttler.js';
import * as githubSync from '../../src/github-sync.js';
import * as githubHelpers from '../../src/github.js';

describe('github-sync throttler schedule usage (unit)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls throttler.schedule for GitHub API helpers', async () => {
    const scheduleSpy = vi.spyOn(throttler, 'schedule');

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
    const comments: any[] = [];

    // Stubs should schedule through the central throttler
    vi.spyOn(githubHelpers as any, 'createGithubIssueAsync').mockImplementation(() =>
      throttler.schedule(async () => ({ number: 1, id: 1, updatedAt: new Date().toISOString() }))
    );
    vi.spyOn(githubHelpers as any, 'updateGithubIssueAsync').mockImplementation(() =>
      throttler.schedule(async () => ({ number: 1, id: 1, updatedAt: new Date().toISOString() }))
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

    await (githubSync as any).upsertIssuesFromWorkItems(items, comments, config);

    expect(scheduleSpy).toHaveBeenCalled();
  });
});
