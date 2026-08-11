/**
 * Unit tests for packages/herdr/src/grouping.ts — the duplicated grouping
 * algorithm applied to the merged (selected) worklist.
 *
 * The grouping algorithm is intentionally duplicated per TUI (decision Q2c
 * in WL-0MS8W5LTW006YZ4B) because Herdr has zero npm dependencies and cannot
 * import from src/commands/. This suite asserts the priority-first ordering
 * introduced by WL-0MSI1LVTJ001M9EY:
 *
 * - One section per priority bucket, ordered Critical → High → Medium → Low
 *   (labels are the priority names; no stage sub-headers are rendered).
 * - Within a bucket, items sort by stage in workflow order (idea →
 *   intake_complete → plan_complete → in_progress → in_review → done) then
 *   by id as a deterministic tie-break.
 * - Unknown/empty priority sorts as medium (DEFAULT_PRIORITY convention);
 *   unknown stages sort after all known stages.
 *
 * It also covers the merged-list regression for duplicate section headings
 * (WL-0MSAK8YLB0025EGW) and the smart-selection merge path guarantee
 * (WL-0MS8W5LTW006YZ4B): all critical + completed/in_review items remain
 * visible after select → regroup.
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

describe('assignItemGroups — priority-bucket sections (WL-0MSI1LVTJ001M9EY)', () => {
  it('produces one section per priority bucket in order Critical → High → Medium → Low', () => {
    const items: GroupableItem[] = [
      { id: 'WL-L', stage: 'in_progress', filePaths: [], priority: 'low' },
      { id: 'WL-H', stage: 'plan_complete', filePaths: [], priority: 'high' },
      { id: 'WL-C', stage: 'idea', filePaths: [], priority: 'critical' },
      { id: 'WL-M', stage: 'in_review', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items);
    // One section per priority bucket, labelled with the priority name.
    expect(groups.get('WL-C')!.groupLabel).toBe('Critical');
    expect(groups.get('WL-H')!.groupLabel).toBe('High');
    expect(groups.get('WL-M')!.groupLabel).toBe('Medium');
    expect(groups.get('WL-L')!.groupLabel).toBe('Low');
    // No stage sub-headers: the set of labels is exactly the priority names.
    expect(new Set([...groups.values()].map(g => g.groupLabel))).toEqual(
      new Set(['Critical', 'High', 'Medium', 'Low']),
    );
    // Sections are numbered in priority order (Critical first).
    expect(groups.get('WL-C')!.group).toBeLessThan(groups.get('WL-H')!.group);
    expect(groups.get('WL-H')!.group).toBeLessThan(groups.get('WL-M')!.group);
    expect(groups.get('WL-M')!.group).toBeLessThan(groups.get('WL-L')!.group);
    expect([...groups.values()].map(g => g.group)).toEqual([1, 2, 3, 4]);
  });

  it('puts a high-priority in_progress item ahead of a medium-priority plan_complete item', () => {
    // Regression for the reported bug: priority is the primary sort key, so
    // a high-priority in_progress item must precede a medium-priority
    // plan_complete item instead of trailing in a lower section.
    const items: GroupableItem[] = [
      { id: 'WL-HIP', stage: 'in_progress', filePaths: [], priority: 'high' },
      { id: 'WL-MPC', stage: 'plan_complete', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items);
    expect(groups.get('WL-HIP')!.groupLabel).toBe('High');
    expect(groups.get('WL-MPC')!.groupLabel).toBe('Medium');
    expect(groups.get('WL-HIP')!.group).toBeLessThan(groups.get('WL-MPC')!.group);
  });

  it('treats unknown/empty priority as medium (DEFAULT_PRIORITY convention)', () => {
    const items: GroupableItem[] = [
      { id: 'WL-UNKNOWN', stage: 'in_progress', filePaths: [], priority: 'bogus' },
      { id: 'WL-EMPTY', stage: 'plan_complete', filePaths: [], priority: undefined },
      { id: 'WL-MED', stage: 'idea', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items);
    for (const id of ['WL-UNKNOWN', 'WL-EMPTY', 'WL-MED']) {
      expect(groups.get(id)!.groupLabel).toBe('Medium');
      expect(groups.get(id)!.group).toBe(1);
    }
  });

  it('numbers buckets sequentially from the first non-empty priority', () => {
    // No critical items → the first section is High (group 1).
    const groups = assignItemGroups([
      { id: 'WL-H', stage: 'idea', filePaths: [], priority: 'high' },
      { id: 'WL-L', stage: 'idea', filePaths: [], priority: 'low' },
    ]);
    expect(groups.get('WL-H')!.groupLabel).toBe('High');
    expect(groups.get('WL-H')!.group).toBe(1);
    expect(groups.get('WL-L')!.groupLabel).toBe('Low');
    expect(groups.get('WL-L')!.group).toBe(2);
  });

  it('assigns every item to exactly one bucket (no item dropped, no duplicate assignments)', () => {
    const items: GroupableItem[] = [
      { id: 'WL-1', stage: 'idea', filePaths: [], priority: 'critical' },
      { id: 'WL-2', stage: 'in_review', filePaths: [], priority: 'high' },
      { id: 'WL-3', stage: 'done', filePaths: [], priority: 'low' },
      { id: 'WL-4', stage: 'custom', filePaths: [], priority: undefined },
    ];
    const groups = assignItemGroups(items);
    expect(groups.size).toBe(items.length);
    for (const item of items) {
      expect(groups.has(item.id)).toBe(true);
    }
  });
});

describe('compareGroupableItems — priority first, then stage, then id', () => {
  it('sorts by priority in descending order regardless of stage', () => {
    const items: GroupableItem[] = [
      { id: 'WL-M', stage: 'in_progress', filePaths: [], priority: 'medium' },
      { id: 'WL-C', stage: 'idea', filePaths: [], priority: 'critical' },
      { id: 'WL-H', stage: 'in_review', filePaths: [], priority: 'high' },
      { id: 'WL-L', stage: 'plan_complete', filePaths: [], priority: 'low' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['WL-C', 'WL-H', 'WL-M', 'WL-L']);
  });

  it('sorts by stage in workflow order within equal priority', () => {
    const items: GroupableItem[] = [
      { id: 'WL-D', stage: 'done', filePaths: [], priority: 'high' },
      { id: 'WL-I', stage: 'idea', filePaths: [], priority: 'high' },
      { id: 'WL-R', stage: 'in_review', filePaths: [], priority: 'high' },
      { id: 'WL-P', stage: 'in_progress', filePaths: [], priority: 'high' },
      { id: 'WL-K', stage: 'intake_complete', filePaths: [], priority: 'high' },
      { id: 'WL-PC', stage: 'plan_complete', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual([
      'WL-I',   // idea
      'WL-K',   // intake_complete
      'WL-PC',  // plan_complete
      'WL-P',   // in_progress
      'WL-R',   // in_review
      'WL-D',   // done
    ]);
  });

  it('uses id as the deterministic tie-break for equal priority and stage', () => {
    const items: GroupableItem[] = [
      { id: 'WL-B', stage: 'idea', filePaths: [], priority: 'high' },
      { id: 'WL-A', stage: 'idea', filePaths: [], priority: 'high' },
      { id: 'WL-C', stage: 'idea', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['WL-A', 'WL-B', 'WL-C']);
  });

  it('sorts unknown stages after all known stages', () => {
    const items: GroupableItem[] = [
      { id: 'WL-custom', stage: 'custom', filePaths: [], priority: 'high' },
      { id: 'WL-done', stage: 'done', filePaths: [], priority: 'high' },
      { id: 'WL-idea', stage: 'idea', filePaths: [], priority: 'high' },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    expect(sorted.map(i => i.id)).toEqual(['WL-idea', 'WL-done', 'WL-custom']);
  });

  it('treats unknown priority as medium in comparisons', () => {
    const items: GroupableItem[] = [
      { id: 'WL-MED', stage: 'idea', filePaths: [], priority: 'medium' },
      { id: 'WL-UNK', stage: 'idea', filePaths: [], priority: 'bogus' },
      { id: 'WL-UNDEF', stage: 'idea', filePaths: [], priority: undefined },
    ];
    const sorted = items.slice().sort(compareGroupableItems);
    // All three are equal on priority (medium) and stage; id is the tie-break.
    expect(sorted.map(i => i.id)).toEqual(['WL-MED', 'WL-UNDEF', 'WL-UNK']);
  });
});

describe('regroupWorkItems — priority-first list order', () => {
  it('orders the regrouped list by priority bucket then stage, stamping every item', () => {
    const merged: WorkItem[] = [
      makeItem('WL-LOW-IP', { stage: 'in_progress', priority: 'low' }),
      makeItem('WL-CRIT-IDEA', { stage: 'idea', priority: 'critical' }),
      makeItem('WL-HIGH-REV', { stage: 'in_review', priority: 'high' }),
      makeItem('WL-MED-PLAN', { stage: 'plan_complete', priority: 'medium' }),
      makeItem('WL-HIGH-IDEA', { stage: 'idea', priority: 'high' }),
    ];
    const regrouped = regroupWorkItems(merged);
    expect(regrouped.map(i => i.id)).toEqual([
      'WL-CRIT-IDEA',  // Critical bucket, idea stage
      'WL-HIGH-IDEA',  // High bucket, idea before in_review
      'WL-HIGH-REV',   // High bucket, in_review stage
      'WL-MED-PLAN',   // Medium bucket
      'WL-LOW-IP',     // Low bucket
    ]);
    // Every displayed item receives group metadata.
    for (const item of regrouped) {
      expect(item.group).toBeDefined();
      expect(item.groupLabel).toBeDefined();
    }
  });

  it('renders exactly one section per priority bucket (no duplicate headings)', () => {
    // Merged list with stale group metadata (wl next) + ungrouped mandatory
    // subsets (wl list): after regroup there must be exactly one section per
    // priority bucket, in priority order.
    const merged: WorkItem[] = [
      makeItem('WL-NEXT-H', { stage: 'plan_complete', priority: 'high', group: 2, groupLabel: 'Group 1' }),
      makeItem('WL-NEXT-M', { stage: 'in_progress', priority: 'medium', status: 'in-progress', group: 3, groupLabel: 'Group 1' }),
      makeItem('WL-LIST-CRIT', { stage: 'plan_complete', priority: 'critical' }),
      makeItem('WL-LIST-REV', { stage: 'in_review', priority: 'medium', status: 'completed' }),
      makeItem('WL-LIST-LOW', { stage: 'idea', priority: 'low' }),
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

    expect(renderedSections).toEqual(['Critical', 'High', 'Medium', 'Low']);
  });

  it('preserves every item across regroup (no filtering) — mandatory guarantee intact', () => {
    const merged: WorkItem[] = [
      makeItem('WL-A', { stage: 'plan_complete', priority: 'high' }),
      makeItem('WL-B', { stage: 'in_review', priority: 'medium', status: 'completed' }),
      makeItem('WL-C', { stage: 'idea', priority: 'low' }),
      makeItem('WL-D', { stage: 'done', priority: 'critical' }),
    ];
    const regrouped = regroupWorkItems(merged, 3);
    expect(regrouped.map(i => i.id).sort()).toEqual(['WL-A', 'WL-B', 'WL-C', 'WL-D']);
  });
});

describe('smart-selection merge path (WL-0MS8W5LTW006YZ4B / parent AC 5)', () => {
  it('keeps all critical and completed/in_review items visible through select → regroup', () => {
    const merged: WorkItem[] = [
      // wl next results (carry stale group metadata).
      makeItem('WL-NEXT-1', { stage: 'plan_complete', priority: 'high', group: 2, groupLabel: 'Group 1' }),
      makeItem('WL-NEXT-2', { stage: 'in_progress', priority: 'medium', status: 'in-progress', group: 3, groupLabel: 'Group 1' }),
      // Mandatory wl list subsets (no group metadata).
      makeItem('WL-CRIT-1', { stage: 'idea', priority: 'critical' }),
      makeItem('WL-CRIT-2', { stage: 'plan_complete', priority: 'critical' }),
      makeItem('WL-REV-1', { stage: 'in_review', priority: 'medium', status: 'completed' }),
      // Non-mandatory "other" item.
      makeItem('WL-OTHER-1', { stage: 'idea', priority: 'low' }),
      // Excluded from the default list (stage=done, WL-0MS94VAII00054L9).
      makeItem('WL-DONE-1', { stage: 'done', priority: 'high' }),
    ];

    const selected = selectWorkItems(merged, 3); // cap 3 → mandatory set only
    const regrouped = regroupWorkItems(selected, 3);

    const ids = new Set(regrouped.map(i => i.id));
    // Mandatory set fully visible despite the small browseItemCount.
    for (const id of ['WL-CRIT-1', 'WL-CRIT-2', 'WL-REV-1']) {
      expect(ids.has(id)).toBe(true);
    }
    // "Other" items were trimmed by the cap; done items never enter the list.
    expect(ids.has('WL-OTHER-1')).toBe(false);
    expect(ids.has('WL-DONE-1')).toBe(false);

    // After regroup, the mandatory items sit in their priority buckets.
    const byId = new Map(regrouped.map(i => [i.id, i]));
    expect(byId.get('WL-CRIT-1')!.groupLabel).toBe('Critical');
    expect(byId.get('WL-CRIT-2')!.groupLabel).toBe('Critical');
    expect(byId.get('WL-REV-1')!.groupLabel).toBe('Medium');
  });

  it('keeps the full mandatory set visible when it exceeds browseItemCount (no hard cap)', () => {
    const merged: WorkItem[] = [
      makeItem('WL-CRIT-1', { stage: 'idea', priority: 'critical' }),
      makeItem('WL-CRIT-2', { stage: 'idea', priority: 'critical' }),
      makeItem('WL-REV-1', { stage: 'in_review', priority: 'medium', status: 'completed' }),
      makeItem('WL-REV-2', { stage: 'in_review', priority: 'medium', status: 'completed' }),
      makeItem('WL-REV-3', { stage: 'in_review', priority: 'medium', status: 'completed' }),
      makeItem('WL-OTHER-1', { stage: 'idea', priority: 'low' }),
    ];
    const selected = selectWorkItems(merged, 2); // mandatory set alone exceeds the cap
    const regrouped = regroupWorkItems(selected, 3);
    const ids = new Set(regrouped.map(i => i.id));
    for (const id of ['WL-CRIT-1', 'WL-CRIT-2', 'WL-REV-1', 'WL-REV-2', 'WL-REV-3']) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.has('WL-OTHER-1')).toBe(false);
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
