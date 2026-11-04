/**
 * Tests for the audit-column drop safety work (WL-0MW1W61CG005K893).
 *
 * Two defects are pinned here:
 *
 *  A. `20260604-backfill-audit-results` used to silently skip any legacy
 *     `workitems.audit` value it could not map, mark itself complete, and let
 *     `20260604-drop-audit-column` delete the column — destroying the only
 *     copy of that text. The backfill must now preserve every value.
 *  B. `safe` no longer reflected destructiveness: a neutralised historical
 *     entry was still declared `safe: false`, so a no-op read as a
 *     `DROP COLUMN`. Neutralised entries are now declared and linted.
 *
 * The preservation store is deliberately a dedicated table
 * (`legacy_audit_preserved`) rather than `audit_results.raw_output`:
 * `getAuditResult()` returns any existing `audit_results` row as a real audit
 * verdict (`readyToClose: false`), so parking unparseable legacy text there
 * would misrepresent those items as "audited and rejected" in `wl next`, the
 * audit gates and the JSONL export.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import {
  runMigrations,
  listPendingMigrations,
  auditPreservationSummary,
  assertAuditTextPreserved,
  MigrationUnsafeError,
  MIGRATION_CATALOG,
  CURRENT_SCHEMA_VERSION,
} from '../../src/migrations/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Create a legacy database that carries the pre-audit_results `audit` TEXT
 * column. No `audit_results` table: the add-audit-results migration creates it.
 */
function createLegacyDb(
  dbPath: string,
  rows: Array<{ id: string; audit: string | null }>,
  opts: { schemaVersion?: string; withAuditColumn?: boolean; withPRR?: boolean } = {},
): void {
  const { schemaVersion = '6', withAuditColumn = true, withPRR = true } = opts;
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE workitems (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL, priority TEXT NOT NULL, sortIndex INTEGER NOT NULL DEFAULT 0,
        parentId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        tags TEXT NOT NULL, assignee TEXT NOT NULL, stage TEXT NOT NULL,
        issueType TEXT NOT NULL, createdBy TEXT NOT NULL, deletedBy TEXT NOT NULL,
        deleteReason TEXT NOT NULL, risk TEXT NOT NULL, effort TEXT NOT NULL,
        githubIssueNumber INTEGER, githubIssueId INTEGER, githubIssueUpdatedAt TEXT
        ${withPRR ? ', needsProducerReview INTEGER NOT NULL DEFAULT 0' : ''}
        ${withAuditColumn ? ', audit TEXT' : ''}
      );
      CREATE TABLE comments (
        id TEXT PRIMARY KEY, workItemId TEXT NOT NULL, author TEXT NOT NULL,
        comment TEXT NOT NULL, createdAt TEXT NOT NULL, refs TEXT
      );
      CREATE TABLE dependency_edges (
        fromId TEXT NOT NULL, toId TEXT NOT NULL,
        createdAt TEXT NOT NULL, PRIMARY KEY (fromId, toId)
      );
    `);
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
      'schemaVersion',
      schemaVersion,
    );
    const cols = withAuditColumn
      ? `(id, title, description, status, priority, sortIndex, parentId, createdAt, updatedAt,
         tags, assignee, stage, issueType, createdBy, deletedBy, deleteReason, risk, effort, audit)
         VALUES (?, ?, 'd', 'open', 'high', 100, NULL, '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z', '[]', '', 'idea', 'task', '', '', '', '', '', ?)`
      : `(id, title, description, status, priority, sortIndex, parentId, createdAt, updatedAt,
         tags, assignee, stage, issueType, createdBy, deletedBy, deleteReason, risk, effort)
         VALUES (?, ?, 'd', 'open', 'high', 100, NULL, '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z', '[]', '', 'idea', 'task', '', '', '', '', '')`;
    const stmt = db.prepare(`INSERT OR REPLACE INTO workitems ${cols}`);
    for (const row of rows) {
      if (withAuditColumn) stmt.run(row.id, `Item ${row.id}`, row.audit);
      else stmt.run(row.id, `Item ${row.id}`);
    }
  } finally {
    db.close();
  }
}

function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function tableExists(dbPath: string, table: string): boolean {
  return withDb(dbPath, db =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(table) as unknown[]).length > 0,
  );
}

function columnExists(dbPath: string, table: string, column: string): boolean {
  return withDb(dbPath, db =>
    (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).some(
      c => String(c.name) === column,
    ),
  );
}

/** Value of a `metadata` row, or `undefined` when the key is absent. */
function metaValue(dbPath: string, key: string): string | undefined {
  return withDb(dbPath, db => {
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as any;
    return row ? String(row.value) : undefined;
  });
}

// ---------------------------------------------------------------------------
// A. Lossless backfill + gated drop
// ---------------------------------------------------------------------------

describe('audit backfill preservation: unparseable legacy text survives the drop', () => {
  const cases: Array<{ name: string; audit: string }> = [
    { name: 'bare plain text (not JSON)', audit: 'Legacy audit notes without any JSON wrapper' },
    { name: 'invalid JSON', audit: '{not valid json' },
    { name: 'JSON object without a .text field', audit: JSON.stringify({ verdict: 'ok', note: 'shape drift' }) },
    { name: 'JSON array', audit: JSON.stringify(['one', 'two']) },
  ];

  for (const { name, audit } of cases) {
    it(`preserves ${name} verbatim and still drops the column`, () => {
      const tmp = createTempDir();
      try {
        const dbPath = path.join(tmp, 'worklog.db');
        createLegacyDb(dbPath, [{ id: 'WL-P1', audit }]);

        const result = runMigrations({ confirm: true }, dbPath);

        // The drop actually ran
        expect(result.applied.map(a => a.id)).toContain('20260604-drop-audit-column');
        expect(columnExists(dbPath, 'workitems', 'audit')).toBe(false);

        // ... and the text survived, byte for byte
        const preserved = withDb(dbPath, db =>
          db.prepare('SELECT * FROM legacy_audit_preserved WHERE work_item_id = ?').get('WL-P1') as any,
        );
        expect(preserved).toBeDefined();
        expect(preserved.audit_text).toBe(audit);

        // ... and it was NOT misrepresented as an audit verdict
        const auditRows = withDb(dbPath, db =>
          db.prepare('SELECT * FROM audit_results WHERE work_item_id = ?').all('WL-P1') as unknown[],
        );
        expect(auditRows.length).toBe(0);
      } finally {
        cleanupTempDir(tmp);
      }
    });
  }

  it('maps parseable audit JSON to audit_results AND keeps verbatim provenance in raw_output', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      const auditJson = JSON.stringify({
        time: '2026-05-01T10:00:00.000Z',
        author: 'alice',
        text: 'Ready to close: Yes\nReviewed',
        status: 'Complete',
      });
      createLegacyDb(dbPath, [{ id: 'WL-P2', audit: auditJson }]);

      runMigrations({ confirm: true }, dbPath);

      const row = withDb(dbPath, db =>
        db.prepare('SELECT * FROM audit_results WHERE work_item_id = ?').get('WL-P2') as any,
      );
      expect(row).toBeDefined();
      expect(row.ready_to_close).toBe(1);
      expect(row.audited_at).toBe('2026-05-01T10:00:00.000Z');
      expect(row.summary).toBe('Ready to close: Yes\nReviewed');
      expect(row.author).toBe('alice');
      expect(row.raw_output).toBe(auditJson); // provenance, not null

      // A genuine audit result needs no preservation row
      const preserved = withDb(dbPath, db =>
        db.prepare('SELECT * FROM legacy_audit_preserved WHERE work_item_id = ?').all('WL-P2') as unknown[],
      );
      expect(preserved.length).toBe(0);
      expect(columnExists(dbPath, 'workitems', 'audit')).toBe(false);
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('preserves leftover text even when the backfill already ran (convergence, no permanent block)', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDb(dbPath, [{ id: 'WL-P3', audit: 'leftover legacy text' }]);

      // Simulate an older database where the backfill marker was written but
      // the unmappable value was left in place (the pre-fix behaviour).
      withDb(dbPath, db => {
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
          'audit_backfill_complete',
          '1',
        );
      });

      const result = runMigrations({ confirm: true }, dbPath);

      expect(result.applied.map(a => a.id)).toContain('20260604-drop-audit-column');
      const preserved = withDb(dbPath, db =>
        db.prepare('SELECT audit_text FROM legacy_audit_preserved WHERE work_item_id = ?').get('WL-P3') as any,
      );
      expect(preserved.audit_text).toBe('leftover legacy text');
      expect(columnExists(dbPath, 'workitems', 'audit')).toBe(false);
    } finally {
      cleanupTempDir(tmp);
    }
  });
});

describe('assertAuditTextPreserved: the drop gate', () => {
  it('throws MigrationUnsafeError listing orphaned item ids', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDb(dbPath, [
        { id: 'WL-ORPHAN1', audit: 'orphaned text one' },
        { id: 'WL-ORPHAN2', audit: 'orphaned text two' },
        { id: 'WL-CLEAN', audit: null },
      ]);
      withDb(dbPath, db => {
        db.exec('CREATE TABLE audit_results (work_item_id TEXT PRIMARY KEY, ready_to_close INTEGER)');
        db.exec(
          'CREATE TABLE legacy_audit_preserved (work_item_id TEXT PRIMARY KEY, audit_text TEXT NOT NULL, preserved_at TEXT NOT NULL)',
        );
        let err: unknown;
        try {
          assertAuditTextPreserved(db);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(MigrationUnsafeError);
        const ids = (err as MigrationUnsafeError).offendingIds;
        expect(ids.sort()).toEqual(['WL-ORPHAN1', 'WL-ORPHAN2']);
      });
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('passes when every non-empty legacy value has an audit_results row', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDb(dbPath, [{ id: 'WL-A', audit: 'text' }]);
      withDb(dbPath, db => {
        db.exec('CREATE TABLE audit_results (work_item_id TEXT PRIMARY KEY, ready_to_close INTEGER)');
        db.prepare('INSERT INTO audit_results (work_item_id, ready_to_close) VALUES (?, 0)').run('WL-A');
        expect(() => assertAuditTextPreserved(db)).not.toThrow();
      });
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('passes when every non-empty legacy value has a preservation row', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDb(dbPath, [{ id: 'WL-B', audit: 'text' }]);
      withDb(dbPath, db => {
        db.exec('CREATE TABLE audit_results (work_item_id TEXT PRIMARY KEY, ready_to_close INTEGER)');
        db.exec(
          'CREATE TABLE legacy_audit_preserved (work_item_id TEXT PRIMARY KEY, audit_text TEXT NOT NULL, preserved_at TEXT NOT NULL)',
        );
        db.prepare('INSERT INTO legacy_audit_preserved VALUES (?, ?, ?)').run('WL-B', 'text', 'now');
        expect(() => assertAuditTextPreserved(db)).not.toThrow();
      });
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('is a no-op when the audit column is already gone', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDb(dbPath, [{ id: 'WL-C', audit: 'ignored' }], { withAuditColumn: false });
      withDb(dbPath, db => {
        expect(() => assertAuditTextPreserved(db)).not.toThrow();
      });
    } finally {
      cleanupTempDir(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// A2. The incident shapes, exercised through the full `runMigrations` flow
// ---------------------------------------------------------------------------

describe('runMigrations: incident shapes end to end', () => {
  it('upgrades a fresh database without touching legacy audit storage', async () => {
    const { WorklogDatabase } = await import('../../src/database.js');
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      const db = new WorklogDatabase('MIG', dbPath, path.join(tmp, 'worklog-data.jsonl'), true, false);
      try {
        db.create({ title: 'Fresh item' });
      } finally {
        db.close();
      }

      // A schema created by this build carries no legacy `audit` column, so
      // the upgrade has nothing to preserve and must simply complete.
      const result = runMigrations({ confirm: true }, dbPath);

      expect(result.applied.map(a => a.id)).toContain('20260604-drop-audit-column');
      expect(columnExists(dbPath, 'workitems', 'audit')).toBe(false);
      // No preservation store is materialised when there is nothing to keep.
      expect(tableExists(dbPath, 'legacy_audit_preserved')).toBe(false);
      // Fully migrated: a second run is a no-op and the version is at HEAD.
      expect(runMigrations({ confirm: true }, dbPath).applied).toEqual([]);
      expect(metaValue(dbPath, 'schemaVersion')).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('refuses the drop when a legacy value cannot be preserved, rolling the whole run back', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDb(dbPath, [
        { id: 'WL-FLOW-ORPHAN', audit: 'legacy text with no successor' },
        {
          id: 'WL-FLOW-MAPPED',
          audit: JSON.stringify({
            time: '2026-05-01T10:00:00.000Z',
            author: 'alice',
            text: 'Ready to close: Yes',
            status: 'Complete',
          }),
        },
      ]);

      // Fault injection: a preservation store that silently refuses writes
      // (the sweep's `INSERT OR IGNORE` reports no change), so one value stays
      // orphaned. This is the only way to reach the gate through the real
      // runner — the lossless sweep removes every natural orphan — and it
      // proves the gate refuses rather than letting the DROP COLUMN run.
      withDb(dbPath, db => {
        db.exec(`
          CREATE TABLE legacy_audit_preserved (
            work_item_id TEXT PRIMARY KEY,
            audit_text TEXT NOT NULL,
            preserved_at TEXT NOT NULL
          );
          CREATE TRIGGER refuse_preserve
            BEFORE INSERT ON legacy_audit_preserved
            BEGIN SELECT RAISE(IGNORE); END;
        `);
      });

      let err: unknown;
      try {
        runMigrations({ confirm: true }, dbPath);
      } catch (e) {
        err = e;
      }

      // The refusal names the offending item and the migration.
      expect(err).toBeInstanceOf(MigrationUnsafeError);
      expect((err as MigrationUnsafeError).migrationId).toBe('20260604-drop-audit-column');
      expect((err as MigrationUnsafeError).offendingIds).toEqual(['WL-FLOW-ORPHAN']);

      // ... and the whole transaction rolled back: the column survives, no
      // migration marker was written and the recorded version is unchanged.
      expect(columnExists(dbPath, 'workitems', 'audit')).toBe(true);
      expect(metaValue(dbPath, 'audit_backfill_complete')).toBeUndefined();
      expect(metaValue(dbPath, 'audit_column_dropped')).toBeUndefined();
      expect(metaValue(dbPath, 'schemaVersion')).toBe('6');
      expect(listPendingMigrations(dbPath).map(m => m.id)).toContain('20260604-drop-audit-column');

      // The legacy text is still readable in place — nothing was destroyed.
      const rows = withDb(dbPath, db =>
        db.prepare('SELECT id, audit FROM workitems ORDER BY id').all() as Array<{ id: string; audit: string }>,
      );
      expect(rows.map(r => [r.id, r.audit])).toEqual([
        ['WL-FLOW-MAPPED', expect.stringContaining('Ready to close: Yes')],
        ['WL-FLOW-ORPHAN', 'legacy text with no successor'],
      ]);
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('is a no-op upgrade when the legacy column is already gone', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      // A database that already ran the drop: the column is absent, so the
      // gate has nothing to protect and the DDL is skipped.
      createLegacyDb(dbPath, [{ id: 'WL-DROPPED', audit: null }], { withAuditColumn: false });

      const result = runMigrations({ confirm: true }, dbPath);

      expect(result.applied.map(a => a.id)).toContain('20260604-drop-audit-column');
      expect(columnExists(dbPath, 'workitems', 'audit')).toBe(false);
      expect(tableExists(dbPath, 'legacy_audit_preserved')).toBe(false);
      expect(runMigrations({ confirm: true }, dbPath).applied).toEqual([]);
    } finally {
      cleanupTempDir(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// --dry-run blast-radius summary
// ---------------------------------------------------------------------------

describe('auditPreservationSummary', () => {
  it('reports candidates, mappable, preserve-only and orphaned counts', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDb(dbPath, [
        {
          id: 'WL-S1',
          audit: JSON.stringify({ time: '2026-01-01T00:00:00.000Z', author: 'a', text: 'ok', status: 'Complete' }),
        },
        { id: 'WL-S2', audit: 'unparseable text' },
        { id: 'WL-S3', audit: null },
      ]);
      withDb(dbPath, db => {
        db.exec('CREATE TABLE audit_results (work_item_id TEXT PRIMARY KEY, ready_to_close INTEGER)');
        db.prepare('INSERT INTO audit_results (work_item_id, ready_to_close) VALUES (?, 1)').run('WL-S1');
      });

      const summary = auditPreservationSummary(dbPath);
      expect(summary).not.toBeNull();
      expect(summary!.candidates).toBe(2);
      expect(summary!.mappedToAuditResult).toBe(1);
      expect(summary!.preserveOnly).toBe(1);
      expect(summary!.orphaned).toBe(1); // WL-S2: nothing preserves it yet
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('returns null when the database or the audit column does not exist', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      expect(auditPreservationSummary(dbPath)).toBeNull();
      createLegacyDb(dbPath, [{ id: 'WL-S4', audit: null }], { withAuditColumn: false });
      expect(auditPreservationSummary(dbPath)).toBeNull();
    } finally {
      cleanupTempDir(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// B. `safe` reflects destructiveness; neutralised entries are honest
// ---------------------------------------------------------------------------

describe('migration catalog invariants', () => {
  it('every destructive (safe: false) migration really performs a destructive statement', () => {
    const destructive = MIGRATION_CATALOG.filter(m => !m.safe);
    expect(destructive.length).toBeGreaterThan(0);
    for (const m of destructive) {
      const body = m.apply.toString();
      const performsDestructiveSql = /DROP\s+COLUMN|DROP\s+TABLE|DELETE\s+FROM/i.test(body);
      expect(performsDestructiveSql, `${m.id} is marked safe: false but its apply() is not destructive`).toBe(true);
    }
  });

  it('every neutralised historical migration is safe and performs no destructive statement', () => {
    const neutralised = MIGRATION_CATALOG.filter(m => m.neutralised === true);
    expect(neutralised.length).toBeGreaterThan(0);
    for (const m of neutralised) {
      const body = m.apply.toString();
      expect(m.safe, `${m.id} is neutralised and must be declared safe`).toBe(true);
      expect(/DROP\s+COLUMN|DROP\s+TABLE|DELETE\s+FROM/i.test(body), `${m.id} is neutralised but destructive`).toBe(
        false,
      );
    }
  });

  it('marks the reverted needsProducerReview drop and the legacy audit add as neutralised', () => {
    const byId = new Map(MIGRATION_CATALOG.map(m => [m.id, m]));
    expect(byId.get('20261015-drop-needsProducerReview')!.neutralised).toBe(true);
    expect(byId.get('20261015-drop-needsProducerReview')!.safe).toBe(true);
    expect(byId.get('20260315-add-audit')!.neutralised).toBe(true);
    expect(byId.get('20260315-add-audit')!.safe).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. schemaVersion is state-derived
// ---------------------------------------------------------------------------

describe('schemaVersion is derived from post-run state', () => {
  it('advances to the current version even when nothing was applied', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDb(dbPath, [{ id: 'WL-V1', audit: null }]);
      // Run once so every migration marker is in place.
      runMigrations({ confirm: true }, dbPath);
      // Regress the recorded version to simulate a stale-version database.
      withDb(dbPath, db =>
        db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run('7', 'schemaVersion'),
      );
      expect(listPendingMigrations(dbPath)).toEqual([]);

      const result = runMigrations({ confirm: true }, dbPath);

      expect(result.applied).toEqual([]);
      const version = withDb(
        dbPath,
        db => (db.prepare('SELECT value FROM metadata WHERE key = ?').get('schemaVersion') as any).value,
      );
      expect(version).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      cleanupTempDir(tmp);
    }
  });

  it('does not claim the current version while unsafe migrations remain pending', () => {
    const tmp = createTempDir();
    try {
      const dbPath = path.join(tmp, 'worklog.db');
      createLegacyDb(dbPath, [{ id: 'WL-V2', audit: 'text' }]);

      const result = runMigrations({ confirm: true }, dbPath, { safeOnly: true });

      expect(result.applied.map(a => a.id)).not.toContain('20260604-drop-audit-column');
      expect(listPendingMigrations(dbPath).map(m => m.id)).toContain('20260604-drop-audit-column');
      const version = withDb(
        dbPath,
        db => (db.prepare('SELECT value FROM metadata WHERE key = ?').get('schemaVersion') as any).value,
      );
      expect(version).not.toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      cleanupTempDir(tmp);
    }
  });
});
