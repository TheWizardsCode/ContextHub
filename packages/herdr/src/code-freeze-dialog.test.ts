/**
 * packages/herdr/src/code-freeze-dialog.test.ts — Integration tests for the
 * Code Freeze notice dialog in the worklist TUI (WL-0MSBU4KMA004PKSR, AC7).
 *
 * Covers the dialog DISMISSAL key handling in runWorklistTui's onData
 * (worklist.ts:1842-1846): while the notice is showing, Esc/Enter/q dismiss
 * it and return to the list; every other key is consumed (the dialog is
 * modal); and the blocked implement command is never dispatched — neither
 * while the dialog is showing nor after dismissal.
 *
 * The dialog *rendering* (formatCodeFreezeDialog) is unit-tested in
 * worklist.test.ts; this file exercises the end-to-end TUI flow with a REAL
 * code-freeze marker file (via setWorklogDir) so the marker -> dialog ->
 * dismissal chain is verified together.
 *
 * Run: npx vitest run packages/herdr/src/code-freeze-dialog.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before worklist.js is imported)
// ---------------------------------------------------------------------------
// Keep the REAL fetcher exports (getWorklogDir/setWorklogDir/readCodeFreezeState
// resolution) but stub the exec-heavy helpers so no real `wl`/`herdr` process
// is spawned. auto-sync and notify are stubbed to keep the run hermetic.

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
import { CODE_FREEZE_MARKER_FILENAME } from './code-freeze.js';
import { loadShortcutConfig } from './shortcut-config.js';

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as notify-dispatch.test.ts)
// ---------------------------------------------------------------------------

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];

/** Temp worklog dir holding the code-freeze marker for the current test. */
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];

  // A fresh worklog dir per test; the marker is written by helpers below.
  tmpDir = mkdtempSync(join(tmpdir(), 'herdr-cfd-'));
  setWorklogDir(tmpDir);

  // Define missing stdin properties (vitest's process.stdin may not expose them)
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
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Small async tick helper so awaited promises settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

/**
 * Build a minimal WorkItem with required fields.
 */
function makeItem(id: string, stage?: string): WorkItem {
  return { id, title: `Item ${id}`, status: 'open', stage };
}

/** Write an active code-freeze marker into the temp worklog dir. */
function writeActiveFreezeMarker(reason?: string): void {
  writeFileSync(
    join(tmpDir, CODE_FREEZE_MARKER_FILENAME),
    JSON.stringify({ active: true, reason, startedAt: '2026-08-02T00:00:00Z', pid: 999 }),
    'utf8',
  );
}

/**
 * Start the TUI with auto-refresh/sync disabled and a real marker dir.
 *
 * Uses the REAL shortcut registry (loadShortcutConfig, same as production
 * index.ts) so the 'i' single-key /skill:implement shortcut is registered.
 */
function startTui(onCommand?: (c: string) => void, items: WorkItem[] = []): Promise<WorkItem | undefined> {
  return runWorklistTui(async () => items, items, loadShortcutConfig(), {
    autoRefresh: false,
    autoSync: false,
    showHelpText: false,
    onCommand,
  });
}

/** Raw accumulated stdout (ANSI codes included). */
function rawOutput(): string {
  return writes.join('');
}

/**
 * The last full render written to stdout. Since every render starts with
 * ANSI.clear + cursorHome, the last write is a complete redraw.
 */
function lastRender(): string {
  return writes[writes.length - 1] ?? '';
}

/**
 * True when the last render is the modal notice DIALOG. The list render also
 * contains 'CODE FREEZE' (the header banner when a freeze is active), so the
 * dialog is detected via its unique copy: 'No agent pane was spawned...' and
 * the '[Esc] dismiss  [Enter] dismiss' hint line.
 */
function dialogShowing(): boolean {
  const out = lastRender();
  return out.includes('No agent pane was spawned') && out.includes('dismiss');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Code Freeze notice dialog — dismissal key handling (AC7)', () => {
  it('shows the dialog when implement is pressed during a freeze and does not dispatch', async () => {
    writeActiveFreezeMarker('ship release in progress');
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')]);
    await tick();

    dataHandler?.(Buffer.from('i')); // /skill:implement <id> single-key shortcut
    await tick();
    await tick();

    const out = rawOutput();
    expect(dialogShowing()).toBe(true);
    expect(out).toContain('ship release in progress');
    // The blocked command must never be routed to the pi pane.
    expect(onCommand).not.toHaveBeenCalled();

    dataHandler?.(Buffer.from('q')); // dismiss (see 'q' test below) then quit
    await tick();
    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('dismisses the dialog with Esc and returns to the list without dispatching', async () => {
    writeActiveFreezeMarker('ship release in progress');
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')]);
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();
    expect(dialogShowing()).toBe(true);

    // Esc dismisses the modal dialog
    dataHandler?.(Buffer.from('\x1b'));
    await tick();
    await tick();
    expect(dialogShowing()).toBe(false);
    // The blocked command stays blocked — dismissal is NOT execution.
    expect(onCommand).not.toHaveBeenCalled();

    // The TUI is back in list mode: 'j' navigates (a fresh list render).
    const writesBefore = writes.length;
    dataHandler?.(Buffer.from('j'));
    await tick();
    await tick();
    expect(writes.length).toBeGreaterThan(writesBefore);
    expect(dialogShowing()).toBe(false);

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('dismisses the dialog with Enter', async () => {
    writeActiveFreezeMarker();
    const onCommand = vi.fn();
    const p = startTui(onCommand);
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();
    expect(dialogShowing()).toBe(true);

    // Enter (\r) dismisses
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();
    expect(dialogShowing()).toBe(false);
    expect(onCommand).not.toHaveBeenCalled();

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('dismisses the dialog with q without quitting the TUI', async () => {
    writeActiveFreezeMarker();
    const onCommand = vi.fn();
    const p = startTui(onCommand);
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();
    expect(dialogShowing()).toBe(true);

    // q while the notice is showing dismisses it (does NOT quit).
    dataHandler?.(Buffer.from('q'));
    await tick();
    await tick();
    expect(dialogShowing()).toBe(false);

    // The TUI is still alive and interactive after the dismissal.
    const writesAfterDismiss = writes.length;
    dataHandler?.(Buffer.from('j'));
    await tick();
    await tick();
    expect(writes.length).toBeGreaterThan(writesAfterDismiss);

    // A second q actually quits.
    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('consumes every other key while the dialog is showing (modal)', async () => {
    writeActiveFreezeMarker();
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')]);
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();
    expect(dialogShowing()).toBe(true);

    // Navigation keys are swallowed — the dialog stays up.
    dataHandler?.(Buffer.from('j'));
    await tick();
    await tick();
    expect(dialogShowing()).toBe(true);

    // A repeated implement press is also swallowed — still no dispatch.
    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();
    expect(dialogShowing()).toBe(true);
    expect(onCommand).not.toHaveBeenCalled();

    dataHandler?.(Buffer.from('\x1b')); // dismiss
    await tick();
    await tick();
    expect(dialogShowing()).toBe(false);

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('re-shows the dialog when implement is attempted again after dismissal (freeze persists)', async () => {
    writeActiveFreezeMarker();
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')]);
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();
    expect(dialogShowing()).toBe(true);

    dataHandler?.(Buffer.from('\x1b')); // dismiss
    await tick();
    await tick();
    expect(dialogShowing()).toBe(false);

    // Freeze is still active — the guard fires again.
    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();
    expect(dialogShowing()).toBe(true);
    expect(onCommand).not.toHaveBeenCalled();

    dataHandler?.(Buffer.from('\x1b'));
    await tick();
    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('dispatches implement normally when not frozen (no dialog)', async () => {
    // No marker written → not frozen.
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')]);
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();

    expect(onCommand).toHaveBeenCalledWith('/skill:implement WL-TEST-1');
    expect(rawOutput()).not.toContain('CODE FREEZE');

    dataHandler?.(Buffer.from('q'));
    await p;
  });
});
