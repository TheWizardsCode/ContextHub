/**
 * Delete command - Delete a work item
 *
 * By default, recursively deletes all child work items (descendants) first,
 * then marks the target item as deleted. Use --no-recursive to delete only
 * the specified item, leaving children orphaned.
 */

import type { PluginContext } from '../plugin-types.js';
import type { DeleteOptions } from '../cli-types.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('delete <id>')
    .description('Delete a work item (marks as deleted). Recursively deletes child items by default.')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--no-recursive', 'Delete only the specified item, leaving children orphaned')
    .action((id: string, options: DeleteOptions) => {
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
    });
}
