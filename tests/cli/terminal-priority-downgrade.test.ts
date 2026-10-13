/**
 * CLI integration tests for the terminal-state `critical` priority
 * auto-downgrade (WL-0MSJM4EIV001A0V9).
 *
 * When a `critical` work item transitions to a terminal state — `status`
 * `completed` or `stage` `in_review` via `wl update`, or via `wl close` — its
 * priority is automatically downgraded to `high` and the change is reported in
 * both JSON and human-readable output, mirroring the existing
 * `downgradedChildren` reporting for the priority cascade.
 *
 * Non-terminal transitions and non-critical priorities are no-ops.
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

async function runJson(args: string): Promise<any> {
  const { stdout } = await execAsync(`tsx ${cliPath} --json ${args}`);
  return JSON.parse(stdout);
}

describe('terminal priority auto-downgrade', () => {
  let tempState: { tempDir: string; originalCwd: string };
  let seq = 0;

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
    seq = 0;
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  /**
   * Create a work item via the CLI. The `--stage ""` flag gives an item an
   * empty (undefined) stage so a later `--status completed` is a valid
   * combination on its own (the test config allows `completed` only with
   * `in_review`/`done`).
   */
  async function createItem(flags: string): Promise<string> {
    seq += 1;
    const result = await runJson(
      `create -t "Terminal item ${seq}" --allow-duplicate ${flags}`
    );
    return result.workItem.id;
  }

  // ── AC1: terminal transitions downgrade critical → high ────────────────
  describe('wl update --status completed', () => {
    it('downgrades a critical item and reports the downgrade in JSON', async () => {
      const id = await createItem('-p critical --stage ""');

      const result = await runJson(`update ${id} --status completed`);

      expect(result.success).toBe(true);
      expect(result.workItem.status).toBe('completed');
      expect(result.workItem.priority).toBe('high');
      expect(result.downgradedItem).toBeDefined();
      expect(result.downgradedItem.id).toBe(id);
      expect(result.downgradedItem.priority).toBe('high');

      const shown = await runJson(`show ${id}`);
      expect(shown.workItem.priority).toBe('high');
    });
  });

  describe('wl update --stage in_review', () => {
    it('downgrades a critical item when only the stage becomes terminal', async () => {
      const id = await createItem('-p critical --stage ""');
      await runJson(`update ${id} --status in_progress`);

      const result = await runJson(`update ${id} --stage in_review`);

      expect(result.workItem.stage).toBe('in_review');
      expect(result.workItem.priority).toBe('high');
      expect(result.downgradedItem).toBeDefined();
      expect(result.downgradedItem.id).toBe(id);
    });
  });

  describe('wl close', () => {
    it('downgrades a critical item and reports it in the close results', async () => {
      const id = await createItem('-p critical --stage ""');

      const result = await runJson(`close ${id} -r "done"`);

      expect(result.closed).toBe(1);
      const res = result.results[0];
      expect(res.success).toBe(true);
      expect(res.downgradedItems).toHaveLength(1);
      expect(res.downgradedItems[0].id).toBe(id);
      expect(res.downgradedItems[0].priority).toBe('high');

      const shown = await runJson(`show ${id}`);
      expect(shown.workItem.priority).toBe('high');
      expect(shown.workItem.status).toBe('completed');
    });

    it('reports every downgraded item when force-closing a critical subtree', async () => {
      const parent = await createItem('-p critical --stage ""');
      const child = await createItem(`-p critical --stage "" --parent ${parent}`);

      const result = await runJson(`close ${parent} --force`);

      const res = result.results[0];
      expect(res.success).toBe(true);
      expect(res.downgradedItems).toHaveLength(2);
      expect(res.downgradedItems.map((d: any) => d.id).sort()).toEqual(
        [parent, child].sort()
      );

      expect((await runJson(`show ${parent}`)).workItem.priority).toBe('high');
      expect((await runJson(`show ${child}`)).workItem.priority).toBe('high');
    });
  });

  // ── AC2/AC4: no-op cases ───────────────────────────────────────────────
  describe('no-op cases', () => {
    it('leaves non-critical priorities unchanged on a terminal transition', async () => {
      for (const priority of ['high', 'medium', 'low']) {
        const id = await createItem(`-p ${priority} --stage ""`);

        const result = await runJson(`update ${id} --status completed`);

        expect(result.workItem.priority).toBe(priority);
        expect(result.downgradedItem).toBeUndefined();
      }
    });

    it('leaves a critical item intact on a non-terminal transition', async () => {
      const id = await createItem('-p critical --stage ""');

      const result = await runJson(`update ${id} --stage plan_complete`);

      expect(result.workItem.stage).toBe('plan_complete');
      expect(result.workItem.priority).toBe('critical');
      expect(result.downgradedItem).toBeUndefined();
    });

    it('does not re-downgrade an already-terminal item on a later edit', async () => {
      const id = await createItem('-p critical --stage ""');
      // Terminal transition downgrades to high; set it back to critical to
      // prove the later edit does not silently rewrite an already-terminal
      // item (only an actual transition triggers the downgrade).
      await runJson(`update ${id} --status completed`);
      await runJson(`update ${id} --priority critical`);

      const result = await runJson(`update ${id} --title "Edited"`);

      expect(result.workItem.priority).toBe('critical');
      expect(result.downgradedItem).toBeUndefined();
    });
  });

  // ── AC3: human-readable reporting ──────────────────────────────────────
  describe('human-readable output', () => {
    it('prints a downgrade summary line for update and close', async () => {
      const updated = await createItem('-p critical --stage ""');
      const { stdout: updateOut } = await execAsync(
        `tsx ${cliPath} update ${updated} --status completed`
      );
      expect(updateOut).toContain(
        `[Downgraded priority of ${updated} from critical to high]`
      );

      const closed = await createItem('-p critical --stage ""');
      const { stdout: closeOut } = await execAsync(
        `tsx ${cliPath} close ${closed} -r "done"`
      );
      expect(closeOut).toContain('Closed');
      expect(closeOut).toContain('[Downgraded 1 item from critical to high]');
    });
  });
});
