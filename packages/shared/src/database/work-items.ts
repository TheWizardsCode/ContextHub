/**
 * packages/shared/src/database/work-items.ts — work-item CRUD and the
 * tracked-field diff helpers for the `database.ts` decomposition.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP4J6003ZKML (extract work-item and hierarchy modules).
 *
 * ## Responsibility
 *
 * The single home of the work-item record lifecycle and of duplicate
 * detection: `create`, `createWithNextSortIndex`, `getRecentDuplicate`
 * (title-normalised dedup guard), `get`, `updateIfMatches` (the CAS claim),
 * `update` (with the no-op / metadata-only `updatedAt` rules),
 * `delete`/`deleteSingle` (recursive soft delete with attribution), `list`
 * (query filtering), and the tracked-field diff helpers they share
 * (`compareTrackedFields`, `hasWorkItemChanged`).
 *
 * ## Boundary
 *
 * **Belongs here.** Every read/write of a single work-item row, plus the
 * semantic "did this change?" predicates that decide whether `updatedAt` and
 * the sync delta are bumped. Reads and writes the store through
 * `WorklogDatabaseContext`; write-side collaborators that are not (yet) part
 * of this slice — semantic indexing, dependency reconciliation, and the tree
 * walk `delete()` performs — are reached through `ItemHooks` (wired by the
 * façade), never by importing the façade or a sibling module.
 *
 * **Does NOT belong here.** Tree traversal, child counts, priority cascade and
 * parent demotion (`hierarchy.ts`, which imports `get`/`update` from here);
 * dependency-edge CRUD and blocker reconciliation (`dependencies`, still on the
 * façade); comments, audits, search, sync, import/export. No knowledge of the
 * `WorklogDatabase` façade; the graph stays acyclic.
 *
 * `WorklogDatabase` keeps a thin delegating member per function so the façade
 * surface is unchanged (parent AC — public API untouched). `delete` exports as
 * `deleteWorkItem` because `delete` is a reserved word; the façade member keeps
 * the original public name and signature.
 */

import {
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItem,
  WorkItemQuery,
} from '../types.js';
import { normalizeStatusValue } from '../status-stage-rules.js';
import {
  ItemHooks,
  UpdateIfMatchesResult,
  WorklogDatabaseContext,
  generateId,
  normalizeTitleForMatch,
} from './context.js';

/**
 * Create a new work item.
 *
 * Status is normalised to its canonical hyphenated form on write (so
 * `in_progress` and `in-progress` never coexist in the store), the FTS entry is
 * upserted, comment caches that the semantic-index trigger may have populated
 * with stale data are cleared, and auto-sync (when enabled) is triggered.
 */
export function create(
  ctx: WorklogDatabaseContext,
  hooks: ItemHooks,
  input: CreateWorkItemInput,
): WorkItem {
  const id = generateId(ctx);
  const now = new Date().toISOString();

  const item: WorkItem = {
    id,
    title: input.title,
    description: input.description || '',
    status: (normalizeStatusValue(input.status) ?? input.status ?? 'open') as WorkItem['status'],
    priority: input.priority || 'medium',
    sortIndex: input.sortIndex ?? 0,
    parentId: input.parentId || null,
    createdAt: now,
    updatedAt: now,
    tags: input.tags || [],
    assignee: input.assignee || '',
    stage: input.stage || '',

    issueType: input.issueType || '',
    createdBy: input.createdBy || '',
    deletedBy: input.deletedBy || '',
    deleteReason: input.deleteReason || '',
    risk: input.risk || '',
    effort: input.effort || '',
    githubIssueNumber: undefined,
    githubIssueId: undefined,
    githubIssueUpdatedAt: undefined,
    // default for the new flag
    needsProducerReview: input.needsProducerReview ?? false,
  };

  ctx.store.saveWorkItem(item);
  ctx.store.upsertFtsEntry(item);
  hooks.triggerSemanticIndex(item);
  // Clear comment caches that triggerSemanticIndex may have populated
  // with stale (empty) data, so subsequent reads see fresh results.
  ctx.store.clearCommentCaches();
  ctx.writeHooks.triggerAutoSync();
  return item;
}

/**
 * Create a work item after the last sibling in hierarchy order, using the
 * same `gap` spacing as an explicit `reSort`.
 */
export function createWithNextSortIndex(
  ctx: WorklogDatabaseContext,
  hooks: ItemHooks,
  input: CreateWorkItemInput,
  gap: number = 100,
): WorkItem {
  const siblings = ctx.store
    .getAllWorkItems()
    .filter(item => item.parentId === (input.parentId ?? null));
  const ordered = hooks.orderBySortIndex(siblings);
  const maxSortIndex = ordered.reduce((max, item) => Math.max(max, item.sortIndex ?? 0), 0);
  const sortIndex = maxSortIndex + gap;
  return create(ctx, hooks, { ...input, sortIndex });
}

/**
 * Find the most recent non-terminal work item whose title matches `title`
 * under case/whitespace normalization and was created within `windowMs`.
 *
 * Backs the `wl create` dedup guard (WL-0MSTNG2QF0049B97): retrying an
 * identical create command (common when agents lose the tool result to
 * output trimming) must return the existing item instead of creating a
 * byte-identical twin. Only non-terminal items (open/in-progress/blocked)
 * within the recent window are considered — completed items and stale
 * same-title items are deliberately unrelated.
 *
 * @param title - The candidate title (compared case- and whitespace-
 *   insensitively against stored titles).
 * @param windowMs - Look-back window in milliseconds; only items created
 *   strictly after `now - windowMs` match.
 * @param prefix - Prefix scope; defaults to this database's prefix. Only
 *   items whose id starts with `<prefix>-` are considered.
 * @returns The newest matching item, or null when no match exists.
 */
export function getRecentDuplicate(
  ctx: WorklogDatabaseContext,
  title: string,
  windowMs: number,
  prefix?: string,
): WorkItem | null {
  const effectivePrefix = (prefix ?? ctx.prefix).toUpperCase();
  return ctx.store.getRecentDuplicateByNormalizedTitle(
    normalizeTitleForMatch(title),
    windowMs,
    effectivePrefix,
  );
}

/**
 * Get a work item by ID
 */
export function get(ctx: WorklogDatabaseContext, id: string): WorkItem | null {
  return ctx.store.getWorkItem(id);
}

/**
 * Conditional update (compare-and-swap, RCA WL-0MSRBFFLN005W3VT design
 * point 1): apply `input` ONLY if the item's current status/stage/assignee
 * match the expected guard. Runs the check and the write inside a single
 * `BEGIN IMMEDIATE` transaction (see `PersistentStore.transactionImmediate`),
 * so two concurrent `wl update --if-status/--if-stage/--if-assignee`
 * processes serialize on the SQLite write lock: exactly one observes the
 * expected state and wins; the loser observes the winner's committed
 * transition and fails `stale` without writing.
 *
 * `expected.assignee` distinguishes an explicit empty-string guard (match
 * an unassigned item — the status-neutral audit-tier claim) from an omitted
 * guard (`undefined`): the empty string is a meaningful expected value, not
 * a "no guard" sentinel.
 *
 * @returns `{ok:true, item}` on success; `{ok:false, reason:'not-found'}`
 * when the id is absent; `{ok:false, reason:'stale'}` when the guard
 * mismatch means another process already changed the item.
 */
export function updateIfMatches(
  ctx: WorklogDatabaseContext,
  hooks: ItemHooks,
  id: string,
  input: UpdateWorkItemInput,
  expected: { status?: string; stage?: string; assignee?: string } = {},
): UpdateIfMatchesResult {
  return ctx.store.transactionImmediate<UpdateIfMatchesResult>(() => {
    const current = ctx.store.getWorkItem(id);
    if (!current) {
      return { ok: false, reason: 'not-found' };
    }
    if (expected.status !== undefined) {
      const want = normalizeStatusValue(expected.status) ?? expected.status;
      const have = normalizeStatusValue(current.status) ?? current.status;
      if (want !== have) {
        return { ok: false, reason: 'stale' };
      }
    }
    if (expected.stage !== undefined && current.stage !== expected.stage) {
      return { ok: false, reason: 'stale' };
    }
    if (expected.assignee !== undefined && (current.assignee ?? '') !== expected.assignee) {
      return { ok: false, reason: 'stale' };
    }
    const updated = update(ctx, hooks, id, input);
    return updated ? { ok: true, item: updated } : { ok: false, reason: 'not-found' };
  });
}

/**
 * Update a work item
 */
export function update(
  ctx: WorklogDatabaseContext,
  hooks: ItemHooks,
  id: string,
  input: UpdateWorkItemInput,
): WorkItem | null {
  const item = ctx.store.getWorkItem(id);
  if (!item) {
    return null;
  }

  const previousStatus = item.status;
  const previousStage = item.stage;

  // Build the new state to detect what actually changed
  const updated: WorkItem = {
    ...item,
    ...input,
    id: item.id, // Prevent ID changes
    // Normalize status to canonical hyphenated form (e.g. in_progress -> in-progress)
    status: (normalizeStatusValue(input.status ?? item.status) ?? item.status) as WorkItem['status'],
    createdAt: item.createdAt, // Prevent createdAt changes
    githubIssueNumber: item.githubIssueNumber,
    githubIssueId: item.githubIssueId,
    githubIssueUpdatedAt: item.githubIssueUpdatedAt,
  };

  // Detect whether any tracked field actually changed.  If the update is a
  // no-op (same values as the existing item), preserve the original
  // updatedAt to avoid silent re-timestamping during bulk operations.
  // Note: githubIssueNumber/Id/UpdatedAt are intentionally excluded from
  // this comparison because the update method above explicitly preserves
  // the existing values for these fields (prevents manual update from
  // overwriting GitHub metadata). Only hasWorkItemChanged() checks them.
  const contentFieldsToCompare: (keyof WorkItem)[] = [
    'title', 'description', 'status', 'priority', 'sortIndex', 'parentId',
    'tags', 'assignee', 'stage', 'issueType', 'risk', 'effort',
    'deletedBy', 'deleteReason'
  ];
  const fieldsToCompare: (keyof WorkItem)[] = [
    ...contentFieldsToCompare,
    'needsProducerReview'
  ];
  // Shared comparator: whitespace-only diffs in title/description are not
  // semantic changes (WL-0MSORD6HC005QVZX). Same normalization as
  // hasWorkItemChanged().
  const hasChanged = compareTrackedFields(item, updated, fieldsToCompare);

  if (!hasChanged) {
    // Nothing changed — preserve original updatedAt and return early
    // without writing to the store or triggering autoSync.
    updated.updatedAt = item.updatedAt;
    return updated;
  }

  // At least one tracked field changed.  Check whether a content field
  // actually changed — only then bump the timestamp.  This prevents
  // needsProducerReview-only flips from invalidating audits
  // (WL-0MSN6ZCTN0027U2R).  A metadata-only change still persists the
  // flag but preserves the timestamp so that existing audits remain fresh.
  const contentChanged = compareTrackedFields(item, updated, contentFieldsToCompare);
  if (contentChanged) {
    updated.updatedAt = new Date().toISOString();
  } else {
    // Metadata-only change (e.g. needsProducerReview): preserve the
    // original updatedAt so existing audits remain fresh.
    updated.updatedAt = item.updatedAt;
  }

  if (process.env.WL_DEBUG_SQL_BINDINGS) {
    try {
      const repr: any = {};
      for (const k of Object.keys(updated)) {
        try {
          const v = (updated as any)[k];
          repr[k] = { type: v === null ? 'null' : typeof v, constructor: v && v.constructor ? v.constructor.name : null };
        } catch (_e) {
          repr[k] = { type: 'unreadable' };
        }
      }
      console.error('WL_DEBUG_SQL_BINDINGS WorklogDatabase.update prepared updated types:', JSON.stringify(repr, null, 2));
      // Also log description to capture non-string values
      try { console.error('WL_DEBUG_SQL_BINDINGS WorklogDatabase.update description value:', (updated as any).description); } catch (_e) { /* ignore */ }
    } catch (_e) {
      console.error('WL_DEBUG_SQL_BINDINGS WorklogDatabase.update: failed to prepare updated log');
    }
  }

  ctx.store.saveWorkItem(updated);
  ctx.store.upsertFtsEntry(updated);
  hooks.triggerSemanticIndex(updated);
  ctx.writeHooks.triggerAutoSync();

  if (previousStatus !== updated.status || previousStage !== updated.stage) {
    // Reconcile the item itself (e.g., re-block when reopened while
    // active blockers still exist, or unblock when all blockers completed
    // if the item was previously manually blocked without blockers).
    hooks.reconcileDependentStatus(id);
    // Reconcile all items that depend on this item
    if (hooks.listDependencyEdgesTo(id).length > 0) {
      hooks.reconcileDependentsForTarget(id);
    }
  }
  return updated;
}

/**
 * Delete a work item
 *
 * If the item has children, recursively deletes all descendants first,
 * then deletes the item itself. This prevents orphaned children from
 * remaining with stale parentId references.
 *
 * @param id - The ID of the work item to delete
 * @param recursive - Whether to recursively delete descendants (default: true)
 * @param opts - Optional attribution: deletedBy (identity) / deleteReason (why).
 *   Deletes are ATTRIBUTED (WL-0MSKZ30SK007K9TO, F4): pass non-empty values so
 *   the soft-delete carries real intent — unattributed deletes never
 *   merge-propagate over a live remote item (delete-side protection in the
 *   merge layer).
 */
export function deleteWorkItem(
  ctx: WorklogDatabaseContext,
  hooks: ItemHooks,
  id: string,
  recursive: boolean = true,
  opts?: { deletedBy?: string; deleteReason?: string },
): boolean {
  const item = ctx.store.getWorkItem(id);
  if (!item) {
    return false;
  }

  // Recursively delete all descendants first (children, grandchildren, etc.)
  if (recursive) {
    const descendants = hooks.getDescendants(id);
    // Delete from leaf to root so parent-child relationships are handled
    // in reverse depth order (descendants sorted deepest-first)
    const deepestFirst = [...descendants].sort((a, b) => {
      const depthA = hooks.getDepth(a.id);
      const depthB = hooks.getDepth(b.id);
      return depthB - depthA;
    });
    for (const descendant of deepestFirst) {
      deleteSingle(ctx, hooks, descendant.id, opts);
    }
  }

  // Now delete the item itself
  return deleteSingle(ctx, hooks, id, opts);
}

/**
 * Internal: Mark a single work item as deleted (no recursive child handling).
 * Persists attribution (deletedBy/deleteReason) when provided — the merge
 * layer's delete-side protection relies on it to distinguish real intent
 * from bogus/stale deleted markers.
 */
export function deleteSingle(
  ctx: WorklogDatabaseContext,
  hooks: ItemHooks,
  id: string,
  opts?: { deletedBy?: string; deleteReason?: string },
): boolean {
  const item = ctx.store.getWorkItem(id);
  if (!item) {
    return false;
  }

  const updated: WorkItem = {
    ...item,
    status: 'deleted',
    // Preserve the existing stage so UI/clients can still show where the
    // item was in the workflow when it was deleted. Clearing the stage
    // caused unexpected regressions in clients/tests that expect the
    // original stage to be retained.
    stage: item.stage,
    deletedBy: opts?.deletedBy || item.deletedBy || '',
    deleteReason: opts?.deleteReason || item.deleteReason || '',
    updatedAt: new Date().toISOString(),
  };

  ctx.store.saveWorkItem(updated);
  ctx.store.deleteFtsEntry(id);
  hooks.removeFromSemanticIndex(id);
  ctx.writeHooks.triggerAutoSync();
  if (hooks.listDependencyEdgesTo(id).length > 0) {
    hooks.reconcileDependentsForTarget(id);
  }
  return true;
}

/**
 * List all work items
 */
export function list(ctx: WorklogDatabaseContext, query?: WorkItemQuery): WorkItem[] {
  let items = ctx.store.getAllWorkItems();

  if (query) {
    if (query.status && query.status.length > 0) {
      // Status values are normalized to hyphenated form on write/import,
      // so we normalize each query value for comparison.
      const normalizedStatuses = query.status.map(s => normalizeStatusValue(s) ?? s);
      items = items.filter(item => normalizedStatuses.includes(item.status));
    }
    if (query.priority) {
      items = items.filter(item => item.priority === query.priority);
    }
    if (query.parentId !== undefined) {
      items = items.filter(item => item.parentId === query.parentId);
    }
    if (query.rootOnly) {
      items = items.filter(item => item.parentId === null);
    }
    if (query.tags && query.tags.length > 0) {
      items = items.filter(item => 
        query.tags!.some(tag => item.tags.includes(tag))
      );
    }
    if (query.assignee) {
      items = items.filter(item => item.assignee === query.assignee);
    }
    if (query.stage) {
      items = items.filter(item => item.stage === query.stage);
    }
    if (query.issueType) {
      items = items.filter(item => item.issueType === query.issueType);
    }
    if (query.createdBy) {
      items = items.filter(item => item.createdBy === query.createdBy);
    }
    if (query.deletedBy) {
      items = items.filter(item => item.deletedBy === query.deletedBy);
    }
    if (query.deleteReason) {
      items = items.filter(item => item.deleteReason === query.deleteReason);
    }
    if (query.needsProducerReview !== undefined) {
      items = items.filter(item => Boolean(item.needsProducerReview) === Boolean(query.needsProducerReview));
    }
  }

  return items;
}

/**
 * Compare two items over a tracked field set and return true when any field
 * semantically changed.
 *
 * Comparison rules (unchanged from the pre-extraction façade):
 *  - `title` / `description`: whitespace-only differences are not semantic
 *    changes (WL-0MSORD6HC005QVZX).
 *  - `needsProducerReview`: normalised through `Boolean()` so that an omitted
 *    flag (undefined on incoming items) is equivalent to an explicit `false`
 *    (the value stored items round-trip to) — no-op re-imports must not bump
 *    `updatedAt` (WL-0MVB9557U009LEIF).
 *  - arrays (tags) are compared by value; all other fields use strict
 *    equality.
 *
 * Shared by {@link hasWorkItemChanged} (16-field tracked set, used by
 * import()/upsertItems()) and the no-op guard in {@link update} (13-field
 * set, excluding the GitHub metadata fields).
 */
export function compareTrackedFields(oldItem: WorkItem, newItem: WorkItem, fields: (keyof WorkItem)[]): boolean {
  return fields.some(f => {
    const oldVal = oldItem[f];
    const newVal = newItem[f];
    if (f === 'title' || f === 'description') {
      // Whitespace-only differences (trailing newline strip/normalization)
      // are not semantic changes — compare normalized text only.
      return String(oldVal ?? '').trim() !== String(newVal ?? '').trim();
    }
    if (f === 'needsProducerReview') {
      // Stored items round-trip this flag through Boolean() (SQLite INTEGER
      // column), while incoming import/upsert items may omit the key
      // (undefined). Normalise so an omitted flag is equivalent to an
      // explicit false — otherwise every no-op re-import looks like a
      // semantic change and updatedAt gets bumped (WL-0MVB9557U009LEIF).
      return Boolean(oldVal) !== Boolean(newVal);
    }
    if (Array.isArray(oldVal) && Array.isArray(newVal)) {
      return JSON.stringify(oldVal) !== JSON.stringify(newVal);
    }
    return oldVal !== newVal;
  });
}

/**
 * Compare an existing work item against a candidate and return true if any
 * tracked field has semantically changed.
 *
 * Uses the same field set and comparison logic as the no-op guard in {@link update}
 * (via {@link compareTrackedFields}). `needsProducerReview` is compared via
 * `Boolean()` normalisation, so incoming items that omit the flag are not
 * treated as changed against stored `false` values (WL-0MVB9557U009LEIF).
 */
export function hasWorkItemChanged(oldItem: WorkItem, newItem: WorkItem): boolean {
  const fieldsToCompare: (keyof WorkItem)[] = [
    'title', 'description', 'status', 'priority', 'sortIndex', 'parentId',
    'tags', 'assignee', 'stage', 'issueType', 'risk', 'effort',
    'needsProducerReview', 'githubIssueNumber', 'githubIssueId',
    'githubIssueUpdatedAt'
  ];
  return compareTrackedFields(oldItem, newItem, fieldsToCompare);
}
