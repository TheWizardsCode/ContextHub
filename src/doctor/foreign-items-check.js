/**
 * Foreign-item classification for `wl doctor foreign-items`.
 *
 * A work item is *foreign* when its ID prefix (the substring before the
 * first '-') does not match the project's configured prefix (e.g. `WL`
 * for ContextHub, `SA` for SorraAgents, `CG` for Tableau-Card-Engine,
 * `OSL` for open_source_llm). IDs without a '-' separator cannot be
 * classified and are left alone (treated as NOT foreign).
 */
/**
 * Extract the ID prefix (substring before the first '-').
 *
 * @param id - The work item ID (e.g. `WL-0MSAH2A71000MUA3`).
 * @returns The prefix string, or `null` when the ID has no '-' separator
 *          (cannot be classified).
 */
export function extractIdPrefix(id) {
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
export function isForeignItem(id, configPrefix) {
    const prefix = extractIdPrefix(id);
    if (prefix === null) {
        return false;
    }
    return prefix.toUpperCase() !== configPrefix.toUpperCase();
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
export function buildForeignItemReport(items, configPrefix, dryRun = true) {
    const byPrefix = {};
    const foreignIds = [];
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
        }
        else {
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
export function applyForeignItemCleanup(db, report) {
    const store = db.store;
    const totalBefore = db.getAll().length;
    const foreignBefore = report.foreignIds.length;
    const ownBefore = totalBefore - foreignBefore;
    const removedIds = [];
    const removedByPrefix = {};
    const errors = [];
    for (const id of report.foreignIds) {
        const prefix = extractIdPrefix(id);
        const key = (prefix ?? '').toUpperCase();
        try {
            // Cascade beyond deleteWorkItem: audit results and FTS entries are NOT
            // removed by deleteWorkItem and must be cleaned explicitly.
            if (store && typeof store.deleteAuditResult === 'function') {
                try {
                    store.deleteAuditResult(id);
                }
                catch (_) { /* best-effort */ }
            }
            if (store && typeof store.deleteFtsEntry === 'function') {
                try {
                    store.deleteFtsEntry(id);
                }
                catch (_) { /* best-effort */ }
            }
            let ok = false;
            if (store && typeof store.deleteWorkItem === 'function') {
                ok = store.deleteWorkItem(id);
            }
            if (ok) {
                removedIds.push(id);
                removedByPrefix[key] = (removedByPrefix[key] ?? 0) + 1;
            }
            else {
                errors.push({ id, error: 'deleteWorkItem returned false (item not found)' });
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ id, error: message });
        }
    }
    const totalAfter = db.getAll().length;
    const remainingIds = new Set(db.getAll().map(item => item.id));
    const foreignAfter = report.foreignIds.filter(id => remainingIds.has(id)).length;
    return {
        success: errors.length === 0,
        apply: true,
        prefix: report.prefix,
        totalBefore,
        totalAfter,
        foreignBefore,
        foreignAfter,
        ownBefore,
        ownAfter: totalAfter - foreignAfter,
        removedCount: removedIds.length,
        removedByPrefix,
        removedIds,
        errors,
    };
}
//# sourceMappingURL=foreign-items-check.js.map