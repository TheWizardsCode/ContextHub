/**
 * `wl doctor prune` subcommand.
 *
 * Single responsibility: register the `prune` subcommand, which hard-deletes
 * soft-deleted work items older than an age threshold (with `--dry-run` to
 * preview), skipping items linked to GitHub whose local state is newer than
 * the last recorded GitHub state so issues are never orphaned. Candidate
 * selection and the guarded deletion live here; this module only owns the
 * CLI contract (options, JSON/human rendering and the mutation lock).
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW084GHU009FV66, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import type { WorklogDatabase } from '../../database.js';
import { withStoreMutationLock } from '../../mutation-lock.js';

/**
 * Narrow context the prune subcommand needs from the CLI registrar — never
 * the full `PluginContext` surface.
 */
export interface PruneCommandContext {
  /** JSON payload emitter. */
  output: { json: (data: unknown) => void };
  /** Worklog data directory, used to serialise the mutating run. */
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

/** Register the `wl doctor prune` subcommand on the parent `doctor` command. */
export function registerPruneCommand(doctor: Command, ctx: PruneCommandContext): void {
  const { output, dataPath, utils } = ctx;

  doctor
    .command('prune')
    .description('Prune soft-deleted work items older than a specified age')
    .option('--days <n>', 'Age threshold in days (items with updatedAt older than this will be pruned)', '30')
    .option('--dry-run', 'Show which items would be pruned without deleting them')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (opts: { days?: string; dryRun?: boolean; prefix?: string }) => {
      utils.requireInitialized();
      try {
        const days = Math.max(0, parseInt(String(opts.days ?? '30'), 10) || 0);
        const db = utils.getDatabase(opts.prefix);

        const now = Date.now();
        const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).getTime();

        const all = db.getAll();
        const candidates = all.filter(i => i.status === 'deleted').filter(i => {
          const ts = i.updatedAt ? Date.parse(i.updatedAt) : Date.parse(i.createdAt);
          return !Number.isNaN(ts) && ts < cutoff;
        });

        // Skip items that are linked to GitHub and appear to have local changes
        // newer than the last recorded GitHub state. This prevents orphaning
        // GitHub issues by deleting items that have local updates not yet
        // reflected on GitHub.
        const skippedIds: string[] = [];
        const prunable = candidates.filter(i => {
          if (i.githubIssueNumber !== undefined && i.githubIssueNumber !== null) {
            const localTs = i.updatedAt ? Date.parse(i.updatedAt) : Date.parse(i.createdAt);
            const ghTs = i.githubIssueUpdatedAt ? Date.parse(i.githubIssueUpdatedAt) : 0;
            if (!Number.isNaN(localTs) && !Number.isNaN(ghTs) && localTs > ghTs) {
              skippedIds.push(i.id);
              return false;
            }
          }
          return true;
        });

        const ids = prunable.map(c => c.id);

        if (opts.dryRun) {
          if (utils.isJsonMode()) {
            output.json({ dryRun: true, candidates: ids, skippedIds, count: ids.length });
            return;
          }
          console.log(`Prune dry-run: ${ids.length} deleted item(s) older than ${days} day(s)`);
          ids.forEach(id => console.log(` - ${id}`));
          if (skippedIds.length > 0) {
            console.log('Skipped (linked to GitHub with newer local changes):');
            skippedIds.forEach(id => console.log(` - ${id}`));
          }
          return;
        }

        // Perform deletions against the persistent store. Use internal store
        // deleteWorkItem to perform a hard-delete (removes dependency edges and comments).
        const pruned: string[] = [];
        const storeAny = (db as any).store;
        await withStoreMutationLock(dataPath, async () => {
        for (const id of ids) {
          try {
            if (storeAny && typeof storeAny.deleteWorkItem === 'function') {
              const ok = storeAny.deleteWorkItem(id);
              if (ok) {
                // Also remove any lingering dependency edges/comments via store helpers
                try { storeAny.deleteDependencyEdgesForItem(id); } catch (_) {}
                pruned.push(id);
              }
            } else if (typeof (db as any).delete === 'function') {
              // Fall back to WorklogDatabase.delete() which marks item as deleted
              const ok = await Promise.resolve((db as any).delete(id));
              if (ok) pruned.push(id);
            } else {
              console.error('Unable to perform prune: persistent store delete method not found');
              break;
            }
          } catch (err) {
            // Continue with other deletions but report error
            console.error(`Failed to prune ${id}: ${(err instanceof Error) ? err.message : String(err)}`);
          }
        }
        });

        if (utils.isJsonMode()) {
          output.json({ dryRun: false, prunedIds: pruned, skippedIds, count: pruned.length });
          return;
        }

        console.log(`Pruned ${pruned.length} work item(s).`);
        if (pruned.length > 0) {
          console.log('Pruned IDs:');
          pruned.forEach(id => console.log(` - ${id}`));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (utils.isJsonMode()) output.json({ success: false, error: message });
        else console.error(`Doctor prune failed: ${message}`);
      }
    });
}
