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

import type { WorkItem } from '../types.js';
import type { PluginContext } from '../plugin-types.js';
import type { CloseOptions } from '../cli-types.js';

import { classifyAuditGap, type ParentAuditState } from '@worklog/shared/icons';
import { withStoreMutationLock } from '../mutation-lock.js';
import { downgradeCriticalIfTerminal } from '../terminal-priority.js';

/**
 * Build the direct parent's audit state for derived child coverage
 * (WL-0MUBVH8QG0020H9L); reuses the shared freshness predicate downstream.
 */
function parentAuditState(item: WorkItem, db: any): ParentAuditState | null {
  if (!item.parentId) return null;
  const parent = db.get(item.parentId);
  if (!parent) return null;
  const audit = db.getAuditResult(item.parentId);
  return {
    auditResult: audit ? audit.readyToClose : null,
    auditedAt: audit?.auditedAt ?? null,
    updatedAt: parent.updatedAt,
    fingerprint: audit?.fingerprint ?? null,
  };
}

/**
 * Non-fatal audit-gap warning for an item about to be closed
 * (WL-0MUBVH9FV0027COG AC2/AC3).
 *
 * Returns `null` unless the item is being closed from `in_review` (the
 * review→done completion transition) AND is genuinely uncovered per the
 * shared classifier: no fresh own audit, no waiver, and no fresh-audited
 * direct parent. Never blocks the close.
 */
function auditGapWarningFor(item: WorkItem, db: any): string | null {
  // Only completion-from-review is the audited gate; closing a never-reviewed
  // open item is not an audit-gap concern.
  if (item.stage !== 'in_review') return null;
  const audit = db.getAuditResult(item.id);
  const status = classifyAuditGap({
    ownAudit: audit ? { auditedAt: audit.auditedAt, fingerprint: audit.fingerprint ?? null } : null,
    updatedAt: item.updatedAt,
    parentId: item.parentId,
    auditWaiver: item.auditWaiver ?? null,
    parentAudit: parentAuditState(item, db),
  });
  if (status !== 'uncovered') return null;

  const relationship = item.parentId ? `child of ${item.parentId}` : 'root';
  const auditState = audit ? 'stale' : 'missing';
  return (
    `Warning: ${item.id} (${relationship}) is being closed from in_review with a ${auditState} audit and no waiver. `
    + 'This is an audit gate leak; re-audit it or record a deliberate exception with '
    + `\`wl audit-waive ${item.id} --reason "<why>"\`.`
  );
}

/**
 * Record a durable waiver for a `--force` close that bypasses the audit gate
 * (AC2: `--force` is the explicit escape hatch and records the bypass).
 * Best-effort: never blocks the force close. Only records when the item would
 * otherwise be uncovered (no existing waiver, no fresh audit).
 */
function recordForceWaiver(item: WorkItem, reason: string, author: string, db: any): void {
  if (item.auditWaiver) return;
  if (!auditGapWarningFor(item, db)) return;
  try {
    const suffix = reason && reason.trim() ? `: ${reason.trim()}` : '';
    db.setAuditWaiver(item.id, {
      reason: `Force close via wl close --force${suffix}`,
      author,
      waivedAt: new Date().toISOString(),
    });
  } catch (_err) {
    // Never block a force close because waiver recording failed.
  }
}

/**
 * Determine whether an item qualifies for recursive close.
 * Conditions:
 *   1. Item has at least one child
 *   2. Item stage is exactly "in_review"
 *   3. Item has an audit result with readyToClose === true
 */
function shouldCloseRecursively(
  item: WorkItem,
  db: any
): boolean {
  const children = db.getChildren(item.id);
  if (!children || children.length === 0) return false;

  if (item.stage !== 'in_review') return false;

  const auditResult = db.getAuditResult(item.id);
  if (!auditResult) return false;

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
function shouldRecoverOpenChildren(
  item: WorkItem,
  db: any
): boolean {
  const children = db.getChildren(item.id);
  if (!children || children.length === 0) return false;

  if (item.status !== 'completed' || item.stage !== 'done') return false;

  return children.some(
    (child: WorkItem) => child.status !== 'completed' || child.stage !== 'done'
  );
}

/**
 * Result of closing a single item.
 */
interface CloseSingleResult {
  /** The item after the close (post auto-downgrade when one occurred). */
  item: WorkItem;
  /** The item when its `critical` priority was auto-downgraded, else null. */
  downgradedItem: WorkItem | null;
}

/**
 * Close a single item (no recursion).  Creates the reason comment if one
 * is provided, then updates status/stage.  Returns the updated item or null
 * on failure.
 */
function closeSingle(
  id: string,
  reason: string | undefined,
  author: string,
  db: any
): CloseSingleResult | null {
  if (reason && reason.trim() !== '') {
    try {
      const comment = db.createComment({
        workItemId: id,
        author,
        comment: `Closed with reason: ${reason}`,
        references: [],
      });
      if (!comment) return null;
    } catch (err) {
      return null;
    }
  }

  try {
    const updated = db.update(id, { status: 'completed', stage: 'done' });
    if (!updated) return null;
    // Closing is a terminal transition: never leave the item at `critical`,
    // which signals urgent *open* work (WL-0MSJM4EIV001A0V9). Report the
    // downgrade so the caller can surface it in the command output.
    const downgradedItem = downgradeCriticalIfTerminal(db, id);
    return { item: downgradedItem ?? updated, downgradedItem };
  } catch (err) {
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
function closeDescendants(
  parentId: string,
  reason: string | undefined,
  author: string,
  db: any
): { errors: Array<{ id: string; error: string }>; childrenClosed: number; auditGapWarnings: string[]; downgradedItems: WorkItem[] } {
  const errors: Array<{ id: string; error: string }> = [];
  const auditGapWarnings: string[] = [];
  const downgradedItems: WorkItem[] = [];

  // Get all descendants (DFS order: parents before children in each branch)
  const descendants = db.getDescendants(parentId);
  if (!descendants || descendants.length === 0) return { errors, childrenClosed: 0, auditGapWarnings, downgradedItems };

  // Reverse to close deepest items first
  const deepestFirst = [...descendants].reverse();

  for (const descendant of deepestFirst) {
    const warning = auditGapWarningFor(descendant, db);
    if (warning) auditGapWarnings.push(warning);
    const closed = closeSingle(descendant.id, reason, author, db);
    if (!closed) {
      errors.push({ id: descendant.id, error: 'Failed to close descendant' });
    } else if (closed.downgradedItem) {
      downgradedItems.push(closed.downgradedItem);
    }
  }

  return { errors, childrenClosed: descendants.length - errors.length, auditGapWarnings, downgradedItems };
}

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  program
    .command('close')
    .description(
      'Close one or more work items and record a close reason as a comment. ' +
      'Recursively closes children when the item is in_review and audit-ready. ' +
      'Use --force to close a parent and all its children unconditionally, '
      + 'bypassing the audit/stage checks.'
    )
    .argument('<ids...>', 'Work item id(s) to close')
    .option('-r, --reason <reason>', 'Reason for closing (stored as a comment)', '')
    .option('-a, --author <author>', 'Author name for the close comment', 'worklog')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--force', 'Close the item and all its descendants unconditionally, '
      + 'bypassing the audit/stage checks. For items without children, '
      + 'this is equivalent to a standard close.')
    .action((ids: string[], options: CloseOptions) =>
      withStoreMutationLock(ctx.dataPath, () => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const isJsonMode = utils.isJsonMode();
      const reason = options.reason || '';
      const author = options.author || 'worklog';
      const force = options.force === true;

      const results: Array<{ id: string; success: boolean; error?: string; childrenClosed?: number; recovered?: boolean; childErrors?: Array<{ id: string; error: string }>; auditGapWarnings?: string[]; downgradedItems?: WorkItem[] }> = [];

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
            // AC2: --force is the explicit escape hatch; record a durable
            // waiver for an uncovered in_review root so the bypass is auditable.
            recordForceWaiver(item, reason, author, db);
            // Close all descendants first (deepest first), collecting errors
            const { errors: childErrors, childrenClosed, auditGapWarnings, downgradedItems } = closeDescendants(id, reason, author, db);

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

            const result: any = { id, success: true, childrenClosed };
            if (childErrors.length > 0) {
              result.childErrors = childErrors;
            }
            if (auditGapWarnings.length > 0) {
              result.auditGapWarnings = auditGapWarnings;
            }
            const allDowngraded = [...downgradedItems];
            if (updated.downgradedItem) allDowngraded.push(updated.downgradedItem);
            if (allDowngraded.length > 0) {
              result.downgradedItems = allDowngraded;
            }
            results.push(result);
          } else {
            // No children — standard single-item close (flag is a no-op)
            recordForceWaiver(item, reason, author, db);
            const updated = closeSingle(id, reason, author, db);
            if (!updated) {
              results.push({ id, success: false, error: 'Failed to close item' });
              continue;
            }
            const result: any = { id, success: true };
            if (updated.downgradedItem) result.downgradedItems = [updated.downgradedItem];
            results.push(result);
          }
        // ── Audit-gated recursive close ──
        } else if (shouldCloseRecursively(item, db)) {
          // Close descendants first (deepest first), collecting errors without aborting
          const { errors: childErrors, childrenClosed, auditGapWarnings, downgradedItems } = closeDescendants(id, reason, author, db);

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
          const result: any = { id, success: true, childrenClosed };
          if (childErrors.length > 0) {
            result.childErrors = childErrors;
          }
          if (auditGapWarnings.length > 0) {
            result.auditGapWarnings = auditGapWarnings;
          }
          const allDowngraded = [...downgradedItems];
          if (updated.downgradedItem) allDowngraded.push(updated.downgradedItem);
          if (allDowngraded.length > 0) {
            result.downgradedItems = allDowngraded;
          }
          results.push(result);
        // ── Recovery path ──
        } else if (shouldRecoverOpenChildren(item, db)) {
          // Recovery path: parent is already completed/done but has open children.
          // Close descendants only — the parent itself is already closed.
          const { errors: childErrors, childrenClosed, auditGapWarnings, downgradedItems } = closeDescendants(id, reason, author, db);

          const result: any = {
            id,
            success: true,
            childrenClosed,
            recovered: true,
          };
          if (childErrors.length > 0) {
            result.childErrors = childErrors;
          }
          if (auditGapWarnings.length > 0) {
            result.auditGapWarnings = auditGapWarnings;
          }
          if (downgradedItems.length > 0) {
            result.downgradedItems = downgradedItems;
          }
          results.push(result);

        } else {
          // Standard (non-recursive) close — existing behaviour
          const auditGapWarning = auditGapWarningFor(item, db);
          const updated = closeSingle(id, reason, author, db);
          if (!updated) {
            results.push({ id, success: false, error: 'Failed to close item' });
            continue;
          }
          const result: any = { id, success: true };
          if (auditGapWarning) result.auditGapWarnings = [auditGapWarning];
          if (updated.downgradedItem) result.downgradedItems = [updated.downgradedItem];
          results.push(result);

          // Warning: parent has orphaned children — determine reason
          const children = db.getChildren(id);
          if (children && children.length > 0) {
            if (!isJsonMode) {
              // Determine why children are not being closed, matching the
              // order of conditions in shouldCloseRecursively() so only the
              // first blocking reason is reported.
              let reason: string;
              if (item.stage !== 'in_review') {
                reason = "the parent is not in the 'in_review' stage";
              } else {
                const auditResult = db.getAuditResult(item.id);
                if (!auditResult) {
                  reason = 'the parent has no audit result';
                } else {
                  reason = 'the audit result is not ready to close';
                }
              }
              const warningMsg = 'Warning: ' + id + ' has ' + children.length + ' open children that will not be closed because ' + reason + '. Use `wl close --force ' + id + '` to close them unconditionally.';
              console.error(warningMsg);
            }
          }

        }
      }

      if (isJsonMode) {
        const closed = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        const auditGapWarnings = results.flatMap(r => r.auditGapWarnings ?? []);
        // If only child errors exist, the close is still considered successful
        output.json({ results, closed, failed, auditGapWarnings });
      } else {
        for (const r of results) {
          if (r.success) {
            if (r.recovered) {
              // Recovery path: parent was already done, children were closed
              if (r.childErrors && r.childErrors.length > 0) {
                const closed = r.childrenClosed ?? 0;
                console.log(`Recovery close for ${r.id}: ${closed}/${closed + r.childErrors.length} open children closed (parent was already done)`);
              } else {
                console.log(`Recovery close for ${r.id}: ${r.childrenClosed ?? 0} open children closed (parent was already done)`);
              }
            } else if (r.childrenClosed !== undefined) {
              console.log(`Closed ${r.id} (${r.childrenClosed} children closed)`);
            } else {
              console.log(`Closed ${r.id}`);
            }
            if (r.downgradedItems && r.downgradedItems.length > 0) {
              const n = r.downgradedItems.length;
              console.log(`[Downgraded ${n} item${n === 1 ? '' : 's'} from critical to high]`);
            }
          } else {
            console.error(`Failed to close ${r.id}: ${r.error}`);
          }
          // Non-fatal audit-gap warnings (never block the close, AC2)
          if (r.auditGapWarnings && r.auditGapWarnings.length > 0) {
            for (const warning of r.auditGapWarnings) {
              console.error(warning);
            }
          }
          // Report per-child errors — recursive / recovery close path only
          if (r.childErrors && r.childErrors.length > 0) {
            for (const ce of r.childErrors) {
              console.error(`  Child ${ce.id}: ${ce.error} — this item remains unclosed at top level`);
            }
          }
        }
      }
      if (!results.every(r => r.success)) process.exit(1);
      }),
    );
}
