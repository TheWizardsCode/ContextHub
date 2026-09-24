/**
 * `wl recent` must reflect semantic edits, not mechanical re-sort churn.
 *
 * Child 1 (WL-0MU2QKB98007BKYT) stopped `batchUpdateSortIndices` from stamping
 * `updatedAt`, so the audit-freshness/recency surface no longer treats a
 * sortIndex-only re-sort as activity. This test verifies that surfacing at the
 * `wl recent` layer: a re-sort that changes sortIndex values must not perturb
 * recency ordering, while a genuine semantic edit must move the item to the
 * top.
 *
 * Work item: WL-0MTWU4Y82001B3UH (parent WL-0MTWU13SU008VLW9).
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

describe('wl recent ignores mechanical re-sort churn', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createItem(title: string, flags = ''): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "${title}" ${flags}`);
    return JSON.parse(stdout).workItem;
  }

  async function recent(n = 5): Promise<any[]> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json recent -n ${n}`);
    return JSON.parse(stdout).workItems;
  }

  it('re-sort does not perturb recent ordering or stamp updatedAt; a semantic edit does', async () => {
    // Deliberately stale sort order: Alpha (low) created before Bravo (high)
    // with auto re-sort suppressed, so a later re-sort must change sortIndex.
    const alpha = await createItem('Alpha', '-p low --no-re-sort');
    const bravo = await createItem('Bravo', '-p high --no-re-sort');

    // Bravo is the most recently changed item.
    expect((await recent(2)).map(i => i.id)).toEqual([bravo.id, alpha.id]);
    const alphaUpdatedBefore = alpha.updatedAt;

    // Force a re-sort: priority wants Bravo first, so sort indices change.
    await execAsync(`tsx ${cliPath} re-sort`);

    const afterResort = await recent(2);
    // Ordering is unchanged and Alpha's updatedAt was NOT stamped by re-sort.
    expect(afterResort.map(i => i.id)).toEqual([bravo.id, alpha.id]);
    expect(afterResort.find(i => i.id === alpha.id)!.updatedAt).toBe(alphaUpdatedBefore);

    // A genuine semantic edit bumps updatedAt and moves the item to the top.
    await execAsync(`tsx ${cliPath} --json update ${alpha.id} -t "Alpha renamed"`);
    expect((await recent(1))[0].id).toBe(alpha.id);
  });

  it('a post-create comment moves an item to the top of recent without bumping updatedAt', async () => {
    const alpha = await createItem('Alpha comment target', '-p low --no-re-sort');
    await createItem('Bravo newer content', '-p high --no-re-sort');

    // Bravo is the newest by content before any comment activity.
    expect((await recent(1))[0].id).not.toBe(alpha.id);

    // Commenting on Alpha is activity: recency must surface it, but the
    // audit-relevant updatedAt must stay put (WL-0MUBVH6JM0093KVM).
    await execAsync(
      `tsx ${cliPath} --json comment add ${alpha.id} -a tester -c "activity bump"`,
    );

    const top = (await recent(1))[0];
    expect(top.id).toBe(alpha.id);
    expect(top.updatedAt).toBe(alpha.updatedAt);
    expect(top.activityAt).toBeDefined();
    expect(new Date(top.activityAt).getTime()).toBeGreaterThanOrEqual(
      new Date(top.updatedAt).getTime(),
    );
  });
});
