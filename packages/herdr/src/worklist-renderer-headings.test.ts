/**
 * packages/herdr/src/worklist-renderer-headings.test.ts — Renderer heading
 * rows with counts (T4 for WL-0MSL5MPSZ003TG94).
 *
 * Tests for:
 * - Heading rows render label + item count (e.g. `── Group 1 (4) ──`)
 * - Collapse arrow/indicator on heading rows (expanded vs collapsed)
 * - createListRenderer renders headings from the display model (no group
 *   transition derivation)
 * - Collapsed groups' items do not render; headings still render with count
 * - The `rows - 1` line-count invariant holds under heading configurations
 * - Click-row mapping accounts for heading rows
 *
 * Run: npx vitest run packages/herdr/src/worklist-renderer-headings.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  createListRenderer,
  mapMouseToAction,
  WorkItemListState,
  type DisplayHeadingRow,
  type ParsedMouseEvent,
} from './worklist.js';
import type { WorkItem } from './fetcher.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const TERM_80x24 = { rows: 24, cols: 80 };
const ANSI_REVERSE = '\x1b[7m';

function makeHeading(group: number, groupLabel: string, count: number, collapsed = false): DisplayHeadingRow {
  return { kind: 'heading', group, groupLabel, count, collapsed };
}

function makeItem(id: string, group?: number): WorkItem {
  return { id, title: `Item ${id}`, status: 'open', group };
}

function press(x: number, y: number): ParsedMouseEvent {
  // Left-button press at (x, y)
  return { button: 0, x, y, release: false };
}

// ── Heading rendering with counts ────────────────────────────────────────

describe('heading rows render label + count', () => {
  const renderer = createListRenderer();

  it('renders each heading with its item count', () => {
    const rows = [
      makeHeading(1, 'Group 1', 3),
      makeItem('A', 1),
      makeItem('B', 1),
      makeItem('C', 1),
      makeHeading(2, 'Idea', 1),
      makeItem('D', 2),
    ];
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null);
    expect(output).toContain('Group 1 (3)');
    expect(output).toContain('Idea (1)');
  });

  it('shows the count whether expanded or collapsed', () => {
    const rows = [
      makeHeading(1, 'Group 1', 3, false),
      makeItem('A', 1),
      makeHeading(2, 'Group 2', 2, true),
    ];
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null);
    expect(output).toContain('Group 1 (3)');
    expect(output).toContain('Group 2 (2)');
  });

  it('renders a collapse arrow distinct from item rows', () => {
    const rows = [
      makeHeading(1, 'Group 1', 3, false), // expanded
      makeItem('A', 1),
      makeHeading(2, 'Group 2', 2, true), // collapsed
    ];
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null);
    // Expanded heading shows ▼; collapsed shows ▶
    expect(output).toContain('▼');
    expect(output).toContain('▶');
  });

  it('does not render items of collapsed groups (they are excluded from rows)', () => {
    // The caller passes display rows where collapsed-group items are already
    // excluded — the renderer renders exactly the rows it is given.
    const rows = [
      makeHeading(1, 'Group 1', 2, true),
      makeHeading(2, 'Idea', 1, false),
      makeItem('D', 2),
    ];
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null);
    expect(output).toContain('Group 1 (2)');
    expect(output).not.toContain('Item A');
    expect(output).toContain('Item D');
  });

  it('highlights a selected heading row', () => {
    const rows = [
      makeHeading(1, 'Group 1', 3),
      makeItem('A', 1),
    ];
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null);
    // Selected heading (index 0) rendered with reverse video
    expect(output).toContain(ANSI_REVERSE);
  });
});

// ── Line-count invariant with headings ───────────────────────────────────

describe('line-count invariant with heading rows', () => {
  const renderer = createListRenderer();

  it('never exceeds rows - 1 with many groups', () => {
    // 6 groups × (heading + 4 items) = 30 rows
    const rows: (DisplayHeadingRow | WorkItem)[] = [];
    for (let g = 1; g <= 6; g++) {
      rows.push(makeHeading(g, `Group ${g}`, 4));
      for (let i = 0; i < 4; i++) {
        rows.push(makeItem(`G${g}-I${i}`, g));
      }
    }
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null);
    expect(output.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows - 1);
    expect(output).toContain('Work Items');
  });

  it('never exceeds rows - 1 with many collapsed headings', () => {
    const rows: (DisplayHeadingRow | WorkItem)[] = [];
    for (let g = 1; g <= 12; g++) {
      rows.push(makeHeading(g, `Group ${g}`, 3, true));
    }
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null);
    expect(output.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows - 1);
  });

  it('never exceeds rows - 1 with code-freeze banner and headings', () => {
    const rows: (DisplayHeadingRow | WorkItem)[] = [];
    for (let g = 1; g <= 8; g++) {
      rows.push(makeHeading(g, `Group ${g}`, 5));
      for (let i = 0; i < 5; i++) {
        rows.push(makeItem(`G${g}-I${i}`, g));
      }
    }
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true);
    expect(output.split('\n').length).toBeLessThanOrEqual(TERM_80x24.rows - 1);
    expect(output).toContain('CODE FREEZE');
  });
});

// ── Click-row mapping with headings ──────────────────────────────────────

describe('click-row mapping accounts for heading rows', () => {
  it('maps clicks on heading rows to their display row index', () => {
    const items = [makeItem('a', 1), makeItem('b', 1), makeItem('c', 2), makeItem('d', 2)];
    const state = new WorkItemListState(items, TERM_80x24);
    // display rows: [h1, a, b, h2, c, d]
    // rows on screen: y2=h1(0), y3=a(1), y4=b(2), y5=h2(3), y6=c(4), y7=d(5)
    expect(mapMouseToAction(state, press(5, 2), TERM_80x24)).toEqual({ type: 'select-row', index: 0 });
    expect(mapMouseToAction(state, press(5, 3), TERM_80x24)).toEqual({ type: 'select-row', index: 1 });
    expect(mapMouseToAction(state, press(5, 5), TERM_80x24)).toEqual({ type: 'select-row', index: 3 });
    expect(mapMouseToAction(state, press(5, 7), TERM_80x24)).toEqual({ type: 'select-row', index: 5 });
  });

  it('maps clicks on items of collapsed groups correctly', () => {
    const items = [makeItem('a', 1), makeItem('b', 1), makeItem('c', 2), makeItem('d', 2)];
    const state = new WorkItemListState(items, TERM_80x24);
    state.toggleGroupCollapse(1);
    // display rows: [h1, h2, c, d] → y2=h1(0), y3=h2(1), y4=c(2), y5=d(3)
    expect(mapMouseToAction(state, press(5, 3), TERM_80x24)).toEqual({ type: 'select-row', index: 1 });
    expect(mapMouseToAction(state, press(5, 4), TERM_80x24)).toEqual({ type: 'select-row', index: 2 });
  });
});
