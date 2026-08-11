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
import type { PluginContext } from '../plugin-types.js';
export default function register(ctx: PluginContext): void;
//# sourceMappingURL=close.d.ts.map