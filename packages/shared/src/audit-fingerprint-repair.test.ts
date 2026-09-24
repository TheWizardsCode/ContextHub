/**
 * Regression tests for the additive schema repair (WL-0MUEBQLRD00288VV).
 *
 * A database created before `audit_results.fingerprint` existed must be
 * repaired automatically when it is opened, so `wl audit-set` (and the audit
 * skill's persister) work without a manual `wl doctor upgrade`. Previously the
 * write failed with `table audit_results has no column named fingerprint`, and
 * the `a-y`/`a-r` shortcuts swallowed the error into a log file.
 *
 * Run: npx vitest run packages/shared/src/audit-fingerprint-repair.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { WorklogDatabase } from './database.js';

describe('additive schema repair (WL-0MUEBQLRD00288VV)', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'worklog-repair-'));
    dbPath = join(tempDir, 'worklog.db');
    jsonlPath = join(tempDir, 'data.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Create a current database, then downgrade it to the pre-fingerprint shape:
   * drop the `audit_results.fingerprint` column and remove the repair marker.
   * Returns the id of a work item to audit.
   */
  function createLegacyDbWithoutFingerprint(): string {
    const db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
    const item = db.create({ title: 'Legacy item', description: 'x', priority: 'high' });
    db.close();

    const raw = new Database(dbPath);
    try {
      raw.exec('ALTER TABLE audit_results DROP COLUMN fingerprint');
      raw.prepare("DELETE FROM metadata WHERE key = 'audit_fingerprint_added'").run();
    } finally {
      raw.close();
    }
    return item.id;
  }

  it('repairs a legacy database on open so saveAuditResult succeeds (AC1)', () => {
    const id = createLegacyDbWithoutFingerprint();

    const db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
    try {
      // The column is restored and the repair marker recorded.
      const raw = new Database(dbPath, { readonly: true });
      try {
        const cols = raw
          .prepare("PRAGMA table_info('audit_results')")
          .all() as Array<{ name: string }>;
        expect(cols.map((c) => c.name)).toContain('fingerprint');
        const marker = raw
          .prepare("SELECT value FROM metadata WHERE key = 'audit_fingerprint_added'")
          .get() as { value?: string } | undefined;
        expect(marker?.value).toBe('1');
      } finally {
        raw.close();
      }

      // The write that used to fail now succeeds.
      expect(() =>
        db.saveAuditResult({
          workItemId: id,
          readyToClose: true,
          auditedAt: new Date().toISOString(),
          summary: 'Approved by manual review',
          rawOutput: null,
          author: 'tester',
          fingerprint: 'abc123',
        }),
      ).not.toThrow();
      const audit = db.getAuditResult(id);
      expect(audit?.readyToClose).toBe(true);
      expect(audit?.fingerprint).toBe('abc123');
    } finally {
      db.close();
    }
  });

  it('is idempotent — a repaired database reopens with no further changes (AC5c)', () => {
    createLegacyDbWithoutFingerprint();

    const first = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
    first.close();

    const second = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
    try {
      const raw = new Database(dbPath, { readonly: true });
      try {
        const cols = raw
          .prepare("PRAGMA table_info('audit_results')")
          .all() as Array<{ name: string }>;
        expect(cols.filter((c) => c.name === 'fingerprint')).toHaveLength(1);
      } finally {
        raw.close();
      }
    } finally {
      second.close();
    }
  });

  it('a fresh database persists audits with a fingerprint (AC5b)', () => {
    const db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
    try {
      const item = db.create({ title: 'Fresh', description: 'x' });
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: new Date().toISOString(),
        summary: 'ok',
        rawOutput: null,
        author: 'tester',
        fingerprint: 'fp',
      });
      expect(db.getAuditResult(item.id)?.fingerprint).toBe('fp');
    } finally {
      db.close();
    }
  });
});
