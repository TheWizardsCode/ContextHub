/**
 * SQLite-based persistent storage for work items and comments
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { WorkItem, Comment, DependencyEdge } from './types.js';
import { listPendingMigrations } from './migrations/index.js';

interface DbMetadata {
  lastJsonlImportMtime?: number;
  lastJsonlImportAt?: string;
  schemaVersion: number;
}

const SCHEMA_VERSION = 6;

export class SqlitePersistentStore {
  private db: Database.Database;
  private dbPath: string;
  private verbose: boolean;

  constructor(dbPath: string, verbose: boolean = false) {
    this.dbPath = dbPath;
    this.verbose = verbose;
    
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
    } catch (error) {
      throw new Error(`Failed to open database ${dbPath}: ${(error as Error).message}`);
    }
    
    // Initialize schema
    try {
      this.initializeSchema();
    } catch (error) {
      throw new Error(`Failed to initialize database schema: ${(error as Error).message}`);
    }
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
            const pending = listPendingMigrations(this.dbPath);
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

    // Ensure we never pass `undefined` into better-sqlite3 bindings (it only
    // accepts numbers, strings, bigints, buffers and null). Normalize tags to
    // a JSON string and convert any undefined to null before running.
    const tagsVal = Array.isArray(item.tags) ? JSON.stringify(item.tags) : JSON.stringify([]);
    const values: any[] = [
      item.id,
      item.title,
      item.description,
      item.status,
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
      item.deleteReason ?? '',
      item.risk ?? '',
      item.effort ?? '',
      item.githubIssueNumber ?? null,
      item.githubIssueId ?? null,
      item.githubIssueUpdatedAt ?? null,
      item.needsProducerReview ? 1 : 0,
    ];

    // Normalize values to types accepted by better-sqlite3:
    // numbers, strings, bigints, buffers, or null. Convert booleans to 1/0
    // and objects to JSON strings to avoid binding errors.
    const normalized = values.map((v) => {
      if (v === undefined) return null;
      if (v === null) return null;
      const t = typeof v;
      if (t === 'number' || t === 'string' || t === 'bigint' || Buffer.isBuffer(v)) return v;
      if (t === 'boolean') return v ? 1 : 0;
      // Fallback: stringify objects (arrays, plain objects, dates)
      try {
        return JSON.stringify(v as any);
      } catch (_err) {
        return String(v);
      }
    });

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
  }

  /**
   * Get a work item by ID
   */
  getWorkItem(id: string): WorkItem | null {
    const stmt = this.db.prepare('SELECT * FROM workitems WHERE id = ?');
    const row = stmt.get(id) as any;
    
    if (!row) {
      return null;
    }

    return this.rowToWorkItem(row);
  }

  /**
   * Count work items
   */
  countWorkItems(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM workitems');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get all work items
   */
  getAllWorkItems(): WorkItem[] {
    const stmt = this.db.prepare('SELECT * FROM workitems');
    const rows = stmt.all() as any[];
    return rows.map(row => this.rowToWorkItem(row));
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
    return deleteTransaction();
  }

  /**
   * Clear all work items
   */
  clearWorkItems(): void {
    this.db.prepare('DELETE FROM workitems').run();
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

    stmt.run(
      comment.id,
      comment.workItemId,
      comment.author,
      comment.comment,
      comment.createdAt,
      JSON.stringify(comment.references),
      comment.githubCommentId ?? null,
      comment.githubCommentUpdatedAt || null
    );
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
    const stmt = this.db.prepare('SELECT * FROM comments');
    const rows = stmt.all() as any[];
    return rows.map(row => this.rowToComment(row));
  }

  /**
   * Get comments for a work item
   */
  getCommentsForWorkItem(workItemId: string): Comment[] {
    // Return comments newest-first (reverse chronological order) so clients
    // and CLI can display the most recent discussion first.
    const stmt = this.db.prepare('SELECT * FROM comments WHERE workItemId = ? ORDER BY createdAt DESC');
    const rows = stmt.all(workItemId) as any[];
    return rows.map(row => this.rowToComment(row));
  }

  /**
   * Delete a comment
   */
  deleteComment(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM comments WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Clear all comments
   */
  clearComments(): void {
    this.db.prepare('DELETE FROM comments').run();
  }

  /**
   * Clear all dependency edges
   */
  clearDependencyEdges(): void {
    this.db.prepare('DELETE FROM dependency_edges').run();
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
   * Create or update a dependency edge
   */
  saveDependencyEdge(edge: DependencyEdge): void {
    const stmt = this.db.prepare(`
      INSERT INTO dependency_edges (fromId, toId, createdAt)
      VALUES (?, ?, ?)
      ON CONFLICT(fromId, toId) DO UPDATE SET
        createdAt = excluded.createdAt
    `);

    stmt.run(edge.fromId, edge.toId, edge.createdAt);
  }

  /**
   * Remove a dependency edge
   */
  deleteDependencyEdge(fromId: string, toId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM dependency_edges WHERE fromId = ? AND toId = ?');
    const result = stmt.run(fromId, toId);
    return result.changes > 0;
  }

  /**
   * List all dependency edges
   */
  getAllDependencyEdges(): DependencyEdge[] {
    const stmt = this.db.prepare('SELECT * FROM dependency_edges');
    const rows = stmt.all() as any[];
    return rows.map(row => this.rowToDependencyEdge(row));
  }

  /**
   * List outbound dependency edges (fromId depends on toId)
   */
  getDependencyEdgesFrom(fromId: string): DependencyEdge[] {
    const stmt = this.db.prepare('SELECT * FROM dependency_edges WHERE fromId = ?');
    const rows = stmt.all(fromId) as any[];
    return rows.map(row => this.rowToDependencyEdge(row));
  }

  /**
   * List inbound dependency edges (items that depend on toId)
   */
  getDependencyEdgesTo(toId: string): DependencyEdge[] {
    const stmt = this.db.prepare('SELECT * FROM dependency_edges WHERE toId = ?');
    const rows = stmt.all(toId) as any[];
    return rows.map(row => this.rowToDependencyEdge(row));
  }

  /**
   * Remove all dependency edges for a work item
   */
  deleteDependencyEdgesForItem(itemId: string): number {
    const stmt = this.db.prepare('DELETE FROM dependency_edges WHERE fromId = ? OR toId = ?');
    const result = stmt.run(itemId, itemId);
    return result.changes;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
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
        needsProducerReview: Boolean(row.needsProducerReview)
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
