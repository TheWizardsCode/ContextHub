/**
 * Next command - Find the next work item to work on
 */
import { humanFormatWorkItem, resolveFormat, formatTitleAndId } from './helpers.js';
import { theme } from '../theme.js';
import { normalizeActionArgs } from './cli-utils.js';
import { loadStatusStageRules } from '../status-stage-rules.js';
import { extractFilePaths } from './helpers.js';
import { assignItemGroups, compareGroupedItems } from './grouping.js';
import { invalidateCacheForWrite } from '../read-cache-cli.js';
export default function register(ctx) {
    const { program, output, utils } = ctx;
    const VALID_RECENCY_POLICIES = new Set(['prefer', 'avoid', 'ignore']);
    program
        .command('next')
        .description('Find the next work item to work on based on priority and status (excludes dependency-blocked items by default)')
        .option('-a, --assignee <assignee>', 'Filter by assignee')
        .option('--stage <stage>', 'Filter by stage (idea, intake_complete, plan_complete, in_progress, in_review, done)')
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
        .action(async (...rawArgs) => {
        // Normalize incoming args: commander may pass a Command instance
        const normalized = normalizeActionArgs(rawArgs, ['assignee', 'stage', 'search', 'number', 'prefix', 'includeBlocked', 'includeInProgress', 'reSort', 'reSortSync', 'recencyPolicy', 'groups', 'risk', 'effort']);
        let options = normalized.options || {};
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
                output.error(`Invalid stage: "${options.stage}". Valid stages are: ${rules.stageValues.filter((s) => s !== '').join(', ')}`, { success: false, error: `Invalid stage: "${options.stage}"` });
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
        const shouldReSort = !((options.noReSort === true) || (options.reSort === false) || cliNoReSort);
        if (shouldReSort) {
            const recencyPolicy = (options.recencyPolicy || 'ignore').toLowerCase();
            if (!VALID_RECENCY_POLICIES.has(recencyPolicy)) {
                output.error('recency-policy must be one of: prefer, avoid, ignore', { success: false, error: 'recency-policy must be one of: prefer, avoid, ignore' });
                process.exit(1);
            }
            try {
                if (typeof db.reSort === 'function') {
                    if (options.reSortSync) {
                        const result = db.reSort(recencyPolicy);
                        // The re-sort is a DB write: bump the read-cache state counter
                        // so cached `next` results reflect the re-sorted order.
                        if (result?.updated > 0)
                            invalidateCacheForWrite();
                    }
                    else {
                        void Promise.resolve()
                            .then(() => db.reSort(recencyPolicy))
                            .then((result) => {
                            if (result?.updated > 0)
                                invalidateCacheForWrite();
                        })
                            .catch(() => { });
                    }
                }
            }
            catch (_e) { }
        }
        const results = db.findNextWorkItems
            ? db.findNextWorkItems(count, options.assignee, options.search, includeBlocked, options.stage, includeInProgress, options.risk, options.effort)
            : [db.findNextWorkItem(options.assignee, options.search, includeBlocked, options.stage, includeInProgress, options.risk, options.effort)];
        const availableResults = results.filter((result) => Boolean(result.workItem));
        const missingCount = Math.max(0, count - availableResults.length);
        const note = missingCount > 0
            ? `Only ${availableResults.length} of ${count} requested work item(s) available.`
            : '';
        // ── Grouping logic (only when count > 1) ──────────────────────
        let groupsEnabled = false;
        let groupMap = null;
        if (count > 1) {
            const groupsOpt = parseInt(String(options.groups || '3'), 10);
            const maxGroups = Number.isNaN(groupsOpt) || groupsOpt < 1 ? 3 : groupsOpt;
            if (maxGroups > 0) {
                groupsEnabled = true;
                // Extract file paths and priority from each work item's description
                const groupableItems = availableResults.map((result) => ({
                    id: result.workItem.id,
                    stage: result.workItem.stage,
                    filePaths: extractFilePaths(result.workItem.description || ''),
                    priority: result.workItem.priority,
                }));
                groupMap = assignItemGroups(groupableItems, maxGroups);
            }
        }
        if (utils.isJsonMode()) {
            // Pre-compute child counts for the full item set so we can enrich
            // each work item with the number of direct children in O(1) per item
            // instead of N+1 queries.
            const childCounts = db.getChildCounts();
            // Enrich each work item with audit result data from the dedicated table.
            // This is needed so consumers (e.g. Pi TUI extension) can show the
            // correct audit icon (✅/❌/❓) without an extra round-trip per item.
            const enrichWorkItem = (wi) => {
                if (!wi)
                    return wi;
                const auditResult = db.getAuditResult(wi.id);
                const childCount = childCounts.get(wi.id) ?? 0;
                return { ...wi, auditResult: auditResult?.readyToClose ?? null, auditedAt: auditResult?.auditedAt ?? null, childCount };
            };
            if (count === 1) {
                const single = results[0];
                const enrichedItem = single.workItem ? enrichWorkItem(single.workItem) : single.workItem;
                output.json({ success: true, workItem: enrichedItem, reason: single.reason });
                return;
            }
            const enrichedResults = availableResults.map((result) => {
                const assignment = groupMap?.get(result.workItem.id);
                return {
                    ...result,
                    workItem: result.workItem ? enrichWorkItem(result.workItem) : result.workItem,
                    ...(assignment ? { group: assignment.group, groupLabel: assignment.groupLabel } : {}),
                };
            });
            const sortByGroup = (a, b) => {
                return compareGroupedItems(groupMap, {
                    id: a.workItem?.id,
                    stage: a.workItem?.stage,
                    priority: a.workItem?.priority,
                    filePaths: [],
                }, {
                    id: b.workItem?.id,
                    stage: b.workItem?.stage,
                    priority: b.workItem?.priority,
                    filePaths: [],
                });
            };
            if (groupsEnabled && groupMap) {
                enrichedResults.sort(sortByGroup);
            }
            output.json({
                success: true,
                count: enrichedResults.length,
                requested: count,
                results: enrichedResults,
                workItems: enrichedResults,
                ...(note ? { note } : {})
            });
            return;
        }
        if (!availableResults || availableResults.length === 0) {
            console.log('No work items found to work on.');
            if (note)
                console.log(theme.text.muted(`Note: ${note}`));
            return;
        }
        const chosenFormat = resolveFormat(program);
        if (availableResults.length === 1) {
            const result = availableResults[0];
            if (!result.workItem) {
                console.log('No work items found to work on.');
                if (result.reason)
                    console.log(`Reason: ${result.reason}`);
                if (note)
                    console.log(theme.text.muted(`Note: ${note}`));
                return;
            }
            console.log('');
            const reasonText = result.reason.replace(/\b[A-Z]+-[A-Z0-9]+\b/g, (match) => {
                const referenced = db.get(match);
                return referenced ? `"${referenced.title}" (${match})` : match;
            });
            console.log(humanFormatWorkItem(result.workItem, db, chosenFormat));
            console.log(`\n${theme.text.muted('## Reason for Selection')}`);
            console.log(theme.text.muted(reasonText));
            console.log('');
            console.log(`${theme.text.muted('ID')}: ${theme.text.muted(result.workItem.id)}`);
            if (note)
                console.log(theme.text.muted(`Note: ${note}`));
            return;
        }
        console.log(`\nNext ${availableResults.length} work item(s) to work on:`);
        if (note)
            console.log(theme.text.muted(`Note: ${note}`));
        console.log('===============================\n');
        // Sort by group for display (groups first, then within groups by stage
        // sub-order and priority).
        const displayResults = [...availableResults];
        if (groupsEnabled && groupMap) {
            displayResults.sort((a, b) => compareGroupedItems(groupMap, {
                id: a.workItem?.id,
                stage: a.workItem?.stage,
                priority: a.workItem?.priority,
                filePaths: [],
            }, {
                id: b.workItem?.id,
                stage: b.workItem?.stage,
                priority: b.workItem?.priority,
                filePaths: [],
            }));
        }
        let lastGroup = null;
        displayResults.forEach((res, _idx) => {
            if (!res.workItem) {
                return;
            }
            // Render group heading if this item is in a new group
            if (groupsEnabled && groupMap) {
                const assignment = groupMap.get(res.workItem.id);
                const currentGroup = assignment?.group ?? 0;
                if (currentGroup !== lastGroup) {
                    console.log(theme.text.strong(`── ${assignment?.groupLabel ?? `Group ${currentGroup}`} ──`));
                    console.log('');
                    lastGroup = currentGroup;
                }
            }
            if (chosenFormat === 'concise') {
                console.log(`${formatTitleAndId(res.workItem)}`);
                // Display stage even when it's an empty string (map to 'Undefined').
                const _stage = res.workItem.stage;
                const stageLabel = _stage === undefined ? undefined : (_stage === '' ? 'Undefined' : _stage);
                if (stageLabel !== undefined) {
                    console.log(`   Status: ${res.workItem.status} · Stage: ${stageLabel} | Priority: ${res.workItem.priority}`);
                }
                else {
                    console.log(`   Status: ${res.workItem.status} | Priority: ${res.workItem.priority}`);
                }
                if (res.workItem.assignee)
                    console.log(`   Assignee: ${res.workItem.assignee}`);
                if (res.workItem.parentId)
                    console.log(`   Parent: ${res.workItem.parentId}`);
                if (res.workItem.description)
                    console.log(`   ${res.workItem.description}`);
                console.log(`   Reason: ${theme.text.info(res.reason)}`);
                console.log('');
            }
            else {
                console.log(humanFormatWorkItem(res.workItem, db, chosenFormat));
                console.log(`Reason: ${theme.text.info(res.reason)}`);
                console.log('');
            }
        });
    });
}
//# sourceMappingURL=next.js.map