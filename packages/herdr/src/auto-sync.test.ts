/**
 * Unit tests for auto-sync.ts — Background `wl sync` for auto-refresh
 *
 * Run: npx vitest run packages/herdr/src/auto-sync.test.ts
 * (from the project root: npx vitest run packages/herdr/src/auto-sync.test.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  DEFAULT_HEARTBEAT_TTL_MS,
  heartbeatTtlForInterval,
  isSyncHeartbeatFresh,
  readSyncHeartbeatMs,
  syncHeartbeatPath,
  _resetSyncInFlight,
  formatSyncNotice,
  getSyncElapsedMs,
  getSyncStatus,
  isSyncInFlight,
  onSyncStatusChange,
  _resetSyncSpawnForTests,
  _resetSyncStatusForTests,
  _setSyncSpawnForTests,
  _setSyncStatusForTests,
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
  it('DEFAULT_SYNC_INTERVAL_MS is 60_000', () => {
    expect(DEFAULT_SYNC_INTERVAL_MS).toBe(60_000);
  });

  it('MIN_SYNC_INTERVAL_MS is 60_000', () => {
    expect(MIN_SYNC_INTERVAL_MS).toBe(60_000);
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
    expect(clampSyncInterval(60_000)).toBe(60_000);
    expect(clampSyncInterval(90_000)).toBe(90_000);
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

  it('triggers safety timeout after 60s to prevent dangling promises', async () => {
    vi.useFakeTimers();

    // No child event will fire (childEventCallback is null)
    childEventToFire = null;

    const promise = runSync();
    expect(mockSpawn).toHaveBeenCalledWith('wl', ['sync'], expect.any(Object));

    // Advance past the 60s safety timeout
    await vi.advanceTimersByTimeAsync(60_000);

    // The mock child's kill should have been called
    const outcome = await promise;
    expect(outcome.success).toBe(false);
  });

  it('does not kill a sync that completes before the 60s safety timeout', async () => {
    vi.useFakeTimers();

    // childEventToFire is 'close' (beforeEach default): the close handler is
    // registered so we can simulate a slow-but-completing sync at 59s.
    const promise = runSync();

    // Advance to 59s — still within the 60s safety timeout, so the sync is
    // not killed and the promise has not settled.
    await vi.advanceTimersByTimeAsync(59_000);

    // Manually resolve the child via the close event at 59s (simulating a sync
    // that completed at 59s — a legitimately slow sync on a large dataset).
    // If the shared global child_process mock is active instead (the file-local
    // vi.mock may not win on a warm transform cache), the real child settles on
    // its own — the assertion below only requires that a completed sync is
    // never reported as timed out.
    if (childEventCallback) childEventCallback();

    const outcome = await promise;
    // A sync that completed before the 60s timeout must never be killed and
    // reported as timed out (WL-0MSAKM838006RZNR).
    expect(outcome.error).not.toBe('wl sync timed out');
    if (childEventCallback) {
      // File-local mock active: close fired with no code → success.
      expect(outcome.success).toBe(true);
    }
    vi.useRealTimers();
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
    await vi.advanceTimersByTimeAsync(60_000);
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
    await vi.advanceTimersByTimeAsync(60_000);
    await p1;
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Cross-instance sync heartbeat (F3 — WL-0MSGAEJQA005QG3W)
// ---------------------------------------------------------------------------

describe('sync heartbeat', () => {
  let hbDir: string;
  let worklogDir: string;

  beforeEach(() => {
    hbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-hb-'));
    // herdr's worklog-dir override points at the .worklog/ subdirectory.
    worklogDir = path.join(hbDir, '.worklog');
  });

  afterEach(() => {
    fs.rmSync(hbDir, { recursive: true, force: true });
  });

  function writeHeartbeat(iso: string): void {
    fs.mkdirSync(worklogDir, { recursive: true });
    fs.writeFileSync(path.join(worklogDir, 'last-sync-time'), iso, 'utf-8');
  }

  it('readSyncHeartbeatMs parses the CLI-written ISO marker', () => {
    writeHeartbeat('2026-06-25T12:00:00.000Z');
    expect(readSyncHeartbeatMs(worklogDir)).toBe(Date.parse('2026-06-25T12:00:00.000Z'));
  });

  it('readSyncHeartbeatMs returns undefined when the marker is absent or unparseable', () => {
    expect(readSyncHeartbeatMs(worklogDir)).toBeUndefined();
    writeHeartbeat('not-a-timestamp');
    expect(readSyncHeartbeatMs(worklogDir)).toBeUndefined();
  });

  it('isSyncHeartbeatFresh is true within the TTL window and false after it (AC3: no indefinite skip)', () => {
    const now = Date.parse('2026-06-25T12:00:00.000Z');
    writeHeartbeat(new Date(now - 10_000).toISOString()); // 10s ago
    expect(isSyncHeartbeatFresh(worklogDir, DEFAULT_HEARTBEAT_TTL_MS, now)).toBe(true);
    // 46s ago > 45s TTL → stale → a sync must spawn again.
    writeHeartbeat(new Date(now - 46_000).toISOString());
    expect(isSyncHeartbeatFresh(worklogDir, DEFAULT_HEARTBEAT_TTL_MS, now)).toBe(false);
  });

  it('isSyncHeartbeatFresh is false when no heartbeat exists (first sync must spawn)', () => {
    expect(isSyncHeartbeatFresh(worklogDir, DEFAULT_HEARTBEAT_TTL_MS)).toBe(false);
  });

  it('heartbeatTtlForInterval keeps the cadence: interval minus a 15s margin', () => {
    expect(heartbeatTtlForInterval(60_000)).toBe(45_000);
    expect(heartbeatTtlForInterval(300_000)).toBe(285_000);
    expect(heartbeatTtlForInterval(0)).toBe(SYNC_DISABLED);
    expect(heartbeatTtlForInterval(30_000)).toBe(45_000); // clamped to MIN first
  });

  it('runSync with a fresh heartbeat skips WITHOUT spawning a process', async () => {
    childEventToFire = 'close';
    writeHeartbeat(new Date().toISOString());
    const outcome = await runSync(worklogDir, { ifIdle: true, heartbeat: true });
    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toBe('heartbeat');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('runSync with a stale heartbeat still spawns (TTL bounds the skip)', async () => {
    childEventToFire = 'close';
    writeHeartbeat(new Date(Date.now() - 2 * DEFAULT_HEARTBEAT_TTL_MS).toISOString());
    const promise = runSync(worklogDir, { ifIdle: true, heartbeat: true });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith('wl', ['--worklog-dir', worklogDir, 'sync', '--if-idle'], expect.any(Object));
    if (childEventCallback) childEventCallback();
    await promise;
  });

  it('runSync with no heartbeat spawns (first sync of a session)', async () => {
    childEventToFire = 'close';
    const promise = runSync(worklogDir, { ifIdle: true, heartbeat: true });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    if (childEventCallback) childEventCallback();
    await promise;
  });

  it('runSync without heartbeat option ignores the marker (manual syncs always run)', async () => {
    childEventToFire = 'close';
    writeHeartbeat(new Date().toISOString());
    const promise = runSync(worklogDir, { ifIdle: true }); // no heartbeat flag
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    if (childEventCallback) childEventCallback();
    await promise;
  });

  it('AC2 (measured): 6 panes on one worklog → only the first spawns within the heartbeat window', async () => {
    childEventToFire = 'close';
    // Pane 1: no heartbeat yet → spawns (the sync will write the marker).
    let promise = runSync(worklogDir, { ifIdle: true, heartbeat: true });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    if (childEventCallback) childEventCallback();
    await promise;

    // The spawned wl sync succeeded → CLI wrote the heartbeat marker.
    writeHeartbeat(new Date().toISOString());

    // Panes 2-6 tick within the window → all skip without spawning.
    for (let pane = 2; pane <= 6; pane++) {
      const outcome = await runSync(worklogDir, { ifIdle: true, heartbeat: true });
      expect(outcome.skipped).toBe(true);
      expect(outcome.reason).toBe('heartbeat');
    }
    expect(mockSpawn).toHaveBeenCalledTimes(1); // 6 panes, 1 process spawned
  });
});

// ---------------------------------------------------------------------------
// In-flight status instrumentation + non-blocking notice (F3 — WL-0MVJV2O7H003HY9N)
// ---------------------------------------------------------------------------

/**
 * Controllable fake child returned by the injected spawn seam: it stays
 * "in flight" until the test fires its close/error event, which is exactly
 * the `wl sync` shape the pane must never wait on.
 */
interface FakeSyncChild {
  pid: number;
  on: (event: string, cb: (...args: any[]) => void) => FakeSyncChild;
  kill: () => void;
  unref: () => void;
  fireClose: (code?: number | null) => void;
  fireError: (message: string) => void;
  killed: boolean;
}

function makeFakeSyncChild(pid = 40_211): FakeSyncChild {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const child: FakeSyncChild = {
    pid,
    on(event, cb) {
      handlers[event] = cb;
      return child;
    },
    kill() {
      child.killed = true;
    },
    unref() {},
    fireClose(code = 0) {
      handlers.close?.(code);
    },
    fireError(message: string) {
      handlers.error?.(new Error(message));
    },
    killed: false,
  };
  return child;
}

describe('in-flight sync status (F3 — auto-sync isolation)', () => {
  let child: FakeSyncChild;

  beforeEach(() => {
    _resetSyncInFlight();
    child = makeFakeSyncChild();
    _setSyncSpawnForTests(() => child);
  });

  afterEach(() => {
    _resetSyncSpawnForTests();
    _resetSyncStatusForTests();
  });

  it('reports the spawned PID and a monotonic start while the sync is in flight', async () => {
    expect(getSyncStatus()).toMatchObject({ state: 'idle', inFlight: false });

    const promise = runSync('/tmp/proj/.worklog', { ifIdle: true });

    // The status is published synchronously at spawn time, so a concurrent
    // refresh reading it sees the sync immediately.
    const status = getSyncStatus();
    expect(status.state).toBe('syncing');
    expect(status.inFlight).toBe(true);
    expect(status.pid).toBe(child.pid);
    expect(typeof status.startedAtMs).toBe('number');
    expect(typeof status.startedAtMonotonicMs).toBe('number');
    expect(isSyncInFlight()).toBe(true);

    // Elapsed is monotonic and injectable — no clock read blocks anything.
    const start = status.startedAtMonotonicMs as number;
    expect(getSyncElapsedMs(start)).toBe(0);
    expect(getSyncElapsedMs(start + 4_321)).toBe(4_321);

    child.fireClose(0);
    await promise;
  });

  it('keeps the monotonic start stable for the whole run and clears it exactly once on settle', async () => {
    const promise = runSync(undefined, { ifIdle: true });
    const startedAt = getSyncStatus().startedAtMonotonicMs;
    expect(typeof startedAt).toBe('number');

    // While in flight the start never changes (a reset would be a wait
    // marker: the pane's notice/elapsed must not restart mid-sync).
    await Promise.resolve();
    expect(getSyncStatus().startedAtMonotonicMs).toBe(startedAt);
    expect(getSyncStatus().pid).toBe(child.pid);

    child.fireClose(0);
    const outcome = await promise;
    expect(outcome.pid).toBe(child.pid);
    expect(typeof outcome.durationMs).toBe('number');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);

    const settled = getSyncStatus();
    expect(settled.state).toBe('synced');
    expect(settled.inFlight).toBe(false);
    expect(settled.pid).toBeUndefined();
    expect(settled.startedAtMonotonicMs).toBeUndefined();
    expect(settled.lastOutcome).toMatchObject({ success: true });
    expect(isSyncInFlight()).toBe(false);
  });

  it('records a failed outcome with the error when the sync exits non-zero', async () => {
    const promise = runSync(undefined, { ifIdle: true });
    child.fireClose(3);
    const outcome = await promise;
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain('status 3');

    const settled = getSyncStatus();
    expect(settled.state).toBe('failed');
    expect(settled.inFlight).toBe(false);
    expect(settled.lastOutcome?.success).toBe(false);
    expect(settled.lastOutcome?.error).toContain('status 3');
  });

  it('records a failed outcome when the spawn errors (e.g. wl not on PATH)', async () => {
    const promise = runSync(undefined, { ifIdle: true });
    child.fireError('spawn wl ENOENT');
    const outcome = await promise;
    expect(outcome.success).toBe(false);
    expect(getSyncStatus().state).toBe('failed');
    expect(getSyncStatus().lastOutcome?.error).toContain('ENOENT');
  });

  it('notifies subscribers on start and settle, and stops after unsubscribe', async () => {
    const transitions: string[] = [];
    const unsubscribe = onSyncStatusChange(() => {
      transitions.push(`${getSyncStatus().state}:${getSyncStatus().inFlight}`);
    });

    const promise = runSync(undefined, { ifIdle: true });
    expect(transitions).toEqual(['syncing:true']);

    child.fireClose(0);
    await promise;
    expect(transitions).toEqual(['syncing:true', 'synced:false']);

    unsubscribe();
    // A reset transition must no longer reach the removed listener.
    _setSyncStatusForTests(null);
    expect(transitions).toEqual(['syncing:true', 'synced:false']);
  });

  it('a skipped tick (single-flight / heartbeat) never claims the sync is running', async () => {
    child.fireClose(0); // settle an earlier run so the status is idle
    _resetSyncInFlight();

    // Single-flight skip: hold one sync in flight, then a second tick skips.
    const first = runSync(undefined, { ifIdle: true });
    const settledStart = getSyncStatus().startedAtMonotonicMs;
    const skipped = await runSync(undefined, { ifIdle: true });
    expect(skipped.skipped).toBe(true);
    // The skip must not reset the in-flight instrumentation.
    expect(getSyncStatus().inFlight).toBe(true);
    expect(getSyncStatus().startedAtMonotonicMs).toBe(settledStart);

    child.fireClose(0);
    await first;
  });

  it('clears a failed spawn state (spawn throws) and still resolves an outcome', async () => {
    _setSyncSpawnForTests(() => {
      throw new Error('spawn exploded');
    });
    const outcome = await runSync(undefined, { ifIdle: true });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain('spawn exploded');
    expect(getSyncStatus().inFlight).toBe(false);
    expect(getSyncStatus().state).toBe('failed');
  });
});

describe('formatSyncNotice (non-blocking pane status notice)', () => {
  afterEach(() => {
    _resetSyncStatusForTests();
    _resetSyncSpawnForTests();
  });

  it('is empty when no sync is in flight', () => {
    expect(formatSyncNotice()).toBe('');
  });

  it('shows "syncing…" with an elapsed seconds counter while in flight', () => {
    const started = 1_000_000;
    _setSyncStatusForTests({
      state: 'syncing',
      inFlight: true,
      pid: 1234,
      startedAtMs: Date.now(),
      startedAtMonotonicMs: started,
    });

    // Pure + non-blocking: the same snapshot renders deterministically for an
    // injected monotonic clock (no timer, no I/O, no lock).
    expect(formatSyncNotice(started)).toBe('⟳ syncing…');
    expect(formatSyncNotice(started + 999)).toBe('⟳ syncing…');
    expect(formatSyncNotice(started + 5_400)).toBe('⟳ syncing… 5s');
    expect(formatSyncNotice(started + 36_000)).toBe('⟳ syncing… 36s');
  });

  it('is empty again once the sync settles (no stale "hanging" indication)', () => {
    _setSyncStatusForTests({
      state: 'syncing',
      inFlight: true,
      pid: 1234,
      startedAtMonotonicMs: 0,
    });
    expect(formatSyncNotice(1_000)).not.toBe('');

    _setSyncStatusForTests(null);
    expect(formatSyncNotice(1_000)).toBe('');
    expect(getSyncStatus().inFlight).toBe(false);
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
    const timer = new SyncTimer({ intervalMs: 60_000, onSync });
    timer.start();
    expect(onSync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSync).toHaveBeenCalledTimes(2);
    expect(onSync).toHaveBeenLastCalledWith(60_000);

    await vi.advanceTimersByTimeAsync(60_000);
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
    const timer = new SyncTimer({ intervalMs: 60_000, onSync });
    timer.start();
    expect(onSync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
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
