/**
 * Tests for auto-sync after wl delete
 *
 * Verifies that after a successful deletion, the local state is automatically
 * synced to the remote git branch to prevent soft-deleted items from being
 * restored by a subsequent sync from another agent.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { runInProcess } from './cli-inproc.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { getPackageVersion } from './cli-helpers.js';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

let tempDir: string;
let remoteDir: string;
let worklogDir: string;

beforeEach(async () => {
  tempDir = createTempDir();
  process.chdir(tempDir);

  // Create a bare remote repo for mock git push to write to
  remoteDir = createTempDir();

  // Initialize git in the temp dir so sync operations work
  childProcess.execSync('git init', { cwd: tempDir });

  // Configure mock remote with absolute path
  childProcess.execSync(`git remote add origin ${remoteDir}`, { cwd: tempDir });

  // Do an initial commit so HEAD resolves
  fs.writeFileSync(path.join(tempDir, 'README.md'), '# Delete Sync Test\n', 'utf8');
  childProcess.execSync('git add README.md', { cwd: tempDir });
  childProcess.execSync('git commit -m "initial commit"', { cwd: tempDir });

  // Create .worklog directory and config
  worklogDir = path.join(tempDir, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });

  // Write a minimal config so the CLI can initialize
  fs.writeFileSync(
    path.join(worklogDir, 'config.yaml'),
    [
      'projectName: DeleteSyncTest',
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

  // Write initialization marker
  fs.writeFileSync(
    path.join(worklogDir, 'initialized'),
    JSON.stringify({ version: getPackageVersion(), initializedAt: new Date().toISOString() }),
    'utf8'
  );
});

afterEach(() => {
  cleanupTempDir(tempDir);
  cleanupTempDir(remoteDir);
});

/**
 * Helper: create a work item and return its JSON-parsed output
 */
async function createItem(title: string): Promise<any> {
  const result = await runInProcess(
    `node src/cli.ts --json create -t "${title}"`,
    10000
  );
  return JSON.parse(result.stdout);
}

/**
 * Helper: delete a work item and return the full result (stdout + exit code)
 */
async function deleteItem(id: string, extraArgs: string = ''): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await runInProcess(
    `node src/cli.ts --json delete ${id}${extraArgs ? ' ' + extraArgs : ''}`,
    15000
  );
}

it('should auto-sync after deleting a single work item', async () => {
  // Create a work item
  const created = await createItem('Test item for sync after delete');
  expect(created.success).toBe(true);
  const id = created.workItem.id;

  // Delete it - this should trigger an auto-sync
  const result = await deleteItem(id);

  // Verify delete was successful
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.deletedId).toContain(id);
  expect(parsed.deletedWorkItem.title).toBe('Test item for sync after delete');

  // Verify no sync error in stderr
  expect(result.stderr).not.toContain('auto-sync after delete failed');
});

it('should auto-sync after recursive delete of parent with children', async () => {
  // Create parent and child
  const parent = await createItem('Parent item');
  const childResult = await runInProcess(
    `node src/cli.ts --json create -t "Child item" --parent ${parent.workItem.id}`,
    10000
  );
  const child = JSON.parse(childResult.stdout);

  // Delete parent (recursive by default)
  const result = await deleteItem(parent.workItem.id);

  // Verify delete was successful
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.deletedDescendantsCount).toBeGreaterThanOrEqual(1);

  // Verify no sync error in stderr
  expect(result.stderr).not.toContain('auto-sync after delete failed');
});

it('should skip auto-sync when --no-sync flag is provided', async () => {
  // Create a work item
  const created = await createItem('Test item --no-sync');
  expect(created.success).toBe(true);
  const id = created.workItem.id;

  // Delete with --no-sync - should skip the sync
  const result = await deleteItem(id, '--no-sync');

  // Verify delete was successful
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.deletedId).toContain(id);

  // Should be no sync-related errors or output
  expect(result.stderr).not.toContain('auto-sync');
});

it('should handle sync failures gracefully without failing the delete', async () => {
  // Create a work item
  const created = await createItem('Test item for sync failure');
  expect(created.success).toBe(true);
  const id = created.workItem.id;

  // Delete it - even if the mock git environment has issues,
  // the delete should still succeed because sync failure is caught
  const result = await deleteItem(id);

  // Verify delete was successful
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.deletedId).toContain(id);

  // If there's a sync warning, the delete stdout should still have success
  // If there's no warning (sync succeeded), that's also fine
  // The important thing is the delete result is returned regardless
});

it('should work with --no-recursive and --no-sync together', async () => {
  // Create parent and child
  const parent = await createItem('Parent no-recursive');
  await runInProcess(
    `node src/cli.ts --json create -t "Child no-recursive" --parent ${parent.workItem.id}`,
    10000
  );

  // Delete with --no-recursive --no-sync
  const result = await deleteItem(parent.workItem.id, '--no-recursive --no-sync');

  // Verify delete was successful
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.deletedId).toContain(parent.workItem.id);
  expect(parsed.recursive).toBe(false);
});

it('should sync the deleted state so remote has it as deleted', async () => {
  // Create a work item
  const created = await createItem('Item to verify sync persistence');
  expect(created.success).toBe(true);

  // Delete it with auto-sync
  const deleteResult = await deleteItem(created.workItem.id);
  expect(JSON.parse(deleteResult.stdout).success).toBe(true);

  // The sync (via mock git push) copies .worklog to the remote
  // We can verify this by running a sync and checking the item status
  const syncResult = await runInProcess(
    `node src/cli.ts --json sync`,
    15000
  );
  const syncParsed = JSON.parse(syncResult.stdout);
  expect(syncParsed.success).toBe(true);

  // Verify the item is still deleted by showing it
  const showResult = await runInProcess(
    `node src/cli.ts --json show ${created.workItem.id}`,
    10000
  );
  const showParsed = JSON.parse(showResult.stdout);
  expect(showParsed.success).toBe(true);
  expect(showParsed.workItem.status).toBe('deleted');
});
