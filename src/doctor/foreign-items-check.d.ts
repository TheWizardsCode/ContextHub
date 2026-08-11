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
export declare function extractIdPrefix(id: string): string | null;
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
export declare function isForeignItem(id: string, configPrefix: string): boolean;
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
export declare function buildForeignItemReport(items: WorkItem[], configPrefix: string, dryRun?: boolean): ForeignItemReport;
/** Result of applying the foreign-items cleanup. */
export interface ForeignItemApplyResult {
    success: boolean;
    apply: boolean;
    prefix: string;
    totalBefore: number;
    totalAfter: number;
    foreignBefore: number;
    foreignAfter: number;
    ownBefore: number;
    ownAfter: number;
    removedCount: number;
    removedByPrefix: Record<string, number>;
    removedIds: string[];
    errors: Array<{
        id: string;
        error: string;
    }>;
}
/**
 * Hard-delete all foreign items listed in the report with full cascade.
 *
 * For each foreign item, the following are removed:
 * - the workitem row (via store.deleteWorkItem, which also removes
 *   dependency edges referencing the item and its comments)
 * - the audit_results row (NOT cascaded by deleteWorkItem)
 * - the FTS index entry (NOT cascaded by deleteWorkItem)
 *
 * Own items are never touched. The operation is destructive and should be
 * gated by an explicit `--apply` flag by the caller.
 *
 * @param db - The WorklogDatabase instance (store accessed via `(db as any).store`).
 * @param report - The foreign-item report (only `foreignIds` and `prefix` are used).
 * @returns Before/after counts, per-prefix removed counts, and any errors.
 */
export declare function applyForeignItemCleanup(db: {
    getAll(): WorkItem[];
}, report: Pick<ForeignItemReport, 'foreignIds' | 'prefix'>): ForeignItemApplyResult;
//# sourceMappingURL=foreign-items-check.d.ts.map