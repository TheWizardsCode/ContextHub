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

describe('doctor stage-sync command', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('reports no stale combinations when all items are valid', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-001', title: 'open item', status: 'open', stage: 'idea' },
      { id: 'TEST-002', title: 'completed item', status: 'completed', stage: 'done' },
      { id: 'TEST-003', title: 'completed review', status: 'completed', stage: 'in_review' },
      { id: 'TEST-004', title: 'in_progress item', status: 'in-progress', stage: 'in_progress' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor stage-sync`);
    const result = JSON.parse(stdout);
    expect(result.dryRun).toBe(true);
    expect(result.totalItems).toBe(4);
    expect(result.staleCount).toBe(0);
    expect(result.staleItems).toEqual([]);
  });

  it('detects completed+idea stale combination in dry-run', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-STALE-1', title: 'stale completed idea', status: 'completed', stage: 'idea' },
      { id: 'TEST-OK', title: 'good item', status: 'completed', stage: 'done' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor stage-sync`);
    const result = JSON.parse(stdout);
    expect(result.dryRun).toBe(true);
    expect(result.staleCount).toBe(1);
    expect(result.staleItems).toContainEqual(
      expect.objectContaining({
        id: 'TEST-STALE-1',
        current: { status: 'completed', stage: 'idea' },
        proposed: { status: 'completed', stage: 'done' },
      })
    );
  });

  it('detects completed+intake_complete stale combination in dry-run', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-STALE-2', title: 'stale completed intake', status: 'completed', stage: 'intake_complete' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor stage-sync`);
    const result = JSON.parse(stdout);
    expect(result.staleCount).toBe(1);
    expect(result.staleItems).toContainEqual(
      expect.objectContaining({
        id: 'TEST-STALE-2',
        current: { status: 'completed', stage: 'intake_complete' },
        proposed: { status: 'completed', stage: 'done' },
      })
    );
  });

  it('detects completed+plan_complete stale combination in dry-run', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-STALE-3', title: 'stale completed plan', status: 'completed', stage: 'plan_complete' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor stage-sync`);
    const result = JSON.parse(stdout);
    expect(result.staleCount).toBe(1);
    expect(result.staleItems).toContainEqual(
      expect.objectContaining({
        id: 'TEST-STALE-3',
        current: { status: 'completed', stage: 'plan_complete' },
        proposed: { status: 'completed', stage: 'done' },
      })
    );
  });

  it('detects in_progress+idea stale combination in dry-run', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-STALE-4', title: 'claimed never processed', status: 'in-progress', stage: 'idea' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor stage-sync`);
    const result = JSON.parse(stdout);
    expect(result.staleCount).toBe(1);
    expect(result.staleItems).toContainEqual(
      expect.objectContaining({
        id: 'TEST-STALE-4',
        current: { status: 'in-progress', stage: 'idea' },
        proposed: { status: 'open', stage: 'idea' },
      })
    );
  });

  it('detects multiple stale combinations in one run', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-S1', title: 'completed+idea', status: 'completed', stage: 'idea' },
      { id: 'TEST-S2', title: 'completed+intake', status: 'completed', stage: 'intake_complete' },
      { id: 'TEST-S3', title: 'in_progress+idea', status: 'in-progress', stage: 'idea' },
      { id: 'TEST-OK', title: 'good item', status: 'completed', stage: 'done' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor stage-sync`);
    const result = JSON.parse(stdout);
    expect(result.staleCount).toBe(3);
    expect(result.totalItems).toBe(4);
    expect(result.staleItems.map((s: any) => s.id).sort()).toEqual(
      ['TEST-S1', 'TEST-S2', 'TEST-S3']
    );
  });

  it('fixes stale items with --fix', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-FIX-1', title: 'completed+idea', status: 'completed', stage: 'idea' },
      { id: 'TEST-FIX-2', title: 'in_progress+idea', status: 'in-progress', stage: 'idea' },
      { id: 'TEST-OK', title: 'good item', status: 'completed', stage: 'done' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor stage-sync --apply`);
    const result = JSON.parse(stdout);
    expect(result.fixApplied).toBe(true);
    expect(result.fixedCount).toBe(2);

    // Verify persistence by re-reading
    const { stdout: listOut } = await execAsync(`tsx ${cliPath} --json list`);
    const listResult = JSON.parse(listOut);
    const items = listResult.workItems || [];
    const f1 = items.find((i: any) => i.id === 'TEST-FIX-1');
    const f2 = items.find((i: any) => i.id === 'TEST-FIX-2');
    expect(f1.status).toBe('completed');
    expect(f1.stage).toBe('done');
    expect(f2.status).toBe('open');
    expect(f2.stage).toBe('idea');
  });

  it('applies all four known stale mappings with --fix', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-M1', title: 'completed+idea', status: 'completed', stage: 'idea' },
      { id: 'TEST-M2', title: 'completed+intake', status: 'completed', stage: 'intake_complete' },
      { id: 'TEST-M3', title: 'completed+plan', status: 'completed', stage: 'plan_complete' },
      { id: 'TEST-M4', title: 'in_progress+idea', status: 'in-progress', stage: 'idea' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} --json doctor stage-sync --apply`);
    const result = JSON.parse(stdout);
    expect(result.fixedCount).toBe(4);

    // Verify all mappings
    const { stdout: listOut } = await execAsync(`tsx ${cliPath} --json list`);
    const listResult = JSON.parse(listOut);
    const items = listResult.workItems || [];

    const m1 = items.find((i: any) => i.id === 'TEST-M1');
    const m2 = items.find((i: any) => i.id === 'TEST-M2');
    const m3 = items.find((i: any) => i.id === 'TEST-M3');
    const m4 = items.find((i: any) => i.id === 'TEST-M4');

    expect(m1.status).toBe('completed');
    expect(m1.stage).toBe('done');
    expect(m2.status).toBe('completed');
    expect(m2.stage).toBe('done');
    expect(m3.status).toBe('completed');
    expect(m3.stage).toBe('done');
    expect(m4.status).toBe('open');
    expect(m4.stage).toBe('idea');
  });

  it('reports summary counts in human-readable mode', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-H1', title: 'stale 1', status: 'completed', stage: 'idea' },
      { id: 'TEST-H2', title: 'stale 2', status: 'completed', stage: 'intake_complete' },
      { id: 'TEST-H3', title: 'stale 3', status: 'in-progress', stage: 'idea' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} doctor stage-sync`);
    expect(stdout).toContain('3');
    expect(stdout).toContain('stale');
  });

  it('shows each stale item with current and proposed values', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-D1', title: 'demo stale', status: 'completed', stage: 'idea' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} doctor stage-sync`);
    expect(stdout).toContain('TEST-D1');
    expect(stdout).toContain('completed');
    expect(stdout).toContain('idea');
    expect(stdout).toContain('done');
  });

  it('reports zero stale items with summary', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-Z1', title: 'good item', status: 'open', stage: 'idea' },
      { id: 'TEST-Z2', title: 'good item 2', status: 'completed', stage: 'done' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} doctor stage-sync`);
    expect(stdout).toContain('no stale');
  });

  it('--fix summary shows items fixed and skipped', async () => {
    seedWorkItems(tempState.tempDir, [
      { id: 'TEST-FS1', title: 'fixed item', status: 'completed', stage: 'idea' },
      { id: 'TEST-OK', title: 'good item', status: 'completed', stage: 'done' },
    ]);

    const { stdout } = await execAsync(`tsx ${cliPath} doctor stage-sync --apply`);
    expect(stdout).toContain('Fixed 1 item');
  });
});
