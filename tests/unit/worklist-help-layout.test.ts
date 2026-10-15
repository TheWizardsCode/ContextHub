/**
 * tests/unit/worklist-help-layout.test.ts — Help-screen layout contract
 * (parent WL-0MTV97GV20088CS7; producer audit rejected the first layout on
 * 2026-10-15).
 *
 * The producer audit of the `?` help overlay required:
 *   - command chords in a SINGLE column with FULL (never ellipsis-truncated)
 *     descriptions, grouped logically with headings separating groups;
 *   - icons grouped by their category prefix under headings, with the prefix
 *     removed from the meaning and each group on a single line.
 *
 * These pins assert the reworked `formatHelpScreen()` output directly (the
 * public formatter the render loop calls). The overlay's open/dismiss and
 * live-registry wiring are covered by `packages/herdr/src/worklist-help.test.ts`;
 * this file lives under `tests/unit/` because the configured project suite
 * (`.pi/test-config.json`: `tests/cli` + `tests/unit`) does not run the
 * package-local `packages/herdr/src/*.test.ts` files — the same layering note
 * as `tests/unit/form-dialog-open-pane.test.ts` (WL-0MUU173V8008IA5E).
 *
 * Run through the test skill (`/skill:test`); do not invoke vitest directly.
 */
import { describe, it, expect } from 'vitest';

import { formatHelpScreen } from '../../packages/herdr/src/worklist.js';
import { loadShortcutConfig } from '../../packages/herdr/src/shortcut-config.js';
import { ICON_LEGEND } from '@worklog/shared/icons';

/** The list-view entries the render path feeds to `formatHelpScreen()`. */
const entries = loadShortcutConfig()
  .getEntriesForStage('plan_complete', false, 'task')
  .filter((e) => e.view === 'list' || e.view === 'both');

/** The icon legend rows the render path builds from the shared source of truth. */
const iconRows = ICON_LEGEND.map((e) => ({
  category: e.category,
  glyph: e.glyph,
  meaning: e.meaning,
}));

/** Collapse wrapped lines so a full description reads as one contiguous string. */
const flatten = (frame: string): string => frame.replace(/\s+/g, ' ').trim();

describe('help screen layout — single-column grouped commands (WL-0MTV97GV20088CS7)', () => {
  const frame = formatHelpScreen(entries, 200, 200, iconRows);

  it('renders every command description in full, never truncated with an ellipsis', () => {
    // The rejected grid ellipsis-truncated every description to the column
    // width; the reworked layout must carry the whole text (word-wrapped).
    expect(frame).not.toContain('\u2026');

    const flat = flatten(frame);
    for (const entry of entries) {
      if (!entry.description) continue;
      expect(
        flat,
        `help should render the full description for "${entry.label ?? entry.command}"`,
      ).toContain(entry.description);
    }

    // The longest entry proves no mid-description clipping.
    expect(flat).toContain(
      'Toggle downtime dispatch for the current pane (d = disable; d again = follow settings; persists across restarts via marker).',
    );
  });

  it('separates command families with a heading per chord leader', () => {
    const lines = frame.split('\n');
    for (const heading of [
      'd — Downtime',
      'c — Create',
      'i — Implement',
      'r — Review',
      'u — Update',
      'f — Filter',
    ]) {
      expect(lines, `missing group heading "${heading}"`).toContain(heading);
    }
  });
});

describe('help screen layout — grouped icon legend (WL-0MTV97GV20088CS7)', () => {
  const frame = formatHelpScreen(entries, 200, 260, iconRows);
  const lines = frame.split('\n');

  it('groups icons by category under headings', () => {
    for (const heading of [
      'Status',
      'Stage',
      'Priority',
      'Epic',
      'Risk',
      'Effort',
      'Audit',
      'Producer Review',
      'Agent',
      'Coverage',
    ]) {
      expect(lines, `missing icon group heading "${heading}"`).toContain(heading);
    }
  });

  it('removes the category name prefix from each meaning', () => {
    // The prefix is gone …
    expect(frame).not.toContain('Status: open');
    expect(frame).not.toContain('Stage: idea');
    expect(frame).not.toContain('Priority: critical');
    expect(frame).not.toContain('Epic — parent work item');
    // … and the bare meaning remains under its heading.
    expect(frame).toContain('open — not started');
    expect(frame).toContain('parent work item');
  });

  it('lists each group on a single line under its heading on a wide pane', () => {
    const statusLine = lines.find((l) => l.includes('open — not started'));
    expect(statusLine).toBeDefined();
    expect(statusLine).toContain('input needed');
  });
});

describe('help screen layout — pane budget (WL-0MTV97GV20088CS7)', () => {
  it('clips to the rows - 1 budget while keeping the dismiss keys visible', () => {
    const cols = 100;
    const rows = 12;
    const small = formatHelpScreen(entries, cols, rows, iconRows);
    const lines = small.split('\n');

    expect(lines.length).toBeLessThanOrEqual(rows - 1);
    expect(small).toContain('? / Esc / q');
    // No rendered line overflows the pane width (wrap, never truncate).
    for (const line of lines) {
      expect(line.length, `line overflows ${cols} cols: ${JSON.stringify(line)}`)
        .toBeLessThanOrEqual(cols);
    }
  });
});
