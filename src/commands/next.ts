/**
 * Next command - Find the next work item to work on
 */

import type { PluginContext } from '../plugin-types.js';
import { humanFormatWorkItem, resolveFormat, formatTitleAndId } from './helpers.js';
import { theme } from '../theme.js';
import { normalizeActionArgs } from './cli-utils.js';
import { loadStatusStageRules } from '../status-stage-rules.js';
import { selectBrowseFeed } from '../worklist-selection.js';
import { invalidateCacheForWrite } from '../read-cache-cli.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  const VALID_RECENCY_POLICIES = new Set(['prefer', 'avoid', 'ignore']);

  program
    .command('next')
    .description('Find the next work item to work on based on priority and status (excludes dependency-blocked items by default)')
    .option('-a, --assignee <assignee>', 'Filter by assignee')
    .option('--stage <stage>', 'Filter by stage (idea, intake_complete, plan_complete, in_review, done)')
    .option('--risk <level>', 'Filter by risk level, at-most semantics (low, medium, high, severe). Items with unset risk never match.')
    .option('--effort <level>', 'Filter by effort level, at-most semantics (xs/extra-small, s/small, m/medium, l/large, xl/extra-large). Items with unset effort never match.')
    .option('--search <term>', 'Search term for fuzzy matching against title, description, and comments')
    .option('-n, --number <n>', 'Number of items to return (default: 1)', '1')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--include-blocked', 'Include dependency-blocked items (excluded by default)')
    .option('--include-in-progress', 'Include in-progress items alongside open items')
    .option('--no-re-sort', 'Skip the automatic re-sort before selection (preserve current sortIndex order)')
    .option('--re-sort-sync', 'Force a synchronous re-sort when auto re-sort is run (blocks until complete)', false)
    .option('--recency-policy <policy>', 'Recency handling for score ordering during re-sort (prefer|avoid|ignore). Default: ignore', 'ignore')
    .option('-g, --groups <n>', 'Number of parallel-safe groups to identify (default: 3, only meaningful when -n > 1)', '3')
    .action(async (...rawArgs: any[]) => {
      // Normalize incoming args: commander may pass a Command instance
      const normalized = normalizeActionArgs(rawArgs, ['assignee', 'stage', 'search', 'number', 'prefix', 'includeBlocked', 'includeInProgress', 'reSort', 'reSortSync', 'recencyPolicy', 'groups', 'risk', 'effort']);
      let options: any = normalized.options || {};
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
       const numRequested = parseInt(options.number || '1', 10);
      const count = Number.isNaN(numRequested) || numRequested < 1 ? 1 : numRequested;

      const includeBlocked = Boolean(options.includeBlocked);
      const includeInProgress = Boolean(options.includeInProgress);

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

      // Validate risk/effort levels (at-most ordinal filters). Invalid levels
      // fail closed at the CLI boundary — the shared filterCandidates pipeline
      // also fails closed (matches nothing) as a belt-and-suspenders guard.
      const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high', 'severe', 'critical']);
      const VALID_EFFORT_LEVELS = new Set(['xs', 'extra-small', 'extrasmall', 's', 'small', 'm', 'medium', 'l', 'large', 'xl', 'extra-large', 'extralarge']);
      if (options.risk) {
        const normalizedRisk = options.risk.toLowerCase().trim();
        if (!VALID_RISK_LEVELS.has(normalizedRisk)) {
          output.error(`Invalid risk: "${options.risk}". Valid levels: low, medium, high, severe, critical.`, { success: false, error: `Invalid risk: "${options.risk}"` });
          process.exit(1);
        }
      }
      if (options.effort) {
        const normalizedEffort = options.effort.toLowerCase().trim().replace(/\s+/g, '-');
        if (!VALID_EFFORT_LEVELS.has(normalizedEffort)) {
          output.error(`Invalid effort: "${options.effort}". Valid levels: xs/extra-small, s/small, m/medium, l/large, xl/extra-large.`, { success: false, error: `Invalid effort: "${options.effort}"` });
          process.exit(1);
        }
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
            if (options.reSortSync) {
              const result = (db as any).reSort(recencyPolicy as 'prefer' | 'avoid' | 'ignore');
              // The re-sort is a DB write: bump the read-cache state counter
              // so cached `next` results reflect the re-sorted order.
              if (result?.updated > 0) invalidateCacheForWrite();
            } else {
              void Promise.resolve()
                .then(() => (db as any).reSort(recencyPolicy as 'prefer' | 'avoid' | 'ignore'))
                .then((result: any) => {
                  if (result?.updated > 0) invalidateCacheForWrite();
                })
                .catch(() => {});
            }
          }
        } catch (_e) {}
      }

      // Selection, grouping and enrichment are shared with the consolidated
      // `wl worklist` read so both commands produce the identical browse feed
      // (WL-0MVI0HX58009JJRF). `selectBrowseFeed` is a pure read — the auto
      // re-sort above remains the only write byproduct of `next`.
      const selection = selectBrowseFeed(db, {
        count,
        assignee: options.assignee,
        search: options.search,
        stage: options.stage,
        risk: options.risk,
        effort: options.effort,
        includeBlocked,
        includeInProgress,
        groups: parseInt(String(options.groups || '3'), 10),
      });

      if (utils.isJsonMode()) {
        if (count === 1) {
          const single = selection.results[0];
          output.json({ success: true, workItem: single?.workItem ?? null, reason: single?.reason ?? '' });
          return;
        }

        output.json({
          success: true,
          count: selection.items.length,
          requested: count,
          results: selection.items,
          workItems: selection.items,
          ...(selection.note ? { note: selection.note } : {})
        });
        return;
      }

      const availableResults = selection.items;
      if (!availableResults || availableResults.length === 0) {
        console.log('No work items found to work on.');
        if (selection.note) console.log(theme.text.muted(`Note: ${selection.note}`));
        return;
      }

      const chosenFormat = resolveFormat(program);
      if (availableResults.length === 1) {
        const result = availableResults[0];
        if (!result.workItem) {
          console.log('No work items found to work on.');
          if (result.reason) console.log(`Reason: ${result.reason}`);
          if (selection.note) console.log(theme.text.muted(`Note: ${selection.note}`));
          return;
        }

        console.log('');
        const reasonText = (result.reason ?? '').replace(/\b[A-Z]+-[A-Z0-9]+\b/g, (match: string) => {
          const referenced = db.get(match);
          return referenced ? `"${referenced.title}" (${match})` : match;
        });
        console.log(humanFormatWorkItem(result.workItem, db, chosenFormat));
        console.log(`\n${theme.text.muted('## Reason for Selection')}`);
        console.log(theme.text.muted(reasonText));
        console.log('');
        console.log(`${theme.text.muted('ID')}: ${theme.text.muted(result.workItem.id)}`);
        if (selection.note) console.log(theme.text.muted(`Note: ${selection.note}`));
        return;
      }

      console.log(`\nNext ${availableResults.length} work item(s) to work on:`);
      if (selection.note) console.log(theme.text.muted(`Note: ${selection.note}`));
      console.log('===============================\n');

      let lastGroup: number | null = null;
      availableResults.forEach((res: any, _idx: number) => {
        if (!res.workItem) {
          return;
        }

        // Render group heading if this item is in a new group. The shared
        // selection already assigned groups and applied the group sort.
        if (selection.groupsEnabled && typeof res.group === 'number') {
          const currentGroup = res.group;
          if (currentGroup !== lastGroup) {
            console.log(theme.text.strong(`── ${res.groupLabel ?? `Group ${currentGroup}`} ──`));
            console.log('');
            lastGroup = currentGroup;
          }
        }

        if (chosenFormat === 'concise') {
          console.log(`${formatTitleAndId(res.workItem)}`);
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
          console.log(humanFormatWorkItem(res.workItem, db, chosenFormat));
          console.log(`Reason: ${theme.text.info(res.reason)}`);
          console.log('');
        }
      });
    });
}
