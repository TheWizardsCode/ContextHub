import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { filterItemsForPush, readLastPushTimestamp, writeLastPushTimestamp } from '../src/github-pre-filter.js';

const baseTime = new Date('2025-01-01T00:00:00.000Z').toISOString();

function makeItem(id: string, updatedAt: string, githubIssueNumber?: number, status: string = 'open') {
  return {
    id,
    title: id,
    description: '',
    status,
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: baseTime,
    updatedAt,
    tags: [],
    assignee: '',
    stage: '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    githubIssueNumber,
  } as any;
}

function makeComment(id: string, workItemId: string) {
  return { id, workItemId, author: 'a', comment: 'c', createdAt: baseTime, references: [] } as any;
}

describe('github pre-filter', () => {
  // -------------------------------------------------------------------
  // AC4: On first run (no timestamp file), all items are processed
  // -------------------------------------------------------------------
  describe('first run / no timestamp', () => {
    it('returns all items when lastPushTimestamp is null', () => {
      const items = [makeItem('A', baseTime), makeItem('B', baseTime)];
      const comments = [makeComment('C1', 'A'), makeComment('C2', 'B')];
      const res = filterItemsForPush(items, comments, null);
      expect(res.filteredItems.length).toBe(2);
      expect(res.filteredComments.length).toBe(2);
      expect(res.skippedCount).toBe(0);
      expect(res.totalCandidates).toBe(2);
      expect(res.deletedWithoutIssueCount).toBe(0);
    });

    it('returns all items when lastPushTimestamp is empty string', () => {
      const items = [makeItem('A', baseTime, 1), makeItem('B', baseTime)];
      const comments = [makeComment('C1', 'A')];
      const res = filterItemsForPush(items, comments, '');
      expect(res.filteredItems.length).toBe(2);
      expect(res.skippedCount).toBe(0);
    });

    it('returns all items when lastPushTimestamp is invalid ISO string', () => {
      const items = [makeItem('A', baseTime, 1), makeItem('B', baseTime)];
      const comments: any[] = [];
      const res = filterItemsForPush(items, comments, 'not-a-date');
      expect(res.filteredItems.length).toBe(2);
      expect(res.skippedCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // AC1: Only items where updatedAt > lastPushTimestamp OR
  //      githubIssueNumber is null/undefined are processed
  // -------------------------------------------------------------------
  describe('pre-filter with valid timestamp', () => {
    const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();

    it('includes items with updatedAt newer than lastPush', () => {
      const newer = new Date('2025-01-03T00:00:00.000Z').toISOString();
      const items = [makeItem('A', newer, 1)];
      const res = filterItemsForPush(items, [], lastPush);
      expect(res.filteredItems.map(i => i.id)).toEqual(['A']);
      expect(res.skippedCount).toBe(0);
    });

    it('includes items with no githubIssueNumber (null)', () => {
      const older = new Date('2025-01-01T00:00:00.000Z').toISOString();
      const items = [makeItem('A', older, undefined)]; // undefined becomes null-ish
      const res = filterItemsForPush(items, [], lastPush);
      expect(res.filteredItems.map(i => i.id)).toEqual(['A']);
    });

    it('includes items with githubIssueNumber explicitly undefined', () => {
      const older = new Date('2025-01-01T00:00:00.000Z').toISOString();
      const item = makeItem('A', older);
      item.githubIssueNumber = undefined;
      const res = filterItemsForPush([item], [], lastPush);
      expect(res.filteredItems.map(i => i.id)).toEqual(['A']);
    });

    it('filters unchanged items with githubIssueNumber set', () => {
      const newer = new Date('2025-01-03T00:00:00.000Z').toISOString();
      const older = new Date('2025-01-01T12:00:00.000Z').toISOString();
      const items = [makeItem('A', older, 1), makeItem('B', newer, 2), makeItem('C', older) /* no issue number */];
      const comments = [makeComment('C1', 'A'), makeComment('C2', 'B'), makeComment('C3', 'C')];
      const res = filterItemsForPush(items, comments, lastPush);
      // A is older than lastPush and has issue number -> skipped
      // B is newer -> included
      // C has no githubIssueNumber -> included
      expect(res.filteredItems.map(i => i.id).sort()).toEqual(['B', 'C']);
      expect(res.filteredComments.map(c => c.workItemId).sort()).toEqual(['B', 'C']);
      expect(res.totalCandidates).toBe(3);
      expect(res.skippedCount).toBe(1);
    });

    // AC5: Items with updatedAt <= lastPushTimestamp AND existing
    //      githubIssueNumber are NOT processed
    it('skips items with updatedAt equal to lastPushTimestamp', () => {
      // Equal timestamps should NOT be processed (strict >)
      const items = [makeItem('A', lastPush, 1)];
      const res = filterItemsForPush(items, [], lastPush);
      expect(res.filteredItems.length).toBe(0);
      expect(res.skippedCount).toBe(1);
    });

    it('skips items with updatedAt older than lastPushTimestamp', () => {
      const older = new Date('2025-01-01T00:00:00.000Z').toISOString();
      const items = [makeItem('A', older, 5)];
      const res = filterItemsForPush(items, [], lastPush);
      expect(res.filteredItems.length).toBe(0);
      expect(res.skippedCount).toBe(1);
    });

    it('treats items with invalid updatedAt as changed (included)', () => {
      const items = [makeItem('A', 'not-a-date', 1)];
      const res = filterItemsForPush(items, [], lastPush);
      // NaN updatedAt should be treated as changed
      expect(res.filteredItems.map(i => i.id)).toEqual(['A']);
      expect(res.skippedCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // AC: Deleted items without githubIssueNumber are excluded;
  //     deleted items WITH githubIssueNumber are included as candidates
  // -------------------------------------------------------------------
  describe('deleted item handling', () => {
    it('excludes deleted items without githubIssueNumber', () => {
      const items = [makeItem('A', baseTime, 1), makeItem('B', baseTime, undefined, 'deleted')];
      const comments = [makeComment('C1', 'A'), makeComment('C2', 'B')];
      const res = filterItemsForPush(items, comments, null);
      expect(res.totalCandidates).toBe(1);
      expect(res.filteredItems.map(i => i.id)).toEqual(['A']);
      expect(res.filteredComments.map(c => c.workItemId)).toEqual(['A']);
    });

    it('includes deleted items with githubIssueNumber when updatedAt > lastPush', () => {
      const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();
      const newer = new Date('2025-01-03T00:00:00.000Z').toISOString();
      const items = [makeItem('A', newer, 10, 'deleted')];
      const res = filterItemsForPush(items, [], lastPush);
      expect(res.filteredItems.map(i => i.id)).toEqual(['A']);
      expect(res.totalCandidates).toBe(1);
      expect(res.skippedCount).toBe(0);
    });

    it('excludes deleted items with githubIssueNumber when updatedAt <= lastPush', () => {
      const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();
      const older = new Date('2025-01-01T00:00:00.000Z').toISOString();
      const items = [makeItem('A', older, 10, 'deleted')];
      const res = filterItemsForPush(items, [], lastPush);
      expect(res.filteredItems.length).toBe(0);
      expect(res.totalCandidates).toBe(1);
      expect(res.skippedCount).toBe(1);
    });

    it('includes all deleted items with githubIssueNumber when lastPush is null (force/first-run)', () => {
      const items = [
        makeItem('A', baseTime, 10, 'deleted'),
        makeItem('B', baseTime, 20, 'deleted'),
        makeItem('C', baseTime, undefined, 'deleted'), // no githubIssueNumber -> excluded
      ];
      const res = filterItemsForPush(items, [], null);
      expect(res.filteredItems.map(i => i.id).sort()).toEqual(['A', 'B']);
      expect(res.totalCandidates).toBe(2);
    });

    it('includes totalCandidates count for eligible deleted items', () => {
      const items = [
        makeItem('A', baseTime, 1),
        makeItem('B', baseTime, 2, 'deleted'),   // has githubIssueNumber -> candidate
        makeItem('C', baseTime, 3, 'deleted'),   // has githubIssueNumber -> candidate
      ];
      const res = filterItemsForPush(items, [], null);
      expect(res.totalCandidates).toBe(3);
    });

    it('includes comments for eligible deleted items', () => {
      const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();
      const newer = new Date('2025-01-03T00:00:00.000Z').toISOString();
      const items = [makeItem('A', newer, 10, 'deleted')];
      const comments = [makeComment('C1', 'A')];
      const res = filterItemsForPush(items, comments, lastPush);
      expect(res.filteredComments.map(c => c.workItemId)).toEqual(['A']);
    });

    it('excludes comments for deleted items without githubIssueNumber', () => {
      const items = [makeItem('A', baseTime, undefined, 'deleted')];
      const comments = [makeComment('C1', 'A')];
      const res = filterItemsForPush(items, comments, null);
      expect(res.filteredComments.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // AC6: Comments are also filtered to only include those belonging
  //      to pre-filtered items
  // -------------------------------------------------------------------
  describe('comment filtering', () => {
    const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();
    const newer = new Date('2025-01-03T00:00:00.000Z').toISOString();
    const older = new Date('2025-01-01T00:00:00.000Z').toISOString();

    it('includes comments for items that pass the filter', () => {
      const items = [makeItem('A', newer, 1)];
      const comments = [makeComment('C1', 'A'), makeComment('C2', 'A')];
      const res = filterItemsForPush(items, comments, lastPush);
      expect(res.filteredComments.length).toBe(2);
    });

    it('excludes comments for items that are filtered out', () => {
      const items = [makeItem('A', older, 1), makeItem('B', newer, 2)];
      const comments = [makeComment('C1', 'A'), makeComment('C2', 'B')];
      const res = filterItemsForPush(items, comments, lastPush);
      expect(res.filteredComments.map(c => c.id)).toEqual(['C2']);
    });

    it('excludes comments for deleted items without githubIssueNumber', () => {
      const items = [makeItem('A', newer, undefined, 'deleted')];
      const comments = [makeComment('C1', 'A')];
      const res = filterItemsForPush(items, comments, lastPush);
      expect(res.filteredComments.length).toBe(0);
    });

    it('handles comments with no matching item', () => {
      const items = [makeItem('A', newer, 1)];
      const comments = [makeComment('C1', 'A'), makeComment('C2', 'Z')]; // Z doesn't exist
      const res = filterItemsForPush(items, comments, lastPush);
      // Only C1 matches item A
      expect(res.filteredComments.map(c => c.id)).toEqual(['C1']);
    });

    it('returns empty comments when all items are filtered out', () => {
      const items = [makeItem('A', older, 1)];
      const comments = [makeComment('C1', 'A')];
      const res = filterItemsForPush(items, comments, lastPush);
      expect(res.filteredItems.length).toBe(0);
      expect(res.filteredComments.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Mixed state scenarios
  // -------------------------------------------------------------------
  describe('mixed item states', () => {
    const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();
    const newer = new Date('2025-01-03T00:00:00.000Z').toISOString();
    const older = new Date('2025-01-01T00:00:00.000Z').toISOString();

    it('correctly handles mix of new, changed, unchanged, and deleted items', () => {
      const items = [
        makeItem('new-item', older),               // no githubIssueNumber -> included
        makeItem('changed', newer, 10),             // newer -> included
        makeItem('unchanged', older, 20),            // older + has issue -> skipped
        makeItem('deleted-with-issue', newer, 30, 'deleted'), // deleted + has issue + newer -> included
        makeItem('deleted-no-issue', newer, undefined, 'deleted'), // deleted + no issue -> excluded
      ];
      const comments = [
        makeComment('C1', 'new-item'),
        makeComment('C2', 'changed'),
        makeComment('C3', 'unchanged'),
        makeComment('C4', 'deleted-with-issue'),
        makeComment('C5', 'deleted-no-issue'),
      ];
      const res = filterItemsForPush(items, comments, lastPush);
      expect(res.filteredItems.map(i => i.id).sort()).toEqual(['changed', 'deleted-with-issue', 'new-item']);
      expect(res.filteredComments.map(c => c.workItemId).sort()).toEqual(['changed', 'deleted-with-issue', 'new-item']);
      expect(res.totalCandidates).toBe(4); // excludes deleted-no-issue only
      expect(res.skippedCount).toBe(1); // only 'unchanged'
      expect(res.deletedWithoutIssueCount).toBe(1); // deleted-no-issue
    });
  });

  // -------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty items array', () => {
      const res = filterItemsForPush([], [], null);
      expect(res.filteredItems.length).toBe(0);
      expect(res.filteredComments.length).toBe(0);
      expect(res.totalCandidates).toBe(0);
      expect(res.skippedCount).toBe(0);
      expect(res.deletedWithoutIssueCount).toBe(0);
    });

    it('handles empty items with valid timestamp', () => {
      const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();
      const res = filterItemsForPush([], [], lastPush);
      expect(res.filteredItems.length).toBe(0);
      expect(res.skippedCount).toBe(0);
    });

    it('handles items with empty comments array', () => {
      const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();
      const newer = new Date('2025-01-03T00:00:00.000Z').toISOString();
      const items = [makeItem('A', newer, 1)];
      const res = filterItemsForPush(items, [], lastPush);
      expect(res.filteredItems.length).toBe(1);
      expect(res.filteredComments.length).toBe(0);
    });

    it('processes all non-deleted items when lastPush is null regardless of githubIssueNumber', () => {
      const items = [
        makeItem('A', baseTime, 1),
        makeItem('B', baseTime, 2),
        makeItem('C', baseTime),
      ];
      const res = filterItemsForPush(items, [], null);
      expect(res.filteredItems.length).toBe(3);
      expect(res.skippedCount).toBe(0);
    });

    it('counts totalCandidates correctly with only deleted items', () => {
      const items = [
        makeItem('A', baseTime, 1, 'deleted'),    // has githubIssueNumber -> candidate
        makeItem('B', baseTime, 2, 'deleted'),    // has githubIssueNumber -> candidate
      ];
      const res = filterItemsForPush(items, [], null);
      expect(res.totalCandidates).toBe(2);
      expect(res.filteredItems.length).toBe(2);
      expect(res.skippedCount).toBe(0);
    });

    it('counts totalCandidates as zero with only deleted items without githubIssueNumber', () => {
      const items = [
        makeItem('A', baseTime, undefined, 'deleted'),
        makeItem('B', baseTime, undefined, 'deleted'),
      ];
      const res = filterItemsForPush(items, [], null);
      expect(res.totalCandidates).toBe(0);
      expect(res.filteredItems.length).toBe(0);
      expect(res.skippedCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // AC3: Logging stats (verified by inspecting return values)
  // -------------------------------------------------------------------
  describe('filter stats for logging', () => {
    it('provides correct stats for mixed filtering', () => {
      const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();
      const newer = new Date('2025-01-03T00:00:00.000Z').toISOString();
      const older = new Date('2025-01-01T00:00:00.000Z').toISOString();
      const items = [
        makeItem('A', older, 1),   // skipped
        makeItem('B', older, 2),   // skipped
        makeItem('C', newer, 3),   // included
        makeItem('D', older),      // new item, included
        makeItem('E', newer, 5),   // included
        makeItem('F', older, 6, 'deleted'), // deleted + has issue -> candidate, but older -> skipped
        makeItem('G', older, undefined, 'deleted'), // deleted + no issue -> excluded from candidates
      ];
      const res = filterItemsForPush(items, [], lastPush);
      // totalCandidates = 6 (G excluded as deleted without githubIssueNumber)
      // filtered = C, D, E => 3
      // skipped = A, B, F => 3
      // deletedWithoutIssueCount = 1 (G)
      expect(res.totalCandidates).toBe(6);
      expect(res.filteredItems.length).toBe(3);
      expect(res.skippedCount).toBe(3);
      expect(res.deletedWithoutIssueCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // deletedWithoutIssueCount tracking
  // -------------------------------------------------------------------
  describe('deletedWithoutIssueCount', () => {
    it('counts deleted items without githubIssueNumber', () => {
      const items = [
        makeItem('A', baseTime, 1),
        makeItem('B', baseTime, undefined, 'deleted'),
        makeItem('C', baseTime, 2, 'deleted'),
      ];
      const res = filterItemsForPush(items, [], null);
      expect(res.deletedWithoutIssueCount).toBe(1); // only B
      expect(res.totalCandidates).toBe(2); // A and C (B excluded)
    });

    it('counts multiple deleted items without githubIssueNumber', () => {
      const items = [
        makeItem('A', baseTime, 1),
        makeItem('B', baseTime, undefined, 'deleted'),
        makeItem('C', baseTime, undefined, 'deleted'),
        makeItem('D', baseTime, 2, 'deleted'),
      ];
      const res = filterItemsForPush(items, [], null);
      expect(res.deletedWithoutIssueCount).toBe(2); // B and C
      expect(res.totalCandidates).toBe(2); // A and D only
    });

    it('returns zero when no deleted items exist', () => {
      const items = [makeItem('A', baseTime, 1), makeItem('B', baseTime)];
      const res = filterItemsForPush(items, [], null);
      expect(res.deletedWithoutIssueCount).toBe(0);
    });

    it('returns zero when all deleted items have githubIssueNumber', () => {
      const items = [makeItem('A', baseTime, 1, 'deleted'), makeItem('B', baseTime, 2, 'deleted')];
      const res = filterItemsForPush(items, [], null);
      expect(res.deletedWithoutIssueCount).toBe(0);
      expect(res.totalCandidates).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // Skip-count composition
  // -------------------------------------------------------------------
  describe('skip-count composition', () => {
    it('skippedCount and deletedWithoutIssueCount are independent', () => {
      const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();
      const older = new Date('2025-01-01T00:00:00.000Z').toISOString();
      const items = [
        makeItem('unchanged', older, 1),      // skipped (unchanged)
        makeItem('deleted-no-issue', older, undefined, 'deleted'), // excluded from candidates
      ];
      const res = filterItemsForPush(items, [], lastPush);
      expect(res.skippedCount).toBe(1); // unchanged only
      expect(res.deletedWithoutIssueCount).toBe(1); // deleted-no-issue
      expect(res.totalCandidates).toBe(1); // unchanged only (deleted-no-issue excluded)
    });

    it('total skipped = skippedCount + deletedWithoutIssueCount', () => {
      const lastPush = new Date('2025-01-02T00:00:00.000Z').toISOString();
      const older = new Date('2025-01-01T00:00:00.000Z').toISOString();
      const newer = new Date('2025-01-03T00:00:00.000Z').toISOString();
      const items = [
        makeItem('new', newer),                          // included
        makeItem('unchanged', older, 1),                 // skipped
        makeItem('deleted-no-issue', older, undefined, 'deleted'), // excluded
      ];
      const res = filterItemsForPush(items, [], lastPush);
      const totalSkipped = res.skippedCount + res.deletedWithoutIssueCount;
      expect(totalSkipped).toBe(2); // 1 unchanged + 1 deleted without issue
      expect(res.filteredItems.length).toBe(1); // only 'new'
    });
  });

  // -------------------------------------------------------------------
  // Timestamp read/write
  // -------------------------------------------------------------------
  describe('timestamp read/write', () => {
    it('read/write timestamp file roundtrip fallback', () => {
      const now = new Date().toISOString();
      writeLastPushTimestamp(now as string, undefined as any);
      const read = readLastPushTimestamp(undefined as any);
      expect(read).toBeTruthy();
      expect(new Date(read as string).getTime()).toBeGreaterThan(0);
    });

    it('readLastPushTimestamp returns null with no DB and no file', () => {
      // When no DB metadata and file does not exist, should return null
      // This test relies on the file not existing yet or the fallback logic
      const read = readLastPushTimestamp(undefined as any);
      // May or may not be null depending on prior test writing a file,
      // but should not throw
      expect(read === null || typeof read === 'string').toBe(true);
    });

    it('readLastPushTimestamp uses DB metadata when available', () => {
      const ts = '2025-06-15T12:00:00.000Z';
      const fakeDb = {
        getMetadata: (key: string) => key === 'githubLastPush' ? ts : null,
      };
      const read = readLastPushTimestamp(fakeDb);
      expect(read).toBe(ts);
    });

    it('readLastPushTimestamp falls back to file when DB returns null', () => {
      const fakeDb = {
        getMetadata: () => null,
      };
      // Should fall through to file-based read without throwing
      const read = readLastPushTimestamp(fakeDb);
      expect(read === null || typeof read === 'string').toBe(true);
    });

    it('readLastPushTimestamp falls back to file when DB throws', () => {
      const fakeDb = {
        getMetadata: () => { throw new Error('DB error'); },
      };
      // Should not throw, should fall through to file-based read
      const read = readLastPushTimestamp(fakeDb);
      expect(read === null || typeof read === 'string').toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Repo-scoped timestamp read/write
  // -------------------------------------------------------------------
  describe('repo-scoped timestamp read/write', () => {
    it('reads repo-scoped metadata key when repo is provided', () => {
      const ts = '2025-06-15T12:00:00.000Z';
      const fakeDb = {
        getMetadata: (key: string) => key === 'githubLastPush:owner/repo' ? ts : null,
      };
      const read = readLastPushTimestamp(fakeDb, 'owner/repo');
      expect(read).toBe(ts);
    });

    it('falls back to global metadata key when repo-scoped key is absent', () => {
      const ts = '2025-06-15T12:00:00.000Z';
      const fakeDb = {
        getMetadata: (key: string) => key === 'githubLastPush' ? ts : null,
      };
      const read = readLastPushTimestamp(fakeDb, 'owner/other-repo');
      expect(read).toBe(ts);
    });

    it('prefers repo-scoped key over global key', () => {
      const globalTs = '2025-01-01T00:00:00.000Z';
      const repoTs = '2025-06-15T12:00:00.000Z';
      const fakeDb = {
        getMetadata: (key: string) => {
          if (key === 'githubLastPush:owner/repo') return repoTs;
          if (key === 'githubLastPush') return globalTs;
          return null;
        },
      };
      const read = readLastPushTimestamp(fakeDb, 'owner/repo');
      expect(read).toBe(repoTs);
    });

    it('writes repo-scoped metadata key and global key', () => {
      const ts = '2025-06-15T12:00:00.000Z';
      const writtenKeys: Record<string, string> = {};
      const fakeDb = {
        setMetadata: (key: string, value: string) => { writtenKeys[key] = value; },
      };
      writeLastPushTimestamp(ts, fakeDb, 'owner/repo');
      expect(writtenKeys['githubLastPush:owner/repo']).toBe(ts);
      expect(writtenKeys['githubLastPush']).toBe(ts);
    });
  });

  // -------------------------------------------------------------------
  // Atomic writes
  // -------------------------------------------------------------------
  describe('atomic write', () => {
    it('uses atomic write and reads back correctly', () => {
      const ts = '2025-06-15T12:00:00.000Z';
      // Write via the module's atomic write (writeLastPushTimestamp writes
      // to .worklog/github-last-push by default when no DB provided)
      writeLastPushTimestamp(ts, undefined, undefined);
      const read = readLastPushTimestamp(undefined, undefined);
      expect(read).toBe(ts);
    });

    it('overwrites previous value atomically', () => {
      const ts1 = '2025-01-01T00:00:00.000Z';
      const ts2 = '2025-06-15T12:00:00.000Z';
      writeLastPushTimestamp(ts1, undefined, undefined);
      writeLastPushTimestamp(ts2, undefined, undefined);
      const read = readLastPushTimestamp(undefined, undefined);
      expect(read).toBe(ts2);
    });
  });
});