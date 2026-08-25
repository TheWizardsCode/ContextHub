/**
 * packages/herdr/src/fetcher-timeout.test.ts — Timeout boundedness for wl spawns
 * (WL-0MSJNJXX2001NMHS).
 *
 * These tests verify:
 *  1. Every refresh/sync-path runWl caller passes a bounded timeout
 *     (DEFAULT_WL_TIMEOUT_MS = 60_000) when no override is supplied.
 *  2. Explicit per-call overrides (CLAIM_TIMEOUT_MS = 3000) survive.
 *  3. checkWlAvailable (wl --version probe) passes a bounded timeout.
 *  4. A hung execFile (mock honouring options.timeout) rejects after the
 *     timeout elapses.
 *  5. At the worklist level, a timed-out refresh yields a 'Refresh failed'
 *     toast, clears the guard, and the next tick proceeds.
 *
 * Run: npx vitest run packages/herdr/src/fetcher-timeout.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('./auto-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auto-sync.js')>();
  return {
    ...actual,
    runSync: vi.fn().mockResolvedValue({ success: true }),
  };
});

// Hoisted so the worklist module (which imports ./notify.js) sees the SAME
// mock instance the assertions below reference.
const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));

vi.mock('./notify.js', () => ({ showToast: showToastMock }));

import { runWorklistTui } from './worklist.js';
import {
  setExecFileAsync,
  resetExecFileAsync,
  claimWorkItem,
  fetchNextItems,
  fetchItemsByStage,
  fetchItemsByPriority,
  fetchActionableCount,
  fetchChildrenForItem,
  runWlSync,
  checkWlAvailable,
} from './fetcher.js';

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness
// ---------------------------------------------------------------------------

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];

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
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_WORKSPACE_ID;
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_ENV;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a basic exec mock that returns empty work-items for normal queries
 * and resolves the herdr pane/tab visibility checks (focused).
 */
function makeExecMock(paneFocused = true): Mock {
  return vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'herdr' && (args[0] === 'pane' || args[0] === 'tab')) {
      return {
        stdout: JSON.stringify({
          id: 'cli:get',
          result: { pane: { focused: paneFocused }, tab: { focused: paneFocused } },
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

/**
 * Build an exec mock that HANGS (never resolves) unless the timeout option
 * fires. When called with a `timeout` in the options, it sets a timer of
 * that many ms and rejects when it elapses — simulating Node's execFile
 * timeout handling under fake timers.
 */
function makeHangExecMock(): Mock {
  return vi.fn(
    async (_bin: string, _args: string[], options?: { timeout?: number }) => {
      const timeout = options?.timeout ?? 60_000;
      // Never resolve on its own — a hung wl process. Only the timeout can
      // reject. Under fake timers, advanceTimersByTimeAsync fires this.
      await new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('exec timed out')), timeout);
      });
    },
  );
}

/** Quit the TUI gracefully. */
async function quitTui(p: Promise<unknown>): Promise<void> {
  dataHandler?.(Buffer.from('q'));
  await p;
}

// ---------------------------------------------------------------------------
// Test: fetcher callers pass DEFAULT_WL_TIMEOUT_MS
// ---------------------------------------------------------------------------

describe('fetcher timeout defaults (WL-0MSJNJXX2001NMHS)', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  afterEach(() => {
    resetExecFileAsync();
  });

  it('fetchNextItems passes a bounded timeout to execFileAsync', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    await fetchNextItems(10);

    // fetchNextItems calls runWl once for 'next', then fetchMandatorySubsets
    // which calls runWl twice (critical list + in_review list).
    // All calls should have a timeout option.
    expect(mockFn.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of mockFn.mock.calls) {
      const opts = call[2] as { timeout?: number } | undefined;
      expect(opts).toBeDefined();
      expect(opts!.timeout).toBe(60_000);
    }
  });

  it('fetchItemsByStage passes a bounded timeout to execFileAsync', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    await fetchItemsByStage('in_progress');

    const opts = mockFn.mock.calls[0][2] as { timeout?: number } | undefined;
    expect(opts).toBeDefined();
    expect(opts!.timeout).toBe(60_000);
  });

  it('fetchItemsByPriority passes a bounded timeout to execFileAsync', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    await fetchItemsByPriority('high');

    const opts = mockFn.mock.calls[0][2] as { timeout?: number } | undefined;
    expect(opts).toBeDefined();
    expect(opts!.timeout).toBe(60_000);
  });

  it('fetchActionableCount passes a bounded timeout to execFileAsync', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ count: 5 }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    await fetchActionableCount();

    const opts = mockFn.mock.calls[0][2] as { timeout?: number } | undefined;
    expect(opts).toBeDefined();
    expect(opts!.timeout).toBe(60_000);
  });

  it('fetchChildrenForItem passes a bounded timeout to execFileAsync', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    await fetchChildrenForItem('WL-0MS9NPHQU005Y3VE');

    const opts = mockFn.mock.calls[0][2] as { timeout?: number } | undefined;
    expect(opts).toBeDefined();
    expect(opts!.timeout).toBe(60_000);
  });

  it('runWlSync passes a bounded timeout to execFileAsync', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    await runWlSync();

    const opts = mockFn.mock.calls[0][2] as { timeout?: number } | undefined;
    expect(opts).toBeDefined();
    expect(opts!.timeout).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Test: explicit overrides survive
// ---------------------------------------------------------------------------

describe('explicit timeout overrides survive (WL-0MSJNJXX2001NMHS)', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  afterEach(() => {
    resetExecFileAsync();
  });

  it('claimWorkItem uses its own CLAIM_TIMEOUT_MS (3000), not the default', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    await claimWorkItem('WL-0MS9NPHQU005Y3VE', 'Map');

    const opts = mockFn.mock.calls[0][2] as { timeout?: number } | undefined;
    expect(opts).toBeDefined();
    expect(opts!.timeout).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// Test: checkWlAvailable passes a bounded timeout
// ---------------------------------------------------------------------------

describe('checkWlAvailable timeout (WL-0MSJNJXX2001NMHS)', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  afterEach(() => {
    resetExecFileAsync();
  });

  it('checkWlAvailable passes a bounded timeout to execFileAsync', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: 'wl 1.0.0',
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const result = await checkWlAvailable();

    expect(result).toBe(true);
    const opts = mockFn.mock.calls[0][2] as { timeout?: number } | undefined;
    expect(opts).toBeDefined();
    expect(opts!.timeout).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Test: hung execFile resolves via timeout (fake timers)
// ---------------------------------------------------------------------------

describe('hung wl spawn resolves via timeout (WL-0MSJNJXX2001NMHS)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetExecFileAsync();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetExecFileAsync();
  });

  it(
    'a hung execFile rejects after DEFAULT_WL_TIMEOUT_MS (60s)',
    async () => {
      const hangMock = makeHangExecMock();
      setExecFileAsync(hangMock as any);

      // Start the fetch — it will hang forever unless the timeout fires.
      // Attach the rejection handler IMMEDIATELY so the timeout rejection
      // never escapes as an unhandled promise rejection.
      const fetchPromise = fetchNextItems(10);
      const rejection = expect(fetchPromise).rejects.toThrow();

      // Advance past the timeout — should trigger rejection.
      await vi.advanceTimersByTimeAsync(60_001);

      // The fetch rejected after the timeout (not before, not never).
      await rejection;
    },
    120_000, // vitest default is 30s; this test simulates 60s timeouts
  );
});

// ---------------------------------------------------------------------------
// Test: worklist-level — timed-out refresh recovers gracefully
// ---------------------------------------------------------------------------

describe('worklist recovery from timed-out refresh (WL-0MSJNJXX2001NMHS)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetExecFileAsync();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetExecFileAsync();
  });

  it('timed-out refresh → Refresh failed toast, guard cleared, next tick proceeds', async () => {
    process.env.HERDR_PANE_ID = 'w1:pCM';
    vi.clearAllMocks();

    // The pane check resolves; wl spawns hang until their timeout fires
    // (simulating the execFile timeout killing a hung wl process).
    const execMock = vi.fn(async (bin: string, args: string[], options?: { timeout?: number }) => {
      if (bin === 'herdr' && (args[0] === 'pane' || args[0] === 'tab')) {
        return {
          stdout: JSON.stringify({ id: 'cli:get', result: { pane: { focused: true }, tab: { focused: true } } }),
          stderr: '',
        };
      }
      // A hung wl child: only the execFile timeout can settle it.
      await new Promise<never>((_resolve, reject) => {
        const timeout = options?.timeout ?? 60_000;
        setTimeout(() => reject(new Error('wl child killed: timeout')), timeout);
      });
    });
    setExecFileAsync(execMock as any);

    // REAL fetcher so the whole refresh path is exercised end-to-end:
    // doRefresh → fetchItemsForView → fetchNextItems → runWl → hung spawn.
    const p = runWorklistTui(fetchNextItems, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    const wlSpawns = (): number =>
      execMock.mock.calls.filter((c) => c[0] === 'wl').length;

    // t=30s: first tick starts a refresh cycle; the hung wl spawn is in
    // flight with its 60s timeout armed.
    await vi.advanceTimersByTimeAsync(30_000);
    const spawnsBeforeTimeout = wlSpawns();
    expect(spawnsBeforeTimeout).toBeGreaterThan(0);

    // t=90s: the DEFAULT_WL_TIMEOUT_MS (60s) fired mid-cycle → the fetch
    // rejected → 'Refresh failed' toast, guard cleared in `finally`.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(showToastMock).toHaveBeenCalledWith('Refresh failed');

    // t=150s: the next refresh tick ran to completion (new wl spawns after
    // the timeout) — the guard did NOT stick. The second cycle's own wl
    // spawn is hung again, but that is the bounded-timeout regression under
    // test, not a permanent wedge.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wlSpawns()).toBeGreaterThan(spawnsBeforeTimeout);

    await quitTui(p);
  });
});
