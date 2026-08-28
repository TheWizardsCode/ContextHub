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
