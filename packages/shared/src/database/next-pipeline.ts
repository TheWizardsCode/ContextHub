/**
 * packages/shared/src/database/next-pipeline.ts — the `wl next` candidate
 * selection pipeline (filtering, blocker surfacing and final selection).
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP0U5007BAZD (extract the `wl next` selection pipeline).
 *
 * ## Responsibility
 *
 * Single- and batch-mode `wl next`: filter the candidate pool
 * (`filterCandidates`), surface dependency/child blockers of higher-priority
 * items (`resolveBlockerToRoot`, `selectHighestPriorityBlocking`), run the
 * critical-escalation stage (`handleCriticalEscalation` from
 * `critical-escalation.ts`, reached through `SelectionHooks` so the module
 * graph stays acyclic), and finally select by sort-index / effective priority
 * (`findNextWorkItemFromItems`, `findNextWorkItem`, `findNextWorkItems`).
 * `applyFilters` implements the assignee/search candidate filter.
 *
 * ## Boundary
 *
 * **Belongs here.** Everything in the candidate-selection path except
 * priority ordinals (`priority.ts`) and the critical-escalation stage
 * (`critical-escalation.ts`). Reads the store through
 * `WorklogDatabaseContext` and the façade's private collaborators through
 * `SelectionHooks`; writes nothing.
 *
 * **Does NOT belong here.** Priority/risk/effort ordinals and effective
 * priority (`priority.ts`), critical escalation (`critical-escalation.ts`),
 * sort-index computation or audit-tier ordering (future `sort.ts`), CRUD and
 * hierarchy traversal (other slices). No knowledge of the `WorklogDatabase`
 * façade.
 *
 * `WorklogDatabase` keeps a thin delegating member per function.
 */

import { NextWorkItemResult, WorkItem } from '../types.js';
import {
  EdgeCache,
  SelectionHooks,
  WorklogDatabaseContext,
  buildEdgeCache,
} from './context.js';
import {
  computeEffectivePriority,
  effortOrdinal,
  getPriorityValue,
  matchesRiskEffort,
  riskOrdinal,
} from './priority.js';
import { handleCriticalEscalation } from './critical-escalation.js';
/**
 * Consolidated filter pipeline for wl next candidate selection.
 *
 * Removes non-actionable items in a single pass and returns two pools:
 *   - candidates: fully filtered items ready for selection
 *   - criticalPool: items filtered before dep-blocking, with assignee/search
 *     applied, so that critical-path escalation can still find blocked
 *     critical items and surface their blockers
 *
 * Filter stages (in order):
 *   0. Apply stage filter first if specified (before other removals)
 *   1. Remove deleted items
 *   2. Remove completed items (preserving in_review stage)
 *   3. Remove in-progress items (wl next skips items already being worked on)
 *   4. Remove excluded items (batch mode)
 *   5. Apply assignee and search filters
 *   --- criticalPool snapshot taken here ---
 *   6. Remove dependency-blocked items (unless includeBlocked)
 */
export function filterCandidates(
  ctx: WorklogDatabaseContext,
  hooks: SelectionHooks,
  items: WorkItem[],
  options: {
    assignee?: string;
    searchTerm?: string;
    stage?: string;
    risk?: string;
    effort?: string;
    excluded?: Set<string>;
    includeBlocked?: boolean;
    includeInProgress?: boolean;
    debugPrefix?: string;
    edgeCache?: EdgeCache;
  } = {}
): { candidates: WorkItem[]; criticalPool: WorkItem[] } {
  const {
    assignee,
    searchTerm,
    stage,
    risk,
    effort,
    excluded,
    includeBlocked = false,
    includeInProgress = false,
    debugPrefix = '[filter]',
  } = options;

  let pool = items;
  hooks.debug(`${debugPrefix} filter: total=${pool.length}`);

  // 1. Apply stage filter first if specified (before removing completed/deleted)
  if (stage) {
    pool = pool.filter(item => item.stage === stage);
    hooks.debug(`${debugPrefix} filter: after stage=${stage}=${pool.length}`);
  }

  // 2. Remove deleted items
  pool = pool.filter(item => item.status !== 'deleted');
  hooks.debug(`${debugPrefix} filter: after deleted=${pool.length}`);

  // 3. Remove completed items (unless stage filter was applied - user is
  //    explicitly filtering by stage and may want completed items in that stage).
  //    Also preserve items in the in_review stage - they need to appear in
  //    wl next for review even though their status is 'completed'.
  //    Also exclude items in the done stage by default (WL-0MSGRJWRX0068W3W) -
  //    done items are terminal and not actionable; explicit --stage done still works.
  if (!stage) {
    pool = pool.filter(
      item =>
        (item.status !== 'completed' || item.stage === 'in_review') &&
        item.stage !== 'done'
    );
    hooks.debug(`${debugPrefix} filter: after completed/done=${pool.length}`);
  }

  // 4. Remove in-progress items by default (wl next recommends what to work on next,
  //    not what's already being worked on). Skip this filter when --include-in-progress
  //    is set so items already being worked on appear in the output.
  if (!includeInProgress) {
    pool = pool.filter(item => item.status !== 'in-progress');
    hooks.debug(`${debugPrefix} filter: after in-progress=${pool.length}`);
  } else {
    hooks.debug(`${debugPrefix} filter: skip in-progress (includeInProgress=true)`);
  }

  // 5. Remove excluded items (batch mode)
  if (excluded && excluded.size > 0) {
    pool = pool.filter(item => !excluded.has(item.id));
    hooks.debug(`${debugPrefix} filter: after excluded=${pool.length}`);
  }

  // 7. Apply assignee and search filters
  pool = applyFilters(ctx, pool, assignee, searchTerm);
  hooks.debug(`${debugPrefix} filter: after assignee/search=${pool.length}`);

  // 7b. Apply risk/effort at-most filters (ordinal, fail-closed on unset).
  // An item is eligible only when its risk ≤ the filter level (Low < Medium
  // < High < Severe) and its effort ≤ the filter level (Extra Small < Small
  // < Medium < Large < Extra Large). Items with unset/empty risk or effort
  // are NEVER matched — an absent estimate is not "≤ low/small" (AC2).
  if (risk !== undefined && risk !== '') {
    const riskLevel = riskOrdinal(risk);
    if (riskLevel === null) {
      // Invalid filter level → fail-closed: match nothing.
      pool = [];
    } else {
      pool = pool.filter(item => {
        const ord = riskOrdinal(item.risk);
        return ord !== null && ord <= riskLevel;
      });
    }
    hooks.debug(`${debugPrefix} filter: after risk=${risk}=${pool.length}`);
  }
  if (effort !== undefined && effort !== '') {
    const effortLevel = effortOrdinal(effort);
    if (effortLevel === null) {
      // Invalid filter level → fail-closed: match nothing.
      pool = [];
    } else {
      pool = pool.filter(item => {
        const ord = effortOrdinal(item.effort);
        return ord !== null && ord <= effortLevel;
      });
    }
    hooks.debug(`${debugPrefix} filter: after effort=${effort}=${pool.length}`);
  }

  // Snapshot for critical-path escalation (before dep-blocker removal)
  const criticalPool = pool;

  // 8. Remove dependency-blocked items unless opted in
  let candidates = pool;
  if (!includeBlocked) {
    const ec = options.edgeCache;
    candidates = pool.filter(item => {
      const edges = ec
        ? (ec.outbound.get(item.id) ?? [])
        : ctx.store.getDependencyEdgesFrom(item.id);
      for (const edge of edges) {
        const target = ec
          ? (ec.itemsById.get(edge.toId) ?? null)
          : ctx.store.getWorkItem(edge.toId);
        if (hooks.isDependencyActive(target ?? null)) {
          return false;
        }
      }
      return true;
    });
    hooks.debug(`${debugPrefix} filter: after dep-blocked=${candidates.length}`);
  }

  return { candidates, criticalPool };
}

/**
 * Resolve a would-be-surfaced blocker to a root-level item (strict root-only,
 * WL-0MS964SIA0057ABR).
 *
 * - Root blockers (no parentId) are returned as-is.
 * - A child blocker is resolved to its parent when the parent is selectable
 *   (a root-level item with an actionable status and no active dependency
 *   blockers, matching the Stage 5 candidate rules). The parent is the unit
 *   of work and is surfaced instead of the child.
 * - Returns null when the blocker is a child whose parent is not selectable
 *   (e.g. the parent is closed/completed/deleted/in-progress/blocked). Such
 *   children are hidden entirely — never promoted to root.
 */
export function resolveBlockerToRoot(
  ctx: WorklogDatabaseContext,
  hooks: SelectionHooks,
  blocker: WorkItem,
  allItems: WorkItem[],
  assignee?: string,
  searchTerm?: string,
  excluded?: Set<string>
): WorkItem | null {
  if (!blocker.parentId) {
    return blocker; // already a root blocker
  }
  const parent = allItems.find(p => p.id === blocker.parentId);
  if (!parent) {
    // Parent is missing (deleted) — the child is an orphan; hidden entirely.
    return null;
  }
  // The parent itself must be a root item (no grandparent) so the surfaced
  // item is always root-level.
  if (parent.parentId) {
    return null;
  }
  // Parent must be actionable and not dependency-blocked (matching Stage 5
  // candidate rules: open, not deleted/completed/in-progress/blocked).
  if (
    parent.status === 'deleted' ||
    parent.status === 'completed' ||
    parent.status === 'in-progress' ||
    parent.status === 'blocked'
  ) {
    return null;
  }
  if (hooks.getActiveDependencyBlockers(parent.id).length > 0) {
    return null;
  }
  if (excluded?.has(parent.id)) {
    return null;
  }
  if (applyFilters(ctx, [parent], assignee, searchTerm).length === 0) {
    return null;
  }
  return parent;
}

/**
 * Shared next-item selection logic to keep single-item and batch results aligned.
 *
 * Selection proceeds through several phases:
 *   1. Filter candidates via filterCandidates() pipeline.
 *   2. Critical-path escalation: if a critical item is blocked, surface its direct
 *      blocker immediately (bypasses scoring).
 *   3. Non-critical blocker surfacing: if a non-critical blocked item has priority
 *      >= the best open competitor, surface its blocker so the dependency is resolved.
 *   4. Open item selection: SortIndex-based ranking among remaining candidates;
 *      when all sortIndex values are equal, effective priority (descending,
 *      accounting for priority inheritance from blocked dependents) then age
 *      (ascending) break ties.
 */
export function findNextWorkItemFromItems(
  ctx: WorklogDatabaseContext,
  hooks: SelectionHooks,
  items: WorkItem[],
  assignee?: string,
  searchTerm?: string,
  excluded?: Set<string>,
  debugPrefix: string = '[next]',
  includeBlocked: boolean = false,
  stage?: string,
  includeInProgress: boolean = false,
  edgeCache?: EdgeCache,
  risk?: string,
  effort?: string
): NextWorkItemResult {
  hooks.debug(`${debugPrefix} assignee=${assignee || ''} search=${searchTerm || ''} stage=${stage || ''} excluded=${excluded?.size || 0} risk=${risk || ''} effort=${effort || ''}`);

  // Build the sort-order cache once from the pre-loaded items array.
  // This avoids an extra full-table scan of all work items from the database.
  const sortOrderCache = ctx.store.orderItemsByHierarchySortIndexSkipCompleted(items);

  // Shared effective-priority cache: avoids redundant dependency lookups
  // across all selectBySortIndex calls within this invocation.
  const effectivePriorityCache = new Map<string, { value: number; reason: string; inheritedFrom?: string }>();

  // ── Stage 1: Filter pipeline ──
  const { candidates: filteredItems, criticalPool } = filterCandidates(ctx, hooks, items, {
    assignee,
    searchTerm,
    stage,
    risk,
    effort,
    excluded,
    includeBlocked,
    includeInProgress,
    debugPrefix,
    edgeCache,
  });

  // ── Stage 2: Critical-path escalation ──
  // Delegated to handleCriticalEscalation() which operates on the full
  // item set so that critical items outside the assignee/search filter
  // can still surface their blockers.
  // Skip critical escalation when stage filter is specified - user is
  // explicitly filtering by stage and doesn't want escalation to override it.
  if (!stage) {
    const criticalResult = handleCriticalEscalation(hooks, items, {
      assignee,
      searchTerm,
      excluded,
      includeInProgress,
      risk,
      effort,
      debugPrefix: `${debugPrefix} [critical]`,
      edgeCache,
      sortOrderCache,
    });
    if (criticalResult) {
      return criticalResult;
    }
  }

  // ── Stage 3: Non-critical blocker surfacing ──
  // For non-critical blocked items whose priority is >= the best open
  // competitor, surface their blocker so that the dependency is resolved
  // first.  This mirrors the old selectDeepestInProgress blocked-item
  // handling that was removed during the filter-pipeline consolidation.
  //
  // Blocked items in an in-progress parent subtree are excluded from
  // Stage 3 — the parent represents the unit of work and children should
  // be hidden from wl next results. The existing isInProgressSubtree()
  // filter in Stage 5 already ensures this for open items; Stage 3 must
  // apply the same filtering for blocker surfacing.
  //
  // Skip non-critical blocker surfacing when a stage filter is specified —
  // mirroring the Stage 2 guard above: the user is explicitly filtering by
  // stage and blocker surfacing must not surface items at other stages
  // (WL-0MSP1XJSO007LE3K). A blocker's own stage is not constrained by the
  // stage-filtered candidate pool, so surfacing it would violate the filter.
  // Strict root-only (WL-0MS964SIA0057ABR): tracks whether any would-be
  // blocker was a hidden child whose parent is not selectable. If no blocker
  // can be surfaced and no root candidate remains in Stage 5, wl next
  // returns null with a clear reason rather than surfacing the child.
  let droppedHiddenChildBlocker = false;

  if (!stage) {
    const nonCriticalBlocked = criticalPool.filter(
      item => item.status === 'blocked' && item.priority !== 'critical'
    ).filter(item => !hooks.isInProgressSubtree(item, items));
    hooks.debug(`${debugPrefix} non-critical blocked=${nonCriticalBlocked.length}`);

    if (nonCriticalBlocked.length > 0 && filteredItems.length > 0) {
      // Find the highest priority value among open candidates
      const bestCompetitorPriority = Math.max(
        ...filteredItems.map(item => getPriorityValue(item.priority))
      );
  
      // Sort blocked items by priority descending so we handle the most
      // important blocked item first
      const sortedBlocked = nonCriticalBlocked.slice().sort(
        (a, b) => getPriorityValue(b.priority) - getPriorityValue(a.priority)
      );
  
      for (const blockedItem of sortedBlocked) {
        const blockedPriority = getPriorityValue(blockedItem.priority);
        if (blockedPriority < bestCompetitorPriority) {
          // Blocked item is lower priority than best open candidate — skip
          continue;
        }
  
        // Blocked item priority >= best competitor: surface its blocker
        const blockingPairs: { blocking: WorkItem; blocked: WorkItem }[] = [];
  
        // Check dependency blockers
        const dependencyBlockers = hooks.getActiveDependencyBlockers(blockedItem.id, edgeCache);
        for (const blocker of dependencyBlockers) {
          if (excluded?.has(blocker.id)) continue;
          blockingPairs.push({ blocking: blocker, blocked: blockedItem });
        }
  
        // Check child blockers
        const blockingChildren = hooks.getNonClosedChildren(blockedItem.id, edgeCache);
        for (const child of blockingChildren) {
          if (excluded?.has(child.id)) continue;
          blockingPairs.push({ blocking: child, blocked: blockedItem });
        }
  
        // Apply assignee/search filters to blockers
        let filteredBlockers = blockingPairs.filter(pair =>
          applyFilters(ctx, [pair.blocking], assignee, searchTerm).length > 0
        ).filter(pair => matchesRiskEffort(pair.blocking, risk, effort));
  
        // Strict root-only (WL-0MS964SIA0057ABR): child blockers are never
        // surfaced by wl next.
        //  - A child blocker whose parent is a selectable actionable root
        //    candidate is dropped — the parent competes in Stage 5 (open item
        //    selection) and is the unit of work surfaced there.
        //  - A child blocker whose parent is NOT selectable is hidden entirely
        //    (no orphan promotion); if no surfacable blocker remains and no
        //    root candidate exists, wl next returns null with a clear reason.
        const rootOnlyBlockers: { blocking: WorkItem; blocked: WorkItem }[] = [];
        for (const pair of filteredBlockers) {
          if (!pair.blocking.parentId) {
            // Root-level blocker — surfacing it is fine.
            rootOnlyBlockers.push(pair);
            continue;
          }
          // Child blocker: resolve to parent when selectable, else hidden.
          const resolved = resolveBlockerToRoot(ctx, hooks, pair.blocking, items, assignee, searchTerm, excluded);
          if (resolved) {
            // Parent is selectable — it competes in Stage 5 (existing
            // hierarchy awareness, WL-0MQF95NCC0024H61).
            hooks.debug(`${debugPrefix}   drop child blocker ${pair.blocking.id} (selectable parent ${resolved.id} competes in Stage 5)`);
          } else {
            droppedHiddenChildBlocker = true;
          }
        }
        filteredBlockers = rootOnlyBlockers;
  
        // Filter out blockers that belong to an in-progress parent subtree —
        // children of in-progress parents must not appear as independent
        // wl next results from any stage, including blocker surfacing.
        // This complements the in-progress subtree filter above on the
        // blocked item itself and the existing isInProgressSubtree() filter
        // in Stage 5 (open item selection).
        filteredBlockers = filteredBlockers.filter(pair =>
          !hooks.isInProgressSubtree(pair.blocking, items)
        );
  
        hooks.debug(`${debugPrefix} blocker-surfacing: blockedItem=${blockedItem.id} pri=${blockedItem.priority} blockers=${filteredBlockers.length}`);
  
        if (filteredBlockers.length > 0) {
          // Select the best blocker by sort index
          const orderedBlockers = hooks.orderBySortIndex(filteredBlockers.map(p => p.blocking), sortOrderCache);
          const selectedBlocker = orderedBlockers[0];
          if (selectedBlocker) {
            const pair = filteredBlockers.find(p => p.blocking.id === selectedBlocker.id)!;
            return {
              workItem: selectedBlocker,
              reason: `Blocking issue for ${pair.blocked.priority}-priority item ${pair.blocked.id} (${pair.blocked.title})`
            };
          }
        }
      }
    }
  } // end if (!stage) — Stage 3 skipped under stage filter

  // ── Stage 5: Open item selection ──
  // Select among filtered candidates, returning the best root item
  // without descending into children.
  if (filteredItems.length === 0) {
    return { workItem: null, reason: 'No work items available' };
  }
  hooks.debug(`${debugPrefix} open candidates=${filteredItems.length}`);

  // Identify root-level candidates: items with no parent. Strict root-only
  // (WL-0MS964SIA0057ABR): orphan promotion is removed — children whose
  // parent is closed/deleted/not in the candidate pool are NOT promoted
  // and are not returned by wl next.
  // Children of in-progress parents are excluded — the entire in-progress
  // subtree should be skipped from wl next recommendations.
  const rootCandidates = filteredItems.filter(item => !item.parentId)
    .filter(item => !hooks.isInProgressSubtree(item, items));
  hooks.debug(`${debugPrefix} root candidates=${rootCandidates.length}`);

  if (rootCandidates.length === 0) {
    // Fallback: no root-level candidates. Strict root-only — do not
    // descend into children, and do not promote orphans.
    // Still exclude items in an in-progress subtree even in the fallback path
    // so that the entire in-progress subtree is skipped.
    const fallbackItems = filteredItems.filter(item => !item.parentId && !hooks.isInProgressSubtree(item, items));
    if (fallbackItems.length === 0) {
      // Clear reason when blockers were hidden children (WL-0MS964SIA0057ABR):
      // the child is hidden entirely and its parent is not selectable.
      if (droppedHiddenChildBlocker) {
        return {
          workItem: null,
          reason: 'No work items available — blockers are child items whose parents are not selectable (children are hidden from wl next)'
        };
      }
      return { workItem: null, reason: 'No work items available' };
    }
    const selected = hooks.selectBySortIndex(fallbackItems, effectivePriorityCache, sortOrderCache, edgeCache, items);
    hooks.debug(`${debugPrefix} selected open (fallback)=${selected?.id || ''}`);
    const effectiveInfo = selected ? computeEffectivePriority(ctx, hooks, selected, effectivePriorityCache, edgeCache, items) : null;
    return {
      workItem: selected,
      reason: `Next open item by sort_index${selected ? ` (${effectiveInfo?.inheritedFrom ? effectiveInfo.reason : `priority ${selected.priority}`})` : ''}`
    };
  }

  const selectedRoot = hooks.selectBySortIndex(rootCandidates, effectivePriorityCache, sortOrderCache, edgeCache, items);
  hooks.debug(`${debugPrefix} selected root=${selectedRoot?.id || ''}`);

  if (!selectedRoot) {
    return { workItem: null, reason: 'No work items available' };
  }

  // Return the selected root directly — do NOT descend into children.
  // The parent represents the unit of work; children are tracked within it.
  const rootEffectiveInfo = computeEffectivePriority(ctx, hooks, selectedRoot, effectivePriorityCache, edgeCache, items);
  return {
    workItem: selectedRoot,
    reason: `Next open item by sort_index${rootEffectiveInfo ? ` (${rootEffectiveInfo.inheritedFrom ? rootEffectiveInfo.reason : `priority ${selectedRoot.priority}`})` : ''}`
  };
}

/**
 * Find the next work item to work on based on priority and creation time
 * @param assignee - Optional assignee filter
 * @param searchTerm - Optional search term for fuzzy matching
 * @returns The next work item and a reason for the selection, or null if none found
 */
export function findNextWorkItem(
  ctx: WorklogDatabaseContext,
  hooks: SelectionHooks,
  assignee?: string,
  searchTerm?: string,
  includeBlocked: boolean = false,
  stage?: string,
  includeInProgress: boolean = false,
  risk?: string,
  effort?: string
): NextWorkItemResult {
  const items = ctx.store.getAllWorkItems();
  const edgeCache = buildEdgeCache(ctx, items);
  return findNextWorkItemFromItems(ctx, hooks, items, assignee, searchTerm, undefined, '[next]', includeBlocked, stage, includeInProgress, edgeCache, risk, effort);
}

/**
 * Find multiple next work items (up to `count`) using the same selection logic
 * as `findNextWorkItem`, but excluding already-selected items between iterations.
 */
export function findNextWorkItems(
  ctx: WorklogDatabaseContext,
  hooks: SelectionHooks,
  count: number,
  assignee?: string,
  searchTerm?: string,
  includeBlocked: boolean = false,
  stage?: string,
  includeInProgress: boolean = false,
  risk?: string,
  effort?: string
): NextWorkItemResult[] {
  const results: NextWorkItemResult[] = [];
  const excluded = new Set<string>();

  // Load all items and dependency edges once, reuse across batch iterations
  // to avoid N+1 database loads (Bottleneck 4: batch reloads all items per iteration)
  const allItems = ctx.store.getAllWorkItems();
  const edgeCache = buildEdgeCache(ctx, allItems);

  for (let i = 0; i < count; i += 1) {
    const result = findNextWorkItemFromItems(
      ctx,
      hooks,
      allItems,
      assignee,
      searchTerm,
      excluded,
      `[next batch ${i + 1}/${count}]`,
      includeBlocked,
      stage,
      includeInProgress,
      edgeCache,
      risk,
      effort
    );

    results.push(result);
    if (result.workItem) {
      excluded.add(result.workItem.id);
      // Also exclude all descendants so children of returned parents
      // are never surfaced in batch results (AC #4)
      const descendants = hooks.getDescendants(result.workItem.id);
      for (const desc of descendants) {
        excluded.add(desc.id);
      }
    }
  }

  return results;
}

/**
 * Apply assignee and search term filters to a list of work items
 */
export function applyFilters(
  ctx: WorklogDatabaseContext,
  items: WorkItem[],
  assignee?: string,
  searchTerm?: string,
): WorkItem[] {
  let filtered = items;

  // Filter by assignee if provided
  if (assignee) {
    filtered = filtered.filter(item => item.assignee === assignee);
  }

  // Filter by search term if provided (fuzzy match against id, title, description, and comments)
  if (searchTerm) {
    const lowerSearchTerm = searchTerm.toLowerCase();

    // Batch-load all comments once into a Map<workItemId, commentText[]>
    // to avoid N+1 per-item comment queries (Bottleneck 5)
    const allComments = ctx.store.getAllComments();
    const commentsByItemId = new Map<string, string[]>();
    for (const comment of allComments) {
      let list = commentsByItemId.get(comment.workItemId);
      if (!list) {
        list = [];
        commentsByItemId.set(comment.workItemId, list);
      }
      list.push(comment.comment);
    }

    filtered = filtered.filter(item => {
      const idMatch = item.id.toLowerCase().includes(lowerSearchTerm);
      // Check title and description
      const titleMatch = item.title.toLowerCase().includes(lowerSearchTerm);
      const descriptionMatch = item.description?.toLowerCase().includes(lowerSearchTerm) || false;

      // Check comments from the pre-loaded batch
      const itemComments = commentsByItemId.get(item.id);
      const commentMatch = itemComments
        ? itemComments.some(comment => comment.toLowerCase().includes(lowerSearchTerm))
        : false;

      return idMatch || titleMatch || descriptionMatch || commentMatch;
    });
  }

  return filtered;
}

/**
 * Select the highest priority blocking candidate with critical reference
 */
export function selectHighestPriorityBlocking(
  hooks: SelectionHooks,
  pairs: { blocking: WorkItem; critical: WorkItem }[],
  sortOrderCache?: WorkItem[],
): { blocking: WorkItem; critical: WorkItem } | null {
  if (pairs.length === 0) {
    return null;
  }

  const orderedBlocking = hooks.orderBySortIndex(pairs.map(pair => pair.blocking), sortOrderCache);
  const selected = orderedBlocking[0];
  return selected ? pairs.find(pair => pair.blocking.id === selected.id) ?? null : null;
}
