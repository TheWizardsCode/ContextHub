/**
 * CLI integration tests for `--parent null` detach (WL-0MUJM2LV1000IHKR).
 *
 * When a user writes `wl update <id> --parent null` (or `none`, `nil`, `-`,
 * `""`), the item's `parentId` must be set to `null` rather than producing
 * the bogus `WL-NULL` parent that `normalizeCliId` would otherwise build.
 *
 * The same sentinel is accepted by `wl create`.
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

describe('parent detach via --parent sentinel', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createItem(flags = ''): Promise<string> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "Item" ${flags}`
    );
    return JSON.parse(stdout).workItem.id;
  }

  async function showItem(id: string): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    return JSON.parse(stdout).workItem;
  }

  // =======================================================================
  // wl update --parent (detach)
  // =======================================================================
  describe('wl update --parent', () => {
    it('should detach an item with --parent null (AC1)', async () => {
      const parentId = 'TEST-1';
      const childId = 'TEST-2';
      // Seed a parent-child pair via the DB directly to avoid in-process create --parent parsing
      seedWorkItems(tempState.tempDir, [
        { id: parentId, title: 'Parent' },
        { id: childId, title: 'Child', parentId },
      ]);

      // Verify child was attached
      const child = await showItem(childId);
      expect(child.parentId).toBe(parentId);

      // Detach with --parent null
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${childId} --parent null`
      );
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);

      // Verify parentId is null
      const detached = await showItem(childId);
      expect(detached.parentId).toBeNull();

      // WL-NULL must not have been created
      const wlNullRun = await execAsync(
        `tsx ${cliPath} --json show WL-NULL`
      ).catch((e) => e as { stdout: string; stderr: string });
      const wlNullReport = JSON.parse(
        (wlNullRun as { stderr: string }).stderr || (wlNullRun as { stdout: string }).stdout
      );
      expect(wlNullReport.success).toBe(false);
    });

    it('should detach with --parent "none" (AC3)', async () => {
      const parentId = await createItem();
      const childId = await createItem(`--parent ${parentId}`);

      await execAsync(`tsx ${cliPath} --json update ${childId} --parent none`);
      const item = await showItem(childId);
      expect(item.parentId).toBeNull();
    });

    it('should detach with --parent "" (AC3)', async () => {
      const parentId = await createItem();
      const childId = await createItem(`--parent ${parentId}`);

      await execAsync(`tsx ${cliPath} --json update ${childId} --parent ""`);
      const item = await showItem(childId);
      expect(item.parentId).toBeNull();
    });

    it('should detach with --parent nil (AC3)', async () => {
      const parentId = await createItem();
      const childId = await createItem(`--parent ${parentId}`);

      await execAsync(`tsx ${cliPath} --json update ${childId} --parent nil`);
      const item = await showItem(childId);
      expect(item.parentId).toBeNull();
    });

    it('should detach with --parent "-" (AC3)', async () => {
      const parentId = await createItem();
      const childId = await createItem(`--parent ${parentId}`);

      await execAsync(`tsx ${cliPath} --json update ${childId} --parent -`);
      const item = await showItem(childId);
      expect(item.parentId).toBeNull();
    });

    it('should NOT treat a real id as detach (AC4 interpretation)', async () => {
      const childId = await createItem();
      // WL-DOESNOTEXIST is not a sentinel — it goes through normalizeCliId
      // unchanged and is stored as-is (not converted to null).
      await execAsync(
        `tsx ${cliPath} --json update ${childId} --parent WL-DOESNOTEXIST`
      );
      const item = await showItem(childId);
      expect(item.parentId).toBe('WL-DOESNOTEXIST');
    });
  });

  // =======================================================================
  // wl create --parent
  // =======================================================================
  describe('wl create --parent', () => {
    it('should create a top-level item with --parent null (AC2)', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Root item" --parent null`
      );
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.parentId).toBeNull();
    });

    it('should create a top-level item with --parent none (AC3)', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Root item" --parent none`
      );
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.parentId).toBeNull();
    });

    it('should create a child with a real parent id', async () => {
      const parentId = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Child" --parent ${parentId}`
      );
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.parentId).toBe(parentId);
    });
  });

  // =======================================================================
  // wl doctor dangling-parents
  // =======================================================================
  describe('wl doctor dangling-parents', () => {
    it('should detect a dangling WL-NULL parent reference (AC6/AC8)', async () => {
      // First, create an item that accidentally got WL-NULL (simulate pre-fix state)
      const parentId = await createItem();
      const childId = await createItem(`--parent ${parentId}`);
      // Manually set parentId to WL-NULL to simulate pre-fix state
      await execAsync(
        `tsx ${cliPath} --json update ${childId} --parent WL-NULL`
      );

      // Doctor should detect it
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json doctor dangling-parents`
      );
      const report = JSON.parse(stdout);
      expect(report.count).toBeGreaterThanOrEqual(1);
      expect(report.items.some((i: any) => i.parentId === 'WL-NULL')).toBe(true);
    });

    it('should fix dangling parents with --apply (AC8)', async () => {
      const parentId = await createItem();
      const childId = await createItem(`--parent ${parentId}`);
      // Simulate pre-fix state
      await execAsync(
        `tsx ${cliPath} --json update ${childId} --parent WL-NULL`
      );

      // Apply fix
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json doctor dangling-parents --apply`
      );
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.fixed.some((f: any) => f.id === childId)).toBe(true);

      // Verify fix
      const item = await showItem(childId);
      expect(item.parentId).toBeNull();
    });

    it('should report zero dangling parents when none exist', async () => {
      await createItem();
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json doctor dangling-parents`
      );
      const report = JSON.parse(stdout);
      expect(report.success).toBe(true);
      expect(report.items).toEqual([]);
    });

    it('should remediate dangling parents via `wl doctor --fix` (AC6)', async () => {
      seedWorkItems(tempState.tempDir, [
        { id: 'TEST-DANGLING', title: 'Dangling child', parentId: 'WL-NULL' },
      ]);

      await execAsync(`tsx ${cliPath} --json doctor --fix`);

      const item = await showItem('TEST-DANGLING');
      expect(item.parentId).toBeNull();
    });
  });

  // =======================================================================
  // Help text (AC5/AC7)
  // =======================================================================
  describe('help text', () => {
    it('documents the detach form in create --help', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} create --help`);
      expect(stdout).toMatch(/--parent/);
      expect(stdout).toMatch(/null/i);
    });

    it('documents the detach form in update --help', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} update --help`);
      expect(stdout).toMatch(/--parent/);
      expect(stdout).toMatch(/detach/i);
    });

    it('lists the dangling-parents doctor subcommand', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} doctor --help`);
      expect(stdout).toMatch(/dangling-parents/);
    });
  });
});
