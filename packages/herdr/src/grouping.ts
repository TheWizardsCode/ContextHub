import { isAuditFresh } from '@worklog/shared/icons';

/**
 * packages/herdr/src/grouping.ts — Grouping for the Herdr worklist
 *
 * Pure, dependency-free duplication of the core `wl next --groups` grouping
 * algorithm (src/commands/grouping.ts) for the Herdr plugin, which has zero
 * npm dependencies and cannot import from src/commands/.
 *
 * The functions here are intentionally duplicated per plugin (decision Q2c in
 * WL-0MS8W5LTW006YZ4B): this plugin copy and the core `wl next` implementation
 * must be kept in sync. (A third copy in the Pi TUI Worklog extension,
 * packages/tui/extensions/Worklog/lib/grouping.ts, was removed by
 * WL-0MSGI7PV9004UD0N.)
 *
 * Why regrouping is needed: the worklist merges `wl next` results (which
 * carry `group`/`groupLabel` assignments) with mandatory subsets fetched via
 * `wl list` (critical + completed/in_review items, which carry NO group
 * metadata). `selectWorkItems` then reorders the merged list, breaking group
 * adjacency. `regroupWorkItems` recomputes group assignments for the final
 * selected set so every displayed item gets a correct group and no duplicate
 * section headings render (WL-0MSAK8YLB0025EGW).
 */

// ── File path extraction ──────────────────────────────────────────────

/**
 * Extract file paths from a work item description.
 *
 * Looks for a "Key Files" / "Key Files:" section (case-insensitive, with or
 * without bold markers or a trailing colon) and extracts path-like strings
 * from subsequent bullet list items. Mirrors `extractFilePaths` in
 * src/commands/helpers.ts; see docs/FILE_PATH_CONVENTION.md.
 */
export function extractFilePaths(description: string): string[] {
  if (!description || description.trim().length === 0) {
    return [];
  }

  const paths: string[] = [];

  // Match the "Key Files:" header (case-insensitive, optional bold markers).
  const keyFilesRegex = /^#{0,3}\s*\*{0,2}key files:?\*{0,2}\s*$/im;
  const match = description.match(keyFilesRegex);

  if (!match) {
    return [];
  }

  const headerIndex = match.index!;
  const afterHeader = description.slice(headerIndex + match[0].length);

  const lines = afterHeader.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // Stop if we hit another Markdown heading.
    if (/^#{1,3}\s/.test(trimmed)) {
      break;
    }

    // Stop if we hit another bold section header (e.g., **Some Section:**).
    if (/^\*{1,2}\w.*:\*{0,2}\s*$/.test(trimmed) && !/^[-*]\s/.test(trimmed)) {
      break;
    }

    // Stop if we hit another "Key Files:" header (case-insensitive).
    if (/\*{0,2}key files:?\*{0,2}\s*$/i.test(trimmed) && !/^[-*]\s/.test(trimmed)) {
      break;
    }

    // Match bullet items: `- ` or `* ` prefix, backtick-wrapped path first.
    let pathCandidate: string | null = null;
    const backtickMatch = trimmed.match(/^[-*]\s+`([^`]+)`/);
    if (backtickMatch) {
      pathCandidate = backtickMatch[1].trim();
    } else {
      const plainMatch = trimmed.match(/^[-*]\s+([^\s]+)/);
      if (plainMatch) {
        pathCandidate = plainMatch[1].trim();
      }
    }

    if (!pathCandidate) continue;

    if (isFilePath(pathCandidate)) {
      paths.push(pathCandidate);
    }
  }

  return paths;
}

/**
 * Check if a string looks like a valid file path (contains `/` and ends with
 * a file extension; rejects URLs).
 */
function isFilePath(candidate: string): boolean {
  if (/^https?:\/\//i.test(candidate)) return false;
  if (!candidate.includes('/')) return false;
  const extMatch = candidate.match(/\.([a-zA-Z0-9]+)$/);
  if (!extMatch) return false;
  return extMatch[1].length >= 1;
}

// ── Grouping types ────────────────────────────────────────────────────

/**
 * Input item for grouping — must have an `id`, `stage`, and a list of
 * `filePaths`.
 *
 * Optional audit fields are used for the 6-bucket sort when
 * `stage === 'in_review'`.
 */
export interface GroupableItem {
  id: string;
  stage?: string;
  /** Lifecycle status (`wl` status vocabulary). Used to detect actively-worked
   * items (`status === 'in-progress'`), which replaced the removed
   * `in_progress` stage (WL-0MUY1CSQG007TCYX). */
  status?: string;
  filePaths: string[];
  priority?: string;
  /**
   * Current assignee (empty/absent = unassigned). A non-empty assignee is a
   * scheduling hold — the producer-hold convention that replaced the removed
   * producer-review flag (WL-0MV85WGIT004PHRC). Held in_review items
   * rank first in the review queue so the pause state stays observable.
   */
  assignee?: string;
  // Optional audit fields — used for in_review bucket sort
  auditResult?: boolean | null;
  auditedAt?: string | null;
  updatedAt?: string | null;
  /** Stored content fingerprint from the audit result (WL-0MUBVH5S0008NQ9K). */
  fingerprint?: string | null;
  /** Current content fingerprint for the item, when the caller can compute it. */
  currentFingerprint?: string | null;
}

/**
 * Result of assigning an item to a group.
 * `group` is a 1-indexed integer for ordering.
 * `groupLabel` is a human-readable label for display.
 */
export interface GroupAssignment {
  group: number;
  groupLabel: string;
}

// ── Grouping algorithm ────────────────────────────────────────────────

/**
 * Greedy first-fit grouping algorithm for file-path-based conflict detection.
 *
 * Assigns each item to the first group (1-indexed) that contains no item
 * sharing any file path with it. Items with empty file paths (unknown) are
 * each placed in their own singleton "restricted" group.
 *
 * Mirrors `groupItemsByFilePaths` in src/commands/grouping.ts.
 */
export function groupItemsByFilePaths(
  items: GroupableItem[],
  maxGroups: number = 3,
): Map<string, number> {
  const itemGroup = new Map<string, number>();
  const groupPaths = new Map<number, Set<string>>();
  const restrictedGroups = new Set<number>();
  let nextGroup = 1;

  for (const item of items) {
    const { id, filePaths } = item;

    // Items with unknown file paths → singleton restricted group.
    if (filePaths.length === 0) {
      itemGroup.set(id, nextGroup);
      groupPaths.set(nextGroup, new Set());
      restrictedGroups.add(nextGroup);
      nextGroup++;
      continue;
    }

    // Try to find an existing group this item fits in.
    let assigned = false;
    const groupsToCheck = Math.min(maxGroups, nextGroup - 1);
    for (let g = 1; g <= groupsToCheck; g++) {
      const existingPaths = groupPaths.get(g);
      if (!existingPaths) continue;

      if (restrictedGroups.has(g)) continue;

      const hasConflict = filePaths.some(fp => existingPaths.has(fp));
      if (!hasConflict) {
        for (const fp of filePaths) {
          existingPaths.add(fp);
        }
        itemGroup.set(id, g);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
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
 * Group display order (most actionable first):
 * - **Critical Group N** — critical items partitioned by file-path conflicts
 *   (per-category label counter, no single all-inclusive "Critical" group).
 * - **Group N** — non-critical actively-worked (`status === 'in-progress'`)
 *   + `plan_complete` + `intake_complete` items partitioned by file-path
 *   conflicts (no stage prefix in the label).
 * - **Idea** — single group for all `idea` items.
 * - **Other** — single group for all remaining non-critical items (safety net
 *   for unknown/custom stages, `done`, etc.).
 * - **In Review** — single group for all `in_review` items, placed last.
 *
 * Mirrors `assignItemGroups` in src/commands/grouping.ts.
 */
export function assignItemGroups(
  items: GroupableItem[],
  maxFilePathGroups: number = 3,
): Map<string, GroupAssignment> {
  const result = new Map<string, GroupAssignment>();

  let nextGroup = 1;

  // Remap file-path group numbers to sequential display group numbers
  // starting at `startGroup`; returns the mapping and the count consumed.
  const remapToSequential = (
    fileGroups: Map<string, number>,
    startGroup: number,
  ): { map: Map<number, number>; count: number } => {
    const unique = [...new Set(fileGroups.values())].sort((a, b) => a - b);
    const map = new Map<number, number>();
    unique.forEach((g, i) => map.set(g, startGroup + i));
    return { map, count: unique.length };
  };

  // 0. Critical Group N.
  const criticalItems = items.filter(item => item.priority === 'critical');
  if (criticalItems.length > 0) {
    const criticalGroups = groupItemsByFilePaths(criticalItems, maxFilePathGroups);
    const { map: groupNumMap, count } = remapToSequential(criticalGroups, nextGroup);
    const labelNumByFileGroup = buildLabelCounter(criticalGroups);
    for (const [id, g] of criticalGroups) {
      const groupNum = groupNumMap.get(g)!;
      result.set(id, { group: groupNum, groupLabel: `Critical Group ${labelNumByFileGroup.get(g)}` });
    }
    nextGroup += count;
  }

  // 1. Group N (actively worked + plan_complete + intake_complete).
  // `in_progress` is no longer a CLI stage; "actively worked" is derived from
  // `status === 'in-progress'` (WL-0MUY1CSQG007TCYX).
  const groupNItems = items.filter(
    item =>
      item.priority !== 'critical' &&
      (item.status === 'in-progress' || item.stage === 'plan_complete' || item.stage === 'intake_complete'),
  );
  if (groupNItems.length > 0) {
    const groupNGroups = groupItemsByFilePaths(groupNItems, maxFilePathGroups);
    const { map: groupNumMap, count } = remapToSequential(groupNGroups, nextGroup);
    const labelNumByFileGroup = buildLabelCounter(groupNGroups);
    for (const [id, g] of groupNGroups) {
      const groupNum = groupNumMap.get(g)!;
      result.set(id, { group: groupNum, groupLabel: `Group ${labelNumByFileGroup.get(g)}` });
    }
    nextGroup += count;
  }

  // 2. Idea.
  const ideaItems = items.filter(item => item.priority !== 'critical' && item.stage === 'idea');
  if (ideaItems.length > 0) {
    for (const item of ideaItems) {
      result.set(item.id, { group: nextGroup, groupLabel: 'Idea' });
    }
    nextGroup++;
  }

  // 3. Other.
  // Safety net for remaining non-critical items (unknown/legacy stages such
  // as the removed `in_progress`, `done`, etc.). Excludes actively-worked
  // items because they belong to Group N via `status === 'in-progress'`.
  const otherItems = items.filter(
    item =>
      item.priority !== 'critical' &&
      item.status !== 'in-progress' &&
      item.stage !== 'in_review' &&
      item.stage !== 'plan_complete' &&
      item.stage !== 'intake_complete' &&
      item.stage !== 'idea',
  );
  if (otherItems.length > 0) {
    for (const item of otherItems) {
      result.set(item.id, { group: nextGroup, groupLabel: 'Other' });
    }
    nextGroup++;
  }

  // 4. In Review (last).
  const inReviewItems = items.filter(item => item.priority !== 'critical' && item.stage === 'in_review');
  if (inReviewItems.length > 0) {
    for (const item of inReviewItems) {
      result.set(item.id, { group: nextGroup, groupLabel: 'In Review' });
    }
    nextGroup++;
  }

  return result;
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

// ── Within-group ordering ─────────────────────────────────────────────

/**
 * Stage sub-order within a group: actively-worked items first
 * (derived from `status === 'in-progress'`), then plan_complete, then
 * intake_complete, then all remaining stages.
 * No headings are rendered between sub-groups.
 */
const WITHIN_GROUP_STAGE_ORDER: Record<string, number> = {
  plan_complete: 1,
  intake_complete: 2,
};
const REMAINING_STAGE_ORDER = 3;

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

/**
 * Priority order for within-group sorting: high → medium → low.
 * Unknown priorities are treated as medium.
 */
const WITHIN_GROUP_PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
const DEFAULT_PRIORITY_ORDER = WITHIN_GROUP_PRIORITY_ORDER.medium;

/**
 * The 6-bucket predicate for in_review items.  Lower number = higher
 * display priority (displayed first).
 *
 * | Bucket | Meaning                                        |
 * |--------|------------------------------------------------ |
 * | 1      | held by a non-empty assignee (producer hold)    |
 * | 2      | failed audit, fresh                             |
 * | 3      | failed audit, stale                             |
 * | 4      | no audit                                        |
 * | 5      | passed audit, stale                             |
 * | 6      | passed audit, fresh                             |
 *
 * Bucket 1 is the assignee hold that replaced the removed producer-review
 * flag (WL-0MV85WGIT004PHRC). The remaining five
 * buckets mirror `src/commands/grouping.ts` (ACL2).
 */
export function inReviewBucket(item: {
  stage?: string;
  assignee?: string;
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

  // Bucket 1: held by a non-empty assignee (producer hold).
  if (typeof item.assignee === 'string' && item.assignee.trim() !== '') return 1;

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
  assignee?: string;
  auditResult?: boolean | null;
  auditedAt?: string | null;
  updatedAt?: string | null;
  fingerprint?: string | null;
  currentFingerprint?: string | null;
}, b: typeof a): number {
  if (a.stage !== 'in_review' || b.stage !== 'in_review') return 0;

  // Primary: priority (high → medium → low).
  const prioA = WITHIN_GROUP_PRIORITY_ORDER[a.priority ?? ''] ?? DEFAULT_PRIORITY_ORDER;
  const prioB = WITHIN_GROUP_PRIORITY_ORDER[b.priority ?? ''] ?? DEFAULT_PRIORITY_ORDER;
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
 * Compare two items for within-group display order:
 * stage sub-sort (actively worked → plan_complete → intake_complete →
 * remaining stages), then priority (high → medium → low), then id as a
 * deterministic tie-break.
 *
 * When BOTH items have stage === 'in_review', `compareInReviewItems`
 * orders them by priority (high → medium → low) and then by the 6-bucket
 * audit predicate (WL-0MSLPM5ZB003TADT, refined by WL-0MUWDW0N6003KF6G so a
 * medium-priority item can never rank ahead of a high-priority one).  This
 * takes precedence over the default stage sub-sort: all in_review items map
 * to the same stage-sub-order value (REMAINING_STAGE_ORDER) anyway.
 *
 * If the in_review comparator returns 0 (same priority, same bucket, same
 * timestamp, same id), falls through to stage/priority/id tie-break.
 */
export function compareGroupableItems(a: GroupableItem, b: GroupableItem): number {
  // Fast-path: if both are in_review, use the in_review ordering
  if (a.stage === 'in_review' && b.stage === 'in_review') {
    const bucketCmp = compareInReviewItems(a, b);
    if (bucketCmp !== 0) return bucketCmp;
  }

  const stageA = withinGroupStageOrder(a);
  const stageB = withinGroupStageOrder(b);
  if (stageA !== stageB) return stageA - stageB;
  const prioA = WITHIN_GROUP_PRIORITY_ORDER[a.priority ?? ''] ?? DEFAULT_PRIORITY_ORDER;
  const prioB = WITHIN_GROUP_PRIORITY_ORDER[b.priority ?? ''] ?? DEFAULT_PRIORITY_ORDER;
  if (prioA !== prioB) return prioA - prioB;
  return a.id.localeCompare(b.id);
}

// ── Regrouping the merged/selected list ───────────────────────────────

/**
 * Regroup and order a set of selected work items (e.g. the output of
 * selectWorkItems) so that every item receives a `group`/`groupLabel`
 * (mandatory wl list items included) and the list renders in the canonical
 * group order with no duplicate section headings.
 *
 * Does not filter or drop items — the always-show-mandatory guarantee of
 * selectWorkItems is preserved. Items are only reordered and stamped.
 */
export function regroupWorkItems<T extends {
  id: string;
  stage?: string;
  /** Lifecycle status — drives actively-worked Group N membership/ordering. */
  status?: string;
  priority?: string;
  description?: string;
  group?: number;
  groupLabel?: string;
  // Optional audit fields — used for in_review bucket sort
  assignee?: string;
  auditResult?: boolean | null;
  auditedAt?: string | null;
  updatedAt?: string | null;
  /** Stored content fingerprint from the audit result (WL-0MUBVH5S0008NQ9K). */
  fingerprint?: string | null;
  /** Current content fingerprint for the item, when the caller can compute it. */
  currentFingerprint?: string | null;
}>(
  items: T[],
  maxFilePathGroups: number = 3,
): T[] {
  const groupable = items.map(item => ({
    id: item.id,
    stage: item.stage,
    status: item.status,
    priority: item.priority,
    filePaths: extractFilePaths(item.description ?? ''),
    assignee: item.assignee,
    auditResult: item.auditResult,
    auditedAt: item.auditedAt,
    updatedAt: item.updatedAt,
    fingerprint: item.fingerprint,
    currentFingerprint: item.currentFingerprint,
  }));
  const groupMap = assignItemGroups(groupable, maxFilePathGroups);

  const sorted = items.slice().sort((a, b) => {
    const ga = groupMap.get(a.id)?.group ?? Number.MAX_SAFE_INTEGER;
    const gb = groupMap.get(b.id)?.group ?? Number.MAX_SAFE_INTEGER;
    if (ga !== gb) return ga - gb;
    return compareGroupableItems(
      { id: a.id, stage: a.stage, status: a.status, priority: a.priority, filePaths: [],
        assignee: a.assignee,
        auditResult: a.auditResult,
        auditedAt: a.auditedAt,
        updatedAt: a.updatedAt,
        fingerprint: a.fingerprint,
        currentFingerprint: a.currentFingerprint,
      },
      { id: b.id, stage: b.stage, status: b.status, priority: b.priority, filePaths: [],
        assignee: b.assignee,
        auditResult: b.auditResult,
        auditedAt: b.auditedAt,
        updatedAt: b.updatedAt,
        fingerprint: b.fingerprint,
        currentFingerprint: b.currentFingerprint,
      },
    );
  });

  return sorted.map(item => {
    const assignment = groupMap.get(item.id);
    if (!assignment) return item;
    return {
      ...item,
      group: assignment.group,
      groupLabel: assignment.groupLabel,
    };
  });
}
