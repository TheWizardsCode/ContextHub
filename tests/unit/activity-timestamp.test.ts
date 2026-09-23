/**
 * Tests for the separate comment/activity timestamp (`activityAt`) and its
 * effect on audit freshness (WL-0MUBVH6JM0093KVM).
 *
 * The contract under test:
 *   • Comment create/update/delete bump `activityAt` only; `updatedAt` — the
 *     audit-relevant content timestamp — is left untouched.
 *   • Semantic content edits still bump `updatedAt`.
 *   • `activityAt >= updatedAt` always holds.
 *   • A legacy (non-fingerprinted) audit therefore stays fresh across a
 *     comment added more than the 60 s tolerance window later, while a
 *     description edit goes stale.
 *   • The score recency policy reads `activityAt`, so comment activity still
 *     influences ordering without touching `updatedAt`.
 *
 * Time is controlled with fake timers so the 60 s freshness tolerance can be
 * crossed deterministically. All assertions go through the public API.
 *
 * Run: npx vitest run tests/unit/activity-timestamp.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorklogDatabase } from '../../src/database.js';
import { isAuditFresh } from '@worklog/shared/icons';
import { WorkItem } from '../../src/types.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T0_PLUS_5MIN = '2026-01-01T00:05:00.000Z';
const ITEM_ID = 'WI-0001';

/** Build a complete WorkItem with a fixed timestamp. */
function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: ITEM_ID,
    title: 'Fix the bug',
    description: 'A description with some detail.',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: T0,
    updatedAt: T0,
    tags: [],
    assignee: '',
    stage: 'in_review',
    issueType: 'bug',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    needsProducerReview: false,
    ...overrides,
  };
}

let tempDir: string;
let db: WorklogDatabase;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
  tempDir = mkdtempSync(join(tmpdir(), 'wl-activity-at-'));
  db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true);
  db.import([makeItem()]);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  rmSync(tempDir, { recursive: true, force: true });
});

/** Persist a legacy (fingerprint-less) passing audit at `auditedAt`. */
function saveLegacyAudit(auditedAt: string): void {
  db.saveAuditResult({
    workItemId: ITEM_ID,
    readyToClose: true,
    auditedAt,
    summary: 'ready to close',
    rawOutput: null,
    author: 'test',
  });
}

describe('activityAt is bumped by comment writes, updatedAt is not', () => {
  it('createComment moves activityAt only', () => {
    vi.setSystemTime(new Date(T0_PLUS_5MIN));
    db.createComment({ workItemId: ITEM_ID, author: 'a', comment: 'hello', references: [] });

    const item = db.get(ITEM_ID)!;
    expect(item.updatedAt).toBe(T0);
    expect(item.activityAt).toBe(T0_PLUS_5MIN);
  });

  it('updateComment moves activityAt only', () => {
    db.createComment({ workItemId: ITEM_ID, author: 'a', comment: 'hello', references: [] });
    const comment = db.getCommentsForWorkItem(ITEM_ID)[0];

    vi.setSystemTime(new Date(T0_PLUS_5MIN));
    db.updateComment(comment.id, { comment: 'edited' });

    const item = db.get(ITEM_ID)!;
    expect(item.updatedAt).toBe(T0);
    expect(item.activityAt).toBe(T0_PLUS_5MIN);
  });

  it('deleteComment moves activityAt only', () => {
    db.createComment({ workItemId: ITEM_ID, author: 'a', comment: 'hello', references: [] });
    const comment = db.getCommentsForWorkItem(ITEM_ID)[0];

    vi.setSystemTime(new Date(T0_PLUS_5MIN));
    expect(db.deleteComment(comment.id)).toBe(true);

    const item = db.get(ITEM_ID)!;
    expect(item.updatedAt).toBe(T0);
    expect(item.activityAt).toBe(T0_PLUS_5MIN);
  });

  it('semantic content edits still bump updatedAt (and activityAt is never behind it)', () => {
    vi.setSystemTime(new Date(T0_PLUS_5MIN));
    db.update(ITEM_ID, { description: 'materially changed content' });

    const item = db.get(ITEM_ID)!;
    expect(item.updatedAt).toBe(T0_PLUS_5MIN);
    expect(item.activityAt).toBe(T0_PLUS_5MIN);
    expect(new Date(item.activityAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(item.updatedAt).getTime(),
    );
  });

  it('a newly created item has activityAt at least updatedAt', () => {
    vi.setSystemTime(new Date(T0_PLUS_5MIN));
    const created = db.create({ title: 'brand new' });
    const item = db.get(created.id)!;

    expect(item.activityAt).toBeDefined();
    expect(new Date(item.activityAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(item.updatedAt).getTime(),
    );
  });
});

describe('legacy audit freshness survives comment churn (AC4/AC5)', () => {
  it('a comment added minutes after the audit leaves the audit fresh', () => {
    saveLegacyAudit(T0);
    expect(db.get(ITEM_ID)!.updatedAt).toBe(T0);

    vi.setSystemTime(new Date(T0_PLUS_5MIN));
    db.createComment({ workItemId: ITEM_ID, author: 'a', comment: 'post-audit note', references: [] });

    const item = db.get(ITEM_ID)!;
    // The audit-relevant content timestamp did not move...
    expect(item.updatedAt).toBe(T0);
    // ...so the legacy (no-fingerprint) time gate still considers it fresh
    // even though more than the 60 s tolerance has passed.
    expect(isAuditFresh(T0, item.updatedAt)).toBe(true);
  });

  it('a comment deleted minutes after the audit leaves the audit fresh', () => {
    db.createComment({ workItemId: ITEM_ID, author: 'a', comment: 'to remove', references: [] });
    const comment = db.getCommentsForWorkItem(ITEM_ID)[0];
    saveLegacyAudit(T0);

    vi.setSystemTime(new Date(T0_PLUS_5MIN));
    expect(db.deleteComment(comment.id)).toBe(true);

    const item = db.get(ITEM_ID)!;
    expect(item.updatedAt).toBe(T0);
    expect(isAuditFresh(T0, item.updatedAt)).toBe(true);
  });

  it('a description edit minutes after the audit makes it stale', () => {
    saveLegacyAudit(T0);

    vi.setSystemTime(new Date(T0_PLUS_5MIN));
    db.update(ITEM_ID, { description: 'materially changed content' });

    const item = db.get(ITEM_ID)!;
    expect(item.updatedAt).toBe(T0_PLUS_5MIN);
    expect(isAuditFresh(T0, item.updatedAt)).toBe(false);
  });
});

describe('score recency policy uses activityAt (AC3)', () => {
  it('a comment-only change lifts an item under recencyPolicy=prefer', () => {
    // Two identical-age items; only the id tie-break differs, and the
    // commented item's id sorts *last*, so it can only come first because
    // comment activity boosts its score. Use a fresh DB so the per-test
    // fixture item is absent.
    db.close();
    db = new WorklogDatabase('TEST', join(tempDir, 'score.db'), join(tempDir, 'score.jsonl'), true);
    db.import([
      makeItem({ id: 'WI-AAAA', createdAt: T0, updatedAt: T0 }),
      makeItem({ id: 'WI-ZZZZ', createdAt: T0, updatedAt: T0 }),
    ]);

    // Without any comment activity the id tie-break puts WI-AAAA first.
    expect(db.getAllOrderedByScore('prefer').map(i => i.id)).toEqual(['WI-AAAA', 'WI-ZZZZ']);

    // Comment on WI-ZZZZ much later: activityAt moves, updatedAt does not.
    const later = '2026-06-01T00:00:00.000Z';
    vi.setSystemTime(new Date(later));
    db.createComment({ workItemId: 'WI-ZZZZ', author: 'a', comment: 'recent activity', references: [] });

    expect(db.get('WI-ZZZZ')!.updatedAt).toBe(T0);
    expect(db.get('WI-ZZZZ')!.activityAt).toBe(later);
    expect(db.getAllOrderedByScore('prefer').map(i => i.id)).toEqual(['WI-ZZZZ', 'WI-AAAA']);
  });
});
