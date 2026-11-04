/**
 * `wl doctor file-paths` subcommand.
 *
 * Single responsibility: register the `file-paths` subcommand, which checks
 * intake-stage work items for missing or incorrect `**Key Files:**` sections
 * and (with `--add-placeholder`) appends a placeholder section to the items
 * missing one. Detection and fix construction are delegated to
 * `src/doctor/file-paths-check.ts`; this module only owns the CLI contract
 * (options, JSON/human rendering and the guarded mutation).
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW084ICG006D6NT, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import type { WorklogDatabase } from '../../database.js';
import { withStoreMutationLock } from '../../mutation-lock.js';
import {
  validateFilePaths,
  applyFilePathsFix,
  DEFAULT_INTAKE_STAGES,
} from '../../doctor/file-paths-check.js';

/**
 * Narrow context the file-paths subcommand needs from the CLI registrar —
 * never the full `PluginContext` surface.
 */
export interface FilePathsCommandContext {
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

/** Register the `wl doctor file-paths` subcommand on the parent `doctor` command. */
export function registerFilePathsCommand(doctor: Command, ctx: FilePathsCommandContext): void {
  const { output, dataPath, utils } = ctx;

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
        withStoreMutationLock(dataPath, () => {
        for (const finding of findings) {
          if (doFix(finding)) {
            fixed.push(finding.itemId);
          }
        }
        });
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
}
