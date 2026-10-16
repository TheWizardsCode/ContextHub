/**
 * Migration test for RESTORING the `needsProducerReview` column
 * (WL-0MVAMS4RO000H3B0 F2).
 *
 * The removal (WL-0MV85WFYU0071YQ9) dropped the column via
 * `20261015-drop-needsProducerReview`. The removal was a wrongful deletion
 * (RCA WL-0MVAOYBZM0065AEN); the restore:
 *
 *   1. re-adds the column via `20261016-restore-needsProducerReview`, and
 *   2. neutralises the historical drop migration into a metadata-sentinel
 *      no-op so it can never remove the column again.
 *
 * These specs prove the restore migration is detected on a database that
 * lost the column, re-adds it, converts surviving producer-hold assignees
 * (`assignee = 'Map'`) to `needsProducerReview = 1` (Q3=A), and is
 * idempotent on a second run. Replaces the removal-era
 * `needs-producer-review-drop-migration.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { listPendingMigrations, runMigrations } from '../../src/migrations/index.js';

/** A legacy database that has LOST the column (mirrors a live post-removal store). */
function createLegacyDbWithoutFlag(dbPath: string): void {
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
        githubIssueUpdatedAt TEXT
      );
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '8');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('needsProducerReview_added', '1');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('needsProducerReview_dropped', '1');
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

function flagFor(dbPath: string, id: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT needsProducerReview AS f FROM workitems WHERE id = ?`).get(id) as { f: number };
    return row.f;
  } finally {
    db.close();
  }
}

describe('migrations: restore needsProducerReview column', () => {
  it('lists the restore migration as pending when the column is missing', () => {
    const tempDir = createTempDir();
    try {
      const dbPath = path.join(tempDir, 'worklog.db');
      createLegacyDbWithoutFlag(dbPath);
      expect(columns(dbPath)).not.toContain('needsProducerReview');

      const pending = listPendingMigrations(dbPath);
      expect(pending.map(p => p.id)).toContain('20261016-restore-needsProducerReview');
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('re-adds the column and never lets the drop migration remove it again', () => {
    const tempDir = createTempDir();
    try {
      const dbPath = path.join(tempDir, 'worklog.db');
      createLegacyDbWithoutFlag(dbPath);

      const applied = runMigrations({ confirm: true }, dbPath);
      expect(applied.applied.map(a => a.id)).toContain('20261016-restore-needsProducerReview');
      // The neutralised historical drop migration must never run a drop.
      expect(applied.applied.map(a => a.id)).not.toContain('20261015-drop-needsProducerReview');
      expect(columns(dbPath)).toContain('needsProducerReview');
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('converts a surviving producer hold (assignee Map) to needsProducerReview = 1 (Q3=A)', () => {
    const tempDir = createTempDir();
    try {
      const dbPath = path.join(tempDir, 'worklog.db');
      createLegacyDbWithoutFlag(dbPath);
      // Seed a producer-hold row BEFORE the migration: the legacy schema has
      // an `assignee` column but no `needsProducerReview` column yet.
      const seed = new Database(dbPath);
      try {
        const now = new Date().toISOString();
        seed.prepare(
          `INSERT INTO workitems (id, title, description, status, priority, sortIndex, parentId, createdAt, updatedAt, tags, assignee, stage, issueType, createdBy, deletedBy, deleteReason, risk, effort)
           VALUES (?, ?, '', 'completed', 'medium', 0, NULL, ?, ?, '', ?, 'in_review', 'task', '', '', '', '', '')`,
        ).run('WL-HOLD', 'Held item', now, now, 'Map');
      } finally {
        seed.close();
      }

      // The migration adds the column and converts the surviving hold (Q3=A).
      runMigrations({ confirm: true }, dbPath);
      expect(columns(dbPath)).toContain('needsProducerReview');
      expect(flagFor(dbPath, 'WL-HOLD')).toBe(1);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('is idempotent on a second run', () => {
    const tempDir = createTempDir();
    try {
      const dbPath = path.join(tempDir, 'worklog.db');
      createLegacyDbWithoutFlag(dbPath);

      runMigrations({ confirm: true }, dbPath);
      const secondRun = runMigrations({ confirm: true }, dbPath);
      expect(secondRun.applied.map(a => a.id)).not.toContain('20261016-restore-needsProducerReview');
      expect(columns(dbPath)).toContain('needsProducerReview');
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
