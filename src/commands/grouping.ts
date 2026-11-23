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
 *
 * Band-first grouping (WL-0MWMQ6AV6007ZUNK): sections are bucketed by
 * **priority band first** — `critical` → `high` → `medium` → `low` →
 * `In Review` — so a `high@idea` item can never render below a
 * `medium@plan_complete` item. Stage is used only as the intra-band sub-order
 * (`in-progress` → `plan_complete` → `intake_complete` → `idea` → other) and
 * as the sub-section scheme inside a band (`<Band> Group N`, `<Band> Idea`,
 * `<Band> Other`). File-path conflict grouping and its label counter apply
 * per band, restarting at 1.
 *
 * Mirror relationship: `packages/herdr/src/grouping.ts` is a deliberate,
 * dependency-free duplicate of this module (the plugin cannot import from
 * src/commands/). The two copies must stay in sync; `tests/grouping-parity.test.ts`
 * is the consistency gate that asserts both `assignItemGroups` implementations
 * produce identical `{ group, groupLabel }` maps for a shared fixture.
 */

import { extractFilePaths, type GroupableItem, type GroupAssignment } from './helpers.js';
import { isAuditFresh } from '@worklog/shared/icons';

// ── Content-derived ordering keys ─────────────────────────────────────

/**
 * Stage sub-order within a band: actively-worked items first, then
 * plan_complete, then intake_complete, then idea, then all remaining stages.
 * No headings are rendered between sub-groups.
 */
const WITHIN_GROUP_STAGE_ORDER: Record<string, number> = {
  plan_complete: 1,
  intake_complete: 2,
  idea: 3,
};
// Any stage not listed above (including undefined/empty) → 4 (remaining).
const REMAINING_STAGE_ORDER = 4;

/**
 * Priority order for within-group sorting: high → medium → low.
 * Unknown priorities are treated as medium (matching helpers.ts conventions).
 */
const WITHIN_GROUP_PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
const DEFAULT_PRIORITY_ORDER = WITHIN_GROUP_PRIORITY_ORDER.medium;

/**
 * Within-group sub-order for an item. Actively-worked items
 * (`status === 'in-progress'`) sort before every stage sub-group; the
 * `in_progress` stage no longer exists in the CLI vocabulary
 * (WL-0MUY1CSQG007TCYX). All other items fall back to the stage sub-order.
 */
function withinGroupStageOrder(item: GroupableItem): number {
  if (item.status === 'in-progress') return 0;
  return WITHIN_GROUP_STAGE_ORDER[item.stage ?? ''] ?? REMAINING_STAGE_ORDER;
}

/** Numeric priority order for a single item (see `WITHIN_GROUP_PRIORITY_ORDER`). */
function priorityOrder(priority: string | undefined): number {
  return WITHIN_GROUP_PRIORITY_ORDER[priority ?? ''] ?? DEFAULT_PRIORITY_ORDER;
}

/**
 * Compare two grouping inputs by their **content-derived key**: priority
 * (high → medium → low), then stage sub-order, then id.
 *
 * This key is a pure function of item content, so it is the canonical
 * pre-pack order that makes group membership independent of the order in
 * which items arrive (WL-0MVVLBTTP003Y4XO). It deliberately excludes
 * `updatedAt` and the audit fields: a comment or an audit run must never move
 * an item from one group to another.
 */
export function compareGroupingContentKey(a: GroupableItem, b: GroupableItem): number {
  const prioA = priorityOrder(a.priority);
  const prioB = priorityOrder(b.priority);
  if (prioA !== prioB) return prioA - prioB;
  const stageA = withinGroupStageOrder(a);
  const stageB = withinGroupStageOrder(b);
  if (stageA !== stageB) return stageA - stageB;
  return a.id.localeCompare(b.id);
}

/**
 * Canonicalise the input order before greedy first-fit packing.
 *
 * Sorting by {@link compareGroupingContentKey} first makes
 * `groupItemsByFilePaths` a pure function of the item *set*: the same items
 * always pack into the same groups, no matter how they were ordered on the
 * way in (the worklist's input order fluctuates with `updatedAt` churn).
 * Greedy first-fit itself is unchanged.
 */
function canonicalizeForGrouping(items: GroupableItem[]): GroupableItem[] {
  return items.slice().sort(compareGroupingContentKey);
}

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
 * The input is **canonicalised first** (priority → stage sub-order → id, never
 * a timestamp — see {@link compareGroupingContentKey}), so the packing result
 * depends only on the item set and its content, never on the order the items
 * were presented in (WL-0MVVLBTTP003Y4XO).
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

  // Canonical, content-derived input order — group membership must not depend
  // on the (fluctuating) order items arrive in.
  for (const item of canonicalizeForGrouping(items)) {
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
 * Assign items to groups based on priority band first, then stage and
 * file-path conflicts.
 *
 * Sections are bucketed by **priority band first** — a `high` item can never
 * render below a `medium` item, whatever their stages. Group display order
 * (most actionable first):
 *
 * - **Critical Group N** — every critical item partitioned by file-path
 *   conflicts (per-category label counter, no Idea/Other split).
 * - **High / Medium / Low** bands, each in turn:
 *   - **<Band> Group N** — the band's actively-worked
 *     (`status === 'in-progress'`) + `plan_complete` + `intake_complete`
 *     items partitioned by file-path conflicts (label counter restarts at 1
 *     per band-section).
 *   - **<Band> Idea** — single group for the band's `idea` items.
 *   - **<Band> Other** — single group for the band's remaining items (safety
 *     net for unknown/custom stages, `done`, etc.).
 * - **In Review** — single global group for all `in_review` items, placed
 *   last regardless of the priority of its members.
 *
 * Input order is canonicalised inside `groupItemsByFilePaths`
 * (priority → stage sub-order → id), so group assignment is a
 * content-deterministic function of the item set (WL-0MVVLBTTP003Y4XO).
 *
 * Within-group ordering (priority high → medium → low, then stage sub-sort
 * actively-worked → `plan_complete` → `intake_complete` → `idea` → remaining
 * stages, then id) is applied by callers via `compareGroupableItems` /
 * `compareGroupedItems`.
 *
 * Mirrors `assignItemGroups` in packages/herdr/src/grouping.ts.
 *
 * @param items - Array of items with id, priority, stage, status, and extracted file paths
 * @param maxFilePathGroups - Maximum number of file-path-based groups (default 3)
 * @returns Map of item id → GroupAssignment
 */
export function assignItemGroups(
  items: GroupableItem[],
  maxFilePathGroups: number = 3,
): Map<string, GroupAssignment> {
  const result = new Map<string, GroupAssignment>();

  let nextGroup = 1;

  // Remap file-path group numbers (from groupItemsByFilePaths, 1-indexed per slice)
  // to sequential display group numbers starting at `startGroup`; returns the
  // mapping and the count consumed.
  const remapToSequential = (
    fileGroups: Map<string, number>,
    startGroup: number,
  ): { map: Map<number, number>; count: number } => {
    const unique = [...new Set(fileGroups.values())].sort((a, b) => a - b);
    const map = new Map<number, number>();
    unique.forEach((g, i) => map.set(g, startGroup + i));
    return { map, count: unique.length };
  };

  // Band-first bucketing (WL-0MWMQ6AV6007ZUNK): priority band is the primary
  // section key; stage only sub-divides inside a band. In Review is a single
  // global section pinned last, whatever the priority of its members.
  const inReviewItems = items.filter(item => item.stage === 'in_review');
  const bandCandidates = items.filter(item => item.stage !== 'in_review');

  for (const band of PRIORITY_BANDS) {
    const bandItems = bandCandidates.filter(item => bandForPriority(item.priority) === band);
    if (bandItems.length === 0) continue;
    const bandLabel = BAND_LABELS[band];

    if (band === 'critical') {
      // Critical keeps today's file-path partitioning: every critical item is
      // packed into `Critical Group N` by Key-File conflicts (per-category
      // label counter), not split into Idea/Other sub-sections.
      const criticalGroups = groupItemsByFilePaths(bandItems, maxFilePathGroups);
      const { map: groupNumMap, count } = remapToSequential(criticalGroups, nextGroup);
      const labelNumByFileGroup = buildLabelCounter(criticalGroups);
      for (const [id, g] of criticalGroups) {
        const groupNum = groupNumMap.get(g)!;
        result.set(id, { group: groupNum, groupLabel: `${bandLabel} Group ${labelNumByFileGroup.get(g)}` });
      }
      nextGroup += count;
      continue;
    }

    // Non-critical band: `<Band> Group N` — actively-worked + plan_complete +
    // intake_complete items partitioned by file-path conflicts, with the
    // label counter restarting at 1 for each band-section.
    const groupNItems = bandItems.filter(isActivelyWorkedOrPlanned);
    if (groupNItems.length > 0) {
      const groupNGroups = groupItemsByFilePaths(groupNItems, maxFilePathGroups);
      const { map: groupNumMap, count } = remapToSequential(groupNGroups, nextGroup);
      const labelNumByFileGroup = buildLabelCounter(groupNGroups);
      for (const [id, g] of groupNGroups) {
        const groupNum = groupNumMap.get(g)!;
        result.set(id, { group: groupNum, groupLabel: `${bandLabel} Group ${labelNumByFileGroup.get(g)}` });
      }
      nextGroup += count;
    }

    // `<Band> Idea` — a single group for the band's `idea` items.
    const ideaItems = bandItems.filter(item => item.stage === 'idea');
    if (ideaItems.length > 0) {
      for (const item of ideaItems) {
        result.set(item.id, { group: nextGroup, groupLabel: `${bandLabel} Idea` });
      }
      nextGroup++;
    }

    // `<Band> Other` — safety net for the band's remaining items (unknown or
    // legacy stages such as the removed `in_progress`, `done`, etc.).
    const otherItems = bandItems.filter(item => !isActivelyWorkedOrPlanned(item) && item.stage !== 'idea');
    if (otherItems.length > 0) {
      for (const item of otherItems) {
        result.set(item.id, { group: nextGroup, groupLabel: `${bandLabel} Other` });
      }
      nextGroup++;
    }
  }

  // In Review (last, single global section).
  if (inReviewItems.length > 0) {
    for (const item of inReviewItems) {
      result.set(item.id, { group: nextGroup, groupLabel: 'In Review' });
    }
    nextGroup++;
  }

  return result;
}

/** Priority bands in display order (most urgent first). */
const PRIORITY_BANDS = ['critical', 'high', 'medium', 'low'] as const;
type PriorityBand = (typeof PRIORITY_BANDS)[number];

/** Display label prefix for each priority band's sections. */
const BAND_LABELS: Record<PriorityBand, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Resolve an item's priority band. Unknown/missing priorities fall back to
 * `medium`, matching {@link priorityOrder} (and the old non-critical bucket).
 */
function bandForPriority(priority: string | undefined): PriorityBand {
  return priority === 'critical' || priority === 'high' || priority === 'medium' || priority === 'low'
    ? priority
    : 'medium';
}

/**
 * Whether an item belongs to its band's `<Band> Group N` sub-section:
 * actively-worked items (`status === 'in-progress'`) plus `plan_complete`
 * and `intake_complete`. `in_progress` is no longer a CLI stage; "actively
 * worked" is derived from `status` (WL-0MUY1CSQG007TCYX).
 */
function isActivelyWorkedOrPlanned(item: GroupableItem): boolean {
  return item.status === 'in-progress' || item.stage === 'plan_complete' || item.stage === 'intake_complete';
}

/**
 * Build a per-category label counter mapping file-path group numbers (from
 * groupItemsByFilePaths) to sequential category labels (1, 2, ...).
 */
function buildLabelCounter(fileGroups: Map<string, number>): Map<number, number> {
  const unique = [...new Set(fileGroups.values())].sort((a, b) => a - b);
  const map = new Map<number, number>();
  unique.forEach((g, i) => map.set(g, i + 1));
  return map;
}

// ── Within-group ordering ────────────────────────────────────────────

/**
 * The 6-bucket predicate for in_review items.  Lower number = higher
 * display priority (displayed first).
 *
 * | Bucket | Meaning                                        |
 * |--------|------------------------------------------------ |
 * | 1      | needsProducerReview                             |
 * | 2      | failed audit, fresh                             |
 * | 3      | failed audit, stale                             |
 * | 4      | no audit                                        |
 * | 5      | passed audit, stale                             |
 * | 6      | passed audit, fresh                             |
 *
 * This mirrors the predicate in packages/herdr/src/grouping.ts (ACL2).
 */
export function inReviewBucket(item: {
  stage?: string;
  needsProducerReview?: boolean;
  auditResult?: boolean | null;
  auditedAt?: string | null;
  updatedAt?: string | null;
  /** Stored content fingerprint from the audit result (optional). */
  fingerprint?: string | null;
  /** Current content fingerprint for the item, when the caller can compute it. */
  currentFingerprint?: string | null;
}): number {
  // Sentinel — only valid when stage === 'in_review'
  if (item.stage !== 'in_review') return 0;

  // Bucket 1: producer review pending
  if (item.needsProducerReview) return 1;

  // Bucket 4: no audit yet (null/undefined auditResult or missing auditedAt)
  // Per AC4 stale buckets require auditedAt present; absence is the no-audit bucket.
  if (item.auditResult === null || item.auditResult === undefined || !item.auditedAt) return 4;

  // Determine freshness via the shared predicate (isAuditFresh/AUDIT_FRESHNESS_AT_NEAR_TOLERANCE_MS)
  const fresh = Boolean(
    item.auditedAt && item.updatedAt && isAuditFresh(item.auditedAt, item.updatedAt, item.fingerprint, item.currentFingerprint),
  );

  if (item.auditResult === false) {
    // Failed audit — fresh items are more urgent (need attention)
    return fresh ? 2 : 3;
  }
  // Passed audit — fresh items are least urgent (already cleared)
  return fresh ? 6 : 5;
}

/**
 * Compare two in_review items.
 *
 * Primary sort: priority (high → medium → low).  The review queue must
 * surface the most important work first: a medium-priority failed-audit item
 * must never rank ahead of a high-priority item (WL-0MUWDW0N6003KF6G).
 * Secondary: audit bucket number (ascending — lower bucket = higher priority).
 * Tertiary: updatedAt (older items first).
 * Quaternary: id (deterministic tie-break).
 *
 * The 6-bucket predicate is applied consistently *within* each priority band
 * rather than as the global primary key.
 *
 * Returns 0 when either item lacks stage === 'in_review', letting the
 * caller fall back to the standard comparator.
 */
export function compareInReviewItems(a: GroupableItem & {
  needsProducerReview?: boolean;
  auditResult?: boolean | null;
  auditedAt?: string | null;
  updatedAt?: string | null;
  fingerprint?: string | null;
  currentFingerprint?: string | null;
}, b: typeof a): number {
  if (a.stage !== 'in_review' || b.stage !== 'in_review') return 0;

  // Primary: priority (high → medium → low).
  const prioA = priorityOrder(a.priority);
  const prioB = priorityOrder(b.priority);
  if (prioA !== prioB) return prioA - prioB;

  // Secondary: audit bucket (within the same priority band).
  const bucketDiff = inReviewBucket(a) - inReviewBucket(b);
  if (bucketDiff !== 0) return bucketDiff;

  // Tertiary: updatedAt (older items first)
  const tsA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
  const tsB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
  if (tsA !== tsB) return tsA - tsB;

  // Deterministic tie-break
  return a.id.localeCompare(b.id);
}

/**
 * Compare two items for within-group display order: **priority first**
 * (high → medium → low — so every high item ranks ahead of every medium item,
 * which ranks ahead of every low item), then stage sub-sort (actively worked →
 * `plan_complete` → `intake_complete` → `idea` → remaining stages), then id as
 * a deterministic tie-break.
 *
 * Priority became the primary key in WL-0MVVLBTTP003Y4XO (the stage sub-order
 * was primary before): the review queue precedent that a lower-priority item
 * must never rank ahead of a higher-priority one (WL-0MUWDW0N6003KF6G) now
 * holds for every group, not only for `in_review`. The actively-worked sub-order
 * (`status === 'in-progress'`) is therefore a **secondary** key — an
 * actively-worked low-priority item no longer outranks a high-priority
 * plan_complete item.
 *
 * When BOTH items have stage === 'in_review', `compareInReviewItems`
 * orders them by priority (high → medium → low), then by the 6-bucket
 * audit predicate (WL-0MSLPM5ZB003TADT) and then by `updatedAt`.  This takes
 * precedence over the default stage sub-sort: all in_review items map to the
 * same stage-sub-order value (REMAINING_STAGE_ORDER) anyway.
 *
 * If the in_review comparator returns 0 (same priority, same bucket, same
 * timestamp, same id), falls through to the priority/stage/id tie-break.
 */
export function compareGroupableItems(a: GroupableItem, b: GroupableItem): number {
  // Fast-path: if both are in_review, use the in_review ordering
  if (a.stage === 'in_review' && b.stage === 'in_review') {
    const bucketCmp = compareInReviewItems(a, b);
    if (bucketCmp !== 0) return bucketCmp;
  }

  // Primary: priority (high → medium → low).
  const prioA = priorityOrder(a.priority);
  const prioB = priorityOrder(b.priority);
  if (prioA !== prioB) return prioA - prioB;
  // Secondary: stage sub-order.
  const stageA = withinGroupStageOrder(a);
  const stageB = withinGroupStageOrder(b);
  if (stageA !== stageB) return stageA - stageB;
  return a.id.localeCompare(b.id);
}

/**
 * Compare two items for full display order: assigned group first (ascending
 * group number), then within-group order via `compareGroupableItems`.
 * Items without an assignment sort after all assigned items.
 */
export function compareGroupedItems(
  groupMap: Map<string, GroupAssignment>,
  a: GroupableItem,
  b: GroupableItem,
): number {
  const ga = groupMap.get(a.id)?.group ?? Number.MAX_SAFE_INTEGER;
  const gb = groupMap.get(b.id)?.group ?? Number.MAX_SAFE_INTEGER;
  if (ga !== gb) return ga - gb;
  return compareGroupableItems(a, b);
}
