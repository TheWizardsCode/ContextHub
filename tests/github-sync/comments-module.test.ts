/**
 * tests/github-sync/comments-module.test.ts — behaviour of the extracted
 * `src/github-sync/comments.ts` module.
 *
 * `buildGithubCommentBody` and `upsertGithubIssueCommentsAsync` moved out of
 * `src/github-sync.ts` (WL-0MW0JF8R6006HUA6, child 5 of 8 of the
 * WL-0MVGKH9Z900178UF decomposition) so the comment mapping/persistence rules
 * are reviewable in one place. The unchanged flow suite
 * (`github-sync-comments.test.ts`) remains the end-to-end gate; this file pins
 * the module's own contract:
 *
 * | Property | Why it matters |
 * |---|---|
 * | body = marker, author label, marker-stripped body, trimmed | marker syntax is how a comment is matched on the next run |
 * | an authorless comment renders `**worklog**` | the fallback label is part of the stored body |
 * | a matching body is never re-pushed | re-rendering identical comments must not churn the GitHub API |
 * | a differing body is updated, a missing one created, in `createdAt` order | the upsert result and `latestUpdatedAt` drive the item timestamp |
 * | the first duplicate marker wins | the existing-comment index keeps the oldest match |
 * | mapping writes go through `persistComment`; its failure is swallowed and logged | a persistence fault must never abort the sync |
 * | `api.comment.create` / `api.comment.update` are still incremented | the metric names are part of the observable contract |
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Comment } from '../../src/types.js';

const WORKLOG_COMMENT_MARKER_PREFIX = '<!-- worklog:comment=';
const WORKLOG_MARKER_SUFFIX = ' -->';

vi.mock('../../src/github.js', () => ({
  buildWorklogCommentMarker: (id: string) => `${WORKLOG_COMMENT_MARKER_PREFIX}${id}${WORKLOG_MARKER_SUFFIX}`,
  extractWorklogCommentId: (body?: string) => {
    const line = (body || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith(WORKLOG_COMMENT_MARKER_PREFIX));
    if (!line) return undefined;
    return line.slice(WORKLOG_COMMENT_MARKER_PREFIX.length, -WORKLOG_MARKER_SUFFIX.length);
  },
  stripWorklogMarkers: (body?: string | null) => {
    if (!body) return '';
    return body
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('<!-- worklog:');
      })
      .join('\n');
  },
  createGithubIssueCommentAsync: vi.fn(async (_config: any, _issueNumber: number, body: string) => ({
    id: 9001,
    body,
    updatedAt: '2025-02-01T00:00:00.000Z',
  })),
  updateGithubIssueCommentAsync: vi.fn(async (_config: any, commentId: number, body: string) => ({
    id: commentId,
    body,
    updatedAt: '2025-02-02T00:00:00.000Z',
  })),
}));

vi.mock('../../src/github-metrics.js', () => ({
  increment: vi.fn(),
}));

import {
  createGithubIssueCommentAsync,
  updateGithubIssueCommentAsync,
} from '../../src/github.js';
import { increment } from '../../src/github-metrics.js';
import {
  buildGithubCommentBody,
  upsertGithubIssueCommentsAsync,
} from '../../src/github-sync/comments.js';

const CONFIG = { token: 't', owner: 'o', repo: 'r' } as any;
const ISSUE_NUMBER = 42;
const BASE = new Date('2025-01-01T00:00:00.000Z').toISOString();

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'C-1',
    workItemId: 'WL-A',
    author: 'alice',
    comment: 'Hello',
    createdAt: BASE,
    references: [],
    ...overrides,
  } as Comment;
}

function makeExisting(id: number, markerId: string, body: string, updatedAt: string = BASE) {
  return { id, body: `${WORKLOG_COMMENT_MARKER_PREFIX}${markerId}${WORKLOG_MARKER_SUFFIX}\n\n${body}`, updatedAt };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildGithubCommentBody', () => {
  it('renders the marker, the bold author label and the marker-stripped body', () => {
    const body = buildGithubCommentBody(
      makeComment({
        id: 'C-7',
        author: 'alice',
        comment: 'Line one\n<!-- worklog:id=WL-A -->\nLine two',
      })
    );

    expect(body).toBe(`${WORKLOG_COMMENT_MARKER_PREFIX}C-7${WORKLOG_MARKER_SUFFIX}\n\n**alice**\n\nLine one\nLine two`);
  });

  it('falls back to the **worklog** label for an authorless comment and trims the whole body', () => {
    const body = buildGithubCommentBody(makeComment({ id: 'C-8', author: '', comment: '  text  \n\n' }));

    expect(body).toBe(`${WORKLOG_COMMENT_MARKER_PREFIX}C-8${WORKLOG_MARKER_SUFFIX}\n\n**worklog**\n\n  text`);
    expect(body.endsWith(' ')).toBe(false);
  });
});

describe('upsertGithubIssueCommentsAsync', () => {
  it('creates a comment with no GitHub counterpart and persists its mapping', async () => {
    const comment = makeComment({ id: 'C-NEW' });
    const persistComment = vi.fn();

    const summary = await upsertGithubIssueCommentsAsync(CONFIG, ISSUE_NUMBER, [comment], [], persistComment);

    expect(createGithubIssueCommentAsync).toHaveBeenCalledTimes(1);
    expect(createGithubIssueCommentAsync).toHaveBeenCalledWith(
      CONFIG,
      ISSUE_NUMBER,
      buildGithubCommentBody(makeComment({ id: 'C-NEW' }))
    );
    expect(updateGithubIssueCommentAsync).not.toHaveBeenCalled();
    expect(comment.githubCommentId).toBe(9001);
    expect(comment.githubCommentUpdatedAt).toBe('2025-02-01T00:00:00.000Z');
    expect(persistComment).toHaveBeenCalledWith(comment);
    expect(summary).toEqual({ created: 1, updated: 0, latestUpdatedAt: '2025-02-01T00:00:00.000Z' });
    expect(increment).toHaveBeenCalledWith('api.comment.create');
  });

  it('leaves an identical body untouched', async () => {
    const comment = makeComment({ id: 'C-SAME', comment: 'No change' });
    const existing = makeExisting(11, 'C-SAME', buildGithubCommentBody(comment).split('\n\n').slice(1).join('\n\n'));
    const persistComment = vi.fn();

    const summary = await upsertGithubIssueCommentsAsync(CONFIG, ISSUE_NUMBER, [comment], [existing], persistComment);

    expect(createGithubIssueCommentAsync).not.toHaveBeenCalled();
    expect(updateGithubIssueCommentAsync).not.toHaveBeenCalled();
    expect(persistComment).not.toHaveBeenCalled();
    expect(summary).toEqual({ created: 0, updated: 0, latestUpdatedAt: null });
  });

  it('updates only the differing body and keeps the newest GitHub timestamp', async () => {
    const same = makeComment({ id: 'C-SAME', comment: 'unchanged', createdAt: '2025-01-01T00:00:00.000Z' });
    const changed = makeComment({ id: 'C-CHANGED', comment: 'new text', createdAt: '2025-01-02T00:00:00.000Z' });
    const existingSame = makeExisting(
      11,
      'C-SAME',
      buildGithubCommentBody(same).split('\n\n').slice(1).join('\n\n'),
      '2025-01-05T00:00:00.000Z'
    );
    const existingChanged = makeExisting(12, 'C-CHANGED', '**alice**\n\nstale text');
    const persistComment = vi.fn();

    const summary = await upsertGithubIssueCommentsAsync(
      CONFIG,
      ISSUE_NUMBER,
      [changed, same],
      [existingChanged, existingSame],
      persistComment
    );

    expect(updateGithubIssueCommentAsync).toHaveBeenCalledTimes(1);
    expect(updateGithubIssueCommentAsync).toHaveBeenCalledWith(CONFIG, 12, buildGithubCommentBody(changed));
    expect(changed.githubCommentId).toBe(12);
    expect(changed.githubCommentUpdatedAt).toBe('2025-02-02T00:00:00.000Z');
    expect(persistComment).toHaveBeenCalledTimes(1);
    expect(persistComment).toHaveBeenCalledWith(changed);
    expect(summary).toEqual({ created: 0, updated: 1, latestUpdatedAt: '2025-02-02T00:00:00.000Z' });
    expect(increment).toHaveBeenCalledWith('api.comment.update');
  });

  it('matches the first GitHub comment when several carry the same marker', async () => {
    const comment = makeComment({ id: 'C-DUP', comment: 'text' });
    const first = makeExisting(21, 'C-DUP', '**alice**\n\nold body');
    const second = makeExisting(22, 'C-DUP', '**alice**\n\nanother body');

    const summary = await upsertGithubIssueCommentsAsync(CONFIG, ISSUE_NUMBER, [comment], [first, second]);

    expect(updateGithubIssueCommentAsync).toHaveBeenCalledTimes(1);
    expect(updateGithubIssueCommentAsync).toHaveBeenCalledWith(CONFIG, 21, buildGithubCommentBody(comment));
    expect(summary.updated).toBe(1);
  });

  it('swallows a persistComment failure, reports it via onVerboseLog and keeps the sync going', async () => {
    const failing = makeComment({ id: 'C-FAIL' });
    const healthy = makeComment({ id: 'C-OK' });
    const persistComment = vi.fn((c: Comment) => {
      if (c.id === 'C-FAIL') throw new Error('boom');
    });
    const onVerboseLog = vi.fn();

    const summary = await upsertGithubIssueCommentsAsync(
      CONFIG,
      ISSUE_NUMBER,
      [failing, healthy],
      [],
      persistComment,
      onVerboseLog
    );

    expect(summary.created).toBe(2);
    expect(persistComment).toHaveBeenCalledTimes(2);
    expect(onVerboseLog).toHaveBeenCalledWith('[persist] failed to save comment mapping for C-FAIL: boom');
    expect(onVerboseLog).toHaveBeenCalledTimes(1);
  });
});
