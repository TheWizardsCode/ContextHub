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
    // Create with audit using CLI create (which uses buildAuditEntry and redacts before persist)
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Roundtrip audit" --audit-text "Confirm by alice@example.com"`);
    const createdRes = JSON.parse(created);
    expect(createdRes.success).toBe(true);
    const id = createdRes.workItem.id;

    // show --json should include audit object
    const { stdout: shown } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shownRes = JSON.parse(shown);
    expect(shownRes.success).toBe(true);
    expect(shownRes.workItem).toBeDefined();
    expect(shownRes.workItem.audit).toBeDefined();
    // Audit text should be redacted by buildAuditEntry before persistence
    // redactAuditText replaces local part with firstChar + '***' and keeps domain
    expect(shownRes.workItem.audit.text).toContain('a***@example.com');
    expect(shownRes.workItem.audit.author).toBeTruthy();
    expect(shownRes.workItem.audit.time).toMatch(/Z$/);
    // For freeform first lines without explicit readiness tokens we conservatively
    // set status to 'Missing Criteria'.
    expect(shownRes.workItem.audit.status).toBe('Missing Criteria');

    // Now update the item with a new audit text and verify it overwrote
    const { stdout: updated } = await execAsync(`tsx ${cliPath} --json update ${id} --audit-text "Updated by bob@domain.org"`);
    const updatedRes = JSON.parse(updated);
    expect(updatedRes.success).toBe(true);

    const { stdout: shown2 } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shownRes2 = JSON.parse(shown2);
    expect(shownRes2.success).toBe(true);
    expect(shownRes2.workItem.audit).toBeDefined();
    expect(shownRes2.workItem.audit.text).toContain('b***@domain.org');
    expect(shownRes2.workItem.audit.status).toBe('Missing Criteria');
  });
});
