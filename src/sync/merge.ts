/**
 * src/sync/merge.ts — public work-item merge entry point.
 *
 * Concern: the single public merge API `mergeWorkItems` — merging two sets of
 * work items with field-level conflict resolution and returning the merged
 * set plus the text and structured conflict reports.
 *
 * Moved verbatim from `src/sync.ts` (WL-0MVP9QLWU003NV41, child 3 of 6 of the
 * WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). Move-only: no logic
 * edited, no signature changed, no symbol renamed.
 *
 * `mergeWorkItems` delegates to `indexItemsById` / `mergeRemoteItem`, which
 * live in `./field-merge.js` (NOT here) to keep the graph acyclic:
 * merge → field-merge → merge-predicates; the barrel re-exports this module
 * and is its only importer outside the merge family.
 */

import type { WorkItem, ConflictDetail } from '../types.js';
import type { MergeOptions } from './types.js';
import { indexItemsById, mergeRemoteItem } from './field-merge.js';

/**
 * Merge two sets of work items with intelligent field-level conflict resolution
 * Strategy: For each field, prefer non-default values, or use the value from the newer version
 * This heuristic allows merging changes from both versions without needing a common ancestor
 */
export function mergeWorkItems(
  localItems: WorkItem[],
  remoteItems: WorkItem[],
  options?: MergeOptions
): { merged: WorkItem[], conflicts: string[], conflictDetails: ConflictDetail[] } {
  const conflicts: string[] = [];
  const conflictDetails: ConflictDetail[] = [];
  const mergedMap = indexItemsById(localItems);

  for (const remoteItem of remoteItems) {
    mergeRemoteItem(mergedMap, remoteItem, options, conflicts, conflictDetails);
  }

  return {
    merged: Array.from(mergedMap.values()),
    conflicts,
    conflictDetails
  };
}
