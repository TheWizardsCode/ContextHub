/**
 * Tests for auto-reversion of in_review items marked "not ready to close".
 *
 * When `wl update <id> --audit-text "Ready to close: No"` (or
 * `wl audit-set <id> --ready-to-close no`) runs on an item in `in_review`
 * (status `completed`), the item is automatically reverted to `open` /
 * `plan_complete` so it drops out of the ready-to-close queue. The
 * reversion is reported in JSON output (`reverted`) and as a human summary
 * line. Priority is preserved.
 *
 * Work item: WL-0MSKHYI5U0069FVV (children WL-0MT0T1D8L009B5P3,
 * WL-0MT0T1DQY0045Y5P)
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

describe('auto-revert on not-ready-to-close audit verdict', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'REVT');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createItem(flags = '', title = 'Item'): Promise<string> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "${title}" ${flags}`
    );
    return JSON.parse(stdout).workItem.id;
  }

  async function showItem(id: string): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    return JSON.parse(stdout).workItem;
  }

  // =======================================================================
  // wl update --audit-text "Ready to close: No"
  // =======================================================================
  describe('wl update --audit-text', () => {
    it('reverts an in_review/completed item and reports it in JSON output', async () => {
      const id = await createItem('--status completed --stage in_review');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id} --audit-text "Ready to close: No\nStill needs work"`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.reverted).toBeDefined();
      expect(result.reverted.item.id).toBe(id);
      expect(result.reverted.from).toEqual({ status: 'completed', stage: 'in_review' });
      expect(result.reverted.to).toEqual({ status: 'open', stage: 'plan_complete' });

      // Persisted in the DB
      const item = await showItem(id);
      expect(item.status).toBe('open');
      expect(item.stage).toBe('plan_complete');
    });

    it('preserves the item priority on reversion', async () => {
      const id = await createItem('--status completed --stage in_review --priority high');

      await execAsync(
        `tsx ${cliPath} --json update ${id} --audit-text "Ready to close: No\nNeeds more work"`
      );

      const item = await showItem(id);
      expect(item.status).toBe('open');
      expect(item.stage).toBe('plan_complete');
      expect(item.priority).toBe('high');
    });

    it('does not revert a done item', async () => {
      const id = await createItem('--status completed --stage done');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id} --audit-text "Ready to close: No\nNot relevant"`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.reverted).toBeUndefined();

      const item = await showItem(id);
      expect(item.status).toBe('completed');
      expect(item.stage).toBe('done');
    });

    it('does not revert items that are not in_review/completed', async () => {
      // Distinct titles so the create dedup guard (WL-0MSTNG2QF0049B97)
      // does not reuse the first item for the second create.
      const openId = await createItem('', 'Open item');
      const inProgressId = await createItem('', 'In-progress item');
      await execAsync(`tsx ${cliPath} --json update ${openId} --status open --stage plan_complete`);
      await execAsync(`tsx ${cliPath} --json update ${inProgressId} --status in-progress --stage in_progress`);

      for (const id of [openId, inProgressId]) {
        const { stdout } = await execAsync(
          `tsx ${cliPath} --json update ${id} --audit-text "Ready to close: No\nNope"`
        );
        const result = JSON.parse(stdout);
        expect(result.success).toBe(true);
        expect(result.reverted).toBeUndefined();
      }

      expect((await showItem(openId)).stage).toBe('plan_complete');
      expect((await showItem(inProgressId)).status).toBe('in-progress');
    });

    it('does not revert when the verdict is "Ready to close: Yes"', async () => {
      const id = await createItem('--status completed --stage in_review');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id} --audit-text "Ready to close: Yes\nAll good"`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.reverted).toBeUndefined();

      const item = await showItem(id);
      expect(item.status).toBe('completed');
      expect(item.stage).toBe('in_review');
    });

    it('prints a human-readable summary line on reversion', async () => {
      const id = await createItem('--status completed --stage in_review');

      const { stdout } = await execAsync(
        `tsx ${cliPath} update ${id} --audit-text "Ready to close: No\nMore work needed"`
      );

      expect(stdout).toContain(
        `[${id} reverted from completed/in_review to open/plan_complete]`
      );
    });

    it('does not print a summary line when no reversion occurs', async () => {
      const id = await createItem('--status completed --stage done');

      const { stdout } = await execAsync(
        `tsx ${cliPath} update ${id} --audit-text "Ready to close: No\nNope"`
      );

      expect(stdout).not.toContain('reverted from');
    });

    it('reverts only qualifying items in a batch update', async () => {
      // Distinct titles so the create dedup guard (WL-0MSTNG2QF0049B97)
      // does not reuse the first item for the second create.
      const inReviewId = await createItem('', 'In-review item');
      const doneId = await createItem('', 'Done item');
      await execAsync(`tsx ${cliPath} --json update ${inReviewId} --status completed --stage in_review`);
      await execAsync(`tsx ${cliPath} --json update ${doneId} --status completed --stage done`);

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${inReviewId} ${doneId} --audit-text "Ready to close: No\nBatch"`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      const inReviewResult = result.results.find((r: any) => r.id === inReviewId);
      const doneResult = result.results.find((r: any) => r.id === doneId);
      expect(inReviewResult.reverted).toBeDefined();
      expect(inReviewResult.reverted.to).toEqual({ status: 'open', stage: 'plan_complete' });
      expect(doneResult.reverted).toBeUndefined();

      expect((await showItem(inReviewId)).status).toBe('open');
      expect((await showItem(doneId)).status).toBe('completed');
      expect((await showItem(doneId)).stage).toBe('done');
    });
  });

  // =======================================================================
  // wl audit-set --ready-to-close no
  // =======================================================================
  describe('wl audit-set', () => {
    it('reverts an in_review/completed item and reports it in JSON output', async () => {
      const id = await createItem('--status completed --stage in_review');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json audit-set ${id} --ready-to-close no --summary "Still needs work"`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.reverted).toBeDefined();
      expect(result.reverted.item.id).toBe(id);
      expect(result.reverted.from).toEqual({ status: 'completed', stage: 'in_review' });
      expect(result.reverted.to).toEqual({ status: 'open', stage: 'plan_complete' });

      const item = await showItem(id);
      expect(item.status).toBe('open');
      expect(item.stage).toBe('plan_complete');
    });

    it('preserves the item priority on reversion', async () => {
      const id = await createItem('--status completed --stage in_review --priority critical');

      await execAsync(
        `tsx ${cliPath} --json audit-set ${id} --ready-to-close no --summary "Not done"`
      );

      const item = await showItem(id);
      expect(item.status).toBe('open');
      expect(item.stage).toBe('plan_complete');
      expect(item.priority).toBe('critical');
    });

    it('does not revert when ready-to-close is yes', async () => {
      const id = await createItem('--status completed --stage in_review');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json audit-set ${id} --ready-to-close yes --summary "Done"`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.reverted).toBeUndefined();

      const item = await showItem(id);
      expect(item.status).toBe('completed');
      expect(item.stage).toBe('in_review');
    });

    it('does not revert items that are not in_review/completed', async () => {
      const ideaId = await createItem('', 'Idea item');
      await execAsync(`tsx ${cliPath} --json update ${ideaId} --status open --stage idea`);

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json audit-set ${ideaId} --ready-to-close no --summary "Nope"`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.reverted).toBeUndefined();
      expect((await showItem(ideaId)).stage).toBe('idea');
    });

    it('does not revert a done item', async () => {
      const id = await createItem('--status completed --stage done');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json audit-set ${id} --ready-to-close no --summary "Nope"`
      );
      const result = JSON.parse(stdout);

      expect(result.success).toBe(true);
      expect(result.reverted).toBeUndefined();

      const item = await showItem(id);
      expect(item.status).toBe('completed');
      expect(item.stage).toBe('done');
    });

    it('prints a human-readable summary line on reversion', async () => {
      const id = await createItem('--status completed --stage in_review');

      const { stdout } = await execAsync(
        `tsx ${cliPath} audit-set ${id} --ready-to-close no --summary "More work"`
      );

      expect(stdout).toContain(
        `[${id} reverted from completed/in_review to open/plan_complete]`
      );
    });
  });
});
