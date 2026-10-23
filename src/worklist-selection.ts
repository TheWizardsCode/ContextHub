/**
 * Shared browse-feed selection for `wl next` and `wl worklist`
 * (WL-0MVI0HX58009JJRF, parent WL-0MVGYLU0S004WZUS).
 *
 * `wl next` used to inline the whole post-`findNextWorkItems` pipeline —
 * available-result filtering, parallel-safe group assignment, audit/child-count
 * enrichment and the group sort — inside its action handler. The consolidated
 * `wl worklist` read needs *exactly* the same browse feed, and the parent epic
 * forbids forking selection logic (a drifed copy would make Herdr's bundle path
 * disagree with `wl next` for the same DB state). The pipeline therefore lives
 * here and both commands call it:
 *
 *   `findNextWorkItems` → filter unresolved → group (count > 1)
 *                       → enrich (auditResult/auditedAt/childCount) → group sort
 *
 * The selection is a **pure read**. `wl next`'s auto re-sort (a DB write
 * byproduct) stays in the `next` command and is never invoked from here, so a
 * caller can serve the result from the read cache deterministically.
 */

import type { WorklogDatabase } from './database.js';
import type { WorkItem } from './types.js';
import { extractFilePaths, type GroupAssignment } from './commands/helpers.js';
import { assignItemGroups, compareGroupedItems } from './commands/grouping.js';

/** A work item enriched with the fields `wl next --json` adds per item. */
export interface EnrichedNextWorkItem extends WorkItem {
  /** Audit verdict: `true` ready to close, `false` rejected, `null` never audited. */
  auditResult: boolean | null;
  /** When the stored audit result was recorded (ISO), `null` when never audited. */
  auditedAt: string | null;
  /** Number of direct children. */
  childCount: number;
}

/** One browse-feed entry — the shape `wl next --json` emits per result. */
export interface BrowseFeedEntry {
  /** The enriched work item (`null` when the selection could not resolve one). */
  workItem: EnrichedNextWorkItem | null;
  /** Human-readable reason the item was selected. */
  reason?: string;
  /** 1-indexed parallel-safe group (only when more than one item was requested). */
  group?: number;
  /** Human-readable group label (only when more than one item was requested). */
  groupLabel?: string;
}

/** Input for {@link selectBrowseFeed}. */
export interface BrowseFeedOptions {
  /** How many items to select (the browse-feed window). */
  count: number;
  assignee?: string;
  search?: string;
  stage?: string;
  risk?: string;
  effort?: string;
  /** Include dependency-blocked items (default: excluded, matching `wl next`). */
  includeBlocked?: boolean;
  /** Include in-progress items alongside open ones (default: excluded). */
  includeInProgress?: boolean;
  /** Maximum parallel-safe groups when `count > 1` (default: 3). */
  groups?: number;
}

/** Result of {@link selectBrowseFeed}. */
export interface BrowseFeedSelection {
  /**
   * Every raw selection result, enriched but unfiltered and unsorted. Kept so
   * `wl next`'s single-item JSON shape (`{ workItem, reason }`, including the
   * "no item" case) stays byte-identical.
   */
  results: BrowseFeedEntry[];
  /** The resolvable results only, enriched and group-sorted (the browse feed). */
  items: BrowseFeedEntry[];
  /** The number of items that was requested. */
  requested: number;
  /** Non-empty when fewer items were available than requested. */
  note: string;
  /** True when parallel-safe groups were assigned (`count > 1`). */
  groupsEnabled: boolean;
}

/** Normalise a `groups` option to a usable maximum (default 3, minimum 1). */
function normalizeMaxGroups(value: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 3;
  return Math.floor(parsed);
}

/**
 * Select the browse feed for a stable DB state.
 *
 * Mirrors the pipeline `wl next` has always run after `findNextWorkItems`:
 *
 *  1. drop results that resolved to no work item;
 *  2. when more than one item was requested, assign parallel-safe groups from
 *     the items' Key Files sections (`assignItemGroups`);
 *  3. pre-compute child counts once and read each item's audit result, adding
 *     `auditResult` / `auditedAt` / `childCount` to the item;
 *  4. sort by group (`compareGroupedItems`) when groups were assigned.
 *
 * Never writes: no re-sort, no cache invalidation.
 */
export function selectBrowseFeed(
  db: WorklogDatabase,
  options: BrowseFeedOptions,
): BrowseFeedSelection {
  const count = options.count;
  const includeBlocked = Boolean(options.includeBlocked);
  const includeInProgress = Boolean(options.includeInProgress);

  const rawResults: any[] = (db as any).findNextWorkItems
    ? (db as any).findNextWorkItems(
        count,
        options.assignee,
        options.search,
        includeBlocked,
        options.stage,
        includeInProgress,
        options.risk,
        options.effort,
      )
    : [
        db.findNextWorkItem(
          options.assignee,
          options.search,
          includeBlocked,
          options.stage,
          includeInProgress,
          options.risk,
          options.effort,
        ),
      ];

  const availableResults = rawResults.filter((result: any) => Boolean(result?.workItem));
  const missingCount = Math.max(0, count - availableResults.length);
  const note =
    missingCount > 0
      ? `Only ${availableResults.length} of ${count} requested work item(s) available.`
      : '';

  // ── Grouping (only when more than one item is requested) ──────────
  let groupsEnabled = false;
  let groupMap: Map<string, GroupAssignment> | null = null;
  if (count > 1) {
    const maxGroups = normalizeMaxGroups(options.groups);
    groupsEnabled = true;
    // Extract file paths and priority from each work item's description.
    // Audit fields feed the in_review bucket sort (WL-0MSLPM5ZB003TADT).
    const groupableItems = availableResults.map((result: any) => {
      const wi = result.workItem;
      const ar = db.getAuditResult(wi?.id);
      return {
        id: wi.id,
        stage: wi.stage,
        filePaths: extractFilePaths(wi.description || ''),
        priority: wi.priority,
        needsProducerReview: wi.needsProducerReview,
        auditResult: ar?.readyToClose ?? null,
        auditedAt: ar?.auditedAt ?? null,
        updatedAt: wi.updatedAt,
      };
    });
    groupMap = assignItemGroups(groupableItems, maxGroups);
  }

  // ── Enrichment (one child-count query for the whole selection) ────
  const childCounts = db.getChildCounts();
  const enrichWorkItem = (wi: any): EnrichedNextWorkItem | null => {
    if (!wi) return null;
    const auditResult = db.getAuditResult(wi.id);
    const childCount = childCounts.get(wi.id) ?? 0;
    return {
      ...wi,
      auditResult: auditResult?.readyToClose ?? null,
      auditedAt: auditResult?.auditedAt ?? null,
      childCount,
    };
  };

  const results: BrowseFeedEntry[] = rawResults.map((result: any) => ({
    ...result,
    workItem: enrichWorkItem(result?.workItem),
  }));

  const items: BrowseFeedEntry[] = availableResults.map((result: any) => {
    const assignment = groupMap?.get(result.workItem.id);
    return {
      ...result,
      workItem: enrichWorkItem(result.workItem),
      ...(assignment ? { group: assignment.group, groupLabel: assignment.groupLabel } : {}),
    };
  });

  if (groupsEnabled && groupMap) {
    const map = groupMap;
    items.sort((a, b) =>
      compareGroupedItems(
        map,
        {
          id: a.workItem?.id ?? '',
          stage: a.workItem?.stage,
          priority: a.workItem?.priority,
          filePaths: [],
          needsProducerReview: a.workItem?.needsProducerReview,
          auditResult: a.workItem?.auditResult,
          auditedAt: a.workItem?.auditedAt,
          updatedAt: a.workItem?.updatedAt,
        },
        {
          id: b.workItem?.id ?? '',
          stage: b.workItem?.stage,
          priority: b.workItem?.priority,
          filePaths: [],
          needsProducerReview: b.workItem?.needsProducerReview,
          auditResult: b.workItem?.auditResult,
          auditedAt: b.workItem?.auditedAt,
          updatedAt: b.workItem?.updatedAt,
        },
      ),
    );
  }

  return { results, items, requested: count, note, groupsEnabled };
}
