import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';

describe('show --json audit handling', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('includes structured audit object when audit present and omits when absent', async () => {
    // Create an item with audit
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Audited task" --audit-text "  Ready to close: Yes  "`);
    const createdRes = JSON.parse(created);
    expect(createdRes.success).toBe(true);
    const id = createdRes.workItem.id;

    const { stdout: shown } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shownRes = JSON.parse(shown);
    expect(shownRes.success).toBe(true);
    expect(shownRes.workItem).toBeDefined();
    expect(shownRes.workItem.audit).toBeDefined();
    expect(typeof shownRes.workItem.audit.text).toBe('string');
    expect(shownRes.workItem.audit.text).toBe('  Ready to close: Yes  ');
    expect(shownRes.workItem.audit.status).toBe('Complete');
    expect(shownRes.workItem.audit.author).toBeTruthy();
    expect(shownRes.workItem.audit.time).toMatch(/Z$/);

    // Create an item without audit
    const { stdout: created2 } = await execAsync(`tsx ${cliPath} --json create -t "No audit"`);
    const createdRes2 = JSON.parse(created2);
    expect(createdRes2.success).toBe(true);
    const id2 = createdRes2.workItem.id;

    const { stdout: shown2 } = await execAsync(`tsx ${cliPath} --json show ${id2}`);
    const shownRes2 = JSON.parse(shown2);
    expect(shownRes2.success).toBe(true);
    // When audit is absent, the JSON output must omit the `audit` key entirely.
    expect(shownRes2.workItem.audit).toBeUndefined();
  });
});
