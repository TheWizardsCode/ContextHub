/**
 * Close command - Close one or more work items and record a close reason
 *
 * If the item is in `in_review` stage and has an audit result with
 * `readyToClose === true`, recursively closes all descendants
 * (deepest-first) before closing the parent.  This ensures that an
 * approved/reviewed parent closes its entire subtree.
 *
 * Recursive close output:
 *   - Human: `Closed <id> (N children closed)`
 *   - JSON:  `{ success: true, results: [{ id, success: true, childrenClosed: N }] }`
 *   On child errors, per-child warnings are printed on stderr and the
 *   JSON result includes `childErrors: [{ id, error }]`.
 *
 * Recovery path: if the item is already in `done` stage (status: completed)
 * but still has non-closed children, the command closes the open children
 * without re-closing the parent.  This handles orphaned children created
 * before recursive close was enabled or added after the parent was closed.
 *
 * Recovery close output:
 *   - Human: `Recovery close for <id>: N open children closed (parent was already done)`
 *   - JSON:  `{ success: true, results: [{ id, success: true, recovered: true, childrenClosed: N }] }`
 *
 * Backward-compatible: items not meeting the recursive or recovery
 * conditions are closed as before (single-item close only).
 */
import { submitToOpenBrain } from '../openbrain.js';
/**
 * Determine whether an item qualifies for recursive close.
 * Conditions:
 *   1. Item has at least one child
 *   2. Item stage is exactly "in_review"
 *   3. Item has an audit result with readyToClose === true
 */
function shouldCloseRecursively(item, db) {
    const children = db.getChildren(item.id);
    if (!children || children.length === 0)
        return false;
    if (item.stage !== 'in_review')
        return false;
    const auditResult = db.getAuditResult(item.id);
    if (!auditResult)
        return false;
    return auditResult.readyToClose === true;
}
/**
 * Determine whether a done parent needs recovery close for open children.
 * This handles the case where a parent was previously closed
 * (status: completed, stage: done) but still has non-closed children —
 * e.g., when the parent was closed before recursive close was enabled,
 * or children were added after the parent was closed.
 *
 * Conditions:
 *   1. Item has at least one child
 *   2. Item status is "completed" and stage is "done"
 *   3. At least one child is NOT completed/done
 */
function shouldRecoverOpenChildren(item, db) {
    const children = db.getChildren(item.id);
    if (!children || children.length === 0)
        return false;
    if (item.status !== 'completed' || item.stage !== 'done')
        return false;
    return children.some((child) => child.status !== 'completed' || child.stage !== 'done');
}
/**
 * Close a single item (no recursion).  Creates the reason comment if one
 * is provided, then updates status/stage.  Returns the updated item or null
 * on failure.
 */
function closeSingle(id, reason, author, db) {
    if (reason && reason.trim() !== '') {
        try {
            const comment = db.createComment({
                workItemId: id,
                author,
                comment: `Closed with reason: ${reason}`,
                references: [],
            });
            if (!comment)
                return null;
        }
        catch (err) {
            return null;
        }
    }
    try {
        const updated = db.update(id, { status: 'completed', stage: 'done' });
        return updated || null;
    }
    catch (err) {
        return null;
    }
}
/**
 * Recursively close all descendants of a parent item, deepest first.
 * Collects errors per child but continues processing.
 *
 * @returns Object with:
 *   - errors: Array of { id, error } for children that could not be closed.
 *   - childrenClosed: Count of successfully closed descendants.
 */
function closeDescendants(parentId, reason, author, db) {
    const errors = [];
    // Get all descendants (DFS order: parents before children in each branch)
    const descendants = db.getDescendants(parentId);
    if (!descendants || descendants.length === 0)
        return { errors, childrenClosed: 0 };
    // Reverse to close deepest items first
    const deepestFirst = [...descendants].reverse();
    for (const descendant of deepestFirst) {
        const updated = closeSingle(descendant.id, reason, author, db);
        if (!updated) {
            errors.push({ id: descendant.id, error: 'Failed to close descendant' });
        }
    }
    return { errors, childrenClosed: descendants.length - errors.length };
}
export default function register(ctx) {
    const { program, output, utils } = ctx;
    program
        .command('close')
        .description('Close one or more work items and record a close reason as a comment. ' +
        'Recursively closes children when the item is in_review and audit-ready. ' +
        'Use --force to close a parent and all its children unconditionally, '
        + 'bypassing the audit/stage checks.')
        .argument('<ids...>', 'Work item id(s) to close')
        .option('-r, --reason <reason>', 'Reason for closing (stored as a comment)', '')
        .option('-a, --author <author>', 'Author name for the close comment', 'worklog')
        .option('--prefix <prefix>', 'Override the default prefix')
        .option('--force', 'Close the item and all its descendants unconditionally, '
        + 'bypassing the audit/stage checks. For items without children, '
        + 'this is equivalent to a standard close.')
        .action((ids, options) => {
        utils.requireInitialized();
        const db = utils.getDatabase(options.prefix);
        const isJsonMode = utils.isJsonMode();
        const reason = options.reason || '';
        const author = options.author || 'worklog';
        const force = options.force === true;
        const results = [];
        for (const rawId of ids) {
            const normalizedId = utils.normalizeCliId(rawId, options.prefix) || rawId;
            const id = normalizedId.toUpperCase();
            const item = db.get(id);
            if (!item) {
                results.push({ id, success: false, error: 'Work item not found' });
                continue;
            }
            // Check if this item qualifies for recursive close
            // ── Force path: unconditionally close descendants then parent ──
            if (force) {
                const children = db.getChildren(id);
                if (children && children.length > 0) {
                    // Close all descendants first (deepest first), collecting errors
                    const { errors: childErrors, childrenClosed } = closeDescendants(id, reason, author, db);
                    // Now close the parent itself
                    const updated = closeSingle(id, reason, author, db);
                    if (!updated) {
                        results.push({
                            id,
                            success: false,
                            error: 'Failed to close parent item',
                            childrenClosed,
                            childErrors: childErrors.length > 0 ? childErrors : undefined,
                        });
                        continue;
                    }
                    const result = { id, success: true, childrenClosed };
                    if (childErrors.length > 0) {
                        result.childErrors = childErrors;
                    }
                    results.push(result);
                    // Fire-and-forget: submit a summary to OpenBrain if enabled.
                    const config = utils.getConfig();
                    if (config?.openBrainEnabled) {
                        submitToOpenBrain(updated).catch(() => {
                            // Errors are already logged inside submitToOpenBrain; swallow here
                            // so the close command is never blocked or aborted.
                        });
                    }
                }
                else {
                    // No children — standard single-item close (flag is a no-op)
                    const updated = closeSingle(id, reason, author, db);
                    if (!updated) {
                        results.push({ id, success: false, error: 'Failed to close item' });
                        continue;
                    }
                    results.push({ id, success: true });
                    const config = utils.getConfig();
                    if (config?.openBrainEnabled) {
                        submitToOpenBrain(updated).catch(() => {
                            // Errors are already logged inside submitToOpenBrain; swallow here
                            // so the close command is never blocked or aborted.
                        });
                    }
                }
                // ── Audit-gated recursive close ──
            }
            else if (shouldCloseRecursively(item, db)) {
                // Close descendants first (deepest first), collecting errors without aborting
                const { errors: childErrors, childrenClosed } = closeDescendants(id, reason, author, db);
                // Now close the parent itself
                const updated = closeSingle(id, reason, author, db);
                if (!updated) {
                    results.push({
                        id,
                        success: false,
                        error: 'Failed to close parent item',
                        childrenClosed,
                        childErrors: childErrors.length > 0 ? childErrors : undefined,
                    });
                    continue;
                }
                // Parent successfully closed
                const result = { id, success: true, childrenClosed };
                if (childErrors.length > 0) {
                    result.childErrors = childErrors;
                }
                results.push(result);
                // Fire-and-forget: submit a summary to OpenBrain if enabled.
                const config = utils.getConfig();
                if (config?.openBrainEnabled) {
                    submitToOpenBrain(updated).catch(() => {
                        // Errors are already logged inside submitToOpenBrain; swallow here
                        // so the close command is never blocked or aborted.
                    });
                }
                // ── Recovery path ──
            }
            else if (shouldRecoverOpenChildren(item, db)) {
                // Recovery path: parent is already completed/done but has open children.
                // Close descendants only — the parent itself is already closed.
                const { errors: childErrors, childrenClosed } = closeDescendants(id, reason, author, db);
                const result = {
                    id,
                    success: true,
                    childrenClosed,
                    recovered: true,
                };
                if (childErrors.length > 0) {
                    result.childErrors = childErrors;
                }
                results.push(result);
                // No OpenBrain submission for the recovery path: the parent was
                // already done and presumably submitted to OpenBrain previously.
                // Children were closed individually but each closeSingle does not
                // trigger OpenBrain (consistent with the recursive close pattern).
            }
            else {
                // Standard (non-recursive) close — existing behaviour
                const updated = closeSingle(id, reason, author, db);
                if (!updated) {
                    results.push({ id, success: false, error: 'Failed to close item' });
                    continue;
                }
                results.push({ id, success: true });
                // Warning: parent has orphaned children — determine reason
                const children = db.getChildren(id);
                if (children && children.length > 0) {
                    if (!isJsonMode) {
                        // Determine why children are not being closed, matching the
                        // order of conditions in shouldCloseRecursively() so only the
                        // first blocking reason is reported.
                        let reason;
                        if (item.stage !== 'in_review') {
                            reason = "the parent is not in the 'in_review' stage";
                        }
                        else {
                            const auditResult = db.getAuditResult(item.id);
                            if (!auditResult) {
                                reason = 'the parent has no audit result';
                            }
                            else {
                                reason = 'the audit result is not ready to close';
                            }
                        }
                        const warningMsg = 'Warning: ' + id + ' has ' + children.length + ' open children that will not be closed because ' + reason + '. Use `wl close --force ' + id + '` to close them unconditionally.';
                        console.error(warningMsg);
                    }
                }
                // Fire-and-forget: submit a summary to OpenBrain if enabled.
                const config = utils.getConfig();
                if (config?.openBrainEnabled) {
                    submitToOpenBrain(updated).catch(() => {
                        // Errors are already logged inside submitToOpenBrain; swallow here
                        // so the close command is never blocked or aborted.
                    });
                }
            }
        }
        if (isJsonMode) {
            const overallSuccess = results.every(r => r.success);
            // If only child errors exist, the close is still considered successful
            output.json({ success: overallSuccess, results });
        }
        else {
            for (const r of results) {
                if (r.success) {
                    if (r.recovered) {
                        // Recovery path: parent was already done, children were closed
                        if (r.childErrors && r.childErrors.length > 0) {
                            const closed = r.childrenClosed ?? 0;
                            console.log(`Recovery close for ${r.id}: ${closed}/${closed + r.childErrors.length} open children closed (parent was already done)`);
                        }
                        else {
                            console.log(`Recovery close for ${r.id}: ${r.childrenClosed ?? 0} open children closed (parent was already done)`);
                        }
                    }
                    else if (r.childrenClosed !== undefined) {
                        console.log(`Closed ${r.id} (${r.childrenClosed} children closed)`);
                    }
                    else {
                        console.log(`Closed ${r.id}`);
                    }
                }
                else {
                    console.error(`Failed to close ${r.id}: ${r.error}`);
                }
                // Report per-child errors — recursive / recovery close path only
                if (r.childErrors && r.childErrors.length > 0) {
                    for (const ce of r.childErrors) {
                        console.error(`  Child ${ce.id}: ${ce.error} — this item remains unclosed at top level`);
                    }
                }
            }
        }
        if (!results.every(r => r.success))
            process.exit(1);
    });
}
//# sourceMappingURL=close.js.map