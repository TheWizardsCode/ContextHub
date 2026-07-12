import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createTempDir, cleanupTempDir } from './test-utils.js';
import { listPendingMigrations, runMigrations } from '../src/migrations/index.js';

function createLegacyDbWithoutAudit(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workitems (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        sortIndex INTEGER NOT NULL DEFAULT 0,
        parentId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        tags TEXT NOT NULL,
        assignee TEXT NOT NULL,
        stage TEXT NOT NULL,
        issueType TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        deletedBy TEXT NOT NULL,
        deleteReason TEXT NOT NULL,
        risk TEXT NOT NULL,
        effort TEXT NOT NULL,
        githubIssueNumber INTEGER,
        githubIssueId INTEGER,
        githubIssueUpdatedAt TEXT,
        needsProducerReview INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '6');
    `);
  } finally {
    db.close();
  }
}

describe('migrations: add audit field', () => {
  it('lists audit migration as pending for legacy db', () => {
    const tempDir = createTempDir();
    try {
      const dbPath = path.join(tempDir, 'worklog.db');
      createLegacyDbWithoutAudit(dbPath);

      const pending = listPendingMigrations(dbPath);
      const ids = pending.map(p => p.id);
      expect(ids).toContain('20260315-add-audit');
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('applies audit migration with backup and idempotency', () => {
    const tempDir = createTempDir();
    try {
      const dbPath = path.join(tempDir, 'worklog.db');
      createLegacyDbWithoutAudit(dbPath);

      const dryRun = runMigrations({ dryRun: true }, dbPath);
      expect(dryRun.applied.map(a => a.id)).toContain('20260315-add-audit');

      const applied = runMigrations({ confirm: true }, dbPath);
      expect(applied.applied.map(a => a.id)).toContain('20260315-add-audit');
      // At least one backup should exist (migration framework makes backups)
      expect(applied.backups.length).toBeGreaterThanOrEqual(1);

      const db = new Database(dbPath, { readonly: true });
      try {
        const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as Array<{ name: string }>;
        // After all migrations run, the audit column should be gone
        // (added by 20260315-add-audit, then dropped by 20260604-drop-audit-column)
        expect(cols.map(c => c.name)).not.toContain('audit');
        // The audit_results table should exist
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_results'").all() as any[];
        expect(tables.length).toBe(1);
      } finally {
        db.close();
      }

      const secondRun = runMigrations({ confirm: true }, dbPath);
      expect(secondRun.applied).toHaveLength(0);
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
