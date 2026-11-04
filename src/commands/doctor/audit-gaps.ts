/**
 * `wl doctor audit-gaps` subcommand.
 *
 * Single responsibility: register the `audit-gaps` subcommand, a read-only
 * report of `completed`/`in_review` items that have no audit record, showing
 * root/child relationship, age and the covered/waived/uncovered
 * classification. Classification itself is delegated to
 * `src/doctor/audit-gaps-check.ts`; this module only renders it.
 *
 * Extracted from `src/commands/doctor.ts` (WL-0MW08084M000ZQW7, parent
 * WL-0MVGKH1770008MNU) as a move-only refactor: it imports only concrete
 * sibling modules and never imports from the registrar.
 */

import type { Command } from 'commander';
import type { WorklogDatabase } from '../../database.js';
import { buildAuditGapReport } from '../../doctor/audit-gaps-check.js';

/**
 * Narrow context the audit-gaps subcommand needs from the CLI registrar —
 * never the full `PluginContext` surface.
 */
export interface AuditGapsCommandContext {
  /** JSON payload emitter. */
  output: { json: (data: unknown) => void };
  utils: {
    /** Fail loudly when the worklog is not initialised. */
    requireInitialized: () => void;
    /** Open the database, honouring the `--prefix` override. */
    getDatabase: (prefix?: string) => WorklogDatabase;
    /** Whether `--json` output mode was requested. */
    isJsonMode: () => boolean;
  };
}

/** Register the `wl doctor audit-gaps` subcommand on the parent `doctor` command. */
export function registerAuditGapsCommand(doctor: Command, ctx: AuditGapsCommandContext): void {
  const { output, utils } = ctx;

  doctor
    .command('audit-gaps')
    .description(
      'Report completed/in_review items with no audit record (read-only; shows ' +
      'root/child relationship, age, and covered/waived/uncovered status)',
    )
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((opts: { prefix?: string }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(opts.prefix);
      const report = buildAuditGapReport(db.getAll(), db.getAllAuditResults());

      if (utils.isJsonMode()) {
        output.json(report);
        return;
      }

      console.log(
        `Doctor audit-gaps: ${report.noAuditCount} of ${report.totalScanned} item(s) completed/in_review with no audit record ` +
        `(${report.flaggedCount} uncovered, ${report.coveredCount} covered, ${report.waivedCount} waived).`,
      );
      if (report.noAuditCount === 0) {
        console.log('No audit gaps found.');
        return;
      }
      console.log('');
      for (const item of report.items) {
        const relationship = item.relationship === 'root' ? 'root' : `child of ${item.parentId}`;
        const age = `${item.ageDays}d`;
        console.log(`  [${item.classification}] ${item.id} (${relationship}, age ${age}) ${item.title}`);
        if (item.classification === 'waived' && item.waiver) {
          console.log(`      waived by ${item.waiver.author}: ${item.waiver.reason}`);
        }
      }
      console.log('');
      console.log('Read-only report. Use `wl audit-waive <id> --reason "..."` to record a deliberate exception.');
    });
}
