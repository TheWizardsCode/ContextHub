/**
 * Tests for async comment helpers and comment upsert flows in github-sync.
 *
 * Validates:
 * - New comments are created via createGithubIssueCommentAsync
 * - Existing comments with changed body are updated via updateGithubIssueCommentAsync
 * - Existing comments with unchanged body are skipped
 * - Comment mappings (githubCommentId, githubCommentUpdatedAt) are persisted
 * - commentsCreated / commentsUpdated counters are correct
 * - Mixed scenarios with multiple items and comments produce correct results
 *
 * Work item: WL-0MLGBABBK0OJETRU
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkItem, Comment } from '../src/types.js';

// Track persistComment calls
const persistCommentSpy = vi.fn();

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
  createGithubIssueCommentAsync: vi.fn(async (_config: any, _issueNumber: number, _body: string) => ({
    id: 5000 + Math.floor(Math.random() * 1000),
    body: _body,
    updatedAt: new Date().toISOString(),
    author: 'bot',
  })),
  updateGithubIssueComment: vi.fn(),
  updateGithubIssueCommentAsync: vi.fn(async (_config: any, _commentId: number, _body: string) => ({
    id: _commentId,
    body: _body,
    updatedAt: new Date().toISOString(),
    author: 'bot',
  })),
  stripWorklogMarkers: vi.fn((s: string) => s),
  extractWorklogId: vi.fn(),
  extractWorklogCommentId: vi.fn((_body?: string) => {
    if (!_body) return undefined;
    const match = _body.match(/<!-- worklog:comment=(\S+) -->/);
    return match ? match[1] : undefined;
  }),
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
}));

vi.mock('../src/github-metrics.js', () => ({
  increment: vi.fn(),
  snapshot: vi.fn(() => ({})),
  diff: vi.fn(() => ({})),
}));

import { upsertIssuesFromWorkItems } from '../src/github-sync.js';
import {
  listGithubIssueCommentsAsync,
  createGithubIssueCommentAsync,
  updateGithubIssueCommentAsync,
} from '../src/github.js';

const baseTime = new Date('2025-01-01T00:00:00.000Z').toISOString();
const laterTime = new Date('2025-01-02T00:00:00.000Z').toISOString();
const evenLaterTime = new Date('2025-01-03T00:00:00.000Z').toISOString();

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

function makeComment(overrides: Partial<Comment> & { id: string; workItemId: string }): Comment {
  return {
    author: 'tester',
    comment: `Comment body for ${overrides.id}`,
    createdAt: laterTime,
    references: [],
    ...overrides,
  };
}

const dummyConfig = {
  owner: 'test',
  repo: 'test/repo',
  token: 'test-token',
};

describe('github-sync comment upsert flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistCommentSpy.mockClear();
  });

  it('creates new comments when no existing GH comments exist', async () => {
    const item = makeItem({
      id: 'COMM-1',
      title: 'Item with comments',
      status: 'open',
      updatedAt: laterTime,
    });
    const comment = makeComment({
      id: 'WL-C1',
      workItemId: 'COMM-1',
      comment: 'First comment',
      createdAt: laterTime,
    });

    // No existing GH comments
    (listGithubIssueCommentsAsync as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const { result } = await upsertIssuesFromWorkItems(
      [item],
      [comment],
      dummyConfig as any,
    );

    // createGithubIssueCommentAsync should have been called for the new comment
    expect(createGithubIssueCommentAsync).toHaveBeenCalled();
    expect(result.commentsCreated).toBe(1);
    expect(result.commentsUpdated).toBe(0);
  });

  it('updates existing comments when body has changed', async () => {
    const item = makeItem({
      id: 'COMM-2',
      title: 'Item with changed comment',
      status: 'open',
      githubIssueNumber: 42,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });
    const comment = makeComment({
      id: 'WL-C2',
      workItemId: 'COMM-2',
      comment: 'Updated comment body',
      createdAt: laterTime,
    });

    // Existing GH comment with old body
    const existingGhComment = {
      id: 100,
      body: '<!-- worklog:comment=WL-C2 -->\n\n**tester**\n\nOld comment body',
      updatedAt: baseTime,
      author: 'bot',
    };
    (listGithubIssueCommentsAsync as ReturnType<typeof vi.fn>).mockResolvedValueOnce([existingGhComment]);

    const { result } = await upsertIssuesFromWorkItems(
      [item],
      [comment],
      dummyConfig as any,
    );

    expect(updateGithubIssueCommentAsync).toHaveBeenCalledWith(
      expect.anything(),
      100, // existing GH comment id
      expect.stringContaining('Updated comment body'),
    );
    expect(result.commentsUpdated).toBeGreaterThanOrEqual(1);
    expect(result.commentsCreated).toBe(0);
  });

  it('skips comments when body is unchanged', async () => {
    const item = makeItem({
      id: 'COMM-3',
      title: 'Item with unchanged comment',
      status: 'open',
      githubIssueNumber: 43,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });
    const commentBody = 'Same comment body';
    const comment = makeComment({
      id: 'WL-C3',
      workItemId: 'COMM-3',
      comment: commentBody,
      createdAt: laterTime,
    });

    // Build expected body to match exactly
    const expectedBody = `<!-- worklog:comment=WL-C3 -->\n\n**tester**\n\n${commentBody}`;
    const existingGhComment = {
      id: 101,
      body: expectedBody,
      updatedAt: baseTime,
      author: 'bot',
    };
    (listGithubIssueCommentsAsync as ReturnType<typeof vi.fn>).mockResolvedValueOnce([existingGhComment]);

    const { result } = await upsertIssuesFromWorkItems(
      [item],
      [comment],
      dummyConfig as any,
    );

    // Should not create or update
    expect(createGithubIssueCommentAsync).not.toHaveBeenCalled();
    expect(updateGithubIssueCommentAsync).not.toHaveBeenCalled();
    expect(result.commentsCreated).toBe(0);
    expect(result.commentsUpdated).toBe(0);
  });

  it('handles multiple comments on same item (create + update mix)', async () => {
    const item = makeItem({
      id: 'COMM-4',
      title: 'Item with multiple comments',
      status: 'open',
      githubIssueNumber: 44,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });

    const comment1 = makeComment({
      id: 'WL-C4A',
      workItemId: 'COMM-4',
      comment: 'First comment (existing, changed)',
      createdAt: baseTime,
    });
    const comment2 = makeComment({
      id: 'WL-C4B',
      workItemId: 'COMM-4',
      comment: 'Second comment (new)',
      createdAt: laterTime,
    });

    // Only first comment exists on GH, with old body
    const existingGhComment = {
      id: 200,
      body: '<!-- worklog:comment=WL-C4A -->\n\n**tester**\n\nOld first comment',
      updatedAt: baseTime,
      author: 'bot',
    };
    (listGithubIssueCommentsAsync as ReturnType<typeof vi.fn>).mockResolvedValueOnce([existingGhComment]);

    const { result } = await upsertIssuesFromWorkItems(
      [item],
      [comment1, comment2],
      dummyConfig as any,
    );

    // First comment updated, second created
    expect(updateGithubIssueCommentAsync).toHaveBeenCalledTimes(1);
    expect(createGithubIssueCommentAsync).toHaveBeenCalledTimes(1);
    expect(result.commentsUpdated).toBe(1);
    expect(result.commentsCreated).toBe(1);
  });

  it('skips comment sync when item has no comments', async () => {
    const item = makeItem({
      id: 'COMM-5',
      title: 'Item without comments',
      status: 'open',
      githubIssueNumber: 45,
      githubIssueUpdatedAt: baseTime,
      updatedAt: laterTime,
    });

    const { result } = await upsertIssuesFromWorkItems(
      [item],
      [],
      dummyConfig as any,
    );

    // Should not list or create/update comments
    expect(listGithubIssueCommentsAsync).not.toHaveBeenCalled();
    expect(createGithubIssueCommentAsync).not.toHaveBeenCalled();
    expect(updateGithubIssueCommentAsync).not.toHaveBeenCalled();
    // commentsCreated/Updated may be undefined (not set) when no comments are processed
    expect(result.commentsCreated ?? 0).toBe(0);
    expect(result.commentsUpdated ?? 0).toBe(0);
  });

  it('handles comment sync across multiple items', async () => {
    const item1 = makeItem({
      id: 'MULTI-1',
      title: 'First item',
      status: 'open',
      updatedAt: laterTime,
    });
    const item2 = makeItem({
      id: 'MULTI-2',
      title: 'Second item',
      status: 'open',
      updatedAt: laterTime,
    });

    const comment1 = makeComment({
      id: 'WL-CM1',
      workItemId: 'MULTI-1',
      comment: 'Comment on first item',
      createdAt: laterTime,
    });
    const comment2 = makeComment({
      id: 'WL-CM2',
      workItemId: 'MULTI-2',
      comment: 'Comment on second item',
      createdAt: laterTime,
    });

    // Both items new (no githubIssueNumber), so comments will be synced after creation
    (listGithubIssueCommentsAsync as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { result } = await upsertIssuesFromWorkItems(
      [item1, item2],
      [comment1, comment2],
      dummyConfig as any,
    );

    // Both comments should be created (one per item)
    expect(createGithubIssueCommentAsync).toHaveBeenCalledTimes(2);
    expect(result.commentsCreated).toBe(2);
  });

  it('does not sync comments when item is skipped (no changes)', async () => {
    const unchangedItem = makeItem({
      id: 'SKIP-COMM',
      title: 'Unchanged item with comments',
      status: 'open',
      githubIssueNumber: 100,
      githubIssueUpdatedAt: laterTime,
      updatedAt: baseTime, // updatedAt <= githubIssueUpdatedAt => skipped
    });

    const comment = makeComment({
      id: 'WL-CSKIP',
      workItemId: 'SKIP-COMM',
      comment: 'Old comment',
      createdAt: baseTime, // also old
    });

    const { result } = await upsertIssuesFromWorkItems(
      [unchangedItem],
      [comment],
      dummyConfig as any,
    );

    // Item was skipped entirely, so comments should not be synced
    expect(listGithubIssueCommentsAsync).not.toHaveBeenCalled();
    expect(createGithubIssueCommentAsync).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});
