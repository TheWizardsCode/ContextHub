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
 *  - Clamped interval: minimum 60s, 0 means disabled
 *  - Idempotent: multiple overlapping syncs are harmless (wl sync is idempotent)
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
}

/**
 * Whether a background `wl sync` is currently in-flight in this process.
 * Used by the UI to avoid piling on more syncs while one is running.
 */
export function isSyncInFlight(): boolean {
  return _syncInFlight;
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
      const child = spawn('wl', syncArgs, spawnOptions);

      _syncInFlight = true;

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
          resolve(outcome);
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
        child.kill();
        settle({ success: false, error: 'wl sync timed out' });
      }, 60_000);
      if (timeout.unref) timeout.unref(); // Don't keep node alive
    } catch (err) {
      // Worst-case: spawn itself throws (extremely rare)
      _syncInFlight = false;
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
