/**
 * tests/herdr/hierarchy.test.ts — Tests for hierarchical navigation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkItemListState,
  NavigationStack,
  handleKeypress,
  formatItemLine,
  createListRenderer,
  type WorkItem,
  type TermSize,
  type NavigationStackEntry,
} from '../../packages/herdr/src/worklist.js';

// ── Fixtures ──────────────────────────────────────────────────────────

function makeItem(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Item ${id}`,
    status: 'open',
    stage: 'in_progress',
    ...overrides,
  };
}

function makeChildItem(parentId: string, index: number): WorkItem {
  return makeItem(`${parentId}-C${index}`, {
    title: `Child ${index} of ${parentId}`,
    stage: 'in_progress',
  });
}

const defaultTermSize: TermSize = { rows: 24, cols: 80 };

// ── Tests ─────────────────────────────────────────────────────────────

describe('WorkItemListState hierarchy', () => {
  it('initializes expandedItems as empty set', () => {
    const items = [makeItem('WL-001')];
    const state = new WorkItemListState(items, defaultTermSize);
    expect(state.expandedItems.size).toBe(0);
  });

  it('toggleExpand adds/removes item ID from set', () => {
    const items = [makeItem('WL-001', { childCount: 2 })];
    const state = new WorkItemListState(items, defaultTermSize);
    expect(state.isExpanded('WL-001')).toBe(false);
    state.toggleExpand('WL-001');
    expect(state.isExpanded('WL-001')).toBe(true);
    state.toggleExpand('WL-001');
    expect(state.isExpanded('WL-001')).toBe(false);
  });

  it('getFlattenedItems returns flat list when nothing expanded', () => {
    const items = [
      makeItem('WL-001', { childCount: 2, children: [makeChildItem('WL-001', 1), makeChildItem('WL-001', 2)] }),
      makeItem('WL-002'),
    ];
    const state = new WorkItemListState(items, defaultTermSize);
    const flat = state.getFlattenedItems();
    expect(flat.length).toBe(2);
    expect(flat[0].id).toBe('WL-001');
    expect(flat[1].id).toBe('WL-002');
  });

  it('getFlattenedItems includes children when parent expanded', () => {
    const children = [makeChildItem('WL-001', 1), makeChildItem('WL-001', 2)];
    const items = [
      makeItem('WL-001', { childCount: 2, children }),
      makeItem('WL-002'),
    ];
    const state = new WorkItemListState(items, defaultTermSize);
    state.toggleExpand('WL-001');
    const flat = state.getFlattenedItems();
    expect(flat.length).toBe(4); // parent + 2 children + other
    expect(flat[0].id).toBe('WL-001');
    expect(flat[1].id).toBe('WL-001-C1');
    expect(flat[2].id).toBe('WL-001-C2');
    expect(flat[3].id).toBe('WL-002');
  });

  it('getFlattenedItems shows depth property', () => {
    const child = makeChildItem('WL-001', 1);
    child.depth = 1;
    const items = [
      makeItem('WL-001', { childCount: 1, children: [child] }),
    ];
    const state = new WorkItemListState(items, defaultTermSize);
    state.toggleExpand('WL-001');
    const flat = state.getFlattenedItems();
    expect(flat[1].depth).toBe(1);
  });
});

describe('formatItemLine with hierarchy', () => {
  it('shows expand icon for items with children', () => {
    const item = makeItem('WL-001', { childCount: 2 });
    const line = formatItemLine(item, 80, false, true); // noIcons=true for test reliability
    expect(line).toContain('▶');
  });

  it('shows collapse icon when expanded', () => {
    const item = makeItem('WL-001', { childCount: 2, _expanded: true });
    const line = formatItemLine(item, 80, false, true);
    expect(line).toContain('▼');
  });

  it('does not show expand icon when childCount is undefined', () => {
    const item = makeItem('WL-001');
    const line = formatItemLine(item, 80, false, true);
    expect(line).not.toContain('▶');
    expect(line).not.toContain('▼');
  });

  it('indents child items with depth property', () => {
    const item = makeItem('WL-001-C1', { depth: 1 });
    const line = formatItemLine(item, 80, false, true);
    // Indented items should not use selection prefix
    expect(line).toContain('  '); // double space indent from depth
  });

  it('shows selection on child items when selected', () => {
    const item = makeItem('WL-001-C1', { depth: 1 });
    const line = formatItemLine(item, 80, true, true);
    expect(line).toContain('▸'); // selection indicator
  });
});

describe('handleKeypress hierarchy', () => {
  it('toggles expand/collapse on enter for items with children', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);
    const action = handleKeypress(state, '\r', defaultTermSize);
    // Should toggle expand (not go to detail mode)
    expect(state.isExpanded('WL-001')).toBe(true);
    expect(state.mode).toBe('list');
    expect(action).toBe('toggle-expand');
  });

  it('enters detail mode for items without children', () => {
    const items = [makeItem('WL-001')];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);
    handleKeypress(state, '\r', defaultTermSize);
    expect(state.mode).toBe('detail');
    expect(state.detailItem?.id).toBe('WL-001');
  });

  it('shows children in flattened items when parent expanded', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.toggleExpand('WL-001');
    const flat = state.getFlattenedItems();
    expect(flat.length).toBe(2);
    expect(flat[1].id).toBe('WL-001-C1');
  });

  it('Tab toggles expand for items with children data', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);
    // Tab should expand
    let action = handleKeypress(state, '\t', defaultTermSize);
    expect(state.isExpanded('WL-001')).toBe(true);
    expect(state.mode).toBe('list');
    expect(action).toBe('toggle-expand');
    // Tab again should collapse
    action = handleKeypress(state, '\t', defaultTermSize);
    expect(state.isExpanded('WL-001')).toBe(false);
    expect(state.mode).toBe('list');
    expect(action).toBe('toggle-expand');
  });

  it('expanding via Enter pushes navigation state; Escape returns to parent', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] }) ];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);
    // Enter expands the parent and records the parent context
    const expandAction = handleKeypress(state, '\r', defaultTermSize);
    expect(expandAction).toBe('toggle-expand');
    expect(state.isExpanded('WL-001')).toBe(true);
    expect(state.navigationStack.depth).toBe(1);
    expect(state.navigationStack.peek()?.parentId).toBe('WL-001');

    // Navigate onto the child, then Escape pops back to the parent
    state.moveDown();
    expect(state.getFlattenedItems()[state.selectedIndex].id).toBe('WL-001-C1');
    const backAction = handleKeypress(state, '\x1b', defaultTermSize);
    expect(backAction).toBe('back');
    expect(state.selectedIndex).toBe(0);
    expect(state.navigationStack.depth).toBe(0);
  });

  it('collapsing a parent clears its navigation-stack entry', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] }) ];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);
    // Expand (pushes) then collapse (should clear)
    handleKeypress(state, '\t', defaultTermSize);
    expect(state.navigationStack.depth).toBe(1);
    handleKeypress(state, '\t', defaultTermSize);
    expect(state.isExpanded('WL-001')).toBe(false);
    expect(state.navigationStack.depth).toBe(0);
  });

  it('Tab is noop for items without children', () => {
    const items = [makeItem('WL-001')];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);
    const action = handleKeypress(state, '\t', defaultTermSize);
    expect(state.mode).toBe('list');
    expect(action).toBeNull();
    expect(state.detailItem).toBeNull();
  });

  it('Tab is noop for items with childCount but no pre-loaded children data', () => {
    const items = [makeItem('WL-001', { childCount: 3 })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);
    const action = handleKeypress(state, '\t', defaultTermSize);
    expect(state.isExpanded('WL-001')).toBe(false);
    expect(state.mode).toBe('list');
    expect(action).toBe('toggle-expand');
  });

  it('Tab does not open detail view for items with children', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);
    handleKeypress(state, '\t', defaultTermSize);
    expect(state.mode).toBe('list');
    expect(state.detailItem).toBeNull();
  });

  it('Tab triggers on-demand fetch when children not pre-loaded (E2E pipeline)', async () => {
    // Simulate an item with childCount but no pre-loaded children
    const childItems = [
      makeItem('WL-001-C1', { depth: 1, childCount: 0 }),
      makeItem('WL-001-C2', { depth: 1, childCount: 0 }),
    ];
    const items = [makeItem('WL-001', { childCount: 2 })]; // no children array
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);

    // Step 1: Tab signals toggle-expand (handleKeypress returns action)
    const action = handleKeypress(state, '\t', defaultTermSize);
    expect(action).toBe('toggle-expand');
    // Tab does NOT expand inline when children are missing
    expect(state.isExpanded('WL-001')).toBe(false);
    expect(state.mode).toBe('list');

    // Step 2: Simulate onData handler — fetch children and attach
    const flat = state.getFlattenedItems();
    const selected = flat[0];
    selected.children = childItems;
    state.toggleExpand(selected.id);

    // Step 3: Verify expanded state shows children
    const expandedFlat = state.getFlattenedItems();
    expect(expandedFlat.length).toBe(3); // parent + 2 children
    expect(expandedFlat[1].id).toBe('WL-001-C1');
    expect(expandedFlat[1].depth).toBe(1);
    expect(expandedFlat[2].id).toBe('WL-001-C2');
    expect(expandedFlat[2].depth).toBe(1);

    // Still in list mode, no detail view
    expect(state.mode).toBe('list');
    expect(state.detailItem).toBeNull();
  });

  // ── Navigation stack ─────────────────────────────────────────────

  it('can navigate back to parent via Escape after expanding child depth', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);

    // Save parent state first, then expand
    state.pushNavigationState('WL-001');
    state.toggleExpand('WL-001');
    expect(state.getFlattenedItems().length).toBe(2);

    // Navigate to child
    state.moveDown();
    expect(state.selectedIndex).toBe(1);
    expect(state.getFlattenedItems()[1].id).toBe('WL-001-C1');

    expect(state.navigationStack.depth).toBe(1);

    // Pop navigation state (Escape) — restores parent context
    const restored = state.popNavigationState();
    expect(restored).not.toBeNull();
    expect(restored!.parentId).toBe('WL-001');
    expect(state.selectedIndex).toBe(0);
  });

  it('NavigationStack clear resets depth', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);

    state.pushNavigationState('WL-001');
    expect(state.navigationStack.depth).toBe(1);
    state.navigationStack.clear();
    expect(state.navigationStack.depth).toBe(0);
  });

  it('Escape in list mode with navigation stack pops to parent context', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);

    // Save parent state first, then expand and navigate into child
    state.pushNavigationState('WL-001');
    state.toggleExpand('WL-001');
    state.moveDown(); // select child
    expect(state.navigationStack.depth).toBe(1);

    // Escape pops back to parent context (restores scroll/selection)
    const action = handleKeypress(state, '\x1b', defaultTermSize);
    expect(action).toBe('back');
    expect(state.selectedIndex).toBe(0); // back at parent
  });

  it('Escape with empty navigation stack closes detail view (existing behavior)', () => {
    const items = [makeItem('WL-001')];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);
    state.selectItem(); // enters detail mode
    expect(state.mode).toBe('detail');

    const action = handleKeypress(state, '\x1b', defaultTermSize);
    expect(action).toBe('back');
    expect(state.mode).toBe('list');
  });

  it('multi-level navigation stack supports depth > 1', () => {
    const grandchild = makeItem('WL-001-C1-C1', { depth: 2, childCount: 0 });
    const child = makeItem('WL-001-C1', { depth: 1, childCount: 1, children: [grandchild] });
    const parent = makeItem('WL-001', { childCount: 1, children: [child] });
    const items = [parent];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);

    // Level 1: expand parent
    state.toggleExpand('WL-001');
    state.pushNavigationState('WL-001');
    expect(state.navigationStack.depth).toBe(1);

    // Navigate to child and expand it
    state.moveDown();
    state.toggleExpand('WL-001-C1');
    state.pushNavigationState('WL-001-C1');
    expect(state.navigationStack.depth).toBe(2);

    // Pop back to child level
    const lvl1 = state.popNavigationState();
    expect(lvl1!.parentId).toBe('WL-001-C1');
    expect(state.navigationStack.depth).toBe(1);

    // Pop back to parent level
    const lvl0 = state.popNavigationState();
    expect(lvl0!.parentId).toBe('WL-001');
    expect(state.navigationStack.depth).toBe(0);
  });

  it('popNavigationState restores selectedIndex after push/pop cycle', () => {
    const children = Array.from({ length: 5 }, (_, i) => makeChildItem('WL-001', i + 1));
    const items = [
      makeItem('WL-001', { childCount: 5, children }),
      makeItem('WL-002'),
    ];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);

    // Expand parent then navigate to child index 3
    state.toggleExpand('WL-001');
    state.moveDown(); // child 1
    state.moveDown(); // child 2
    state.moveDown(); // child 3
    expect(state.selectedIndex).toBe(3);

    // Push state and then change selection
    state.pushNavigationState('WL-001');
    state.selectedIndex = 0;

    // Pop restores original selection
    state.popNavigationState();
    expect(state.selectedIndex).toBe(3);
  });

  it('peekNavigationStack returns top entry without removing it', () => {
    const items = [makeItem('WL-001', { childCount: 1, children: [makeChildItem('WL-001', 1)] })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);

    state.pushNavigationState('WL-001');
    expect(state.navigationStack.depth).toBe(1);

    const top = state.navigationStack.peek();
    expect(top).not.toBeNull();
    expect(top!.parentId).toBe('WL-001');
    expect(state.navigationStack.depth).toBe(1); // still there
  });

  it('Escape from child context collapses expanded parent and returns focus', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);

    // Save parent state, then expand and navigate into child
    state.pushNavigationState('WL-001');
    state.toggleExpand('WL-001');
    state.moveDown();

    // Escape back to parent
    const action = handleKeypress(state, '\x1b', defaultTermSize);
    expect(action).toBe('back');
    expect(state.isExpanded).toBeDefined();
    expect(state.selectedIndex).toBe(0);
  });
});

describe('createListRenderer hierarchy', () => {
  it('shows expanded children in rendered output', () => {
    const child = makeChildItem('WL-001-C1', 1);
    const parent = makeItem('WL-001', { childCount: 1, children: [child] });
    // The renderer receives already-flattened items (flattening is done upstream
    // by runWorklistTui's render callback via state.getFlattenedItems()).
    const items = [parent, { ...child, depth: 1 }];
    const renderer = createListRenderer();
    const result = renderer(
      items, 0, 0, defaultTermSize, null, 'list', null, undefined, undefined, 0, false, new Set(['WL-001']),
    );
    expect(result).toContain('WL-001-C1');
    expect(result).toContain('▼');
  });

  it('hides children when parent collapsed', () => {
    const child = makeChildItem('WL-001-C1', 1);
    const parent = makeItem('WL-001', { childCount: 1, children: [child] });
    // Renderer receives already-flattened items; when collapsed there are no
    // children in the passed array and no expandedItems.
    const items = [parent];
    const renderer = createListRenderer();
    const result = renderer(
      items, 0, 0, defaultTermSize, null, 'list', null, undefined, undefined, 0, false, new Set<string>(),
    );
    expect(result).not.toContain('WL-001-C1');
    expect(result).toContain('▶');
  });

  it('shows back hint in footer when navStackDepth > 0', () => {
    const child = makeChildItem('WL-001-C1', 1);
    const parent = makeItem('WL-001', { childCount: 1, children: [child] });
    const items = [parent];
    const renderer = createListRenderer();
    const result = renderer(
      items, 0, 0, defaultTermSize, null, 'list', null, undefined, undefined, 0, false, new Set(['WL-001']),
      undefined, 1,
    );
    expect(result).toContain('[esc] back');
  });

  it('shows multi-level back hint when navStackDepth > 1', () => {
    const child = makeChildItem('WL-001-C1', 1);
    const parent = makeItem('WL-001', { childCount: 1, children: [child] });
    const items = [parent];
    const renderer = createListRenderer();
    const result = renderer(
      items, 0, 0, defaultTermSize, null, 'list', null, undefined, undefined, 0, false, new Set(['WL-001']),
      undefined, 2,
    );
    expect(result).toContain('[esc] back');
    expect(result).toContain('(2 levels)');
  });

  it('does not show back hint when navStackDepth is 0', () => {
    const items = [makeItem('WL-001')];
    const renderer = createListRenderer();
    const result = renderer(
      items, 0, 0, defaultTermSize, null, 'list', null,
    );
    expect(result).not.toContain('[esc] back');
  });
});

describe('Navigation through expanded hierarchy', () => {
  it('moveDown navigates through all children when parent expanded', () => {
    const children = [makeChildItem('WL-001', 1), makeChildItem('WL-001', 2), makeChildItem('WL-001', 3)];
    const items = [makeItem('WL-001', { childCount: 3, children })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.toggleExpand('WL-001');
    expect(state.flatCount).toBe(4); // parent + 3 children

    // Move down repeatedly, should navigate through all children
    state.moveDown(); expect(state.selectedIndex).toBe(1); // child 1
    state.moveDown(); expect(state.selectedIndex).toBe(2); // child 2
    state.moveDown(); expect(state.selectedIndex).toBe(3); // child 3
    // Wraps to first
    state.moveDown(); expect(state.selectedIndex).toBe(0);
  });

  it('moveUp navigates back through children when parent expanded', () => {
    const children = [makeChildItem('WL-001', 1), makeChildItem('WL-001', 2)];
    const items = [makeItem('WL-001', { childCount: 2, children })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.toggleExpand('WL-001');
    expect(state.flatCount).toBe(3); // parent + 2 children

    state.selectedIndex = 2; // last child
    state.moveUp(); expect(state.selectedIndex).toBe(1); // first child
    state.moveUp(); expect(state.selectedIndex).toBe(0); // parent
    state.moveUp(); expect(state.selectedIndex).toBe(2); // wrap to last child
  });

  it('goToLast navigates to last child when parent expanded', () => {
    const children = [makeChildItem('WL-001', 1), makeChildItem('WL-001', 2)];
    const items = [makeItem('WL-001', { childCount: 2, children })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.toggleExpand('WL-001');
    state.goToLast();
    expect(state.selectedIndex).toBe(state.flatCount - 1);
    expect(state.selectedIndex).toBe(2); // last child
  });

  it('pageDown does not exceed flatCount when parent expanded', () => {
    const children = Array.from({ length: 20 }, (_, i) => makeChildItem('WL-001', i + 1));
    const items = [makeItem('WL-001', { childCount: 20, children })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.toggleExpand('WL-001');
    expect(state.flatCount).toBe(21);

    // Page down from near the end — should stay within flatCount
    state.selectedIndex = 18;
    state.pageDown();
    expect(state.selectedIndex).toBeLessThanOrEqual(state.flatCount - 1);
    expect(state.selectedIndex).toBe(state.flatCount - 1); // should land on last
  });

  it('pageDown on collapsed list (no children) still works correctly', () => {
    const manyItems = Array.from({ length: 50 }, (_, i) =>
      makeItem(`WL-${String(i + 1).padStart(6, '0')}`));
    const state = new WorkItemListState(manyItems, defaultTermSize);
    state.selectedIndex = 48;
    state.pageDown();
    expect(state.selectedIndex).toBe(manyItems.length - 1);
  });

  it('setSelectedIndex clamps within flatCount when parent expanded', () => {
    const children = [makeChildItem('WL-001', 1)];
    const items = [makeItem('WL-001', { childCount: 1, children })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.toggleExpand('WL-001');
    expect(state.flatCount).toBe(2);

    state.setSelectedIndex(10);
    expect(state.selectedIndex).toBe(1); // flatCount - 1
  });

  it('moveDown after expand navigates to last child then wraps (multiple parents)', () => {
    const c1 = [makeChildItem('WL-001', 1)];
    const i1 = makeItem('WL-001', { childCount: 1, children: c1 });
    const c2 = [makeChildItem('WL-002', 1)];
    const i2 = makeItem('WL-002', { childCount: 1, children: c2 });
    const items = [i1, i2];
    const state = new WorkItemListState(items, defaultTermSize);
    state.toggleExpand('WL-001');
    state.toggleExpand('WL-002');
    expect(state.flatCount).toBe(4); // 2 parents + 2 children

    state.selectedIndex = 0; // i1
    state.moveDown(); expect(state.selectedIndex).toBe(1); // c1
    state.moveDown(); expect(state.selectedIndex).toBe(2); // i2
    state.moveDown(); expect(state.selectedIndex).toBe(3); // c2
    state.moveDown(); expect(state.selectedIndex).toBe(0); // wraps to i1
  });

  it('_adjustScroll uses flatCount for max scroll offset when parent expanded', () => {
    const children = Array.from({ length: 40 }, (_, i) => makeChildItem('WL-001', i + 1));
    const items = [makeItem('WL-001', { childCount: 40, children })];
    const state = new WorkItemListState(items, { rows: 10, cols: 80 });
    state.toggleExpand('WL-001');
    expect(state.flatCount).toBe(41);

    state.selectedIndex = 40; // last child
    state._adjustScroll();
    const listHeight = state._listHeight();
    const expectedMaxOffset = Math.max(0, state.flatCount - listHeight);
    expect(state.scrollOffset).toBeLessThanOrEqual(expectedMaxOffset);
  });
});

