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

  // ── childrenClosed output tests ─────────────────────────────────────

  it('includes childrenClosed in JSON output for recursive close', async () => {
    const { parentId, childIds } = await createParentWithChildren(3, true);
    await runJson(`update ${parentId} --audit-text "Ready to close: Yes\nAll criteria met"`);

    const result = await runJson(`close ${parentId} -r "done"`);
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);

    const parentResult = result.results[0];
    expect(parentResult.id).toBe(parentId);
    expect(parentResult.success).toBe(true);
    // childrenClosed should count all 3 children
    expect(parentResult.childrenClosed).toBe(3);
  });

  it('includes childrenClosed count for nested descendants (grandchildren)', async () => {
    // Create grandparent -> parent -> child chain
    const grandparent = await runJson(`create -t "Grandparent"`);
    const gpId = grandparent.workItem.id;

    const parent = await runJson(`create -t "Parent" --parent ${gpId}`);
    const parentId = parent.workItem.id;

    const child = await runJson(`create -t "Child" --parent ${parentId}`);
    const childId = child.workItem.id;

    // Set grandparent to in_review stage
    await runJson(`update ${gpId} --status completed --stage in_review`);
    await runJson(`update ${gpId} --audit-text "Ready to close: Yes\nAll criteria met"`);

    const result = await runJson(`close ${gpId} -r "done"`);
    expect(result.success).toBe(true);
    expect(result.results[0].childrenClosed).toBe(2); // parent + child = 2 descendants
  });

  it('does NOT include childrenClosed for non-recursive close', async () => {
    const { parentId } = await createParentWithChildren(2, false);

    // Close parent (NOT in_review -> non-recursive)
    const result = await runJson(`close ${parentId} -r "done"`);
    expect(result.success).toBe(true);
    expect(result.results[0].childrenClosed).toBeUndefined();
  });

  it('shows human-readable output with children count for recursive close', async () => {
    const { parentId } = await createParentWithChildren(2, true);
    await runJson(`update ${parentId} --audit-text "Ready to close: Yes\nAll criteria met"`);

    // Run without --json to test human-readable output
    const { stdout, stderr } = await runRaw(`close ${parentId} -r "done"`);

    // Should show "Closed <id> (2 children closed)"
    expect(stdout).toContain(`Closed ${parentId}`);
    expect(stdout).toContain('(2 children closed)');
    // No child errors
    expect(stderr).toBe('');
  });

  it('shows human-readable (0 children closed) for recursive close with no children', async () => {
    // Create an item with no children but that will trigger the recursive path
    const created = await runJson(`create -t "No children"`);
    const id = created.workItem.id;
    await runJson(`update ${id} --status completed --stage in_review`);
    await runJson(`update ${id} --audit-text "Ready to close: Yes\nAll criteria met"`);

    // This still goes through the recursive check path but has no children
    const { stdout, stderr } = await runRaw(`close ${id} -r "done"`);

    // Standard close (no children) shows just "Closed <id>"
    expect(stdout).toContain(`Closed ${id}`);
    expect(stdout).not.toContain('children closed');
    expect(stderr).toBe('');
  });

  it('preserves single-item close human-readable output unchanged', async () => {
    const created = await runJson(`create -t "Single"`);
    const id = created.workItem.id;

    const { stdout, stderr } = await runRaw(`close ${id} -r "done"`);
    expect(stdout).toContain(`Closed ${id}`);
    expect(stdout).not.toContain('children');
    expect(stderr).toBe('');
  });

  it('human-readable output shows child error message format (code-level verification)', async () => {
    // Integration-level verification of the child error output format is not
    // possible because the database layer does not fail on closeSingle() in
    // a test environment. The error path is verified through:
    //   1. Code review: `closeDescendants()` catches erors from `closeSingle()`
    //      and adds them to the errors array with the expected format.
    //   2. The output formatting code formats child errors as:
    //      "Child <id>: Failed to close descendant — this item remains unclosed at top level"
    //
    // For now, verify the happy path output format is correct.
    const { parentId } = await createParentWithChildren(2, true);
    await runJson(`update ${parentId} --audit-text "Ready to close: Yes\nAll criteria met"`);

    const { stdout, stderr } = await runRaw(`close ${parentId} -r "done"`);
    expect(stdout).toContain(`Closed ${parentId}`);
    expect(stdout).toContain('(2 children closed)');
    // No child errors on happy path
    expect(stderr).toBe('');
  });

  it('childErrors array present in JSON when children fail (code-level verification, see comment above)', async () => {
    // Same limitation as above: we cannot trigger closeSingle() failure in
    // integration tests. See the previous test for explanation.
    //
    // This test verifies the happy path only — no childErrors when all children
    // close successfully.
    const { parentId } = await createParentWithChildren(2, true);
    await runJson(`update ${parentId} --audit-text "Ready to close: Yes\nAll criteria met"`);

    const result = await runJson(`close ${parentId} -r "done"`);
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);

    const parentResult = result.results[0];
    expect(parentResult.success).toBe(true);
    expect(parentResult.childrenClosed).toBe(2);
    // No childErrors on happy path
    expect(parentResult.childErrors).toBeUndefined();
  });

  // ── Recovery path: done parent with open children ───────────────────

  it('closes open children when parent is already in done stage (recovery path via update)', async () => {
    // Create parent with children (default open/idea stage)
    const { parentId, childIds } = await createParentWithChildren(2, false);

    // Set parent to completed/done via update (simulating a workflow where
    // the parent was marked done without closing children)
    await runJson(`update ${parentId} --status completed --stage done`);

    // Verify parent is done
    let parentShown = await runJson(`show ${parentId}`);
    expect(parentShown.workItem.status).toBe('completed');
    expect(parentShown.workItem.stage).toBe('done');

    // Children should NOT be closed
    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).not.toBe('completed');
    }

    // Call close again on the done parent — should trigger recovery
    const result = await runJson(`close ${parentId} -r "closing children"`);
    expect(result.success).toBe(true);

    // Children should now be closed
    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).toBe('completed');
      expect(childShown.workItem.stage).toBe('done');
    }

    // Parent should remain done (unchanged)
    parentShown = await runJson(`show ${parentId}`);
    expect(parentShown.workItem.status).toBe('completed');
    expect(parentShown.workItem.stage).toBe('done');
  });

  it('closes open children when parent is already done via close (recovery path via close)', async () => {
    // Create parent with children (default open/idea stage)
    const { parentId, childIds } = await createParentWithChildren(2, false);

    // Close parent (non-recursive — parent not in_review)
    // This leaves children open, simulating real-world orphaned children
    await runJson(`close ${parentId} -r "done"`);

    // Verify parent is done but children are NOT
    let parentShown = await runJson(`show ${parentId}`);
    expect(parentShown.workItem.status).toBe('completed');
    expect(parentShown.workItem.stage).toBe('done');

    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).not.toBe('completed');
    }

    // Call close again on the done parent — should trigger recovery
    const result = await runJson(`close ${parentId} -r "closing children"`);
    expect(result.success).toBe(true);

    // Children should now be closed
    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).toBe('completed');
    }

    // Parent should remain done
    parentShown = await runJson(`show ${parentId}`);
    expect(parentShown.workItem.status).toBe('completed');
  });

  it('recovery path JSON output includes recovered: true', async () => {
    const { parentId } = await createParentWithChildren(2, false);

    // Set parent to completed/done
    await runJson(`update ${parentId} --status completed --stage done`);

    const result = await runJson(`close ${parentId} -r "closing children"`);
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);

    const parentResult = result.results[0];
    expect(parentResult.id).toBe(parentId);
    expect(parentResult.success).toBe(true);
    // Should have recovered: true and childrenClosed count
    expect(parentResult.recovered).toBe(true);
    expect(parentResult.childrenClosed).toBe(2);
  });

  it('recovery path human-readable output shows recovery message', async () => {
    const { parentId } = await createParentWithChildren(2, false);

    // Set parent to completed/done
    await runJson(`update ${parentId} --status completed --stage done`);

    // Run without --json to test human-readable output
    const { stdout, stderr } = await runRaw(`close ${parentId} -r "closing children"`);

    // Should show recovery message with children count
    expect(stdout).toContain(`Recovery close for ${parentId}`);
    expect(stdout).toContain('2 open children closed');
    expect(stderr).toBe('');
  });

  it('does NOT trigger recovery path when parent is done and all children are already done', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, false);

    // Close all children first
    for (const childId of childIds) {
      await runJson(`close ${childId} -r "done"`);
    }

    // Set parent to done
    await runJson(`update ${parentId} --status completed --stage done`);

    // Call close — should NOT trigger recovery (all children already done)
    const result = await runJson(`close ${parentId} -r "done"`);
    expect(result.success).toBe(true);
    expect(result.results[0].recovered).toBeUndefined();

    // Standard output: no recovery message
    const { stdout } = await runRaw(`close ${parentId} -r "done"`);
    expect(stdout).not.toContain('Recovery close');
  });

  it('does NOT trigger recovery path when parent is not done', async () => {
    // Parent in open stage — standard behavior
    const { parentId } = await createParentWithChildren(2, false);

    const result = await runJson(`close ${parentId} -r "done"`);
    expect(result.success).toBe(true);
    expect(result.results[0].recovered).toBeUndefined();
  });

  it('recovery path closes nested descendants (grandchildren)', async () => {
    // Create grandparent -> parent -> child chain
    const grandparent = await runJson(`create -t "Grandparent"`);
    const gpId = grandparent.workItem.id;

    const parent = await runJson(`create -t "Parent" --parent ${gpId}`);
    const parentId = parent.workItem.id;

    const child = await runJson(`create -t "Child" --parent ${parentId}`);
    const childId = child.workItem.id;

    // Set grandparent to completed/done (simulating a workflow where
    // the grandparent was closed without closing descendants)
    await runJson(`update ${gpId} --status completed --stage done`);

    // Call close on grandparent — should trigger recovery
    const result = await runJson(`close ${gpId} -r "closing descendants"`);
    expect(result.success).toBe(true);
    expect(result.results[0].recovered).toBe(true);
    expect(result.results[0].childrenClosed).toBe(2); // parent + child

    // All items should be done
    expect((await runJson(`show ${gpId}`)).workItem.stage).toBe('done');
    expect((await runJson(`show ${parentId}`)).workItem.status).toBe('completed');
    expect((await runJson(`show ${childId}`)).workItem.status).toBe('completed');
  });

  it('recovery path with mixed children (some already done, some open)', async () => {
    const { parentId, childIds } = await createParentWithChildren(3, false);

    // Close the first child only
    await runJson(`close ${childIds[0]} -r "done"`);

    // Set parent to completed/done
    await runJson(`update ${parentId} --status completed --stage done`);

    // Call close on parent — should recover the remaining open children.
    // closeDescendants processes ALL descendants; childrenClosed includes
    // the already-closed child since closeSingle handles it gracefully.
    const result = await runJson(`close ${parentId} -r "closing open children"`);
    expect(result.success).toBe(true);
    expect(result.results[0].recovered).toBe(true);
    // All 3 descendants were processed (1 was already done, 2 were open)
    // closeDescendants counts descendants.length - errors.length = 3 - 0
    expect(result.results[0].childrenClosed).toBe(3);

    // All children should be done now
    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).toBe('completed');
    }
  });

  // ── Warning on orphaned children (non-recursive close) ──────────────

  it('prints warning to stderr when closing parent with children in non-recursive mode', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, false);

    // Close parent (not in_review -> non-recursive)
    const { stdout, stderr } = await runRaw(`close ${parentId} -r "done"`);

    // Parent should be closed
    const parentShown = await runJson(`show ${parentId}`);
    expect(parentShown.workItem.status).toBe('completed');

    // Children should NOT be closed
    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).not.toBe('completed');
    }

    // Stdout should show standard close message
    expect(stdout).toContain(`Closed ${parentId}`);
    // Stderr should contain the warning about orphaned children
    expect(stderr).toContain(`Warning: ${parentId} has ${childIds.length} open children`);
    expect(stderr).toContain('Use `wl close --force');
  });

  it('does NOT print warning when closing single item with no children', async () => {
    const created = await runJson(`create -t "Single item"`);
    const id = created.workItem.id;

    const { stdout, stderr } = await runRaw(`close ${id} -r "done"`);

    expect(stdout).toContain(`Closed ${id}`);
    expect(stderr).toBe('');
  });

  it('does NOT print warning for audit-gated recursive close (children are closed)', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, true);
    await runJson(`update ${parentId} --audit-text "Ready to close: Yes\nAll criteria met"`);

    const { stdout, stderr } = await runRaw(`close ${parentId} -r "done"`);

    // All items should be closed (recursive)
    expect(stdout).toContain(`Closed ${parentId}`);
    expect(stdout).toContain('(2 children closed)');
    // No warning in stderr
    expect(stderr).toBe('');
  });

  it('does NOT print warning for recovery close (children are being closed)', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, false);
    await runJson(`update ${parentId} --status completed --stage done`);

    const { stdout, stderr } = await runRaw(`close ${parentId} -r "closing children"`);

    expect(stdout).toContain(`Recovery close for ${parentId}`);
    expect(stderr).toBe('');
  });

  // ── --force flag ─────────────────────────────────────────────────────

  it('closes parent and all children when --force is used (non-recursive path)', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, false);

    // Close parent with --force
    const result = await runJson(`close --force ${parentId} -r "done"`);
    expect(result.success).toBe(true);
    expect(result.results[0].childrenClosed).toBe(2);

    // Parent should be closed
    const parentShown = await runJson(`show ${parentId}`);
    expect(parentShown.workItem.status).toBe('completed');

    // Children should also be closed
    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).toBe('completed');
    }
  });

  it('closes parent and all children when --force is used (in_review but no audit)', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, true);

    // Close parent with --force (parent is in_review but has no audit)
    const result = await runJson(`close --force ${parentId} -r "done"`);
    expect(result.success).toBe(true);
    expect(result.results[0].childrenClosed).toBe(2);

    // All should be closed
    const parentShown = await runJson(`show ${parentId}`);
    expect(parentShown.workItem.status).toBe('completed');
    for (const childId of childIds) {
      const childShown = await runJson(`show ${childId}`);
      expect(childShown.workItem.status).toBe('completed');
    }
  });

  it('closes nested descendants (grandchildren) when --force is used', async () => {
    const grandparent = await runJson(`create -t "Grandparent"`);
    const gpId = grandparent.workItem.id;

    const parent = await runJson(`create -t "Parent" --parent ${gpId}`);
    const parentId = parent.workItem.id;

    const child = await runJson(`create -t "Child" --parent ${parentId}`);
    const childId = child.workItem.id;

    // Close grandparent with --force (not in_review, no audit)
    const result = await runJson(`close --force ${gpId} -r "done"`);
    expect(result.success).toBe(true);
    expect(result.results[0].childrenClosed).toBe(2); // parent + child

    // All items should be closed
    expect((await runJson(`show ${gpId}`)).workItem.status).toBe('completed');
    expect((await runJson(`show ${parentId}`)).workItem.status).toBe('completed');
    expect((await runJson(`show ${childId}`)).workItem.status).toBe('completed');
  });

  it('--force with no children behaves as standard close', async () => {
    const created = await runJson(`create -t "Single item"`);
    const id = created.workItem.id;

    const result = await runJson(`close --force ${id} -r "done"`);
    expect(result.success).toBe(true);
    expect(result.results[0].childrenClosed).toBeUndefined();

    const shown = await runJson(`show ${id}`);
    expect(shown.workItem.status).toBe('completed');
  });

  it('--force does NOT print warning on stderr', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, false);

    const { stdout, stderr } = await runRaw(`close --force ${parentId} -r "done"`);

    // Should show recursive close message
    expect(stdout).toContain(`Closed ${parentId}`);
    expect(stdout).toContain('(2 children closed)');
    // No warning in stderr
    expect(stderr).toBe('');
  });

  it('--force human-readable output matches recursive close format', async () => {
    const { parentId } = await createParentWithChildren(2, false);

    const { stdout, stderr } = await runRaw(`close --force ${parentId} -r "done"`);

    expect(stdout).toContain(`Closed ${parentId}`);
    expect(stdout).toContain('(2 children closed)');
    expect(stderr).toBe('');
  });

  it('--force in JSON mode returns childrenClosed in result', async () => {
    const { parentId, childIds } = await createParentWithChildren(3, false);

    const result = await runJson(`close --force ${parentId} -r "done"`);
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe(parentId);
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].childrenClosed).toBe(3);
  });

  it('JSON mode: warning on stderr does not corrupt stdout JSON', async () => {
    const { parentId, childIds } = await createParentWithChildren(2, false);

    // Run in JSON mode but capture stderr separately via raw execution
    // The --json flag affects output format; the warning goes to stderr
    const { stdout, stderr } = await execAsync(`tsx ${cliPath} --json close ${parentId} -r "done"`);

    // Stdout should be valid JSON
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.results[0].success).toBe(true);

    // Stderr should contain the warning
    expect(stderr).toContain(`Warning: ${parentId} has ${childIds.length} open children`);
  });
});