/**
 * `wl doctor foreign-items` subcommand.
 *
 * Single responsibility: register the `foreign-items` subcommand, which
 * reports work items whose ID prefix does not match the project prefix and —
 * only with the explicit `--apply` opt-in — hard-deletes them, optionally
 * rewriting and force-pushing the remote worklog ref so it contains own items
 * only. Report construction and the cascading cleanup live in
 * `src/doctor/foreign-items-check.ts`; this module owns the CLI contract
 * (flags, the `--apply`/`--push` safety gate, JSON/human rendering and the
 * mutation lock).
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW084MT9006M7MC, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import type { WorklogDatabase } from '../../database.js';
import type { WorklogConfig } from '../../types.js';
import { buildForeignItemReport, applyForeignItemCleanup } from '../../doctor/foreign-items-check.js';
import { rewriteAndForcePushDataFile } from '../../sync.js';
import { getSyncDefaults } from '../sync.js';
import { withFileLock, getLockPathForJsonl } from '../../file-lock.js';
import { withStoreMutationLock } from '../../mutation-lock.js';

/**
 * Narrow context the foreign-items subcommand needs from the CLI registrar —
 * never the full `PluginContext` surface.
 */
export interface ForeignItemsCommandContext {
  /** JSON payload emitter. */
  output: { json: (data: unknown) => void };
  /** Worklog data path, used to serialise the mutating run. */
  dataPath: string;
  utils: {
    /** Fail loudly when the worklog is not initialised. */
    requireInitialized: () => void;
    /** Read the project config (its `prefix` is the default expected prefix). */
    getConfig: () => WorklogConfig | null;
    /** Open the database, honouring the `--prefix` override. */
    getDatabase: (prefix?: string) => WorklogDatabase;
    /** Whether `--json` output mode was requested. */
    isJsonMode: () => boolean;
  };
}

/** Register the `wl doctor foreign-items` subcommand on the parent `doctor` command. */
export function registerForeignItemsCommand(doctor: Command, ctx: ForeignItemsCommandContext): void {
  const { output, dataPath, utils } = ctx;

  doctor
    .command('foreign-items')
    .description('Report work items whose ID prefix does not match the project prefix')
    .option('--dry-run', 'Show foreign items without modifying anything (default)')
    .option('--apply', 'Hard-delete foreign items from the database (destructive; requires explicit opt-in)')
    .option('--push', 'After --apply, rewrite and force-push the remote worklog ref so it contains only own items (destructive)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (opts: { dryRun?: boolean; apply?: boolean; push?: boolean; prefix?: string }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(opts.prefix);
      const config = utils.getConfig();
      // The parent `doctor` command also declares --prefix and captures it
      // for child commands; fall back to it when the child value is absent.
      const configuredPrefix = opts.prefix || doctor.opts().prefix || config?.prefix || 'WI';
      const allItems = db.getAll();

      const report = buildForeignItemReport(allItems, configuredPrefix, !opts.apply);

      // Safety: --push requires --apply. Rewriting the remote ref without
      // cleaning the DB would publish foreign items.
      if (opts.push && !opts.apply) {
        if (utils.isJsonMode()) {
          output.json({
            success: false,
            error: '--push requires --apply: the remote ref can only be rewritten after foreign items are removed from the database.',
          });
          return;
        }
        console.error('Doctor foreign-items: --push requires --apply (rewriting the remote ref without cleaning the DB would push foreign items).');
        process.exitCode = 1;
        return;
      }

      // Destructive path: hard-delete foreign items with full cascade.
      if (opts.apply) {
        const result = withStoreMutationLock(dataPath, () => applyForeignItemCleanup(db, report));

        // Optional remote ref rewrite: publish a clean JSONL (only own items)
        // to the project's worklog ref, bypassing the polluted remote history.
        let pushResult: string | null = null;
        if (opts.push) {
          const jsonlPath = await db.exportForSync();
          const lockPath = getLockPathForJsonl(jsonlPath);
          const defaults = getSyncDefaults(config || undefined);
          const gitTarget = {
            remote: defaults.gitRemote,
            branch: defaults.gitBranch,
          };
          pushResult = await withFileLock(lockPath, async () => {
            const tipSha = await rewriteAndForcePushDataFile(
              jsonlPath,
              'Rewrite worklog ref: remove foreign items',
              gitTarget
            );
            // The rewritten ref is a full clean snapshot — advance the
            // per-type watermarks so the next sync runs an incremental delta
            // from this baseline (WL-0MT2KY0RQ008F50Q AC5: advance only after
            // a successful push).
            const now = new Date().toISOString();
            db.markLastExportTimestamps({
              workitems: now,
              comments: now,
              edges: now,
              audit_results: now,
            });
            db.setDeltaSyncMetadata(0, 0);
            // Ephemeral JSONL pattern: remove the local file after a successful push.
            try { db.deleteLocalJsonl(); } catch (_) { /* best-effort */ }
            return tipSha;
          });
        }

        if (utils.isJsonMode()) {
          if (opts.push) {
            output.json({ ...result, push: true, pushRef: getSyncDefaults(config || undefined).gitBranch, pushSha: pushResult });
          } else {
            output.json(result);
          }
          return;
        }
        console.log(`Doctor foreign-items: removed ${result.removedCount} foreign item(s) (total: ${result.totalBefore} -> ${result.totalAfter}; own: ${result.ownBefore} -> ${result.ownAfter}).`);
        if (result.removedIds.length > 0) {
          console.log('Removed IDs:');
          for (const id of result.removedIds) {
            console.log(`  - ${id}`);
          }
        }
        if (opts.push) {
          console.log(`Rewrote ${getSyncDefaults(config || undefined).gitBranch} (${pushResult}) with own items only.`);
        }
        if (result.errors.length > 0) {
          console.log(`\n${result.errors.length} error(s):`);
          for (const e of result.errors) {
            console.log(`  - ${e.id}: ${e.error}`);
          }
          process.exitCode = 1;
        }
        return;
      }

      if (utils.isJsonMode()) {
        output.json(report);
        return;
      }

      console.log(`Doctor foreign-items: ${report.totalItems} item(s) scanned, ${report.foreignCount} foreign item(s) (prefix: ${report.prefix}).`);
      if (report.foreignCount === 0) {
        console.log('No foreign items found.');
        return;
      }

      const prefixes = Object.keys(report.byPrefix).sort();
      for (const prefix of prefixes) {
        const group = report.byPrefix[prefix];
        console.log(`\n${prefix}: ${group.count} item(s) (${group.deleted} deleted, ${group.nonDeleted} non-deleted)`);
        for (const id of group.ids) {
          console.log(`  - ${id}`);
        }
      }
      console.log(`\nTotal: ${report.deletedForeignCount} deleted, ${report.nonDeletedForeignCount} non-deleted foreign item(s).`);
      console.log('Dry-run only; nothing was modified. Use --apply to hard-delete foreign items.');
    });
}
