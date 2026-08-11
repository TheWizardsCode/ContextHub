/**
 * Delete command - Delete a work item
 *
 * By default, recursively deletes all child work items (descendants) first,
 * then marks the target item as deleted. Use --no-recursive to delete only
 * the specified item, leaving children orphaned.
 *
 * After successful deletion, automatically syncs the local state to the
 * remote git branch to prevent soft-deleted items from being restored by
 * a subsequent sync from another agent. The sync runs exactly once after
 * all deletions in the current invocation complete, and failures during
 * sync do not cause the delete command to fail.
 */
import type { PluginContext } from '../plugin-types.js';
export default function register(ctx: PluginContext): void;
//# sourceMappingURL=delete.d.ts.map