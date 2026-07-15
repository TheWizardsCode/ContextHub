import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execAsync, enterTempDir, leaveTempDir, writeConfig, writeInitSemaphore, cliPath } from './cli-helpers.js';

describe('wl audit-set command', () => {
  let state: { tempDir: string; originalCwd: string };
  let targetId: string;

  beforeEach(async () => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'ASET');
    writeInitSemaphore(state.tempDir);
    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Audit set target"`);
    const created = JSON.parse(stdout);
    expect(created.success).toBe(true);
    targetId = created.workItem.id;
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('sets an audit result with --ready-to-close yes', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json audit-set ${targetId} --ready-to-close yes --summary "All criteria met"`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.audit.readyToClose).toBe(true);
    expect(result.audit.summary).toBe('All criteria met');
    expect(result.audit.auditedAt).toBeTruthy();
  });

  it('sets an audit result with --ready-to-close no', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json audit-set ${targetId} --ready-to-close no --summary "Still needs work" --author "bot"`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.audit.readyToClose).toBe(false);
    expect(result.audit.author).toBe('bot');
  });

  it('rejects invalid --ready-to-close value', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json audit-set ${targetId} --ready-to-close maybe`);
      // Should not reach here
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.exitCode).not.toBe(0);
    }
  });

  it('requires --ready-to-close', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json audit-set ${targetId} --summary "No readiness flag"`);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.exitCode).not.toBe(0);
    }
  });

  it('fails for non-existent work item', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json audit-set ASET-NONEXISTENT999 --ready-to-close yes`);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.exitCode).not.toBe(0);
    }
  });

  it('returns error when database write fails (read-only db)', async () => {
    const fs = await import('fs');
    const path = await import('path');

    // Set an audit successfully first (to ensure DB is initialized)
    await execAsync(`tsx ${cliPath} --json audit-set ${targetId} --ready-to-close yes --summary "Initial audit"`);

    // Make the database read-only
    const dbPath = path.join(state.tempDir, '.worklog', 'worklog.db');
    fs.chmodSync(dbPath, 0o444);

    // Now try to set another audit - should fail
    try {
      await execAsync(`tsx ${cliPath} --json audit-set ${targetId} --ready-to-close no --summary "Should fail"`);
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      const result = JSON.parse(err.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(err.exitCode).not.toBe(0);
    }

    // Restore permissions for cleanup
    fs.chmodSync(dbPath, 0o644);
  });
});

describe('wl audit-show command', () => {
  let state: { tempDir: string; originalCwd: string };
  let targetId: string;

  beforeEach(async () => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'ASHOW');
    writeInitSemaphore(state.tempDir);
    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Audit show target"`);
    const created = JSON.parse(stdout);
    expect(created.success).toBe(true);
    targetId = created.workItem.id;
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('shows null audit result when no audit exists', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json audit-show ${targetId}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.audit).toBeNull();
  });

  it('shows audit result after setting one', async () => {
    // First set an audit
    await execAsync(`tsx ${cliPath} --json audit-set ${targetId} --ready-to-close yes --summary "Ready to close" --author "tester"`);
    // Then show it
    const { stdout } = await execAsync(`tsx ${cliPath} --json audit-show ${targetId}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.audit).toBeDefined();
    expect(result.audit).not.toBeNull();
    expect(result.audit.workItemId).toBe(targetId);
    expect(result.audit.readyToClose).toBe(true);
    expect(result.audit.summary).toBe('Ready to close');
    expect(result.audit.author).toBe('tester');
  });

  it('shows human-readable output when no audit exists', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} audit-show ${targetId}`);
    expect(stdout).toContain('No audit result');
  });

  it('shows human-readable output when audit exists', async () => {
    await execAsync(`tsx ${cliPath} --json audit-set ${targetId} --ready-to-close yes --summary "Passed all checks"`);
    const { stdout } = await execAsync(`tsx ${cliPath} audit-show ${targetId}`);
    expect(stdout).toContain('Ready to close: Yes');
    expect(stdout).toContain('Passed all checks');
  });

  it('fails for non-existent work item', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json audit-show ASHOW-NONEXISTENT999`);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.exitCode).not.toBe(0);
    }
  });
});

describe('wl update --audit-text writes to audit_results', () => {
  let state: { tempDir: string; originalCwd: string };
  let targetId: string;

  beforeEach(async () => {
    state = enterTempDir();
    writeConfig(state.tempDir, 'Test Project', 'AWRT');
    writeInitSemaphore(state.tempDir);
    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Audit write target"`);
    const created = JSON.parse(stdout);
    expect(created.success).toBe(true);
    targetId = created.workItem.id;
  });

  afterEach(() => {
    leaveTempDir(state);
  });

  it('writes audit to audit_results table via --audit-text', async () => {
    // Update with audit text
    await execAsync(`tsx ${cliPath} --json update ${targetId} --audit-text "Ready to close: Yes\nAll checks passed"`);

    // Read via audit-show
    const { stdout } = await execAsync(`tsx ${cliPath} --json audit-show ${targetId}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.audit).not.toBeNull();
    expect(result.audit.readyToClose).toBe(true);
    expect(result.audit.summary).toContain('Ready to close: Yes');
  });

  it('writes audit to audit_results table via --audit-file', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const auditFile = path.join(state.tempDir, 'audit-content.txt');
    fs.writeFileSync(auditFile, 'Ready to close: No\nStill needs review');

    await execAsync(`tsx ${cliPath} --json update ${targetId} --audit-file "${auditFile}"`);

    const { stdout } = await execAsync(`tsx ${cliPath} --json audit-show ${targetId}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.audit).not.toBeNull();
    expect(result.audit.readyToClose).toBe(false);
    expect(result.audit.summary).toContain('Ready to close: No');
  });

  it('wl show --json includes auditResult from audit_results table', async () => {
    await execAsync(`tsx ${cliPath} --json update ${targetId} --audit-text "Ready to close: Yes\nGood to go" -a "test-author"`);

    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${targetId}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.auditResult).toBeDefined();
    expect(result.auditResult).not.toBeNull();
    expect(result.auditResult.readyToClose).toBe(true);
    expect(result.auditResult.summary).toContain('Ready to close: Yes');
    expect(result.auditResult.author).toBeTruthy();
  });

  it('wl show --json includes auditResult null when no audit set', async () => {
    const { stdout } = await execAsync(`tsx ${cliPath} --json show ${targetId}`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.auditResult).toBeNull();
  });

  it('returns error on write failure via --audit-text', async () => {
    const fs = await import('fs');
    const path = await import('path');

    // Make the database read-only before writing audit
    const dbPath = path.join(state.tempDir, '.worklog', 'worklog.db');
    fs.chmodSync(dbPath, 0o444);

    // Attempt to write audit via --audit-text - should fail
    try {
      await execAsync(`tsx ${cliPath} --json update ${targetId} --audit-text "Ready to close: Yes\nShould fail"`);
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      const result = JSON.parse(err.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(err.exitCode).not.toBe(0);
    }

    fs.chmodSync(dbPath, 0o644);
  });
});