/**
 * Unit tests for packages/herdr/src/grouping.ts — the duplicated grouping
 * algorithm applied to the merged (selected) worklist.
 *
 * The grouping algorithm is intentionally duplicated per TUI (decision Q2c
 * in WL-0MS8W5LTW006YZ4B) because Herdr has zero npm dependencies and cannot
 * import from src/commands/. This suite mirrors the core grouping-utility
 * tests plus the merged-list regression for the duplicate "In Review"
 * sections bug (WL-0MSAK8YLB0025EGW).
 *
 * Run: npx vitest run packages/herdr/src/grouping.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  assignItemGroups,
  regroupWorkItems,
  compareGroupableItems,
  compareGroupingContentKey,
  groupItemsByFilePaths,
  extractFilePaths,
  inReviewBucket,
  compareInReviewItems,
  type GroupableItem,
} from './grouping.js';
import type { WorkItem } from './fetcher.js';

/** Every ordering of `items` (all permutations) — used by the stability tests. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([item, ...tail]);
  });
  return result;
}

/**
 * Build a minimal WorkItem.
 */
function makeItem(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Item ${id}`,
    status: 'open',
    priority: 'medium',
    stage: 'idea',
    description: `**Key Files:**\n- \`src/${id.toLowerCase()}.ts\``,
    ...overrides,
  };
}

describe('grouping.ts — duplicated algorithm mirrors core spec', () => {
  it('produces the canonical group order: Critical Group N → Group N → Idea → Other → In Review', () => {
    const items: GroupableItem[] = [
      { id: 'WL-C1', stage: 'plan_complete', filePaths: ['src/c.ts'], priority: 'critical' },
      { id: 'WL-P1', stage: 'plan_complete', filePaths: ['src/p1.ts'], priority: 'high' },
      { id: 'WL-I1', stage: 'intake_complete', filePaths: ['src/i1.ts'], priority: 'medium' },
      { id: 'WL-idea', stage: 'idea', filePaths: [], priority: 'low' },
      { id: 'WL-other', stage: 'custom', filePaths: [], priority: 'medium' },
      { id: 'WL-R1', stage: 'in_review', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    const groupOf = (id: string): number => groups.get(id)!.group;
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
    // Plan/intake items share Group N (no stage prefix in the label).
    expect(groups.get('WL-P1')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-I1')!.groupLabel).toBe('Group 1');
    expect(groupOf('WL-C1')).toBeLessThan(groupOf('WL-P1'));
    expect(groupOf('WL-P1')).toBeLessThan(groupOf('WL-idea'));
    expect(groupOf('WL-idea')).toBeLessThan(groupOf('WL-other'));
    expect(groupOf('WL-other')).toBeLessThan(groupOf('WL-R1'));
    expect(groups.get('WL-R1')!.groupLabel).toBe('In Review');
  });

  it('partitions critical items into Critical Group N by file-path conflicts', () => {
    const items: GroupableItem[] = [
      { id: 'WL-C1', stage: 'plan_complete', filePaths: ['src/foo.ts'], priority: 'critical' },
      { id: 'WL-C2', stage: 'plan_complete', filePaths: ['src/foo.ts'], priority: 'critical' },
      { id: 'WL-C3', stage: 'idea', filePaths: [], priority: 'critical' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
    expect(groups.get('WL-C2')!.groupLabel).toBe('Critical Group 2');
    expect(groups.get('WL-C3')!.groupLabel).toBe('Critical Group 3');
    for (const [, assignment] of groups) {
      expect(assignment.groupLabel).not.toBe('Critical');
    }
  });

  it('sorts within a group by priority first, then stage sub-order (WL-0MVVLBTTP003Y4XO)', () => {
    // Priority became the primary key: every high item ranks ahead of every
    // medium item, which ranks ahead of every low item. The stage sub-order is
    // the secondary key (it decides ties inside a priority band).
    const items: GroupableItem[] = [
      { id: 'I-low', stage: 'intake_complete', filePaths: [], priority: 'low' },
      { id: 'P-med', stage: 'plan_complete', filePaths: [], priority: 'medium' },
      { id: 'I-high', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'P-high', stage: 'plan_complete', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['P-high', 'I-high', 'P-med', 'I-low']);
  });

  it('never places canonical stages in "Other" (plan_complete + intake_complete join Group N)', () => {
    const items: GroupableItem[] = [
      { id: 'WL-idea', stage: 'idea', filePaths: ['src/idea.ts'], priority: 'medium' },
      { id: 'WL-intake', stage: 'intake_complete', filePaths: ['src/intake.ts'], priority: 'medium' },
      { id: 'WL-plan', stage: 'plan_complete', filePaths: ['src/plan.ts'], priority: 'medium' },
      { id: 'WL-review', stage: 'in_review', filePaths: ['src/review.ts'], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    for (const [, assignment] of groups) {
      expect(assignment.groupLabel).not.toBe('Other');
    }
    // Unknown/custom stages still fall back to "Other" as the safety net.
    const unknown = assignItemGroups([{ id: 'WL-x', stage: 'custom', filePaths: [], priority: 'medium' }], 3);
    expect(unknown.get('WL-x')!.groupLabel).toBe('Other');
  });

  it('breaks a same-priority tie by stage sub-order (plan_complete before intake_complete)', () => {
    const items: GroupableItem[] = [
      { id: 'I-high', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'P-high', stage: 'plan_complete', filePaths: [], priority: 'high' },
      { id: 'I-low', stage: 'intake_complete', filePaths: [], priority: 'low' },
      { id: 'P-low', stage: 'plan_complete', filePaths: [], priority: 'low' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['P-high', 'I-high', 'P-low', 'I-low']);
  });

  it('places actively-worked items (status in-progress) in Group N (WL-0MUY1CSQG007TCYX)', () => {
    const items: GroupableItem[] = [
      { id: 'WL-active', status: 'in-progress', stage: 'plan_complete', filePaths: ['src/active.ts'], priority: 'medium' },
      { id: 'WL-idea', stage: 'idea', filePaths: ['src/idea.ts'], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-active')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-idea')!.groupLabel).toBe('Idea');
    expect(groups.get('WL-active')!.group).toBeLessThan(groups.get('WL-idea')!.group);
  });

  it('sorts actively-worked items before plan_complete and intake_complete within the same priority band', () => {
    const items: GroupableItem[] = [
      { id: 'WL-intake', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'WL-plan', stage: 'plan_complete', filePaths: [], priority: 'high' },
      { id: 'WL-active', status: 'in-progress', stage: 'plan_complete', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    // Priority first (WL-0MVVLBTTP003Y4XO): inside the same priority band the
    // actively-worked sub-order still leads.
    expect(sorted.map(i => i.id)).toEqual(['WL-active', 'WL-plan', 'WL-intake']);
  });

  it('does not let the actively-worked sub-order outrank a higher priority (WL-0MVVLBTTP003Y4XO)', () => {
    const items: GroupableItem[] = [
      { id: 'WL-active-low', status: 'in-progress', stage: 'plan_complete', filePaths: [], priority: 'low' },
      { id: 'WL-plan-high', stage: 'plan_complete', filePaths: [], priority: 'high' },
      { id: 'WL-plan-med', stage: 'plan_complete', filePaths: [], priority: 'medium' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['WL-plan-high', 'WL-plan-med', 'WL-active-low']);
  });

  it('treats the removed in_progress stage as Other (fail-soft legacy rows)', () => {
    const groups = assignItemGroups(
      [{ id: 'WL-legacy', stage: 'in_progress', filePaths: ['src/legacy.ts'], priority: 'medium' }],
      3,
    );
    expect(groups.get('WL-legacy')!.groupLabel).toBe('Other');
  });
});

describe('grouping stability — content-deterministic grouping (WL-0MVVLBTTP003Y4XO)', () => {
  /**
   * A set whose greedy first-fit packing genuinely depends on the input order
   * when it is *not* canonicalised: with A→x, B→x+y, C→y, feeding A,B,C puts
   * A and C together in group 1, while feeding B,A,C puts A and C together in
   * group 2. Canonicalisation must erase that difference.
   */
  const conflictSet: GroupableItem[] = [
    { id: 'WL-A', stage: 'plan_complete', filePaths: ['src/x.ts'], priority: 'medium' },
    { id: 'WL-B', stage: 'plan_complete', filePaths: ['src/x.ts', 'src/y.ts'], priority: 'medium' },
    { id: 'WL-C', stage: 'plan_complete', filePaths: ['src/y.ts'], priority: 'medium' },
  ];

  it('packs the same item set into the same groups for every input order', () => {
    const reference = groupItemsByFilePaths(conflictSet, 3);
    expect(reference.get('WL-A')).toBe(1);
    expect(reference.get('WL-B')).toBe(2);
    expect(reference.get('WL-C')).toBe(1);
    for (const permuted of permutations(conflictSet)) {
      expect(groupItemsByFilePaths(permuted, 3)).toEqual(reference);
    }
  });

  it('assignItemGroups assigns identical groups and labels for every input order', () => {
    const items: GroupableItem[] = [
      ...conflictSet,
      { id: 'WL-D', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'WL-E', stage: 'idea', filePaths: ['src/z.ts'], priority: 'low' },
      { id: 'WL-F', stage: 'plan_complete', filePaths: ['src/x.ts'], priority: 'critical' },
      { id: 'WL-G', stage: 'in_review', filePaths: [], priority: 'medium' },
    ];
    const reference = assignItemGroups(items, 3);
    for (const permuted of permutations(items)) {
      const got = assignItemGroups(permuted, 3);
      expect(got.size).toBe(reference.size);
      for (const [id, assignment] of reference) {
        expect(got.get(id)).toEqual(assignment);
      }
    }
  });

  it('never changes group membership when only updatedAt changes (comment/audit churn)', () => {
    const reference = assignItemGroups(conflictSet, 3);
    const churned = conflictSet.map((item, index) => ({
      ...item,
      // A stationary item can gain a comment or an audit result at any time.
      updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      auditedAt: index % 2 === 0 ? `2026-01-0${index + 1}T00:00:00.000Z` : null,
      auditResult: index % 2 === 0,
    }));
    expect(assignItemGroups(churned, 3)).toEqual(reference);
  });

  it('regroupWorkItems renders the same order for every input order and updatedAt set', () => {
    const merged: WorkItem[] = [
      makeItem('WL-NEXT-1', { stage: 'plan_complete', priority: 'high' }),
      makeItem('WL-ACTIVE', { stage: 'plan_complete', priority: 'high', status: 'in-progress' }),
      makeItem('WL-NEXT-2', { stage: 'intake_complete', priority: 'low' }),
      makeItem('WL-REVIEW', { stage: 'in_review', priority: 'medium' }),
      makeItem('WL-IDEA', { stage: 'idea', priority: 'low' }),
    ];
    const render = (items: WorkItem[]): string[] =>
      regroupWorkItems(items, 3).map(i => `${i.id}|${i.group}|${i.groupLabel}`);
    const reference = render(merged);
    for (const permuted of permutations(merged)) {
      const churned = permuted.map((item, index) => ({
        ...item,
        updatedAt: `2026-02-1${index}T00:00:00.000Z`,
      }));
      expect(render(churned)).toEqual(reference);
    }
  });

  it('moves an item between groups only when a material input changes (key files)', () => {
    const before: GroupableItem[] = [
      { id: 'WL-A', stage: 'plan_complete', filePaths: ['src/x.ts'], priority: 'medium' },
      { id: 'WL-B', stage: 'plan_complete', filePaths: ['src/y.ts'], priority: 'medium' },
    ];
    expect(assignItemGroups(before, 3).get('WL-B')!.groupLabel).toBe('Group 1');
    const after = before.map(item =>
      item.id === 'WL-B' ? { ...item, filePaths: ['src/x.ts'] } : item,
    );
    expect(assignItemGroups(after, 3).get('WL-B')!.groupLabel).toBe('Group 2');
  });

  it('moves an item into the Critical group when its priority becomes critical (material change)', () => {
    const before: GroupableItem[] = [
      { id: 'WL-A', stage: 'plan_complete', filePaths: ['src/x.ts'], priority: 'high' },
    ];
    expect(assignItemGroups(before, 3).get('WL-A')!.groupLabel).toBe('Group 1');
    const after = before.map(item => ({ ...item, priority: 'critical' }));
    expect(assignItemGroups(after, 3).get('WL-A')!.groupLabel).toBe('Critical Group 1');
  });

  it('compareGroupingContentKey is a pure function of priority, stage sub-order and id', () => {
    const base: GroupableItem = {
      id: 'WL-A',
      stage: 'plan_complete',
      filePaths: [],
      priority: 'high',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    // Same content, different timestamps → equal keys (timestamps are not an input).
    expect(compareGroupingContentKey(base, { ...base, updatedAt: '2030-01-01T00:00:00.000Z' })).toBe(0);
    // Priority dominates stage.
    expect(
      compareGroupingContentKey(
        { ...base, id: 'WL-Z', priority: 'high', stage: 'intake_complete' },
        { ...base, id: 'WL-A', priority: 'medium', stage: 'plan_complete' },
      ),
    ).toBeLessThan(0);
    // Stage sub-order breaks a same-priority tie.
    expect(
      compareGroupingContentKey(
        { ...base, id: 'WL-Z', stage: 'plan_complete' },
        { ...base, id: 'WL-A', stage: 'intake_complete' },
      ),
    ).toBeLessThan(0);
    // Id breaks a full tie.
    expect(
      compareGroupingContentKey({ ...base, id: 'WL-A' }, { ...base, id: 'WL-B' }),
    ).toBeLessThan(0);
  });
});

describe('regroupWorkItems — merged-list regression (WL-0MSAK8YLB0025EGW)', () => {
  it('assigns group metadata to every displayed item (mandatory wl list items included)', () => {
    // Simulated merged list: wl next items carry group metadata, mandatory
    // wl list items (critical + completed/in_review) do NOT.
    const merged: WorkItem[] = [
      // From wl next — already grouped by the CLI.
      makeItem('WL-NEXT-1', { stage: 'plan_complete', priority: 'high', group: 2, groupLabel: 'Group 1' }),
      makeItem('WL-NEXT-2', { stage: 'in_review', priority: 'medium', status: 'in-progress', group: 5, groupLabel: 'In Review' }),
      // From wl list (mandatory subset) — NO group metadata.
      makeItem('WL-LIST-CRIT', { stage: 'intake_complete', priority: 'critical' }),
      makeItem('WL-LIST-REV', { stage: 'in_review', priority: 'medium', status: 'completed' }),
    ];

    const regrouped = regroupWorkItems(merged, 3);

    // Every item receives a group assignment.
    for (const item of regrouped) {
      expect(item.group).toBeDefined();
      expect(item.groupLabel).toBeDefined();
    }

    // The merged mandatory in_review items (one non-completed from wl next,
    // one completed from wl list) land in the SAME "In Review" group.
    const inReviewItems = regrouped.filter(i => i.id === 'WL-NEXT-2' || i.id === 'WL-LIST-REV');
    expect(inReviewItems.every(i => i.groupLabel === 'In Review')).toBe(true);
    expect(inReviewItems[0].group).toBe(inReviewItems[1].group);
    // Exactly one distinct In Review group number exists.
    expect(new Set(regrouped.filter(i => i.groupLabel === 'In Review').map(i => i.group)).size).toBe(1);
  });

  it('regression: merged list renders exactly one In Review section, positioned after Other', () => {
    const merged: WorkItem[] = [
      // wl next results (grouped) — including a non-completed in_review item
      // that previously fell into the "others" bucket while carrying its
      // "In Review" group label, producing a second In Review section.
      makeItem('WL-NEXT-PLAN', { stage: 'plan_complete', priority: 'high', group: 2, groupLabel: 'Group 1' }),
      makeItem('WL-NEXT-REVIEW', { stage: 'in_review', priority: 'medium', status: 'in-progress', group: 5, groupLabel: 'In Review' }),
      makeItem('WL-NEXT-OTHER', { stage: 'custom', priority: 'medium', group: 3, groupLabel: 'Other' }),
      // Mandatory wl list subsets (no group metadata).
      makeItem('WL-LIST-CRIT', { stage: 'plan_complete', priority: 'critical' }),
      makeItem('WL-LIST-REV', { stage: 'in_review', priority: 'medium', status: 'completed' }),
    ];

    const regrouped = regroupWorkItems(merged, 3);

    // Simulate the renderer: separator lines are emitted when the group
    // number changes between consecutive items.
    const renderedSections: string[] = [];
    let lastGroup: number | undefined;
    for (const item of regrouped) {
      if (item.group !== undefined) {
        if (lastGroup === undefined || item.group !== lastGroup) {
          renderedSections.push(item.groupLabel!);
        }
        lastGroup = item.group;
      }
    }

    // Exactly one "In Review" section.
    const inReviewCount = renderedSections.filter(s => s === 'In Review').length;
    expect(inReviewCount).toBe(1);
    // "In Review" is the LAST section (after Other).
    expect(renderedSections[renderedSections.length - 1]).toBe('In Review');
    const otherIndex = renderedSections.indexOf('Other');
    expect(otherIndex).toBeGreaterThan(-1);
    expect(renderedSections.indexOf('In Review')).toBeGreaterThan(otherIndex);
    // No duplicate section headings at all.
    expect(new Set(renderedSections).size).toBe(renderedSections.length);
  });

  it('preserves every item across regroup (no filtering) — mandatory guarantee intact', () => {
    const merged: WorkItem[] = [
      makeItem('WL-A', { stage: 'plan_complete', priority: 'high' }),
      makeItem('WL-B', { stage: 'in_review', priority: 'medium', status: 'completed' }),
      makeItem('WL-C', { stage: 'idea', priority: 'low' }),
    ];
    const regrouped = regroupWorkItems(merged, 3);
    expect(regrouped.map(i => i.id).sort()).toEqual(['WL-A', 'WL-B', 'WL-C']);
  });

  it('orders the regrouped list by group then within-group order', () => {
    const merged: WorkItem[] = [
      makeItem('WL-I-low', { stage: 'intake_complete', priority: 'low' }),
      makeItem('WL-P-med', { stage: 'plan_complete', priority: 'medium' }),
      makeItem('WL-idea', { stage: 'idea', priority: 'low' }),
      makeItem('WL-R', { stage: 'in_review', priority: 'medium' }),
    ];
    const regrouped = regroupWorkItems(merged, 3);
    // plan_complete before intake_complete inside Group 1; Idea; In Review last.
    const order = regrouped.map(i => i.id);
    expect(order.indexOf('WL-P-med')).toBeLessThan(order.indexOf('WL-I-low'));
    expect(order.indexOf('WL-I-low')).toBeLessThan(order.indexOf('WL-idea'));
    expect(order.indexOf('WL-idea')).toBeLessThan(order.indexOf('WL-R'));
  });

  it('treats status=in-progress as Group N and orders it by priority within the group (WL-0MUY1CSQG007TCYX, WL-0MVVLBTTP003Y4XO)', () => {
    const merged: WorkItem[] = [
      makeItem('WL-plan', { stage: 'plan_complete', priority: 'high' }),
      makeItem('WL-active', { stage: 'plan_complete', priority: 'low', status: 'in-progress' }),
      makeItem('WL-idea', { stage: 'idea', priority: 'low' }),
    ];
    const regrouped = regroupWorkItems(merged, 3);
    expect(regrouped.find(i => i.id === 'WL-active')!.groupLabel).toBe('Group 1');
    expect(regrouped.find(i => i.id === 'WL-plan')!.groupLabel).toBe('Group 1');
    // Priority is the primary within-group key, so the high plan item leads the
    // low actively-worked one; the actively-worked sub-order only decides ties.
    expect(regrouped[0].id).toBe('WL-plan');
  });

  it('orders a same-priority Group N by the actively-worked sub-order first', () => {
    const merged: WorkItem[] = [
      makeItem('WL-plan', { stage: 'plan_complete', priority: 'high' }),
      makeItem('WL-active', { stage: 'plan_complete', priority: 'high', status: 'in-progress' }),
      makeItem('WL-idea', { stage: 'idea', priority: 'low' }),
    ];
    const regrouped = regroupWorkItems(merged, 3);
    expect(regrouped[0].id).toBe('WL-active');
    expect(regrouped[1].id).toBe('WL-plan');
  });
});

describe('extractFilePaths (duplicated)', () => {
  it('extracts paths from a **Key Files:** section', () => {
    const description = `## Summary\nDo the thing.\n\n**Key Files:**\n- \`src/commands/next.ts\`\n- \`docs/CLI.md\``;
    expect(extractFilePaths(description)).toEqual(['src/commands/next.ts', 'docs/CLI.md']);
  });

  it('returns an empty array when no Key Files section exists', () => {
    expect(extractFilePaths('Just a description.')).toEqual([]);
  });
});

describe('in_review 6-bucket sort (WL-0MSLPM5ZB003TADT)', () => {
  // isAuditFresh(auditedAt, updatedAt): auditedAt within
  // AUDIT_FRESHNESS_AT_NEAR_TOLERANCE_MS of updatedAt → fresh
  // So auditedAt === updatedAt is fresh; auditedAt 10m before updatedAt is stale.
  const updatedAt = '2026-01-10T10:00:00.000Z';
  const freshAuditedAt = '2026-01-10T10:00:00.000Z'; // same instant → fresh
  const staleAuditedAt = '2026-01-10T09:40:00.000Z'; // 20m earlier → stale

  function inReviewItem(id: string, overrides: Partial<GroupableItem> = {}): GroupableItem {
    return { id, stage: 'in_review', filePaths: [], priority: 'medium', ...overrides } as GroupableItem;
  }

  it('orders the six buckets: needsProducerReview → failed fresh → failed stale → no audit → passed stale → passed fresh', () => {
    const items: GroupableItem[] = [
      inReviewItem('WL-passed-fresh', { auditResult: true, auditedAt: freshAuditedAt, updatedAt }),
      inReviewItem('WL-passed-stale', { auditResult: true, auditedAt: staleAuditedAt, updatedAt }),
      inReviewItem('WL-no-audit', { auditResult: null, auditedAt: null, updatedAt }),
      inReviewItem('WL-failed-stale', { auditResult: false, auditedAt: staleAuditedAt, updatedAt }),
      inReviewItem('WL-failed-fresh', { auditResult: false, auditedAt: freshAuditedAt, updatedAt }),
      inReviewItem('WL-needs-producer', { needsProducerReview: true, auditResult: false, auditedAt: freshAuditedAt, updatedAt }),
    ];
    // Shuffle then sort
    const shuffled = [items[0], items[3], items[1], items[5], items[2], items[4]];
    const sorted = shuffled.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual([
      'WL-needs-producer',
      'WL-failed-fresh',
      'WL-failed-stale',
      'WL-no-audit',
      'WL-passed-stale',
      'WL-passed-fresh',
    ]);
  });

  it('needsProducerReview wins regardless of audit state', () => {
    const a = inReviewItem('WL-a', { needsProducerReview: true, auditResult: true, auditedAt: freshAuditedAt, updatedAt });
    const b = inReviewItem('WL-b', { auditResult: false, auditedAt: freshAuditedAt, updatedAt });
    expect(compareGroupableItems(a, b)).toBeLessThan(0);
    expect(compareGroupableItems(b, a)).toBeGreaterThan(0);
  });

  it('within the same bucket orders by priority high → medium → low', () => {
    const items: GroupableItem[] = [
      inReviewItem('WL-low', { priority: 'low', auditResult: null }),
      inReviewItem('WL-high', { priority: 'high', auditResult: null }),
      inReviewItem('WL-med', { priority: 'medium', auditResult: null }),
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['WL-high', 'WL-med', 'WL-low']);
  });

  it('within same bucket and priority orders by updatedAt older first', () => {
    const items: GroupableItem[] = [
      inReviewItem('WL-newer', { auditResult: null, updatedAt: '2026-01-10T12:00:00.000Z' }),
      inReviewItem('WL-older', { auditResult: null, updatedAt: '2026-01-10T08:00:00.000Z' }),
      inReviewItem('WL-mid', { auditResult: null, updatedAt: '2026-01-10T10:00:00.000Z' }),
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['WL-older', 'WL-mid', 'WL-newer']);
  });

  it('uses id as deterministic tie-break when bucket, priority, and timestamp are equal', () => {
    const items: GroupableItem[] = [
      inReviewItem('WL-b', { auditResult: null, updatedAt }),
      inReviewItem('WL-a', { auditResult: null, updatedAt }),
      inReviewItem('WL-c', { auditResult: null, updatedAt }),
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['WL-a', 'WL-b', 'WL-c']);
  });

  it('does not apply bucket sort to non-in_review items', () => {
    const a: GroupableItem = { id: 'WL-a', stage: 'plan_complete', filePaths: [], priority: 'medium', needsProducerReview: true } as any;
    const b: GroupableItem = { id: 'WL-b', stage: 'plan_complete', filePaths: [], priority: 'medium' } as any;
    // Both are plan_complete, so needsProducerReview is irrelevant — ordering is by id
    expect(compareGroupableItems(a, b)).toBeLessThan(0); // WL-a < WL-b lexicographically
  });

  it('regroupWorkItems respects bucket order within the In Review section', () => {
    const merged: WorkItem[] = [
      makeItem('WL-passed-fresh', { stage: 'in_review', priority: 'medium', auditResult: true, auditedAt: freshAuditedAt, updatedAt }),
      makeItem('WL-no-audit', { stage: 'in_review', priority: 'medium', auditResult: null, auditedAt: null as any, updatedAt }),
      makeItem('WL-failed-fresh', { stage: 'in_review', priority: 'medium', auditResult: false, auditedAt: freshAuditedAt, updatedAt }),
      makeItem('WL-needs-producer', { stage: 'in_review', priority: 'medium', needsProducerReview: true, auditResult: null, updatedAt }),
      makeItem('WL-other', { stage: 'custom', priority: 'medium' }),
    ];
    const regrouped = regroupWorkItems(merged, 3);
    const inReviewOrder = regrouped.filter(i => i.stage === 'in_review').map(i => i.id);
    expect(inReviewOrder).toEqual([
      'WL-needs-producer',
      'WL-failed-fresh',
      'WL-no-audit',
      'WL-passed-fresh',
    ]);
  });

  it('fingerprint match keeps a passed audit fresh (bucket 6) despite stale-looking updatedAt (AC4/AC7)', () => {
    const fingerprint = 'sha256-match';
    // auditedAt is 20m before updatedAt (would be stale by the time gate),
    // but the stored and current fingerprints match → fresh.
    const item = inReviewItem('WL-fingerprint-fresh', {
      auditResult: true,
      auditedAt: staleAuditedAt,
      updatedAt,
      fingerprint,
      currentFingerprint: fingerprint,
    });
    expect(inReviewBucket(item)).toBe(6);
  });

  it('fingerprint mismatch marks a passed audit stale (bucket 5) even when timestamps are close (AC5/AC7)', () => {
    const item = inReviewItem('WL-fingerprint-stale', {
      auditResult: true,
      auditedAt: freshAuditedAt,
      updatedAt,
      fingerprint: 'sha256-old',
      currentFingerprint: 'sha256-new',
    });
    expect(inReviewBucket(item)).toBe(5);
  });

  it('regroupWorkItems honours fingerprint freshness so a fingerprint-fresh item is not ranked behind a lower-priority one (WL-0MUWDW0N6003KF6G)', () => {
    // Regression: regroupWorkItems used to drop `fingerprint`/`currentFingerprint`
    // when building its sort comparator. The medium item below is fresh by the
    // primary content gate (fingerprints match) but stale by the 60s time gate;
    // without the fingerprint fields it was classified bucket 5 (passed-stale)
    // while the high item was bucket 6 (passed-fresh), so the medium appeared
    // BEFORE the high. With the fingerprint fields forwarded, both land in
    // bucket 6 and priority decides (high first).
    const fingerprint = 'sha256-match';
    const merged: WorkItem[] = [
      makeItem('WL-medium-fp-fresh', {
        stage: 'in_review',
        priority: 'medium',
        auditResult: true,
        auditedAt: staleAuditedAt,
        updatedAt,
        fingerprint,
        currentFingerprint: fingerprint,
      }),
      makeItem('WL-high-time-fresh', {
        stage: 'in_review',
        priority: 'high',
        auditResult: true,
        auditedAt: updatedAt,
        updatedAt,
      }),
    ];

    const inReviewOrder = regroupWorkItems(merged, 3)
      .filter((i) => i.stage === 'in_review')
      .map((i) => i.id);

    expect(inReviewOrder).toEqual(['WL-high-time-fresh', 'WL-medium-fp-fresh']);
  });

  it('regroupWorkItems keeps a fingerprint-mismatch item in bucket 5 but priority still dominates a passed-fresh item (WL-0MUWDW0N6003KF6G)', () => {
    // A medium item whose stored/current fingerprints disagree is stale even
    // though its timestamps look fresh (bucket 5). Priority is the primary
    // sort key (WL-0MUWDW0N6003KF6G): the high passed-fresh item (bucket 6)
    // must still rank first; the bucket only orders items within the same
    // priority band.
    const merged: WorkItem[] = [
      makeItem('WL-high-time-fresh', {
        stage: 'in_review',
        priority: 'high',
        auditResult: true,
        auditedAt: freshAuditedAt,
        updatedAt,
      }),
      makeItem('WL-medium-fp-stale', {
        stage: 'in_review',
        priority: 'medium',
        auditResult: true,
        auditedAt: freshAuditedAt,
        updatedAt,
        fingerprint: 'sha256-old',
        currentFingerprint: 'sha256-new',
      }),
    ];

    // Sanity: the mismatch is still classified as bucket 5.
    expect(inReviewBucket(merged[1])).toBe(5);

    const inReviewOrder = regroupWorkItems(merged, 3)
      .filter((i) => i.stage === 'in_review')
      .map((i) => i.id);

    expect(inReviewOrder).toEqual(['WL-high-time-fresh', 'WL-medium-fp-stale']);
  });

  it('ranks a high no-audit item ahead of a medium failed-audit item (WL-0MUWDW0N6003KF6G)', () => {
    // Regression for the producer-reported symptom: a medium-priority item
    // with a failed (stale) audit was ranking ahead of a high-priority item
    // with no audit because the audit bucket was the primary sort key. With
    // priority primary the high item must lead, and the two medium items are
    // then ordered by their bucket (failed-stale 3 before no-audit 4).
    const merged: WorkItem[] = [
      makeItem('WL-medium-no-audit', {
        stage: 'in_review',
        priority: 'medium',
        auditResult: null,
        auditedAt: null as unknown as string,
        updatedAt,
      }),
      makeItem('WL-medium-failed-stale', {
        stage: 'in_review',
        priority: 'medium',
        auditResult: false,
        auditedAt: staleAuditedAt,
        updatedAt,
      }),
      makeItem('WL-high-no-audit', {
        stage: 'in_review',
        priority: 'high',
        auditResult: null,
        auditedAt: null as unknown as string,
        updatedAt,
      }),
    ];

    const inReviewOrder = regroupWorkItems(merged, 3)
      .filter((i) => i.stage === 'in_review')
      .map((i) => i.id);

    expect(inReviewOrder).toEqual([
      'WL-high-no-audit',
      'WL-medium-failed-stale',
      'WL-medium-no-audit',
    ]);
  });
});

