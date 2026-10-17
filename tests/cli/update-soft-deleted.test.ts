/**
 * tests/cli/update-soft-deleted.test.ts — `wl update` must not resurrect a
 * soft-deleted work item.
 *
 * A soft delete (`wl delete`) sets `deletedBy` (and `deleteReason`) and may
 * leave the item's status untouched. Before this guard, `wl update <id>
 * --status <open|in-progress>` rewrote the status of an item whose `deletedBy`
 * was set, after which the downtime dispatcher re-selected it and worked it a
 * second time (SA-0MUJBLZC60085DI9 — the false-positive test-failure item
 * SA-0MUJ14FQQ006R3PD was resurrected this way).
 *
 * The guard treats a non-empty `deletedBy` as the authoritative deletion
 * marker: any mutation other than an explicit change to the delete-attribution
 * fields (`--deleted-by`/`--delete-reason`) is rejected per-id with a clear
 * error naming the item, and the command exits non-zero. A batch edit still
 * applies to live ids.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';

describe('wl update refuses to resurrect a soft-deleted work item', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createItem(title = 'Soft-delete guard item', flags = ''): Promise<string> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "${title}" ${flags}`
    );
    return JSON.parse(stdout).workItem.id;
  }

  async function deleteItem(id: string): Promise<void> {
    // Attribute the delete (WL-0MSKZ30SK007K9TO): `wl delete` reads
    // `deletedBy` from `git config user.email`, which the test git mock
    // serves from `.git/user-email`. Without attribution the soft-delete
    // marker (`deletedBy`) stays empty and the guard has nothing to
    // key on — this is the exact real-world shape the guard protects.
    mkdirSync(join(tempState.tempDir, '.git'), { recursive: true });
    writeFileSync(join(tempState.tempDir, '.git', 'user-email'), 'deleter@example.com');
    await execAsync(`tsx ${cliPath} --json delete ${id} --no-sync`);
  }

  async function showItem(id: string): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    return JSON.parse(stdout).workItem;
  }

  it('rejects a status mutation on a soft-deleted item and exits non-zero', async () => {
    const id = await createItem();
    await deleteItem(id);

    const run = await execAsync(
      `tsx ${cliPath} --json update ${id} --status in_progress`,
    ).catch((e) => e as { stdout: string; stderr: string; exitCode?: number });

    const parsed = JSON.parse((run as { stderr: string }).stderr || (run as { stdout: string }).stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('deleted-item');
    // The error names the deleted item so the operator can act on it.
    expect(parsed.message ?? '').toContain(id);
    // Non-zero exit is what callers (and the dispatcher) observe.
    expect(run.exitCode).not.toBe(0);
  });

  it('leaves the deleted item untouched after the refusal', async () => {
    const id = await createItem();
    await deleteItem(id);
    const before = await showItem(id);

    await execAsync(`tsx ${cliPath} --json update ${id} --status in_progress`).catch(() => undefined);

    const after = await showItem(id);
    expect(after.status).toBe(before.status);
    expect(after.deletedBy).toBe(before.deletedBy);
  });

  it('rejects a stage mutation on a soft-deleted item (no resurrection route)', async () => {
    const id = await createItem('Stage guard', '--stage idea');
    await deleteItem(id);

    const run = await execAsync(
      `tsx ${cliPath} --json update ${id} --stage plan_complete`,
    ).catch((e) => e as { stdout: string; stderr: string });

    const parsed = JSON.parse((run as { stderr: string }).stderr || (run as { stdout: string }).stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('deleted-item');
  });

  it('still updates a live item normally (guard is scoped to deleted items)', async () => {
    const id = await createItem();
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --status in_progress`,
    );
    expect(JSON.parse(stdout).workItem.status).toBe('in-progress');
  });

  it('batch update applies to the live id and rejects the deleted id', async () => {
    const liveId = await createItem('Live item');
    const deletedId = await createItem('Deleted item');
    await deleteItem(deletedId);

    const run = await execAsync(
      `tsx ${cliPath} --json update ${liveId} ${deletedId} --status in_progress`,
    ).catch((e) => e as { stdout: string; stderr: string });

    const parsed = JSON.parse((run as { stderr: string }).stderr || (run as { stdout: string }).stdout);
    expect(parsed.success).toBe(false);
    const results: any[] = parsed.results ?? [];
    const live = results.find((r) => r.id === liveId);
    const deleted = results.find((r) => r.id === deletedId);
    expect(live?.success).toBe(true);
    expect(deleted?.success).toBe(false);
    expect(deleted?.error).toBe('deleted-item');
    // The live item really moved.
    expect((await showItem(liveId)).status).toBe('in-progress');
  });
});
