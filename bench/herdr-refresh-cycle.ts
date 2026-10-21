/**
 * Herdr refresh-cycle CPU measurement (F10 — WL-0MVFRRS2I000G93J).
 *
 * Reproduces the parent AC2 workload: **4 panes** sharing one worklog dir,
 * each running the herdr worklist query set once per refresh tick, for a
 * **30 s cycle**, with the F1 spawn instrumentation enabled. It reports total
 * CPU-seconds per cycle, spawn counts by kind (cache-hit / read-work /
 * version), p95 per-spawn wall time and peak RSS.
 *
 * The query set mirrors `packages/herdr/src/fetcher.ts` (the mandatory
 * subsets fetched on every refresh):
 *
 *   - `wl list --priority critical --status open,in-progress,blocked,completed --json`
 *   - `wl list --status completed,in-progress --stage in_review --root-only --json`
 *   - `wl list --status in-progress --root-only --json`
 *   - `wl list --status blocked --root-only --json`
 *   - `wl next -n 20 --json` (the browse feed)
 *
 * Since WL-0MVI0HH740065Z2T the harness accepts `--query-set legacy|consolidated`
 * (default `legacy`): `legacy` is the five-query set above (byte-identical to
 * F10, so the recorded numbers remain comparable), while `consolidated` runs
 * one `wl worklist --json` read per tick. The CLI vector for each set lives in
 * one place (`bench/worklist-query-sets.ts`) and is shared with the perf
 * harness and the tests — measured numbers for the two sets can therefore be
 * compared via `computeReduction(...)` against the F10-style legacy baseline
 * (parent AC3: ≤ 0.4× CPU, ideally ~5× fewer spawns).
 *
 * `wl worklist` itself lands in WL-0MVI0HX58009JJRF, so in C1 the
 * `consolidated` path is plumbing only: when the invocation is absent the
 * harness reports a clear "not available yet" diagnostic and exits 0, and
 * only exits non-zero when `--fail-if-unavailable` is passed explicitly.
 *
 * Usage (see the F10 work item for the recorded command lines):
 *
 *   npm run benchmark:herdr-refresh -- --json
 *   npm run benchmark:herdr-refresh -- --json --cli /path/to/dist/cli.js
 *   npm run benchmark:herdr-refresh -- --json --query-set consolidated
 *
 * `--cli` lets the same harness measure a *different* build (e.g. the pre-F4
 * worktree) so the before/after numbers describe the same workload on the same
 * host. `WL_CACHE_DISABLED=1` in the environment measures the no-cache
 * read-work baseline.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readSpawnRecords, type SpawnRecord } from '../src/spawn-counter.js';
import { parseWorklistQuerySet, worklistQueriesFor, WORKLIST_QUERY_SET_NAMES, type WorklistQuerySet } from './worklist-query-sets.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Options {
  cli: string;
  panes: number;
  cycleSeconds: number;
  tickSeconds: number;
  items: number;
  json: boolean;
  keep: boolean;
  querySet: WorklistQuerySet;
  /** Fail (exit 1) when the selected query set's invocation is unavailable. */
  failIfUnavailable: boolean;
}

/**
 * Parse harness options. Exported so the bench tests can pin the `--query-set`
 * selector plumbing without spawning the (slow) benchmark itself.
 */
export function parseOptions(argv: string[]): Options {
  const options: Options = {
    cli: path.join(repoRoot, 'dist', 'cli.js'),
    panes: 4,
    cycleSeconds: 30,
    tickSeconds: 5,
    items: 30,
    json: false,
    keep: false,
    querySet: 'legacy',
    failIfUnavailable: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--cli' && next) {
      options.cli = path.resolve(next);
      i++;
    } else if (arg === '--panes' && next) {
      options.panes = Math.max(1, Number(next));
      i++;
    } else if (arg === '--cycle-seconds' && next) {
      options.cycleSeconds = Math.max(1, Number(next));
      i++;
    } else if (arg === '--tick-seconds' && next) {
      options.tickSeconds = Math.max(0.5, Number(next));
      i++;
    } else if (arg === '--items' && next) {
      options.items = Math.max(0, Number(next));
      i++;
    } else if (arg === '--query-set') {
      if (!next || next.startsWith('--')) {
        throw new Error(
          `--query-set requires a value: ${WORKLIST_QUERY_SET_NAMES.join(', ')}`
        );
      }
      options.querySet = parseWorklistQuerySet(next);
      i++;
    } else if (arg === '--fail-if-unavailable') {
      options.failIfUnavailable = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--keep') {
      options.keep = true;
    }
  }
  return options;
}

/** Create a throwaway worklog dir with `items` seeded work items. */
function createFixture(cli: string, items: number): { dir: string; spawnFile: string; cacheDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-refresh-'));
  fs.mkdirSync(path.join(dir, '.worklog'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.worklog', 'initialized'),
    JSON.stringify({ version: '1.0.22', initializedAt: '2024-01-23T12:00:00.000Z' })
  );
  fs.writeFileSync(
    path.join(dir, '.worklog', 'config.json'),
    JSON.stringify({ projectName: 'Herdr Refresh', prefix: 'HF' })
  );

  const env = {
    ...process.env,
    WL_CACHE_DIR: path.join(dir, 'cache'),
    WL_TUI_MODE: '1',
    WL_SPAWN_COUNT_FILE: path.join(dir, 'spawns.log'),
  };
  for (let i = 0; i < items; i++) {
    const status = i % 5 === 0 ? 'in-progress' : i % 7 === 0 ? 'blocked' : 'open';
    const created = spawnSync(
      process.execPath,
      [cli, '--json', 'create', '-t', `Item ${i}`, '--status', status],
      { cwd: dir, env, encoding: 'utf-8', timeout: 60_000 }
    );
    if (created.status !== 0) {
      throw new Error(`fixture create failed: ${created.stderr}`);
    }
  }
  return {
    dir,
    spawnFile: path.join(dir, 'spawns.log'),
    cacheDir: path.join(dir, 'cache'),
  };
}

interface TickResult {
  wallMs: number;
  code: number | null;
}

/**
 * Run the selected query set once (as one pane refresh) and collect each
 * invocation's wall time and exit code.
 *
 * NOTE (WL-0MVI0HH740065Z2T): the query results MUST be returned — the
 * pre-existing implementation resolved a local array it never filled, so
 * `failures` was always 0 and p95 spawn wall time always null, which would
 * also hide a consolidated invocation that is not available yet.
 */
async function runTick(
  cli: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  queries: readonly (readonly string[])[]
): Promise<TickResult[]> {
  return Promise.all(
    queries.map(
      (args) =>
        new Promise<TickResult>((resolve) => {
          const started = process.hrtime.bigint();
          const child = spawn(process.execPath, [cli, ...args], {
            cwd,
            env,
            stdio: 'ignore',
          });
          child.on('error', () =>
            resolve({ wallMs: Number(process.hrtime.bigint() - started) / 1e6, code: null })
          );
          child.on('exit', (code) =>
            resolve({ wallMs: Number(process.hrtime.bigint() - started) / 1e6, code })
          );
        })
    )
  );
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function round(value: number | null, digits = 1): number | null {
  return value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(options.cli)) {
    throw new Error(`CLI not found: ${options.cli} (build the tree first: npm run build)`);
  }

  const queries = worklistQueriesFor(options.querySet);
  const { dir, spawnFile, cacheDir } = createFixture(options.cli, options.items);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WL_CACHE_DIR: cacheDir,
    WL_TUI_MODE: '1',
    WL_SPAWN_COUNT_FILE: spawnFile,
  };

  // Warm the cache with one full cycle before measuring (steady state).
  for (let i = 0; i < options.panes; i++)
    await runTick(options.cli, dir, env, queries);
  fs.rmSync(spawnFile, { force: true });

  const started = Date.now();

  const panes = await Promise.all(
    Array.from({ length: options.panes }, async () => {
      const deadline = Date.now() + options.cycleSeconds * 1000;
      const results: TickResult[] = [];
      let ticks = 0;
      while (Date.now() < deadline) {
        const tickStarted = Date.now();
        results.push(...(await runTick(options.cli, dir, env, queries)));
        ticks++;
        const elapsed = Date.now() - tickStarted;
        const waitMs = Math.max(0, options.tickSeconds * 1000 - elapsed);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      return { ticks, results };
    })
  );

  const ticksPerPane = panes.map((pane) => pane.ticks);
  const wallSamples = panes.flatMap((pane) => pane.results.map((r) => r.wallMs));
  const failures = panes.reduce(
    (sum, pane) => sum + pane.results.filter((r) => r.code !== 0).length,
    0
  );

  const elapsedMs = Date.now() - started;
  const records: SpawnRecord[] = fs.existsSync(spawnFile) ? readSpawnRecords(spawnFile) : [];

  const cpuMs = records.reduce((sum, r) => sum + (r.cpuMs ?? 0), 0);
  const byKind: Record<string, number> = {};
  for (const record of records) byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
  const rss = records
    .map((r) => (r.maxRssKb ?? 0) / 1024)
    .filter((value) => value > 0);

  const totalTicks = ticksPerPane.reduce((a, b) => a + b, 0);

  // A consolidated run whose only failure is the still-unimplemented `wl
  // worklist` invocation is NOT a harness failure: it is a clean "not
  // available yet" diagnostic (C1 plumbing). It only exits non-zero when
  // --fail-if-unavailable is passed explicitly.
  const availability = {
    available: options.querySet === 'legacy' ? true : failures === 0,
    diagnostic:
      options.querySet === 'consolidated' && failures > 0
        ? 'consolidated invocation `wl worklist --json` is not available in this build yet (implemented by WL-0MVI0HX58009JJRF); one invocation per tick was attempted and failed cleanly. Re-run with --query-set legacy for a comparable measurement.'
        : null,
  };

  const report = {
    cli: options.cli,
    host: os.hostname(),
    node: process.version,
    cacheDisabled: process.env.WL_CACHE_DISABLED === '1',
    panes: options.panes,
    cycleSeconds: options.cycleSeconds,
    tickSeconds: options.tickSeconds,
    items: options.items,
    querySet: options.querySet,
    elapsedSeconds: round(elapsedMs / 1000),
    spawns: records.length,
    spawnsByKind: byKind,
    ticksPerPane,
    queriesPerTick: queries.length,
    spawnsPerRefresh: totalTicks > 0 ? round(records.length / totalTicks) : null,
    cpuSeconds: round(cpuMs / 1000, 2),
    cpuSecondsPerSpawn: records.length > 0 ? round(cpuMs / 1000 / records.length, 3) : null,
    cpuSecondsPerPaneCycle:
      ticksPerPane.length > 0
        ? round(
            cpuMs /
              1000 /
              (ticksPerPane.reduce((a, b) => a + b, 0) || 1)
          )
        : null,
    p95SpawnWallMs: round(percentile(wallSamples, 95)),
    p50SpawnWallMs: round(percentile(wallSamples, 50)),
    peakRssMb: rss.length > 0 ? round(Math.max(...rss)) : null,
    failures,
    ...availability,
  };

  if (options.json) {
    console.log(JSON.stringify({ success: true, result: report }, null, 2));
  } else {
    console.log('Herdr refresh-cycle CPU measurement');
    console.log(`  cli:                  ${report.cli}`);
    console.log(`  panes / cycle:        ${report.panes} / ${report.cycleSeconds}s`);
    console.log(`  query set:            ${report.querySet} (${report.queriesPerTick} invocation(s)/tick)`);
    if (!report.available) {
      console.log(`  consolidated read:    UNAVAILABLE — ${report.diagnostic}`);
    }
    console.log(`  spawns:               ${report.spawns} ${JSON.stringify(report.spawnsByKind)}`);
    console.log(`  spawns / refresh:     ${report.spawnsPerRefresh ?? 'n/a'}`);
    console.log(`  CPU-seconds (cycle):  ${report.cpuSeconds}`);
    console.log(`  CPU-seconds / spawn:  ${report.cpuSecondsPerSpawn}`);
    console.log(`  CPU-s / pane refresh: ${report.cpuSecondsPerPaneCycle}`);
    console.log(`  p95 spawn wall:       ${report.p95SpawnWallMs} ms`);
    console.log(`  peak RSS:             ${report.peakRssMb} MB`);
    console.log(`  failures:             ${report.failures}`);
  }

  if (!options.keep) fs.rmSync(dir, { recursive: true, force: true });
  else console.log(`(kept fixture at ${dir})`);

  if (report.failures > 0 && report.available) process.exitCode = 1;
  else if (!report.available && options.failIfUnavailable) process.exitCode = 1;
}

// Only run when executed directly: tests import the module to pin the option
// parsing without triggering a full (slow) benchmark run.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((err) => {
    console.error('benchmark failed:', err);
    process.exitCode = 1;
  });
}
