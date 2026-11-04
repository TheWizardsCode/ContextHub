/**
 * `wl doctor upgrade` subcommand.
 *
 * Single responsibility: register the `upgrade` subcommand, which previews
 * (`--dry-run`) or applies (`--confirm`) pending database schema migrations
 * and outdated git hooks. Migration listing/execution and hook inspection are
 * delegated to `src/migrations/` and `src/doctor/hook-upgrade.js`; this module
 * only owns the CLI contract (options, JSON/human rendering, the interactive
 * confirmation prompt, the guarded mutation and the failure exit code).
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW084QD9008A1K8, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import { listPendingMigrations, runMigrations } from '../../migrations/index.js';
import { dryRunHooks, upgradeHooks, detectHooksTargetDir } from '../../doctor/hook-upgrade.js';
import { withStoreMutationLock } from '../../mutation-lock.js';

/**
 * Narrow context the upgrade subcommand needs from the CLI registrar — never
 * the full `PluginContext` surface.
 */
export interface UpgradeCommandContext {
  /** JSON payload emitter. */
  output: { json: (data: unknown) => void };
  /** Worklog data directory, used to serialise the mutating run. */
  dataPath: string;
  utils: {
    /** Fail loudly when the worklog is not initialised. */
    requireInitialized: () => void;
    /** Whether `--json` output mode was requested. */
    isJsonMode: () => boolean;
  };
}

/** Register the `wl doctor upgrade` subcommand on the parent `doctor` command. */
export function registerUpgradeCommand(doctor: Command, ctx: UpgradeCommandContext): void {
  const { output, utils, dataPath } = ctx;

  doctor
    .command('upgrade')
    .description('Preview or apply pending database schema migrations and outdated git hooks')
    .option('--dry-run', 'Preview pending migrations and outdated hooks without applying them')
    .option('--confirm', 'Apply pending migrations and outdated hooks (non-interactive)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (opts: { dryRun?: boolean; confirm?: boolean; prefix?: string }) => {
      // Migration + hook upgrade subcommand
      utils.requireInitialized();
      try {
        const pending = listPendingMigrations();
        const hooksTargetDir = detectHooksTargetDir();
        const hooksResult = dryRunHooks('.githooks', hooksTargetDir);

        const hasPendingMigrations = pending && pending.length > 0;
        const hasOutdatedHooks = hooksResult.outdatedCount > 0;

        if (!hasPendingMigrations && !hasOutdatedHooks) {
          if (utils.isJsonMode()) {
            output.json({ success: true, pending: [], hooks: hooksResult });
            return;
          }
          console.log('Doctor: no pending migrations. See docs/migrations.md for migration policy and guidance.');
          console.log('Doctor: all installed hooks are up-to-date.');
          return;
        }

        if (opts.dryRun) {
          if (utils.isJsonMode()) {
            const out: any = {
              success: true,
              dryRun: true,
              pending: hasPendingMigrations ? pending : [],
              hooks: hooksResult,
            };
            output.json(out);
            return;
          }
          // Dry-run: list all pending migrations
          if (hasPendingMigrations) {
            console.log('Pending migrations:');
            pending.forEach(p => console.log(` - ${p.id}: ${p.description} (safe=${p.safe})`));
          }
          // List outdated hooks
          if (hasOutdatedHooks) {
            console.log('');
            console.log('Outdated hooks:');
            hooksResult.hooks
              .filter(h => h.status === 'outdated')
              .forEach(h => console.log(` - ${h.name} at ${h.hookPath}`));
          }
          if (!hasOutdatedHooks && hasPendingMigrations) {
            console.log('');
            console.log('Doctor: all installed hooks are up-to-date.');
          }
          return;
        }

        // Not a dry-run: list safe migrations and outdated hooks, ask to apply
        const safeMigs = pending ? pending.filter(p => p.safe) : [];
        if (utils.isJsonMode()) {
          if (!opts.confirm) {
            const out: any = {
              success: true,
              pending: hasPendingMigrations ? pending : [],
              safeMigrations: safeMigs,
              hooks: hooksResult,
              requiresConfirm: true,
            };
            output.json(out);
            return;
          }

          // Apply hooks first, then migrations
          let hooksApplied: string[] = [];
          let hooksSkipped: string[] = [];
          let hookError: string | undefined;

          if (hasOutdatedHooks) {
            const hookResult = upgradeHooks('.githooks', hooksTargetDir);
            if (hookResult.success) {
              hooksApplied = hookResult.upgraded;
              hooksSkipped = hookResult.skipped;
            } else {
              hookError = hookResult.error;
            }
          }

          if (hookError) {
            process.exitCode = 1;
            output.json({ success: false, error: hookError });
            return;
          }

          try {
            let migrationResult = { applied: [] as any[], backups: [] as string[] };
            if (hasPendingMigrations) {
              migrationResult = withStoreMutationLock(dataPath, () => runMigrations({
                dryRun: false,
                confirm: true,
                logger: { info: s => console.error(s), error: s => console.error(s) }
              }));
            }

            output.json({
              success: true,
              pending: hasPendingMigrations ? pending : [],
              safeMigrations: safeMigs,
              applied: migrationResult.applied,
              backups: migrationResult.backups,
              hooks: hooksResult,
              hooksApplied,
              hooksSkipped,
            });
            return;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.exitCode = 1;
            output.json({ success: false, error: message });
            return;
          }
        }
        console.log('Pending safe migrations:');
        safeMigs.forEach(p => console.log(` - ${p.id}: ${p.description}`));
        console.log('');

        // Confirm before applying unless --confirm provided
        let proceed = Boolean(opts.confirm);
        const totalItems = (hasPendingMigrations ? pending.length : 0) + hooksResult.outdatedCount;
        if (totalItems > 0 && !proceed) {
          // Prompt interactively
          const readlineMod = await import('node:readline');
          const answer = await new Promise<boolean>(resolve => {
            const rl = readlineMod.createInterface({ input: process.stdin, output: process.stdout });
            const parts: string[] = [];
            if (hasPendingMigrations) parts.push(`${pending.length} pending migration(s)`);
            if (hasOutdatedHooks) parts.push(`${hooksResult.outdatedCount} outdated hook(s)`);
            rl.question(`Apply ${parts.join(' and ')}? (y/N): `, (a: string) => {
              rl.close();
              const v = (a || '').trim().toLowerCase();
              resolve(v === 'y' || v === 'yes');
            });
          });
          proceed = answer;
        }

        if (!proceed) {
          if (utils.isJsonMode()) output.json({ success: false, message: 'User declined to apply changes' });
          else console.log('Aborted: changes not applied.');
          return;
        }

        // Apply hooks first, then migrations
        let hooksApplied: string[] = [];
        let hookError: string | undefined;
        if (hasOutdatedHooks) {
          const hookResult = upgradeHooks('.githooks', hooksTargetDir);
          if (hookResult.success) {
            hooksApplied = hookResult.upgraded;
          } else {
            hookError = hookResult.error;
          }
        }

        if (hookError) {
          if (utils.isJsonMode()) {
            output.json({ success: false, error: hookError });
          } else {
            console.error(`Hook upgrade failed: ${hookError}`);
          }
          return;
        }

        // Apply migrations
        try {
          let migrationResult = { applied: [] as any[], backups: [] as string[] };
          if (hasPendingMigrations) {
            migrationResult = withStoreMutationLock(dataPath, () => runMigrations({ dryRun: false, confirm: true, logger: { info: s => console.error(s), error: s => console.error(s) } }));
          }
          if (utils.isJsonMode()) {
            output.json({ success: true, applied: migrationResult.applied, backups: migrationResult.backups });
            return;
          }
          if (migrationResult.applied.length > 0) {
            console.log(`Applied migrations: ${migrationResult.applied.map(a => a.id).join(', ')}`);
          }
          if (migrationResult.backups && migrationResult.backups.length > 0) console.log(`Backups: ${migrationResult.backups.join(', ')}`);
          if (hooksApplied.length > 0) {
            console.log(`Upgraded hooks: ${hooksApplied.join(', ')}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (utils.isJsonMode()) output.json({ success: false, error: message });
          else console.error(`Migration failed: ${message}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (utils.isJsonMode()) output.json({ success: false, error: message });
        else console.error(`Doctor upgrade failed: ${message}`);
      }
    });
}
