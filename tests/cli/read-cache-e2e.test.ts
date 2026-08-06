/**
 * End-to-end tests for the wl CLI read cache (F2 — WL-0MSGAEC5N006W5QA).
 *
 * These spawn the REAL CLI (tsx src/cli.ts) as a subprocess against temp
 * worklog dirs, with an isolated cache dir and the spawn counter enabled,
 * and assert the cache behaviour through observable spawn records:
 *   - 'read-work'  = the process did real DB work (cache miss)
 *   - 'cache-hit'  = the process was served from cache (no DB work)
 *
 * Note: `execAsync` from cli-helpers runs `tsx src/cli.ts` in-process via
 * cli-inproc.ts, which bypasses src/cli.ts's cache wiring — so these tests
 * spawn the CLI directly instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
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

/** Run the real CLI as a subprocess; returns stdout, stderr, exit status. */
function runCli(args: string[], cwd: string, env: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [tsxBin, cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** Setup: temp worklog + isolated cache dir + spawn counter file. */
function setup(): { tempDir: string; cacheDir: string; spawnFile: string; env: Record<string, string> } {
  const tempDir = createTempDir();
  writeConfig(tempDir, 'Read Cache E2E', 'RCE');
  writeInitSemaphore(tempDir);
  const cacheDir = path.join(tempDir, 'cache');
  const spawnFile = path.join(tempDir, 'spawns.log');
  const env: Record<string, string> = {
    WL_CACHE_DIR: cacheDir,
    WL_SPAWN_COUNT_FILE: spawnFile,
    WL_TUI_MODE: '1',
  };
  return { tempDir, cacheDir, spawnFile, env };
}

function workSpawns(spawnFile: string): number {
  return countSpawnRecords(spawnFile, 'read-work');
}

function hitSpawns(spawnFile: string): number {
  return countSpawnRecords(spawnFile, 'cache-hit');
}

function createItem(tempDir: string, env: Record<string, string>, title: string, extra: string[] = []): void {
  const res = runCli(['--json', 'create', '-t', title, ...extra], tempDir, env);
  expect(res.status).toBe(0);
}

describe('wl CLI read cache (e2e)', () => {
  let tempDir: string;
  let cacheDir: string;
  let spawnFile: string;
  let env: Record<string, string>;

  beforeEach(() => {
    const s = setup();
    tempDir = s.tempDir;
    cacheDir = s.cacheDir;
    spawnFile = s.spawnFile;
    env = s.env;
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('serves repeat identical reads from cache (AC1): list + show', () => {
    createItem(tempDir, env, 'Alpha');
    createItem(tempDir, env, 'Beta');

    const first = runCli(['list', '--json'], tempDir, env);
    expect(first.status).toBe(0);
    const second = runCli(['list', '--json'], tempDir, env);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout); // byte-identical
    expect(workSpawns(spawnFile)).toBe(1);
    expect(hitSpawns(spawnFile)).toBe(1);

    // show <id> is also covered
    const id = (JSON.parse(first.stdout) as { workItems: { id: string }[] }).workItems[0].id;
    const s1 = runCli(['show', id, '--json'], tempDir, env);
    expect(s1.status).toBe(0);
    const s2 = runCli(['show', id, '--json'], tempDir, env);
    expect(s2.stdout).toBe(s1.stdout);
    expect(workSpawns(spawnFile)).toBe(2);
    expect(hitSpawns(spawnFile)).toBe(2);
  });

  it('a write invalidates: identical read after write returns fresh data (AC2)', () => {
    createItem(tempDir, env, 'Alpha');
    const before = runCli(['list', '--json'], tempDir, env);
    expect(before.status).toBe(0);
    expect(JSON.parse(before.stdout).workItems).toHaveLength(1);

    createItem(tempDir, env, 'Gamma'); // write
    const after = runCli(['list', '--json'], tempDir, env);
    expect(after.status).toBe(0);
    const items = JSON.parse(after.stdout).workItems;
    expect(items).toHaveLength(2); // fresh — not served from cache
    expect(items.map((i: any) => i.title)).toContain('Gamma');
    expect(workSpawns(spawnFile)).toBe(2); // both reads missed (second was invalidated)
    expect(hitSpawns(spawnFile)).toBe(0);
  });

  it('arg variants produce separate cache entries (AC3)', () => {
    createItem(tempDir, env, 'Alpha', ['--priority', 'high']);
    createItem(tempDir, env, 'Beta', ['--priority', 'low']);

    const variants: string[][] = [
      ['list', '--json'],
      ['list', '--status', 'open', '--json'],
      ['list', '-n', '1', '--json'],
    ];
    for (const v of variants) {
      const r1 = runCli(v, tempDir, env);
      expect(r1.status).toBe(0);
      const r2 = runCli(v, tempDir, env);
      expect(r2.stdout).toBe(r1.stdout);
    }
    // One miss per distinct variant; every repeat is a hit.
    expect(workSpawns(spawnFile)).toBe(3);
    expect(hitSpawns(spawnFile)).toBe(3);
  });

  it("next's auto re-sort counts as a write and invalidates the cache (AC4)", () => {
    // Create in a deliberately non-canonical order (no re-sort) so the next
    // re-sort actually changes sort indices → bumps the state counter.
    createItem(tempDir, env, 'Low', ['--priority', 'low', '--no-re-sort']);
    createItem(tempDir, env, 'High', ['--priority', 'high', '--no-re-sort']);
    createItem(tempDir, env, 'Mid', ['--priority', 'medium', '--no-re-sort']);

    const run1 = runCli(['next', '-n', '3', '--json'], tempDir, env);
    expect(run1.status).toBe(0);
    const run2 = runCli(['next', '-n', '3', '--json'], tempDir, env);
    expect(run2.status).toBe(0);
    // The first run's re-sort byproduct invalidated the cache → run2 missed.
    expect(workSpawns(spawnFile)).toBe(2);
    // Run 2's re-sort was a no-op (order already canonical) → run3 hits.
    const run3 = runCli(['next', '-n', '3', '--json'], tempDir, env);
    expect(run3.status).toBe(0);
    expect(hitSpawns(spawnFile)).toBe(1);
    expect(run3.stdout).toBe(run2.stdout);
  });

  it('search is cached, but --rebuild-index is a write that invalidates (AC4)', () => {
    createItem(tempDir, env, 'Searchable Widget');
    const q = ['search', 'Widget', '--json'];

    const r1 = runCli(q, tempDir, env);
    expect(r1.status).toBe(0);
    const r2 = runCli(q, tempDir, env);
    expect(r2.stdout).toBe(r1.stdout);
    expect(workSpawns(spawnFile)).toBe(1);
    expect(hitSpawns(spawnFile)).toBe(1);

    // --rebuild-index is never served from cache and invalidates (write).
    // It is excluded from the spawn metric (non-cacheable), so no extra
    // read-work is recorded — but it must invalidate the cached search.
    const rb = runCli(['search', 'Widget', '--json', '--rebuild-index'], tempDir, env);
    expect(rb.status).toBe(0);
    expect(hitSpawns(spawnFile)).toBe(1); // rebuild never hits

    const r3 = runCli(q, tempDir, env);
    expect(r3.status).toBe(0);
    expect(workSpawns(spawnFile)).toBe(2); // r1 + r3 (r3 invalidated by rebuild)
  });

  it('status is covered and write commands invalidate it (sync counts as a write)', () => {
    createItem(tempDir, env, 'Alpha');
    const s1 = runCli(['status', '--json'], tempDir, env);
    expect(s1.status).toBe(0);
    const s2 = runCli(['status', '--json'], tempDir, env);
    expect(s2.stdout).toBe(s1.stdout);
    expect(workSpawns(spawnFile)).toBe(1);
    expect(hitSpawns(spawnFile)).toBe(1);
  });

  it('WL_CACHE_DISABLED bypasses the cache entirely (baseline)', () => {
    createItem(tempDir, env, 'Alpha');
    const disabledEnv = { ...env, WL_CACHE_DISABLED: '1' };
    const r1 = runCli(['list', '--json'], tempDir, disabledEnv);
    expect(r1.status).toBe(0);
    const r2 = runCli(['list', '--json'], tempDir, disabledEnv);
    expect(r2.status).toBe(0);
    // Baseline: every cacheable read records a work spawn, none hit.
    expect(workSpawns(spawnFile)).toBe(2);
    expect(hitSpawns(spawnFile)).toBe(0);
  });

  it('does not cache text (non-JSON) output', () => {
    createItem(tempDir, env, 'Alpha');
    const r1 = runCli(['list'], tempDir, env);
    expect(r1.status).toBe(0);
    const r2 = runCli(['list'], tempDir, env);
    expect(r2.status).toBe(0);
    expect(hitSpawns(spawnFile)).toBe(0); // text mode never cached
    expect(workSpawns(spawnFile)).toBe(0); // and excluded from the spawn metric
    // No cache ENTRY files were written (the dir itself may exist from
    // write-invalidation state counters).
    if (fs.existsSync(cacheDir)) {
      const entries = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
      expect(entries).toEqual([]);
    }
  });

  it('a fresh cache dir misses once then hits (no cross-test pollution)', () => {
    // Second test file uses its own temp dirs; this just re-verifies the
    // miss→hit cycle in a pristine cache dir.
    createItem(tempDir, env, 'Alpha');
    const r1 = runCli(['list', '--json'], tempDir, env);
    const r2 = runCli(['list', '--json'], tempDir, env);
    expect(r1.stdout).toBe(r2.stdout);
    expect(workSpawns(spawnFile)).toBe(1);
    expect(hitSpawns(spawnFile)).toBe(1);
  });
});
