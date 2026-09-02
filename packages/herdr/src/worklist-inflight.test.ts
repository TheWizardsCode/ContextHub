/**
 * packages/herdr/src/worklist-inflight.test.ts — Tests for the doRefresh
 * in-flight (single-flight) guard (WL-0MSBVYBMD004007C).
 *
 * `doRefresh` spawns the fetcher (which runs the 4 wl processes: `wl next`,
 * critical list, in-review list, open/in-progress/blocked list). Without a
 * guard, a refresh cycle still awaiting its wl calls when the next interval
 * tick fires causes overlapping cycles that pile up wl processes under load.
 *
 * These tests verify that:
 *  1. Two rapid consecutive refresh triggers produce at most one in-flight
 *     fetcher invocation (single-flight behavior) — the second tick is
 *     skipped while the first refresh cycle is still pending.
 *  2. The skipped tick does NOT leave the list stale forever: once the
 *     in-flight cycle completes, the next tick refreshes again (cadence
 *     resumes), and the guard is cleared even when the fetcher rejects.
 *
 * Run: npx vitest run packages/herdr/src/worklist-inflight.test.ts
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
    // Keep the real SyncTimer but stub runSync so no real `wl sync` spawns.
    runSync: vi.fn().mockResolvedValue({ success: true }),
  };
});

vi.mock('./notify.js', () => ({
  showToast: vi.fn(),
}));

import { runWorklistTui } from './worklist.js';
import { setExecFileAsync, resetExecFileAsync } from './fetcher.js';
import type { WorkItem } from './fetcher.js';

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as worklist-visibility.test.ts)
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Exec-mock helper: a visible pane (focused=true) so auto-refresh ticks fire
 * (the guard under test lives inside the refresh path, not the gate), plus
 * benign wl responses for the fetcher's other best-effort calls.
 */
function makeExecMock(paneFocused: boolean): Mock {
  return vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'herdr' && args[0] === 'pane' && args[1] === 'get') {
      return {
        stdout: JSON.stringify({
          id: 'cli:pane:get',
          result: { pane: { focused: paneFocused } },
        }),
        stderr: '',
      };
    }
    if (args.includes('list') && args.includes('--status')) {
      return { stdout: JSON.stringify({ count: 5 }), stderr: '' };
    }
    return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
  });
}

/** Quit the TUI and await its promise (cleans up timers/listeners). */
async function quit(p: Promise<unknown>): Promise<void> {
  dataHandler?.(Buffer.from('q'));
  await p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worklist doRefresh in-flight guard (WL-0MSBVYBMD004007C)', () => {
  it('two rapid refresh ticks while a refresh is pending → at most one in-flight fetcher invocation (single-flight)', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock(true) as any);

    // Deferred fetcher: the first refresh cycle stays pending until the test
    // resolves it, so the second refresh tick fires while it is still
    // awaiting its "wl" calls.
    let resolveFetch!: (items: WorkItem[]) => void;
    const fetchPromise = new Promise<WorkItem[]>((r) => { resolveFetch = r; });
    const fetcher = vi.fn(() => fetchPromise);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // t=30s: first tick starts a refresh cycle; fetcher called once.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // t=60s: second tick while the first cycle is STILL pending — the guard
    // must skip it, so no second fetcher (wl spawn set) is created.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Resolve the in-flight cycle. With the trailing refresh fix
    // (WL-0MTIB7JAN004MQ8N), the pending second tick now fires as a
    // trailing refresh immediately on resolve (fetches twice); then the
    // t=90s tick adds one more fetch (total 3).
    resolveFetch([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(3);

    await quit(p);
  });

  it('guard is cleared even when the fetcher rejects (finally) — cadence resumes', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock(true) as any);

    let fail = true;
    const fetcher = vi.fn(async (): Promise<WorkItem[]> => {
      if (fail) throw new Error('wl failed');
      return [];
    });

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // First tick: fetcher rejects → 'Refresh failed' toast, guard cleared
    // in `finally` so it can never stick.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Next tick succeeds — proves the guard did not stick after the error.
    fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await quit(p);
  });
});

// ---------------------------------------------------------------------------
// Coalescing / trailing refresh tests (WL-0MTIB7JAN004MQ8N)
// ---------------------------------------------------------------------------
// Trailing refresh: when a refresh is in-flight and a second refresh is
// requested (e.g. a background `u p c` / `wl update` exiting while the
// initial immediate fetch is still awaiting), the second request is not
// silently dropped — it runs as a trailing refresh after the first completes.

describe('worklist doRefresh trailing/coalescing refresh (WL-0MTIB7JAN004MQ8N)', () => {
  it('two ticks while fetcher is pending → trailing refresh runs after in-flight completes (not dropped)', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock(true) as any);

    // Deferred fetcher: in-flight until test resolves it — so the second
    // tick (the onExit) fires while the fetch is still pending.
    let resolveFetch!: (items: WorkItem[]) => void;
    const deferredPromise = new Promise<WorkItem[]>((r) => { resolveFetch = r; });
    const fetcher = vi.fn(() => deferredPromise);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // First tick: starts a fetch (in-flight)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Second tick while fetcher is still pending: the trailing refresh is
    // not dropped — the pending flag is set.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Resolve the pending fetch — the trailing refresh now fires.
    resolveFetch([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await quit(p);
  });

  it('at-most-one trailing — three rapid deferred ticks while pending coalesce into one trailing', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock(true) as any);

    let resolveFetch!: (items: WorkItem[]) => void;
    const deferredPromise = new Promise<WorkItem[]>((r) => { resolveFetch = r; });
    const fetcher = vi.fn(() => deferredPromise);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // First tick: starts a fetch
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Three more ticks while still pending — pending flag stays true, at most
    // one trailing runs, not three.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Resolve — exactly ONE trailing refresh
    resolveFetch([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await quit(p);
  });

  it('no trailing when no tick fired — no extra fetch after resolve when pending flag was never set', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock(true) as any);

    let resolveFetch!: (items: WorkItem[]) => void;
    const deferredPromise = new Promise<WorkItem[]>((r) => { resolveFetch = r; });
    const fetcher = vi.fn(() => deferredPromise);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // First tick: starts a fetch; no second tick while pending
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // No extra tick — pending stays false
    resolveFetch([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await quit(p);
  });
});
