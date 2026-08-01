/**
 * Tests for `wl update --audit-text` stage preservation.
 *
 * Verifies that calling `wl update --audit-text` on a `completed/in_review`
 * work item does NOT advance the stage to `done`.
 *
 * Work item: SA-0MS6B5ESG0056GZJ — Prevent unintended stage advancement
 * to 'done' outside of ship command.
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

describe('wl update --audit-text stage preservation', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  async function createItem(status = 'open', stage = ''): Promise<string> {
    const flags = [
      status ? `--status ${status}` : '',
      stage ? `--stage ${stage}` : '',
    ].filter(Boolean).join(' ');
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json create -t "Test item" ${flags}`
    );
    return JSON.parse(stdout).workItem.id;
  }

  /**
   * Helper: fetch a work item's details as JSON.
   */
  async function getItem(id: string): Promise<any> {
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json show ${id}`
    );
    return JSON.parse(stdout).workItem;
  }

  // =======================================================================
  // Audit-text on completed/in_review items
  // =======================================================================

  it('should not advance stage when --audit-text is called on a completed/in_review item', async () => {
    // Create item and advance to completed/in_review
    const id = await createItem('completed', 'in_review');

    // Verify initial state
    let item = await getItem(id);
    expect(item.status).toBe('completed');
    expect(item.stage).toBe('in_review');

    // Call wl update --audit-text (the scenario from persist_audit.py)
    const auditText = 'Ready to close: Yes\n\nAudit passed.';
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --audit-text '${auditText}'`
    );
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);

    // Verify stage was NOT changed to 'done'
    item = await getItem(id);
    expect(item.stage).toBe('in_review');
    // Status should also be unchanged
    expect(item.status).toBe('completed');
  });

  it('should not advance stage when --audit-text is called on a completed/in_review item with multi-line report', async () => {
    const id = await createItem('completed', 'in_review');

    const multiLineReport = `Ready to close: Yes

## Summary
All acceptance criteria are met.

## Children Status
No children.

## Acceptance Criteria Status
| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | Criterion A | met | evidence |
| 2 | Criterion B | met | evidence |
`;

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --audit-text '${multiLineReport}'`
    );
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);

    const item = await getItem(id);
    expect(item.stage).toBe('in_review');
    expect(item.status).toBe('completed');
  });

  // =======================================================================
  // Audit-text on items in other stages
  // =======================================================================

  it('should not advance stage when --audit-text is called on an in_progress/in_review item', async () => {
    const id = await createItem('in-progress', 'in_review');

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --audit-text 'Ready to close: No'`
    );
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);

    const item = await getItem(id);
    expect(item.stage).toBe('in_review');
  });

  it('should not change stage when --audit-text is called on an open/idea item', async () => {
    const id = await createItem('open', 'idea');

    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --audit-text 'Ready to close: No'`
    );
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);

    const item = await getItem(id);
    expect(item.stage).toBe('idea');
  });
});
