/**
 * Tests for parent demotion when a child is added to a completed/in_review parent.
 *
 * `wl create --parent <id>` and `wl update <id> --parent <parent>` demote the
 * target parent from `completed`/`in_review` to `open`/`plan_complete`, so a
 * completed parent never silently gains uncompleted children. The demotion is
 * reported in JSON output (`demotedParent`) and as a human summary line.
 *
 * Work item: WL-0MSJL00P5004Y0L6
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

describe('parent demotion on child add', () => {
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
  // wl create --parent
  // =======================================================================
  describe('wl create --parent', () => {
    it('should demote a completed/in_review parent and report it in JSON output', async () => {
      const parentId = await createItem('--status completed --stage in_review');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Child" --parent ${parentId}`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.demotedParent).toBeDefined();
      expect(result.demotedParent.parent.id).toBe(parentId);
      expect(result.demotedParent.from).toEqual({ status: 'completed', stage: 'in_review' });
      expect(result.demotedParent.to).toEqual({ status: 'open', stage: 'plan_complete' });

      // Parent demoted in the DB
      const parent = await showItem(parentId);
      expect(parent.status).toBe('open');
      expect(parent.stage).toBe('plan_complete');
    });

    it('should demote a completed/done parent', async () => {
      const parentId = await createItem('--status completed --stage done');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Child" --parent ${parentId}`
      );
      const result = JSON.parse(stdout);

      expect(result.demotedParent).toBeDefined();
      expect(result.demotedParent.from).toEqual({ status: 'completed', stage: 'done' });
      expect(result.demotedParent.to).toEqual({ status: 'open', stage: 'plan_complete' });
    });

    it('should not demote a parent that is not completed/in_review', async () => {
      const parentId = await createItem('--status open --stage plan_complete');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Child" --parent ${parentId}`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.demotedParent).toBeUndefined();

      const parent = await showItem(parentId);
      expect(parent.status).toBe('open');
      expect(parent.stage).toBe('plan_complete');
    });

    it('should print a human-readable summary line on demotion', async () => {
      const parentId = await createItem('--status completed --stage in_review');

      const { stdout } = await execAsync(
        `tsx ${cliPath} create -t "Child" --parent ${parentId}`
      );

      expect(stdout).toContain(
        `[Parent ${parentId} demoted from completed/in_review to open/plan_complete]`
      );
    });

    it('should not print a summary line when no demotion occurs', async () => {
      const parentId = await createItem('--status open --stage idea');

      const { stdout } = await execAsync(
        `tsx ${cliPath} create -t "Child" --parent ${parentId}`
      );

      expect(stdout).not.toContain('demoted from');
    });
  });

  // =======================================================================
  // wl update --parent (reparenting)
  // =======================================================================
  describe('wl update --parent (reparenting)', () => {
    it('should demote the target parent when reparenting under a completed parent', async () => {
      const parentId = await createItem('--status completed --stage in_review');
      const childId = await createItem('--status open --stage idea');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${childId} --parent ${parentId}`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.demotedParent).toBeDefined();
      expect(result.demotedParent.parent.id).toBe(parentId);
      expect(result.demotedParent.from).toEqual({ status: 'completed', stage: 'in_review' });
      expect(result.demotedParent.to).toEqual({ status: 'open', stage: 'plan_complete' });

      // Parent demoted and child attached in the DB
      const parent = await showItem(parentId);
      expect(parent.status).toBe('open');
      expect(parent.stage).toBe('plan_complete');
      const child = await showItem(childId);
      expect(child.parentId).toBe(parentId);
    });

    it('should not demote when reparenting under an open parent', async () => {
      const parentId = await createItem('--status open --stage idea');
      const childId = await createItem('--status open --stage idea');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${childId} --parent ${parentId}`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.demotedParent).toBeUndefined();
    });

    it('should print a human-readable summary line on reparenting demotion', async () => {
      const parentId = await createItem('--status completed --stage done');
      const childId = await createItem('--status open --stage idea');

      const { stdout } = await execAsync(
        `tsx ${cliPath} update ${childId} --parent ${parentId}`
      );

      expect(stdout).toContain(
        `[Parent ${parentId} demoted from completed/done to open/plan_complete]`
      );
    });
  });

  // =======================================================================
  // Automation-authored children (WL-0MTWU4XUD0001ALR)
  // =======================================================================
  describe('automation-authored children', () => {
    it('does not demote a completed parent when a test-failure bot child is attached via create', async () => {
      const parentId = await createItem('--status completed --stage in_review');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "[test-failure] suite exited 1" ` +
          `--parent ${parentId} --tags test-failure --priority critical --stage idea`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.demotedParent).toBeUndefined();

      // Child is attached (telemetry stays discoverable) but the parent is
      // untouched: a finished parent is not silently rewound.
      const child = await showItem(result.workItem.id);
      expect(child.parentId).toBe(parentId);
      const parent = await showItem(parentId);
      expect(parent.status).toBe('completed');
      expect(parent.stage).toBe('in_review');
    });

    it('does not demote a completed parent when a bot child is attached via reparenting', async () => {
      const parentId = await createItem('--status completed --stage in_review');
      const botChildId = await createItem('--tags test-failure --stage idea');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${botChildId} --parent ${parentId}`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.demotedParent).toBeUndefined();

      const child = await showItem(botChildId);
      expect(child.parentId).toBe(parentId);
      const parent = await showItem(parentId);
      expect(parent.status).toBe('completed');
      expect(parent.stage).toBe('in_review');
    });

    it('still demotes for a human-authored child (original demotion intent preserved)', async () => {
      const parentId = await createItem('--status completed --stage in_review');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Missed subtask" --parent ${parentId}`
      );
      const result = JSON.parse(stdout);

      expect(result.demotedParent).toBeDefined();
      expect(result.demotedParent.parent.id).toBe(parentId);
      const parent = await showItem(parentId);
      expect(parent.status).toBe('open');
      expect(parent.stage).toBe('plan_complete');
    });
  });
});
