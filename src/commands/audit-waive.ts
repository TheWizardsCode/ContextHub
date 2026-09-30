/**
 * Audit-gap waiver commands (WL-0MUBVH9FV0027COG).
 *
 * `wl audit-waive <id> --reason "<text>" [--author <name>]` records an
 * explicit, durable waiver on a work item; `wl audit-unwaive <id>` removes
 * it. A waiver suppresses the non-fatal closure guard and excludes the item
 * from the `wl doctor audit-gaps` flagged set. The record is persisted in the
 * nullable `workitems.auditWaiver` column and surfaced by `wl show --json`.
 */

import type { PluginContext } from '../plugin-types.js';
import type { AuditWaiveOptions, AuditUnwaiveOptions } from '../cli-types.js';
import { resolveAuditAuthor } from '../audit.js';

function notFound(output: PluginContext['output'], id: string): void {
  output.error(`Work item not found: ${id}`, {
    success: false,
    error: `Work item not found: ${id}`,
    workItemId: id,
  });
  process.exit(1);
}

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  // ── wl audit-waive <id> ────────────────────────────────────────────
  program
    .command('audit-waive <id>')
    .description(
      'Record an explicit audit-gap waiver on a work item so it is not flagged ' +
      'by the no-audit closure guard or `wl doctor audit-gaps`.',
    )
    .option('-r, --reason <reason>', 'Why the audit gap is deliberately accepted (required)')
    .option('-a, --author <author>', 'Who recorded the waiver (defaults to the current user)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((id: string, options: AuditWaiveOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);

      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;
      const item = db.get(normalizedId);
      if (!item) {
        notFound(output, normalizedId);
        return;
      }

      const reason = (options.reason ?? '').trim();
      if (!reason) {
        output.error('--reason is required: a waiver must record why the audit gap is accepted.', {
          success: false,
          error: 'missing-reason',
          workItemId: normalizedId,
        });
        process.exit(1);
        return;
      }

      const author = (options.author ?? '').trim() || resolveAuditAuthor();
      const waivedAt = new Date().toISOString();
      const updated = db.setAuditWaiver(normalizedId, { reason, author, waivedAt });
      if (!updated) {
        notFound(output, normalizedId);
        return;
      }

      if (utils.isJsonMode()) {
        output.json({
          success: true,
          workItemId: normalizedId,
          auditWaiver: updated.auditWaiver,
        });
        return;
      }
      console.log(`Recorded audit waiver for ${normalizedId}.`);
      console.log(`  Reason: ${updated.auditWaiver?.reason ?? reason}`);
      console.log(`  Author: ${updated.auditWaiver?.author ?? author}`);
      console.log(`  Waived at: ${updated.auditWaiver?.waivedAt ?? waivedAt}`);
    });

  // ── wl audit-unwaive <id> ──────────────────────────────────────────
  program
    .command('audit-unwaive <id>')
    .description('Remove an explicit audit-gap waiver from a work item.')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((id: string, options: AuditUnwaiveOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);

      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;
      const item = db.get(normalizedId);
      if (!item) {
        notFound(output, normalizedId);
        return;
      }

      const updated = db.clearAuditWaiver(normalizedId);
      if (!updated) {
        notFound(output, normalizedId);
        return;
      }

      if (utils.isJsonMode()) {
        output.json({
          success: true,
          workItemId: normalizedId,
          auditWaiver: null,
        });
        return;
      }
      console.log(`Removed audit waiver for ${normalizedId}.`);
    });
}
