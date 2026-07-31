/**
 * packages/herdr/src/smart-selection.ts — Smart selection for the Herdr worklist
 *
 * Guarantees that all critical-priority items and all completed/in_review
 * items (the producer-review queue) are ALWAYS shown in the default worklist,
 * regardless of the `browseItemCount` setting. The count limit applies only
 * to "other" items that are neither critical nor completed/in_review.
 *
 * This function is intentionally duplicated per TUI (decision Q2c in
 * WL-0MS8W5LTW006YZ4B): a copy lives in the Herdr plugin and another in the
 * Pi TUI Worklog extension. Do NOT move it to a shared package — Herdr has
 * zero npm dependencies and sharing would require new packaging wiring.
 */

import type { WorkItem } from './fetcher.js';

/**
 * Returns true when an item is part of the mandatory set that must always
 * be shown: priority=critical OR (status=completed AND stage=in_review).
 */
export function isMandatoryItem(item: Pick<WorkItem, 'priority' | 'status' | 'stage'>): boolean {
  return item.priority === 'critical' || (item.status === 'completed' && item.stage === 'in_review');
}

/**
 * Smart-select work items for the default worklist.
 *
 * - Items whose stage is 'done' (fully closed) are always excluded — the
 *   default list only shows actionable work (WL-0MS94VAII00054L9).
 * - All mandatory items (critical ∪ completed/in_review) are always included,
 *   deduplicated (an item matching both criteria counts once).
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
  // Defensive root-only filter (WL-0MS964SIA0057ABR): merged lists can never
  // contain child items regardless of source. Children are only visible under
  // their parent via expand.
  const rootOnly = items.filter((i) => !i.parentId);
  const actionable = rootOnly.filter((i) => i.stage !== 'done');
  const criticals = actionable.filter((i) => i.priority === 'critical');
  const reviews = actionable.filter((i) => i.status === 'completed' && i.stage === 'in_review' && i.priority !== 'critical');
  const others = actionable.filter((i) => !isMandatoryItem(i));
  const othersLimit = Math.max(0, browseItemCount - (criticals.length + reviews.length));
  return [...criticals, ...reviews, ...others.slice(0, othersLimit)];
}
