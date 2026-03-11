import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore
} from './cli-helpers.js';

describe('CLI Issue Management Tests', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir, '1.0.0');
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  describe('create command', () => {
    it('should create a work item with required fields', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Test task"`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem).toBeDefined();
      expect(result.workItem.id).toMatch(/^TEST-/);
      expect(result.workItem.title).toBe('Test task');
      expect(result.workItem.status).toBe('open');
      expect(result.workItem.priority).toBe('medium');
      expect(result.workItem.stage).toBe('idea');
    });

    it('should create a work item with all optional fields', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Full task" -d "Description" -s in-progress -p high --tags "tag1,tag2" -a "john" --stage "in_progress"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.title).toBe('Full task');
      expect(result.workItem.description).toBe('Description');
      expect(result.workItem.status).toBe('in-progress');
      expect(result.workItem.priority).toBe('high');
      expect(result.workItem.tags).toEqual(['tag1', 'tag2']);
      expect(result.workItem.assignee).toBe('john');
      expect(result.workItem.stage).toBe('in_progress');
    });

    it('should reject incompatible status/stage combinations', async () => {
      try {
        await execAsync(
          `tsx ${cliPath} --json create -t "Bad combo" -s open --stage "done"`
        );
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || error.stdout || '{}');
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid status/stage combination');
        expect(result.error).toContain('Allowed stages for status "open"');
        expect(result.error).toContain('Allowed statuses for stage "done"');
      }
    });

    it('should normalize kebab/underscore status and stage with warnings', async () => {
      const { stdout, stderr } = await execAsync(
        `tsx ${cliPath} --json create -t "Normalize" -s in_progress --stage "in-progress"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.status).toBe('in-progress');
      expect(result.workItem.stage).toBe('in_progress');
      expect(stderr).toContain('Warning: normalized status "in_progress" to "in-progress".');
      expect(stderr).toContain('Warning: normalized stage "in-progress" to "in_progress".');
    });
  });

  describe('update command', () => {
    let workItemId: string;

    beforeEach(async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Original title"`);
      const result = JSON.parse(stdout);
      workItemId = result.workItem.id;
    });

    it('should update a work item title', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${workItemId} -t "Updated title"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.title).toBe('Updated title');
    });

    it('should update multiple fields', async () => {
      const { stdout: created } = await execAsync(
        `tsx ${cliPath} --json create -t "Update base" -s in-progress --stage "in_progress"`
      );
      const itemId = JSON.parse(created).workItem.id;

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${itemId} -t "Updated" -s completed -p high --stage "in_review"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.title).toBe('Updated');
      expect(result.workItem.status).toBe('completed');
      expect(result.workItem.priority).toBe('high');
      expect(result.workItem.stage).toBe('in_review');
    });

    it('should reject incompatible status/stage updates', async () => {
      const { stdout: created } = await execAsync(
        `tsx ${cliPath} --json create -t "Done item" -s completed --stage "done"`
      );
      const itemId = JSON.parse(created).workItem.id;

      try {
        await execAsync(
          `tsx ${cliPath} --json update ${itemId} --stage "idea"`
        );
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || error.stdout || '{}');
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid status/stage combination');
      }
    });

    it('should normalize status/stage updates with warnings', async () => {
      const created = await execAsync(
        `tsx ${cliPath} --json create -t "Stage base" --stage "in_progress"`
      );
      const baseItem = JSON.parse(created.stdout).workItem.id;

      const { stdout, stderr } = await execAsync(
        `tsx ${cliPath} --json update ${baseItem} --status in_progress --stage "in-progress"`
      );
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.status).toBe('in-progress');
      expect(result.workItem.stage).toBe('in_progress');
      expect(stderr).toContain('Warning: normalized status "in_progress" to "in-progress".');
      expect(stderr).toContain('Warning: normalized stage "in-progress" to "in_progress".');
    });

    describe('batch processing (multiple ids)', () => {
      let id1: string;
      let id2: string;
      let id3: string;

      beforeEach(async () => {
        const r1 = await execAsync(`tsx ${cliPath} --json create -t "Batch item 1"`);
        const r2 = await execAsync(`tsx ${cliPath} --json create -t "Batch item 2"`);
        const r3 = await execAsync(`tsx ${cliPath} --json create -t "Batch item 3"`);
        id1 = JSON.parse(r1.stdout).workItem.id;
        id2 = JSON.parse(r2.stdout).workItem.id;
        id3 = JSON.parse(r3.stdout).workItem.id;
      });

      it('should apply flags to all provided ids', async () => {
        const { stdout } = await execAsync(
          `tsx ${cliPath} --json update ${id1} ${id2} ${id3} -t "Batch updated" -p high`
        );

        const result = JSON.parse(stdout);
        expect(result.success).toBe(true);
        expect(result.results).toHaveLength(3);
        for (const r of result.results) {
          expect(r.success).toBe(true);
          expect(r.workItem.title).toBe('Batch updated');
          expect(r.workItem.priority).toBe('high');
        }
      });

      it('should return per-id results in batch JSON output', async () => {
        const { stdout } = await execAsync(
          `tsx ${cliPath} --json update ${id1} ${id2} -a "batch-user"`
        );

        const result = JSON.parse(stdout);
        expect(result.success).toBe(true);
        expect(result.results).toHaveLength(2);
        expect(result.results[0].id).toBe(id1);
        expect(result.results[0].success).toBe(true);
        expect(result.results[0].workItem.assignee).toBe('batch-user');
        expect(result.results[1].id).toBe(id2);
        expect(result.results[1].success).toBe(true);
        expect(result.results[1].workItem.assignee).toBe('batch-user');
      });

      it('should continue processing after a failure for one id', async () => {
        const fakeId = 'TEST-DOESNOTEXIST';

        try {
          await execAsync(
            `tsx ${cliPath} --json update ${id1} ${fakeId} ${id2} -t "Partial batch"`
          );
          expect.fail('Should have exited with non-zero');
        } catch (error: any) {
          const output = error.stdout || error.stderr || '';
          const result = JSON.parse(output);
          expect(result.success).toBe(false);
          expect(result.results).toHaveLength(3);

          // First id succeeds
          expect(result.results[0].id).toBe(id1);
          expect(result.results[0].success).toBe(true);
          expect(result.results[0].workItem.title).toBe('Partial batch');

          // Invalid id fails
          expect(result.results[1].id).toBe(fakeId);
          expect(result.results[1].success).toBe(false);
          expect(result.results[1].error).toContain('not found');

          // Third id still succeeds (not stopped by prior failure)
          expect(result.results[2].id).toBe(id2);
          expect(result.results[2].success).toBe(true);
          expect(result.results[2].workItem.title).toBe('Partial batch');
        }
      });

      it('should exit non-zero when any id fails in batch', async () => {
        const fakeId = 'TEST-NOTREAL';

        try {
          await execAsync(
            `tsx ${cliPath} --json update ${id1} ${fakeId} -t "Some title"`
          );
          expect.fail('Should have exited with non-zero');
        } catch (error: any) {
          const output = error.stdout || error.stderr || '';
          const result = JSON.parse(output);
          expect(result.success).toBe(false);
          expect(result.results).toHaveLength(2);
          expect(result.results[0].success).toBe(true);
          expect(result.results[1].success).toBe(false);
        }
      });

      it('should handle all invalid ids gracefully', async () => {
        try {
          await execAsync(
            `tsx ${cliPath} --json update TEST-BAD1 TEST-BAD2 -t "Won't work"`
          );
          expect.fail('Should have exited with non-zero');
        } catch (error: any) {
          const output = error.stdout || error.stderr || '';
          const result = JSON.parse(output);
          expect(result.success).toBe(false);
          expect(result.results).toHaveLength(2);
          expect(result.results[0].success).toBe(false);
          expect(result.results[0].error).toContain('not found');
          expect(result.results[1].success).toBe(false);
          expect(result.results[1].error).toContain('not found');
        }
      });

      it('should handle status/stage conflict for one id without stopping others', async () => {
        // Create an item with completed/done status so updating to invalid combo fails
        const { stdout: doneStdout } = await execAsync(
          `tsx ${cliPath} --json create -t "Done item" -s completed --stage "done"`
        );
        const doneId = JSON.parse(doneStdout).workItem.id;

        try {
          await execAsync(
            `tsx ${cliPath} --json update ${id1} ${doneId} ${id2} --stage "idea"`
          );
          expect.fail('Should have exited with non-zero');
        } catch (error: any) {
          const output = error.stdout || error.stderr || '';
          const result = JSON.parse(output);
          expect(result.success).toBe(false);
          expect(result.results).toHaveLength(3);

          // id1 (open) updated to idea stage - should succeed (open + idea is valid)
          expect(result.results[0].id).toBe(id1);
          expect(result.results[0].success).toBe(true);

          // doneId (completed/done) updated to idea stage - should fail (invalid combo)
          expect(result.results[1].id).toBe(doneId);
          expect(result.results[1].success).toBe(false);
          expect(result.results[1].error).toContain('Invalid status/stage combination');

          // id2 (open) updated to idea stage - should still succeed
          expect(result.results[2].id).toBe(id2);
          expect(result.results[2].success).toBe(true);
        }
      });

      it('should preserve legacy single-id JSON shape for single id', async () => {
        const { stdout } = await execAsync(
          `tsx ${cliPath} --json update ${id1} -t "Single update"`
        );

        const result = JSON.parse(stdout);
        // Single-id preserves legacy shape: { success, workItem } (no results array)
        expect(result.success).toBe(true);
        expect(result.workItem).toBeDefined();
        expect(result.results).toBeUndefined();
        expect(result.workItem.title).toBe('Single update');
      });
    });
  });

  describe('delete command', () => {
    it('should delete a work item', async () => {
      const createResult = await execAsync(`tsx ${cliPath} --json create -t "To delete"`);
      const created = JSON.parse(createResult.stdout);
      const workItemId = created.workItem.id;

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json delete ${workItemId}`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.deletedId).toBe(workItemId);

      const { stdout: showStdout } = await execAsync(`tsx ${cliPath} --json show ${workItemId}`);
      const shown = JSON.parse(showStdout);
      expect(shown.success).toBe(true);
      expect(shown.workItem.status).toBe('deleted');
      expect(shown.workItem.stage).toBe('idea');
    });
  });

  describe('comment commands', () => {
    let workItemId: string;

    beforeEach(async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Task with comments"`);
      const result = JSON.parse(stdout);
      workItemId = result.workItem.id;
    });

    it('should create a comment', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json comment create ${workItemId} -a "John" --body "Test comment"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.comment.workItemId).toBe(workItemId);
      expect(result.comment.author).toBe('John');
      expect(result.comment.comment).toBe('Test comment');
    });

    it('should error when both --comment and --body are provided', async () => {
      try {
        await execAsync(`tsx ${cliPath} --json comment create ${workItemId} -a "John" -c "Legacy" --body "New"`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || error.stdout || '{}');
        expect(result.success).toBe(false);
        expect(result.error).toBe('Cannot use both --comment and --body together.');
      }
    });

    it('should update a comment', async () => {
      const createResult = await execAsync(
        `tsx ${cliPath} --json comment create ${workItemId} -a "Alice" --body "Original"`
      );
      const created = JSON.parse(createResult.stdout);
      const commentId = created.comment.id;

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json comment update ${commentId} -c "Updated comment"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.comment.comment).toBe('Updated comment');
    });

    it('should delete a comment', async () => {
      const createResult = await execAsync(
        `tsx ${cliPath} --json comment create ${workItemId} -a "Alice" --body "To delete"`
      );
      const created = JSON.parse(createResult.stdout);
      const commentId = created.comment.id;

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json comment delete ${commentId}`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.deletedId).toBe(commentId);
    });
  });

  describe('dep commands', () => {
    it('should add a dependency edge', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;

      const { stdout } = await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.edge.fromId).toBe(fromId);
      expect(result.edge.toId).toBe(toId);

      const { stdout: showStdout } = await execAsync(`tsx ${cliPath} --json show ${fromId}`);
      const updated = JSON.parse(showStdout).workItem;
      expect(updated.status).toBe('blocked');
    });

    it('should remove a dependency edge', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json dep rm ${fromId} ${toId}`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.removed).toBe(true);
      expect(result.edge.fromId).toBe(fromId);
      expect(result.edge.toId).toBe(toId);

      const { stdout: showStdout } = await execAsync(`tsx ${cliPath} --json show ${fromId}`);
      const updated = JSON.parse(showStdout).workItem;
      expect(updated.status).toBe('open');
    });

    it('should unblock dependents when a blocking item is closed', async () => {
      const { stdout: blockedStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocked"`);
      const { stdout: blockerStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocker"`);
      const blockedId = JSON.parse(blockedStdout).workItem.id;
      const blockerId = JSON.parse(blockerStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerId}`);
      const { stdout: blockedShowStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(blockedShowStdout).workItem.status).toBe('blocked');

      await execAsync(`tsx ${cliPath} --json close ${blockerId}`);
      const { stdout: unblockedShowStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(unblockedShowStdout).workItem.status).toBe('open');
    });

    it('should unblock dependents when a blocking item is deleted', async () => {
      const { stdout: blockedStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocked"`);
      const { stdout: blockerStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocker"`);
      const blockedId = JSON.parse(blockedStdout).workItem.id;
      const blockerId = JSON.parse(blockerStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerId}`);
      const { stdout: blockedShowStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(blockedShowStdout).workItem.status).toBe('blocked');

      await execAsync(`tsx ${cliPath} --json delete ${blockerId}`);
      const { stdout: unblockedShowStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(unblockedShowStdout).workItem.status).toBe('open');
    });

    it('should re-block dependents when a closed blocker is reopened', async () => {
      const { stdout: blockedStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocked"`);
      const { stdout: blockerStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocker"`);
      const blockedId = JSON.parse(blockedStdout).workItem.id;
      const blockerId = JSON.parse(blockerStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerId}`);
      await execAsync(`tsx ${cliPath} --json close ${blockerId}`);
      const { stdout: unblockedShowStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(unblockedShowStdout).workItem.status).toBe('open');

      await execAsync(`tsx ${cliPath} --json update ${blockerId} --status in-progress --stage in_progress`);
      const { stdout: blockedShowStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(blockedShowStdout).workItem.status).toBe('blocked');
    });

    it('should keep dependent blocked when only one of multiple blockers is closed', async () => {
      const { stdout: blockedStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocked"`);
      const { stdout: blockerAStdout } = await execAsync(`tsx ${cliPath} --json create -t "BlockerA"`);
      const { stdout: blockerBStdout } = await execAsync(`tsx ${cliPath} --json create -t "BlockerB"`);
      const blockedId = JSON.parse(blockedStdout).workItem.id;
      const blockerAId = JSON.parse(blockerAStdout).workItem.id;
      const blockerBId = JSON.parse(blockerBStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerAId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerBId}`);
      const { stdout: blockedShowStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(blockedShowStdout).workItem.status).toBe('blocked');

      await execAsync(`tsx ${cliPath} --json close ${blockerAId}`);
      const { stdout: stillBlockedStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(stillBlockedStdout).workItem.status).toBe('blocked');
    });

    it('should unblock dependent when all blockers are closed', async () => {
      const { stdout: blockedStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocked"`);
      const { stdout: blockerAStdout } = await execAsync(`tsx ${cliPath} --json create -t "BlockerA"`);
      const { stdout: blockerBStdout } = await execAsync(`tsx ${cliPath} --json create -t "BlockerB"`);
      const blockedId = JSON.parse(blockedStdout).workItem.id;
      const blockerAId = JSON.parse(blockerAStdout).workItem.id;
      const blockerBId = JSON.parse(blockerBStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerAId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerBId}`);

      await execAsync(`tsx ${cliPath} --json close ${blockerAId}`);
      await execAsync(`tsx ${cliPath} --json close ${blockerBId}`);
      const { stdout: unblockedStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(unblockedStdout).workItem.status).toBe('open');
    });

    it('should handle chain dependencies: close A unblocks B but C stays blocked', async () => {
      const { stdout: aStdout } = await execAsync(`tsx ${cliPath} --json create -t "A"`);
      const { stdout: bStdout } = await execAsync(`tsx ${cliPath} --json create -t "B"`);
      const { stdout: cStdout } = await execAsync(`tsx ${cliPath} --json create -t "C"`);
      const aId = JSON.parse(aStdout).workItem.id;
      const bId = JSON.parse(bStdout).workItem.id;
      const cId = JSON.parse(cStdout).workItem.id;

      // B depends on A, C depends on B
      await execAsync(`tsx ${cliPath} --json dep add ${bId} ${aId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${cId} ${bId}`);

      // Close A: B should unblock, C should stay blocked (B is open, not completed)
      await execAsync(`tsx ${cliPath} --json close ${aId}`);
      const { stdout: bShowStdout } = await execAsync(`tsx ${cliPath} --json show ${bId}`);
      expect(JSON.parse(bShowStdout).workItem.status).toBe('open');
      const { stdout: cShowStdout } = await execAsync(`tsx ${cliPath} --json show ${cId}`);
      expect(JSON.parse(cShowStdout).workItem.status).toBe('blocked');

      // Close B: C should unblock
      await execAsync(`tsx ${cliPath} --json close ${bId}`);
      const { stdout: cUnblockedStdout } = await execAsync(`tsx ${cliPath} --json show ${cId}`);
      expect(JSON.parse(cUnblockedStdout).workItem.status).toBe('open');
    });

    it('should unblock multiple dependents when shared blocker is closed', async () => {
      const { stdout: blockerStdout } = await execAsync(`tsx ${cliPath} --json create -t "SharedBlocker"`);
      const { stdout: depAStdout } = await execAsync(`tsx ${cliPath} --json create -t "DepA"`);
      const { stdout: depBStdout } = await execAsync(`tsx ${cliPath} --json create -t "DepB"`);
      const blockerId = JSON.parse(blockerStdout).workItem.id;
      const depAId = JSON.parse(depAStdout).workItem.id;
      const depBId = JSON.parse(depBStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${depAId} ${blockerId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${depBId} ${blockerId}`);

      await execAsync(`tsx ${cliPath} --json close ${blockerId}`);
      const { stdout: depAShowStdout } = await execAsync(`tsx ${cliPath} --json show ${depAId}`);
      const { stdout: depBShowStdout } = await execAsync(`tsx ${cliPath} --json show ${depBId}`);
      expect(JSON.parse(depAShowStdout).workItem.status).toBe('open');
      expect(JSON.parse(depBShowStdout).workItem.status).toBe('open');
    });

    it('should close with reason and still unblock dependents', async () => {
      const { stdout: blockedStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocked"`);
      const { stdout: blockerStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocker"`);
      const blockedId = JSON.parse(blockedStdout).workItem.id;
      const blockerId = JSON.parse(blockerStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerId}`);
      await execAsync(`tsx ${cliPath} --json close ${blockerId} -r "Done with implementation"`);
      const { stdout: unblockedStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(unblockedStdout).workItem.status).toBe('open');
    });

    it('should fail when adding an existing dependency', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);

      try {
        await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || '{}');
        expect(result.success).toBe(false);
        expect(result.error).toBe('Dependency already exists.');
      }
    });

    it('should error for missing ids', async () => {
      try {
        await execAsync(`tsx ${cliPath} --json dep add TEST-NOTFOUND TEST-NOTFOUND-2`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || '{}');
        expect(result.success).toBe(false);
        expect(Array.isArray(result.errors)).toBe(true);
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it('should list dependency edges', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const { stdout: otherStdout } = await execAsync(`tsx ${cliPath} --json create -t "Other"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;
      const otherId = JSON.parse(otherStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${otherId} ${fromId}`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json dep list ${fromId}`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.outbound).toHaveLength(1);
      expect(result.outbound[0].id).toBe(toId);
      expect(result.outbound[0].direction).toBe('depends-on');
      expect(result.inbound).toHaveLength(1);
      expect(result.inbound[0].id).toBe(otherId);
      expect(result.inbound[0].direction).toBe('depended-on-by');
    });

    it('should list outbound-only dependency edges', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const { stdout: otherStdout } = await execAsync(`tsx ${cliPath} --json create -t "Other"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;
      const otherId = JSON.parse(otherStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${otherId} ${fromId}`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json dep list ${fromId} --outgoing`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.outbound).toHaveLength(1);
      expect(result.outbound[0].id).toBe(toId);
      expect(result.inbound).toHaveLength(0);
    });

    it('should list inbound-only dependency edges', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const { stdout: otherStdout } = await execAsync(`tsx ${cliPath} --json create -t "Other"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;
      const otherId = JSON.parse(otherStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${otherId} ${fromId}`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json dep list ${fromId} --incoming`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.inbound).toHaveLength(1);
      expect(result.inbound[0].id).toBe(otherId);
      expect(result.outbound).toHaveLength(0);
    });

    it('should warn for missing ids and exit 0 for list', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json dep list TEST-NOTFOUND`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.inbound).toHaveLength(0);
      expect(result.outbound).toHaveLength(0);
    });

    it('should error when using incoming and outgoing together', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const fromId = JSON.parse(fromStdout).workItem.id;

      try {
        await execAsync(`tsx ${cliPath} --json dep list ${fromId} --incoming --outgoing`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || '{}');
        expect(result.success).toBe(false);
        expect(result.error).toBe('Cannot use --incoming and --outgoing together.');
      }
    });

    it('should unblock dependent when sole blocker moves to in_review stage via update', async () => {
      const { stdout: blockedStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocked"`);
      const { stdout: blockerStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocker"`);
      const blockedId = JSON.parse(blockedStdout).workItem.id;
      const blockerId = JSON.parse(blockerStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerId}`);
      const { stdout: blockedShowStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(blockedShowStdout).workItem.status).toBe('blocked');

      await execAsync(`tsx ${cliPath} --json update ${blockerId} --status completed --stage in_review`);
      const { stdout: unblockedShowStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(unblockedShowStdout).workItem.status).toBe('open');
    });

    it('should keep dependent blocked when only one of multiple blockers moves to in_review', async () => {
      const { stdout: blockedStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocked"`);
      const { stdout: blockerAStdout } = await execAsync(`tsx ${cliPath} --json create -t "BlockerA"`);
      const { stdout: blockerBStdout } = await execAsync(`tsx ${cliPath} --json create -t "BlockerB"`);
      const blockedId = JSON.parse(blockedStdout).workItem.id;
      const blockerAId = JSON.parse(blockerAStdout).workItem.id;
      const blockerBId = JSON.parse(blockerBStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerAId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerBId}`);

      await execAsync(`tsx ${cliPath} --json update ${blockerAId} --status completed --stage in_review`);
      const { stdout: stillBlockedStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(stillBlockedStdout).workItem.status).toBe('blocked');
    });

    it('should unblock dependent when all blockers move to in_review', async () => {
      const { stdout: blockedStdout } = await execAsync(`tsx ${cliPath} --json create -t "Blocked"`);
      const { stdout: blockerAStdout } = await execAsync(`tsx ${cliPath} --json create -t "BlockerA"`);
      const { stdout: blockerBStdout } = await execAsync(`tsx ${cliPath} --json create -t "BlockerB"`);
      const blockedId = JSON.parse(blockedStdout).workItem.id;
      const blockerAId = JSON.parse(blockerAStdout).workItem.id;
      const blockerBId = JSON.parse(blockerBStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerAId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${blockedId} ${blockerBId}`);

      await execAsync(`tsx ${cliPath} --json update ${blockerAId} --status completed --stage in_review`);
      const { stdout: stillBlockedStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(stillBlockedStdout).workItem.status).toBe('blocked');

      await execAsync(`tsx ${cliPath} --json update ${blockerBId} --status completed --stage in_review`);
      const { stdout: unblockedStdout } = await execAsync(`tsx ${cliPath} --json show ${blockedId}`);
      expect(JSON.parse(unblockedStdout).workItem.status).toBe('open');
    });
  });
});
