/**
 * packages/herdr/src/worklist-visibility.test.ts — Integration tests for
 * visibility-gated auto-refresh/auto-sync in the worklist TUI
 * (WL-0MSB446N4009FFT5).
 *
 * Verifies that when the herdr pane's TAB is hidden (not focused), the
 * auto-refresh and auto-sync timers skip their ticks (zero fetcher /
 * `wl sync` invocations), while visible panes (and the fail-open path)
 * keep the existing cadence. Manual actions are never gated.
 * Visibility signal: tab focus (HERDR_TAB_ID + `herdr tab get`), no
 * pane-focus fallback (WL-0MSJNJPRM009RM35).
 *
 * Run: npx vitest run packages/herdr/src/worklist-visibility.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before worklist.js is imported)
// ---------------------------------------------------------------------------
// Keep the REAL fetcher + visibility modules (so the exec seam and PollGate
// run for real) but avoid real `wl`/`herdr` process spawns by injecting a
// mock execFileAsync via setExecFileAsync() in each test.

vi.mock('./auto-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auto-sync.js')>();
  return {
    ...actual,
    // Keep the real SyncTimer (so timer ticks fire) but stub runSync so no
    // real `wl sync` is spawned and invocations are observable.
    runSync: vi.fn().mockResolvedValue({ success: true }),
  };
});

vi.mock('./notify.js', () => ({
  showToast: vi.fn(),
}));

import { runWorklistTui } from './worklist.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { setExecFileAsync, resetExecFileAsync, getExecFileAsync } from './fetcher.js';
import { runSync } from './auto-sync.js';
import { showToast } from './notify.js';

const mockRunSync = runSync as Mock;
const mockShowToast = showToast as Mock;

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as notify-dispatch.test.ts)
// ---------------------------------------------------------------------------

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];

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
  resetExecFileAsync();
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_BIN_PATH;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Small async tick helper so awaited promises settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

// ---------------------------------------------------------------------------
// Exec-mock helper: dispatch herdr tab-get vs wl CLI calls.
// ---------------------------------------------------------------------------

/**
 * Build an execFileAsync mock that returns a herdr tab-get envelope for
 * `herdr tab get` calls and a benign wl response for everything else.
 *
 * @param tabFocused - The focused flag for `herdr tab get` responses.
 * @param tabGetCalls - Optional array collecting tab-get call counts.
 */
function makeExecMock(
  tabFocused: boolean | undefined,
  tabGetCalls?: { count: number },
): Mock {
  return vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'herdr' && args[0] === 'tab' && args[1] === 'get') {
      if (tabGetCalls) tabGetCalls.count += 1;
      if (tabFocused === undefined) {
        throw new Error('herdr: tab not found');
      }
      return {
        stdout: JSON.stringify({
          id: 'cli:tab:get',
          result: { tab: { focused: tabFocused } },
        }),
        stderr: '',
      };
    }
    // wl CLI responses used by the fetcher during startup/refresh.
    if (args.includes('list') && args.includes('--status')) {
      return { stdout: JSON.stringify({ count: 5 }), stderr: '' };
    }
    return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
  });
}

/** Count how many tab-get execs were made through the mock. */
function countTabGetCalls(mockFn: Mock): number {
  return mockFn.mock.calls.filter(
    (c) => c[0] === 'herdr' && c[1]?.[0] === 'tab' && c[1]?.[1] === 'get',
  ).length;
}

/** Quit the TUI and await its promise (cleans up timers/listeners). */
async function quit(p: Promise<unknown>): Promise<void> {
  dataHandler?.(Buffer.from('q'));
  await p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worklist TUI visibility gating', () => {
  it('hidden pane: refreshTimer ticks do NOT invoke the fetcher (zero wl spawns)', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    setExecFileAsync(makeExecMock(false) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Advance one full refresh cycle while the pane is hidden.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).not.toHaveBeenCalled();

    await quit(p);
  });

  it('hidden pane: syncTimer ticks do NOT invoke runSync or the fetcher', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    setExecFileAsync(makeExecMock(false) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: false,
      autoSync: true,
      syncIntervalMs: 60_000,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    mockRunSync.mockClear();

    // Advance one full sync cycle while hidden: no sync, no refresh.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRunSync).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();

    await quit(p);
  });

  it('visible pane: refreshTimer and syncTimer ticks invoke the fetcher / runSync as today', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    setExecFileAsync(makeExecMock(true) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: true,
      syncIntervalMs: 60_000,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();
    mockRunSync.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1); // refresh tick

    await vi.advanceTimersByTimeAsync(30_000); // t=60s: refresh + sync tick
    // At t=60 the refresh tick (1 call) AND the sync tick's follow-up
    // doRefresh (1 call) both invoke the fetcher — cadence unchanged vs today.
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(mockRunSync).toHaveBeenCalled(); // sync tick at t=60

    await quit(p);
  });

  it('fail-open: no HERDR_TAB_ID env → ticks invoke the fetcher as today (standalone runs unaffected)', async () => {
    vi.useFakeTimers();
    delete process.env.HERDR_TAB_ID;
    setExecFileAsync(makeExecMock(undefined) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await quit(p);
  });

  it('fail-open: herdr CLI error → pane treated as visible, polling continues', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    setExecFileAsync(makeExecMock(undefined) as any); // CLI throws

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await quit(p);
  });

  it('manual S (Ship It dialog) is never gated — works even when the pane is hidden', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    setExecFileAsync(makeExecMock(false) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], loadShortcutConfig(), {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: true,
      syncIntervalMs: 60_000,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();
    mockRunSync.mockClear();

    // Hidden pane + manual S → the Ship It confirmation dialog still opens:
    // manual actions are never visibility-gated (WL-0MSGG5N5Z0074TLY). The
    // manual-sync binding was removed, so NO `wl sync` is spawned.
    dataHandler?.(Buffer.from('S'));
    await vi.advanceTimersByTimeAsync(0);
    const render = writes[writes.length - 1] ?? '';
    expect(render).toContain("Type 'ship' to confirm, Esc to cancel");
    expect(mockRunSync).not.toHaveBeenCalled();

    dataHandler?.(Buffer.from('\x1b')); // cancel the dialog
    await quit(p);
  });

  it('manual actions are never gated — a fresh TUI load fetches items even while hidden', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    setExecFileAsync(makeExecMock(false) as any);

    // Initial data load (which happens regardless of visibility) still works
    // — i.e. a fresh run fetches items even when the pane is hidden.
    const fetcher2 = vi.fn().mockResolvedValue([{ id: 'A', title: 'A', status: 'open' }]);
    const p2 = runWorklistTui(fetcher2, undefined, undefined, {
      autoRefresh: false,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher2).toHaveBeenCalledTimes(1); // initial load never gated

    await quit(p2);
  });

  it('PollGate TTL: refresh+sync ticks in one cycle share a single herdr tab get call', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    const tabGetCalls = { count: 0 };
    setExecFileAsync(makeExecMock(true, tabGetCalls) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: true,
      syncIntervalMs: 60_000,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    const execsAfterStart = tabGetCalls.count;

    // One refresh cycle (t=30s): exactly one tab-get for the refresh tick.
    await vi.advanceTimersByTimeAsync(30_000);
    const execsAfterRefresh = tabGetCalls.count;
    expect(execsAfterRefresh - execsAfterStart).toBe(1);

    // One sync cycle boundary (t=60s): refresh + sync fire together; the
    // sync tick reuses the refresh tick's cached result (TTL) → no extra exec.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tabGetCalls.count - execsAfterRefresh).toBe(1);
    expect(tabGetCalls.count - execsAfterStart).toBeLessThanOrEqual(3);

    await quit(p);
  });

  it('header shows the [paused — hidden] indicator when the pane is hidden', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    setExecFileAsync(makeExecMock(false) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Force a render after a hidden-gate check, then inspect the output.
    await vi.advanceTimersByTimeAsync(30_000);
    dataHandler?.(Buffer.from('j')); // navigation triggers render
    await vi.advanceTimersByTimeAsync(0);

    // Search the RAW output (the indicator is wrapped in ANSI colour codes,
    // so stripping ANSI would erase the marker text entirely).
    const raw = writes.join('');
    expect(raw).toContain('[paused — hidden]');

    await quit(p);
  });
});

describe('worklist TUI visibility gating — getExecFileAsync seam', () => {
  it('visibility checks go through the same injectable exec seam as the fetcher', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    const mockFn = makeExecMock(false);
    setExecFileAsync(mockFn as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    // Fire the refresh tick so the gate runs its tab-get check.
    await vi.advanceTimersByTimeAsync(30_000);

    // The gate's tab-get check must have gone through getExecFileAsync().
    expect(getExecFileAsync).toBeDefined();
    expect(countTabGetCalls(mockFn)).toBeGreaterThanOrEqual(1);

    await quit(p);
  });
});

describe('worklist TUI visibility gating — hidden → visible transition (WL-0MSBVS4AS006ZQEZ)', () => {
  /**
   * Exec mock with a dynamic focused flag (read per tab-get call), so a
   * test can flip the tab from hidden to visible mid-run.
   */
  function makeDynamicExecMock(getFocused: () => boolean | undefined, tabGetCalls?: { count: number }): Mock {
    return vi.fn(async (bin: string, args: string[]) => {
      if (bin === 'herdr' && args[0] === 'tab' && args[1] === 'get') {
        if (tabGetCalls) tabGetCalls.count += 1;
        const focused = getFocused();
        if (focused === undefined) {
          throw new Error('herdr: tab not found');
        }
        return {
          stdout: JSON.stringify({ id: 'cli:tab:get', result: { tab: { focused } } }),
          stderr: '',
        };
      }
      if (args.includes('list') && args.includes('--status')) {
        return { stdout: JSON.stringify({ count: 5 }), stderr: '' };
      }
      return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
    });
  }

  it('hidden → visible transition triggers an immediate fetch outside the normal tick', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    let tabFocused = false;
    setExecFileAsync(makeDynamicExecMock(() => tabFocused) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // First refresh tick while hidden: skipped, tab pauses.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).not.toHaveBeenCalled();

    // Tab regains focus → the resume poll catches the transition and the
    // list re-fetches immediately (t=32s, outside the 30s tick at t=60s).
    tabFocused = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await quit(p);
  });

  it('while hidden the resume poll spawns only herdr tab get — never the fetcher', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    const tabGetCalls = { count: 0 };
    setExecFileAsync(makeDynamicExecMock(() => false, tabGetCalls) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // Hidden tick starts the resume poll; run several polls while still hidden.
    await vi.advanceTimersByTimeAsync(30_000);
    const execsAfterFirstTick = tabGetCalls.count;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetcher).not.toHaveBeenCalled();
    expect(tabGetCalls.count).toBeGreaterThan(execsAfterFirstTick); // tab-get polls only

    await quit(p);
  });

  it('after the immediate transition refresh, refreshes follow the normal refreshIntervalMs cadence', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    let tabFocused = false;
    setExecFileAsync(makeDynamicExecMock(() => tabFocused) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // Two hidden refresh cycles (t=30s, t=60s): no fetches.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).not.toHaveBeenCalled();

    // Become visible: immediate fetch via the resume poll (t=62s).
    tabFocused = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // No fetches until the next regular tick (t=90s), then every 30s.
    await vi.advanceTimersByTimeAsync(27_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); // t=90s: regular tick
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000); // t=120s: regular tick
    expect(fetcher).toHaveBeenCalledTimes(3);

    await quit(p);
  });

  it('the [paused — hidden] header indicator clears once the transition refresh completes', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    let tabFocused = false;
    setExecFileAsync(makeDynamicExecMock(() => tabFocused) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Hidden tick pauses the tab; a navigation render shows the indicator.
    await vi.advanceTimersByTimeAsync(30_000);
    writes.length = 0;
    dataHandler?.(Buffer.from('j'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.join('')).toContain('[paused — hidden]');

    // Regain focus: the immediate transition refresh re-renders without it.
    tabFocused = true;
    writes.length = 0;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(writes.join('')).not.toContain('[paused — hidden]');

    await quit(p);
  });
});

// Silence unused-var lint for showToast in the manual-sync assertion import.
void showToast;

// ── Event-driven focus/visibility path (WL-0MSHB7DHO004RHBJ F3) ───────
// A pane_focused event for the CURRENT pane updates the visibility gate
// directly (no `herdr tab get` exec) and triggers an immediate refresh on
// the hidden → visible transition — replacing the 2s resume-poll.

describe('worklist — event-driven focus/visibility (WL-0MSHB7DHO004RHBJ)', () => {
  it('a pane_focused event for the current pane triggers an immediate refresh with no tab-get exec', async () => {
    const { createMockSocket } = await import('./test-utils/mock-herdr-socket.js');
    const { HerdrEventSubscriber } = await import('./events.js');
    const mockServer = await createMockSocket();
    const subscriber = new HerdrEventSubscriber({ socketPath: mockServer.getAddress(), callbacks: {} });
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock(true) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      subscriber,
    });
    await new Promise((r) => setTimeout(r, 100));
    const client = mockServer.getFirstClient();
    expect(client).toBeDefined();
    fetcher.mockClear();

    // A pane_focused event for the current pane triggers doRefresh(true).
    client!.pushEvent({ event: 'pane_focused', data: { pane_id: 'w1:pCM', focused: true } });
    await new Promise((r) => setTimeout(r, 100));
    expect(fetcher).toHaveBeenCalled();

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
  });

  it('a pane_focused(unfocused) event for the current pane sets the paused indicator without a tab-get exec', async () => {
    const { createMockSocket } = await import('./test-utils/mock-herdr-socket.js');
    const { HerdrEventSubscriber } = await import('./events.js');
    const mockServer = await createMockSocket();
    const subscriber = new HerdrEventSubscriber({ socketPath: mockServer.getAddress(), callbacks: {} });
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const tabGetCalls = { count: 0 };
    setExecFileAsync(makeExecMock(true, tabGetCalls) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      subscriber,
    });
    await new Promise((r) => setTimeout(r, 100));
    const client = mockServer.getFirstClient();

    // Unfocus event → pane marked hidden immediately without a tab-get exec.
    const before = tabGetCalls.count;
    client!.pushEvent({ event: 'pane_focused', data: { pane_id: 'w1:pCM', focused: false } });
    await new Promise((r) => setTimeout(r, 100));
    writes.length = 0;
    dataHandler?.(Buffer.from('j')); // navigation re-renders the header
    await new Promise((r) => setTimeout(r, 20));
    expect(writes.join('')).toContain('[paused — hidden]');
    // No tab-get exec happened for this transition.
    expect(tabGetCalls.count).toBe(before);

    await subscriber.close();
    await mockServer.stop();
    await quit(p);
  });

  it('fail-open: unreachable socket keeps today\'s polling cadence (no crash, fetcher ticks as before)', async () => {
    const { HerdrEventSubscriber } = await import('./events.js');
    const subscriber = new HerdrEventSubscriber({
      socketPath: '/tmp/herdr-unreachable-test-socket-never-exists.sock',
      callbacks: {},
      maxReconnectAttempts: 0,
    });
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    process.env.HERDR_TAB_ID = 'w1:t11';
    setExecFileAsync(makeExecMock(true) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      subscriber,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // The events path is unavailable → the polling cadence is preserved.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // The resume-poll fallback is active while events are unavailable: a
    // hidden → visible transition is still caught by the 2s resume-poll.
    await subscriber.close();
    await quit(p);
  });
});
