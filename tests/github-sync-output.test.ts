/**
 * Tests for per-item sync output (syncedItems / errorItems) in github-sync.
 *
 * Validates that:
 * - syncedItems collects created, updated, and closed items with correct action, id, title, issueNumber
 * - Titles longer than 60 characters are truncated with an ellipsis
 * - Skipped items are NOT included in syncedItems
 * - Errored items are collected in errorItems with id, title, and error message
 * - A mixed set produces the correct syncedItems and errorItems arrays
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
import { updateGithubIssueAsync, createGithubIssueAsync } from '../src/github.js';
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
  repo: 'test/repo',
  token: 'test-token',
};

describe('github-sync per-item sync output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('created item appears in syncedItems with action "created"', async () => {
    const newItem = makeItem({
      id: 'NEW-1',
      title: 'A brand new item',
      status: 'open',
      updatedAt: laterTime,
    });

    const { result } = await upsertIssuesFromWorkItems(
      [newItem],
      [],
      dummyConfig as any,
    );

    expect(result.syncedItems).toHaveLength(1);
    expect(result.syncedItems[0]).toEqual({
      action: 'created',
      id: 'NEW-1',
      title: 'A brand new item',
      issueNumber: 999,
    });
  });

  it('updated item appears in syncedItems with action "updated"', async () => {
    const updatedItem = makeItem({
      id: 'UPD-1',
      title: 'Updated work item',
      status: 'open',
      githubIssueNumber: 42,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });

    const { result } = await upsertIssuesFromWorkItems(
      [updatedItem],
      [],
      dummyConfig as any,
    );

    expect(result.syncedItems).toHaveLength(1);
    expect(result.syncedItems[0]).toEqual({
      action: 'updated',
      id: 'UPD-1',
      title: 'Updated work item',
      issueNumber: 42,
    });
  });

  it('closed (deleted) item appears in syncedItems with action "closed"', async () => {
    const deletedItem = makeItem({
      id: 'DEL-1',
      title: 'Deleted item to close',
      status: 'deleted',
      githubIssueNumber: 77,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });

    const { result } = await upsertIssuesFromWorkItems(
      [deletedItem],
      [],
      dummyConfig as any,
    );

    expect(result.syncedItems).toHaveLength(1);
    expect(result.syncedItems[0]).toEqual({
      action: 'closed',
      id: 'DEL-1',
      title: 'Deleted item to close',
      issueNumber: 77,
    });
  });

  it('skipped items are NOT included in syncedItems', async () => {
    const unchangedItem = makeItem({
      id: 'SKIP-1',
      title: 'Unchanged item',
      status: 'open',
      githubIssueNumber: 100,
      githubIssueUpdatedAt: laterTime,
      updatedAt: baseTime, // updatedAt <= githubIssueUpdatedAt => skipped
    });

    const { result } = await upsertIssuesFromWorkItems(
      [unchangedItem],
      [],
      dummyConfig as any,
    );

    expect(result.syncedItems).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('truncates titles longer than 60 characters', async () => {
    const longTitle = 'A'.repeat(80);
    const item = makeItem({
      id: 'LONG-TITLE',
      title: longTitle,
      status: 'open',
      updatedAt: laterTime,
    });

    const { result } = await upsertIssuesFromWorkItems(
      [item],
      [],
      dummyConfig as any,
    );

    expect(result.syncedItems).toHaveLength(1);
    expect(result.syncedItems[0].title.length).toBe(60);
    expect(result.syncedItems[0].title).toBe('A'.repeat(59) + '\u2026');
  });

  it('does not truncate titles of exactly 60 characters', async () => {
    const title60 = 'B'.repeat(60);
    const item = makeItem({
      id: 'EXACT-60',
      title: title60,
      status: 'open',
      updatedAt: laterTime,
    });

    const { result } = await upsertIssuesFromWorkItems(
      [item],
      [],
      dummyConfig as any,
    );

    expect(result.syncedItems).toHaveLength(1);
    expect(result.syncedItems[0].title).toBe(title60);
  });

  it('errored items appear in errorItems with id, title, and error message', async () => {
    const errorMsg = 'API rate limit exceeded';
    (updateGithubIssueAsync as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(errorMsg));

    const item = makeItem({
      id: 'ERR-1',
      title: 'Item that errors',
      status: 'open',
      githubIssueNumber: 55,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });

    const { result } = await upsertIssuesFromWorkItems(
      [item],
      [],
      dummyConfig as any,
    );

    expect(result.syncedItems).toHaveLength(0);
    expect(result.errorItems).toHaveLength(1);
    expect(result.errorItems[0]).toEqual({
      id: 'ERR-1',
      title: 'Item that errors',
      error: errorMsg,
    });
    expect(result.errors).toContain('ERR-1: API rate limit exceeded');
  });

  it('mixed set produces correct syncedItems and errorItems', async () => {
    const newItem = makeItem({
      id: 'MIX-NEW',
      title: 'New item',
      status: 'open',
      updatedAt: laterTime,
    });
    const updatedItem = makeItem({
      id: 'MIX-UPD',
      title: 'Updated item',
      status: 'open',
      githubIssueNumber: 200,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });
    const closedItem = makeItem({
      id: 'MIX-DEL',
      title: 'Closed item',
      status: 'deleted',
      githubIssueNumber: 201,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });
    const skippedItem = makeItem({
      id: 'MIX-SKIP',
      title: 'Skipped item',
      status: 'open',
      githubIssueNumber: 202,
      githubIssueUpdatedAt: laterTime,
      updatedAt: baseTime,
    });
    const errorItem = makeItem({
      id: 'MIX-ERR',
      title: 'Error item',
      status: 'open',
      githubIssueNumber: 203,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });

    // Make the error item fail
    (updateGithubIssueAsync as ReturnType<typeof vi.fn>).mockImplementation(
      async (_config: any, num: number, _payload: any) => {
        if (num === 203) {
          throw new Error('Server error');
        }
        return {
          number: num,
          id: `ID_${num}`,
          updatedAt: new Date().toISOString(),
        };
      },
    );

    const { result } = await upsertIssuesFromWorkItems(
      [newItem, updatedItem, closedItem, skippedItem, errorItem],
      [],
      dummyConfig as any,
    );

    // Synced items: new (created), updated (updated), closed (closed)
    expect(result.syncedItems).toHaveLength(3);
    const actions = result.syncedItems.map(si => si.action);
    expect(actions).toContain('created');
    expect(actions).toContain('updated');
    expect(actions).toContain('closed');

    // Verify individual entries
    const created = result.syncedItems.find(si => si.action === 'created');
    expect(created).toEqual({
      action: 'created',
      id: 'MIX-NEW',
      title: 'New item',
      issueNumber: 999,
    });

    const updated = result.syncedItems.find(si => si.action === 'updated');
    expect(updated).toEqual({
      action: 'updated',
      id: 'MIX-UPD',
      title: 'Updated item',
      issueNumber: 200,
    });

    const closed = result.syncedItems.find(si => si.action === 'closed');
    expect(closed).toEqual({
      action: 'closed',
      id: 'MIX-DEL',
      title: 'Closed item',
      issueNumber: 201,
    });

    // Error items
    expect(result.errorItems).toHaveLength(1);
    expect(result.errorItems[0]).toEqual({
      id: 'MIX-ERR',
      title: 'Error item',
      error: 'Server error',
    });

    // Skipped should NOT appear in either
    const allIds = [...result.syncedItems.map(si => si.id), ...result.errorItems.map(ei => ei.id)];
    expect(allIds).not.toContain('MIX-SKIP');
  });

  it('deleted item without githubIssueNumber does not appear in syncedItems', async () => {
    const deletedNoIssue = makeItem({
      id: 'DEL-NO-ISSUE',
      title: 'Deleted without issue number',
      status: 'deleted',
    });

    const { result } = await upsertIssuesFromWorkItems(
      [deletedNoIssue],
      [],
      dummyConfig as any,
    );

    expect(result.syncedItems).toHaveLength(0);
    expect(result.errorItems).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });
});
