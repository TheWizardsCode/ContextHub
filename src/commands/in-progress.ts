/**
 * In-progress command - List all in-progress work items
 */

import type { PluginContext } from '../plugin-types.js';
import type { InProgressOptions } from '../cli-types.js';
import type { WorkItemQuery, WorkItemStatus } from '../types.js';
import { displayItemTree, humanFormatWorkItem, resolveFormat, sortByPriorityAndDate } from './helpers.js';
import { markNotStarted, resolveNotStartedFilter } from '../not-started.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('in-progress')
    .alias('in_progress')
    .description('List all in-progress work items in a tree layout showing hierarchy')
    .option('-a, --assignee <assignee>', 'Filter by assignee')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((options: InProgressOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      
      const query: WorkItemQuery = { status: ['in-progress' as WorkItemStatus] };
      if (options.assignee) {
        query.assignee = options.assignee;
      }
      const items = db.list(query);

      // `in_progress` is never filtered by `startOn`: a started item has
      // already started, even when its scheduled instant lies in the future
      // (WL-0MWMGET8N009KG33). The read still *marks* such rows, so an operator
      // can see why an in-progress item is not yet dispatchable.
      const markedItems = markNotStarted(items, resolveNotStartedFilter());

      if (utils.isJsonMode()) {
        // Enrich each work item with audit result data from the dedicated table.
        const auditMap = new Map<string, { readyToClose: boolean; auditedAt: string | null }>();
        const allAudits = db.getAllAuditResults();
        for (const ar of allAudits) {
          auditMap.set(ar.workItemId, { readyToClose: ar.readyToClose, auditedAt: ar.auditedAt ?? null });
        }
        const enrichedItems = markedItems.map(item => {
          const audit = auditMap.get(item.id);
          return {
            ...item,
            auditResult: audit ? audit.readyToClose : null,
            auditedAt: audit ? audit.auditedAt : null,
          };
        });
        output.json({ success: true, count: enrichedItems.length, workItems: enrichedItems });
      } else {
        if (items.length === 0) {
          console.log('No in-progress work items found');
          return;
        }
        
        console.log(`\nFound ${items.length} in-progress work item(s):\n`);
        const format = resolveFormat(program);
        if (format.toLowerCase() === 'concise') {
          displayItemTree(markedItems);
          console.log();
          return;
        }

        const sortedItems = markedItems.slice().sort(sortByPriorityAndDate);
        sortedItems.forEach((item, index) => {
          console.log(humanFormatWorkItem(item, null, format));
          if (index < sortedItems.length - 1) console.log('');
        });
        console.log();
      }
    });
}
