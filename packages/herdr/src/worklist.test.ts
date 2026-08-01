/**
 * Unit tests for WorkItemListState.refreshItems ID-preserving selection.
 *
 * Run: npx vitest run packages/herdr/src/worklist.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WorkItemListState,
  getTermSize,
  executeResolvedCommand,
  dispatchChordCommand,
  ANSI,
} from './worklist.js';
import type { WorkItem } from './fetcher.js';

// ── ANSI helpers ───────────────────────────────────────────────────────
// Regression test: the sync-failed status indicator uses ANSI.yellow
// (WL-0MS4FIUYS001K08K) but `yellow` was missing from the ANSI object,
// breaking `npm run build` (tsc) in packages/herdr.

describe('ANSI helpers', () => {
  it('defines yellow as a valid ANSI escape code', () => {
    expect(ANSI.yellow).toBe('\x1b[33m');
  });
});

/**
 * Build a minimal WorkItem with required fields.
 */
function makeItem(id: string, stage?: string): WorkItem {
  return { id, title: `Item ${id}`, status: 'open', stage };
}

/**
 * Default terminal size (80x24) for test stability.
 */
const TERM_80x24 = { rows: 24, cols: 80 };
getTermSize(); // verify the module loads

describe('WorkItemListState.refreshItems — preserve selection by ID', () => {
  let items: WorkItem[];

  beforeEach(() => {
    items = [
      makeItem('A', 'idea'),
      makeItem('B', 'intake_complete'),
      makeItem('C', 'plan_complete'),
      makeItem('D', 'in_progress'),
    ];
  });

  it('preserves selection when items are reordered', () => {
    const state = new WorkItemListState(items, TERM_80x24);
    // Select item at index 1 (item 'B')
    state.selectedIndex = 1;
    expect(state.getFlattenedItems()[1].id).toBe('B');

    // Refresh with reordered items — 'B' moves to index 3
    const reordered = [
      makeItem('D', 'in_progress'),
      makeItem('C', 'plan_complete'),
      makeItem('A', 'idea'),
      makeItem('B', 'intake_complete'),
    ];
    state.refreshItems(reordered);

    // Selection should follow 'B' to its new position (index 3)
    expect(state.selectedIndex).toBe(3);
    expect(state.getFlattenedItems()[state.selectedIndex].id).toBe('B');
  });

  it('preserves selection when items are partially reordered', () => {
    const state = new WorkItemListState(items, TERM_80x24);
    // Select item at index 2 (item 'C')
    state.selectedIndex = 2;
    expect(state.getFlattenedItems()[2].id).toBe('C');

    // Refresh: new items array where only 'C' and 'D' swap places
    const reordered = [
      makeItem('A', 'idea'),
      makeItem('B', 'intake_complete'),
      makeItem('D', 'in_progress'),
      makeItem('C', 'plan_complete'),
    ];
    state.refreshItems(reordered);

    // 'C' moved from index 2 to index 3
    expect(state.selectedIndex).toBe(3);
    expect(state.getFlattenedItems()[state.selectedIndex].id).toBe('C');
  });

  it('falls back to clamping when selected item is removed', () => {
    const state = new WorkItemListState(items, TERM_80x24);
    // Select item at index 3 (item 'D')
    state.selectedIndex = 3;
    expect(state.getFlattenedItems()[3].id).toBe('D');

    // Refresh: remove 'D'
    const reduced = [
      makeItem('A', 'idea'),
      makeItem('B', 'intake_complete'),
      makeItem('C', 'plan_complete'),
    ];
    state.refreshItems(reduced);

    // Since selectedIndex was 3 and new flatCount is 3, clamp should set index to 2 (last)
    expect(state.selectedIndex).toBe(2);
    expect(state.getFlattenedItems()[2].id).toBe('C');
  });

  it('falls back to clamping when selected item is filtered out by active filter', () => {
    const state = new WorkItemListState(items, TERM_80x24);
    // Apply a filter for 'idea' stage
    state.applyFilter('idea');
    // After filter, only item 'A' (index 0) should be visible
    expect(state.getFlattenedItems().length).toBe(1);
    expect(state.getFlattenedItems()[0].id).toBe('A');

    // Select item 'A' (the only visible item)
    expect(state.selectedIndex).toBe(0);

    // Refresh with items where no item has stage 'idea'
    const noIdeaItems = [
      makeItem('B', 'intake_complete'),
      makeItem('C', 'plan_complete'),
      makeItem('D', 'in_progress'),
    ];
    state.refreshItems(noIdeaItems);

    // After refresh with filter active, no items match 'idea' filter.
    // The selected item 'A' is gone, so fall back to clamping.
    // _clampSelection sees flatCount=0, sets selectedIndex=0
    expect(state.selectedIndex).toBe(0);
    expect(state.getFlattenedItems().length).toBe(0);
  });

  it('handles empty list gracefully', () => {
    const state = new WorkItemListState(items, TERM_80x24);
    state.selectedIndex = 2;

    // Refresh with empty list
    state.refreshItems([]);

    expect(state.selectedIndex).toBe(0);
    expect(state.getFlattenedItems().length).toBe(0);
  });

  it('handles refresh with no previous selection (empty initial list)', () => {
    const state = new WorkItemListState([], TERM_80x24);
    expect(state.selectedIndex).toBe(0);

    // Refresh with new items
    state.refreshItems(items);

    // First item should be selected (clamp to index 0)
    expect(state.selectedIndex).toBe(0);
    expect(state.getFlattenedItems()[0].id).toBe('A');
  });

  it('preserves selection with expanded children after refresh', () => {
    // Create items with children
    const parentA = makeItem('PARENT-A', 'idea');
    parentA.children = [makeItem('CHILD-A1'), makeItem('CHILD-A2')];
    parentA.childCount = 2;

    const parentB = makeItem('PARENT-B', 'in_progress');
    parentB.children = [makeItem('CHILD-B1')];
    parentB.childCount = 1;

    const withChildren = [parentA, parentB];
    const state = new WorkItemListState(withChildren, TERM_80x24);

    // Expand parent A so children are visible in the flattened list
    state.toggleExpand('PARENT-A');

    // Flattened: [PARENT-A, CHILD-A1, CHILD-A2, PARENT-B]
    expect(state.getFlattenedItems().length).toBe(4);

    // Select CHILD-A1 (index 1)
    state.selectedIndex = 1;
    expect(state.getFlattenedItems()[1].id).toBe('CHILD-A1');

    // Refresh with reordered parents — swap Parent A and Parent B
    const reordered = [parentB, parentA];
    state.refreshItems(reordered);

    // After refresh, expanded state should be preserved via expandedItems Set.
    // So flattened: [PARENT-B, PARENT-A, CHILD-A1, CHILD-A2]
    // CHILD-A1 should be at index 2
    expect(state.selectedIndex).toBe(2);
    expect(state.getFlattenedItems()[state.selectedIndex].id).toBe('CHILD-A1');
  });

  it('prefers the selected item ID over the collapsed child position', () => {
    // Test that when parent is collapsed and then refreshed with expanded
    // children, the same child ID is found in the new flattened list
    const itemC = makeItem('C', 'in_progress');
    itemC.children = [makeItem('CHILD-X')];
    itemC.childCount = 1;

    const startItems = [
      makeItem('A', 'idea'),
      itemC,
      makeItem('B', 'intake_complete'),
    ];
    const state = new WorkItemListState(startItems, TERM_80x24);

    // Select 'B' (index 2)
    state.selectedIndex = 2;
    expect(state.getFlattenedItems()[2].id).toBe('B');

    // Refresh with same items but reorder
    const reordered = [
      makeItem('B', 'intake_complete'),
      makeItem('A', 'idea'),
      itemC,
    ];
    state.refreshItems(reordered);

    // 'B' should be at index 0 after reorder
    expect(state.selectedIndex).toBe(0);
    expect(state.getFlattenedItems()[0].id).toBe('B');
  });
});

describe('executeResolvedCommand', () => {
  it('returns noop when command has <id> but no items', () => {
    const state = new WorkItemListState([], TERM_80x24);
    const result = executeResolvedCommand('wl update <id> --priority high', state);
    expect(result).toBe('noop');
  });

  it('returns callback when command is routed to onCommand', () => {
    const state = new WorkItemListState([makeItem('A')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = executeResolvedCommand('echo hello', state, onCommand);
    expect(result).toBe('callback');
    expect(onCommand).toHaveBeenCalledWith('echo hello');
  });

  it('resolves <id> placeholder when item is selected', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    executeResolvedCommand('wl update <id> --priority high', state, onCommand);
    expect(onCommand).toHaveBeenCalledWith('wl update TEST-123 --priority high');
  });

  it('returns dispatched for /wl commands handled internally', () => {
    const state = new WorkItemListState([makeItem('A')], TERM_80x24);
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/wl idea', state, onCommand);
    expect(result).toBe('dispatched');
    expect(state.activeFilter).toBe('idea');
  });

  it('returns dispatched for /skill:implement with resolved <id>', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = executeResolvedCommand('/skill:implement <id>', state, onCommand);
    expect(result).toBe('dispatched');
    expect(onCommand).toHaveBeenCalledWith('/skill:implement TEST-123');
  });

  it('propagates error from onCommand callback', () => {
    const state = new WorkItemListState([makeItem('A')], TERM_80x24);
    state.selectedIndex = 0;
    const failingCommand = () => {
      throw new Error('mock command failure');
    };
    expect(() => executeResolvedCommand('echo hello', state, failingCommand)).toThrow('mock command failure');
  });

  it('returns noop for command without <id> but no onCommand', () => {
    const state = new WorkItemListState([], TERM_80x24);
    const result = executeResolvedCommand('echo hello', state);
    expect(result).toBe('callback');
  });
});

describe('dispatchChordCommand', () => {
  it('handles /wl stage filter commands internally', () => {
    const state = new WorkItemListState([makeItem('A', 'idea')], TERM_80x24);
    const result = dispatchChordCommand('/wl review', state);
    expect(result).toBe(true);
    expect(state.activeFilter).toBe('in_review');
  });

  it('routes agent commands through onCommand', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = dispatchChordCommand('/skill:audit <id>', state, onCommand);
    expect(result).toBe(true);
    expect(onCommand).toHaveBeenCalledWith('/skill:audit TEST-123');
  });

  it('routes !!wl reviewed producer-review commands through onCommand', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = dispatchChordCommand(
      "!!wl reviewed <id> && wl comment add <id> --body '<producer_comment>'",
      state,
      onCommand,
    );
    expect(result).toBe(true);
    expect(onCommand).toHaveBeenCalledWith(
      "!!wl reviewed TEST-123 && wl comment add TEST-123 --body '<producer_comment>'",
    );
  });

  it('routes a-y audit-approve compound commands through onCommand', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = dispatchChordCommand(
      "!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes --summary 'Approved by manual review'",
      state,
      onCommand,
    );
    expect(result).toBe(true);
    expect(onCommand).toHaveBeenCalledWith(
      "!!wl reviewed TEST-123 false && wl audit-set TEST-123 --ready-to-close yes --summary 'Approved by manual review'",
    );
  });

  it('routes a-r audit-reject compound commands through onCommand', () => {
    const state = new WorkItemListState([makeItem('TEST-123')], TERM_80x24);
    state.selectedIndex = 0;
    const onCommand = vi.fn();
    const result = dispatchChordCommand(
      "!!wl reviewed <id> false && wl audit-set <id> --ready-to-close no --summary 'Rejected by manual review. <reason>'",
      state,
      onCommand,
    );
    expect(result).toBe(true);
    expect(onCommand).toHaveBeenCalledWith(
      "!!wl reviewed TEST-123 false && wl audit-set TEST-123 --ready-to-close no --summary 'Rejected by manual review. <reason>'",
    );
  });

  it('returns false for unknown commands', () => {
    const state = new WorkItemListState([makeItem('A')], TERM_80x24);
    state.selectedIndex = 0;
    const result = dispatchChordCommand('unknown command', state);
    expect(result).toBe(false);
  });
});

describe('Chord-complete error notification handling', () => {
  it('tests that executeResolvedCommand noop is returned correctly when no item selected', () => {
    // This tests the underlying behavior that the chord-complete handler
    // relies on: when there's no selected item and the command uses <id>,
    // executeResolvedCommand returns 'noop' so the chord handler can show
    // appropriate feedback instead of misleading "Sent: ..."
    const state = new WorkItemListState([], TERM_80x24);
    const result = executeResolvedCommand('wl update <id> --priority high', state);
    expect(result).toBe('noop');
  });
});
