/**
 * packages/herdr/src/worklist-heading-metadata.test.ts — Metadata panel group
 * info on heading selection (T5 for WL-0MSL5MPSZ003TG94).
 *
 * Tests for:
 * - Selecting a heading row renders group info (label + count) in the
 *   metadata panel instead of stale item metadata
 * - getSelectedItem() returns null for heading selection (panel caller
 *   renders group info)
 * - Enter on a heading is a no-op (does not open a detail view)
 * - Selecting an item row renders its normal metadata panel
 *
 * Run: npx vitest run packages/herdr/src/worklist-heading-metadata.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  createListRenderer,
  WorkItemListState,
  handleKeypress,
  formatGroupInfoPanel,
  type DisplayHeadingRow,
} from './worklist.js';
import type { WorkItem } from './fetcher.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const TERM_80x24 = { rows: 24, cols: 80 };

function makeHeading(group: number, groupLabel: string, count: number, collapsed = false): DisplayHeadingRow {
  return { kind: 'heading', group, groupLabel, count, collapsed };
}

function makeItem(id: string, group?: number, groupLabel?: string, stage?: string): WorkItem {
  return { id, title: `Item ${id}`, status: 'open', stage, group, groupLabel, description: `Description of ${id}` };
}

function makeGroupedList(): WorkItem[] {
  return [
    makeItem('A', 1, 'Group 1', 'in_progress'),
    makeItem('B', 1, 'Group 1'),
    makeItem('C', 2, 'Idea', 'idea'),
  ];
}

// ── formatGroupInfoPanel ─────────────────────────────────────────────────

describe('formatGroupInfoPanel', () => {
  it('renders the group label, count and collapse state', () => {
    const lines = formatGroupInfoPanel(makeHeading(1, 'Group 1', 3, false), 80, 8);
    const text = lines.join('\n');
    expect(text).toContain('Group 1');
    expect(text).toContain('3');
    expect(text).toContain('expanded');
  });

  it('renders the collapsed state when collapsed', () => {
    const lines = formatGroupInfoPanel(makeHeading(2, 'In Review', 5, true), 80, 8);
    const text = lines.join('\n');
    expect(text).toContain('In Review');
    expect(text).toContain('5');
    expect(text).toContain('collapsed');
  });

  it('never exceeds the panel row budget', () => {
    const lines = formatGroupInfoPanel(makeHeading(1, 'Group 1', 3), 80, 4);
    expect(lines.length).toBeLessThanOrEqual(4);
  });
});

// ── Renderer metadata panel on heading selection ─────────────────────────

describe('renderer metadata panel on heading selection', () => {
  const renderer = createListRenderer();

  it('shows group info (label + count) when a heading is selected', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    // selectedIndex 0 = heading(1)
    const output = renderer(state.getDisplayRows(), 0, 0, TERM_80x24, null, 'list', null);
    expect(output).toContain('Group 1');
    expect(output).toContain('3');
    // No stale item metadata for item A
    expect(output).not.toContain('Description of A');
  });

  it('shows group info for any selected heading', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    // Navigate to heading(2): rows = [h1, A, B, h2, C] → index 3
    state.selectedIndex = 3;
    const output = renderer(state.getDisplayRows(), 3, 0, TERM_80x24, null, 'list', null);
    expect(output).toContain('Idea');
    expect(output).toContain('1');
  });

  it('shows the normal item metadata panel when an item is selected', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.selectedIndex = 1; // A
    const output = renderer(state.getDisplayRows(), 1, 0, TERM_80x24, null, 'list', null);
    expect(output).toContain('Description of A');
    expect(output).toContain('── A ──');
  });

  it('does not show group info when an item is selected', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.selectedIndex = 1; // A
    const output = renderer(state.getDisplayRows(), 1, 0, TERM_80x24, null, 'list', null);
    // The panel is the item metadata — no group-count lines in the panel
    // (the list-area heading row still shows the group label, which is fine).
    expect(output).not.toContain('Items:');
    expect(output).not.toContain("Tab toggles this group's collapse state");
  });
});

// ── getSelectedItem returns null for heading (panel caller contract) ─────

describe('getSelectedItem() null for heading (AC2)', () => {
  it('returns null for a heading selection', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    expect(state.getSelectedItem()).toBeNull();
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading' });
  });

  it('returns the item for an item selection', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    state.moveDown(); // A
    expect(state.getSelectedItem()?.id).toBe('A');
  });
});

// ── Enter on heading is a no-op (AC3) ────────────────────────────────────

describe('Enter on a heading is a no-op (AC3)', () => {
  it('does not open the detail view', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    const action = handleKeypress(state, '\r', TERM_80x24);
    expect(action).toBe('select');
    expect(state.mode).toBe('list');
    expect(state.detailItem).toBeNull();
  });

  it('keeps the heading selected after Enter', () => {
    const state = new WorkItemListState(makeGroupedList(), TERM_80x24);
    handleKeypress(state, '\r', TERM_80x24);
    expect(state.getSelectedDisplayRow()).toMatchObject({ kind: 'heading', group: 1 });
  });
});
