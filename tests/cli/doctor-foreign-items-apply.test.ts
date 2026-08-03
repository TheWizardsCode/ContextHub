/**
 * Integration tests for `wl doctor foreign-items --apply`.
 *
 * Verifies the destructive cleanup removes all foreign-prefix items from
 * the DB (with full cascade), leaves own items untouched, and that a
 * subsequent dry-run reports zero foreign items.
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

describe('doctor foreign-items --apply command', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('--apply removes all foreign items, leaves own items, and subsequent dry-run reports zero', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-001', title: 'own item' },
      { id: 'TEST-002', title: 'own deleted', status: 'deleted' },
      { id: 'WL-101', title: 'foreign WL active' },
      { id: 'WL-102', title: 'foreign WL deleted', status: 'deleted' },
      { id: 'OB-0MN9CZ48N0053L9Q', title: 'ob fixture deleted', status: 'deleted' },
      { id: 'NODASH123', title: 'no dash' },
    ]);

    // Before: dry-run reports 3 foreign items
    const { stdout: beforeOut } = await execAsync(`tsx ${cliPath} --json doctor foreign-items --dry-run`);
    const before = JSON.parse(beforeOut);
    expect(before.foreignCount).toBe(3);

    // Apply cleanup
    const { stdout: applyOut } = await execAsync(`tsx ${cliPath} --json doctor foreign-items --apply`);
    const applied = JSON.parse(applyOut);
    expect(applied.success).toBe(true);
    expect(applied.apply).toBe(true);
    expect(applied.removedCount).toBe(3);
    expect(applied.totalBefore).toBe(6);
    expect(applied.totalAfter).toBe(3);
    expect(applied.foreignBefore).toBe(3);
    expect(applied.foreignAfter).toBe(0);
    expect(applied.ownBefore).toBe(3);
    expect(applied.ownAfter).toBe(3);
    expect(applied.removedByPrefix.WL).toBe(2);
    expect(applied.removedByPrefix.OB).toBe(1);
    expect(applied.removedIds).toEqual(
      expect.arrayContaining(['WL-101', 'WL-102', 'OB-0MN9CZ48N0053L9Q'])
    );

    // After: dry-run reports zero foreign items
    const { stdout: afterOut } = await execAsync(`tsx ${cliPath} --json doctor foreign-items --dry-run`);
    const after = JSON.parse(afterOut);
    expect(after.foreignCount).toBe(0);
    expect(after.totalItems).toBe(3);

    // Own items remain
    const { stdout: listOut } = await execAsync(`tsx ${cliPath} --json list --deleted`);
    const list = JSON.parse(listOut);
    const ids = list.workItems.map((i: { id: string }) => i.id);
    expect(ids).toContain('TEST-001');
    expect(ids).toContain('TEST-002');
    expect(ids).toContain('NODASH123'); // no-dash is not foreign; stays
    expect(ids).not.toContain('WL-101');
    expect(ids).not.toContain('WL-102');
  });

  it('dry-run remains the default and does not modify the DB', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-001', title: 'own' },
      { id: 'WL-101', title: 'foreign' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor foreign-items`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);

    // DB unchanged
    const { stdout: listOut } = await execAsync(`tsx ${cliPath} --json list --deleted`);
    const list = JSON.parse(listOut);
    const ids = list.workItems.map((i: { id: string }) => i.id);
    expect(ids).toEqual(['TEST-001', 'WL-101']);
  });

  it('--apply with zero foreign items reports success and removes nothing', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-001', title: 'own' },
      { id: 'TEST-002', title: 'own deleted', status: 'deleted' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor foreign-items --apply`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.removedCount).toBe(0);
    expect(result.totalBefore).toBe(2);
    expect(result.totalAfter).toBe(2);
  });

  it('after apply, doctor prune dry-run lists only own deleted items (no foreign WL-)', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (40 * 24 * 60 * 60 * 1000)).toISOString();
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-001', title: 'own active' },
      { id: 'TEST-002', title: 'own deleted', status: 'deleted' },
      { id: 'WL-101', title: 'foreign WL deleted', status: 'deleted' },
    ]);

    // Patch timestamps so both deleted items are older than the prune cutoff
    const fs = await import('fs');
    const f = tempState.tempDir + '/.worklog/worklog-data.jsonl';
    const content = fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
    for (const rec of content) {
      if (rec.type !== 'workitem') continue;
      if (rec.data.id === 'TEST-002' || rec.data.id === 'WL-101') {
        rec.data.updatedAt = old;
      }
    }
    fs.writeFileSync(f, content.map((c: any) => JSON.stringify(c)).join('\n') + '\n', 'utf-8');

    // Apply cleanup removes the foreign WL-101
    await execAsync(`tsx ${cliPath} --json doctor foreign-items --apply`);

    // Prune dry-run now lists only own deleted items
    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor prune --dry-run --days 30`);
    const result = JSON.parse(stdout);
    expect(result.candidates).toContain('TEST-002');
    expect(result.candidates).not.toContain('WL-101');
  });

  it('produces human-readable output for --apply', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-001', title: 'own' },
      { id: 'WL-101', title: 'foreign' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} doctor foreign-items --apply`);
    expect(stdout).toContain('Doctor foreign-items:');
    expect(stdout).toContain('removed');
    expect(stdout).toContain('WL-101');
  });
});
