/**
 * tests/herdr/errors.test.ts — Tests for error handling, edge cases & polish
 */

import { describe, it, expect, vi } from 'vitest';
import {
  WorkItemListState,
  formatItemLine,
  formatFilterBar,
  createListRenderer,
  handleKeypress,
  type WorkItem,
  type TermSize,
} from '../../packages/herdr/src/worklist.js';
import { formatWlError, type WlError } from '../../packages/herdr/src/fetcher.js';

// ── Fixtures ──────────────────────────────────────────────────────────

function makeItem(id = 'WL-TEST', overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Test Item ${id}`,
    status: 'open',
    stage: 'in_progress',
    ...overrides,
  };
}

const defaultTermSize: TermSize = { rows: 24, cols: 80 };
const tinyTermSize: TermSize = { rows: 5, cols: 30 };

// ── Tests ─────────────────────────────────────────────────────────────

describe('formatWlError', () => {
  it('formats initialization error', () => {
    const error: WlError = {
      success: false,
      initialized: false,
      error: 'Worklog not initialized',
    };
    const msg = formatWlError(error);
    expect(msg).toContain('not initialized');
    expect(msg).toContain('worklog init');
  });

  it('formats generic error', () => {
    const error: WlError = {
      success: false,
      error: 'Something went wrong',
    };
    const msg = formatWlError(error);
    expect(msg).toContain('Something went wrong');
  });

  it('handles missing error message', () => {
    const msg = formatWlError({ success: false });
    expect(msg).toContain('Unknown');
  });
});

describe('error state rendering', () => {
  it('renders empty list state', () => {
    const renderer = createListRenderer();
    const result = renderer([], 0, 0, defaultTermSize, null, 'list', null);
    expect(result).toContain('0 item');
  });

  it('renders empty state message for empty items', () => {
    const renderer = createListRenderer();
    const result = renderer([], 0, 0, defaultTermSize, null, 'list', null);
    // Should have a helpful message or at least not crash
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles very small terminal gracefully', () => {
    const items = [makeItem('WL-001'), makeItem('WL-002')];
    const renderer = createListRenderer();
    const result = renderer(items, 0, 0, tinyTermSize, null, 'list', null);
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles very small terminal in detail mode', () => {
    const item = makeItem('WL-001', { description: 'A long description '.repeat(20) });
    const renderer = createListRenderer();
    const result = renderer([item], 0, 0, tinyTermSize, null, 'detail', item);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('WorkItemListState edge cases', () => {
  it('handles empty initial items', () => {
    const state = new WorkItemListState([], defaultTermSize);
    expect(state.items).toEqual([]);
    expect(state.selectedIndex).toBe(0);
  });

  it('handles single item list', () => {
    const items = [makeItem('WL-001')];
    const state = new WorkItemListState(items, defaultTermSize);
    expect(state.items.length).toBe(1);
    expect(state.selectedIndex).toBe(0);
  });

  it('does not crash on moveDown on empty list', () => {
    const state = new WorkItemListState([], defaultTermSize);
    state.moveDown();
    expect(state.selectedIndex).toBe(0);
  });

  it('does not crash on moveUp on empty list', () => {
    const state = new WorkItemListState([], defaultTermSize);
    state.moveUp();
    expect(state.selectedIndex).toBe(0);
  });

  it('clamps selectedIndex when refreshing to empty', () => {
    const items = [makeItem('WL-001')];
    const state = new WorkItemListState(items, defaultTermSize);
    state.refreshItems([]);
    expect(state.selectedIndex).toBe(0);
    expect(state.items).toEqual([]);
  });

  it('does not set detailItem from empty list', () => {
    const state = new WorkItemListState([], defaultTermSize);
    state.selectItem();
    expect(state.mode).toBe('list');
    expect(state.detailItem).toBeNull();
  });
});

describe('handleKeypress edge cases', () => {
  it('handles page up at top of list', () => {
    const items = [makeItem('WL-001'), makeItem('WL-002')];
    const state = new WorkItemListState(items, defaultTermSize);
    state.pageUp();
    expect(state.selectedIndex).toBe(0);
  });

  it('handles page down at bottom of list', () => {
    const items = [makeItem('WL-001'), makeItem('WL-002')];
    const state = new WorkItemListState(items, defaultTermSize);
    state.setSelectedIndex(1);
    state.pageDown();
    expect(state.selectedIndex).toBe(1);
  });

  it('handles goToFirst on empty list', () => {
    const state = new WorkItemListState([], defaultTermSize);
    state.goToFirst();
    expect(state.selectedIndex).toBe(0);
  });

  it('handles goToLast on empty list', () => {
    const state = new WorkItemListState([], defaultTermSize);
    state.goToLast();
    expect(state.selectedIndex).toBe(0);
  });

  it('remains in list mode when selecting empty list item', () => {
    const state = new WorkItemListState([], defaultTermSize);
    handleKeypress(state, '\r', defaultTermSize);
    expect(state.mode).toBe('list');
  });

  it('enters detail mode on enter for items without children', () => {
    const items = [makeItem('WL-001')];
    const state = new WorkItemListState(items, defaultTermSize);
    handleKeypress(state, '\r', defaultTermSize);
    // Should go to detail view, not exit the TUI
    expect(state.mode).toBe('detail');
    expect(state.detailItem?.id).toBe('WL-001');
  });
});

describe('footer key hints', () => {
  it('shows no navigation hints in footer (removed for auto-refresh)', () => {
    const renderer = createListRenderer();
    const items = [makeItem('WL-001')];
    const result = renderer(items, 0, 0, defaultTermSize, null, 'list', null);
    // Nav hints removed — auto-refresh is on, chords cover filtering
    expect(result).not.toContain('[q]');
    expect(result).not.toContain('[r]');
    expect(result).not.toContain('nav');
  });

  it('shows chord hints in footer when available', () => {
    const renderer = createListRenderer();
    const items = [makeItem('WL-001')];
    const result = renderer(items, 0, 0, defaultTermSize, null, 'list', null, undefined, {
      pendingKeys: ['f'],
      hints: 'i:filter idea',
      resolvedCommand: null,
    });
    expect(result).toContain('chord');
  });
});
