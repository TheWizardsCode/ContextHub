/**
 * Migration test for dropping the legacy `needsProducerReview` column
 * (WL-0MV85WFYU0071YQ9).
 *
 * The add-migration (`20260210-add-needsProducerReview`) is preserved for
 * history but must never re-add the column after the drop. This test proves
 * the drop migration is detected on a legacy database, actually removes the
 * column, and is idempotent on a second run.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { listPendingMigrations, runMigrations } from '../../src/migrations/index.js';

function createLegacyDbWithFlag(dbPath: string): void {
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

function columns(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`PRAGMA table_info('workitems')`).all() as Array<{ name: string }>).map(c => c.name);
  } finally {
    db.close();
  }
}

describe('migrations: drop legacy needsProducerReview column', () => {
  it('is listed as pending for a legacy database that still has the column', () => {
    const tempDir = createTempDir();
    try {
      const dbPath = path.join(tempDir, 'worklog.db');
      createLegacyDbWithFlag(dbPath);
      expect(columns(dbPath)).toContain('needsProducerReview');

      const pending = listPendingMigrations(dbPath);
      expect(pending.map(p => p.id)).toContain('20261015-drop-needsProducerReview');
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('drops the column and never re-adds it via the preserved add-migration', () => {
    const tempDir = createTempDir();
    try {
      const dbPath = path.join(tempDir, 'worklog.db');
      createLegacyDbWithFlag(dbPath);

      const applied = runMigrations({ confirm: true }, dbPath);
      expect(applied.applied.map(a => a.id)).toContain('20261015-drop-needsProducerReview');
      // The preserved add-migration may run as a no-op sentinel on a legacy
      // database, but it must never re-add the column.
      if (applied.applied.map(a => a.id).includes('20260210-add-needsProducerReview')) {
        expect(columns(dbPath)).not.toContain('needsProducerReview');
      }
      expect(columns(dbPath)).not.toContain('needsProducerReview');
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('is idempotent on a second run', () => {
    const tempDir = createTempDir();
    try {
      const dbPath = path.join(tempDir, 'worklog.db');
      createLegacyDbWithFlag(dbPath);

      runMigrations({ confirm: true }, dbPath);
      const secondRun = runMigrations({ confirm: true }, dbPath);
      expect(secondRun.applied.map(a => a.id)).not.toContain('20261015-drop-needsProducerReview');
      expect(columns(dbPath)).not.toContain('needsProducerReview');
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
