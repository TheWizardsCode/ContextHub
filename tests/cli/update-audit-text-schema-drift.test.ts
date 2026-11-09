/**
 * Regression guard: `wl update --audit-text` against a drifted-but-repairable DB.
 *
 * Work item: WL-0MW56RBFD003J5WB (mirror of AH-0MW4W2CAJ000NUJZ).
 *
 * On 2026-11-06 the AI_Hell release gate could not persist its audit result:
 * `wl update --audit-text` exited rc=1 while the worklog database was drifted
 * (`schemaVersion=8` vs the installed tool's `9`). The store repairs a column
 * the current code requires but an older database lacks
 * (`REQUIRED_COLUMNS` in `packages/shared/src/persistent-store.ts`,
 * WL-0MUEBQLRD00288VV), so the write only works when that repair runs.
 *
 * The existing repair test
 * (`packages/shared/src/audit-fingerprint-repair.test.ts`) calls
 * `saveAuditResult()` directly. It therefore does NOT prove that the
 * production path — the `wl update --audit-text` **command** — still works on
 * a drifted database: a regression that broke the command, or bypassed the
 * store's repair, would leave that unit test green. These tests drive the real
 * CLI command.
 *
 * Everything is local and deterministic: a temp worklog directory, drift
 * applied directly to *that copy's* SQLite file, and the CLI run in-process /
 * bundled. No live worklog, network or `pi` calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore,
} from './cli-helpers.js';

describe('wl update --audit-text on a drifted-but-repairable DB (WL-0MW56RBFD003J5WB)', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir);
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  function dbPath(): string {
    return path.join(tempState.tempDir, '.worklog', 'worklog.db');
  }

  async function createItem(): Promise<string> {
    const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Drift item" -d "Item used by the drift guard."`);
    return JSON.parse(stdout).workItem.id;
  }

  /**
   * Downgrade the temp database to the pre-`audit_results.fingerprint` shape
   * that the 2026-11-06 release ran against: the column and its repair
   * sentinel are gone and the recorded version still says 8.
   */
  function driftDatabase(): void {
    const db = new Database(dbPath());
    try {
      db.exec('ALTER TABLE audit_results DROP COLUMN fingerprint');
      db.prepare("DELETE FROM metadata WHERE key = 'audit_fingerprint_added'").run();
      db.prepare("UPDATE metadata SET value = '8' WHERE key = 'schemaVersion'").run();
    } finally {
      db.close();
    }
  }

  function readMetadata(key: string): string | undefined {
    const db = new Database(dbPath(), { readonly: true });
    try {
      const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
        | { value?: string }
        | undefined;
      return row?.value;
    } finally {
      db.close();
    }
  }

  function auditColumns(): string[] {
    const db = new Database(dbPath(), { readonly: true });
    try {
      const cols = db.prepare("PRAGMA table_info('audit_results')").all() as Array<{ name: string }>;
      return cols.map((c) => String(c.name));
    } finally {
      db.close();
    }
  }

  function readAuditResult(id: string): any {
    const db = new Database(dbPath(), { readonly: true });
    try {
      return db.prepare('SELECT * FROM audit_results WHERE work_item_id = ?').get(id);
    } finally {
      db.close();
    }
  }

  // =====================================================================
  // The regression: the audit-text write command on a drifted database
  // =====================================================================

  it('writes the audit result instead of failing (rc=0) on a schemaVersion=8 DB missing audit_results.fingerprint', async () => {
    const id = await createItem();
    driftDatabase();

    // The fixture is genuinely drifted: without this the test could pass
    // vacuously against a database the repair never had to touch.
    expect(readMetadata('schemaVersion')).toBe('8');
    expect(auditColumns()).not.toContain('fingerprint');

    const auditText = `Ready to close: Yes

Drift regression guard (AH-0MW4W2CAJ000NUJZ).`;

    // execAsync throws on a non-zero exit, so reaching the assertions below
    // means `wl update --audit-text` returned rc=0 — the behaviour the release
    // gate depends on.
    const { stdout } = await execAsync(
      `tsx ${cliPath} --json update ${id} --audit-text "${auditText}"`,
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.workItem.auditResult).toMatchObject({
      workItemId: id,
      readyToClose: true,
    });

    // The write landed, and the connect-time repair healed the column plus its
    // sentinel rather than the write silently degrading.
    expect(auditColumns()).toContain('fingerprint');
    expect(readMetadata('audit_fingerprint_added')).toBe('1');

    const audit = readAuditResult(id);
    expect(audit).toBeDefined();
    expect(audit.summary).toContain('Drift regression guard');
    expect(audit.ready_to_close).toBe(1);
    expect(audit.fingerprint).toBeTruthy();
  });

  // =====================================================================
  // The release-gate sequence: `wl audit-set` then `wl update --audit-text`
  // (the pair `skill/audit/scripts/persist_audit.py` drives)
  // =====================================================================

  it('persists the audit-skill sequence (audit-set then update --audit-text) end to end on a drifted DB', async () => {
    const id = await createItem();
    driftDatabase();
    expect(readMetadata('schemaVersion')).toBe('8');

    const auditSet = await execAsync(
      `tsx ${cliPath} --json audit-set ${id} --ready-to-close yes --summary "Persist path verification." --raw-output "Audit complete: drift guard"`,
    );
    expect(JSON.parse(auditSet.stdout).success).toBe(true);

    const auditText = `Ready to close: Yes

Persist path verification via audit-set then audit-text.`;
    const updated = await execAsync(
      `tsx ${cliPath} --json update ${id} --audit-text "${auditText}"`,
    );
    const parsed = JSON.parse(updated.stdout);
    expect(parsed.success).toBe(true);

    const audit = readAuditResult(id);
    expect(audit.summary).toContain('Persist path verification via audit-set');
    // `--audit-text` must not clobber the machine-readable payload written by
    // `wl audit-set` (that would silently lose the release gate's report).
    expect(audit.raw_output).toBe('Audit complete: drift guard');
    expect(audit.fingerprint).toBeTruthy();
    expect(auditColumns()).toContain('fingerprint');
  });
});
