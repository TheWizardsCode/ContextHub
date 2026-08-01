/**
 * Unit tests for auto-sync.ts — Background `wl sync` for auto-refresh
 *
 * Run: npx vitest run packages/herdr/src/auto-sync.test.ts
 * (from the project root: npx vitest run packages/herdr/src/auto-sync.test.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level state for the mocked child_process.spawn
// ---------------------------------------------------------------------------

/** Tracks whether the next spawn call should throw */
let spawnShouldThrow = false;
let childEventToFire: 'close' | 'error' | null = 'close';
let childEventCallback: (() => void) | null = null;

vi.mock('node:child_process', () => {
  const mockOn = vi.fn((event: string, cb: () => void) => {
    if (event === childEventToFire) {
      childEventCallback = cb;
    }
    return child;
  });
  const mockKill = vi.fn();
  const mockUnref = vi.fn();

  const child = {
    on: mockOn,
    kill: mockKill,
    unref: mockUnref,
  };

  return {
    spawn: vi.fn(() => {
      if (spawnShouldThrow) {
        throw new Error('spawn failed');
      }
      childEventCallback = null;
      return child;
    }),
  };
});

// Now import the module under test
import {
  clampSyncInterval,
  runSync,
  SyncTimer,
  createSyncTimer,
  DEFAULT_SYNC_INTERVAL_MS,
  MIN_SYNC_INTERVAL_MS,
  SYNC_DISABLED,
  _resetSyncInFlight,
} from './auto-sync.js';

// Re-import the mocked spawn for assertions
import { spawn as mockSpawn } from 'node:child_process';

beforeEach(() => {
  vi.clearAllMocks();
  spawnShouldThrow = false;
  childEventToFire = 'close';
  childEventCallback = null;
  _resetSyncInFlight();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('DEFAULT_SYNC_INTERVAL_MS is 30_000', () => {
    expect(DEFAULT_SYNC_INTERVAL_MS).toBe(30_000);
  });

  it('MIN_SYNC_INTERVAL_MS is 30_000', () => {
    expect(MIN_SYNC_INTERVAL_MS).toBe(30_000);
  });

  it('SYNC_DISABLED is 0', () => {
    expect(SYNC_DISABLED).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// clampSyncInterval
// ---------------------------------------------------------------------------

describe('clampSyncInterval', () => {
  it('returns SYNC_DISABLED for 0', () => {
    expect(clampSyncInterval(0)).toBe(SYNC_DISABLED);
  });

  it('returns SYNC_DISABLED for negative values', () => {
    expect(clampSyncInterval(-1)).toBe(SYNC_DISABLED);
    expect(clampSyncInterval(-1000)).toBe(SYNC_DISABLED);
  });

  it('clamps values below MIN to MIN', () => {
    expect(clampSyncInterval(5_000)).toBe(MIN_SYNC_INTERVAL_MS);
    expect(clampSyncInterval(15_000)).toBe(MIN_SYNC_INTERVAL_MS);
    expect(clampSyncInterval(29_999)).toBe(MIN_SYNC_INTERVAL_MS);
  });

  it('returns value unchanged for values at or above MIN', () => {
    expect(clampSyncInterval(30_000)).toBe(30_000);
    expect(clampSyncInterval(60_000)).toBe(60_000);
    expect(clampSyncInterval(120_000)).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// runSync
// ---------------------------------------------------------------------------

describe('runSync', () => {
  it('spawns wl sync with ignore stdio', async () => {
    childEventToFire = 'close';
    const promise = runSync();

    expect(mockSpawn).toHaveBeenCalledWith('wl', ['sync'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: false,
    });

    // Resolve the promise by firing the close callback
    if (childEventCallback) childEventCallback();
    await promise;
  });

  it('resolves when child emits close event', async () => {
    childEventToFire = 'close';
    const promise = runSync();
    // Fire the registered callback
    if (childEventCallback) setImmediate(childEventCallback);
    // close fires without a code; treat as success (or at minimum resolve)
    const outcome = await promise;
    expect(outcome).toHaveProperty('success');
  });

  it('spawns wl sync with cwd rooted at the worklog project when worklogDir is provided (WL-0MSAH26DD001XXST)', async () => {
    childEventToFire = 'close';
    const promise = runSync('/tmp/proj/.worklog');

    // The child must run from the tab project (parent of .worklog) so the CLI
    // resolves its git context against the tab project, never the pane cwd.
    expect(mockSpawn).toHaveBeenCalledWith(
      'wl',
      ['--worklog-dir', '/tmp/proj/.worklog', 'sync'],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: false,
        cwd: '/tmp/proj',
      }
    );

    if (childEventCallback) childEventCallback();
    await promise;
  });

  it('does not set cwd when no worklogDir is provided (inherits pane cwd)', async () => {
    childEventToFire = 'close';
    const promise = runSync();

    // Exact match on the options proves no cwd key is present.
    expect(mockSpawn).toHaveBeenCalledWith('wl', ['sync'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: false,
    });

    if (childEventCallback) childEventCallback();
    await promise;
  });

  it('resolves when child emits error event (e.g. ENOENT)', async () => {
    childEventToFire = 'error';
    const promise = runSync();
    if (childEventCallback) setImmediate(childEventCallback);
    const outcome = await promise;
    expect(outcome).toHaveProperty('success', false);
  });

  it('resolves when spawn throws (catch fallback)', async () => {
    spawnShouldThrow = true;
    const outcome = await runSync();
    expect(outcome).toHaveProperty('success', false);
    expect(mockSpawn).toHaveBeenCalled();
  });

  it('triggers safety timeout after 10s to prevent dangling promises', async () => {
    vi.useFakeTimers();

    // No child event will fire (childEventCallback is null)
    childEventToFire = null;

    const promise = runSync();
    expect(mockSpawn).toHaveBeenCalledWith('wl', ['sync'], expect.any(Object));

    // Advance past the 10s safety timeout
    await vi.advanceTimersByTimeAsync(10_000);

    // The mock child's kill should have been called
    const outcome = await promise;
    expect(outcome.success).toBe(false);
  });

  it('skips a second sync while one is in-flight (single-flight guard)', async () => {
    vi.useFakeTimers();
    // First sync stays in-flight (no close/error event)
    childEventToFire = null;
    const first = runSync(undefined, { ifIdle: true });

    // Second overlapping auto-sync tick is skipped without spawning
    const second = runSync(undefined, { ifIdle: true });
    const outcome = await second;
    expect(outcome.skipped).toBe(true);
    expect(outcome.success).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Let the first settle via its safety timeout so the guard is released
    // (no dangling promise).
    await vi.advanceTimersByTimeAsync(10_000);
    const firstOutcome = await first;
    expect(firstOutcome.success).toBe(false);
    vi.useRealTimers();
  });

  it('spawns a new sync after the in-flight one settles (guard released)', async () => {
    vi.useFakeTimers();
    childEventToFire = 'close';
    const first = runSync(undefined, { ifIdle: true });
    if (childEventCallback) childEventCallback();
    await first;
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Guard released — a later tick spawns again
    const second = runSync(undefined, { ifIdle: true });
    if (childEventCallback) childEventCallback();
    const outcome = await second;
    expect(outcome.skipped).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('passes --if-idle to wl sync when the ifIdle option is set', async () => {
    childEventToFire = 'close';
    const promise = runSync(undefined, { ifIdle: true });
    expect(mockSpawn).toHaveBeenCalledWith('wl', ['sync', '--if-idle'], expect.any(Object));
    if (childEventCallback) childEventCallback();
    await promise;
  });

  it('does not pass --if-idle for manual (non-ifIdle) syncs', async () => {
    childEventToFire = 'close';
    const promise = runSync();
    expect(mockSpawn).toHaveBeenCalledWith('wl', ['sync'], expect.any(Object));
    if (childEventCallback) childEventCallback();
    await promise;
  });

  it('two panes sharing a process do not double-spawn syncs on the same tick (lock-storm regression)', async () => {
    vi.useFakeTimers();
    // Simulate two worklist panes in one process, each firing onSync with the
    // auto-sync (ifIdle) flag on the same tick. The single-flight guard must
    // collapse them into ONE spawn, not two (WL-0MSAB7ZUC004SK7E).
    childEventToFire = null; // first sync stays in-flight
    const p1 = runSync(undefined, { ifIdle: true });
    const p2 = runSync(undefined, { ifIdle: true });

    const o2 = await p2;
    expect(o2.skipped).toBe(true); // second pane's tick was skipped
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Clean up: settle the in-flight sync via its safety timeout
    await vi.advanceTimersByTimeAsync(10_000);
    await p1;
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// SyncTimer
// ---------------------------------------------------------------------------

describe('SyncTimer', () => {
  let onSync: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    onSync = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onSync immediately on start() (first tick)', () => {
    const timer = new SyncTimer({ intervalMs: 60_000, onSync });
    expect(onSync).not.toHaveBeenCalled();
    timer.start();
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(onSync).toHaveBeenCalledWith(60_000);
    timer.stop();
  });

  it('calls onSync repeatedly at the configured interval', async () => {
    const timer = new SyncTimer({ intervalMs: 30_000, onSync });
    timer.start();
    expect(onSync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onSync).toHaveBeenCalledTimes(2);
    expect(onSync).toHaveBeenLastCalledWith(30_000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onSync).toHaveBeenCalledTimes(3);

    timer.stop();
  });

  it('does not fire onSync when interval is 0 (disabled)', () => {
    const timer = new SyncTimer({ intervalMs: 0, onSync });
    timer.start();
    expect(onSync).not.toHaveBeenCalled();
    timer.stop();
  });

  it('is a no-op when start() is called multiple times', () => {
    const timer = new SyncTimer({ intervalMs: 60_000, onSync });
    timer.start();
    timer.start();
    expect(onSync).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  it('stop() prevents further onSync calls', async () => {
    const timer = new SyncTimer({ intervalMs: 30_000, onSync });
    timer.start();
    expect(onSync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onSync).toHaveBeenCalledTimes(2);

    timer.stop();
    const countAfterStop = onSync.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSync).toHaveBeenCalledTimes(countAfterStop);
  });

  it('clamps interval below MIN to MIN', () => {
    const timer = new SyncTimer({ intervalMs: 5_000, onSync });
    timer.start();
    expect(onSync).toHaveBeenCalledWith(MIN_SYNC_INTERVAL_MS);
    timer.stop();
  });
});

// ---------------------------------------------------------------------------
// createSyncTimer
// ---------------------------------------------------------------------------

describe('createSyncTimer', () => {
  it('creates a SyncTimer instance', () => {
    const onSync = vi.fn();
    const timer = createSyncTimer({ intervalMs: 60_000, onSync });
    expect(timer).toBeInstanceOf(SyncTimer);
    timer.stop();
  });

  it('created timer calls onSync when started', () => {
    const onSync = vi.fn();
    const timer = createSyncTimer({ intervalMs: 60_000, onSync });
    timer.start();
    expect(onSync).toHaveBeenCalledTimes(1);
    timer.stop();
  });
});
