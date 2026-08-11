/**
 * Import command - Import work items and comments from JSONL file
 */
import { importFromJsonl } from '../jsonl.js';
import { withFileLock, getLockPathForJsonl } from '../file-lock.js';
export default function register(ctx) {
    const { program, dataPath, output, utils } = ctx;
    program
        .command('import')
        .description('Import work items and comments from JSONL file')
        .option('-f, --file <filepath>', 'Input file path', dataPath)
        .option('--prefix <prefix>', 'Override the default prefix')
        .action((options) => {
        utils.requireInitialized();
        const filePath = options.file || dataPath;
        const lockPath = getLockPathForJsonl(filePath);
        withFileLock(lockPath, () => {
            const db = utils.getDatabase(options.prefix);
            const { items, comments, dependencyEdges, auditResults } = importFromJsonl(filePath);
            // SAFETY: db.import() is destructive (clears all items before inserting).
            // This is intentional here — the import command replaces the entire
            // database with the contents of the JSONL file.
            db.import(items, dependencyEdges, auditResults);
            db.importComments(comments);
            if (utils.isJsonMode()) {
                output.json({
                    success: true,
                    message: `Imported ${items.length} work items, ${comments.length} comments, and ${auditResults.length} audit results`,
                    itemsCount: items.length,
                    commentsCount: comments.length,
                    auditCount: auditResults.length,
                    file: options.file
                });
            }
            else {
                console.log(`Imported ${items.length} work items, ${comments.length} comments, and ${auditResults.length} audit results from ${filePath}`);
            }
        });
    });
}
//# sourceMappingURL=import.js.map