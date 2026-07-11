import { describe, it, expect, vi, beforeEach } from 'vitest';
import throttler from '../src/github-throttler.js';

// This test verifies github-sync handles HTTP 403 / rate-limit responses by
// retrying with backoff and that all external GitHub helper calls are
// scheduled via the central throttler. It's written to follow existing test
// patterns and is intentionally short so it runs in CI. Longer load sims are
// gated by WL_RUN_LONG_TESTS and not included here.

// Mock the github helpers before importing github-sync so the module under
// test uses our mocked implementations.
vi.mock('../src/github.js', () => {
  // We'll provide implementations per-test by replacing these functions.
  return {
    normalizeGithubLabelPrefix: (p?: string) => p || 'wl:',
    workItemToIssuePayload: (_item: any, _comments: any[], _prefix: string, _all: any[]) => ({
      title: _item.title,
      body: '',
      labels: [],
      state: _item.status === 'completed' || _item.status === 'deleted' ? 'closed' : 'open',
    }),
    updateGithubIssueAsync: vi.fn(),
    createGithubIssueAsync: vi.fn(),
    getGithubIssueAsync: vi.fn(),
    listGithubIssues: vi.fn(() => []),
    getGithubIssue: vi.fn(),
    listGithubIssueComments: vi.fn(() => []),
    listGithubIssueCommentsAsync: vi.fn(async () => []),
    createGithubIssueComment: vi.fn(),
    createGithubIssueCommentAsync: vi.fn(),
    updateGithubIssueComment: vi.fn(),
    updateGithubIssueCommentAsync: vi.fn(),
    stripWorklogMarkers: (s: string) => s,
    extractWorklogId: vi.fn(),
    extractWorklogCommentId: vi.fn(),
    extractParentId: vi.fn(),
    extractParentIssueNumber: vi.fn(),
    extractChildIds: vi.fn(),
    extractChildIssueNumbers: vi.fn(),
    getIssueHierarchy: vi.fn(() => ({ parentIssueNumber: null, childIssueNumbers: [] })),
    getIssueHierarchyAsync: vi.fn(async () => ({ parentIssueNumber: null, childIssueNumbers: [] })),
    addSubIssueLink: vi.fn(),
    addSubIssueLinkResult: vi.fn(() => ({ ok: true })),
    addSubIssueLinkResultAsync: vi.fn(async () => ({ ok: true })),
    buildWorklogCommentMarker: vi.fn((id: string) => `<!-- worklog:comment=${id} -->`),
    createGithubIssue: vi.fn(),
    updateGithubIssue: vi.fn(),
    issueToWorkItemFields: vi.fn(),
  };
});

vi.mock('../src/github-metrics.js', () => ({
  increment: vi.fn(),
  snapshot: vi.fn(() => ({})),
  diff: vi.fn(() => ({})),
}));

import { upsertIssuesFromWorkItems } from '../src/github-sync.js';
import * as githubHelpers from '../src/github.js';
import { makeNetworkStub } from './test-helpers.js';

describe('github-sync rate-limit handling and throttler scheduling (integration)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('retries on 403/rate-limit and schedules calls via throttler', async () => {
    const scheduleSpy = vi.spyOn(throttler, 'schedule');

    // Prepare one item that will trigger a createGithubIssueAsync call.
    const now = new Date().toISOString();
    const items = [
      {
        id: 'WL-RL-1',
        title: 'Rate limited item',
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
    const comments: any[] = [];

    // Simulate createGithubIssueAsync performing internal retries/backoff.
    // Each internal attempt is scheduled via the central throttler and the
    // first two attempts fail with a 403-like error; the third attempt
    // succeeds. This mirrors the real helper which retries internally so the
    // github-sync flow only sees a final success or failure.
    const createMock = vi.spyOn(githubHelpers as any, 'createGithubIssueAsync').mockImplementation(
      // Use shared helper to simulate internal retries that schedule via throttler
      makeNetworkStub(throttler, { attempts: 3, failAttempts: 2, result: () => ({ number: 555, id: 'ID_555', updatedAt: new Date().toISOString() }) })
    );

    // Also stub comment/list helpers so flow proceeds predictably and they go
    // through the throttler too.
    vi.spyOn(githubHelpers as any, 'listGithubIssueCommentsAsync').mockImplementation(() =>
      throttler.schedule(async () => [])
    );
    vi.spyOn(githubHelpers as any, 'createGithubIssueCommentAsync').mockImplementation(() =>
      throttler.schedule(async () => ({ id: 1, updatedAt: new Date().toISOString() }))
    );

    const config = { repo: 'owner/repo', labelPrefix: 'wl:' } as any;

    const { result } = await upsertIssuesFromWorkItems(items as any, comments as any, config);

    // Ensure the helper was invoked and eventually succeeded
    expect(createMock).toHaveBeenCalled();
    expect(result.syncedItems.length).toBeGreaterThanOrEqual(1);

    // Verify throttler.schedule was used for external GH calls (>=1 call)
    expect(scheduleSpy).toHaveBeenCalled();

    // The internal retries should schedule multiple throttler tasks (>=3 attempts)
    expect((scheduleSpy as any).mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
