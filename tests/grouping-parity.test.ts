/**
 * tests/grouping-parity.test.ts — Core/Herdr grouping parity gate
 * (WL-0MWMQ6AV6007ZUNK, child WL-0MWMRG3HL007PDZ6).
 *
 * `wl next --groups` (src/commands/grouping.ts) and the Herdr worklist
 * (packages/herdr/src/grouping.ts) are two hand-synchronised copies of the
 * same grouping algorithm: the plugin has zero npm dependencies and cannot
 * import from src/commands/. This test is the consistency gate that keeps the
 * copies honest — it feeds one shared fixture through both `assignItemGroups`
 * implementations and asserts identical `{ group, groupLabel }` maps.
 *
 * The fixture deliberately spans every display section of the band-first
 * contract (WL-0MWMQ6AV6007ZUNK):
 *
 * - all four priority bands (`critical`, `high`, `medium`, `low`),
 * - the global `In Review` section (including a critical-priority member, to
 *   pin that the review queue never becomes a priority band of its own),
 * - a same-band Key-File collision (two `critical` items sharing a file),
 * - a band-crossing Key-File share (`high` vs `medium` — the conflict must be
 *   evaluated per band, so it must NOT split groups across bands),
 * - an item with no Key Files (restricted singleton group),
 * - an actively-worked item (`status === 'in-progress'`, which drives the
 *   intra-band sub-order) and an unknown stage (band `Other` safety net).
 *
 * A parity assertion alone would also pass if both copies were equally wrong,
 * so the second test pins the expected labels and band order explicitly.
 */

import { describe, it, expect } from 'vitest';
import { assignItemGroups as assignCoreGroups } from '../src/commands/grouping.js';
import { assignItemGroups as assignHerdrGroups } from '../packages/herdr/src/grouping.js';

type FixtureItem = {
  id: string;
  stage?: string;
  status?: string;
  priority?: string;
  filePaths: string[];
};

/** Shared fixture: one item set spanning every band-first section. */
const SHARED_FIXTURE: FixtureItem[] = [
  // ── Critical band ──────────────────────────────────────────────────
  // Same-band Key-File collision: these two must land in separate groups.
  { id: 'WL-CRIT-1', stage: 'plan_complete', filePaths: ['src/crit-a.ts'], priority: 'critical' },
  { id: 'WL-CRIT-2', stage: 'plan_complete', filePaths: ['src/crit-a.ts'], priority: 'critical' },

  // ── High band ──────────────────────────────────────────────────────
  { id: 'WL-HIGH-PLAN', stage: 'plan_complete', filePaths: ['src/shared.ts'], priority: 'high' },
  { id: 'WL-HIGH-ACTIVE', stage: 'plan_complete', status: 'in-progress', filePaths: ['src/active.ts'], priority: 'high' },
  // No Key Files at all → still grouped, with an empty path set.
  { id: 'WL-HIGH-NOFILES', stage: 'plan_complete', filePaths: [], priority: 'high' },
  { id: 'WL-HIGH-IDEA', stage: 'idea', filePaths: [], priority: 'high' },

  // ── Medium band ────────────────────────────────────────────────────
  // Shares `src/shared.ts` with a high item: conflicts are per band, so this
  // must not push either item into another group.
  { id: 'WL-MED-INTAKE', stage: 'intake_complete', filePaths: ['src/shared.ts'], priority: 'medium' },
  { id: 'WL-MED-OTHER', stage: 'custom', filePaths: [], priority: 'medium' },

  // ── Low band ───────────────────────────────────────────────────────
  { id: 'WL-LOW-PLAN', stage: 'plan_complete', filePaths: ['src/low.ts'], priority: 'low' },
  { id: 'WL-LOW-IDEA', stage: 'idea', filePaths: [], priority: 'low' },

  // ── In Review (global, pinned last) ────────────────────────────────
  { id: 'WL-REVIEW-HIGH', stage: 'in_review', filePaths: [], priority: 'high' },
  // A critical in_review item belongs to the review section, not the
  // critical band.
  { id: 'WL-REVIEW-CRIT', stage: 'in_review', filePaths: [], priority: 'critical' },
];

describe('core/herdr grouping parity (WL-0MWMQ6AV6007ZUNK)', () => {
  it('assignItemGroups produces identical { group, groupLabel } maps for the shared fixture', () => {
    const core = assignCoreGroups(SHARED_FIXTURE, 3);
    const herdr = assignHerdrGroups(SHARED_FIXTURE, 3);

    // Both copies must label every fixture item (no silent omissions).
    expect(core.size, 'core assigns every item').toBe(SHARED_FIXTURE.length);
    expect(herdr.size, 'herdr assigns every item').toBe(SHARED_FIXTURE.length);
    expect(core).toEqual(herdr);

    // Same check with a non-default file-path group limit: the band loop and
    // the per-band label counters must stay in step for any `-g` value.
    expect(assignCoreGroups(SHARED_FIXTURE, 1)).toEqual(assignHerdrGroups(SHARED_FIXTURE, 1));
    expect(assignCoreGroups(SHARED_FIXTURE, 5)).toEqual(assignHerdrGroups(SHARED_FIXTURE, 5));
  });

  it('both copies render the band-first section order and band labels', () => {
    const groups = assignCoreGroups(SHARED_FIXTURE, 3);
    const label = (id: string): string => groups.get(id)!.groupLabel;
    const groupOf = (id: string): number => groups.get(id)!.group;

    // Section labels: <Band> Group N / <Band> Idea / <Band> Other, with the
    // per-band label counter restarting at 1.
    expect(label('WL-CRIT-1')).toBe('Critical Group 1');
    expect(label('WL-CRIT-2')).toBe('Critical Group 2');
    expect(label('WL-HIGH-PLAN')).toBe('High Group 1');
    expect(label('WL-HIGH-ACTIVE')).toBe('High Group 1');
    expect(label('WL-HIGH-IDEA')).toBe('High Idea');
    expect(label('WL-MED-INTAKE')).toBe('Medium Group 1');
    expect(label('WL-MED-OTHER')).toBe('Medium Other');
    expect(label('WL-LOW-PLAN')).toBe('Low Group 1');
    expect(label('WL-LOW-IDEA')).toBe('Low Idea');
    expect(label('WL-REVIEW-HIGH')).toBe('In Review');
    expect(label('WL-REVIEW-CRIT')).toBe('In Review');

    // Band order: critical → high → medium → low → In Review.
    const critMax = Math.max(groupOf('WL-CRIT-1'), groupOf('WL-CRIT-2'));
    const highMax = Math.max(
      groupOf('WL-HIGH-PLAN'),
      groupOf('WL-HIGH-ACTIVE'),
      groupOf('WL-HIGH-NOFILES'),
      groupOf('WL-HIGH-IDEA'),
    );
    const medMax = Math.max(groupOf('WL-MED-INTAKE'), groupOf('WL-MED-OTHER'));
    const lowMax = Math.max(groupOf('WL-LOW-PLAN'), groupOf('WL-LOW-IDEA'));
    expect(critMax, 'the critical band precedes the high band').toBeLessThan(groupOf('WL-HIGH-PLAN'));
    expect(highMax, 'the high band precedes the medium band').toBeLessThan(groupOf('WL-MED-INTAKE'));
    expect(medMax, 'the medium band precedes the low band').toBeLessThan(groupOf('WL-LOW-PLAN'));
    expect(lowMax, 'the low band precedes the In Review section').toBeLessThan(groupOf('WL-REVIEW-HIGH'));
    expect(groupOf('WL-REVIEW-HIGH'), 'In Review is a single section').toBe(groupOf('WL-REVIEW-CRIT'));

    // Same-band conflict split; the band-crossing `src/shared.ts` share does
    // NOT split (both items stay in their band's single Group N section).
    expect(groupOf('WL-CRIT-1'), 'a same-band Key-File share splits groups').not.toBe(groupOf('WL-CRIT-2'));
    expect(label('WL-HIGH-PLAN'), 'the cross-band share leaves the high band unsplit').toBe('High Group 1');
    expect(label('WL-MED-INTAKE'), 'the cross-band share leaves the medium band unsplit').toBe('Medium Group 1');
    // The no-Key-Files item gets its own restricted singleton group.
    expect(label('WL-HIGH-NOFILES')).toBe('High Group 2');
  });

  it('both copies agree on the intra-band stage sub-order, in-progress first', () => {
    // One band, one item per stage sub-section — ids deliberately sort against
    // the expected order so a pure id tie-break cannot satisfy the assertion.
    const fixture: FixtureItem[] = [
      { id: 'a-other', stage: 'custom', filePaths: [], priority: 'high' },
      { id: 'z-idea', stage: 'idea', filePaths: [], priority: 'high' },
      { id: 'c-intake', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'b-plan', stage: 'plan_complete', filePaths: [], priority: 'high' },
      { id: 'a-active', stage: 'plan_complete', status: 'in-progress', filePaths: [], priority: 'high' },
    ];
    for (const assign of [assignCoreGroups, assignHerdrGroups]) {
      const groups = assign(fixture, 3);
      // Each sub-section is its own group in this fixture (plan/active share
      // the Group N section but a no-Key-Files item is a restricted singleton).
      const order = [...groups.entries()]
        .sort((x, y) => x[1].group - y[1].group)
        .map(([id]) => id);
      expect(order).toEqual(['a-active', 'b-plan', 'c-intake', 'z-idea', 'a-other']);
    }
  });
});
