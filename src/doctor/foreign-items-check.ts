/**
 * Foreign-item classification for `wl doctor foreign-items`.
 *
 * A work item is *foreign* when its ID prefix (the substring before the
 * first '-') does not match the project's configured prefix (e.g. `WL`
 * for ContextHub, `SA` for SorraAgents, `CG` for Tableau-Card-Engine,
 * `OSL` for open_source_llm). IDs without a '-' separator cannot be
 * classified and are left alone (treated as NOT foreign).
 */

import type { WorkItem } from '../types.js';

/**
 * Extract the ID prefix (substring before the first '-').
 *
 * @param id - The work item ID (e.g. `WL-0MSAH2A71000MUA3`).
 * @returns The prefix string, or `null` when the ID has no '-' separator
 *          (cannot be classified).
 */
export function extractIdPrefix(id: string): string | null {
  const dash = id.indexOf('-');
  if (dash <= 0) {
    return null; // no dash, or dash at position 0 (empty prefix)
  }
  return id.slice(0, dash);
}

/**
 * Determine whether a work item is foreign to the project.
 *
 * A work item is foreign when its ID prefix does not match the project's
 * configured prefix (case-insensitive). IDs without a '-' separator cannot
 * be classified and are treated as NOT foreign.
 *
 * @param id - The work item ID.
 * @param configPrefix - The project's configured prefix (e.g. `WL`).
 * @returns True when the item is foreign.
 */
export function isForeignItem(id: string, configPrefix: string): boolean {
  const prefix = extractIdPrefix(id);
  if (prefix === null) {
    return false;
  }
  return prefix.toUpperCase() !== configPrefix.toUpperCase();
}

/** Per-prefix grouping of foreign items. */
export interface ForeignItemPrefixGroup {
  count: number;
  deleted: number;
  nonDeleted: number;
  ids: string[];
}

/** Report produced by the foreign-items dry-run. */
export interface ForeignItemReport {
  success: boolean;
  dryRun: boolean;
  prefix: string;
  totalItems: number;
  foreignCount: number;
  deletedForeignCount: number;
  nonDeletedForeignCount: number;
  byPrefix: Record<string, ForeignItemPrefixGroup>;
  foreignIds: string[];
}

/**
 * Build a foreign-item report for a set of work items.
 *
 * @param items - All work items in the database.
 * @param configPrefix - The project's configured prefix (case-insensitive).
 * @param dryRun - Whether this is a dry-run (default true). The report is
 *                 read-only either way; the flag is echoed for callers that
 *                 render human output.
 * @returns The report with totals, per-prefix groups, and ID lists.
 */
export function buildForeignItemReport(
  items: WorkItem[],
  configPrefix: string,
  dryRun = true,
): ForeignItemReport {
  const byPrefix: Record<string, ForeignItemPrefixGroup> = {};
  const foreignIds: string[] = [];
  let deletedForeignCount = 0;
  let nonDeletedForeignCount = 0;

  for (const item of items) {
    const prefix = extractIdPrefix(item.id);
    if (prefix === null || !isForeignItem(item.id, configPrefix)) {
      continue;
    }
    const key = prefix.toUpperCase();
    const group = byPrefix[key] ?? { count: 0, deleted: 0, nonDeleted: 0, ids: [] };
    group.count += 1;
    group.ids.push(item.id);
    if (item.status === 'deleted') {
      group.deleted += 1;
      deletedForeignCount += 1;
    } else {
      group.nonDeleted += 1;
      nonDeletedForeignCount += 1;
    }
    byPrefix[key] = group;
    foreignIds.push(item.id);
  }

  return {
    success: true,
    dryRun,
    prefix: configPrefix.toUpperCase(),
    totalItems: items.length,
    foreignCount: foreignIds.length,
    deletedForeignCount,
    nonDeletedForeignCount,
    byPrefix,
    foreignIds,
  };
}
