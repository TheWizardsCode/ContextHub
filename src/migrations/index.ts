/**
 * Migration runner for Worklog
 * Exposes listPendingMigrations and runMigrations used by `wl doctor upgrade`
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getDefaultDataPath } from '../jsonl.js';

export interface MigrationInfo {
  id: string;
  description: string;
  safe: boolean; // non-destructive
}

interface RunOptions {
  dryRun?: boolean;
  confirm?: boolean;
  logger?: { info: (s: string) => void; error: (s: string) => void };
}

const MIGRATIONS: Array<{ id: string; description: string; safe: boolean; requiredColumn: string; apply: (db: Database.Database) => void }> = [
  {
    id: '20260210-add-needsProducerReview',
    description: 'Add needsProducerReview INTEGER column to workitems (default 0)',
    safe: true,
    requiredColumn: 'needsProducerReview',
    apply: (db: Database.Database) => {
      const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
      const existingCols = new Set(cols.map(c => String(c.name)));
      if (!existingCols.has('needsProducerReview')) {
        // Idempotent add column
        db.exec(`ALTER TABLE workitems ADD COLUMN needsProducerReview INTEGER NOT NULL DEFAULT 0`);
      }
    }
  },
  {
    id: '20260315-add-audit',
    description: 'Legacy: Add audit TEXT column to workitems (now replaced by audit_results table)',
    safe: true,
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
    description: 'Backfill audit_results from existing workitems.audit JSON column',
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
      if (alreadyDone) return;

      // Check if workitems table has an audit column
      const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
      const hasAuditColumn = cols.some(c => String(c.name) === 'audit');
      if (!hasAuditColumn) {
        // No audit column to backfill; mark as done
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('audit_backfill_complete', '1');
        return;
      }

      // Read all workitems that have non-null audit data
      const rows = db.prepare('SELECT id, audit FROM workitems WHERE audit IS NOT NULL AND audit != \'\'').all() as any[];
      const insertStmt = db.prepare('INSERT OR REPLACE INTO audit_results (work_item_id, ready_to_close, audited_at, summary, raw_output, author) VALUES (?, ?, ?, ?, ?, ?)');

      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.audit);
          if (parsed && typeof parsed === 'object' && parsed.text) {
            const readyToClose = parsed.status === 'Complete' ? 1 : 0;
            const auditedAt = parsed.time || '';
            const summary = parsed.text || '';
            const author = parsed.author || '';
            insertStmt.run(row.id, readyToClose, auditedAt, summary, null, author);
          }
        } catch (_e) {
          // Skip invalid JSON entries
        }
      }

      // Mark backfill as complete
      db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('audit_backfill_complete', '1');
    }
  },
  {
    id: '20260604-drop-audit-column',
    description: 'Drop legacy audit TEXT column from workitems table (replaced by audit_results)',
    safe: false,
    requiredColumn: '__meta:audit_column_dropped',
    apply: (db: Database.Database) => {
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
  }
];

function resolveDbPath(dbPath?: string): string {
  if (dbPath) return dbPath;
  const dataPath = getDefaultDataPath();
  return path.join(path.dirname(dataPath), 'worklog.db');
}

export function listPendingMigrations(dbPath?: string): MigrationInfo[] {
  const file = resolveDbPath(dbPath);
  if (!fs.existsSync(file)) {
    // Nothing to migrate if DB doesn't exist
    return [];
  }

  const db = new Database(file, { readonly: true });
  try {
    const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
    const existingCols = new Set(cols.map(c => String(c.name)));
    // Also check which tables exist in the database
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const existingTables = new Set(tables.map(t => t.name));
    // Also check metadata for migration markers
    let existingMeta: Set<string>;
    try {
      const metaRows = db.prepare('SELECT key FROM metadata').all() as any[];
      existingMeta = new Set(metaRows.map(r => String(r.key)));
    } catch (_e) {
      existingMeta = new Set();
    }
    const pending = MIGRATIONS.filter(m => {
        // Sentinel values starting with __table: represent table-existence checks
        if (m.requiredColumn.startsWith('__table:')) {
          const tableName = m.requiredColumn.slice('__table:'.length);
          return !existingTables.has(tableName);
        }
        // Sentinel values starting with __meta: represent metadata-key checks
        if (m.requiredColumn.startsWith('__meta:')) {
          const metaKey = m.requiredColumn.slice('__meta:'.length);
          return !existingMeta.has(metaKey);
        }
        return !existingCols.has(m.requiredColumn);
      })
      .map(m => ({ id: m.id, description: m.description, safe: m.safe }));
    return pending;
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
    return { applied: [], backups: [] };
  }

  if (opts.dryRun) {
    return { applied: pending, backups: [] };
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
      for (const m of MIGRATIONS) {
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
          applied.push({ id: m.id, description: m.description, safe: m.safe });
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

      // Update metadata schemaVersion deterministically to current schema.
      try {
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('schemaVersion', '8');
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
