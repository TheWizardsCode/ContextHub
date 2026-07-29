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

/**
 * Run `wl sync` in the background using `spawn`.
 *
 * This is a fire-and-forget operation — it does not wait for completion
 * and silently ignores all errors. If `wl` is not available, the
 * function returns immediately without throwing.
 *
 * @returns A promise that resolves when the sync process exits (or
 *          immediately on failure).
 */
export function runSync(): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const child = spawn('wl', ['sync'], {
        stdio: ['ignore', 'ignore', 'ignore'], // Discard all output
        detached: false,
      });

      // Fire-and-forget: we don't care about success/failure
      child.on('close', () => {
        resolve();
      });

      child.on('error', () => {
        // e.g., ENOENT — wl not on PATH
        resolve();
      });

      // Safety timeout: if spawn never fires close/error, resolve after 10s
      // to prevent dangling promises (very unlikely with ignore stdio).
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 10_000);
      if (timeout.unref) timeout.unref(); // Don't keep node alive
    } catch {
      // Worst-case: spawn itself throws (extremely rare)
      resolve();
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
