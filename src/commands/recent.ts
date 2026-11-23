/**
 * Recent command - List most recently changed work items
 */

import type { PluginContext } from '../plugin-types.js';
import type { RecentOptions } from '../cli-types.js';
import type { WorkItem } from '../types.js';
import { displayItemTreeWithFormat } from './helpers.js';
import {
  filterNotStarted,
  markNotStarted,
  resolveNotStartedFilterFromFlags,
  INCLUDE_NOT_STARTED_FLAG,
  STARTS_BEFORE_FLAG,
} from '../not-started.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('recent')
    .description('List most recently changed work items')
    .option('-n, --number <n>', 'Number of recent items to show', '3')
    .option('-c, --children', 'Also show children')
    .option(INCLUDE_NOT_STARTED_FLAG, 'Include items whose startOn is in the future (excluded by default)')
    .option(`${STARTS_BEFORE_FLAG} <iso>`, 'Include not-yet-started items starting before this ISO-8601 instant')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((options: RecentOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);

      let count = 3;
      const parsed = parseInt(options.number || '3', 10);
      if (!Number.isNaN(parsed) && parsed > 0) count = parsed;

      const notStartedFlags = resolveNotStartedFilterFromFlags(options);
      if (!notStartedFlags.ok) {
        output.error(notStartedFlags.message, {
          success: false,
          error: 'invalid-starts-before',
          message: notStartedFlags.message,
        });
        process.exit(1);
      }
      const notStarted = notStartedFlags.filter;

      // Filter *before* slicing the recency window: a hidden future-dated row
      // must not consume one of the `-n` slots (WL-0MWMGET8N009KG33).
      const all = filterNotStarted(
        db.getAll().filter(i => i.status !== 'deleted'),
        notStarted,
      );
      // Recency is activity-based: comment writes bump `activityAt` only, so
      // ordering on `updatedAt` would hide recently commented items. Falls
      // back to `updatedAt` for rows written before `activityAt` existed
      // (WL-0MUBVH6JM0093KVM).
      const activityMs = (i: WorkItem): number => new Date(i.activityAt ?? i.updatedAt).getTime();
      all.sort((a, b) => activityMs(b) - activityMs(a));

      const selected = all.slice(0, count);
      // Mark the items this read shows (JSON `notStarted: true`, text
      // `[not started until …]`).
      const markedSelected = markNotStarted(selected, notStarted);

      if (utils.isJsonMode()) {
        let itemsToOutput: any[] = markedSelected.slice();
        if (options.children) {
          const seen = new Set(itemsToOutput.map(i => i.id));
          for (const item of selected) {
            const desc = db.getDescendants(item.id);
            for (const d of desc) {
              if (!seen.has(d.id)) {
                seen.add(d.id);
                itemsToOutput.push(markNotStarted([d], notStarted)[0]);
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

      let itemsToDisplay: WorkItem[] = markedSelected.slice();
      if (options.children) {
        const seen = new Set(itemsToDisplay.map(i => i.id));
        for (const item of selected) {
          const desc = db.getDescendants(item.id);
          for (const d of desc) {
            if (!seen.has(d.id)) {
              seen.add(d.id);
              itemsToDisplay.push(markNotStarted([d], notStarted)[0]);
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
