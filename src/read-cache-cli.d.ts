/**
 * wl CLI read-cache wiring (F2 — WL-0MSGAEC5N006W5QA).
 *
 * Routes `list`, `next`, `show`, `search`, `status` (JSON mode only) through
 * the shared on-disk read cache so herdr panes / pi-agent polling don't
 * re-query the SQLite DB for byte-identical invocations.
 *
 * Fingerprint model (see read-cache.ts): the SQLite files are rewritten by
 * the app on every open/close (`journal_mode = WAL` + schema init touch the
 * header), so file-based fingerprints are not stable across processes. The
 * CLI therefore fingerprints DB state with a monotonic per-worklog-dir write
 * counter in the cache dir: stable across reads, bumped on every write.
 *
 * Orchestration model (see src/cli.ts for the hook wiring):
 *   1. preAction — for a cacheable read invocation, `lookup()` serves the
 *      cached payload (if fresh) or arms a backfill that records the state
 *      counter captured *before* the action reads the DB.
 *   2. post-output — the JSON payload each command emits via `output.json`
 *      is routed through `onJsonOutput()`, which stores it keyed by
 *      (worklog-dir, argv) only if the state counter is unchanged since the
 *      lookup (a concurrent write would have bumped it).
 *   3. write commands — `invalidateOnWrite()` bumps the state counter (and
 *      drops entry files), so no stale result can be served after a mutation.
 *   4. read write-byproducts (`next`'s auto re-sort) — `invalidateCacheForWrite()`
 *      bumps the counter when the byproduct lands (see src/commands/next.ts).
 *
 * The TTL safety net bounds staleness from writes the counter misses (e.g.
 * external tools writing the DB directly).
 */
/** Commands whose JSON output is a deterministic function of (DB state, argv). */
export declare const READ_CACHE_COMMANDS: ReadonlySet<string>;
/** True when the command is one of the read commands covered by the cache. */
export declare function isCacheableReadCommand(command: string): boolean;
/** True when the raw argv requests JSON output. */
export declare function argvIsJsonMode(argv: string[]): boolean;
/** True when the argv contains a flag that makes a read non-cacheable. */
export declare function hasNonCacheableReadFlags(argv: string[]): boolean;
/**
 * True when a (command, argv) invocation should be served from / backfilled
 * into the read cache. Requires a covered command, JSON mode, and no
 * write-byproduct / non-deterministic flags.
 */
export declare function shouldCacheReadInvocation(command: string, argv: string[]): boolean;
/** Canonical argv for cache keys: process.argv minus the node + script prefix. */
export declare function cacheKeyArgv(): string[];
/**
 * Extract the subcommand name from raw argv, skipping program-level options
 * and their values (`--json`, `--verbose`, `-F/--format <v>`, `--worklog-dir
 * <v>`, help/version flags). Returns null when no command token is found
 * (bare `wl`, `wl --json`, etc.).
 */
export declare function extractCommandFromArgv(argv: string[]): string | null;
/**
 * Invalidate the read cache after a write that happens outside the normal
 * write-command flow (e.g. `next`'s auto re-sort byproduct). Bumps the state
 * counter so every previously cached entry for the worklog dir goes stale.
 * Uses the env-resolved cache dir, so it is safe to call from command
 * modules that never constructed a ReadCacheCli.
 */
export declare function invalidateCacheForWrite(): void;
/**
 * Stateful cache orchestration for one CLI process: one shared cache, one
 * armed backfill at a time (a CLI process runs exactly one command).
 */
export declare class ReadCacheCli {
    private readonly cacheDir;
    private readonly cache;
    private backfill;
    constructor(options?: {
        ttlMs?: number;
        maxEntries?: number;
        cacheDir?: string;
    });
    /**
     * Attempt to serve a cacheable read from cache; otherwise arm a backfill.
     *
     * Returns `{ served: true, value }` when a fresh cached payload exists
     * (the caller prints it and exits without any DB work), or
     * `{ served: false }` otherwise (the command runs normally and its JSON
     * output is routed through `onJsonOutput()` for backfill).
     */
    lookup(command: string, argv: string[]): {
        served: boolean;
        value?: unknown;
    };
    /**
     * Route a produced JSON payload into the cache.
     *
     * Called from the wrapped `output.json`. Caches only when a backfill was
     * armed by `lookup()` AND the state counter is unchanged since then (a
     * mid-action write — e.g. `next`'s re-sort — means the payload is not
     * representative of a single stable DB state, so it is skipped).
     */
    onJsonOutput(data: unknown): void;
    /**
     * Drop every cached entry for the current worklog dir (after a write):
     * bumps the state counter (freshness) and removes entry files (tidiness).
     */
    invalidateOnWrite(): void;
    /** Hit/miss counters (spawn-reduction reporting). */
    stats(): {
        hits: number;
        misses: number;
    };
}
//# sourceMappingURL=read-cache-cli.d.ts.map