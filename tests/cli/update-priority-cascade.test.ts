/**
 * Tests for the priority cascade behavior of `wl update --priority`.
 *
 * When a work item's priority is downgraded away from `critical`, any direct
 * children with `critical` priority are automatically downgraded to `high`,
 * and the cascade is reported in the command output.
 *
 * Work item: WL-0MS7YCCLV000YJCR
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';

describe('update priority cascade', () => {
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
    // --allow-duplicate: the dedup guard (WL-0MSTNG2QF0049B97) would
    // otherwise return the first item for subsequent same-title creates,
    // collapsing the parent+children setup this test needs.
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "Cascade item" --allow-duplicate ${flags}`
    );
    return JSON.parse(stdout).workItem.id;
  }

  // =======================================================================
  // JSON output includes downgradedChildren when cascade happens
  // =======================================================================
  describe('JSON output', () => {
    it('should downgrade critical children and report them in JSON output', async () => {
      const parentId = await createItem('-p critical');
      const child1 = await createItem(`-p critical --parent ${parentId}`);
      const child2 = await createItem(`-p critical --parent ${parentId}`);
      const highChild = await createItem(`-p high --parent ${parentId}`);

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${parentId} --priority high`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.workItem.priority).toBe('high');
      expect(result.downgradedChildren).toBeDefined();
      expect(result.downgradedChildren).toHaveLength(2);
      const downgradedIds = result.downgradedChildren.map((c: any) => c.id);
      expect(downgradedIds.sort()).toEqual([child1, child2].sort());

      // Children updated in the DB
      const show1 = JSON.parse((await execAsync(`tsx ${cliPath} --json show ${child1}`)).stdout).workItem;
      const show2 = JSON.parse((await execAsync(`tsx ${cliPath} --json show ${child2}`)).stdout).workItem;
      const showHigh = JSON.parse((await execAsync(`tsx ${cliPath} --json show ${highChild}`)).stdout).workItem;
      expect(show1.priority).toBe('high');
      expect(show2.priority).toBe('high');
      expect(showHigh.priority).toBe('high'); // untouched
    });

    it('should downgrade critical children for any non-critical target priority', async () => {
      const parentId = await createItem('-p critical');
      const child = await createItem(`-p critical --parent ${parentId}`);

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${parentId} --priority medium`
      );
      const result = JSON.parse(stdout);

      expect(result.downgradedChildren).toHaveLength(1);
      expect(result.downgradedChildren[0].id).toBe(child);
      expect(result.downgradedChildren[0].priority).toBe('high');
    });

    it('should not include downgradedChildren when no children were changed', async () => {
      const parentId = await createItem('-p critical');
      const child = await createItem(`-p high --parent ${parentId}`);

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${parentId} --priority medium`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.workItem.priority).toBe('medium');
      expect(result.downgradedChildren).toBeUndefined();
      const showChild = JSON.parse((await execAsync(`tsx ${cliPath} --json show ${child}`)).stdout).workItem;
      expect(showChild.priority).toBe('high');
    });
  });

  // =======================================================================
  // Trigger conditions
  // =======================================================================
  describe('trigger conditions', () => {
    it('should NOT cascade when parent priority changes between non-critical values', async () => {
      const parentId = await createItem('-p high');
      const child = await createItem(`-p critical --parent ${parentId}`);

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${parentId} --priority medium`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.workItem.priority).toBe('medium');
      expect(result.downgradedChildren).toBeUndefined();
      const showChild = JSON.parse((await execAsync(`tsx ${cliPath} --json show ${child}`)).stdout).workItem;
      expect(showChild.priority).toBe('critical'); // untouched
    });

    it('should NOT cascade when parent is set to critical (critical to critical is a no-op)', async () => {
      const parentId = await createItem('-p critical');
      const child = await createItem(`-p critical --parent ${parentId}`);

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${parentId} --priority critical`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.workItem.priority).toBe('critical');
      expect(result.downgradedChildren).toBeUndefined();
      const showChild = JSON.parse((await execAsync(`tsx ${cliPath} --json show ${child}`)).stdout).workItem;
      expect(showChild.priority).toBe('critical'); // untouched
    });

    it('should cascade only for the parent whose priority changed in a batch update', async () => {
      const criticalParent = await createItem('-p critical');
      const criticalChild = await createItem(`-p critical --parent ${criticalParent}`);
      const otherParent = await createItem('-p critical');
      const otherChild = await createItem(`-p critical --parent ${otherParent}`);

      // Downgrade only the first parent
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${criticalParent} --priority low`
      );
      const result = JSON.parse(stdout);

      expect(result.downgradedChildren).toHaveLength(1);
      expect(result.downgradedChildren[0].id).toBe(criticalChild);
      // The other parent and child are untouched
      const otherShow = JSON.parse((await execAsync(`tsx ${cliPath} --json show ${otherChild}`)).stdout).workItem;
      expect(otherShow.priority).toBe('critical');
    });
  });

  // =======================================================================
  // Human-readable output
  // =======================================================================
  describe('human-readable output', () => {
    it('should print a summary of downgraded children', async () => {
      const parentId = await createItem('-p critical');
      await createItem(`-p critical --parent ${parentId}`);
      await createItem(`-p critical --parent ${parentId}`);
      await createItem(`-p critical --parent ${parentId}`);

      const { stdout } = await execAsync(
        `tsx ${cliPath} update ${parentId} --priority high`
      );

      expect(stdout).toContain('[Downgraded 3 child(ren) from critical to high]');
    });

    it('should not print downgrade summary when nothing was downgraded', async () => {
      const parentId = await createItem('-p high');

      const { stdout } = await execAsync(
        `tsx ${cliPath} update ${parentId} --priority medium`
      );

      expect(stdout).not.toContain('Downgraded');
    });
  });
});
