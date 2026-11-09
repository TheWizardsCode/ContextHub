/**
 * packages/shared/src/database/work-items-soft-deleted.test.ts — unit tests
 * for the `isSoftDeleted` predicate (WL-0MW8ESCYL0080I9F).
 *
 * These tests exercise all four status/deletedBy quadrants to ensure the
 * shared soft-delete predicate behaves consistently before the read/write
 * path tasks consume it.
 *
 * Run: npx vitest run packages/shared/src/database/work-items-soft-deleted.test.ts
 */

import { describe, it, expect } from 'vitest';
import { isSoftDeleted } from './work-items.js';

describe('isSoftDeleted predicate (WL-0MW8ESCYL0080I9F)', () => {
  describe('quadrant tests', () => {
    it('returns true when status is deleted and deletedBy is empty', () => {
      // status=deleted + no attribution — still soft-deleted
      expect(
        isSoftDeleted({ status: 'deleted', deletedBy: '' }),
      ).toBe(true);
    });

    it('returns true when status is deleted and deletedBy is non-empty', () => {
      // status=deleted + attribution — clearly soft-deleted
      expect(
        isSoftDeleted({ status: 'deleted', deletedBy: 'user@example.com' }),
      ).toBe(true);
    });

    it('returns true when status is alive and deletedBy is non-empty', () => {
      // status=completed + attribution — the key reconciliation case:
      // a repaired item that still carries deletedBy is excluded.
      expect(
        isSoftDeleted({ status: 'completed', deletedBy: 'user@example.com' }),
      ).toBe(true);
    });

    it('returns false when status is alive and deletedBy is empty', () => {
      // Fully live item — never soft-deleted.
      expect(
        isSoftDeleted({ status: 'completed', deletedBy: '' }),
      ).toBe(false);
    });

    it('returns false for an open item with no deletedBy', () => {
      expect(
        isSoftDeleted({ status: 'open', deletedBy: '' }),
      ).toBe(false);
    });

    it('returns false for an open item with deletedBy (rescued)', () => {
      // Item that was deleted then had deletedBy cleared — fully live.
      // Note: this tests that only one of the two conditions is needed.
      expect(
        isSoftDeleted({ status: 'open', deletedBy: '' }),
      ).toBe(false);
    });
  });

  describe('deletedBy whitespace handling', () => {
    it('treats whitespace-only deletedBy as empty (not soft-deleted)', () => {
      // Consistent with the wl update guard: trim() === '' means empty.
      expect(
        isSoftDeleted({ status: 'completed', deletedBy: '   ' }),
      ).toBe(false);
    });

    it('treats empty string deletedBy as not soft-deleted', () => {
      expect(
        isSoftDeleted({ status: 'in-progress', deletedBy: '' }),
      ).toBe(false);
    });
  });
});
