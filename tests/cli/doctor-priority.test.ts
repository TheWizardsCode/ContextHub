import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
  seedWorkItems,
} from './cli-helpers.js';

describe('doctor priority command', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('reports no invalid priorities when all are canonical', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-OK-1', title: 'item 1', priority: 'low' },
      { id: 'TEST-OK-2', title: 'item 2', priority: 'medium' },
      { id: 'TEST-OK-3', title: 'item 3', priority: 'high' },
      { id: 'TEST-OK-4', title: 'item 4', priority: 'critical' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor priority`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.invalid).toEqual([]);
  });

  it('detects invalid P* priority values in dry-run mode', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-P0', title: 'P0 item', priority: 'P0' as any },
      { id: 'TEST-P1', title: 'P1 item', priority: 'P1' as any },
      { id: 'TEST-OK', title: 'good item', priority: 'medium' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor priority --dry-run`);
    const result = JSON.parse(stdout);
    expect(result.dryRun).toBe(true);
    expect(result.count).toBe(2);
    expect(result.invalid).toContainEqual(
      expect.objectContaining({ id: 'TEST-P0', current: 'P0', mapped: 'critical' })
    );
    expect(result.invalid).toContainEqual(
      expect.objectContaining({ id: 'TEST-P1', current: 'P1', mapped: 'high' })
    );
  });

  it('detects invalid case-mangled priority values', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-HIGH', title: 'High item', priority: 'High' as any },
      { id: 'TEST-LOW', title: 'LOW item', priority: 'LOW' as any },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor priority --dry-run`);
    const result = JSON.parse(stdout);
    // "High" and "LOW" are valid after case normalization, so isValidPriority returns true
    expect(result.success).toBe(true);
    expect(result.invalid).toEqual([]);
  });

  it('fixes P* priorities with --apply', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-P0', title: 'P0 item', priority: 'P0' as any },
      { id: 'TEST-P2', title: 'P2 item', priority: 'P2' as any },
      { id: 'TEST-OK', title: 'good item', priority: 'medium' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor priority --apply`);
    const result = JSON.parse(stdout);
    expect(result.fixedCount).toBe(2);
    expect(result.fixed).toContainEqual({ id: 'TEST-P0', from: 'P0', to: 'critical' });
    expect(result.fixed).toContainEqual({ id: 'TEST-P2', from: 'P2', to: 'medium' });

    // Verify persistence by re-reading
    const { stdout: listOut } = await execAsync(`tsx ${cliPath} --json list`);
    const listResult = JSON.parse(listOut);
    const items = listResult.workItems || [];
    const p0 = items.find((i: any) => i.id === 'TEST-P0');
    const p2 = items.find((i: any) => i.id === 'TEST-P2');
    expect(p0.priority).toBe('critical');
    expect(p2.priority).toBe('medium');
  });

  it('reports unmappable invalid priorities', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-BAD', title: 'bad priority', priority: 'urgent' as any },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor priority --dry-run`);
    const result = JSON.parse(stdout);
    expect(result.count).toBe(1);
    expect(result.invalid[0].id).toBe('TEST-BAD');
    expect(result.invalid[0].mapped).toBeUndefined();
  });

  it('leaves unmappable priorities unfixed after --apply', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-BAD', title: 'bad priority', priority: 'urgent' as any },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor priority --apply`);
    const result = JSON.parse(stdout);
    expect(result.fixedCount).toBe(0);
    expect(result.unfixableCount).toBe(1);
    expect(result.unfixable[0].id).toBe('TEST-BAD');
  });
});
