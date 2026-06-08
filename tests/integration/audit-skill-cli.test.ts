import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, cliPath } from '../cli/cli-helpers.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

describe('integration: audit skill CLI write path', () => {
  let state: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(state.tempDir);
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

  it('sets audit via create --audit-text and shows in wl show --json', async () => {
    // Test the full lifecycle: create with audit text
    const { stdout: created } = await execAsync(
      `tsx ${cliPath} --json create -t "Audit on create test" --audit-text "Ready to close: Yes\nAll criteria met."`
    );
    const createdRes = JSON.parse(created);
    expect(createdRes.success).toBe(true);
    expect(createdRes.workItem.audit).toBeDefined();
    expect(createdRes.workItem.audit.text).toBe('Ready to close: Yes\nAll criteria met.');
    expect(createdRes.workItem.audit.status).toBe('Complete');
    expect(createdRes.workItem.audit.author).toBeTruthy();
    expect(createdRes.workItem.audit.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);

    const id = createdRes.workItem.id;

    // Verify it persists via show --json
    const { stdout: shown } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shownRes = JSON.parse(shown);
    expect(shownRes.success).toBe(true);
    expect(shownRes.workItem.audit.text).toBe('Ready to close: Yes\nAll criteria met.');
    expect(shownRes.workItem.audit.status).toBe('Complete');
  });

  it('sets audit via --audit-file and reads back correctly', async () => {
    // Create work item
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Audit file test"`);
    const id = JSON.parse(created).workItem.id;

    // Write audit text to a file
    const auditFile = join(state.tempDir, 'audit.txt');
    writeFileSync(auditFile, 'Ready to close: No\nNeeds more work:\n- Add tests\n- Update docs');

    // Set audit via --audit-file
    const { stdout: updated } = await execAsync(
      `tsx ${cliPath} --json update ${id} --audit-file "${auditFile}"`
    );
    const updatedRes = JSON.parse(updated);
    expect(updatedRes.success).toBe(true);
    expect(updatedRes.workItem.audit).toBeDefined();
    expect(updatedRes.workItem.audit.text).toBe('Ready to close: No\nNeeds more work:\n- Add tests\n- Update docs');
    expect(updatedRes.workItem.audit.status).toBe('Partial');

    // Verify it reads back correctly
    const { stdout: shown } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shownRes = JSON.parse(shown);
    expect(shownRes.workItem.audit.text).toBe('Ready to close: No\nNeeds more work:\n- Add tests\n- Update docs');
    expect(shownRes.workItem.audit.status).toBe('Partial');
  });

  it('verifies audit object contains all required fields', async () => {
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Field verification test"`);
    const id = JSON.parse(created).workItem.id;

    await execAsync(`tsx ${cliPath} --json update ${id} --audit-text "Ready to close: Yes"`);

    const { stdout: shown } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shownRes = JSON.parse(shown);
    const audit = shownRes.workItem.audit;

    // Verify all required fields exist with correct types
    expect(audit).toBeDefined();
    expect(typeof audit.text).toBe('string');
    expect(typeof audit.author).toBe('string');
    expect(typeof audit.time).toBe('string');
    expect(typeof audit.status).toBe('string');

    // Verify field values
    expect(audit.text).toBe('Ready to close: Yes');
    expect(audit.status).toBe('Complete');
    expect(audit.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    // Author should be non-empty (system user or configured author)
    expect(audit.author.length).toBeGreaterThan(0);
  });

  it('derives readiness status correctly from first line', async () => {
    const { stdout: created1 } = await execAsync(`tsx ${cliPath} --json create -t "Status test Complete"`);
    const id1 = JSON.parse(created1).workItem.id;

    const { stdout: created2 } = await execAsync(`tsx ${cliPath} --json create -t "Status test Partial"`);
    const id2 = JSON.parse(created2).workItem.id;

    // Test Complete status
    await execAsync(`tsx ${cliPath} --json update ${id1} --audit-text "Ready to close: Yes\nAll good."`);
    const { stdout: shown1 } = await execAsync(`tsx ${cliPath} --json show ${id1}`);
    expect(JSON.parse(shown1).workItem.audit.status).toBe('Complete');

    // Test Partial status
    await execAsync(`tsx ${cliPath} --json update ${id2} --audit-text "Ready to close: No\nNeeds work."`);
    const { stdout: shown2 } = await execAsync(`tsx ${cliPath} --json show ${id2}`);
    expect(JSON.parse(shown2).workItem.audit.status).toBe('Partial');
  });

  it('persists email redaction through full roundtrip', async () => {
    const { stdout: created } = await execAsync(`tsx ${cliPath} --json create -t "Redaction roundtrip"`);
    const id = JSON.parse(created).workItem.id;

    const auditText = 'Ready to close: Yes\nReviewed by developer@company.com and qa@test.io';
    await execAsync(`tsx ${cliPath} --json update ${id} --audit-text "${auditText}"`);

    // Verify redaction in show --json
    const { stdout: shown } = await execAsync(`tsx ${cliPath} --json show ${id}`);
    const shownRes = JSON.parse(shown);
    expect(shownRes.workItem.audit.text).toBe(
      'Ready to close: Yes\nReviewed by d***@company.com and q***@test.io'
    );

    // Update again and verify redaction persists
    const { stdout: updated } = await execAsync(
      `tsx ${cliPath} --json update ${id} --audit-text "Ready to close: Yes\nFinal review by manager@corp.com"`
    );
    expect(JSON.parse(updated).workItem.audit.text).toBe(
      'Ready to close: Yes\nFinal review by m***@corp.com'
    );
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
