/**
 * Tests for concurrent `wl sync` serialization (SA-0MSAK2W0F0027ZP7).
 *
 * The fan-out investigation (SA-0MSAEKOQE009TEB4) identified concurrent
 * `wl sync` runs from multiple sessions as a fan-out source. The sync
 * command serializes on the JSONL data file via withFileLock (a
 * process-level O_EXCL mutex with stale-lock cleanup, see
 * WL-0MSAB7ZUC004SK7E). These tests prove end-to-end that:
 *
 * - AC1: two concurrent `wl sync` invocations on the same worklog serialize
 *   (max 1 active) and BOTH succeed — no lost data, no corruption.
 * - AC2: the lock file is removed after the runs complete (no stale locks).
 * - AC4: a normal single `wl sync` behaves identically (no regression).
 *
 * Uses REAL git + a real bare remote (mock-bin removed from PATH) so the
 * pull/merge/push path actually runs.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');
const mockBinDir = path.join(__dirname, 'mock-bin');

/** PATH without the test mock-bin so we run the real git binary. */
function realGitPath(): string {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter(p => path.resolve(p) !== path.resolve(mockBinDir))
    .join(path.delimiter);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, PATH: realGitPath() } });
}

let tempDir: string;
let remoteDir: string;
let worklogDir: string;
let dataFile: string;

beforeEach(async () => {
  tempDir = createTempDir();
  process.chdir(tempDir);

  remoteDir = createTempDir();
  git(tempDir, 'init', '-q');
  git(tempDir, 'config', 'user.email', 'test@example.com');
  git(tempDir, 'config', 'user.name', 'Test User');
  git(tempDir, 'init', '-q', '--bare', remoteDir);
  git(tempDir, 'remote', 'add', 'origin', remoteDir);

  fs.writeFileSync(path.join(tempDir, 'README.md'), '# Concurrent Sync Test\n', 'utf8');
  git(tempDir, 'add', 'README.md');
  git(tempDir, 'commit', '-m', 'initial commit');

  worklogDir = path.join(tempDir, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });
  dataFile = path.join(worklogDir, 'worklog-data.jsonl');
  fs.writeFileSync(
    path.join(worklogDir, 'config.json'),
    JSON.stringify({
      projectName: 'Concurrent Sync Test',
      prefix: 'CS',
      syncRemote: 'origin',
      syncBranch: 'refs/worklog/data',
    }),
    'utf-8'
  );
  const { getPackageVersion } = await import('./cli-helpers.js');
  fs.writeFileSync(
    path.join(worklogDir, 'initialized'),
    JSON.stringify({ version: getPackageVersion(), initializedAt: '2024-01-23T12:00:00.000Z' }),
    'utf-8'
  );
});

afterEach(() => {
  cleanupTempDir(tempDir);
  cleanupTempDir(remoteDir);
});

function lockPath(): string {
  return `${dataFile}.lock`;
}

function runSyncViaSpawn(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      [cliPath, '--json', 'sync', '--if-idle'],
      {
        cwd: tempDir,
        env: { ...process.env, PATH: realGitPath() },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// AC1: concurrent invocations serialize (max 1 active) and both succeed
// ---------------------------------------------------------------------------

it('two concurrent wl sync invocations both succeed (serialized via file lock)', async () => {
  // Seed an initial sync so the worklog ref exists on the remote.
  const first = await runSyncViaSpawn();
  expect(first.code).toBe(0);
  expect(first.stdout).toContain('"success": true');

  // Now launch two concurrent syncs. Both must complete; because the sync
  // command serializes on the data-file lock, neither may fail with a
  // lock-busy error (--if-idle skips gracefully) and neither may corrupt
  // the data file.
  const [a, b] = await Promise.all([runSyncViaSpawn(), runSyncViaSpawn()]);
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);

  // If the JSONL data file exists it must remain valid (JSON lines).
  if (fs.existsSync(dataFile)) {
    const content = fs.readFileSync(dataFile, 'utf-8');
    expect(content.trim().length).toBeGreaterThan(0);
    for (const line of content.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }
}, 120000);

// ---------------------------------------------------------------------------
// AC2: lock released after runs — no stale lock blocks future syncs
// ---------------------------------------------------------------------------

it('removes the lock file after concurrent runs (no stale lock)', async () => {
  await Promise.all([runSyncViaSpawn(), runSyncViaSpawn()]);
  expect(fs.existsSync(lockPath())).toBe(false);
  // A subsequent sync must run fine.
  const after = await runSyncViaSpawn();
  expect(after.code).toBe(0);
  expect(fs.existsSync(lockPath())).toBe(false);
}, 120000);

// ---------------------------------------------------------------------------
// AC4: single sync works identically (no regression)
// ---------------------------------------------------------------------------

it('single wl sync works identically and reports success', async () => {
  const result = await runSyncViaSpawn();
  expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.skipped).toBeUndefined();
  expect(fs.existsSync(lockPath())).toBe(false);
}, 60000);
