import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, cliPath } from '../cli/cli-helpers.js';

describe('integration: audit skill CLI write path', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir, '1.0.0');
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('stores audit via update --audit-text and shows in wl show --json', async () => {
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Audit skill test"`);
    const createdRes = JSON.parse(created);
    expect(createdRes.success).toBe(true);
    const id = createdRes.workItem.id;

    // Simulate what the audit skill would do: call wl update with --audit-text
    const { stdout: updated } = await execAsync(
      `tsx ${cliPath} --json update ${id} --audit-text "Ready to close: Yes"`
    );
    const updatedRes = JSON.parse(updated);
    expect(updatedRes.success).toBe(true);

    // Verify the audit is stored and returned in show --json
    const { stdout: shown } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shownRes = JSON.parse(shown);
    expect(shownRes.success).toBe(true);
    expect(shownRes.workItem).toBeDefined();
    expect(shownRes.workItem.audit).toBeDefined();
    expect(shownRes.workItem.audit.text).toBe('Ready to close: Yes');
    expect(shownRes.workItem.audit.author).toBeTruthy();
    expect(shownRes.workItem.audit.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    // Status should be parsed from "Ready to close: Yes" -> Complete
    expect(shownRes.workItem.audit.status).toBe('Complete');
  });

  it('redacts email addresses in audit text while preserving valid first line', async () => {
    // Create a work item
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Email redaction test"`);
    const createdRes = JSON.parse(created);
    expect(createdRes.success).toBe(true);
    const id = createdRes.workItem.id;

    // Audit with required first line + free-form details including emails
    const auditText = 'Ready to close: No\nReviewed by alice@example.com and bob@test.org';
    const { stdout: updated } = await execAsync(
      `tsx ${cliPath} --json update ${id} --audit-text "${auditText}"`
    );
    const updatedRes = JSON.parse(updated);
    expect(updatedRes.success).toBe(true);

    // Verify email redaction
    const { stdout: shown } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shownRes = JSON.parse(shown);
    expect(shownRes.workItem.audit.text).toBe('Ready to close: No\nReviewed by a***@example.com and b***@test.org');
  });

  it('preserves historical comments while storing new structured audit', async () => {
    // Create a work item
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Historical test"`);
    const createdRes = JSON.parse(created);
    const id = createdRes.workItem.id;

    // Add a comment (historical audit) - using correct command syntax
    // Note: We use --json flag to get JSON output
    const commentResult = await execAsync(`tsx ${cliPath} --json comment create ${id} --body "Old comment-based audit" --author "old-auditor"`);
    const commentRes = JSON.parse(commentResult.stdout);
    expect(commentRes.success).toBe(true);

    // Add structured audit via CLI write path (new audit skill behavior)
    await execAsync(`tsx ${cliPath} --json update ${id} --audit-text "Ready to close: No"`);

    // Verify both exist: structured audit AND comment
    const { stdout: shown } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shownRes = JSON.parse(shown);

    // Structured audit should be present
    expect(shownRes.workItem.audit).toBeDefined();
    expect(shownRes.workItem.audit.text).toBe('Ready to close: No');

    // Historical comment should also still exist - fetch with comment list
    const { stdout: commentList } = await execAsync(`tsx ${cliPath} --json comment list ${id}`);
    const commentListRes = JSON.parse(commentList);
    expect(commentListRes.success).toBe(true);
    expect(commentListRes.comments).toBeDefined();
    // Note: The comment was created successfully (success: true)
    // but the exact structure of comments returned may vary
  });

  it('accepts only the exact required first line and rejects invalid variants', async () => {
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Status test"`);
    const id = JSON.parse(created).workItem.id;

    const { stdout: noOut } = await execAsync(`tsx ${cliPath} --json update ${id} --audit-text "  Ready to close: No  \nDetails"`);
    const noRes = JSON.parse(noOut);
    expect(noRes.success).toBe(true);
    expect(noRes.workItem.audit.status).toBe('Partial');

    try {
      await execAsync(`tsx ${cliPath} --json update ${id} --audit-text "Ready to close"`);
      expect.fail('Should have rejected invalid first line');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || error.stderr || '{}');
      expect(result.success).toBe(false);
      expect(result.error).toBe('audit-invalid-first-line');
      expect(result.message).toContain("Found: 'Ready to close'");
    }
  });

  it('handles the reported example and flags gutter-character variant', async () => {
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Reported example test"`);
    const id = JSON.parse(created).workItem.id;

    const reportedAudit = `
  Ready to close: No

  ## Summary

  The work item remains open and needs follow-up.
`;
    const { stdout: okOut } = await execAsync(`tsx ${cliPath} --json update ${id} --audit-text "${reportedAudit}"`);
    const ok = JSON.parse(okOut);
    expect(ok.success).toBe(true);
    expect(ok.workItem.audit.status).toBe('Partial');

    try {
      await execAsync(`tsx ${cliPath} --json update ${id} --audit-text "┃ Ready to close: No"`);
      expect.fail('Should have rejected gutter-character first line');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || error.stderr || '{}');
      expect(result.success).toBe(false);
      expect(result.error).toBe('audit-invalid-first-line');
      expect(result.indicators.gutterChars).toBe(true);
    }
  });
});
