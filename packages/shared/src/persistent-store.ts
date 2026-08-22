/**
 * SQLite-based persistent storage for work items and comments
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { WorkItem, Comment, DependencyEdge, AuditResult } from './types.js';
import { normalizeStatusValue } from './status-stage-rules.js';

/**
 * Info about a pending schema migration.
 */
export interface MigrationInfo {
  id: string;
  description: string;
  safe: boolean;
}

/**
 * Optional services for SqlitePersistentStore.
 */
export interface PersistentStoreServices {
  /**
   * Optional function to list pending migrations.
   * When not provided, the schema-version warning message omits the migration list.
   */
  listPendingMigrations?: (dbPath: string) => MigrationInfo[];
}

/**
 * Result from a full-text search query
 */
export interface FtsSearchResult {
  /** The work item ID */
  itemId: string;
  /** BM25 relevance score (lower = more relevant in SQLite FTS5) */
  rank: number;
  /** Snippet with highlighted matches */
  snippet: string;
  /** Which column the snippet was extracted from */
  matchedColumn: string;
}

interface DbMetadata {
  lastJsonlImportMtime?: number;
  lastJsonlImportAt?: string;
  schemaVersion: number;
}

/**
 * Per-record-type last-export timestamps used for delta-aware export
 * (WL-0MT2KWFUJ001OGHF / WL-0MSAKUBKW006FN8Q).
 *
 * Records whose `updatedAt` (or `createdAt` for comments) is strictly greater
 * than the corresponding timestamp are considered dirty and eligible for a
 * delta (incremental) export. An absent/missing type timestamp means "no
 * baseline" → treat all records of that type as dirty (full export).
 */
export interface LastExportTimestamps {
  workitems?: string; // ISO 8601 — items changed after this are dirty
  comments?: string;  // ISO 8601 — comments created after this are dirty
  edges?: string;     // ISO 8601 — dependency edges created after this are dirty
  audit_results?: string; // ISO 8601 — audit results after this are dirty
}

const SCHEMA_VERSION = 8;

// ── In-memory cache types (Phase 5) ────────────────────────────────

/**
 * A single entry in the in-memory query cache.
 */
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * Optional caching configuration for SqlitePersistentStore.
 * When not provided, caching defaults are used.
 */
export interface PersistentStoreCacheOptions {
  /**
   * Enable/disable the in-memory query cache.
   * Default: true (enabled).
   */
  enabled?: boolean;
  /**
   * Time-to-live for cached entries in milliseconds.
   * Default: 5000 (5 seconds). Set to 0 to disable caching.
   */
  ttlMs?: number;
  /**
   * Maximum number of cache entries.
   * Default: 500. Oldest entries are evicted when the limit is exceeded.
   */
  maxEntries?: number;
}

/**
 * Normalize a single value for use as a better-sqlite3 binding parameter.
 * better-sqlite3 only accepts: number, string, bigint, Buffer, or null.
 * This function converts unsupported types:
 *  - undefined  -> null
 *  - null       -> null (passthrough)
 *  - boolean    -> 1 or 0
 *  - Date       -> ISO 8601 string via toISOString()
 *  - object/array -> JSON string via JSON.stringify (fallback to String())
 *  - number, string, bigint, Buffer -> passthrough
 */
export function normalizeSqliteValue(v: unknown): number | string | bigint | Buffer | null {
  if (v === undefined) return null;
  if (v === null) return null;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'bigint' || Buffer.isBuffer(v)) {
    return v as number | string | bigint | Buffer;
  }
  if (t === 'boolean') return (v as boolean) ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  // Fallback: stringify objects (arrays, plain objects, etc.)
  try {
    return JSON.stringify(v);
  } catch (_err) {
    return String(v);
  }
}

/**
 * Normalize an array of values for use as better-sqlite3 binding parameters.
 * Applies {@link normalizeSqliteValue} to each element.
 */
export function normalizeSqliteBindings(values: unknown[]): Array<number | string | bigint | Buffer | null> {
  return values.map(normalizeSqliteValue);
}

/**
 * Unescape backslash escape sequences in a plain-text string before persisting.
 * Converts common two-character escape artifacts (e.g. backslash-n from CLI
 * argument passing) into their actual character equivalents so stored text is
 * human-readable and free of accidental escape artifacts.
 *
 * Only the following sequences are converted (single-pass, left-to-right):
 *   \n  -> newline
 *   \t  -> tab
 *   \r  -> carriage return
 *   \\  -> single backslash
 *
 * All other characters (including quotes and backticks) are left unchanged.
 * This function must NOT be applied to JSON strings or structured fields.
 */
export function unescapeText(s: string): string {
  const map: Record<string, string> = { '\\': '\\', n: '\n', t: '\t', r: '\r' };
  return s.replace(/\\(\\|n|t|r)/g, (_, c: string) => map[c]);
}

export class SqlitePersistentStore {
  private db: Database.Database;
  private dbPath: string;
  private verbose: boolean;
  private _ftsAvailable: boolean = false;
  private _listPendingMigrations?: (dbPath: string) => MigrationInfo[];

  // ── In-memory cache state (Phase 5) ──────────────────────────────────
  private _cacheEnabled: boolean;
  private _cacheTtlMs: number;
  private _cacheMaxEntries: number;
  private _cache = new Map<string, CacheEntry>();

  constructor(dbPath: string, verbose: boolean = false, services?: PersistentStoreServices, cacheOptions?: PersistentStoreCacheOptions) {
    this._listPendingMigrations = services?.listPendingMigrations;
    this.dbPath = dbPath;
    this.verbose = verbose;

    // Initialize cache settings (Phase 5)
    const envCache = process.env.WL_CACHE_ENABLED !== '0';
    this._cacheEnabled = cacheOptions?.enabled ?? envCache;
    const envTtl = parseInt(process.env.WL_CACHE_TTL_MS ?? '', 10);
    this._cacheTtlMs = cacheOptions?.ttlMs ?? (Number.isFinite(envTtl) ? envTtl : 5000);
    this._cacheMaxEntries = cacheOptions?.maxEntries ?? 500;
    
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (error) {
        throw new Error(`Failed to create database directory ${dir}: ${(error as Error).message}`);
      }
    }

    // Open/create database
    try {
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL'); // Better concurrency
      this.db.pragma('foreign_keys = ON');
      // Keep TUI reads responsive under write contention by using a shorter
      // busy timeout in TUI mode. Override via WL_SQLITE_BUSY_TIMEOUT_MS.
      const configuredBusyTimeout = Number(process.env.WL_SQLITE_BUSY_TIMEOUT_MS);
      const busyTimeoutMs = Number.isFinite(configuredBusyTimeout)
        ? configuredBusyTimeout
        : (process.env.WL_TUI_MODE === '1' ? 250 : 5000);
      this.db.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    } catch (error) {
      throw new Error(`Failed to open database ${dbPath}: ${(error as Error).message}`);
    }
    
    // Initialize schema
    try {
      this.initializeSchema();
    } catch (error) {
      throw new Error(`Failed to initialize database schema: ${(error as Error).message}`);
    }

    // Initialize FTS5 index (best-effort; falls back to app-level search if unavailable)
    this._ftsAvailable = this.initializeFts();
  }

  /**
   * Whether FTS5 full-text search is available in this SQLite build
   */
  get ftsAvailable(): boolean {
    return this._ftsAvailable;
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    // Create metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Create work items table
    this.db.exec(`
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
        ,needsProducerReview INTEGER NOT NULL DEFAULT 0
       )
    `);

    // NOTE: Historically this method performed non-destructive schema migrations
    // (ALTER TABLE ADD COLUMN ...) when opening an existing database. That caused
    // silent schema changes on first-run after upgrading the CLI with no backup
    // or audit trail. Migrations are now centralized in src/migrations and
    // surfaced via `wl doctor upgrade` so operators may review and back up the
    // database before applying changes. To preserve compatibility for new
    // databases we still create the necessary tables; however, we no longer
    // modify existing databases here.

    // If the database is newly created (no schemaVersion metadata present) set
    // the current schema version so the migration runner can detect pending
    // migrations on existing DBs. We avoid altering existing databases here.
    const schemaVersionRaw = this.getMetadata('schemaVersion');
    const isNewDb = !schemaVersionRaw;
    if (isNewDb) {
      this.setMetadata('schemaVersion', SCHEMA_VERSION.toString());
    }

    // Determine test environment early so we can suppress operator-facing
    // warnings during automated test runs. Tests MUST create the expected
    // schema via the migration runner (`src/migrations`) or test setup; the
    // persistent store will not modify existing databases in any environment.
    const runningInTest = process.env.NODE_ENV === 'test' || Boolean(process.env.JEST_WORKER_ID);

    // For all environments we avoid performing non-destructive ALTERs here.
    // If the DB is older than the current schema, emit a non-fatal warning for
    // interactive operators but do not change schema silently. In test runs we
    // suppress the warning so test output remains clean — tests should run the
    // migration runner or create schema as part of setup.
    if (!isNewDb) {
      const existingVersion = schemaVersionRaw ? parseInt(schemaVersionRaw, 10) : 1;
      if (existingVersion < SCHEMA_VERSION) {
        // Try to include the pending migration ids to help operators run the
        // appropriate `wl doctor upgrade` command. We deliberately do not
        // perform any schema changes here — migrations are centralized in
        // src/migrations and must be applied via `wl doctor upgrade` so that
        // operators can preview and back up their DB first.
        if (!runningInTest) {
          let pendingMsg = "see 'wl doctor upgrade' to list and apply pending migrations";
          try {
            const pending = this._listPendingMigrations?.(this.dbPath);
            if (pending && pending.length > 0) {
              const ids = pending.map(p => p.id).join(', ');
              pendingMsg = `pending migrations: ${ids}. Run 'wl doctor upgrade --dry-run' to preview and '--confirm' to apply`;
            }
          } catch (err) {
            // Best-effort: if listing migrations fails do not throw — emit the
            // warning without the migration list so opening the DB still works.
          }

          console.warn(
            `Worklog: database at ${this.dbPath} has schemaVersion=${existingVersion} but the application expects schemaVersion=${SCHEMA_VERSION}. ` +
            `No automatic schema changes were performed. ${pendingMsg} (migrations live in src/migrations)`
          );
        }
      }
    }

    // Create comments table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        workItemId TEXT NOT NULL,
        author TEXT NOT NULL,
        comment TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        refs TEXT NOT NULL,
        githubCommentId INTEGER,
        githubCommentUpdatedAt TEXT,
      FOREIGN KEY (workItemId) REFERENCES workitems(id) ON DELETE CASCADE
      )
    `);

    // Note: Do not perform ALTERs to existing databases here. The CREATE TABLE
    // above includes the latest comment columns for newly created DBs; upgrades
    // must be performed via the migration runner (`wl doctor upgrade`).

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dependency_edges (
        fromId TEXT NOT NULL,
        toId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (fromId, toId),
        FOREIGN KEY (fromId) REFERENCES workitems(id) ON DELETE CASCADE,
        FOREIGN KEY (toId) REFERENCES workitems(id) ON DELETE CASCADE
      )
    `);

    // Create audit_results table for storing the latest audit per work item
    // This table is the sole source of truth for audit state (see WL-0MPZNJVWT000IKG7).
    // Only one row per work item is kept (latest-only, upsert via INSERT OR REPLACE).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_results (
        work_item_id TEXT PRIMARY KEY,
        ready_to_close INTEGER NOT NULL DEFAULT 0,
        audited_at TEXT NOT NULL,
        summary TEXT,
        raw_output TEXT,
        author TEXT,
        FOREIGN KEY (work_item_id) REFERENCES workitems(id) ON DELETE CASCADE
      )
    `);

    // Create last_export_timestamps table for tracking per-record-type
    // last-export watermarks used by delta (incremental) sync
    // (WL-0MT2KWFUJ001OGHF / WL-0MSAKUBKW006FN8Q). Only the four known
    // record types are stored; each holds a single ISO-8601 watermark.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS last_export_timestamps (
        record_type TEXT PRIMARY KEY,
        exported_at TEXT NOT NULL
      )
    `);

    // Create indexes for common queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_workitems_status ON workitems(status);
      CREATE INDEX IF NOT EXISTS idx_workitems_priority ON workitems(priority);
      CREATE INDEX IF NOT EXISTS idx_workitems_sortIndex ON workitems(sortIndex);
      CREATE INDEX IF NOT EXISTS idx_workitems_parent_sortIndex ON workitems(parentId, sortIndex);
      CREATE INDEX IF NOT EXISTS idx_workitems_parentId ON workitems(parentId);
      CREATE INDEX IF NOT EXISTS idx_comments_workItemId ON comments(workItemId);
      CREATE INDEX IF NOT EXISTS idx_dependency_edges_fromId ON dependency_edges(fromId);
      CREATE INDEX IF NOT EXISTS idx_dependency_edges_toId ON dependency_edges(toId);
    `);

    // Existing databases retain their schemaVersion metadata. If an older
    // schemaVersion is present we intentionally do not modify the DB here. The
    // `wl doctor upgrade` workflow should be used to review and apply any
    // required migrations (backups/pruning are handled there).
  }

  /**
   * Get metadata value
   */
  getMetadata(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM metadata WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /**
   * Set metadata value
   */
  setMetadata(key: string, value: string): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'
    );
    stmt.run(key, value);
  }

  /**
   * Get all metadata
   */
  getAllMetadata(): DbMetadata {
    const schemaVersion = parseInt(this.getMetadata('schemaVersion') || '1', 10);
    const lastJsonlImportAt = this.getMetadata('lastJsonlImportAt') || undefined;
    const lastJsonlImportMtimeStr = this.getMetadata('lastJsonlImportMtime');
    const lastJsonlImportMtime = lastJsonlImportMtimeStr 
      ? parseInt(lastJsonlImportMtimeStr, 10) 
      : undefined;

    return {
      schemaVersion,
      lastJsonlImportAt,
      lastJsonlImportMtime,
    };
  }

  /**
   * Read the per-record-type last-export watermarks used by delta (incremental)
   * sync (WL-0MT2KWFUJ001OGHF). Returns an object with the watermark timestamp
   * for each record type that has one; absent types are `undefined` (treated as
   * "no baseline" → full export by the caller).
   */
  getLastExportTimestamps(): LastExportTimestamps {
    const stmt = this.db.prepare('SELECT record_type, exported_at FROM last_export_timestamps');
    const rows = stmt.all() as Array<{ record_type: string; exported_at: string }>;
    const out: LastExportTimestamps = {};
    for (const row of rows) {
      if (row.record_type === 'workitems') out.workitems = row.exported_at;
      else if (row.record_type === 'comments') out.comments = row.exported_at;
      else if (row.record_type === 'edges') out.edges = row.exported_at;
      else if (row.record_type === 'audit_results') out.audit_results = row.exported_at;
    }
    return out;
  }

  /**
   * Upsert the per-record-type last-export watermarks. Passing `undefined` for
   * a type leaves that type's existing watermark untouched (or absent if never
   * set).
   */
  setLastExportTimestamps(ts: LastExportTimestamps): void {
    const upsert = this.db.prepare(
      'INSERT OR REPLACE INTO last_export_timestamps (record_type, exported_at) VALUES (?, ?)'
    );
    if (ts.workitems !== undefined) upsert.run('workitems', ts.workitems);
    if (ts.comments !== undefined) upsert.run('comments', ts.comments);
    if (ts.edges !== undefined) upsert.run('edges', ts.edges);
    if (ts.audit_results !== undefined) upsert.run('audit_results', ts.audit_results);
  }

  /**
   * Delta-sync cadence metadata (WL-0MT2KY0RQ008F50Q / WL-0MSAKUBKW006FN8Q),
   * persisted by the push path after each successful delta/full sync:
   *   - `deltaSyncCount` — number of consecutive delta syncs since the last
   *     full snapshot (full snapshots reset it to 0).
   *   - `deltaBytes`     — accumulated JSONL bytes pushed since the last full
   *     snapshot.
   *
   * Stored as dedicated rows in `last_export_timestamps` (special record
   * types `__delta_count__` / `__delta_bytes__`); the watermark reader
   * (`getLastExportTimestamps`) ignores these rows, so they never collide
   * with per-type watermarks. When no full-snapshot cadence policy is in
   * place the rows simply never appear and the default (0, 0) is returned.
   */
  getDeltaSyncMetadata(): { deltaSyncCount: number; deltaBytes: number } {
    const stmt = this.db.prepare('SELECT record_type, exported_at FROM last_export_timestamps WHERE record_type IN (?, ?)');
    const rows = stmt.all('__delta_count__', '__delta_bytes__') as Array<{ record_type: string; exported_at: string }>;
    let deltaSyncCount = 0;
    let deltaBytes = 0;
    for (const row of rows) {
      const parsed = Number(row.exported_at);
      if (Number.isFinite(parsed)) {
        if (row.record_type === '__delta_count__') deltaSyncCount = parsed;
        else deltaBytes = parsed;
      }
    }
    return { deltaSyncCount, deltaBytes };
  }

  /**
   * Persist the delta-sync cadence metadata ({@link getDeltaSyncMetadata}).
   */
  setDeltaSyncMetadata(deltaSyncCount: number, deltaBytes: number): void {
    const upsert = this.db.prepare(
      'INSERT OR REPLACE INTO last_export_timestamps (record_type, exported_at) VALUES (?, ?)'
    );
    upsert.run('__delta_count__', String(deltaSyncCount));
    upsert.run('__delta_bytes__', String(deltaBytes));
  }

  /**
   * Save a work item
   */
  saveWorkItem(item: WorkItem): void {
    // Use INSERT ... ON CONFLICT DO UPDATE to avoid triggering DELETE (which would cascade and remove comments)
    const stmt = this.db.prepare(`
      INSERT INTO workitems
      (id, title, description, status, priority, sortIndex, parentId, createdAt, updatedAt, tags, assignee, stage, issueType, createdBy, deletedBy, deleteReason, risk, effort, githubIssueNumber, githubIssueId, githubIssueUpdatedAt, needsProducerReview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        sortIndex = excluded.sortIndex,
        parentId = excluded.parentId,
        createdAt = excluded.createdAt,
        updatedAt = excluded.updatedAt,
        tags = excluded.tags,
        assignee = excluded.assignee,
        stage = excluded.stage,
        issueType = excluded.issueType,
        createdBy = excluded.createdBy,
        deletedBy = excluded.deletedBy,
        deleteReason = excluded.deleteReason,
        risk = excluded.risk,
        effort = excluded.effort,
        githubIssueNumber = excluded.githubIssueNumber,
        githubIssueId = excluded.githubIssueId,
        githubIssueUpdatedAt = excluded.githubIssueUpdatedAt,
        needsProducerReview = excluded.needsProducerReview
    `);

    // Normalize status to canonical hyphenated form on write (e.g. in_progress -> in-progress).
    // This ensures all stored data uses consistent status values, eliminating the need for
    // runtime normalization elsewhere.
    const normalizedStatus = normalizeStatusValue(item.status) ?? item.status;

    // Unescape plain-text fields so backslash escape artifacts (e.g. \n from
    // CLI argument passing) are stored as the intended characters.
    // Structured/JSON fields (tags, refs) must NOT be unescaped here.
    const titleVal = unescapeText(item.title ?? '');
    const descriptionVal = unescapeText(item.description ?? '');
    const deleteReasonVal = unescapeText(item.deleteReason ?? '');

    // Ensure we never pass `undefined` into better-sqlite3 bindings (it only
    // accepts numbers, strings, bigints, buffers and null). Normalize tags to
    // a JSON string and convert any undefined to null before running.
    const tagsVal = Array.isArray(item.tags) ? JSON.stringify(item.tags) : JSON.stringify([]);
    const values: any[] = [
      item.id,
      titleVal,
      descriptionVal,
      normalizedStatus,
      item.priority,
      item.sortIndex,
      item.parentId ?? null,
      item.createdAt,
      item.updatedAt,
      tagsVal,
      item.assignee ?? '',
      item.stage ?? '',
      item.issueType ?? '',
      item.createdBy ?? '',
      item.deletedBy ?? '',
      deleteReasonVal,
      item.risk ?? '',
      item.effort ?? '',
      item.githubIssueNumber ?? null,
      item.githubIssueId ?? null,
      item.githubIssueUpdatedAt ?? null,
      item.needsProducerReview ? 1 : 0,
    ];

    const normalized = normalizeSqliteBindings(values);

    // Diagnostic logging: when WL_DEBUG_SQL_BINDINGS is set print the type
    // and a safe representation of each binding before calling stmt.run.
    // This is temporary and intended to help identify unsupported binding
    // types during test runs (e.g. Date objects, functions, symbols).
    if (process.env.WL_DEBUG_SQL_BINDINGS) {
      try {
        // Log the incoming work item shape so we can see unexpected types on properties
        const itemRepr: any = {};
        for (const k of Object.keys(item)) {
          try {
            const v = (item as any)[k];
            itemRepr[k] = { type: v === null ? 'null' : typeof v, constructor: v && v.constructor ? v.constructor.name : null };
          } catch (_e) {
            itemRepr[k] = { type: 'unreadable' };
          }
        }
        console.error('WL_DEBUG_SQL_BINDINGS saveWorkItem incoming item keys:', JSON.stringify(itemRepr, null, 2));
        const rawRows = values.map((v, i) => ({ index: i, type: v === null ? 'null' : typeof v, constructor: v && v.constructor ? v.constructor.name : null, value: (() => { try { return v; } catch (_) { return '<unreadable>'; } })() }));
        console.error('WL_DEBUG_SQL_BINDINGS saveWorkItem raw values:', JSON.stringify(rawRows, null, 2));
      } catch (_err) {
        console.error('WL_DEBUG_SQL_BINDINGS saveWorkItem: failed to prepare raw values log');
      }
    }

    if (process.env.WL_DEBUG_SQL_BINDINGS) {
      const safeRepr = (x: any) => {
        try {
          if (x === null) return 'null';
          if (Buffer.isBuffer(x)) return `<Buffer length=${x.length}>`;
          const t = typeof x;
          if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return String(x);
          // JSON.stringify may throw for circular structures
          return JSON.stringify(x);
        } catch (err) {
          try {
            return String(x);
          } catch (_e) {
            return '<unserializable>';
          }
        }
      };

      try {
        const rows = normalized.map((v, i) => ({ index: i, type: v === null ? 'null' : typeof v, value: safeRepr(v) }));
        // Use console.error so test runners capture the output even on failures
        console.error('WL_DEBUG_SQL_BINDINGS saveWorkItem bindings:', JSON.stringify(rows, null, 2));
      } catch (_err) {
        // best-effort logging; do not interfere with normal flow
        console.error('WL_DEBUG_SQL_BINDINGS saveWorkItem: failed to prepare bindings log');
      }
    }

    stmt.run(...normalized);
    this.invalidateWorkItemCaches();
    this.cacheInvalidate(`workitem_${item.id}`);
  }

  /**
   * Get a work item by ID
   */
  getWorkItem(id: string): WorkItem | null {
    const cacheKey = `workitem_${id}`;
    const cached = this.cacheGet<WorkItem | null>(cacheKey);
    if (cached !== undefined) return cached;

    const stmt = this.db.prepare('SELECT * FROM workitems WHERE id = ?');
    const row = stmt.get(id) as any;
    
    if (!row) {
      this.cacheSet(cacheKey, null);
      return null;
    }

    const result = this.rowToWorkItem(row);
    this.cacheSet(cacheKey, result);
    return result;
  }

  /**
   * Count work items
   */
  countWorkItems(): number {
    const cached = this.cacheGet<number>('countWorkItems');
    if (cached !== undefined) return cached;

    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM workitems');
    const row = stmt.get() as { count: number };
    this.cacheSet('countWorkItems', row.count);
    return row.count;
  }

  /**
   * Find the most recent non-terminal work item whose *normalized* title
   * equals `normalizedTitle` and whose creation time is strictly after
   * `now - windowMs`. Used by the `wl create` dedup guard
   * (WL-0MSTNG2QF0049B97) — see `WorklogDatabase.getRecentDuplicate`.
   *
   * The stored title is normalized in SQL the same way
   * `normalizeTitleForMatch` normalizes the query side: case-folded with
   * tab/CR/LF/space removed, so `"Same Title"` vs `"same  title"` compare
   * equal. A direct SQL query (rather than filtering `getAllWorkItems()` in
   * memory) keeps the guard cheap and always reads the freshest rows.
   *
   * @param normalizedTitle - Canonical key from `normalizeTitleForMatch()`.
   * @param windowMs - Look-back window in milliseconds.
   * @param prefix - Prefix scope; only ids starting with `<prefix>-` match.
   * @returns The newest matching `WorkItem`, or null when none matches.
   */
  getRecentDuplicateByNormalizedTitle(
    normalizedTitle: string,
    windowMs: number,
    prefix: string,
  ): WorkItem | null {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const stmt = this.db.prepare(`
      SELECT * FROM workitems
      WHERE status IN ('open', 'in-progress', 'blocked')
        AND createdAt > ?
        AND LOWER(REPLACE(REPLACE(REPLACE(REPLACE(title, char(9), ''), char(10), ''), char(13), ''), ' ', '')) = ?
        AND id LIKE ? ESCAPE '\\'
      ORDER BY createdAt DESC
      LIMIT 1
    `);
    const row = stmt.get(
      cutoff,
      normalizedTitle,
      `${this.escapeLikePattern(prefix)}-%`,
    ) as any;
    if (!row) return null;
    return this.rowToWorkItem(row);
  }

  /**
   * Escape LIKE wildcards (`%`, `_`) and the escape character itself so a
   * user-supplied prefix cannot act as a wildcard in an `id LIKE ?` clause.
   */
  private escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  }

  /**
   * Get all work items
   */
  getAllWorkItems(): WorkItem[] {
    const cached = this.cacheGet<WorkItem[]>('allWorkItems');
    if (cached !== undefined) return cached;

    const stmt = this.db.prepare('SELECT * FROM workitems');
    const rows = stmt.all() as any[];
    const result = rows.map(row => this.rowToWorkItem(row));
    this.cacheSet('allWorkItems', result);
    return result;
  }

  /**
   * Batch-update sortIndex values for a list of work items.
   * Uses a single transaction to reduce write overhead.
   * Each item at index i gets sortIndex = (i + 1) * gap.
   * Only updates items whose sortIndex actually changes.
   *
   * @returns The number of items whose sortIndex was changed.
   */
  batchUpdateSortIndices(orderedItems: WorkItem[], gap: number): number {
    const updateStmt = this.db.prepare(`
      UPDATE workitems SET sortIndex = ?, updatedAt = ? WHERE id = ?
    `);

    const now = new Date().toISOString();
    let updated = 0;

    const doUpdates = this.db.transaction(() => {
      for (let index = 0; index < orderedItems.length; index += 1) {
        const item = orderedItems[index];
        const nextSortIndex = (index + 1) * gap;
        if (item.sortIndex !== nextSortIndex) {
          updateStmt.run(nextSortIndex, now, item.id);
          updated += 1;
        }
      }
    });

    doUpdates();
    this.invalidateWorkItemCaches();
    return updated;
  }

  getAllWorkItemsOrderedByHierarchySortIndex(): WorkItem[] {
    const items = this.getAllWorkItems();
    const childrenByParent = new Map<string | null, WorkItem[]>();

    for (const item of items) {
      const parentKey = item.parentId ?? null;
      const list = childrenByParent.get(parentKey);
      if (list) {
        list.push(item);
      } else {
        childrenByParent.set(parentKey, [item]);
      }
    }

    const sortSiblings = (list: WorkItem[]): WorkItem[] => {
      return list.slice().sort((a, b) => {
        if (a.sortIndex !== b.sortIndex) {
          return a.sortIndex - b.sortIndex;
        }
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      });
    };

    const ordered: WorkItem[] = [];
    const traverse = (parentId: string | null) => {
      const children = childrenByParent.get(parentId) || [];
      const sorted = sortSiblings(children);
      for (const child of sorted) {
        ordered.push(child);
        traverse(child.id);
      }
    };

    traverse(null);
    return ordered;
  }

  /**
   * Get all work items ordered by hierarchy sort index, but skip completed/deleted
   * subtrees. Open children under completed/deleted parents are promoted to root
   * level so they don't inherit traversal priority from their completed ancestors.
   */
  getAllWorkItemsOrderedByHierarchySortIndexSkipCompleted(): WorkItem[] {
    const items = this.getAllWorkItems();
    const itemMap = new Map<string, WorkItem>();
    const childrenByParent = new Map<string | null, WorkItem[]>();

    for (const item of items) {
      itemMap.set(item.id, item);
    }

    // Build parent-child map but promote orphans: if an item's parent is
    // completed or deleted, treat the item as a root-level item.
    for (const item of items) {
      let effectiveParent: string | null = item.parentId ?? null;

      // Walk up the ancestor chain; if any ancestor is completed/deleted,
      // promote this item to root level.
      if (effectiveParent) {
        let cursor: string | null = effectiveParent;
        while (cursor) {
          const parent = itemMap.get(cursor);
          if (!parent) break;
          if (parent.status === 'completed' || parent.status === 'deleted') {
            effectiveParent = null;
            break;
          }
          cursor = parent.parentId ?? null;
        }
      }

      const list = childrenByParent.get(effectiveParent);
      if (list) {
        list.push(item);
      } else {
        childrenByParent.set(effectiveParent, [item]);
      }
    }

    const sortSiblings = (list: WorkItem[]): WorkItem[] => {
      return list.slice().sort((a, b) => {
        if (a.sortIndex !== b.sortIndex) {
          return a.sortIndex - b.sortIndex;
        }
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      });
    };

    const ordered: WorkItem[] = [];
    const traverse = (parentId: string | null) => {
      const children = childrenByParent.get(parentId) || [];
      const sorted = sortSiblings(children);
      for (const child of sorted) {
        ordered.push(child);
        // Don't descend into completed/deleted items' subtrees
        if (child.status !== 'completed' && child.status !== 'deleted') {
          traverse(child.id);
        }
      }
    };

    traverse(null);
    return ordered;
  }

  /**
   * Like getAllWorkItemsOrderedByHierarchySortIndexSkipCompleted(), but operates
   * on a pre-loaded items array instead of loading from the database.
   * This avoids redundant full-table scans when the caller already has items.
   */
  orderItemsByHierarchySortIndexSkipCompleted(items: WorkItem[]): WorkItem[] {
    const itemMap = new Map<string, WorkItem>();
    const childrenByParent = new Map<string | null, WorkItem[]>();

    for (const item of items) {
      itemMap.set(item.id, item);
    }

    for (const item of items) {
      let effectiveParent: string | null = item.parentId ?? null;

      if (effectiveParent) {
        let cursor: string | null = effectiveParent;
        while (cursor) {
          const parent = itemMap.get(cursor);
          if (!parent) break;
          if (parent.status === 'completed' || parent.status === 'deleted') {
            effectiveParent = null;
            break;
          }
          cursor = parent.parentId ?? null;
        }
      }

      const list = childrenByParent.get(effectiveParent);
      if (list) {
        list.push(item);
      } else {
        childrenByParent.set(effectiveParent, [item]);
      }
    }

    const sortSiblings = (list: WorkItem[]): WorkItem[] => {
      return list.slice().sort((a, b) => {
        if (a.sortIndex !== b.sortIndex) {
          return a.sortIndex - b.sortIndex;
        }
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      });
    };

    const ordered: WorkItem[] = [];
    const traverse = (parentId: string | null) => {
      const children = childrenByParent.get(parentId) || [];
      const sorted = sortSiblings(children);
      for (const child of sorted) {
        ordered.push(child);
        if (child.status !== 'completed' && child.status !== 'deleted') {
          traverse(child.id);
        }
      }
    };

    traverse(null);
    return ordered;
  }

  /**
   * Delete a work item
   */
  deleteWorkItem(id: string): boolean {
    const deleteTransaction = this.db.transaction(() => {
      const result = this.db.prepare('DELETE FROM workitems WHERE id = ?').run(id);
      if (result.changes === 0) {
        return false;
      }
      this.db.prepare('DELETE FROM dependency_edges WHERE fromId = ? OR toId = ?').run(id, id);
      this.db.prepare('DELETE FROM comments WHERE workItemId = ?').run(id);
      return true;
    });
    const result = deleteTransaction();
    this.invalidateWorkItemCaches();
    this.invalidateCommentCaches();
    this.invalidateDependencyEdgeCaches();
    this.cacheInvalidate(`workitem_${id}`);
    return result;
  }

  /**
   * Clear all work items
   */
  clearWorkItems(): void {
    this.db.prepare('DELETE FROM workitems').run();
    this.invalidateWorkItemCaches();
    this.invalidateCommentCaches();
    this.invalidateDependencyEdgeCaches();
  }

  /**
   * Save a comment
   */
  saveComment(comment: Comment): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO comments 
      (id, workItemId, author, comment, createdAt, refs, githubCommentId, githubCommentUpdatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Pre-construction: stringify references, coerce optional fields.
    // Preserve existing || behavior for githubCommentUpdatedAt so that
    // falsy values (including empty string) become null.
    // Unescape the comment body so backslash escape artifacts are stored as
    // the intended characters. The refs JSON and other structured fields are
    // intentionally left unchanged.
    const values: unknown[] = [
      comment.id,
      comment.workItemId,
      comment.author,
      unescapeText(comment.comment),
      comment.createdAt,
      JSON.stringify(comment.references),
      comment.githubCommentId ?? null,
      comment.githubCommentUpdatedAt || null,
    ];

    const normalized = normalizeSqliteBindings(values);
    stmt.run(...normalized);
    this.invalidateCommentCaches();
  }

  /**
   * Get a comment by ID
   */
  getComment(id: string): Comment | null {
    const stmt = this.db.prepare('SELECT * FROM comments WHERE id = ?');
    const row = stmt.get(id) as any;
    
    if (!row) {
      return null;
    }

    return this.rowToComment(row);
  }

  /**
   * Get all comments
   */
  getAllComments(): Comment[] {
    const cached = this.cacheGet<Comment[]>('allComments');
    if (cached !== undefined) return cached;

    const stmt = this.db.prepare('SELECT * FROM comments');
    const rows = stmt.all() as any[];
    const result = rows.map(row => this.rowToComment(row));
    this.cacheSet('allComments', result);
    return result;
  }

  /**
   * Get comments for a work item
   */
  getCommentsForWorkItem(workItemId: string): Comment[] {
    const cacheKey = `commentsForItem_${workItemId}`;
    const cached = this.cacheGet<Comment[]>(cacheKey);
    if (cached !== undefined) return cached;

    // Return comments newest-first (reverse chronological order) so clients
    // and CLI can display the most recent discussion first.
    const stmt = this.db.prepare('SELECT * FROM comments WHERE workItemId = ? ORDER BY createdAt DESC');
    const rows = stmt.all(workItemId) as any[];
    const result = rows.map(row => this.rowToComment(row));
    this.cacheSet(cacheKey, result);
    return result;
  }

  /**
   * Delete a comment
   */
  deleteComment(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM comments WHERE id = ?');
    const result = stmt.run(id);
    if (result.changes > 0) {
      this.invalidateCommentCaches();
    }
    return result.changes > 0;
  }

  /**
   * Clear all comments
   */
  clearComments(): void {
    this.db.prepare('DELETE FROM comments').run();
    this.invalidateCommentCaches();
  }

  /**
   * Clear all dependency edges
   */
  clearDependencyEdges(): void {
    this.db.prepare('DELETE FROM dependency_edges').run();
    this.invalidateDependencyEdgeCaches();
  }

  /**
   * Import work items and comments (replaces existing data)
   */
  importData(items: WorkItem[], comments: Comment[]): void {
    // Use a transaction for atomic import
    const importTransaction = this.db.transaction(() => {
      this.clearWorkItems();
      this.clearComments();
      this.db.prepare('DELETE FROM dependency_edges').run();
      
      for (const item of items) {
        this.saveWorkItem(item);
      }
      
      for (const comment of comments) {
        this.saveComment(comment);
      }
    });

    importTransaction();
  }

  /**
   * Execute a function inside a database transaction.
   *
   * All write operations inside `fn` are committed atomically. If `fn`
   * throws, all changes are rolled back.  Nested transactions are
   * supported via SQLite savepoints (better-sqlite3 handles this
   * automatically when `this.db.transaction()` is called inside another
   * transaction).
   *
   * This is the same underlying transaction API used by {@link importData}.
   */
  transaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }

  /**
   * Execute a function inside a `BEGIN IMMEDIATE` transaction.
   *
   * The write lock is acquired BEFORE any read inside `fn` (deferred
   * transactions acquire it at the first write). This serializes
   * check-then-write sequences against OTHER processes' connections: a
   * concurrent writer blocks at `BEGIN IMMEDIATE` until this transaction
   * commits (busy_timeout), then observes the committed state — which is
   * exactly the atomicity the CAS claim (compare-and-swap, RCA
   * WL-0MSRBFFLN005W3VT design point 1) needs across herdr panes.
   */
  transactionImmediate<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx.immediate();
  }

  /**
   * Create or update a dependency edge
   */
  saveDependencyEdge(edge: DependencyEdge): void {
    const stmt = this.db.prepare(`
      INSERT INTO dependency_edges (fromId, toId, createdAt)
      VALUES (?, ?, ?)
      ON CONFLICT(fromId, toId) DO UPDATE SET
        createdAt = excluded.createdAt
    `);

    const normalized = normalizeSqliteBindings([edge.fromId, edge.toId, edge.createdAt]);
    stmt.run(...normalized);
    this.invalidateDependencyEdgeCaches();
  }

  /**
   * Remove a dependency edge
   */
  deleteDependencyEdge(fromId: string, toId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM dependency_edges WHERE fromId = ? AND toId = ?');
    const result = stmt.run(fromId, toId);
    if (result.changes > 0) {
      this.invalidateDependencyEdgeCaches();
    }
    return result.changes > 0;
  }

  /**
   * List all dependency edges
   */
  getAllDependencyEdges(): DependencyEdge[] {
    const cached = this.cacheGet<DependencyEdge[]>('allDependencyEdges');
    if (cached !== undefined) return cached;

    const stmt = this.db.prepare('SELECT * FROM dependency_edges');
    const rows = stmt.all() as any[];
    const result = rows.map(row => this.rowToDependencyEdge(row));
    this.cacheSet('allDependencyEdges', result);
    return result;
  }

  /**
   * List outbound dependency edges (fromId depends on toId)
   */
  getDependencyEdgesFrom(fromId: string): DependencyEdge[] {
    const cacheKey = `depEdgesFrom_${fromId}`;
    const cached = this.cacheGet<DependencyEdge[]>(cacheKey);
    if (cached !== undefined) return cached;

    const stmt = this.db.prepare('SELECT * FROM dependency_edges WHERE fromId = ?');
    const rows = stmt.all(fromId) as any[];
    const result = rows.map(row => this.rowToDependencyEdge(row));
    this.cacheSet(cacheKey, result);
    return result;
  }

  /**
   * List inbound dependency edges (items that depend on toId)
   */
  getDependencyEdgesTo(toId: string): DependencyEdge[] {
    const cacheKey = `depEdgesTo_${toId}`;
    const cached = this.cacheGet<DependencyEdge[]>(cacheKey);
    if (cached !== undefined) return cached;

    const stmt = this.db.prepare('SELECT * FROM dependency_edges WHERE toId = ?');
    const rows = stmt.all(toId) as any[];
    const result = rows.map(row => this.rowToDependencyEdge(row));
    this.cacheSet(cacheKey, result);
    return result;
  }

  /**
   * Remove all dependency edges for a work item
   */
  deleteDependencyEdgesForItem(itemId: string): number {
    const stmt = this.db.prepare('DELETE FROM dependency_edges WHERE fromId = ? OR toId = ?');
    const result = stmt.run(itemId, itemId);
    if (result.changes > 0) {
      this.invalidateDependencyEdgeCaches();
    }
    return result.changes;
  }

  // ── Audit Results ────────────────────────────────────────────────

  /**
   * Save or update an audit result for a work item (upsert).
   * Only the latest audit per work item is kept.
   */
  saveAuditResult(audit: { workItemId: string; readyToClose: boolean; auditedAt: string; summary: string | null; rawOutput: string | null; author: string | null }): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_results (work_item_id, ready_to_close, audited_at, summary, raw_output, author)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET
        ready_to_close = excluded.ready_to_close,
        audited_at = excluded.audited_at,
        summary = excluded.summary,
        raw_output = excluded.raw_output,
        author = excluded.author
    `);
    const values: unknown[] = [
      audit.workItemId,
      audit.readyToClose ? 1 : 0,
      audit.auditedAt,
      audit.summary ?? null,
      audit.rawOutput ?? null,
      audit.author ?? null,
    ];
    const normalized = normalizeSqliteBindings(values);
    const result = stmt.run(...normalized);
    if (result.changes === 0) {
      throw new Error(`Audit result could not be persisted for work item ${audit.workItemId}`);
    }
  }

  /**
   * Get the audit result for a work item.
   * Returns null if no audit result exists.
   */
  getAuditResult(workItemId: string): { workItemId: string; readyToClose: boolean; auditedAt: string; summary: string | null; rawOutput: string | null; author: string | null } | null {
    const stmt = this.db.prepare('SELECT * FROM audit_results WHERE work_item_id = ?');
    const row = stmt.get(workItemId) as any;
    if (!row) return null;
    return {
      workItemId: row.work_item_id,
      readyToClose: Boolean(row.ready_to_close),
      auditedAt: row.audited_at,
      summary: row.summary ?? null,
      rawOutput: row.raw_output ?? null,
      author: row.author ?? null,
    };
  }

  /**
   * Delete the audit result for a work item.
   */
  deleteAuditResult(workItemId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM audit_results WHERE work_item_id = ?');
    const result = stmt.run(workItemId);
    return result.changes > 0;
  }

  /**
   * Get all audit results (for JSONL export / sync).
   */
  getAllAuditResults(): AuditResult[] {
    const stmt = this.db.prepare('SELECT * FROM audit_results');
    const rows = stmt.all() as any[];
    return rows.map(row => ({
      workItemId: row.work_item_id,
      readyToClose: Boolean(row.ready_to_close),
      auditedAt: row.audited_at,
      summary: row.summary ?? null,
      rawOutput: row.raw_output ?? null,
      author: row.author ?? null,
    }));
  }

  /**
   * Save or update audit results (upsert, bulk).
   */
  saveAuditResults(audits: { workItemId: string; readyToClose: boolean; auditedAt: string; summary: string | null; rawOutput: string | null; author: string | null }[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_results (work_item_id, ready_to_close, audited_at, summary, raw_output, author)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET
        ready_to_close = excluded.ready_to_close,
        audited_at = excluded.audited_at,
        summary = excluded.summary,
        raw_output = excluded.raw_output,
        author = excluded.author
    `);
    const normalized = audits.map(audit => {
      const values: unknown[] = [
        audit.workItemId,
        audit.readyToClose ? 1 : 0,
        audit.auditedAt,
        audit.summary ?? null,
        audit.rawOutput ?? null,
        audit.author ?? null,
      ];
      return normalizeSqliteBindings(values);
    });
    const failed: string[] = [];
    this.db.transaction(() => {
      for (const values of normalized) {
        const result = stmt.run(...values);
        if (result.changes === 0) {
          failed.push(values[0] as string);
        }
      }
    })();
    if (failed.length > 0) {
      throw new Error(`Audit results could not be persisted for work items: ${failed.join(', ')}`);
    }
  }

  // ── FTS5 Full-Text Search ──────────────────────────────────────────

  /**
   * Detect whether FTS5 is available and create the virtual table if so.
   * Returns true when FTS5 is usable, false otherwise (caller should fall
   * back to application-level search).
   */
  private initializeFts(): boolean {
    try {
      // Probe FTS5 availability by attempting to compile a no-op statement
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x)`);
      this.db.exec(`DROP TABLE IF EXISTS _fts5_probe`);
    } catch (_err) {
      // FTS5 extension is not compiled in
      return false;
    }

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS worklog_fts USING fts5(
          title,
          description,
          comments,
          tags,
          itemId UNINDEXED,
          status UNINDEXED,
          parentId UNINDEXED,
          tokenize = 'porter'
        )
      `);
      return true;
    } catch (_err) {
      return false;
    }
  }

  /**
   * Upsert a single work item into the FTS index.
   * Collects all comments for the item and concatenates them into a single
   * text blob so comment content is searchable.
   */
  upsertFtsEntry(item: WorkItem): void {
    if (!this._ftsAvailable) return;

    // Gather comment bodies for this item
    const comments = this.getCommentsForWorkItem(item.id);
    const commentText = comments.map(c => c.comment).join('\n');
    const tagsText = Array.isArray(item.tags) ? item.tags.join(' ') : '';

    // Delete any existing row then insert fresh (FTS5 content tables
    // don't support UPDATE in the same way as regular tables).
    const deleteFts = this.db.prepare(
      `DELETE FROM worklog_fts WHERE itemId = ?`
    );
    const insertFts = this.db.prepare(`
      INSERT INTO worklog_fts (title, description, comments, tags, itemId, status, parentId)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    deleteFts.run(item.id);
    insertFts.run(
      item.title,
      item.description,
      commentText,
      tagsText,
      item.id,
      item.status,
      item.parentId ?? ''
    );
  }

  /**
   * Remove a work item from the FTS index
   */
  deleteFtsEntry(itemId: string): void {
    if (!this._ftsAvailable) return;
    this.db.prepare(`DELETE FROM worklog_fts WHERE itemId = ?`).run(itemId);
  }

  /**
   * Rebuild the entire FTS index from the current workitems and comments tables.
   * This drops and recreates the FTS table then inserts all items.
   */
  rebuildFtsIndex(): { indexed: number } {
    if (!this._ftsAvailable) {
      throw new Error('FTS5 is not available in this SQLite build. Cannot rebuild index.');
    }

    const rebuildTx = this.db.transaction(() => {
      // Drop and recreate
      this.db.exec(`DROP TABLE IF EXISTS worklog_fts`);
      this.db.exec(`
        CREATE VIRTUAL TABLE worklog_fts USING fts5(
          title,
          description,
          comments,
          tags,
          itemId UNINDEXED,
          status UNINDEXED,
          parentId UNINDEXED,
          tokenize = 'porter'
        )
      `);

      const items = this.getAllWorkItems();
      const allComments = this.getAllComments();

      // Group comments by work item id
      const commentsByItem = new Map<string, string[]>();
      for (const c of allComments) {
        const list = commentsByItem.get(c.workItemId);
        if (list) {
          list.push(c.comment);
        } else {
          commentsByItem.set(c.workItemId, [c.comment]);
        }
      }

      const insertFts = this.db.prepare(`
        INSERT INTO worklog_fts (title, description, comments, tags, itemId, status, parentId)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const commentText = (commentsByItem.get(item.id) || []).join('\n');
        const tagsText = Array.isArray(item.tags) ? item.tags.join(' ') : '';
        insertFts.run(
          item.title,
          item.description,
          commentText,
          tagsText,
          item.id,
          item.status,
          item.parentId ?? ''
        );
      }

      return items.length;
    });

    const indexed = rebuildTx();
    return { indexed };
  }

  /**
   * Search the FTS index using an FTS5 MATCH expression.
   * Returns results ranked by BM25 relevance (most relevant first).
   *
   * @param query - FTS5 query string (supports phrases, prefix*, OR, AND, NOT)
   * @param options - Optional filters and limits
   */
  searchFts(
    query: string,
    options?: {
      status?: string;
      parentId?: string;
      tags?: string[];
      limit?: number;
      priority?: string;
      assignee?: string;
      stage?: string;
      deleted?: boolean;
      needsProducerReview?: boolean;
      issueType?: string;
    }
  ): FtsSearchResult[] {
    if (!this._ftsAvailable) return [];

    // Sanitize and prepare the query
    const trimmed = query.trim();
    if (!trimmed) return [];

    const limit = options?.limit ?? 50;

    try {
      // Build the base query with BM25 ranking and snippets.
      // We extract snippets from each searchable column and pick the best one.
      // BM25 column weights: title=10, description=5, comments=2, tags=3
      // JOIN with workitems table to support filtering by priority, assignee,
      // stage, issueType, needsProducerReview, and deleted status.
      let sql = `
        SELECT
          worklog_fts.itemId,
          bm25(worklog_fts, 10.0, 5.0, 2.0, 3.0) AS rank,
          snippet(worklog_fts, 0, '<<', '>>', '...', 32) AS title_snippet,
          snippet(worklog_fts, 1, '<<', '>>', '...', 32) AS desc_snippet,
          snippet(worklog_fts, 2, '<<', '>>', '...', 32) AS comment_snippet,
          snippet(worklog_fts, 3, '<<', '>>', '...', 32) AS tags_snippet,
          worklog_fts.status,
          worklog_fts.parentId
        FROM worklog_fts
        JOIN workitems ON worklog_fts.itemId = workitems.id
        WHERE worklog_fts MATCH ?
      `;

      const params: (string | number)[] = [trimmed];

      if (options?.status) {
        sql += ` AND worklog_fts.status = ?`;
        params.push(options.status);
      }

      if (options?.parentId) {
        sql += ` AND worklog_fts.parentId = ?`;
        params.push(options.parentId);
      }

      if (options?.priority) {
        sql += ` AND workitems.priority = ?`;
        params.push(options.priority);
      }

      if (options?.assignee) {
        sql += ` AND workitems.assignee = ?`;
        params.push(options.assignee);
      }

      if (options?.stage) {
        sql += ` AND workitems.stage = ?`;
        params.push(options.stage);
      }

      if (options?.issueType) {
        sql += ` AND workitems.issueType = ?`;
        params.push(options.issueType);
      }

      if (options?.needsProducerReview !== undefined) {
        sql += ` AND workitems.needsProducerReview = ?`;
        params.push(options.needsProducerReview ? 1 : 0);
      }

      // By default exclude deleted items; include them when deleted: true
      if (!options?.deleted) {
        sql += ` AND workitems.status != 'deleted'`;
      }

      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as any[];

      const results: FtsSearchResult[] = [];

      for (const row of rows) {
        // Pick the best snippet (the one with highlight markers)
        let snippet = '';
        let matchedColumn = 'title';

        if (row.title_snippet && row.title_snippet.includes('<<')) {
          snippet = row.title_snippet;
          matchedColumn = 'title';
        } else if (row.desc_snippet && row.desc_snippet.includes('<<')) {
          snippet = row.desc_snippet;
          matchedColumn = 'description';
        } else if (row.comment_snippet && row.comment_snippet.includes('<<')) {
          snippet = row.comment_snippet;
          matchedColumn = 'comments';
        } else if (row.tags_snippet && row.tags_snippet.includes('<<')) {
          snippet = row.tags_snippet;
          matchedColumn = 'tags';
        } else {
          // Fallback: use title snippet even without highlights
          snippet = row.title_snippet || '';
          matchedColumn = 'title';
        }

        results.push({
          itemId: row.itemId,
          rank: row.rank,
          snippet,
          matchedColumn,
        });
      }

      // Post-filter by tags (FTS5 can't efficiently filter JSON arrays,
      // so we do this in application code)
      if (options?.tags && options.tags.length > 0) {
        const tagSet = new Set(options.tags.map(t => t.toLowerCase()));
        const filtered: FtsSearchResult[] = [];
        for (const result of results) {
          const item = this.getWorkItem(result.itemId);
          if (item && item.tags.some(t => tagSet.has(t.toLowerCase()))) {
            filtered.push(result);
          }
        }
        return filtered;
      }

      return results;
    } catch (_err) {
      // If the query syntax is invalid, return empty results
      return [];
    }
  }

  /**
   * Perform a simple application-level text search as a fallback when FTS5
   * is not available. Searches title, description, tags and comment bodies
   * using case-insensitive substring matching with basic relevance scoring.
   */
  searchFallback(
    query: string,
    options?: {
      status?: string;
      parentId?: string;
      tags?: string[];
      limit?: number;
      priority?: string;
      assignee?: string;
      stage?: string;
      deleted?: boolean;
      needsProducerReview?: boolean;
      issueType?: string;
    }
  ): FtsSearchResult[] {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];

    const limit = options?.limit ?? 50;
    const terms = trimmed.split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0) return [];

    let items = this.getAllWorkItems();

    // Apply filters
    if (options?.status) {
      items = items.filter(i => i.status === options.status);
    }
    if (options?.parentId) {
      items = items.filter(i => i.parentId === options.parentId);
    }
    if (options?.tags && options.tags.length > 0) {
      const tagSet = new Set(options.tags.map(t => t.toLowerCase()));
      items = items.filter(i => i.tags.some(t => tagSet.has(t.toLowerCase())));
    }
    if (options?.priority) {
      items = items.filter(i => i.priority === options.priority);
    }
    if (options?.assignee) {
      items = items.filter(i => i.assignee === options.assignee);
    }
    if (options?.stage) {
      items = items.filter(i => i.stage === options.stage);
    }
    if (options?.issueType) {
      items = items.filter(i => i.issueType === options.issueType);
    }
    if (options?.needsProducerReview !== undefined) {
      items = items.filter(i => i.needsProducerReview === options.needsProducerReview);
    }
    // By default exclude deleted items; include them when deleted: true
    if (!options?.deleted) {
      items = items.filter(i => i.status !== 'deleted');
    }

    const allComments = this.getAllComments();
    const commentsByItem = new Map<string, string>();
    for (const c of allComments) {
      const existing = commentsByItem.get(c.workItemId) || '';
      commentsByItem.set(c.workItemId, existing + '\n' + c.comment);
    }

    const results: FtsSearchResult[] = [];

    for (const item of items) {
      const titleLower = item.title.toLowerCase();
      const descLower = item.description.toLowerCase();
      const tagsLower = (item.tags || []).join(' ').toLowerCase();
      const commentLower = (commentsByItem.get(item.id) || '').toLowerCase();

      // Count matching terms across fields (simple TF-like scoring)
      let score = 0;
      let bestField = 'title';
      let bestFieldScore = 0;

      for (const term of terms) {
        const titleHits = this.countOccurrences(titleLower, term) * 10;
        const descHits = this.countOccurrences(descLower, term) * 5;
        const tagHits = this.countOccurrences(tagsLower, term) * 3;
        const commentHits = this.countOccurrences(commentLower, term) * 2;

        score += titleHits + descHits + tagHits + commentHits;

        if (titleHits > bestFieldScore) { bestFieldScore = titleHits; bestField = 'title'; }
        if (descHits > bestFieldScore) { bestFieldScore = descHits; bestField = 'description'; }
        if (commentHits > bestFieldScore) { bestFieldScore = commentHits; bestField = 'comments'; }
        if (tagHits > bestFieldScore) { bestFieldScore = tagHits; bestField = 'tags'; }
      }

      if (score > 0) {
        // Generate a simple snippet from the best matching field
        const fieldText = bestField === 'title' ? item.title
          : bestField === 'description' ? item.description
          : bestField === 'tags' ? (item.tags || []).join(' ')
          : commentsByItem.get(item.id) || '';

        const snippet = this.generateSnippet(fieldText, terms[0], 64);

        results.push({
          itemId: item.id,
          rank: -score, // Negate so higher scores sort first (matching FTS5 BM25 convention)
          snippet,
          matchedColumn: bestField,
        });
      }
    }

    // Sort by rank (most relevant first - lowest rank value for BM25-like convention)
    results.sort((a, b) => a.rank - b.rank);

    return results.slice(0, limit);
  }

  /**
   * Count occurrences of a substring in a string
   */
  private countOccurrences(text: string, sub: string): number {
    if (!sub || !text) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(sub, pos)) !== -1) {
      count++;
      pos += sub.length;
    }
    return count;
  }

  /**
   * Generate a snippet around the first occurrence of a term
   */
  private generateSnippet(text: string, term: string, maxLen: number): string {
    if (!text) return '';
    const lower = text.toLowerCase();
    const termLower = term.toLowerCase();
    const idx = lower.indexOf(termLower);

    if (idx === -1) {
      // Term not found directly, return start of text
      return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
    }

    const halfWindow = Math.floor(maxLen / 2);
    let start = Math.max(0, idx - halfWindow);
    let end = Math.min(text.length, idx + term.length + halfWindow);

    let snippet = '';
    if (start > 0) snippet += '...';
    const raw = text.slice(start, end);
    // Add highlight markers around the term occurrence
    const matchStart = idx - start;
    snippet += raw.slice(0, matchStart) + '<<' + raw.slice(matchStart, matchStart + term.length) + '>>' + raw.slice(matchStart + term.length);
    if (end < text.length) snippet += '...';

    return snippet;
  }

  /**
   * Find work items whose ID contains the given substring (case-insensitive).
   * Used for partial-ID matching when the query token length is >= 8 characters.
   */
  findByIdSubstring(substr: string): WorkItem[] {
    if (!substr || substr.length < 8) return [];
    const upperSubstr = substr.toUpperCase();
    const stmt = this.db.prepare('SELECT * FROM workitems WHERE UPPER(id) LIKE ?');
    const rows = stmt.all(`%${upperSubstr}%`) as any[];
    return rows.map(row => this.rowToWorkItem(row));
  }

  /**
   * Close database connection
   */
  // ── In-memory cache helpers (Phase 5) ────────────────────────────

  /**
   * Get a value from the in-memory cache.
   * Returns undefined if the key is not cached or the entry has expired.
   */
  private cacheGet<T>(key: string): T | undefined {
    if (!this._cacheEnabled || this._cacheTtlMs <= 0) return undefined;
    const entry = this._cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /**
   * Set a value in the in-memory cache with the configured TTL.
   * Evicts the oldest entry if the cache exceeds maxEntries.
   */
  private cacheSet(key: string, value: unknown): void {
    if (!this._cacheEnabled || this._cacheTtlMs <= 0) return;
    if (this._cache.size >= this._cacheMaxEntries) {
      // Evict oldest entry (first inserted)
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) this._cache.delete(oldestKey);
    }
    this._cache.set(key, { value, expiresAt: Date.now() + this._cacheTtlMs });
  }

  /**
   * Invalidate a specific cache key.
   */
  private cacheInvalidate(key: string): void {
    this._cache.delete(key);
  }

  /**
   * Invalidate all cached entries that match a prefix.
   */
  private cacheInvalidatePrefix(prefix: string): void {
    for (const key of this._cache.keys()) {
      if (key.startsWith(prefix)) {
        this._cache.delete(key);
      }
    }
  }

  /**
   * Clear the entire in-memory cache.
   */
  private cacheClear(): void {
    this._cache.clear();
  }

  /**
   * Invalidate all caches that are affected by work item mutations.
   */
  private invalidateWorkItemCaches(): void {
    this.cacheInvalidatePrefix('workitem_');
    this.cacheInvalidatePrefix('commentsForItem_');
    this.cacheInvalidate('allWorkItems');
    this.cacheInvalidate('countWorkItems');
    this.cacheInvalidate('allChildren');
    this.cacheInvalidate('allComments');
    this.cacheInvalidate('allDependencyEdges');
  }

  /**
   * Invalidate all caches that are affected by comment mutations.
   */
  private invalidateCommentCaches(): void {
    this.cacheInvalidatePrefix('commentsForItem_');
    this.cacheInvalidate('allComments');
  }

  /**
   * Invalidate all caches that are affected by dependency edge mutations.
   */
  private invalidateDependencyEdgeCaches(): void {
    this.cacheInvalidatePrefix('depEdgesFrom_');
    this.cacheInvalidatePrefix('depEdgesTo_');
    this.cacheInvalidate('allDependencyEdges');
  }

  /**
   * Public wrapper to clear comment-related caches.
   */
  clearCommentCaches(): void {
    this.invalidateCommentCaches();
  }

  close(): void {
    this.db.close();
    this.cacheClear();
  }

  /**
   * Convert database row to WorkItem
   */
  private rowToWorkItem(row: any): WorkItem {
    try {
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        sortIndex: row.sortIndex ?? 0,
        parentId: row.parentId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        tags: JSON.parse(row.tags),
        assignee: row.assignee,
        stage: row.stage,

        issueType: row.issueType || '',
        createdBy: row.createdBy || '',
        deletedBy: row.deletedBy || '',
        deleteReason: row.deleteReason || '',
        risk: row.risk || '',
        effort: row.effort || '',
        githubIssueNumber: row.githubIssueNumber ?? undefined,
        githubIssueId: row.githubIssueId ?? undefined,
        githubIssueUpdatedAt: row.githubIssueUpdatedAt || undefined,
        needsProducerReview: Boolean(row.needsProducerReview),
      };
    } catch (error) {
      console.error(`Error parsing work item ${row.id}:`, error);
      // Return item with empty tags if parsing fails
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        sortIndex: row.sortIndex ?? 0,
        parentId: row.parentId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        tags: [],
        assignee: row.assignee,
        stage: row.stage,

        issueType: row.issueType || '',
        createdBy: row.createdBy || '',
        deletedBy: row.deletedBy || '',
        deleteReason: row.deleteReason || '',
        risk: row.risk || '',
        effort: row.effort || '',
        githubIssueNumber: row.githubIssueNumber ?? undefined,
        githubIssueId: row.githubIssueId ?? undefined,
        githubIssueUpdatedAt: row.githubIssueUpdatedAt || undefined,
        needsProducerReview: Boolean(row.needsProducerReview),
      };
    }
  }

  /**
   * Convert database row to Comment
   */
  private rowToComment(row: any): Comment {
    try {
      return {
        id: row.id,
        workItemId: row.workItemId,
        author: row.author,
        comment: row.comment,
        createdAt: row.createdAt,
        references: JSON.parse(row.refs),
        githubCommentId: row.githubCommentId ?? undefined,
        githubCommentUpdatedAt: row.githubCommentUpdatedAt || undefined,
      };
    } catch (error) {
      console.error(`Error parsing comment ${row.id}:`, error);
      // Return comment with empty references if parsing fails
      return {
        id: row.id,
        workItemId: row.workItemId,
        author: row.author,
        comment: row.comment,
        createdAt: row.createdAt,
        references: [],
      };
    }
  }

  /**
   * Convert database row to DependencyEdge
   */
  private rowToDependencyEdge(row: any): DependencyEdge {
    return {
      fromId: row.fromId,
      toId: row.toId,
      createdAt: row.createdAt,
    };
  }
}
