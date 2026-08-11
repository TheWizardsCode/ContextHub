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
export function groupItemsByFilePaths(items, maxGroups = 3) {
    const itemGroup = new Map();
    // Track the set of file paths assigned to each group
    // groupPaths[groupNumber] = Set of file paths
    const groupPaths = new Map();
    // Track which groups are "restricted" (contain unknown-path items)
    // Restricted groups cannot accept any other items.
    const restrictedGroups = new Set();
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
            if (!existingPaths)
                continue;
            // Skip restricted groups (unknown-path singletons)
            if (restrictedGroups.has(g))
                continue;
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
export function assignItemGroups(items, maxFilePathGroups = 3) {
    const result = new Map();
    let nextGroup = 1;
    // Remap file-path group numbers (from groupItemsByFilePaths, 1-indexed per slice)
    // to sequential display group numbers starting at `startGroup`.
    const remapToSequential = (fileGroups, startGroup) => {
        const unique = [...new Set(fileGroups.values())].sort((a, b) => a - b);
        const map = new Map();
        unique.forEach((g, i) => map.set(g, startGroup + i));
        return { map, count: unique.length };
    };
    // 0. Critical Group N — all critical items partitioned by file-path conflicts.
    //    Labels use a per-category counter (Critical Group 1, 2, ...) independent of
    //    the sequential ordering number.
    const criticalItems = items.filter(item => item.priority === 'critical');
    if (criticalItems.length > 0) {
        const criticalGroups = groupItemsByFilePaths(criticalItems, maxFilePathGroups);
        const { map: groupNumMap, count } = remapToSequential(criticalGroups, nextGroup);
        const categoryGroupNumbers = [...new Set(criticalGroups.values())].sort((a, b) => a - b);
        const labelNumByFileGroup = new Map();
        categoryGroupNumbers.forEach((g, i) => labelNumByFileGroup.set(g, i + 1));
        for (const [id, g] of criticalGroups) {
            const groupNum = groupNumMap.get(g);
            result.set(id, { group: groupNum, groupLabel: `Critical Group ${labelNumByFileGroup.get(g)}` });
        }
        nextGroup += count;
    }
    // 1. Group N — non-critical in_progress + plan_complete + intake_complete items
    //    partitioned by file-path conflicts (no stage prefix in the label).
    const groupNItems = items.filter(item => item.priority !== 'critical' &&
        (item.stage === 'in_progress' || item.stage === 'plan_complete' || item.stage === 'intake_complete'));
    if (groupNItems.length > 0) {
        const groupNGroups = groupItemsByFilePaths(groupNItems, maxFilePathGroups);
        const { map: groupNumMap, count } = remapToSequential(groupNGroups, nextGroup);
        const categoryGroupNumbers = [...new Set(groupNGroups.values())].sort((a, b) => a - b);
        const labelNumByFileGroup = new Map();
        categoryGroupNumbers.forEach((g, i) => labelNumByFileGroup.set(g, i + 1));
        for (const [id, g] of groupNGroups) {
            const groupNum = groupNumMap.get(g);
            result.set(id, { group: groupNum, groupLabel: `Group ${labelNumByFileGroup.get(g)}` });
        }
        nextGroup += count;
    }
    // 2. Idea — single group for all non-critical idea items.
    const ideaItems = items.filter(item => item.priority !== 'critical' && item.stage === 'idea');
    if (ideaItems.length > 0) {
        for (const item of ideaItems) {
            result.set(item.id, { group: nextGroup, groupLabel: 'Idea' });
        }
        nextGroup++;
    }
    // 3. Other — single group for all remaining non-critical items (unknown/other
    //    custom stages such as done, undefined, custom, ...). Safety net only.
    const otherItems = items.filter(item => item.priority !== 'critical' &&
        item.stage !== 'in_review' &&
        item.stage !== 'in_progress' &&
        item.stage !== 'plan_complete' &&
        item.stage !== 'intake_complete' &&
        item.stage !== 'idea');
    if (otherItems.length > 0) {
        for (const item of otherItems) {
            result.set(item.id, { group: nextGroup, groupLabel: 'Other' });
        }
        nextGroup++;
    }
    // 4. In Review — single group for all non-critical in_review items, placed last.
    const inReviewItems = items.filter(item => item.priority !== 'critical' && item.stage === 'in_review');
    if (inReviewItems.length > 0) {
        for (const item of inReviewItems) {
            result.set(item.id, { group: nextGroup, groupLabel: 'In Review' });
        }
        nextGroup++;
    }
    return result;
}
// ── Within-group ordering ────────────────────────────────────────────
/**
 * Stage sub-order within a group: in_progress first (actively being worked),
 * then plan_complete, then intake_complete, then all remaining stages.
 * No headings are rendered between sub-groups.
 */
const WITHIN_GROUP_STAGE_ORDER = {
    in_progress: 0,
    plan_complete: 1,
    intake_complete: 2,
};
// Any stage not listed above (including undefined/empty) → 3 (remaining).
const REMAINING_STAGE_ORDER = 3;
/**
 * Priority order for within-group sorting: high → medium → low.
 * Unknown priorities are treated as medium (matching helpers.ts conventions).
 */
const WITHIN_GROUP_PRIORITY_ORDER = {
    high: 0,
    medium: 1,
    low: 2,
};
const DEFAULT_PRIORITY_ORDER = WITHIN_GROUP_PRIORITY_ORDER.medium;
/**
 * Compare two items for within-group display order:
 * stage sub-sort (in_progress → plan_complete → intake_complete → remaining
 * stages), then priority (high → medium → low), then id as a deterministic
 * tie-break.
 */
export function compareGroupableItems(a, b) {
    const stageA = WITHIN_GROUP_STAGE_ORDER[a.stage ?? ''] ?? REMAINING_STAGE_ORDER;
    const stageB = WITHIN_GROUP_STAGE_ORDER[b.stage ?? ''] ?? REMAINING_STAGE_ORDER;
    if (stageA !== stageB)
        return stageA - stageB;
    const prioA = WITHIN_GROUP_PRIORITY_ORDER[a.priority ?? ''] ?? DEFAULT_PRIORITY_ORDER;
    const prioB = WITHIN_GROUP_PRIORITY_ORDER[b.priority ?? ''] ?? DEFAULT_PRIORITY_ORDER;
    if (prioA !== prioB)
        return prioA - prioB;
    return a.id.localeCompare(b.id);
}
/**
 * Compare two items for full display order: assigned group first (ascending
 * group number), then within-group order via `compareGroupableItems`.
 * Items without an assignment sort after all assigned items.
 */
export function compareGroupedItems(groupMap, a, b) {
    const ga = groupMap.get(a.id)?.group ?? Number.MAX_SAFE_INTEGER;
    const gb = groupMap.get(b.id)?.group ?? Number.MAX_SAFE_INTEGER;
    if (ga !== gb)
        return ga - gb;
    return compareGroupableItems(a, b);
}
//# sourceMappingURL=grouping.js.map