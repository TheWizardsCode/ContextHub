/**
 * src/sync/prefix-filter.ts — cross-project prefix filtering (defense-in-depth).
 *
 * Concern: keeping foreign-prefix work items out of the merge. The repo-root
 * guard (`assertDataFileInCwdRepo`) blocks syncs whose data file lives in a
 * different git repo, but a stale long-running process or a bypassed
 * repo-context check can still reach the merge step with foreign data; this
 * filter makes the merge itself prefix-aware (SA-0MSC0BM1V0032UYT).
 *
 * Extracted verbatim from `src/sync.ts` (WL-0MVP9R3PU004EGYE, child 4 of 6 of
 * the WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). Both functions are
 * public and re-exported from the barrel.
 */

import type { WorkItem, Comment, DependencyEdge, AuditResult } from '../types.js';

/**
 * Cross-project prefix filter (SA-0MSC0BM1V0032UYT) — defense-in-depth.
 *
 * `assertDataFileInCwdRepo` (WL-0MSAH26DD001XXST) blocks syncs whose data
 * file lives in a different git repo than the process cwd, but a stale
 * long-running process (loaded pre-fix modules) or a bypassed repo-context
 * check can still reach the merge step with foreign data. This filter makes
 * the merge itself prefix-aware: work items whose ID prefix does not match
 * the project prefix are never imported, and their comments, dependency
 * edges and audit results are dropped with them.
 *
 * IDs without a '-' separator cannot be classified and are kept, matching
 * `wl doctor foreign-items` behaviour.
 *
 * @param id - The work item ID (e.g. `WL-0MSAH2A71000MUA3`).
 * @param projectPrefix - The project's configured prefix (e.g. `WL`), matched case-insensitively.
 * @returns True when the item belongs to the project (or is unclassifiable).
 */
export function isOwnProjectItemId(id: string, projectPrefix: string): boolean {
  const dash = id.indexOf('-');
  if (dash <= 0) {
    return true; // no dash, or leading dash — cannot be classified (consistent with doctor)
  }
  return id.slice(0, dash).toUpperCase() === projectPrefix.toUpperCase();
}

/**
 * Filter remote sync data so only records belonging to the project prefix
 * can enter the merge. Comments, dependency edges and audit results that
 * reference dropped foreign items are removed with them.
 *
 * @param items - Remote work items fetched from the remote ref.
 * @param comments - Remote comments.
 * @param edges - Remote dependency edges.
 * @param audits - Remote audit results.
 * @param projectPrefix - The project's configured prefix (case-insensitive).
 * @returns The filtered sets plus the IDs of dropped foreign items (for observability).
 */
export function filterRemoteDataByPrefix(
  items: WorkItem[],
  comments: Comment[],
  edges: DependencyEdge[],
  audits: AuditResult[],
  projectPrefix: string
): {
  items: WorkItem[];
  comments: Comment[];
  edges: DependencyEdge[];
  audits: AuditResult[];
  droppedItems: string[];
} {
  const allowedItemIds = new Set<string>();
  const keptItems: WorkItem[] = [];
  const droppedItems: string[] = [];

  for (const item of items) {
    if (isOwnProjectItemId(item.id, projectPrefix)) {
      allowedItemIds.add(item.id);
      keptItems.push(item);
    } else {
      droppedItems.push(item.id);
    }
  }

  const keptComments = comments.filter(c => allowedItemIds.has(c.workItemId));
  const keptEdges = edges.filter(e => allowedItemIds.has(e.fromId) && allowedItemIds.has(e.toId));
  const keptAudits = audits.filter(a => allowedItemIds.has(a.workItemId));

  return {
    items: keptItems,
    comments: keptComments,
    edges: keptEdges,
    audits: keptAudits,
    droppedItems,
  };
}
