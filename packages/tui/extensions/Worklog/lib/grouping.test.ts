/**
 * Unit tests for lib/grouping.ts — the duplicated grouping algorithm applied
 * to the merged (selected) browse list in the Pi TUI Worklog extension.
 *
 * Mirrors the Herdr plugin grouping suite (decision Q2c in
 * WL-0MS8W5LTW006YZ4B); covers the merged-list regression for the duplicate
 * "In Review" sections bug (WL-0MSAK8YLB0025EGW).
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/lib/grouping.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  assignItemGroups,
  regroupWorkItems,
  compareGroupableItems,
  extractFilePaths,
  type GroupableItem,
} from './grouping.js';
import type { WorklogBrowseItem } from './tools.js';

/**
 * Build a minimal WorklogBrowseItem.
 */
function makeItem(id: string, overrides: Partial<WorklogBrowseItem> = {}): WorklogBrowseItem {
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
      { id: 'WL-other', stage: 'in_progress', filePaths: [], priority: 'medium' },
      { id: 'WL-R1', stage: 'in_review', filePaths: [], priority: 'medium' },
    ];
    const groups = assignItemGroups(items, 3);
    const groupOf = (id: string): number => groups.get(id)!.group;
    expect(groups.get('WL-C1')!.groupLabel).toBe('Critical Group 1');
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
});

describe('regroupWorkItems — merged-list regression (WL-0MSAK8YLB0025EGW)', () => {
  it('assigns group metadata to every displayed item (mandatory wl list items included)', () => {
    const merged: WorklogBrowseItem[] = [
      // From wl next — already grouped by the CLI.
      makeItem('WL-NEXT-1', { stage: 'plan_complete', priority: 'high', group: 2, groupLabel: 'Group 1' }),
      makeItem('WL-NEXT-2', { stage: 'in_review', priority: 'medium', status: 'in-progress', group: 5, groupLabel: 'In Review' }),
      // From wl list (mandatory subset) — NO group metadata.
      makeItem('WL-LIST-CRIT', { stage: 'intake_complete', priority: 'critical' }),
      makeItem('WL-LIST-REV', { stage: 'in_review', priority: 'medium', status: 'completed' }),
    ];

    const regrouped = regroupWorkItems(merged, 3);

    for (const item of regrouped) {
      expect(item.group).toBeDefined();
      expect(item.groupLabel).toBeDefined();
    }

    const inReviewItems = regrouped.filter(i => i.id === 'WL-NEXT-2' || i.id === 'WL-LIST-REV');
    expect(inReviewItems.every(i => i.groupLabel === 'In Review')).toBe(true);
    expect(inReviewItems[0].group).toBe(inReviewItems[1].group);
    expect(new Set(regrouped.filter(i => i.groupLabel === 'In Review').map(i => i.group)).size).toBe(1);
  });

  it('regression: merged list renders exactly one In Review section, positioned after Other', () => {
    const merged: WorklogBrowseItem[] = [
      makeItem('WL-NEXT-PLAN', { stage: 'plan_complete', priority: 'high', group: 2, groupLabel: 'Group 1' }),
      makeItem('WL-NEXT-REVIEW', { stage: 'in_review', priority: 'medium', status: 'in-progress', group: 5, groupLabel: 'In Review' }),
      makeItem('WL-NEXT-OTHER', { stage: 'in_progress', priority: 'medium', group: 3, groupLabel: 'Other' }),
      makeItem('WL-LIST-CRIT', { stage: 'plan_complete', priority: 'critical' }),
      makeItem('WL-LIST-REV', { stage: 'in_review', priority: 'medium', status: 'completed' }),
    ];

    const regrouped = regroupWorkItems(merged, 3);

    // Simulate the browse renderer: separator lines emitted when the group
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

    expect(renderedSections.filter(s => s === 'In Review').length).toBe(1);
    expect(renderedSections[renderedSections.length - 1]).toBe('In Review');
    const otherIndex = renderedSections.indexOf('Other');
    expect(otherIndex).toBeGreaterThan(-1);
    expect(renderedSections.indexOf('In Review')).toBeGreaterThan(otherIndex);
    expect(new Set(renderedSections).size).toBe(renderedSections.length);
  });

  it('preserves every item across regroup (no filtering) — mandatory guarantee intact', () => {
    const merged: WorklogBrowseItem[] = [
      makeItem('WL-A', { stage: 'plan_complete', priority: 'high' }),
      makeItem('WL-B', { stage: 'in_review', priority: 'medium', status: 'completed' }),
      makeItem('WL-C', { stage: 'idea', priority: 'low' }),
    ];
    const regrouped = regroupWorkItems(merged, 3);
    expect(regrouped.map(i => i.id).sort()).toEqual(['WL-A', 'WL-B', 'WL-C']);
  });

  it('orders the regrouped list by group then within-group order', () => {
    const merged: WorklogBrowseItem[] = [
      makeItem('WL-I-low', { stage: 'intake_complete', priority: 'low' }),
      makeItem('WL-P-med', { stage: 'plan_complete', priority: 'medium' }),
      makeItem('WL-idea', { stage: 'idea', priority: 'low' }),
      makeItem('WL-R', { stage: 'in_review', priority: 'medium' }),
    ];
    const regrouped = regroupWorkItems(merged, 3);
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
