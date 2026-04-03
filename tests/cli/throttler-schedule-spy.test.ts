import { describe, it, expect, vi, beforeEach } from 'vitest';
import throttler from '../../src/github-throttler.js';
import * as githubSync from '../../src/github-sync.js';
import * as githubHelpers from '../../src/github.js';

describe('github-sync throttler schedule usage (unit)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules exactly once per external call in create+comment flow', async () => {
    const scheduleSpy = vi.spyOn(throttler, 'schedule');

    const now = new Date().toISOString();
    const items = [
      {
        id: 'WI-1',
        title: 'T1',
        description: 'desc',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: now,
        updatedAt: now,
        tags: [],
        assignee: '',
      },
    ];
    const comments: any[] = [
      {
        id: 'WL-C1',
        workItemId: 'WI-1',
        author: 'tester',
        comment: 'First comment',
        createdAt: now,
        references: [],
      },
    ];

    const createIssueSpy = vi.spyOn(githubHelpers as any, 'createGithubIssueAsync').mockImplementation(() =>
      throttler.schedule(async () => ({ number: 1, id: 1, updatedAt: new Date().toISOString() }))
    );
    const updateIssueSpy = vi.spyOn(githubHelpers as any, 'updateGithubIssueAsync').mockImplementation(() =>
      throttler.schedule(async () => ({ number: 1, id: 1, updatedAt: new Date().toISOString() }))
    );
    const listCommentsSpy = vi.spyOn(githubHelpers as any, 'listGithubIssueCommentsAsync').mockImplementation(() =>
      throttler.schedule(async () => [])
    );
    const createCommentSpy = vi.spyOn(githubHelpers as any, 'createGithubIssueCommentAsync').mockImplementation(() =>
      throttler.schedule(async () => ({ id: 1, updatedAt: new Date().toISOString() }))
    );
    const updateCommentSpy = vi.spyOn(githubHelpers as any, 'updateGithubIssueCommentAsync').mockImplementation(() =>
      throttler.schedule(async () => ({ id: 1, updatedAt: new Date().toISOString() }))
    );

    const config = { repo: 'owner/repo', labelPrefix: 'wl:' } as any;

    await (githubSync as any).upsertIssuesFromWorkItems(items, comments, config);

    // Flow should create issue, list existing comments, then create one comment.
    expect(createIssueSpy).toHaveBeenCalledTimes(1);
    expect(updateIssueSpy).not.toHaveBeenCalled();
    expect(listCommentsSpy).toHaveBeenCalledTimes(1);
    expect(createCommentSpy).toHaveBeenCalledTimes(1);
    expect(updateCommentSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalledTimes(3);
  });
});
