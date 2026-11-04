/**
 * packages/herdr/src/host-budget-dialog-tui.test.ts — TUI wiring for the
 * interactive over-quota confirmation dialog (WL-0MVXY0Z93002HKCZ F4, parent
 * WL-0MVXWQFGV000D2AB).
 *
 * The dialog lives in the worklist (it owns the keys and the frame), while the
 * decision lives on the dispatch path (`index.ts`'s `route === 'agent'` block
 * awaits `hostBudgetPrompt.ask()`). This test drives the REAL worklist with the
 * REAL shortcut registry and the REAL prompt host, and stands in for
 * `index.ts`'s agent preamble with the real
 * `prepareInteractiveAgentDispatch()` gate — proving the two halves agree:
 *
 *  - below quota: pressing `i` dispatches with no dialog and no extra keypress;
 *  - at cap: `i` shows the bottom-anchored dialog over the still-visible list,
 *    and nothing is dispatched until the human answers;
 *  - `y`/Enter proceeds (dispatch fires, ledger entry records the override);
 *  - `Esc` cancels — no dispatch, no claim, no ledger entry;
 *  - an unreadable ledger fails open with a visible notice (AC8).
 *
 * Run: npx vitest run packages/herdr/src/host-budget-dialog-tui.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    fetchBlockersForItem: vi.fn().mockResolvedValue([]),
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
import { createHostBudgetPromptHost } from './host-budget-dialog.js';
import { prepareInteractiveAgentDispatch } from './host-dispatch-budget.interactive.js';
import { HOST_BUDGET_CONFIG_FILE } from './host-dispatch-budget.js';
import {
  makeBudgetEntry,
  makeLivePaneList,
  readBudgetLedger,
  writeBudgetLedger,
  type FakeBudgetEntry,
  type FakeLivePane,
} from './host-dispatch-budget.fixtures.js';

const ITEM_ID = 'WL-0000000000000001';
const LEDGER_FILE = 'dispatch-budget.json';

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as ship-it-dialog-tui.test.ts)
// ---------------------------------------------------------------------------

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];

  setLogPath(join(tmpdir(), `herdr-budget-cmdlog-${process.pid}-${Date.now()}.json`));
  tmpDir = mkdtempSync(join(tmpdir(), 'herdr-budget-dialog-'));
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

function makeItem(id: string): WorkItem {
  return { id, title: `Item ${id}`, status: 'open', stage: 'plan_complete' };
}

function lastRender(): string {
  return writes[writes.length - 1] ?? '';
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** True when the last frame shows the over-quota dialog over the list. */
function budgetDialogShowing(): boolean {
  const out = stripAnsi(lastRender());
  return out.includes('Work Items') && out.includes('Host quota exceeded');
}

interface DispatchOutcome {
  spawned: boolean;
  override?: { by: 'user' };
}

interface TuiHarness {
  done: Promise<WorkItem | undefined>;
  claims: ReturnType<typeof vi.fn>;
  outcomes: DispatchOutcome[];
  notices: string[];
}

/**
 * Start the TUI with `index.ts`'s agent preamble reproduced in miniature: the
 * real gate runs, and only a `proceed` verdict "spawns".
 */
function startTui(
  opts: { livePanes?: readonly FakeLivePane[] } = {},
): TuiHarness {
  const promptHost = createHostBudgetPromptHost();
  const claims = vi.fn(async () => {});
  const outcomes: DispatchOutcome[] = [];
  const notices: string[] = [];
  const items = [makeItem(ITEM_ID)];

  const done = runWorklistTui(async () => items, items, loadShortcutConfig(), {
    autoRefresh: false,
    autoSync: false,
    showHelpText: false,
    cwd: tmpDir,
    hostBudgetPrompt: promptHost,
    onCommand: (command: string) => {
      void (async () => {
        const preparation = await prepareInteractiveAgentDispatch(command, {
          confirm: (request) => promptHost.ask(request),
          notify: (message) => notices.push(message),
          readLivePanes: async () => opts.livePanes ?? makeLivePaneList([]),
          claim: (agentCommand) => claims(agentCommand),
          root: tmpDir,
          instanceId: 'test-instance',
          budget: { dir: tmpDir },
        });
        if (!preparation.proceed) return;
        outcomes.push({ spawned: true, override: preparation.override });
      })();
    },
  });
  return { done, claims, outcomes, notices };
}

/** Seed `budget.json` (and optionally the ledger) in the temp machine dir. */
function seedBudget(
  maxImplement: number,
  entries: readonly FakeBudgetEntry[] = [],
): void {
  writeFileSync(
    join(tmpDir, HOST_BUDGET_CONFIG_FILE),
    JSON.stringify({ maxImplement, maxAudit: 1 }),
    'utf8',
  );
  if (entries.length > 0) writeBudgetLedger(tmpDir, entries);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('host-budget over-quota dialog — worklist wiring (WL-0MVXY0Z93002HKCZ)', () => {
  it('below quota: pressing i dispatches with no dialog (AC2)', async () => {
    seedBudget(2);
    const { done, claims, outcomes } = startTui();
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();

    expect(budgetDialogShowing()).toBe(false);
    expect(outcomes).toEqual([{ spawned: true, override: undefined }]);
    expect(claims).toHaveBeenCalledTimes(1);
    expect(readBudgetLedger(tmpDir)?.entries).toHaveLength(1);

    dataHandler?.(Buffer.from('q'));
    await done;
  });

  it('at cap: i opens the bottom-anchored dialog, nothing dispatched yet (AC1/AC5)', async () => {
    seedBudget(1, [makeBudgetEntry({ itemId: 'WL-OTHER-1', paneId: 'pane-1' })]);
    const { done, claims, outcomes } = startTui({ livePanes: makeLivePaneList(['WL-OTHER-1']) });
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();

    const frame = stripAnsi(lastRender());
    expect(frame).toContain('Work Items'); // the list stays visible
    expect(frame).toContain('Host quota exceeded');
    expect(frame).toContain('(1 running, max 1) — over by 1.');
    expect(frame).toContain('[Enter/y] proceed anyway');
    // Nothing has happened yet: the human has not answered.
    expect(outcomes).toEqual([]);
    expect(claims).not.toHaveBeenCalled();
    expect(readBudgetLedger(tmpDir)?.entries).toHaveLength(1);

    dataHandler?.(Buffer.from('\x1b')); // Esc — cancel
    await tick();
    await tick();
    expect(budgetDialogShowing()).toBe(false);

    dataHandler?.(Buffer.from('q'));
    await done;
  });

  it('at cap: y proceeds and the ledger entry records the user override (AC7)', async () => {
    seedBudget(1, [makeBudgetEntry({ itemId: 'WL-OTHER-1', paneId: 'pane-1' })]);
    const { done, claims, outcomes } = startTui({ livePanes: makeLivePaneList(['WL-OTHER-1']) });
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();
    expect(budgetDialogShowing()).toBe(true);

    dataHandler?.(Buffer.from('y'));
    await tick();
    await tick();
    await tick();

    expect(budgetDialogShowing()).toBe(false);
    expect(outcomes).toEqual([{ spawned: true, override: { by: 'user' } }]);
    expect(claims).toHaveBeenCalledTimes(1);
    const entry = readBudgetLedger(tmpDir)?.entries.find(
      (candidate) => candidate.itemId === ITEM_ID,
    );
    expect(entry?.override).toEqual({ by: 'user' });

    dataHandler?.(Buffer.from('q'));
    await done;
  });

  it('at cap: Esc cancels with no dispatch, no claim and no ledger entry (AC6)', async () => {
    seedBudget(1, [makeBudgetEntry({ itemId: 'WL-OTHER-1', paneId: 'pane-1' })]);
    const before = readBudgetLedger(tmpDir);
    const { done, claims, outcomes } = startTui({ livePanes: makeLivePaneList(['WL-OTHER-1']) });
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();
    expect(budgetDialogShowing()).toBe(true);

    dataHandler?.(Buffer.from('\x1b'));
    await tick();
    await tick();
    await tick();

    expect(budgetDialogShowing()).toBe(false);
    expect(outcomes).toEqual([]);
    expect(claims).not.toHaveBeenCalled();
    expect(readBudgetLedger(tmpDir)).toEqual(before);

    dataHandler?.(Buffer.from('q'));
    await done;
  });

  /** AC5: the answer is keyboard-only — no typed confirmation. */
  it('does not need typed text: Enter alone proceeds', async () => {
    seedBudget(1, [makeBudgetEntry({ itemId: 'WL-OTHER-1', paneId: 'pane-1' })]);
    const { done, outcomes } = startTui({ livePanes: makeLivePaneList(['WL-OTHER-1']) });
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();
    await tick();

    expect(outcomes).toEqual([{ spawned: true, override: { by: 'user' } }]);

    dataHandler?.(Buffer.from('q'));
    await done;
  });

  /**
   * AC8 at the wiring level: a corrupt ledger shows the notice and the
   * dispatch still proceeds — a human's shortcut is never blocked by an
   * unreadable ledger.
   */
  it('fails open with a visible notice when the ledger is unreadable (AC8)', async () => {
    writeFileSync(
      join(tmpDir, HOST_BUDGET_CONFIG_FILE),
      JSON.stringify({ maxImplement: 1, maxAudit: 1 }),
      'utf8',
    );
    writeFileSync(join(tmpDir, LEDGER_FILE), '{ corrupt', 'utf8');
    const { done, outcomes, notices } = startTui();
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();

    expect(budgetDialogShowing()).toBe(false);
    expect(outcomes).toEqual([{ spawned: true, override: undefined }]);
    expect(notices).toEqual([
      'Host dispatch budget ledger unreadable — proceeding without the quota check.',
    ]);

    dataHandler?.(Buffer.from('q'));
    await done;
  });
});
