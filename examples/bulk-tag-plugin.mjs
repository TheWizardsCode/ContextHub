/**
 * Example Plugin: Bulk Tag Operations
 * 
 * This plugin demonstrates:
 * - Bulk operations on work items
 * - Filtering by status
 * - Updating multiple items
 * - Using output helpers
 * 
 * Installation:
 * Copy this file to .worklog/plugins/bulk-tag.mjs
 */

export default function register(ctx) {
  ctx.program
    .command('bulk-tag')
    .description('Add a tag to multiple work items')
    .requiredOption('-t, --tag <tag>', 'Tag to add')
    .requiredOption('-s, --status <status>', 'Status to filter by')
    .option('--prefix <prefix>', 'Override prefix')
    .action((options) => {
      ctx.utils.requireInitialized();
      const db = ctx.utils.getDatabase(options.prefix);
      
      const items = db.getAll().filter(i => i.status === options.status);
      let updated = 0;
      
      items.forEach(item => {
        if (!item.tags.includes(options.tag)) {
          const tags = [...item.tags, options.tag];
          db.update(item.id, { tags });
          updated++;
        }
      });
      
      ctx.output.success(
        `Tagged ${updated} items with "${options.tag}"`,
        { success: true, updated, total: items.length }
      );
    });
}
