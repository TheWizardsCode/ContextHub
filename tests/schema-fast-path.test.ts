/**
 * SQLite schema/migration bootstrap fast path (WL-0MVWLBZG4003A803).
 *
 * Opening a store re-ran `initializeSchema()` — every `CREATE TABLE`/index
 * statement plus the additive required-column repair — on every open. For a
 * store that is already at the current schema version and holds every column
 * the code needs (the normal case for an operator's existing store and for
 * every warm CLI call in a test) that DDL is pure repeated startup work.
 *
 * The fast path is deliberately conservative:
 *
 *  - it is taken only when the store's `schemaVersion` equals the current
 *    version **and** every additive `REQUIRED_COLUMNS` entry is present;
 *  - a new store, an older version, a partially-migrated store (a missing
 *    additive column at the current version), or a store missing a required
 *    table still takes the full slow path and ends up repaired.
 *
 * These tests are black-box: the "no DDL" assertion drops an index the slow
 * path would recreate and checks it is still absent after a fast-path reopen,
 * so a silently re-enabled bootstrap fails the test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SqlitePersistentStore } from '@worklog/shared/persistent-store';
import { createTempDir, cleanupTempDir } from './test-utils.js';

describe('schema bootstrap fast path', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    const worklogDir = path.join(tempDir, '.worklog');
    fs.mkdirSync(worklogDir, { recursive: true });
    dbPath = path.join(worklogDir, 'worklog.db');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  /** Execute a statement against the store outside SqlitePersistentStore. */
  function mutateDb(fn: (db: Database.Database) => void): void {
    const db = new Database(dbPath);
    try {
      fn(db);
    } finally {
      db.close();
    }
  }

  function readOnly<T>(fn: (db: Database.Database) => T): T {
    const db = new Database(dbPath, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function indexNames(table: string): string[] {
    return readOnly((db) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(table) as Array<{
        name: string;
      }>).map((row) => row.name),
    );
  }

  function columnNames(table: string): string[] {
    return readOnly((db) =>
      (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((row) =>
        String(row.name),
      ),
    );
  }

  function tableNames(): string[] {
    return readOnly((db) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>).map((row) => row.name),
    );
  }

  function metadata(key: string): string | null {
    return readOnly((db) => {
      const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
        | { value?: string }
        | undefined;
      return row?.value ?? null;
    });
  }

  /** Create a current-version store and close it; returns its schema version. */
  function seedStore(): string {
    const store = new SqlitePersistentStore(dbPath);
    const version = store.getMetadata('schemaVersion');
    store.close();
    expect(version).not.toBeNull();
    return version as string;
  }

  it('runs the bootstrap on a new store and records the current schema version', () => {
    const store = new SqlitePersistentStore(dbPath);
    try {
      expect(store.schemaBootstrapSkipped).toBe(false);
      expect(store.getMetadata('schemaVersion')).not.toBeNull();
      expect(store.ftsAvailable).toBe(true);
    } finally {
      store.close();
    }
  });

  it('re-opening an already-migrated store skips the DDL bootstrap', () => {
    seedStore();
    // Drop an index the slow path would recreate with CREATE INDEX IF NOT EXISTS.
    mutateDb((db) => db.exec('DROP INDEX IF EXISTS idx_workitems_status'));
    expect(indexNames('workitems')).not.toContain('idx_workitems_status');

    const store = new SqlitePersistentStore(dbPath);
    try {
      expect(store.schemaBootstrapSkipped).toBe(true);
      // FTS stays available through the same cheap read, not a write probe.
      expect(store.ftsAvailable).toBe(true);
    } finally {
      store.close();
    }

    // No DDL ran, so the dropped index was not recreated.
    expect(indexNames('workitems')).not.toContain('idx_workitems_status');
  });

  it('an older schema version takes the slow path and repairs the required columns', () => {
    const currentVersion = seedStore();
    mutateDb((db) => {
      db.exec('ALTER TABLE audit_results DROP COLUMN fingerprint');
      db.prepare("DELETE FROM metadata WHERE key = 'audit_fingerprint_added'").run();
      db.prepare("UPDATE metadata SET value = '8' WHERE key = 'schemaVersion'").run();
    });
    expect(columnNames('audit_results')).not.toContain('fingerprint');

    const store = new SqlitePersistentStore(dbPath);
    try {
      expect(store.schemaBootstrapSkipped).toBe(false);
      expect(columnNames('audit_results')).toContain('fingerprint');
      expect(metadata('audit_fingerprint_added')).toBe('1');
      // Opening never rewrites schemaVersion; `wl doctor upgrade` advances it.
      expect(store.getMetadata('schemaVersion')).toBe('8');
      expect(currentVersion).not.toBe('8');
    } finally {
      store.close();
    }
  });

  it('a partially-migrated store at the current version still takes the slow path', () => {
    seedStore();
    // Current schemaVersion, but a required column is missing: a version-only
    // gate would wrongly skip the repair and break audit writes.
    mutateDb((db) => {
      db.exec('ALTER TABLE audit_results DROP COLUMN fingerprint');
      db.prepare("DELETE FROM metadata WHERE key = 'audit_fingerprint_added'").run();
    });
    expect(columnNames('audit_results')).not.toContain('fingerprint');

    const store = new SqlitePersistentStore(dbPath);
    try {
      expect(store.schemaBootstrapSkipped).toBe(false);
      expect(columnNames('audit_results')).toContain('fingerprint');
    } finally {
      store.close();
    }
  });

  it('a current-version store missing a base table takes the slow path and recreates it', () => {
    seedStore();
    // `comments`/`dependency_edges` carry no REQUIRED_COLUMNS entry, so only the
    // table-presence check can catch this. A legacy store migrated to the
    // current version without the base schema hits exactly this shape (the
    // `wl doctor` upgrade-notice regression), and it used to be self-healed by
    // the unconditional CREATE TABLE IF NOT EXISTS on every open.
    mutateDb((db) => {
      db.exec('DROP TABLE comments');
      db.exec('DROP TABLE dependency_edges');
    });
    expect(tableNames()).not.toContain('comments');
    expect(tableNames()).not.toContain('dependency_edges');

    const store = new SqlitePersistentStore(dbPath);
    try {
      expect(store.schemaBootstrapSkipped).toBe(false);
      expect(tableNames()).toContain('comments');
      expect(tableNames()).toContain('dependency_edges');
    } finally {
      store.close();
    }
  });
});
