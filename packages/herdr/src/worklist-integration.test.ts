/**
 * packages/herdr/src/worklist-integration.test.ts — End-to-end integration
 * tests for collapsible group headings with item counts (T6 of
 * WL-0MSL5MPSZ003TG94).
 *
 * Drives the real TUI (runWorklistTui) with a fake stdin/stdout harness:
 * - AC1: navigate to a heading → Tab collapses the group → rows shrink in
 *   render AND navigation → Tab again expands.
 * - AC2: heading counts reflect the top-level items in the group (post
 *   stage-filter) before AND after collapse.
 * - AC3: the `rows - 1` line-count invariant holds under collapse
 *   configurations with the metadata panel.
 *
 * Run: npx vitest run packages/herdr/src/worklist-integration.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./fetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fetcher.js')>();
  return {
    ...actual,
    fetchActionableCount: vi.fn().mockResolvedValue(0),
    fetchChildrenForItem: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('./auto-sync.js', () => ({
  runSync: vi.fn().mockResolvedValue({ success: true }),
  createSyncTimer: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  clampSyncInterval: vi.fn((v: number) => v),
}));

vi.mock('./notify.js', () => ({
  showToast: vi.fn(),
}));

import { runWorklistTui } from './worklist.js';
import { setWorklogDir, resetWorklogDir, type WorkItem } from './fetcher.js';
import { setLogPath, resetLogPath } from './command-log.js';
import { loadShortcutConfig } from './shortcut-config.js';

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as code-freeze-dialog.test.ts)
// ---------------------------------------------------------------------------

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];
  setLogPath(join(tmpdir(), `herdr-int-cmdlog-${process.pid}-${Date.now()}.json`));
  tmpDir = mkdtempSync(join(tmpdir(), 'herdr-int-'));
  setWorklogDir(tmpDir);

  for (const prop of ['on', 'removeListener', 'pause', 'resume', 'setRawMode'] as const) {
    if (!(prop in process.stdin)) {
      Object.defineProperty(process.stdin, prop, {
        value: vi.fn(),
        configurable: true,
        writable: true,
      });
    }
  }
  (process.stdin as any).on = vi.fn((event: string, cb: (chunk: Buffer) => void) => {
    if (event === 'data') dataHandler = cb;
    return process.stdin;
  });
  (process.stdin as any).removeListener = vi.fn(() => process.stdin);
  (process.stdin as any).pause = vi.fn(() => process.stdin);
  (process.stdin as any).resume = vi.fn(() => process.stdin);
  (process.stdin as any).setRawMode = vi.fn(() => process.stdin);
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

  vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => {
    writes.push(String(s));
    return true;
  }) as any);
  vi.spyOn(process.stdout, 'on').mockImplementation((() => process.stdout as any) as any);
  vi.spyOn(process.stdout, 'removeListener').mockImplementation((() => process.stdout as any) as any);
});

afterEach(() => {
  resetWorklogDir();
  resetLogPath();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Small async tick helper so awaited promises settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

function makeItem(id: string, group?: number, groupLabel?: string, stage?: string): WorkItem {
  return { id, title: `Item ${id}`, status: 'open', stage, group, groupLabel };
}

function startTui(items: WorkItem[]): Promise<WorkItem | undefined> {
  return runWorklistTui(async () => items, items, loadShortcutConfig(), {
    autoRefresh: false,
    autoSync: false,
    showHelpText: false,
  });
}

/** Raw accumulated stdout (ANSI codes included). */
function rawOutput(): string {
  return writes.join('');
}

/** The last full render written to stdout (a complete redraw). */
function lastRender(): string {
  return writes[writes.length - 1] ?? '';
}

/** Strip ANSI codes for line counting. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visible lines of the last render. */
function visibleLines(): string[] {
  return stripAnsi(lastRender()).split('\n');
}

// ---------------------------------------------------------------------------
// AC1: End-to-end collapse/expand scenario
// ---------------------------------------------------------------------------

describe('AC1: TUI end-to-end collapse/expand scenario', () => {
  const groupedItems = (): WorkItem[] => [
    makeItem('A', 1, 'Group 1'),
    makeItem('B', 1, 'Group 1'),
    makeItem('C', 2, 'Idea'),
    makeItem('D', 2, 'Idea'),
  ];

  it('navigate to heading → Tab collapses → rows shrink in render and navigation → Tab expands', async () => {
    const p = startTui(groupedItems());
    await tick();

    // Display rows: [h1, A, B, h2, C, D]; initial selection is the h1 heading.
    let lines = visibleLines().join('\n');
    expect(lines).toContain('── Group 1 (2) ▼ ──');
    expect(lines).toContain('── Idea (2) ▼ ──');
    expect(lines).toContain('Item A');

    // Tab on the selected heading (h1) collapses Group 1.
    dataHandler?.(Buffer.from('\t'));
    await tick();
    await tick();

    lines = visibleLines().join('\n');
    // Collapsed group renders only its heading — items A/B are hidden.
    expect(lines).toContain('── Group 1 (2) ▶ ──');
    expect(lines).not.toContain('Item A');
    expect(lines).not.toContain('Item B');
    // Other group unaffected.
    expect(lines).toContain('Item C');
    expect(lines).toContain('Item D');

    // Navigation skips the collapsed items: j from h1 lands on h2, then C.
    dataHandler?.(Buffer.from('j'));
    await tick();
    await tick();
    // Selected row h2 — its heading line is reverse-video in the render.
    let sel = selectedRowText();
    expect(sel).toContain('Idea');

    dataHandler?.(Buffer.from('j'));
    await tick();
    await tick();
    sel = selectedRowText();
    expect(sel).toContain('Item C');

    // j again should wrap or stop — with the collapsed group, nav stays in
    // the visible rows (no jump back into hidden A/B).
    dataHandler?.(Buffer.from('j'));
    await tick();
    await tick();
    sel = selectedRowText();
    expect(sel).toContain('Item D');

    // Tab on the selected heading h2 collapses Idea too.
    // Move back up to h2 (display rows: [h1, h2, C, D]).
    dataHandler?.(Buffer.from('k'));
    await tick();
    await tick();
    sel = selectedRowText();
    expect(sel).toContain('Item C');
    dataHandler?.(Buffer.from('k'));
    await tick();
    await tick();
    sel = selectedRowText();
    expect(sel).toContain('Idea');
    dataHandler?.(Buffer.from('\t'));
    await tick();
    await tick();
    lines = visibleLines().join('\n');
    expect(lines).toContain('── Idea (2) ▶ ──');
    expect(lines).not.toContain('Item C');

    // Tab again on h2 expands it back.
    dataHandler?.(Buffer.from('\t'));
    await tick();
    await tick();
    lines = visibleLines().join('\n');
    expect(lines).toContain('── Idea (2) ▼ ──');
    expect(lines).toContain('Item C');
    expect(lines).toContain('Item D');

    dataHandler?.(Buffer.from('q'));
    await p;
  });
});

// ---------------------------------------------------------------------------
// AC2: counts match top-level items post stage-filter, before/after collapse
// ---------------------------------------------------------------------------

describe('AC2: heading counts are stable across collapse', () => {
  it('counts reflect post-filter top-level items, unchanged by collapse', async () => {
    const items = [
      makeItem('A', 1, 'Group 1'),
      makeItem('B', 1, 'Group 1'),
      makeItem('C', 2, 'Idea', 'idea'),
      makeItem('D', 2, 'Idea'),
    ];
    const p = startTui(items);
    await tick();

    // Count = top-level items in the group (2 each), regardless of collapse.
    let lines = visibleLines().join('\n');
    expect(lines).toContain('── Group 1 (2) ▼ ──');
    expect(lines).toContain('── Idea (2) ▼ ──');

    // Collapse Group 1 — the count stays 2 (it is NOT the visible count).
    dataHandler?.(Buffer.from('\t'));
    await tick();
    await tick();
    lines = visibleLines().join('\n');
    expect(lines).toContain('── Group 1 (2) ▶ ──');
    expect(lines).not.toContain('── Group 1 (0)');

    // Collapse Idea too — both counts remain.
    dataHandler?.(Buffer.from('j'));
    await tick();
    dataHandler?.(Buffer.from('\t'));
    await tick();
    await tick();
    lines = visibleLines().join('\n');
    expect(lines).toContain('── Group 1 (2) ▶ ──');
    expect(lines).toContain('── Idea (2) ▶ ──');

    dataHandler?.(Buffer.from('q'));
    await p;
  });
});

// ---------------------------------------------------------------------------
// AC3: rows - 1 line-count invariant with collapse + metadata panel
// ---------------------------------------------------------------------------

describe('AC3: rows - 1 invariant under collapse configurations', () => {
  it('render never exceeds rows - 1 lines with collapsed groups', async () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      makeItem(`I${i}`, i % 2, i % 2 === 0 ? 'Even' : 'Odd'),
    );
    const p = startTui(items);
    await tick();

    // Baseline (all expanded): render fits rows - 1.
    let lineCount = visibleLines().length;
    expect(lineCount).toBeLessThanOrEqual(23); // 24 rows - 1

    // Collapse the first group, then the second.
    dataHandler?.(Buffer.from('\t')); // collapse Even (h1 selected)
    await tick();
    await tick();
    lineCount = visibleLines().length;
    expect(lineCount).toBeLessThanOrEqual(23);

    dataHandler?.(Buffer.from('j')); // to h2 (Odd)
    await tick();
    await tick();
    dataHandler?.(Buffer.from('\t')); // collapse Odd
    await tick();
    await tick();
    lineCount = visibleLines().length;
    expect(lineCount).toBeLessThanOrEqual(23);
    // Only the two headings remain in the list area.
    const lines = visibleLines().join('\n');
    expect(lines).toContain('── Even (6) ▶ ──');
    expect(lines).toContain('── Odd (6) ▶ ──');

    dataHandler?.(Buffer.from('q'));
    await p;
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the reverse-video selected row from the last render. */
function selectedRowText(): string {
  const raw = lastRender();
  // Selected rows are wrapped in ANSI.reverse (7m). The wrapped content may
  // itself contain fg color codes, so match non-greedily up to the reset.
  const m = raw.match(/\x1b\[7m(.*?)\x1b\[0m/);
  return m ? stripAnsi(m[1]) : '';
}
