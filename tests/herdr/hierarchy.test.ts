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
});

describe('createListRenderer hierarchy', () => {
  it('shows expanded children in rendered output', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] })];
    const renderer = createListRenderer();
    const result = renderer(
      items, 0, 0, defaultTermSize, null, 'list', null, undefined, undefined, 0, false, new Set(['WL-001']),
    );
    expect(result).toContain('WL-001-C1');
    expect(result).toContain('▼');
  });

  it('hides children when parent collapsed', () => {
    const child = makeChildItem('WL-001', 1);
    const items = [makeItem('WL-001', { childCount: 1, children: [child] })];
    const renderer = createListRenderer();
    const result = renderer(
      items, 0, 0, defaultTermSize, null, 'list', null, undefined, undefined, 0, false, new Set<string>(),
    );
    expect(result).not.toContain('WL-001-C1');
    expect(result).toContain('▶');
  });
});
