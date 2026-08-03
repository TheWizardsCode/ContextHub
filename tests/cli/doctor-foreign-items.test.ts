/**
 * Integration tests for `wl doctor foreign-items` (dry-run detection).
 *
 * Verifies the CLI reports foreign work items grouped by prefix, honors
 * --prefix override, and never writes to the DB in dry-run mode.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  seedWorkItems,
} from './cli-helpers.js';

describe('doctor foreign-items command', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('dry-run reports exact foreign counts grouped by prefix and changes nothing in the DB', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-001', title: 'own item' },
      { id: 'WL-101', title: 'foreign WL active' },
      { id: 'WL-102', title: 'foreign WL deleted', status: 'deleted' },
      { id: 'OB-0MN9CZ48N0053L9Q', title: 'ob fixture' },
      { id: 'SA-1234', title: 'foreign SA deleted', status: 'deleted' },
      { id: 'NODASH123', title: 'no dash' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor foreign-items --dry-run`);
    const result = JSON.parse(stdout);

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.prefix).toBe('TEST');
    expect(result.totalItems).toBe(6);
    expect(result.foreignCount).toBe(4);

    expect(result.byPrefix.WL).toEqual({
      count: 2,
      deleted: 1,
      nonDeleted: 1,
      ids: ['WL-101', 'WL-102'],
    });
    expect(result.byPrefix.OB).toEqual({
      count: 1,
      deleted: 0,
      nonDeleted: 1,
      ids: ['OB-0MN9CZ48N0053L9Q'],
    });
    expect(result.byPrefix.SA).toEqual({
      count: 1,
      deleted: 1,
      nonDeleted: 0,
      ids: ['SA-1234'],
    });
    expect(result.byPrefix.TEST).toBeUndefined();

    expect(result.deletedForeignCount).toBe(2);
    expect(result.nonDeletedForeignCount).toBe(2);

    // Dry-run must not change the DB: all items still present (incl. deleted)
    const { stdout: listOut } = await execAsync(`tsx ${cliPath} --json list --deleted`);
    const list = JSON.parse(listOut);
    expect(list.success).toBe(true);
    const ids = list.workItems.map((i: { id: string }) => i.id);
    expect(ids).toContain('TEST-001');
    expect(ids).toContain('WL-101');
    expect(ids).toContain('WL-102');
    expect(ids).toContain('OB-0MN9CZ48N0053L9Q');
    expect(ids).toContain('SA-1234');
    expect(ids).toContain('NODASH123');
  });

  it('dry-run is the default mode when no flags are given', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-001', title: 'own' },
      { id: 'WL-101', title: 'foreign' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor foreign-items`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.foreignCount).toBe(1);
  });

  it('honors --prefix override for classification', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'WL-101', title: 'now own under override' },
      { id: 'TEST-001', title: 'now foreign under override' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor foreign-items --dry-run --prefix WL`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.prefix).toBe('WL');
    expect(result.foreignCount).toBe(1);
    expect(result.byPrefix.TEST).toEqual({
      count: 1,
      deleted: 0,
      nonDeleted: 1,
      ids: ['TEST-001'],
    });
    expect(result.byPrefix.WL).toBeUndefined();
  });

  it('reports zero foreign items for a clean DB', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-001', title: 'own' },
      { id: 'TEST-002', title: 'own deleted', status: 'deleted' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor foreign-items --dry-run`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.foreignCount).toBe(0);
    expect(result.totalItems).toBe(2);
    expect(result.byPrefix).toEqual({});
  });

  it('produces human-readable dry-run output without --json', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-001', title: 'own' },
      { id: 'WL-101', title: 'foreign' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} doctor foreign-items --dry-run`);
    expect(stdout).toContain('Doctor foreign-items:');
    expect(stdout).toContain('2 item(s) scanned');
    expect(stdout).toContain('1 foreign item(s)');
    expect(stdout).toContain('WL');
    expect(stdout).toContain('WL-101');
  });
});
