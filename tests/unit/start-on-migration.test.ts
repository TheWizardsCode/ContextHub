/**
 * `startOn` back-fill migration — `20261118-add-start-on`
 * (WL-0MWMGEPY2004EDZ8, parent WL-0MWM0FDZK007BAD0).
 *
 * Covers the migration half of AC6: the migration is listed by
 * `wl doctor upgrade` for a store that predates the field, it back-fills
 * `startOn = createdAt`, it creates the index, it advances the recorded schema
 * version, and **re-running it is a no-op** — an explicitly scheduled item is
 * never overwritten.
 *
 * `createV9Store()` reproduces the shape of a real version-9 store: the
 * `workitems` table without `startOn`, whose rows are all legacy.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import {
  CURRENT_SCHEMA_VERSION,
  listPendingMigrations,
  runMigrations,
  MIGRATION_CATALOG,
} from '../../src/migrations/index.js';

/** Id of the migration under test. */
const MIGRATION_ID = '20261118-add-start-on';

/** A frozen legacy creation instant, so the back-fill is deterministic. */
const LEGACY_CREATED_AT = '2026-06-01T12:00:00.000Z';

describe('startOn migration', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = path.join(tempDir, 'worklog.db');
    createV9Store(dbPath);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  /** Execute against the store under test. */
  function withDb<T>(fn: (db: Database.Database) => T): T {
    const db = new Database(dbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  /** All workitem rows, ordered by id, read straight from SQLite. */
  function storedRows(): Array<{ id: string; createdAt: string; startOn: string | null }> {
    return withDb((db) =>
      db.prepare('SELECT id, createdAt, startOn FROM workitems ORDER BY id').all() as Array<{
        id: string;
        createdAt: string;
        startOn: string | null;
      }>,
    );
  }

  function metadata(key: string): string | null {
    return withDb((db) => {
      const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
        | { value?: string }
        | undefined;
      return row?.value ?? null;
    });
  }

  function startOnColumnPresent(): boolean {
    return withDb((db) =>
      (db.prepare(`PRAGMA table_info('workitems')`).all() as Array<{ name: string }>).some(
        (column) => String(column.name) === 'startOn',
      ),
    );
  }

  function startOnIndexPresent(): boolean {
    return withDb((db) =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .all('idx_workitems_startOn') as Array<{ name: string }>
      ).length > 0,
    );
  }

  it('is registered in the migration catalog and listed as pending for a pre-startOn store', () => {
    expect(MIGRATION_CATALOG.some((entry) => entry.id === MIGRATION_ID)).toBe(true);
    expect(listPendingMigrations(dbPath).map((migration) => migration.id)).toContain(MIGRATION_ID);
  });

  it('is documented', () => {
    // The migration note is part of the deliverable (AC: "documented in
    // docs/migrations/start_on.md"), so a missing file fails the suite.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const doc = path.join(repoRoot, 'docs', 'migrations', 'start_on.md');
    expect(fs.existsSync(doc)).toBe(true);
    const content = fs.readFileSync(doc, 'utf-8');
    expect(content).toContain(MIGRATION_ID);
    expect(content).toContain('startOn = createdAt');
  });

  it('adds the column, back-fills startOn = createdAt for every legacy row and indexes it', () => {
    expect(startOnColumnPresent()).toBe(false);

    const { applied } = runMigrations({ confirm: true, logger: silentLogger() }, dbPath);

    expect(applied.map((migration) => migration.id)).toContain(MIGRATION_ID);
    expect(startOnColumnPresent()).toBe(true);
    expect(startOnIndexPresent()).toBe(true);

    const rows = storedRows();
    expect(rows.map((row) => row.id)).toEqual(['TEST-A', 'TEST-B']);
    for (const row of rows) {
      expect(row.startOn).toBe(row.createdAt);
      expect(row.startOn).toBe(LEGACY_CREATED_AT);
    }

    expect(metadata('startOn_added')).toBe('1');
    expect(metadata('startOn_backfilled')).toBe('1');
    expect(metadata('schemaVersion')).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('is idempotent: re-running changes nothing and keeps an explicitly scheduled value', () => {
    runMigrations({ confirm: true, logger: silentLogger() }, dbPath);
    // A user reschedules one item after the migration has run.
    const rescheduled = '2026-11-19T10:25:00.000Z';
    withDb((db) => {
      db.prepare('UPDATE workitems SET startOn = ? WHERE id = ?').run(rescheduled, 'TEST-A');
    });

    expect(listPendingMigrations(dbPath).map((migration) => migration.id)).not.toContain(
      MIGRATION_ID,
    );

    const second = runMigrations({ confirm: true, logger: silentLogger() }, dbPath);

    expect(second.applied.map((migration) => migration.id)).not.toContain(MIGRATION_ID);
    expect(storedRows()).toEqual([
      { id: 'TEST-A', createdAt: LEGACY_CREATED_AT, startOn: rescheduled },
      { id: 'TEST-B', createdAt: LEGACY_CREATED_AT, startOn: LEGACY_CREATED_AT },
    ]);
  });

  it('stays pending when only the column was added by the additive store repair', () => {
    // The persistent store adds a missing column on open (recording
    // `startOn_added`) but never back-fills. Keying the pending check on the
    // column would silently retire the back-fill; keying it on the back-fill
    // sentinel keeps the migration visible.
    withDb((db) => {
      db.exec('ALTER TABLE workitems ADD COLUMN startOn TEXT');
      db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
        'startOn_added',
        '1',
      );
    });

    expect(listPendingMigrations(dbPath).map((migration) => migration.id)).toContain(MIGRATION_ID);

    runMigrations({ confirm: true, logger: silentLogger() }, dbPath);

    expect(storedRows().every((row) => row.startOn === row.createdAt)).toBe(true);
    expect(metadata('startOn_backfilled')).toBe('1');
  });
});

/** Collect migration output without polluting the test report. */
function silentLogger(): { info: (s: string) => void; error: (s: string) => void } {
  return { info: () => {}, error: () => {} };
}

/**
 * Create a version-9-shaped store: `workitems` without `startOn`, two legacy
 * rows with distinct ids and `startOn`-less `createdAt` values.
 */
function createV9Store(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE workitems (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        sortIndex INTEGER NOT NULL DEFAULT 0,
        parentId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        activityAt TEXT,
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
        needsProducerReview INTEGER NOT NULL DEFAULT 0,
        auditWaiver TEXT
      );
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '9');
    `);
    const insert = db.prepare(`
      INSERT INTO workitems (
        id, title, description, status, priority, sortIndex, parentId,
        createdAt, updatedAt, activityAt, tags, assignee, stage, issueType,
        createdBy, deletedBy, deleteReason, risk, effort
      ) VALUES (?, ?, '', 'open', 'medium', 0, NULL, ?, ?, ?, '[]', '', 'idea', '', '', '', '', '', '')
    `);
    for (const id of ['TEST-B', 'TEST-A']) {
      insert.run(id, `Item ${id}`, LEGACY_CREATED_AT, LEGACY_CREATED_AT, LEGACY_CREATED_AT);
    }
  } finally {
    db.close();
  }
}
