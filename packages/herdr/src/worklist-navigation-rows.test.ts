/**
 * packages/herdr/src/worklist-navigation-rows.test.ts — Navigation over
 * display rows (T2 for WL-0MSL5MPSZ003TG94).
 *
 * Tests for:
 * - moveUp/moveDown land on heading rows
 * - pageUp/pageDown, goToFirst/goToLast work over display rows
 * - Wrap-around works correctly with headings
 * - flatCount = display row count
 * - _clampSelection and _adjustScroll use display row count
 * - getSelectedItem() returns null for heading selection
 *
 * Run: npx vitest run packages/herdr/src/worklist-navigation-rows.test.ts
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

/** Build a grouped list matching regroupWorkItems output. */
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

// ── flatCount ────────────────────────────────────────────────────────────

describe('flatCount returns display row count', () => {
  it('counts headings + items', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    // 3 headings + 6 items = 9
    expect(state.flatCount).toBe(9);
    expect(state.flatCount).toBe(state.getDisplayRows().length);
  });

  it('counts fewer rows when groups are collapsed', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.toggleGroupCollapse(1);
    // heading(1) + heading(2) + D, E + heading(3) + F = 6
    expect(state.flatCount).toBe(6);
  });

  it('counts headings + expanded children', () => {
    const parent = makeItem('P', 1, 'Group 1', 'plan_complete', [makeChild('C1'), makeChild('C2')]);
    parent.childCount = 2;
    const items = [parent, makeItem('A', 1, 'Group 1'), makeItem('B', 2, 'Group 2')];
    const state = new WorkItemListState(items, TERM_80x24);
    state.toggleExpand('P');
    // heading(1) + P + C1 + C2 + A + heading(2) + B = 7
    expect(state.flatCount).toBe(7);
  });
});

// ── moveUp / moveDown ───────────────────────────────────────────────────

describe('moveUp / moveDown over display rows', () => {
  it('moveDown advances from heading to first item in group', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    expect(state.selectedIndex).toBe(0); // heading(1)
    state.moveDown();
    expect(state.selectedIndex).toBe(1); // A
    expect(state.getSelectedItem()?.id).toBe('A');
  });

  it('moveDown lands on heading rows', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    // Start at heading(1) → A → B → C → heading(2)
    state.moveDown(); // A (1)
    state.moveDown(); // B (2)
    state.moveDown(); // C (3)
    state.moveDown(); // heading(2) (4)
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading', group: 2 });
  });

  it('moveUp goes from item back to heading', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.moveDown(); // A
    state.moveDown(); // B
    state.moveDown(); // C
    state.moveDown(); // heading(2)
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading', group: 2 });
    state.moveUp(); // C
    expect((state.getSelectedItem() as WorkItem)?.id).toBe('C');
  });

  it('moveDown wrap-around goes from last row to first (heading)', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    // Last display row is F (index 8)
    for (let i = 0; i < 8; i++) state.moveDown();
    expect(state.selectedIndex).toBe(8);
    expect(state.getSelectedItem()?.id).toBe('F');
    state.moveDown(); // should wrap to 0 (heading)
    expect(state.selectedIndex).toBe(0);
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading', group: 1 });
  });

  it('moveUp wrap-around goes from first (heading) to last row', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.moveUp(); // should wrap to last (F)
    expect(state.selectedIndex).toBe(8);
    expect(state.getSelectedItem()?.id).toBe('F');
  });
});

// ── pageUp / pageDown ────────────────────────────────────────────────────

describe('pageUp / pageDown over display rows', () => {
  it('pageDown advances by list height over display rows', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    const pageSize = state._listHeight();
    state.pageDown();
    // flatCount (9) < pageSize (17), so pageDown clamps to the last row.
    expect(state.selectedIndex).toBe(state.flatCount - 1);
    expect(state.getSelectedDisplayRow()).toBeDefined();
  });

  it('pageDown clamps to display row count', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.pageDown();
    expect(state.selectedIndex).toBeLessThan(state.flatCount);
    expect(state.selectedIndex).toBeGreaterThanOrEqual(0);
  });

  it('pageUp goes to top when already near top', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.moveDown(); // index 1
    state.pageUp(); // should go to 0
    expect(state.selectedIndex).toBe(0);
    expect((state.getSelectedDisplayRow() as NonNullable<DisplayRow> & { kind: 'heading' }).kind).toBe('heading');
  });
});

// ── goToFirst / goToLast ─────────────────────────────────────────────────

describe('goToFirst / goToLast over display rows', () => {
  it('goToFirst selects heading(1)', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.selectedIndex = 8;
    state.scrollOffset = 5;
    state.goToFirst();
    expect(state.selectedIndex).toBe(0);
    expect(state.scrollOffset).toBe(0);
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading', group: 1 });
  });

  it('goToLast selects last display row', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.goToLast();
    expect(state.selectedIndex).toBe(8); // last row
    expect(state.getSelectedItem()?.id).toBe('F');
  });
});

// ── getSelectedItem returns null for heading ──────────────────────────────

describe('getSelectedItem() heading handling', () => {
  it('returns null when a heading row is selected', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    // selectedIndex = 0, which is heading(1)
    expect(state.getSelectedItem()).toBeNull();
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading' });
  });

  it('returns the item when an item row is selected', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.moveDown(); // A (index 1)
    expect(state.getSelectedItem()?.id).toBe('A');
  });

  it('returns null for any heading row, not just the first', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    // Move to heading(2) (index 4)
    for (let i = 0; i < 4; i++) state.moveDown();
    expect(state.getSelectedItem()).toBeNull();
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading', group: 2 });
  });

  it('returns null for heading in collapsed group too', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.toggleGroupCollapse(1);
    // After collapse, heading(1) is index 0
    expect(state.getSelectedItem()).toBeNull();
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading', group: 1, collapsed: true });
  });
});

// ── getSelectedDisplayRow ────────────────────────────────────────────────

describe('getSelectedDisplayRow()', () => {
  it('returns the row at selectedIndex', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    // Headings are derived per call, so compare deeply; items are the same
    // object references from the flattened tree.
    expect(state.getSelectedDisplayRow()).toEqual(state.getDisplayRows()[0]);
    state.moveDown();
    expect(state.getSelectedDisplayRow()).toBe(state.getDisplayRows()[1]);
    expect(state.getSelectedDisplayRow()?.id).toBe('A');
  });

  it('returns null when selection is out of bounds', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.selectedIndex = 999;
    expect(state.getSelectedDisplayRow()).toBeNull();
  });
});

// ── clamping with display rows ──────────────────────────────────────────

describe('_clampSelection with display rows', () => {
  it('clamps to display row count', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.selectedIndex = state.flatCount + 10;
    state._clampSelection();
    expect(state.selectedIndex).toBe(state.flatCount - 1);
  });

  it('clamps negative to 0', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.selectedIndex = -5;
    state._clampSelection();
    expect(state.selectedIndex).toBe(0);
  });

  it('clamps to 0 when list is empty', () => {
    const state = new WorkItemListState([], TERM_80x24);
    state.selectedIndex = 5;
    state._clampSelection();
    expect(state.selectedIndex).toBe(0);
  });
});

// ── _adjustScroll with display rows ──────────────────────────────────────

describe('_adjustScroll with display rows', () => {
  it('clamps scroll offset to display row count', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.selectedIndex = state.flatCount - 1;
    state.scrollOffset = 999;
    state._adjustScroll();
    expect(state.scrollOffset).toBeLessThanOrEqual(Math.max(0, state.flatCount - state._listHeight()));
  });

  it('keeps selected index visible within scroll window', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    // Move selection far down, scroll should follow
    state.selectedIndex = state.flatCount - 1;
    state._adjustScroll();
    expect(state.selectedIndex).toBeGreaterThanOrEqual(state.scrollOffset);
    expect(state.selectedIndex).toBeLessThan(state.scrollOffset + state._listHeight());
  });
});

// ── collapsed groups and navigation ──────────────────────────────────────

describe('collapsed groups in navigation', () => {
  it('collapsing a group shrinks the navigation space', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    const before = state.flatCount;
    state.toggleGroupCollapse(1);
    expect(state.flatCount).toBeLessThan(before);
    // Navigation now covers the reduced display rows
    state.goToLast();
    expect(state.selectedIndex).toBe(state.flatCount - 1);
    expect(state.getSelectedItem()?.id).toBe('F');
  });

  it('a selection pointing at a hidden item clamps to valid display row', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.moveDown(); // A (index 1)
    state.moveDown(); // B (index 2)
    // Collapse group 1 → rows shrink from 9 to 6; selection 2 is still valid
    state.toggleGroupCollapse(1);
    expect(state.selectedIndex).toBeLessThan(state.flatCount);
  });
});
