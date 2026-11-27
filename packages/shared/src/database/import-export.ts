/**
 * packages/shared/src/database/import-export.ts — whole-store snapshot
 * import/export for the `database.ts` decomposition.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP8MC0093Y7T (extract search, sync and import-export).
 *
 * ## Responsibility
 *
 * The in-process snapshot boundary of the store: the whole-store read
 * snapshots (`getAll`, `getAllOrderedByHierarchySortIndex`), the destructive
 * `clear`, the **destructive** differential `import` (replace semantics) and
 * the **non-destructive** `upsertItems` (incremental sync back from GitHub),
 * plus the no-op guard they share (`hasWorkItemChanged` from
 * `work-items.ts`) and the newest-wins audit merge the replace path uses.
 *
 * ## Boundary
 *
 * **Belongs here.** The diff/persist of a complete (or partial) item set,
 * its dependency edges and its audit rows, in one SQLite transaction; the
 * `updatedAt`/`activityAt` preservation rules that keep a no-change import
 * write-free. Reads and writes the store through `WorklogDatabaseContext`.
 *
 * **Does NOT belong here.** Record-level merge semantics for a *remote*
 * snapshot — the injected `services.sync` merger owns Git merge and
 * `sync.ts` owns the Git/JSONL round-trip and its watermarks. Also out of
 * scope: individual item CRUD (`work-items.ts`), hierarchy queries
 * (`hierarchy.ts`), comments/edges (`comments.ts`, `dependencies.ts`),
 * audits (`audit.ts`), sorting/selection, and search. No knowledge of the
 * `WorklogDatabase` façade; the extracted-module graph stays acyclic.
 *
 * `WorklogDatabase` keeps a thin delegating member per function so the façade
 * surface is unchanged (parent AC — public API untouched).
 */

import { WorkItem, DependencyEdge, AuditResult } from '../types.js';
import { WorklogDatabaseContext, laterTimestamp } from './context.js';
import { hasWorkItemChanged } from './work-items.js';

/**
 * Diagnostics returned by the dependency-edge persist paths.
 *
 * An incoming edge can be **unstorable** locally in two ways: it has no local
 * endpoint at all (a fully foreign edge) or its owner (`fromId`) is foreign,
 * which the `dependency_edges` schema rejects (`FOREIGN KEY (fromId) REFERENCES
 * workitems(id)`). Both are skipped rather than aborting the sync transaction,
 * and both are reported here — as `fromId->toId` — so the caller can surface
 * the loss instead of dropping the edge silently (WL-0MWXIT6H3006TY2I AC5).
 */
export interface DependencyEdgePersistReport {
  /** Edges the persist could not store locally, formatted `fromId->toId`. */
  droppedEdges: string[];
}

/**
 * Clear all work items (useful for import)
 */
export function clear(ctx: WorklogDatabaseContext): void {
  ctx.store.clearWorkItems();
}

/**
 * Get all work items as an array
 */
export function getAll(ctx: WorklogDatabaseContext): WorkItem[] {
  return ctx.store.getAllWorkItems();
}

/**
 * All work items in hierarchy sort-index order (createdAt/id fallback).
 */
export function getAllOrderedByHierarchySortIndex(ctx: WorklogDatabaseContext): WorkItem[] {
  return ctx.store.getAllWorkItemsOrderedByHierarchySortIndex();
}

/**
 * Fold a stored audit set and an incoming audit set into one entry per work
 * item, keeping the newest audit by `auditedAt` (stored wins exact ties).
 *
 * Used by the destructive {@link importWorkItems} path so a stale snapshot can
 * never downgrade a newer stored audit (SA-0MUJNFF3K009BF03). Delegates to the
 * injected sync merge when present, so this path shares the exact
 * last-write-wins semantics as `wl sync`; otherwise the same rule is applied
 * inline.
 */
export function mergeAuditsNewestWins(
  ctx: WorklogDatabaseContext,
  stored: AuditResult[],
  incoming: AuditResult[],
): AuditResult[] {
  const syncSvc = ctx.services.sync;
  if (syncSvc?.mergeAuditResults) {
    return syncSvc.mergeAuditResults(stored, incoming).merged as AuditResult[];
  }

  const byId = new Map<string, AuditResult>();
  for (const audit of stored) byId.set(audit.workItemId, audit);

  const timeOf = (audit: AuditResult): number | null => {
    const ms = typeof audit.auditedAt === 'string' ? Date.parse(audit.auditedAt) : NaN;
    return Number.isFinite(ms) ? ms : null;
  };

  for (const audit of incoming) {
    const current = byId.get(audit.workItemId);
    if (!current) {
      byId.set(audit.workItemId, audit);
      continue;
    }
    const incomingMs = timeOf(audit);
    const currentMs = timeOf(current);
    if (incomingMs !== null && currentMs !== null && incomingMs > currentMs) {
      byId.set(audit.workItemId, audit);
    }
  }

  return Array.from(byId.values());
}

/**
 * Import work items by **replacing** all existing data.
 *
 * **WARNING — DESTRUCTIVE**: any items, edges or audits NOT included in the
 * arguments are permanently deleted (comments cascade with their item).
 *
 * **Change detection (WL-0MVK3WRY9009KV6P / WL-0MVK6S9TN00500UL)**: the
 * replace is now differential rather than clear-and-re-insert. Records whose
 * merged value is identical to the stored value are not written at all, and
 * their FTS row is left untouched, so a no-change sync performs zero record
 * writes and zero FTS writes (F2 measured `upsertFtsEntry` at 78–90 % of the
 * persist CPU when every row was rewritten). Deleted ids still have their
 * item row, comments, edges, audit row and FTS entry removed.
 *
 * **Atomic**: the whole differential persist runs in one SQLite transaction
 * so that concurrent readers always see either the old complete state or the
 * new complete state — never an empty or partially-populated database. This
 * prevents the race condition where another Pi TUI instance's selection list
 * appears empty or stale during a sync operation.
 *
 * Only call this method with a **complete** item set (e.g. the result of
 * merging local + remote data). For partial / incremental updates — such as
 * syncing a subset of items back from GitHub — use {@link upsertItems}
 * instead, which preserves items not in the provided array.
 *
 * **No-op guard**: Before clearing, this method snapshots existing items.
 * For each incoming item that already exists and has identical tracked fields
 * (title, description, status, priority, sortIndex, parentId, tags, assignee,
 * stage, issueType, risk, effort, needsProducerReview), the original
 * `updatedAt` is preserved so that sync operations do not silently
 * re-timestamp unchanged items. Changed items get a new `updatedAt`;
 * entirely new items use the incoming value as-is.
 *
 * `needsProducerReview` is compared via `Boolean()` normalisation (see
 * `compareTrackedFields` in `./work-items.js`), so an omitted flag on
 * incoming items is treated as unchanged against a stored `false` — a no-op
 * re-import must not re-timestamp every item (WL-0MVB9557U009LEIF). A genuine
 * flip to `true` still counts as a change.
 *
 * Comparison is whitespace-insensitive for `title` and `description`
 * (via `compareTrackedFields`): trailing-newline strips / leading or
 * trailing whitespace / blank-line runs do NOT count as semantic changes,
 * so `wl sync` does not re-timestamp items whose meaningful content never
 * changed (WL-0MSORD6HC005QVZX). The incoming (normalized) content is still
 * persisted — only `updatedAt` is preserved.
 *
 * @param items - The full set of work items to store.
 * @param dependencyEdges - Optional full set of dependency edges. When
 *   provided, edges absent from this set are deleted and only new/changed
 *   edges are written.
 * @param auditResults - Optional full set of audit results. When provided,
 *   existing audit results are replaced with these — but never with an
 *   OLDER row than a stored one for the same item (monotonic,
 *   SA-0MUJNFF3K009BF03).
 * @returns The ids of incoming edges that could not be stored locally.
 */
export function importWorkItems(
  ctx: WorklogDatabaseContext,
  items: WorkItem[],
  dependencyEdges?: DependencyEdge[],
  auditResults?: AuditResult[],
): DependencyEdgePersistReport {
  const droppedEdges: string[] = [];
  // Snapshot the current state up front: it is the diff base for every
  // record type, so unchanged rows are never re-written.
  const existingItems = new Map<string, WorkItem>();
  for (const existing of ctx.store.getAllWorkItems()) {
    existingItems.set(existing.id, existing);
  }
  const storedAudits = ctx.store.getAllAuditResults();
  const storedEdges = dependencyEdges ? ctx.store.getAllDependencyEdges() : [];
  const importedIdSet = new Set(items.map(item => item.id));

  // Destructive-replace semantics are preserved: ids absent from the
  // incoming snapshot are deleted (their comments, edges and audit rows
  // cascade through the FK constraints, their FTS row is removed below).
  const removedIds = Array.from(existingItems.keys()).filter(id => !importedIdSet.has(id));

  // One transaction for the whole differential persist so concurrent
  // readers never see an empty or partially-populated database during sync.
  ctx.store.transaction(() => {
    for (const id of removedIds) {
      ctx.store.deleteWorkItem(id);
      if (ctx.store.ftsAvailable) {
        ctx.store.deleteFtsEntry(id);
      }
    }

    for (const item of items) {
      const existing = existingItems.get(item.id);
      let toSave: WorkItem;
      if (existing && !hasWorkItemChanged(existing, item)) {
        // Semantically unchanged — preserve the existing updatedAt and keep
        // the later activityAt. Only write when the merged activityAt
        // actually advances, so a true no-change import performs zero
        // writes (comment activity must never be lost — WL-0MUBVH6JM0093KVM).
        const activityAt = laterTimestamp(item.activityAt, existing.activityAt);
        if (activityAt === existing.activityAt) {
          continue;
        }
        toSave = { ...item, updatedAt: existing.updatedAt, activityAt };
      } else if (existing) {
        // Semantic change detected — bump the timestamp.
        toSave = {
          ...item,
          updatedAt: new Date().toISOString(),
          activityAt: laterTimestamp(item.activityAt, existing.activityAt),
        };
      } else {
        // New item — use the incoming updatedAt as-is.
        toSave = item;
      }
      ctx.store.saveWorkItem(toSave);
      // Keep FTS fresh only for the records actually written.
      if (ctx.store.ftsAvailable) {
        ctx.store.upsertFtsEntry(toSave);
      }
    }

    if (dependencyEdges) {
      // Replace the edge set differentially: drop edges absent from the
      // incoming set, write only new/changed edges whose **either** endpoint
      // exists locally — so a `local → foreign` cross-repo edge survives
      // the destructive replace (WL-0MWXIT6H3006TY2I).
      const desiredEdges = new Map<string, DependencyEdge>();
      for (const edge of dependencyEdges) {
        if (ctx.store.getWorkItem(edge.fromId) || ctx.store.getWorkItem(edge.toId)) {
          desiredEdges.set(`${edge.fromId}\u0000${edge.toId}`, edge);
        } else {
          // No local anchor for either endpoint — the edge cannot be stored
          // and has no local owner to cascade from. Report it rather than
          // dropping it silently (WL-0MWXIT6H3006TY2I AC5).
          droppedEdges.push(`${edge.fromId}->${edge.toId}`);
        }
      }
      const storedEdgeKey = new Map<string, DependencyEdge>();
      for (const edge of storedEdges) {
        storedEdgeKey.set(`${edge.fromId}\u0000${edge.toId}`, edge);
      }
      for (const [key, edge] of storedEdgeKey) {
        if (!desiredEdges.has(key)) {
          ctx.store.deleteDependencyEdge(edge.fromId, edge.toId);
        }
      }
      for (const [key, edge] of desiredEdges) {
        const stored = storedEdgeKey.get(key);
        if (!stored || stored.createdAt !== edge.createdAt) {
          // `dependency_edges` has a foreign key on `fromId`, so an edge whose
          // owner is not a local item cannot be stored. Skip it rather than
          // abort the whole sync transaction, but report it so the skip is
          // never silent (WL-0MWXIT6H3006TY2I AC5).
          if (ctx.store.getWorkItem(edge.fromId)) {
            ctx.store.saveDependencyEdge(edge);
          } else {
            droppedEdges.push(`${edge.fromId}->${edge.toId}`);
          }
        }
      }
    }

    // Newest-wins: the incoming set replaces the stored set except where an
    // incoming row is strictly older than a stored row for the same item.
    // Only rows that actually differ from the stored value are written.
    const survivingAudits = storedAudits.filter(audit => importedIdSet.has(audit.workItemId));
    const mergedAudits = auditResults
      ? mergeAuditsNewestWins(ctx, survivingAudits, auditResults)
      : survivingAudits;
    const storedAuditByItem = new Map(storedAudits.map(audit => [audit.workItemId, audit]));
    const auditsToSave = mergedAudits.filter(audit => {
      const stored = storedAuditByItem.get(audit.workItemId);
      if (!stored) {
        return true;
      }
      return (
        stored.readyToClose !== audit.readyToClose ||
        stored.auditedAt !== audit.auditedAt ||
        (stored.summary ?? null) !== (audit.summary ?? null) ||
        (stored.rawOutput ?? null) !== (audit.rawOutput ?? null) ||
        (stored.author ?? null) !== (audit.author ?? null) ||
        (stored.fingerprint ?? null) !== (audit.fingerprint ?? null)
      );
    });
    if (auditsToSave.length > 0) {
      ctx.store.saveAuditResults(auditsToSave);
    }
  });

  ctx.writeHooks.triggerAutoSync();
  return { droppedEdges };
}

/**
 * Upsert work items non-destructively (INSERT OR REPLACE without clearing).
 *
 * Unlike `importWorkItems()`, this method does NOT call `clearWorkItems()` or
 * `clearDependencyEdges()`. It saves each provided item via the store's
 * `saveWorkItem()` (which uses INSERT … ON CONFLICT DO UPDATE) so that
 * existing items not in the provided array are preserved.
 *
 * **No-op guard**: For each item that already exists in the store AND has
 * identical tracked fields (same field set as `hasWorkItemChanged`,
 * whitespace-insensitive for `title`/`description`, `Boolean()`-normalised
 * for `needsProducerReview`), the save is entirely
 * skipped — preserving the existing `updatedAt`. Items whose tracked fields
 * differ, or that are new, get a fresh `updatedAt` timestamp.
 *
 * When `dependencyEdges` is provided, only edges whose `fromId` or `toId`
 * belongs to the provided items are upserted; all other edges are untouched.
 * An upserted edge is persisted when **either** endpoint resolves to a stored
 * item, so a `local → foreign` cross-repo blocker is retained
 * (WL-0MWXIT6H3006TY2I); only an edge whose both endpoints are unresolvable
 * is skipped, and every skip is reported in the returned diagnostics.
 *
 * If `items` is empty the method is a no-op (no export/sync triggered).
 *
 * @returns The ids of affected edges that could not be stored locally.
 */
export function upsertItems(
  ctx: WorklogDatabaseContext,
  items: WorkItem[],
  dependencyEdges?: DependencyEdge[],
): DependencyEdgePersistReport {
  if (items.length === 0) {
    return { droppedEdges: [] };
  }
  const droppedEdges: string[] = [];

  for (const item of items) {
    const existing = ctx.store.getWorkItem(item.id);
    if (existing && !hasWorkItemChanged(existing, item)) {
      // No semantic change — skip the save entirely to preserve updatedAt
      continue;
    }
    // Either a new item or a semantic change — bump the timestamp, keeping
    // the later activityAt (comment activity must not be lost on sync).
    const itemToSave = existing
      ? { ...item, updatedAt: new Date().toISOString(), activityAt: laterTimestamp(item.activityAt, existing.activityAt) }
      : item;
    ctx.store.saveWorkItem(itemToSave);
    // Keep the FTS index fresh for the upserted item
    if (ctx.store.ftsAvailable) {
      ctx.store.upsertFtsEntry(itemToSave);
    }
  }

  if (dependencyEdges) {
    const affectedIds = new Set(items.map(i => i.id));
    for (const edge of dependencyEdges) {
      if (!affectedIds.has(edge.fromId) && !affectedIds.has(edge.toId)) {
        // Untouched by this upsert — not a loss, so not reported.
        continue;
      }
      // Keep when either endpoint resolves (a `local → foreign` cross-repo
      // edge has a foreign target), but the owner must exist locally: the
      // `dependency_edges` schema has a foreign key on `fromId`, so a
      // `foreign → local` edge is unstorable and is skipped. Report the skip
      // so the loss is never silent (WL-0MWXIT6H3006TY2I AC5).
      if (ctx.store.getWorkItem(edge.fromId)) {
        ctx.store.saveDependencyEdge(edge);
      } else {
        droppedEdges.push(`${edge.fromId}->${edge.toId}`);
      }
    }
  }

  ctx.writeHooks.triggerAutoSync();
  return { droppedEdges };
}
