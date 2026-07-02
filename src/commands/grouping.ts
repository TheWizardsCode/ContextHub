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
 * - `packages/tui/extensions/lib/browse.ts`
 * ```
 *
 * See docs/FILE_PATH_CONVENTION.md for the full specification.
 */

import { extractFilePaths, type GroupableItem, type GroupAssignment } from './helpers.js';

// ── Grouping algorithm ────────────────────────────────────────────────

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
export function groupItemsByFilePaths(
  items: GroupableItem[],
  maxGroups: number = 3,
): Map<string, number> {
  const itemGroup = new Map<string, number>();

  // Track the set of file paths assigned to each group
  // groupPaths[groupNumber] = Set of file paths
  const groupPaths = new Map<number, Set<string>>();

  // Track which groups are "restricted" (contain unknown-path items)
  // Restricted groups cannot accept any other items.
  const restrictedGroups = new Set<number>();

  // Track the current group counter
  let nextGroup = 1;

  for (const item of items) {
    const { id, filePaths } = item;

    // Items with unknown file paths → singleton restricted group
    if (filePaths.length === 0) {
      itemGroup.set(id, nextGroup);
      groupPaths.set(nextGroup, new Set());
      restrictedGroups.add(nextGroup);
      nextGroup++;
      continue;
    }

    // Try to find an existing group this item fits in
    let assigned = false;
    // Only check within established groups (up to maxGroups)
    const groupsToCheck = Math.min(maxGroups, nextGroup - 1);
    for (let g = 1; g <= groupsToCheck; g++) {
      const existingPaths = groupPaths.get(g);
      if (!existingPaths) continue;

      // Skip restricted groups (unknown-path singletons)
      if (restrictedGroups.has(g)) continue;

      // Check if any of this item's paths conflict with the group's paths
      const hasConflict = filePaths.some(fp => existingPaths.has(fp));
      if (!hasConflict) {
        // No conflict — assign to this group
        for (const fp of filePaths) {
          existingPaths.add(fp);
        }
        itemGroup.set(id, g);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      // Start a new group
      const newGroup = nextGroup;
      groupPaths.set(newGroup, new Set(filePaths));
      itemGroup.set(id, newGroup);
      nextGroup++;
    }
  }

  return itemGroup;
}

/**
 * Assign items to groups based on priority, stage and file-path conflicts.
 *
 * Grouping rules (display order — most actionable first):
 * - Items with priority `critical` → all placed in a single group labeled "Critical"
 *   at the very top, regardless of stage or file-path conflicts.
 * - Items with other/unknown stage → all placed in a single group labeled "Other"
 *   (no file-overlap splitting, all such items share one group).
 * - Items with stage `plan_complete` → grouped by file-path conflicts using the
 *   greedy first-fit algorithm, labeled "Plan Complete Group N".
 * - Items with stage `in_review` → all placed in one group labeled "In Review".
 * - Items with stage `intake_complete` → all placed in one group labeled "Intake Complete".
 * - Items with stage `idea` → all placed in one group labeled "Idea" (no conflict checking).
 *
 * @param items - Array of items with id, priority, stage, and extracted file paths
 * @param maxFilePathGroups - Maximum number of file-path-based groups (default 3)
 * @returns Map of item id → GroupAssignment
 */
export function assignItemGroups(
  items: GroupableItem[],
  maxFilePathGroups: number = 3,
): Map<string, GroupAssignment> {
  const result = new Map<string, GroupAssignment>();

  const knownStages = new Set(['idea', 'intake_complete', 'in_review', 'plan_complete']);

  let nextGroup = 1;

  // 0. Critical — single group for all items with priority 'critical', regardless of stage
  const criticalIds = new Set<string>();
  const criticalItems = items.filter(item => item.priority === 'critical');
  if (criticalItems.length > 0) {
    for (const item of criticalItems) {
      criticalIds.add(item.id);
      result.set(item.id, { group: nextGroup, groupLabel: 'Critical' });
    }
    nextGroup++;
  }

  // 1. Other — single group for all items with unknown/other stages (excluding critical)
  const otherItems = items.filter(item => !criticalIds.has(item.id) && (!item.stage || !knownStages.has(item.stage)));
  if (otherItems.length > 0) {
    for (const item of otherItems) {
      result.set(item.id, { group: nextGroup, groupLabel: 'Other' });
    }
    nextGroup++;
  }

  // 2. Group plan_complete items by file-path conflicts (excluding critical)
  const planCompleteItems = items.filter(item => !criticalIds.has(item.id) && item.stage === 'plan_complete');
  if (planCompleteItems.length > 0) {
    const planGroups = groupItemsByFilePaths(planCompleteItems, maxFilePathGroups);
    // Map file-path group numbers to sequential group numbers after Other
    const uniqueGroups = [...new Set(planGroups.values())].sort((a, b) => a - b);
    const groupNumMap = new Map<number, number>();
    for (let i = 0; i < uniqueGroups.length; i++) {
      groupNumMap.set(uniqueGroups[i], nextGroup + i);
    }
    for (const [id, g] of planGroups) {
      const newGroupNum = groupNumMap.get(g)!;
      result.set(id, {
        group: newGroupNum,
        groupLabel: `Plan Complete Group ${newGroupNum}`,
      });
    }
    nextGroup += uniqueGroups.length;
  }

  // 3. In Review (excluding critical)
  const inReviewItems = items.filter(item => !criticalIds.has(item.id) && item.stage === 'in_review');
  if (inReviewItems.length > 0) {
    for (const item of inReviewItems) {
      result.set(item.id, { group: nextGroup, groupLabel: 'In Review' });
    }
    nextGroup++;
  }

  // 4. Intake Complete (excluding critical)
  const intakeCompleteItems = items.filter(item => !criticalIds.has(item.id) && item.stage === 'intake_complete');
  if (intakeCompleteItems.length > 0) {
    for (const item of intakeCompleteItems) {
      result.set(item.id, { group: nextGroup, groupLabel: 'Intake Complete' });
    }
    nextGroup++;
  }

  // 5. Idea (excluding critical)
  const ideaItems = items.filter(item => !criticalIds.has(item.id) && item.stage === 'idea');
  if (ideaItems.length > 0) {
    for (const item of ideaItems) {
      result.set(item.id, { group: nextGroup, groupLabel: 'Idea' });
    }
    nextGroup++;
  }

  return result;
}
