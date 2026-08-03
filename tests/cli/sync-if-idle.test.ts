/**
 * Tests for `wl sync --if-idle` — the lock-aware guard for auto-sync spawners.
 *
 * Background (WL-0MSAB7ZUC004SK7E): herdr worklist panes and pi TUI instances
 * spawn background `wl sync` processes. Under file-lock contention these used
 * to queue up (30s lock timeout each) producing a self-sustaining lock storm.
 * `--if-idle` makes `wl sync` fail fast with a graceful "skipped" result when
 * another sync holds the lock — so spawners skip instead of piling up.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { runInProcess } from './cli-inproc.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FileLockInfo } from '../../src/file-lock.js';

let tempDir: string;
let remoteDir: string;
let worklogDir: string;

beforeEach(async () => {
  tempDir = createTempDir();
  process.chdir(tempDir);

  // Create a bare remote repo for mock git push to write to
  remoteDir = createTempDir();

  // Initialize git in the temp dir so sync operations work
  childProcess.execSync('git init', { cwd: tempDir });

  // Configure mock remote with absolute path
  childProcess.execSync(`git remote add origin ${remoteDir}`, { cwd: tempDir });

  // Do an initial commit so HEAD resolves
  fs.writeFileSync(path.join(tempDir, 'README.md'), '# Sync If-Idle Test\n', 'utf8');
  childProcess.execSync('git add README.md', { cwd: tempDir });
  childProcess.execSync('git commit -m "initial commit"', { cwd: tempDir });

  // Create .worklog directory and config
  worklogDir = path.join(tempDir, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });
  fs.writeFileSync(
    path.join(worklogDir, 'config.json'),
    JSON.stringify({
      projectName: 'IfIdle Test',
      prefix: 'IF',
      syncRemote: 'origin',
      syncBranch: 'refs/worklog/data',
    }),
    'utf-8'
  );
  // Mark initialized (semaphore content mirrors writeInitSemaphore in cli-helpers)
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

/**
 * Hold the sync file lock as if another wl sync process is running.
 */
function holdLock(lockPath: string): void {
  const lockInfo: FileLockInfo = {
    pid: process.pid, // live process → lock not stale
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(lockInfo));
}

it('wl sync --if-idle skips (exit 0, skipped:true) when another sync holds the lock', async () => {
  const lockPath = path.join(worklogDir, 'worklog-data.jsonl.lock');
  holdLock(lockPath);

  const result = await runInProcess(
    `node src/cli.ts --json sync --if-idle`,
    15000
  );

  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.skipped).toBe(true);
  expect(parsed.reason).toMatch(/already in progress/);
});

it('wl sync --if-idle proceeds when the lock is free', async () => {
  // No lock held — sync should run to completion (or report a sync-level error,
  // but never a lock-busy skip). Generous timeout: system under load (stuck
  // wl sync processes from the lock storm) can slow subprocess spawns.
  const result = await runInProcess(
    `node src/cli.ts --json sync --if-idle`,
    45000
  );

  const parsed = JSON.parse(result.stdout);
  expect(parsed.skipped).toBeUndefined();
  expect(parsed.success).toBe(true);
});
