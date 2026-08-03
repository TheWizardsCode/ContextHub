/**
 * packages/herdr/src/worklist-visibility.test.ts — Integration tests for
 * visibility-gated auto-refresh/auto-sync in the worklist TUI
 * (WL-0MSB446N4009FFT5).
 *
 * Verifies that when the herdr pane is hidden (not focused), the
 * auto-refresh and auto-sync timers skip their ticks (zero fetcher /
 * `wl sync` invocations), while visible panes (and the fail-open path)
 * keep the existing cadence. Manual actions are never gated.
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
// Exec-mock helper: dispatch herdr pane-get vs wl CLI calls.
// ---------------------------------------------------------------------------

/**
 * Build an execFileAsync mock that returns a herdr pane-get envelope for
 * `herdr pane get` calls and a benign wl response for everything else.
 *
 * @param paneFocused - The focused flag for `herdr pane get` responses.
 * @param paneGetCalls - Optional array collecting pane-get call counts.
 */
function makeExecMock(
  paneFocused: boolean | undefined,
  paneGetCalls?: { count: number },
): Mock {
  return vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'herdr' && args[0] === 'pane' && args[1] === 'get') {
      if (paneGetCalls) paneGetCalls.count += 1;
      if (paneFocused === undefined) {
        throw new Error('herdr: pane not found');
      }
      return {
        stdout: JSON.stringify({
          id: 'cli:pane:get',
          result: { pane: { focused: paneFocused } },
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

/** Count how many pane-get execs were made through the mock. */
function countPaneGetCalls(mockFn: Mock): number {
  return mockFn.mock.calls.filter(
    (c) => c[0] === 'herdr' && c[1]?.[0] === 'pane' && c[1]?.[1] === 'get',
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
    process.env.HERDR_PANE_ID = 'w1:pCM';
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
    process.env.HERDR_PANE_ID = 'w1:pCM';
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
    process.env.HERDR_PANE_ID = 'w1:pCM';
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

  it('fail-open: no HERDR_PANE_ID env → ticks invoke the fetcher as today (standalone runs unaffected)', async () => {
    vi.useFakeTimers();
    delete process.env.HERDR_PANE_ID;
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
    process.env.HERDR_PANE_ID = 'w1:pCM';
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

  it('manual S (sync) is never gated — works even when the pane is hidden', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock(false) as any);

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

    // Hidden pane + manual S → sync still runs.
    dataHandler?.(Buffer.from('S'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRunSync).toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith('Synced');

    await quit(p);
  });

  it('manual actions are never gated — a fresh TUI load fetches items even while hidden', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
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

  it('PollGate TTL: refresh+sync ticks in one cycle share a single herdr pane get call', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const paneGetCalls = { count: 0 };
    setExecFileAsync(makeExecMock(true, paneGetCalls) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: true,
      syncIntervalMs: 60_000,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    const execsAfterStart = paneGetCalls.count;

    // One refresh cycle (t=30s): exactly one pane-get for the refresh tick.
    await vi.advanceTimersByTimeAsync(30_000);
    const execsAfterRefresh = paneGetCalls.count;
    expect(execsAfterRefresh - execsAfterStart).toBe(1);

    // One sync cycle boundary (t=60s): refresh + sync fire together; the
    // sync tick reuses the refresh tick's cached result (TTL) → no extra exec.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(paneGetCalls.count - execsAfterRefresh).toBe(1);
    expect(paneGetCalls.count - execsAfterStart).toBeLessThanOrEqual(3);

    await quit(p);
  });

  it('header shows the [paused — hidden] indicator when the pane is hidden', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
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
    process.env.HERDR_PANE_ID = 'w1:pCM';
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
    // Fire the refresh tick so the gate runs its pane-get check.
    await vi.advanceTimersByTimeAsync(30_000);

    // The gate's pane-get check must have gone through getExecFileAsync().
    expect(getExecFileAsync).toBeDefined();
    expect(countPaneGetCalls(mockFn)).toBeGreaterThanOrEqual(1);

    await quit(p);
  });
});

// Silence unused-var lint for showToast in the manual-sync assertion import.
void showToast;
