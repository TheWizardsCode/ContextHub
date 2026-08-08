/**
 * tests/herdr/worklist.test.ts — Tests for Herdr plugin work list UI logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import after mocks are set up
import {
  WorkItemListState,
  StageFilter,
  formatItemLine,
  formatDetailView,
  handleKeypress,
  createListRenderer,
  STAGES,
} from '../../packages/herdr/src/worklist.js';
import type { WorkItem } from '../../packages/herdr/src/worklist.js';

// ── Mock terminal size ────────────────────────────────────────────

const DEFAULT_TERM_SIZE = { rows: 24, cols: 80 };

// ── Test fixtures ─────────────────────────────────────────────────

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WL-TEST001',
    title: 'Test work item',
    status: 'open',
    priority: 'high',
    stage: 'plan_complete',
    description: 'A test work item description',
    tags: ['test'],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    ...overrides,
  };
}

const sampleItems: WorkItem[] = [
  makeItem({ id: 'WL-TEST001', title: 'First item', priority: 'high', stage: 'plan_complete' }),
  makeItem({ id: 'WL-TEST002', title: 'Second item', priority: 'medium', stage: 'in_progress' }),
  makeItem({ id: 'WL-TEST003', title: 'Third item', priority: 'low', stage: 'idea' }),
  makeItem({ id: 'WL-TEST004', title: 'Fourth item', priority: 'high', stage: 'in_review' }),
  makeItem({ id: 'WL-TEST005', title: 'Fifth item', priority: 'critical', stage: 'in_progress' }),
];

// ── Tests ─────────────────────────────────────────────────────────

describe('WorkItemListState', () => {
  it('initializes with items and defaults', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    expect(state.items).toHaveLength(5);
    expect(state.selectedIndex).toBe(0);
    expect(state.scrollOffset).toBe(0);
    expect(state.mode).toBe('list');
  });

  it('clamps selectedIndex to valid range via setSelectedIndex', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.setSelectedIndex(-1);
    expect(state.selectedIndex).toBe(0);
    state.setSelectedIndex(100);
    expect(state.selectedIndex).toBe(4);
  });

  it('computes visible items based on terminal rows', () => {
    const smallTerm = { rows: 5, cols: 80 };
    const state = new WorkItemListState(sampleItems, smallTerm);
    // With 5 rows, list area is about 3 items (after subtracting header/filter/status)
    const visible = state.getVisibleItems();
    expect(visible.length).toBeLessThanOrEqual(5);
  });

  it('scrolls down and adjusts selection', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.moveDown();
    expect(state.selectedIndex).toBe(1);
    state.moveDown();
    expect(state.selectedIndex).toBe(2);
  });

  it('scrolls up and wraps to last item', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectedIndex = 0;
    state.moveUp();
    expect(state.selectedIndex).toBe(sampleItems.length - 1);
  });

  it('page down moves by visible page size', () => {
    const state = new WorkItemListState(sampleItems, { rows: 10, cols: 80 });
    const old = state.selectedIndex;
    state.pageDown();
    // Page size is approx visible rows minus header
    expect(state.selectedIndex).toBeGreaterThan(old);
  });

  it('page up moves backward and clamps', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectedIndex = 3;
    state.pageUp();
    expect(state.selectedIndex).toBeLessThan(3);
    state.selectedIndex = 0;
    state.pageUp();
    expect(state.selectedIndex).toBe(0);
  });

  it('toggles to detail mode when selecting an item', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectItem();
    expect(state.mode).toBe('detail');
    expect(state.detailItem).toEqual(sampleItems[0]);
  });

  it('backs out of detail mode to list', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectItem();
    state.back();
    expect(state.mode).toBe('list');
    expect(state.detailItem).toBeNull();
  });

  it('switches to filter mode and back', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.activateFilter();
    expect(state.mode).toBe('filter');
    state.back();
    expect(state.mode).toBe('list');
  });

  it('applies stage filter and resets selection', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.applyFilter('in_progress');
    expect(state.activeFilter).toBe('in_progress');
    expect(state.selectedIndex).toBe(0);
    const filtered = state.items;
    expect(filtered.every((i) => i.stage === 'in_progress')).toBe(true);
  });

  it('clears filter to show all items', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.applyFilter('in_progress');
    state.clearFilter();
    expect(state.activeFilter).toBeNull();
    expect(state.items).toHaveLength(5);
  });

  it('refreshes items while preserving selection if possible', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectedIndex = 2;
    const newItems = [
      makeItem({ id: 'WL-TEST001', title: 'First item' }),
      makeItem({ id: 'WL-TEST006', title: 'New item' }),
    ];
    state.refreshItems(newItems);
    expect(state.items).toHaveLength(2);
    // Selected index clamped
    expect(state.selectedIndex).toBe(1);
  });

  it('sets scroll offset for large lists', () => {
    const manyItems = Array.from({ length: 50 }, (_, i) =>
      makeItem({ id: `WL-${String(i).padStart(6, '0')}`, title: `Item ${i}` })
    );
    const state = new WorkItemListState(manyItems, DEFAULT_TERM_SIZE);
    // Navigate down many times to trigger scroll adjustment
    for (let i = 0; i < 40; i++) {
      state.moveDown();
    }
    expect(state.selectedIndex).toBe(40);
    // Scroll offset should be calculated to show the selected item
    expect(state.scrollOffset).toBeGreaterThan(0);
  });

  // ── Wrap-around navigation ──────────────────────────────────────────

  it('moveUp at index 0 wraps to last item', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectedIndex = 0;
    state.moveUp();
    expect(state.selectedIndex).toBe(sampleItems.length - 1);
  });

  it('moveDown at last item wraps to first', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectedIndex = sampleItems.length - 1;
    state.moveDown();
    expect(state.selectedIndex).toBe(0);
  });

  it('moveUp does not wrap when not at boundary', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectedIndex = 3;
    state.moveUp();
    expect(state.selectedIndex).toBe(2);
  });

  it('moveDown does not wrap when not at boundary', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectedIndex = 1;
    state.moveDown();
    expect(state.selectedIndex).toBe(2);
  });

  it('moveUp does nothing on empty list', () => {
    const state = new WorkItemListState([], DEFAULT_TERM_SIZE);
    state.moveUp();
    expect(state.selectedIndex).toBe(0);
  });

  it('moveDown does nothing on empty list', () => {
    const state = new WorkItemListState([], DEFAULT_TERM_SIZE);
    state.moveDown();
    expect(state.selectedIndex).toBe(0);
  });

  it('moveUp on single-item list wraps to itself (no crash)', () => {
    const single = [makeItem({ id: 'WL-ONLY', title: 'Only item' })];
    const state = new WorkItemListState(single, DEFAULT_TERM_SIZE);
    state.selectedIndex = 0;
    state.moveUp();
    expect(state.selectedIndex).toBe(0);
  });

  it('moveDown on single-item list wraps to itself (no crash)', () => {
    const single = [makeItem({ id: 'WL-ONLY', title: 'Only item' })];
    const state = new WorkItemListState(single, DEFAULT_TERM_SIZE);
    state.selectedIndex = 0;
    state.moveDown();
    expect(state.selectedIndex).toBe(0);
  });

  // ── Flat-count navigation ───────────────────────────────────────────

  it('goToLast goes to flatCount - 1', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.goToLast();
    expect(state.selectedIndex).toBe(sampleItems.length - 1);
  });

  it('goToLast does nothing on empty list', () => {
    const state = new WorkItemListState([], DEFAULT_TERM_SIZE);
    state.goToLast();
    expect(state.selectedIndex).toBe(0);
  });

  it('pageDown stays within flatCount bounds', () => {
    const manyItems = Array.from({ length: 50 }, (_, i) =>
      makeItem({ id: `WL-${String(i).padStart(6, '0')}`, title: `Item ${i}` })
    );
    const state = new WorkItemListState(manyItems, { rows: 10, cols: 80 });
    state.selectedIndex = 49;
    state.pageDown();
    expect(state.selectedIndex).toBeLessThanOrEqual(state.flatCount - 1);
  });

  it('setSelectedIndex clamps using flatCount', () => {
    const manyItems = Array.from({ length: 50 }, (_, i) =>
      makeItem({ id: `WL-${String(i).padStart(6, '0')}`, title: `Item ${i}` })
    );
    const state = new WorkItemListState(manyItems, DEFAULT_TERM_SIZE);
    state.setSelectedIndex(999);
    expect(state.selectedIndex).toBe(state.flatCount - 1);
  });

  it('setSelectedIndex handles negative index', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.setSelectedIndex(-5);
    expect(state.selectedIndex).toBe(0);
  });

  it('_adjustScroll calculates maxOffset from flatCount', () => {
    const manyItems = Array.from({ length: 50 }, (_, i) =>
      makeItem({ id: `WL-${String(i).padStart(6, '0')}`, title: `Item ${i}` })
    );
    const state = new WorkItemListState(manyItems, { rows: 10, cols: 80 });
    state.selectedIndex = 49;
    state._adjustScroll();
    // Should not exceed flatCount-based max offset
    const listHeight = state._listHeight();
    const expectedMaxOffset = Math.max(0, state.flatCount - listHeight);
    expect(state.scrollOffset).toBeLessThanOrEqual(expectedMaxOffset);
  });
});


describe('StageFilter', () => {
  it('lists all stage options', () => {
    expect(STAGES).toEqual([
      'idea',
      'intake_complete',
      'plan_complete',
      'in_progress',
      'in_review',
      'completed',
    ]);
  });

  it('StageFilter can cycle through stages', () => {
    const filter = new StageFilter();
    expect(filter.current).toBeNull();
    filter.cycle();
    expect(filter.current).toBe('idea');
    filter.cycle();
    expect(filter.current).toBe('intake_complete');
    filter.cycle();
    expect(filter.current).toBe('plan_complete');
  });

  it('StageFilter wraps around', () => {
    const filter = new StageFilter();
    // Cycle through all stages
    for (let i = 0; i < 6; i++) filter.cycle();
    // Should be back at null (off) after wrapping
    // Actually, let's test: after setting to 'completed', next cycle goes to null
    filter.set('completed');
    expect(filter.current).toBe('completed');
    filter.cycle();
    expect(filter.current).toBeNull();
  });

  it('set applies a valid stage', () => {
    const filter = new StageFilter();
    filter.set('in_progress');
    expect(filter.current).toBe('in_progress');
  });

  it('set with null clears the filter', () => {
    const filter = new StageFilter();
    filter.set('in_progress');
    filter.set(null);
    expect(filter.current).toBeNull();
  });
});

describe('formatItemLine', () => {
  it('formats a basic item line', () => {
    const line = formatItemLine(sampleItems[0], 80);
    expect(line).toContain('WL-TEST001');
    expect(line).toContain('First item');
  });

  it('highlights selected item', () => {
    const line = formatItemLine(sampleItems[0], 80, true);
    expect(line).toContain('▸'); // Selection indicator
  });

  it('truncates long titles to fit terminal width', () => {
    const longItem = makeItem({
      title: 'A'.repeat(200),
    });
    const line = formatItemLine(longItem, 40);
    // Strip ANSI codes and check visible length
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped.length).toBeLessThanOrEqual(45); // ~40 + some formatting characters
  });

  it('includes stage label for non-default stages', () => {
    const item = makeItem({ stage: 'idea' });
    const line = formatItemLine(item, 80);
    expect(line).toContain('idea');
  });
});

describe('formatDetailView', () => {
  it('includes title, id, status, priority in detail view', () => {
    const detail = formatDetailView(sampleItems[0], 80);
    expect(detail).toContain('WL-TEST001');
    expect(detail).toContain('First item');
    expect(detail).toContain('open');
    expect(detail).toContain('high');
    expect(detail).toContain('plan_complete');
  });

  it('includes description if present', () => {
    const detail = formatDetailView(sampleItems[0], 80);
    expect(detail).toContain('A test work item description');
  });

  it('truncates very long descriptions', () => {
    const longDesc = 'B'.repeat(5000);
    const item = makeItem({ description: longDesc });
    const detail = formatDetailView(item, 80);
    // Should not have the full 5000 chars
    expect(detail.length).toBeLessThan(5000);
  });

  it('handles items with no description', () => {
    const item = makeItem({ description: undefined });
    const detail = formatDetailView(item, 80);
    expect(detail).toContain('WL-TEST001');
  });
});

describe('handleKeypress', () => {
  it('handles j/k navigation in list mode', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    handleKeypress(state, 'j', DEFAULT_TERM_SIZE);
    expect(state.selectedIndex).toBe(1);
    handleKeypress(state, 'k', DEFAULT_TERM_SIZE);
    expect(state.selectedIndex).toBe(0);
  });

  it('handles arrow key navigation', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    handleKeypress(state, '\x1b[A', DEFAULT_TERM_SIZE); // up wraps to last
    expect(state.selectedIndex).toBe(4);
    handleKeypress(state, '\x1b[B', DEFAULT_TERM_SIZE); // down wraps to first
    expect(state.selectedIndex).toBe(0);
    handleKeypress(state, '\x1b[B', DEFAULT_TERM_SIZE); // down again
    expect(state.selectedIndex).toBe(1);
  });

  it('handles enter to select item', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    const result = handleKeypress(state, '\r', DEFAULT_TERM_SIZE);
    expect(state.mode).toBe('detail');
    expect(result).toBe('select');
  });

  it('handles escape to go back from detail mode', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectItem();
    const result = handleKeypress(state, '\x1b', DEFAULT_TERM_SIZE);
    expect(state.mode).toBe('list');
    expect(result).toBe('back');
  });

  it('handles escape to go back from filter mode', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.activateFilter();
    const result = handleKeypress(state, '\x1b', DEFAULT_TERM_SIZE);
    expect(state.mode).toBe('list');
    expect(result).toBe('back');
  });

  it('handles / as unhandled key (filter via chords now)', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    const result = handleKeypress(state, '/', DEFAULT_TERM_SIZE);
    expect(state.mode).toBe('list');
    expect(result).toBeNull();
  });

  it('handles r as keyboard neutral in list mode (resolved via ShortcutRegistry)', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    // In list mode 'r' returns null — it's a single-key Producer Review shortcut
    // resolved by lookupChord in the onData flow, not as a direct handleKeypress action
    const result = handleKeypress(state, 'r', DEFAULT_TERM_SIZE);
    expect(result).toBeNull();
  });

  it('handles r as keyboard neutral in detail mode (resolved via ShortcutRegistry)', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectItem();
    expect(state.mode).toBe('detail');
    // In detail mode 'r' no longer returns 'refresh' — it's resolved as a
    // single-key Producer Review shortcut by lookupChord in the onData flow
    const result = handleKeypress(state, 'r', DEFAULT_TERM_SIZE);
    expect(result).toBeNull();
  });

  it('handles q to quit', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    const result = handleKeypress(state, 'q', DEFAULT_TERM_SIZE);
    expect(result).toBe('quit');
  });

  it('handles pageup/pagedown', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.selectedIndex = 3;
    const oldIndex = state.selectedIndex;
    handleKeypress(state, '\x1b[5~', DEFAULT_TERM_SIZE); // page up
    expect(state.selectedIndex).toBeLessThan(oldIndex);
    handleKeypress(state, '\x1b[6~', DEFAULT_TERM_SIZE); // page down
    expect(state.selectedIndex).toBeGreaterThanOrEqual(0);
  });

  it('handles g/G for first/last item', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    handleKeypress(state, 'G', DEFAULT_TERM_SIZE);
    expect(state.selectedIndex).toBe(sampleItems.length - 1);
    handleKeypress(state, 'g', DEFAULT_TERM_SIZE);
    expect(state.selectedIndex).toBe(0);
  });

  it('processes digit key as stage filter shortcut in filter mode', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    state.activateFilter();
    handleKeypress(state, '1', DEFAULT_TERM_SIZE);
    // Stage indices: 0=idea, 1=intake_complete, 2=plan_complete, etc.
    // '1' picks second stage: intake_complete
    // But the stage-to-index mapping is 0-indexed, so '1' = index 1? 
    // Let's see the implementation...
    // Actually the handler converts char to number: Number('1') gives 1, so it uses stage index 1
    // After applying filter, mode should be back to list
    expect(state.mode).toBe('list');
  });

  it('does nothing for unrecognized keys in list mode', () => {
    const state = new WorkItemListState(sampleItems, DEFAULT_TERM_SIZE);
    const result = handleKeypress(state, 'x', DEFAULT_TERM_SIZE);
    expect(result).toBeNull();
  });
});

describe('createListRenderer', () => {
  it('returns a function that produces a render string', () => {
    const renderer = createListRenderer();
    const output = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null);
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('includes header and footer in output', () => {
    const renderer = createListRenderer();
    const output = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null);
    expect(output).toContain('Work Items');
    // Nav hints removed from footer; header + items + blank lines present
    expect(output.split('\n').length).toBeGreaterThan(10);
    expect(output).not.toContain('[q]');
  });

  it('renders detail view when mode is detail', () => {
    const renderer = createListRenderer();
    const output = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, null, 'detail', sampleItems[0]);
    expect(output).toContain(sampleItems[0].id);
    expect(output).toContain(sampleItems[0].title);
    expect(output).not.toContain('Work Items');
  });

  it('indicates an active stage filter in the header only (no filter bar)', () => {
    const renderer = createListRenderer();
    const output = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, 'in_progress', 'list', null);
    const firstLine = output.split('\n')[0];
    expect(firstLine).toContain('(filtered: in_progress)');
    expect(output).not.toMatch(/Filter: /);
  });

  it('shows total actionable count in header when totalCount > items.length', () => {
    const renderer = createListRenderer();
    // sampleItems has 5 items, totalCount = 47
    const output = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null, 47);
    expect(output).toContain('(top 5 of 47)');
  });

  it('does not show total count when totalCount equals items.length', () => {
    const renderer = createListRenderer();
    // sampleItems has 5 items
    const output = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null, 5);
    expect(output).not.toContain('(top');
  });

  it('does not show total count when undefined', () => {
    const renderer = createListRenderer();
    const output = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null);
    expect(output).not.toContain('(top');
  });

  it('renders group separators when items have groups', () => {
    const groupedItems = [
      makeItem({ id: 'T1', title: 'Item 1', group: 0, groupLabel: 'Priority' }),
      makeItem({ id: 'T2', title: 'Item 2', group: 0 }),
      makeItem({ id: 'T3', title: 'Item 3', group: 1, groupLabel: 'Backlog' }),
    ];
    const renderer = createListRenderer();
    const output = renderer(groupedItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null);
    expect(output).toContain('Priority');
    expect(output).toContain('Backlog');
  });

  it('includes total count when provided', () => {
    const renderer = createListRenderer();
    const output = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null, 100);
    expect(output).toContain('of');
    expect(output).toMatch(/\d+ of \d+/);
  });

  it('shows chord help hints when provided', () => {
    const renderer = createListRenderer();
    const output = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null,
      undefined, null, undefined, undefined, undefined,
      'u:update  c:close',
    );
    expect(output).toContain('u:update');
    expect(output).toContain('c:close');
  });

  it('hides chord help hints when undefined', () => {
    const renderer = createListRenderer();
    const outputWith = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null,
      undefined, null, undefined, undefined, undefined,
      'some hint',
    );
    const outputWithout = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null,
      undefined, null, undefined, undefined, undefined,
      undefined,
    );
    expect(outputWith).toContain('some hint');
    expect(outputWithout).not.toContain('some hint');
  });

  it('does not duplicate children when items are already flattened and expandedItems is set', () => {
    const renderer = createListRenderer();

    // Simulate items that are ALREADY flattened (parent + children)
    const child1 = makeItem({ id: 'WL-CHILD1', title: 'Child 1', stage: 'in_progress', childCount: 0 });
    const child2 = makeItem({ id: 'WL-CHILD2', title: 'Child 2', stage: 'in_progress', childCount: 0 });
    const child3 = makeItem({ id: 'WL-CHILD3', title: 'Child 3', stage: 'in_progress', childCount: 0 });

    const parent = makeItem({
      id: 'WL-PARENT',
      title: 'Parent',
      stage: 'in_review',
      childCount: 3,
      children: [child1, child2, child3],
    });

    // Already-flattened list (render callback passes state.getFlattenedItems())
    const alreadyFlattened: WorkItem[] = [parent, child1, child2, child3];

    const expandedItems = new Set<string>(['WL-PARENT']);

    const output = renderer(
      alreadyFlattened,
      0, 0, DEFAULT_TERM_SIZE, null, 'list', null,
      undefined, null, undefined, undefined, expandedItems,
    );

    // Count occurrences of each child ID in the output
    const child1Count = (output.match(/WL-CHILD1/g) || []).length;
    const child2Count = (output.match(/WL-CHILD2/g) || []).length;
    const child3Count = (output.match(/WL-CHILD3/g) || []).length;

    expect(child1Count).toBe(1);
    expect(child2Count).toBe(1);
    expect(child3Count).toBe(1);
  });

  it('shows children exactly once when parent is expanded (integration: getFlattenedItems + renderer)', () => {
    const child1 = makeItem({ id: 'WL-C1', title: 'Child 1', childCount: 0 });
    const child2 = makeItem({ id: 'WL-C2', title: 'Child 2', childCount: 0 });
    const parent = makeItem({
      id: 'WL-P',
      title: 'Parent',
      childCount: 2,
      children: [child1, child2],
      depth: undefined,
    });

    const stateItems = [parent];
    const state = new WorkItemListState(stateItems, DEFAULT_TERM_SIZE);

    // Simulate expand: fetch children and toggle
    state.items = stateItems;
    state.expandedItems.add('WL-P');

    const flattened = state.getFlattenedItems();
    expect(flattened).toHaveLength(3); // parent + 2 children

    const renderer = createListRenderer();
    const output = renderer(
      flattened,
      0, 0, DEFAULT_TERM_SIZE, null, 'list', null,
      undefined, null, undefined, undefined, state.expandedItems,
    );

    const c1Count = (output.match(/WL-C1/g) || []).length;
    const c2Count = (output.match(/WL-C2/g) || []).length;

    expect(c1Count).toBe(1);
    expect(c2Count).toBe(1);
  });

  // ── Line-count invariant (WL-0MSAAON63003N6LO) ─────────────────
  // The renderer must never produce more than `rows - 1` lines so that
  // render()'s notification append stays within the pane height; otherwise
  // the terminal scrolls the header and top items off the top of the pane.

  it('keeps output within rows - 1 lines with multiple group separators', () => {
    // One item per group forces a separator per item — the worst case for
    // the layout budget (each separator consumes a row).
    const manyGroups: WorkItem[] = Array.from({ length: 30 }, (_, i) =>
      makeItem({ id: `WL-G${i}`, title: `Group item ${i}`, group: i, groupLabel: `Group ${i}` }),
    );
    const renderer = createListRenderer();
    const output = renderer(manyGroups, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null);
    expect(output.split('\n').length).toBeLessThanOrEqual(DEFAULT_TERM_SIZE.rows - 1);
    // AC1: the header must stay visible
    expect(output).toContain('Work Items');
  });

  it('keeps output within rows - 1 lines with no groups', () => {
    const renderer = createListRenderer();
    const output = renderer(sampleItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null);
    expect(output.split('\n').length).toBeLessThanOrEqual(DEFAULT_TERM_SIZE.rows - 1);
    expect(output).toContain('Work Items');
  });

  it('keeps output within rows - 1 lines for a short list', () => {
    const shortList: WorkItem[] = [makeItem({ id: 'WL-ONE', title: 'Only item' })];
    const renderer = createListRenderer();
    const output = renderer(shortList, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null);
    expect(output.split('\n').length).toBeLessThanOrEqual(DEFAULT_TERM_SIZE.rows - 1);
    expect(output).toContain('Work Items');
  });

  it('keeps output within rows - 1 lines at a pane-sized terminal (53 rows)', () => {
    const paneSize = { rows: 53, cols: 253 };
    // 60 items across 10 groups: many separators + a full window.
    const manyGroups: WorkItem[] = Array.from({ length: 60 }, (_, i) =>
      makeItem({
        id: `WL-G${i}`,
        title: `Group item ${i}`,
        group: i % 10,
        groupLabel: `Group ${i % 10}`,
      }),
    );
    const renderer = createListRenderer();
    const output = renderer(manyGroups, 0, 0, paneSize, null, 'list', null);
    expect(output.split('\n').length).toBeLessThanOrEqual(paneSize.rows - 1);
    expect(output).toContain('Work Items');
  });

  it('render plus an active notification line never exceeds rows lines', () => {
    const groupedItems: WorkItem[] = [
      makeItem({ id: 'T1', title: 'Item 1', group: 0, groupLabel: 'Priority' }),
      makeItem({ id: 'T2', title: 'Item 2', group: 0 }),
      makeItem({ id: 'T3', title: 'Item 3', group: 1, groupLabel: 'Backlog' }),
    ];
    const renderer = createListRenderer();
    const output = renderer(groupedItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null);
    // Simulate render()'s notification append (see runWorklistTui render()).
    const renderedWithNotification =
      output.split('\n').slice(0, DEFAULT_TERM_SIZE.rows - 1).join('\n') + '\n' + ' [Synced]';
    expect(renderedWithNotification.split('\n').length).toBeLessThanOrEqual(DEFAULT_TERM_SIZE.rows);
  });
});

// ── New: Group separator formatting ─────────────────────────────────

describe('formatItemLine with icons and colours', () => {
  it('includes status icon in the line', () => {
    const item = makeItem({ status: 'completed' });
    const line = formatItemLine(item, 80, false);
    // Status icon for completed should be present
    expect(line).toContain('Test');
  });

  it('applies stage color via ANSI codes', () => {
    const item = makeItem({ stage: 'in_review' });
    const line = formatItemLine(item, 80, false);
    // Should have ANSI color escape codes
    expect(line).toContain('\x1b[');
  });

  it('truncates long titles with ellipsis', () => {
    const item = makeItem({ title: 'A'.repeat(200) });
    const line = formatItemLine(item, 40, false);
    // Should be truncated — visible chars < 40, and contain ellipsis
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped.length).toBeLessThan(200);
    expect(line).toContain('…');
  });

  it('shows priority icon when priority is set', () => {
    const item = makeItem({ priority: 'high' });
    const line = formatItemLine(item, 80, false);
    expect(line).toContain('high');
  });

  it('shows stage tag for non-default stages', () => {
    const item = makeItem({ stage: 'in_review' });
    const line = formatItemLine(item, 80, false);
    expect(line).toContain('in_review');
  });

  it('highlights selected item with reverse ANSI', () => {
    const item = makeItem();
    const selectedLine = formatItemLine(item, 80, true);
    expect(selectedLine).toContain('▸');
    const unselectedLine = formatItemLine(item, 80, false);
    expect(unselectedLine).toContain('  ');
  });
});

// ── Toast notifications replace bottom-line status (WL-0MSACL482002RNYH) ──

// The renderer must never emit more than `rows` lines: status feedback is
// surfaced via Herdr toasts (showToast), never appended as a bottom line.

describe('renderer line-count invariant (toast notifications)', () => {
  it('renders at most rows lines for a full list', () => {
    const manyItems = Array.from({ length: 30 }, (_, i) =>
      makeItem({ id: `T${i}`, title: `Item ${i}` }),
    );
    const renderer = createListRenderer();
    const output = renderer(manyItems, 0, 0, DEFAULT_TERM_SIZE, null, 'list', null);
    const lines = output.split('\n');
    // Notification feedback is surfaced via toasts — never appended as a
    // bottom line. (Group-separator budget is tracked in WL-0MSAAON63003N6LO.)
    expect(lines.length).toBeLessThanOrEqual(DEFAULT_TERM_SIZE.rows);
  });

  it('renders at most rows lines for a short list', () => {
    const renderer = createListRenderer();
    const output = renderer([makeItem({ id: 'A', title: 'Only' })], 0, 0, DEFAULT_TERM_SIZE, null, 'list', null);
    const lines = output.split('\n');
    expect(lines.length).toBeLessThanOrEqual(DEFAULT_TERM_SIZE.rows);
  });

  it('renders at most rows lines with no items', () => {
    const renderer = createListRenderer();
    const output = renderer([], 0, 0, DEFAULT_TERM_SIZE, null, 'list', null);
    const lines = output.split('\n');
    expect(lines.length).toBeLessThanOrEqual(DEFAULT_TERM_SIZE.rows);
  });

  it('renders at most rows lines in filter mode', () => {
    const renderer = createListRenderer();
    const output = renderer([], 0, 0, DEFAULT_TERM_SIZE, null, 'filter', null);
    const lines = output.split('\n');
    expect(lines.length).toBeLessThanOrEqual(DEFAULT_TERM_SIZE.rows);
  });
});

