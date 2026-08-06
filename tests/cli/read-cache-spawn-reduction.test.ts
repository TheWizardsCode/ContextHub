/**
 * Spawn-reduction simulation (F2 — WL-0MSGAEC5N006W5QA, parent AC7).
 *
 * Simulates a 6-pane herdr refresh against one shared worklog: each pane
 * issues the same query set (the herdr fetcher's real read commands), all
 * byte-identical across panes. With the shared on-disk read cache, repeat
 * queries are served from cache without DB work, so the number of wl
 * processes that do real read work must drop by ≥60% vs the baseline
 * (cache disabled).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { createTempDir, cleanupTempDir, resolveTsxBin } from '../test-utils.js';
import { countSpawnRecords } from '../../src/spawn-counter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(projectRoot, 'src', 'cli.ts');
const tsxBin = resolveTsxBin(__dirname);

const PANES = 6;

/** The herdr fetcher's query set (see parent epic WL-0MSAZQEQB008O7H3). */
const QUERIES: string[][] = [
  ['next', '-n', '5', '--include-in-progress', '--json'],
  ['list', '--priority', 'critical', '--root-only', '--json'],
  ['list', '--status', 'completed', '--stage', 'in_review', '--root-only', '--json'],
  ['list', '--status', 'open,in-progress,blocked', '--json'],
  ['status', '--json'],
];

function runCli(args: string[], cwd: string, env: Record<string, string>): { status: number | null } {
  const result = spawnSync(process.execPath, [tsxBin, cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { status: result.status };
}

describe('read-cache spawn reduction (6-pane simulation)', () => {
  let tempDir: string;
  let spawnFile: string;
  let envBase: Record<string, string>;

  beforeEach(() => {
    tempDir = createTempDir();
    writeConfig(tempDir, 'Spawn Reduction', 'SPR');
    writeInitSemaphore(tempDir);
    spawnFile = path.join(tempDir, 'spawns.log');
    envBase = { WL_TUI_MODE: '1', WL_SPAWN_COUNT_FILE: spawnFile };

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
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it(
    'cuts work spawns by ≥60% across a simulated 6-pane refresh',
    () => {
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
    // eslint-disable-next-line no-console
    console.log(
      `[spawn-reduction] panes=${PANES} queries=${QUERIES.length} ` +
        `baselineWork=${baselineWork} cachedWork=${cachedWork} cacheHits=${cachedHits} ` +
        `reduction=${(reduction * 100).toFixed(1)}% (target ≥60%)`
    );

    expect(cachedWork).toBeLessThanOrEqual(0.4 * baselineWork);
    expect(cachedHits).toBeGreaterThan(0); // panes 1-5 were served from cache
  },
  180_000 // slow: 60+ tsx subprocess spawns
  );
});
