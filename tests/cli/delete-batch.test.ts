/**
 * Integration tests for batch `wl delete <ids...>` (WL-0MUI83ZTX005RN93).
 *
 * Covers the acceptance criteria:
 *   AC1 — multi-id delete with single-id backward compatibility
 *   AC2 — per-id processing with partial failure (non-zero exit)
 *   AC3 — exit code zero when all ids succeed
 *   AC4 — auto-sync runs exactly once for the whole batch; --no-sync suppresses
 *   AC5 — --no-recursive and --prefix apply uniformly; descendants reported
 *   AC6 — JSON per-id `results` array plus deleted/failed summary
 *   Constraint — duplicate/descendant ids are skipped, not hard errors
 *
 * `performSync` is mocked so sync invocation counts can be asserted without a
 * real git remote round-trip. The database mutations are exercised for real.
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
  fs.writeFileSync(path.join(tempDir, 'README.md'), '# Delete Batch Test\n', 'utf8');
  childProcess.execSync('git add README.md', { cwd: tempDir });
  childProcess.execSync('git commit -m "initial commit"', { cwd: tempDir });

  worklogDir = path.join(tempDir, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });

  fs.writeFileSync(
    path.join(worklogDir, 'config.yaml'),
    [
      'projectName: DeleteBatchTest',
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

/** Fetch a work item's status via `wl show`. Returns null when not found. */
async function getStatus(id: string): Promise<string | null> {
  const result = await runInProcess(`node src/cli.ts --json show ${id}`, 10000);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed?.workItem?.status ?? null;
  } catch {
    return null;
  }
}

it('AC1/AC6: deletes multiple ids and returns a per-id results array', async () => {
  const a = await createItem('Batch A');
  const b = await createItem('Batch B');
  const c = await createItem('Batch C');

  const result = await deleteItems([a.workItem.id, b.workItem.id, c.workItem.id], '--no-sync');
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.deleted).toBe(3);
  expect(parsed.failed).toBe(0);
  expect(Array.isArray(parsed.results)).toBe(true);
  expect(parsed.results).toHaveLength(3);
  for (const r of parsed.results) {
    expect(r.success).toBe(true);
    expect(r.deletedId).toBe(r.id);
  }

  expect(await getStatus(a.workItem.id)).toBe('deleted');
  expect(await getStatus(b.workItem.id)).toBe('deleted');
  expect(await getStatus(c.workItem.id)).toBe('deleted');
});

it('AC2/AC3: continues past a missing id and exits non-zero on partial failure', async () => {
  const real = await createItem('Partial real item');
  const missingId = 'DEL-NONEXISTENT-999';

  const result = await deleteItems([real.workItem.id, missingId], '--no-sync');
  expect(result.exitCode).toBe(1);

  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(false);
  expect(parsed.deleted).toBe(1);
  expect(parsed.failed).toBe(1);
  expect(parsed.results).toHaveLength(2);
  expect(parsed.results[0].success).toBe(true);
  expect(parsed.results[1].success).toBe(false);
  expect(parsed.results[1].error).toContain('Work item not found');

  // The valid id must still have been deleted despite the later failure.
  expect(await getStatus(real.workItem.id)).toBe('deleted');
});

it('AC3: exits zero when all ids in the batch succeed', async () => {
  const a = await createItem('All ok A');
  const b = await createItem('All ok B');

  const result = await deleteItems([a.workItem.id, b.workItem.id], '--no-sync');
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.deleted).toBe(2);
  expect(parsed.failed).toBe(0);
});

it('AC4: auto-sync runs exactly once for the whole batch', async () => {
  const a = await createItem('Sync once A');
  const b = await createItem('Sync once B');
  const c = await createItem('Sync once C');

  const result = await deleteItems([a.workItem.id, b.workItem.id, c.workItem.id]);
  expect(result.exitCode).toBe(0);
  expect(performSyncMock).toHaveBeenCalledTimes(1);
});

it('AC4: --no-sync suppresses auto-sync for the whole batch', async () => {
  const a = await createItem('No sync A');
  const b = await createItem('No sync B');

  const result = await deleteItems([a.workItem.id, b.workItem.id], '--no-sync');
  expect(result.exitCode).toBe(0);
  expect(performSyncMock).not.toHaveBeenCalled();
});

it('AC4: auto-sync does not run when nothing was deleted', async () => {
  const result = await deleteItems(['DEL-NONEXISTENT-1', 'DEL-NONEXISTENT-2']);
  expect(result.exitCode).toBe(1);
  expect(performSyncMock).not.toHaveBeenCalled();
});

it('AC5: --no-recursive applies to every id and leaves children orphaned', async () => {
  const parent = await createItem('Non-recursive parent');
  const child = await createItem('Non-recursive child', `--parent ${parent.workItem.id}`);

  const result = await deleteItems([parent.workItem.id, child.workItem.id], '--no-recursive --no-sync');
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout);
  expect(parsed.deleted).toBe(2);
  for (const r of parsed.results) {
    expect(r.recursive).toBe(false);
    expect(r.deletedDescendantsCount).toBeUndefined();
  }

  expect(await getStatus(parent.workItem.id)).toBe('deleted');
  expect(await getStatus(child.workItem.id)).toBe('deleted');
});

it('AC5: recursive delete reports descendants for the parent id', async () => {
  const parent = await createItem('Recursive parent with child');
  await createItem('Recursive child one', `--parent ${parent.workItem.id}`);
  await createItem('Recursive child two', `--parent ${parent.workItem.id}`);

  const result = await deleteItems([parent.workItem.id], '--no-sync');
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout);
  expect(parsed.recursive).toBe(true);
  expect(parsed.deletedDescendantsCount).toBe(2);
  expect(parsed.results[0].deletedDescendants).toHaveLength(2);
});

it('AC5: --prefix applies uniformly to bare ids in the batch', async () => {
  const a = await createItem('Prefix A');
  const b = await createItem('Prefix B');
  const bareA = a.workItem.id.replace(/^DEL-/, '');
  const bareB = b.workItem.id.replace(/^DEL-/, '');

  const result = await deleteItems([bareA, bareB], '--prefix DEL --no-sync');
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.deleted).toBe(2);
  expect(await getStatus(a.workItem.id)).toBe('deleted');
  expect(await getStatus(b.workItem.id)).toBe('deleted');
});

it('Constraint: a descendant listed alongside its parent is skipped, not an error', async () => {
  const parent = await createItem('Parent and child batch');
  const child = await createItem('Child in same batch', `--parent ${parent.workItem.id}`);

  const result = await deleteItems([parent.workItem.id, child.workItem.id], '--no-sync');
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.deleted).toBe(1);
  expect(parsed.failed).toBe(0);
  expect(parsed.results).toHaveLength(2);

  const childResult = parsed.results.find((r: any) => r.id === child.workItem.id);
  expect(childResult.success).toBe(true);
  expect(childResult.skipped).toBe(true);
  expect(childResult.skippedReason).toBe('already deleted');

  expect(await getStatus(parent.workItem.id)).toBe('deleted');
  expect(await getStatus(child.workItem.id)).toBe('deleted');
});

it('Constraint: a repeated id is deduplicated and skipped', async () => {
  const item = await createItem('Duplicate id in batch');

  const result = await deleteItems([item.workItem.id, item.workItem.id], '--no-sync');
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout);
  expect(parsed.deleted).toBe(1);
  expect(parsed.results).toHaveLength(2);
  expect(parsed.results[1].skipped).toBe(true);
  expect(parsed.results[1].skippedReason).toBe('duplicate id in this invocation');
});

it('AC1/AC6: single-id JSON output preserves legacy fields', async () => {
  const item = await createItem('Single id legacy shape');

  const result = await deleteItems([item.workItem.id], '--no-sync');
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.deletedId).toBe(item.workItem.id);
  expect(parsed.deletedWorkItem.title).toBe('Single id legacy shape');
  expect(parsed.recursive).toBe(true);
  expect(parsed.message).toContain(item.workItem.id);
  // Batch fields are additive, not a replacement.
  expect(parsed.results).toHaveLength(1);
  expect(parsed.deleted).toBe(1);
  expect(parsed.failed).toBe(0);
});
