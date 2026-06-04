/**
 * Audit result subcommands: `wl audit show` and `wl audit set`
 *
 * These commands manage the audit_results table – the sole source of truth
 * for audit state (see epic WL-0MPZNJVWT000IKG7).
 */

import type { PluginContext } from '../plugin-types.js';
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
    .option('--author <author>', 'Author of the audit (defaults to current user)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--json', 'Output in JSON format')
    .action((id: string, options: {
      readyToClose?: string;
      summary?: string;
      rawOutput?: string;
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

      const readyToClose = rtc === 'yes';
      const author = options.author?.trim() || resolveAuditAuthor();
      const auditedAt = new Date().toISOString();
      const summary = options.summary || null;
      const rawOutput = options.rawOutput || null;

      db.saveAuditResult({
        workItemId: normalizedId,
        readyToClose,
        auditedAt,
        summary,
        rawOutput,
        author,
      });

      if (options.json || utils.isJsonMode()) {
        output.json({
          success: true,
          workItemId: normalizedId,
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
    });
}