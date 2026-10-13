/**
 * Unit tests for db-change.ts — DB-change signal module (WL-0MTBWK01P000QO90 F1)
 *
 * Tests the DbChangeTracker's contract:
 *  - resolveCacheDir() precedence (WL_CACHE_DIR > XDG_CACHE_HOME > ~/.cache/wl)
 *  - readStateCounter() reads the per-worklog-dir counter file
 *  - DbChangeTracker first-call returns changed=true; unchanged counter returns false
 *  - Fail-open: read errors return changed=true
 *
 * Run: npx vitest run packages/herdr/src/db-change.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Partial mock: readFileSync is mocked, but mkdirSync/mkdtempSync are real
// ---------------------------------------------------------------------------

let mockFileSyncContents: Record<string, string> = {};
let mockFileSyncThrowFor: string | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((filePath: string): string => {
      if (mockFileSyncThrowFor === filePath) {
        throw new Error('EACCES: permission denied');
      }
      return mockFileSyncContents[filePath] ?? '';
    }),
  };
});

// ---------------------------------------------------------------------------
// Import the module under test (after fs mock)
// ---------------------------------------------------------------------------

import {
  resolveCacheDir,
  readStateCounter,
  DbChangeTracker,
  stateCounterFilePath,
  watchDbChanges,
  type DbChangeWatch,
} from './db-change.js';

// Re-import fs for real mkdtempSync
import * as fsReal from 'node:fs';

function stateCounterFile(cacheDir: string, worklogDir: string): string {
  const hash = createHash('sha256').update(path.resolve(worklogDir)).digest('hex');
  return path.join(cacheDir, 'state', `${hash}.json`);
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fsReal.mkdtempSync(path.join(os.tmpdir(), 'db-change-test-'));
}

beforeEach(() => {
  mockFileSyncContents = {};
  mockFileSyncThrowFor = null;
  vi.clearAllMocks();
});

afterEach(() => {
  // Clean up env vars
  delete process.env.WL_CACHE_DIR;
  delete process.env.XDG_CACHE_HOME;
});

// ---------------------------------------------------------------------------
// resolveCacheDir
// ---------------------------------------------------------------------------

describe('resolveCacheDir', () => {
  it('returns WL_CACHE_DIR when set', () => {
    process.env.WL_CACHE_DIR = '/custom/cache';
    expect(resolveCacheDir()).toBe('/custom/cache');
  });

  it('falls back to $XDG_CACHE_HOME/wl when WL_CACHE_DIR is not set', () => {
    process.env.XDG_CACHE_HOME = '/custom/xdg';
    expect(resolveCacheDir()).toBe('/custom/xdg/wl');
  });

  it('falls back to ~/.cache/wl when neither env var is set', () => {
    // Ensure both are unset
    delete process.env.WL_CACHE_DIR;
    delete process.env.XDG_CACHE_HOME;
    const home = os.homedir();
    expect(resolveCacheDir()).toBe(path.join(home, '.cache', 'wl'));
  });

  it('WL_CACHE_DIR takes precedence over XDG_CACHE_HOME', () => {
    process.env.WL_CACHE_DIR = '/override';
    process.env.XDG_CACHE_HOME = '/xdg';
    expect(resolveCacheDir()).toBe('/override');
  });
});

// ---------------------------------------------------------------------------
// readStateCounter
// ---------------------------------------------------------------------------

describe('readStateCounter', () => {
  it('reads a valid counter from the cache file', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 42 });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(42);
  });

  it('returns 0 when the file does not exist', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });

  it('returns 0 when the JSON is unparseable', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = 'not json';
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });

  it('returns 0 when the JSON has no state field', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ foo: 'bar' });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });

  it('returns 0 when the state value is not a finite number', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 'abc' });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);

    mockFileSyncContents[file] = JSON.stringify({ state: NaN });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);

    mockFileSyncContents[file] = JSON.stringify({ state: Infinity });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });

  it('returns 0 for a negative state value', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: -1 });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });

  it('returns the floor for a fractional state value', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 42.9 });
    expect(readStateCounter(cacheDir, worklogDir)).toBe(42);
  });

  it('returns 0 when the file cannot be read (fail-open at tracker level)', () => {
    const cacheDir = tempDir();
    const worklogDir = '/some/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncThrowFor = file;
    expect(readStateCounter(cacheDir, worklogDir)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DbChangeTracker
// ---------------------------------------------------------------------------

describe('DbChangeTracker', () => {
  it('first call returns changed=true when no prior counter exists', () => {
    const tracker = new DbChangeTracker('/test/cache', '/test/worklog');
    expect(tracker.dbChanged()).toBe(true);
  });

  it('returns changed=false when the counter has not changed since the first call', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 10 });

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true); // first call: no prior value
    expect(tracker.dbChanged()).toBe(false); // second call: counter still 10
  });

  it('returns changed=true when the counter has been bumped between calls', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 10 });

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true);

    // Simulate the counter being bumped externally
    mockFileSyncContents[file] = JSON.stringify({ state: 11 });
    expect(tracker.dbChanged()).toBe(true);
  });

  it('returns changed=false after a bump, on subsequent reads', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 10 });

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true);

    mockFileSyncContents[file] = JSON.stringify({ state: 11 });
    expect(tracker.dbChanged()).toBe(true);

    // Now it should be stable again
    expect(tracker.dbChanged()).toBe(false);
  });

  it('fail-open: read errors return changed=true', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncThrowFor = file;

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true); // fail-open on first read

    // Fix the read — should still be changed since we never got a valid prior value
    mockFileSyncThrowFor = null;
    mockFileSyncContents[file] = JSON.stringify({ state: 5 });
    expect(tracker.dbChanged()).toBe(true); // still true: prior call errored, no valid baseline

    // Now fix and bump
    mockFileSyncContents[file] = JSON.stringify({ state: 6 });
    expect(tracker.dbChanged()).toBe(true);

    expect(tracker.dbChanged()).toBe(false);
  });

  it('fail-open: after a successful read, read error returns changed=true', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 10 });

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true);
    expect(tracker.dbChanged()).toBe(false);

    // Now simulate a read error — readStateCounter returns 0, tracker
    // sees counter 0 vs lastSeen 10 → changed=true. lastSeen is updated
    // to 0 (the error-returned value).
    mockFileSyncThrowFor = file;
    expect(tracker.dbChanged()).toBe(true); // fail-open: error returns 0, 0≠10

    // Recovery: error goes away, counter is 10 vs lastSeen 0 → still changed
    mockFileSyncThrowFor = null;
    mockFileSyncContents[file] = JSON.stringify({ state: 10 });
    expect(tracker.dbChanged()).toBe(true); // 10 ≠ 0 (lastSeen updated by error)

    // Next call: stable
    expect(tracker.dbChanged()).toBe(false);
  });

  it('zero counter is treated as a valid baseline (first call returns changed=true)', () => {
    const cacheDir = tempDir();
    const worklogDir = '/test/worklog';
    const file = stateCounterFile(cacheDir, worklogDir);

    mockFileSyncContents[file] = JSON.stringify({ state: 0 });

    const tracker = new DbChangeTracker(cacheDir, worklogDir);
    expect(tracker.dbChanged()).toBe(true); // first call, no prior baseline
    expect(tracker.dbChanged()).toBe(false); // still 0, no change
  });
});

// ---------------------------------------------------------------------------
// watchDbChanges (event-driven companion)
// ---------------------------------------------------------------------------

/**
 * A controllable fake `fs.watch`: records listeners in target order and
 * returns closeable handles so dispose can be asserted.
 */
function fakeWatch(): {
  watch: any;
  listeners: Array<(event: string, filename: string | Buffer | null) => void>;
  closes: Array<ReturnType<typeof vi.fn>>;
  dirs: string[];
} {
  const listeners: Array<(event: string, filename: string | Buffer | null) => void> = [];
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  const dirs: string[] = [];
  const watch = vi.fn((dir: string, listener: any) => {
    dirs.push(dir);
    listeners.push(listener);
    const close = vi.fn();
    closes.push(close);
    return { close };
  });
  return { watch, listeners, closes, dirs };
}

/** A controllable timer seam for deterministic debounce assertions. */
function fakeDebounceTimers(): {
  setTimeoutFn: any;
  clearTimeoutFn: any;
  run: () => void;
  pending: () => boolean;
} {
  let scheduled: (() => void) | null = null;
  const setTimeoutFn = vi.fn((fn: () => void) => {
    scheduled = fn;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  });
  const clearTimeoutFn = vi.fn(() => {
    scheduled = null;
  });
  return {
    setTimeoutFn,
    clearTimeoutFn,
    run: () => scheduled?.(),
    pending: () => scheduled !== null,
  };
}

/**
 * A controllable fake `fs.watch` whose handles expose an async `'error'`
 * emitter, mirroring `fs.FSWatcher` (which can fail after creation).
 */
function fakeErrorWatch(): {
  watch: any;
  handles: Array<{
    close: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emitError: (error: unknown) => void;
  }>;
} {
  const handles: Array<{
    close: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emitError: (error: unknown) => void;
  }> = [];
  const watch = vi.fn((_dir: string, _listener: any) => {
    let errorListener: ((error: unknown) => void) | null = null;
    const handle = {
      close: vi.fn(),
      on: vi.fn((event: string, listener: (error: unknown) => void) => {
        if (event === 'error') errorListener = listener;
      }),
      emitError: (error: unknown) => errorListener?.(error),
    };
    handles.push(handle);
    return handle;
  });
  return { watch, handles };
}

describe('watchDbChanges', () => {
  it('watches the state-counter dir ONLY — the SQLite files are deliberately not watched', () => {
    const { watch, dirs } = fakeWatch();
    const w = watchDbChanges('/cache', '/worklog', vi.fn(), { watch });
    expect(w.active).toBe(true);
    // One watch handle: the state-counter directory. The SQLite worklog.db /
    // -wal / -shm files are deliberately NOT watched: the pane's own
    // in-process SQLite reads (fetchActionableCount / fetchChildrenForItems
    // open a fresh WorklogDatabase) checkpoint the WAL and touch -shm, so
    // watching them re-fires the watch on every refresh — a self-sustaining
    // refresh loop that saturated the event loop and made keyboard input
    // unresponsive (WL-0MV02VA29009WBEN producer-rejection fix).
    expect(dirs).toEqual(['/cache/state']);
    w.dispose();
  });

  it('the worklog dir is never watched (no extra handles beyond the state dir)', () => {
    const { watch, dirs } = fakeWatch();
    const w = watchDbChanges('/cache', '/worklog', vi.fn(), { watch });
    expect(dirs).not.toContain('/worklog');
    w.dispose();
  });

  it('debounces a burst of matching events into ONE trailing callback', () => {
    const { watch, listeners } = fakeWatch();
    const on = vi.fn();
    const timers = fakeDebounceTimers();
    const w = watchDbChanges('/cache', '/worklog', on, {
      watch,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const counterName = path.basename(stateCounterFile('/cache', '/worklog'));
    // listener[0] is the state-counter dir watch.
    listeners[0]('change', counterName);
    listeners[0]('change', counterName);
    listeners[0]('change', counterName);

    // Not fired until the debounce window elapses.
    expect(on).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(true);

    timers.run();
    expect(on).toHaveBeenCalledTimes(1);

    w.dispose();
  });

  it('ignores events for unrelated files — INCLUDING SQLite -wal/-shm churn', () => {
    const { watch, listeners } = fakeWatch();
    const on = vi.fn();
    const timers = fakeDebounceTimers();
    const w = watchDbChanges('/cache', '/worklog', on, {
      watch,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    // Another worklog's counter: filtered out by name.
    listeners[0]('change', 'some-other-counter.json');
    // SQLite-file churn — the pane's own in-process reads, WAL checkpoints,
    // other panes' reads — must NOT schedule a refresh. Only the state
    // counter (the write-only signal) counts; watching the DB files created
    // a self-refresh loop (WL-0MV02VA29009WBEN producer-rejection fix).
    listeners[0]('change', 'worklog.db');
    listeners[0]('change', 'worklog.db-wal');
    listeners[0]('change', 'worklog.db-shm');

    expect(timers.setTimeoutFn).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
    w.dispose();
  });

  it('fail-open: reacts when the platform omits the filename', () => {
    const { watch, listeners } = fakeWatch();
    const on = vi.fn();
    const timers = fakeDebounceTimers();
    const w = watchDbChanges('/cache', '/worklog', on, {
      watch,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    listeners[0]('rename', null);
    expect(timers.setTimeoutFn).toHaveBeenCalledTimes(1);
    timers.run();
    expect(on).toHaveBeenCalledTimes(1);
    w.dispose();
  });

  it('fail-open: reports inactive when the state-counter watch throws', () => {
    const watch = vi.fn(() => {
      throw new Error('ENOENT: no such directory');
    });
    const onError = vi.fn();
    const w = watchDbChanges('/cache', '/worklog', vi.fn(), { watch, onError });

    expect(w.active).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    // Disposing an inactive watch is safe and idempotent.
    expect(() => w.dispose()).not.toThrow();
  });

  it('dispose closes every handle, clears the pending timer, and ignores later events', () => {
    const { watch, listeners, closes } = fakeWatch();
    const on = vi.fn();
    const timers = fakeDebounceTimers();
    const w = watchDbChanges('/cache', '/worklog', on, {
      watch,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const counterName = path.basename(stateCounterFile('/cache', '/worklog'));
    listeners[0]('change', counterName);

    w.dispose();
    expect(timers.clearTimeoutFn).toHaveBeenCalled();
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(w.active).toBe(false);

    // A stale listener firing after dispose must not invoke onChange.
    listeners[0]('change', counterName);
    timers.run();
    expect(on).not.toHaveBeenCalled();

    // Idempotent.
    w.dispose();
    expect(closes[0]).toHaveBeenCalledTimes(1);
  });

  it('close() is an alias for dispose() (idempotent, closes every handle)', () => {
    const { watch, closes } = fakeWatch();
    const w = watchDbChanges('/cache', '/worklog', vi.fn(), { watch });
    w.close();
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(w.active).toBe(false);

    // Idempotent: dispose after close is a no-op.
    w.dispose();
    expect(closes[0]).toHaveBeenCalledTimes(1);
  });

  it('fail-open: an async fs.watch error retires the target and is reported', () => {
    const { watch, handles } = fakeErrorWatch();
    const onError = vi.fn();
    const w = watchDbChanges('/cache', '/worklog', vi.fn(), { watch, onError });

    expect(handles).toHaveLength(1);
    expect(w.active).toBe(true);

    // A post-creation failure (e.g. EPERM on a network FS) must be reported
    // and the target retired; with no other target the watch reports
    // inactive so the caller falls back to the 30 s polling tick.
    handles[0].emitError(new Error('EPERM: operation not permitted'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(handles[0].close).toHaveBeenCalledTimes(1);
    expect(w.active).toBe(false);
  });

  it('fail-open: repeated async errors on the same handle are safe', () => {
    const { watch, handles } = fakeErrorWatch();
    const onError = vi.fn();
    const w = watchDbChanges('/cache', '/worklog', vi.fn(), { watch, onError });

    handles[0].emitError(new Error('first'));
    handles[0].emitError(new Error('second'));
    expect(onError).toHaveBeenCalledTimes(2);
    // The single handle is already retired; the watch reports inactive.
    expect(w.active).toBe(false);
    w.dispose();
  });

  it('fail-open: a throwing onError handler never breaks watch setup', () => {
    const watch = vi.fn(() => {
      throw new Error('ENOENT: no state dir');
    });
    const onError = vi.fn(() => {
      throw new Error('handler exploded');
    });

    let w: DbChangeWatch | undefined;
    expect(() => {
      w = watchDbChanges('/cache', '/worklog', vi.fn(), { watch, onError });
    }).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    // The only target failed to start, so the watch is inactive (fail-open:
    // the caller keeps its 30 s polling tick).
    expect(w!.active).toBe(false);
    w!.dispose();
  });

  it('fail-open: a throwing onChange callback is contained (never crashes the loop)', () => {
    const { watch, listeners } = fakeWatch();
    const onError = vi.fn();
    const boom = vi.fn(() => {
      throw new Error('pane callback exploded');
    });
    const timers = fakeDebounceTimers();
    const w = watchDbChanges('/cache', '/worklog', boom, {
      watch,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onError,
    });

    const counterName = path.basename(stateCounterFile('/cache', '/worklog'));
    listeners[0]('change', counterName);
    expect(() => timers.run()).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // The watch stays armed and observes the next write.
    listeners[0]('change', counterName);
    timers.run();
    expect(boom).toHaveBeenCalledTimes(2);
    w.dispose();
  });

  it('really fires onChange when the state-counter file is written (real fs.watch)', async () => {
    const cacheDir = tempDir();
    const worklogDir = tempDir();
    const file = stateCounterFile(cacheDir, worklogDir);
    fsReal.mkdirSync(path.dirname(file), { recursive: true });

    let resolveCalled!: () => void;
    const called = new Promise<void>((resolve) => {
      resolveCalled = resolve;
    });
    const on = vi.fn(() => resolveCalled());

    const w = watchDbChanges(cacheDir, worklogDir, on, { debounceMs: 20 });
    expect(w.active).toBe(true);
    try {
      // Emulate a wl write bumping the counter (the same atomic-ish write the
      // CLI performs) and assert the watch observes it.
      fsReal.writeFileSync(file, JSON.stringify({ state: 1 }), 'utf-8');
      await Promise.race([
        called,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('watch did not fire within 2s')), 2000),
        ),
      ]);
      expect(on).toHaveBeenCalled();
    } finally {
      w.dispose();
    }
  });

  it('REGRESSION: SQLite -wal/-shm/db churn alone never fires onChange (real fs.watch)', async () => {
    // The pane's own refresh path opens a fresh WorklogDatabase for
    // in-process reads, which checkpoints the WAL and touches -shm. If the
    // watch reacted to those files it would re-fire on the pane's own reads
    // — a self-sustaining refresh loop that saturated the event loop and
    // made keyboard input unresponsive (WL-0MV02VA29009WBEN
    // producer-rejection fix). Only the state counter may fire the watch.
    const cacheDir = tempDir();
    const worklogDir = tempDir();
    const file = stateCounterFile(cacheDir, worklogDir);
    fsReal.mkdirSync(path.dirname(file), { recursive: true });
    fsReal.writeFileSync(file, JSON.stringify({ state: 0 }), 'utf-8');

    const on = vi.fn();
    const w = watchDbChanges(cacheDir, worklogDir, on, { debounceMs: 20 });
    expect(w.active).toBe(true);
    try {
      // Emulate the pane's own in-process SQLite reads touching the files
      // that were previously watched: nothing may fire.
      fsReal.writeFileSync(path.join(worklogDir, 'worklog.db'), 'x', 'utf-8');
      fsReal.writeFileSync(path.join(worklogDir, 'worklog.db-wal'), 'wal', 'utf-8');
      fsReal.writeFileSync(path.join(worklogDir, 'worklog.db-shm'), 'shm', 'utf-8');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(on).not.toHaveBeenCalled();

      // Sanity: the watch is alive — the counter write still fires it.
      fsReal.writeFileSync(file, JSON.stringify({ state: 1 }), 'utf-8');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(on).toHaveBeenCalledTimes(1);
    } finally {
      w.dispose();
    }
  });
});
