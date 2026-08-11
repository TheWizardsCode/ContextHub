/**
 * Grouping utility for `wl next --groups/-g`.
 *
 * Provides:
 * - Greedy first-fit grouping algorithm for partitioning items into parallel-safe groups
 *
 * File-path extraction is provided by `extractFilePaths` in `helpers.ts`.
 * The file-path convention targets a structured "**Key Files:**" section in the work item
 * description, where paths are listed as bullet points with or without backticks:
 *
 * ```
 * **Key Files:**
 * - `src/commands/next.ts`
 * - `src/commands/list.ts`
 * ```
 *
 * See docs/FILE_PATH_CONVENTION.md for the full specification.
 */
import { type GroupableItem, type GroupAssignment } from './helpers.js';
/**
 * Greedy first-fit grouping algorithm for file-path-based conflict detection.
 *
 * Assigns each item to the first group (1-indexed) that contains no item
 * sharing any file path with it. If no existing group works, starts a new
 * group (up to `maxGroups`, then continues creating singleton groups).
 *
 * Items with empty file paths (unknown) are each placed in their own
 * singleton "conflict-unknown" group, because we cannot assess their
 * conflict with other items. These groups are marked as "restricted" —
 * no other item may join a restricted group.
 *
 * @param items - Array of items with id and extracted file paths
 * @param maxGroups - Maximum number of parallel-safe groups to form (default 3)
 * @returns Map of item id → group number (1-indexed)
 */
export declare function groupItemsByFilePaths(items: GroupableItem[], maxGroups?: number): Map<string, number>;
/**
 * Assign items to groups based on priority, stage and file-path conflicts.
 *
 * Grouping rules (display order — most actionable first):
 * - Items with priority `critical` → partitioned by file-path conflicts using the
 *   greedy first-fit algorithm, labeled `Critical Group 1..x`, placed first.
 * - Non-critical items with stage `in_progress`, `plan_complete` or `intake_complete`
 *   → partitioned by file-path conflicts using the greedy first-fit algorithm,
 *   labeled `Group 1..x` (no stage prefix in the label).
 * - Items with stage `idea` → all placed in one group labeled "Idea" (no conflict checking).
 * - All remaining non-critical items (unknown/other/custom stages, `done`, etc.) → all
 *   placed in a single group labeled "Other" (safety net for unknown/custom stages).
 * - Items with stage `in_review` → all placed in one group labeled "In Review", placed last.
 *
 * Within-group ordering (stage sub-sort `in_progress` → `plan_complete` → `intake_complete`
 * → remaining stages, then priority high → medium → low) is applied by callers via
 * `compareGroupableItems` / `compareGroupedItems`.
 *
 * @param items - Array of items with id, priority, stage, and extracted file paths
 * @param maxFilePathGroups - Maximum number of file-path-based groups (default 3)
 * @returns Map of item id → GroupAssignment
 */
export declare function assignItemGroups(items: GroupableItem[], maxFilePathGroups?: number): Map<string, GroupAssignment>;
/**
 * Compare two items for within-group display order:
 * stage sub-sort (in_progress → plan_complete → intake_complete → remaining
 * stages), then priority (high → medium → low), then id as a deterministic
 * tie-break.
 */
export declare function compareGroupableItems(a: GroupableItem, b: GroupableItem): number;
/**
 * Compare two items for full display order: assigned group first (ascending
 * group number), then within-group order via `compareGroupableItems`.
 * Items without an assignment sort after all assigned items.
 */
export declare function compareGroupedItems(groupMap: Map<string, GroupAssignment>, a: GroupableItem, b: GroupableItem): number;
//# sourceMappingURL=grouping.d.ts.map