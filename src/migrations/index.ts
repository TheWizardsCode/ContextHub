/**
 * Migration runner for Worklog
 * Exposes listPendingMigrations and runMigrations used by `wl doctor upgrade`
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getDefaultDataPath } from '../jsonl.js';

/** The schema version this build writes once every migration is applied. */
export const CURRENT_SCHEMA_VERSION = '9';

/**
 * The preservation store for legacy `workitems.audit` text that cannot be
 * mapped onto `audit_results` (WL-0MW1W61CG005K893). Deliberately a dedicated
 * table rather than `audit_results.raw_output`: `getAuditResult()` treats any
 * existing `audit_results` row as a real verdict (`readyToClose: false`), so
 * parking unmappable legacy text there would misrepresent those items as
 * "audited and rejected" in `wl next`, the audit gates and the JSONL export.
 */
const LEGACY_AUDIT_PRESERVED_TABLE = 'legacy_audit_preserved';

export interface MigrationInfo {
  id: string;
  description: string;
  safe: boolean; // non-destructive
  /**
   * True for a historical entry kept only for its metadata sentinel: it
   * performs no schema change (WL-0MW1W61CG005K893). Neutralised entries are
   * always `safe` and are rendered as `no-op (historical)` so a reader cannot
   * mistake one for a destructive migration.
   */
  neutralised?: boolean;
}

interface MigrationEntry {
  id: string;
  description: string;
  safe: boolean;
  neutralised?: boolean;
  requiredColumn: string;
  apply: (db: Database.Database) => void;
}

interface RunOptions {
  dryRun?: boolean;
  confirm?: boolean;
  logger?: { info: (s: string) => void; error: (s: string) => void };
}

/**
 * Raised when a migration refuses to run because doing so would destroy data
 * that has not been preserved. `runMigrations` applies every migration inside a
 * single transaction, so a throw rolls the whole run back: nothing is dropped,
 * the migration stays pending, `schemaVersion` is untouched.
 */
export class MigrationUnsafeError extends Error {
  readonly migrationId: string;
  readonly offendingIds: string[];

  constructor(migrationId: string, offendingIds: string[], detail?: string) {
    const shown = offendingIds.slice(0, 10).join(', ');
    const more = offendingIds.length > 10 ? `, +${offendingIds.length - 10} more` : '';
    super(
      `Refusing to run ${migrationId}: ${offendingIds.length} legacy audit value(s) would be destroyed ` +
        `(${detail ?? 'no preserved copy'}): ${shown}${more}. ` +
        'Nothing was changed — the migration stays pending.',
    );
    this.name = 'MigrationUnsafeError';
    this.migrationId = migrationId;
    this.offendingIds = offendingIds;
  }
}

/**
 * The full migration catalog. Exported for tooling and for the migration
 * invariant lint (destructiveness vs `safe`/`neutralised`); the CLI contract is
 * `listPendingMigrations` / `runMigrations`.
 */
export const MIGRATION_CATALOG: MigrationEntry[] = [
  {
    id: '20260210-add-needsProducerReview',
    description: 'Add needsProducerReview INTEGER column to workitems (default 0)',
    safe: true,
    neutralised: true,
    requiredColumn: '__meta:needsProducerReview_added',
    apply: (db: Database.Database) => {
      // Historical migration — preserved for history (WL-0MV85WFYU0071YQ9).
      // The column has been dropped by 20261015-drop-needsProducerReview;
      // this entry must never re-add it, so it only records completion via a
      // metadata sentinel (mirrors the add-audit migration's noop pattern).
      try {
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('needsProducerReview_added', '1');
      } catch (_e) { /* best-effort */ }
    }
  },
  {
    id: '20260315-add-audit',
    description: 'Legacy: Add audit TEXT column to workitems (now replaced by audit_results table)',
    safe: true,
    neutralised: true,
    requiredColumn: '__meta:audit_migration_noop',
    apply: (db: Database.Database) => {
      // This migration is now a no-op. The audit column has been replaced by the
      // audit_results table. If the audit column doesn't exist, we skip adding it
      // since it will be dropped anyway by the 20260604-drop-audit-column migration.
      // If it already exists (legacy databases), we leave it in place for the
      // backfill migration to read from before the drop migration removes it.
      try {
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('audit_migration_noop', '1');
      } catch (_e) { /* best-effort */ }
    }
  },
  {
    id: '20260604-add-audit-results',
    description: 'Add audit_results table for structured audit storage (latest-only per work item)',
    safe: true,
    requiredColumn: '__table:audit_results',
    apply: (db: Database.Database) => {
      // Check if audit_results table already exists
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_results'").all() as any[];
      if (tables.length === 0) {
        db.exec(`
          CREATE TABLE audit_results (
            work_item_id TEXT PRIMARY KEY,
            ready_to_close INTEGER NOT NULL DEFAULT 0,
            audited_at TEXT NOT NULL,
            summary TEXT,
            raw_output TEXT,
            author TEXT,
            FOREIGN KEY (work_item_id) REFERENCES workitems(id) ON DELETE CASCADE
          )
        `);
      }
    }
  },
  {
    id: '20260604-backfill-audit-results',
    description: 'Backfill audit_results from existing workitems.audit JSON column (lossless: unmappable values are preserved verbatim)',
    safe: true,
    requiredColumn: '__meta:audit_backfill_complete',
    apply: (db: Database.Database) => {
      // Check if backfill has already been done
      let alreadyDone = false;
      try {
        const metaRow = db.prepare('SELECT value FROM metadata WHERE key = ?').get('audit_backfill_complete');
        if (metaRow && String((metaRow as any).value) === '1') {
          alreadyDone = true;
        }
      } catch (_e) { /* metadata table may not exist */ }

      if (!alreadyDone) {
        // Check if workitems table has an audit column
        const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
        const hasAuditColumn = cols.some(c => String(c.name) === 'audit');
        if (hasAuditColumn) {
          // Read all workitems that have non-empty audit data
          const rows = db.prepare(`SELECT id, audit FROM workitems WHERE audit IS NOT NULL AND trim(audit) != ''`).all() as any[];
          const insertStmt = db.prepare('INSERT OR REPLACE INTO audit_results (work_item_id, ready_to_close, audited_at, summary, raw_output, author) VALUES (?, ?, ?, ?, ?, ?)');

          let mapped = 0;
          for (const row of rows) {
            const mappedAudit = mapLegacyAudit(row.audit);
            // An unmappable value is NOT skipped: the preservation sweep below
            // stores it verbatim so the drop migration can never destroy it
            // (WL-0MW1W61CG005K893).
            if (mappedAudit === null) continue;
            // `raw_output` carries the verbatim source text as provenance for
            // every mapped row, so the legacy column is reproducible.
            insertStmt.run(
              row.id,
              mappedAudit.readyToClose,
              mappedAudit.auditedAt,
              mappedAudit.summary,
              String(row.audit),
              mappedAudit.author,
            );
            mapped += 1;
          }
          try {
            db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
              'audit_backfill_stats',
              JSON.stringify({ candidates: rows.length, mapped, unmappable: rows.length - mapped }),
            );
          } catch (_e) { /* best-effort observability */ }
        }

        // Mark backfill as complete
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('audit_backfill_complete', '1');
      }

      // Always sweep, even when the marker is already set: a database migrated
      // by the pre-fix runner has the marker but left unmappable values in
      // place, and only the sweep makes the drop gate converge.
      preserveLegacyAuditText(db);
    }
  },
  {
    id: '20260604-drop-audit-column',
    description: 'Drop legacy audit TEXT column from workitems table (replaced by audit_results)',
    safe: false,
    requiredColumn: '__meta:audit_column_dropped',
    apply: (db: Database.Database) => {
      // Safety gate (WL-0MW1W61CG005K893): the legacy column is the only copy of
      // any audit value the backfill could not map. Preserve whatever is left,
      // then refuse to drop while anything is unaccounted for. A throw aborts
      // the whole `runMigrations` transaction, so this migration stays pending
      // and no data is lost.
      if (auditColumnPresent(db)) {
        ensureLegacyAuditPreservedTable(db);
        preserveLegacyAuditText(db);
        assertAuditTextPreserved(db);
      }

      // SQLite 3.35.0+ supports ALTER TABLE DROP COLUMN
      // Check if the audit column still exists before dropping
      const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
      const existingCols = new Set(cols.map(c => String(c.name)));
      if (existingCols.has('audit')) {
        db.exec(`ALTER TABLE workitems DROP COLUMN audit`);
      }
      // Mark migration as complete
      try {
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('audit_column_dropped', '1');
      } catch (_e) { /* best-effort */ }
    }
  },
  {
    id: '20260821-add-last-export-timestamps',
    description: 'Add last_export_timestamps table for per-record-type delta sync watermarks',
    safe: true,
    requiredColumn: '__table:last_export_timestamps',
    apply: (db: Database.Database) => {
      // Idempotent table creation for existing databases (new DBs get it in
      // initializeSchema). Row values are upserted at runtime by the store.
      db.exec(`
        CREATE TABLE IF NOT EXISTS last_export_timestamps (
          record_type TEXT PRIMARY KEY,
          exported_at TEXT NOT NULL
        )
      `);
    }
  },
  {
    id: '20260923-add-audit-fingerprint',
    description: 'Add nullable fingerprint column to audit_results for content-based freshness gate (WL-0MUBVH5S0008NQ9K)',
    safe: true,
    requiredColumn: '__meta:audit_fingerprint_added',
    apply: (db: Database.Database) => {
      const cols = db.prepare(`PRAGMA table_info('audit_results')`).all() as any[];
      const hasFingerprint = cols.some(c => String(c.name) === 'fingerprint');
      if (!hasFingerprint) {
        db.exec(`ALTER TABLE audit_results ADD COLUMN fingerprint TEXT`);
      }
      // Mark the migration complete so the runner treats it as idempotent even
      // though the target column lives in audit_results, not workitems (the
      // plain requiredColumn check only inspects workitems). Mirrors the
      // `drop-audit-column` migration's metadata sentinel pattern.
      try {
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('audit_fingerprint_added', '1');
      } catch (_e) { /* best-effort */ }
    }
  },
  {
    id: '20260923-add-activity-at',
    description: 'Add nullable activityAt column to workitems so comment writes no longer bump updatedAt (WL-0MUBVH6JM0093KVM)',
    safe: true,
    requiredColumn: 'activityAt',
    apply: (db: Database.Database) => {
      const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
      if (!cols.some(c => String(c.name) === 'activityAt')) {
        db.exec(`ALTER TABLE workitems ADD COLUMN activityAt TEXT`);
      }
    }
  },
  {
    id: '20260928-add-audit-waiver',
    description: 'Add nullable auditWaiver JSON column to workitems for the explicit no-audit gate waiver (WL-0MUBVH9FV0027COG)',
    safe: true,
    requiredColumn: 'auditWaiver',
    apply: (db: Database.Database) => {
      const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
      if (!cols.some(c => String(c.name) === 'auditWaiver')) {
        db.exec(`ALTER TABLE workitems ADD COLUMN auditWaiver TEXT`);
      }
    }
  },
  {
    id: '20261015-drop-needsProducerReview',
    description: 'Legacy: Drop needsProducerReview column (reverted — the flag was restored by 20261016-restore-needsProducerReview)',
    // NEUTRALISED (WL-0MVAMS4RO000H3B0 F2), so it is NOT destructive and must
    // not be advertised as such: the entry only writes its sentinel
    // (WL-0MW1W61CG005K893).
    safe: true,
    neutralised: true,
    requiredColumn: '__meta:needsProducerReview_dropped',
    apply: (db: Database.Database) => {
      // NEUTRALISED (WL-0MVAMS4RO000H3B0 F2): the removal was a wrongful
      // deletion (RCA WL-0MVAOYBZM0065AEN); the flag is restored by
      // 20261016-restore-needsProducerReview. This historical entry must
      // never drop the column again, so it only records completion via a
      // metadata sentinel (mirrors the add-audit noop pattern). Existing
      // databases that already applied the original drop keep the sentinel
      // and the restore migration re-adds the column.
      try {
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('needsProducerReview_dropped', '1');
      } catch (_e) { /* best-effort */ }
    }
  },
  {
    id: '20261016-restore-needsProducerReview',
    description: 'Restore needsProducerReview column (re-add after the reverted removal) and convert producer-hold assignees (WL-0MVAMS4RO000H3B0 F2)',
    safe: true,
    requiredColumn: 'needsProducerReview',
    apply: (db: Database.Database) => {
      // Re-add the column when it is missing (fresh databases get it from the
      // persistent-store schema; already-migrated databases lost it to the
      // now-neutralised drop migration). Idempotent.
      const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
      const existingCols = new Set(cols.map(c => String(c.name)));
      if (!existingCols.has('needsProducerReview')) {
        db.exec(`ALTER TABLE workitems ADD COLUMN needsProducerReview INTEGER NOT NULL DEFAULT 0`);
      }
      // Q3=A conversion: any surviving producer-hold item (assignee 'Map',
      // the retired assignee-hold convention) is marked as needing producer
      // review so the review queue is not silently emptied by the restore.
      try {
        db.exec(`UPDATE workitems SET needsProducerReview = 1 WHERE trim(assignee) = 'Map' AND needsProducerReview = 0`);
      } catch (_e) { /* best-effort: columns may be absent on partial schemas */ }
    }
  },
  {
    id: '20261102-drop-dependency-edge-target-fk',
    description:
      'Drop the dependency_edges.toId foreign key so an edge may target a foreign (cross-project) item (WL-0MVWABT2Z001XMSD D2)',
    safe: true,
    requiredColumn: '__meta:dependency_edges_foreign_target',
    apply: (db: Database.Database) => {
      // A cross-repo dependency edge is stored locally with a foreign id as
      // `toId` (D2), which the original `toId` foreign key rejected. Rebuild
      // the table without that key, keeping the local `fromId` constraint.
      // Idempotent: a database already created from the current schema has no
      // `toId` foreign key and is left untouched.
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dependency_edges'")
        .all() as any[];
      if (tables.length > 0) {
        const fks = db.prepare(`PRAGMA foreign_key_list('dependency_edges')`).all() as any[];
        const hasTargetForeignKey = fks.some((fk) => String(fk.from) === 'toId');
        if (hasTargetForeignKey) {
          db.exec(`
            CREATE TABLE dependency_edges_new (
              fromId TEXT NOT NULL,
              toId TEXT NOT NULL,
              createdAt TEXT NOT NULL,
              PRIMARY KEY (fromId, toId),
              FOREIGN KEY (fromId) REFERENCES workitems(id) ON DELETE CASCADE
            );
            INSERT OR IGNORE INTO dependency_edges_new (fromId, toId, createdAt)
              SELECT fromId, toId, createdAt FROM dependency_edges;
            DROP TABLE dependency_edges;
            ALTER TABLE dependency_edges_new RENAME TO dependency_edges;
            CREATE INDEX IF NOT EXISTS idx_dependency_edges_fromId ON dependency_edges(fromId);
            CREATE INDEX IF NOT EXISTS idx_dependency_edges_toId ON dependency_edges(toId);
          `);
        }
      }
      db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
        'dependency_edges_foreign_target',
        '1',
      );
    }
  }
];

function resolveDbPath(dbPath?: string): string {
  if (dbPath) return dbPath;
  const dataPath = getDefaultDataPath();
  return path.join(path.dirname(dataPath), 'worklog.db');
}

// ── Legacy audit-text preservation (WL-0MW1W61CG005K893) ────────────────

type MappedLegacyAudit = {
  readyToClose: number;
  auditedAt: string;
  summary: string;
  author: string;
};

/**
 * Map one legacy `workitems.audit` value onto the `audit_results` columns.
 * Returns `null` when the value cannot be represented (invalid JSON, a bare
 * string, an object without `.text`, an array): those values are preserved
 * verbatim instead of being dropped with the column.
 */
function mapLegacyAudit(raw: unknown): MappedLegacyAudit | null {
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!(parsed as any).text) return null;
    return {
      readyToClose: (parsed as any).status === 'Complete' ? 1 : 0,
      auditedAt: (parsed as any).time || '',
      summary: String((parsed as any).text),
      author: (parsed as any).author || '',
    };
  } catch (_e) {
    return null;
  }
}

function tablePresent(db: Database.Database, name: string): boolean {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .all(name) as any[];
  return rows.length > 0;
}

/** True when `workitems` still carries the legacy `audit` TEXT column. */
function auditColumnPresent(db: Database.Database): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
    return cols.some(c => String(c.name) === 'audit');
  } catch (_e) {
    return false;
  }
}

function ensureLegacyAuditPreservedTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LEGACY_AUDIT_PRESERVED_TABLE} (
    work_item_id TEXT PRIMARY KEY,
    audit_text TEXT NOT NULL,
    preserved_at TEXT NOT NULL
  )`);
}

/**
 * Rows whose non-empty legacy audit text has no successor in `audit_results`
 * and no preservation row — i.e. text the drop would destroy.
 */
function orphanedLegacyAuditIds(db: Database.Database): string[] {
  if (!auditColumnPresent(db)) return [];
  const hasResults = tablePresent(db, 'audit_results');
  const hasPreserved = tablePresent(db, LEGACY_AUDIT_PRESERVED_TABLE);
  const rows = db
    .prepare(
      `SELECT w.id AS id FROM workitems w
        WHERE w.audit IS NOT NULL AND trim(w.audit) <> ''
        ${hasResults ? 'AND NOT EXISTS (SELECT 1 FROM audit_results a WHERE a.work_item_id = w.id)' : ''}
        ${hasPreserved ? `AND NOT EXISTS (SELECT 1 FROM ${LEGACY_AUDIT_PRESERVED_TABLE} p WHERE p.work_item_id = w.id)` : ''}
        ORDER BY w.id`,
    )
    .all() as any[];
  return rows.map(r => String(r.id));
}

/**
 * Store the verbatim text of every legacy audit value that has no
 * `audit_results` successor, so the column can be dropped without losing
 * anything. Idempotent (`INSERT OR IGNORE`). Returns the number of rows newly
 * preserved. Exported for tests and for the drop-migration gate.
 */
export function preserveLegacyAuditText(db: Database.Database): number {
  if (!auditColumnPresent(db)) return 0;
  ensureLegacyAuditPreservedTable(db);
  const hasResults = tablePresent(db, 'audit_results');
  const rows = db
    .prepare(
      `SELECT w.id AS id, w.audit AS audit FROM workitems w
        WHERE w.audit IS NOT NULL AND trim(w.audit) <> ''
        ${hasResults ? 'AND NOT EXISTS (SELECT 1 FROM audit_results a WHERE a.work_item_id = w.id)' : ''}`,
    )
    .all() as any[];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ${LEGACY_AUDIT_PRESERVED_TABLE} (work_item_id, audit_text, preserved_at) VALUES (?, ?, ?)`,
  );
  const now = new Date().toISOString();
  let preserved = 0;
  for (const row of rows) {
    preserved += stmt.run(String(row.id), String(row.audit), now).changes;
  }
  return preserved;
}

/**
 * Refuse to drop the legacy audit column while any non-empty value has no
 * preserved copy. Throws {@link MigrationUnsafeError}, which aborts the whole
 * `runMigrations` transaction.
 */
export function assertAuditTextPreserved(db: Database.Database): void {
  const orphans = orphanedLegacyAuditIds(db);
  if (orphans.length > 0) {
    throw new MigrationUnsafeError('20260604-drop-audit-column', orphans);
  }
}

/** Blast-radius report for `wl doctor upgrade --dry-run`. */
export interface AuditPreservationSummary {
  /** Items still carrying non-empty legacy audit text. */
  candidates: number;
  /** Candidates already represented in `audit_results`. */
  mappedToAuditResult: number;
  /** Candidates whose text would be (or was) preserved verbatim. */
  preserveOnly: number;
  /** Candidates with a preservation row already in place. */
  alreadyPreserved: number;
  /** Candidates the drop would currently destroy (the gate refuses). */
  orphaned: number;
}

/**
 * Read-only preservation summary for a worklog database. Returns `null` when
 * the database does not exist, has no `workitems` table, or no longer carries
 * the legacy `audit` column (nothing to lose).
 */
export function auditPreservationSummary(dbPath?: string): AuditPreservationSummary | null {
  const file = resolveDbPath(dbPath);
  if (!fs.existsSync(file)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true });
    if (!tablePresent(db, 'workitems')) return null;
    if (!auditColumnPresent(db)) return null;
    const count = (sql: string): number => {
      try {
        const row = db!.prepare(sql).get() as any;
        return Number(row?.n ?? 0);
      } catch (_e) {
        return 0;
      }
    };
    const base = `FROM workitems w WHERE w.audit IS NOT NULL AND trim(w.audit) <> ''`;
    const candidates = count(`SELECT COUNT(*) AS n ${base}`);
    const hasResults = tablePresent(db, 'audit_results');
    const hasPreserved = tablePresent(db, LEGACY_AUDIT_PRESERVED_TABLE);
    const mappedToAuditResult = hasResults
      ? count(`SELECT COUNT(*) AS n ${base} AND EXISTS (SELECT 1 FROM audit_results a WHERE a.work_item_id = w.id)`)
      : 0;
    const alreadyPreserved = hasPreserved
      ? count(
          `SELECT COUNT(*) AS n ${base} AND EXISTS (SELECT 1 FROM ${LEGACY_AUDIT_PRESERVED_TABLE} p WHERE p.work_item_id = w.id)`,
        )
      : 0;
    return {
      candidates,
      mappedToAuditResult,
      preserveOnly: Math.max(0, candidates - mappedToAuditResult),
      alreadyPreserved,
      orphaned: orphanedLegacyAuditIds(db).length,
    };
  } catch (_e) {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Which migrations are still pending against an open database, by the same
 * `requiredColumn` contract `listPendingMigrations` uses.
 */
function computePending(db: Database.Database): MigrationInfo[] {
  let existingCols: Set<string>;
  try {
    const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
    existingCols = new Set(cols.map(c => String(c.name)));
  } catch (_e) {
    existingCols = new Set();
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
  const existingTables = new Set(tables.map(t => String(t.name)));
  let existingMeta: Set<string>;
  try {
    const metaRows = db.prepare('SELECT key FROM metadata').all() as any[];
    existingMeta = new Set(metaRows.map(r => String(r.key)));
  } catch (_e) {
    existingMeta = new Set();
  }
  return MIGRATION_CATALOG.filter(m => {
    if (m.requiredColumn.startsWith('__table:')) {
      return !existingTables.has(m.requiredColumn.slice('__table:'.length));
    }
    if (m.requiredColumn.startsWith('__meta:')) {
      return !existingMeta.has(m.requiredColumn.slice('__meta:'.length));
    }
    return !existingCols.has(m.requiredColumn);
  }).map(m => toMigrationInfo(m));
}

function toMigrationInfo(m: MigrationEntry): MigrationInfo {
  const info: MigrationInfo = { id: m.id, description: m.description, safe: m.safe };
  if (m.neutralised === true) info.neutralised = true;
  return info;
}

export function listPendingMigrations(dbPath?: string): MigrationInfo[] {
  const file = resolveDbPath(dbPath);
  if (!fs.existsSync(file)) {
    // Nothing to migrate if DB doesn't exist
    return [];
  }

  const db = new Database(file, { readonly: true });
  try {
    return computePending(db);
  } finally {
    db.close();
  }
}

function makeBackup(dbPath: string, logger?: { info: (s: string) => void; error: (s: string) => void }): string {
  const dir = path.dirname(dbPath);
  const backupsDir = path.join(dir, 'backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:]/g, '').replace(/\..+/, '');
  const base = path.basename(dbPath);
  const out = path.join(backupsDir, `${base}.${ts}`);

  fs.copyFileSync(dbPath, out);
  // Prune to last 5 backups
  const files = fs.readdirSync(backupsDir)
    .map(f => ({ f, full: path.join(backupsDir, f), mtime: fs.statSync(path.join(backupsDir, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);
  const keep = 5;
  for (let i = keep; i < files.length; i += 1) {
    try {
      fs.unlinkSync(files[i].full);
    } catch (err) {
      // ignore errors while pruning
      logger?.error?.(`Failed to prune old backup ${files[i].full}: ${(err as Error).message}`);
    }
  }

  logger?.info?.(`Created backup: ${out}`);
  return out;
}

export function runMigrations(opts: RunOptions = {}, dbPath?: string, filter?: { safeOnly?: boolean }): { applied: MigrationInfo[]; backups: string[] } {
  const file = resolveDbPath(dbPath);
  const logger = opts.logger || { info: () => {}, error: () => {} };
  if (!fs.existsSync(file)) {
    return { applied: [], backups: [] };
  }

  const pending = listPendingMigrations(file);
  if (pending.length === 0) {
    // Nothing to migrate. The recorded version can still be stale (a database
    // whose columns were patched out-of-band, or one migrated by an older
    // build), and that state must be correctable — otherwise the
    // "schemaVersion=X but the application expects Y" warning is permanent
    // (WL-0MW1W61CG005K893).
    if (!opts.dryRun) advanceSchemaVersion(file, logger);
    return { applied: [], backups: [] };
  }

  const applicable = filter?.safeOnly ? pending.filter(p => p.safe) : pending;

  if (opts.dryRun) {
    return { applied: applicable, backups: [] };
  }

  if (applicable.length === 0) {
    // Only migrations the caller declined to run are pending: leave the
    // recorded version alone so the next full run is still advertised.
    return { applied: [], backups: [] };
  }

  // If any migrations are present and not confirmed, error.
  if (!opts.confirm) {
    throw new Error('Migrations present but not confirmed. Rerun with --confirm to apply.');
  }

  // Create backup before applying
  let backupPath = '';
  try {
    backupPath = makeBackup(file, logger);
  } catch (err) {
    throw new Error(`Failed to create backup before applying migrations: ${(err as Error).message}`);
  }

  const db = new Database(file);
  const applied: MigrationInfo[] = [];
  try {
    const tx = db.transaction(() => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
      const existingTables = new Set(tables.map(t => t.name));
      let existingMeta: Set<string>;
      try {
        const metaRows = db.prepare('SELECT key FROM metadata').all() as any[];
        existingMeta = new Set(metaRows.map(r => String(r.key)));
      } catch (_e) {
        existingMeta = new Set();
      }
      for (const m of MIGRATION_CATALOG) {
        if (filter?.safeOnly && !m.safe) continue;
        // Sentinel values starting with __table: represent table-existence checks
        // Sentinel values starting with __meta: represent metadata-key checks
        let alreadyApplied: boolean;
        if (m.requiredColumn.startsWith('__table:')) {
          const tableName = m.requiredColumn.slice('__table:'.length);
          alreadyApplied = existingTables.has(tableName);
        } else if (m.requiredColumn.startsWith('__meta:')) {
          const metaKey = m.requiredColumn.slice('__meta:'.length);
          alreadyApplied = existingMeta.has(metaKey);
        } else {
          const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
          const existingCols = new Set(cols.map(c => String(c.name)));
          alreadyApplied = existingCols.has(m.requiredColumn);
        }
        if (!alreadyApplied) {
          m.apply(db);
          applied.push(toMigrationInfo(m));
          // Refresh metadata set after each migration in case a migration adds a metadata key
          try {
            const metaRows = db.prepare('SELECT key FROM metadata').all() as any[];
            existingMeta = new Set(metaRows.map(r => String(r.key)));
          } catch (_e) { /* best-effort */ }
          // Refresh tables set after each migration in case a migration creates a table
          const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
          existingTables.clear();
          for (const row of t) existingTables.add(row.name);
        }
      }

      // Record the version only when the schema is genuinely at HEAD. Writing
      // it unconditionally (the pre-fix behaviour) claimed HEAD while a
      // `safeOnly` filter had left unsafe migrations pending
      // (WL-0MW1W61CG005K893).
      try {
        const remaining = computePending(db);
        if (remaining.length === 0) {
          db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
            'schemaVersion',
            CURRENT_SCHEMA_VERSION,
          );
        } else {
          logger.info?.(
            `Not advancing metadata.schemaVersion: ${remaining.length} migration(s) still pending ` +
              `(${remaining.map(r => r.id).join(', ')})`,
          );
        }
      } catch (err) {
        // Best-effort: don't fail migration if metadata update fails, but log
        logger.error?.(`Failed to update metadata.schemaVersion: ${(err as Error).message}`);
      }
    });

    tx();
  } finally {
    db.close();
  }

  return { applied, backups: backupPath ? [backupPath] : [] };
}

/**
 * Best-effort write of the current schema version for a database that has no
 * pending migrations. Called on the zero-pending path so a stale recorded
 * version cannot produce a permanent "expects schemaVersion=9" warning
 * (WL-0MW1W61CG005K893).
 */
function advanceSchemaVersion(
  file: string,
  logger: { info: (s: string) => void; error: (s: string) => void },
): void {
  let db: Database.Database | null = null;
  try {
    db = new Database(file);
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('schemaVersion') as any;
    if (row && String(row.value) === CURRENT_SCHEMA_VERSION) return;
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
      'schemaVersion',
      CURRENT_SCHEMA_VERSION,
    );
  } catch (err) {
    logger.error?.(`Failed to update metadata.schemaVersion: ${(err as Error).message}`);
  } finally {
    db?.close();
  }
}
