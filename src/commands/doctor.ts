/**
 * Doctor command - Validate work items against config rules
 */

import type { PluginContext } from '../plugin-types.js';
import { loadStatusStageRules } from '../status-stage-rules.js';
import { validateStatusStageItems } from '../doctor/status-stage-check.js';
import { validateDependencyEdges } from '../doctor/dependency-check.js';
import { listPendingMigrations, runMigrations } from '../migrations/index.js';

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
    .description('Preview or apply pending database schema migrations')
    .option('--dry-run', 'Preview pending migrations without applying them')
    .option('--confirm', 'Apply pending migrations (non-interactive)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (opts: { dryRun?: boolean; confirm?: boolean; prefix?: string }) => {
      // Migration upgrade subcommand
      utils.requireInitialized();
      try {
        const pending = listPendingMigrations();
        if (!pending || pending.length === 0) {
          if (utils.isJsonMode()) {
            output.json({ success: true, pending: [] });
            return;
          }
          console.log('Doctor: no pending migrations. See docs/migrations.md for migration policy and guidance.');
          return;
        }

        if (opts.dryRun) {
          if (utils.isJsonMode()) {
            output.json({ success: true, dryRun: true, pending });
            return;
          }
          // Dry-run: list all pending migrations (no prompt, purely informational)
          console.log('Pending migrations:');
          pending.forEach(p => console.log(` - ${p.id}: ${p.description} (safe=${p.safe})`));
          return;
        }

        // Not a dry-run: list safe migrations, print blank line, and ask to apply
        const safeMigs = pending.filter(p => p.safe);
        if (utils.isJsonMode()) {
          output.json({ success: true, pending, safeMigrations: safeMigs });
          return;
        }
        console.log('Pending safe migrations:');
        safeMigs.forEach(p => console.log(` - ${p.id}: ${p.description}`));
        console.log('');

        // Confirm before applying unless --confirm provided
        let proceed = Boolean(opts.confirm);
        if (!proceed) {
          // Prompt interactively
          const readlineMod = await import('node:readline');
          const answer = await new Promise<boolean>(resolve => {
            const rl = readlineMod.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(`Apply ${pending.length} pending migration(s)? (y/N): `, (a: string) => {
              rl.close();
              const v = (a || '').trim().toLowerCase();
              resolve(v === 'y' || v === 'yes');
            });
          });
          proceed = answer;
        }

        if (!proceed) {
          if (utils.isJsonMode()) output.json({ success: false, message: 'User declined to apply migrations' });
          else console.log('Aborted: migrations not applied.');
          return;
        }

        // Apply migrations
        try {
          const result = runMigrations({ dryRun: false, confirm: true, logger: { info: s => console.error(s), error: s => console.error(s) } });
          if (utils.isJsonMode()) {
            output.json({ success: true, applied: result.applied, backups: result.backups });
            return;
          }
          console.log(`Applied migrations: ${result.applied.map(a => a.id).join(', ')}`);
          if (result.backups && result.backups.length > 0) console.log(`Backups: ${result.backups.join(', ')}`);
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

        const ids = candidates.map(c => c.id);

        if (opts.dryRun) {
          if (utils.isJsonMode()) {
            output.json({ dryRun: true, candidates: ids, count: ids.length });
            return;
          }
          console.log(`Prune dry-run: ${ids.length} deleted item(s) older than ${days} day(s)`);
          ids.forEach(id => console.log(` - ${id}`));
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
          output.json({ dryRun: false, prunedIds: pruned, count: pruned.length });
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

  doctor.action(async (options: DoctorOptions & { fix?: boolean }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
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
      let findings = [
        ...validateStatusStageItems(items, rules),
        ...validateDependencyEdges(items, dependencyEdges),
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

        // Auto-fix: if an item is `completed` with stage `in_progress`, convert stage -> `in_review`.
        // This handles a common mismatch where completed items retained an in-progress stage.
        for (const f of findings) {
          try {
            const ctx = (f && (f as any).context) || {};
            if (f.type === 'incompatible-status-stage' && ctx.status === 'completed' && ctx.stage === 'in_progress') {
              const current = (f.proposedFix && typeof f.proposedFix === 'object') ? (f.proposedFix as Record<string, unknown>) : {};
              (f as any).proposedFix = Object.assign({}, current, { stage: 'in_review' });
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
            Object.prototype.hasOwnProperty.call(f.proposedFix, 'stage')
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
          Object.prototype.hasOwnProperty.call(proposed, 'stage')
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
