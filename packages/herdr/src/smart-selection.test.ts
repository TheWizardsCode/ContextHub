/**
 * Unit tests for selectWorkItems — the smart selection algorithm that
 * guarantees all critical, in_review and actively-worked in-progress items
 * are always shown in the Herdr worklist regardless of the browseItemCount
 * setting.
 *
 * The selection function is intentionally duplicated per TUI (decision Q2c
 * in WL-0MS8W5LTW006YZ4B); the Pi TUI extension copy was removed by
 * WL-0MSGI7PV9004UD0N, so this is the only remaining suite.
 *
 * Run: npx vitest run packages/herdr/src/smart-selection.test.ts
 */

import { describe, it, expect } from 'vitest';
import { selectWorkItems, isMandatoryItem } from './smart-selection.js';
import type { WorkItem } from './fetcher.js';

/**
 * Build a minimal WorkItem for testing.
 */
function makeItem(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
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
const critical = (id: string): WorkItem => makeItem(id, { priority: 'critical' });
const inReview = (id: string): WorkItem => makeItem(id, { status: 'completed', stage: 'in_review' });
/** in_review item being re-worked after review feedback (status = in-progress). */
const inProgressInReview = (id: string): WorkItem => makeItem(id, { status: 'in-progress', stage: 'in_review' });
/** Item that is BOTH critical and completed/in_review (overlap case). */
const criticalInReview = (id: string): WorkItem => makeItem(id, { priority: 'critical', status: 'completed', stage: 'in_review' });
/** Item that is BOTH critical and in-progress/in_review (overlap case). */
const criticalInProgressInReview = (id: string): WorkItem => makeItem(id, { priority: 'critical', status: 'in-progress', stage: 'in_review' });
/** Actively-worked item (status = in-progress) at a non-in_review stage. */
const active = (id: string, overrides: Partial<WorkItem> = {}): WorkItem => makeItem(id, { status: 'in-progress', stage: 'plan_complete', ...overrides });
/** Blocked item (status = blocked) at a non-done stage — always shown (WL-0MV71WBHB007D8ZE). */
const blocked = (id: string, overrides: Partial<WorkItem> = {}): WorkItem => makeItem(id, { status: 'blocked', stage: 'plan_complete', ...overrides });
const other = (id: string): WorkItem => makeItem(id, { priority: 'medium', status: 'open', stage: 'idea' });
/** Item whose stage is 'done' (fully closed — must never appear in the default list). */
const done = (id: string, overrides: Partial<WorkItem> = {}): WorkItem => makeItem(id, { stage: 'done', status: 'completed', ...overrides });

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

  describe('in-progress/in_review items — mandatory review set (WL-0MV6JGVPH009YDXB)', () => {
    it('keeps an in-progress/in_review item in the guaranteed set even when it exceeds browseItemCount', () => {
      const items = [
        inReview('R1'),
        inProgressInReview('RP1'),
        ...Array.from({ length: 25 }, (_, i) => other(`O${i + 1}`)),
      ];

      // browseItemCount=3: 2 mandatory reviews (completed + in-progress) + 1 other.
      const result = selectWorkItems(items, 3);

      expect(result).toHaveLength(3);
      expect(result.map(i => i.id)).toEqual(['R1', 'RP1', 'O1']);
    });

    it('in-progress/in_review items are never demoted to the capped others bucket', () => {
      const items = [
        inProgressInReview('RP1'),
        ...Array.from({ length: 20 }, (_, i) => other(`O${i + 1}`)),
      ];

      // browseItemCount=1: the in-progress/in_review item is mandatory and
      // must still show, consuming the slot before any other.
      const result = selectWorkItems(items, 1);

      expect(result.map(i => i.id)).toEqual(['RP1']);
    });

    it('an in-progress/in_review item alone exceeds browseItemCount without a cap', () => {
      const items = Array.from({ length: 10 }, (_, i) => inProgressInReview(`RP${i + 1}`));

      const result = selectWorkItems(items, 3);

      expect(result).toHaveLength(10);
      expect(result.every(i => i.status === 'in-progress' && i.stage === 'in_review')).toBe(true);
    });

    it('overlap critical ∩ in-progress/in_review → item counts once (deduplicated)', () => {
      const items = [
        criticalInProgressInReview('BOTH1'),
        other('O1'),
        other('O2'),
        other('O3'),
        other('O4'),
        other('O5'),
      ];

      // browseItemCount=5: mandatory set = 1 (BOTH1 counts once), so 4 others shown.
      const result = selectWorkItems(items, 5);

      expect(result).toHaveLength(5);
      const mandatory = result.filter(i =>
        i.priority === 'critical' ||
        (i.stage === 'in_review' && (i.status === 'completed' || i.status === 'in-progress')),
      );
      expect(mandatory).toHaveLength(1);
      expect(result.map(i => i.id)).toEqual(['BOTH1', 'O1', 'O2', 'O3', 'O4']);
    });

    it('mixed completed + in-progress in_review items share one guaranteed review set', () => {
      const items = [
        inReview('R1'),
        inProgressInReview('RP1'),
        other('O1'),
        other('O2'),
      ];

      // browseItemCount=2: both review items are mandatory, zero others shown.
      const result = selectWorkItems(items, 2);

      expect(result.map(i => i.id)).toEqual(['R1', 'RP1']);
    });
  });

  describe('actively-worked in-progress items — mandatory set (WL-0MV6KV22S004NYIU)', () => {
    it('keeps an actively-worked item visible when the review queue saturates browseItemCount', () => {
      // Exactly the reported symptom: 22 root in_review items vs
      // browseItemCount=20 leaves zero slots for "others" — the in-progress
      // item must still be shown.
      const items = [
        ...Array.from({ length: 22 }, (_, i) => inReview(`R${i + 1}`)),
        active('A1'),
        other('O1'),
      ];

      const result = selectWorkItems(items, 20);

      expect(result.map(i => i.id)).toContain('A1');
      // 22 reviews + 1 active = 23 mandatory; the "other" is cut.
      expect(result).toHaveLength(23);
      expect(result.map(i => i.id)).not.toContain('O1');
    });

    it('treats in-progress at any non-done stage as mandatory', () => {
      const items = [
        active('A-idea', { stage: 'idea' }),
        active('A-intake', { stage: 'intake_complete' }),
        active('A-plan', { stage: 'plan_complete' }),
        other('O1'),
      ];

      // browseItemCount=1: all three active items are mandatory, zero others.
      const result = selectWorkItems(items, 1);

      expect(result.map(i => i.id)).toEqual(['A-idea', 'A-intake', 'A-plan']);
    });

    it('overlap in-progress ∩ in_review → item counts once (active, not double-counted)', () => {
      const items = [inProgressInReview('RP1'), other('O1'), other('O2')];

      const result = selectWorkItems(items, 3);

      expect(result.map(i => i.id)).toEqual(['RP1', 'O1', 'O2']);
      expect(result.filter(i => i.id === 'RP1')).toHaveLength(1);
    });

    it('overlap critical ∩ in-progress → item counts once (critical, not double-counted)', () => {
      const items = [
        makeItem('BOTH1', { priority: 'critical', status: 'in-progress', stage: 'plan_complete' }),
        other('O1'),
        other('O2'),
      ];

      const result = selectWorkItems(items, 3);

      expect(result.map(i => i.id)).toEqual(['BOTH1', 'O1', 'O2']);
      expect(result.filter(i => i.id === 'BOTH1')).toHaveLength(1);
    });

    it('orders criticals, then reviews, then actively-worked, then others', () => {
      const items = [other('O1'), active('A1'), inReview('R1'), critical('C1'), other('O2')];

      const result = selectWorkItems(items, 10);

      expect(result.map(i => i.id)).toEqual(['C1', 'R1', 'A1', 'O1', 'O2']);
    });

    it('hides a non-critical child in-progress item (root-only rule still applies)', () => {
      const items = [
        active('A1'),
        makeItem('ChildActive', { status: 'in-progress', stage: 'plan_complete', parentId: 'A1' }),
        other('O1'),
      ];

      const result = selectWorkItems(items, 10);

      expect(result.map(i => i.id)).toEqual(['A1', 'O1']);
    });

    it('excludes an in-progress item whose stage is done (done gate applies first)', () => {
      const items = [makeItem('D-IP', { status: 'in-progress', stage: 'done' }), other('O1')];

      const result = selectWorkItems(items, 10);

      expect(result.map(i => i.id)).toEqual(['O1']);
    });
  });

  describe('isMandatoryItem — mandatory-set predicate', () => {
    it('is true for critical, completed/in_review, in-progress, and blocked at any stage', () => {
      expect(isMandatoryItem(makeItem('C', { priority: 'critical', stage: 'idea' }))).toBe(true);
      expect(isMandatoryItem(makeItem('R', { status: 'completed', stage: 'in_review' }))).toBe(true);
      expect(isMandatoryItem(makeItem('A', { status: 'in-progress', stage: 'plan_complete' }))).toBe(true);
      expect(isMandatoryItem(makeItem('AI', { status: 'in-progress', stage: 'idea' }))).toBe(true);
      expect(isMandatoryItem(makeItem('B', { status: 'blocked', stage: 'in_review' }))).toBe(true);
      expect(isMandatoryItem(makeItem('B2', { status: 'blocked', stage: 'intake_complete' }))).toBe(true);
    });

    it('is false for an untouched open item', () => {
      expect(isMandatoryItem(makeItem('O', { status: 'open', stage: 'idea' }))).toBe(false);
      expect(isMandatoryItem(makeItem('O2', { status: 'open', stage: 'plan_complete' }))).toBe(false);
    });
  });

  describe('blocked items — mandatory set (WL-0MV71WBHB007D8ZE)', () => {
    it('keeps a blocked in_review item visible when it ranks below browseItemCount', () => {
      // The operator-visible symptom: WL-0MTF5WO1N0088P5P (status=blocked,
      // stage=in_review) ranked ~35 of 52, so `wl next -n 20` never returned
      // it and the default list hid a release-blocking item entirely.
      const items = [
        ...Array.from({ length: 25 }, (_, i) => other(`O${i + 1}`)),
        blocked('BLK1', { stage: 'in_review' }),
      ];

      const result = selectWorkItems(items, 20);

      expect(result.map((i) => i.id)).toContain('BLK1');
      // The blocked item consumes a mandatory slot — it must not be cut even
      // though it appears after 25 other items in the input.
      expect(result.filter((i) => i.id === 'BLK1')).toHaveLength(1);
    });

    it('blocked item survives a tiny browseItemCount when others saturate the window', () => {
      const items = [...Array.from({ length: 5 }, (_, i) => other(`O${i + 1}`)), blocked('BLK1')];

      // browseItemCount=1: the blocked item is mandatory and must show
      // instead of being demoted to the capped others bucket.
      const result = selectWorkItems(items, 1);

      expect(result.map((i) => i.id)).toEqual(['BLK1']);
    });

    it('orders criticals, then reviews, then blocked, then actively-worked, then others', () => {
      const items = [other('O1'), active('A1'), blocked('B1'), inReview('R1'), critical('C1'), other('O2')];

      const result = selectWorkItems(items, 10);

      expect(result.map((i) => i.id)).toEqual(['C1', 'R1', 'B1', 'A1', 'O1', 'O2']);
    });

    it('a blocked child item stays hidden (root-only rule for non-critical children)', () => {
      const items = [
        blocked('B1'),
        makeItem('ChildBlocked', { status: 'blocked', stage: 'idea', parentId: 'B1' }),
        other('O1'),
      ];

      const result = selectWorkItems(items, 10);

      expect(result.map((i) => i.id)).toEqual(['B1', 'O1']);
    });

    it('excludes a blocked item whose stage is done (done gate applies first)', () => {
      const items = [blocked('B1', { stage: 'done' }), other('O1')];

      const result = selectWorkItems(items, 10);

      expect(result.map((i) => i.id)).toEqual(['O1']);
    });

    it('a blocked item does not consume an others slot when the window is full', () => {
      // browseItemCount=2: mandatory = 1 blocked, so 1 other shown — the
      // blocked item is NOT charged to the others budget.
      const items = [other('O1'), other('O2'), other('O3'), blocked('B1')];

      const result = selectWorkItems(items, 2);

      expect(result.map((i) => i.id)).toEqual(['B1', 'O1']);
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

  describe('done-stage exclusion (WL-0MS94VAII00054L9)', () => {
    it('excludes a stage=done item from the returned list entirely', () => {
      const items = [done('D1'), other('O1')];
      const result = selectWorkItems(items, 10);
      expect(result.map(i => i.id)).toEqual(['O1']);
    });

    it('excludes a stage=done item even when it is priority=critical', () => {
      const items = [done('DC1', { priority: 'critical' }), critical('C1'), other('O1')];
      const result = selectWorkItems(items, 10);
      expect(result.map(i => i.id)).toEqual(['C1', 'O1']);
    });

    it('excludes a stage=done item even when it is status=completed (closed item)', () => {
      const items = [done('DC1'), inReview('R1'), other('O1')];
      const result = selectWorkItems(items, 10);
      expect(result.map(i => i.id)).toEqual(['R1', 'O1']);
    });

    it('a stage=done item does not consume a browseItemCount slot', () => {
      const items = [done('D1'), other('O1'), other('O2'), other('O3'), other('O4'), other('O5')];
      // browseItemCount=5: the done item must not count, so 5 others fill the list.
      const result = selectWorkItems(items, 5);
      expect(result).toHaveLength(5);
      expect(result.map(i => i.id)).toEqual(['O1', 'O2', 'O3', 'O4', 'O5']);
    });

    it('returns an empty list when all items are stage=done', () => {
      const items = [done('D1'), done('D2'), done('D3')];
      expect(selectWorkItems(items, 10)).toEqual([]);
    });

    it('still shows all mandatory non-done items when done items are interleaved', () => {
      const items = [
        critical('C1'),
        done('D1'),
        inReview('R1'),
        done('D2', { priority: 'critical' }),
        other('O1'),
        other('O2'),
      ];
      // browseItemCount=2: mandatory (C1, R1) = 2 → zero others; done items never appear.
      const result = selectWorkItems(items, 2);
      expect(result.map(i => i.id)).toEqual(['C1', 'R1']);
    });

    it('hides non-critical child items from the selection list (WL-0MS964SIA0057ABR)', () => {
      const items = [
        critical('C1'),
        inReview('R1'),
        other('O1'),
        // Non-critical children are hidden from the top-level list.
        makeItem('ChildReview', { status: 'completed', stage: 'in_review', parentId: 'R1' }),
        makeItem('ChildOther', { parentId: 'O1' }),
      ];
      const result = selectWorkItems(items, 10);
      const ids = result.map(i => i.id);
      expect(ids).toEqual(['C1', 'R1', 'O1']);
    });

    // Root-only top level for ALL items, critical included (WL-0MVN4WESM007T4XI).
    // The critical exception (commit cae8ea8a) is superseded: a critical child is
    // reachable through its root ancestor (substituted in the fetcher), never as
    // a duplicate top-level row.
    //
    // RED WITNESS: the current root filter still carries the
    // `|| i.priority === 'critical'` exception, so this spec is committed as
    // `it.fails`; the implementation feature (WL-0MVN4WESM007T4XI-F2) removes the
    // exception and flips it to `it` (same test-first convention as
    // WL-0MVFE0T0M009ZCPM).
    it.fails('hides a child critical item (parentId set) even when priority=critical', () => {
      const items = [
        critical('C1'),
        inReview('R1'),
        other('O1'),
        // A critical child must NOT be rendered at top level despite its priority.
        makeItem('ChildCritical', { priority: 'critical', parentId: 'C1' }),
        // Non-critical children stay hidden too.
        makeItem('ChildReview', { status: 'completed', stage: 'in_review', parentId: 'R1' }),
        makeItem('ChildOther', { parentId: 'O1' }),
      ];
      const result = selectWorkItems(items, 10);
      const ids = result.map(i => i.id);
      expect(ids).toEqual(['C1', 'R1', 'O1']);
      // Invariant, stated directly: the returned top level contains roots only.
      expect(result.every(i => !i.parentId)).toBe(true);
    });

    // RED WITNESS (same as above): hiding must hold even when the root ancestor
    // is absent from the input — the child is never a fallback top-level row.
    it.fails('hides a critical child even when its root ancestor is absent from the input', () => {
      const items = [
        other('O1'),
        other('O2'),
        makeItem('OrphanChildCritical', { priority: 'critical', parentId: 'MissingRoot' }),
      ];
      const result = selectWorkItems(items, 10);
      expect(result.map(i => i.id)).toEqual(['O1', 'O2']);
    });

    it('keeps a critical root item (no parentId) mandatory regardless of browseItemCount', () => {
      // A critical ROOT is the release-blocking signal the top level must always
      // surface: it is mandatory, so no browseItemCount window may cut it.
      const items = [critical('C1'), other('O1'), other('O2'), other('O3')];

      // browseItemCount=1: the single slot goes to the mandatory critical root.
      expect(selectWorkItems(items, 1).map(i => i.id)).toEqual(['C1']);
      // browseItemCount=0: mandatory items are still shown (no hard cap).
      expect(selectWorkItems(items, 0).map(i => i.id)).toEqual(['C1']);
      // browseItemCount large enough: the critical root is present as before.
      expect(selectWorkItems(items, 10).map(i => i.id)).toEqual(['C1', 'O1', 'O2', 'O3']);
    });
  });
});
