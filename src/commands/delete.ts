/**
 * Delete command - Delete one or more work items
 *
 * Accepts one or more work-item ids (`wl delete <ids...>`). Every id is
 * processed independently: a failure for one id (not found, invalid id) does
 * not abort the remaining ids, each id is reported in a per-id result, and the
 * command exits non-zero when any id failed. This mirrors the variadic
 * conventions already used by `wl update <id...>` and `wl close <ids...>`.
 *
 * By default, recursively deletes all child work items (descendants) first,
 * then marks the target item as deleted. Use --no-recursive to delete only the
 * specified items, leaving children orphaned.
 *
 * After processing every id, automatically syncs the local state to the
 * remote git branch exactly once (never once per id) to prevent soft-deleted
 * items from being restored by a subsequent sync from another agent. The sync
 * is skipped when --no-sync is supplied or when no item was actually deleted.
 * Sync failures are logged but do not cause the delete command to fail.
 *
 * Backward compatibility (WL-0MUI83ZTX005RN93): for a single-id invocation the
 * JSON output preserves the legacy top-level fields (`deletedId`,
 * `deletedWorkItem`, `recursive`) in addition to the batch summary. When a
 * parent and one of its descendants are both listed in the same invocation,
 * the descendant is reported as `skipped`/`already deleted` rather than
 * producing a hard error.
 */

import type { PluginContext } from '../plugin-types.js';
import type { DeleteOptions } from '../cli-types.js';
import type { WorkItem } from '../types.js';
import { performSync, getSyncDefaults } from './sync.js';
import { getConfiguredUserEmail } from '../sync.js';
import { withStoreMutationLock } from '../mutation-lock.js';

/** Per-id result for a batch delete invocation. */
interface DeleteResult {
  id: string;
  success: boolean;
  /** Present on failures (and on skips for a human-readable reason). */
  error?: string;
  /** Human-readable summary for this id. */
  message?: string;
  /** Legacy single-id field: the id that was deleted. */
  deletedId?: string;
  /** Legacy single-id field: the pre-delete snapshot of the item. */
  deletedWorkItem?: WorkItem;
  /** Whether recursive deletion was applied to this id. */
  recursive?: boolean;
  /** Number of descendants removed along with this id. */
  deletedDescendantsCount?: number;
  /** The descendants removed along with this id. */
  deletedDescendants?: Array<{ id: string; title: string }>;
  /** True when the id was a no-op (duplicate or already deleted). */
  skipped?: boolean;
  /** Why the id was skipped. */
  skippedReason?: string;
}

export default function register(ctx: PluginContext): void {
  const { program, dataPath, output, utils } = ctx;

  program
    .command('delete <ids...>')
    .description('Delete one or more work items (marks as deleted). Recursively deletes child items by default.')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--no-recursive', 'Delete only the specified items, leaving children orphaned')
    .option('--no-sync', 'Skip auto-sync after deletion')
    .action(async (ids: string[], options: DeleteOptions & { sync?: boolean }) =>
      withStoreMutationLock(dataPath, async () => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const isJsonMode = utils.isJsonMode();

      // Recursive is the default; only disabled when --no-recursive is set.
      const recursive = options.recursive !== false;

      // Attribution (WL-0MSKZ30SK007K9TO, F4): record who deleted the item(s)
      // and why, so the soft-delete carries real intent. The merge layer's
      // delete-side protection only propagates ATTRIBUTED deletes over a live
      // remote item — an unattributed delete would silently fail to propagate.
      const deletedBy = await getConfiguredUserEmail();
      const deleteReason = 'deleted via wl delete';

      const results: DeleteResult[] = [];
      const seen = new Set<string>();

      for (const rawId of ids) {
        const normalizedId = utils.normalizeCliId(rawId, options.prefix) || rawId;
        const idLookup = normalizedId.toUpperCase();

        // Deduplicate repeated ids in the same invocation so an item is never
        // processed (and never deleted) twice.
        if (seen.has(idLookup)) {
          results.push({
            id: normalizedId,
            success: true,
            skipped: true,
            skippedReason: 'duplicate id in this invocation',
            message: `Skipped work item: ${normalizedId} (duplicate id in this invocation)`,
          });
          continue;
        }
        seen.add(idLookup);

        const existing = db.get(idLookup);
        if (!existing) {
          const message = `Work item not found: ${normalizedId}`;
          results.push({ id: normalizedId, success: false, error: message, message });
          continue;
        }

        // Already deleted — most commonly because an earlier id in this batch
        // deleted it recursively as a descendant. Report coherently as a skip
        // rather than a hard error.
        if (existing.status === 'deleted') {
          results.push({
            id: normalizedId,
            success: true,
            skipped: true,
            skippedReason: 'already deleted',
            deletedId: normalizedId,
            deletedWorkItem: existing,
            recursive,
            message: `Skipped work item: ${normalizedId} (already deleted)`,
          });
          continue;
        }

        // Get descendants before deletion for reporting.
        const children = recursive ? db.getDescendants(idLookup) : [];
        const childrenCount = children.length;

        const deleted = db.delete(idLookup, recursive, { deletedBy, deleteReason });
        if (!deleted) {
          const message = `Work item not found: ${normalizedId}`;
          results.push({ id: normalizedId, success: false, error: message, message });
          continue;
        }

        const message = childrenCount > 0
          ? `Deleted work item: ${normalizedId} and ${childrenCount} descendant(s)`
          : `Deleted work item: ${normalizedId}`;
        const result: DeleteResult = {
          id: normalizedId,
          success: true,
          message,
          deletedId: normalizedId,
          deletedWorkItem: existing,
          recursive,
        };
        if (childrenCount > 0) {
          result.deletedDescendantsCount = childrenCount;
          result.deletedDescendants = children.map(c => ({ id: c.id, title: c.title }));
        }
        results.push(result);
      }

      const deletedCount = results.filter(r => r.success && !r.skipped).length;
      const failedCount = results.filter(r => !r.success).length;
      const anyFailures = failedCount > 0;

      if (isJsonMode) {
        if (results.length === 1) {
          // Preserve the legacy single-id JSON shape (deletedId,
          // deletedWorkItem, recursive) for existing consumers/tests, adding
          // the batch summary fields additively.
          const r = results[0];
          if (r.success) {
            const jsonOut: Record<string, any> = {
              success: true,
              message: r.message,
              deletedId: r.deletedId ?? r.id,
              deletedWorkItem: r.deletedWorkItem,
              recursive: r.recursive ?? recursive,
            };
            if (r.skipped) jsonOut.skipped = true;
            if (r.skippedReason) jsonOut.skippedReason = r.skippedReason;
            if (r.deletedDescendantsCount !== undefined) {
              jsonOut.deletedDescendantsCount = r.deletedDescendantsCount;
              jsonOut.deletedDescendants = r.deletedDescendants;
            }
            jsonOut.deleted = deletedCount;
            jsonOut.failed = failedCount;
            jsonOut.results = results;
            output.json(jsonOut);
          } else {
            output.json({
              success: false,
              error: r.error,
              deleted: deletedCount,
              failed: failedCount,
              results,
            });
          }
        } else {
          output.json({ success: !anyFailures, deleted: deletedCount, failed: failedCount, results });
        }
      } else {
        for (const r of results) {
          if (r.success) {
            console.log(r.message ?? `Deleted work item: ${r.id}`);
          } else {
            console.error(r.error ?? `Failed to delete work item: ${r.id}`);
          }
        }
      }

      // Auto-sync once, after every id in this invocation has been processed.
      // Skip when --no-sync is set or when nothing was actually deleted.
      const skipSync = (options as any).sync === false || (options as any).noSync === true;
      if (!skipSync && deletedCount > 0) {
        try {
          const config = utils.getConfig();
          const defaults = getSyncDefaults(config || undefined);
          await performSync(
            dataPath,
            utils.getDatabase,
            {
              file: dataPath,
              prefix: options.prefix,
              gitRemote: defaults.gitRemote,
              gitBranch: defaults.gitBranch,
              push: true,
              dryRun: false,
              silent: true,
              isJsonMode,
              isVerbose: false,
            }
          );
        } catch (syncError) {
          // Sync failure must not abort the delete - the deletions are already
          // committed locally. Log a warning so the user can manually sync.
          const message = syncError instanceof Error
            ? syncError.message
            : String(syncError);
          console.error(`Warning: auto-sync after delete failed: ${message}`);
        }
      }

      if (anyFailures) process.exit(1);
      }),
    );
}
