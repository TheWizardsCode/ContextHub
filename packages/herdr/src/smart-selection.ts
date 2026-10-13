/**
 * packages/herdr/src/smart-selection.ts — Smart selection for the Herdr worklist
 *
 * Guarantees that all critical-priority items and all in_review items (the
 * producer-review queue — status `completed` awaiting review OR `in-progress`
 * being re-worked after review feedback, WL-0MV6JGVPH009YDXB) are ALWAYS
 * shown in the default worklist, regardless of the `browseItemCount` setting.
 * The count limit applies only to "other" items that are neither critical
 * nor in_review.
 *
 * This function is intentionally duplicated per TUI (decision Q2c in
 * WL-0MS8W5LTW006YZ4B); the Pi TUI Worklog extension copy was removed by
 * WL-0MSGI7PV9004UD0N, so the Herdr plugin copy (and the core `wl next`
 * grouping duplication noted in grouping.ts) is the only one remaining.
 */

import type { WorkItem } from './fetcher.js';

/**
 * Returns true when an item is part of the mandatory set that must always
 * be shown: priority=critical OR (stage=in_review with status=completed
 * awaiting producer review or status=in-progress being re-worked after
 * review feedback).
 */
export function isMandatoryItem(item: Pick<WorkItem, 'priority' | 'status' | 'stage'>): boolean {
  return (
    item.priority === 'critical' ||
    (item.stage === 'in_review' && (item.status === 'completed' || item.status === 'in-progress'))
  );
}

/**
 * Smart-select work items for the default worklist.
 *
 * - Items whose stage is 'done' (fully closed) are always excluded — the
 *   default list only shows actionable work (WL-0MS94VAII00054L9).
 * - All mandatory items (critical ∪ in_review) are always included,
 *   deduplicated (an item matching both criteria counts once). The review
 *   component covers BOTH status=completed and status=in-progress items
 *   (the latter are in_review items being re-worked after review feedback,
 *   WL-0MV6JGVPH009YDXB).
 * - The remaining `browseItemCount` slots are filled with "other" items in
 *   their original (wl next) order.
 * - When the mandatory set alone meets or exceeds `browseItemCount`, all
 *   mandatory items are shown and zero others (no hard cap on mandatory).
 *
 * Pure & deterministic: takes (items, browseItemCount), returns a new array,
 * does not mutate the input. The caller clamps `browseItemCount` to 1–50.
 */
export function selectWorkItems<T extends Pick<WorkItem, 'priority' | 'status' | 'stage' | 'parentId'>>(
  items: T[],
  browseItemCount: number,
): T[] {
  // Defensive root-only filter for non-critical items (WL-0MS964SIA0057ABR):
  // child items are hidden from the top-level worklist — they are only
  // visible under their parent via expand. HOWEVER, critical items are an
  // exception: child critical items must always be visible so the team can
  // see blocking items (e.g., untriaged test-failures) that the ship
  // critical-items gate detects.
  const nonCriticals = items.filter((i) => !i.parentId || i.priority === 'critical');
  const actionable = nonCriticals.filter((i) => i.stage !== 'done');
  const criticals = actionable.filter((i) => i.priority === 'critical');
  const reviews = actionable.filter((i) => i.stage === 'in_review' && (i.status === 'completed' || i.status === 'in-progress') && i.priority !== 'critical');
  const others = actionable.filter((i) => !isMandatoryItem(i));
  const othersLimit = Math.max(0, browseItemCount - (criticals.length + reviews.length));
  return [...criticals, ...reviews, ...others.slice(0, othersLimit)];
}
