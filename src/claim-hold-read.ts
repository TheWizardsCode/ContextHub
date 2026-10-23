/**
 * Cache-bypassing read of the store's current claim rows (SA-0MVE34D9B005TUYJ
 * → SA-0MVKWV2V2006JC8E).
 *
 * The claim-hold guard must see claims that landed in the sync's
 * read→merge→write window — i.e. rows written by *another process* seconds
 * ago. `WorklogDatabase.getAll()` goes through `SqlitePersistentStore`'s
 * in-memory query cache (5 s TTL), and a cached snapshot is exactly the wrong
 * input for a monotonic guard: it would re-introduce the stale view the guard
 * exists to reject.
 *
 * This module therefore opens a short-lived **read-only** SQLite connection
 * and reads the claim columns directly. It is deliberately tiny and lives in
 * the CLI layer (not `@worklog/shared`) — worktrees resolve `@worklog/shared`
 * to the main checkout's built `dist`, so shared code is not testable from a
 * worktree (see `src/demotion-audit.ts` for the same convention).
 *
 * Failure is fail-open: when the store cannot be opened (fresh project, no
 * database yet, locked schema) the caller falls back to its own snapshot, so
 * the guard never turns a sync into an error.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkItem } from './types.js';

/** The columns the guard needs; mirrors the `workitems` table. */
const CLAIM_COLUMNS =
  'id, status, stage, assignee, updatedAt, activityAt, deletedBy, deleteReason';

/**
 * Resolve the SQLite database path that backs a JSONL data-file path.
 *
 * The store keeps `worklog.db` next to its data file (see `src/read-cache.ts`).
 */
export function getDatabasePathFor(dataFilePath: string): string {
  return path.join(path.dirname(dataFilePath), 'worklog.db');
}

/**
 * Read the current `status`/`stage`/claim fields for work items, bypassing the
 * in-process query cache.
 *
 * @param dataFilePath - The store's JSONL data-file path (`options.file`).
 * @returns The rows as partial `WorkItem`s (claim fields only), or `null` when
 *   the store is unavailable — callers then fall back to their own snapshot.
 */
export function readCurrentClaimRows(dataFilePath: string): WorkItem[] | null {
  const dbPath = getDatabasePathFor(dataFilePath);
  if (!fs.existsSync(dbPath)) return null;

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`SELECT ${CLAIM_COLUMNS} FROM workitems`).all() as Array<
      Record<string, any>
    >;
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      stage: row.stage,
      assignee: row.assignee ?? '',
      updatedAt: row.updatedAt,
      activityAt: row.activityAt || row.updatedAt,
      deletedBy: row.deletedBy ?? '',
      deleteReason: row.deleteReason ?? '',
    })) as unknown as WorkItem[];
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // A failed close must not mask a successful read.
    }
  }
}
