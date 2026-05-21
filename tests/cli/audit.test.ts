import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cliPath, execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore } from './cli-helpers.js';

describe('wl audit command', () => {
  let tempState: { tempDir: string; originalCwd: string };
  let targetId: string;

  beforeEach(async () => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
    const created = await execAsync(`tsx ${cliPath} --json create -t "Audit target"`);
    const createdPayload = JSON.parse(created.stdout);
    targetId = createdPayload?.workItem?.id as string;
    if (!targetId) throw new Error('Failed to create work item for audit test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    leaveTempDir(tempState);
  });

  it('prints audit completion message and text in human mode', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} audit ${targetId}`);
    expect(stdout).toContain('Audit Report for');
    expect(stdout).toContain(targetId);
  });

  it('returns JSON in --json mode', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json audit ${targetId}`);
    const payload = JSON.parse(stdout);
    expect(payload.success).toBe(true);
    expect(payload.workItemId).toBe(targetId);
    // The Pi audit returns the formatted audit text
    expect(payload.auditText).toContain(targetId);
  });

  it('fails when id is missing', async () => {
    await expect(execAsync(`tsx ${cliPath} audit`)).rejects.toBeTruthy();
  });
});
