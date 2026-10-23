/**
 * packages/herdr/src/auto-sync.ts — Background `wl sync` for auto-refresh
 *
 * Provides a fire-and-forget background sync mechanism that runs
 * `wl sync` before each auto-refresh cycle, keeping local worklog data
 * in sync with remote changes without blocking the TUI event loop.
 *
 * Key design decisions:
 *  - Fire-and-forget: uses `spawn` with no output capture (stderr is ignored)
 *  - Never blocks: sync runs concurrently with refresh, errors are silently swallowed
 *  - Off the TUI event loop: the spawn and every completion signal are
 *    asynchronous libuv events; nothing in the sync path is awaited by the
 *    refresh path, so a long `wl sync` can never delay a refresh
 *    (F3 — WL-0MVJV2O7H003HY9N)
 *  - Observable: a tiny in-flight status model (PID, monotonic start,
 *    elapsed, last outcome) plus a change subscription lets the pane show a
 *    non-blocking "syncing…" notice and lets a test prove the refresh never
 *    waited on the sync
 *  - Clamped interval: minimum 60s, 0 means disabled
 *  - Idempotent: multiple overlapping syncs are harmless (wl sync is idempotent)
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

// ── Constants ─────────────────────────────────────────────────────────

/** Default sync interval in milliseconds (60s). */
export const DEFAULT_SYNC_INTERVAL_MS = 60_000;

/** Minimum allowed sync interval in milliseconds (60s). */
export const MIN_SYNC_INTERVAL_MS = 60_000;

/** Sentinel value meaning "sync is disabled". */
export const SYNC_DISABLED = 0;

/**
 * Default heartbeat freshness window (45s): MIN_SYNC_INTERVAL_MS minus a
 * 15s margin. Must be SHORTER than the sync interval so at least one pane's
 * tick lands outside the window each cycle — otherwise the heartbeat skip
 * would suppress every future sync (indefinite skip, AC3).
 */
export const DEFAULT_HEARTBEAT_TTL_MS = MIN_SYNC_INTERVAL_MS - 15_000;

// ── Cross-instance sync heartbeat (F3 — WL-0MSGAEJQA005QG3W) ──────────

/**
 * Heartbeat marker file: `<worklogDir>/last-sync-time` containing an ISO
 * timestamp. Written by the wl CLI only after a successful `wl sync` (see
 * src/commands/sync.ts), so its presence means "a sync succeeded recently in
 * SOME instance/process".
 */
export function syncHeartbeatPath(worklogDir: string): string {
  return path.join(path.resolve(worklogDir), 'last-sync-time');
}

/**
 * Read the last-success sync timestamp (epoch ms) for a worklog dir.
 * Returns undefined when the marker is absent or unparseable.
 */
export function readSyncHeartbeatMs(worklogDir: string): number | undefined {
  try {
    const raw = fs.readFileSync(syncHeartbeatPath(worklogDir), 'utf-8').trim();
    const ts = Date.parse(raw);
    return Number.isFinite(ts) ? ts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when a successful sync landed within the last `ttlMs` for the
 * worklog dir. `now` is injectable for tests.
 */
export function isSyncHeartbeatFresh(
  worklogDir: string,
  ttlMs: number,
  now: number = Date.now()
): boolean {
  const ts = readSyncHeartbeatMs(worklogDir);
  return ts !== undefined && now - ts < ttlMs;
}

/**
 * Heartbeat TTL for a configured sync interval: the interval minus a 15s
 * margin (clamped to ≥1s), so syncs land roughly once per interval across
 * all panes while only the first pane per window spawns. 0 (sync disabled)
 * maps to 0.
 */
export function heartbeatTtlForInterval(intervalMs: number): number {
  const clamped = clampSyncInterval(intervalMs);
  if (clamped === SYNC_DISABLED) return SYNC_DISABLED;
  return Math.max(1_000, clamped - 15_000);
}

// ── Single-flight state ───────────────────────────────────────────────

/**
 * Process-wide in-flight guard: only one `wl sync` may run at a time within
 * this pane process. Overlapping auto-sync ticks are skipped (single-flight)
 * so the worklist pane cannot spawn a lock storm of its own.
 */
let _syncInFlight = false;

/**
 * Test helper: reset the in-flight guard between tests.
 */
export function _resetSyncInFlight(): void {
  _syncInFlight = false;
  _syncStatus = { state: 'idle', inFlight: false };
}

/**
 * Whether a background `wl sync` is currently in-flight in this process.
 * Used by the UI to avoid piling on more syncs while one is running.
 */
export function isSyncInFlight(): boolean {
  return _syncStatus.inFlight;
}

// ── In-flight sync status model (F3 — WL-0MVJV2O7H003HY9N) ────────────

/**
 * Lifecycle state of the background sync in this pane process.
 *
 * - `idle`    — no sync has run yet, or the run started from a reset state.
 * - `syncing` — a `wl sync` child process is currently in-flight.
 * - `synced`  — the last run completed successfully.
 * - `failed`  — the last run failed (spawn error, non-zero exit, timeout).
 */
export type SyncRunState = 'idle' | 'syncing' | 'synced' | 'failed';

/** Outcome of the last completed background sync. */
export interface SyncLastOutcome {
  success: boolean;
  error?: string;
  /** Epoch ms at which the run settled. */
  completedAtMs: number;
  /** Monotonic duration of the run in ms (0 when unknown). */
  durationMs: number;
}

/**
 * Snapshot of the background sync's in-flight instrumentation.
 *
 * `startedAtMonotonicMs` uses `performance.now()`: it is monotonic within
 * this process, so a caller (or a test) can prove that a concurrent refresh
 * did not wait on the sync by comparing its own monotonic timeline against
 * the sync's start (F3 AC3, no lock/wait coupling).
 */
export interface SyncStatusSnapshot {
  state: SyncRunState;
  inFlight: boolean;
  /** PID of the in-flight `wl sync` child (undefined when idle). */
  pid?: number;
  /** Epoch ms when the in-flight sync started. */
  startedAtMs?: number;
  /** Monotonic (`performance.now()`) start of the in-flight sync. */
  startedAtMonotonicMs?: number;
  /** The most recent completed run's outcome (undefined before any run). */
  lastOutcome?: SyncLastOutcome;
}

/** Current status snapshot (a defensive copy — callers cannot mutate it). */
let _syncStatus: SyncStatusSnapshot = { state: 'idle', inFlight: false };

/** Listeners notified after every status transition. */
const syncStatusListeners = new Set<() => void>();

function setSyncStatus(patch: Partial<SyncStatusSnapshot>): void {
  _syncStatus = { ..._syncStatus, ...patch };
  for (const listener of [...syncStatusListeners]) {
    try {
      listener();
    } catch {
      // Fail-open: a broken listener (e.g. a torn-down pane) must never
      // break the sync bookkeeping or leak into the TUI event loop.
    }
  }
}

/**
 * Read the current background-sync status snapshot. Never blocks.
 */
export function getSyncStatus(): SyncStatusSnapshot {
  return { ..._syncStatus };
}

/**
 * Monotonic elapsed time (ms) of the in-flight sync; 0 when no sync is
 * in-flight. `nowMonotonic` is injectable for deterministic tests.
 */
export function getSyncElapsedMs(nowMonotonic: number = performance.now()): number {
  const started = _syncStatus.startedAtMonotonicMs;
  if (started === undefined) return 0;
  return Math.max(0, nowMonotonic - started);
}

/**
 * Subscribe to sync status transitions (start → syncing, settle → synced /
 * failed). Returns an unsubscribe function. The callback runs synchronously
 * in the settling scope and must stay cheap (the pane only schedules a
 * render); a throwing listener is swallowed so it cannot break the sync.
 */
export function onSyncStatusChange(listener: () => void): () => void {
  syncStatusListeners.add(listener);
  return () => {
    syncStatusListeners.delete(listener);
  };
}

/**
 * The pane's non-blocking "syncing…" notice text, or '' when idle.
 *
 * Never blocks and never throws: it is a pure read of the status snapshot, so
 * the pane can render it on every frame (and on every status transition)
 * without any I/O or lock.
 */
export function formatSyncNotice(nowMonotonic: number = performance.now()): string {
  if (!_syncStatus.inFlight) return '';
  const elapsedSeconds = Math.floor(getSyncElapsedMs(nowMonotonic) / 1000);
  return elapsedSeconds > 0 ? `⟳ syncing… ${elapsedSeconds}s` : '⟳ syncing…';
}

// ── Injectable spawn seam (tests) ─────────────────────────────────────

/** Minimal shape of the child returned by the sync spawn seam. */
export interface SyncChildLike {
  pid?: number;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  kill?: (signal?: any) => unknown;
  unref?: () => void;
}

/** Spawn seam: defaults to `child_process.spawn`. */
export type SyncSpawnFn = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => SyncChildLike;

let syncSpawnFn: SyncSpawnFn = spawn as unknown as SyncSpawnFn;

/**
 * Test seam: replace the sync spawn implementation (e.g. to hold a "long
 * sync" in flight without a real child process). Always pair with
 * {@link _resetSyncSpawnForTests}.
 */
export function _setSyncSpawnForTests(fn: SyncSpawnFn): void {
  syncSpawnFn = fn;
}

/** Test helper: restore the real `child_process.spawn` seam. */
export function _resetSyncSpawnForTests(): void {
  syncSpawnFn = spawn as unknown as SyncSpawnFn;
}

/**
 * Test helper: force a status snapshot (used by the pane's render tests to
 * assert the notice without spawning anything). Pass `null` to reset to the
 * idle state (keeping any recorded last outcome).
 */
export function _setSyncStatusForTests(snapshot: SyncStatusSnapshot | null): void {
  _syncInFlight = snapshot?.inFlight ?? false;
  setSyncStatus(
    snapshot ?? {
      state: 'idle',
      inFlight: false,
      pid: undefined,
      startedAtMs: undefined,
      startedAtMonotonicMs: undefined,
    },
  );
}

/**
 * Test helper: drop every status listener and reset the snapshot. Used to
 * isolate the module between test files that share a worker.
 */
export function _resetSyncStatusForTests(): void {
  syncStatusListeners.clear();
  _syncInFlight = false;
  _syncStatus = { state: 'idle', inFlight: false };
}

// ── Options ───────────────────────────────────────────────────────────

/**
 * Options for the sync timer.
 */
export interface SyncOptions {
  /** Sync interval in ms. 0 = disabled, values below MIN_SYNC_INTERVAL_MS are clamped. */
  intervalMs: number;
  /** Callback invoked on each sync tick. Receives the effective interval. */
  onSync: (effectiveInterval: number) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Clamp a sync interval to the allowed range.
 * 0 is preserved (disabled); values below MIN are raised to MIN.
 */
export function clampSyncInterval(intervalMs: number): number {
  if (intervalMs <= 0) return SYNC_DISABLED;
  return Math.max(intervalMs, MIN_SYNC_INTERVAL_MS);
}

export interface RunSyncOptions {
  /**
   * Single-flight / lock-aware guard: skip (do not spawn) when another sync
   * is already in-flight in this process, and pass `--if-idle` to `wl sync`
   * so the CLI also skips when the file lock is held by another process.
   * Auto-sync paths set this; manual syncs (user-triggered) leave it off so
   * they wait for the lock like a regular `wl sync`.
   */
  ifIdle?: boolean;
  /**
   * Cross-instance heartbeat skip (auto-sync only): skip spawning `wl sync`
   * entirely when a recent successful sync (heartbeat marker) exists for the
   * worklog dir — so with 6 panes on one worklog, only the first to tick
   * inside a window spawns a process. Manual/user syncs leave this off so
   * they always run.
   */
  heartbeat?: boolean;
  /** Freshness window for the heartbeat (ms); default DEFAULT_HEARTBEAT_TTL_MS. */
  heartbeatTtlMs?: number;
}

export interface SyncOutcome {
  success: boolean;
  error?: string;
  skipped?: boolean;
  /** Why the sync was skipped: `in-flight` (single-flight guard) or `heartbeat` (fresh marker). */
  reason?: 'in-flight' | 'heartbeat';
  /** PID of the spawned `wl sync` (in-flight instrumentation). */
  pid?: number;
  /** Monotonic duration of the run in ms (0 for skips / pre-spawn failures). */
  durationMs?: number;
}

/**
 * Run `wl sync` in the background using `spawn`.
 *
 * Fire-and-forget: it does not block the TUI, but it DOES report whether the
 * sync succeeded so the UI can surface status. If `wl` is not available the
 * promise resolves with `success: false` (no throw).
 *
 * With `ifIdle`, overlapping syncs are skipped (single-flight guard) and the
 * spawned CLI gets `--if-idle` so it exits immediately when the cross-process
 * file lock is held — preventing lock-storm process pile-up.
 *
 * With `heartbeat`, the sync is skipped without spawning a process when a
 * recent successful sync already happened in another instance (cross-instance
 * coordination, F3).
 *
 * @returns A promise resolving with the sync outcome.
 */
export function runSync(worklogDir?: string, options?: RunSyncOptions): Promise<SyncOutcome> {
  const ifIdle = options?.ifIdle ?? false;

  // Cross-instance heartbeat skip: a successful sync in ANY pane/instance
  // writes the heartbeat marker, so with 6 panes only the first to tick
  // inside a window spawns `wl sync`; the rest skip without spawning a
  // process (measured in the 6-pane spawn-reduction simulation).
  if (options?.heartbeat && worklogDir) {
    const ttlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    if (isSyncHeartbeatFresh(worklogDir, ttlMs)) {
      return Promise.resolve({ success: false, skipped: true, reason: 'heartbeat', error: 'sync heartbeat fresh' });
    }
  }

  // Single-flight guard: never spawn a second sync while one is in-flight
  // (auto-sync path). The caller is told the sync was skipped.
  if (ifIdle && _syncInFlight) {
    return Promise.resolve({ success: false, skipped: true, error: 'sync already in progress' });
  }

  return new Promise<SyncOutcome>((resolve) => {
    try {
      // Target the resolved worklog (same as other wl invocations) so the
      // background sync operates on the tab project, not the plugin's CWD.
      const syncArgs = worklogDir
        ? ['--worklog-dir', worklogDir, 'sync', ...(ifIdle ? ['--if-idle'] : [])]
        : ['sync', ...(ifIdle ? ['--if-idle'] : [])];
      // Root the spawned `wl sync` at the tab project (the parent of the
      // .worklog dir) so the CLI resolves its git context against the tab
      // project. Without a cwd the child inherits the pane's cwd, which can
      // live in a DIFFERENT git repo than the tab project — sync would then
      // fetch the wrong project's remote ref and merge it into the tab
      // project's database (cross-project pollution, WL-0MSAH26DD001XXST).
      const syncCwd = worklogDir ? path.dirname(path.resolve(worklogDir)) : undefined;
      const spawnOptions: any = {
        stdio: ['ignore', 'ignore', 'ignore'], // Discard output
        detached: false,
      };
      if (syncCwd) spawnOptions.cwd = syncCwd;
      const child = syncSpawnFn('wl', syncArgs, spawnOptions);

      _syncInFlight = true;
      const startedAtMonotonicMs = performance.now();
      const startedAtMs = Date.now();
      setSyncStatus({
        state: 'syncing',
        inFlight: true,
        pid: typeof child.pid === 'number' ? child.pid : undefined,
        startedAtMs,
        startedAtMonotonicMs,
      });

      let settled = false;
      // Safety timeout: if spawn never fires close/error, resolve after 60s.
      // This matches the Pi TUI extension's DEFAULT_WL_TIMEOUT_MS (60s) so that
      // legitimately slow syncs (11.6 MB JSONL, SSH push) are not killed. The
      // single-flight guard still prevents process pile-up; this timeout only
      // catches truly hung spawns (e.g. binary missing, infinite wait).
      // Declared before settle so the guard can clear it once the sync ends.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: { success: boolean; error?: string }) => {
        if (!settled) {
          settled = true;
          _syncInFlight = false;
          if (timeout) clearTimeout(timeout);
          const durationMs = Math.max(0, performance.now() - startedAtMonotonicMs);
          // Publish the settled status BEFORE resolving the promise so a
          // caller that awaits the outcome always observes the final state
          // (and the pane's notice clears in the same tick).
          setSyncStatus({
            state: outcome.success ? 'synced' : 'failed',
            inFlight: false,
            pid: undefined,
            startedAtMs: undefined,
            startedAtMonotonicMs: undefined,
            lastOutcome: {
              success: outcome.success,
              ...(outcome.error !== undefined ? { error: outcome.error } : {}),
              completedAtMs: Date.now(),
              durationMs,
            },
          });
          resolve({ ...outcome, pid: child.pid, durationMs });
        }
      };

      child.on('close', (code) => {
        // Some spawn mocks/tests fire close without an explicit code; treat
        // an undefined/null code as success (the process ended normally).
        const success = code == null || code === 0;
        settle({ success, error: success ? undefined : `wl sync exited with status ${code}` });
      });

      child.on('error', (err) => {
        // e.g., ENOENT — wl not on PATH
        const msg = err && typeof err === 'object' && 'message' in (err as any)
          ? String((err as any).message)
          : String(err);
        settle({ success: false, error: msg || 'wl sync failed' });
      });

      timeout = setTimeout(() => {
        child.kill?.();
        settle({ success: false, error: 'wl sync timed out' });
      }, 60_000);
      if (timeout.unref) timeout.unref(); // Don't keep node alive
    } catch (err) {
      // Worst-case: spawn itself throws (extremely rare)
      _syncInFlight = false;
      setSyncStatus({ state: 'failed', inFlight: false, pid: undefined });
      const msg = err && typeof err === 'object' && 'message' in (err as any)
        ? String((err as any).message)
        : String(err);
      resolve({ success: false, error: msg || 'wl sync failed' });
    }
  });
}

// ── Timer ─────────────────────────────────────────────────────────────

/**
 * A sync timer that runs `wl sync` at a configured interval.
 *
 * The timer:
 *  - Clamps intervals below MIN_SYNC_INTERVAL_MS to MIN_SYNC_INTERVAL_MS
 *  - Does nothing if interval is 0 (disabled)
 *  - Can be stopped via `stop()`
 */
export class SyncTimer {
  private timerId: ReturnType<typeof setInterval> | null = null;
  private effectiveInterval: number;

  constructor(private options: SyncOptions) {
    this.effectiveInterval = clampSyncInterval(options.intervalMs);
  }

  /**
   * Start the sync timer. If interval is 0 (disabled), this is a no-op.
   */
  start(): void {
    if (this.effectiveInterval === SYNC_DISABLED) return;
    if (this.timerId !== null) return; // Already running

    const tick = (): void => {
      this.options.onSync(this.effectiveInterval);
    };

    this.timerId = setInterval(tick, this.effectiveInterval);
    // Don't keep the process alive just for the timer
    if (this.timerId.unref) this.timerId.unref();

    // Fire once immediately on start so the first refresh gets fresh data
    tick();
  }

  /**
   * Stop the sync timer and clear the interval.
   */
  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }
}

/**
 * Create a SyncTimer from options. Convenience function.
 */
export function createSyncTimer(options: SyncOptions): SyncTimer {
  return new SyncTimer(options);
}
