/**
 * Export command - Export work items and comments to JSONL file
 */
import { exportToJsonlAsync } from '../jsonl.js';
import { withFileLock, getLockPathForJsonl } from '../file-lock.js';
export default function register(ctx) {
    const { program, dataPath, output, utils } = ctx;
    program
        .command('export')
        .description('Export work items and comments to JSONL file')
        .option('-f, --file <filepath>', 'Output file path', dataPath)
        .option('--prefix <prefix>', 'Override the default prefix')
        .action(async (options) => {
        utils.requireInitialized();
        const filePath = options.file || dataPath;
        const lockPath = getLockPathForJsonl(filePath);
        await withFileLock(lockPath, async () => {
            const db = utils.getDatabase(options.prefix);
            const items = db.getAll();
            const comments = db.getAllComments();
            const dependencyEdges = db.getAllDependencyEdges();
            const progressHandler = (evt) => {
                if (utils.isJsonMode())
                    return;
                try {
                    if (evt.type === 'progress') {
                        const pct = typeof evt.percent === 'number' ? `${evt.percent}%` : '';
                        const itemsProcessed = typeof evt.itemsProcessed === 'number' ? ` ${evt.itemsProcessed} processed` : '';
                        process.stderr.write(`\rExporting JSONL: ${pct}${itemsProcessed}`);
                    }
                    else if (evt.type === 'done') {
                        process.stderr.write('\rExport complete.                      \n');
                    }
                    else if (evt.type === 'error') {
                        process.stderr.write('\rExport error: ' + (evt.error || 'unknown') + '\n');
                    }
                }
                catch { }
            };
            await exportToJsonlAsync(items, comments, filePath, dependencyEdges, [], { onProgress: progressHandler });
            if (utils.isJsonMode()) {
                output.json({
                    success: true,
                    message: `Exported ${items.length} work items and ${comments.length} comments`,
                    itemsCount: items.length,
                    commentsCount: comments.length,
                    file: options.file
                });
            }
            else {
                console.log(`Exported ${items.length} work items and ${comments.length} comments to ${filePath}`);
            }
        });
    });
}
//# sourceMappingURL=export.js.map