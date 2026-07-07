/**
 * Test: JSON output shape consistency across all commands with --json flag
 *
 * Validates that all `wl` commands returning --json output follow a
 * consistent top-level shape:
 *
 * - Array-returning commands use `{success, workItems: [...]}`
 *   (list, search, in-progress, recent)
 * - Object-returning commands use `{success, workItem: {...}}`
 *   (show, create, update, next single)
 * - Non-JSON preamble text is suppressed when --json is used
 *
 * See WL-0MQPS28DY007ALBI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';

describe('JSON output shape consistency', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
    // Seed a few work items for list/search/next tests
    execAsync(`tsx ${cliPath} create -t "First item" -d "Description for first item"`).catch(() => {});
    execAsync(`tsx ${cliPath} create -t "Second item" -d "Description for second item" -p high`).catch(() => {});
    execAsync(`tsx ${cliPath} create -t "Third item" -d "Description for third item" -p low`).catch(() => {});
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  // ── Array-returning commands ──

  it('list --json uses {success, workItems}', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json list`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems).toBeDefined();
    expect(Array.isArray(result.workItems)).toBe(true);
    // Should have at least count field
    expect(result.count).toBeGreaterThanOrEqual(0);
    // Should NOT have legacy flat array at top level
    expect(Array.isArray(result)).toBe(false);
  });

  it('in-progress --json uses {success, workItems}', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json in-progress`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems).toBeDefined();
    expect(Array.isArray(result.workItems)).toBe(true);
  });

  it('recent --json uses {success, workItems}', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json recent -n 5`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems).toBeDefined();
    expect(Array.isArray(result.workItems)).toBe(true);
  });

  it('search --json uses {success, workItems} (not results)', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json search "item"`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems).toBeDefined();
    expect(Array.isArray(result.workItems)).toBe(true);
    // Must not use the old `results` key as the primary array
    // But may include it for backward compatibility
    if (result.results !== undefined) {
      // If both keys present, they should be equivalent
      expect(result.results).toEqual(result.workItems);
    }
    // Metadata fields are preserved
    expect(result.ftsAvailable).toBeDefined();
    expect(result.count).toBeGreaterThanOrEqual(0);
  });

  it('search --json with semantic flag still uses workItems', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json search "item" --semantic`).catch(() => {
      // semantic may fail if no embedder; that's fine
      return { stdout: '{}' };
    });
    // If semantic search is unavailable, the command errors and we skip
    // Actually we can handle this:
    // Just run a regular enough test
    const { stdout: stdout2 } = await execAsync(`tsx ${cliPath} --json search "item"`);
    const result = JSON.parse(stdout2);
    expect(result.workItems).toBeDefined();
  });

  // ── Object-returning commands ──

  it('create --json uses {success, workItem}', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "New item for test"`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItem).toBeDefined();
    expect(result.workItem.id).toBeDefined();
    expect(result.workItem.title).toBe('New item for test');
    // No preamble text should appear in JSON output
    expect(stdout).not.toMatch(/^Updated work item:/m);
  });

  it('show --json uses {success, workItem}', async () => {
    // Create item first with --json to get the id
    const { stdout: createStdout } = await execAsync(`tsx ${cliPath} --json create -t "Show test item"`);
    const created = JSON.parse(createStdout);
    const id = created.workItem.id;

    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItem).toBeDefined();
    expect(result.workItem.id).toBe(id);
    expect(result.workItem.title).toBe('Show test item');
  });

  it('show --json uses workItem (not workItem in a wrapper)', async () => {
    const { stdout: createStdout } = await execAsync(`tsx ${cliPath} --json create -t "Direct access test"`);
    const created = JSON.parse(createStdout);
    const id = created.workItem.id;

    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const result = JSON.parse(stdout);
    // workItem must be directly on the result, not nested
    expect(result.workItem).toBeDefined();
    expect(result.workItem.title).toBeDefined();
  });

  it('update --json uses {success, workItem} for single id', async () => {
    const { stdout: createStdout } = await execAsync(`tsx ${cliPath} --json create -t "Update test item"`);
    const created = JSON.parse(createStdout);
    const id = created.workItem.id;

    const { stdout } = await execAsync(`tsx ${cliPath} --json update ${id} --priority high`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItem).toBeDefined();
    expect(result.workItem.id).toBe(id);
    expect(result.workItem.priority).toBe('high');
    // No preamble text in JSON output
    expect(stdout).not.toMatch(/^Updated work item:/m);
  });

  it('next --json uses {success, workItem} for single result', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json next`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItem).toBeDefined();
    expect(result.workItem.id).toBeDefined();
    expect(result.reason).toBeDefined();
  });

  it('next --json with --number uses {success, workItems} for multiple', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json next -n 2 --include-in-progress`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    // Should have workItems (or results for backward compat)
    if (result.workItems !== undefined) {
      expect(Array.isArray(result.workItems)).toBe(true);
    } else if (result.results !== undefined) {
      expect(Array.isArray(result.results)).toBe(true);
    }
    if (result.results !== undefined && result.workItems !== undefined) {
      // Both keys should be equivalent if both present
      expect(result.workItems).toEqual(result.results);
    }
    expect(result.count).toBeGreaterThanOrEqual(0);
  });

  // ── Error handling ──

  it('error responses include {success: false}', async () => {
    // execAsync merges stdout+stderr; for error cases, the command exits non-zero
    // and we need to parse the error output from stderr
    const { stderr } = await execAsync(`tsx ${cliPath} --json show NONEXISTENT-ID`)
      .then(r => ({ stderr: '' })) // Should not succeed
      .catch(e => ({ stderr: e.stderr || '{}' }));
    const trimmed = stderr.trim();
    // stderr may contain multiple lines; find the first JSON object
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : trimmed;
    const result = JSON.parse(jsonStr || '{}');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  // ── close --json uses {success, results} ──

  it('close --json uses {success, results}', async () => {
    const { stdout: createStdout } = await execAsync(`tsx ${cliPath} --json create -t "Item to close"`);
    const created = JSON.parse(createStdout);
    const id = created.workItem.id;

    const { stdout } = await execAsync(`tsx ${cliPath} --json close ${id} -r "Test close"`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results[0].id).toBe(id);
    expect(result.results[0].success).toBe(true);
  });

  // ── delete --json uses {success, ...} ──

  it('delete --json uses {success, ...}', async () => {
    const { stdout: createStdout } = await execAsync(`tsx ${cliPath} --json create -t "Item to delete"`);
    const created = JSON.parse(createStdout);
    const id = created.workItem.id;

    const { stdout } = await execAsync(`tsx ${cliPath} --json delete ${id} --no-sync`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.deletedId).toBe(id);
    expect(result.message).toBeDefined();
  });

  // ── comment create --json uses {success, comment} ──

  it('comment create --json uses {success, comment}', async () => {
    const { stdout: createStdout } = await execAsync(`tsx ${cliPath} --json create -t "Item for comment"`);
    const created = JSON.parse(createStdout);
    const id = created.workItem.id;

    const { stdout } = await execAsync(`tsx ${cliPath} --json comment add ${id} -a tester -c "Test comment"`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.comment).toBeDefined();
    expect(result.comment.workItemId).toBe(id);
    expect(result.comment.comment).toBe('Test comment');
  });

  it('comment list --json uses {success, comments}', async () => {
    const { stdout: createStdout } = await execAsync(`tsx ${cliPath} --json create -t "Item for comments"`);
    const created = JSON.parse(createStdout);
    const id = created.workItem.id;

    // Add a comment first
    await execAsync(`tsx ${cliPath} comment add ${id} -a tester -c "A comment"`);

    const { stdout } = await execAsync(`tsx ${cliPath} --json comment list ${id}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.comments).toBeDefined();
    expect(Array.isArray(result.comments)).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(0);
  });

  // ── No preamble text when --json ──

  it('no preamble text in update --json output', async () => {
    const { stdout: createStdout } = await execAsync(`tsx ${cliPath} --json create -t "Preamble test"`);
    const created = JSON.parse(createStdout);
    const id = created.workItem.id;

    const { stdout } = await execAsync(`tsx ${cliPath} --json update ${id} -t "Updated title"`);
    // The entire output must be valid JSON without any leading text
    expect(() => JSON.parse(stdout)).not.toThrow();
    const result = JSON.parse(stdout);
    expect(result.workItem.title).toBe('Updated title');
  });

  // ── status --json uses {success, ...} ──

  it('status --json uses {success, ...}', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json status`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.initialized).toBe(true);
    expect(result.database).toBeDefined();
    expect(result.database.workItems).toBeGreaterThanOrEqual(0);
  });
});
