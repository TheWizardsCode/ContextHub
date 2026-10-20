/**
 * CLI tests for `wl doctor cache` (F8 — WL-0MVFRRGGC001IQK1).
 *
 * Spawns the REAL CLI (`tsx src/cli.ts`) against a temp worklog dir with an
 * isolated WL_CACHE_DIR, and asserts the cache-maintenance contract:
 * dry-run reports without deleting, `--prune` reclaims stale counters and
 * enforces the bound, and invalid options exit non-zero with a JSON error.
 * See `src/commands/doctor.ts` for the command wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { createTempDir, cleanupTempDir, resolveTsxBin } from '../test-utils.js';
import { stateCounterFilePath } from '../../src/read-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(projectRoot, 'src', 'cli.ts');
const tsxBin = resolveTsxBin(__dirname);

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Write a counter file and pin its mtime (seconds granularity per utimes). */
function writeCounter(cacheDir: string, worklogDir: string, state: number, mtimeMs: number): string {
  const file = stateCounterFilePath(cacheDir, worklogDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ state }), 'utf-8');
  const seconds = Math.max(1, Math.floor(mtimeMs / 1000));
  fs.utimesSync(file, seconds, seconds);
  return file;
}

function listCounters(cacheDir: string): string[] {
  const dir = path.join(cacheDir, 'state');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
}

describe('wl doctor cache', () => {
  let tempDir: string;
  let cacheDir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tempDir = createTempDir();
    writeConfig(tempDir, 'Doctor Cache', 'DCA');
    writeInitSemaphore(tempDir);
    cacheDir = path.join(tempDir, 'cache');
    env = { WL_CACHE_DIR: cacheDir, WL_TUI_MODE: '1' };
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('reports a healthy (empty or fresh) state dir in --json dry-run with exit 0', () => {
    const { stdout, status } = runCli(['--json', 'doctor', 'cache'], tempDir, env);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.filesScanned).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('dry-run reports stale counters and bytes without deleting them', () => {
    const now = Date.now();
    // Two stale counters + one fresh counter.
    const staleA = writeCounter(cacheDir, path.join(tempDir, 'work', 'a'), 1, now - 8 * DAY_MS);
    const staleB = writeCounter(cacheDir, path.join(tempDir, 'work', 'b'), 2, now - 20 * DAY_MS);
    writeCounter(cacheDir, path.join(tempDir, 'work', 'c'), 3, now - 60_000);

    const { stdout, status } = runCli(['--json', 'doctor', 'cache'], tempDir, env);

    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.filesScanned).toBe(3);
    expect(result.staleByTtl).toBe(2);
    expect(result.removed).toBe(2); // would remove
    expect(result.bytesReclaimed).toBeGreaterThan(0);
    // Nothing was removed by the dry run.
    expect(fs.existsSync(staleA)).toBe(true);
    expect(fs.existsSync(staleB)).toBe(true);
    expect(listCounters(cacheDir).length).toBe(3);
  });

  it('--prune removes stale counters and keeps fresh ones', () => {
    const now = Date.now();
    const stale = writeCounter(cacheDir, path.join(tempDir, 'work', 'a'), 1, now - 8 * DAY_MS);
    writeCounter(cacheDir, path.join(tempDir, 'work', 'c'), 3, now - 60_000);

    const { stdout, status } = runCli(['--json', 'doctor', 'cache', '--prune'], tempDir, env);

    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.staleByTtl).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.remaining).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(listCounters(cacheDir).length).toBe(1);
  });

  it('--prune --max-files enforces the file bound (LRU by mtime)', () => {
    const now = Date.now();
    // Six counters, all an hour old: outside the live window, inside the TTL.
    for (let i = 0; i < 6; i++) {
      writeCounter(cacheDir, path.join(tempDir, 'work', `dir-${i}`), i + 1, now - 3_600_000 + i * 60_000);
    }

    const { stdout, status } = runCli(['--json', 'doctor', 'cache', '--prune', '--max-files', '2'], tempDir, env);

    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.overBound).toBe(4);
    expect(result.remaining).toBe(2);
    expect(listCounters(cacheDir).length).toBe(2);
  });

  it('a long --ttl-days keeps an hour-old counter that the default TTL would remove', () => {
    const now = Date.now();
    writeCounter(cacheDir, path.join(tempDir, 'work', 'a'), 5, now - 3_600_000);

    const { stdout, status } = runCli(['--json', 'doctor', 'cache', '--prune', '--ttl-days', '30'], tempDir, env);

    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.staleByTtl).toBe(0);
    expect(result.removed).toBe(0);
    expect(listCounters(cacheDir).length).toBe(1);
  });

  it('text mode summarises the state dir and a prune run', () => {
    const now = Date.now();
    writeCounter(cacheDir, path.join(tempDir, 'work', 'a'), 1, now - 8 * DAY_MS);

    const dry = runCli(['doctor', 'cache'], tempDir, env);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('state');
    expect(dry.stdout).toContain('Dry run');
    expect(dry.stdout).toContain('1');

    const prune = runCli(['doctor', 'cache', '--prune'], tempDir, env);
    expect(prune.status).toBe(0);
    expect(prune.stdout).toContain('Removed');
    expect(prune.stdout).toContain('1');
    expect(listCounters(cacheDir).length).toBe(0);
  });

  it('rejects an invalid option value with a non-zero exit and a JSON error', () => {
    const { stdout, status } = runCli(['--json', 'doctor', 'cache', '--max-files', 'abc'], tempDir, env);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});
