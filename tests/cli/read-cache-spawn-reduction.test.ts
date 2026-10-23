/**
 * Spawn-reduction simulation (F2 — WL-0MSGAEC5N006W5QA, parent AC7).
 *
 * Simulates a 6-pane herdr refresh against one shared worklog: each pane
 * issues the same query set (the herdr fetcher's real read commands), all
 * byte-identical across panes. With the shared on-disk read cache, repeat
 * queries are served from cache without DB work, so the number of wl
 * processes that do real read work must drop by ≥60% vs the baseline
 * (cache disabled).
 *
 * Spawn cost (WL-0MVH47YF300087AQ): spawn accounting is per-process, so each
 * pane × query needs its own real CLI subprocess — but not its own tsx
 * re-transpile. Spawns go through `runCliProcess()` (`cli-bundle.ts`), a
 * pre-compiled snapshot of the same `src/cli.ts` entry: ~1.3 s per spawn vs
 * 2.5–8 s for `tsx src/cli.ts` (which re-transpiles the whole `src/` graph on
 * every start). The simulation keeps all 6 panes and the full 5-query herdr
 * set, so the ≥60% spawn-reduction measurement is unchanged; only the
 * per-spawn cost drops (~5×), which is what moves the wall clock from the
 * historic ~203 s into the low tens of seconds. The 300 s test budget is
 * deliberately NOT raised again (a third raise was the behaviour this item
 * was created to stop) — the margin now belongs to the run, not the ceiling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { runCliProcess } from './cli-bundle.js';
import { countSpawnRecords } from '../../src/spawn-counter.js';
import { LEGACY_WORKLIST_QUERIES } from '../../bench/worklist-query-sets.js';

// The simulation needs a real subprocess per query (spawn accounting is
// per-process). `runCliProcess` spawns the pre-compiled CLI bundle instead of
// `tsx src/cli.ts`, so each of the 65 spawns in this file pays ~1.3 s rather
// than the 2.5–8 s a tsx re-transpile costs (WL-0MVH47YF300087AQ).
const PANES = 6;

/** The herdr refresh query set (WL-0MVI0HH740065Z2T): the shared legacy set. */
const QUERIES = LEGACY_WORKLIST_QUERIES;

// Spawn the real CLI entry point as a subprocess. The bundle contains the same
// `src/cli.ts` graph (including the read-cache fast path this test measures),
// so the cross-process cache behaviour is exercised exactly as with tsx.
function runCli(args: readonly string[], cwd: string, env: Record<string, string>): { status: number | null } {
  const result = runCliProcess([...args], { cwd, env: { ...process.env, ...env } });
  return { status: result.status };
}

describe('read-cache spawn reduction (6-pane simulation)', () => {
  let tempDir: string;
  let spawnFile: string;
  let envBase: Record<string, string>;

  beforeEach(
    () => {
      tempDir = createTempDir();
      writeConfig(tempDir, 'Spawn Reduction', 'SPR');
      writeInitSemaphore(tempDir);
      spawnFile = path.join(tempDir, 'spawns.log');
      // WL_CACHE_TTL_MS: the 30s default TTL (a bounding safety net) can
      // expire cache entries mid-run on loaded machines where each tsx
      // subprocess spawn takes seconds; raise it so the simulation measures
      // cache behaviour, not wall-clock timing.
      envBase = { WL_TUI_MODE: '1', WL_SPAWN_COUNT_FILE: spawnFile, WL_CACHE_TTL_MS: '300000' };

      // Seed a realistic worklog (open/critical/completed-in-review/blocked).
      const seed: Array<[string, string[]]> = [
        ['Critical Open', ['--priority', 'critical']],
        ['High Open', ['--priority', 'high']],
        ['Completed Review', ['--priority', 'medium', '--status', 'completed', '--stage', 'in_review']],
        ['Blocked Item', ['--priority', 'low', '--status', 'blocked']],
        ['In Progress', ['--priority', 'high', '--status', 'in-progress']],
      ];
      for (const [title, extra] of seed) {
        const res = runCli(['--json', 'create', '-t', title, ...extra], tempDir, envBase);
        expect(res.status).toBe(0);
      }
    },
    // Seeding runs 5 real `create` subprocesses through the pre-compiled CLI
    // bundle. The hook keeps a generous ceiling (a hang should fail, not stall
    // the suite indefinitely); with bundle spawns the expected cost is a few
    // seconds, so this is headroom rather than a tight budget.
    180_000,
  );

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it(
    'cuts work spawns by ≥60% across a simulated 6-pane refresh',
    () => {
    // Measure the simulation's own wall clock: the failure this test guards
    // against was a timeout, so the achieved runtime is the evidence that the
    // 300 s ceiling has real headroom (recorded via the summary line below).
    const startedAt = Date.now();
    // Baseline: cache disabled — every pane × query does real DB work.
    const baselineEnv = { ...envBase, WL_CACHE_DISABLED: '1' };
    for (let pane = 0; pane < PANES; pane++) {
      for (const q of QUERIES) {
        const res = runCli(q, tempDir, baselineEnv);
        expect(res.status).toBe(0);
      }
    }
    const baselineWork = countSpawnRecords(spawnFile, 'read-work');
    expect(baselineWork).toBe(PANES * QUERIES.length); // 30

    // Cached: fresh cache dir — pane 0 backfills, panes 1-5 hit.
    const cacheDir = path.join(tempDir, 'cache');
    const cachedEnv = { ...envBase, WL_CACHE_DIR: cacheDir };
    // Start the spawn counter file fresh for the cached phase.
    const cachedSpawnFile = path.join(tempDir, 'cached-spawns.log');
    cachedEnv.WL_SPAWN_COUNT_FILE = cachedSpawnFile;
    for (let pane = 0; pane < PANES; pane++) {
      for (const q of QUERIES) {
        const res = runCli(q, tempDir, cachedEnv);
        expect(res.status).toBe(0);
      }
    }
    const cachedWork = countSpawnRecords(cachedSpawnFile, 'read-work');
    const cachedHits = countSpawnRecords(cachedSpawnFile, 'cache-hit');

    const reduction = 1 - cachedWork / baselineWork;
    const elapsedMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.log(
      `[spawn-reduction] panes=${PANES} queries=${QUERIES.length} ` +
        `baselineWork=${baselineWork} cachedWork=${cachedWork} cacheHits=${cachedHits} ` +
        `reduction=${(reduction * 100).toFixed(1)}% (target ≥60%) ` +
        `elapsedMs=${elapsedMs} budgetMs=300000`
    );

    expect(cachedWork).toBeLessThanOrEqual(0.4 * baselineWork);
    expect(cachedHits).toBeGreaterThan(0); // panes 1-5 were served from cache
  },
    // Budget deliberately left at 300 s: this item exists because raising it
    // (30 s → 180 s → 300 s) never fixed the tsx-spawn cost. The bundle fix
    // does, so the run now finishes far inside this ceiling (see the
    // [spawn-reduction] summary line) while a pathological hang still fails.
    300_000
  );
});
