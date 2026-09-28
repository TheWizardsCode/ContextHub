/**
 * Migration test for the nullable `auditWaiver` column
 * (WL-0MUBVH9FV0027COG).
 *
 * Ensures the migration is detected on a legacy database, adds the column
 * additively (nullable, so old rows fail safe to "not waived"), and is
 * idempotent on a second run.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { listPendingMigrations, runMigrations } from '../../src/migrations/index.js';

function createLegacyDb(dbPath: string): void {
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

describe('migrations: add nullable auditWaiver column', () => {
  it('is listed as pending for a legacy database without the column', () => {
    const tempDir = createTempDir();
    try {
      const dbPath = path.join(tempDir, 'worklog.db');
      createLegacyDb(dbPath);

      const pending = listPendingMigrations(dbPath);
      expect(pending.map(p => p.id)).toContain('20260928-add-audit-waiver');
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('adds the nullable auditWaiver column and is idempotent', () => {
    const tempDir = createTempDir();
    try {
      const dbPath = path.join(tempDir, 'worklog.db');
      createLegacyDb(dbPath);

      const applied = runMigrations({ confirm: true }, dbPath);
      expect(applied.applied.map(a => a.id)).toContain('20260928-add-audit-waiver');

      const db = new Database(dbPath, { readonly: true });
      try {
        const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as Array<{ name: string; notnull: number }>;
        const waiverCol = cols.find(c => c.name === 'auditWaiver');
        expect(waiverCol).toBeDefined();
        // Nullable: legacy rows default to NULL = "not waived" (fail-safe).
        expect(waiverCol?.notnull).toBe(0);
      } finally {
        db.close();
      }

      const secondRun = runMigrations({ confirm: true }, dbPath);
      expect(secondRun.applied.map(a => a.id)).not.toContain('20260928-add-audit-waiver');
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
