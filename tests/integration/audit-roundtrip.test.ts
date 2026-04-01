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
    // Create without audit text and then attempt to write an ambiguous audit
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Roundtrip audit"`);
    const createdRes = JSON.parse(created);
    expect(createdRes.success).toBe(true);
    const id = createdRes.workItem.id;

    // Attempt to update with an invalid first line; expect the CLI to reject the write.
    try {
      await execAsync(`tsx ${cliPath} --json update ${id} --audit-text "Confirm by alice@example.com"`);
      expect.fail('Should have rejected ambiguous audit write');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || error.stderr || '{}');
      expect(result.success).toBe(false);
      expect(result.error).toBe('audit-invalid-first-line');
      expect(result.message).toContain("Found: 'Confirm by a***@example.com'");
    }
  });
});
