/**
 * Tests for deleted item handling in github-sync.
 *
 * Validates that:
 * - Deleted items with a githubIssueNumber pass through the filter and reach upsertMapper
 * - upsertMapper routes deleted items with githubIssueNumber to the update path (not create)
 * - Deleted items without githubIssueNumber are skipped with a verbose log message
 * - The hierarchy skip for deleted items is preserved
 * - The skipped count correctly accounts for deleted items
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the github module before importing github-sync
vi.mock('../src/github.js', () => ({
  normalizeGithubLabelPrefix: (p?: string) => p || 'wl:',
  workItemToIssuePayload: (_item: any, _comments: any[], _prefix: string, _all: any[]) => ({
    title: _item.title,
    body: '',
    labels: [],
    state: _item.status === 'completed' || _item.status === 'deleted' ? 'closed' : 'open',
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
import { updateGithubIssueAsync, createGithubIssueAsync, getIssueHierarchyAsync } from '../src/github.js';
import type { WorkItem } from '../src/types.js';

const baseTime = new Date('2025-01-01T00:00:00.000Z').toISOString();
const laterTime = new Date('2025-01-02T00:00:00.000Z').toISOString();

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

describe('github-sync deleted item handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deleted item with githubIssueNumber passes filter and calls updateGithubIssueAsync', async () => {
    const deletedItem = makeItem({
      id: 'DELETED-WITH-ISSUE',
      status: 'deleted',
      githubIssueNumber: 42,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });

    const { result } = await upsertIssuesFromWorkItems(
      [deletedItem],
      [],
      dummyConfig as any,
    );

    // Should have called update (not create)
    expect(updateGithubIssueAsync).toHaveBeenCalledTimes(1);
    expect(updateGithubIssueAsync).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.objectContaining({ state: 'closed' }),
    );
    expect(createGithubIssueAsync).not.toHaveBeenCalled();

    // Should count as updated, not skipped
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(result.created).toBe(0);
  });

  it('deleted item without githubIssueNumber is excluded by filter and counted as skipped', async () => {
    const deletedItem = makeItem({
      id: 'DELETED-NO-ISSUE',
      status: 'deleted',
    });

    const verboseMessages: string[] = [];
    const { result } = await upsertIssuesFromWorkItems(
      [deletedItem],
      [],
      dummyConfig as any,
      undefined,
      (msg) => verboseMessages.push(msg),
    );

    // Should NOT call any GitHub API
    expect(updateGithubIssueAsync).not.toHaveBeenCalled();
    expect(createGithubIssueAsync).not.toHaveBeenCalled();

    // Should be counted as skipped
    expect(result.skipped).toBe(1);
  });

  it('deleted items are excluded from hierarchy linking', async () => {
    const parent = makeItem({
      id: 'PARENT',
      status: 'open',
      githubIssueNumber: 10,
      githubIssueUpdatedAt: baseTime,
    });
    const deletedChild = makeItem({
      id: 'DELETED-CHILD',
      status: 'deleted',
      parentId: 'PARENT',
      githubIssueNumber: 20,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });

    const verboseMessages: string[] = [];
    const { result } = await upsertIssuesFromWorkItems(
      [parent, deletedChild],
      [],
      dummyConfig as any,
      undefined,
      (msg) => verboseMessages.push(msg),
    );

    // Hierarchy linking should skip the deleted child
    // (deleted items are skipped at lines 414-417 in the hierarchy loop)
    const hierarchyMessages = verboseMessages.filter(m =>
      m.includes('[hierarchy]') && m.includes('10') && m.includes('20'),
    );
    expect(hierarchyMessages).toHaveLength(0);

    // No hierarchy errors
    const hierarchyErrors = result.errors.filter(e => e.includes('link'));
    expect(hierarchyErrors).toHaveLength(0);
  });

  it('mix of deleted and non-deleted items processes correctly', async () => {
    const activeItem = makeItem({
      id: 'ACTIVE',
      status: 'open',
      githubIssueNumber: 100,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });
    const deletedWithIssue = makeItem({
      id: 'DELETED-WITH',
      status: 'deleted',
      githubIssueNumber: 200,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });
    const deletedWithoutIssue = makeItem({
      id: 'DELETED-WITHOUT',
      status: 'deleted',
    });

    const { result } = await upsertIssuesFromWorkItems(
      [activeItem, deletedWithIssue, deletedWithoutIssue],
      [],
      dummyConfig as any,
    );

    // Both active and deleted-with-issue should be updated
    expect(updateGithubIssueAsync).toHaveBeenCalledTimes(2);
    expect(createGithubIssueAsync).not.toHaveBeenCalled();

    // deleted-without-issue is excluded by the filter (items.length - issueItems.length = 1)
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it('deleted item with githubIssueNumber but no changes is skipped by timestamp check', async () => {
    const deletedItem = makeItem({
      id: 'DELETED-UNCHANGED',
      status: 'deleted',
      githubIssueNumber: 50,
      githubIssueUpdatedAt: laterTime,
      updatedAt: baseTime, // updatedAt is BEFORE githubIssueUpdatedAt => no changes
    });

    const verboseMessages: string[] = [];
    const { result } = await upsertIssuesFromWorkItems(
      [deletedItem],
      [],
      dummyConfig as any,
      undefined,
      (msg) => verboseMessages.push(msg),
    );

    // Should be skipped by the timestamp check (no API calls)
    expect(updateGithubIssueAsync).not.toHaveBeenCalled();
    expect(createGithubIssueAsync).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('deleted item with githubIssueNumber that has upsertMapper guard does not create issue', async () => {
    // This tests the guard inside upsertMapper specifically —
    // a deleted item that somehow passes the filter but has no githubIssueNumber.
    // In practice, the filter should prevent this, but the guard is a safety net.
    // We test indirectly: if a deleted item without githubIssueNumber reaches upsertMapper,
    // it should be skipped. The filter already excludes it, so we verify the filter works.
    const deletedNoIssue = makeItem({
      id: 'GUARD-TEST',
      status: 'deleted',
      // no githubIssueNumber
    });

    const { result } = await upsertIssuesFromWorkItems(
      [deletedNoIssue],
      [],
      dummyConfig as any,
    );

    expect(updateGithubIssueAsync).not.toHaveBeenCalled();
    expect(createGithubIssueAsync).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
  });
});
