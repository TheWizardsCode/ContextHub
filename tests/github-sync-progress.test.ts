import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkItem } from '../src/types.js';

vi.mock('../src/github.js', () => ({
  normalizeGithubLabelPrefix: (p?: string) => p || 'wl:',
  workItemToIssuePayload: (item: any) => ({
    title: item.title,
    body: '',
    labels: [],
    state: item.status === 'completed' || item.status === 'deleted' ? 'closed' : 'open',
  }),
  updateGithubIssueAsync: vi.fn(async (_config: any, issueNumber: number) => {
    const delayMs = issueNumber === 1 ? 80 : 40;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return {
      number: issueNumber,
      id: `ID_${issueNumber}`,
      title: `Issue ${issueNumber}`,
      body: '',
      state: 'open',
      labels: [],
      updatedAt: new Date().toISOString(),
    };
  }),
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
  stripWorklogMarkers: vi.fn((s: string) => s),
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
  buildWorklogCommentMarker: vi.fn(() => '<!--wl-comment:TEST-->'),
  createGithubIssue: vi.fn(),
  updateGithubIssue: vi.fn(),
  issueToWorkItemFields: vi.fn(),
}));

vi.mock('../src/github-metrics.js', () => ({
  increment: vi.fn(),
  snapshot: vi.fn(() => ({})),
  diff: vi.fn(() => ({})),
}));

import { upsertIssuesFromWorkItems } from '../src/github-sync.js';

const baseTime = new Date('2025-01-01T00:00:00.000Z').toISOString();

function makeItem(id: string, issueNumber: number): WorkItem {
  return {
    id,
    title: id,
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: baseTime,
    updatedAt: new Date('2025-01-02T00:00:00.000Z').toISOString(),
    tags: [],
    assignee: '',
    stage: '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    githubIssueNumber: issueNumber,
    githubIssueId: issueNumber,
    githubIssueUpdatedAt: baseTime,
  };
}

describe('github-sync push progress timing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits push progress as items complete (not immediately on task start)', async () => {
    const items = [makeItem('WL-A', 1), makeItem('WL-B', 2)];
    const start = Date.now();
    const pushEvents: Array<{ current: number; total: number; elapsedMs: number }> = [];

    await upsertIssuesFromWorkItems(
      items,
      [],
      { owner: 'test', repo: 'owner/name', token: 't' } as any,
      (ev) => {
        if (ev.phase === 'push') {
          pushEvents.push({
            current: ev.current,
            total: ev.total,
            elapsedMs: Date.now() - start,
          });
        }
      },
    );

    expect(pushEvents.length).toBeGreaterThanOrEqual(2);
    expect(pushEvents[0].elapsedMs).toBeGreaterThanOrEqual(30);
    const last = pushEvents[pushEvents.length - 1];
    expect(last.current).toBe(2);
    expect(last.total).toBe(2);
  });
});
