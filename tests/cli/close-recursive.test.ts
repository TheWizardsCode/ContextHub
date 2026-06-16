/**
 * Integration tests: close command recursively closes descendants when
 * the parent is in `in_review` stage AND its `AuditResult.readyToClose`
 * is `true`.
 *
 * Tests run through the CLI via tsx, using a temp directory with a minimal
 * .worklog config.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';

/**
 * Run a CLI command via tsx and return parsed JSON output.
 * Ensures the command is run with --json flag.
 */
async function runJson(args: string): Promise<any> {
  const { stdout } = await execAsync(`tsx ${cliPath} --json ${args}`);
  return JSON.parse(stdout);
}

/**
 * Run a CLI command and return raw stdout/stderr.
 */
async function runRaw(args: string): Promise<{ stdout: string; stderr: string }> {
  return await execAsync(`tsx ${cliPath} ${args}`);
}

describe('close command recursive close', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeInitSemaphore(tempState.tempDir);
    writeConfig(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  /**
   * Create a parent and N children via the CLI.
   * Returns { parentId, childIds }
   */
  async function createParentWithChildren(
    numChildren: number = 2,
    setInReview: boolean = false
  ): Promise<{ parentId: string; childIds: string[] }> {
    const created = await runJson(`create -t "Parent item"`);
    const parentId = created.workItem.id;

    const childIds: string[] = [];
    for (let i = 0; i < numChildren; i++) {
      const child = await runJson(
        `create -t "Child ${i + 1}" --parent ${parentId}`
      );
      childIds.push(child.workItem.id);
    }

    // If needed, set parent to in_review stage (requires completed status)
    if (setInReview) {
      await runJson(`update ${parentId} --status completed --stage in_review`);
    }

    return { parentId, childIds };
  }

  it('closes a single work item (no children) - baseline', async () => {
    const created = await runJson(`create -t "Single item"`);
    const id = created.workItem.id;

    const result = await runJson(`close ${id} -r "done"`);
    expect(result.success).toBe(true);

    // Verify it's closed
    const shown = await runJson(`show ${id}`);
    expect(shown.workItem.status).toBe('completed');
    expect(shown.workItem.stage).toBe('done');
  });

  it('closes only the parent when parent has children but is NOT in_review', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, false);

    // Close parent (not in_review stage)
    const result = await runJson(`close ${parentId} -r "done"`);
    expect(result.success).toBe(true);

    // Parent should be closed
    const parentShown = await runJson(`show ${parentId}`);
    expect(parentShown.workItem.status).toBe('completed');

    // Children should NOT be closed
    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).not.toBe('completed');
    }
  });

  it('closes only the parent when parent is in_review but has no audit result', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, true);

    // Close parent (in_review but no audit)
    const result = await runJson(`close ${parentId} -r "done"`);
    expect(result.success).toBe(true);

    // Parent should be closed
    const parentShown = await runJson(`show ${parentId}`);
    expect(parentShown.workItem.status).toBe('completed');

    // Children should NOT be closed
    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).not.toBe('completed');
    }
  });

  it('closes only the parent when readyToClose is false', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, true);

    // Set audit result with readyToClose=false
    await runJson(`update ${parentId} --audit-text "Ready to close: No\nNot ready yet"`);

    // Close parent
    const result = await runJson(`close ${parentId} -r "done"`);
    expect(result.success).toBe(true);

    // Parent should be closed
    const parentShown = await runJson(`show ${parentId}`);
    expect(parentShown.workItem.status).toBe('completed');

    // Children should NOT be closed
    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).not.toBe('completed');
    }
  });

  it('recursively closes all descendants when parent is in_review and readyToClose is true', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, true);

    // Set audit result with readyToClose=true
    await runJson(`update ${parentId} --audit-text "Ready to close: Yes\nAll criteria met"`);

    // Close parent - should recursively close children
    const result = await runJson(`close ${parentId} -r "done"`);
    expect(result.success).toBe(true);

    // Parent should be closed
    const parentShown = await runJson(`show ${parentId}`);
    expect(parentShown.workItem.status).toBe('completed');
    expect(parentShown.workItem.stage).toBe('done');

    // Children should also be closed
    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).toBe('completed');
      expect(childShown.workItem.stage).toBe('done');
    }
  });

  it('recursively closes nested descendants (grandchildren)', async () => {
    // Create grandparent -> parent -> child chain
    const grandparent = await runJson(`create -t "Grandparent"`);
    const gpId = grandparent.workItem.id;

    const parent = await runJson(`create -t "Parent" --parent ${gpId}`);
    const parentId = parent.workItem.id;

    const child = await runJson(`create -t "Child" --parent ${parentId}`);
    const childId = child.workItem.id;

    // Set grandparent to in_review stage (requires completed status)
    await runJson(`update ${gpId} --status completed --stage in_review`);

    // Set audit result on grandparent
    await runJson(`update ${gpId} --audit-text "Ready to close: Yes\nAll criteria met"`);

    // Close grandparent
    const result = await runJson(`close ${gpId} -r "done"`);
    expect(result.success).toBe(true);

    // All items should be closed
    expect((await runJson(`show ${gpId}`)).workItem.status).toBe('completed');
    expect((await runJson(`show ${parentId}`)).workItem.status).toBe('completed');
    expect((await runJson(`show ${childId}`)).workItem.status).toBe('completed');
  });

  it('does not close siblings or unrelated items', async () => {
    // Create two independent parent trees
    const parent1 = await runJson(`create -t "Parent 1"`);
    const p1Id = parent1.workItem.id;
    const child1 = await runJson(`create -t "Child of 1" --parent ${p1Id}`);
    const c1Id = child1.workItem.id;

    const parent2 = await runJson(`create -t "Parent 2"`);
    const p2Id = parent2.workItem.id;
    const child2 = await runJson(`create -t "Child of 2" --parent ${p2Id}`);
    const c2Id = child2.workItem.id;

    const unrelated = await runJson(`create -t "Unrelated"`);
    const uId = unrelated.workItem.id;

    // Set parent1 to in_review stage
    await runJson(`update ${p1Id} --status completed --stage in_review`);

    // Set audit on parent1 only
    await runJson(`update ${p1Id} --audit-text "Ready to close: Yes\nAll criteria met"`);

    // Close parent1
    await runJson(`close ${p1Id} -r "done"`);

    // parent1 and its child should be closed
    expect((await runJson(`show ${p1Id}`)).workItem.status).toBe('completed');
    expect((await runJson(`show ${c1Id}`)).workItem.status).toBe('completed');

    // parent2 tree and unrelated should remain open
    expect((await runJson(`show ${p2Id}`)).workItem.status).not.toBe('completed');
    expect((await runJson(`show ${c2Id}`)).workItem.status).not.toBe('completed');
    expect((await runJson(`show ${uId}`)).workItem.status).not.toBe('completed');
  });
});
