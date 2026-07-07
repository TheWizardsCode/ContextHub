/**
 * Test: wl list --json includes childCount field
 *
 * When hierarchical navigation fetches children via `wl list --parent <id>`,
 * the JSON output must include a `childCount` field for each work item so
 * that the TUI can render child-count indicators (e.g. "(2)") without an
 * extra round-trip per item.
 *
 * The enrichment follows the same O(n) pattern used by `wl next` via
 * `db.getChildCounts()`.
 *
 * See WL-0MQK8EBNT002XMR7.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, cliPath } from './cli-helpers.js';

describe('wl list --json childCount', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('includes childCount for all items in wl list --json output', async () => {
    // Seed a parent with two children and one standalone item
    seedWorkItems(state.tempDir, [
      { id: 'TEST-1', title: 'Parent item' },
      { id: 'TEST-2', title: 'Child one', parentId: 'TEST-1' },
      { id: 'TEST-3', title: 'Child two', parentId: 'TEST-1' },
      { id: 'TEST-4', title: 'Standalone item' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} list --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems).toBeDefined();
    expect(Array.isArray(result.workItems)).toBe(true);

    // Find items by id
    const parentItem = result.workItems.find((wi: any) => wi.id === 'TEST-1');
    const childOne = result.workItems.find((wi: any) => wi.id === 'TEST-2');
    const childTwo = result.workItems.find((wi: any) => wi.id === 'TEST-3');
    const standalone = result.workItems.find((wi: any) => wi.id === 'TEST-4');

    // Every item should have a childCount field (additive, backwards-compatible)
    expect(parentItem).toHaveProperty('childCount');
    expect(childOne).toHaveProperty('childCount');
    expect(childTwo).toHaveProperty('childCount');
    expect(standalone).toHaveProperty('childCount');

    // Parent has 2 direct children
    expect(parentItem.childCount).toBe(2);
    // Children and standalone have no children themselves
    expect(childOne.childCount).toBe(0);
    expect(childTwo.childCount).toBe(0);
    expect(standalone.childCount).toBe(0);
  });

  it('includes childCount when using wl list --parent <id> --json', async () => {
    // Seed two parents, each with children
    seedWorkItems(state.tempDir, [
      { id: 'TEST-1', title: 'Parent A' },
      { id: 'TEST-2', title: 'Parent B' },
      { id: 'TEST-3', title: 'Child of A', parentId: 'TEST-1' },
      { id: 'TEST-4', title: 'Another child of A', parentId: 'TEST-1' },
      { id: 'TEST-5', title: 'Child of B', parentId: 'TEST-2' },
    ]);

    // List items under Parent A
    const { stdout } = await execAsync(`tsx ${cliPath} list --parent TEST-1 --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems.length).toBe(2);

    for (const item of result.workItems) {
      expect(item).toHaveProperty('childCount');
      // Children of A have no children themselves
      expect(item.childCount).toBe(0);
    }
  });

  it('reports childCount as 0 for items with no children', async () => {
    seedWorkItems(state.tempDir, [
      { id: 'TEST-1', title: 'Alone item' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} list --json`);
    const result = JSON.parse(stdout);
    expect(result.workItems[0].childCount).toBe(0);
  });

  it('does not break human (non-JSON) output format', async () => {
    seedWorkItems(state.tempDir, [
      { id: 'TEST-1', title: 'Parent' },
      { id: 'TEST-2', title: 'Child', parentId: 'TEST-1' },
    ]);

    // Human output should still work (no crash, non-empty)
    const { stdout } = await execAsync(`tsx ${cliPath} list`);
    expect(stdout).toContain('Parent');
    expect(stdout).toContain('Child');
  });
});
