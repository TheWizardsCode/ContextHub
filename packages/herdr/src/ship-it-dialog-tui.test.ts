/**
 * packages/herdr/src/ship-it-dialog-tui.test.ts — Integration tests for the
 * Ship It confirmation dialog in the worklist TUI (WL-0MSGG5N5Z0074TLY).
 *
 * Exercises the end-to-end TUI flow with the REAL shortcut registry
 * (loadShortcutConfig, same as production index.ts) and a fake stdin/stdout
 * harness (same pattern as code-freeze-dialog.test.ts):
 *   - pressing `S` opens the bottom-anchored dialog (list still visible);
 *   - typing `ship` (case-insensitive) + Enter dispatches
 *     `/skill:ship release` via the standard command-routing path — with NO
 *     `<id>` substitution;
 *   - non-matching text + Enter does NOT dispatch (dialog stays open);
 *   - Esc cancels without dispatching;
 *   - `s` (lowercase Search) does NOT open the dialog (S/s distinct);
 *   - the Ship It shortcut stays available during a Code Freeze;
 *   - the S shortcut appears in the footer hints.
 *
 * Run: npx vitest run packages/herdr/src/ship-it-dialog-tui.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before worklist.js is imported)
// ---------------------------------------------------------------------------

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

import { runWorklistTui, SHIP_IT_COMMAND } from './worklist.js';
import { setWorklogDir, resetWorklogDir, type WorkItem } from './fetcher.js';
import { CODE_FREEZE_MARKER_FILENAME } from './code-freeze.js';
import { setLogPath, resetLogPath } from './command-log.js';
import { loadShortcutConfig } from './shortcut-config.js';

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as code-freeze-dialog.test.ts)
// ---------------------------------------------------------------------------

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];

/** Temp worklog dir holding the code-freeze marker for the current test. */
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];

  // Isolate the command log so dispatched commands never touch the user's
  // real ~/.config/herdr log (WL-0MSEPP104006PS7T).
  setLogPath(join(tmpdir(), `herdr-ship-cmdlog-${process.pid}-${Date.now()}.json`));

  tmpDir = mkdtempSync(join(tmpdir(), 'herdr-ship-'));
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
  resetLogPath();
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
 * Start the TUI with auto-refresh/sync disabled and the REAL shortcut
 * registry (same as production index.ts).
 */
function startTui(
  onCommand?: (c: string) => void,
  items: WorkItem[] = [],
  opts: { showHelpText?: boolean } = {},
): Promise<WorkItem | undefined> {
  return runWorklistTui(async () => items, items, loadShortcutConfig(), {
    autoRefresh: false,
    autoSync: false,
    showHelpText: opts.showHelpText ?? false,
    onCommand,
  });
}

/** The last full render written to stdout. */
function lastRender(): string {
  return writes[writes.length - 1] ?? '';
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * True when the last render shows the bottom-anchored Ship It dialog over
 * the selection list: the list header AND the dialog copy are both present.
 */
function shipDialogShowing(): boolean {
  const out = stripAnsi(lastRender());
  return out.includes('Work Items') && out.includes("Type 'ship' to confirm, Esc to cancel");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Ship It shortcut (S) — typed confirmation dialog (WL-0MSGG5N5Z0074TLY)', () => {
  it('opens the bottom-anchored dialog on S with the list still visible', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')]);
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    await tick();

    expect(shipDialogShowing()).toBe(true);
    // Nothing dispatched yet — typing alone must not fire the release.
    expect(onCommand).not.toHaveBeenCalled();

    dataHandler?.(Buffer.from('\x1b')); // cancel
    await tick();
    await tick();
    expect(shipDialogShowing()).toBe(false);

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('does not open the dialog for lowercase s (Search chord, S/s distinct)', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')]);
    await tick();

    dataHandler?.(Buffer.from('s'));
    await tick();
    await tick();

    // Lowercase s is the Search shortcut (unknown <search_term> → form page);
    // it must NOT trigger the Ship It confirmation dialog.
    expect(shipDialogShowing()).toBe(false);
    expect(stripAnsi(lastRender())).toContain('Command Input');

    dataHandler?.(Buffer.from('\x1b')); // cancel the form
    await tick();
    await tick();
    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('dispatches /skill:ship release (no <id>) when the user types ship + Enter', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')]);
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    await tick();
    expect(shipDialogShowing()).toBe(true);

    for (const ch of 'ship') dataHandler?.(Buffer.from(ch));
    await tick();
    await tick();
    // The typed buffer is reflected in the dialog render.
    expect(stripAnsi(lastRender())).toContain('> ship');

    dataHandler?.(Buffer.from('\r')); // Enter submits
    await tick();
    await tick();

    expect(onCommand).toHaveBeenCalledWith(SHIP_IT_COMMAND, 'plan'); // agent commands default to the plan model
    expect(onCommand).toHaveBeenCalledTimes(1);
    // The dialog closes after dispatch.
    expect(shipDialogShowing()).toBe(false);

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('matches case-insensitively (SHIP dispatches)', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1')]);
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    for (const ch of 'SHIP') dataHandler?.(Buffer.from(ch));
    await tick();
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();

    expect(onCommand).toHaveBeenCalledWith(SHIP_IT_COMMAND, 'plan'); // agent commands default to the plan model
    expect(onCommand).toHaveBeenCalledTimes(1);

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('does not dispatch on Enter with non-matching text (dialog stays open)', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1')]);
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    for (const ch of 'shipx') dataHandler?.(Buffer.from(ch));
    await tick();
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();

    expect(onCommand).not.toHaveBeenCalled();
    // Dialog stays open (AC3): the list + prompt are still rendered.
    expect(shipDialogShowing()).toBe(true);

    dataHandler?.(Buffer.from('\x1b')); // cancel
    await tick();
    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('cancels with Esc without dispatching anything', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1')]);
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    for (const ch of 'ship') dataHandler?.(Buffer.from(ch));
    await tick();
    expect(shipDialogShowing()).toBe(true);

    dataHandler?.(Buffer.from('\x1b')); // Esc cancels
    await tick();
    await tick();

    expect(shipDialogShowing()).toBe(false);
    expect(onCommand).not.toHaveBeenCalled();

    // The TUI is back in list mode: j navigates.
    const writesBefore = writes.length;
    dataHandler?.(Buffer.from('j'));
    await tick();
    await tick();
    expect(writes.length).toBeGreaterThan(writesBefore);

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('consumes navigation keys while the dialog is open (modal input)', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1')]);
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    expect(shipDialogShowing()).toBe(true);

    // Navigation keys are swallowed into the typed buffer, not navigation.
    dataHandler?.(Buffer.from('j'));
    await tick();
    expect(shipDialogShowing()).toBe(true);
    expect(stripAnsi(lastRender())).toContain('> j');

    dataHandler?.(Buffer.from('\x1b'));
    await tick();
    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('is NOT blocked during a Code Freeze (ship skill gates itself)', async () => {
    writeActiveFreezeMarker('ship release in progress');
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')]);
    await tick();

    // During a freeze the S shortcut still resolves (no code_freeze: "block").
    dataHandler?.(Buffer.from('S'));
    await tick();
    await tick();
    expect(shipDialogShowing()).toBe(true);

    for (const ch of 'ship') dataHandler?.(Buffer.from(ch));
    await tick();
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();

    // The release command is dispatched even while frozen — the ship skill
    // itself decides whether a release may proceed.
    expect(onCommand).toHaveBeenCalledWith(SHIP_IT_COMMAND, 'plan'); // agent commands default to the plan model

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('shows the S ship-it shortcut in the dynamic footer hints', async () => {
    const p = startTui(() => {}, [makeItem('WL-TEST-1', 'plan_complete')], { showHelpText: true });
    await tick();

    const out = stripAnsi(lastRender());
    expect(out).toContain('S:ship it');
    expect(out).toContain('s:Search');

    dataHandler?.(Buffer.from('q'));
    await p;
  });
});
