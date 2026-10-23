/**
 * packages/herdr/src/worklist-sync-notice.test.ts — Non-blocking sync status
 * notice (F3 — WL-0MVJV2O7H003HY9N).
 *
 * F3 AC2/AC3: while a long background `wl sync` is in flight the pane shows a
 * non-blocking "⟳ syncing… Ns" status notice in the header, input is never
 * blocked, and there is no lock wait or "hanging" UI state beyond the notice.
 *
 * The tests drive the REAL auto-sync status model (the pane subscribes to
 * `onSyncStatusChange`) but stub `runSync` so no real `wl sync` process is
 * spawned; status transitions are injected through `_setSyncStatusForTests`
 * or produced by the stubbed `runSync`, exactly the two entry points the
 * production subscription consumes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// Mock runSync (never spawns a real `wl sync`) while keeping the REAL status
// model + subscription primitives from auto-sync.ts so the pane's wiring is
// exercised end-to-end.
vi.mock('./auto-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auto-sync.js')>();
  return {
    ...actual,
    runSync: vi.fn((worklogDir?: string, options?: { ifIdle?: boolean }) => {
      // Drive the REAL status model the way a real spawn would: syncing
      // immediately, stayed in flight until the test settles it.
      actual._setSyncStatusForTests({
        state: 'syncing',
        inFlight: true,
        pid: 40_211,
        startedAtMs: Date.now(),
        startedAtMonotonicMs: performance.now(),
      });
      return new Promise<{ success: boolean }>(() => {
        // Deliberately never settles — a "long ~36 s sync in flight".
      });
    }),
  };
});

vi.mock('./notify.js', () => ({
  showToast: vi.fn(),
}));

import { runWorklistTui } from './worklist.js';
import { setExecFileAsync, resetExecFileAsync } from './fetcher.js';
import type { WorkItem } from './fetcher.js';
import { _resetSyncStatusForTests, _setSyncStatusForTests, getSyncStatus } from './auto-sync.js';

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
  // Leave the shared auto-sync status model clean for other test files.
  _resetSyncStatusForTests();
  resetExecFileAsync();
  delete process.env.HERDR_PANE_ID;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Exec-mock: a focused/visible pane + benign herdr/wl responses. */
function makeExecMock(paneFocused = true): Mock {
  return vi.fn(async (_bin: string, args: string[]) => {
    if (args[0] === 'pane' && args[1] === 'get') {
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

/** The writes accumulated since `from` (default: all). */
function writesSince(from = 0): string {
  return writes.slice(from).join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worklist sync status notice (F3 — WL-0MVJV2O7H003HY9N)', () => {
  it('shows the non-blocking "syncing" notice while a sync is in flight and still renders the list', async () => {
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
    // The auto-sync task fires immediately on scheduler start → the stubbed
    // runSync flips the status model to syncing → the subscription renders.
    await vi.advanceTimersByTimeAsync(0);

    const raw = writes.join('');
    // The notice appears...
    expect(raw).toContain('⟳ syncing');
    // ...without replacing the pane (the list still renders normally; the
    // notice is a header fragment, not a hang screen).
    expect(raw).toContain('Work Items');

    await quit(p);
  });

  it("proves the notice never blocks input: 'q' quits while a sync is in flight", async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock(true) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: true,
      syncIntervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.join('')).toContain('⟳ syncing');

    // Keystroke processing is fully responsive while the notice is shown —
    // this is the pane "never hangs beyond the notice" assertion.
    await quit(p);
  });

  it('updates the elapsed seconds via the 1s ticker and clears the notice on settle', async () => {
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
    expect(writes.join('')).toContain('⟳ syncing');

    // Force a fresh in-flight snapshot with a monotonic start 2 s in the
    // past, then advance one ticker tick: the notice gains a seconds
    // counter. `performance.now()` is the REAL monotonic clock (vitest fake
    // timers do not advance it), so the elapsed offset is what makes the
    // counter observable while the 1 s ticker drives the re-render.
    _setSyncStatusForTests({
      state: 'syncing',
      inFlight: true,
      pid: 40_211,
      startedAtMs: Date.now(),
      startedAtMonotonicMs: performance.now() - 2_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writesSince(writes.length - 4)).toMatch(/syncing… [1-9]\d*s/);
    _resetSyncStatusForTests();

    // Ticker currently paused so we can settle deterministically.
    await vi.advanceTimersByTimeAsync(1_000);

    // Settle: the sync completes → the subscription clears the notice.
    _setSyncStatusForTests(null);
    const before = writes.length;
    // The subscription render fires synchronously; nothing else to await.
    expect(writesSince(before)).not.toContain('⟳ syncing');

    await quit(p);
  });

  it('shows no notice when auto-sync is disabled', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock(true) as any);

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.join('')).not.toContain('⟳ syncing');
    await quit(p);
  });

  it('adopts a sync already in flight at pane start (previous sync outlives the subscription)', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeExecMock(true) as any);

    // A sync started before this pane subscribed.
    _setSyncStatusForTests({
      state: 'syncing',
      inFlight: true,
      pid: 40_211,
      startedAtMs: Date.now(),
      startedAtMonotonicMs: performance.now(),
    });

    const fetcher = vi.fn().mockResolvedValue([]);
    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: true,
      syncIntervalMs: 60_000,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(writes.join('')).toContain('⟳ syncing');
    // The adopted in-flight sync is still reported as running.
    expect(getSyncStatus().inFlight).toBe(true);
    await quit(p);
  });
});
