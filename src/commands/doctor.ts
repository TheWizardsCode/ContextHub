/**
 * Doctor command - Validate work items against config rules
 */

import type { PluginContext } from '../plugin-types.js';
import { loadStatusStageRules } from '../status-stage-rules.js';
import { validateStatusStageItems } from '../doctor/status-stage-check.js';
import { validateDependencyEdges } from '../doctor/dependency-check.js';
import { resolveForeignItem, prefixOfWorkItemId } from '../cross-repo/foreign-store.js';
import { validateParentReferences } from '../doctor/parent-check.js';
import { listPendingMigrations, runMigrations } from '../migrations/index.js';
import { dryRunHooks, upgradeHooks, detectHooksTargetDir, type HookDryRunResult, type HookUpgradeResult } from '../doctor/hook-upgrade.js';
import { validatePodcastScripts } from '../doctor/podcast-scripts-check.js';
import { probeAuditFingerprintSkewFinding } from '../doctor/audit-fingerprint-skew-check.js';
import { withStoreMutationLock } from '../mutation-lock.js';
import * as fs from 'fs';
import * as path from 'path';
import { normalizePriority, isValidPriority, isMappablePriority, PRIORITY_MAP, CANONICAL_PRIORITIES } from '../validators/priority.js';
import {
  type DoctorOptions,
  detectPendingUpgrades,
  buildPendingUpgradeFinding,
  printPendingUpgradeNotice,
  detectPendingCacheState,
  printPendingCacheNotice,
} from './doctor/notices.js';
import { registerCacheCommand } from './doctor/cache.js';
import { registerAuditGapsCommand } from './doctor/audit-gaps.js';
import { registerPrefixCommand } from './doctor/prefix.js';
import { registerDanglingParentsCommand } from './doctor/dangling-parents.js';
import { registerPriorityCommand } from './doctor/priority.js';
import { registerPruneCommand } from './doctor/prune.js';
import { registerFilePathsCommand } from './doctor/file-paths.js';
import { registerMigrateCommand } from './doctor/migrate.js';
import { registerForeignItemsCommand } from './doctor/foreign-items.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  const doctor = program
    .command('doctor')
    .description('Validate work items against status/stage config rules')
    .option('--fix', 'Apply safe fixes and prompt for non-safe findings')
    .option('--prefix <prefix>', 'Override the default prefix');

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
              migrationResult = withStoreMutationLock(ctx.dataPath, () => runMigrations({
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
            migrationResult = withStoreMutationLock(ctx.dataPath, () => runMigrations({ dryRun: false, confirm: true, logger: { info: s => console.error(s), error: s => console.error(s) } }));
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

        withStoreMutationLock(ctx.dataPath, () => {
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

  registerPruneCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerCacheCommand(doctor, { output, utils });

  registerForeignItemsCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerPrefixCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerAuditGapsCommand(doctor, { output, utils });

  registerDanglingParentsCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerPriorityCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerFilePathsCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  registerMigrateCommand(doctor, { output, utils, dataPath: ctx.dataPath });

  doctor.action(async (options: DoctorOptions & { fix?: boolean }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      
      // Check for persistent JSONL file (indicates old architecture needs migration)
      const jsonlPath = path.join('.worklog', 'worklog-data.jsonl');
      if (fs.existsSync(jsonlPath)) {
        const stats = fs.statSync(jsonlPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        if (!utils.isJsonMode()) {
          console.log('');
          console.log('⚠️  Found persistent JSONL file: ' + jsonlPath);
          console.log(`   File size: ${fileSizeMB} MB`);
          console.log('');
          console.log('   Worklog now uses SQLite as the runtime source of truth.');
          console.log('   JSONL files should only exist temporarily during sync operations.');
          console.log('');
          console.log('   To migrate your data to SQLite and remove the JSONL file:');
          console.log('     wl doctor migrate --delete');
          console.log('');
          console.log('   To keep the JSONL file (for backup) and migrate to SQLite:');
          console.log('     wl doctor migrate');
          console.log('');
        }
      }
      
      const items = db.getAll();
      let rules;
      try {
        rules = loadStatusStageRules(utils.getConfig());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.error(message, { success: false, error: message });
        process.exit(1);
      }

      const dependencyEdges = db.getAllDependencyEdges();
      const priorityFindings: Array<{
        checkId: string;
        type: string;
        severity: string;
        itemId: string;
        message: string;
        proposedFix: Record<string, unknown> | null;
        safe: boolean;
        context: Record<string, unknown>;
      }> = [];
      for (const item of items) {
        const p = item.priority;
        if (p && !isValidPriority(p)) {
          const mapped = isMappablePriority(p) ? normalizePriority(p) : null;
          priorityFindings.push({
            checkId: 'priority.invalid',
            type: 'invalid-priority',
            severity: 'warning',
            itemId: item.id,
            message: mapped
              ? `Invalid priority "${p}" (maps to "${mapped}" via P* mapping)`
              : `Invalid priority "${p}" (not a canonical value: ${CANONICAL_PRIORITIES.join(', ')})`,
            proposedFix: mapped ? { priority: mapped } as Record<string, unknown> : null,
            safe: !!mapped,
            context: { current: p, mapped } as Record<string, unknown>,
          });
        }
      }

      // Installed-vs-expected audit fingerprint schema (WL-0MVS2RAR5007CBD5):
      // a warning-only, global (itemId: null) finding — read-only and never
      // allowed to change the exit status. `null` means ok/skip or no skew.
      const auditFingerprintSkew = probeAuditFingerprintSkewFinding();

      let findings: any[] = [
        // Dependency-graph findings come first: an unresolved foreign edge is
        // the item's primary dependency signal and must not be buried behind
        // per-item lifecycle noise (the AC3 spec looks the dependent up by
        // its first finding).
        ...validateDependencyEdges(items, dependencyEdges, {
          // A foreign (cross-project) target is resolved from its own store, so
          // an unresolved foreign edge is a warning keyed to the dependent —
          // never a false `dependency.missing-endpoint` error. Ids carrying this
          // store's own prefix stay on the local-only path.
          resolveForeign: (id: string) => {
            const localPrefix = (db.getPrefix() || '').toUpperCase();
            const prefix = prefixOfWorkItemId(id);
            if (prefix === '' || prefix === localPrefix) return null;
            return resolveForeignItem(id);
          },
        }),
        ...validateStatusStageItems(items, rules),
        ...validateParentReferences(items),
        ...priorityFindings,
        ...validatePodcastScripts(items),
        ...(auditFingerprintSkew ? [auditFingerprintSkew] : []),
      ];

      // If --fix was provided, attempt to apply safe fixes and prompt per non-safe finding
      if (options.fix) {
        // Compute a sensible default stage from rules (prefer a stage that allows 'open')
        let defaultStage = 'idea';
        try {
          defaultStage = (rules.stageValues.find(s => (rules.stageStatusCompatibility[s] || []).includes('open'))) || rules.stageValues[0] || defaultStage;
        } catch (e) {
          // fall back to hard-coded default
        }

        // Auto-fix rules for common incompatible status/stage combos
        for (const f of findings) {
          try {
            const ctx = (f && (f as any).context) || {};
            // completed + (intake_complete|idea) -> completed + in_review
            if (f.type === 'incompatible-status-stage' && ctx.status === 'completed' && (ctx.stage === 'intake_complete' || ctx.stage === 'idea')) {
              const current = (f.proposedFix && typeof f.proposedFix === 'object') ? (f.proposedFix as Record<string, unknown>) : {};
              (f as any).proposedFix = Object.assign({}, current, { stage: 'in_review' });
              (f as any).safe = true;
            }

            // migrated stage (in_progress -> plan_complete): general fallback
            // Items with stage=in_progress are migrated to plan_complete (the
            // highest-priority actionable stage after removal of in_progress).
            if (f.type === 'incompatible-status-stage' && ctx.stage === 'in_progress') {
              const current = (f.proposedFix && typeof f.proposedFix === 'object') ? (f.proposedFix as Record<string, unknown>) : {};
              (f as any).proposedFix = Object.assign({}, current, { stage: 'plan_complete' });
              (f as any).safe = true;
            }
          } catch (e) {
            // ignore
          }
        }

        // Retired `in_progress` stage (WL-0MTYL7DX9000MZOH AC5): once the
        // stage is REMOVED from the config (WL-0MTOHS5B4001Y9FX) the checker
        // above reports the row as `invalid-stage` (not a compatibility
        // finding), so the rule above never fires and the row would be left
        // for manual review. Migrate the stored stage to plan_complete — the
        // same target the downtime dispatcher's risk-effort recovery uses —
        // when plan_complete is compatible with the item's status (open /
        // in-progress / blocked / input_needed / deleted). A status that does
        // not admit plan_complete (completed — only in_review/done) is left
        // for manual review.
        for (const f of findings) {
          try {
            const ctx = (f && (f as any).context) || {};
            if (f.type === 'invalid-stage' && ctx.stage === 'in_progress') {
              const planCompatibleStatuses =
                (rules.stageStatusCompatibility['plan_complete'] as readonly string[] | undefined) ?? [];
              const compatible =
                typeof ctx.status === 'string' && planCompatibleStatuses.includes(ctx.status);
              if (compatible) {
                const current = (f.proposedFix && typeof f.proposedFix === 'object') ? (f.proposedFix as Record<string, unknown>) : {};
                (f as any).proposedFix = Object.assign({}, current, { stage: 'plan_complete' });
                (f as any).safe = true;
              }
            }
          } catch (e) {
            // ignore
          }
        }

        // Normalize certain findings: if an invalid/empty stage can be safely defaulted, mark safe
        for (const f of findings) {
          try {
            if (f.type === 'invalid-stage' && f.context && (f.context as any).stage === '') {
              const current = (f.proposedFix && typeof f.proposedFix === 'object') ? (f.proposedFix as Record<string, unknown>) : {};
              f.proposedFix = Object.assign({}, current, { stage: defaultStage });
              f.safe = true;
            }
          } catch (e) {
            // ignore
          }
        }

        // First, apply all safe fixes
        const remainingFindings: any[] = [];
        withStoreMutationLock(ctx.dataPath, () => {
        for (const f of findings) {
          if (f.safe && f.proposedFix && typeof f.proposedFix === 'object') {
            try {
              const itemId = f.itemId;
              const item = db.get(itemId);
              if (!item) {
                remainingFindings.push(f);
                continue;
              }
              const update: any = {};
              if ((f.proposedFix as any).status) update.status = (f.proposedFix as any).status;
              if ((f.proposedFix as any).stage) update.stage = (f.proposedFix as any).stage;
              if ((f.proposedFix as any).priority) update.priority = (f.proposedFix as any).priority;
              if ((f.proposedFix as any).description) update.description = (f.proposedFix as any).description;
              // A `parentId: null` fix is a detach — use hasOwnProperty so the
              // null value (falsy) is not skipped (WL-0MUJM2LV1000IHKR).
              if (Object.prototype.hasOwnProperty.call(f.proposedFix, 'parentId')) {
                update.parentId = (f.proposedFix as any).parentId;
              }
              if (Object.keys(update).length > 0) {
                try {
                  db.update(itemId, update);
                } catch (err) {
                  // if update fails, keep finding in remaining list so it appears in report
                  remainingFindings.push(f);
                  continue;
                }
                // applied successfully; don't add to remainingFindings
                continue;
              }
            } catch (err) {
              remainingFindings.push(f);
              continue;
            }
          }
          remainingFindings.push(f);
        }
        });

        // For non-safe actionable findings, prompt interactively unless in JSON/non-interactive mode
        const finalFindings: any[] = [];
        const readlineMod = await import('node:readline');
        const promptInteractive = (promptText: string) => {
          const rl = readlineMod.createInterface({ input: process.stdin, output: process.stdout });
          return new Promise<boolean>(resolve => {
            rl.question(promptText + ' (y/N): ', (answer: string) => {
              rl.close();
              const a = (answer || '').trim().toLowerCase();
              resolve(a === 'y' || a === 'yes');
            });
          });
        };

        for (const f of remainingFindings) {
          if (f.safe) {
            // safe but nothing actionable left - keep for report
            finalFindings.push(f);
            continue;
          }

          const hasActionableFix = f.proposedFix && typeof f.proposedFix === 'object' && (
            Object.prototype.hasOwnProperty.call(f.proposedFix, 'status') ||
            Object.prototype.hasOwnProperty.call(f.proposedFix, 'stage') ||
            Object.prototype.hasOwnProperty.call(f.proposedFix, 'priority') ||
            Object.prototype.hasOwnProperty.call(f.proposedFix, 'description')
          );

          if (!hasActionableFix) {
            // mark as manual required
            try { f.context = { ...(f.context || {}), requiresManualFix: true }; } catch (e) {}
            finalFindings.push(f);
            continue;
          }

          let shouldApply = false;
          if (utils.isJsonMode()) {
            // In JSON / non-interactive mode do not prompt; only safe fixes were applied above
            shouldApply = false;
          } else {
            shouldApply = await promptInteractive(`${f.itemId}: ${f.message}`);
          }

          if (shouldApply && f.proposedFix && typeof f.proposedFix === 'object') {
            try {
              const item = db.get(f.itemId);
              if (item) {
                const update: any = {};
                if ((f.proposedFix as any).status) update.status = (f.proposedFix as any).status;
                if ((f.proposedFix as any).stage) update.stage = (f.proposedFix as any).stage;
                if ((f.proposedFix as any).priority) update.priority = (f.proposedFix as any).priority;
                if ((f.proposedFix as any).description) update.description = (f.proposedFix as any).description;
                if (Object.keys(update).length > 0) {
                  try { withStoreMutationLock(ctx.dataPath, () => db.update(f.itemId, update)); continue; } catch (err) { /* fall through to keep in report */ }
                }
              }
            } catch (err) {
              // fall through to keep in report
            }
          }

          finalFindings.push(f);
        }

        // Replace findings with the post-fix set for reporting
        findings = finalFindings;
      }

      // Human-readable output handled below

      // Pending-upgrade detection (WL-0MUTVB271007YKJZ): read-only scan for
      // schema migrations and outdated git hooks that `wl doctor upgrade`
      // would apply. Computed after --fix so the notice reflects the final
      // findings set. Pending read-cache state (F9 — WL-0MVFRRQ9W003KEFL) is
      // detected alongside.
      const pendingUpgrade = detectPendingUpgrades();
      const pendingCache = detectPendingCacheState();

      if (utils.isJsonMode()) {
        const jsonFindings = [...findings];
        if (pendingUpgrade.hasPendingUpgrades) jsonFindings.push(buildPendingUpgradeFinding(pendingUpgrade));
        if (pendingCache.pending) {
          jsonFindings.push({
            checkId: 'read-cache.state',
            type: 'maintenance',
            severity: 'info',
            itemId: null,
            message:
              `Read-cache state: ${pendingCache.files} counter(s) (${pendingCache.staleByTtl} stale by TTL, ` +
              `${pendingCache.overBound} over the ${pendingCache.maxFiles}-file bound). Run ` +
              '`wl doctor cache` to review or `wl doctor cache --prune` to reclaim.',
            proposedFix: null,
            safe: false,
          });
        }
        output.json(jsonFindings);
        return;
      }

      if (findings.length === 0) {
        if (!pendingUpgrade.hasPendingUpgrades && !pendingCache.pending) {
          console.log('Doctor: no issues found.');
          return;
        }
        // Pending upgrades / cache state exist but validation is clean: emit
        // the advisory notice instead of a misleading bare "no issues found".
        if (pendingUpgrade.hasPendingUpgrades) printPendingUpgradeNotice(pendingUpgrade);
        if (pendingCache.pending) printPendingCacheNotice(pendingCache);
        return;
      }

      console.log('Doctor: validation findings');
      console.log('Rules source: docs/validation/status-stage-inventory.md');
      // Findings are keyed by work item; a global finding (itemId: null, e.g.
      // audit-fingerprint.schema-skew) is grouped under a `(global)` heading.
      const byItem = new Map<string, typeof findings>();
      for (const finding of findings) {
        const groupKey = finding.itemId ?? '(global)';
        const existing = byItem.get(groupKey) || [];
        existing.push(finding);
        byItem.set(groupKey, existing);
      }

      for (const [itemId, itemFindings] of byItem.entries()) {
        console.log(`\n${itemId}`);
        for (const finding of itemFindings) {
          console.log(`  - ${finding.message}`);
          if (finding.proposedFix) {
            console.log(`    Suggested: ${JSON.stringify(finding.proposedFix)}`);
          }
        }
      }

      // At the end, list findings that require manual intervention (no actionable proposedFix)
      const manual = findings.filter(f => {
        const ctx = (f as any).context || {};
        const proposed = f.proposedFix as any;
        const hasActionableFix = proposed && typeof proposed === 'object' && (
          Object.prototype.hasOwnProperty.call(proposed, 'status') ||
          Object.prototype.hasOwnProperty.call(proposed, 'stage') ||
          Object.prototype.hasOwnProperty.call(proposed, 'priority') ||
          Object.prototype.hasOwnProperty.call(proposed, 'description')
        );
        return !!ctx.requiresManualFix || !hasActionableFix;
      });
      if (manual.length > 0) {
        // Group by finding type
        const byType = new Map<string, typeof manual>();
        for (const f of manual) {
          const list = byType.get(f.type) || [];
          list.push(f);
          byType.set(f.type, list);
        }

        console.log('\nManual fixes required (grouped by type):');
        for (const [type, group] of byType.entries()) {
          console.log(`\nType: ${type}`);
          for (const f of group) {
            // Show basic message
            let line = `  - ${f.itemId ?? '(global)'}: ${f.message}`;
            // Include suggested allowed values if available
            const proposed = f.proposedFix as any;
            const ctx = (f as any).context || {};
            const suggestions: string[] = [];
            if (proposed) {
              if (proposed.allowedStages) suggestions.push(`allowedStages=${JSON.stringify(proposed.allowedStages)}`);
              if (proposed.allowedStatuses) suggestions.push(`allowedStatuses=${JSON.stringify(proposed.allowedStatuses)}`);
              if (proposed.stage) suggestions.push(`proposedStage=${String(proposed.stage)}`);
              if (proposed.status) suggestions.push(`proposedStatus=${String(proposed.status)}`);
              if (proposed.priority) suggestions.push(`proposedPriority=${String(proposed.priority)}`);
            }
            // Also check context for same keys
            if (ctx.allowedStages && !suggestions.some(s => s.startsWith('allowedStages='))) {
              suggestions.push(`allowedStages=${JSON.stringify(ctx.allowedStages)}`);
            }
            if (ctx.allowedStatuses && !suggestions.some(s => s.startsWith('allowedStatuses='))) {
              suggestions.push(`allowedStatuses=${JSON.stringify(ctx.allowedStatuses)}`);
            }

            if (suggestions.length > 0) line += ` (${suggestions.join('; ')})`;
            console.log(line);
          }
        }
      }

      // Pending-upgrade / read-cache notices are appended after the existing
      // per-item findings/manual-fix output, without altering it.
      if (pendingUpgrade.hasPendingUpgrades) {
        printPendingUpgradeNotice(pendingUpgrade);
      }
      if (pendingCache.pending) {
        printPendingCacheNotice(pendingCache);
      }
    });
}
