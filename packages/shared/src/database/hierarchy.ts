/**
 * packages/shared/src/database/hierarchy.ts — tree traversal, child queries
 * and the parent-lifecycle transitions of the `database.ts` decomposition.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP4J6003ZKML (extract work-item and hierarchy modules).
 *
 * ## Responsibility
 *
 * Everything that reasons about the parent/child tree without moving rows
 * beyond it: `getChildren` and `getChildCounts` (direct children),
 * `getNonClosedChildren` (open subtree frontier), `getDescendants` /
 * `isLeafNode` / `getLeafDescendants` / `getDepth` (recursive traversal), and
 * the three lifecycle transitions that fix a parent's state when the subtree
 * changes — `cascadePriorityDowngrade` (critical children of a demoted
 * parent), `demoteParentOnChildAdded` (completed/in_review parent gets a new
 * child), `revertToPlanComplete` (post-audit not-ready reversion).
 *
 * ## Boundary
 *
 * **Belongs here.** Tree-shape queries and the three parent-state
 * transitions. Reads the store through `WorklogDatabaseContext`; traversal
 * results are computed here, never by the caller.
 *
 * **Does NOT belong here.** Work-item row CRUD (`create`/`update`/`delete`),
 * duplicate detection and the diff helpers — this module imports
 * `get`/`update` from `work-items.ts` for the transitions above, which is the
 * single allowed dependency direction of this slice (`hierarchy.ts` →
 * `work-items.ts` → `context.ts`). Sort-index ordering (`sort.ts`),
 * dependency/blocker reconciliation (façade until its slice), semantic
 * indexing, audits, search, sync. No knowledge of the `WorklogDatabase`
 * façade; the graph stays acyclic.
 *
 * `WorklogDatabase` keeps a thin delegating member per function so the façade
 * surface is unchanged (parent AC — public API untouched).
 */

import {
  DemotedParent,
  RevertedItem,
  WorkItem,
  WorkItemPriority,
} from '../types.js';
import {
  EdgeCache,
  ItemHooks,
  WorklogDatabaseContext,
} from './context.js';
import { get, update } from './work-items.js';

/**
 * Get children of a work item
 */
export function getChildren(ctx: WorklogDatabaseContext, parentId: string): WorkItem[] {
  return ctx.store.getAllWorkItems().filter(
    item => item.parentId === parentId
  );
}

/**
 * Cascade a priority downgrade to direct children.
 *
 * When a work item's priority is reduced away from `critical`, any direct
 * children still at `critical` priority are downgraded to `high` so that
 * critical-priority subtasks of a non-critical parent are resolved.
 * Children already at `high`, `medium`, or `low` are left untouched, and
 * grandchildren are not affected.
 *
 * @param parentId - id of the work item whose children should be checked
 * @param newPriority - the parent's new priority; when still `critical`
 *   this is a no-op (no children are touched)
 * @returns the list of children whose priority was downgraded (empty if none)
 */
export function cascadePriorityDowngrade(
  ctx: WorklogDatabaseContext,
  hooks: ItemHooks,
  parentId: string,
  newPriority: WorkItemPriority,
): WorkItem[] {
  if (newPriority === 'critical') {
    return [];
  }
  const downgraded: WorkItem[] = [];
  const children = getChildren(ctx, parentId);
  for (const child of children) {
    if (child.priority === 'critical') {
      const updated = update(ctx, hooks, child.id, { priority: 'high' });
      if (updated) {
        downgraded.push(updated);
      }
    }
  }
  return downgraded;
}

/**
 * Demote a parent work item when a child is added to it.
 *
 * A parent cannot be `completed` (status) or `in_review` (stage) while its
 * subtree is not finished. When a new child is attached to such a parent
 * (via `wl create --parent` or `wl update --parent`), the parent is moved
 * back to `open` / `plan_complete` so its lifecycle state always reflects
 * that it has uncompleted children.
 *
 * Only the direct parent is demoted; ancestors are left untouched.
 *
 * @param parentId - id of the parent that received the new child
 * @returns the demotion details (parent, from status/stage, to status/stage)
 *   or `null` when the parent is not in an eligible state (or does not exist)
 */
export function demoteParentOnChildAdded(
  ctx: WorklogDatabaseContext,
  hooks: ItemHooks,
  parentId: string,
): DemotedParent | null {
  const parent = get(ctx, parentId);
  if (!parent) {
    return null;
  }
  const eligible = parent.status === 'completed' || parent.stage === 'in_review';
  if (!eligible) {
    return null;
  }
  const from = { status: parent.status, stage: parent.stage };
  const updated = update(ctx, hooks, parentId, { status: 'open', stage: 'plan_complete' });
  if (!updated) {
    return null;
  }
  return {
    parent: updated,
    from,
    to: { status: updated.status, stage: updated.stage },
  };
}

/**
 * Revert an item to `open`/`plan_complete` after a "not ready to close"
 * audit verdict.
 *
 * When an item in `in_review` (status `completed`) receives a
 * not-ready-to-close verdict ("Ready to close: No" via `--audit-text`, or
 * `--ready-to-close no` via `wl audit-set`), it is moved back to
 * `open`/`plan_complete` so it drops out of the ready-to-close queue and
 * returns to the planning queue for further work. The item's priority is
 * preserved (only status/stage change).
 *
 * Only items in exactly `completed`/`in_review` are reverted: a `done`
 * item or an item already `open`/`in-progress` is left untouched.
 *
 * @param itemId - id of the work item whose audit verdict is not-ready-to-close
 * @returns the reversion details (item, from status/stage, to status/stage)
 *   or `null` when the item is not in an eligible state (or does not exist)
 */
export function revertToPlanComplete(
  ctx: WorklogDatabaseContext,
  hooks: ItemHooks,
  itemId: string,
): RevertedItem | null {
  const item = get(ctx, itemId);
  if (!item) {
    return null;
  }
  const eligible = item.status === 'completed' && item.stage === 'in_review';
  if (!eligible) {
    return null;
  }
  const from = { status: item.status, stage: item.stage };
  const updated = update(ctx, hooks, itemId, { status: 'open', stage: 'plan_complete' });
  if (!updated) {
    return null;
  }
  return {
    item: updated,
    from,
    to: { status: updated.status, stage: updated.stage },
  };
}

/**
 * Get the number of direct children for each work item.
 * Returns a Map<itemId, count>.
 * If items is provided, only counts within that subset; otherwise uses all items.
 * This is more efficient than calling getChildren() for every item individually
 * because it computes the full map in a single O(n) pass.
 */
export function getChildCounts(ctx: WorklogDatabaseContext, items?: WorkItem[]): Map<string, number> {
  const source = items ?? ctx.store.getAllWorkItems();
  const counts = new Map<string, number>();
  for (const item of source) {
    if (item.parentId) {
      counts.set(item.parentId, (counts.get(item.parentId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Get children that are not closed or deleted
 */
export function getNonClosedChildren(
  ctx: WorklogDatabaseContext,
  parentId: string,
  edgeCache?: EdgeCache,
): WorkItem[] {
  const children = edgeCache
    ? (edgeCache.childrenByParent.get(parentId) ?? [])
    : getChildren(ctx, parentId);
  return children.filter(
    item => item.status !== 'completed' && item.status !== 'deleted'
  );
}

/**
 * Get all descendants (children, grandchildren, etc.) of a work item
 */
export function getDescendants(ctx: WorklogDatabaseContext, parentId: string): WorkItem[] {
  const descendants: WorkItem[] = [];
  const children = getChildren(ctx, parentId);

  for (const child of children) {
    descendants.push(child);
    descendants.push(...getDescendants(ctx, child.id));
  }

  return descendants;
}

/**
 * Check if a work item is a leaf node (has no children)
 */
export function isLeafNode(ctx: WorklogDatabaseContext, itemId: string): boolean {
  return getChildren(ctx, itemId).length === 0;
}

/**
 * Get all leaf nodes that are descendants of a parent item
 */
export function getLeafDescendants(ctx: WorklogDatabaseContext, parentId: string): WorkItem[] {
  const descendants = getDescendants(ctx, parentId);
  return descendants.filter(item => isLeafNode(ctx, item.id));
}

/**
 * Get the depth of an item in the tree (root = 0)
 */
export function getDepth(ctx: WorklogDatabaseContext, itemId: string): number {
  let depth = 0;
  let current = get(ctx, itemId);

  while (current && current.parentId) {
    depth += 1;
    current = get(ctx, current.parentId);
  }

  return depth;
}
