/**
 * Unit tests for the hover tooltip on agent-pane rows in the Herdr
 * worklist (WL-0MT9XRZDK006GMUH).
 *
 * Contract under test:
 *  - Tooltip state machine (show / Esc-dismiss / re-show on re-entry):
 *    `state.hoveredRowIndex` + `state.tooltipDismissed`.
 *  - Motion-to-row mapping: motion events (button & 32) map to
 *    `hover-row` (over an item row) or `hover-none` (over chrome/blank
 *    rows) in list mode, and never navigate (AC5/AC6).
 *  - Metadata formatting: `formatTooltipLines` renders all 8 fields
 *    (ID, Title, Command, Priority, Type, Risk, Effort, Start Time).
 *  - Backward-compatible `agent-panes.json` parsing: entries lacking the
 *    new `command` field still load; recorded commands persist.
 */

import { describe, it, expect } from 'vitest';
import {
  ANSI,
  WorkItemListState,
  handleKeypress,
  handleMouseInput,
  mapMouseToAction,
  formatTooltipLines,
  formatTooltipOverlay,
  createListRenderer,
} from './worklist.js';
import type { MouseClickState, TermSize } from './worklist.js';
import type { WorkItem } from './fetcher.js';
import { AgentTracker, AGENT_PANES_FILE } from './agent-tracker.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Default terminal size (80x24) for test stability. */
const TERM_80x24: TermSize = { rows: 24, cols: 80 };

/** Extract visible (ANSI-stripped) text from a rendered line. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Build a WorkItem with the fields the tooltip shows. */
function makeItem(
  id: string,
  overrides: Partial<WorkItem> = {},
): WorkItem {
  return {
    id,
    title: `Title for ${id}`,
    status: 'in_progress',
    stage: 'in_progress',
    priority: 'high',
    issueType: 'feature',
    risk: 'Low',
    effort: 'Medium',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
    ...overrides,
  } as WorkItem;
}

function makeListState(n: number): WorkItemListState {
  return new WorkItemListState(
    Array.from({ length: n }, (_, i) => makeItem(`WL-${i}`)),
    TERM_80x24,
  );
}

/** Motion event helper (button includes the 32 motion bit). */
function motion(button: number, x: number, y: number) {
  return { button: button | 32, x, y, release: false };
}

// ── AC2/AC7: tooltip state machine ─────────────────────────────────────

describe('tooltip state machine (WL-0MT9XRZDK006GMUH AC2/AC7)', () => {
  it('a motion over a visible row sets hoveredRowIndex (tooltip candidate)', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    // Motion over row 5 → display-row index 3.
    expect(handleMouseInput(state, '\x1b[<32;5;5M', TERM_80x24, click)).toBe(true);
    expect(state.hoveredRowIndex).toBe(3);
    expect(state.tooltipDismissed).toBe(false);
  });

  it('esc dismisses the tooltip: clears hover and sets dismissed', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    handleMouseInput(state, '\x1b[<32;5;5M', TERM_80x24, click);
    expect(state.hoveredRowIndex).toBe(3);

    const action = handleKeypress(state, '\x1b', TERM_80x24);
    expect(action).toBe('dismiss-tooltip');
    expect(state.hoveredRowIndex).toBeNull();
    expect(state.tooltipDismissed).toBe(true);
  });

  it('while dismissed, motion over a row does NOT re-show the tooltip (stays dismissed)', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    handleMouseInput(state, '\x1b[<32;5;5M', TERM_80x24, click);
    handleKeypress(state, '\x1b', TERM_80x24);
    expect(state.tooltipDismissed).toBe(true);

    // Motion over a DIFFERENT row while the pointer is still in the rows area.
    handleMouseInput(state, '\x1b[<32;5;8M', TERM_80x24, click);
    expect(state.hoveredRowIndex).toBe(6);
    expect(state.tooltipDismissed).toBe(true); // still dismissed — no re-show
  });

  it('motion over chrome rows (hover-none) clears dismissal — re-entry re-shows', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    handleMouseInput(state, '\x1b[<32;5;5M', TERM_80x24, click);
    handleKeypress(state, '\x1b', TERM_80x24);
    expect(state.tooltipDismissed).toBe(true);

    // Pointer leaves the rows area (header row 1) → hover-none clears.
    handleMouseInput(state, '\x1b[<32;5;1M', TERM_80x24, click);
    expect(state.hoveredRowIndex).toBeNull();
    expect(state.tooltipDismissed).toBe(false);

    // Re-entry over a row re-shows the tooltip candidate.
    handleMouseInput(state, '\x1b[<32;5;5M', TERM_80x24, click);
    expect(state.hoveredRowIndex).toBe(3);
    expect(state.tooltipDismissed).toBe(false);
  });

  it('esc with no tooltip showing still performs its normal navigation job', () => {
    const state = makeListState(3);
    // No hover → Esc is the normal back action.
    expect(handleKeypress(state, '\x1b', TERM_80x24)).toBe('back');
  });

  it('motion events never select or navigate (AC5/AC6)', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    handleMouseInput(state, '\x1b[<32;5;5M', TERM_80x24, click);
    expect(state.selectedIndex).toBe(0); // unchanged
    expect(state.mode).toBe('list'); // unchanged
  });

  it('releases do not disturb tooltip state', () => {
    const state = makeListState(30);
    const click: MouseClickState = { lastClick: null, now: 0 };
    handleMouseInput(state, '\x1b[<32;5;5M', TERM_80x24, click); // motion press
    handleMouseInput(state, '\x1b[<32;5;5m', TERM_80x24, click); // motion release
    expect(state.hoveredRowIndex).toBe(3);
  });
});

// ── AC4/AC7: motion-to-row mapping ─────────────────────────────────────

describe('mapMouseToAction — motion-to-row mapping (AC4/AC7)', () => {
  it('maps motion over a visible item row to the display-row index', () => {
    const state = makeListState(30);
    // Row 2 → index 0; row 5 → index 3; row 14 → index 12 (fixture rows 2..14).
    expect(mapMouseToAction(state, motion(0, 5, 2), TERM_80x24)).toEqual({ type: 'hover-row', index: 0 });
    expect(mapMouseToAction(state, motion(0, 5, 5), TERM_80x24)).toEqual({ type: 'hover-row', index: 3 });
    expect(mapMouseToAction(state, motion(0, 5, 14), TERM_80x24)).toEqual({ type: 'hover-row', index: 12 });
  });

  it('maps motion over chrome/blank rows to hover-none', () => {
    const state = makeListState(30);
    expect(mapMouseToAction(state, motion(0, 5, 1), TERM_80x24)).toEqual({ type: 'hover-none' }); // header
    expect(mapMouseToAction(state, motion(0, 5, 20), TERM_80x24)).toEqual({ type: 'hover-none' }); // footer
    expect(mapMouseToAction(state, motion(0, 5, 21), TERM_80x24)).toEqual({ type: 'hover-none' }); // metadata panel
  });

  it('accounts for the top fold indicator when scrolled', () => {
    const state = makeListState(30);
    state.scrollOffset = 20;
    expect(mapMouseToAction(state, motion(0, 5, 2), TERM_80x24)).toEqual({ type: 'hover-none' }); // '▲ more'
    expect(mapMouseToAction(state, motion(0, 5, 3), TERM_80x24)).toEqual({ type: 'hover-row', index: 20 });
  });
});

// ── AC1/AC7: metadata formatting ───────────────────────────────────────

describe('formatTooltipLines — metadata formatting (AC1/AC7)', () => {
  it('renders all 8 metadata fields (ID, Title, Command, Priority, Type, Risk, Effort, Start Time)', () => {
    const item = makeItem('WL-ABCD', {
      priority: 'critical',
      issueType: 'epic',
      risk: 'High',
      effort: 'Large',
    });
    const lines = formatTooltipLines(
      item,
      '/skill:implement WL-ABCD',
      '2026-08-26T10:13:46.328Z',
      80,
    );
    const text = lines.map(strip).join('\n');
    expect(text).toContain('WL-ABCD');
    expect(text).toContain('Title for WL-ABCD');
    expect(text).toContain('Command:');
    expect(text).toContain('/skill:implement WL-ABCD');
    expect(text).toContain('Priority:');
    expect(text).toContain('critical');
    expect(text).toContain('Type:');
    expect(text).toContain('epic');
    expect(text).toContain('Risk:');
    expect(text).toContain('High');
    expect(text).toContain('Effort:');
    expect(text).toContain('Large');
    // Start Time renders as a local-time DD/MM/YY HH:MM stamp.
    const startedLine = lines.find((l) => strip(l).includes('Started:'));
    expect(startedLine).toBeDefined();
    expect(strip(startedLine!)).toMatch(/Started: \d{2}\/\d{2}\/\d{2} \d{2}:\d{2}/);
  });

  it('omits the Command row when no command was recorded (backward compatible)', () => {
    const item = makeItem('WL-ABCD');
    const lines = formatTooltipLines(item, undefined, '2026-08-26T10:13:46.328Z', 80);
    const text = lines.map(strip).join('\n');
    expect(text).not.toContain('Command:');
    expect(text).toContain('WL-ABCD'); // other fields still render
  });

  it('truncates long titles/commands to the terminal width', () => {
    const item = makeItem('WL-ABCD', { title: 'Long '.repeat(40).trim() });
    const lines = formatTooltipLines(item, '/skill:implement ' + 'cmd '.repeat(60), '2026-08-26T10:13:46.328Z', 40);
    for (const line of lines) {
      expect(strip(line).length).toBeLessThanOrEqual(40);
    }
  });
});

describe('formatTooltipOverlay — footer overlay (AC1)', () => {
  it('wraps each content line in a box and returns empty for no content', () => {
    expect(formatTooltipOverlay(80, [])).toEqual([]);
    const lines = formatTooltipOverlay(80, ['a', 'bb']);
    expect(lines.length).toBe(2);
    // Both lines carry the styling and content.
    expect(strip(lines[0])).toContain('a');
    expect(strip(lines[1])).toContain('bb');
  });
});

// ── AC1: renderer integration ──────────────────────────────────────────

describe('createListRenderer — tooltip overlay replaces footer (AC1)', () => {
  it('renders tooltip lines instead of the footer hints when supplied', () => {
    const renderer = createListRenderer();
    const items = [makeItem('WL-1'), makeItem('WL-2')];
    const output = renderer(
      items,
      0,
      0,
      TERM_80x24,
      null,
      'list',
      null,
      undefined,
      null,
      0,
      false,
      undefined,
      undefined,
      0,
      false,
      false,
      0,
      undefined,
      undefined,
      '',
      0,
      true,
      0,
      true,
      false,
      ['TIP LINE'],
    );
    expect(strip(output)).toContain('TIP LINE');
    // Normal footer hints are replaced by the tooltip overlay.
    expect(strip(output)).not.toContain('alt+m mouse on');
  });

  it('renders the normal footer when no tooltip lines are supplied', () => {
    const renderer = createListRenderer();
    const items = [makeItem('WL-1')];
    const output = renderer(
      items,
      0,
      0,
      TERM_80x24,
      null,
      'list',
      null,
      undefined,
      null,
      0,
      false,
      undefined,
      'hint-hints',
      0,
      false,
      false,
      0,
      undefined,
      undefined,
      '',
      0,
      true,
      0,
      true,
      false,
    );
    // Normal footer hints render (not the tooltip overlay).
    expect(strip(output)).toContain('hint-hints');
    expect(strip(output)).not.toContain('TIP LINE');
  });
});

// ── AC4/AC6/AC7: command storage + backward-compatible parsing ─────────

describe('AgentTracker — command persistence (AC4/AC6/AC7)', () => {
  function makeTracker(): { tracker: AgentTracker; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-tooltip-'));
    const stateFile = join(dir, AGENT_PANES_FILE);
    const tracker = new AgentTracker({ stateFile });
    return { tracker, dir };
  }

  it('records and persists the command with the pane association (AC4)', async () => {
    const { tracker, dir } = makeTracker();
    try {
      await tracker.recordAgentForWorkItem('WL-1', 'pane-1', '/skill:implement WL-1');
      expect(tracker.getPaneId('WL-1')).toBe('pane-1');
      expect(tracker.getCommand('WL-1')).toBe('/skill:implement WL-1');
      expect(tracker.getEntry('WL-1')?.recordedAt).toBeDefined();

      // Persisted on disk.
      const raw = JSON.parse(readFileSync(join(dir, AGENT_PANES_FILE), 'utf8'));
      expect(raw[0].command).toBe('/skill:implement WL-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a legacy file whose entries lack the command field (AC6)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-tooltip-legacy-'));
    try {
      // Legacy shape: no command field.
      writeFileSync(
        join(dir, AGENT_PANES_FILE),
        JSON.stringify([
          { workItemId: 'WL-OLD', paneId: 'pane-old', recordedAt: '2026-08-01T00:00:00.000Z' },
        ]),
      );
      const tracker = new AgentTracker({ stateFile: join(dir, AGENT_PANES_FILE) });
      expect(tracker.getPaneId('WL-OLD')).toBe('pane-old');
      expect(tracker.getCommand('WL-OLD')).toBeUndefined();
      expect(tracker.getEntry('WL-OLD')?.recordedAt).toBe('2026-08-01T00:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a recorded command through a fresh tracker instance (AC4/AC6)', async () => {
    const { tracker, dir } = makeTracker();
    await tracker.recordAgentForWorkItem('WL-1', 'pane-1', '/intake WL-1');
    // Fresh instance reads the persisted file.
    const reloaded = new AgentTracker({ stateFile: join(dir, AGENT_PANES_FILE) });
    expect(reloaded.getCommand('WL-1')).toBe('/intake WL-1');
    rmSync(dir, { recursive: true, force: true });
  });
});