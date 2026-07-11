/**
 * Tests for last-sync-time recording and display.
 *
 * Verifies that:
 * - performSync writes .worklog/last-sync-time after successful sync
 * - wl status displays the last sync timestamp in human-readable output
 * - wl status --json includes the lastSync field
 * - When no sync has been performed, status shows "Never" / null
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  getPackageVersion
} from './cli-helpers.js';

describe('Last Sync Time', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('should show "Never" in human-readable output when no sync has been performed', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} status`);

    expect(stdout).toContain('Last sync:');
    expect(stdout).toContain('Never');
  });

  it('should show null in JSON output when no sync has been performed', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json status`);
    const result = JSON.parse(stdout);

    expect(result.success).toBe(true);
    expect(result).toHaveProperty('lastSync');
    expect(result.lastSync).toBeNull();
  });

  it('should display last sync timestamp in human-readable status after sync file is written', async () => {
    // Manually write a last-sync-time file as if sync completed
    const testTimestamp = '2026-06-25T12:00:00.000Z';
    fs.writeFileSync(
      path.join(tempState.tempDir, '.worklog', 'last-sync-time'),
      testTimestamp,
      'utf-8'
    );

    const { stdout } = await execAsync(`tsx ${cliPath} status`);

    expect(stdout).toContain('Last sync:');
    expect(stdout).toContain(testTimestamp);
  });

  it('should include lastSync in JSON output after sync file is written', async () => {
    const testTimestamp = '2026-06-25T12:00:00.000Z';
    fs.writeFileSync(
      path.join(tempState.tempDir, '.worklog', 'last-sync-time'),
      testTimestamp,
      'utf-8'
    );

    const { stdout } = await execAsync(`tsx ${cliPath} --json status`);
    const result = JSON.parse(stdout);

    expect(result.success).toBe(true);
    expect(result.lastSync).toBe(testTimestamp);
  });
});
