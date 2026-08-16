/**
 * CLI integration tests for the `wl create` dedup guard (WL-0MSTNG2QF0049B97).
 *
 * Retrying an identical `wl create` (common when agents lose the tool result
 * to output trimming) must return the existing item with a `duplicateOf`
 * marker instead of creating a byte-identical twin work item.
 *
 * The test cases map 1:1 to the acceptance criteria of feature
 * WL-0MSU89IZG000FHJF (9 CLI integration tests via the temp-dir harness in
 * `cli-helpers.ts`).
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

  // AC1: No match within window → normal create proceeds, new item returned
  it('AC1: creates a new item when no recent title match exists', async () => {
    const first = await createJson('Some Title');
    expect(first.success).toBe(true);
    expect(first.duplicateOf).toBeUndefined();

    const second = await createJson('Unrelated Title');
    expect(second.duplicateOf).toBeUndefined();
    expect(second.workItem.id).not.toBe(first.workItem.id);
  });

  // AC2: Recent match found (exact title) → existing item returned with duplicateOf
  it('AC2: returns the existing item with duplicateOf on exact-title retry', async () => {
    const first = await createJson();
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

  // AC3: Recent match (case-insensitive) → existing item returned with duplicateOf
  it('AC3: matches case-insensitive title variants', async () => {
    const first = await createJson('Same Title');
    const second = await createJson('same title');
    expect(second.duplicateOf).toBe(first.workItem.id);
    expect(second.workItem.id).toBe(first.workItem.id);
  });

  // AC4: Recent match (whitespace-normalized) → existing item returned with duplicateOf
  it('AC4: matches whitespace-normalized title variants', async () => {
    const first = await createJson('Same Title');
    const second = await createJson('Same   Title');
    expect(second.duplicateOf).toBe(first.workItem.id);
    expect(second.workItem.id).toBe(first.workItem.id);
  });

  // AC5: Non-terminal (completed) item → normal create proceeds, new item returned
  it('AC5: does not reuse terminal (completed) items', async () => {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "Done Title" --status completed --stage in_review`
    );
    const first = JSON.parse(stdout);
    const second = await createJson('Done Title');
    expect(second.duplicateOf).toBeUndefined();
    expect(second.workItem.id).not.toBe(first.workItem.id);
  });

  // AC6: --allow-duplicate → bypasses guard, new item created
  it('AC6: --allow-duplicate bypasses the guard and creates a new item', async () => {
    const first = await createJson('Same Title');
    const second = await createJson('Same Title', '--allow-duplicate');
    expect(second.duplicateOf).toBeUndefined();
    expect(second.workItem.id).not.toBe(first.workItem.id);

    const list = await listJson();
    expect(list.count).toBe(2);
  });

  // AC7: --dedup-window 10s with match after 11s → normal create (window expired)
  // Implemented with a 1s window + 1.2s wait — the same expiry code path
  // (createdAt > now - windowMs cutoff in persistent-store.ts) 10x faster.
  it('AC7: does not reuse a match older than --dedup-window (window expiry)', async () => {
    const first = await createJson('Same Title');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const second = await createJson('Same Title', '--dedup-window 1s');
    expect(second.duplicateOf).toBeUndefined();
    expect(second.workItem.id).not.toBe(first.workItem.id);
  });

  // AC8: Prefix-aware matching (items with different prefixes don't match)
  it('AC8: respects --prefix scope', async () => {
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

  // AC9: JSON mode includes duplicateOf; human mode includes "Duplicate of" line
  it('AC9: JSON output carries duplicateOf; human output prints a Duplicate of line', async () => {
    const first = await createJson('Same Title');

    // JSON mode: duplicateOf field present (covered end-to-end here too).
    const retryJson = await createJson('Same Title');
    expect(retryJson.duplicateOf).toBe(first.workItem.id);

    // Human mode: a clear "Duplicate of <id>" line.
    const { stdout } = await execAsync(`tsx ${cliPath} create -t "Same Title"`);
    expect(stdout).toContain(`Duplicate of ${first.workItem.id}`);
  });

  // Bonus (beyond the 9 ACs): invalid --dedup-window values fail loudly
  it('rejects an invalid --dedup-window value with a clear error', async () => {
    await expect(
      execAsync(`tsx ${cliPath} --json create -t "Same Title" --dedup-window bogus`)
    ).rejects.toThrow('Command failed');
  });
});
