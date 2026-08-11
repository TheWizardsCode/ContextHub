/**
 * Env-gated spawn instrumentation (F2 — WL-0MSGAEC5N006W5QA).
 *
 * Records `wl` process spawns so the herdr refresh spawn-reduction target
 * (parent AC7: ≥60%) can be measured. A "work spawn" is a `wl` process that
 * performed real read work (a read-cache miss); cache-hit processes exit
 * without touching the DB and are recorded with a distinct kind.
 *
 * Configuration:
 *   - `WL_SPAWN_COUNT_FILE=<path>` — append one `<kind>\t<ts>\t<pid>` line
 *     per recorded spawn (append-only, so concurrent processes never corrupt
 *     each other's records).
 *   - `WL_SPAWN_COUNT=1` (without a file) — log `[wl:spawn] <kind> <pid>`
 *     lines to stderr.
 *
 * Instrumentation is best-effort and must never break the CLI.
 */
/** A single recorded spawn: kind, wall-clock timestamp, process pid. */
export interface SpawnRecord {
    kind: string;
    ts: number;
    pid: number;
}
/**
 * Record one spawn (or cache-hit) observation.
 *
 * No-op unless `WL_SPAWN_COUNT_FILE` or `WL_SPAWN_COUNT` is set. Never
 * throws — instrumentation must not break command execution.
 */
export declare function recordSpawn(kind: string): void;
/** Parse a spawn-count file back into records (for tests and reports). */
export declare function readSpawnRecords(file: string): SpawnRecord[];
/** Count recorded spawns, optionally filtered by kind. */
export declare function countSpawnRecords(file: string, kind?: string): number;
//# sourceMappingURL=spawn-counter.d.ts.map