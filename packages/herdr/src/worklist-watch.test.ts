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
