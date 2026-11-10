/**
 * Store-divergence fixtures (WL-0MW9YUYF3006H56I, child WL-0MWABDLX500929F1).
 *
 * These helpers construct — deterministically, in a throwaway temp worklog —
 * the two divergence classes the parent item describes, so the reproduction
 * test (`divergence-reproduction.test.ts`) and the `wl doctor` integrity check
 * (child WL-0MWABEV8100167Y5) share one way of building the corrupt state.
 *
 * ## Divergence classes
 *
 * **Class 1 — a derived read path holds an item the primary table cannot serve.**
 *
 *  1a. **Phantom FTS entry** — a `worklog_fts` row with no matching
 *      `workitems` row ({@link plantPhantomFtsEntry}). Today no user read path
 *      surfaces it (the FTS query JOINs `workitems`), but it is a genuine
 *      primary-vs-derived divergence the integrity check must name.
 *  1b. **FTS gap (the "vice versa")** — an item present in `workitems` but
 *      missing from `worklog_fts` ({@link dropFtsEntry}). `wl list` returns the
 *      item while `wl search` silently omits it — a read-path disagreement
 *      that is currently silent. `rebuildFtsIndex()` (exposed by
 *      `wl search --rebuild-index`) restores it from the primary table.
 *  1c. **JSONL holds it, primary does not** — the authoritative JSONL snapshot
 *      contains an item the SQLite primary store lacks
 *      ({@link writeDivergenceJsonlSnapshot}). This is the "re-apply from the
 *      authoritative source" repair input (child WL-0MWABFI8Z004RFA0).
 *
 * **Class 2 — the primary row exists but the exact-match lookup misses it.**
 *
 *  A `workitems` row whose stored id is not in canonical upper-case form
 *  (e.g. lower-case, from a manual or legacy write), so
 *  `db.get(normalizedId)` (`SELECT * FROM workitems WHERE id = ?`) returns
 *  null while scan-based reads (`wl list`, `wl search`, `wl export`) still
 *  find it ({@link demotePrimaryIdToNonCanonical}). This is the class that
 *  reproduces the reported symptom: visible through list/search/export, but
 *  the exact-match paths behind `wl show --exact`, `wl comment add` and
 *  `wl update` report `Work item not found`. `wl show` (tolerant) is masked by
 *  the unique-substring fallback from WL-0MSOMI4GQ009WL8E.
 *
 * ## Concurrency
 *
 * Every mutation runs under {@link withStoreMutationLock} — the same per-store
 * advisory file lock (`getLockPathForJsonl`) that `wl sync` and the mutating
 * commands hold — so a fixture write can never interleave with a concurrent
 * `wl` write/sync (the reporter's 00:39Z timeline). Fixtures are targeted
 * single-row INSERT/DELETE/UPDATE operations; they never replace the store.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { withStoreMutationLock } from '../../src/mutation-lock.js';
import { exportToJsonl } from '../../src/jsonl.js';
import type { WorkItem } from '../../src/types.js';

/** The SQLite primary store file inside a temp worklog directory. */
export function divergenceDbPath(dir: string): string {
  return path.join(dir, '.worklog', 'worklog.db');
}

/**
 * The store's authoritative JSONL data path — the same path
 * `getDefaultDataPath()` returns and the mutating commands pass to
 * `withStoreMutationLock` as `ctx.dataPath`.
 */
export function divergenceDataPath(dir: string): string {
  return path.join(dir, '.worklog', 'worklog-data.jsonl');
}

/** Open the temp store for a direct, scoped read/write. */
function withDivergenceStore<T>(dir: string, fn: (db: Database.Database) => T): T {
  const db = new Database(divergenceDbPath(dir));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The ids the authoritative primary table (`workitems`) can serve. */
export function readPrimaryIds(dir: string): string[] {
  return withDivergenceStore(dir, (db) =>
    (db.prepare('SELECT id FROM workitems').all() as Array<{ id: string }>).map((r) => String(r.id)),
  );
}

/** The ids the derived FTS index (`worklog_fts`) holds. */
export function readFtsIds(dir: string): string[] {
  return withDivergenceStore(dir, (db) =>
    (db.prepare('SELECT itemId FROM worklog_fts').all() as Array<{ itemId: string }>).map((r) => String(r.itemId)),
  );
}

/** Read the raw JSONL snapshot text (the authoritative source for repair). */
export function readDivergenceJsonl(dir: string): string {
  return fs.readFileSync(divergenceDataPath(dir), 'utf-8');
}

/**
 * Class 2: rewrite an existing canonical item's stored id — in both the
 * primary table and the FTS index — to a non-canonical form (lower-case by
 * default).
 *
 * Applied under the store mutation lock. Returns the stored (non-canonical)
 * id so callers can assert the exact-match/scan divergence against it.
 *
 * The item must exist in the primary table and must have no dependent rows
 * (comments/edges) that reference its id — the fixtures create a fresh item
 * for this purpose.
 */
export function demotePrimaryIdToNonCanonical(
  dir: string,
  canonicalId: string,
  storedId: string = canonicalId.toLowerCase(),
): string {
  return withStoreMutationLock(divergenceDataPath(dir), () =>
    withDivergenceStore(dir, (db) => {
      const fts = db
        .prepare('SELECT title, description, comments, tags, status, parentId FROM worklog_fts WHERE itemId = ?')
        .get(canonicalId) as
        | { title: string; description: string; comments: string; tags: string; status: string; parentId: string }
        | undefined;

      db.prepare('UPDATE workitems SET id = ? WHERE id = ?').run(storedId, canonicalId);

      if (fts) {
        db.prepare('DELETE FROM worklog_fts WHERE itemId = ?').run(canonicalId);
        db.prepare(
          'INSERT INTO worklog_fts (title, description, comments, tags, itemId, status, parentId) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(fts.title, fts.description, fts.comments, fts.tags, storedId, fts.status, fts.parentId);
      }
      return storedId;
    }),
  );
}

/**
 * Class 1a: plant a phantom `worklog_fts` row for an id with no matching
 * `workitems` row (removing any primary row that was there first).
 */
export function plantPhantomFtsEntry(
  dir: string,
  id: string,
  opts: { title?: string; status?: string } = {},
): void {
  withStoreMutationLock(divergenceDataPath(dir), () =>
    withDivergenceStore(dir, (db) => {
      db.prepare('DELETE FROM workitems WHERE id = ?').run(id);
      db.prepare('DELETE FROM worklog_fts WHERE itemId = ?').run(id);
      db.prepare(
        'INSERT INTO worklog_fts (title, description, comments, tags, itemId, status, parentId) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(opts.title ?? 'phantom item', '', '', '', id, opts.status ?? 'open', '');
    }),
  );
}

/**
 * Class 1b: drop the `worklog_fts` row for an id that remains in `workitems`
 * — an FTS gap, so `wl search` silently omits an item `wl list` returns.
 */
export function dropFtsEntry(dir: string, id: string): void {
  withStoreMutationLock(divergenceDataPath(dir), () =>
    withDivergenceStore(dir, (db) => {
      db.prepare('DELETE FROM worklog_fts WHERE itemId = ?').run(id);
    }),
  );
}

/**
 * Class 1c: write the authoritative JSONL snapshot holding the given items.
 *
 * The primary store is left untouched (the caller must already hold at least
 * one item so the constructor's empty-store JSONL refresh does not import the
 * snapshot). Used as the repair input for a genuinely missing primary row.
 */
export function writeDivergenceJsonlSnapshot(dir: string, items: WorkItem[]): void {
  withStoreMutationLock(divergenceDataPath(dir), () => {
    exportToJsonl(items, [], divergenceDataPath(dir), [], []);
  });
}

/** Build a minimal, fully-populated {@link WorkItem} for JSONL fixtures. */
export function makeDivergenceWorkItem(partial: Partial<WorkItem> & { id: string; title: string }): WorkItem {
  const now = new Date().toISOString();
  return {
    id: partial.id,
    title: partial.title,
    description: partial.description ?? '',
    status: partial.status ?? 'open',
    priority: partial.priority ?? 'medium',
    sortIndex: partial.sortIndex ?? 0,
    parentId: partial.parentId ?? null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    tags: partial.tags ?? [],
    assignee: partial.assignee ?? '',
    stage: partial.stage ?? '',
    issueType: partial.issueType ?? '',
    createdBy: partial.createdBy ?? '',
    deletedBy: partial.deletedBy ?? '',
    deleteReason: partial.deleteReason ?? '',
    risk: partial.risk ?? '',
    effort: partial.effort ?? '',
    githubIssueNumber: partial.githubIssueNumber,
    githubIssueId: partial.githubIssueId,
    githubIssueUpdatedAt: partial.githubIssueUpdatedAt,
    needsProducerReview: partial.needsProducerReview ?? false,
    auditWaiver: partial.auditWaiver ?? null,
  };
}
