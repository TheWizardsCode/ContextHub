/**
 * Integration tests for `wl undelete <ids...>` (WL-0MWMRNL2W003W5R3).
 *
 * Covers the acceptance criteria:
 *   AC1 — restore clears the tombstone, returns the item to a live status and
 *         keeps its stage; the item is visible to show/list again
 *   AC2 — an audit comment records the restoring identity and the previous
 *         deletedBy/deleteReason/status
 *   AC3 — recursive restore of cascade-deleted descendants, `--no-recursive`,
 *         and a descendant deleted in its own right is left deleted
 *   AC4 — idempotence + batch semantics (skip live, fail unknown, exit codes)
 *   AC5 — `--dry-run` mutates nothing
 *   AC6 — auto-sync runs exactly once for the batch; `--no-sync` suppresses
 *   Constraint — `wl update` keeps refusing field mutations on a soft-deleted
 *         item; `undelete` is the sanctioned path
 *
 * `performSync` is mocked so sync invocation counts can be asserted without a
 * real git remote round-trip. Database mutations are exercised for real.
 */

import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runInProcess } from './cli-inproc.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { getPackageVersion } from './cli-helpers.js';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const { performSyncMock } = vi.hoisted(() => ({
  performSyncMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/commands/sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/sync.js')>();
  return {
    ...actual,
    performSync: performSyncMock,
  };
});

let tempDir: string;
let worklogDir: string;
let titleCounter = 0;

beforeEach(async () => {
  tempDir = createTempDir();
  process.chdir(tempDir);

  childProcess.execSync('git init', { cwd: tempDir });
  // A real identity makes delete attribution non-empty (the audit comment and
  // the tombstone assertions depend on it), mirroring a developer machine.
  childProcess.execSync('git config user.email "deleter@example.com"', { cwd: tempDir });
  childProcess.execSync('git config user.name "Deleter"', { cwd: tempDir });
  fs.writeFileSync(path.join(tempDir, 'README.md'), '# Undelete Test\n', 'utf8');
  childProcess.execSync('git add README.md', { cwd: tempDir });
  childProcess.execSync('git commit -m "initial commit"', { cwd: tempDir });

  worklogDir = path.join(tempDir, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });

  fs.writeFileSync(
    path.join(worklogDir, 'config.yaml'),
    [
      'projectName: UndeleteTest',
      'prefix: UND',
      'statuses:',
      '  - value: open',
      '    label: Open',
      '  - value: in-progress',
      '    label: In Progress',
      '  - value: blocked',
      '    label: Blocked',
      '  - value: completed',
      '    label: Completed',
      '  - value: deleted',
      '    label: Deleted',
      'stages:',
      '  - value: ""',
      '    label: Undefined',
      '  - value: idea',
      '    label: Idea',
      '  - value: plan_complete',
      '    label: Plan Complete',
      '  - value: in_progress',
      '    label: In Progress',
      '  - value: in_review',
      '    label: In Review',
      '  - value: done',
      '    label: Done',
      'statusStageCompatibility:',
      '  open: ["", idea, plan_complete, in_progress]',
      '  in-progress: [in_progress]',
      '  blocked: ["", idea, plan_complete]',
      '  completed: [in_review, done]',
      '  deleted: ["", idea, plan_complete, done]',
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(worklogDir, 'initialized'),
    JSON.stringify({ version: getPackageVersion(), initializedAt: new Date().toISOString() }),
    'utf8'
  );

  performSyncMock.mockClear();
  performSyncMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

/** Create a work item and return the parsed JSON output. */
async function createItem(title?: string, extraArgs: string = ''): Promise<any> {
  const uniqueTitle = title ?? `item-${++titleCounter}-${Date.now()}`;
  const result = await runInProcess(
    `node src/cli.ts --json create -t "${uniqueTitle}"${extraArgs ? ' ' + extraArgs : ''}`,
    15000
  );
  return JSON.parse(result.stdout);
}

/** Run a `wl` subcommand in-process and return the raw result. */
async function run(
  args: string,
  timeout = 15000
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await runInProcess(`node src/cli.ts${args}`, timeout);
}

/** Fetch a work item via `wl show`. Returns null when not found. */
async function getItem(id: string): Promise<any | null> {
  const result = await run(` --json show ${id}`, 10000);
  if (result.exitCode !== 0) return null;
  try {
    return JSON.parse(result.stdout)?.workItem ?? null;
  } catch {
    return null;
  }
}

/** Fetch an item's comments via `wl comment list --json`. */
async function getComments(id: string): Promise<any[]> {
  const result = await run(` --json comment list ${id}`, 10000);
  if (result.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed?.comments ?? [];
  } catch {
    return [];
  }
}

/**
 * Delete one or more ids (recursive by default, sync suppressed).
 *
 * `--deleted-by` is explicit so the tombstone attribution is deterministic: the
 * default falls back to the configured git identity, which the in-process
 * harness may not have.
 */
async function deleteItems(ids: string[], extraArgs = '--no-sync'): Promise<void> {
  const result = await run(
    ` --json delete ${ids.join(' ')} --deleted-by deleter@example.com ${extraArgs}`,
    15000
  );
  expect(result.exitCode).toBe(0);
}

it('AC1: restores a soft-deleted item — tombstone cleared, live status, stage kept', async () => {
  const created = await createItem('Restorable', '--stage plan_complete --priority high');
  const id = created.workItem.id;
  await deleteItems([id]);

  const deletedState = await getItem(id);
  expect(deletedState.status).toBe('deleted');
  expect(deletedState.deletedBy).toBe('deleter@example.com');

  const result = await run(` --json undelete ${id} --no-sync`);
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.restored).toBe(1);
  expect(parsed.failed).toBe(0);

  const restored = await getItem(id);
  expect(restored.status).toBe('open');
  expect(restored.deletedBy ?? '').toBe('');
  expect(restored.deleteReason ?? '').toBe('');
  expect(restored.assignee ?? '').toBe('');
  // Stage is preserved: the delete kept it, and the restore must not lose it.
  expect(restored.stage).toBe('plan_complete');
  // Unrelated fields survive untouched.
  expect(restored.priority).toBe('high');

  // Visible to list again (soft-deleted items are filtered out of listings).
  const listed = await run(' --json list', 15000);
  const listedIds = JSON.parse(listed.stdout).workItems.map((w: any) => w.id);
  expect(listedIds).toContain(id);
});

it('AC1: restoring an item whose stage only fits a terminal status picks that status', async () => {
  // Model "deleted while in review": reach completed/in_review through the
  // status+stage pair, which is the only compatible route.
  const created = await createItem('Terminal stage', '--stage plan_complete');
  const id = created.workItem.id;
  const updated = await run(` --json update ${id} --status completed --stage in_review`, 15000);
  expect(updated.exitCode).toBe(0);
  await deleteItems([id]);

  const result = await run(` --json undelete ${id} --no-sync`);
  expect(result.exitCode).toBe(0);

  const restored = await getItem(id);
  // `open` and `in-progress` cannot carry `in_review`; `completed` can, so the
  // default status must be the one that keeps the stage (never a stage wipe).
  expect(restored.stage).toBe('in_review');
  expect(restored.status).toBe('completed');
});

it('AC1: explicit --status and --assignee override the defaults', async () => {
  const created = await createItem('Overridden', '--stage idea');
  const id = created.workItem.id;
  await deleteItems([id]);

  const result = await run(` --json undelete ${id} --status blocked --assignee agent-x --no-sync`);
  expect(result.exitCode).toBe(0);

  const restored = await getItem(id);
  expect(restored.status).toBe('blocked');
  expect(restored.assignee).toBe('agent-x');
});

it('AC2: records an audit comment with the previous tombstone and restoring identity', async () => {
  const created = await createItem('Audited');
  const id = created.workItem.id;
  await run(` --json delete ${id} --reason "accidental sweep" --deleted-by deleter@example.com --no-sync`, 15000);

  const before = await getItem(id);
  const previousDeletedBy = before.deletedBy;

  const result = await run(` --json undelete ${id} --restored-by producer@example.com --no-sync`);
  expect(result.exitCode).toBe(0);

  const comments = await getComments(id);
  const audit = comments.find((c) => String(c.comment).includes('Restored from soft-delete'));
  expect(audit).toBeTruthy();
  expect(audit.author).toBe('producer@example.com');
  expect(String(audit.comment)).toContain(previousDeletedBy);
  expect(String(audit.comment)).toContain('accidental sweep');
  expect(String(audit.comment)).toContain('deleted');
});

it('AC3: restores cascade-deleted descendants recursively by default', async () => {
  const parent = await createItem('Cascade parent');
  const parentId = parent.workItem.id;
  const child = await createItem('Cascade child', `--parent ${parentId}`);
  const childId = child.workItem.id;
  const grandchild = await createItem('Cascade grandchild', `--parent ${childId}`);
  const grandchildId = grandchild.workItem.id;

  await deleteItems([parentId]);
  expect((await getItem(childId)).status).toBe('deleted');
  expect((await getItem(grandchildId)).status).toBe('deleted');

  const result = await run(` --json undelete ${parentId} --no-sync`);
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.restored).toBe(1);
  expect(parsed.restoredDescendantsCount).toBe(2);

  expect((await getItem(parentId)).status).toBe('open');
  expect((await getItem(childId)).status).toBe('open');
  expect((await getItem(grandchildId)).status).toBe('open');
});

it('AC3: --no-recursive restores only the named item', async () => {
  const parent = await createItem('Non-recursive parent');
  const parentId = parent.workItem.id;
  const child = await createItem('Non-recursive child', `--parent ${parentId}`);
  const childId = child.workItem.id;

  await deleteItems([parentId]);
  const result = await run(` --json undelete ${parentId} --no-recursive --no-sync`);
  expect(result.exitCode).toBe(0);

  expect((await getItem(parentId)).status).toBe('open');
  expect((await getItem(childId)).status).toBe('deleted');
});

it('AC3: a descendant deleted in its own right is not resurrected', async () => {
  const parent = await createItem('Own-reason parent');
  const parentId = parent.workItem.id;
  const child = await createItem('Own-reason child', `--parent ${parentId}`);
  const childId = child.workItem.id;

  // The child is retired deliberately *before* the parent is swept: its
  // deleteReason is its own, not `cascade from <parent>`.
  await run(` --json delete ${childId} --reason "retired, not swept" --deleted-by deleter@example.com --no-sync`, 15000);
  await deleteItems([parentId]);

  const result = await run(` --json undelete ${parentId} --no-sync`);
  expect(result.exitCode).toBe(0);

  expect((await getItem(parentId)).status).toBe('open');
  const stillDeleted = await getItem(childId);
  expect(stillDeleted.status).toBe('deleted');
  expect(stillDeleted.deleteReason).toContain('retired, not swept');
});

it('AC4: restoring a live item is an idempotent skip, not an error', async () => {
  const created = await createItem('Already live');
  const id = created.workItem.id;

  const result = await run(` --json undelete ${id} --no-sync`);
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.restored).toBe(0);
  expect(parsed.failed).toBe(0);
  expect(parsed.results[0].skipped).toBe(true);
  expect(parsed.results[0].skippedReason).toBe('already live');

  const item = await getItem(id);
  expect(item.status).toBe('open');
});

it('AC4: a batch restores the deleted id, skips the live one and fails the unknown', async () => {
  const live = await createItem('Batch live');
  const gone = await createItem('Batch deleted');
  await deleteItems([gone.workItem.id]);

  const result = await run(
    ` --json undelete ${live.workItem.id} ${gone.workItem.id} UND-NONEXISTENT-999 --no-sync`
  );
  expect(result.exitCode).toBe(1);

  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(false);
  expect(parsed.restored).toBe(1);
  expect(parsed.failed).toBe(1);
  expect(parsed.results).toHaveLength(3);
  expect(parsed.results[0].skipped).toBe(true);
  expect(parsed.results[1].success).toBe(true);
  expect(parsed.results[2].success).toBe(false);
  expect(parsed.results[2].error).toContain('Work item not found');

  expect((await getItem(gone.workItem.id)).status).toBe('open');
});

it('AC4: refuses --status deleted', async () => {
  const created = await createItem('Bad status');
  const id = created.workItem.id;
  await deleteItems([id]);

  const result = await run(` --json undelete ${id} --status deleted --no-sync`);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain('deleted');

  expect((await getItem(id)).status).toBe('deleted');
});

it('AC5: --dry-run reports the plan and mutates nothing', async () => {
  const parent = await createItem('Dry parent');
  const parentId = parent.workItem.id;
  const child = await createItem('Dry child', `--parent ${parentId}`);
  const childId = child.workItem.id;
  await deleteItems([parentId]);

  const result = await run(` --json undelete ${parentId} --dry-run --no-sync`);
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.dryRun).toBe(true);
  expect(parsed.restored).toBe(0);
  expect(parsed.results[0].wouldRestore).toBe(true);
  expect(parsed.results[0].restoredDescendants).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: childId })])
  );

  // Nothing changed, and no audit comment was written.
  expect((await getItem(parentId)).status).toBe('deleted');
  expect((await getItem(parentId)).deletedBy).toBe('deleter@example.com');
  const audit = (await getComments(parentId)).find((c) =>
    String(c.comment).includes('Restored from soft-delete')
  );
  expect(audit).toBeUndefined();
});

it('AC6: syncs once for the whole batch; --no-sync suppresses it', async () => {
  const a = await createItem('Sync A');
  const b = await createItem('Sync B');
  await deleteItems([a.workItem.id, b.workItem.id]);
  performSyncMock.mockClear();

  const synced = await run(
    ` --json undelete ${a.workItem.id} ${b.workItem.id} --no-recursive`,
    20000
  );
  expect(synced.exitCode).toBe(0);
  expect(performSyncMock).toHaveBeenCalledTimes(1);

  performSyncMock.mockClear();
  const a2 = await createItem('Sync C');
  await deleteItems([a2.workItem.id]);
  performSyncMock.mockClear();

  const silent = await run(` --json undelete ${a2.workItem.id} --no-sync`, 20000);
  expect(silent.exitCode).toBe(0);
  expect(performSyncMock).not.toHaveBeenCalled();
});

it('Constraint: `wl update` keeps refusing field mutations until the item is restored', async () => {
  const created = await createItem('Guard check');
  const id = created.workItem.id;
  await deleteItems([id]);

  const refused = await run(` --json update ${id} --status open`, 15000);
  expect(refused.exitCode).toBe(1);
  expect(refused.stdout + refused.stderr).toContain('soft-deleted');

  await run(` --json undelete ${id} --no-sync`);
  const allowed = await run(` --json update ${id} --priority low`, 15000);
  expect(allowed.exitCode).toBe(0);
  expect((await getItem(id)).priority).toBe('low');
});
