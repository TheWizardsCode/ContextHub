/**
 * `wl doctor stage-sync` subcommand.
 *
 * Single responsibility: register the `stage-sync` subcommand, which scans the
 * store for known stale status/stage combinations and, with `--apply`, moves
 * each stale item to its corrected status/stage. Detection rules, the dry-run
 * report and the guarded mutation all live here; this module only owns the CLI
 * contract (options, JSON/human rendering and the mutation lock).
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW084OJQ006AL6M, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import type { WorklogDatabase } from '../../database.js';
import { withStoreMutationLock } from '../../mutation-lock.js';

/**
 * Narrow context the stage-sync subcommand needs from the CLI registrar —
 * never the full `PluginContext` surface.
 */
export interface StageSyncCommandContext {
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

/** Register the `wl doctor stage-sync` subcommand on the parent `doctor` command. */
export function registerStageSyncCommand(doctor: Command, ctx: StageSyncCommandContext): void {
  const { output, dataPath, utils } = ctx;

  doctor
    .command('stage-sync')
    .description('Detect and fix stale status/stage combinations')
    .option('--apply', 'Apply fixes for stale stage/status combinations')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (opts: { apply?: boolean; prefix?: string }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(opts.prefix);
      const allItems = db.getAll();

      // Known stale combinations and their fixes
      const staleRules: Array<{
        status: string;
        stage: string;
        fixStatus?: string;
        fixStage: string;
      }> = [
        { status: 'completed', stage: 'idea', fixStage: 'done' },
        { status: 'completed', stage: 'intake_complete', fixStage: 'done' },
        { status: 'completed', stage: 'plan_complete', fixStage: 'done' },
        { status: 'in-progress', stage: 'idea', fixStatus: 'open', fixStage: 'idea' },
      ];

      const staleItems: Array<{
        id: string;
        title: string;
        current: { status: string; stage: string };
        proposed: { status: string; stage: string };
      }> = [];

      for (const item of allItems) {
        for (const rule of staleRules) {
          if (item.status === rule.status && item.stage === rule.stage) {
            staleItems.push({
              id: item.id,
              title: item.title,
              current: { status: item.status, stage: item.stage },
              proposed: {
                status: rule.fixStatus ?? item.status,
                stage: rule.fixStage,
              },
            });
            break;
          }
        }
      }

      if (opts.apply) {
        // Apply fixes
        const fixed: Array<{ id: string; title: string; from: { status: string; stage: string }; to: { status: string; stage: string } }> = [];
        const errors: Array<{ id: string; error: string }> = [];

        withStoreMutationLock(dataPath, () => {
        for (const stale of staleItems) {
          try {
            const update: any = {};
            if (stale.proposed.status !== stale.current.status) {
              update.status = stale.proposed.status;
            }
            update.stage = stale.proposed.stage;

            db.update(stale.id, update);
            fixed.push({
              id: stale.id,
              title: stale.title,
              from: stale.current,
              to: stale.proposed,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ id: stale.id, error: message });
          }
        }
        });

        if (utils.isJsonMode()) {
          output.json({
            fixApplied: true,
            totalItems: allItems.length,
            staleCount: staleItems.length,
            fixedCount: fixed.length,
            fixed,
            skippedCount: staleItems.length - fixed.length,
            errors,
          });
          return;
        }

        console.log(`Doctor stage-sync: scanned ${allItems.length} item(s), found ${staleItems.length} stale combination(s).`);
        if (fixed.length > 0) {
          console.log(`Fixed ${fixed.length} item(s):`);
          for (const f of fixed) {
            console.log(`  - ${f.id}: ${f.title} (${f.from.status}/${f.from.stage} -> ${f.to.status}/${f.to.stage})`);
          }
        }
        if (errors.length > 0) {
          console.log(`\n${errors.length} error(s):`);
          for (const e of errors) {
            console.log(`  - ${e.id}: ${e.error}`);
          }
        }
        return;
      }

      // Dry-run mode (default)
      if (utils.isJsonMode()) {
        output.json({
          dryRun: true,
          totalItems: allItems.length,
          staleCount: staleItems.length,
          staleItems,
        });
        return;
      }

      if (staleItems.length === 0) {
        console.log(`Doctor stage-sync: no stale status/stage combinations found. (scanned ${allItems.length} item(s))`);
        return;
      }

      console.log(`Doctor stage-sync: found ${staleItems.length} stale status/stage combination(s) out of ${allItems.length} item(s).`);
      console.log('');
      for (const s of staleItems) {
        console.log(`  ${s.id}: ${s.title}`);
        console.log(`    current: ${s.current.status}/${s.current.stage}`);
        console.log(`    propose: ${s.proposed.status}/${s.proposed.stage}`);
      }
      console.log('');
      console.log('Use --apply to fix stale items automatically.');
    });
}
