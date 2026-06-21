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
 * Backward-compatible: items not meeting the recursive conditions are
 * closed as before (single-item close only).
 */

import type { WorkItem } from '../types.js';
import type { PluginContext } from '../plugin-types.js';
import type { CloseOptions } from '../cli-types.js';
import { submitToOpenBrain } from '../openbrain.js';

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
 * Close a single item (no recursion).  Creates the reason comment if one
 * is provided, then updates status/stage.  Returns the updated item or null
 * on failure.
 */
function closeSingle(
  id: string,
  reason: string | undefined,
  author: string,
  db: any
): WorkItem | null {
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
    return updated || null;
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
): { errors: Array<{ id: string; error: string }>; childrenClosed: number } {
  const errors: Array<{ id: string; error: string }> = [];

  // Get all descendants (DFS order: parents before children in each branch)
  const descendants = db.getDescendants(parentId);
  if (!descendants || descendants.length === 0) return { errors, childrenClosed: 0 };

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

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  program
    .command('close')
    .description(
      'Close one or more work items and record a close reason as a comment. ' +
      'Recursively closes children when the item is in_review and audit-ready.'
    )
    .argument('<ids...>', 'Work item id(s) to close')
    .option('-r, --reason <reason>', 'Reason for closing (stored as a comment)', '')
    .option('-a, --author <author>', 'Author name for the close comment', 'worklog')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((ids: string[], options: CloseOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const isJsonMode = utils.isJsonMode();
      const reason = options.reason || '';
      const author = options.author || 'worklog';

      const results: Array<{ id: string; success: boolean; error?: string; childrenClosed?: number; childErrors?: Array<{ id: string; error: string }> }> = [];

      for (const rawId of ids) {
        const normalizedId = utils.normalizeCliId(rawId, options.prefix) || rawId;
        const id = normalizedId.toUpperCase();
        const item = db.get(id);
        if (!item) {
          results.push({ id, success: false, error: 'Work item not found' });
          continue;
        }

        // Check if this item qualifies for recursive close
        if (shouldCloseRecursively(item, db)) {
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
          const result: any = { id, success: true, childrenClosed };
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
        } else {
          // Standard (non-recursive) close — existing behaviour
          const updated = closeSingle(id, reason, author, db);
          if (!updated) {
            results.push({ id, success: false, error: 'Failed to close item' });
            continue;
          }
          results.push({ id, success: true });

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
      } else {
        for (const r of results) {
          if (r.success) {
            // Show children-closed count for recursive close results
            if (r.childrenClosed !== undefined) {
              console.log(`Closed ${r.id} (${r.childrenClosed} children closed)`);
            } else {
              console.log(`Closed ${r.id}`);
            }
          } else {
            console.error(`Failed to close ${r.id}: ${r.error}`);
          }
          // Report per-child errors — recursive close path only
          if (r.childErrors && r.childErrors.length > 0) {
            for (const ce of r.childErrors) {
              console.error(`  Child ${ce.id}: ${ce.error} — this item remains unclosed at top level`);
            }
          }
        }
      }
      if (!results.every(r => r.success)) process.exit(1);
    });
}
