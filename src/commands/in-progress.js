/**
 * In-progress command - List all in-progress work items
 */
import { displayItemTree, humanFormatWorkItem, resolveFormat, sortByPriorityAndDate } from './helpers.js';
export default function register(ctx) {
    const { program, output, utils } = ctx;
    program
        .command('in-progress')
        .alias('in_progress')
        .description('List all in-progress work items in a tree layout showing hierarchy')
        .option('-a, --assignee <assignee>', 'Filter by assignee')
        .option('--prefix <prefix>', 'Override the default prefix')
        .action((options) => {
        utils.requireInitialized();
        const db = utils.getDatabase(options.prefix);
        const query = { status: ['in-progress'] };
        if (options.assignee) {
            query.assignee = options.assignee;
        }
        const items = db.list(query);
        if (utils.isJsonMode()) {
            // Enrich each work item with audit result data from the dedicated table.
            const auditMap = new Map();
            const allAudits = db.getAllAuditResults();
            for (const ar of allAudits) {
                auditMap.set(ar.workItemId, { readyToClose: ar.readyToClose, auditedAt: ar.auditedAt ?? null });
            }
            const enrichedItems = items.map(item => {
                const audit = auditMap.get(item.id);
                return {
                    ...item,
                    auditResult: audit ? audit.readyToClose : null,
                    auditedAt: audit ? audit.auditedAt : null,
                };
            });
            output.json({ success: true, count: enrichedItems.length, workItems: enrichedItems });
        }
        else {
            if (items.length === 0) {
                console.log('No in-progress work items found');
                return;
            }
            console.log(`\nFound ${items.length} in-progress work item(s):\n`);
            const format = resolveFormat(program);
            if (format.toLowerCase() === 'concise') {
                displayItemTree(items);
                console.log();
                return;
            }
            const sortedItems = items.slice().sort(sortByPriorityAndDate);
            sortedItems.forEach((item, index) => {
                console.log(humanFormatWorkItem(item, null, format));
                if (index < sortedItems.length - 1)
                    console.log('');
            });
            console.log();
        }
    });
}
//# sourceMappingURL=in-progress.js.map