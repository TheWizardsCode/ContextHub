/**
 * Tests for the ancestor-promotion cascade of `wl update`.
 *
 * Contract (parent epic WL-0MWDD2JE6006CL7I, operator answer Q1-B): when a
 * work item is `critical`, every non-critical ancestor is promoted to
 * `critical`, transitively to the root. The mirror of the existing
 * `cascadePriorityDowngrade` behaviour in update-priority-cascade.test.ts.
 *
 * The write-path wiring lands with the sibling children
 * WL-0MWETWS2F006Q1W1 (`wl update`) and WL-0MWETWNSO001UL2M (shared
 * primitive). Until then the *positive* pins stay RED-as-expected via
 * `it.fails(...)` — the same test-first convention used by the sibling slice
 * WL-0MWETWBS3006D4OI in tests/database.test.ts — so the suite is green while
 * the implementation is pending. The owning implementation item flips
 * `it.fails(` to `it(` once the wiring exists.
 *
 * Pinned semantics:
 *   * only ancestors are promoted; the critical item and its descendants are
 *     untouched
 *   * the walk runs from the direct parent up to the root (nearest first)
 *   * an ancestor already at `critical` is never rewritten (the "skip but keep
 *     walking past it to the root" rule needs legacy data — a critical item
 *     under a non-critical ancestor — that no CLI path can build once the
 *     create/reparent promotion lands, so it stays pinned at the unit level in
 *     tests/database.test.ts, WL-0MWETWBS3006D4OI)
 *   * the promoted ancestors are reported as `promotedAncestors` in JSON and
 *     as a summary line in human-readable output
 *   * re-running an update that changes nothing promotes nothing
 *   * reparenting a critical item promotes the *new* ancestor chain; it never
 *     reverses a promotion of the previous chain (reversal is out of scope)
 *
 * Work item: WL-0MWETWFSH007GRTR
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

/** Spawned-CLI budget; each tsx startup is slow under concurrent load. */
const CLI_TIMEOUT = 60000;

describe('update priority promote', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createItem(title: string, flags = ''): Promise<string> {
    // --allow-duplicate: the dedup guard (WL-0MSTNG2QF0049B97) would otherwise
    // collapse the parent/child chain this test needs into a single item.
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "${title}" --allow-duplicate ${flags}`
    );
    return JSON.parse(stdout).workItem.id;
  }

  async function showItem(id: string): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    return JSON.parse(stdout).workItem;
  }

  /** `promotedAncestors` is optional in the JSON contract: absent or empty. */
  function promotedIds(result: any): string[] {
    return (result.promotedAncestors ?? []).map((a: any) => a.id);
  }

  // =======================================================================
  // JSON output
  // =======================================================================
  describe('JSON output', () => {
    it.fails(
      'should promote every ancestor transitively to the root and report them',
      async () => {
        const root = await createItem('Root', '-p medium');
        const middle = await createItem('Middle', `-p low --parent ${root}`);
        const parent = await createItem('Parent', `-p high --parent ${middle}`);
        const child = await createItem('Child', `-p medium --parent ${parent}`);

        const { stdout } = await execAsync(
          `tsx ${cliPath} --json update ${child} --priority critical`
        );
        const result = JSON.parse(stdout);

        expect(result.success).toBe(true);
        expect(result.workItem.priority).toBe('critical');
        expect(result.promotedAncestors).toBeDefined();
        expect(promotedIds(result)).toEqual([parent, middle, root]);
        expect(result.promotedAncestors.every((a: any) => a.priority === 'critical')).toBe(true);

        // Persisted, not just echoed in the update result.
        expect((await showItem(parent)).priority).toBe('critical');
        expect((await showItem(middle)).priority).toBe('critical');
        expect((await showItem(root)).priority).toBe('critical');
        // The critical item itself is untouched.
        expect((await showItem(child)).priority).toBe('critical');
      },
      CLI_TIMEOUT
    );

    it.fails(
      'should be a no-op when the same update is re-run (already critical)',
      async () => {
        const parent = await createItem('Parent', '-p high');
        const child = await createItem('Child', `-p medium --parent ${parent}`);

        const first = JSON.parse(
          (await execAsync(`tsx ${cliPath} --json update ${child} --priority critical`)).stdout
        );
        expect(promotedIds(first)).toEqual([parent]);

        const second = JSON.parse(
          (await execAsync(`tsx ${cliPath} --json update ${child} --priority critical`)).stdout
        );
        expect(second.success).toBe(true);
        expect(second.workItem.priority).toBe('critical');
        expect(promotedIds(second)).toEqual([]);
        expect((await showItem(parent)).priority).toBe('critical');
      },
      CLI_TIMEOUT
    );
  });

  // =======================================================================
  // Reparenting trigger
  // =======================================================================
  describe('reparenting', () => {
    it.fails(
      'should promote the new ancestor chain when a critical item is reparented',
      async () => {
        const oldRoot = await createItem('Old root', '-p medium');
        const item = await createItem('Item', `-p medium --parent ${oldRoot}`);
        // Making the item critical promotes its then-current chain.
        await execAsync(`tsx ${cliPath} --json update ${item} --priority critical`);
        expect((await showItem(oldRoot)).priority).toBe('critical');

        const newRoot = await createItem('New root', '-p medium');
        const newParent = await createItem('New parent', `-p low --parent ${newRoot}`);

        // Reparent without touching --priority: the item is already critical,
        // so attaching it under a non-critical chain must promote that chain.
        const { stdout } = await execAsync(
          `tsx ${cliPath} --json update ${item} --parent ${newParent}`
        );
        const result = JSON.parse(stdout);

        expect(result.success).toBe(true);
        expect(result.workItem.parentId).toBe(newParent);
        expect(promotedIds(result)).toEqual([newParent, newRoot]);
        expect((await showItem(newParent)).priority).toBe('critical');
        expect((await showItem(newRoot)).priority).toBe('critical');
        // No reversal (out of scope): the previous chain keeps its priority.
        expect((await showItem(oldRoot)).priority).toBe('critical');
        expect((await showItem(item)).priority).toBe('critical');
      },
      CLI_TIMEOUT
    );

    it(
      'should not promote ancestors when a non-critical item is reparented',
      async () => {
        const newRoot = await createItem('New root', '-p high');
        const newParent = await createItem('New parent', `-p medium --parent ${newRoot}`);
        const item = await createItem('Item', '-p high');

        const { stdout } = await execAsync(
          `tsx ${cliPath} --json update ${item} --parent ${newParent}`
        );
        const result = JSON.parse(stdout);

        expect(result.success).toBe(true);
        expect(result.promotedAncestors ?? []).toHaveLength(0);
        expect((await showItem(newParent)).priority).toBe('medium');
        expect((await showItem(newRoot)).priority).toBe('high');
      },
      CLI_TIMEOUT
    );
  });

  // =======================================================================
  // Trigger conditions
  // =======================================================================
  describe('trigger conditions', () => {
    it(
      'should NOT promote when priority changes between non-critical values',
      async () => {
        const root = await createItem('Root', '-p medium');
        const parent = await createItem('Parent', `-p high --parent ${root}`);
        const child = await createItem('Child', `-p high --parent ${parent}`);

        const childUpdate = JSON.parse(
          (await execAsync(`tsx ${cliPath} --json update ${child} --priority low`)).stdout
        );
        expect(childUpdate.success).toBe(true);
        expect(childUpdate.promotedAncestors ?? []).toHaveLength(0);
        expect((await showItem(root)).priority).toBe('medium');

        // A middle item changing high -> medium must not promote its own root.
        const parentUpdate = JSON.parse(
          (await execAsync(`tsx ${cliPath} --json update ${parent} --priority medium`)).stdout
        );
        expect(parentUpdate.success).toBe(true);
        expect(parentUpdate.promotedAncestors ?? []).toHaveLength(0);
        expect((await showItem(root)).priority).toBe('medium');
        // Only ancestors are promoted — descendants are never touched.
        expect((await showItem(child)).priority).toBe('low');
      },
      CLI_TIMEOUT
    );

    it(
      'should report no promotion when every ancestor is already critical',
      async () => {
        const root = await createItem('Root', '-p critical');
        const parent = await createItem('Parent', `-p critical --parent ${root}`);
        const child = await createItem('Child', `-p medium --parent ${parent}`);

        const { stdout } = await execAsync(
          `tsx ${cliPath} --json update ${child} --priority critical`
        );
        const result = JSON.parse(stdout);

        expect(result.success).toBe(true);
        expect(result.workItem.priority).toBe('critical');
        expect(result.promotedAncestors ?? []).toHaveLength(0);
        expect((await showItem(parent)).priority).toBe('critical');
        expect((await showItem(root)).priority).toBe('critical');
      },
      CLI_TIMEOUT
    );

    it.fails(
      'should restrict a batch update to each touched item, with no cross-item leakage',
      async () => {
        const rootA = await createItem('Root A', '-p medium');
        const itemA = await createItem('Item A', `-p low --parent ${rootA}`);
        const rootB = await createItem('Root B', '-p low');
        const itemB = await createItem('Item B', `-p high --parent ${rootB}`);
        const rootC = await createItem('Root C', '-p medium');
        const itemC = await createItem('Item C', `-p medium --parent ${rootC}`);

        const { stdout } = await execAsync(
          `tsx ${cliPath} --json update ${itemA} ${itemB} --priority critical`
        );
        const result = JSON.parse(stdout);

        expect(result.success).toBe(true);
        expect(result.results).toHaveLength(2);
        const byId = new Map(result.results.map((r: any) => [r.id, r]));
        expect(promotedIds(byId.get(itemA))).toEqual([rootA]);
        expect(promotedIds(byId.get(itemB))).toEqual([rootB]);

        expect((await showItem(rootA)).priority).toBe('critical');
        expect((await showItem(rootB)).priority).toBe('critical');
        // Untouched chain is never promoted.
        expect((await showItem(rootC)).priority).toBe('medium');
        expect((await showItem(itemC)).priority).toBe('medium');
      },
      CLI_TIMEOUT
    );
  });

  // =======================================================================
  // Human-readable output
  // =======================================================================
  describe('human-readable output', () => {
    it.fails(
      'should print a summary of promoted ancestors',
      async () => {
        const root = await createItem('Root', '-p medium');
        const parent = await createItem('Parent', `-p low --parent ${root}`);
        const child = await createItem('Child', `-p medium --parent ${parent}`);

        const { stdout } = await execAsync(
          `tsx ${cliPath} update ${child} --priority critical`
        );

        expect(stdout).toContain('[Promoted 2 ancestor(s) to critical]');
      },
      CLI_TIMEOUT
    );

    it(
      'should not print promotion summary when nothing was promoted',
      async () => {
        const parent = await createItem('Parent', '-p medium');
        const child = await createItem('Child', `-p high --parent ${parent}`);

        const { stdout } = await execAsync(
          `tsx ${cliPath} update ${child} --priority low`
        );

        expect(stdout).not.toContain('Promoted');
      },
      CLI_TIMEOUT
    );
  });
});
