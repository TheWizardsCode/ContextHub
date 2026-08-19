/**
 * Unit tests for mouse/touch input handling in the Herdr worklist selection
 * list (parent WL-0MSGHM5BQ0096BNJ, child WL-0MSI720DX002E9WC).
 *
 * TDD RED phase (C1): the mouse path is NOT implemented yet, so this module
 * fails to load with "does not provide an export named 'parseMouseEvent'" /
 * "'mapMouseToAction'" (etc.) from src/worklist.ts. This is the expected,
 * documented red state — the tests go green when the implementation children
 * land:
 *   - C2 (WL-0MSI7278X0008XGM): ANSI mouse constants, parseMouseEvent +
 *     split-chunk buffering, lifecycle emission in runWorklistTui.
 *   - C3 (WL-0MSI72EYW00050N2): row mapping, mapMouseToAction, dispatch
 *     (double-click window, wheel/touch scroll, filter-tap, drag-motion
 *     guard).
 *
 * ── Contract under test (implemented by C2/C3) ──────────────────────────
 *
 *   export interface ParsedMouseEvent {
 *     button: number;    // raw SGR button code (0=left, 1=middle, 2=right,
 *                        // 64=wheel up, 65=wheel down; bit 32 = motion)
 *     x: number;         // 1-based column
 *     y: number;         // 1-based row
 *     release: boolean;  // true for '\x1b[<...m' (release), false for 'M' (press)
 *   }
 *
 *   export function parseMouseEvent(key: string): ParsedMouseEvent | null;
 *     // PURE: parses a COMPLETE SGR mouse sequence ('\x1b[<b;x;yM' / m).
 *     // Returns null for non-mouse input. Partial SGR prefixes are NOT
 *     // consumed by this function (see consumeMouseChunk).
 *
 *   export function consumeMouseChunk(chunk: string): ParsedMouseEvent | null;
 *     // STATEFUL (module-level buffer): feeds stdin chunks to the parser,
 *     // holding a partial SGR prefix ('\x1b[<0;10;') in a small module-level
 *     // buffer until the terminating 'M'/'m' arrives in a later chunk, then
 *     // returns the complete event. A non-mouse chunk clears the buffer.
 *
 *   export const DOUBLE_CLICK_WINDOW_MS = 400;
 *     // Double-click window (parent AC3). Tests pin inclusive <= on the
 *     // boundary (now - lastClick.at <= 400 → double-click).
 *
 *   export interface MouseClickState {
 *     lastClick: { x: number; y: number; at: number } | null; // previous press
 *     now: number;  // current clock (ms), injected for deterministic tests
 *   }
 *
 *   export type MouseAction =
 *     | { type: 'select-row'; index: number }  // list mode: click/tap on an item row
 *     | { type: 'open-detail' }                // list mode: double-click (Enter-equiv)
 *     | { type: 'back' }                       // detail mode: double-click (to list)
 *     | { type: 'wheel-up' }                   // list mode: wheel/touch-scroll up
 *     | { type: 'wheel-down' }                 // list mode: wheel/touch-scroll down
 *     | { type: 'scroll-detail-up' }           // detail mode: wheel up (j/k-equiv)
 *     | { type: 'scroll-detail-down' }         // detail mode: wheel down (j/k-equiv)
 *     | { type: 'filter-stage'; index: number }// filter mode: tap a stage option
 *     | null;                                  // inert: chrome rows, motion, unknown
 *
 *   export function mapMouseToAction(
 *     state: WorkItemListState,
 *     ev: ParsedMouseEvent,
 *     termSize: TermSize,
 *     clickState?: MouseClickState,   // absent → treated as a plain single click
 *   ): MouseAction | null;
 *
 *   // ANSI.mouseEnable / ANSI.mouseDisable added to the ANSI object:
 *   ANSI.mouseEnable  === '\x1b[?1000h\x1b[?1002h\x1b[?1006h'
 *   ANSI.mouseDisable === '\x1b[?1000l\x1b[?1002l\x1b[?1006l'
 *
 * ── Gate rules (parent ACs + plan resolutions) ─────────────────────────
 *   (AC1) enable sequences are written to stdout when raw mode is entered;
 *         disable sequences are written by cleanup() on exit.
 *   (AC2) a single left click/tap on a visible list row maps y → flat item
 *         index via the SAME row budget the renderer uses: header (row 1),
 *         fold indicators, group separators and the footer/chrome are NOT
 *         item rows (inert → null), the metadata panel and notification row
 *         are inert (plan A1).
 *   (AC3) two left presses on the SAME row within DOUBLE_CLICK_WINDOW_MS
 *         activate that item ('open-detail' in list mode; 'back' from the
 *         detail view to the list). Different-row or slow second presses are
 *         plain 'select-row' clicks (double-click state never leaks to
 *         unrelated rows).
 *   (AC4) wheel buttons 64/65 → 'wheel-up'/'wheel-down' in list mode and
 *         'scroll-detail-up'/'scroll-detail-down' in detail mode (page/line
 *         scroll consistent with j/k; the detail-ToC-focus nuance is applied
 *         by the C3 dispatcher mirroring j/k — the mapper is position-
 *         agnostic). Wheel in filter mode is ignored (plan A2).
 *   (AC5) filter mode: tapping the stage-options row (y=3 of the filter
 *         prompt layout) maps the tapped column to a stage index
 *         ('[i] name' marker spans); other rows are inert.
 *   (AC6) motion events (button & 32) NEVER return a navigation action
 *         (drag-motion guard); release events are consumed but inert; truly
 *         unknown sequences parse to null and the keyboard path is
 *         untouched ('\x1b[A' arrows etc. still work).
 *
 * ── Fixture geometry (TERM_80x24, 1-based rows, verified against the
 *    renderer at authoring time) ────────────────────────────────────────
 *
 *   panelHeight(24) = 7; listArea = 16; listHeight = 13.
 *   30 items, scrollOffset 0  → items 0..12 at rows 2..14, '▼ more' row 15,
 *                                footer row 16, panel rows 17..23.
 *   30 items, scrollOffset 20 → '▲ more' row 2, items 20..29 at rows 3..12,
 *                                13+ blank (inert).
 *   4 items, 2 groups         → sep '── G1 ──' row 2, items a,b rows 3,4,
 *                                sep '── G2 ──' row 5, items c,d rows 6,7.
 *   Filter prompt rows        → y1 '', y2 'Filter by stage:', y3 options,
 *                                y4 '', y5 '[0-5] select stage...' .
 *   Marker columns (stripped) → [0]@2 [1]@12 [2]@33 [3]@52 [4]@69 [5]@84.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ANSI,
  WorkItemListState,
  handleKeypress,
  keyToAction,
  parseMouseEvent,
  consumeMouseChunk,
  mapMouseToAction,
  handleMouseInput,
  DOUBLE_CLICK_WINDOW_MS,
  runWorklistTui,
} from './worklist.js';
import type { ParsedMouseEvent, MouseAction, MouseClickState, TermSize } from './worklist.js';
import type { WorkItem } from './fetcher.js';
import { setExecFileAsync, resetExecFileAsync } from './fetcher.js';

/** Default terminal size (80x24) for test stability. */
const TERM_80x24: TermSize = { rows: 24, cols: 80 };

/** Build a minimal WorkItem with required fields. */
function makeItem(id: string, group?: number): WorkItem {
  const item: WorkItem = { id, title: `Item ${id}`, status: 'open', stage: 'idea' };
  if (group !== undefined) {
    (item as any).group = group;
    (item as any).groupLabel = `G${group}`;
  }
  return item;
}

function makeListState(n: number): WorkItemListState {
  return new WorkItemListState(
    Array.from({ length: n }, (_, i) => makeItem(String(i))),
    TERM_80x24,
  );
}

/** Left-press event helper. */
function press(button: number, x: number, y: number): ParsedMouseEvent {
  return { button, x, y, release: false };
}

// ── AC1: ANSI mouse lifecycle sequences ────────────────────────────────

describe('ANSI mouse sequences (WL-0MSGHM5BQ0096BNJ AC1)', () => {
  it('defines the exact mouse-tracking enable sequence (1000 + 1002 + 1006)', () => {
    expect(ANSI.mouseEnable).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  });

  it('defines the exact mouse-tracking disable sequence (h → l)', () => {
    expect(ANSI.mouseDisable).toBe('\x1b[?1000l\x1b[?1002l\x1b[?1006l');
  });
});

// ── AC1/AC6: SGR parser ────────────────────────────────────────────────

describe('parseMouseEvent (WL-0MSGHM5BQ0096BNJ AC1/AC6)', () => {
  it('parses a left press: \\x1b[<0;10;5M', () => {
    expect(parseMouseEvent('\x1b[<0;10;5M')).toEqual({ button: 0, x: 10, y: 5, release: false });
  });

  it('parses a left release: \\x1b[<0;10;5m', () => {
    expect(parseMouseEvent('\x1b[<0;10;5m')).toEqual({ button: 0, x: 10, y: 5, release: true });
  });

  it('preserves 1-based coordinates and multi-digit values', () => {
    expect(parseMouseEvent('\x1b[<0;123;45M')).toEqual({ button: 0, x: 123, y: 45, release: false });
  });

  it('decodes wheel-up (64) and wheel-down (65) buttons', () => {
    expect(parseMouseEvent('\x1b[<64;1;1M')).toEqual({ button: 64, x: 1, y: 1, release: false });
    expect(parseMouseEvent('\x1b[<65;1;1M')).toEqual({ button: 65, x: 1, y: 1, release: false });
  });

  it('decodes the motion bit (32) as part of the button code', () => {
    // 35 = 3 | 32 — a motion event carrying the release-button marker.
    expect(parseMouseEvent('\x1b[<35;2;3M')).toEqual({ button: 35, x: 2, y: 3, release: false });
  });

  it('returns null for plain keyboard input', () => {
    expect(parseMouseEvent('j')).toBeNull();
    expect(parseMouseEvent('q')).toBeNull();
    expect(parseMouseEvent('')).toBeNull();
  });

  it('returns null for escape sequences that are NOT SGR mouse events', () => {
    // Arrow keys must fall through to the keyboard path untouched (AC6).
    expect(parseMouseEvent('\x1b[A')).toBeNull();
    expect(parseMouseEvent('\x1b[B')).toBeNull();
    expect(parseMouseEvent('\x1b[5~')).toBeNull();
  });

  it('returns null for malformed SGR sequences', () => {
    expect(parseMouseEvent('\x1b[<')).toBeNull();
    expect(parseMouseEvent('\x1b[<abc')).toBeNull();
    expect(parseMouseEvent('\x1b[<0;x;yM')).toBeNull();
    // Legacy (non-SGR) X10 mouse protocol is not supported.
    expect(parseMouseEvent('\x1b[M')).toBeNull();
  });
});

// ── AC1 risk mitigation: split-chunk buffering ────────────────────────

describe('consumeMouseChunk — split-chunk buffering (AC1 risk mitigation)', () => {
  it('parses a complete sequence in one chunk', () => {
    const ev = consumeMouseChunk('\x1b[<0;10;5M');
    expect(ev).toEqual({ button: 0, x: 10, y: 5, release: false });
  });

  it('buffers a partial SGR prefix until the terminating M arrives', () => {
    expect(consumeMouseChunk('\x1b[<0;10;')).toBeNull(); // partial — buffered
    expect(consumeMouseChunk('5M')).toEqual({ button: 0, x: 10, y: 5, release: false });
  });

  it('buffers a release (m) split across chunks', () => {
    expect(consumeMouseChunk('\x1b[<64;3;')).toBeNull();
    expect(consumeMouseChunk('2m')).toEqual({ button: 64, x: 3, y: 2, release: true });
  });

  it('buffers a multi-chunk split (three chunks)', () => {
    expect(consumeMouseChunk('\x1b[<')).toBeNull();
    expect(consumeMouseChunk('0;10;')).toBeNull();
    expect(consumeMouseChunk('5M')).toEqual({ button: 0, x: 10, y: 5, release: false });
  });

  it('clears the buffer on a non-mouse chunk (a stale tail must not complete later)', () => {
    expect(consumeMouseChunk('\x1b[<0;10;')).toBeNull(); // partial — buffered
    expect(consumeMouseChunk('j')).toBeNull();            // keyboard input clears the buffer
    expect(consumeMouseChunk('5M')).toBeNull();           // stale tail does NOT complete
  });

  it('screen-clearing/refresh chunks do not disturb a pending partial', () => {
    expect(consumeMouseChunk('\x1b[<0;10;')).toBeNull();
    expect(consumeMouseChunk('\x1b[2J')).toBeNull();
    expect(consumeMouseChunk('5M')).toEqual({ button: 0, x: 10, y: 5, release: false });
  });
});

// ── AC2: row mapping — list mode ───────────────────────────────────────

describe('mapMouseToAction — list mode row mapping (AC2)', () => {
  it('maps a click on a visible item row to select-row with the flat index (scroll 0)', () => {
    const state = makeListState(30);
    expect(mapMouseToAction(state, press(0, 5, 2), TERM_80x24)).toEqual({ type: 'select-row', index: 0 });
    expect(mapMouseToAction(state, press(0, 5, 5), TERM_80x24)).toEqual({ type: 'select-row', index: 3 });
    expect(mapMouseToAction(state, press(0, 5, 14), TERM_80x24)).toEqual({ type: 'select-row', index: 12 });
  });

  it('is inert for the header row (y=1) and panel rows', () => {
    const state = makeListState(30);
    expect(mapMouseToAction(state, press(0, 5, 1), TERM_80x24)).toBeNull();
    expect(mapMouseToAction(state, press(0, 5, 17), TERM_80x24)).toBeNull();
    expect(mapMouseToAction(state, press(0, 5, 24), TERM_80x24)).toBeNull(); // notification row
  });

  it('is inert for the bottom fold indicator and footer rows', () => {
    const state = makeListState(30);
    expect(mapMouseToAction(state, press(0, 5, 15), TERM_80x24)).toBeNull(); // '▼ more'
    expect(mapMouseToAction(state, press(0, 5, 16), TERM_80x24)).toBeNull(); // footer
  });

  it('is inert for blank rows beyond the visible tail', () => {
    const state = makeListState(3);
    expect(mapMouseToAction(state, press(0, 5, 4), TERM_80x24)).toEqual({ type: 'select-row', index: 2 });
    expect(mapMouseToAction(state, press(0, 5, 5), TERM_80x24)).toBeNull(); // blank fill
  });

  it('accounts for scrollOffset and the top fold indicator', () => {
    const state = makeListState(30);
    state.scrollOffset = 20;
    expect(mapMouseToAction(state, press(0, 5, 2), TERM_80x24)).toBeNull(); // '▲ more'
    expect(mapMouseToAction(state, press(0, 5, 3), TERM_80x24)).toEqual({ type: 'select-row', index: 20 });
    expect(mapMouseToAction(state, press(0, 5, 12), TERM_80x24)).toEqual({ type: 'select-row', index: 29 });
    expect(mapMouseToAction(state, press(0, 5, 13), TERM_80x24)).toBeNull(); // past the tail
  });

  it('is inert on group separator rows and maps items correctly (AC2/A1)', () => {
    const items = [makeItem('a', 1), makeItem('b', 1), makeItem('c', 2), makeItem('d', 2)];
    const state = new WorkItemListState(items, TERM_80x24);
    expect(mapMouseToAction(state, press(0, 5, 2), TERM_80x24)).toBeNull(); // '── G1 ──'
    expect(mapMouseToAction(state, press(0, 5, 3), TERM_80x24)).toEqual({ type: 'select-row', index: 0 });
    expect(mapMouseToAction(state, press(0, 5, 4), TERM_80x24)).toEqual({ type: 'select-row', index: 1 });
    expect(mapMouseToAction(state, press(0, 5, 5), TERM_80x24)).toBeNull(); // '── G2 ──'
    expect(mapMouseToAction(state, press(0, 5, 6), TERM_80x24)).toEqual({ type: 'select-row', index: 2 });
    expect(mapMouseToAction(state, press(0, 5, 7), TERM_80x24)).toEqual({ type: 'select-row', index: 3 });
  });
});

// ── AC2/AC3: row mapping — detail mode ─────────────────────────────────

describe('mapMouseToAction — detail mode (AC2/AC3)', () => {
  it('ignores single clicks in detail mode (no rows to select)', () => {
    const state = makeListState(3);
    state.mode = 'detail';
    state.detailItem = makeItem('a');
    expect(mapMouseToAction(state, press(0, 5, 5), TERM_80x24)).toBeNull();
  });

  it('returns back for a double-click in detail mode (AC3: to the list)', () => {
    const state = makeListState(3);
    state.mode = 'detail';
    state.detailItem = makeItem('a');
    const click: MouseClickState = {
      lastClick: { x: 5, y: 3, at: 1000 },
      now: 1300,
    };
    expect(mapMouseToAction(state, press(0, 5, 3), TERM_80x24, click)).toEqual({ type: 'back' });
  });
});

// ── AC5: row mapping — filter prompt ───────────────────────────────────

describe('mapMouseToAction — filter prompt taps (AC5)', () => {
  it('maps a tap on the stage-options row (y=3) to the stage index under the pointer', () => {
    const state = makeListState(3);
    state.mode = 'filter';
    expect(mapMouseToAction(state, press(0, 3, 3), TERM_80x24)).toEqual({ type: 'filter-stage', index: 0 });  // inside [0]
    expect(mapMouseToAction(state, press(0, 13, 3), TERM_80x24)).toEqual({ type: 'filter-stage', index: 1 }); // inside [1]
    expect(mapMouseToAction(state, press(0, 34, 3), TERM_80x24)).toEqual({ type: 'filter-stage', index: 2 }); // inside [2]
    expect(mapMouseToAction(state, press(0, 53, 3), TERM_80x24)).toEqual({ type: 'filter-stage', index: 3 }); // inside [3]
    expect(mapMouseToAction(state, press(0, 70, 3), TERM_80x24)).toEqual({ type: 'filter-stage', index: 4 }); // inside [4]
  });

  it('is inert for taps on any other filter row (AC5)', () => {
    const state = makeListState(3);
    state.mode = 'filter';
    expect(mapMouseToAction(state, press(0, 5, 1), TERM_80x24)).toBeNull();
    expect(mapMouseToAction(state, press(0, 5, 2), TERM_80x24)).toBeNull(); // 'Filter by stage:' header
    expect(mapMouseToAction(state, press(0, 5, 4), TERM_80x24)).toBeNull();
    expect(mapMouseToAction(state, press(0, 5, 5), TERM_80x24)).toBeNull(); // '[0-5] select stage' hint
  });
});

// ── AC3: double-click window ───────────────────────────────────────────

describe('mapMouseToAction — double-click window (AC3)', () => {
  it('opens the detail view for a second click on the same row within 400 ms', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: { x: 5, y: 6, at: 1000 }, now: 1300 };
    expect(mapMouseToAction(state, press(0, 5, 6), TERM_80x24, click)).toEqual({ type: 'open-detail' });
  });

  it('treats the 400 ms boundary itself as a double-click (inclusive <=)', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: { x: 5, y: 6, at: 1000 }, now: 1400 };
    expect(mapMouseToAction(state, press(0, 5, 6), TERM_80x24, click)).toEqual({ type: 'open-detail' });
  });

  it('treats a second click past 400 ms as a plain select-row (window elapsed)', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: { x: 5, y: 6, at: 1000 }, now: 1401 };
    expect(mapMouseToAction(state, press(0, 5, 6), TERM_80x24, click)).toEqual({ type: 'select-row', index: 4 });
  });

  it('never leaks double-click state to a DIFFERENT row (AC3)', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: { x: 5, y: 6, at: 1000 }, now: 1300 };
    expect(mapMouseToAction(state, press(0, 5, 8), TERM_80x24, click)).toEqual({ type: 'select-row', index: 6 });
  });

  it('treats a first click (no prior click state) as a plain select-row', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 1000 };
    expect(mapMouseToAction(state, press(0, 5, 6), TERM_80x24, click)).toEqual({ type: 'select-row', index: 4 });
  });

  it('does not open the detail view from a repeated click on an inert row', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: { x: 5, y: 1, at: 1000 }, now: 1300 };
    expect(mapMouseToAction(state, press(0, 5, 1), TERM_80x24, click)).toBeNull(); // header rows stay inert
  });
});

// ── WL-0MSZBWT500034E74: onData wiring — handleMouseInput ─────────────
// Regression: dispatchMouse updated clickState to the CURRENT event before
// mapMouseToAction ran, so every click self-matched as a double-click and
// opened the detail view instead of selecting. handleMouseInput is the
// exported wiring that onData calls; these tests pin the select-vs-open
// semantics (parent AC2/AC3).

describe('handleMouseInput — single click selects, double click opens (AC2/AC3)', () => {
  it('a single left click on a visible row selects it WITHOUT opening the detail view', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    const consumed = handleMouseInput(state, '\x1b[<0;5;3M', TERM_80x24, click);
    expect(consumed).toBe(true); // mouse sequence fully consumed
    expect(state.selectedIndex).toBe(1); // row 3 → index 1 (row 2 → index 0)
    expect(state.mode).toBe('list'); // NOT detail — selection only
    expect(click.lastClick).toEqual({ x: 5, y: 3, at: expect.any(Number) });
  });

  it('a second click on the SAME row within the window opens the detail view', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    handleMouseInput(state, '\x1b[<0;5;3M', TERM_80x24, click); // first click — selects
    expect(state.mode).toBe('list');
    handleMouseInput(state, '\x1b[<0;5;3M', TERM_80x24, click); // second click (~0ms later)
    expect(state.mode).toBe('detail');
    expect(state.detailItem?.id).toBe('1');
  });

  it('a second click on a DIFFERENT row within the window selects that row, never opens detail', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    handleMouseInput(state, '\x1b[<0;5;3M', TERM_80x24, click); // row 3
    handleMouseInput(state, '\x1b[<0;5;8M', TERM_80x24, click); // row 8, same instant
    expect(state.mode).toBe('list');
    expect(state.selectedIndex).toBe(6); // row 8 → index 6
  });

  it('release events do not advance the double-click window', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    handleMouseInput(state, '\x1b[<0;5;3M', TERM_80x24, click); // press 1
    handleMouseInput(state, '\x1b[<0;5;3m', TERM_80x24, click); // release 1 — inert, no state change
    handleMouseInput(state, '\x1b[<0;5;3M', TERM_80x24, click); // press 2 → still a double-click
    expect(state.mode).toBe('detail');
  });

  it('wheel events navigate but never count as clicks for the window', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    handleMouseInput(state, '\x1b[<64;5;3M', TERM_80x24, click); // wheel up — wraps to last
    expect(state.selectedIndex).toBe(29); // moveUp wraps to last (30 items)
    handleMouseInput(state, '\x1b[<0;5;3M', TERM_80x24, click); // click row 3 → selects only
    expect(state.mode).toBe('list'); // wheel did not prime a double-click
    handleMouseInput(state, '\x1b[<0;5;3M', TERM_80x24, click); // same row again → double-click
    expect(state.mode).toBe('detail'); // double-click still works after a wheel event
  });

  it('consumes a partial SGR prefix so it never reaches the keyboard path', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    expect(handleMouseInput(state, '\x1b[<0;5;', TERM_80x24, click)).toBe(true); // buffered partial
    expect(handleMouseInput(state, '3M', TERM_80x24, click)).toBe(true); // completes
    expect(state.selectedIndex).toBe(1);
    expect(state.mode).toBe('list');
  });

  it('returns false for plain keys and foreign escapes (keyboard path untouched)', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    expect(handleMouseInput(state, 'j', TERM_80x24, click)).toBe(false);
    expect(handleMouseInput(state, 'q', TERM_80x24, click)).toBe(false);
    expect(handleMouseInput(state, '\x1b[A', TERM_80x24, click)).toBe(false); // arrow key stays keyboard
    expect(state.selectedIndex).toBe(0); // untouched
  });
});

// ── AC4: wheel / touch-scroll dispatch ─────────────────────────────────

describe('mapMouseToAction — wheel and touch scroll (AC4)', () => {
  it('maps wheel-up (64) and wheel-down (65) to navigation in list mode', () => {
    const state = makeListState(30);
    expect(mapMouseToAction(state, press(64, 5, 5), TERM_80x24)).toEqual({ type: 'wheel-up' });
    expect(mapMouseToAction(state, press(65, 5, 5), TERM_80x24)).toEqual({ type: 'wheel-down' });
  });

  it('maps wheel events to detail scrolling in detail mode (j/k-equivalent)', () => {
    const state = makeListState(3);
    state.mode = 'detail';
    state.detailItem = makeItem('a');
    expect(mapMouseToAction(state, press(64, 5, 5), TERM_80x24)).toEqual({ type: 'scroll-detail-up' });
    expect(mapMouseToAction(state, press(65, 5, 5), TERM_80x24)).toEqual({ type: 'scroll-detail-down' });
  });

  it('ignores wheel events in filter mode (plan A2)', () => {
    const state = makeListState(3);
    state.mode = 'filter';
    expect(mapMouseToAction(state, press(64, 5, 3), TERM_80x24)).toBeNull();
    expect(mapMouseToAction(state, press(65, 5, 3), TERM_80x24)).toBeNull();
  });
});

// ── AC6: drag-motion guard + button semantics ──────────────────────────

describe('mapMouseToAction — drag-motion guard and button codes (AC6)', () => {
  it('never jumps the selection on motion events (button & 32)', () => {
    const state = makeListState(30);
    // 35 = 3 | 32 (motion carrying release marker), 33 = 1 | 32, 32 alone.
    expect(mapMouseToAction(state, press(32, 5, 5), TERM_80x24)).toBeNull();
    expect(mapMouseToAction(state, press(33, 5, 5), TERM_80x24)).toBeNull();
    expect(mapMouseToAction(state, press(35, 5, 5), TERM_80x24)).toBeNull();
  });

  it('guards motion in detail and filter modes too', () => {
    const d = makeListState(3);
    d.mode = 'detail';
    d.detailItem = makeItem('a');
    expect(mapMouseToAction(d, press(32, 5, 5), TERM_80x24)).toBeNull();
    const f = makeListState(3);
    f.mode = 'filter';
    expect(mapMouseToAction(f, press(34, 5, 3), TERM_80x24)).toBeNull();
  });

  it('ignores release events for click actions (press drives selection)', () => {
    const state = makeListState(30);
    expect(mapMouseToAction(state, { button: 0, x: 5, y: 5, release: true }, TERM_80x24)).toBeNull();
  });

  it('ignores middle (1) and right (2) buttons — only left selects', () => {
    const state = makeListState(30);
    expect(mapMouseToAction(state, press(1, 5, 5), TERM_80x24)).toBeNull();
    expect(mapMouseToAction(state, press(2, 5, 5), TERM_80x24)).toBeNull();
  });
});

// ── AC6: unknown-sequence regression ───────────────────────────────────

describe('unknown-sequence regression (AC6)', () => {
  it('leaves the keyboard path untouched: handleKeypress treats mouse chunks as inert', () => {
    const state = makeListState(30);
    const before = { selectedIndex: state.selectedIndex, scrollOffset: state.scrollOffset };
    const action = handleKeypress(state, '\x1b[<0;10;5M', TERM_80x24);
    expect(action).toBeNull();
    expect(state.selectedIndex).toBe(before.selectedIndex);
    expect(state.scrollOffset).toBe(before.scrollOffset);
  });

  it('does not confuse mouse chunks with arrow-key escape sequences', () => {
    expect(parseMouseEvent('\x1b[A')).toBeNull(); // arrows stay keyboard
    expect(keyToAction('\x1b[<0;10;5M')).toBeNull(); // mouse chunk is not an arrow action
  });
});

// ── AC1: lifecycle emission ────────────────────────────────────────────

describe('runWorklistTui — mouse lifecycle emission (AC1)', () => {
  it('emits enable sequences on raw-mode entry and disable sequences on cleanup', async () => {
    // Fake TTY stdin + captured stdout.
    type StdinListener = (chunk: Buffer) => void;
    const dataListeners: StdinListener[] = [];
    const fakeStdin = {
      isTTY: true,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      on: (ev: string, cb: StdinListener) => {
        if (ev === 'data') dataListeners.push(cb);
      },
      removeListener: (ev: string, cb: StdinListener) => {
        if (ev === 'data') {
          const i = dataListeners.indexOf(cb);
          if (i >= 0) dataListeners.splice(i, 1);
        }
      },
    };
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
      writes.push(String(chunk));
      return true;
    }) as any);
    const origStdin = (process as any).stdin;
    // Node 22+ defines process.stdin as a getter-only property — use
    // Object.defineProperty to swap in the fake TTY stdin.
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true, writable: true });

    try {
      // Stub wl subprocesses (fetchActionableCount etc.) — the mouse test
      // suite never spawns a real wl process.
      setExecFileAsync((async () => ({ stdout: '{"count": 0}' })) as any);

      const tui = runWorklistTui(
        async () => [],
        [],
        undefined,
        { autoRefresh: false, autoSync: false },
      );

      // Let the initial render complete, then assert the enable sequence
      // was emitted at raw-mode entry (before any input).
      await vi.waitFor(() => {
        expect(writes.join('')).toContain(ANSI.mouseEnable);
      });

      // Quit via 'q' → cleanup() must emit the disable sequences.
      dataListeners.forEach((cb) => cb(Buffer.from('q')));
      await tui;

      expect(writes.join('')).toContain(ANSI.mouseDisable);
      // Enable must precede disable in the output stream.
      expect(writes.join('').indexOf(ANSI.mouseEnable)).toBeLessThan(
        writes.join('').indexOf(ANSI.mouseDisable),
      );
    } finally {
      Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true, writable: true });
      writeSpy.mockRestore();
      resetExecFileAsync();
    }
  });
});

// ── WL-0MT0AP2LR000JFWN: Alt+m toggle for drag-select ─────────────────
// Regression: mouse tracking (enabled on raw-mode entry) captures ALL mouse
// events, so the terminal's native text selection (drag-select to copy)
// stops working. Alt+m toggles tracking off (native selection works again)
// and back on (mouse interaction resumes).

describe('runWorklistTui — Alt+m mouse-tracking toggle (WL-0MT0AP2LR000JFWN)', () => {
  // Shared fake-TTY harness: swaps process.stdin for a fake TTY that
  // records data listeners, and captures process.stdout writes.
  function setupFakeTty(): {
    dataListeners: Array<(chunk: Buffer) => void>;
    writes: string[];
    restore: () => void;
  } {
    type StdinListener = (chunk: Buffer) => void;
    const dataListeners: StdinListener[] = [];
    const fakeStdin = {
      isTTY: true,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      on: (ev: string, cb: StdinListener) => {
        if (ev === 'data') dataListeners.push(cb);
      },
      removeListener: (ev: string, cb: StdinListener) => {
        if (ev === 'data') {
          const i = dataListeners.indexOf(cb);
          if (i >= 0) dataListeners.splice(i, 1);
        }
      },
    };
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
      writes.push(String(chunk));
      return true;
    }) as any);
    const origStdin = (process as any).stdin;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true, writable: true });
    setExecFileAsync((async () => ({ stdout: '{"count": 0}' })) as any);
    return {
      dataListeners,
      writes,
      restore: () => {
        Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true, writable: true });
        writeSpy.mockRestore();
        resetExecFileAsync();
      },
    };
  }

  it('Alt+m toggles tracking OFF (disable sequences emitted) then ON again', async () => {
    const { dataListeners, writes, restore } = setupFakeTty();
    try {
      const tui = runWorklistTui(
        async () => [],
        [],
        undefined,
        { autoRefresh: false, autoSync: false },
      );

      // Raw-mode entry → mouse tracking enabled by default.
      await vi.waitFor(() => {
        expect(writes.join('')).toContain(ANSI.mouseEnable);
      });
      const firstEnable = writes.join('').indexOf(ANSI.mouseEnable);

      // Alt+m (\x1bm) → toggle OFF: disable sequences emitted.
      dataListeners.forEach((cb) => cb(Buffer.from('\x1bm')));
      await vi.waitFor(() => {
        expect(writes.join('').indexOf(ANSI.mouseDisable)).toBeGreaterThan(firstEnable);
      });
      const disableAt = writes.join('').indexOf(ANSI.mouseDisable);

      // Alt+m again → toggle back ON: a SECOND enable sequence is emitted.
      dataListeners.forEach((cb) => cb(Buffer.from('\x1bm')));
      await vi.waitFor(() => {
        const enableCount = writes.join('').split(ANSI.mouseEnable).length - 1;
        expect(enableCount).toBe(2);
        expect(writes.join('').lastIndexOf(ANSI.mouseEnable)).toBeGreaterThan(disableAt);
      });

      // Quit via 'q' → cleanup still emits the disable sequences.
      dataListeners.forEach((cb) => cb(Buffer.from('q')));
      await tui;
      expect(writes.join('')).toContain(ANSI.mouseDisable);
    } finally {
      restore();
    }
  });

  it('Alt+m does not reach keyToAction (meta-down m is unaffected)', async () => {
    const { dataListeners, writes, restore } = setupFakeTty();
    try {
      const tui = runWorklistTui(
        async () => [],
        [],
        undefined,
        { autoRefresh: false, autoSync: false },
      );
      await vi.waitFor(() => {
        expect(writes.join('')).toContain(ANSI.mouseEnable);
      });

      // Plain 'm' (meta-down) must NOT trigger the toggle — only \x1bm does.
      const before = writes.join('');
      dataListeners.forEach((cb) => cb(Buffer.from('m')));
      // Allow the render to settle, then confirm no disable sequence was
      // emitted (plain m is a navigation key, not a toggle).
      await new Promise((r) => setTimeout(r, 50));
      expect(writes.join('').split(ANSI.mouseDisable).length - 1).toBe(0);
      void before;

      // Alt+m toggles OFF (disable emitted), proving the \x1bm prefix is
      // what triggers the toggle — distinct from the bare 'm' key.
      dataListeners.forEach((cb) => cb(Buffer.from('\x1bm')));
      await vi.waitFor(() => {
        expect(writes.join('').split(ANSI.mouseDisable).length - 1).toBeGreaterThan(0);
      });

      dataListeners.forEach((cb) => cb(Buffer.from('q')));
      await tui;
    } finally {
      restore();
    }
  });

  it('footer shows the current mouse-tracking state (on/off)', async () => {
    const { dataListeners, writes, restore } = setupFakeTty();
    try {
      const tui = runWorklistTui(
        async () => [],
        [],
        undefined,
        { autoRefresh: false, autoSync: false },
      );

      // Initial render: hint says mouse on.
      await vi.waitFor(() => {
        expect(writes.join('')).toContain('alt+m mouse on');
      });

      // Alt+m → hint flips to mouse off.
      dataListeners.forEach((cb) => cb(Buffer.from('\x1bm')));
      await vi.waitFor(() => {
        expect(writes.join('')).toContain('alt+m mouse off');
      });

      // Alt+m again → hint flips back to mouse on.
      dataListeners.forEach((cb) => cb(Buffer.from('\x1bm')));
      await vi.waitFor(() => {
        expect(writes.join('')).toContain('alt+m mouse on');
      });

      dataListeners.forEach((cb) => cb(Buffer.from('q')));
      await tui;
    } finally {
      restore();
    }
  });
});