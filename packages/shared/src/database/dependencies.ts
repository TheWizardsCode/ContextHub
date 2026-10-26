/**
 * packages/shared/src/database/dependencies.ts — dependency-edge CRUD,
 * blocker queries and blocked/open reconciliation for the `database.ts`
 * decomposition.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP6K0007574C (extract dependency and comment modules).
 *
 * ## Responsibility
 *
 * Everything that owns the dependency-edge graph and the `blocked`/`open`
 * status derived from it: edge add/remove/list (`addDependencyEdge`,
 * `removeDependencyEdge`, `listDependencyEdgesFrom`, `listDependencyEdgesTo`,
 * `getAllDependencyEdges`), the "is this target still blocking?" predicate
 * (`isDependencyActive`), the blocker queries built on it
 * (`getActiveDependencyBlockers`, `getInboundDependents`,
 * `hasActiveBlockers`), and the reconciliation that flips a dependent between
 * `blocked` and `open` (`reconcileBlockedStatus`, `reconcileDependentStatus`,
 * `reconcileDependentsForTarget`).
 *
 * ## Boundary
 *
 * **Belongs here.** Dependency edges and the status reconciliation they drive.
 * Reads the store through `WorklogDatabaseContext`; writes only dependency
 * edges and the `status` of an affected item (plus its FTS row), and never
 * `updatedAt` beyond what the pre-extraction implementation already did.
 *
 * **Does NOT belong here.** `EdgeCache` construction and ownership — that
 * stays in `context.ts` (`buildEdgeCache`), because every extracted module
 * (sort, next-pipeline) consumes it; this module only reads the `outbound`
 * slice of an already-built cache. Also out of scope: work-item/hierarchy CRUD
 * (`work-items.ts`, `hierarchy.ts`), priority ordinals and effective priority
 * (`priority.ts`), candidate selection and blocker surfacing in the `wl next`
 * pipeline (`next-pipeline.ts`, `critical-escalation.ts`), comments
 * (`comments.ts`), audits, search and sync. No knowledge of the
 * `WorklogDatabase` façade; the graph stays acyclic.
 *
 * ## Why the dependency↔priority coupling is resolved through the context
 *
 * `next-pipeline.ts` (and, via its hooks, `priority.ts`) calls
 * `getActiveDependencyBlockers` / `isDependencyActive` through
 * `SelectionHooks`. This module therefore never imports `next-pipeline.ts` or
 * `priority.ts` — the coupling the parent plan flagged as the main cycle risk
 * is expressed as context hooks wired by the façade.
 *
 * `WorklogDatabase` keeps a thin delegating member per function so the façade
 * surface is unchanged (parent AC — public API untouched).
 */

import { DependencyEdge, WorkItem } from '../types.js';
import {
  EdgeCache,
  WorklogDatabaseContext,
} from './context.js';

/**
 * Add a dependency edge (fromId depends on toId)
 */
export function addDependencyEdge(
  ctx: WorklogDatabaseContext,
  fromId: string,
  toId: string,
): DependencyEdge | null {
  if (!ctx.store.getWorkItem(fromId) || !ctx.store.getWorkItem(toId)) {
    return null;
  }

  const edge: DependencyEdge = {
    fromId,
    toId,
    createdAt: new Date().toISOString(),
  };

  ctx.store.saveDependencyEdge(edge);
  ctx.writeHooks.triggerAutoSync();
  return edge;
}

/**
 * Remove a dependency edge (fromId depends on toId)
 */
export function removeDependencyEdge(
  ctx: WorklogDatabaseContext,
  fromId: string,
  toId: string,
): boolean {
  const removed = ctx.store.deleteDependencyEdge(fromId, toId);
  if (removed) {
    ctx.writeHooks.triggerAutoSync();
  }
  return removed;
}

/**
 * List outbound dependency edges (fromId depends on toId)
 */
export function listDependencyEdgesFrom(
  ctx: WorklogDatabaseContext,
  fromId: string,
): DependencyEdge[] {
  return ctx.store.getDependencyEdgesFrom(fromId);
}

/**
 * List inbound dependency edges (items that depend on toId)
 */
export function listDependencyEdgesTo(
  ctx: WorklogDatabaseContext,
  toId: string,
): DependencyEdge[] {
  return ctx.store.getDependencyEdgesTo(toId);
}

/**
 * All dependency edges in the store (used by JSONL export / sync).
 */
export function getAllDependencyEdges(ctx: WorklogDatabaseContext): DependencyEdge[] {
  return ctx.store.getAllDependencyEdges();
}

/**
 * True when a dependency target still blocks: not completed, not deleted, and
 * not sitting in a closing stage (`in_review` / `done`).
 */
export function isDependencyActive(target: WorkItem | null): boolean {
  if (!target) {
    return false;
  }
  if (target.status === 'completed' || target.status === 'deleted') {
    return false;
  }
  if (target.stage === 'in_review' || target.stage === 'done') {
    return false;
  }
  return true;
}

/**
 * The items `itemId` depends on whose dependency is still active.
 *
 * Reads the pre-built `EdgeCache.outbound` slice when one is supplied so the
 * `wl next` pipeline performs no per-candidate SQL.
 */
export function getActiveDependencyBlockers(
  ctx: WorklogDatabaseContext,
  itemId: string,
  edgeCache?: EdgeCache,
): WorkItem[] {
  let edges: DependencyEdge[];
  if (edgeCache) {
    edges = edgeCache.outbound.get(itemId) ?? [];
  } else {
    edges = listDependencyEdgesFrom(ctx, itemId);
  }
  const blockers: WorkItem[] = [];
  for (const edge of edges) {
    const target = edgeCache
      ? (edgeCache.itemsById.get(edge.toId) ?? null)
      : ctx.store.getWorkItem(edge.toId);
    if (isDependencyActive(target) && target) {
      blockers.push(target);
    }
  }
  return blockers;
}

/**
 * The items that depend on `targetId`.
 */
export function getInboundDependents(
  ctx: WorklogDatabaseContext,
  targetId: string,
): WorkItem[] {
  const inbound = listDependencyEdgesTo(ctx, targetId);
  const dependents: WorkItem[] = [];
  for (const edge of inbound) {
    const dependent = ctx.store.getWorkItem(edge.fromId);
    if (dependent) {
      dependents.push(dependent);
    }
  }
  return dependents;
}

/**
 * True when `itemId` depends on at least one still-active item.
 */
export function hasActiveBlockers(
  ctx: WorklogDatabaseContext,
  itemId: string,
): boolean {
  const edges = listDependencyEdgesFrom(ctx, itemId);
  for (const edge of edges) {
    const target = ctx.store.getWorkItem(edge.toId);
    if (isDependencyActive(target)) {
      return true;
    }
  }
  return false;
}

/**
 * Set or clear `blocked` for an item purely from its active blockers: a
 * `blocked` item with no remaining active blockers becomes `open`.
 *
 * @returns true when the item's status was changed.
 */
export function reconcileBlockedStatus(
  ctx: WorklogDatabaseContext,
  itemId: string,
): boolean {
  const item = ctx.store.getWorkItem(itemId);
  if (!item) {
    return false;
  }
  if (item.status !== 'blocked') {
    return false;
  }
  if (hasActiveBlockers(ctx, itemId)) {
    return false;
  }

  const updated: WorkItem = {
    ...item,
    status: 'open',
    updatedAt: new Date().toISOString(),
  };
  ctx.store.saveWorkItem(updated);
  // Keep the FTS index fresh so status-filtered search reflects the change
  if (ctx.store.ftsAvailable) {
    ctx.store.upsertFtsEntry(updated);
  }
  ctx.writeHooks.triggerAutoSync();
  return true;
}

/**
 * Reconcile one item's own `blocked`/`open` status from its blockers: block it
 * when an active blocker exists, unblock it when none do. Terminal items
 * (completed/deleted) are never touched.
 *
 * @returns true when the item's status was changed.
 */
export function reconcileDependentStatus(
  ctx: WorklogDatabaseContext,
  itemId: string,
): boolean {
  const item = ctx.store.getWorkItem(itemId);
  if (!item) {
    return false;
  }
  if (item.status === 'completed' || item.status === 'deleted') {
    return false;
  }

  if (hasActiveBlockers(ctx, itemId)) {
    if (item.status === 'blocked') {
      return false;
    }
    const updated: WorkItem = {
      ...item,
      status: 'blocked',
      updatedAt: new Date().toISOString(),
    };
    ctx.store.saveWorkItem(updated);
    // Keep the FTS index fresh so status-filtered search reflects the change
    if (ctx.store.ftsAvailable) {
      ctx.store.upsertFtsEntry(updated);
    }
    ctx.writeHooks.triggerAutoSync();
    if (process.env.WL_DEBUG) {
      process.stderr.write(`[wl:dep] re-blocked ${itemId} (active blockers remain)\n`);
    }
    return true;
  }

  if (item.status !== 'blocked') {
    return false;
  }

  const updated: WorkItem = {
    ...item,
    status: 'open',
    updatedAt: new Date().toISOString(),
  };
  ctx.store.saveWorkItem(updated);
  // Keep the FTS index fresh so status-filtered search reflects the change
  if (ctx.store.ftsAvailable) {
    ctx.store.upsertFtsEntry(updated);
  }
  ctx.writeHooks.triggerAutoSync();
  if (process.env.WL_DEBUG) {
    process.stderr.write(`[wl:dep] unblocked ${itemId} (no active blockers remain)\n`);
  }
  return true;
}

/**
 * Reconcile every item that depends on `targetId` after `targetId` changed
 * status or stage. This is the entry point called by the item update/delete
 * paths.
 *
 * @returns the number of dependents whose status was changed.
 */
export function reconcileDependentsForTarget(
  ctx: WorklogDatabaseContext,
  targetId: string,
): number {
  const dependents = getInboundDependents(ctx, targetId);
  let updated = 0;
  for (const dependent of dependents) {
    if (reconcileDependentStatus(ctx, dependent.id)) {
      updated += 1;
    }
  }
  if (process.env.WL_DEBUG && updated > 0) {
    process.stderr.write(`[wl:dep] reconciled ${updated} dependent(s) for target ${targetId}\n`);
  }
  return updated;
}
