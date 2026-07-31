/**
 * Unit tests for selectWorkItems — the smart selection algorithm that
 * guarantees all critical and completed/in_review items are always shown
 * in the Pi TUI Worklog extension selection list regardless of the
 * browseItemCount setting.
 *
 * The selection function is intentionally duplicated per TUI (decision Q2c
 * in WL-0MS8W5LTW006YZ4B); this suite mirrors the Herdr plugin suite.
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/lib/smart-selection.test.ts
 */

import { describe, it, expect } from 'vitest';
import { selectWorkItems } from './smart-selection.js';
import type { WorklogBrowseItem } from './tools.js';

/**
 * Build a minimal WorklogBrowseItem for testing.
 */
function makeItem(id: string, overrides: Partial<WorklogBrowseItem> = {}): WorklogBrowseItem {
  return {
    id,
    title: `Item ${id}`,
    status: 'open',
    priority: 'medium',
    stage: 'idea',
    ...overrides,
  };
}

/** Convenience builders for the mandatory-set criteria. */
const critical = (id: string): WorklogBrowseItem => makeItem(id, { priority: 'critical' });
const inReview = (id: string): WorklogBrowseItem => makeItem(id, { status: 'completed', stage: 'in_review' });
/** Item that is BOTH critical and completed/in_review (overlap case). */
const criticalInReview = (id: string): WorklogBrowseItem => makeItem(id, { priority: 'critical', status: 'completed', stage: 'in_review' });
const other = (id: string): WorklogBrowseItem => makeItem(id, { priority: 'medium', status: 'open', stage: 'idea' });

describe('selectWorkItems — smart selection algorithm', () => {
  it('returns a new array and does not mutate the input (pure & deterministic)', () => {
    const input = [critical('C1'), other('O1'), inReview('R1')];
    const snapshot = JSON.stringify(input);

    const result = selectWorkItems(input, 10);

    expect(result).not.toBe(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(selectWorkItems(input, 10)).toEqual(result);
  });

  describe('reference example 1 — browseItemCount=15, 2 critical + 3 in_review + 10 others', () => {
    it('returns exactly 15 items (2 mandatory-critical + 3 mandatory-review + 10 others)', () => {
      const items = [
        critical('C1'),
        critical('C2'),
        inReview('R1'),
        inReview('R2'),
        inReview('R3'),
        ...Array.from({ length: 20 }, (_, i) => other(`O${i + 1}`)),
      ];

      const result = selectWorkItems(items, 15);

      expect(result).toHaveLength(15);
      expect(result.filter(i => i.priority === 'critical')).toHaveLength(2);
      expect(result.filter(i => i.status === 'completed' && i.stage === 'in_review')).toHaveLength(3);
      expect(result.filter(i => i.priority !== 'critical' && !(i.status === 'completed' && i.stage === 'in_review'))).toHaveLength(10);
      // The 10 "other" items are the first 10 of the input's 20 others.
      expect(result.map(i => i.id)).toEqual([
        'C1', 'C2', 'R1', 'R2', 'R3', 'O1', 'O2', 'O3', 'O4', 'O5',
        'O6', 'O7', 'O8', 'O9', 'O10',
      ]);
    });
  });

  describe('reference example 2 — browseItemCount=15, 2 critical + 20 in_review', () => {
    it('returns all 22 items (total exceeds the setting; no hard cap on mandatory set)', () => {
      const items = [
        critical('C1'),
        critical('C2'),
        ...Array.from({ length: 20 }, (_, i) => inReview(`R${i + 1}`)),
      ];

      const result = selectWorkItems(items, 15);

      expect(result).toHaveLength(22);
      expect(result.filter(i => i.priority === 'critical')).toHaveLength(2);
      expect(result.filter(i => i.status === 'completed' && i.stage === 'in_review')).toHaveLength(20);
    });
  });

  describe('edge cases', () => {
    it('empty mandatory set → behaves like plain top-N (others.slice(0, browseItemCount))', () => {
      const items = Array.from({ length: 25 }, (_, i) => other(`O${i + 1}`));

      const result = selectWorkItems(items, 10);

      expect(result).toHaveLength(10);
      expect(result.map(i => i.id)).toEqual(
        Array.from({ length: 10 }, (_, i) => `O${i + 1}`),
      );
    });

    it('overlap critical ∩ completed/in_review → item counts once (deduplicated)', () => {
      const items = [
        criticalInReview('BOTH1'),
        other('O1'),
        other('O2'),
        other('O3'),
        other('O4'),
        other('O5'),
      ];

      // browseItemCount=5: mandatory set = 1 (BOTH1 counts once), so 4 others shown.
      const result = selectWorkItems(items, 5);

      expect(result).toHaveLength(5);
      expect(result.filter(i => i.priority === 'critical' || (i.status === 'completed' && i.stage === 'in_review'))).toHaveLength(1);
      expect(result.map(i => i.id)).toEqual(['BOTH1', 'O1', 'O2', 'O3', 'O4']);
    });

    it('mandatory-only exceeding the cap → all mandatory items shown, zero others', () => {
      const items = [
        critical('C1'),
        critical('C2'),
        critical('C3'),
        inReview('R1'),
        inReview('R2'),
        other('O1'),
        other('O2'),
      ];

      // browseItemCount=3: 5 mandatory (3 critical + 2 in_review) exceed the cap
      // → all 5 shown in full, zero others (no hard cap on mandatory set).
      const result = selectWorkItems(items, 3);

      expect(result).toHaveLength(5);
      expect(result.every(i => i.priority === 'critical' || (i.status === 'completed' && i.stage === 'in_review'))).toBe(true);
      expect(result.map(i => i.id)).toEqual(['C1', 'C2', 'C3', 'R1', 'R2']);
    });

    it('slots floor at zero → othersLimit = max(0, browseItemCount - mandatory.length) never negative', () => {
      const items = [
        critical('C1'),
        critical('C2'),
        critical('C3'),
        critical('C4'),
        inReview('R1'),
        inReview('R2'),
        inReview('R3'),
        other('O1'),
      ];

      // browseItemCount=2: mandatory (7) exceeds the cap → all 7 shown, 0 others.
      const result = selectWorkItems(items, 2);

      expect(result).toHaveLength(7);
      expect(result.filter(i => i.priority !== 'critical' && !(i.status === 'completed' && i.stage === 'in_review'))).toHaveLength(0);
    });

    it('handles empty input array', () => {
      expect(selectWorkItems([], 10)).toEqual([]);
    });

    it('handles browseItemCount of 0 → mandatory items only', () => {
      const items = [critical('C1'), inReview('R1'), other('O1')];
      const result = selectWorkItems(items, 0);
      expect(result.map(i => i.id)).toEqual(['C1', 'R1']);
    });
  });

  describe('ordering assertion', () => {
    it('mandatory items first (critical group, then completed/in_review), others retain input order', () => {
      // Deliberately interleaved input: others, review, others, critical, others.
      const items = [
        other('O1'),
        inReview('R1'),
        other('O2'),
        critical('C1'),
        other('O3'),
        inReview('R2'),
        other('O4'),
      ];

      const result = selectWorkItems(items, 10);

      // Critical group first, then completed/in_review group.
      expect(result.slice(0, 1).map(i => i.id)).toEqual(['C1']);
      expect(result.slice(1, 3).map(i => i.id)).toEqual(['R1', 'R2']);
      // Others retain original relative order.
      expect(result.slice(3).map(i => i.id)).toEqual(['O1', 'O2', 'O3', 'O4']);
    });
  });
});
