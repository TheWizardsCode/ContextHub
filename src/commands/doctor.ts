/**
 * Doctor command - Validate work items against config rules
 */

import type { PluginContext } from '../plugin-types.js';
import { loadStatusStageRules } from '../status-stage-rules.js';
import { validateStatusStageItems } from '../doctor/status-stage-check.js';
import { validateDependencyEdges } from '../doctor/dependency-check.js';
import { listPendingMigrations, runMigrations } from '../migrations/index.js';
import { dryRunHooks, upgradeHooks, type HookDryRunResult, type HookUpgradeResult } from '../doctor/hook-upgrade.js';
import { validateFilePaths, applyFilePathsFix, DEFAULT_INTAKE_STAGES } from '../doctor/file-paths-check.js';
import { importFromJsonl } from '../jsonl.js';
import { mergeWorkItems, mergeComments, mergeAuditResults } from '../sync.js';
import * as fs from 'fs';
import * as path from 'path';
import { normalizePriority, isValidPriority, isMappablePriority, PRIORITY_MAP, CANONICAL_PRIORITIES } from '../validators/priority.js';

interface DoctorOptions {
  prefix?: string;
}

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
        const hooksResult = dryRunHooks();

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
            const hookResult = upgradeHooks();
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
              migrationResult = runMigrations({
                dryRun: false,
                confirm: true,
                logger: { info: s => console.error(s), error: s => console.error(s) }
              });
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
          const hookResult = upgradeHooks();
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
            migrationResult = runMigrations({ dryRun: false, confirm: true, logger: { info: s => console.error(s), error: s => console.error(s) } });
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

  doctor
    .command('priority')
    .description('Detect and fix invalid priority values in the database')
    .option('--dry-run', 'Show invalid priorities without modifying them')
    .option('--apply', 'Apply priority mapping (P0-P3 -> canonical values)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (opts: { dryRun?: boolean; apply?: boolean; prefix?: string }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(opts.prefix);
      const all = db.getAll();

      const invalid: Array<{ id: string; current: string; mapped?: string }> = [];

      for (const item of all) {
        const p = item.priority;
        if (p && !isValidPriority(p)) {
          const mapped = isMappablePriority(p) ? normalizePriority(p) : undefined;
          invalid.push({ id: item.id, current: p, mapped: mapped ?? undefined });
        }
      }

      if (invalid.length === 0) {
        if (utils.isJsonMode()) {
          output.json({ success: true, invalid: [], fixed: [] });
          return;
        }
        console.log('Doctor priority: no invalid priorities found.');
        return;
      }

      if (opts.dryRun || !opts.apply) {
        if (utils.isJsonMode()) {
          const out: any = { dryRun: true, invalid, count: invalid.length };
          if (!opts.dryRun) out.hint = 'Use --apply to fix invalid priorities';
          output.json(out);
          return;
        }
        console.log(`Doctor priority: found ${invalid.length} work item(s) with invalid priorities.`);
        console.log(`Canonical priority values: ${CANONICAL_PRIORITIES.join(', ')}`);
        console.log(`P* mapping: P0->critical, P1->high, P2->medium, P3->low`);
        console.log('');
        for (const entry of invalid) {
          const hint = entry.mapped ? ` (would map to "${entry.mapped}")` : ' (no mapping available)';
          console.log(` - ${entry.id}: current="${entry.current}"${hint}`);
        }
        if (!opts.dryRun) {
          console.log('');
          console.log('Use --dry-run to preview or --apply to apply the P* mapping.');
        }
        return;
      }

      // --apply: apply mapping for mappable values
      const fixed: Array<{ id: string; from: string; to: string }> = [];
      const unfixable: Array<{ id: string; current: string }> = [];

      for (const entry of invalid) {
        if (entry.mapped) {
          try {
            db.update(entry.id, { priority: entry.mapped as any });
            fixed.push({ id: entry.id, from: entry.current, to: entry.mapped });
          } catch (err) {
            unfixable.push({ id: entry.id, current: entry.current });
          }
        } else {
          unfixable.push({ id: entry.id, current: entry.current });
        }
      }

      if (utils.isJsonMode()) {
        output.json({ fixed, unfixable, fixedCount: fixed.length, unfixableCount: unfixable.length });
        return;
      }

      console.log(`Doctor priority: fixed ${fixed.length} item(s).`);
      for (const f of fixed) {
        console.log(` - ${f.id}: "${f.from}" -> "${f.to}"`);
      }
      if (unfixable.length > 0) {
        console.log(`\n${unfixable.length} item(s) with unmappable priorities (requires manual fix):`);
        for (const u of unfixable) {
          console.log(` - ${u.id}: "${u.current}"`);
        }
      }
    });

  doctor
    .command('file-paths')
    .description('Check intake stage work items for missing or incorrect **Key Files:** sections')
    .option('--add-placeholder', 'Add placeholder **Key Files:** section to items that are missing one')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (opts: { addPlaceholder?: boolean; prefix?: string }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(opts.prefix);
      const allItems = db.getAll();

      const findings = validateFilePaths(allItems);

      // Helper to apply a fix for a finding
      const doFix = (finding: typeof findings[0]): boolean => {
        if (!applyFilePathsFix(finding, (_id: string, _updates: { description: string }) => true)) {
          return false;
        }
        // applyFilePathsFix only returns true for TYPE_MISSING findings
        // We need to update the actual item
        const item = db.get(finding.itemId);
        if (!item) return false;
        const appendText = (finding.proposedFix as Record<string, string> | null)?.appendDescription;
        if (!appendText) return false;
        const newDescription = (item.description || '') + appendText;
        try {
          db.update(finding.itemId, { description: newDescription });
          return true;
        } catch {
          return false;
        }
      };

      const missing = findings.filter(f => f.type === 'missing-key-files');
      const withIncorrect = findings.filter(f => f.type === 'incorrect-key-files');

      const intakeItemCount = allItems.filter(
        i => DEFAULT_INTAKE_STAGES.includes(i.stage) && i.status !== 'deleted'
      ).length;

      if (opts.addPlaceholder) {
        const fixed: string[] = [];
        for (const finding of findings) {
          if (doFix(finding)) {
            fixed.push(finding.itemId);
          }
        }
        if (utils.isJsonMode()) {
          output.json({
            success: true,
            total: intakeItemCount,
            missing: missing.map(f => ({ itemId: f.itemId, title: (f.context as any)?.itemTitle })),
            withIncorrect: withIncorrect.map(f => ({ itemId: f.itemId, title: (f.context as any)?.itemTitle })),
            fixed: fixed.length,
            fixedItems: fixed,
          });
          return;
        }
        if (fixed.length > 0) {
          console.log(`Added placeholder **Key Files:** section to ${fixed.length} item(s):`);
          for (const id of fixed) {
            console.log(`  - ${id}`);
          }
        } else {
          console.log('No items needed fixing.');
        }
        return;
      }

      if (utils.isJsonMode()) {
        output.json({
          success: true,
          total: intakeItemCount,
          missing: missing.map(f => ({ itemId: f.itemId, title: (f.context as any)?.itemTitle, message: f.message })),
          withIncorrect: withIncorrect.map(f => ({ itemId: f.itemId, title: (f.context as any)?.itemTitle, message: f.message })),
        });
        return;
      }

      if (intakeItemCount === 0) {
        console.log('Doctor file-paths: no intake stage items found.');
        return;
      }

      console.log(`Doctor file-paths: scanned ${intakeItemCount} intake stage item(s).`);
      if (missing.length === 0 && withIncorrect.length === 0) {
        console.log('All intake stage items have valid **Key Files:** sections.');
        return;
      }

      if (missing.length > 0) {
        console.log(`
${missing.length} item(s) missing **Key Files:** section:`);
        for (const f of missing) {
          console.log(`  - ${f.itemId}: ${(f.context as any)?.itemTitle || f.itemId}`);
        }
      }

      if (withIncorrect.length > 0) {
        console.log(`
${withIncorrect.length} item(s) with incorrect **Key Files:** sections:`);
        for (const f of withIncorrect) {
          console.log(`  - ${f.itemId}: ${(f.context as any)?.itemTitle || f.itemId}`);
        }
      }

      if (missing.length > 0) {
        console.log('');
        console.log('Use --fix to add a placeholder **Key Files:** section to missing items.');
      }
      console.log('See docs/FILE_PATH_CONVENTION.md for the file-path convention specification.');
    });

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

      let findings: any[] = [
        ...validateStatusStageItems(items, rules),
        ...validateDependencyEdges(items, dependencyEdges),
        ...priorityFindings,
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
            // completed + (in_progress|intake_complete|idea) -> completed + in_review
            if (f.type === 'incompatible-status-stage' && ctx.status === 'completed' && (ctx.stage === 'in_progress' || ctx.stage === 'intake_complete' || ctx.stage === 'idea')) {
              const current = (f.proposedFix && typeof f.proposedFix === 'object') ? (f.proposedFix as Record<string, unknown>) : {};
              (f as any).proposedFix = Object.assign({}, current, { stage: 'in_review' });
              (f as any).safe = true;
            }

            // deleted + in_progress -> deleted + done
            if (f.type === 'incompatible-status-stage' && ctx.status === 'deleted' && ctx.stage === 'in_progress') {
              const current = (f.proposedFix && typeof f.proposedFix === 'object') ? (f.proposedFix as Record<string, unknown>) : {};
              (f as any).proposedFix = Object.assign({}, current, { stage: 'done' });
              (f as any).safe = true;
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
            Object.prototype.hasOwnProperty.call(f.proposedFix, 'priority')
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
                if (Object.keys(update).length > 0) {
                  try { db.update(f.itemId, update); continue; } catch (err) { /* fall through to keep in report */ }
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

      if (utils.isJsonMode()) {
        output.json(findings);
        return;
      }

      if (findings.length === 0) {
        console.log('Doctor: no issues found.');
        return;
      }

      console.log('Doctor: validation findings');
      console.log('Rules source: docs/validation/status-stage-inventory.md');
      const byItem = new Map<string, typeof findings>();
      for (const finding of findings) {
        const existing = byItem.get(finding.itemId) || [];
        existing.push(finding);
        byItem.set(finding.itemId, existing);
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
          Object.prototype.hasOwnProperty.call(proposed, 'priority')
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
            let line = `  - ${f.itemId}: ${f.message}`;
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
    });
}
