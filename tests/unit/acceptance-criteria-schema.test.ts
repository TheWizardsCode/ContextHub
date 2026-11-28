/**
 * `acceptance_criteria` schema, version pairing and self-heal
 * (WL-0MWXJGVOQ0068QWK, parent WL-0MWXBHODR002ZLJG).
 *
 * Pins the storage half of the parent's first AC: the table exists with a
 * stable AC id, an owning-item FK (`ON DELETE CASCADE`), the criterion text,
 * a status CHECK restricted to the shared `AcceptanceCriterionStatus`
 * vocabulary, and a non-null, per-work-item-unique `position`; the paired
 * version constants are bumped together; and `wl doctor` sees no schema
 * mismatch for the new table on a store it has just created.
 *
 * Rows are written with raw SQL: the CRUD layer that fills the table is a
 * later child (WL-0MWXJGXSM009QA25), which is exactly why this slice pins the
 * shape now — the persistence layer builds on it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WorklogDatabase } from '../../src/database.js';
import { SqlitePersistentStore } from '@worklog/shared/persistent-store';
import {
  CURRENT_SCHEMA_VERSION,
  listPendingMigrations,
} from '../../src/migrations/index.js';
import { ACCEPTANCE_CRITERION_STATUSES } from '@worklog/shared/types';
import {
  createTempDir,
  cleanupTempDir,
  createTempDbPath,
  createTempJsonlPath,
} from '../test-utils.js';

/** The migration under test. */
const MIGRATION_ID = '20261128-add-acceptance-criteria';

describe('acceptance_criteria schema', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, false, false);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  /** Raw SQL read/write on the store file, bypassing the wrapper. */
  function raw<T>(fn: (conn: Database.Database) => T): T {
    const conn = new Database(dbPath);
    try {
      return fn(conn);
    } finally {
      conn.close();
    }
  }

  /** Insert one AC row directly (the CRUD layer lands in a later child). */
  function insertAc(
    conn: Database.Database,
    row: {
      id: string;
      workItemId: string;
      position: number;
      text: string;
      status?: string;
      originalText?: string | null;
      justification?: string | null;
    },
  ): void {
    conn
      .prepare(
        `INSERT INTO acceptance_criteria
           (id, work_item_id, position, text, status, original_text, modification_justification)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.workItemId,
        row.position,
        row.text,
        row.status ?? 'unmet',
        row.originalText ?? null,
        row.justification ?? null,
      );
  }

  it('creates the table with the required shape on a fresh store', () => {
    const tableInfo = raw((conn) =>
      Object.fromEntries(
        (conn.prepare(`PRAGMA table_info('acceptance_criteria')`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>).map((c) => [c.name, c]),
      ),
    );

    expect(Object.keys(tableInfo).sort()).toEqual(
      [
        'id',
        'work_item_id',
        'position',
        'text',
        'status',
        'original_text',
        'modification_justification',
      ].sort(),
    );
    // id is the PK; the owning item, position, text and status are required.
    expect(tableInfo.id).toMatchObject({ type: 'TEXT', notnull: 1, pk: 1 });
    expect(tableInfo.work_item_id).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
    expect(tableInfo.position).toMatchObject({ type: 'INTEGER', notnull: 1, pk: 0 });
    expect(tableInfo.text).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
    expect(tableInfo.status).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
    // The provenance fields are optional, populated only for `modified` rows.
    expect(tableInfo.original_text).toMatchObject({ notnull: 0, pk: 0 });
    expect(tableInfo.modification_justification).toMatchObject({ notnull: 0, pk: 0 });

    // The FK targets workitems(id) and cascades on delete.
    const fks = raw((conn) =>
      conn.prepare(`PRAGMA foreign_key_list('acceptance_criteria')`).all() as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>,
    );
    expect(fks).toEqual([
      expect.objectContaining({
        table: 'workitems',
        from: 'work_item_id',
        to: 'id',
        on_delete: 'CASCADE',
      }),
    ]);
  });

  it('restricts status to the shared vocabulary via a CHECK constraint', () => {
    // The CHECK is generated from the shared constant, so the constraint
    // string is the source of truth for "declared once".
    const createSql = raw(
      (conn) =>
        (conn
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'acceptance_criteria'")
          .get() as { sql: string }).sql,
    );
    expect(createSql).toContain(
      `CHECK (status IN (${ACCEPTANCE_CRITERION_STATUSES.map((s) => `'${s}'`).join(', ')}))`,
    );

    const item = db.create({ title: 'Status vocabulary item' });
    const occurrences = ACCEPTANCE_CRITERION_STATUSES.reduce<Record<string, number>>(
      (acc, status, index) => {
        acc[status] = index;
        return acc;
      },
      {},
    );
    // Every declared status is accepted.
    raw((conn) => {
      for (const status of ACCEPTANCE_CRITERION_STATUSES) {
        insertAc(conn, {
          id: `TEST-A-${status}`,
          workItemId: item.id,
          position: occurrences[status],
          text: `criterion ${status}`,
          status,
        });
      }
    });
    // Anything outside the vocabulary is rejected.
    expect(() =>
      raw((conn) =>
        insertAc(conn, {
          id: 'TEST-A-INVALID',
          workItemId: item.id,
          position: 99,
          text: 'bad status',
          status: 'adjusted',
        }),
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('removes the owning item\u2019s criteria on delete via ON DELETE CASCADE', () => {
    const item = db.create({ title: 'To be deleted' });
    raw((conn) => {
      insertAc(conn, {
        id: 'TEST-A-CASCADE',
        workItemId: item.id,
        position: 0,
        text: 'criterion that dies with its item',
      });
    });
    expect(
      raw((conn) =>
        (conn.prepare('SELECT COUNT(*) AS n FROM acceptance_criteria').get() as { n: number }).n,
      ),
    ).toBe(1);

    // `SqlitePersistentStore.deleteWorkItem` is the hard-delete path used by
    // `wl doctor prune`; the FK cascade removes the item's criteria with it.
    const store = new SqlitePersistentStore(dbPath);
    try {
      expect(store.deleteWorkItem(item.id)).toBe(true);
    } finally {
      store.close();
    }

    expect(
      raw((conn) =>
        (conn.prepare('SELECT COUNT(*) AS n FROM acceptance_criteria').get() as { n: number }).n,
      ),
    ).toBe(0);
  });

  it('enforces position as a non-null integer unique per work item', () => {
    const item = db.create({ title: 'Ordered criteria' });
    raw((conn) => {
      insertAc(conn, { id: 'TEST-A-0', workItemId: item.id, position: 0, text: 'first' });
      insertAc(conn, { id: 'TEST-A-1', workItemId: item.id, position: 1, text: 'second' });
    });

    // NULL position is rejected ...
    expect(() =>
      raw((conn) =>
        conn
          .prepare(
            `INSERT INTO acceptance_criteria (id, work_item_id, position, text, status)
             VALUES (?, ?, NULL, ?, 'unmet')`,
          )
          .run('TEST-A-NULL', item.id, 'no position'),
      ),
    ).toThrow(/NOT NULL constraint failed/);

    // ... and so is a duplicate (work_item_id, position).
    expect(() =>
      raw((conn) =>
        insertAc(conn, { id: 'TEST-A-DUP', workItemId: item.id, position: 0, text: 'clash' }),
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('creates a unique (work_item_id, position) index used for the read order', () => {
    const indexes = raw((conn) =>
      (conn.prepare(`PRAGMA index_list('acceptance_criteria')`).all() as Array<{
        name: string;
        unique: number;
      }>).filter((i) => i.name === 'idx_acceptance_criteria_work_item_position'),
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0].unique).toBe(1);

    const columns = raw((conn) =>
      (conn
        .prepare(`PRAGMA index_info('idx_acceptance_criteria_work_item_position')`)
        .all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(columns).toEqual(['work_item_id', 'position']);
  });

  it('bumps the paired version constants by exactly one step', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe('11');
    const stored = raw(
      (conn) =>
        (conn.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get() as {
          value: string;
        }).value,
    );
    // The store records the shared SCHEMA_VERSION; comparing it against the
    // migration constant catches a half-done bump (same pattern as the
    // `startOn` schema test).
    expect(stored).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('reports no schema mismatch for a store it has just created', () => {
    // The fresh store carries the table, so the doctor migration that creates
    // it is not pending (a legacy store gains it via `wl doctor upgrade`).
    expect(listPendingMigrations(dbPath).map((m) => m.id)).not.toContain(MIGRATION_ID);
  });

  it('self-heals the table on open when it is missing from an older store', () => {
    // Simulate a store written before this item: same build-created tables but
    // without the acceptance_criteria table, still at version 10.
    raw((conn) => {
      conn.prepare('DROP TABLE acceptance_criteria').run();
      conn
        .prepare("UPDATE metadata SET value = '10' WHERE key = 'schemaVersion'")
        .run();
    });

    // A second open runs the DDL bootstrap (the table is a REQUIRED_TABLES
    // member, so the fast path no longer applies) and recreates the table.
    const reopened = new WorklogDatabase('TEST', dbPath, jsonlPath, false, false);
    try {
      const present = raw((conn) =>
        (conn
          .prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'acceptance_criteria'")
          .get() as { n: number } | undefined) !== undefined,
      );
      expect(present).toBe(true);
      // The migration is satisfied again: `wl doctor upgrade` is a no-op for
      // this table on the healed store.
      expect(listPendingMigrations(dbPath).map((m) => m.id)).not.toContain(MIGRATION_ID);
    } finally {
      reopened.close();
    }
  });
});
