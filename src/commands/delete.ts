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
import type { DeleteOptions } from '../cli-types.js';
import { performSync, getSyncDefaults } from './sync.js';

export default function register(ctx: PluginContext): void {
  const { program, dataPath, output, utils } = ctx;
  
  program
    .command('delete <id>')
    .description('Delete a work item (marks as deleted). Recursively deletes child items by default.')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--no-recursive', 'Delete only the specified item, leaving children orphaned')
    .option('--no-sync', 'Skip auto-sync after deletion')
    .action(async (id: string, options: DeleteOptions & { sync?: boolean }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      
      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;
      const idLookup = normalizedId.toUpperCase();
      const existing = db.get(idLookup);
      
      if (!existing) {
        output.error(`Work item not found: ${normalizedId}`, { success: false, error: `Work item not found: ${normalizedId}` });
        process.exit(1);
      }

      // Determine if recursive (default: true when --no-recursive is not set)
      const recursive = options.recursive !== false;
      
      // Get descendants before deletion for reporting
      const children = recursive ? db.getDescendants(idLookup) : [];
      const childrenCount = children.length;
      
      const deleted = db.delete(idLookup, recursive);
      if (!deleted) {
        output.error(`Work item not found: ${normalizedId}`, { success: false, error: `Work item not found: ${normalizedId}` });
        process.exit(1);
      }
      
      if (utils.isJsonMode()) {
        const result: Record<string, any> = {
          success: true,
          message: childrenCount > 0
            ? `Deleted work item: ${normalizedId} and ${childrenCount} descendant(s)`
            : `Deleted work item: ${normalizedId}`,
          deletedId: normalizedId,
          deletedWorkItem: existing,
          recursive,
        };
        if (childrenCount > 0) {
          result.deletedDescendantsCount = childrenCount;
          result.deletedDescendants = children.map(c => ({ id: c.id, title: c.title }));
        }
        output.json(result);
      } else {
        if (childrenCount > 0) {
          console.log(`Deleted work item: ${normalizedId} and ${childrenCount} descendant(s)`);
        } else {
          console.log(`Deleted work item: ${normalizedId}`);
        }
      }

      // Auto-sync after delete: push the deleted state to remote so it can't
      // be restored by a subsequent sync from another agent.
      // Sync runs exactly once after all deletions in this invocation, and
      // failures are logged but do not cause the delete to fail.
      const skipSync = (options as any).sync === false || (options as any).noSync === true;
      if (!skipSync) {
        try {
          const config = utils.getConfig();
          const defaults = getSyncDefaults(config || undefined);
          const isJsonMode = utils.isJsonMode();
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
          // Sync failure must not abort the delete - the deletion is already
          // committed locally. Log a warning so the user can manually sync.
          const message = syncError instanceof Error
            ? syncError.message
            : String(syncError);
          console.error(`Warning: auto-sync after delete failed: ${message}`);
        }
      }
    });
}
