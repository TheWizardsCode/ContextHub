/**
 * tests/herdr/hierarchy.test.ts — Tests for hierarchical navigation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkItemListState,
  handleKeypress,
  formatItemLine,
  createListRenderer,
  type WorkItem,
  type TermSize,
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

  it('Tab re-fetches children on each press when previous batch was loaded (E2E pipeline)', async () => {
    // First press: expand
    const childItems = [makeItem('WL-001-C1', { depth: 1, childCount: 0 })];
    const items = [makeItem('WL-001', { childCount: 1 })];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(0);

    // Simulate onData for first press
    const flat1 = state.getFlattenedItems();
    flat1[0].children = childItems;
    state.toggleExpand('WL-001');
    expect(state.isExpanded('WL-001')).toBe(true);
    expect(state.getFlattenedItems().length).toBe(2);

    // Second press: collapse
    const action2 = handleKeypress(state, '\t', defaultTermSize);
    expect(action2).toBe('toggle-expand');
    expect(state.isExpanded('WL-001')).toBe(false);
    expect(state.getFlattenedItems().length).toBe(1);

    // Third press: re-expand (after children already loaded, should toggle inline)
    const action3 = handleKeypress(state, '\t', defaultTermSize);
    expect(action3).toBe('toggle-expand');
    expect(state.isExpanded('WL-001')).toBe(true);
    expect(state.getFlattenedItems().length).toBe(2);
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
});
