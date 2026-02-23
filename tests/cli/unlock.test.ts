/**
 * Tests for the `wl unlock` CLI command.
 *
 * TDD: These tests are written first; the command implementation follows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';
import type { FileLockInfo } from '../../src/file-lock.js';

describe('wl unlock', () => {
  let tempState: { tempDir: string; originalCwd: string };
  let lockPath: string;

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
    lockPath = path.join(tempState.tempDir, '.worklog', 'worklog-data.jsonl.lock');
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  // -----------------------------------------------------------------------
  // No lock file present
  // -----------------------------------------------------------------------
  it('should print no lock file found when none exists (text mode)', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} unlock --force`);
    expect(stdout).toMatch(/no lock file found/i);
  });

  it('should return success JSON when no lock file exists', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json unlock --force`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.lockFound).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Lock file with valid metadata
  // -----------------------------------------------------------------------
  it('should display lock metadata and remove with --force', async () => {
    const lockInfo: FileLockInfo = {
      pid: 99999,
      hostname: os.hostname(),
      acquiredAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

    const { stdout } = await execAsync(`tsx ${cliPath} unlock --force`);
    expect(stdout).toContain('PID 99999');
    expect(stdout).toContain(os.hostname());
    expect(stdout).toMatch(/removed/i);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should return metadata in JSON mode with --force', async () => {
    const lockInfo: FileLockInfo = {
      pid: 99999,
      hostname: os.hostname(),
      acquiredAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

    const { stdout } = await execAsync(`tsx ${cliPath} --json unlock --force`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.lockFound).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.lockInfo.pid).toBe(99999);
    expect(result.lockInfo.hostname).toBe(os.hostname());
    expect(result.lockInfo.acquiredAt).toBeTruthy();
    expect(result.lockInfo.age).toMatch(/ago|just now/);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Corrupted lock file
  // -----------------------------------------------------------------------
  it('should handle corrupted lock file and remove with --force', async () => {
    fs.writeFileSync(lockPath, 'not-valid-json!!!');

    const { stdout } = await execAsync(`tsx ${cliPath} unlock --force`);
    expect(stdout).toMatch(/corrupted/i);
    expect(stdout).toMatch(/removed/i);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should return corrupted status in JSON with --force', async () => {
    fs.writeFileSync(lockPath, '');

    const { stdout } = await execAsync(`tsx ${cliPath} --json unlock --force`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.lockFound).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.corrupted).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // --force flag removes without prompting
  // -----------------------------------------------------------------------
  it('should remove the lock file without interactive prompt when --force is used', async () => {
    const lockInfo: FileLockInfo = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

    // --force should succeed without stdin input
    const { stdout } = await execAsync(`tsx ${cliPath} --json unlock --force`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.removed).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // PID alive warning
  // -----------------------------------------------------------------------
  it('should warn when lock is held by a live PID', async () => {
    const lockInfo: FileLockInfo = {
      pid: process.pid, // current process — definitely alive
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

    const { stdout } = await execAsync(`tsx ${cliPath} unlock --force`);
    expect(stdout).toMatch(/still running|alive|active/i);
    expect(stdout).toMatch(/removed/i);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should indicate PID is not running when dead', async () => {
    const lockInfo: FileLockInfo = {
      pid: 99999, // almost certainly not running
      hostname: os.hostname(),
      acquiredAt: new Date(Date.now() - 60000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockInfo));

    const { stdout } = await execAsync(`tsx ${cliPath} unlock --force`);
    expect(stdout).toMatch(/not running|no longer running|dead/i);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Command is registered
  // -----------------------------------------------------------------------
  it('should appear in wl --help output', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --help`);
    expect(stdout).toContain('unlock');
  });
});
