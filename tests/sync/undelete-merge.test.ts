/**
 * Sync/merge tests for the `wl undelete` restore signal (WL-0MWMRNL2W003W5R3).
 *
 * A soft delete is merged as terminal intent: an **attributed** tombstone
 * (non-empty deletedBy/deleteReason) wins over a live copy, and at equal
 * timestamps `deleted` wins deterministically. A restore is the inverse
 * operation, so it must be able to win back the item without a schema change:
 *
 *   - `db.update` bumps `updatedAt`, so the restore is the newer write and
 *     converges over a peer that still holds the older tombstone;
 *   - a *subsequent* delete (newer still, attributed) wins again — a restore
 *     never makes an item undeletable.
 *
 * These are the reconciliation guarantees AC7 of the work item asks for; they
 * are asserted against the real `mergeWorkItems` implementation rather than a
 * mock so a future merge-policy change cannot silently re-tombstone a restore.
 */

import { describe, it, expect } from 'vitest';
import { mergeWorkItems } from '../../src/sync.js';
import type { WorkItem } from '../../src/types.js';

/** Minimal live item fixture. */
function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'UND-0TEST00000000001',
    title: 'Restore/delete convergence fixture',
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    assignee: '',
    stage: '',
    issueType: 'task',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    ...overrides,
  } as WorkItem;
}

/** A soft-deleted copy of the fixture, attributed and optionally timestamped. */
function tombstone(updatedAt: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return item({
    status: 'deleted',
    deletedBy: 'Map',
    deleteReason: "Won't fix — operator decision.",
    updatedAt,
    ...overrides,
  });
}

/** A restored copy: live status, tombstone cleared, newer timestamp. */
function restored(updatedAt: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return item({ status: 'open', updatedAt, ...overrides });
}

describe('undelete ↔ sync convergence', () => {
  it('a restore newer than an attributed tombstone keeps the item live', () => {
    const local = restored('2026-01-02T00:00:00.000Z');
    const remote = tombstone('2026-01-01T00:00:00.000Z');

    const { merged: items } = mergeWorkItems([local], [remote]);

    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('open');
    expect(items[0].deletedBy ?? '').toBe('');
    expect(items[0].deleteReason ?? '').toBe('');
  });

  it('the same convergence holds with the sides swapped (remote restored)', () => {
    const local = tombstone('2026-01-01T00:00:00.000Z');
    const remote = restored('2026-01-02T00:00:00.000Z');

    const { merged: items } = mergeWorkItems([local], [remote]);

    expect(items[0].status).toBe('open');
    expect(items[0].deletedBy ?? '').toBe('');
  });

  it('an older tombstone never resurrects a restore that carries unrelated edits', () => {
    // The realistic case: the restore is followed by a field edit before the
    // peer's tombstone arrives.
    const local = restored('2026-01-03T00:00:00.000Z', { priority: 'high' });
    const remote = tombstone('2026-01-01T00:00:00.000Z');

    const { merged: items } = mergeWorkItems([local], [remote]);

    expect(items[0].status).toBe('open');
    expect(items[0].priority).toBe('high');
  });

  it('a newer attributed delete still wins over an earlier restore', () => {
    const local = restored('2026-01-02T00:00:00.000Z');
    const remote = tombstone('2026-01-03T00:00:00.000Z');

    const { merged: items } = mergeWorkItems([local], [remote]);

    expect(items[0].status).toBe('deleted');
    expect(items[0].deletedBy).toBe('Map');
  });

  it('an unattributed tombstone never wins over a restore', () => {
    const local = restored('2026-01-02T00:00:00.000Z');
    const remote = item({
      status: 'deleted',
      deletedBy: '',
      deleteReason: '',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });

    const { merged: items } = mergeWorkItems([local], [remote]);

    expect(items[0].status).toBe('open');
  });
});
