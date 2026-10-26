/**
 * packages/shared/src/database/critical-escalation.ts — Stage 2 of the
 * `wl next` selection pipeline: critical-path escalation.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP0U5007BAZD (extract the `wl next` selection pipeline).
 *
 * ## Responsibility
 *
 * When a critical item is blocked (by a child or a dependency edge), surface
 * the blocker with the highest effective priority so the critical path is
 * unblocked first; an unblocked critical competes by sort-index. Operates on
 * the FULL item set so critical items outside the assignee/search filter are
 * still considered; only the final blocker selection is filtered.
 *
 * ## Boundary
 *
 * **Belongs here.** `handleCriticalEscalation` and nothing else. It reuses
 * `matchesRiskEffort` from `priority.ts` (a leaf import) and the pipeline
 * primitives `applyFilters`, `resolveBlockerToRoot` and
 * `selectHighestPriorityBlocking` through `SelectionHooks`: `next-pipeline.ts`
 * imports this stage, so importing back would create a cycle the split guard
 * forbids.
 *
 * **Does NOT belong here.** Candidate filtering and final selection
 * (`next-pipeline.ts`), priority ordinals (`priority.ts`), CRUD, hierarchy
 * and dependency management (other slices).
 *
 * `WorklogDatabase` keeps a thin delegating member for this function.
 */

import { NextWorkItemResult, WorkItem } from '../types.js';
import { EdgeCache, SelectionHooks } from './context.js';
import { matchesRiskEffort } from './priority.js';
/**
 * Handle critical-path escalation (Stage 2 of the next-item algorithm).
 *
 * Critical items are always prioritized above non-critical items:
 *   - Unblocked criticals are selected first by sortIndex (priority+age fallback).
 *   - Blocked criticals surface their direct blocker (child or dependency edge)
 *     with the highest effective priority.
 *   - An unblocked critical always wins over a blocker of a non-critical item.
 *
 * Operates on the FULL item set so that critical items outside the
 * assignee/search filter are still considered — only the final blocker
 * selection is filtered by assignee/search.
 *
 * @returns NextWorkItemResult if critical escalation selects an item, null otherwise
 */
export function handleCriticalEscalation(
  hooks: SelectionHooks,
  allItems: WorkItem[],
  options: {
    assignee?: string;
    searchTerm?: string;
    risk?: string;
    effort?: string;
    excluded?: Set<string>;
    debugPrefix?: string;
    includeInProgress?: boolean;
    edgeCache?: EdgeCache;
    sortOrderCache?: WorkItem[];
  } = {}
): NextWorkItemResult | null {
  const {
    assignee,
    searchTerm,
    risk,
    effort,
    excluded,
    debugPrefix = '[critical]',
    includeInProgress = false,
    edgeCache,
  } = options;

  // Find all critical items from the full set, excluding only
  // deleted items (these are never actionable).
  // In-progress items are excluded by default (not actionable for escalation)
  // unless --include-in-progress is set.
  // Items in the in_review stage are preserved even if their status
  // is 'completed' since they need to appear in wl next for review.
  // Items in the done stage are excluded (terminal, not actionable)
  // (WL-0MSGRJWRX0068W3W).
  const criticalItems = allItems.filter(
    item =>
      item.priority === 'critical' &&
      item.status !== 'deleted' &&
      (item.status !== 'completed' || item.stage === 'in_review') &&
      item.stage !== 'done' &&
      (includeInProgress || item.status !== 'in-progress')
  );
  hooks.debug(`${debugPrefix} critical items from full set=${criticalItems.length}`);

  if (criticalItems.length === 0) {
    return null;
  }

  // ── Unblocked criticals ──
  // An item is "unblocked" if it is not blocked AND has no non-closed children
  // (children act as implicit blockers).
  const unblockedCriticals = criticalItems.filter(
    item => item.status !== 'blocked' && hooks.getNonClosedChildren(item.id, edgeCache).length === 0
  );
  hooks.debug(`${debugPrefix} unblocked criticals=${unblockedCriticals.length}`);

  if (unblockedCriticals.length > 0) {
    // Apply assignee/search to unblocked criticals — only return items
    // that match the caller's filters (including risk/effort).
    let selectable = hooks.applyFilters(unblockedCriticals, assignee, searchTerm)
      .filter(item => matchesRiskEffort(item, risk, effort));
    if (excluded && excluded.size > 0) {
      selectable = selectable.filter(item => !excluded.has(item.id));
    }
    hooks.debug(`${debugPrefix} unblocked criticals after filters=${selectable.length}`);

    if (selectable.length > 0) {
      // Strict root-only (WL-0MS964SIA0057ABR): only root criticals are
      // selectable here. Children are hidden entirely (no orphan promotion)
      // and their parent, if actionable, competes in Stage 5.
      selectable = selectable.filter(item => !item.parentId);
    }

    if (selectable.length > 0) {
      const selected = hooks.selectBySortIndex(selectable, undefined, options.sortOrderCache, options.edgeCache);
      hooks.debug(`${debugPrefix} selected unblocked critical=${selected?.id || ''} title="${selected?.title || ''}"`);
      return {
        workItem: selected,
        reason: `Next unblocked critical item by sort_index${selected ? ` (priority ${selected.priority})` : ''}`
      };
    }
  }

  // ── Blocked criticals ──
  // For each blocked critical, gather its direct blockers (children + dependency edges)
  // from the full item store, then select the best blocker that passes filters.
  const blockedCriticals = criticalItems.filter(
    item => item.status === 'blocked'
  );
  hooks.debug(`${debugPrefix} blocked criticals=${blockedCriticals.length}`);

  if (blockedCriticals.length > 0) {
    const blockingPairs: { blocking: WorkItem; critical: WorkItem }[] = [];

    for (const critical of blockedCriticals) {
      // If the blocked critical has a parent that is a valid (open, not
      // deleted/completed/in-progress) candidate, skip surfacing its
      // blockers — the parent will compete in Stage 5 (open item selection)
      // instead. This ensures that children are not surfaced individually
      // when their parent is a valid candidate (WL-0MQFIYPZK00680H1).
      if (critical.parentId) {
        const critParent = allItems.find(p => p.id === critical.parentId);
        if (
          critParent &&
          critParent.status !== 'deleted' &&
          critParent.status !== 'completed' &&
          critParent.status !== 'in-progress'
        ) {
          hooks.debug(`${debugPrefix}   skip blocker pairs for ${critical.id} (valid parent ${critical.parentId})`);
          continue;
        }
      }

      // Child blockers (non-closed children implicitly block a parent)
      const blockingChildren = hooks.getNonClosedChildren(critical.id, options.edgeCache);
      for (const child of blockingChildren) {
        if (excluded?.has(child.id)) continue;
        blockingPairs.push({ blocking: child, critical });
        hooks.debug(`${debugPrefix}   blocker: child ${child.id} ("${child.title}") blocks critical ${critical.id}`);
      }

      // Dependency-edge blockers
      const dependencyBlockers = hooks.getActiveDependencyBlockers(critical.id, options.edgeCache);
      for (const blocker of dependencyBlockers) {
        if (excluded?.has(blocker.id)) continue;
        blockingPairs.push({ blocking: blocker, critical });
        hooks.debug(`${debugPrefix}   blocker: dep ${blocker.id} ("${blocker.title}") blocks critical ${critical.id}`);
      }
    }

    // Apply assignee/search filters to the blockers only
    const filteredBlockingPairs = blockingPairs.filter(pair =>
      hooks.applyFilters([pair.blocking], assignee, searchTerm).length > 0
    ).filter(pair => matchesRiskEffort(pair.blocking, risk, effort));
    hooks.debug(`${debugPrefix} blocking candidates=${blockingPairs.length} after filters=${filteredBlockingPairs.length}`);

    // Strict root-only (WL-0MS964SIA0057ABR): never surface child blockers.
    // Resolve each blocker to its root parent when the parent is selectable;
    // drop blockers whose parent is not selectable (children are hidden
    // entirely — no orphan promotion).
    const rootBlockingPairs: { blocking: WorkItem; critical: WorkItem }[] = [];
    for (const pair of filteredBlockingPairs) {
      const resolved = hooks.resolveBlockerToRoot(pair.blocking, allItems, assignee, searchTerm, excluded);
      if (resolved && matchesRiskEffort(resolved, risk, effort)) {
        rootBlockingPairs.push({ blocking: resolved, critical: pair.critical });
      }
    }
    hooks.debug(`${debugPrefix} root-resolved blocking candidates=${rootBlockingPairs.length}`);

    const selectedBlocking = hooks.selectHighestPriorityBlocking(rootBlockingPairs, options.sortOrderCache);

    if (selectedBlocking) {
      hooks.debug(`${debugPrefix} selected blocker=${selectedBlocking.blocking.id} ("${selectedBlocking.blocking.title}") for critical ${selectedBlocking.critical.id}`);
      return {
        workItem: selectedBlocking.blocking,
        reason: `Blocking issue for critical item ${selectedBlocking.critical.id} (${selectedBlocking.critical.title})`
      };
    }

    // No actionable blocker found — return the blocked critical itself as a
    // last resort so the user is aware of the stuck critical item.
    let selectableBlocked = hooks.applyFilters(blockedCriticals, assignee, searchTerm)
      .filter(item => matchesRiskEffort(item, risk, effort));
    if (excluded && excluded.size > 0) {
      selectableBlocked = selectableBlocked.filter(item => !excluded.has(item.id));
    }
    // Strict root-only (WL-0MS964SIA0057ABR): only root blocked criticals
    // are eligible for the last-resort selection. Children are hidden
    // entirely (no orphan promotion).
    selectableBlocked = selectableBlocked.filter(item => !item.parentId);
    if (selectableBlocked.length === 0) {
      hooks.debug(`${debugPrefix} all blocked criticals filtered out by root-only filter — returning null`);
      return null;
    }
    const selectedBlockedCritical = hooks.selectBySortIndex(selectableBlocked, undefined, options.sortOrderCache, options.edgeCache);
    hooks.debug(`${debugPrefix} selected blocked critical (fallback)=${selectedBlockedCritical?.id || ''}`);
    return {
      workItem: selectedBlockedCritical,
      reason: 'Blocked critical work item with no identifiable blocking issues'
    };
  }

  // No critical items to escalate
  return null;
}
