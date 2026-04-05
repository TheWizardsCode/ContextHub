import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { cliPath, execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore } from './cli-helpers.js';

describe('wl audit command', () => {
  let tempState: { tempDir: string; originalCwd: string };
  let mockBin: string;
  let opencodeLogPath: string;
  let targetId: string;

  beforeEach(async () => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
    const created = await execAsync(`tsx ${cliPath} --json create -t "Audit target"`);
    const createdPayload = JSON.parse(created.stdout);
    targetId = createdPayload?.workItem?.id as string;
    if (!targetId) throw new Error('Failed to create work item for audit test');

    mockBin = path.join(tempState.tempDir, 'mock-bin');
    opencodeLogPath = path.join(tempState.tempDir, 'opencode-invocations.log');
    fs.mkdirSync(mockBin, { recursive: true });
    fs.writeFileSync(
      path.join(mockBin, 'opencode'),
      [
        '#!/usr/bin/env node',
        'const fs = require("fs");',
        'const args = process.argv.slice(2).join(" ");',
        'const logPath = process.env.WL_TEST_OPENCODE_LOG_PATH || "";',
        'if (logPath) fs.appendFileSync(logPath, `${args}\\n`, "utf-8");',
        'console.log(JSON.stringify({ type: "text", part: { type: "text", messageID: "m1", text: "Audit text from mock" } }));',
        'console.log(JSON.stringify({ type: "input.request", input: { type: "text" } }));',
      ].join('\n'),
      'utf-8'
    );
    fs.chmodSync(path.join(mockBin, 'opencode'), 0o755);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    leaveTempDir(tempState);
  });

  it('prints audit completion message and text in human mode', async () => {
    const { stdout } = await execAsync(
      `PATH="${mockBin}:$PATH" WL_TEST_OPENCODE_LOG_PATH="${opencodeLogPath}" WL_OPENCODE_BIN="opencode" tsx ${cliPath} audit ${targetId}`
    );
    expect(stdout).toContain('Audit complete:');
    expect(stdout).toContain('Audit text from mock');

    const invocations = fs.readFileSync(opencodeLogPath, 'utf-8');
    expect(invocations).toContain(`run --format json audit ${targetId}`);
  });

  it('returns JSON in --json mode', async () => {
    const { stdout } = await execAsync(
      `PATH="${mockBin}:$PATH" WL_TEST_OPENCODE_LOG_PATH="${opencodeLogPath}" WL_OPENCODE_BIN="opencode" tsx ${cliPath} --json audit ${targetId}`
    );
    const payload = JSON.parse(stdout);
    expect(payload.success).toBe(true);
    expect(payload.workItemId).toBe(targetId);
    expect(payload.auditText).toBe('Audit text from mock');
  });

  it('fails when id is missing', async () => {
    await expect(execAsync(`tsx ${cliPath} audit`)).rejects.toBeTruthy();
  });
});
