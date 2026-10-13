/**
 * DB-change signal module — reads the wl CLI state counter to detect
 * whether the worklog database has changed since the last check.
 *
 * This is a cheap, cross-process stable signal: the state counter is bumped
 * by every wl write command and by post-sync cache invalidation.
 *
 * Fail-open: any read error returns `changed = true`, so the refresh/sync
 * cycle always runs when the signal is unavailable.
 *
 * `watchDbChanges` is the event-driven companion: it watches `wl`'s
 * cross-process write signal (the state-counter file) so the pane can react
 * to an agent write promptly instead of waiting for the 30 s auto-refresh
 * tick. The watch is debounced (one trailing callback per burst), fails open
 * (an unusable watch is reported as inactive so the caller keeps polling),
 * and is disposable (`dispose()`/`close()` closes every `fs.watch` handle
 * and clears pending timers). Hardened against watch failures that surface
 * *after* creation (an asynchronous `fs.FSWatcher` `'error'` event, e.g.
 * inotify limits or a network filesystem dropping the watch) and against
 * throwing callbacks so nothing ever escapes into the TUI loop.
 *
 * The watch targets the state-counter FILE ONLY — deliberately NOT the
 * SQLite `worklog.db`/`-wal`/`-shm` files. Watching those created a
 * self-sustaining refresh loop: the pane's own refresh path opens a fresh
 * `WorklogDatabase` for in-process reads, and that open/close checkpoints
 * the WAL and touches `-shm`, i.e. it modifies exactly the files being
 * watched → the watch re-fired → another refresh → more file churn. The
 * pane NEVER writes the state counter (it only reads it), so the counter is
 * the loop-free authoritative signal: every `wl` write bumps it and every
 * pane-side read leaves it untouched (WL-0MV02VA29009WBEN
 * producer-rejection fix).
 *
 * @module db-change
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Cache-dir resolution (mirrors wl CLI's resolveCacheDir)
// ---------------------------------------------------------------------------

/**
 * Resolve the wl read-cache directory.
 *
 * Precedence: `WL_CACHE_DIR` (explicit override) → `$XDG_CACHE_HOME/wl` → `~/.cache/wl`.
 */
export function resolveCacheDir(): string {
  const override = process.env.WL_CACHE_DIR;
  if (override) return path.resolve(override);
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() !== '' ? path.resolve(xdg) : path.join(os.homedir(), '.cache');
  return path.join(base, 'wl');
}

// ---------------------------------------------------------------------------
// State-counter read
// ---------------------------------------------------------------------------

/**
 * Path of the per-worklog-dir state counter file within a cache dir.
 */
export function stateCounterFilePath(cacheDir: string, worklogDir: string): string {
  const hash = createHash('sha256').update(path.resolve(worklogDir)).digest('hex');
  return path.join(cacheDir, 'state', `${hash}.json`);
}

/**
 * Read the monotonic write-counter for a worklog dir.
 *
 * Returns 0 when the file is absent, unparseable, or the value is not a
 * finite non-negative number.
 */
export function readStateCounter(cacheDir: string, worklogDir: string): number {
  try {
    const file = stateCounterFilePath(cacheDir, worklogDir);
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as { state?: unknown };
    const state = Number(parsed?.state);
    return Number.isFinite(state) && state >= 0 ? Math.floor(state) : 0;
  } catch {
    // Any error (ENOENT, EACCES, JSON parse, etc.) → return 0.
    // The DbChangeTracker uses this as a signal of failure: on the first
    // call (lastSeen === null), 0 is treated as "no baseline, changed". After
    // a successful read, if the tracker receives 0 unexpectedly (e.g. after
    // an error cleared), it will treat the transition as changed until a
    // fresh read stabilises the baseline.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// DbChangeTracker
// ---------------------------------------------------------------------------

/**
 * Tracks whether the worklog DB has changed since the last check.
 *
 * First call with no prior value always returns `changed = true`. Subsequent
 * calls compare the current counter against the last-seen value.
 *
 * Fail-open: any read error returns `changed = true`. After an error, the
 * tracker recovers once a valid counter is read.
 */
export class DbChangeTracker {
  private cacheDir: string;
  private worklogDir: string;
  private lastSeen: number | null = null;

  constructor(cacheDir: string, worklogDir: string) {
    this.cacheDir = cacheDir;
    this.worklogDir = worklogDir;
  }

  /**
   * Returns `true` if the DB has changed since the last call (or if this is
   * the first call).
   */
  dbChanged(): boolean {
    // Fail-open: if readStateCounter itself throws, always return true.
    // (In practice readStateCounter returns 0 on error, so we treat 0 as
    // a valid counter — but if an error did slip through, the catch below
    // handles it.)
    try {
      const counter = readStateCounter(this.cacheDir, this.worklogDir);

      if (this.lastSeen === null) {
        // First call: no prior baseline, treat as changed.
        this.lastSeen = counter;
        return true;
      }

      if (this.lastSeen !== counter) {
        this.lastSeen = counter;
        return true;
      }

      // Counter unchanged since last check.
      return false;
    } catch {
      // Fail-open: any unexpected error means the cycle must run.
      return true;
    }
  }
}

// ---------------------------------------------------------------------------
// watchDbChanges — event-driven companion to DbChangeTracker
// ---------------------------------------------------------------------------

/** Default debounce window for coalescing a burst of watch events. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 150;

/** Minimal shape of an `fs.watch` handle (closeable, optionally error-emitting). */
export interface WatchHandle {
  close(): void;
  /**
   * Optional error subscription (a real `fs.FSWatcher` supports it). Used to
   * fail open when a watch fails *after* creation — otherwise the emitted
   * `'error'` event is unhandled and crashes the process.
   */
  on?(event: 'error', listener: (error: unknown) => void): unknown;
}

/** A filesystem watch listener, matching the `fs.watch` callback signature. */
export type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

/** Injectable `fs.watch` seam (defaults to the real `node:fs` implementation). */
export type WatchFn = (path: string, listener: WatchListener) => WatchHandle;

/** Injectable timer seam so debounce behaviour is deterministic in tests. */
export type WatchTimerFn = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
export type WatchClearTimerFn = (handle: ReturnType<typeof setTimeout>) => void;

export interface WatchDbChangesOptions {
  /** Debounce window in ms (default {@link DEFAULT_WATCH_DEBOUNCE_MS}). */
  debounceMs?: number;
  /** `fs.watch` implementation; defaults to the real one. */
  watch?: WatchFn;
  /** `setTimeout` implementation; defaults to the global. */
  setTimeoutFn?: WatchTimerFn;
  /** `clearTimeout` implementation; defaults to the global. */
  clearTimeoutFn?: WatchClearTimerFn;
  /** Called for each failed watch target (fail-open; never throws). */
  onError?: (error: unknown) => void;
}

/** A running DB-change watch. */
export interface DbChangeWatch {
  /**
   * True while at least one underlying `fs.watch` handle is active. `false`
   * means the watch could not be established (fail open): the caller must
   * keep the 30 s polling tick as its fallback.
   */
  readonly active: boolean;
  /** Stop watching and clear any pending debounce timer. Idempotent. */
  dispose(): void;
  /** Alias for {@link DbChangeWatch.dispose} (scope names both). */
  close(): void;
}

interface WatchTarget {
  dir: string;
  matches: (filename: string) => boolean;
}

/**
 * Watch the cross-process DB-change signal for a worklog dir.
 *
 * Watches the state-counter directory (`<cacheDir>/state/`), filtered to
 * this worklog's counter file — the SAME monotonic write counter
 * `DbChangeTracker` reads and the one `wl`'s write path bumps (pre-action
 * cache invalidation and post-sync invalidation; write-only from `wl`'s
 * perspective). A burst of events is coalesced into at most ONE trailing
 * `onChange()` call after `debounceMs` of quiet.
 *
 * Why NOT the SQLite files: an early design also watched the worklog dir
 * (`worklog.db`, `-wal`, `-shm`), which created a SELF-SUSTAINING refresh
 * loop — the pane's own refresh path opens a fresh `WorklogDatabase`
 * connection for in-process reads, and that open/close checkpoints the WAL
 * and touches `-shm`, i.e. it modifies exactly the files being watched,
 * re-firing the watch → another refresh → more file churn. The pane never
 * writes the state counter (it only reads it), so the counter is the
 * loop-free authoritative signal: every real `wl` write bumps it, every
 * pane-side read leaves it untouched (WL-0MV02VA29009WBEN
 * producer-rejection fix). The 30 s polling tick stays the fail-open
 * fallback.
 *
 * Fail-open: a target whose `fs.watch` throws is skipped; when no target
 * could be watched the returned watch reports `active === false` and the
 * caller keeps its polling fallback. Errors are surfaced via `onError` and
 * never thrown into the TUI event loop.
 */
export function watchDbChanges(
  cacheDir: string,
  worklogDir: string,
  onChange: () => void,
  opts: WatchDbChangesOptions = {},
): DbChangeWatch {
  const watchFn: WatchFn = opts.watch ?? ((target, listener) => fs.watch(target, listener));
  const setT: WatchTimerFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT: WatchClearTimerFn = opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  const debounceMs = opts.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;

  const counterFile = stateCounterFilePath(cacheDir, worklogDir);
  const counterName = path.basename(counterFile);

  // The state-counter directory is watched (not the bare file): the CLI
  // writes the counter via an atomic tmp + rename, which a direct file watch
  // would silently stop following after the inode is replaced. The directory
  // watch sees the rename and the per-worklog filename filter keeps events
  // from other worklogs (the dir holds one counter file per worklog dir) out.
  const targets: WatchTarget[] = [
    { dir: path.dirname(counterFile), matches: (name) => name === counterName },
  ];

  const handles: WatchHandle[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // A throwing callback must never take down the watch (or the pane): report
  // it through the error seam and carry on (fail open).
  const reportError = (error: unknown): void => {
    try {
      opts.onError?.(error);
    } catch {
      // Ignore a throwing error handler — the watch keeps working.
    }
  };

  const fire = (): void => {
    timer = null;
    if (disposed) return;
    try {
      onChange();
    } catch (error) {
      reportError(error);
    }
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer !== null) clearT(timer);
    timer = setT(fire, debounceMs);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
    for (const handle of handles) {
      try {
        handle.close();
      } catch {
        // A close failure must never break teardown.
      }
    }
    handles.length = 0;
  };

  for (const target of targets) {
    let handle: WatchHandle;
    try {
      handle = watchFn(target.dir, (_eventType, filename) => {
        if (disposed) return;
        const name = typeof filename === 'string'
          ? filename
          : filename
            ? filename.toString()
            : '';
        // Some platforms/filesystems omit the filename; treat that as a
        // possible match (fail-open toward reacting) rather than ignoring it.
        if (name === '' || target.matches(name)) schedule();
      });
    } catch (error) {
      // Fail-open: a target that cannot be watched is skipped. The caller
      // still has the polling fallback (and any other target).
      reportError(error);
      continue;
    }

    // Harden against a watch that fails AFTER creation: a real `fs.FSWatcher`
    // emits `'error'` (e.g. inotify watch-limit exhaustion, or a network FS
    // dropping the watch). Left unhandled, that event would crash the process,
    // so subscribe and retire the failed target (fail open — `active` then
    // reflects only the handles still alive).
    const liveHandle = handle;
    if (typeof liveHandle.on === 'function') {
      try {
        liveHandle.on('error', (error: unknown) => {
          const index = handles.indexOf(liveHandle);
          if (index !== -1) handles.splice(index, 1);
          reportError(error);
          try {
            liveHandle.close();
          } catch {
            // A close failure must never break teardown.
          }
        });
      } catch (error) {
        reportError(error);
      }
    }
    handles.push(liveHandle);
  }

  return {
    get active(): boolean {
      return handles.length > 0;
    },
    dispose,
    close: dispose,
  };
}
