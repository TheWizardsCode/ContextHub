/**
 * packages/herdr/src/worklist-watch.test.ts — Event-driven DB-change watch
 * integration tests (F1 of parent WL-0MV02VA29009WBEN).
 *
 * Proves the wiring that closes the latency gap: after an agent write against
 * the shared `.worklog`, the Herdr pane triggers a refresh via the watch
 * WITHOUT waiting for the 30 s auto-refresh tick. It also covers the
 * fail-open contract (an unavailable watch leaves the 30 s tick as the
 * fallback and never crashes the pane) and watch teardown on pane exit.
 *
 * The write is emulated exactly as the `wl` CLI does it: bump the
 * cross-process state counter (`<cacheDir>/state/<hash>.json`). The REAL
 * `watchDbChanges` primitive is used (the only injected seam is the factory
 * itself, so the test can await the watch being armed).
 *
 * Run: npx vitest run packages/herdr/src/worklist-watch.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsReal from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before worklist.js is imported)
// ---------------------------------------------------------------------------

vi.mock('./auto-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auto-sync.js')>();
  return {
    ...actual,
    runSync: vi.fn().mockResolvedValue({ success: true }),
  };
});

vi.mock('./notify.js', () => ({
  showToast: vi.fn(),
}));

import { runWorklistTui } from './worklist.js';
import { setExecFileAsync, resetExecFileAsync, setWorklogDir, resetWorklogDir } from './fetcher.js';
import type { WorkItem } from './fetcher.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { stateCounterFilePath, watchDbChanges, type DbChangeWatch } from './db-change.js';

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as worklist-inflight.test.ts)
// ---------------------------------------------------------------------------

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];
let tempDirs: string[];

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];
  tempDirs = [];

  // HERDR_TAB_ID unset → `isPaneVisible()` fails open to "visible" with no
  // `herdr` spawn, so the watch path does not need a visibility mock.
  delete process.env.HERDR_TAB_ID;

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
  resetWorklogDir();
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_TAB_ID;
  delete process.env.WL_CACHE_DIR;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    try {
      fsReal.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tempDir(prefix: string): string {
  const dir = fsReal.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Benign exec mock: all fetcher best-effort `wl` calls return an empty set. */
function makeExecMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_bin: string, _args: string[]) => ({
    stdout: JSON.stringify({ workItems: [] }),
    stderr: '',
  }));
}

/** Quit the TUI and await its promise (cleans up timers/listeners). */
async function quit(p: Promise<unknown>): Promise<void> {
  dataHandler?.(Buffer.from('q'));
  await p;
}

/** Poll a predicate until it is true or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Nearest-rank percentile of a numeric sample (same helper as the hydrator suite). */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worklist event-driven DB-change watch (WL-0MV5CBO820024S5A F1)', () => {
  it('a state-counter write triggers a refresh within 2 s — before the 30 s tick (real watch)', async () => {
    setExecFileAsync(makeExecMock() as any);

    const cacheDir = tempDir('wl-watch-cache-');
    const worklogDir = tempDir('wl-watch-log-');
    process.env.WL_CACHE_DIR = cacheDir;
    setWorklogDir(worklogDir);

    const counterFile = stateCounterFilePath(cacheDir, worklogDir);
    fsReal.mkdirSync(path.dirname(counterFile), { recursive: true });

    const fetchTimes: number[] = [];
    const fetcher = vi.fn(async () => {
      fetchTimes.push(Date.now());
      return [];
    });

    // Wrap the REAL watch so the test can await it being armed.
    let armedResolve!: () => void;
    const armed = new Promise<void>((resolve) => {
      armedResolve = resolve;
    });
    const dbWatch = vi.fn((c: string, w: string, onChange: () => void, opts: any): DbChangeWatch => {
      const watcher = watchDbChanges(c, w, onChange, { debounceMs: 30, ...opts });
      armedResolve();
      return watcher;
    });

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      dbWatch,
    });

    await armed;
    // No fetch yet: initialItems=[] skips the startup fetch and the 30 s tick
    // has not fired.
    expect(fetchTimes.length).toBe(0);

    const t0 = Date.now();
    fsReal.writeFileSync(counterFile, JSON.stringify({ state: 1 }), 'utf-8');
    await waitFor(() => fetchTimes.length >= 1, 2000);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(2000);
    // ...and crucially long before the 30 000 ms poll would have fired.
    expect(elapsed).toBeLessThan(30_000);

    await quit(p);
  });

  it('does not refresh for an unrelated write (only the signal file counts)', async () => {
    setExecFileAsync(makeExecMock() as any);

    const cacheDir = tempDir('wl-watch-cache-');
    const worklogDir = tempDir('wl-watch-log-');
    process.env.WL_CACHE_DIR = cacheDir;
    setWorklogDir(worklogDir);

    const counterFile = stateCounterFilePath(cacheDir, worklogDir);
    fsReal.mkdirSync(path.dirname(counterFile), { recursive: true });

    const fetcher = vi.fn(async () => []);
    let armedResolve!: () => void;
    const armed = new Promise<void>((resolve) => {
      armedResolve = resolve;
    });
    const dbWatch = vi.fn((c: string, w: string, onChange: () => void, opts: any): DbChangeWatch => {
      const watcher = watchDbChanges(c, w, onChange, { debounceMs: 30, ...opts });
      armedResolve();
      return watcher;
    });

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      dbWatch,
    });
    await armed;

    // An unrelated file landing in the worklog dir must not trigger a refresh.
    fsReal.writeFileSync(path.join(worklogDir, 'notes.txt'), 'unrelated', 'utf-8');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetcher).not.toHaveBeenCalled();

    await quit(p);
  });

  it('fail-open: a throwing watch factory does not crash the pane; the 30 s tick still refreshes (idle no-spawn preserved)', async () => {
    vi.useFakeTimers();
    setExecFileAsync(makeExecMock() as any);

    process.env.WL_CACHE_DIR = tempDir('wl-watch-cache-');
    setWorklogDir(tempDir('wl-watch-log-'));

    const dbWatch = vi.fn((): DbChangeWatch => {
      throw new Error('fs.watch unavailable');
    });
    const fetcher = vi.fn(async () => []);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      dbWatch,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dbWatch).toHaveBeenCalledTimes(1);
    fetcher.mockClear();

    // First 30 s tick: the tracker's first read has no baseline → refresh runs.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Second 30 s tick: DB unchanged → zero spawns (idle no-op preserved).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await quit(p);
  });

  it('disposes the watch on pane exit', async () => {
    setExecFileAsync(makeExecMock() as any);

    process.env.WL_CACHE_DIR = tempDir('wl-watch-cache-');
    setWorklogDir(tempDir('wl-watch-log-'));

    const dispose = vi.fn();
    let armedResolve!: () => void;
    const armed = new Promise<void>((resolve) => {
      armedResolve = resolve;
    });
    const dbWatch = vi.fn((): DbChangeWatch => {
      armedResolve();
      return { active: true, dispose };
    });

    const p = runWorklistTui(vi.fn(async () => []), [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      dbWatch,
    });
    await armed;
    expect(dbWatch).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();

    await quit(p);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Gated-refresh integration (WL-0MV5CBPI400508MK F3)
// ---------------------------------------------------------------------------
// These tests exercise the WATCH -> gated refresh path with a synchronously
// controllable watch (the real `watchDbChanges` debounce is covered in
// db-change.test.ts). They pin the guarantees the parent epic
// (WL-0MV02VA29009WBEN) requires: the watch feeds the EXISTING gates,
// consumes the DB-change signal so the 30 s tick stays idle, and a burst of
// watch callbacks during an in-flight refresh coalesces into one trailing run.

describe('worklist gated watch refresh (WL-0MV5CBPI400508MK F3)', () => {
  interface ControllableWatch {
    dbWatch: ReturnType<typeof vi.fn>;
    fire: () => void;
    dispose: ReturnType<typeof vi.fn>;
  }

  /** A watch whose onChange is invoked explicitly by the test. */
  function controllableWatch(): ControllableWatch {
    let onChange: (() => void) | null = null;
    const dispose = vi.fn();
    const dbWatch = vi.fn((_cache: string, _dir: string, cb: () => void): DbChangeWatch => {
      onChange = cb;
      return { active: true, dispose };
    });
    return { dbWatch, dispose, fire: () => onChange?.() };
  }

  /** Benign exec mock: `herdr tab get` reports the requested focus state. */
  function makeGateExecMock(tabFocused: boolean): ReturnType<typeof vi.fn> {
    return vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'tab' && args[1] === 'get') {
        return {
          stdout: JSON.stringify({ result: { tab: { focused: tabFocused } } }),
          stderr: '',
        };
      }
      return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
    });
  }

  /**
   * Start the pane with a real worklog/cache dir (so the `DbChangeTracker`
   * is created), an armed controllable watch, and a seeded state counter.
   */
  async function startPane(opts: {
    exec: ReturnType<typeof vi.fn>;
    fetcher: ReturnType<typeof vi.fn>;
    watch: ControllableWatch;
    shortcuts?: Parameters<typeof runWorklistTui>[2];
  }): Promise<{ p: Promise<WorkItem | undefined> }> {
    setExecFileAsync(opts.exec as any);
    const cacheDir = tempDir('wl-watch-cache-');
    const worklogDir = tempDir('wl-watch-log-');
    process.env.WL_CACHE_DIR = cacheDir;
    setWorklogDir(worklogDir);

    const counterFile = stateCounterFilePath(cacheDir, worklogDir);
    fsReal.mkdirSync(path.dirname(counterFile), { recursive: true });
    fsReal.writeFileSync(counterFile, JSON.stringify({ state: 1 }), 'utf-8');

    const p = runWorklistTui(opts.fetcher as any, [], opts.shortcuts, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      dbWatch: opts.watch.dbWatch as any,
    });
    await vi.advanceTimersByTimeAsync(0);
    return { p };
  }

  it('a watch-triggered refresh consumes the DB-change signal, so the next 30 s tick is a no-op', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (): Promise<WorkItem[]> => []);
    const watch = controllableWatch();
    const { p } = await startPane({ exec: makeGateExecMock(true), fetcher, watch });
    expect(watch.dbWatch).toHaveBeenCalledTimes(1);

    // The watch observes an agent write and refreshes immediately (no tick).
    watch.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // The next periodic tick must NOT refresh again: the change was already
    // reflected and its signal consumed (idle zero-spawn, WL-0MSJ1OLTL009N4IQ).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await quit(p);
  });

  it('typing gate: the watch skips refresh while a text-input overlay is open, then resumes', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (): Promise<WorkItem[]> => []);
    const watch = controllableWatch();
    const { p } = await startPane({
      exec: makeGateExecMock(true),
      fetcher,
      watch,
      shortcuts: loadShortcutConfig(),
    });
    fetcher.mockClear();

    // Open the `s` Search form (a text-input overlay).
    dataHandler?.(Buffer.from('s'));
    await vi.advanceTimersByTimeAsync(0);

    // A watch-triggered refresh must be skipped while typing.
    watch.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).not.toHaveBeenCalled();

    // Closing the overlay lets the next tick refresh again.
    dataHandler?.(Buffer.from('\x1b'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalled();

    await quit(p);
  });

  it('visibility gate: the watch skips refresh while the pane tab is hidden', async () => {
    vi.useFakeTimers();
    process.env.HERDR_TAB_ID = 'w1:t11';
    const fetcher = vi.fn(async (): Promise<WorkItem[]> => []);
    const watch = controllableWatch();
    const { p } = await startPane({ exec: makeGateExecMock(false), fetcher, watch });

    watch.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).not.toHaveBeenCalled();

    // The fallback 30 s tick is gated while hidden too (pause-when-hidden).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).not.toHaveBeenCalled();

    await quit(p);
  });

  it('coalesces a burst of watch callbacks during an in-flight refresh into one trailing refresh', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (items: WorkItem[]) => void;
    const deferred = new Promise<WorkItem[]>((resolve) => {
      resolveFetch = resolve;
    });
    const fetcher = vi.fn((): Promise<WorkItem[]> => deferred);
    const watch = controllableWatch();
    const { p } = await startPane({ exec: makeGateExecMock(true), fetcher, watch });
    fetcher.mockClear();

    // First fire starts a refresh that stays in-flight.
    watch.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // A burst of further fires while in-flight must coalesce, not queue.
    for (let i = 0; i < 5; i++) {
      watch.fire();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Exactly ONE trailing refresh runs when the in-flight cycle settles.
    resolveFetch([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await quit(p);
  });

  it('keeps event-loop delay under 100 ms p95 across watch-triggered refreshes (F5)', async () => {
    // Real timers: sample event-loop delay while the REAL pane wiring runs a
    // yielding refresh. The refresh fetcher models the cold default-view
    // refresh — several awaited CLI-shaped steps that each yield — so a
    // synchronous (loop-blocking) refresh would starve the sampler and push
    // the p95 past the 100 ms budget. See parent WL-0MV02VA29009WBEN F5.
    const watch = controllableWatch();
    let fetches = 0;
    const fetcher = vi.fn(async (): Promise<WorkItem[]> => {
      fetches += 1;
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 4));
      return [];
    });

    setExecFileAsync(makeGateExecMock(true) as any);
    const cacheDir = tempDir('wl-watch-cache-');
    const worklogDir = tempDir('wl-watch-log-');
    process.env.WL_CACHE_DIR = cacheDir;
    setWorklogDir(worklogDir);
    const counterFile = stateCounterFilePath(cacheDir, worklogDir);
    fsReal.mkdirSync(path.dirname(counterFile), { recursive: true });
    fsReal.writeFileSync(counterFile, JSON.stringify({ state: 1 }), 'utf-8');

    const p = runWorklistTui(fetcher as any, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      dbWatch: watch.dbWatch as any,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const intervalMs = 5;
    const delays: number[] = [];
    let last = Date.now();
    const sampler = setInterval(() => {
      const tick = Date.now();
      delays.push(Math.max(0, tick - last - intervalMs));
      last = tick;
    }, intervalMs);

    try {
      // Drive several watch-triggered refreshes, each after the previous
      // settles, so the responsiveness guard is exercised repeatedly.
      for (let i = 0; i < 8; i++) {
        watch.fire();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      clearInterval(sampler);
      await quit(p);
    }

    expect(fetches).toBeGreaterThanOrEqual(8);
    expect(percentile(delays, 0.95)).toBeLessThan(100);
  });
});
