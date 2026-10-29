/**
 * packages/shared/src/database/sort.ts — score-based ordering and
 * sort-index management for the `database.ts` decomposition.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP2Q2002ZYCF (extract sort and audit modules).
 *
 * ## Responsibility
 *
 * Everything that turns a set of work items into an order, and everything
 * that persists that order as hierarchical `sortIndex` values:
 * `sortItemsByScore`/`computeScore` (score ranking), `orderBySortIndex`
 * (hierarchy-position ordering), the audit-not-ready tier comparator
 * (`compareAuditNotReadyTier`), `selectBySortIndex` (final candidate pick),
 * and the sort-index compute/assign/preview family (`computeSortIndexOrder`,
 * `assignSortIndexValues`, `assignSortIndexValuesForItems`, `reSort`,
 * `previewSortIndexOrder`, `previewSortIndexOrderForItems`,
 * `getAllOrderedByScore`).
 *
 * ## Boundary
 *
 * **Belongs here.** Every comparator, tier and tie-break used to order items,
 * plus the writes that persist `sortIndex` values. Reads the store through
 * `WorklogDatabaseContext`; writes only sort indices (never `updatedAt`, so a
 * mechanical re-sort cannot invalidate a passing audit). The audit-map and
 * freshness predicates come from `audit.ts`; priority ordinals and effective
 * priority inheritance come from `priority.ts`.
 *
 * **Does NOT belong here.** Audit-result CRUD, waivers and invalidation
 * (`audit.ts`); priority ordinals (`priority.ts`); candidate filtering,
 * blocker surfacing and critical escalation (`next-pipeline.ts`,
 * `critical-escalation.ts`); work-item/hierarchy CRUD. No knowledge of the
 * `WorklogDatabase` façade; the graph stays acyclic.
 *
 * `WorklogDatabase` keeps a thin delegating member per function so the façade
 * surface is unchanged (parent AC — public API untouched; `docs/ARCHITECTURE.md`
 * § sort ordering now names this module).
 */

import { AuditResult, WorkItem } from '../types.js';
import {
  EdgeCache,
  SelectionHooks,
  WorklogDatabaseContext,
  WriteHooks,
  buildEdgeCache,
} from './context.js';
import {
  computeEffectivePriority,
  getPriorityValue,
} from './priority.js';
import {
  buildAuditMapForItems,
  isAuditNotReadyFresh,
} from './audit.js';

// ── Score ranking ─────────────────────────────────────────────────────

/**
 * Order items by the composite score used by `wl next` and `wl re-sort`.
 *
 * The comparator is tiered: critical items are always above any non-critical
 * item, and a fresh audited-not-ready non-critical item outranks any
 * unaudited/non-fresh non-critical item regardless of base priority. Only
 * then is the numeric {@link computeScore} consulted, with `createdAt` then
 * `id` as the final, deterministic tie-breaks.
 */
export function sortItemsByScore(ctx: WorklogDatabaseContext, items: WorkItem[], recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore', edgeCache?: EdgeCache): WorkItem[] {
  const now = Date.now();
  const cache = edgeCache ?? buildEdgeCache(ctx, items);

  // Pre-compute ancestors of in-progress items for O(1) per-item lookup.
  // For each in-progress item, walk up the parent chain and record ancestor IDs.
  const MAX_ANCESTOR_DEPTH = 50;
  const ancestorsOfInProgress = new Set<string>();
  for (const item of items) {
    if (item.status === 'in-progress') {
      let currentParentId = item.parentId ?? null;
      let depth = 0;
      while (currentParentId && depth < MAX_ANCESTOR_DEPTH) {
        ancestorsOfInProgress.add(currentParentId);
        const parent = cache.itemsById.get(currentParentId);
        currentParentId = parent?.parentId ?? null;
        depth++;
      }
    }
  }

  // Audit-not-ready tier: batch audit map so the comparator is O(1) per
  // item (no per-item N+1 queries). Mirrors the EdgeCache pattern.
  const auditMap = buildAuditMapForItems(ctx, items);
  const maxPriorityValue = 4; // critical

  return items.slice().sort((a, b) => {
    const aIsCritical = getPriorityValue(a.priority) === maxPriorityValue;
    const bIsCritical = getPriorityValue(b.priority) === maxPriorityValue;
    const aAuditFresh = !aIsCritical && isAuditNotReadyFresh(auditMap.get(a.id), a.updatedAt);
    const bAuditFresh = !bIsCritical && isAuditNotReadyFresh(auditMap.get(b.id), b.updatedAt);
    // Hard tier boundary: critical items stay above any audited non-critical.
    // Otherwise, any fresh audited-not-ready non-critical outranks any unaudited/non-fresh non-critical,
    // regardless of base priority — enforced here as a tiered comparator before score.
    if (aIsCritical !== bIsCritical) {
      return aIsCritical ? -1 : 1;
    }
    if (!aIsCritical && !bIsCritical && aAuditFresh !== bAuditFresh) {
      return aAuditFresh ? -1 : 1;
    }
    const scoreA = computeScore(ctx, a, now, recencyPolicy, ancestorsOfInProgress, cache, auditMap);
    const scoreB = computeScore(ctx, b, now, recencyPolicy, ancestorsOfInProgress, cache, auditMap);
    if (scoreB !== scoreA) return scoreB - scoreA;
    const createdA = new Date(a.createdAt).getTime();
    const createdB = new Date(b.createdAt).getTime();
    if (createdA !== createdB) return createdA - createdB;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Numeric score for one work item — the fine-grained half of the ranking.
 *
 * Ranking precedence (highest to lowest): priority, blocks-high-priority,
 * in-progress multipliers, blocked penalty, then age / effort / recency
 * tie-breakers. The audit-not-ready boost is applied here as well, bounded so
 * it can never cross the critical boundary the comparator enforces.
 */
export function computeScore(
  ctx: WorklogDatabaseContext,
  item: WorkItem,
  now: number,
  recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore',
  ancestorsOfInProgress?: Set<string>,
  edgeCache?: EdgeCache,
  auditMap?: Map<string, AuditResult>
): number {
  // Weights are intentionally fixed and not configurable per request
  //
  // Ranking precedence (highest to lowest):
  //   1. priority          — primary ranking (weight 1000 per level)
  //   2. blocksHighPriority — boost for items that unblock high/critical work
  //   3. in-progress multipliers — boost active items and their ancestors
  //   4. blocked penalty   — heavy penalty for blocked items
  //   5. age / effort / recency — fine-grained tie-breakers
  const WEIGHTS = {
    priority: 1000,
    blocksHighPriority: 500,  // boost when this item unblocks high/critical items
    age: 10, // per day
    updated: 100, // recency boost/penalty
    blocked: -10000,
    effort: 20,
  };

  let score = 0;

  // Audit-not-ready tier: second only to critical. Fresh `readyToClose ===
  // false` audits boost any non-critical item so it outranks any unaudited
  // non-critical regardless of base priority (tiered as numeric boost >
  // max priority delta, with the comparator above as the hard authority).
  // Critical items never receive this boost (hard boundary).
  if (item.priority !== 'critical' && auditMap) {
    const audit = auditMap.get(item.id);
    if (isAuditNotReadyFresh(audit, item.updatedAt)) {
      score += 3500; // > priority range (max 3*1000=3000 delta) but < critical gap
    }
  }

  // Priority base
  score += getPriorityValue(item.priority) * WEIGHTS.priority;

  // Blocks-high-priority boost: if this item is a dependency prerequisite for
  // active items with high or critical priority, add a proportional boost.
  // This ensures that among equal-priority peers, unblockers rank higher.
  // Uses store-direct access to avoid per-item refreshFromJsonlIfNewer overhead
  // (consistent with the dependency filter at the top of findNextWorkItemFromItems).
  // When edgeCache is provided, uses pre-loaded in-memory Maps instead of
  // per-item SQL queries, eliminating the N+1 query pattern (Bottleneck 1).
  const inboundEdges = edgeCache
    ? (edgeCache.inbound.get(item.id) ?? [])
    : ctx.store.getDependencyEdgesTo(item.id);
  let maxBlockedPriorityValue = 0;
  for (const edge of inboundEdges) {
    const dependent = edgeCache
      ? (edgeCache.itemsById.get(edge.fromId) ?? null)
      : ctx.store.getWorkItem(edge.fromId);
    if (dependent && dependent.status !== 'completed' && dependent.status !== 'deleted') {
      const depPriority = getPriorityValue(dependent.priority);
      // Only boost for high (3) or critical (4) dependents
      if (depPriority >= 3 && depPriority > maxBlockedPriorityValue) {
        maxBlockedPriorityValue = depPriority;
      }
    }
  }
  if (maxBlockedPriorityValue > 0) {
    // Proportional: critical (4) gets a larger boost than high (3).
    // Scale: high=1.0x, critical=1.33x of the base weight.
    score += (maxBlockedPriorityValue / 3) * WEIGHTS.blocksHighPriority;
  }

  // In-review boost: items awaiting review are surfaced above medium- and
  // low-priority items but below critical- and high-priority items.
  // 600 points = 0.6 * priority weight (1000), which places in-review items
  // in a band between high (3000) and medium (2000) priority levels:
  //   - Critical (4000) + in-review (600) = 4600 > high (3000) ✓
  //   - High (3000) + in-review (600) = 3600 > medium (2000) ✓
  //   - Medium (2000) + in-review (600) = 2600 < high (3000) ✓
  //   - Medium (2000) + in-review (600) = 2600 > medium (2000, non-review) ✓
  //   - Low (1000) + in-review (600) = 1600 < medium (2000) ✓
  if (item.stage === 'in_review') {
    score += 600;
  }

  // Age (createdAt) - small boost per day to avoid starvation
  const ageDays = Math.max(0, (now - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24));
  score += Math.min(ageDays, 365) * WEIGHTS.age;

  // Effort: prefer smaller numeric efforts if present
  if (item.effort) {
    const effortVal = parseFloat(String(item.effort)) || 0;
    if (effortVal > 0) score += (1 / (1 + effortVal)) * WEIGHTS.effort;
  }

  // Activity recency policy. `activityAt` includes comment activity; it
  // falls back to `updatedAt` for rows written before the column existed.
  // Audit freshness deliberately does NOT use this field (WL-0MUBVH6JM0093KVM).
  const lastActivity = item.activityAt ?? item.updatedAt;
  if (recencyPolicy !== 'ignore' && lastActivity) {
    const activityHours = (now - new Date(lastActivity).getTime()) / (1000 * 60 * 60);
    if (recencyPolicy === 'avoid') {
      // Penalty stronger when active very recently, decays to zero by 72 hours
      const penaltyFactor = Math.max(0, (72 - activityHours) / 72);
      score -= penaltyFactor * WEIGHTS.updated;
    } else if (recencyPolicy === 'prefer') {
      // Boost for recent activity (peak within ~48 hours)
      const boostFactor = Math.max(0, (48 - activityHours) / 48);
      score += boostFactor * WEIGHTS.updated;
    }
  }

  // Blocked status - heavy penalty
  if (item.status === 'blocked') score += WEIGHTS.blocked;

  // In-progress score multiplier boosts (applied after all additive components).
  // Non-stacking: direct in-progress boost takes precedence over ancestor boost.
  // Blocked items receive no boost (the -10000 penalty remains dominant).
  const IN_PROGRESS_BOOST = 1.5;
  const PARENT_IN_PROGRESS_BOOST = 1.25;
  // Apply in-progress / ancestor multipliers non-stacking.
  // Use an explicit multiplier variable to avoid any accidental
  // double-application of boosts if this code is refactored in future.
  let multiplier = 1;
  if (item.status !== 'blocked') {
    if (item.status === 'in-progress') {
      multiplier = IN_PROGRESS_BOOST;
    } else if (ancestorsOfInProgress?.has(item.id)) {
      multiplier = PARENT_IN_PROGRESS_BOOST;
    }
  }
  score *= multiplier;

  return score;
}

// ── Tier comparator ───────────────────────────────────────────────────

/**
 * Compare two items by the audit-not-ready tier (WL-0MTH7G2O1004BHN5).
 * Critical is strictly above the audited-not-ready non-critical tier;
 * within the non-critical tier, a fresh `readyToClose===false` item
 * outranks any unaudited/stale/ready-to-close item regardless of base
 * priority. The tier only applies to workers that respect it (see callers).
 * Returns -1/0/1 suitable as a comparator prefix before fallbacks.
 */
export function compareAuditNotReadyTier(
  a: WorkItem,
  b: WorkItem,
  auditMap: Map<string, AuditResult>,
  maxPriorityValue: number
): number {
  const aIsCritical = getPriorityValue(a.priority) === maxPriorityValue;
  const bIsCritical = getPriorityValue(b.priority) === maxPriorityValue;
  const aAuditFresh = !aIsCritical && isAuditNotReadyFresh(auditMap.get(a.id), a.updatedAt);
  const bAuditFresh = !bIsCritical && isAuditNotReadyFresh(auditMap.get(b.id), b.updatedAt);
  if (aIsCritical !== bIsCritical) return aIsCritical ? -1 : 1;
  if (!aIsCritical && !bIsCritical && aAuditFresh !== bAuditFresh) return aAuditFresh ? -1 : 1;
  return 0;
}

// ── Sort-index ordering / selection ───────────────────────────────────

/**
 * Order items by their hierarchy sort-index position, with `createdAt` then
 * `id` as the deterministic fallback for items that are absent from the
 * cached ordering or share a position.
 */
export function orderBySortIndex(ctx: WorklogDatabaseContext, items: WorkItem[], sortOrderCache?: WorkItem[]): WorkItem[] {
  const orderedAll = sortOrderCache ?? ctx.store.getAllWorkItemsOrderedByHierarchySortIndexSkipCompleted();
  const positions = new Map(orderedAll.map((item, index) => [item.id, index]));
  return items.slice().sort((a, b) => {
    const aPos = positions.get(a.id);
    const bPos = positions.get(b.id);
    if (aPos === undefined && bPos === undefined) {
      const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (createdDiff !== 0) return createdDiff;
      return a.id.localeCompare(b.id);
    }
    if (aPos === undefined) return 1;
    if (bPos === undefined) return -1;
    if (aPos !== bPos) return aPos - bPos;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Select the best candidate from `items`.
 *
 * When all `sortIndex` values coincide (including all-zero), full fallback
 * is effective priority/age. Otherwise the primary ordering is sortIndex —
 * but the audit tier is applied as a prefix before any of those so that
 * `wl next --no-re-sort` (which skips reSort) still reflects the boosted
 * order rather than stale sortIndex (AC3, WL-0MTH7G2O1004BHN5).
 */
export function selectBySortIndex(
  ctx: WorklogDatabaseContext,
  hooks: SelectionHooks,
  items: WorkItem[],
  effectivePriorityCache?: Map<string, { value: number; reason: string; inheritedFrom?: string }>,
  sortOrderCache?: WorkItem[],
  edgeCache?: EdgeCache,
  allItems?: WorkItem[]
): WorkItem | null {
  if (!items || items.length === 0) return null;
  const cache = effectivePriorityCache ?? new Map();
  const auditMap = buildAuditMapForItems(ctx, items);
  const maxPriorityValue = 4;
  const firstSortIndex = items[0].sortIndex ?? 0;
  const allSame = items.every(item => (item.sortIndex ?? 0) === firstSortIndex);
  if (allSame) {
    const sorted = items.slice().sort((a, b) => {
      const tierDiff = compareAuditNotReadyTier(a, b, auditMap, maxPriorityValue);
      if (tierDiff !== 0) return tierDiff;
      const aEffective = computeEffectivePriority(ctx, hooks, a, cache, edgeCache, allItems);
      const bEffective = computeEffectivePriority(ctx, hooks, b, cache, edgeCache, allItems);
      const priDiff = bEffective.value - aEffective.value;
      if (priDiff !== 0) return priDiff;
      const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (createdDiff !== 0) return createdDiff;
      return a.id.localeCompare(b.id);
    });
    return sorted[0] ?? null;
  }
  const sorted = items.slice().sort((a, b) => {
    const tierDiff = compareAuditNotReadyTier(a, b, auditMap, maxPriorityValue);
    if (tierDiff !== 0) return tierDiff;
    const aIdx = a.sortIndex ?? 0;
    const bIdx = b.sortIndex ?? 0;
    if (aIdx !== bIdx) return aIdx - bIdx;
    const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  });
  return sorted[0] ?? null;
}

// ── Sort-index compute / assign / preview ─────────────────────────────

/**
 * Build the canonical hierarchy order: depth-first over parent → children,
 * siblings ordered by `sortIndex`, then `createdAt`, then `id`.
 */
export function computeSortIndexOrder(ctx: WorklogDatabaseContext): WorkItem[] {
  const items = ctx.store.getAllWorkItems();
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

  const order: WorkItem[] = [];
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

  const traverse = (parentId: string | null) => {
    const children = childrenByParent.get(parentId) || [];
    const sorted = sortSiblings(children);
    for (const child of sorted) {
      order.push(child);
      traverse(child.id);
    }
  };

  traverse(null);
  return order;
}

/**
 * Reassign `sortIndex` values from the canonical hierarchy order, writing
 * only the items whose value actually changes.
 */
export function assignSortIndexValues(ctx: WorklogDatabaseContext, hooks: WriteHooks, gap: number): { updated: number } {
  const ordered = computeSortIndexOrder(ctx);
  let updated = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    const nextSortIndex = (index + 1) * gap;
    if (item.sortIndex !== nextSortIndex) {
      // sortIndex is organizational, not semantic: a sortIndex-only change
      // must NOT bump `updatedAt`, or a mechanical re-assignment would
      // invalidate a previously-passing audit (WL-0MTWU4XGP001GDEA /
      // WL-0MU2O8AQ8000ASDO). Semantic edits still bump `updatedAt` via
      // `update`/`saveWorkItem`, and the activityAt invariant is preserved
      // because `saveWorkItem` takes the later of the two.
      const updatedItem = {
        ...item,
        sortIndex: nextSortIndex,
      };
      ctx.store.saveWorkItem(updatedItem);
      updated += 1;
    }
  }
  hooks.triggerAutoSync();
  return { updated };
}

/**
 * Re-sort all active (non-completed, non-deleted) work items by score and
 * reassign their sortIndex values.  This is the same logic used by `wl re-sort`
 * and is called automatically by `wl next` unless `--no-re-sort` is passed.
 *
 * @param recencyPolicy - How to weight recency in the score calculation
 * @param gap - Gap between consecutive sortIndex values (default 100)
 * @returns The number of items whose sortIndex was updated
 */
export function reSort(
  ctx: WorklogDatabaseContext,
  hooks: WriteHooks,
  recencyPolicy: 'prefer' | 'avoid' | 'ignore' = 'ignore',
  gap: number = 100
): { updated: number } {
  const ordered = getAllOrderedByScore(ctx, recencyPolicy)
    .filter(item => item.status !== 'completed' && item.status !== 'deleted');
  return assignSortIndexValuesForItems(ctx, hooks, ordered, gap);
}

/**
 * Persist an explicit ordering as `sortIndex` values (`index + 1) * gap`).
 */
export function assignSortIndexValuesForItems(ctx: WorklogDatabaseContext, hooks: WriteHooks, orderedItems: WorkItem[], gap: number): { updated: number } {
  const updated = ctx.store.batchUpdateSortIndices(orderedItems, gap);
  hooks.triggerAutoSync();
  return { updated };
}

/**
 * Preview the canonical hierarchy order with would-be `sortIndex` values,
 * without writing anything.
 */
export function previewSortIndexOrder(ctx: WorklogDatabaseContext, gap: number): Array<{ id: string; sortIndex: number } & WorkItem> {
  const ordered = computeSortIndexOrder(ctx);
  return ordered.map((item, index) => ({
    ...item,
    sortIndex: (index + 1) * gap,
  }));
}

/**
 * Preview would-be `sortIndex` values for an explicit item list, without
 * writing anything.
 */
export function previewSortIndexOrderForItems(items: WorkItem[], gap: number): Array<{ id: string; sortIndex: number } & WorkItem> {
  return items.map((item, index) => ({
    ...item,
    sortIndex: (index + 1) * gap,
  }));
}

/**
 * All work items ordered by the composite score (the input to `reSort`).
 */
export function getAllOrderedByScore(ctx: WorklogDatabaseContext, recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore'): WorkItem[] {
  const items = ctx.store.getAllWorkItems();
  const cache = buildEdgeCache(ctx, items);
  return sortItemsByScore(ctx, items, recencyPolicy, cache);
}
