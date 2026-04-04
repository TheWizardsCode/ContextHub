/**
 * Export command - Export work items and comments to JSONL file
 */

import type { PluginContext } from '../plugin-types.js';
import type { ExportOptions } from '../cli-types.js';
import { exportToJsonlAsync } from '../jsonl.js';
import { withFileLock, getLockPathForJsonl } from '../file-lock.js';

export default function register(ctx: PluginContext): void {
  const { program, dataPath, output, utils } = ctx;
  
  program
    .command('export')
    .description('Export work items and comments to JSONL file')
    .option('-f, --file <filepath>', 'Output file path', dataPath)
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (options: ExportOptions) => {
      utils.requireInitialized();
      const filePath = options.file || dataPath;
      const lockPath = getLockPathForJsonl(filePath);
      await withFileLock(lockPath, async () => {
        const db = utils.getDatabase(options.prefix);
        const items = db.getAll();
        const comments = db.getAllComments();
        const dependencyEdges = db.getAllDependencyEdges();
        await exportToJsonlAsync(items, comments, filePath, dependencyEdges);
        
        if (utils.isJsonMode()) {
          output.json({ 
            success: true, 
            message: `Exported ${items.length} work items and ${comments.length} comments`,
            itemsCount: items.length,
            commentsCount: comments.length,
            file: options.file
          });
        } else {
          console.log(`Exported ${items.length} work items and ${comments.length} comments to ${filePath}`);
        }
      });
    });
}
