/**
 * tests/unit/worklist-help-layout.test.ts — Help-screen layout contract
 * (parent WL-0MTV97GV20088CS7; producer audits rejected earlier layouts on
 * 2026-10-15 and 2026-10-16).
 *
 * The 2026-10-15 producer audit required:
 *   - command chords in a SINGLE column with FULL (never ellipsis-truncated)
 *     descriptions, grouped logically with headings separating groups;
 *   - icons grouped by their category prefix under headings, with the prefix
 *     removed from the meaning and each group on a single line.
 *
 * The 2026-10-16 producer audit required:
 *   - blank lines separating the sections;
 *   - colours for the headings;
 *   - the ability to scroll the text.
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

/** Strip ANSI SGR escape sequences so layout assertions match visible text. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

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
  const lines = frame.split('\n');

  it('renders every command description in full, never truncated with an ellipsis', () => {
    // The rejected grid ellipsis-truncated every description to the column
    // width; the reworked layout must carry the whole text (word-wrapped).
    expect(frame).not.toContain('\u2026');

    const flat = flatten(stripAnsi(frame));
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
    for (const heading of [
      'd — Downtime',
      'c — Create',
      'i — Implement',
      'r — Review',
      'u — Update',
      'f — Filter',
    ]) {
      expect(
        lines.map(stripAnsi),
        `missing group heading "${heading}"`,
      ).toContain(heading);
    }
  });

  it('separates sections and families with blank lines (2026-10-16 audit)', () => {
    const visible = lines.map(stripAnsi);
    // A blank line separates the title from the first section heading.
    expect(visible.indexOf('')).toBeGreaterThanOrEqual(0);
    // A blank line separates each command family: headings are never adjacent.
    const familyIndices = visible.map((l, i) => (l.startsWith('d — ') || l.startsWith('c — ') || l.startsWith('i — ') ? i : -1)).filter(i => i >= 0);
    for (const idx of familyIndices) {
      expect(visible[idx - 1] ?? '', `family heading at ${idx} is not preceded by a blank line`).toBe('');
      expect(visible[idx + 1] ?? 'EOF', `family heading at ${idx} is not followed by content`).not.toBe('');
    }
  });

  it('colours the headings at every level (2026-10-16 audit)', () => {
    // Title, section headings and sub-headings each carry bold + a 256-colour
    // foreground code and are terminated by a reset — never plain text.
    expect(frame).toMatch(/\x1b/);
    const expectStyled = (text: string): void => {
      const line = lines.find(l => stripAnsi(l).trim() === text.trim());
      expect(line, `heading "${text}" should exist`).toBeDefined();
      expect(line, `heading "${text}" should carry ANSI styling`).toMatch(/\x1b\[1m/);
      expect(line, `heading "${text}" should carry a colour`).toMatch(/\x1b\[38;5;\d+m/);
      expect(line, `heading "${text}" should be reset`).toContain('\x1b[0m');
    };
    expectStyled('Help');
    expectStyled('Commands');
    expectStyled('d — Downtime');
    expectStyled('Icons');
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
      'Agent',
      'Coverage',
    ]) {
      expect(
        lines.map(stripAnsi),
        `missing icon group heading "${heading}"`,
      ).toContain(heading);
    }
  });

  it('removes the category name prefix from each meaning', () => {
    const frame = formatHelpScreen(entries, 200, 260, iconRows);
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

describe('help screen layout — scrolling (2026-10-16 audit)', () => {
  it('shows a scroll hint in the footer when content overflows the pane', () => {
    const rows = 12;
    const small = formatHelpScreen(entries, 100, rows, iconRows);
    const visible = stripAnsi(small);
    // Dismiss keys stay discoverable…
    expect(visible).toContain('? / Esc / q');
    // … and the footer advertises the scroll capability.
    expect(visible).toMatch(/↑↓\/j:k scroll/);
    expect(visible).toMatch(/g\/G top\/bot/);
  });

  it('scrolls the content window to reveal hidden lines', () => {
    const rows = 12;
    const top = formatHelpScreen(entries, 100, rows, iconRows, 0);
    const bottom = formatHelpScreen(entries, 100, rows, iconRows, 10_000);
    const topVisible = stripAnsi(top);
    const bottomVisible = stripAnsi(bottom);
    // Top shows the early command families; the bottom window shows the last
    // icon category (`Coverage`) instead of the top of the document.
    expect(topVisible).toContain('d — Downtime');
    expect(topVisible).not.toContain('Coverage');
    expect(bottomVisible).toContain('Coverage');
    expect(bottomVisible.match(/Coverage/g) ?? []).toHaveLength(1);
    // Scrolling further is clamped — the last window is stable.
    expect(bottomVisible).toBe(
      stripAnsi(formatHelpScreen(entries, 100, rows, iconRows, 20_000)),
    );
    // The budget invariant holds for every window.
    for (const f of [top, bottom]) {
      expect(f.split('\n').length).toBeLessThanOrEqual(rows - 1);
    }
  });
});

describe('help screen layout — pane budget (WL-0MTV97GV20088CS7)', () => {
  it('clips to the rows - 1 budget while keeping the dismiss keys visible', () => {
    const cols = 100;
    const rows = 12;
    const small = formatHelpScreen(entries, cols, rows, iconRows);
    const lines = small.split('\n');

    expect(lines.length).toBeLessThanOrEqual(rows - 1);
    expect(stripAnsi(small)).toContain('? / Esc / q');
    // No rendered line overflows the pane width (wrap, never truncate).
    // ANSI colour codes are invisible, so measure the visible text.
    for (const line of lines) {
      const visible = stripAnsi(line);
      expect(visible.length, `line overflows ${cols} cols: ${JSON.stringify(line)}`)
        .toBeLessThanOrEqual(cols);
    }
  });
});
