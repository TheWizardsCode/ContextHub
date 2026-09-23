/**
 * packages/herdr/src/ship-guard-tui.test.ts — TUI integration tests for the
 * Ship Guard pre-dialog gate and freeze-on-confirm (WL-0MUDELHIH009O0AX /
 * parent WL-0MUD6DDZC007ZSIW).
 *
 * Drives the REAL worklist TUI with the REAL shortcut registry
 * (loadShortcutConfig, same as production index.ts) and a fake stdin/stdout
 * harness (same pattern as ship-it-dialog-tui.test.ts /
 * code-freeze-dialog.test.ts). The Ship Guard query is injected, so no real
 * `wl`/`herdr` process is spawned; the Code Freeze marker uses a real temp
 * worklog directory.
 *
 * Covered:
 *   - `S` with blocking (live) panes  → dialog NOT opened, blocked notice
 *     lists the offending work-item IDs + pane labels;
 *   - `S` with no blocking panes      → dialog opens (no regression) and
 *     `ship` + Enter dispatches `/skill:ship release`;
 *   - `S` with done/exited agents     → dialog opens (only live panes block);
 *   - `S` with a guard query failure  → fail safe, no dialog;
 *   - different-project IDs           → do NOT block;
 *   - multiple blocking panes         → all listed;
 *   - confirm writes the Code Freeze marker BEFORE dispatch;
 *   - dispatch failure (onCommand throws) → marker cleared, error surfaced;
 *   - blocked notice dismissal (Esc/Enter/q) and no dispatch while blocked.
 *
 * Run: npx vitest run packages/herdr/src/ship-guard-tui.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { isCodeFreezeActive, readCodeFreezeState } from './code-freeze.js';
import { showToast } from './notify.js';
import { setLogPath, resetLogPath } from './command-log.js';
import { loadShortcutConfig } from './shortcut-config.js';

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness
// ---------------------------------------------------------------------------

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];

  // Isolate the command log so dispatched commands never touch the user's
  // real ~/.config/herdr log.
  setLogPath(join(tmpdir(), `herdr-shipguard-cmdlog-${process.pid}-${Date.now()}.json`));

  tmpDir = mkdtempSync(join(tmpdir(), 'herdr-shipguard-'));
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

function makeItem(id: string, stage?: string): WorkItem {
  return { id, title: `Item ${id}`, status: 'open', stage };
}

// ---------------------------------------------------------------------------
// Guard-query fixtures
// ---------------------------------------------------------------------------

type GuardQuery = () => Promise<{ worklogOutput: string | null; paneOutput: string | null }>;

/** Realistic project work-item IDs (the ID regex needs 6+ chars after the dash). */
const TEST_ITEM = 'WL-0MUDEGBGO00609RV';
const TEST_ITEM_2 = 'WL-0MUDEIYUB008FFC2';
/** A different project's work-item ID — must NOT block. */
const OTHER_ITEM = 'AH-0MTVYBL2L0085G6G';

/** `wl list --json` output carrying `ids` as project work items. */
function worklog(ids: string[]): string {
  return JSON.stringify({ workItems: ids.map((id) => ({ id, title: `Item ${id}` })) });
}

interface PaneFixture {
  paneId: string;
  label?: string;
  agent?: string;
  agentStatus?: string;
}

/** `herdr pane list` output carrying `panes`. */
function paneList(panes: PaneFixture[]): string {
  return JSON.stringify({
    result: {
      panes: panes.map((p) => ({
        pane_id: p.paneId,
        label: p.label,
        agent: p.agent,
        agent_status: p.agentStatus,
      })),
    },
  });
}

/** A guard query returning the given raw CLI outputs. */
function guardQuery(worklogOutput: string | null, paneOutput: string | null): GuardQuery {
  return async () => ({ worklogOutput, paneOutput });
}

/** A guard query with no project panes — the ship dialog may open. */
function clearGuard(): GuardQuery {
  return guardQuery(worklog([TEST_ITEM]), paneList([]));
}

// ---------------------------------------------------------------------------
// TUI harness
// ---------------------------------------------------------------------------

function startTui(
  onCommand: ((...args: any[]) => void) | undefined,
  items: WorkItem[] = [],
  shipGuardQuery: GuardQuery = clearGuard(),
): Promise<WorkItem | undefined> {
  return runWorklistTui(async () => items, items, loadShortcutConfig(), {
    autoRefresh: false,
    autoSync: false,
    showHelpText: false,
    onCommand,
    shipGuardQuery,
  });
}

function lastRender(): string {
  return writes[writes.length - 1] ?? '';
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** True when the bottom-anchored Ship It dialog is showing. */
function shipDialogShowing(): boolean {
  const out = stripAnsi(lastRender());
  return out.includes('Work Items') && out.includes("Type 'ship' to confirm, Esc to cancel");
}

/** True when the full-pane Ship-mode blocked notice is showing. */
function blockedNoticeShowing(): boolean {
  return stripAnsi(lastRender()).includes('SHIP MODE BLOCKED');
}

/** Press keys (one Buffer per character) with a settle tick. */
async function press(keys: string): Promise<void> {
  for (const ch of keys) dataHandler?.(Buffer.from(ch));
  await tick();
}

// ---------------------------------------------------------------------------
// Pre-dialog gate
// ---------------------------------------------------------------------------

describe('Ship Guard — pre-dialog gate (WL-0MUDELHIH009O0AX)', () => {
  it('does NOT open the dialog when a live agent pane carries a project item; shows the blocked notice', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')], guardQuery(
      worklog([TEST_ITEM]),
      paneList([
        { paneId: 'p1', label: `Downtime implement ${TEST_ITEM}`, agent: 'agent-1', agentStatus: 'working' },
      ]),
    ));
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    await tick();

    // Dialog is NOT open; the blocked notice is shown instead.
    expect(shipDialogShowing()).toBe(false);
    expect(blockedNoticeShowing()).toBe(true);
    const out = stripAnsi(lastRender());
    expect(out).toContain(TEST_ITEM);
    expect(out).toContain(`Downtime implement ${TEST_ITEM}`);
    // Nothing dispatched by opening the gate.
    expect(onCommand).not.toHaveBeenCalled();

    // Dismiss with q, then quit.
    await press('q');
    expect(blockedNoticeShowing()).toBe(false);
    await press('q');
    await p;
  });

  it('lists multiple blocking panes with their work-item IDs and labels', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1')], guardQuery(
      worklog([TEST_ITEM, TEST_ITEM_2]),
      paneList([
        { paneId: 'p1', label: `implement ${TEST_ITEM}`, agent: 'a1', agentStatus: 'working' },
        { paneId: 'p2', label: `audit ${TEST_ITEM_2}`, agent: 'a2', agentStatus: 'idle' },
        { paneId: 'p3', label: `Publish ${TEST_ITEM}`, agent: 'a3', agentStatus: 'blocked' },
      ]),
    ));
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    await tick();

    expect(blockedNoticeShowing()).toBe(true);
    const out = stripAnsi(lastRender());
    expect(out).toContain(`implement ${TEST_ITEM}`);
    expect(out).toContain(`audit ${TEST_ITEM_2}`);
    expect(out).toContain(`Publish ${TEST_ITEM}`);

    await press('q');
    await press('q');
    await p;
  });

  it('opens the dialog when no panes are blocking (no regression)', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')], clearGuard());
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    await tick();

    expect(blockedNoticeShowing()).toBe(false);
    expect(shipDialogShowing()).toBe(true);

    await press('\x1b'); // cancel
    await press('q');
    await p;
  });

  it('does NOT block on done/exited agents (only live panes block)', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1')], guardQuery(
      worklog([TEST_ITEM]),
      paneList([
        { paneId: 'p1', label: `implement ${TEST_ITEM}`, agent: 'a1', agentStatus: 'done' },
        { paneId: 'p2', label: `audit ${TEST_ITEM}`, agent: 'a2', agentStatus: 'exited' },
      ]),
    ));
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    await tick();

    expect(blockedNoticeShowing()).toBe(false);
    expect(shipDialogShowing()).toBe(true);

    await press('\x1b');
    await press('q');
    await p;
  });

  it('does NOT block on work-item IDs from a different project', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1')], guardQuery(
      worklog([TEST_ITEM]),
      paneList([
        { paneId: 'p1', label: `implement ${OTHER_ITEM}`, agent: 'a1', agentStatus: 'working' },
      ]),
    ));
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    await tick();

    expect(blockedNoticeShowing()).toBe(false);
    expect(shipDialogShowing()).toBe(true);

    await press('\x1b');
    await press('q');
    await p;
  });

  it('fails safe (no dialog) when the guard query is unavailable', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1')], guardQuery(null, null));
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    await tick();

    expect(shipDialogShowing()).toBe(false);
    expect(blockedNoticeShowing()).toBe(true);
    expect(stripAnsi(lastRender())).toContain('Cannot verify pane state');
    expect(onCommand).not.toHaveBeenCalled();

    await press('\x1b');
    await press('q');
    await p;
  });

  it('does not dispatch while the blocked notice is showing', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand, [makeItem('WL-TEST-1')], guardQuery(
      worklog([TEST_ITEM]),
      paneList([
        { paneId: 'p1', label: `implement ${TEST_ITEM}`, agent: 'a1', agentStatus: 'working' },
      ]),
    ));
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    await tick();
    expect(blockedNoticeShowing()).toBe(true);

    // Typing `ship` + Enter while blocked must not dispatch.
    for (const ch of 'ship') dataHandler?.(Buffer.from(ch));
    await tick();
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();
    expect(onCommand).not.toHaveBeenCalled();

    await press('q');
    await press('q');
    await p;
  });
});

// ---------------------------------------------------------------------------
// Freeze-on-confirm
// ---------------------------------------------------------------------------

describe('Ship Guard — freeze on confirm (WL-0MUDELHIH009O0AX)', () => {
  it('writes the Code Freeze marker BEFORE dispatching the release', async () => {
    const onCommand = vi.fn();
    // Capture the marker state at the exact moment the dispatch callback runs.
    let markerActiveAtDispatch: boolean | undefined;
    onCommand.mockImplementation(() => {
      markerActiveAtDispatch = isCodeFreezeActive(tmpDir);
    });

    const p = startTui(onCommand, [makeItem('WL-TEST-1', 'plan_complete')], clearGuard());
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    expect(shipDialogShowing()).toBe(true);
    // No marker before confirming.
    expect(isCodeFreezeActive(tmpDir)).toBe(false);

    for (const ch of 'ship') dataHandler?.(Buffer.from(ch));
    await tick();
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith(
      SHIP_IT_COMMAND,
      'plan',
      undefined,
      undefined,
      'Item WL-TEST-1',
    );
    // The marker existed at dispatch time (ordering proof) and remains after
    // a successful dispatch — the ship skill clears it on release exit.
    expect(markerActiveAtDispatch).toBe(true);
    expect(isCodeFreezeActive(tmpDir)).toBe(true);
    expect(readCodeFreezeState(tmpDir).reason).toContain('Ship It');

    await press('q');
    await p;
  });

  it('best-effort clears the marker it wrote when dispatch throws, and surfaces the error', async () => {
    const onCommand = vi.fn(() => {
      throw new Error('no agent pane available');
    });
    const p = startTui(onCommand, [makeItem('WL-TEST-1')], clearGuard());
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    for (const ch of 'ship') dataHandler?.(Buffer.from(ch));
    await tick();
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();

    expect(onCommand).toHaveBeenCalledTimes(1);
    // Marker written then cleared — no stale freeze after a failed dispatch.
    expect(isCodeFreezeActive(tmpDir)).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      'Error',
      expect.objectContaining({ body: 'no agent pane available' }),
    );

    await press('q');
    await p;
  });

  it('leaves a pre-existing freeze marker untouched on dispatch failure (ship skill owns it)', async () => {
    // Simulate the ship skill having already written the marker.
    const { writeCodeFreezeMarker } = await import('./code-freeze.js');
    writeCodeFreezeMarker({ worklogDir: tmpDir, reason: 'ship skill release', pid: 1234 });

    const onCommand = vi.fn(() => {
      throw new Error('dispatch boom');
    });
    const p = startTui(onCommand, [makeItem('WL-TEST-1')], clearGuard());
    await tick();

    dataHandler?.(Buffer.from('S'));
    await tick();
    for (const ch of 'ship') dataHandler?.(Buffer.from(ch));
    await tick();
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();

    // The ship skill's marker is preserved (we did not write it, so we must
    // not clear it) — the release may already be running.
    expect(isCodeFreezeActive(tmpDir)).toBe(true);
    expect(readCodeFreezeState(tmpDir).reason).toBe('ship skill release');

    await press('q');
    await p;
  });
});
