/**
 * Read-cache coverage for the consolidated `wl worklist` bundle
 * (WL-0MVI0IS6Y0028KTO, parent WL-0MVGYLU0S004WZUS).
 *
 * A Herdr refresh tick issues one `wl worklist --json` read
 * (WL-0MVI0HX58009JJRF). For that to pay off across panes, the invocation must
 * be served from the existing on-disk read cache as **one** entry, keyed by
 * `(worklog-dir, argv)` and invalidated by the same monotonic state counter as
 * `list`/`next`/`show`/`search`/`status` — no forked cache.
 *
 * These tests spawn the REAL CLI (`runCliProcess`, the pre-compiled `src/cli.ts`
 * entry) with an isolated cache dir and spawn counter, so the fast-path cache
 * lookup and the write-invalidation hook are the production ones.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { seedWorklistFixture, writeConfig, writeInitSemaphore } from './cli-helpers.js';
import { runCliProcess } from './cli-bundle.js';
import { countSpawnRecords } from '../../src/spawn-counter.js';
import { bumpStateCounter, readStateCounter } from '../../src/read-cache.js';
import { ReadCacheCli, isCacheableReadCommand, shouldCacheReadInvocation } from '../../src/read-cache-cli.js';
import { resolveWorklogDir, setWorklogDirOverride } from '../../src/worklog-paths.js';

/** Run the real CLI as a subprocess with an isolated cache + spawn counter. */
function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): { stdout: string; stderr: string; status: number | null } {
  return runCliProcess(args, { cwd, env: { ...process.env, ...env } });
}

function workSpawns(spawnFile: string): number {
  return countSpawnRecords(spawnFile, 'read-work');
}

function hitSpawns(spawnFile: string): number {
  return countSpawnRecords(spawnFile, 'cache-hit');
}

describe('wl worklist read cache', { timeout: 120_000 }, () => {
  let tempDir: string;
  let cacheDir: string;
  let spawnFile: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tempDir = createTempDir();
    seedWorklistFixture(tempDir, { prefix: 'FIX', projectName: 'Worklist Cache' });
    cacheDir = path.join(tempDir, 'cache');
    spawnFile = path.join(tempDir, 'spawns.log');
    env = {
      WL_CACHE_DIR: cacheDir,
      WL_SPAWN_COUNT_FILE: spawnFile,
      WL_TUI_MODE: '1',
    };
  });

  afterEach(() => {
    setWorklogDirOverride(undefined);
    cleanupTempDir(tempDir);
  });

  it('registers worklist as a cacheable read command', () => {
    expect(isCacheableReadCommand('worklist')).toBe(true);
    expect(shouldCacheReadInvocation('worklist', ['worklist', '--json'])).toBe(true);
    // Same gate as every other read: JSON only, no non-cacheable flags.
    expect(shouldCacheReadInvocation('worklist', ['worklist'])).toBe(false);
  });

  it('serves a repeat invocation from cache with a byte-identical payload', () => {
    const first = runCli(['--json', 'worklist'], tempDir, env);
    expect(first.status).toBe(0);
    const second = runCli(['--json', 'worklist'], tempDir, env);
    expect(second.status).toBe(0);

    expect(second.stdout).toBe(first.stdout);
    expect(workSpawns(spawnFile)).toBe(1);
    expect(hitSpawns(spawnFile)).toBe(1);

    // A cache hit does no DB work: the payload is still the full contract.
    const payload = JSON.parse(second.stdout);
    expect(Object.keys(payload.subsets).sort()).toEqual(
      ['blockedRoots', 'browse', 'critical', 'inProgressRoots', 'reviewQueue'].sort(),
    );
  });

  it('is invalidated by a write and reflects the new DB state', () => {
    const before = runCli(['--json', 'worklist'], tempDir, env);
    expect(before.status).toBe(0);
    const beforePayload = JSON.parse(before.stdout);
    expect(beforePayload.subsets.inProgressRoots).toHaveLength(1);

    // A write bumps the state counter, so the cached entry must not be served.
    const created = runCli(['--json', 'create', '-t', 'Fresh in-progress item', '--status', 'in-progress'], tempDir, env);
    expect(created.status).toBe(0);

    const after = runCli(['--json', 'worklist'], tempDir, env);
    expect(after.status).toBe(0);
    const afterPayload = JSON.parse(after.stdout);
    expect(afterPayload.subsets.inProgressRoots).toHaveLength(2);
    expect(
      afterPayload.subsets.inProgressRoots.map((item: any) => item.title),
    ).toContain('Fresh in-progress item');

    expect(workSpawns(spawnFile)).toBe(2);
    expect(hitSpawns(spawnFile)).toBe(0);
  });

  it('keys entries by argv: a different -n is a distinct entry', () => {
    const variants: string[][] = [
      ['--json', 'worklist', '-n', '2'],
      ['--json', 'worklist', '-n', '3'],
    ];
    for (const variant of variants) {
      const first = runCli(variant, tempDir, env);
      expect(first.status).toBe(0);
      const second = runCli(variant, tempDir, env);
      expect(second.status).toBe(0);
      expect(second.stdout).toBe(first.stdout);
    }
    // One miss per distinct argv, every repeat is a hit.
    expect(workSpawns(spawnFile)).toBe(2);
    expect(hitSpawns(spawnFile)).toBe(2);
  });

  it('keys entries by worklog dir: --worklog-dir selects a distinct entry', () => {
    const otherDir = createTempDir();
    try {
      // An empty worklog: its payload differs from the seeded tempDir one.
      writeConfig(otherDir, 'Other Worklog', 'OTH');
      writeInitSemaphore(otherDir);
      const otherWorklogDir = path.join(otherDir, '.worklog');
      const otherArgs = ['--json', '--worklog-dir', otherWorklogDir, 'worklist'];

      for (const args of [['--json', 'worklist'], otherArgs]) {
        const first = runCli(args, tempDir, env);
        expect(first.status).toBe(0);
        const second = runCli(args, tempDir, env);
        expect(second.status).toBe(0);
        expect(second.stdout).toBe(first.stdout);
      }

      // Two distinct keys → two misses, then two hits.
      expect(workSpawns(spawnFile)).toBe(2);
      expect(hitSpawns(spawnFile)).toBe(2);

      // Each entry carries its own worklog dir.
      const seeded = JSON.parse(runCli(['--json', 'worklist'], tempDir, env).stdout);
      const other = JSON.parse(runCli(otherArgs, tempDir, env).stdout);
      expect(seeded.worklogDir).toBe(path.join(tempDir, '.worklog'));
      expect(other.worklogDir).toBe(otherWorklogDir);
    } finally {
      cleanupTempDir(otherDir);
    }
  });

  it('WL_CACHE_DISABLED=1 bypasses lookup and backfill', () => {
    const disabled = { ...env, WL_CACHE_DISABLED: '1' };
    const first = runCli(['--json', 'worklist'], tempDir, disabled);
    expect(first.status).toBe(0);
    const second = runCli(['--json', 'worklist'], tempDir, disabled);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);

    // Baseline: every invocation does real read work, none hit.
    expect(workSpawns(spawnFile)).toBe(2);
    expect(hitSpawns(spawnFile)).toBe(0);
    // And nothing was backfilled into the cache dir.
    const entries = fs.existsSync(cacheDir)
      ? fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))
      : [];
    expect(entries).toEqual([]);
  });

  it('does not store a payload when the state counter changes mid-action', () => {
    // Direct exercise of the shared ReadCacheCli backfill guard for the new
    // command: a write landing between the lookup and `onJsonOutput` means the
    // payload is not representative of one stable DB state and must not be
    // cached.
    const worklogDir = path.join(tempDir, '.worklog');
    setWorklogDirOverride(worklogDir);
    const argv = ['worklist', '--json', '-n', '5'];
    const cache = new ReadCacheCli({ cacheDir });

    const before = readStateCounter(cacheDir, resolveWorklogDir());
    expect(cache.lookup('worklist', argv)).toEqual({ served: false });

    bumpStateCounter(cacheDir, resolveWorklogDir()); // mid-action write
    cache.onJsonOutput({ success: true, subsets: {} });

    // Nothing stored — the next lookup misses and does real work.
    expect(readStateCounter(cacheDir, resolveWorklogDir())).toBeGreaterThan(before);
    expect(cache.lookup('worklist', argv)).toEqual({ served: false });

    // Control: with no intervening write the payload IS stored and served.
    bumpStateCounter(cacheDir, resolveWorklogDir()); // settle to a stable state
    expect(cache.lookup('worklist', argv)).toEqual({ served: false });
    cache.onJsonOutput({ success: true, subsets: { stable: true } });
    const served = cache.lookup('worklist', argv);
    expect(served.served).toBe(true);
    expect(served.value).toEqual({ success: true, subsets: { stable: true } });
  });
});
