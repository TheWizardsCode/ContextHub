/**
 * bench/start-on-filter-baseline.ts — the pre-`startOn`-filter latency baseline
 * for `list` / `search` / `next` (WL-0MWMGEL5R003IH71, parent
 * WL-0MWM0FDZK007BAD0, AC9).
 *
 * ## Why this exists
 *
 * The `startOn` epic adds a temporal predicate to every CLI search surface and
 * requires `list` / `search` / `next` to stay within the existing benchmarks
 * (parent AC9). Slice 1 records the **before** figures so slice 4's default
 * filter and slice 2's index have something honest to be compared with, and
 * slice 7 can publish a before/after pair rather than a single unattributed
 * number.
 *
 * ## Method
 *
 * - **Store**: `generateLargeWorklog(LARGE_DB_PROFILES[profile])` — the
 *   existing large-DB harness fixture (`packages/herdr/test/perf/large-db-
 *   harness.ts`): a throwaway temp `.worklog`, deterministic seed, real SQLite
 *   schema, nested parent/child subtrees, dependency edges, comments and the
 *   FTS index. `full` is the epic's real scale (~2,600 items / ~100 MB).
 * - **Measured in-process** at the exact entry points the CLI commands call,
 *   so a sample is the query cost rather than process startup (startup has its
 *   own budget, `tests/cli/startup-import-budget.test.ts`):
 *     - `list`   → `db.list({})` — `src/commands/list.ts`
 *     - `search` → `db.search('refresh', { limit: 20 })` — `src/commands/search.ts`
 *     - `next`   → `selectBrowseFeed(db, { count: browseCount })` —
 *                  `src/commands/next.ts` (the shared browse feed)
 * - **Store row cache disabled** (`WL_CACHE_ENABLED=0`, read by the store at
 *   construction): a fresh `wl` process starts with an empty cache, so a warm
 *   in-process cache hit (0.01 ms for `list`) would flatter the numbers rather
 *   than describe an invocation. Every sample is therefore a real cold read.
 * - **FTS index rebuilt before measuring.** The fixture's bulk JSONL import
 *   bypasses the FTS triggers, so `worklog_fts` is empty after generation
 *   (verified: `select count(*) from worklog_fts` → 0). Measuring `search`
 *   against an empty index would report the cost of finding nothing, so the
 *   bench rebuilds it exactly as `wl search --rebuild-index` does and records
 *   the rebuild cost separately (it is not part of a search sample).
 * - Plus the two filter shapes slice 4 adds over today's store (every item
 *   still resolves to `createdAt`, exactly as a back-filled `startOn` will):
 *     - `filter pass`   → the `isNotStarted(item, now)` predicate over an
 *                         already-materialised item array (pure predicate cost);
 *     - `list + filter` → `db.list({}).filter(…)`, the composed call shape.
 * - One discarded warmup per surface, then `--runs` samples; median and p95
 *   (nearest-rank) are reported alongside every raw sample, with the result
 *   count so a row can never be read as "latency of returning nothing".
 *
 * Usage:
 *
 *   npm run benchmark:start-on-filter                       # full profile, text
 *   npm run benchmark:start-on-filter:json                  # machine-readable
 *   npx tsx bench/start-on-filter-baseline.ts --profile default --runs 9 --json
 *
 * Options:
 *
 *   --profile default|full  Fixture size (default `full` — the epic's scale).
 *   --runs N                Measured samples per surface (default 7, min 3).
 *   --now <ISO-8601>        The `now` the predicate filter compares against
 *                           (default: the instant the run starts; recorded in
 *                           the report).
 *   --json                  Machine-readable report on stdout.
 *   --keep                  Keep the generated fixture directory.
 *
 * Recorded baseline: `docs/benchmarks/start_on_filter_baseline.md`.
 */

import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  LARGE_DB_PROFILES,
  generateLargeWorklog,
  percentile,
  type LargeDbFixture,
  type LargeDbProfileName,
} from '../packages/herdr/test/perf/large-db-harness.js';
import { WorklogDatabase } from '../src/database.js';
import { selectBrowseFeed } from '../src/worklist-selection.js';
import { isNotStarted } from '@worklog/shared/predicates';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** The FTS term the `search` surface runs — a fixture filler word. */
export const SEARCH_TERM = 'refresh';

/** The `search` result limit, mirroring `wl search`'s default. */
export const SEARCH_LIMIT = 20;

/** One measured surface: repeated runs of a single read. */
export interface SurfaceResult {
  /** Stable surface name (`list`, `search`, `next`, `list+filter`). */
  surface: string;
  /** One line describing exactly what was called. */
  call: string;
  /** Rows returned by the last sample (so latency has a denominator). */
  resultCount: number;
  /** Every measured sample in milliseconds, in run order. */
  samplesMs: number[];
  /** Median sample (ms). */
  medianMs: number;
  /** Nearest-rank p95 sample (ms). */
  p95Ms: number;
  /** Fastest sample (ms). */
  minMs: number;
  /** Slowest sample (ms). */
  maxMs: number;
}

/** A full baseline run. */
export interface StartOnFilterBaselineReport {
  capturedAt: string;
  /** The `now` the predicate filter compared against. */
  nowIso: string;
  profile: LargeDbProfileName;
  runs: number;
  store: {
    items: number;
    dependencyEdges: number;
    dbSizeMb: number;
    diskSizeMb: number;
    generationMs: number;
    /** Documents (items + comments) indexed by the pre-measurement FTS rebuild. */
    ftsIndexed: number;
    /** Wall time of that one-off rebuild (ms) — fixture preparation, not a sample. */
    ftsRebuildMs: number;
  };
  host: {
    platform: string;
    release: string;
    cpus: number;
    loadAverage1m: number;
    loadAverage5m: number;
    totalMemMb: number;
    node: string;
    commit: string;
  };
  surfaces: SurfaceResult[];
}

/** Options for {@link runStartOnFilterBaseline}. */
export interface StartOnFilterBaselineOptions {
  /** Fixture profile (default `full`). */
  profile?: LargeDbProfileName;
  /** Measured samples per surface (default 7, min 3). */
  runs?: number;
  /** Comparison instant as ISO-8601 (default: the run start). */
  now?: string;
  /** Keep the generated fixture directory for inspection. */
  keep?: boolean;
}

/** Round to two decimals — latency figures do not need more. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Summarise the samples of one surface. */
function summarise(surface: string, call: string, samplesMs: number[], resultCount: number): SurfaceResult {
  return {
    surface,
    call,
    resultCount,
    samplesMs: samplesMs.map(round2),
    medianMs: round2(percentile(samplesMs, 0.5) ?? 0),
    p95Ms: round2(percentile(samplesMs, 0.95) ?? 0),
    minMs: round2(Math.min(...samplesMs)),
    maxMs: round2(Math.max(...samplesMs)),
  };
}

/**
 * Time `fn` on a warm store: one discarded warmup, then `runs` samples.
 *
 * Synchronous by construction (better-sqlite3 is synchronous), so no async
 * scheduling noise enters a sample.
 */
function measure(
  surface: string,
  call: string,
  runs: number,
  fn: () => { count: number },
): SurfaceResult {
  fn(); // discarded warmup — see the module docblock
  const samplesMs: number[] = [];
  let count = 0;
  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    count = fn().count;
    samplesMs.push(performance.now() - startedAt);
  }
  return summarise(surface, call, samplesMs, count);
}

/** Current git commit, or `unknown` outside a checkout. */
function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Open the fixture exactly as the CLI would: SQLite is the runtime source of
 * truth, and the JSONL path stays inside the temp `.worklog` so a stray
 * snapshot can never be re-imported (the fixture deletes it after generation).
 */
function openFixture(fixture: LargeDbFixture): WorklogDatabase {
  const jsonlPath = path.join(fixture.worklogDir, 'worklog-data.jsonl');
  return new WorklogDatabase('LDB', fixture.dbPath, jsonlPath, true, false);
}

/**
 * Run the baseline and return the report.
 *
 * Never throws for a merely slow run — this is a recorder, not a gate. The
 * slice-4/slice-7 comparisons are made against the recorded figures.
 */
export function runStartOnFilterBaseline(
  options: StartOnFilterBaselineOptions = {},
): StartOnFilterBaselineReport {
  const profile: LargeDbProfileName = options.profile ?? 'full';
  const runs = Math.max(3, options.runs ?? 7);
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) {
    throw new Error(`--now must be a valid ISO-8601 instant (got '${options.now}')`);
  }

  // Read before the store is constructed: the CLI runs with an empty cache, so
  // the baseline must too (see the module docblock).
  process.env.WL_CACHE_ENABLED = '0';

  const scale = LARGE_DB_PROFILES[profile];
  const fixture = generateLargeWorklog(scale);
  const db = openFixture(fixture);
  try {
    const ftsStartedAt = performance.now();
    const fts = db.rebuildFtsIndex();
    const ftsRebuildMs = round2(performance.now() - ftsStartedAt);
    const snapshot = db.list({});

    const surfaces = [
      measure('list', 'db.list({})', runs, () => {
        const items = db.list({});
        return { count: items.length };
      }),
      measure('search', `db.search('${SEARCH_TERM}', { limit: ${SEARCH_LIMIT} })`, runs, () => {
        const { results } = db.search(SEARCH_TERM, { limit: SEARCH_LIMIT });
        return { count: results.length };
      }),
      measure('next', `selectBrowseFeed(db, { count: ${scale.browseCount} })`, runs, () => {
        const selection = selectBrowseFeed(db, { count: scale.browseCount });
        return { count: selection.items.length };
      }),
      measure('filter pass', 'items.filter(item => !isNotStarted(item, now))', runs, () => {
        const items = snapshot.filter((item) => !isNotStarted(item, nowMs));
        return { count: items.length };
      }),
      measure('list+filter', 'db.list({}).filter(item => !isNotStarted(item, now))', runs, () => {
        const items = db.list({}).filter((item) => !isNotStarted(item, nowMs));
        return { count: items.length };
      }),
    ];

    return {
      capturedAt: new Date().toISOString(),
      nowIso: new Date(nowMs).toISOString(),
      profile,
      runs,
      store: {
        items: fixture.itemCount,
        dependencyEdges: fixture.dependencyEdges,
        dbSizeMb: fixture.dbSizeMb,
        diskSizeMb: fixture.diskSizeMb,
        generationMs: fixture.generationMs,
        ftsIndexed: fts.indexed,
        ftsRebuildMs,
      },
      host: {
        platform: `${os.platform()} ${os.release()}`,
        cpus: os.cpus().length,
        loadAverage1m: round2(os.loadavg()[0]),
        loadAverage5m: round2(os.loadavg()[1]),
        totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
        node: process.version,
        commit: gitCommit(),
      },
      surfaces,
    };
  } finally {
    db.close();
    if (!options.keep) fixture.cleanup();
    else process.stdout.write(`fixture kept at ${fixture.rootDir}\n`);
  }
}

/** Render the report as a human-readable table. */
export function formatStartOnFilterBaseline(report: StartOnFilterBaselineReport): string {
  const lines = [
    '',
    '================================================',
    '  startOn pre-filter baseline (list / search / next)',
    '================================================',
    '',
    `  profile:  ${report.profile} — ${report.store.items} items, ${report.store.dbSizeMb} MB db, ` +
      `${report.store.diskSizeMb} MB on disk, ${report.store.dependencyEdges} dependency edges, ` +
      `${report.store.ftsIndexed} FTS docs (rebuilt in ${report.store.ftsRebuildMs} ms)`,
    `  captured: ${report.capturedAt} on ${report.host.platform} ` +
      `(${report.host.cpus} vCPU, load ${report.host.loadAverage1m}/${report.host.loadAverage5m}, ` +
      `${report.host.node})`,
    `  commit:   ${report.host.commit}`,
    `  runs:     ${report.runs} samples per surface (one warmup discarded), now = ${report.nowIso}`,
    '',
    '  surface        median      p95      min      max   results',
    '  ------------  -------  -------  -------  -------  --------',
  ];
  for (const surface of report.surfaces) {
    lines.push(
      `  ${surface.surface.padEnd(12)} ${`${surface.medianMs} ms`.padStart(8)} ` +
        `${`${surface.p95Ms} ms`.padStart(8)} ${`${surface.minMs} ms`.padStart(8)} ` +
        `${`${surface.maxMs} ms`.padStart(8)} ${String(surface.resultCount).padStart(9)}`,
    );
  }
  lines.push('', '  calls:', '');
  for (const surface of report.surfaces) {
    lines.push(`  - ${surface.surface}: ${surface.call}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Parse `--flag value` / boolean flags (no dependency on a CLI framework). */
export function parseBenchArgs(argv: string[]): StartOnFilterBaselineOptions & {
  json: boolean;
} {
  const options: StartOnFilterBaselineOptions & { json: boolean } = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string | undefined => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return undefined;
      index += 1;
      return next;
    };
    switch (arg) {
      case '--profile': {
        const raw = value();
        if (raw !== 'default' && raw !== 'full') {
          throw new Error(`--profile requires 'default' or 'full' (got '${raw ?? ''}')`);
        }
        options.profile = raw;
        break;
      }
      case '--runs': {
        const raw = value();
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 3) {
          throw new Error(`--runs requires an integer >= 3 (got '${raw ?? ''}')`);
        }
        options.runs = Math.floor(parsed);
        break;
      }
      case '--now':
        options.now = value();
        break;
      case '--json':
        options.json = true;
        break;
      case '--keep':
        options.keep = true;
        break;
      default:
        throw new Error(`unknown argument '${arg}'`);
    }
  }
  return options;
}

function main(): void {
  const options = parseBenchArgs(process.argv.slice(2));
  const report = runStartOnFilterBaseline(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatStartOnFilterBaseline(report));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`startOn filter baseline failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
