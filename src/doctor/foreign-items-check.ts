/**
 * Foreign-item classification for `wl doctor foreign-items`.
 *
 * A work item is *foreign* when its ID prefix (the substring before the
 * first '-') does not match the project's configured prefix (e.g. `WL`
 * for ContextHub, `SA` for SorraAgents, `CG` for Tableau-Card-Engine,
 * `OSL` for open_source_llm). IDs without a '-' separator cannot be
 * classified and are left alone (treated as NOT foreign).
 */

import type { WorkItem } from '../types.js';

/**
 * Extract the ID prefix (substring before the first '-').
 *
 * @param id - The work item ID (e.g. `WL-0MSAH2A71000MUA3`).
 * @returns The prefix string, or `null` when the ID has no '-' separator
 *          (cannot be classified).
 */
export function extractIdPrefix(id: string): string | null {
  const dash = id.indexOf('-');
  if (dash <= 0) {
    return null; // no dash, or dash at position 0 (empty prefix)
  }
  return id.slice(0, dash);
}

/**
 * Determine whether a work item is foreign to the project.
 *
 * A work item is foreign when its ID prefix does not match the project's
 * configured prefix (case-insensitive). IDs without a '-' separator cannot
 * be classified and are treated as NOT foreign.
 *
 * @param id - The work item ID.
 * @param configPrefix - The project's configured prefix (e.g. `WL`).
 * @returns True when the item is foreign.
 */
export function isForeignItem(id: string, configPrefix: string): boolean {
  const prefix = extractIdPrefix(id);
  if (prefix === null) {
    return false;
  }
  return prefix.toUpperCase() !== configPrefix.toUpperCase();
}

/** Per-prefix grouping of foreign items. */
export interface ForeignItemPrefixGroup {
  count: number;
  deleted: number;
  nonDeleted: number;
  ids: string[];
}

/** Report produced by the foreign-items dry-run. */
export interface ForeignItemReport {
  success: boolean;
  dryRun: boolean;
  prefix: string;
  totalItems: number;
  foreignCount: number;
  deletedForeignCount: number;
  nonDeletedForeignCount: number;
  byPrefix: Record<string, ForeignItemPrefixGroup>;
  foreignIds: string[];
}

/**
 * Build a foreign-item report for a set of work items.
 *
 * @param items - All work items in the database.
 * @param configPrefix - The project's configured prefix (case-insensitive).
 * @param dryRun - Whether this is a dry-run (default true). The report is
 *                 read-only either way; the flag is echoed for callers that
 *                 render human output.
 * @returns The report with totals, per-prefix groups, and ID lists.
 */
export function buildForeignItemReport(
  items: WorkItem[],
  configPrefix: string,
  dryRun = true,
): ForeignItemReport {
  const byPrefix: Record<string, ForeignItemPrefixGroup> = {};
  const foreignIds: string[] = [];
  let deletedForeignCount = 0;
  let nonDeletedForeignCount = 0;

  for (const item of items) {
    const prefix = extractIdPrefix(item.id);
    if (prefix === null || !isForeignItem(item.id, configPrefix)) {
      continue;
    }
    const key = prefix.toUpperCase();
    const group = byPrefix[key] ?? { count: 0, deleted: 0, nonDeleted: 0, ids: [] };
    group.count += 1;
    group.ids.push(item.id);
    if (item.status === 'deleted') {
      group.deleted += 1;
      deletedForeignCount += 1;
    } else {
      group.nonDeleted += 1;
      nonDeletedForeignCount += 1;
    }
    byPrefix[key] = group;
    foreignIds.push(item.id);
  }

  return {
    success: true,
    dryRun,
    prefix: configPrefix.toUpperCase(),
    totalItems: items.length,
    foreignCount: foreignIds.length,
    deletedForeignCount,
    nonDeletedForeignCount,
    byPrefix,
    foreignIds,
  };
}

/** Result of applying the foreign-items cleanup. */
export interface ForeignItemApplyResult {
  success: boolean;
  apply: boolean;
  prefix: string;
  totalBefore: number;
  totalAfter: number;
  foreignBefore: number;
  foreignAfter: number;
  ownBefore: number;
  ownAfter: number;
  removedCount: number;
  removedByPrefix: Record<string, number>;
  removedIds: string[];
  /** Foreign ids kept because an own-prefix child still references them (default protect). */
  protectedIds: string[];
  /** Own-prefix children hard-deleted together with their foreign parent (cascade opt-in). */
  cascadedIds: string[];
  errors: Array<{ id: string; error: string }>;
}

/**
 * Hard-delete foreign items listed in the report, protecting or cascading
 * own-prefix children (cascade-or-refuse, R1).
 *
 * For each foreign item, the following are removed:
 * - the workitem row (via store.deleteWorkItem, which also removes
 *   dependency edges referencing the item and its comments)
 * - the audit_results row (NOT cascaded by deleteWorkItem)
 * - the FTS index entry (NOT cascaded by deleteWorkItem)
 *
 * Cascade-or-refuse guard: when a foreign item is still referenced as the
 * `parentId` of an own-prefix child (a child whose id prefix matches the
 * project prefix), the foreign item is **protected** by default — it stays in
 * the database and is reported in `protectedIds`. With the explicit
 * `cascadeChildren` opt-in, the foreign item is removed together with its
 * own-prefix descendants (hard-deleted), so no live own item is ever left
 * pointing at a vanished parent.
 *
 * Own items are never touched (except as cascaded descendants of a foreign
 * parent under the explicit opt-in). The operation is destructive and should
 * be gated by an explicit `--apply` flag by the caller.
 *
 * @param db - The WorklogDatabase instance (store accessed via `(db as any).store`).
 * @param report - The foreign-item report (only `foreignIds` and `prefix` are used).
 * @param opts - `cascadeChildren`: hard-delete own-prefix descendants instead
 *               of protecting the foreign parent (default false).
 * @returns Before/after counts, per-prefix removed counts, protected/cascaded
 *          ids, and any errors.
 */
export function applyForeignItemCleanup(
  db: { getAll(): WorkItem[] },
  report: Pick<ForeignItemReport, 'foreignIds' | 'prefix'>,
  opts: { cascadeChildren?: boolean } = {},
): ForeignItemApplyResult {
  const cascadeChildren = opts.cascadeChildren === true;
  const store = (db as any).store;
  const totalBefore = db.getAll().length;
  const foreignBefore = report.foreignIds.length;
  const ownBefore = totalBefore - foreignBefore;
  const configPrefix = report.prefix;

  // Index children by parent so we can find own-prefix children that
  // reference a foreign id (cascade-or-refuse guard).
  const childrenByParent = new Map<string, WorkItem[]>();
  for (const item of db.getAll()) {
    if (!item.parentId) continue;
    const siblings = childrenByParent.get(item.parentId) ?? [];
    siblings.push(item);
    childrenByParent.set(item.parentId, siblings);
  }
  const isOwnItem = (id: string): boolean => !isForeignItem(id, configPrefix);
  // Recursively collect own-prefix descendants of a foreign id.
  const ownDescendantsOf = (id: string): WorkItem[] => {
    const out: WorkItem[] = [];
    const stack = [...(childrenByParent.get(id) ?? [])];
    while (stack.length > 0) {
      const child = stack.pop()!;
      if (!isOwnItem(child.id)) continue; // foreign children are handled by the loop itself
      out.push(child);
      stack.push(...(childrenByParent.get(child.id) ?? []));
    }
    return out;
  };
  // A foreign id is protected when an own-prefix child (not itself deleted)
  // still points at it — deleting it would silently orphan that child.
  const hasLiveOwnChild = (id: string): boolean =>
    (childrenByParent.get(id) ?? []).some(c => isOwnItem(c.id) && c.status !== 'deleted');

  const removedIds: string[] = [];
  const removedByPrefix: Record<string, number> = {};
  const protectedIds: string[] = [];
  const cascadedIds: string[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  const alreadyRemoved = new Set<string>();

  const hardDelete = (targetId: string): boolean => {
    // Cascade beyond deleteWorkItem: audit results and FTS entries are NOT
    // removed by deleteWorkItem and must be cleaned explicitly.
    if (store && typeof store.deleteAuditResult === 'function') {
      try { store.deleteAuditResult(targetId); } catch (_) { /* best-effort */ }
    }
    if (store && typeof store.deleteFtsEntry === 'function') {
      try { store.deleteFtsEntry(targetId); } catch (_) { /* best-effort */ }
    }
    let ok = false;
    if (store && typeof store.deleteWorkItem === 'function') {
      ok = store.deleteWorkItem(targetId);
    }
    return ok;
  };

  for (const id of report.foreignIds) {
    const prefix = extractIdPrefix(id);
    const key = (prefix ?? '').toUpperCase();

    // Cascade-or-refuse: protect the foreign parent by default when an
    // own-prefix live child references it.
    if (hasLiveOwnChild(id) && !cascadeChildren) {
      protectedIds.push(id);
      continue;
    }

    try {
      // Cascade opt-in: hard-delete own-prefix descendants first, then the
      // foreign item itself — no own child is left pointing at a vanished parent.
      if (cascadeChildren) {
        for (const descendant of ownDescendantsOf(id)) {
          if (alreadyRemoved.has(descendant.id)) continue;
          if (hardDelete(descendant.id)) {
            cascadedIds.push(descendant.id);
            alreadyRemoved.add(descendant.id);
          } else {
            errors.push({ id: descendant.id, error: 'deleteWorkItem returned false (item not found)' });
          }
        }
      }
      if (alreadyRemoved.has(id)) continue;
      if (hardDelete(id)) {
        removedIds.push(id);
        alreadyRemoved.add(id);
        removedByPrefix[key] = (removedByPrefix[key] ?? 0) + 1;
      } else {
        errors.push({ id, error: 'deleteWorkItem returned false (item not found)' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ id, error: message });
    }
  }

  const totalAfter = db.getAll().length;
  const remainingIds = new Set(db.getAll().map(item => item.id));
  const foreignAfter = report.foreignIds.filter(id => remainingIds.has(id)).length;

  return {
    success: errors.length === 0,
    apply: true,
    prefix: report.prefix,
    totalBefore,
    totalAfter,
    foreignBefore,
    foreignAfter,
    ownBefore,
    ownAfter: totalAfter - foreignAfter,
    removedCount: removedIds.length,
    removedByPrefix,
    removedIds,
    protectedIds,
    cascadedIds,
    errors,
  };
}
