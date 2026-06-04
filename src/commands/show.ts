/**
 * Show command - Show details of a work item
 */

import type { PluginContext } from '../plugin-types.js';
import type { ShowOptions } from '../cli-types.js';
import type { WorkItem, Comment, ShowJsonOutput } from '../types.js';
import { displayItemTree, displayItemTreeWithFormat, displayItemTreeWithFormatToString, humanFormatComment, resolveFormat, humanFormatWorkItem } from './helpers.js';
import pageOutput from '../pager.js';
import { createCliOutputFromCommand } from '../cli-output.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('show <id>')
    .description('Show details of a work item')
    .option('-c, --children', 'Also show children')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--no-pager', 'Disable interactive paging even in a TTY')
    .action((id: string, options: ShowOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      
      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;
      const item = db.get(normalizedId);
      if (!item) {
        // Use the CLI output renderer for stderr when available so errors
        // look consistent with other CLI output in TTY. In JSON mode we
        // skip the human-formatted stderr output to keep stderr machine-
        // readable and rely on output.error to emit structured JSON.
        const cliOut = createCliOutputFromCommand(program.opts(), utils.getConfig() ?? undefined);
        if (!program.opts().json) {
          cliOut.printError(`Work item not found: ${normalizedId}`);
        }
        // Signal JSON consumers with structured error via output.error
        output.error(`Work item not found: ${normalizedId}`, { success: false, error: `Work item not found: ${normalizedId}` });
        process.exit(1);
      }
      
      if (utils.isJsonMode()) {
        // Prepare JSON-safe copies that omit the `audit` field when absent.
        // Keep the audit object verbatim when present so JSON consumers can
        // rely on the structured { time, author, text } shape.
        // Additionally, include structured audit_result data from the new table.
        const stripAudit = (src: WorkItem) => {
          const copy: any = Object.assign({}, src);
          if (copy.audit === undefined || copy.audit === null) delete copy.audit;
          return copy as WorkItem;
        };

        const auditResult = db.getAuditResult(normalizedId);

        const result: ShowJsonOutput = { success: true, workItem: stripAudit(item) };
        // Include structured audit result from the dedicated table
        (result as any).auditResult = auditResult;

        result.comments = db.getCommentsForWorkItem(normalizedId) as Comment[];
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

      // Build the full human output into a string so we can decide whether to
      // pipe it through a pager (TTY) or write straight to stdout (non-TTY).
      let finalOutput = '';

      if (options.children) {
        const itemsToDisplay = [item, ...db.getDescendants(normalizedId)];

        // Render the tree into a string (keeps same formatting as before)
        finalOutput += '\n';
        finalOutput += displayItemTreeWithFormatToString(itemsToDisplay, db, chosenFormat);
        finalOutput += '\n\n';

        // For non-full formats, also show comments for the root item (legacy behavior)
        if (chosenFormat !== 'full') {
          const comments = db.getCommentsForWorkItem(normalizedId);
          if (comments.length > 0) {
            finalOutput += 'Comments:\n';
            comments.forEach(c => {
              finalOutput += humanFormatComment(c, chosenFormat) + '\n\n';
            });
          }
        }

        const noPagerFlag = Boolean((options as any).noPager === true || (options as any).pager === false);
        pageOutput(finalOutput, { noPager: noPagerFlag });
        return;
      }

      finalOutput += '\n';
      finalOutput += displayItemTreeWithFormatToString([item], db, chosenFormat);

      const noPagerFlag = Boolean((options as any).noPager === true || (options as any).pager === false);
      pageOutput(finalOutput, { noPager: noPagerFlag });
    });
}
