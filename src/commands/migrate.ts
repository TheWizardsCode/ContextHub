/**
 * Migrate command - database migrations for Worklog
 */

import type { PluginContext } from '../plugin-types.js';
import type { MigrateOptions } from '../cli-types.js';
import { importFromJsonl } from '../jsonl.js';
import { mergeWorkItems, mergeComments, mergeAuditResults } from '../sync.js';
import * as fs from 'fs';

const DEFAULT_SORT_GAP = 100;

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  const migrate = program
    .command('migrate')
    .description('Run Worklog database migrations');

  migrate
    .command('sort-index')
    .alias('sort_index')
    .description('Add sort_index values based on existing next-item ordering')
    .option('--dry-run', 'Preview changes without writing to the database')
    .option('--gap <gap>', `Gap between sort_index values (default: ${DEFAULT_SORT_GAP})`, String(DEFAULT_SORT_GAP))
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((options: MigrateOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const dryRun = Boolean(options.dryRun);
      const gap = parseInt(options.gap || String(DEFAULT_SORT_GAP), 10);

      if (Number.isNaN(gap) || gap <= 0) {
        output.error('Gap must be a positive integer', { success: false, error: 'Gap must be a positive integer' });
        process.exit(1);
      }

      if (dryRun) {
        const ordered = db.previewSortIndexOrder(gap);
        if (utils.isJsonMode()) {
          output.json({ success: true, dryRun: true, gap, count: ordered.length, items: ordered });
          return;
        }

        console.log(`Dry run: ${ordered.length} item(s) would be updated.`);
        ordered.forEach((entry: { id: string; title: string; sortIndex: number }) => {
          console.log(`${entry.id} ${entry.title} -> ${entry.sortIndex}`);
        });
        return;
      }

      const result = db.assignSortIndexValues(gap);
      if (utils.isJsonMode()) {
        output.json({ success: true, updated: result.updated, gap });
        return;
      }
      console.log(`Migration complete. Updated ${result.updated} item(s).`);
    });

  migrate
    .command('jsonl')
    .description('DEPRECATED: Use "wl doctor migrate" instead. Migrate from persistent JSONL to SQLite.')
    .option('-f, --file <filepath>', 'JSONL file path to migrate (default: .worklog/worklog-data.jsonl)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--delete', 'Delete JSONL file after successful migration')
    .action((options: MigrateOptions & { delete?: boolean }) => {
      if (!utils.isJsonMode()) {
        console.log('Note: The "wl migrate jsonl" command is deprecated.');
        console.log('Please use "wl doctor migrate" instead.\n');
      }
      
      utils.requireInitialized();
      const filePath = options.file || '.worklog/worklog-data.jsonl';
      
      if (!fs.existsSync(filePath)) {
        if (utils.isJsonMode()) {
          output.json({ success: true, message: 'No JSONL file found. Your data is already in SQLite format.', migrated: false });
        } else {
          console.log(`No JSONL file found at ${filePath}`);
          console.log('Your data is already in SQLite format. No migration needed.');
        }
        return;
      }

      const db = utils.getDatabase(options.prefix);
      
      try {
        const { items, comments, dependencyEdges, auditResults } = importFromJsonl(filePath);
        
        // Check if SQLite already has data
        const existingItems = db.getAll();
        const existingComments = db.getAllComments();
        const existingAudits = db.getAllAuditResults();
        
        if (existingItems.length > 0 || existingComments.length > 0) {
          // Merge instead of replace to preserve existing data
          const itemMergeResult = mergeWorkItems(existingItems, items);
          const commentMergeResult = mergeComments(existingComments, comments);
          const auditMergeResult = mergeAuditResults(existingAudits, auditResults);
          
          db.import(itemMergeResult.merged, dependencyEdges, auditMergeResult.merged);
          db.importComments(commentMergeResult.merged);
          
          if (utils.isJsonMode()) {
            output.json({
              success: true,
              message: `Merged ${items.length} work items, ${comments.length} comments, and ${auditResults.length} audit results from JSONL`,
              itemsImported: items.length,
              commentsImported: comments.length,
              auditImported: auditResults.length,
              itemsMerged: itemMergeResult.conflicts.length,
              file: filePath,
              migrated: true
            });
          } else {
            console.log(`Merged ${items.length} work items, ${comments.length} comments, and ${auditResults.length} audit results from ${filePath}`);
            if (itemMergeResult.conflicts.length > 0) {
              console.log(`Note: ${itemMergeResult.conflicts.length} items had conflicting updates and were merged.`);
            }
          }
        } else {
          // SQLite is empty, just import
          db.import(items, dependencyEdges, auditResults);
          db.importComments(comments);
          
          if (utils.isJsonMode()) {
            output.json({
              success: true,
              message: `Imported ${items.length} work items, ${comments.length} comments, and ${auditResults.length} audit results from JSONL`,
              itemsImported: items.length,
              commentsImported: comments.length,
              auditImported: auditResults.length,
              file: filePath,
              migrated: true
            });
          } else {
            console.log(`Imported ${items.length} work items, ${comments.length} comments, and ${auditResults.length} audit results from ${filePath}`);
          }
        }
        
        // Optionally delete the JSONL file
        if (options.delete) {
          fs.unlinkSync(filePath);
          if (!utils.isJsonMode()) {
            console.log(`\nDeleted JSONL file: ${filePath}`);
            console.log('\nMigration complete! Your data is now in SQLite format.');
            console.log('JSONL files will only be created temporarily during sync operations.');
          }
        } else {
          if (!utils.isJsonMode()) {
            console.log('\nMigration complete! Your data is now in SQLite format.');
            console.log('The JSONL file has been preserved.');
            console.log('To delete it and complete the migration, run:');
            console.log(`  wl doctor migrate --delete`);
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (utils.isJsonMode()) {
          output.json({ success: false, error: errorMessage, migrated: false });
        } else {
          console.error(`Migration failed: ${errorMessage}`);
          process.exit(1);
        }
      }
    });
}
