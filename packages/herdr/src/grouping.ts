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
 * Ordering (WL-0MSI1LVTJ001M9EY): the Herdr selection list sorts by priority
 * FIRST — one section per priority bucket (Critical → High → Medium → Low) —
 * then by stage in workflow order (idea → intake_complete → plan_complete →
 * in_progress → in_review → done, unknown stages last) then by id. The old
 * file-path conflict partitioning ("Critical Group N" / "Group N" labels) was
 * dropped: priority is the primary sort key, so a high-priority in_progress
 * item no longer trails a medium-priority plan_complete item.
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
 */
export interface GroupableItem {
  id: string;
  stage?: string;
  filePaths: string[];
  priority?: string;
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
 * Priority rank per the project convention (src/commands/helpers.ts):
 * critical=4 > high=3 > medium=2 > low=1. Unknown/empty priorities sort as
 * medium (the `DEFAULT_PRIORITY` convention).
 */
const PRIORITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};
const DEFAULT_PRIORITY_RANK = PRIORITY_RANK.medium;

/**
 * Priority buckets rendered as one section each, most actionable first:
 * Critical → High → Medium → Low. Labels are the priority names; no stage
 * sub-headers are rendered (within-bucket stage order is implicit).
 */
const PRIORITY_BUCKET_ORDER: ReadonlyArray<string> = ['critical', 'high', 'medium', 'low'];
const BUCKET_LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Stage order within a priority bucket, following the canonical stage order
 * recorded in the work item config (src/config.ts defaults): idea →
 * intake_complete → plan_complete → in_progress → in_review → done. Unknown
 * stages sort after all known ones.
 */
const STAGE_ORDER: Record<string, number> = {
  idea: 0,
  intake_complete: 1,
  plan_complete: 2,
  in_progress: 3,
  in_review: 4,
  done: 5,
};
const UNKNOWN_STAGE_ORDER = 6;

/**
 * Resolve an item's priority rank, treating unknown/empty priority as medium
 * (the `DEFAULT_PRIORITY` convention from src/commands/helpers.ts).
 */
function priorityRank(priority: string | undefined): number {
  return PRIORITY_RANK[priority ?? ''] ?? DEFAULT_PRIORITY_RANK;
}

/**
 * Assign items to groups by priority bucket.
 *
 * Group display order (most actionable first):
 * - **Critical** — all critical-priority items.
 * - **High** — all high-priority items.
 * - **Medium** — all medium-priority items (and unknown/empty priorities,
 *   per the `DEFAULT_PRIORITY` convention).
 * - **Low** — all low-priority items.
 *
 * Each non-empty bucket becomes exactly one section labelled with its
 * priority name; empty buckets produce no section (group numbers start at 1
 * for the first non-empty bucket). Items carry no file-path partition
 * labels — the old "Critical Group N" / "Group N" partitioning
 * (WL-0MSAKPVR9005B6XJ) was dropped by WL-0MSI1LVTJ001M9EY.
 *
 * `maxFilePathGroups` is retained for signature compatibility with the core
 * `assignItemGroups` (src/commands/grouping.ts) but is no longer used.
 */
export function assignItemGroups(
  items: GroupableItem[],
  _maxFilePathGroups: number = 3,
): Map<string, GroupAssignment> {
  const result = new Map<string, GroupAssignment>();

  let nextGroup = 1;
  for (const bucket of PRIORITY_BUCKET_ORDER) {
    const bucketItems = items.filter(item => priorityRank(item.priority) === PRIORITY_RANK[bucket]);
    if (bucketItems.length === 0) continue;
    for (const item of bucketItems) {
      result.set(item.id, { group: nextGroup, groupLabel: BUCKET_LABEL[bucket] });
    }
    nextGroup++;
  }

  return result;
}

// ── Within-group ordering ─────────────────────────────────────────────

/**
 * Compare two items for display order: priority first (critical → high →
 * medium → low; unknown → medium), then stage in workflow order (idea →
 * intake_complete → plan_complete → in_progress → in_review → done; unknown
 * stages last), then id as a deterministic tie-break.
 */
export function compareGroupableItems(a: GroupableItem, b: GroupableItem): number {
  const prioA = priorityRank(a.priority);
  const prioB = priorityRank(b.priority);
  if (prioA !== prioB) return prioB - prioA;
  const stageA = STAGE_ORDER[a.stage ?? ''] ?? UNKNOWN_STAGE_ORDER;
  const stageB = STAGE_ORDER[b.stage ?? ''] ?? UNKNOWN_STAGE_ORDER;
  if (stageA !== stageB) return stageA - stageB;
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
export function regroupWorkItems<T extends { id: string; stage?: string; priority?: string; description?: string; group?: number; groupLabel?: string }>(
  items: T[],
  maxFilePathGroups: number = 3,
): T[] {
  const groupable = items.map(item => ({
    id: item.id,
    stage: item.stage,
    priority: item.priority,
    filePaths: extractFilePaths(item.description ?? ''),
  }));
  const groupMap = assignItemGroups(groupable, maxFilePathGroups);

  const sorted = items.slice().sort((a, b) => {
    const ga = groupMap.get(a.id)?.group ?? Number.MAX_SAFE_INTEGER;
    const gb = groupMap.get(b.id)?.group ?? Number.MAX_SAFE_INTEGER;
    if (ga !== gb) return ga - gb;
    return compareGroupableItems(
      { id: a.id, stage: a.stage, priority: a.priority, filePaths: [] },
      { id: b.id, stage: b.stage, priority: b.priority, filePaths: [] },
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
