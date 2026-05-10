import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';
import * as fs from 'fs';

describe('update with --audit-file', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('should read audit from file and not execute shell metacharacters', async () => {
    const createOut = await execAsync(`tsx ${cliPath} --json create -t "To update"`);
    const created = JSON.parse(createOut.stdout);
    const id = created.workItem.id;

    const auditPath = './audit.txt';
    const exploitedPath = './exploited_file';
    const auditContent = `Ready to close: No\nThis line contains shell-sensitive chars: \`$(touch ${exploitedPath})\` and $(touch ${exploitedPath}) and ; echo hi`;
    fs.writeFileSync(auditPath, auditContent, 'utf8');

    const { stdout } = await execAsync(`tsx ${cliPath} --json update ${id} --audit-file ${auditPath}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);

    // Query the item to ensure audit persisted
    const showOut = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shown = JSON.parse(showOut.stdout);
    expect(shown.success).toBe(true);
    expect(shown.workItem.audit).toBeTruthy();
    expect(shown.workItem.audit.text).toBe(auditContent);

    // Ensure the dangerous sequence in the file was not executed by the CLI
    expect(fs.existsSync(exploitedPath)).toBe(false);
  });
});
