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
    .option('--no-icons', 'Disable icon rendering for clean text output')
    .option('--exact', 'Force strict exact-match (skip substring fallback)')
    .action((id: string, options: ShowOptions) => {
      // Apply --no-icons flag by setting env var before any icon functions are called
      if (options.icons === false) {
        process.env.WL_NO_ICONS = '1';
      }
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      
      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;
      let item: WorkItem | null = null;

      if (options.exact) {
        // Strict exact-match: only normalize + db.get, no fallback.
        item = db.get(normalizedId);
      } else {
        // Tolerant resolution: exact first, then unique substring.
        item = db.get(normalizedId);
        if (!item) {
          const lower = normalizedId.toLowerCase();
          const allItems = db.getAll();
          const matches = allItems.filter(i => i.id.toLowerCase().includes(lower));
          if (matches.length === 1) {
            item = matches[0];
          } else if (matches.length > 1) {
            // Ambiguous match
            if (program.opts().json) {
              output.error('Ambiguous work item ID', {
                success: false,
                error: 'ambiguous-match',
                candidates: matches.map(m => m.id),
              });
            } else {
              const cliOut = createCliOutputFromCommand(program.opts(), utils.getConfig() ?? undefined);
              cliOut.printError(
                `Ambiguous work item ID: "${normalizedId}" matches ${matches.length} item(s):\n` +
                matches.map(m => `  - ${m.id}`).join('\n') +
                '\nHint: use a longer prefix, or specify the exact ID.'
              );
            }
            process.exit(1);
          }
          // If matches.length === 0, fall through to "not found" below.
        }
      }

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
        // Include structured audit_result data from the dedicated table.
        // The legacy `audit` field on WorkItem is no longer used.
        // Note: item.id may differ from normalizedId when the item was
        // resolved via the tolerant substring fallback, so all follow-up
        // lookups use the resolved item's id.
        const auditResult = db.getAuditResult(item.id);

        const result: ShowJsonOutput = { success: true, workItem: item };
        // Include structured audit result from the dedicated table
        (result as any).auditResult = auditResult;
        // For backwards compatibility, also populate workItem.audit from audit_results
        if (auditResult) {
          (result.workItem as any).audit = {
            time: auditResult.auditedAt,
            author: auditResult.author,
            text: auditResult.summary,
            status: auditResult.readyToClose ? 'Complete' : 'Partial',
          };
        }

        result.comments = db.getCommentsForWorkItem(item.id) as Comment[];
        if (options.children) {
           const children = db.getDescendants(item.id);
           const ancestors: any[] = [];
          let currentParentId = item.parentId;
          while (currentParentId) {
            const parent = db.get(currentParentId);
            if (!parent) break;
            ancestors.push(parent);
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
        const itemsToDisplay = [item, ...db.getDescendants(item.id)];

        // Render the tree into a string (keeps same formatting as before)
        finalOutput += '\n';
        finalOutput += displayItemTreeWithFormatToString(itemsToDisplay, db, chosenFormat);
        finalOutput += '\n\n';

        // For non-full formats, also show comments for the root item (legacy behavior)
        if (chosenFormat !== 'full') {
          const comments = db.getCommentsForWorkItem(item.id);
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
