/**
 * Test: wl list --root-only
 *
 * The `--root-only` flag returns only work items with no parent (parentId
 * null). Default `wl list` behavior (flat list including children) is
 * unchanged, and combining `--parent` with `--root-only` is rejected with
 * a clear error (mutually exclusive).
 *
 * See WL-0MS964SIA0057ABR.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, seedWorkItems, cliPath } from './cli-helpers.js';

describe('wl list --root-only', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('returns only root items (parentId null) with --root-only', async () => {
    seedWorkItems(state.tempDir, [
      { id: 'TEST-1', title: 'Root epic' },
      { id: 'TEST-2', title: 'Child one', parentId: 'TEST-1' },
      { id: 'TEST-3', title: 'Child two', parentId: 'TEST-1' },
      { id: 'TEST-4', title: 'Standalone root' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} list --root-only --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.workItems).toBeDefined();
    const ids = result.workItems.map((wi: any) => wi.id);
    expect(ids).toContain('TEST-1');
    expect(ids).toContain('TEST-4');
    expect(ids).not.toContain('TEST-2');
    expect(ids).not.toContain('TEST-3');
    // Every returned item has no parent
    for (const wi of result.workItems) {
      expect(wi.parentId).toBeNull();
    }
  });

  it('keeps default flat list behavior unchanged (children included)', async () => {
    seedWorkItems(state.tempDir, [
      { id: 'TEST-1', title: 'Root epic' },
      { id: 'TEST-2', title: 'Child one', parentId: 'TEST-1' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} list --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    const ids = result.workItems.map((wi: any) => wi.id);
    expect(ids).toContain('TEST-1');
    expect(ids).toContain('TEST-2');
  });

  it('combines --root-only with other filters (status, priority, stage)', async () => {
    seedWorkItems(state.tempDir, [
      { id: 'TEST-1', title: 'Root critical', priority: 'critical', status: 'open' },
      { id: 'TEST-2', title: 'Child critical', priority: 'critical', status: 'open', parentId: 'TEST-1' },
      { id: 'TEST-3', title: 'Root high', priority: 'high', status: 'open' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} list --root-only --priority critical --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    const ids = result.workItems.map((wi: any) => wi.id);
    expect(ids).toEqual(['TEST-1']);
  });

  it('rejects combining --parent with --root-only with a clear error', async () => {
    seedWorkItems(state.tempDir, [
      { id: 'TEST-1', title: 'Root epic' },
      { id: 'TEST-2', title: 'Child one', parentId: 'TEST-1' },
    ]);

    const { stderr, code } = await execAsync(`tsx ${cliPath} list --parent TEST-1 --root-only --json`)
      .then((r: any) => ({ stderr: '', code: 0 }))
      .catch((e: any) => ({ stderr: e.stderr || '', code: e.code }));
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/mutually exclusive|--root-only.*--parent|--parent.*--root-only/i);
  });

  it('drill-down via --parent still returns children (unchanged)', async () => {
    seedWorkItems(state.tempDir, [
      { id: 'TEST-1', title: 'Root epic' },
      { id: 'TEST-2', title: 'Child one', parentId: 'TEST-1' },
      { id: 'TEST-3', title: 'Child two', parentId: 'TEST-1' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} list --parent TEST-1 --json`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    const ids = result.workItems.map((wi: any) => wi.id);
    expect(ids).toContain('TEST-2');
    expect(ids).toContain('TEST-3');
  });
});
