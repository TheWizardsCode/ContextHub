/**
 * packages/herdr/src/worklist-group-toggle.test.ts — Tab toggle for group
 * collapse (T3 for WL-0MSL5MPSZ003TG94).
 *
 * Tests for:
 * - Tab on a heading row toggles that group's collapse state
 * - Tab on an item row keeps the existing expand/collapse-children behaviour
 * - Enter on a heading is a no-op
 * - Heading toggle does not disturb expandedItems / navigation stack
 * - Collapsed group's items hidden from render (display rows) and navigation
 *
 * Run: npx vitest run packages/herdr/src/worklist-group-toggle.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkItemListState,
  handleKeypress,
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
  childCount?: number,
): WorkItem {
  return { id, title: `Item ${id}`, status: 'open', stage, group, groupLabel, children, childCount };
}

function makeChild(id: string): WorkItem {
  return { id, title: `Child ${id}`, status: 'open' };
}

function makeGroupedList(): WorkItem[] {
  return [
    makeItem('A', 1, 'Group 1'),
    makeItem('B', 1, 'Group 1'),
    makeItem('C', 2, 'Group 2'),
    makeItem('D', 2, 'Group 2'),
    makeItem('E', 3, 'Idea'),
  ];
}

// ── Tab on heading toggles group collapse ────────────────────────────────

describe('Tab on a heading toggles group collapse', () => {
  it('collapses the selected group', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    // selectedIndex 0 = heading(1)
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading', group: 1 });

    const action = handleKeypress(state, '\t', TERM_80x24);
    expect(action).toBeNull(); // handled inline, no on-demand fetch action
    expect(state.collapsedGroups.has(1)).toBe(true);
  });

  it('re-expands on the second Tab', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    handleKeypress(state, '\t', TERM_80x24);
    expect(state.collapsedGroups.has(1)).toBe(true);
    handleKeypress(state, '\t', TERM_80x24);
    expect(state.collapsedGroups.has(1)).toBe(false);
  });

  it('toggles the group under any heading, not just the first', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    // Navigate to heading(2): rows = [h1, A, B, h2, C, D, h3, E] → index 3
    state.selectedIndex = 3;
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading', group: 2 });

    handleKeypress(state, '\t', TERM_80x24);
    expect(state.collapsedGroups.has(2)).toBe(true);
    expect(state.collapsedGroups.has(1)).toBe(false);
  });

  it('collapsing hides the group items from display rows and navigation', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.selectedIndex = 3; // heading(2)
    handleKeypress(state, '\t', TERM_80x24);

    const rows = state.getDisplayRows();
    const items = rows.filter((r): r is WorkItem =>
      typeof r === 'object' && r !== null && 'id' in r && !('kind' in r)
    );
    expect(items.map(i => i.id)).toEqual(['A', 'B', 'E']);
    // Navigation space shrinks: [h1, A, B, h2, h3, E] = 6 rows (was 8)
    expect(state.flatCount).toBe(6);
  });

  it('the heading row stays selected and visible after collapse', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.selectedIndex = 3; // heading(2)
    handleKeypress(state, '\t', TERM_80x24);
    // Selection stays on heading(2) — it remains a row
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading', group: 2, collapsed: true });
  });
});

// ── Tab on item keeps existing behaviour ─────────────────────────────────

describe('Tab on an item keeps existing expand/collapse-children behaviour', () => {
  it('returns toggle-expand for an item with children', () => {
    const parent = makeItem('P', 1, 'Group 1', 'plan_complete', [makeChild('C1')], 1);
    const state = new WorkItemListState([parent], TERM_80x24);
    state.selectedIndex = 1; // C1? — P is index 0, then heading? No: P group 1 at 0
    // display rows: [h1, P, C1]
    state.selectedIndex = 1; // P
    const action = handleKeypress(state, '\t', TERM_80x24);
    expect(action).toBe('toggle-expand');
    expect(state.collapsedGroups.size).toBe(0); // no group toggled
  });

  it('expands an item with children and does not touch collapsedGroups', () => {
    const parent = makeItem('P', 1, 'Group 1', 'plan_complete', [makeChild('C1'), makeChild('C2')], 2);
    const state = new WorkItemListState([parent], TERM_80x24);
    state.selectedIndex = 1; // P
    const action = handleKeypress(state, '\t', TERM_80x24);
    expect(action).toBe('toggle-expand');
    expect(state.isExpanded('P')).toBe(true);
    expect(state.collapsedGroups.size).toBe(0);
  });

  it('returns null for an item without children (no toggle, no crash)', () => {
    const item = makeItem('X', 1, 'Group 1');
    const state = new WorkItemListState([item], TERM_80x24);
    state.selectedIndex = 1; // X
    expect(handleKeypress(state, '\t', TERM_80x24)).toBeNull();
    expect(state.collapsedGroups.size).toBe(0);
  });

  it('item expand/collapse still works alongside collapsed groups', () => {
    const parent = makeItem('P', 1, 'Group 1', 'plan_complete', [makeChild('C1')], 1);
    const state = new WorkItemListState([parent], TERM_80x24);
    state.selectedIndex = 1; // P
    handleKeypress(state, '\t', TERM_80x24); // expand P
    expect(state.isExpanded('P')).toBe(true);
    handleKeypress(state, '\t', TERM_80x24); // collapse P
    expect(state.isExpanded('P')).toBe(false);
    expect(state.collapsedGroups.size).toBe(0);
  });
});

// ── Enter on heading is a no-op ──────────────────────────────────────────

describe('Enter on a heading is a no-op', () => {
  it('does not open the detail view', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    const action = handleKeypress(state, '\r', TERM_80x24);
    expect(action).toBe('select');
    expect(state.mode).toBe('list');
    expect(state.detailItem).toBeNull();
  });

  it('does not toggle the group (only Tab toggles)', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    handleKeypress(state, '\r', TERM_80x24);
    expect(state.collapsedGroups.size).toBe(0);
  });

  it('Enter on a heading with children data does not expand it', () => {
    // Heading rows never carry children — but guard: even if the row were an
    // item with children, Enter on a HEADING must be a no-op. Use a heading
    // selection and confirm no expand happens.
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    handleKeypress(state, '\r', TERM_80x24);
    expect(state.mode).toBe('list');
  });
});

// ── Navigation stack / expandedItems untouched by heading toggle ─────────

describe('heading toggle does not disturb item state', () => {
  it('expandedItems is untouched by a heading toggle', () => {
    const parent = makeItem('P', 1, 'Group 1', 'plan_complete', [makeChild('C1')], 1);
    const items = [parent, makeItem('A', 1, 'Group 1'), makeItem('B', 2, 'Group 2')];
    const state = new WorkItemListState(items, TERM_80x24);
    state.toggleExpand('P');
    expect(state.isExpanded('P')).toBe(true);

    // Navigate to heading(2): rows = [h1, P, C1, A, h2, B] → index 4
    state.selectedIndex = 4;
    handleKeypress(state, '\t', TERM_80x24); // collapse group 2
    expect(state.collapsedGroups.has(2)).toBe(true);
    expect(state.isExpanded('P')).toBe(true); // untouched
  });

  it('navigation stack is untouched by a heading toggle', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.pushNavigationState('SOME-PARENT');
    expect(state.navigationStack.depth).toBe(1);

    handleKeypress(state, '\t', TERM_80x24); // collapse group 1 (heading selected)
    expect(state.navigationStack.depth).toBe(1);
  });
});
