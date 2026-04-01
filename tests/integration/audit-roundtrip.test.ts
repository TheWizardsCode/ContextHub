import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, cliPath } from '../cli/cli-helpers.js';

describe('integration: audit write -> read roundtrip', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir, '1.0.0');
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('persists audit via create/update and is returned by show --json', async () => {
    // Create without audit text and then write a freeform audit
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Roundtrip audit"`);
    const createdRes = JSON.parse(created);
    expect(createdRes.success).toBe(true);
    const id = createdRes.workItem.id;

    // Write freeform audit text (email addresses will be redacted)
    const { stdout: updated } = await execAsync(`tsx ${cliPath} --json update ${id} --audit-text "Confirm by alice@example.com"`);
    const updatedRes = JSON.parse(updated);
    expect(updatedRes.success).toBe(true);

    // Verify the audit is persisted and returned by show --json
    const { stdout: shown } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shownRes = JSON.parse(shown);
    expect(shownRes.success).toBe(true);
    expect(shownRes.workItem.audit).toBeDefined();
    // Email should be redacted in the stored text
    expect(shownRes.workItem.audit.text).toBe('Confirm by a***@example.com');
  });
});
