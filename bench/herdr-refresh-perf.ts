/**
 * Benchmark: end-to-end latency and `wl` spawn count of a default-view
 * Herdr refresh (F1 of parent WL-0MV02VA29009WBEN).
 *
 * Seeds a real temp worklog (≥ 1000 root items + ≥ 20 expanded parents with
 * children), then measures the refresh DATA path exactly as `doRefresh` drives
 * it: `wl next` (+ mandatory subsets), the actionable count, the review-queue
 * state, and one `wl list --parent` per expanded parent. It reports:
 *
 *   - warm default-view refresh latency (read cache hot),
 *   - cold default-view refresh latency (state counter bumped → cache cold),
 *   - the number of `wl` child processes spawned per refresh,
 *   - how many of those spawns did real read work vs served a cache hit.
 *
 * The ≤ 2 s target is host-dependent, so the benchmark REPORTS `withinTarget`
 * rather than failing the process on it (the paired spawn-count metric is the
 * regression guard).
 *
 * Usage:
 *   npx tsx bench/herdr-refresh-perf.ts            # text output
 *   npx tsx bench/herdr-refresh-perf.ts --json     # machine-readable output
 *
 * Options:
 *   --items N              root items to create (default 1000)
 *   --parents N            expanded parent items (default 20)
 *   --children-per-parent  children created under each parent (default 3)
 *   --browse N             browseItemCount used by `wl next` (default 30)
 *   --iterations N         measured warm/cold pairs (default 2)
 *   --keep                 keep temp artifacts (default false)
 *   --json                 JSON output for agent consumption
 *
 * A `wl` binary must be resolvable on PATH (the same requirement as the
 * running plugin). This is a repeatable, spawn-count-observable harness, not a
 * substitute for the manual wall-clock note recorded by F4 on a real dataset.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pathToFileURL } from 'url';
import { WorklogDatabase } from '../src/database.js';
import { bumpStateCounter } from '../src/read-cache.js';
import { countSpawnRecords } from '../src/spawn-counter.js';
import {
  setExecFileAsync,
  resetExecFileAsync,
  setWorklogDir,
  resetWorklogDir,
  fetchNextItems,
  fetchActionableCount,
  fetchReviewQueueState,
  fetchChildrenForItem,
} from '../packages/herdr/src/fetcher.js';

// ── Configuration ────────────────────────────────────────────────────

const TARGET_MS = 2000;

export interface HerdrRefreshPerfOptions {
  items: number;
  parents: number;
  childrenPerParent: number;
  browse: number;
  iterations: number;
  keep: boolean;
  json: boolean;
}

const DEFAULTS: HerdrRefreshPerfOptions = {
  items: 1000,
  parents: 20,
  childrenPerParent: 3,
  browse: 30,
  iterations: 2,
  keep: false,
  json: false,
};

export interface HerdrRefreshPerfResult {
  itemCount: number;
  expandedParents: number;
  childrenPerParent: number;
  browseCount: number;
  iterations: number;
  /** Median warm default-view refresh latency (ms). */
  warmMs: number;
  /** Median cold default-view refresh latency (ms). */
  coldMs: number;
  /** `wl` processes spawned during the last cold refresh. */
  coldSpawns: number;
  /** `wl` processes spawned during the last warm refresh. */
  warmSpawns: number;
  /** Cold spawns that performed real read work (read-cache miss). */
  coldReadWorkSpawns: number;
  /** Warm spawns served from the read cache (no DB work). */
  warmCacheHitSpawns: number;
  targetMs: number;
  withinTarget: boolean;
  dbPath: string;
}

// ── Arg parsing ──────────────────────────────────────────────────────

export function parseArgs(argv: string[]): HerdrRefreshPerfOptions {
  const options = { ...DEFAULTS };
  const args = argv.slice(2);
  const readValue = (index: number): string | undefined => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) return undefined;
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--items': {
        const v = readValue(i);
        if (v) options.items = Number(v);
        break;
      }
      case '--parents': {
        const v = readValue(i);
        if (v) options.parents = Number(v);
        break;
      }
      case '--children-per-parent': {
        const v = readValue(i);
        if (v) options.childrenPerParent = Number(v);
        break;
      }
      case '--browse': {
        const v = readValue(i);
        if (v) options.browse = Number(v);
        break;
      }
      case '--iterations': {
        const v = readValue(i);
        if (v) options.iterations = Number(v);
        break;
      }
      case '--keep':
        options.keep = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        break;
    }
  }
  return options;
}

// ── Helpers ──────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const realExecFile = promisify(execFile);

/**
 * Seed a real temp worklog with root items plus expanded parents and
 * children, returning the worklog dir and the expanded parent ids.
 */
function seedWorklog(
  rootDir: string,
  options: HerdrRefreshPerfOptions,
): { worklogDir: string; expandedParentIds: string[] } {
  const worklogDir = path.join(rootDir, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });

  const db = new WorklogDatabase(
    'BENCH',
    path.join(worklogDir, 'worklog.db'),
    path.join(worklogDir, 'worklog-data.jsonl'),
    true,
    false,
  );

  const priorities = ['critical', 'high', 'medium', 'low'] as const;

  try {
    for (let i = 0; i < options.items; i += 1) {
      db.create({
        title: `Refresh perf item ${i}`,
        priority: priorities[i % priorities.length],
        description: `Synthetic description for refresh benchmark item ${i}.`,
      });
    }

    const expandedParentIds: string[] = [];
    for (let p = 0; p < options.parents; p += 1) {
      const parent = db.create({
        title: `Refresh perf expanded parent ${p}`,
        priority: priorities[p % priorities.length],
        description: `Parent ${p} used to measure the expanded-children fetch cost.`,
      });
      expandedParentIds.push(parent.id);
      for (let c = 0; c < options.childrenPerParent; c += 1) {
        db.create({
          title: `Refresh perf child ${p}.${c}`,
          priority: priorities[c % priorities.length],
          parentId: parent.id,
          description: `Child ${c} of parent ${p}.`,
        });
      }
    }

    return { worklogDir, expandedParentIds };
  } finally {
    db.close();
  }
}

// ── Benchmark runner ─────────────────────────────────────────────────

/**
 * Run the benchmark and return its summary. Restores every piece of global
 * state it touches (env, fetcher worklog dir, exec seam) on the way out, so
 * it is safe to call from the vitest contract test in-process.
 */
export async function runBenchmark(argv: string[] = process.argv): Promise<HerdrRefreshPerfResult> {
  const options = parseArgs(argv);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-refresh-perf-'));
  const cacheDir = path.join(rootDir, 'cache');
  const spawnFile = path.join(rootDir, 'spawns.log');

  const savedCacheDir = process.env.WL_CACHE_DIR;
  const savedSpawnFile = process.env.WL_SPAWN_COUNT_FILE;

  let spawnCount = 0;

  try {
    const { worklogDir, expandedParentIds } = seedWorklog(rootDir, options);

    // `wl` refuses to run unless the init semaphore is present.
    fs.writeFileSync(
      path.join(worklogDir, 'initialized'),
      JSON.stringify({ version: '1.0.20', initializedAt: new Date().toISOString() }),
      'utf-8',
    );

    process.env.WL_CACHE_DIR = cacheDir;
    process.env.WL_SPAWN_COUNT_FILE = spawnFile;
    setWorklogDir(worklogDir);
    setExecFileAsync((async (file: any, args: any, execOptions: any) => {
      spawnCount += 1;
      return realExecFile(file, args, execOptions);
    }) as any);

    const refresh = async (): Promise<void> => {
      await fetchNextItems(options.browse);
      await Promise.all([
        fetchActionableCount(),
        fetchReviewQueueState(),
        ...expandedParentIds.map((id) => fetchChildrenForItem(id, 1)),
      ]);
    };

    const resetSpawnFile = (): void => {
      try {
        fs.rmSync(spawnFile, { force: true });
      } catch {
        // ignore
      }
    };

    const measure = async (): Promise<{ ms: number; spawns: number; readWork: number; cacheHits: number }> => {
      resetSpawnFile();
      spawnCount = 0;
      const start = performance.now();
      await refresh();
      const ms = performance.now() - start;
      return {
        ms,
        spawns: spawnCount,
        readWork: countSpawnRecords(spawnFile, 'read-work'),
        cacheHits: countSpawnRecords(spawnFile, 'cache-hit'),
      };
    };

    // Prime the read cache so the first "warm" measurement is genuinely warm.
    await refresh();

    const warmRuns: number[] = [];
    const coldRuns: number[] = [];
    let coldSpawns = 0;
    let warmSpawns = 0;
    let coldReadWorkSpawns = 0;
    let warmCacheHitSpawns = 0;

    for (let i = 0; i < options.iterations; i += 1) {
      const warm = await measure();
      warmRuns.push(warm.ms);
      warmSpawns = warm.spawns;
      warmCacheHitSpawns = warm.cacheHits;

      // Invalidate the read cache exactly as a `wl` write does.
      bumpStateCounter(cacheDir, worklogDir);
      const cold = await measure();
      coldRuns.push(cold.ms);
      coldSpawns = cold.spawns;
      coldReadWorkSpawns = cold.readWork;
    }

    const warmMs = median(warmRuns);
    const coldMs = median(coldRuns);

    return {
      itemCount: options.items,
      expandedParents: expandedParentIds.length,
      childrenPerParent: options.childrenPerParent,
      browseCount: options.browse,
      iterations: options.iterations,
      warmMs,
      coldMs,
      coldSpawns,
      warmSpawns,
      coldReadWorkSpawns,
      warmCacheHitSpawns,
      targetMs: TARGET_MS,
      withinTarget: coldMs <= TARGET_MS,
      dbPath: path.join(worklogDir, 'worklog.db'),
    };
  } finally {
    resetExecFileAsync();
    resetWorklogDir();
    if (savedCacheDir === undefined) delete process.env.WL_CACHE_DIR;
    else process.env.WL_CACHE_DIR = savedCacheDir;
    if (savedSpawnFile === undefined) delete process.env.WL_SPAWN_COUNT_FILE;
    else process.env.WL_SPAWN_COUNT_FILE = savedSpawnFile;

    if (!options.keep) {
      try {
        fs.rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  const summary = await runBenchmark(process.argv);

  if (options.json) {
    console.log(JSON.stringify({ ...summary, timestamp: new Date().toISOString() }, null, 2));
    return;
  }

  console.log('\n========================================');
  console.log('  Herdr default-view refresh benchmark');
  console.log('========================================\n');
  console.log(`  dataset:            ${summary.itemCount} items, ${summary.expandedParents} expanded parents x ${summary.childrenPerParent} children`);
  console.log(`  browseItemCount:    ${summary.browseCount}`);
  console.log(`  iterations:         ${summary.iterations}`);
  console.log(`  warm refresh:       ${summary.warmMs.toFixed(1)} ms (${summary.warmSpawns} wl spawns, ${summary.warmCacheHitSpawns} cache hits)`);
  console.log(`  cold refresh:       ${summary.coldMs.toFixed(1)} ms (${summary.coldSpawns} wl spawns, ${summary.coldReadWorkSpawns} read-work)`);
  console.log(`  target:             ${summary.targetMs} ms`);
  console.log(`  within target:      ${summary.withinTarget ? 'yes' : 'no (regression guard: spawn count)'}`);
  console.log(`  db:                 ${summary.dbPath}`);
  console.log('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('benchmark failed:', err);
    process.exitCode = 1;
  });
}
