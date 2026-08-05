/**
 * On-disk read cache for the wl CLI (option A — primary win from
 * WL-0MSAZQEQB008O7H3).
 *
 * Pure-read commands (`list`, `next`, `show`, `search`, `status` in JSON
 * mode) cache their JSON result keyed by (absolute worklog-dir, full argv,
 * wl version) in the XDG cache dir (`~/.cache/wl/`). Freshness is WAL-aware:
 * the cached entry stores a fingerprint (mtime+size) of `worklog.db`,
 * `worklog.db-wal` and `worklog.db-shm`, and is invalidated when any of them
 * change. A TTL (default 30s) acts as a bounding safety net, and the cache is
 * bounded via LRU purge.
 *
 * Concurrency safety: entries are written atomically (temp file + rename) so
 * concurrent readers/writers across processes never observe partial entries.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { WORKLOG_VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

/** Bounding safety net: entries older than this are never served (30s). */
export const DEFAULT_TTL_MS = 30_000;

/** LRU bound on the number of entry files kept in the cache dir. */
export const DEFAULT_MAX_ENTRIES = 1_000;

/** Entry files live in `<cache-dir>/<64-hex-sha256>.json`. */
const ENTRY_FILE_RE = /^[0-9a-f]{64}\.json$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReadCacheOptions {
  /** Cache root dir override (default: XDG `~/.cache/wl`). Tests use this. */
  cacheDir?: string;
  /** TTL in ms (default 30_000). */
  ttlMs?: number;
  /** Max entry files before LRU purge (default 1_000). */
  maxEntries?: number;
  /** Injectable clock for TTL/LRU tests (default `Date.now`). */
  now?: () => number;
  /** Version string included in the cache key (default `WORKLOG_VERSION`). */
  version?: string;
}

/**
 * mtime+size snapshot of the WAL-mode SQLite files for a worklog dir.
 * Each pair is `[mtimeMs, size]`; missing files fingerprint as `[0, 0]`.
 */
export interface DbFingerprint {
  /** worklog.db — rewritten on WAL checkpoint */
  db: [number, number];
  /** worklog.db-wal — grows/shrinks on every write commit */
  wal: [number, number];
  /** worklog.db-shm — shared-memory index, touched on connections */
  shm: [number, number];
}

/** A single cache entry: header (key + freshness metadata) + cached value. */
interface CacheEntry {
  key: string;
  worklogDir: string;
  argv: string[];
  version: string;
  dbFingerprint: DbFingerprint;
  createdAt: number;
  accessedAt: number;
  value: unknown;
}

// ---------------------------------------------------------------------------
// Path + key helpers
// ---------------------------------------------------------------------------

/** The WAL-mode SQLite files that make up the DB state for a worklog dir. */
export function dbFilesForWorklogDir(worklogDir: string): { db: string; wal: string; shm: string } {
  return {
    db: path.join(worklogDir, 'worklog.db'),
    wal: path.join(worklogDir, 'worklog.db-wal'),
    shm: path.join(worklogDir, 'worklog.db-shm'),
  };
}

function statPair(p: string): [number, number] {
  try {
    const st = fs.statSync(p);
    return [st.mtimeMs, st.size];
  } catch {
    return [0, 0];
  }
}

/**
 * WAL-aware DB-state fingerprint for a worklog dir.
 *
 * `worklog.db` mtime alone is unreliable in WAL mode (writes land in the WAL,
 * and the main file only changes on checkpoint), so we fingerprint all three
 * files: db + `-wal` + `-shm`. A fingerprint mismatch on read invalidates the
 * entry. Missing files fingerprint as zeros, so a DB that is later created
 * (files appear) also invalidates.
 */
export function computeDbFingerprint(worklogDir: string): DbFingerprint {
  const { db, wal, shm } = dbFilesForWorklogDir(worklogDir);
  return { db: statPair(db), wal: statPair(wal), shm: statPair(shm) };
}

/** Structural equality for fingerprints. */
export function fingerprintsEqual(a: DbFingerprint, b: DbFingerprint): boolean {
  return (
    a.db[0] === b.db[0] &&
    a.db[1] === b.db[1] &&
    a.wal[0] === b.wal[0] &&
    a.wal[1] === b.wal[1] &&
    a.shm[0] === b.shm[0] &&
    a.shm[1] === b.shm[1]
  );
}

/**
 * Resolve the read-cache directory.
 *
 * Precedence: `WL_CACHE_DIR` (explicit override, e.g. tests) → XDG cache home
 * (`$XDG_CACHE_HOME/wl`) → `~/.cache/wl`.
 */
export function resolveCacheDir(): string {
  const override = process.env.WL_CACHE_DIR;
  if (override) return path.resolve(override);
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() !== '' ? path.resolve(xdg) : path.join(os.homedir(), '.cache');
  return path.join(base, 'wl');
}

/**
 * Deterministic cache key: SHA-256 over (wl version, resolved worklog dir,
 * argv elements in order). Includes the wl version so a binary upgrade with a
 * changed output schema never serves stale-shaped entries.
 */
export function deriveCacheKey(worklogDir: string, argv: string[], version: string): string {
  const hash = createHash('sha256');
  hash.update(version);
  hash.update('\0');
  hash.update(path.resolve(worklogDir));
  for (const arg of argv) {
    hash.update('\0');
    hash.update(arg);
  }
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// ReadCache
// ---------------------------------------------------------------------------

/** Emit a debug line to stderr when `WL_CACHE_DEBUG` is set. */
function debugLog(...args: unknown[]): void {
  if (process.env.WL_CACHE_DEBUG) {
    process.stderr.write(`[wl:cache] ${args.map(String).join(' ')}\n`);
  }
}

export class ReadCache {
  private readonly cacheDir: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly version: string;
  private hits = 0;
  private misses = 0;

  constructor(options: ReadCacheOptions = {}) {
    this.cacheDir = options.cacheDir ? path.resolve(options.cacheDir) : resolveCacheDir();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
    this.version = options.version ?? WORKLOG_VERSION;
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  /** Cache key for a (worklog-dir, argv) pair under this cache's version. */
  keyFor(worklogDir: string, argv: string[]): string {
    return deriveCacheKey(worklogDir, argv, this.version);
  }

  /** Hit/miss counters — used by spawn-reduction instrumentation (F2). */
  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  /**
   * Read a cached value for (worklog-dir, argv).
   *
   * Returns the cached JSON value on a hit, or `null` on a miss. A miss
   * happens when the entry is absent, corrupt, header-mismatched, TTL-expired,
   * or when the WAL-aware DB fingerprint no longer matches (a write happened).
   * Stale/corrupt entries are removed as a side effect.
   */
  get(worklogDir: string, argv: string[]): unknown | null {
    const dir = path.resolve(worklogDir);
    const key = this.keyFor(dir, argv);
    const entryPath = this.entryPath(key);

    let raw: string;
    try {
      raw = fs.readFileSync(entryPath, 'utf-8');
    } catch {
      this.misses++;
      return null;
    }

    let entry: CacheEntry;
    try {
      entry = JSON.parse(raw) as CacheEntry;
    } catch {
      debugLog(`corrupt entry ${key}; removing`);
      this.removeFile(entryPath);
      this.misses++;
      return null;
    }

    // Header invariants: key, version, argv and worklog dir must all match.
    if (
      entry.key !== key ||
      entry.version !== this.version ||
      !arraysEqual(entry.argv, argv) ||
      path.resolve(entry.worklogDir) !== dir
    ) {
      debugLog(`header mismatch for ${key}; removing`);
      this.removeFile(entryPath);
      this.misses++;
      return null;
    }

    const now = this.now();

    // TTL bounding safety net.
    if (now - entry.createdAt > this.ttlMs) {
      debugLog(`ttl expired for ${key}; removing`);
      this.removeFile(entryPath);
      this.misses++;
      return null;
    }

    // WAL-aware freshness: any change to db/-wal/-shm invalidates.
    const fp = computeDbFingerprint(dir);
    if (!fingerprintsEqual(fp, entry.dbFingerprint)) {
      debugLog(`db state changed for ${key}; removing`);
      this.removeFile(entryPath);
      this.misses++;
      return null;
    }

    // Hit. Refresh the access time (LRU ordering) without churning when the
    // clock has not advanced (rapid repeat queries within the same ms).
    this.hits++;
    if (now !== entry.accessedAt) {
      entry.accessedAt = now;
      this.safeAtomicWrite(entryPath, entry);
    }
    return entry.value;
  }

  /**
   * Store a JSON value for (worklog-dir, argv).
   *
   * The DB fingerprint is captured at write time; a later DB change makes the
   * entry stale on read. Writes are atomic (temp file + rename).
   *
   * Callers that read the DB to produce `value` may pass a fingerprint they
   * captured BEFORE the read (options.dbFingerprint); the entry is then only
   * consistent with that state. `set()` does not re-verify, so the caller
   * should skip caching (or re-check) if the DB changed mid-query.
   */
  set(worklogDir: string, argv: string[], value: unknown, options?: { dbFingerprint?: DbFingerprint }): void {
    const dir = path.resolve(worklogDir);
    const key = this.keyFor(dir, argv);
    const now = this.now();
    const entry: CacheEntry = {
      key,
      worklogDir: dir,
      argv: [...argv],
      version: this.version,
      dbFingerprint: options?.dbFingerprint ?? computeDbFingerprint(dir),
      createdAt: now,
      accessedAt: now,
      value,
    };
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.atomicWrite(this.entryPath(key), entry);
    this.purgeIfNeeded(now);
  }

  /**
   * Remove every entry belonging to a worklog dir (used after writes/sync).
   * Returns the number of entries removed.
   */
  invalidate(worklogDir: string): number {
    const dir = path.resolve(worklogDir);
    let removed = 0;
    for (const entryPath of this.listEntryPaths()) {
      try {
        const entry = JSON.parse(fs.readFileSync(entryPath, 'utf-8')) as CacheEntry;
        if (path.resolve(entry.worklogDir) === dir && this.removeFile(entryPath)) removed++;
      } catch {
        // Unparseable entries are not attributed to a dir; leave for get()/purge.
      }
    }
    return removed;
  }

  /** Remove all cache entries. Returns the number removed. */
  clear(): number {
    let removed = 0;
    for (const entryPath of this.listEntryPaths()) {
      if (this.removeFile(entryPath)) removed++;
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private entryPath(key: string): string {
    return path.join(this.cacheDir, `${key}.json`);
  }

  private listEntryPaths(): string[] {
    try {
      return fs
        .readdirSync(this.cacheDir)
        .filter((f) => ENTRY_FILE_RE.test(f))
        .map((f) => path.join(this.cacheDir, f));
    } catch {
      return [];
    }
  }

  /** Atomic write: temp file + rename so readers never see partial data. */
  private atomicWrite(target: string, entry: CacheEntry): void {
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
    try {
      fs.renameSync(tmp, target);
    } catch (err: any) {
      if (err && (err.code === 'EEXIST' || err.code === 'EPERM')) {
        // Windows cannot rename over an existing file — unlink then retry.
        try {
          fs.unlinkSync(target);
        } catch {
          /* ignore */
        }
        try {
          fs.renameSync(tmp, target);
        } catch (err2) {
          this.removeFile(tmp);
          throw err2;
        }
      } else {
        this.removeFile(tmp);
        throw err;
      }
    }
  }

  /** Best-effort atomic write (used for LRU touch on hit — never fails reads). */
  private safeAtomicWrite(target: string, entry: CacheEntry): void {
    try {
      this.atomicWrite(target, entry);
    } catch (err) {
      debugLog(`failed to touch ${target}: ${(err as Error).message}`);
    }
  }

  /** Remove a file, ignoring missing-file errors. Returns true if removed. */
  private removeFile(p: string): boolean {
    try {
      fs.unlinkSync(p);
      return true;
    } catch (err: any) {
      if (err && err.code === 'ENOENT') return false;
      debugLog(`failed to remove ${p}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Keep the cache bounded: evict TTL-expired entries and, if still over the
   * max-entry bound, evict least-recently-accessed entries. Only runs when the
   * entry count exceeds `maxEntries`, so the header-parsing cost is bounded
   * and rare.
   */
  private purgeIfNeeded(now: number): void {
    const entries = this.listEntryPaths();
    if (entries.length <= this.maxEntries) return;

    const parsed = entries.map((p): { file: string; accessedAt: number; createdAt: number } => {
      try {
        const h = JSON.parse(fs.readFileSync(p, 'utf-8')) as CacheEntry;
        return { file: p, accessedAt: h.accessedAt ?? 0, createdAt: h.createdAt ?? 0 };
      } catch {
        // Unparseable entries sort as oldest → evicted first.
        return { file: p, accessedAt: 0, createdAt: 0 };
      }
    });

    // Pass 1: drop TTL-expired entries.
    for (const p of parsed) {
      if (now - p.createdAt > this.ttlMs) this.removeFile(p.file);
    }

    // Pass 2: LRU eviction until at (or under) the bound.
    const remaining = this.listEntryPaths();
    if (remaining.length <= this.maxEntries) return;
    const alive = new Set(remaining);
    const sorted = parsed.filter((p) => alive.has(p.file)).sort((a, b) => a.accessedAt - b.accessedAt);
    let toRemove = sorted.length - this.maxEntries;
    for (const p of sorted) {
      if (toRemove <= 0) break;
      if (this.removeFile(p.file)) toRemove--;
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
