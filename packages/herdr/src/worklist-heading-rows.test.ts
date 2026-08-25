/**
 * packages/herdr/src/worklist-heading-rows.test.ts — Display-rows model with
 * heading type (T1 for WL-0MSL5MPSZ003TG94).
 *
 * Tests for:
 * - DisplayRow union type (heading / item)
 * - WorkItemListState.collapsedGroups state
 * - getDisplayRows() producing interleaved heading + item rows
 * - Heading count = top-level items in group (unaffected by collapse)
 * - collapsedGroups survives list refresh
 *
 * Run: npx vitest run packages/herdr/src/worklist-heading-rows.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkItemListState,
  type DisplayRow,
} from './worklist.js';
import type { WorkItem } from './fetcher.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const TERM_80x24 = { rows: 24, cols: 80 };

function makeItem(
  id: string,
  group?: number,
  groupLabel?: string,
  stage?: string,
  children?: WorkItem[],
): WorkItem {
  return { id, title: `Item ${id}`, status: 'open', stage, group, groupLabel, children };
}

function makeChild(id: string): WorkItem {
  return { id, title: `Child ${id}`, status: 'open' };
}

/**
 * Build a grouped list of items matching the regroupWorkItems output.
 */
function makeGroupedList(): WorkItem[] {
  return [
    makeItem('A', 1, 'Group 1'),
    makeItem('B', 1, 'Group 1'),
    makeItem('C', 1, 'Group 1'),
    makeItem('D', 2, 'Group 2'),
    makeItem('E', 2, 'Group 2'),
    makeItem('F', 3, 'Idea'),
  ];
}

// ── DisplayRow type ──────────────────────────────────────────────────────

describe('DisplayRow type', () => {
  it('defines a heading row with correct shape', () => {
    const heading: DisplayRow = {
      kind: 'heading',
      group: 1,
      groupLabel: 'Group 1',
      count: 3,
      collapsed: false,
    };
    expect(heading.kind).toBe('heading');
    expect(heading.group).toBe(1);
    expect(heading.groupLabel).toBe('Group 1');
    expect(heading.count).toBe(3);
    expect(heading.collapsed).toBe(false);
  });

  it('defines an item row as a WorkItem', () => {
    const item: WorkItem = makeItem('A');
    // DisplayRow union: item rows are just WorkItem objects
    expect(item.id).toBe('A');
    expect(item.title).toBe('Item A');
  });
});

// ── collapsedGroups state ────────────────────────────────────────────────

describe('collapsedGroups state', () => {
  it('starts empty', () => {
    const items = makeGroupedList();
    const state = new WorkItemListState(items, TERM_80x24);
    expect(state.collapsedGroups.size).toBe(0);
  });

  it('can toggle a group into collapsed state', () => {
    const items = makeGroupedList();
    const state = new WorkItemListState(items, TERM_80x24);
    state.toggleGroupCollapse(1);
    expect(state.collapsedGroups.has(1)).toBe(true);
  });

  it('can toggle a collapsed group back to expanded', () => {
    const items = makeGroupedList();
    const state = new WorkItemListState(items, TERM_80x24);
    state.toggleGroupCollapse(1);
    state.toggleGroupCollapse(1);
    expect(state.collapsedGroups.has(1)).toBe(false);
  });
});

// ── getDisplayRows() ─────────────────────────────────────────────────────

describe('getDisplayRows()', () => {
  it('interleaves heading rows before each new group', () => {
    const items = makeGroupedList();
    const state = new WorkItemListState(items, TERM_80x24);
    const rows = state.getDisplayRows();

    // Should have: heading(1), A, B, C, heading(2), D, E, heading(3), F
    expect(rows.length).toBe(9);

    // First row is a heading
    expect(rows[0]).toMatchObject({ kind: 'heading', group: 1, groupLabel: 'Group 1', count: 3, collapsed: false });
    // Second row is an item
    expect((rows[1] as WorkItem).id).toBe('A');
    expect((rows[2] as WorkItem).id).toBe('B');
    expect((rows[3] as WorkItem).id).toBe('C');
    // Fourth row is heading for Group 2
    expect(rows[4]).toMatchObject({ kind: 'heading', group: 2, groupLabel: 'Group 2', count: 2, collapsed: false });
    // Fifth and sixth are items from Group 2
    expect((rows[5] as WorkItem).id).toBe('D');
    expect((rows[6] as WorkItem).id).toBe('E');
    // Seventh is heading for Idea
    expect(rows[7]).toMatchObject({ kind: 'heading', group: 3, groupLabel: 'Idea', count: 1, collapsed: false });
    // Eighth is the Idea item
    expect((rows[8] as WorkItem).id).toBe('F');
  });

  it('shows correct count per group', () => {
    const items = makeGroupedList();
    const state = new WorkItemListState(items, TERM_80x24);
    const rows = state.getDisplayRows();

    const headings = rows.filter((r): r is NonNullable<DisplayRow> & { kind: 'heading' } =>
      typeof r === 'object' && r !== null && 'kind' in r && (r as any).kind === 'heading'
    );

    expect(headings.length).toBe(3);
    expect(headings[0].count).toBe(3); // Group 1
    expect(headings[1].count).toBe(2); // Group 2
    expect(headings[2].count).toBe(1); // Idea
  });

  it('excludes items of collapsed groups from display rows', () => {
    const items = makeGroupedList();
    const state = new WorkItemListState(items, TERM_80x24);

    // Collapse group 1
    state.toggleGroupCollapse(1);
    const rows = state.getDisplayRows();

    // Should have: heading(1), heading(2), D, E, heading(3), F
    expect(rows.length).toBe(6);

    // First row is still the heading for Group 1
    expect(rows[0]).toMatchObject({ kind: 'heading', group: 1, collapsed: true });
    // Next should be heading for Group 2 (items of group 1 are hidden)
    expect(rows[1]).toMatchObject({ kind: 'heading', group: 2 });
    expect((rows[2] as WorkItem).id).toBe('D');
  });

  it('keeps heading visible even when group is collapsed', () => {
    const items = makeGroupedList();
    const state = new WorkItemListState(items, TERM_80x24);

    state.toggleGroupCollapse(1);
    const rows = state.getDisplayRows();

    const headings = rows.filter((r): r is NonNullable<DisplayRow> & { kind: 'heading' } =>
      typeof r === 'object' && r !== null && 'kind' in r && (r as any).kind === 'heading'
    );

    // All 3 headings should still be visible
    expect(headings.length).toBe(3);
    // First heading should show collapsed: true
    expect(headings[0].collapsed).toBe(true);
    // Count should still reflect the full group count (AC4)
    expect(headings[0].count).toBe(3);
  });

  it('does not include items without a group field', () => {
    const items = [
      makeItem('X', 1, 'Group 1'),
      makeItem('Y'), // no group
      makeItem('Z', 1, 'Group 1'),
    ];
    const state = new WorkItemListState(items, TERM_80x24);
    const rows = state.getDisplayRows();

    // Should have: heading(1), X, Z, Y
    // Items without a group are included but no heading is inserted for them
    const itemsOnly = rows.filter((r): r is WorkItem =>
      typeof r === 'object' && r !== null && 'id' in r && !('kind' in r)
    );
    expect(itemsOnly.length).toBe(3);
  });
});

// ── collapsedGroups survives refresh ─────────────────────────────────────

describe('collapsedGroups survives list refresh', () => {
  it('preserves collapsed groups across refreshItems', () => {
    const items = makeGroupedList();
    const state = new WorkItemListState(items, TERM_80x24);

    // Collapse group 1
    state.toggleGroupCollapse(1);
    expect(state.collapsedGroups.has(1)).toBe(true);

    // Simulate a refresh with updated items (same group assignments)
    const refreshedItems = [
      makeItem('A', 1, 'Group 1'),
      makeItem('B-updated', 1, 'Group 1'), // title changed
      makeItem('C', 1, 'Group 1'),
      makeItem('D', 2, 'Group 2'),
      makeItem('E', 2, 'Group 2'),
      makeItem('F', 3, 'Idea'),
    ];
    state.refreshItems(refreshedItems);

    // collapsedGroups should survive
    expect(state.collapsedGroups.has(1)).toBe(true);

    // Display rows should reflect the collapsed state
    const rows = state.getDisplayRows();
    expect(rows.length).toBe(6); // heading(1), heading(2), D, E, heading(3), F
  });

  it('preserves collapsed groups when group assignments change after refresh', () => {
    const items = makeGroupedList();
    const state = new WorkItemListState(items, TERM_80x24);

    // Collapse group 1
    state.toggleGroupCollapse(1);

    // Refresh with regrouped items — groups renumbered
    const refreshedItems = [
      makeItem('D', 1, 'Group 1'), // was group 2
      makeItem('E', 1, 'Group 1'),
      makeItem('A', 2, 'Group 2'), // was group 1, now group 2
      makeItem('B', 2, 'Group 2'),
      makeItem('C', 2, 'Group 2'),
    ];
    state.refreshItems(refreshedItems);

    // The collapsed set uses group numbers, so group 1 (now D/E) is collapsed.
    // This is the documented in-session behaviour (same as expandedItems).
    expect(state.collapsedGroups.has(1)).toBe(true);
    const rows = state.getDisplayRows();
    // Group 1 (D/E) is collapsed → its items are hidden; group 2 (A/B/C)
    // items remain visible.
    const itemsVisible = rows.filter((r): r is WorkItem =>
      typeof r === 'object' && r !== null && 'id' in r && !('kind' in r)
    );
    expect(itemsVisible.map(i => i.id).sort()).toEqual(['A', 'B', 'C']);
  });

  it('all headings visible with correct counts after refresh', () => {
    const items = makeGroupedList();
    const state = new WorkItemListState(items, TERM_80x24);

    state.toggleGroupCollapse(2);

    const refreshedItems = [
      makeItem('A-new', 1, 'Group 1'),
      makeItem('B-new', 1, 'Group 1'),
      makeItem('C-new', 1, 'Group 1'),
      makeItem('D-new', 2, 'Group 2'),
      makeItem('F-new', 3, 'Idea'),
    ];
    state.refreshItems(refreshedItems);

    const rows = state.getDisplayRows();
    const headings = rows.filter((r): r is NonNullable<DisplayRow> & { kind: 'heading' } =>
      typeof r === 'object' && r !== null && 'kind' in r && (r as any).kind === 'heading'
    );

    expect(headings.length).toBe(3);
    expect(headings[0].count).toBe(3);
    expect(headings[1].count).toBe(1); // Group 2 only has D now
    expect(headings[2].count).toBe(1);
    expect(headings[1].collapsed).toBe(true);
  });
});

// ── Interaction with expanded items ──────────────────────────────────────

describe('getDisplayRows() with expanded items', () => {
  it('includes children of expanded parents in display rows', () => {
    const parent = makeItem('P', 1, 'Group 1', 'plan_complete', [makeChild('C1'), makeChild('C2')]);
    parent.childCount = 2;
    const items = [parent, makeItem('A', 1, 'Group 1')];
    const state = new WorkItemListState(items, TERM_80x24);

    // Expand the parent
    state.toggleExpand('P');
    const rows = state.getDisplayRows();

    // heading(1), P, C1, C2, A
    expect(rows.length).toBe(5);
    expect(rows[0]).toMatchObject({ kind: 'heading', group: 1 });
    expect((rows[1] as WorkItem).id).toBe('P');
    expect((rows[2] as WorkItem).id).toBe('C1');
    expect((rows[3] as WorkItem).id).toBe('C2');
    expect((rows[4] as WorkItem).id).toBe('A');
  });

  it('count does NOT include children of expanded parents', () => {
    const parent = makeItem('P', 1, 'Group 1', 'plan_complete', [makeChild('C1'), makeChild('C2')]);
    parent.childCount = 2;
    const items = [parent, makeItem('A', 1, 'Group 1')];
    const state = new WorkItemListState(items, TERM_80x24);

    state.toggleExpand('P');
    const rows = state.getDisplayRows();

    const heading = rows[0] as NonNullable<DisplayRow> & { kind: 'heading' };
    // Count = top-level items only (P + A = 2), NOT including children
    expect(heading.count).toBe(2);
  });

  it('items of collapsed groups are excluded even if parent is expanded', () => {
    const parent = makeItem('P', 1, 'Group 1', 'plan_complete', [makeChild('C1'), makeChild('C2')]);
    parent.childCount = 2;
    const items = [parent, makeItem('A', 1, 'Group 1')];
    const state = new WorkItemListState(items, TERM_80x24);

    // Expand parent and collapse group
    state.toggleExpand('P');
    state.toggleGroupCollapse(1);
    const rows = state.getDisplayRows();

    // Only heading visible (collapsed group hides P, C1, C2, A)
    const itemsVisible = rows.filter((r): r is WorkItem =>
      typeof r === 'object' && r !== null && 'id' in r && !('kind' in r)
    );
    expect(itemsVisible.length).toBe(0);
    // Heading still visible with correct count (top-level items, regardless of collapse)
    const heading = rows[0] as NonNullable<DisplayRow> & { kind: 'heading' };
    expect(heading.count).toBe(2);
    expect(heading.collapsed).toBe(true);
  });
});
