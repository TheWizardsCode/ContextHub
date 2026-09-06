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
  extractFilePaths,
  inReviewBucket,
  compareInReviewItems,
  type GroupableItem,
} from './grouping.js';
import type { WorkItem } from './fetcher.js';

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
      { id: 'WL-IP1', stage: 'in_progress', filePaths: ['src/ip1.ts'], priority: 'high' },
      { id: 'WL-idea', stage: 'idea', filePaths: [], priority: 'low' },
      { id: 'WL-other', stage: 'custom', filePaths: [], priority: 'medium' },
      { id: 'WL-R1', stage: 'in_review', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    const groupOf = (id: string): number => groups.get(id)!.group;
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
    // Plan/intake/in_progress items share Group N (no stage prefix in the label).
    expect(groups.get('WL-P1')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-I1')!.groupLabel).toBe('Group 1');
    expect(groups.get('WL-IP1')!.groupLabel).toBe('Group 1');
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

  it('sorts within a group by stage sub-order then priority', () => {
    const items: GroupableItem[] = [
      { id: 'I-low', stage: 'intake_complete', filePaths: [], priority: 'low' },
      { id: 'P-med', stage: 'plan_complete', filePaths: [], priority: 'medium' },
      { id: 'I-high', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'P-high', stage: 'plan_complete', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['P-high', 'P-med', 'I-high', 'I-low']);
  });

  it('never places canonical stages in "Other" (in_progress joins Group N)', () => {
    const items: GroupableItem[] = [
      { id: 'WL-idea', stage: 'idea', filePaths: ['src/idea.ts'], priority: 'medium' },
      { id: 'WL-intake', stage: 'intake_complete', filePaths: ['src/intake.ts'], priority: 'medium' },
      { id: 'WL-plan', stage: 'plan_complete', filePaths: ['src/plan.ts'], priority: 'medium' },
      { id: 'WL-progress', stage: 'in_progress', filePaths: ['src/progress.ts'], priority: 'medium' },
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

  it('sorts in_progress items first within a group (stage sub-order)', () => {
    const items: GroupableItem[] = [
      { id: 'I-low', stage: 'intake_complete', filePaths: [], priority: 'low' },
      { id: 'IP-high', stage: 'in_progress', filePaths: [], priority: 'high' },
      { id: 'P-med', stage: 'plan_complete', filePaths: [], priority: 'medium' },
      { id: 'IP-low', stage: 'in_progress', filePaths: [], priority: 'low' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['IP-high', 'IP-low', 'P-med', 'I-low']);
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
  // isAuditFresh(auditedAt, updatedAt) → auditedAt > updatedAt - 60s
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
});

