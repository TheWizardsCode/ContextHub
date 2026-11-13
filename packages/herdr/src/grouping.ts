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
 *
 * Stability (WL-0MVVLBTTP003Y4XO): group assignment is a pure function of the
 * item *content*. The input order is canonicalised (priority → stage sub-order
 * → id, never a timestamp) before greedy first-fit packing, so a comment, an
 * audit run or any other `updatedAt` churn can never move an item between
 * groups; only a material change (key files, priority, stage/status, or the
 * item set itself) can.
 *
 * Blocker pinning (WL-0MW7YJYS5009H7WC) — DEFAULT VIEW ONLY: the optional
 * pin map passed to `regroupWorkItems` overrides a pinned blocker's group to
 * the blocked item's group (same label, immediately after it; first/lowest
 * group wins for multi-block). This is a DELIBERATE exception to the
 * file-path conflict invariant for the blocker/blocked pair only (AC12): a
 * blocked row must be followed by the work that unblocks it, even though the
 * two items' key files never justify sharing a group. The override applies
 * exclusively to ids present in the pin map, so every other item keeps the
 * content-derived grouping and an empty pin map is byte-identical to today
 * (AC5). Stage-filtered views (`fetchItemsByStage`/`fetchItemsByPriority`)
 * pass no pin map and do not synthesise dependency rows.
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
  // Optional audit fields — used for in_review bucket sort
  needsProducerReview?: boolean;
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

// ── Content-derived ordering keys ─────────────────────────────────────

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
 * sharing any file path with it. Items with empty file paths (unknown) are
 * each placed in their own singleton "restricted" group.
 *
 * The input is **canonicalised first** (priority → stage sub-order → id, never
 * a timestamp — see {@link compareGroupingContentKey}), so the packing result
 * depends only on the item set and its content, never on the order the items
 * were presented in (WL-0MVVLBTTP003Y4XO).
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

  // Canonical, content-derived input order — group membership must not depend
  // on the (fluctuating) order items arrive in.
  for (const item of canonicalizeForGrouping(items)) {
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
 * Input order is canonicalised inside `groupItemsByFilePaths`
 * (priority → stage sub-order → id), so group assignment is a
 * content-deterministic function of the item set (WL-0MVVLBTTP003Y4XO).
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
 * This mirrors the predicate in src/commands/grouping.ts (ACL2).
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
 * plan_complete → intake_complete → remaining stages), then id as a
 * deterministic tie-break.
 *
 * Priority became the primary key in WL-0MVVLBTTP003Y4XO (the stage sub-order
 * was primary before): the review queue precedent that a lower-priority item
 * must never rank ahead of a higher-priority one (WL-0MUWDW0N6003KF6G) now
 * holds for every group, not only for `in_review`. The actively-worked sub-order
 * is therefore a **secondary** key — an actively-worked low-priority item no
 * longer outranks a high-priority plan_complete item.
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
 * Blocker-pin relationship consumed by the grouping override
 * (WL-0MW7YJYS5009H7WC AC2/AC3): blocker (or substituted-root) item id → the
 * visible blocked item id(s) it was pinned for. Produced by the selection
 * tail (`fetcher.root-substitution.ts`) and passed as the optional third
 * `regroupWorkItems` argument so a pinned blocker is grouped WITH the item it
 * blocks (first group wins — implemented here, WL-0MWDOL7I1001SXXA).
 * Absent/empty → byte-identical to today's output (AC5 no-op regression).
 */
export type BlockerPins = ReadonlyMap<string, string | string[]>;

// ── Regrouping the merged/selected list ───────────────────────────────

/**
 * Regroup and order a set of selected work items (e.g. the output of
 * selectWorkItems) so that every item receives a `group`/`groupLabel`
 * (mandatory wl list items included) and the list renders in the canonical
 * group order with no duplicate section headings.
 *
 * Does not filter or drop items — the always-show-mandatory guarantee of
 * selectWorkItems is preserved. Items are only reordered and stamped.
 *
 * The optional `pins` map applies the blocker-pin override (WL-0MW7YJYS5009H7WC):
 * a pinned blocker is grouped WITH the blocked item it blocks — same
 * `group`/`groupLabel` — and sorts immediately after it (AC2/AC3). When a
 * blocker blocks two visible blocked items in different groups the FIRST
 * (lowest-numbered) group in display order wins and the blocker appears
 * exactly once. An absent/empty pin map leaves the output byte-identical to
 * today's (AC5). The override is a deliberate exception to the file-path
 * conflict invariant for the blocker/blocked pair ONLY (AC12).
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
  needsProducerReview?: boolean;
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
  pins?: BlockerPins,
): T[] {
  const groupable = items.map(item => ({
    id: item.id,
    stage: item.stage,
    status: item.status,
    priority: item.priority,
    filePaths: extractFilePaths(item.description ?? ''),
    needsProducerReview: item.needsProducerReview,
    auditResult: item.auditResult,
    auditedAt: item.auditedAt,
    updatedAt: item.updatedAt,
    fingerprint: item.fingerprint,
    currentFingerprint: item.currentFingerprint,
  }));
  const groupMap = assignItemGroups(groupable, maxFilePathGroups);

  // ── Blocker-pin override (WL-0MW7YJYS5009H7WC AC2/AC3) ────────────────
  //
  // AC12 — DELIBERATE INVARIANT OVERRIDE: the file-path conflict invariant
  // (two conflicting items must never share a group) is broken for the
  // blocker/blocked pair, on purpose. A pinned blocker renders NEXT TO the
  // item it blocks (same group/label, immediately after it) because the
  // dependency relationship is the operator's primary need: a "blocked" row
  // must be followed by the work that unblocks it. This override applies ONLY
  // to ids present in the pin map; every other item keeps the content-derived
  // grouping, so the invariant is weakened for exactly the required pair and
  // nothing else.
  //
  // Resolve each blocker → its blocked anchor: the FIRST (lowest-numbered)
  // group in display order wins when a blocker blocks several visible blocked
  // items that land in different groups (AC2). Tie-breaks are by id so the
  // resolution is a pure function of content + edges, never of `updatedAt` or
  // the pin map's insertion order (AC9).
  const pinAnchor = new Map<string, { anchorId: string; group: number; groupLabel: string }>();
  if (pins && pins.size > 0) {
    for (const [blockerId, ref] of pins) {
      const blockedIds = Array.isArray(ref) ? ref : [ref];
      let chosen: { anchorId: string; group: number; groupLabel: string } | null = null;
      for (const blockedId of blockedIds) {
        const assignment = groupMap.get(blockedId);
        if (!assignment) continue; // blocked item not visible → skip candidate
        if (
          !chosen ||
          assignment.group < chosen.group ||
          (assignment.group === chosen.group && blockedId < chosen.anchorId)
        ) {
          chosen = {
            anchorId: blockedId,
            group: assignment.group,
            groupLabel: assignment.groupLabel,
          };
        }
      }
      if (chosen) {
        // Override the blocker's group to the blocked item's (AC2).
        groupMap.set(blockerId, { group: chosen.group, groupLabel: chosen.groupLabel });
        pinAnchor.set(blockerId, chosen);
      }
    }
  }

  const sorted = items.slice().sort((a, b) => {
    const ga = groupMap.get(a.id)?.group ?? Number.MAX_SAFE_INTEGER;
    const gb = groupMap.get(b.id)?.group ?? Number.MAX_SAFE_INTEGER;
    if (ga !== gb) return ga - gb;
    return compareGroupableItems(
      { id: a.id, stage: a.stage, status: a.status, priority: a.priority, filePaths: [],
        needsProducerReview: a.needsProducerReview,
        auditResult: a.auditResult,
        auditedAt: a.auditedAt,
        updatedAt: a.updatedAt,
        fingerprint: a.fingerprint,
        currentFingerprint: a.currentFingerprint,
      },
      { id: b.id, stage: b.stage, status: b.status, priority: b.priority, filePaths: [],
        needsProducerReview: b.needsProducerReview,
        auditResult: b.auditResult,
        auditedAt: b.auditedAt,
        updatedAt: b.updatedAt,
        fingerprint: b.fingerprint,
        currentFingerprint: b.currentFingerprint,
      },
    );
  });

  // AC3 — adjacency: within a group, each pinned blocker sorts immediately
  // AFTER the blocked item it was pinned for, instead of at its own
  // content-derived position. Deterministic: process each group's members in
  // content order (already established by `sorted`), emit non-pinned items as
  // they come, and insert each pinned blocker right after its anchor
  // (multi-block: the anchor resolves to the first/lowest group per AC2).
  // Iteration order of `pins` never matters — everything derives from the
  // content-ordered list + the resolved anchor map (AC9).
  if (pinAnchor.size > 0) {
    const result: T[] = [];
    const byGroup = new Map<number, T[]>();
    for (const item of sorted) {
      const g = groupMap.get(item.id)?.group ?? Number.MAX_SAFE_INTEGER;
      const list = byGroup.get(g);
      if (list) list.push(item);
      else byGroup.set(g, [item]);
    }
    for (const g of [...byGroup.keys()].sort((a, b) => a - b)) {
      const members = byGroup.get(g)!;
      const pinnedHere = members.filter(m => {
        const anchor = pinAnchor.get(m.id);
        return anchor !== undefined && anchor.group === g;
      });
      const pinnedIds = new Set(pinnedHere.map(m => m.id));
      const out: T[] = [];
      for (const member of members) {
        if (pinnedIds.has(member.id)) continue; // emitted below, next to its anchor
        out.push(member);
        // Insert every pinned blocker anchored on this member immediately
        // after it (deterministic by blocker id).
        const afterThis = pinnedHere
          .filter(p => pinAnchor.get(p.id)!.anchorId === member.id)
          .sort((x, y) => x.id.localeCompare(y.id));
        for (const pinned of afterThis) out.push(pinned);
      }
      // Fail-open: a pinned blocker whose anchor left the group (should not
      // happen — the override forces them into the same group) appends at the
      // group's end, deterministically.
      const emitted = new Set(out.map(m => m.id));
      for (const pinned of pinnedHere.sort((x, y) => x.id.localeCompare(y.id))) {
        if (!emitted.has(pinned.id)) out.push(pinned);
      }
      result.push(...out);
    }
    return result.map(item => {
      const assignment = groupMap.get(item.id);
      if (!assignment) return item;
      return {
        ...item,
        group: assignment.group,
        groupLabel: assignment.groupLabel,
      };
    });
  }

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
