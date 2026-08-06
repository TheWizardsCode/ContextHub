/**
 * Unit tests for packages/herdr/src/grouping.ts — the duplicated grouping
 * algorithm applied to the merged (selected) worklist.
 *
 * The grouping algorithm is intentionally duplicated per TUI (decision Q2c
 * in WL-0MS8W5LTW006YZ4B) because Herdr has zero npm dependencies and cannot
 * import from src/commands/. This suite covers the priority-first group
 * ordering (Critical → High → Medium → Low, with stage ordering within each
 * bucket) introduced by WL-0MSI1LVTJ001M9EY, plus the merged-list regression
 * for duplicate section headings (WL-0MSAK8YLB0025EGW).
 *
 * Run: npx vitest run packages/herdr/src/grouping.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  assignItemGroups,
  regroupWorkItems,
  compareGroupableItems,
  extractFilePaths,
  type GroupableItem,
} from './grouping.js';
import { selectWorkItems } from './smart-selection.js';
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

describe('grouping.ts — priority-first group order (WL-0MSI1LVTJ001M9EY)', () => {
  it('produces the canonical group order: Critical → High → Medium → Low priority buckets', () => {
    const items: GroupableItem[] = [
      { id: 'WL-C1', stage: 'plan_complete', filePaths: ['src/c.ts'], priority: 'critical' },
      { id: 'WL-P1', stage: 'plan_complete', filePaths: ['src/p1.ts'], priority: 'high' },
      { id: 'WL-I1', stage: 'intake_complete', filePaths: ['src/i1.ts'], priority: 'medium' },
      { id: 'WL-idea', stage: 'idea', filePaths: [], priority: 'low' },
      { id: 'WL-other', stage: 'in_progress', filePaths: [], priority: 'medium' },
      { id: 'WL-R1', stage: 'in_review', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    const groupOf = (id: string): number => groups.get(id)!.group;
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical');
    expect(groups.get('WL-P1')!.groupLabel).toBe('High');
    expect(groups.get('WL-I1')!.groupLabel).toBe('Medium');
    expect(groups.get('WL-idea')!.groupLabel).toBe('Low');
    expect(groupOf('WL-C1')).toBeLessThan(groupOf('WL-P1'));
    expect(groupOf('WL-P1')).toBeLessThan(groupOf('WL-I1'));
    expect(groupOf('WL-I1')).toBeLessThan(groupOf('WL-idea'));
    // Same priority bucket → same group number.
    expect(groups.get('WL-I1')!.group).toBe(groups.get('WL-other')!.group);
    expect(groups.get('WL-other')!.group).toBe(groups.get('WL-R1')!.group);
  });

  it('keeps a single section per priority bucket (no file-path partitioning)', () => {
    const items: GroupableItem[] = [
      { id: 'WL-C1', stage: 'plan_complete', filePaths: ['src/foo.ts'], priority: 'critical' },
      { id: 'WL-C2', stage: 'plan_complete', filePaths: ['src/foo.ts'], priority: 'critical' },
      { id: 'WL-C3', stage: 'idea', filePaths: [], priority: 'critical' },
    ];
    const groups = assignItemGroups(items, 3);
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical');
    expect(groups.get('WL-C2')!.groupLabel).toBe('Critical');
    expect(groups.get('WL-C3')!.groupLabel).toBe('Critical');
    // Items sharing file paths no longer land in separate groups.
    expect(new Set([...groups.values()].map(g => g.group)).size).toBe(1);
  });

  it('treats unknown/empty priority as medium (DEFAULT_PRIORITY)', () => {
    const items: GroupableItem[] = [
      { id: 'unknown', stage: 'in_progress', filePaths: [], priority: 'urgent' },
      { id: 'empty', stage: 'idea', filePaths: [], priority: '' },
      { id: 'missing', stage: 'idea', filePaths: [] },
      { id: 'low', stage: 'idea', filePaths: [], priority: 'low' },
    ];
    const groups = assignItemGroups(items, 3);
    // All unknown/empty/undefined priorities land in the Medium bucket.
    expect(groups.get('unknown')!.groupLabel).toBe('Medium');
    expect(groups.get('empty')!.groupLabel).toBe('Medium');
    expect(groups.get('missing')!.groupLabel).toBe('Medium');
    expect(groups.get('low')!.groupLabel).toBe('Low');
    // Medium bucket sorts before Low bucket.
    expect(groups.get('unknown')!.group).toBeLessThan(groups.get('low')!.group);
  });
});

describe('compareGroupableItems — priority → stage → id', () => {
  it('sorts by priority first, then stage within the same priority', () => {
    const items: GroupableItem[] = [
      { id: 'I-low', stage: 'intake_complete', filePaths: [], priority: 'low' },
      { id: 'P-med', stage: 'plan_complete', filePaths: [], priority: 'medium' },
      { id: 'I-high', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'P-high', stage: 'plan_complete', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    // Priority first (high → medium → low). Within the same priority the
    // stage order is workflow order (idea(0) → intake_complete(1) →
    // plan_complete(2) → ...), so intake_complete sorts before
    // plan_complete (AC 2).
    expect(sorted.map(i => i.id)).toEqual(['I-high', 'P-high', 'P-med', 'I-low']);
  });

  it('sorts unknown stages after known ones', () => {
    const items: GroupableItem[] = [
      { id: 'weird-stage', stage: 'custom', filePaths: [], priority: 'medium' },
      { id: 'no-stage', filePaths: [], priority: 'medium' },
      { id: 'done', stage: 'done', filePaths: [], priority: 'medium' },
      { id: 'idea', stage: 'idea', filePaths: [], priority: 'medium' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    // Known stages in workflow order first (idea → done), unknown stages
    // after (id tie-break: 'no-stage' < 'weird-stage').
    expect(sorted.map(i => i.id)).toEqual(['idea', 'done', 'no-stage', 'weird-stage']);
  });

  it('treats unknown priority as medium in the comparator', () => {
    const items: GroupableItem[] = [
      { id: 'unknown-prio', stage: 'idea', filePaths: [], priority: 'urgent' },
      { id: 'medium', stage: 'idea', filePaths: [], priority: 'medium' },
      { id: 'low', stage: 'idea', filePaths: [], priority: 'low' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    // 'urgent' → medium rank: medium(1) < low(2); id tie-break for the
    // medium-ranked pair.
    expect(sorted.map(i => i.id)).toEqual(['medium', 'unknown-prio', 'low']);
  });

  it('uses id as the deterministic tie-break', () => {
    const items: GroupableItem[] = [
      { id: 'WL-B', stage: 'idea', filePaths: [], priority: 'high' },
      { id: 'WL-A', stage: 'idea', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['WL-A', 'WL-B']);
  });
});

describe('regroupWorkItems — priority-bucket ordering on the merged list', () => {
  it('assigns group metadata to every displayed item (mandatory wl list items included)', () => {
    // Simulated merged list: wl next items carry group metadata, mandatory
    // wl list items (critical + completed/in_review) do NOT.
    const merged: WorkItem[] = [
      // From wl next — already grouped by the CLI (labels ignored on regroup).
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

    // Mandatory items land in their priority bucket: critical → Critical;
    // both medium in_review items (one non-completed from wl next, one
    // completed from wl list) share the SAME Medium group.
    expect(regrouped.find(i => i.id === 'WL-LIST-CRIT')?.groupLabel).toBe('Critical');
    const mediumItems = regrouped.filter(i => i.id === 'WL-NEXT-2' || i.id === 'WL-LIST-REV');
    expect(mediumItems.every(i => i.groupLabel === 'Medium')).toBe(true);
    expect(mediumItems[0].group).toBe(mediumItems[1].group);
    expect(new Set(regrouped.filter(i => i.groupLabel === 'Medium').map(i => i.group)).size).toBe(1);
  });

  it('renders one section per priority bucket, in priority order, with no duplicates', () => {
    const merged: WorkItem[] = [
      // wl next results (grouped) — legacy stage labels are superseded.
      makeItem('WL-NEXT-PLAN', { stage: 'plan_complete', priority: 'high', group: 2, groupLabel: 'Group 1' }),
      makeItem('WL-NEXT-REVIEW', { stage: 'in_review', priority: 'medium', status: 'in-progress', group: 5, groupLabel: 'In Review' }),
      makeItem('WL-NEXT-OTHER', { stage: 'in_progress', priority: 'medium', group: 3, groupLabel: 'Other' }),
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

    // One section per priority bucket, ordered Critical → High → Medium.
    expect(renderedSections).toEqual(['Critical', 'High', 'Medium']);
    // No duplicate section headings at all.
    expect(new Set(renderedSections).size).toBe(renderedSections.length);
    // No legacy stage-based labels render.
    expect(renderedSections).not.toContain('In Review');
    expect(renderedSections).not.toContain('Other');
    expect(renderedSections).not.toContain('Idea');
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

  it('orders the regrouped list by priority bucket, then stage within the bucket', () => {
    const merged: WorkItem[] = [
      makeItem('WL-I-low', { stage: 'intake_complete', priority: 'low' }),
      makeItem('WL-P-med', { stage: 'plan_complete', priority: 'medium' }),
      makeItem('WL-idea', { stage: 'idea', priority: 'low' }),
      makeItem('WL-R', { stage: 'in_review', priority: 'medium' }),
    ];
    const regrouped = regroupWorkItems(merged, 3);
    const order = regrouped.map(i => i.id);
    // Priority first: medium items before low items.
    expect(order.indexOf('WL-P-med')).toBeLessThan(order.indexOf('WL-I-low'));
    // Within the medium bucket: plan_complete (stage 2) before in_review (stage 4).
    expect(order.indexOf('WL-P-med')).toBeLessThan(order.indexOf('WL-R'));
    // Within the low bucket: idea (stage 0) before intake_complete (stage 1).
    expect(order.indexOf('WL-idea')).toBeLessThan(order.indexOf('WL-I-low'));
  });

  it('smart-selection merge path: mandatory + next items regroup into priority buckets', () => {
    // Simulates fetchNextItems: wl next results (grouped) merged with the
    // mandatory wl list subsets (ungrouped), then selectWorkItems, then
    // regroupWorkItems. A high-priority in_progress item must appear before
    // a medium-priority plan_complete item (priority first, AC 1).
    const nextItems: WorkItem[] = [
      makeItem('WL-NEXT-HIGH-IP', { stage: 'in_progress', priority: 'high', group: 3, groupLabel: 'Other' }),
      makeItem('WL-NEXT-MED-PLAN', { stage: 'plan_complete', priority: 'medium', group: 2, groupLabel: 'Group 1' }),
    ];
    const mandatory: WorkItem[] = [
      makeItem('WL-LIST-CRIT', { stage: 'idea', priority: 'critical' }),
      makeItem('WL-LIST-REV', { stage: 'in_review', priority: 'medium', status: 'completed' }),
    ];
    const selected = selectWorkItems([...nextItems, ...mandatory], 10);
    const regrouped = regroupWorkItems(selected, 3);

    const order = regrouped.map(i => i.id);
    // Critical bucket first, then High, then Medium.
    expect(order.indexOf('WL-LIST-CRIT')).toBe(0);
    expect(order.indexOf('WL-NEXT-HIGH-IP')).toBeLessThan(order.indexOf('WL-NEXT-MED-PLAN'));
    // Mandatory items are all present (smart-selection guarantee intact).
    expect(regrouped.map(i => i.id).sort()).toEqual(
      ['WL-LIST-CRIT', 'WL-LIST-REV', 'WL-NEXT-HIGH-IP', 'WL-NEXT-MED-PLAN'].sort(),
    );
    // Every displayed item carries group metadata, one section per bucket.
    expect([...new Set(regrouped.map(i => i.groupLabel))]).toEqual(['Critical', 'High', 'Medium']);
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
