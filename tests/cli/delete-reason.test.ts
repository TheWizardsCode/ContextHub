/**
 * Tests for delete-reason attribution on `wl delete` (WL-0MW8078CA006Q2P7).
 *
 * The defect: `wl delete` unconditionally overwrote `deleteReason` with the
 * hardcoded string `"deleted via wl delete"` and offered no `--reason` flag,
 * destroying pre-set reasons and making every CLI delete look deliberate to
 * the merge gate (`isAttributedDelete()`).
 *
 * Covers the acceptance criteria:
 *   AC1  — `--reason <text>` is stored verbatim and echoed per id in JSON
 *   AC2  — a pre-set reason survives a delete without `--reason`
 *   AC3  — no fabricated default: an unreasoned delete stores an empty reason
 *          and, on its own, does not satisfy `isAttributedDelete()`
 *   AC4  — recursive deletes attribute each descendant with the cascade source
 *   AC5a-e — the five regression scenarios named in the intake brief
 *   AC6  — `wl update --delete-reason` remains the repair path
 *
 * `performSync` is mocked so sync invocation counts never require a real git
 * remote round-trip; the database mutations are exercised for real.
 */

import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runInProcess } from './cli-inproc.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { getPackageVersion } from './cli-helpers.js';
import { isAttributedDelete } from '../../src/sync/merge-predicates.js';
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
  fs.writeFileSync(path.join(tempDir, 'README.md'), '# Delete Reason Test\n', 'utf8');
  childProcess.execSync('git add README.md', { cwd: tempDir });
  childProcess.execSync('git commit -m "initial commit"', { cwd: tempDir });

  worklogDir = path.join(tempDir, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });

  fs.writeFileSync(
    path.join(worklogDir, 'config.yaml'),
    [
      'projectName: DeleteReasonTest',
      'prefix: DEL',
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
      '  - value: prd_complete',
      '    label: PRD Complete',
      '  - value: plan_complete',
      '    label: Plan Complete',
      '  - value: in_progress',
      '    label: In Progress',
      '  - value: in_review',
      '    label: In Review',
      '  - value: done',
      '    label: Done',
      'statusStageCompatibility:',
      '  open: ["", idea, prd_complete, plan_complete, in_progress]',
      '  in-progress: [in_progress]',
      '  blocked: ["", idea, prd_complete, plan_complete]',
      '  completed: [in_review, done]',
      '  deleted: ["", idea, prd_complete, plan_complete, done]',
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

/** Create a work item and return its JSON-parsed output. */
async function createItem(title?: string, extraArgs: string = ''): Promise<any> {
  const uniqueTitle = title ?? `item-${++titleCounter}-${Date.now()}`;
  const result = await runInProcess(
    `node src/cli.ts --json create -t "${uniqueTitle}"${extraArgs ? ' ' + extraArgs : ''}`,
    10000
  );
  return JSON.parse(result.stdout);
}

/** Run `wl delete <ids...>` in-process and return the raw result. */
async function deleteItems(
  ids: string[],
  extraArgs: string = ''
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const idArgs = ids.join(' ');
  return await runInProcess(
    `node src/cli.ts --json delete ${idArgs}${extraArgs ? ' ' + extraArgs : ''}`,
    15000
  );
}

/** Run `wl update <id>` in-process and return the raw result. */
async function updateItem(
  id: string,
  extraArgs: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await runInProcess(
    `node src/cli.ts --json update ${id} ${extraArgs}`,
    10000
  );
}

/** Fetch a work item via `wl show`. */
async function showItem(id: string): Promise<any> {
  const result = await runInProcess(`node src/cli.ts --json show ${id}`, 10000);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout).workItem;
}

it('AC5a: --reason is stored verbatim as deleteReason', async () => {
  const item = await createItem('Reason verbatim');

  const result = await deleteItems([item.workItem.id], '--reason "cleaning up stale backlog" --no-sync');
  expect(result.exitCode).toBe(0);

  const shown = await showItem(item.workItem.id);
  expect(shown.status).toBe('deleted');
  expect(shown.deleteReason).toBe('cleaning up stale backlog');
});

it('AC1: the applied reason is echoed per id in --json output', async () => {
  const item = await createItem('Reason echoed');

  const result = await deleteItems([item.workItem.id], '--reason "duplicate of DEL-1" --no-sync');
  const parsed = JSON.parse(result.stdout);

  expect(parsed.results).toHaveLength(1);
  expect(parsed.results[0].deleteReason).toBe('duplicate of DEL-1');
  expect(parsed.deleteReason).toBe('duplicate of DEL-1');
});

it('AC5b/AC2: a pre-set reason survives a delete with no --reason', async () => {
  const item = await createItem('Pre-set reason');

  const preset = await updateItem(item.workItem.id, '--delete-reason "retired: no longer needed"');
  expect(preset.exitCode).toBe(0);
  expect((await showItem(item.workItem.id)).deleteReason).toBe('retired: no longer needed');

  const result = await deleteItems([item.workItem.id], '--no-sync');
  expect(result.exitCode).toBe(0);

  const shown = await showItem(item.workItem.id);
  expect(shown.status).toBe('deleted');
  expect(shown.deleteReason).toBe('retired: no longer needed');
  expect(shown.deleteReason).not.toBe('deleted via wl delete');
});

it('AC1/AC5a: an explicit --reason overrides a pre-set reason', async () => {
  const item = await createItem('Override pre-set reason');
  await updateItem(item.workItem.id, '--delete-reason "old placeholder"');

  const result = await deleteItems([item.workItem.id], '--reason "superseded by explicit reason" --no-sync');
  expect(result.exitCode).toBe(0);

  expect((await showItem(item.workItem.id)).deleteReason).toBe('superseded by explicit reason');
});

it('AC5c/AC3: no fabricated default — an unreasoned delete stores an empty reason', async () => {
  const item = await createItem('No reason supplied');

  const result = await deleteItems([item.workItem.id], '--no-sync');
  expect(result.exitCode).toBe(0);

  const shown = await showItem(item.workItem.id);
  expect(shown.status).toBe('deleted');
  expect(shown.deleteReason).toBe('');
  expect(shown.deleteReason).not.toBe('deleted via wl delete');
});

it('AC5d/AC4: recursive deletes attribute each descendant with the cascade source', async () => {
  const parent = await createItem('Cascade parent');
  const child = await createItem('Cascade child', `--parent ${parent.workItem.id}`);
  const grandchild = await createItem('Cascade grandchild', `--parent ${child.workItem.id}`);

  const result = await deleteItems([parent.workItem.id], '--reason "sweeping subtree" --no-sync');
  expect(result.exitCode).toBe(0);

  const parentShown = await showItem(parent.workItem.id);
  expect(parentShown.deleteReason).toBe('sweeping subtree');

  const childShown = await showItem(child.workItem.id);
  expect(childShown.status).toBe('deleted');
  expect(childShown.deleteReason).toBe(`cascade from ${parent.workItem.id}: sweeping subtree`);

  const grandchildShown = await showItem(grandchild.workItem.id);
  expect(grandchildShown.status).toBe('deleted');
  expect(grandchildShown.deleteReason).toBe(`cascade from ${parent.workItem.id}: sweeping subtree`);

  // Each cascaded descendant is distinguishable from a deliberate retire.
  expect(childShown.deleteReason).toContain('cascade from');
  expect(childShown.deleteReason).not.toBe(parentShown.deleteReason);
});

it('AC5d/AC4: a cascade without an explicit reason still records the source', async () => {
  const parent = await createItem('Cascade no reason parent');
  const child = await createItem('Cascade no reason child', `--parent ${parent.workItem.id}`);

  await deleteItems([parent.workItem.id], '--no-sync');

  expect((await showItem(parent.workItem.id)).deleteReason).toBe('');
  expect((await showItem(child.workItem.id)).deleteReason).toBe(`cascade from ${parent.workItem.id}`);
});

it('AC4: descendants are reported separately with their cascade attribution in --json', async () => {
  const parent = await createItem('JSON cascade parent');
  const child = await createItem('JSON cascade child', `--parent ${parent.workItem.id}`);

  const result = await deleteItems([parent.workItem.id], '--reason "json cascade" --no-sync');
  const parsed = JSON.parse(result.stdout);

  expect(parsed.deletedDescendantsCount).toBe(1);
  expect(parsed.results[0].deletedDescendants).toHaveLength(1);
  expect(parsed.results[0].deletedDescendants[0].id).toBe(child.workItem.id);
  expect(parsed.results[0].deletedDescendants[0].deleteReason).toBe(
    `cascade from ${parent.workItem.id}: json cascade`
  );
});

it('AC5e/AC3: an unattributed CLI delete does not satisfy isAttributedDelete()', async () => {
  const item = await createItem('Unattributed delete');

  // No `.git/user-email` seed and no --reason: `deletedBy` and `deleteReason`
  // are both empty, which is exactly the "intent-less delete" the merge gate
  // must refuse to treat as deliberate.
  const result = await deleteItems([item.workItem.id], '--no-sync');
  expect(result.exitCode).toBe(0);

  const shown = await showItem(item.workItem.id);
  expect(shown.deletedBy).toBe('');
  expect(shown.deleteReason).toBe('');
  expect(isAttributedDelete(shown)).toBe(false);
});

it('AC5e: an explicitly reasoned delete does satisfy isAttributedDelete()', async () => {
  const item = await createItem('Attributed by reason');

  await deleteItems([item.workItem.id], '--reason "deliberate retirement" --no-sync');

  const shown = await showItem(item.workItem.id);
  expect(isAttributedDelete(shown)).toBe(true);
});

it('AC5e: a delete attributed by who (deletedBy) still satisfies isAttributedDelete()', async () => {
  // Seed the configured identity so `wl delete` records `deletedBy`.
  fs.writeFileSync(path.join(tempDir, '.git', 'user-email'), 'deleter@example.com\n', 'utf8');

  const item = await createItem('Attributed by who');
  await deleteItems([item.workItem.id], '--no-sync');

  const shown = await showItem(item.workItem.id);
  expect(shown.deletedBy).toBe('deleter@example.com');
  expect(shown.deleteReason).toBe('');
  // "Who" attribution alone is a real delete — the merge gate must still see it.
  expect(isAttributedDelete(shown)).toBe(true);
});

it('AC6: wl update --delete-reason repairs the reason on an already-deleted item', async () => {
  const item = await createItem('Repair path');

  await deleteItems([item.workItem.id], '--no-sync');
  expect((await showItem(item.workItem.id)).deleteReason).toBe('');

  const repair = await updateItem(item.workItem.id, '--delete-reason "reason added after delete"');
  expect(repair.exitCode).toBe(0);
  expect(JSON.parse(repair.stdout).success).toBe(true);

  const shown = await showItem(item.workItem.id);
  expect(shown.status).toBe('deleted');
  expect(shown.deleteReason).toBe('reason added after delete');
  expect(isAttributedDelete(shown)).toBe(true);
});

it('rejects an empty --reason value', async () => {
  const item = await createItem('Empty reason');

  const result = await deleteItems([item.workItem.id], '--reason "" --no-sync');
  expect(result.exitCode).not.toBe(0);

  // The item must not have been deleted by an invalid invocation.
  expect((await showItem(item.workItem.id)).status).not.toBe('deleted');
});

it('AC4: --no-recursive leaves descendants untouched and unattributed', async () => {
  const parent = await createItem('No-recursive parent');
  const child = await createItem('No-recursive child', `--parent ${parent.workItem.id}`);

  const result = await deleteItems(
    [parent.workItem.id],
    '--no-recursive --reason "parent only" --no-sync'
  );
  expect(result.exitCode).toBe(0);

  expect((await showItem(parent.workItem.id)).deleteReason).toBe('parent only');

  const childShown = await showItem(child.workItem.id);
  expect(childShown.status).not.toBe('deleted');
  expect(childShown.deleteReason).toBe('');
});
