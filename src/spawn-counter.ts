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

import * as fs from 'fs';

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
export function recordSpawn(kind: string): void {
  const file = process.env.WL_SPAWN_COUNT_FILE;
  if (file) {
    try {
      fs.appendFileSync(file, `${kind}\t${Date.now()}\t${process.pid}\n`, 'utf-8');
    } catch {
      // Ignore: instrumentation must never break the CLI.
    }
    return;
  }
  if (process.env.WL_SPAWN_COUNT) {
    process.stderr.write(`[wl:spawn] ${kind} ${process.pid}\n`);
  }
}

/** Parse a spawn-count file back into records (for tests and reports). */
export function readSpawnRecords(file: string): SpawnRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const records: SpawnRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [kind, ts, pid] = line.split('\t');
    if (kind === undefined) continue;
    records.push({ kind, ts: Number(ts) || 0, pid: Number(pid) || 0 });
  }
  return records;
}

/** Count recorded spawns, optionally filtered by kind. */
export function countSpawnRecords(file: string, kind?: string): number {
  const records = readSpawnRecords(file);
  if (kind === undefined) return records.length;
  return records.filter((r) => r.kind === kind).length;
}
