/**
 * Env-gated spawn instrumentation (F2 — WL-0MSGAEC5N006W5QA,
 * CPU/RSS extension — WL-0MVFRR98A008MM19).
 *
 * Records `wl` process spawns so the herdr refresh spawn-reduction target
 * (parent AC7: ≥60%) can be measured. A "work spawn" is a `wl` process that
 * performed real read work (a read-cache miss); cache-hit processes exit
 * without touching the DB and are recorded with a distinct kind.
 *
 * Each record also carries the process' own CPU time and peak RSS, so a
 * coordinator can total CPU-seconds per refresh cycle (parent AC2) and read
 * per-process peak memory (parent AC1) without an external sampler.
 *
 * Configuration:
 *   - `WL_SPAWN_COUNT_FILE=<path>` — append one
 *     `<kind>\t<ts>\t<pid>\t<cpuMs>\t<maxRssKb>` line per recorded spawn
 *     (append-only, so concurrent processes never corrupt each other's
 *     records). Legacy three-field lines (`<kind>\t<ts>\t<pid>`) are still
 *     read, with CPU/RSS reported as `null`.
 *   - `WL_SPAWN_COUNT=1` (without a file) — log
 *     `[wl:spawn] <kind> <pid> cpuMs=<n> maxRssKb=<n>` lines to stderr.
 *
 * CPU time is sampled with `process.resourceUsage()` at record time, i.e. it
 * is the CPU consumed from process start to the instrumentation point. The
 * instrumentation point is the same for baseline and cache-enabled runs, so
 * comparisons are like-for-like.
 *
 * Instrumentation is best-effort and must never break the CLI.
 */

import * as fs from 'fs';

/**
 * A single recorded spawn: kind, wall-clock timestamp, process pid, plus the
 * process' CPU time (user+system, milliseconds) and peak RSS (KiB).
 *
 * `cpuMs`/`maxRssKb` are `null` for legacy three-field records and whenever
 * the platform cannot report them — never `0`, so aggregation cannot silently
 * under-report.
 */
export interface SpawnRecord {
  kind: string;
  ts: number;
  pid: number;
  cpuMs: number | null;
  maxRssKb: number | null;
}

/** Aggregated view of a spawn-count file. */
export interface SpawnSummary {
  /** Number of records in the file. */
  total: number;
  /** Record counts keyed by kind (e.g. `read-work`, `cache-hit`). */
  byKind: Record<string, number>;
  /** Total CPU-seconds across records that reported CPU time. */
  cpuSeconds: number;
  /** Peak RSS (KiB) across records that reported it (`null` when none do). */
  maxRssKb: number | null;
  /** Records with no CPU data (legacy lines) — makes under-reporting visible. */
  missingCpu: number;
  /** Records with no RSS data (legacy lines). */
  missingRss: number;
}

/** Sample this process' CPU time (ms) and peak RSS (KiB); never throws. */
function snapshotUsage(): { cpuMs: number | null; maxRssKb: number | null } {
  try {
    // Node reports userCPUTime/systemCPUTime in microseconds, maxRSS in KiB.
    const usage = process.resourceUsage();
    const micros = usage.userCPUTime + usage.systemCPUTime;
    return {
      cpuMs: Number.isFinite(micros) ? Math.round(micros / 1000) : null,
      maxRssKb: Number.isFinite(usage.maxRSS) ? usage.maxRSS : null,
    };
  } catch {
    return { cpuMs: null, maxRssKb: null };
  }
}

/** Render an optional numeric field: unknown values become an empty field. */
function field(value: number | null): string {
  return value === null ? '' : String(value);
}

/** Parse an optional numeric field; blank/absent/invalid becomes `null`. */
function optionalNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
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
      const { cpuMs, maxRssKb } = snapshotUsage();
      const line = `${kind}\t${Date.now()}\t${process.pid}\t${field(cpuMs)}\t${field(maxRssKb)}\n`;
      fs.appendFileSync(file, line, 'utf-8');
    } catch {
      // Ignore: instrumentation must never break the CLI.
    }
    return;
  }
  if (process.env.WL_SPAWN_COUNT) {
    const { cpuMs, maxRssKb } = snapshotUsage();
    process.stderr.write(
      `[wl:spawn] ${kind} ${process.pid} cpuMs=${cpuMs === null ? 'unknown' : cpuMs} ` +
        `maxRssKb=${maxRssKb === null ? 'unknown' : maxRssKb}\n`
    );
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
    const [kind, ts, pid, cpuMs, maxRssKb] = line.split('\t');
    if (kind === undefined) continue;
    records.push({
      kind,
      ts: Number(ts) || 0,
      pid: Number(pid) || 0,
      cpuMs: optionalNumber(cpuMs),
      maxRssKb: optionalNumber(maxRssKb),
    });
  }
  return records;
}

/** Count recorded spawns, optionally filtered by kind. */
export function countSpawnRecords(file: string, kind?: string): number {
  const records = readSpawnRecords(file);
  if (kind === undefined) return records.length;
  return records.filter((r) => r.kind === kind).length;
}

/**
 * Aggregate a spawn-count file: total records, per-kind counts, total
 * CPU-seconds and the peak RSS observed.
 *
 * Records without CPU/RSS data (legacy three-field lines) contribute nothing
 * to the totals but are counted in `missingCpu`/`missingRss`, so an
 * aggregation can never silently under-report.
 */
export function summariseSpawnRecords(file: string): SpawnSummary {
  const records = readSpawnRecords(file);
  const byKind: Record<string, number> = {};
  let cpuMs = 0;
  let maxRssKb: number | null = null;
  let missingCpu = 0;
  let missingRss = 0;

  for (const rec of records) {
    byKind[rec.kind] = (byKind[rec.kind] ?? 0) + 1;
    if (rec.cpuMs === null) missingCpu += 1;
    else cpuMs += rec.cpuMs;
    if (rec.maxRssKb === null) missingRss += 1;
    else if (maxRssKb === null || rec.maxRssKb > maxRssKb) maxRssKb = rec.maxRssKb;
  }

  return {
    total: records.length,
    byKind,
    cpuSeconds: Math.round(cpuMs) / 1000,
    maxRssKb,
    missingCpu,
    missingRss,
  };
}
