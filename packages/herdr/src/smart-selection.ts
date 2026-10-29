/**
 * packages/herdr/src/smart-selection.ts — Smart selection for the Herdr worklist
 *
 * Guarantees that all critical-priority items, all in_review items (the
 * producer-review queue — status `completed` awaiting review OR `in-progress`
 * being re-worked after review feedback, WL-0MV6JGVPH009YDXB), ALL
 * actively-worked items (status = in-progress, WL-0MV6KV22S004NYIU) and ALL
 * status=blocked items (WL-0MV71WBHB007D8ZE) are ALWAYS shown in the default
 * worklist, regardless of the `browseItemCount` setting. The count limit
 * applies only to "other" items that match none of those criteria.
 *
 * Actively-worked items are mandatory because they are the producer's main
 * real-time signal ("what am I working on right now") — they must stay
 * visible even when the deep review queue would otherwise consume the whole
 * window (observed: 22 root in_review items vs browseItemCount=20 left zero
 * slices for "others", hiding an in-progress item entirely). Blocked items
 * are mandatory for the same reason on the release axis: the ship gate
 * queries `wl list --stage in_review` with no status filter, so a
 * status=blocked in_review item is release-blocking and must never be hidden
 * by ranking or the browseItemCount window (WL-0MV71WBHB007D8ZE).
 *
 * This function is intentionally duplicated per TUI (decision Q2c in
 * WL-0MS8W5LTW006YZ4B); the Pi TUI Worklog extension copy was removed by
 * WL-0MSGI7PV9004UD0N, so the Herdr plugin copy (and the core `wl next`
 * grouping duplication noted in grouping.ts) is the only one remaining.
 */

import type { WorkItem } from './fetcher.js';

/**
 * Returns true when an item is part of the mandatory set that must always
 * be shown: priority=critical OR status=in-progress (actively worked at any
 * non-done stage) OR (stage=in_review with status=completed awaiting
 * producer review) OR status=blocked (release-blocking work that the ship
 * gate sees; WL-0MV71WBHB007D8ZE). In-progress/in_review items match the
 * in-progress leg.
 */
export function isMandatoryItem(item: Pick<WorkItem, 'priority' | 'status' | 'stage'>): boolean {
  return (
    item.priority === 'critical' ||
    item.status === 'in-progress' ||
    item.status === 'blocked' ||
    (item.stage === 'in_review' && item.status === 'completed')
  );
}

/**
 * Smart-select work items for the default worklist.
 *
 * - Items whose stage is 'done' (fully closed) are always excluded — the
 *   default list only shows actionable work (WL-0MS94VAII00054L9).
 * - All mandatory items (critical ∪ actively-worked in-progress ∪ in_review
 *   ∪ status=blocked) are always included, deduplicated (an item matching
 *   multiple criteria counts once).
 * - The remaining `browseItemCount` slots are filled with "other" items in
 *   their original (wl next) order.
 * - When the mandatory set alone meets or exceeds `browseItemCount`, all
 *   mandatory items are shown and zero others (no hard cap on mandatory).
 *
 * Placement order (pre-regroup): criticals, then completed/in_review
 * reviews, then status=blocked items, then actively-worked in-progress items
 * (the downstream Group N section), then capped others.
 *
 * Pure & deterministic: takes (items, browseItemCount), returns a new array,
 * does not mutate the input. The caller clamps `browseItemCount` to 1–50.
 */
export function selectWorkItems<T extends Pick<WorkItem, 'priority' | 'status' | 'stage' | 'parentId'>>(
  items: T[],
  browseItemCount: number,
): T[] {
  // Root-only top level for ALL items (WL-0MS964SIA0057ABR, WL-0MVN4WESM007T4XI):
  // the top-level worklist contains only root items — an item with a
  // non-empty `parentId` is never returned here, critical items included; it
  // is reachable through its parent via expand. The critical exception of
  // commit cae8ea8a ("show child critical items in the selection list") is
  // gone: a critical child would otherwise be rendered twice, once at top
  // level and once under its parent.
  //
  // Reachability contract (parent substitution, implemented in fetcher.ts):
  // hiding a critical child must not make release-blocking work invisible, so
  // the fetcher resolves each critical child's ROOT ancestor (walking
  // `parentId` to the top-most non-child item) and injects it into the
  // mandatory set before calling this function. The substituted root is
  // always shown, is sorted by its own priority/group (it is not marked
  // critical), and is omitted when already present — so the ship
  // critical-items gate keeps blocking releases without a duplicate row.
  const nonCriticals = items.filter((i) => !i.parentId);
  const actionable = nonCriticals.filter((i) => i.stage !== 'done');
  const criticals = actionable.filter((i) => i.priority === 'critical');
  const reviews = actionable.filter((i) => i.stage === 'in_review' && i.status === 'completed' && i.priority !== 'critical');
  const blockedItems = actionable.filter((i) => i.status === 'blocked' && i.priority !== 'critical');
  const active = actionable.filter((i) => i.status === 'in-progress' && i.priority !== 'critical');
  const others = actionable.filter((i) => !isMandatoryItem(i));
  const othersLimit = Math.max(0, browseItemCount - (criticals.length + reviews.length + blockedItems.length + active.length));
  return [...criticals, ...reviews, ...blockedItems, ...active, ...others.slice(0, othersLimit)];
}
