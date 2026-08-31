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

// ── Heading indentation ──────────────────────────────────────────────────

describe('heading row indentation', () => {
  const renderer = createListRenderer();

  function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  it('top-level heading (depth 0) renders without extra leading indentation', () => {
    const rows: (DisplayHeadingRow | WorkItem)[] = [
      makeHeading(1, 'Group 1', 2),
      makeItem('A', 1),
      makeItem('B', 1),
    ];
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null);
    const headingLine = output.split('\n').find((l) => l.includes('── Group 1'));
    expect(headingLine).toBeDefined();
    // Format is ` ── Group 1 ...` — one base space, no extra indent at depth 0
    const stripped = stripAnsi(headingLine!);
    const match = stripped.match(/^(\s*)──/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(1); // just the base space
  });

  it('heading inside expanded parent at depth 1 renders with 2-space indent', () => {
    const heading = makeHeading(2, 'Group 2', 1);
    heading.depth = 1;
    const rows: (DisplayHeadingRow | WorkItem)[] = [
      heading,
      { id: 'C1', title: 'Child 1', status: 'open' },
    ];
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null);
    const headingLine = output.split('\n').find((l) => l.includes('── Group 2'));
    expect(headingLine).toBeDefined();
    // At depth 1: 2 indent spaces + 1 base space = 3 spaces before ──
    const stripped = stripAnsi(headingLine!);
    const match = stripped.match(/^(\s*)──/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(3);
  });

  it('heading at depth 2 renders with 4-space indent', () => {
    const heading = makeHeading(3, 'Group 3', 1);
    heading.depth = 2;
    const rows: (DisplayHeadingRow | WorkItem)[] = [
      heading,
      { id: 'GC1', title: 'Grandchild 1', status: 'open' },
    ];
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null);
    const headingLine = output.split('\n').find((l) => l.includes('── Group 3'));
    expect(headingLine).toBeDefined();
    // At depth 2: 4 indent spaces + 1 base space = 5 spaces before ──
    const stripped = stripAnsi(headingLine!);
    const match = stripped.match(/^(\s*)──/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(5);
  });

  it('heading indentation matches item indentation at same depth', () => {
    // A heading at depth 1 alongside an item at depth 1 should share the same depth indent
    const heading = makeHeading(2, 'Group 2', 1);
    heading.depth = 1;
    const item: WorkItem = { id: 'C1', title: 'Child 1', status: 'open', depth: 1 };
    const rows: (DisplayHeadingRow | WorkItem)[] = [heading, item];
    const output = renderer(rows, 0, 0, TERM_80x24, null, 'list', null);
    const lines = output.split('\n');
    const headingLine = lines.find((l) => l.includes('── Group 2'));
    const itemLine = lines.find((l) => l.includes('C1'));

    expect(headingLine).toBeDefined();
    expect(itemLine).toBeDefined();
    const headingStripped = stripAnsi(headingLine!);
    const itemStripped = stripAnsi(itemLine!);
    // Both should have the same 2-space depth indent prefix
    const headingIndent = headingStripped.match(/^(\s*)──/)![1].length;
    // formatItemLine at depth 1: '  ' + '  ' + '  ' + id ... -> stripped starts with '      ' before id
    // The depth indent is 2 spaces. Check heading depth indent equals item depth indent (2).
    // headingIndent is 3 (2 indent + 1 base), item depth indent is 2.
    // So heading extra beyond base (headingIndent - 1) should equal item depth indent (2).
    expect(headingIndent - 1).toBe(2);
    expect(itemStripped.startsWith('  ')).toBe(true);
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
