/**
 * Tests for self-link guard in github-sync hierarchy linking.
 *
 * When a parent work item and its child both map to the same GitHub issue
 * number (data corruption), the hierarchy linking phase must skip that pair
 * instead of attempting to link the issue to itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the github module before importing github-sync
vi.mock('../src/github.js', () => ({
  normalizeGithubLabelPrefix: (p?: string) => p || 'wl:',
  workItemToIssuePayload: (_item: any, _comments: any[], _prefix: string, _all: any[]) => ({
    title: _item.title,
    body: '',
    labels: [],
    state: _item.status === 'deleted' ? 'closed' : 'open',
  }),
  updateGithubIssueAsync: vi.fn(async (_config: any, _num: number, _payload: any) => ({
    number: _num,
    id: `ID_${_num}`,
    updatedAt: new Date().toISOString(),
  })),
  createGithubIssueAsync: vi.fn(async (_config: any, _payload: any) => ({
    number: 999,
    id: 'ID_999',
    updatedAt: new Date().toISOString(),
  })),
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
  buildWorklogCommentMarker: vi.fn(),
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
import type { WorkItem } from '../src/types.js';

const baseTime = new Date('2025-01-01T00:00:00.000Z').toISOString();

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: overrides.id,
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: baseTime,
    updatedAt: baseTime,
    tags: [],
    assignee: '',
    stage: '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  } as WorkItem;
}

const dummyConfig = {
  owner: 'test',
  repo: 'test',
  token: 'test-token',
};

describe('github-sync self-link guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips hierarchy linking when parent and child share the same githubIssueNumber', async () => {
    const parent = makeItem({
      id: 'PARENT',
      githubIssueNumber: 675,
      githubIssueUpdatedAt: baseTime,
    });
    const child = makeItem({
      id: 'CHILD',
      parentId: 'PARENT',
      githubIssueNumber: 675,
      githubIssueUpdatedAt: baseTime,
    });

    const verboseMessages: string[] = [];
    const { result } = await upsertIssuesFromWorkItems(
      [parent, child],
      [],
      dummyConfig as any,
      undefined,
      (msg) => verboseMessages.push(msg),
    );

    // No self-link error should be reported
    const selfLinkErrors = result.errors.filter(e => e.includes('675->675'));
    expect(selfLinkErrors).toHaveLength(0);

    // Should have logged a verbose skip message
    const skipMessages = verboseMessages.filter(m => m.includes('skipping self-link'));
    expect(skipMessages.length).toBeGreaterThanOrEqual(1);
    expect(skipMessages[0]).toContain('CHILD');
    expect(skipMessages[0]).toContain('PARENT');
    expect(skipMessages[0]).toContain('675');

    // getIssueHierarchyAsync should NOT have been called (no valid pairs to check)
    const { getIssueHierarchyAsync } = await import('../src/github.js');
    expect(getIssueHierarchyAsync).not.toHaveBeenCalled();
  });

  it('still links hierarchy when parent and child have different githubIssueNumbers', async () => {
    const parent = makeItem({
      id: 'PARENT',
      githubIssueNumber: 100,
      githubIssueUpdatedAt: baseTime,
    });
    const child = makeItem({
      id: 'CHILD',
      parentId: 'PARENT',
      githubIssueNumber: 200,
      githubIssueUpdatedAt: baseTime,
    });

    const verboseMessages: string[] = [];
    const { result } = await upsertIssuesFromWorkItems(
      [parent, child],
      [],
      dummyConfig as any,
      undefined,
      (msg) => verboseMessages.push(msg),
    );

    // No self-link skip messages
    const skipMessages = verboseMessages.filter(m => m.includes('skipping self-link'));
    expect(skipMessages).toHaveLength(0);

    // getIssueHierarchyAsync should have been called for the parent
    const { getIssueHierarchyAsync } = await import('../src/github.js');
    expect(getIssueHierarchyAsync).toHaveBeenCalled();
  });
});
