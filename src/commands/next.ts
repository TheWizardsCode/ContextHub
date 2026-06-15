/**
 * Next command - Find the next work item to work on
 */

import type { PluginContext } from '../plugin-types.js';
import { humanFormatWorkItem, resolveFormat, formatTitleAndId } from './helpers.js';
import { theme } from '../theme.js';
import { normalizeActionArgs } from './cli-utils.js';
import { loadStatusStageRules } from '../status-stage-rules.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  const VALID_RECENCY_POLICIES = new Set(['prefer', 'avoid', 'ignore']);

  program
    .command('next')
    .description('Find the next work item to work on based on priority and status (excludes dependency-blocked items by default)')
    .option('-a, --assignee <assignee>', 'Filter by assignee')
    .option('--stage <stage>', 'Filter by stage (idea, intake_complete, plan_complete, in_progress, in_review, done)')
    .option('--search <term>', 'Search term for fuzzy matching against title, description, and comments')
    .option('-n, --number <n>', 'Number of items to return (default: 1)', '1')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--include-blocked', 'Include dependency-blocked items (excluded by default)')
    .option('--no-re-sort', 'Skip the automatic re-sort before selection (preserve current sortIndex order)')
    .option('--re-sort-sync', 'Force a synchronous re-sort when auto re-sort is run (blocks until complete)', false)
    .option('--recency-policy <policy>', 'Recency handling for score ordering during re-sort (prefer|avoid|ignore). Default: ignore', 'ignore')
    .action(async (...rawArgs: any[]) => {
      // Normalize incoming args: commander may pass a Command instance
      const normalized = normalizeActionArgs(rawArgs, ['assignee', 'stage', 'search', 'number', 'prefix', 'includeBlocked', 'reSort', 'reSortSync', 'recencyPolicy']);
      let options: any = normalized.options || {};
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
       const numRequested = parseInt(options.number || '1', 10);
      const count = Number.isNaN(numRequested) || numRequested < 1 ? 1 : numRequested;

      const includeBlocked = Boolean(options.includeBlocked);

      // Validate stage if provided
      if (options.stage) {
        const rules = loadStatusStageRules(utils.getConfig());
        const normalizedStage = options.stage.toLowerCase().trim().replace(/-/g, '_');
        if (!rules.stageValues.includes(normalizedStage)) {
          output.error(`Invalid stage: "${options.stage}". Valid stages are: ${rules.stageValues.filter((s: string) => s !== '').join(', ')}`, { success: false, error: `Invalid stage: "${options.stage}"` });
          process.exit(1);
        }
        options.stage = normalizedStage;
      }

      // Auto re-sort unless --no-re-sort is passed. Commander exposes
      // the flag as `reSort: false` (for --no-re-sort) in some contexts
      // and some callers/tools may surface `noReSort` instead. Accept
      // either form for robustness.
      // Also check raw process.argv for `--no-re-sort` to handle variations in
      // how commander/normalizeActionArgs may expose the flag in different
      // invocation contexts (spawned vs in-process). This makes the behavior
      // robust in tests and CI where option names can vary.
      const cliNoReSort = process.argv.includes('--no-re-sort') || process.argv.includes('--noReSort');
      const shouldReSort = !(((options as any).noReSort === true) || (options.reSort === false) || cliNoReSort);
      if (shouldReSort) {
        const recencyPolicy = (options.recencyPolicy || 'ignore').toLowerCase();
        if (!VALID_RECENCY_POLICIES.has(recencyPolicy)) {
          output.error('recency-policy must be one of: prefer, avoid, ignore', { success: false, error: 'recency-policy must be one of: prefer, avoid, ignore' });
          process.exit(1);
        }
        try {
          if (typeof (db as any).reSort === 'function') {
            if (options.reSortSync) (db as any).reSort(recencyPolicy as 'prefer' | 'avoid' | 'ignore');
            else void Promise.resolve().then(() => (db as any).reSort(recencyPolicy as 'prefer' | 'avoid' | 'ignore'));
          }
        } catch (_e) {}
      }

      const results = (db as any).findNextWorkItems 
        ? (db as any).findNextWorkItems(count, options.assignee, options.search, includeBlocked, options.stage) 
        : [db.findNextWorkItem(options.assignee, options.search, includeBlocked, options.stage)];

      const availableResults = results.filter((result: any) => Boolean(result.workItem));
      const missingCount = Math.max(0, count - availableResults.length);
      const note = missingCount > 0
        ? `Only ${availableResults.length} of ${count} requested work item(s) available.`
        : '';

      if (utils.isJsonMode()) {
        // Pre-compute child counts for the full item set so we can enrich
        // each work item with the number of direct children in O(1) per item
        // instead of N+1 queries.
        const childCounts = db.getChildCounts();

        // Enrich each work item with audit result data from the dedicated table.
        // This is needed so consumers (e.g. Pi TUI extension) can show the
        // correct audit icon (✅/❌/❓) without an extra round-trip per item.
        const enrichWorkItem = (wi: any) => {
          if (!wi) return wi;
          const auditResult = db.getAuditResult(wi.id);
          const childCount = childCounts.get(wi.id) ?? 0;
          return { ...wi, auditResult: auditResult?.readyToClose ?? null, childCount };
        };

        if (count === 1) {
          const single = results[0];
          const enrichedItem = single.workItem ? enrichWorkItem(single.workItem) : single.workItem;
          output.json({ success: true, workItem: enrichedItem, reason: single.reason });
          return;
        }

        const enrichedResults = availableResults.map((result: any) => ({
          ...result,
          workItem: result.workItem ? enrichWorkItem(result.workItem) : result.workItem,
        }));

        output.json({
          success: true,
          count: enrichedResults.length,
          requested: count,
          results: enrichedResults,
          ...(note ? { note } : {})
        });
        return;
      }

      if (!availableResults || availableResults.length === 0) {
        console.log('No work items found to work on.');
        if (note) console.log(theme.text.muted(`Note: ${note}`));
        return;
      }

      const chosenFormat = resolveFormat(program);
      if (availableResults.length === 1) {
        const result = availableResults[0];
        if (!result.workItem) {
          console.log('No work items found to work on.');
          if (result.reason) console.log(`Reason: ${result.reason}`);
          if (note) console.log(theme.text.muted(`Note: ${note}`));
          return;
        }

        console.log('');
        const reasonText = result.reason.replace(/\b[A-Z]+-[A-Z0-9]+\b/g, (match: string) => {
          const referenced = db.get(match);
          return referenced ? `"${referenced.title}" (${match})` : match;
        });
        console.log(humanFormatWorkItem(result.workItem, db, chosenFormat));
        console.log(`\n${theme.text.muted('## Reason for Selection')}`);
        console.log(theme.text.muted(reasonText));
        console.log('');
        console.log(`${theme.text.muted('ID')}: ${theme.text.muted(result.workItem.id)}`);
        if (note) console.log(theme.text.muted(`Note: ${note}`));
        return;
      }

      console.log(`\nNext ${availableResults.length} work item(s) to work on:`);
      if (note) console.log(theme.text.muted(`Note: ${note}`));
      console.log('===============================\n');
      availableResults.forEach((res: any, idx: number) => {
        if (!res.workItem) {
          console.log(`${idx + 1}. (no item) - ${res.reason}`);
          return;
        }
        if (chosenFormat === 'concise') {
          console.log(`${idx + 1}. ${formatTitleAndId(res.workItem)}`);
          // Display stage even when it's an empty string (map to 'Undefined').
          const _stage = (res.workItem.stage as string | undefined);
          const stageLabel = _stage === undefined ? undefined : (_stage === '' ? 'Undefined' : _stage);
          if (stageLabel !== undefined) {
            console.log(`   Status: ${res.workItem.status} · Stage: ${stageLabel} | Priority: ${res.workItem.priority}`);
          } else {
            console.log(`   Status: ${res.workItem.status} | Priority: ${res.workItem.priority}`);
          }
          if (res.workItem.assignee) console.log(`   Assignee: ${res.workItem.assignee}`);
          if (res.workItem.parentId) console.log(`   Parent: ${res.workItem.parentId}`);
          if (res.workItem.description) console.log(`   ${res.workItem.description}`);
          console.log(`   Reason: ${theme.text.info(res.reason)}`);
          console.log('');
        } else {
          console.log(`${idx + 1}.`);
          console.log(humanFormatWorkItem(res.workItem, db, chosenFormat));
          console.log(`Reason: ${theme.text.info(res.reason)}`);
          console.log('');
        }
      });
    });
}
