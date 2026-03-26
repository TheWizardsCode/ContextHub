/**
 * Show command - Show details of a work item
 */

import type { PluginContext } from '../plugin-types.js';
import type { ShowOptions } from '../cli-types.js';
import type { WorkItem } from '../types.js';
import { displayItemTree, displayItemTreeWithFormat, humanFormatComment, resolveFormat, humanFormatWorkItem } from './helpers.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('show <id>')
    .description('Show details of a work item')
    .option('-c, --children', 'Also show children')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((id: string, options: ShowOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      
      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;
      const item = db.get(normalizedId);
      if (!item) {
        output.error(`Work item not found: ${normalizedId}`, { success: false, error: `Work item not found: ${normalizedId}` });
        process.exit(1);
      }
      
      if (utils.isJsonMode()) {
        // Prepare JSON-safe copies that omit the `audit` field when absent
        const stripAudit = (src: WorkItem) => {
          // shallow copy - preserve other fields
          const copy: any = Object.assign({}, src);
          // If audit is undefined or null, delete the property so JSON output
          // omits the key entirely per our API contract.
          if (copy.audit === undefined || copy.audit === null) delete copy.audit;
          return copy;
        };

        const result: any = { success: true, workItem: stripAudit(item) };
        result.comments = db.getCommentsForWorkItem(normalizedId);
        if (options.children) {
           const children = db.getDescendants(normalizedId).map(stripAudit);
           const ancestors: any[] = [];
          let currentParentId = item.parentId;
          while (currentParentId) {
            const parent = db.get(currentParentId);
            if (!parent) break;
            ancestors.push(stripAudit(parent));
            currentParentId = parent.parentId;
          }
          result.children = children;
          result.ancestors = ancestors;
        }
        output.json(result);
        return;
      }

      const chosenFormat = resolveFormat(program);

      if (options.children) {
        const itemsToDisplay = [item, ...db.getDescendants(normalizedId)];

        console.log('');
        // Always show a tree with hierarchy markers; the per-item formatting
        // is controlled by `chosenFormat` so `-F full` will include comments
        // inline for each item while concise/normal stay compact.
        displayItemTreeWithFormat(itemsToDisplay, db, chosenFormat);
        console.log('');

        // For non-full formats, also show comments for the root item (legacy behavior)
        if (chosenFormat !== 'full') {
          const comments = db.getCommentsForWorkItem(normalizedId);
          if (comments.length > 0) {
            console.log('Comments:');
            comments.forEach(c => {
              console.log(humanFormatComment(c, chosenFormat));
              console.log('');
            });
          }
        }
        return;
      }
      console.log('');
      // For single-item show, display as a tree (preserves the same visual
      // layout used when showing children). This ensures a consistent
      // hierarchy marker is present even for a single item in human mode.
      displayItemTreeWithFormat([item], db, chosenFormat);
    });
}
