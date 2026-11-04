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
import * as path from 'node:path';
import {
  listPendingMigrations,
  runMigrations,
  auditPreservationSummary,
  MigrationUnsafeError,
  type AuditPreservationSummary,
} from '../../migrations/index.js';
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
  // Resolve the database the same way the migration runner's default does, but
  // from the injected `dataPath` so an explicit worklog location is honoured
  // (WL-0MW1W61CG005K893).
  const dbFile = path.join(path.dirname(dataPath), 'worklog.db');

  /** Human-readable migration line: neutralised entries never read as unsafe. */
  const formatMigration = (p: { id: string; description: string; safe: boolean; neutralised?: boolean }): string =>
    ` - ${p.id}: ${p.description} (${p.neutralised ? 'no-op (historical)' : `safe=${p.safe}`})`;

  /**
   * Legacy audit-text blast radius (WL-0MW1W61CG005K893): how much legacy data
   * the pending drop would touch, and how much of it has no preserved copy yet.
   * `null` when there is nothing to lose.
   */
  const preservation = auditPreservationSummary(dbFile);

  /**
   * The legacy audit-text blast radius as human lines (WL-0MW1W61CG005K893).
   * One formatter shared by the dry-run and the applying run, so the operator
   * sees the same four counts (candidates, parsed, preserved, orphaned) plus
   * the already-preserved detail in **both** modes and can approve on
   * evidence rather than faith.
   *
   * `orphaned` is the count with no successor row *right now*: the drop
   * migration re-runs the preservation sweep first, so those values are
   * preserved rather than destroyed — the gate refuses only when preservation
   * itself cannot complete.
   */
  const preservationLines = (p: AuditPreservationSummary): string[] => [
    ` - items with legacy audit text: ${p.candidates}`,
    ` - already mapped to audit_results: ${p.mappedToAuditResult}`,
    ` - unmappable, preserved verbatim on apply: ${p.preserveOnly}`,
    ` - already preserved in legacy_audit_preserved: ${p.alreadyPreserved}`,
    ` - orphaned (no successor row yet; the drop preserves these first): ${p.orphaned}`,
  ];

  /** True when there is legacy audit text worth reporting. */
  const hasPreservation = (p: AuditPreservationSummary | null): p is AuditPreservationSummary =>
    p !== null && p.candidates > 0;

  const reportUnsafeMigration = (err: MigrationUnsafeError): void => {
    if (utils.isJsonMode()) {
      output.json({
        success: false,
        error: err.message,
        migrationId: err.migrationId,
        offendingIds: err.offendingIds,
        // The blast radius is carried on the refusal path too, so a JSON
        // consumer sees the same four counts as the success paths
        // (AC2, WL-0MW2F2AC8002BBRV).
        ...(preservation !== null ? { preservation } : {}),
      });
      return;
    }
    console.error(`Refusing to upgrade: ${err.message}`);
    console.error(
      'No data was changed. Re-run after investigating the listed work items (the migration stays pending).',
    );
  };

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
        const pending = listPendingMigrations(dbFile);
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
            if (preservation !== null) out.preservation = preservation;
            output.json(out);
            return;
          }
          // Dry-run: list all pending migrations
          if (hasPendingMigrations) {
            console.log('Pending migrations:');
            pending.forEach(p => console.log(formatMigration(p)));
          }
          // Legacy audit-text blast radius (WL-0MW1W61CG005K893)
          if (hasPreservation(preservation)) {
            console.log('');
            console.log('Legacy audit text (workitems.audit):');
            preservationLines(preservation).forEach(line => console.log(line));
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
            // The blast radius is reported before applying in JSON mode too
            // (AC4, WL-0MW1W61CG005K893).
            if (preservation !== null) out.preservation = preservation;
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
              }, dbFile));
            }

            output.json({
              success: true,
              pending: hasPendingMigrations ? pending : [],
              safeMigrations: safeMigs,
              applied: migrationResult.applied,
              backups: migrationResult.backups,
              // Pre-apply blast radius: what the run had to preserve
              // (AC4, WL-0MW1W61CG005K893).
              ...(preservation !== null ? { preservation } : {}),
              hooks: hooksResult,
              hooksApplied,
              hooksSkipped,
            });
            return;
          } catch (err) {
            if (err instanceof MigrationUnsafeError) {
              process.exitCode = 1;
              reportUnsafeMigration(err);
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            process.exitCode = 1;
            output.json({ success: false, error: message });
            return;
          }
        }
        console.log('Pending safe migrations:');
        safeMigs.forEach(p => console.log(formatMigration(p)));
        // The same blast radius the dry-run shows, before anything is applied
        // (AC4, WL-0MW1W61CG005K893).
        if (hasPreservation(preservation)) {
          console.log('');
          console.log('Legacy audit text (workitems.audit):');
          preservationLines(preservation).forEach(line => console.log(line));
        }
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
            migrationResult = withStoreMutationLock(dataPath, () => runMigrations({ dryRun: false, confirm: true, logger: { info: s => console.error(s), error: s => console.error(s) } }, dbFile));
          }
          if (utils.isJsonMode()) {
            output.json({
              success: true,
              applied: migrationResult.applied,
              backups: migrationResult.backups,
              // Pre-apply blast radius (AC4, WL-0MW1W61CG005K893).
              ...(preservation !== null ? { preservation } : {}),
            });
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
          if (err instanceof MigrationUnsafeError) {
            process.exitCode = 1;
            reportUnsafeMigration(err);
            return;
          }
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
