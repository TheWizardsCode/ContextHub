/**
 * Recent command - List most recently changed work items
 */

import type { PluginContext } from '../plugin-types.js';
import type { RecentOptions } from '../cli-types.js';
import type { WorkItem } from '../types.js';
import { displayItemTreeWithFormat } from './helpers.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('recent')
    .description('List most recently changed work items')
    .option('-n, --number <n>', 'Number of recent items to show', '3')
    .option('-c, --children', 'Also show children')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((options: RecentOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);

      let count = 3;
      const parsed = parseInt(options.number || '3', 10);
      if (!Number.isNaN(parsed) && parsed > 0) count = parsed;

      const all = db.getAll().filter(i => i.status !== 'deleted');
      all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      const selected = all.slice(0, count);

      if (utils.isJsonMode()) {
        let itemsToOutput: any[] = selected.slice();
        if (options.children) {
          const seen = new Set(itemsToOutput.map(i => i.id));
          for (const item of selected) {
            const desc = db.getDescendants(item.id);
            for (const d of desc) {
              if (!seen.has(d.id)) {
                seen.add(d.id);
                itemsToOutput.push(d);
              }
            }
          }
        }
        // Enrich each work item with audit result data from the dedicated table.
        const auditMap = new Map<string, { readyToClose: boolean; auditedAt: string | null }>();
        const allAudits = db.getAllAuditResults();
        for (const ar of allAudits) {
          auditMap.set(ar.workItemId, { readyToClose: ar.readyToClose, auditedAt: ar.auditedAt ?? null });
        }
        const enrichedItems = itemsToOutput.map(item => {
          const audit = auditMap.get(item.id);
          return {
            ...item,
            auditResult: audit ? audit.readyToClose : null,
            auditedAt: audit ? audit.auditedAt : null,
          };
        });
        output.json({ success: true, count: selected.length, workItems: enrichedItems });
        return;
      }

      if (selected.length === 0) {
        console.log('No recent work items found');
        return;
      }

      console.log(`\nFound ${selected.length} recent work item(s):\n`);

      let itemsToDisplay: WorkItem[] = selected.slice();
      if (options.children) {
        const seen = new Set(itemsToDisplay.map(i => i.id));
        for (const item of selected) {
          const desc = db.getDescendants(item.id);
          for (const d of desc) {
            if (!seen.has(d.id)) {
              seen.add(d.id);
              itemsToDisplay.push(d);
            }
          }
        }
      }

      console.log('');
      // Use the human formatter so recent output includes the audit summary
      // (concise format by default).
      displayItemTreeWithFormat(itemsToDisplay, db, 'concise');
      console.log('');
    });
}
