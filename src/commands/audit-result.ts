/**
 * Audit result subcommands: `wl audit show` and `wl audit set`
 *
 * These commands manage the audit_results table – the sole source of truth
 * for audit state (see epic WL-0MPZNJVWT000IKG7).
 */

import type { PluginContext } from '../plugin-types.js';
import { promises as fs } from 'fs';
import { formatInvalidAuditFirstLineMessage, inspectAuditFirstLine, redactAuditText, resolveAuditAuthor } from '../audit.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  // ── wl audit show <id> ─────────────────────────────────────────────
  program
    .command('audit-show <id>')
    .alias('audit show')
    .description('Show the latest audit result for a work item')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--json', 'Output in JSON format')
    .action((id: string, options: { prefix?: string; json?: boolean }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);

      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;
      const item = db.get(normalizedId);
      if (!item) {
        output.error(`Work item not found: ${normalizedId}`, {
          success: false,
          error: `Work item not found: ${normalizedId}`,
        });
        process.exit(1);
      }

      const auditResult = db.getAuditResult(normalizedId);

      if (options.json || utils.isJsonMode()) {
        if (!auditResult) {
          output.json({
            success: true,
            workItemId: normalizedId,
            audit: null,
          });
        } else {
          output.json({
            success: true,
            workItemId: normalizedId,
            audit: {
              workItemId: auditResult.workItemId,
              readyToClose: auditResult.readyToClose,
              auditedAt: auditResult.auditedAt,
              summary: auditResult.summary,
              rawOutput: auditResult.rawOutput,
              author: auditResult.author,
            },
          });
        }
        return;
      }

      // Human output
      if (!auditResult) {
        console.log(`No audit result for ${normalizedId}`);
        return;
      }

      console.log(`Audit result for ${normalizedId}:`);
      console.log(`  Ready to close: ${auditResult.readyToClose ? 'Yes' : 'No'}`);
      console.log(`  Audited at:     ${auditResult.auditedAt}`);
      if (auditResult.author) {
        console.log(`  Author:         ${auditResult.author}`);
      }
      if (auditResult.summary) {
        console.log(`  Summary:`);
        for (const line of auditResult.summary.split('\n')) {
          console.log(`    ${line}`);
        }
      }
      if (auditResult.rawOutput) {
        console.log(`  Raw output:`);
        for (const line of auditResult.rawOutput.split('\n')) {
          console.log(`    ${line}`);
        }
      }
    });

  // ── wl audit set <id> ──────────────────────────────────────────────
  program
    .command('audit-set <id>')
    .alias('audit set')
    .description('Set or update the audit result for a work item')
    .option('--ready-to-close <yes|no>', 'Whether the work item is ready to close (yes/no)')
    .option('--summary <text>', 'Human-readable summary of the audit')
    .option('--raw-output <text>', 'Machine-readable raw output from the audit tool')
    .option('--audit-file <file>', 'Read audit raw output from a file')
    .option('--author <author>', 'Author of the audit (defaults to current user)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--json', 'Output in JSON format')
    .action(async (id: string, options: {
      readyToClose?: string;
      summary?: string;
      rawOutput?: string;
      auditFile?: string;
      author?: string;
      prefix?: string;
      json?: boolean;
    }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);

      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;
      const item = db.get(normalizedId);
      if (!item) {
        output.error(`Work item not found: ${normalizedId}`, {
          success: false,
          error: `Work item not found: ${normalizedId}`,
        });
        process.exit(1);
      }

      // Validate --ready-to-close
      if (!options.readyToClose) {
        output.error('--ready-to-close is required. Use yes or no.', {
          success: false,
          error: 'missing-ready-to-close',
        });
        process.exit(1);
      }

      const rtc = options.readyToClose.toLowerCase();
      if (rtc !== 'yes' && rtc !== 'no') {
        output.error(`Invalid value for --ready-to-close: ${options.readyToClose}. Use yes or no.`, {
          success: false,
          error: 'invalid-ready-to-close',
        });
        process.exit(1);
      }

      // Resolve rawOutput: --audit-file takes precedence over --raw-output
      let rawOutput: string | null = options.rawOutput || null;
      if (options.auditFile) {
        try {
          rawOutput = await fs.readFile(options.auditFile, 'utf8');
        } catch (err) {
          output.error(`Failed to read audit file: ${options.auditFile}`, {
            success: false,
            error: `Failed to read audit file: ${options.auditFile}`,
          });
          process.exit(1);
        }
      }

      const readyToClose = rtc === 'yes';
      const author = options.author?.trim() || resolveAuditAuthor();
      const auditedAt = new Date().toISOString();
      const summary = options.summary || null;

      try {
        db.saveAuditResult({
          workItemId: normalizedId,
          readyToClose,
          auditedAt,
          summary,
          rawOutput,
          author,
        });
      } catch (err: any) {
        if (options.json || utils.isJsonMode()) {
          output.json({
            success: false,
            error: err.message || 'Failed to persist audit result',
            workItemId: normalizedId,
          });
          process.exitCode = 1;
          return;
        }
        console.error(`Error: Failed to persist audit result for ${normalizedId}`);
        console.error(`  ${err.message || 'Unknown error'}`);
        process.exit(1);
      }

      // Reversion: when the verdict is "not ready to close" on an item in
      // `in_review` (status `completed`), move it back to `open` /
      // `plan_complete` so it drops out of the ready-to-close queue and
      // returns to the planning queue (WL-0MSKHYI5U0069FVV). Best-effort:
      // a reversion failure must not abort the command — surface a warning.
      let reverted = null;
      if (rtc === 'no') {
        try {
          reverted = db.revertToPlanComplete(normalizedId);
        } catch (err) {
          console.error(`Warning: failed to revert ${normalizedId} to open/plan_complete: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (options.json || utils.isJsonMode()) {
        output.json({
          success: true,
          workItemId: normalizedId,
          ...(reverted ? { reverted } : {}),
          audit: {
            workItemId: normalizedId,
            readyToClose,
            auditedAt,
            summary,
            rawOutput,
            author,
          },
        });
        return;
      }

      console.log(`Audit result set for ${normalizedId}:`);
      console.log(`  Ready to close: ${readyToClose ? 'Yes' : 'No'}`);
      console.log(`  Audited at:    ${auditedAt}`);
      if (author) console.log(`  Author:        ${author}`);
      if (reverted) {
        console.log(`[${reverted.item.id} reverted from ${reverted.from.status}/${reverted.from.stage} to ${reverted.to.status}/${reverted.to.stage}]`);
      }
    });
}