/**
 * `wl doctor migrate` subcommand.
 *
 * Single responsibility: register the `migrate` subcommand, which imports a
 * persistent JSONL snapshot into SQLite (merging into existing rows when the
 * database is not empty) and optionally deletes the JSONL file afterwards.
 * JSONL parsing and merge semantics are delegated to `src/jsonl.ts` and
 * `src/sync.js`; this module only owns the CLI contract (options, JSON/human
 * rendering, the guarded mutation and the failure exit code).
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW084KKS003X4TJ, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import type { WorklogDatabase } from '../../database.js';
import { importFromJsonl } from '../../jsonl.js';
import { mergeWorkItems, mergeComments, mergeAuditResults } from '../../sync.js';
import { withStoreMutationLock } from '../../mutation-lock.js';

/**
 * Narrow context the migrate subcommand needs from the CLI registrar — never
 * the full `PluginContext` surface.
 */
export interface MigrateCommandContext {
  /** JSON payload emitter. */
  output: { json: (data: unknown) => void };
  /** Worklog data path, used to serialise the mutating run. */
  dataPath: string;
  utils: {
    /** Fail loudly when the worklog is not initialised. */
    requireInitialized: () => void;
    /** Open the database, honouring the `--prefix` override. */
    getDatabase: (prefix?: string) => WorklogDatabase;
    /** Whether `--json` output mode was requested. */
    isJsonMode: () => boolean;
  };
}

/** Register the `wl doctor migrate` subcommand on the parent `doctor` command. */
export function registerMigrateCommand(doctor: Command, ctx: MigrateCommandContext): void {
  const { output, dataPath, utils } = ctx;

  doctor
    .command('migrate')
    .description('Migrate from persistent JSONL to SQLite-only architecture (ephemeral JSONL pattern)')
    .option('-f, --file <filepath>', 'JSONL file path to migrate (default: .worklog/worklog-data.jsonl)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--delete', 'Delete JSONL file after successful migration')
    .action(async (opts: { file?: string; prefix?: string; delete?: boolean }) => {
      utils.requireInitialized();
      const filePath = opts.file || path.join('.worklog', 'worklog-data.jsonl');
      
      // Check if JSONL file exists
      if (!fs.existsSync(filePath)) {
        if (utils.isJsonMode()) {
          output.json({ success: true, message: 'No JSONL file found. Your data is already in SQLite format.', migrated: false });
        } else {
          console.log('Doctor: No JSONL file found at ' + filePath);
          console.log('Your data is already in SQLite format. No migration needed.');
        }
        return;
      }

      const db = utils.getDatabase(opts.prefix);
      
      try {
        // Get counts before migration
        const itemsBefore = db.getAll().length;
        const commentsBefore = db.getAllComments().length;
        
        // Import JSONL data
        const { items, comments, dependencyEdges, auditResults } = importFromJsonl(filePath);
        
        // Check if SQLite already has data
        if (itemsBefore > 0 || commentsBefore > 0) {
          // Merge instead of replace to preserve existing data
          const localItems = db.getAll();
          const localComments = db.getAllComments();
          const localAudits = db.getAllAuditResults();
          
          const itemMergeResult = mergeWorkItems(localItems, items);
          const commentMergeResult = mergeComments(localComments, comments);
          const auditMergeResult = mergeAuditResults(localAudits, auditResults);
          
          withStoreMutationLock(dataPath, () => {
            db.import(itemMergeResult.merged, dependencyEdges, auditMergeResult.merged);
            db.importComments(commentMergeResult.merged);
          });
          
          if (utils.isJsonMode()) {
            output.json({
              success: true,
              message: `Merged ${items.length} work items, ${comments.length} comments, and ${auditResults.length} audit results from JSONL`,
              itemsImported: items.length,
              commentsImported: comments.length,
              auditImported: auditResults.length,
              itemsMerged: itemMergeResult.conflicts.length,
              file: filePath,
              itemsBefore,
              itemsAfter: db.getAll().length,
              commentsBefore,
              commentsAfter: db.getAllComments().length,
              migrated: true
            });
          } else {
            console.log(`Doctor: Merged ${items.length} work items, ${comments.length} comments, and ${auditResults.length} audit results from ${filePath}`);
            if (itemMergeResult.conflicts.length > 0) {
              console.log(`Note: ${itemMergeResult.conflicts.length} items had conflicting updates and were merged.`);
            }
            console.log(`Database now contains ${db.getAll().length} work items, ${db.getAllComments().length} comments, and ${db.getAllAuditResults().length} audit results.`);
          }
        } else {
          // SQLite is empty, just import
          withStoreMutationLock(dataPath, () => {
            db.import(items, dependencyEdges, auditResults);
            db.importComments(comments);
          });
          
          if (utils.isJsonMode()) {
            output.json({
              success: true,
              message: `Imported ${items.length} work items, ${comments.length} comments, and ${auditResults.length} audit results from JSONL`,
              itemsImported: items.length,
              commentsImported: comments.length,
              auditImported: auditResults.length,
              file: filePath,
              itemsBefore: 0,
              itemsAfter: items.length,
              commentsBefore: 0,
              commentsAfter: comments.length,
              migrated: true
            });
          } else {
            console.log(`Doctor: Imported ${items.length} work items, ${comments.length} comments, and ${auditResults.length} audit results from ${filePath}`);
          }
        }
        
        // Optionally delete the JSONL file
        if (opts.delete) {
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
          console.error(`Doctor migrate failed: ${errorMessage}`);
        }
        process.exit(1);
      }
    });
}
