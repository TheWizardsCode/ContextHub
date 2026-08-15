/**
 * CLI integration tests for the `wl create` dedup guard (WL-0MSTNG2QF0049B97).
 *
 * Retrying an identical `wl create` (common when agents lose the tool result
 * to output trimming) must return the existing item with a `duplicateOf`
 * marker instead of creating a byte-identical twin work item.
 *
 * Work item: WL-0MSU8B7Y0008MRK0
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

describe('wl create dedup guard', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createJson(title = 'Some Title', flags = ''): Promise<any> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "${title}" ${flags}`
    );
    return JSON.parse(stdout);
  }

  async function listJson(): Promise<any> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json list`);
    return JSON.parse(stdout);
  }

  it('returns the existing item with duplicateOf when a recent match exists', async () => {
    const first = await createJson();
    expect(first.success).toBe(true);
    expect(first.duplicateOf).toBeUndefined();

    // Byte-identical retry — must NOT create a twin.
    const second = await createJson();
    expect(second.success).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.duplicateOf).toBe(first.workItem.id);
    expect(second.workItem.id).toBe(first.workItem.id);

    // Only one item exists in the worklog.
    const list = await listJson();
    expect(list.count).toBe(1);
  });

  it('matches case- and whitespace-insensitive title variants', async () => {
    const first = await createJson('Same Title');
    const second = await createJson('same   title');
    expect(second.duplicateOf).toBe(first.workItem.id);
    expect(second.workItem.id).toBe(first.workItem.id);
  });

  it('creates a new item when no recent match exists', async () => {
    const first = await createJson('Some Title');
    const second = await createJson('Unrelated Title');
    expect(second.duplicateOf).toBeUndefined();
    expect(second.workItem.id).not.toBe(first.workItem.id);
  });

  it('does not reuse terminal (completed) items', async () => {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "Done Title" --status completed --stage in_review`
    );
    const first = JSON.parse(stdout);
    const second = await createJson('Done Title');
    expect(second.duplicateOf).toBeUndefined();
    expect(second.workItem.id).not.toBe(first.workItem.id);
  });

  it('--allow-duplicate bypasses the guard and creates a new item', async () => {
    const first = await createJson('Same Title');
    const second = await createJson('Same Title', '--allow-duplicate');
    expect(second.duplicateOf).toBeUndefined();
    expect(second.workItem.id).not.toBe(first.workItem.id);

    const list = await listJson();
    expect(list.count).toBe(2);
  });

  it('--dedup-window 0ms disables matching (item outside window)', async () => {
    const first = await createJson('Same Title');
    const second = await createJson('Same Title', '--dedup-window 0ms');
    expect(second.duplicateOf).toBeUndefined();
    expect(second.workItem.id).not.toBe(first.workItem.id);
  });

  it('--dedup-window 30s accepts a duration string', async () => {
    const first = await createJson('Same Title');
    const second = await createJson('Same Title', '--dedup-window 30s');
    expect(second.duplicateOf).toBe(first.workItem.id);
  });

  it('prints "Duplicate of <id>" in human mode', async () => {
    const first = await createJson('Same Title');
    const { stdout } = await execAsync(`tsx ${cliPath} create -t "Same Title"`);
    expect(stdout).toContain(`Duplicate of ${first.workItem.id}`);
    // The duplicate line still surfaces the item id (robust to trimming).
    expect(stdout).toContain(first.workItem.id);
  });

  it('respects --prefix scope', async () => {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "Prefixed Title" --prefix OTHER`
    );
    const first = JSON.parse(stdout);
    expect(first.workItem.id.startsWith('OTHER-')).toBe(true);

    // Same title under the default TEST prefix is NOT a duplicate.
    const second = await createJson('Prefixed Title');
    expect(second.duplicateOf).toBeUndefined();
    expect(second.workItem.id.startsWith('TEST-')).toBe(true);
  });

  it('rejects an invalid --dedup-window value with a clear error', async () => {
    await expect(
      execAsync(`tsx ${cliPath} --json create -t "Same Title" --dedup-window bogus`)
    ).rejects.toThrow('Command failed');
  });
});
