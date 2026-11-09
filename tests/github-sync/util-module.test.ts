/**
 * tests/github-sync/util-module.test.ts — behaviour of the extracted
 * `src/github-sync/util.ts` helpers.
 *
 * The six helpers moved out of `src/github-sync.ts` (WL-0MW0JF6TH00749I2,
 * child 3 of 8) are now the single shared implementation both flows call, so
 * their contract is asserted directly: timestamp ordering, comment ordering,
 * the comment-sync predicate, title shortening and the stable import key. The
 * unchanged flow suites (`github-sync-output`, `github-sync-comments`) remain
 * the end-to-end behaviour gate; this file pins the primitives they depend on.
 */

import { describe, it, expect } from 'vitest';
import type { Comment, WorkItem } from '../../src/types.js';
import {
  commentNeedsSync,
  latestCommentTimestamp,
  maxIsoTimestamp,
  sortCommentsByCreatedAt,
  stableItemKeyForImport,
  truncateTitle,
} from '../../src/github-sync/util.js';

const BASE = new Date('2025-01-01T00:00:00.000Z').toISOString();

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WL-A',
    title: 'Item A',
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: BASE,
    updatedAt: BASE,
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
  };
}

function makeComment(id: string, createdAt: string): Comment {
  return { id, workItemId: 'WL-A', author: 'a', comment: 'c', createdAt, references: [] };
}

describe('maxIsoTimestamp', () => {
  it('returns null when both values are absent', () => {
    expect(maxIsoTimestamp(undefined, null)).toBeNull();
  });

  it('returns the present value when only one side is set', () => {
    expect(maxIsoTimestamp(undefined, '2025-01-02T00:00:00.000Z')).toBe('2025-01-02T00:00:00.000Z');
    expect(maxIsoTimestamp('2025-01-03T00:00:00.000Z', null)).toBe('2025-01-03T00:00:00.000Z');
  });

  it('returns the later of two parseable timestamps', () => {
    expect(maxIsoTimestamp('2025-01-02T00:00:00.000Z', '2025-01-05T00:00:00.000Z')).toBe(
      '2025-01-05T00:00:00.000Z',
    );
    expect(maxIsoTimestamp('2025-01-05T00:00:00.000Z', '2025-01-02T00:00:00.000Z')).toBe(
      '2025-01-05T00:00:00.000Z',
    );
  });

  it('prefers the parseable value when the other is unparseable', () => {
    expect(maxIsoTimestamp('not-a-date', '2025-01-02T00:00:00.000Z')).toBe('2025-01-02T00:00:00.000Z');
    expect(maxIsoTimestamp('2025-01-02T00:00:00.000Z', 'not-a-date')).toBe('2025-01-02T00:00:00.000Z');
  });

  it('returns the left value when both are unparseable', () => {
    expect(maxIsoTimestamp('nope', 'also-nope')).toBe('nope');
  });
});

describe('latestCommentTimestamp', () => {
  it('returns null for an empty list', () => {
    expect(latestCommentTimestamp([])).toBeNull();
  });

  it('returns the greatest createdAt across the comments', () => {
    const comments = [
      makeComment('c1', '2025-01-02T00:00:00.000Z'),
      makeComment('c2', '2025-01-05T00:00:00.000Z'),
      makeComment('c3', '2025-01-03T00:00:00.000Z'),
    ];
    expect(latestCommentTimestamp(comments)).toBe('2025-01-05T00:00:00.000Z');
  });
});

describe('sortCommentsByCreatedAt', () => {
  it('orders parseable timestamps ascending', () => {
    const comments = [
      makeComment('late', '2025-01-05T00:00:00.000Z'),
      makeComment('early', '2025-01-02T00:00:00.000Z'),
      makeComment('middle', '2025-01-03T00:00:00.000Z'),
    ];
    expect(comments.slice().sort(sortCommentsByCreatedAt).map((c) => c.id)).toEqual([
      'early',
      'middle',
      'late',
    ]);
  });

  it('sorts unparseable timestamps before parseable ones', () => {
    const comments = [
      makeComment('valid', '2025-01-02T00:00:00.000Z'),
      makeComment('invalid', 'not-a-date'),
    ];
    expect(comments.slice().sort(sortCommentsByCreatedAt).map((c) => c.id)).toEqual([
      'invalid',
      'valid',
    ]);
  });

  it('reports equality when both timestamps are unparseable', () => {
    expect(
      sortCommentsByCreatedAt(makeComment('a', 'nope'), makeComment('b', 'also-nope')),
    ).toBe(0);
  });
});

describe('truncateTitle', () => {
  it('returns short titles unchanged', () => {
    expect(truncateTitle('short', 60)).toBe('short');
  });

  it('truncates long titles to the limit with a single ellipsis', () => {
    const title = 'x'.repeat(80);
    const result = truncateTitle(title, 60);
    expect(result).toHaveLength(60);
    expect(result.endsWith('\u2026')).toBe(true);
    expect(result.slice(0, 59)).toBe('x'.repeat(59));
  });

  it('defaults the limit to 60 characters', () => {
    expect(truncateTitle('y'.repeat(61))).toHaveLength(60);
  });
});

describe('commentNeedsSync', () => {
  it('returns false when the item has no comments', () => {
    expect(commentNeedsSync(makeItem({ githubIssueUpdatedAt: BASE }), [])).toBe(false);
  });

  it('returns true when no issue timestamp is recorded', () => {
    expect(commentNeedsSync(makeItem(), [makeComment('c1', BASE)])).toBe(true);
  });

  it('returns true when a comment is newer than the issue timestamp', () => {
    const item = makeItem({ githubIssueUpdatedAt: '2025-01-02T00:00:00.000Z' });
    expect(commentNeedsSync(item, [makeComment('c1', '2025-01-03T00:00:00.000Z')])).toBe(true);
  });

  it('returns false when all comments are older than the issue timestamp', () => {
    const item = makeItem({ githubIssueUpdatedAt: '2025-01-05T00:00:00.000Z' });
    expect(commentNeedsSync(item, [makeComment('c1', '2025-01-02T00:00:00.000Z')])).toBe(false);
  });
});

describe('stableItemKeyForImport', () => {
  it('ignores the sync bookkeeping fields', () => {
    const base = makeItem({ tags: ['b', 'a'] });
    const withSync = {
      ...base,
      updatedAt: '2030-01-01T00:00:00.000Z',
      githubIssueNumber: 42,
      githubIssueId: 7,
      githubIssueUpdatedAt: '2030-01-01T00:00:00.000Z',
    };
    expect(stableItemKeyForImport(withSync)).toBe(stableItemKeyForImport(base));
  });

  it('normalises tag order', () => {
    const a = makeItem({ tags: ['x', 'y', 'z'] });
    const b = makeItem({ tags: ['z', 'x', 'y'] });
    expect(stableItemKeyForImport(a)).toBe(stableItemKeyForImport(b));
  });

  it('differs when a content field changes', () => {
    expect(stableItemKeyForImport(makeItem({ title: 'One' }))).not.toBe(
      stableItemKeyForImport(makeItem({ title: 'Two' })),
    );
  });
});
