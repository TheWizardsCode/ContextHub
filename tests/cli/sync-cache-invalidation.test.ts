/**
 * E2E tests for sync → read-cache invalidation (F3 — WL-0MSGAEJQA005QG3W, AC1).
 *
 * Uses REAL git + a real bare remote (mock-bin stripped from PATH, mirroring
 * tests/cli/sync-concurrent.test.ts) so the pull/merge/push path actually
 * runs against the compiled CLI (dist/cli.js).
 *
 * AC1: after a successful `wl sync`, identical reads return post-pull data
 * (no stale cache served). The sync command bumps the read-cache state
 * counter AFTER the merge lands (preAction already bumped it before the
 * action), so entries cached before/during the sync window are never served.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { readStateCounter } from '../../src/read-cache.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');
const mockBinDir = path.join(__dirname, 'mock-bin');

/** PATH without the test mock-bin so we run the real git binary. */
function realGitPath(): string {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter((p) => path.resolve(p) !== path.resolve(mockBinDir))
    .join(path.delimiter);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, PATH: realGitPath() } });
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      {
        cwd,
        env: { ...process.env, ...env },
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ code: (error as any).code ?? 1, stdout: String(stdout), stderr: String(stderr) });
        } else {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
        }
      }
    );
    child.on('error', reject);
  });
}

describe('sync → read-cache invalidation (F3 AC1)', () => {
  let repoA: string; // primary repo
  let repoB: string; // second clone (remote-side changes)
  let remoteDir: string;
  let cacheDir: string;

  function envFor(cwd: string): Record<string, string> {
    return {
      PATH: realGitPath(),
      WL_CACHE_DIR: cacheDir,
      WL_TUI_MODE: '1',
    };
  }

  function cli(cwd: string, ...args: string[]): Promise<CliResult> {
    return runCli(cwd, args, envFor(cwd));
  }

  beforeEach(() => {
    repoA = createTempDir();
    remoteDir = createTempDir();
    git(repoA, 'init', '-q');
    git(repoA, 'config', 'user.email', 'test@example.com');
    git(repoA, 'config', 'user.name', 'Test User');
    git(repoA, 'init', '-q', '--bare', remoteDir);
    git(repoA, 'remote', 'add', 'origin', remoteDir);
    fs.writeFileSync(path.join(repoA, 'README.md'), '# Sync Cache Test\n', 'utf-8');
    git(repoA, 'add', 'README.md');
    git(repoA, 'commit', '-m', 'initial commit');

    // Worklog config (syncRemote/syncBranch like sync-concurrent.test.ts).
    const worklogDir = path.join(repoA, '.worklog');
    fs.mkdirSync(worklogDir, { recursive: true });
    fs.writeFileSync(
      path.join(worklogDir, 'config.json'),
      JSON.stringify({
        projectName: 'Sync Cache Test',
        prefix: 'SC',
        syncRemote: 'origin',
        syncBranch: 'refs/worklog/data',
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(worklogDir, 'initialized'),
      JSON.stringify({ version: '1.0.0', initializedAt: '2026-01-01T00:00:00.000Z' }),
      'utf-8'
    );

    // Second clone for remote-side changes.
    repoB = path.join(createTempDir(), 'cloneB');
    git(repoA, 'clone', '-q', remoteDir, repoB);
    git(repoB, 'config', 'user.email', 'test@example.com');
    git(repoB, 'config', 'user.name', 'Test User');
    // Empty clone has no HEAD; the sync worktree path needs an initial commit.
    git(repoB, 'commit', '--allow-empty', '-m', 'chore: initial');
    const wlB = path.join(repoB, '.worklog');
    fs.mkdirSync(wlB, { recursive: true });
    fs.writeFileSync(
      path.join(wlB, 'config.json'),
      JSON.stringify({
        projectName: 'Sync Cache Test',
        prefix: 'SC',
        syncRemote: 'origin',
        syncBranch: 'refs/worklog/data',
      }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(wlB, 'initialized'),
      JSON.stringify({ version: '1.0.0', initializedAt: '2026-01-01T00:00:00.000Z' }),
      'utf-8'
    );

    cacheDir = path.join(repoA, 'cache');
  });

  afterEach(() => {
    cleanupTempDir(repoA);
    cleanupTempDir(path.dirname(repoB));
    cleanupTempDir(remoteDir);
  });

  it('AC1: after a successful sync, identical reads return post-pull data (no stale cache)', async () => {
    const worklogDirA = path.join(repoA, '.worklog');

    // Seed item 1 in A and cache a read (counter C0).
    const create1 = await cli(repoA, '--json', 'create', '-t', 'Item One');
    expect(create1.code).toBe(0);
    const read1 = await cli(repoA, 'list', '--json');
    expect(read1.code).toBe(0);
    expect(read1.stdout).toContain('Item One');
    const counterBefore = readStateCounter(cacheDir, worklogDirA);

    // B creates item 2 and pushes it to the remote via wl sync.
    const create2 = await cli(repoB, '--json', 'create', '-t', 'Item Two');
    expect(create2.code).toBe(0);
    const syncB = await cli(repoB, '--json', 'sync');
    expect(syncB.code).toBe(0);
    expect(syncB.stdout).toContain('"success": true');

    // A syncs: pulls item 2 into its DB.
    const syncA = await cli(repoA, '--json', 'sync');
    expect(syncA.code, `syncA stdout: ${syncA.stdout}\nstderr: ${syncA.stderr}`).toBe(0);
    expect(syncA.stdout).toContain('"success": true');

    // The post-sync invalidation fired: the state counter advanced AGAIN
    // after the preAction bump (preAction +1, post-sync +1 ⇒ +2 total).
    const counterAfter = readStateCounter(cacheDir, worklogDirA);
    expect(counterAfter).toBe(counterBefore + 2);

    // The identical read must return POST-PULL data (both items), never the
    // pre-sync cached payload.
    const read2 = await cli(repoA, 'list', '--json');
    expect(read2.code).toBe(0);
    expect(read2.stdout).toContain('Item One');
    expect(read2.stdout).toContain('Item Two');
  }, 180000);

  it('AC3: a dry-run sync does not refresh the heartbeat marker', async () => {
    const markerPath = path.join(repoA, '.worklog', 'last-sync-time');
    const testTimestamp = '2026-06-25T12:00:00.000Z';
    fs.writeFileSync(markerPath, testTimestamp, 'utf-8');

    const dry = await cli(repoA, '--json', 'sync', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('"success": true');

    // Skipped sync: marker untouched (a refreshed marker would suppress real
    // syncs across herdr panes).
    expect(fs.readFileSync(markerPath, 'utf-8')).toBe(testTimestamp);
  }, 120000);

  it('AC3: a failed sync does not create/refresh the heartbeat marker', async () => {
    const markerPath = path.join(repoA, '.worklog', 'last-sync-time');
    expect(fs.existsSync(markerPath)).toBe(false);

    // A nonexistent remote fails at the push step (real git) → sync fails.
    const failed = await cli(repoA, '--json', 'sync', '--git-remote', 'does-not-exist');
    expect(failed.code).not.toBe(0);
    expect(failed.stdout).toContain('"success": false');

    // Failed sync: no heartbeat written — the next pane tick must still sync.
    expect(fs.existsSync(markerPath)).toBe(false);
  }, 120000);
});
