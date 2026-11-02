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

import { DependencyEdge, ForeignDependencyView, WorkItem } from '../types.js';
import {
  EdgeCache,
  ForeignDependencyResolution,
  WorklogDatabaseContext,
} from './context.js';

/**
 * Options for {@link addDependencyEdge}.
 */
export interface AddDependencyEdgeOptions {
  /**
   * Permit `toId` to reference an item that lives in **another project's**
   * store (parent WL-0MVWABT2Z001XMSD, design constraint D2).
   *
   * The edge is still written to the **local** store and the local `fromId`
   * endpoint is still validated here; only the `toId` existence check is
   * delegated to the caller, which must have validated the foreign endpoint
   * against its own store **read-only**. Defaults to `false`, so the historical
   * local-endpoint invariant is unchanged for every existing call site.
   */
  allowForeignTarget?: boolean;
}

/**
 * Add a dependency edge (fromId depends on toId)
 *
 * `fromId` must exist locally. `toId` must exist locally too unless the caller
 * passes `allowForeignTarget` after resolving it against a sibling store
 * (read-only, D2).
 */
export function addDependencyEdge(
  ctx: WorklogDatabaseContext,
  fromId: string,
  toId: string,
  options: AddDependencyEdgeOptions = {},
): DependencyEdge | null {
  if (!ctx.store.getWorkItem(fromId)) {
    return null;
  }
  if (!options.allowForeignTarget && !ctx.store.getWorkItem(toId)) {
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
 * The prefix segment of a work-item id (`ALPHA-…` → `ALPHA`), or `''` when the
 * id carries no separator.
 */
function prefixOfWorkItemId(id: string): string {
  const separator = id.indexOf('-');
  return separator < 0 ? '' : id.slice(0, separator).toUpperCase();
}

/**
 * True when `toId` names a target that can only live in **another project's**
 * store: it carries a prefix and that prefix is not this store's own.
 *
 * An id with this store's prefix that is absent locally is a genuinely missing
 * local endpoint (the existing `dependency.missing-endpoint` case), never a
 * foreign target — resolving it against siblings could only find a project
 * that cannot own it.
 */
function isForeignTarget(ctx: WorklogDatabaseContext, toId: string): boolean {
  const prefix = prefixOfWorkItemId(toId);
  if (prefix === '') return false;
  const localPrefix = (ctx.prefix || '').toUpperCase();
  return prefix !== localPrefix;
}

/**
 * Resolve a foreign target through the injected read-only resolver.
 *
 * Returns `null` when no resolver is injected (a consumer that only ever holds
 * local edges, e.g. the shared package used outside the CLI) or when the id is
 * not foreign. A resolver that throws is degraded to an `unavailable` result
 * that still counts as a discovered project, so a broken resolver can never
 * silently unblock a dependent (D3 fail-safe).
 */
function resolveForeignTarget(
  ctx: WorklogDatabaseContext,
  toId: string,
): ForeignDependencyResolution | null {
  if (!isForeignTarget(ctx, toId)) return null;
  const resolver = ctx.services?.foreign;
  if (!resolver) return null;
  try {
    const resolution = resolver.resolve(toId);
    if (!resolution) return null;
    return {
      ...resolution,
      id: (resolution.id || toId).toUpperCase(),
      discoveredProject: Boolean(resolution.discoveredProject),
    };
  } catch (error) {
    return {
      id: toId.toUpperCase(),
      state: 'unavailable',
      discoveredProject: true,
      reason:
        `The foreign dependency resolver failed for ${toId} ` +
        `(${error instanceof Error ? error.message : String(error)}) — ` +
        'treating the foreign dependency as unavailable.',
    };
  }
}

/**
 * True when a foreign resolution keeps the dependent blocked.
 *
 * Uses the same terminal semantics as a local target — {@link isDependencyActive}
 * is reused, never forked — and fails safe for an unresolved target or a
 * discovered-but-unreadable store. An undiscoverable prefix (no project owns
 * it) stays a non-blocking coordination note.
 */
function foreignResolutionBlocks(resolution: ForeignDependencyResolution): boolean {
  if (resolution.state === 'resolved') {
    return isDependencyActive(resolution.item ?? null);
  }
  if (resolution.state === 'unresolved') return true;
  return resolution.discoveredProject;
}

/**
 * Turn a foreign resolution into the shared view emitted by every gating
 * surface. A `resolved` view deliberately carries no `reason`.
 */
function toForeignDependencyView(
  resolution: ForeignDependencyResolution,
): ForeignDependencyView {
  const unresolved =
    resolution.state === 'unresolved' ||
    (resolution.state === 'unavailable' && resolution.discoveredProject);
  const view: ForeignDependencyView = {
    id: resolution.id,
    foreign: true,
    foreign_dependency: resolution.state,
    unresolved,
    blocking: foreignResolutionBlocks(resolution),
  };
  if (resolution.state !== 'resolved') {
    view.reason =
      resolution.reason ??
      `Foreign dependency ${resolution.id} could not be resolved (${resolution.state}).`;
  }
  return view;
}

/** Foreign ids whose unresolved state has already been warned about (once per process). */
const warnedForeignTargets = new Set<string>();

/**
 * Emit at most one warning per foreign target per process. Interactive runs
 * (silent=false) see it on stderr; JSON callers do not get noise on stdout.
 *
 * Only a target that actually blocks is warned about: an undiscoverable prefix
 * is a coordination note, so warning about it would be false alarm.
 */
function warnUnresolvedForeign(
  ctx: WorklogDatabaseContext,
  resolution: ForeignDependencyResolution,
): void {
  if (ctx.silent) return;
  const key = `${resolution.id}\u0000${resolution.state}`;
  if (warnedForeignTargets.has(key)) return;
  warnedForeignTargets.add(key);
  try {
    process.stderr.write(
      `[wl:dep] warning: foreign dependency ${resolution.id} is ${resolution.state}` +
        `${resolution.reason ? ` (${resolution.reason})` : ''}; the dependent stays blocked.\n`,
    );
  } catch {
    // stderr is best-effort; a closed pipe must never fail the gating path.
  }
}

/**
 * The foreign dependency edges of `itemId`, resolved from their own stores and
 * reported in the shared {@link ForeignDependencyView} shape.
 *
 * Returns `[]` when the item has no foreign edges or no resolver is injected,
 * so output for items without foreign edges is byte-identical to before.
 */
export function getForeignDependencyViews(
  ctx: WorklogDatabaseContext,
  itemId: string,
  edgeCache?: EdgeCache,
): ForeignDependencyView[] {
  const edges = edgeCache
    ? (edgeCache.outbound.get(itemId) ?? [])
    : ctx.store.getDependencyEdgesFrom(itemId);
  const views: ForeignDependencyView[] = [];
  for (const edge of edges) {
    const resolution = resolveForeignTarget(ctx, edge.toId);
    if (!resolution) continue;
    if (foreignResolutionBlocks(resolution)) {
      warnUnresolvedForeign(ctx, resolution);
    }
    views.push(toForeignDependencyView(resolution));
  }
  return views;
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
    if (target) {
      if (isDependencyActive(target)) blockers.push(target);
      continue;
    }
    // No local row: a foreign edge is resolved from its own store (never from
    // a local row that cannot exist — AC: `buildEdgeCache` keeps foreign
    // targets out of `itemsById`). An unresolved foreign target blocks the
    // dependent but has no `WorkItem` to return; `hasActiveBlockers` is the
    // authoritative predicate for that case.
    const resolution = resolveForeignTarget(ctx, edge.toId);
    if (resolution && foreignResolutionBlocks(resolution) && resolution.item) {
      blockers.push(resolution.item);
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
  edgeCache?: EdgeCache,
): boolean {
  const edges = edgeCache
    ? (edgeCache.outbound.get(itemId) ?? [])
    : listDependencyEdgesFrom(ctx, itemId);
  for (const edge of edges) {
    const target = edgeCache
      ? (edgeCache.itemsById.get(edge.toId) ?? null)
      : ctx.store.getWorkItem(edge.toId);
    if (target) {
      if (isDependencyActive(target)) return true;
      continue;
    }
    // A foreign target is resolved from its own store; an unresolved one keeps
    // the dependent blocked (fail-safe), an undiscoverable prefix does not.
    const resolution = resolveForeignTarget(ctx, edge.toId);
    if (resolution && foreignResolutionBlocks(resolution)) return true;
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
