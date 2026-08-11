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
/** Bounding safety net: entries older than this are never served (30s). */
export declare const DEFAULT_TTL_MS = 30000;
/** LRU bound on the number of entry files kept in the cache dir. */
export declare const DEFAULT_MAX_ENTRIES = 1000;
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
    /**
     * Custom DB-state fingerprint provider (default: WAL-aware file snapshot).
     *
     * The wl CLI (F2) uses a stable counter-based fingerprint instead: the
     * SQLite files are rewritten by the app on every open/close cycle
     * (`journal_mode = WAL` + schema init touch the header), so file-based
     * fingerprints are not stable across processes. The counter is monotonic
     * per worklog dir and bumped on every write, so it is stable across reads
     * yet changes exactly when the data does.
     */
    fingerprint?: (worklogDir: string) => DbFingerprint;
}
/**
 * Snapshot of the DB state for a worklog dir.
 *
 * The file-pair fields capture the WAL-mode SQLite files (default provider;
 * `[mtimeMs, size]` per file, `[0, 0]` when missing). The optional
 * `stateCounter` field is the F2 CLI fingerprint: a monotonic per-worklog-dir
 * write counter stored in the cache dir (see `bumpStateCounter`).
 */
export interface DbFingerprint {
    /** worklog.db — rewritten on WAL checkpoint */
    db: [number, number];
    /** worklog.db-wal — grows/shrinks on every write commit */
    wal: [number, number];
    /** worklog.db-shm — shared-memory index, touched on connections */
    shm: [number, number];
    /** F2 CLI fingerprint: monotonic per-worklog-dir write counter. */
    stateCounter?: number;
}
/** The WAL-mode SQLite files that make up the DB state for a worklog dir. */
export declare function dbFilesForWorklogDir(worklogDir: string): {
    db: string;
    wal: string;
    shm: string;
};
/**
 * WAL-aware DB-state fingerprint for a worklog dir.
 *
 * `worklog.db` mtime alone is unreliable in WAL mode (writes land in the WAL,
 * and the main file only changes on checkpoint), so we fingerprint all three
 * files: db + `-wal` + `-shm`. A fingerprint mismatch on read invalidates the
 * entry. Missing files fingerprint as zeros, so a DB that is later created
 * (files appear) also invalidates.
 */
export declare function computeDbFingerprint(worklogDir: string): DbFingerprint;
/** Structural equality for fingerprints. */
export declare function fingerprintsEqual(a: DbFingerprint, b: DbFingerprint): boolean;
/** Path of the per-worklog-dir state counter file within a cache dir. */
export declare function stateCounterFilePath(cacheDir: string, worklogDir: string): string;
/**
 * Read the monotonic write-counter for a worklog dir (0 when absent — a
 * fresh cache dir means no writes have been observed, which is the safe
 * baseline for entries written from the same counter value).
 */
export declare function readStateCounter(cacheDir: string, worklogDir: string): number;
/**
 * Atomically increment the per-worklog-dir write counter. Returns the new
 * value. Concurrent increments may coalesce (both write N+1) but can never
 * regress the counter, which is all freshness checking needs.
 */
export declare function bumpStateCounter(cacheDir: string, worklogDir: string): number;
/**
 * The F2 CLI fingerprint: file fields are inert, `stateCounter` carries the
 * per-worklog-dir write counter.
 */
export declare function counterFingerprint(cacheDir: string, worklogDir: string): DbFingerprint;
/**
 * Resolve the read-cache directory.
 *
 * Precedence: `WL_CACHE_DIR` (explicit override, e.g. tests) → XDG cache home
 * (`$XDG_CACHE_HOME/wl`) → `~/.cache/wl`.
 */
export declare function resolveCacheDir(): string;
/**
 * Deterministic cache key: SHA-256 over (wl version, resolved worklog dir,
 * argv elements in order). Includes the wl version so a binary upgrade with a
 * changed output schema never serves stale-shaped entries.
 */
export declare function deriveCacheKey(worklogDir: string, argv: string[], version: string): string;
export declare class ReadCache {
    private readonly cacheDir;
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly now;
    private readonly version;
    private readonly fingerprint;
    private hits;
    private misses;
    constructor(options?: ReadCacheOptions);
    getCacheDir(): string;
    /** DB-state fingerprint for a worklog dir under this cache's provider. */
    fingerprintFor(worklogDir: string): DbFingerprint;
    /** Cache key for a (worklog-dir, argv) pair under this cache's version. */
    keyFor(worklogDir: string, argv: string[]): string;
    /** Hit/miss counters — used by spawn-reduction instrumentation (F2). */
    stats(): {
        hits: number;
        misses: number;
    };
    /**
     * Read a cached value for (worklog-dir, argv).
     *
     * Returns the cached JSON value on a hit, or `null` on a miss. A miss
     * happens when the entry is absent, corrupt, header-mismatched, TTL-expired,
     * or when the WAL-aware DB fingerprint no longer matches (a write happened).
     * Stale/corrupt entries are removed as a side effect.
     */
    get(worklogDir: string, argv: string[]): unknown | null;
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
    set(worklogDir: string, argv: string[], value: unknown, options?: {
        dbFingerprint?: DbFingerprint;
    }): void;
    /**
     * Remove every entry belonging to a worklog dir (used after writes/sync).
     * Returns the number of entries removed.
     */
    invalidate(worklogDir: string): number;
    /** Remove all cache entries. Returns the number removed. */
    clear(): number;
    private entryPath;
    private listEntryPaths;
    /** Atomic write: temp file + rename so readers never see partial data. */
    private atomicWrite;
    /** Best-effort atomic write (used for LRU touch on hit — never fails reads). */
    private safeAtomicWrite;
    /** Remove a file, ignoring missing-file errors. Returns true if removed. */
    private removeFile;
    /**
     * Keep the cache bounded: evict TTL-expired entries and, if still over the
     * max-entry bound, evict least-recently-accessed entries. Only runs when the
     * entry count exceeds `maxEntries`, so the header-parsing cost is bounded
     * and rare.
     */
    private purgeIfNeeded;
}
//# sourceMappingURL=read-cache.d.ts.map