/**
 * Tests for GitHub comment import (GitHub -> Worklog) and push (Worklog -> GitHub).
 *
 * Validates:
 * - Comments on GitHub issues are imported into Worklog as Comment objects
 *   when running `importIssuesToWorkItems()`
 * - Worklog-originated comments (with worklog markers) are not duplicated on import
 * - Locally created comments are pushed to GitHub via `upsertIssuesFromWorkItems()`
 *   and appear as GitHub issue comments
 *
 * Bug: WL-0MM3WJQL90GKUQ62
 * Child tasks: WL-0MM3WK5LQ0YOAM0V (import test), WL-0MM3WKC130ER65EM (push test)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkItem, Comment, WorkItemStatus, WorkItemPriority } from '../src/types.js';
import type { GithubConfig, GithubIssueComment } from '../src/github.js';

// ── Hoist mock references for partial mock (import tests) ────────────────

const {
  mockListGithubIssues,
  mockListGithubIssueCommentsAsync,
  mockFetchLabelEventsAsync,
} = vi.hoisted(() => ({
  mockListGithubIssues: vi.fn(),
  mockListGithubIssueCommentsAsync: vi.fn(),
  mockFetchLabelEventsAsync: vi.fn(),
}));

// ── Mock ../src/github.js with partial real implementations ──────────────

vi.mock('../src/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/github.js')>();
  return {
    ...actual,
    // Override only the functions that make real API calls
    listGithubIssues: mockListGithubIssues,
    listGithubIssueCommentsAsync: mockListGithubIssueCommentsAsync,
    getGithubIssue: vi.fn(() => { throw new Error('not found'); }),
    getIssueHierarchy: vi.fn(() => ({ parentIssueNumber: null, childIssueNumbers: [] })),
    getIssueHierarchyAsync: vi.fn(async () => ({ parentIssueNumber: null, childIssueNumbers: [] })),
    createGithubIssue: vi.fn(),
    createGithubIssueAsync: vi.fn(async (_config: any, _payload: any) => ({
      number: 999,
      id: 'ID_999',
      updatedAt: new Date().toISOString(),
    })),
    updateGithubIssue: vi.fn(),
    updateGithubIssueAsync: vi.fn(async (_config: any, _num: number, _payload: any) => ({
      number: _num,
      id: `ID_${_num}`,
      updatedAt: new Date().toISOString(),
    })),
    getGithubIssueAsync: vi.fn(),
    listGithubIssueComments: vi.fn(() => []),
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
    addSubIssueLink: vi.fn(),
    addSubIssueLinkResult: vi.fn(() => ({ ok: true })),
    addSubIssueLinkResultAsync: vi.fn(async () => ({ ok: true })),
    fetchLabelEventsAsync: mockFetchLabelEventsAsync,
    // Keep real: issueToWorkItemFields, normalizeGithubLabelPrefix,
    // stripWorklogMarkers, extractWorklogId, extractWorklogCommentId,
    // buildWorklogCommentMarker, extractParentId, extractChildIds,
    // extractParentIssueNumber, extractChildIssueNumbers, LabelEventCache,
    // labelFieldsDiffer, workItemToIssuePayload
  };
});

vi.mock('../src/github-metrics.js', () => ({
  increment: vi.fn(),
  snapshot: vi.fn(() => ({})),
  diff: vi.fn(() => ({})),
}));

import { importIssuesToWorkItems, upsertIssuesFromWorkItems } from '../src/github-sync.js';
import {
  createGithubIssueCommentAsync,
  listGithubIssueCommentsAsync,
} from '../src/github.js';

// ── Timestamps ───────────────────────────────────────────────────────────

const T_BASE = '2026-01-01T00:00:00.000Z';
const T_LATER = '2026-01-02T00:00:00.000Z';
const T_ISSUE_UPDATE = '2026-01-12T00:00:00.000Z';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeLocalItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: overrides.id,
    description: '',
    status: 'open' as WorkItemStatus,
    priority: 'medium' as WorkItemPriority,
    sortIndex: 0,
    parentId: null,
    createdAt: T_BASE,
    updatedAt: T_BASE,
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

function makeGithubIssue(overrides: {
  number: number;
  labels?: string[];
  body?: string;
  title?: string;
  state?: string;
  updatedAt?: string;
}) {
  return {
    number: overrides.number,
    id: overrides.number * 1000,
    title: overrides.title || `Issue #${overrides.number}`,
    body: overrides.body !== undefined
      ? overrides.body
      : `<!-- worklog:id=WL-IMPORT-${overrides.number} -->`,
    state: overrides.state || 'open',
    labels: overrides.labels || [],
    updatedAt: overrides.updatedAt || T_ISSUE_UPDATE,
    subIssuesSummary: { total: 0 },
    assignees: [],
    milestone: null,
  };
}

function makeComment(overrides: Partial<Comment> & { id: string; workItemId: string }): Comment {
  return {
    author: 'tester',
    comment: `Comment body for ${overrides.id}`,
    createdAt: T_LATER,
    references: [],
    ...overrides,
  };
}

const dummyConfig: GithubConfig = {
  repo: 'test/repo',
  labelPrefix: 'wl:',
};

// ── Import Tests (GitHub -> Worklog) ─────────────────────────────────────

describe('GitHub comment import (GitHub -> Worklog)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchLabelEventsAsync.mockResolvedValue([]);
  });

  it('imports comments from a GitHub issue into Worklog', async () => {
    // Local item linked to GitHub issue #10
    const localItem = makeLocalItem({
      id: 'WL-IMPORT-10',
      githubIssueNumber: 10,
      githubIssueUpdatedAt: T_BASE,
    });

    // GitHub issue #10 exists with a worklog marker
    const issue = makeGithubIssue({
      number: 10,
      body: '<!-- worklog:id=WL-IMPORT-10 -->\nSome issue body',
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    // GitHub issue has a comment from a human (not worklog-originated)
    const ghComment: GithubIssueComment = {
      id: 1001,
      body: 'This is a user comment on the GitHub issue',
      updatedAt: T_ISSUE_UPDATE,
      author: 'octocat',
    };
    mockListGithubIssueCommentsAsync.mockResolvedValue([ghComment]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    // The result should include imported comments
    expect(result).toHaveProperty('importedComments');
    const importedComments = (result as any).importedComments as Comment[];
    expect(importedComments).toBeDefined();
    expect(importedComments.length).toBe(1);

    // The imported comment should map to the correct work item
    const imported = importedComments[0];
    expect(imported.workItemId).toBe('WL-IMPORT-10');
    expect(imported.comment).toBe('This is a user comment on the GitHub issue');
    expect(imported.author).toBe('octocat');
    expect(imported.githubCommentId).toBe(1001);
  });

  it('does not duplicate worklog-originated comments on import', async () => {
    // Local item linked to GitHub issue #11
    const localItem = makeLocalItem({
      id: 'WL-IMPORT-11',
      githubIssueNumber: 11,
      githubIssueUpdatedAt: T_BASE,
    });

    const issue = makeGithubIssue({
      number: 11,
      body: '<!-- worklog:id=WL-IMPORT-11 -->\nIssue body',
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    // GitHub has two comments: one worklog-originated (with marker) and one user comment
    const worklogComment: GithubIssueComment = {
      id: 2001,
      body: '<!-- worklog:comment=WL-C1 -->\n\n**agent**\n\nThis was pushed from worklog',
      updatedAt: T_ISSUE_UPDATE,
      author: 'bot',
    };
    const userComment: GithubIssueComment = {
      id: 2002,
      body: 'A genuine user comment',
      updatedAt: T_ISSUE_UPDATE,
      author: 'octocat',
    };
    mockListGithubIssueCommentsAsync.mockResolvedValue([worklogComment, userComment]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    const importedComments = (result as any).importedComments as Comment[];
    expect(importedComments).toBeDefined();

    // Only the user comment should be imported (worklog comment already exists locally)
    const nonWorklogComments = importedComments.filter(
      c => !c.id.startsWith('WL-C1') // filter out the worklog-originated one if somehow included
    );
    // At minimum, the user comment must be present
    expect(importedComments.some(c => c.comment === 'A genuine user comment')).toBe(true);
    // The worklog-originated comment should NOT be re-imported as a new comment
    expect(importedComments.filter(c => c.comment.includes('This was pushed from worklog')).length).toBe(0);
  });

  it('imports comments for newly created items when createNew is enabled', async () => {
    // No local items — issue is brand new
    const issue = makeGithubIssue({
      number: 20,
      body: '', // no worklog marker
      title: 'New issue from GitHub',
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);

    // The new issue has a comment
    const ghComment: GithubIssueComment = {
      id: 3001,
      body: 'Comment on the new issue',
      updatedAt: T_ISSUE_UPDATE,
      author: 'contributor',
    };
    mockListGithubIssueCommentsAsync.mockResolvedValue([ghComment]);

    let genCounter = 1;
    const result = await importIssuesToWorkItems([], dummyConfig, {
      createNew: true,
      generateId: () => `WL-NEW-${genCounter++}`,
    });

    // A new item should be created
    expect(result.createdItems.length).toBe(1);

    // Comments should be imported for the new item
    const importedComments = (result as any).importedComments as Comment[];
    expect(importedComments).toBeDefined();
    expect(importedComments.length).toBe(1);
    expect(importedComments[0].comment).toBe('Comment on the new issue');
    expect(importedComments[0].author).toBe('contributor');
  });

  it('handles issues with no comments gracefully', async () => {
    const localItem = makeLocalItem({
      id: 'WL-IMPORT-30',
      githubIssueNumber: 30,
      githubIssueUpdatedAt: T_BASE,
    });

    const issue = makeGithubIssue({
      number: 30,
      body: '<!-- worklog:id=WL-IMPORT-30 -->\nIssue body',
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue]);
    mockListGithubIssueCommentsAsync.mockResolvedValue([]);

    const result = await importIssuesToWorkItems([localItem], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    const importedComments = (result as any).importedComments as Comment[];
    expect(importedComments).toBeDefined();
    expect(importedComments.length).toBe(0);
  });

  it('imports multiple comments from multiple issues', async () => {
    const item1 = makeLocalItem({
      id: 'WL-IMPORT-40',
      githubIssueNumber: 40,
      githubIssueUpdatedAt: T_BASE,
    });
    const item2 = makeLocalItem({
      id: 'WL-IMPORT-41',
      githubIssueNumber: 41,
      githubIssueUpdatedAt: T_BASE,
    });

    const issue1 = makeGithubIssue({
      number: 40,
      body: '<!-- worklog:id=WL-IMPORT-40 -->\nFirst issue',
      updatedAt: T_ISSUE_UPDATE,
    });
    const issue2 = makeGithubIssue({
      number: 41,
      body: '<!-- worklog:id=WL-IMPORT-41 -->\nSecond issue',
      updatedAt: T_ISSUE_UPDATE,
    });

    mockListGithubIssues.mockReturnValue([issue1, issue2]);

    // Each issue has comments
    mockListGithubIssueCommentsAsync
      .mockResolvedValueOnce([
        { id: 4001, body: 'Comment on issue 40', updatedAt: T_ISSUE_UPDATE, author: 'alice' },
        { id: 4002, body: 'Another comment on issue 40', updatedAt: T_ISSUE_UPDATE, author: 'bob' },
      ])
      .mockResolvedValueOnce([
        { id: 4003, body: 'Comment on issue 41', updatedAt: T_ISSUE_UPDATE, author: 'charlie' },
      ]);

    const result = await importIssuesToWorkItems([item1, item2], dummyConfig, {
      generateId: () => 'WL-GEN',
    });

    const importedComments = (result as any).importedComments as Comment[];
    expect(importedComments).toBeDefined();
    expect(importedComments.length).toBe(3);

    // Verify comments are associated with correct work items
    const item40Comments = importedComments.filter(c => c.workItemId === 'WL-IMPORT-40');
    const item41Comments = importedComments.filter(c => c.workItemId === 'WL-IMPORT-41');
    expect(item40Comments.length).toBe(2);
    expect(item41Comments.length).toBe(1);
  });
});

// ── Push Tests (Worklog -> GitHub) ───────────────────────────────────────

describe('GitHub comment push (Worklog -> GitHub)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchLabelEventsAsync.mockResolvedValue([]);
  });

  it('pushes a locally created comment to GitHub', async () => {
    const item = makeLocalItem({
      id: 'PUSH-1',
      title: 'Item to push',
      status: 'open',
      updatedAt: T_LATER,
    });

    const comment = makeComment({
      id: 'WL-PUSH-C1',
      workItemId: 'PUSH-1',
      comment: 'This comment should appear on GitHub',
      createdAt: T_LATER,
      author: 'developer',
    });

    // No existing GH comments
    mockListGithubIssueCommentsAsync.mockResolvedValue([]);

    const { result } = await upsertIssuesFromWorkItems(
      [item],
      [comment],
      dummyConfig as any,
    );

    // The comment should have been pushed to GitHub
    expect(createGithubIssueCommentAsync).toHaveBeenCalled();
    expect(result.commentsCreated).toBe(1);

    // Verify the body sent to GitHub contains the comment text
    const callArgs = (createGithubIssueCommentAsync as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = callArgs[2] as string;
    expect(sentBody).toContain('This comment should appear on GitHub');
    expect(sentBody).toContain('developer'); // author should be in the body
    expect(sentBody).toContain('<!-- worklog:comment=WL-PUSH-C1 -->'); // marker for round-tripping
  });

  it('pushes multiple comments for different items to GitHub', async () => {
    const item1 = makeLocalItem({
      id: 'PUSH-2',
      title: 'First push item',
      status: 'open',
      updatedAt: T_LATER,
    });
    const item2 = makeLocalItem({
      id: 'PUSH-3',
      title: 'Second push item',
      status: 'open',
      updatedAt: T_LATER,
    });

    const comment1 = makeComment({
      id: 'WL-PUSH-C2',
      workItemId: 'PUSH-2',
      comment: 'Comment for first item',
      createdAt: T_LATER,
    });
    const comment2 = makeComment({
      id: 'WL-PUSH-C3',
      workItemId: 'PUSH-3',
      comment: 'Comment for second item',
      createdAt: T_LATER,
    });

    mockListGithubIssueCommentsAsync.mockResolvedValue([]);

    const { result } = await upsertIssuesFromWorkItems(
      [item1, item2],
      [comment1, comment2],
      dummyConfig as any,
    );

    expect(createGithubIssueCommentAsync).toHaveBeenCalledTimes(2);
    expect(result.commentsCreated).toBe(2);
  });
});
