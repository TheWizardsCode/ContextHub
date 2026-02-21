/**
 * Dedicated tests for `wl update` batch behaviour.
 *
 * Covers:
 * - single-id update unchanged (no-op) behaviour
 * - single-id update preserves untouched fields
 * - multiple ids apply same flags to each item
 * - per-id failures do not stop processing of other ids
 * - exit code is non-zero when any id fails
 * - invalid ids are reported per-id with clear error messages
 * - batch update with various field types (tags, assignee, description, etc.)
 * - human-mode (non-JSON) output for batch results
 *
 * Work item: WL-0MLRSUXHR000EW60
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

describe('update batch behaviour', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir, '1.0.0');
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  // -----------------------------------------------------------------------
  // Helper: create a work item and return its id
  // -----------------------------------------------------------------------
  async function createItem(flags = ''): Promise<string> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "Batch test item" ${flags}`
    );
    return JSON.parse(stdout).workItem.id;
  }

  // =======================================================================
  // Single-id: unchanged / no-op behaviour
  // =======================================================================
  describe('single-id unchanged behaviour', () => {
    it('should succeed when updating with no flags (no-op)', async () => {
      const id = await createItem();

      // Show before update
      const { stdout: beforeStdout } = await execAsync(
        `tsx ${cliPath} --json show ${id}`
      );
      const before = JSON.parse(beforeStdout).workItem;

      // Update with no flags -- should succeed without changing anything
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id}`
      );
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem).toBeDefined();
      expect(result.workItem.id).toBe(id);

      // Verify fields are unchanged
      expect(result.workItem.title).toBe(before.title);
      expect(result.workItem.status).toBe(before.status);
      expect(result.workItem.priority).toBe(before.priority);
      expect(result.workItem.description).toBe(before.description);
    });

    it('should preserve untouched fields when updating a single field', async () => {
      const id = await createItem('-p high -a "alice" --tags "tag1,tag2"');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id} -t "New title only"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.title).toBe('New title only');
      // Untouched fields should remain
      expect(result.workItem.priority).toBe('high');
      expect(result.workItem.assignee).toBe('alice');
      expect(result.workItem.tags).toEqual(['tag1', 'tag2']);
    });

    it('should return legacy single-id JSON shape (no results array)', async () => {
      const id = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id} -t "Legacy shape"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem).toBeDefined();
      expect(result.results).toBeUndefined();
    });
  });

  // =======================================================================
  // Multiple ids: same flags applied to all
  // =======================================================================
  describe('multiple ids apply same flags', () => {
    it('should update title for all ids', async () => {
      const id1 = await createItem();
      const id2 = await createItem();
      const id3 = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} ${id3} -t "Unified title"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(3);
      for (const r of result.results) {
        expect(r.success).toBe(true);
        expect(r.workItem.title).toBe('Unified title');
      }
    });

    it('should update priority and assignee for all ids', async () => {
      const id1 = await createItem();
      const id2 = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} -p critical -a "batch-agent"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      for (const r of result.results) {
        expect(r.success).toBe(true);
        expect(r.workItem.priority).toBe('critical');
        expect(r.workItem.assignee).toBe('batch-agent');
      }
    });

    it('should update tags for all ids', async () => {
      const id1 = await createItem();
      const id2 = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} --tags "alpha,beta"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      for (const r of result.results) {
        expect(r.success).toBe(true);
        expect(r.workItem.tags).toEqual(['alpha', 'beta']);
      }
    });

    it('should update description for all ids', async () => {
      const id1 = await createItem();
      const id2 = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} -d "Shared description"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      for (const r of result.results) {
        expect(r.success).toBe(true);
        expect(r.workItem.description).toBe('Shared description');
      }
    });

    it('should preserve per-id ordering in results array', async () => {
      const id1 = await createItem();
      const id2 = await createItem();
      const id3 = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} ${id3} -t "Ordered"`
      );

      const result = JSON.parse(stdout);
      expect(result.results[0].id).toBe(id1);
      expect(result.results[1].id).toBe(id2);
      expect(result.results[2].id).toBe(id3);
    });
  });

  // =======================================================================
  // Per-id failures do not stop other ids
  // =======================================================================
  describe('per-id failure isolation', () => {
    it('should process ids after a failing id', async () => {
      const id1 = await createItem();
      const id2 = await createItem();
      const fakeId = 'TEST-NONEXISTENT';

      try {
        await execAsync(
          `tsx ${cliPath} --json update ${id1} ${fakeId} ${id2} -t "Resilient"`
        );
        expect.fail('Should have exited with non-zero');
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        const result = JSON.parse(output);

        expect(result.success).toBe(false);
        expect(result.results).toHaveLength(3);

        // First succeeds
        expect(result.results[0].id).toBe(id1);
        expect(result.results[0].success).toBe(true);
        expect(result.results[0].workItem.title).toBe('Resilient');

        // Invalid fails
        expect(result.results[1].id).toBe(fakeId);
        expect(result.results[1].success).toBe(false);

        // Third still succeeds
        expect(result.results[2].id).toBe(id2);
        expect(result.results[2].success).toBe(true);
        expect(result.results[2].workItem.title).toBe('Resilient');
      }
    });

    it('should process remaining ids after multiple consecutive failures', async () => {
      const id1 = await createItem();

      try {
        await execAsync(
          `tsx ${cliPath} --json update TEST-FAKE1 TEST-FAKE2 ${id1} -t "After failures"`
        );
        expect.fail('Should have exited with non-zero');
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        const result = JSON.parse(output);

        expect(result.success).toBe(false);
        expect(result.results).toHaveLength(3);
        expect(result.results[0].success).toBe(false);
        expect(result.results[1].success).toBe(false);
        // Valid id at the end still succeeds
        expect(result.results[2].id).toBe(id1);
        expect(result.results[2].success).toBe(true);
        expect(result.results[2].workItem.title).toBe('After failures');
      }
    });

    it('should isolate status/stage validation failures per-id', async () => {
      // Create one item in completed/done state
      const { stdout: doneStdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Completed" -s completed --stage "done"`
      );
      const doneId = JSON.parse(doneStdout).workItem.id;

      // Create a normal open item
      const openId = await createItem();

      try {
        // Attempt to set stage=idea on both -- should fail for completed item
        // but succeed for open item
        await execAsync(
          `tsx ${cliPath} --json update ${openId} ${doneId} --stage "idea"`
        );
        expect.fail('Should have exited with non-zero');
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        const result = JSON.parse(output);

        expect(result.success).toBe(false);
        expect(result.results).toHaveLength(2);

        // open item can accept stage=idea
        expect(result.results[0].id).toBe(openId);
        expect(result.results[0].success).toBe(true);

        // completed item cannot accept stage=idea
        expect(result.results[1].id).toBe(doneId);
        expect(result.results[1].success).toBe(false);
        expect(result.results[1].error).toContain('Invalid status/stage combination');
      }
    });
  });

  // =======================================================================
  // Exit code non-zero if any id failed
  // =======================================================================
  describe('exit code behaviour', () => {
    it('should exit zero when all ids succeed', async () => {
      const id1 = await createItem();
      const id2 = await createItem();

      // Should not throw (exit code 0)
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} -t "All pass"`
      );
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
    });

    it('should exit non-zero when single id is invalid', async () => {
      try {
        await execAsync(
          `tsx ${cliPath} --json update TEST-BOGUS -t "Missing"`
        );
        expect.fail('Should have exited with non-zero');
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        const result = JSON.parse(output);
        expect(result.success).toBe(false);
      }
    });

    it('should exit non-zero even when majority of ids succeed', async () => {
      const id1 = await createItem();
      const id2 = await createItem();
      const id3 = await createItem();

      try {
        await execAsync(
          `tsx ${cliPath} --json update ${id1} ${id2} TEST-MISSING ${id3} -t "Mostly ok"`
        );
        expect.fail('Should have exited with non-zero');
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        const result = JSON.parse(output);

        expect(result.success).toBe(false);
        expect(result.results).toHaveLength(4);
        // 3 succeed, 1 fails -- still non-zero
        const successes = result.results.filter((r: any) => r.success);
        const failures = result.results.filter((r: any) => !r.success);
        expect(successes).toHaveLength(3);
        expect(failures).toHaveLength(1);
      }
    });
  });

  // =======================================================================
  // Invalid ids are reported per-id
  // =======================================================================
  describe('invalid id reporting', () => {
    it('should include the specific invalid id in the error result', async () => {
      const specificFakeId = 'TEST-UNIQUE42';

      try {
        await execAsync(
          `tsx ${cliPath} --json update ${specificFakeId} -t "Nope"`
        );
        expect.fail('Should have exited with non-zero');
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        const result = JSON.parse(output);

        expect(result.success).toBe(false);
        expect(result.id).toBe(specificFakeId);
        expect(result.error).toContain('not found');
        expect(result.error).toContain(specificFakeId);
      }
    });

    it('should report each invalid id separately in batch mode', async () => {
      const fakeA = 'TEST-FAKEA';
      const fakeB = 'TEST-FAKEB';
      const fakeC = 'TEST-FAKEC';

      try {
        await execAsync(
          `tsx ${cliPath} --json update ${fakeA} ${fakeB} ${fakeC} -t "All bad"`
        );
        expect.fail('Should have exited with non-zero');
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        const result = JSON.parse(output);

        expect(result.success).toBe(false);
        expect(result.results).toHaveLength(3);

        expect(result.results[0].id).toBe(fakeA);
        expect(result.results[0].success).toBe(false);
        expect(result.results[0].error).toContain(fakeA);

        expect(result.results[1].id).toBe(fakeB);
        expect(result.results[1].success).toBe(false);
        expect(result.results[1].error).toContain(fakeB);

        expect(result.results[2].id).toBe(fakeC);
        expect(result.results[2].success).toBe(false);
        expect(result.results[2].error).toContain(fakeC);
      }
    });

    it('should distinguish invalid ids from valid ids in mixed batch', async () => {
      const validId = await createItem();
      const fakeId = 'TEST-PHANTOM';

      try {
        await execAsync(
          `tsx ${cliPath} --json update ${validId} ${fakeId} -t "Mixed"`
        );
        expect.fail('Should have exited with non-zero');
      } catch (error: any) {
        const output = error.stdout || error.stderr || '';
        const result = JSON.parse(output);

        expect(result.success).toBe(false);
        expect(result.results).toHaveLength(2);

        // Valid id has workItem, no error
        expect(result.results[0].id).toBe(validId);
        expect(result.results[0].success).toBe(true);
        expect(result.results[0].workItem).toBeDefined();
        expect(result.results[0].error).toBeUndefined();

        // Invalid id has error, no workItem
        expect(result.results[1].id).toBe(fakeId);
        expect(result.results[1].success).toBe(false);
        expect(result.results[1].error).toBeDefined();
        expect(result.results[1].workItem).toBeUndefined();
      }
    });
  });

  // =======================================================================
  // Human-mode (non-JSON) output
  // =======================================================================
  describe('human-mode output', () => {
    it('should print success messages for valid batch updates', async () => {
      const id1 = await createItem();
      const id2 = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} update ${id1} ${id2} -t "Human batch"`
      );

      // Human mode should contain "Updated work item" text
      expect(stdout).toContain('Updated work item');
    });

    it('should print error messages for invalid ids in human mode', async () => {
      try {
        await execAsync(
          `tsx ${cliPath} update TEST-GHOST -t "Ghost"`
        );
        expect.fail('Should have exited with non-zero');
      } catch (error: any) {
        const output = (error.stdout || '') + (error.stderr || '');
        expect(output).toContain('not found');
      }
    });
  });

  // =======================================================================
  // Edge cases
  // =======================================================================
  describe('edge cases', () => {
    it('should handle update with do-not-delegate across multiple ids', async () => {
      const id1 = await createItem();
      const id2 = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} --do-not-delegate true`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      for (const r of result.results) {
        expect(r.success).toBe(true);
        expect(r.workItem.tags).toContain('do-not-delegate');
      }
    });

    it('should handle removing do-not-delegate across multiple ids', async () => {
      const id1 = await createItem('--tags "do-not-delegate"');
      const id2 = await createItem('--tags "do-not-delegate"');

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} --do-not-delegate false`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      for (const r of result.results) {
        expect(r.success).toBe(true);
        expect(r.workItem.tags).not.toContain('do-not-delegate');
      }
    });

    it('should handle batch update with issue-type flag', async () => {
      const id1 = await createItem();
      const id2 = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} --issue-type bug`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      for (const r of result.results) {
        expect(r.success).toBe(true);
        expect(r.workItem.issueType).toBe('bug');
      }
    });

    it('should handle batch update with risk and effort flags', async () => {
      const id1 = await createItem();
      const id2 = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} --risk High --effort M`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      for (const r of result.results) {
        expect(r.success).toBe(true);
        expect(r.workItem.risk).toBe('High');
        expect(r.workItem.effort).toBe('M');
      }
    });

    it('should handle batch update with needs-producer-review flag', async () => {
      const id1 = await createItem();
      const id2 = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} --needs-producer-review true`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      for (const r of result.results) {
        expect(r.success).toBe(true);
        expect(r.workItem.needsProducerReview).toBe(true);
      }
    });

    it('should handle update with compatible status and stage across batch', async () => {
      const id1 = await createItem();
      const id2 = await createItem();

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${id1} ${id2} -s in-progress --stage in_progress`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      for (const r of result.results) {
        expect(r.success).toBe(true);
        expect(r.workItem.status).toBe('in-progress');
        expect(r.workItem.stage).toBe('in_progress');
      }
    });
  });
});
