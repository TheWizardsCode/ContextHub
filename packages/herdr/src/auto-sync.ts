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
 *  - Clamped interval: minimum 30s, 0 means disabled
 *  - Idempotent: multiple overlapping syncs are harmless (wl sync is idempotent)
 */

import { spawn } from 'node:child_process';

// ── Constants ─────────────────────────────────────────────────────────

/** Default sync interval in milliseconds (30s). */
export const DEFAULT_SYNC_INTERVAL_MS = 30_000;

/** Minimum allowed sync interval in milliseconds (30s). */
export const MIN_SYNC_INTERVAL_MS = 30_000;

/** Sentinel value meaning "sync is disabled". */
export const SYNC_DISABLED = 0;

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
 * @returns A promise resolving with the sync outcome.
 */
export function runSync(worklogDir?: string, options?: RunSyncOptions): Promise<{ success: boolean; error?: string; skipped?: boolean }> {
  const ifIdle = options?.ifIdle ?? false;

  // Single-flight guard: never spawn a second sync while one is in-flight
  // (auto-sync path). The caller is told the sync was skipped.
  if (ifIdle && _syncInFlight) {
    return Promise.resolve({ success: false, skipped: true, error: 'sync already in progress' });
  }

  return new Promise<{ success: boolean; error?: string; skipped?: boolean }>((resolve) => {
    try {
      // Target the resolved worklog (same as other wl invocations) so the
      // background sync operates on the tab project, not the plugin's CWD.
      const syncArgs = worklogDir
        ? ['--worklog-dir', worklogDir, 'sync', ...(ifIdle ? ['--if-idle'] : [])]
        : ['sync', ...(ifIdle ? ['--if-idle'] : [])];
      const child = spawn('wl', syncArgs, {
        stdio: ['ignore', 'ignore', 'ignore'], // Discard output
        detached: false,
      });

      _syncInFlight = true;

      let settled = false;
      // Safety timeout: if spawn never fires close/error, resolve after 10s.
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
      }, 10_000);
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
