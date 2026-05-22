/**
 * Create command - Create a new work item
 */

import type { PluginContext } from '../plugin-types.js';
import type { CreateOptions } from '../cli-types.js';
import type { WorkItemStatus, WorkItemPriority, WorkItemRiskLevel, WorkItemEffortLevel } from '../types.js';
import { humanFormatWorkItem, resolveFormat } from './helpers.js';
import { canValidateStatusStage, validateStatusStageCompatibility, validateStatusStageInput } from './status-stage-validation.js';
import { promises as fs } from 'fs';
import { normalizeActionArgs } from './cli-utils.js';
import { buildAuditEntry, formatInvalidAuditFirstLineMessage, inspectAuditFirstLine, redactAuditText } from '../audit.js';
import { normalizePriority, CANONICAL_PRIORITIES } from '../validators/priority.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('create')
    .description('Create a new work item')
    .requiredOption('-t, --title <title>', 'Title of the work item')
    .option('-d, --description <description>', 'Description of the work item', '')
    .option('--description-file <file>', 'Read description from a file')
    .option('-s, --status <status>', 'Status (open, in-progress, completed, blocked, deleted)', 'open')
    .option('-p, --priority <priority>', 'Priority (low, medium, high, critical)', 'medium')
    .option('-P, --parent <parentId>', 'Parent work item ID')
    .option('--tags <tags>', 'Comma-separated list of tags')
    .option('-a, --assignee <assignee>', 'Assignee of the work item')
    .option('--stage <stage>', 'Stage of the work item in the workflow')
    .option('--risk <risk>', 'Risk level (Low, Medium, High, Severe)')
    .option('--effort <effort>', 'Effort level (XS, S, M, L, XL)')
    .option('--issue-type <issueType>', 'Issue type (interoperability field)')
    .option('--created-by <createdBy>', 'Created by (interoperability field)')
    .option('--deleted-by <deletedBy>', 'Deleted by (interoperability field)')
    .option('--delete-reason <deleteReason>', 'Delete reason (interoperability field)')
    .option('--needs-producer-review <true|false>', 'Set needsProducerReview flag for the new item (true|false|yes|no)')
    .option('--audit <text>', 'Legacy alias for --audit-text')
    .option('--audit-text <text>', 'Set structured audit text. First non-empty line must be "Ready to close: Yes" or "Ready to close: No" (see docs/AUDIT_STATUS.md)')
    .option('--audit-file <file>', 'Read audit text from a file')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--no-re-sort', 'Skip automatic re-sort after creating the item')
    .option('--re-sort-sync', 'Force a synchronous re-sort after creating the item', false)
    .action(async (...rawArgs: any[]) => {
      const normalized = normalizeActionArgs(rawArgs, ['title','description','descriptionFile','status','priority','parent','tags','assignee','stage','risk','effort','issueType','createdBy','deletedBy','deleteReason','needsProducerReview','audit','auditText','auditFile','prefix','noReSort','reSortSync']);
      let options: CreateOptions = normalized.options as any || {};
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);

      let description = options.description || '';
      if (options.descriptionFile) {
        try {
          description = await fs.readFile(options.descriptionFile, 'utf8');
        } catch (err) {
          // Print a helpful error and exit with failure
          console.error(`Failed to read description file: ${options.descriptionFile}`);
          process.exit(1);
        }
      }

      const config = utils.getConfig();
      const auditWriteEnabled = config?.auditWriteEnabled !== false;
      const requestedStage = options.stage !== undefined ? options.stage : 'idea';
      let normalizedStatus = (options.status || 'open') as WorkItemStatus;
      let normalizedStage = requestedStage;
      if (canValidateStatusStage(config)) {
        let warnings: string[] = [];
        try {
          const validation = validateStatusStageInput(
            {
              status: options.status || 'open',
              stage: requestedStage,
            },
            config
          );
          normalizedStatus = validation.status as WorkItemStatus;
          normalizedStage = validation.stage;
          warnings = validation.warnings;
          validateStatusStageCompatibility(normalizedStatus, normalizedStage, validation.rules);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.error(message, { success: false, error: message });
          process.exit(1);
        }

        for (const warning of warnings) {
          console.error(warning);
        }
      }

      if (normalized.provided.has('priority') && options.priority !== undefined) {
        const np = normalizePriority(options.priority);
        if (!np) {
          const allowed = CANONICAL_PRIORITIES.join(', ');
          output.error(`Invalid priority: "${options.priority}". Allowed values: ${allowed} (case-insensitive). P0-P3 values are not accepted at creation time; use "wl doctor" to migrate legacy data.`, { success: false, error: 'invalid-priority' });
          process.exit(1);
        }
        options.priority = np;
      }

      let auditTextInput = options.auditText ?? options.audit;

      if (options.auditFile) {
        try {
          auditTextInput = await fs.readFile(options.auditFile, 'utf8');
        } catch (err) {
          console.error(`Failed to read audit file: ${options.auditFile}`);
          process.exit(1);
        }
      }

      if (auditTextInput !== undefined && !auditWriteEnabled) {
        output.error('Audit writes are disabled by config (`auditWriteEnabled: false`).', {
          success: false,
          error: 'audit-write-disabled',
        });
        process.exit(1);
      }

      let auditEntry;
      if (auditTextInput !== undefined) {
        const redacted = redactAuditText(String(auditTextInput));
        const inspection = inspectAuditFirstLine(redacted);
        if (!inspection.isValid) {
          const message = formatInvalidAuditFirstLineMessage(inspection);
          output.error(message, {
            success: false,
            error: 'audit-invalid-first-line',
            message,
            firstNonEmptyLine: inspection.trimmedFirstNonEmptyLine,
            indicators: {
              bom: inspection.hasBom,
              nonPrintable: inspection.hasNonPrintable,
              gutterChars: inspection.hasGutterChars,
            },
          });
          process.exit(1);
        }

        auditEntry = buildAuditEntry(String(auditTextInput));
      }

      const item = db.createWithNextSortIndex({
        title: options.title,
        description: description,
        status: normalizedStatus as WorkItemStatus,
        priority: (options.priority || 'medium') as WorkItemPriority,
        parentId: utils.normalizeCliId(options.parent, options.prefix) || null,
        tags: options.tags ? options.tags.split(',').map((t: string) => t.trim()) : [],
        assignee: options.assignee || '',
        stage: normalizedStage,
        risk: (options.risk || '') as WorkItemRiskLevel | '',
        effort: (options.effort || '') as WorkItemEffortLevel | '',
        issueType: options.issueType || '',
        createdBy: options.createdBy || '',
        deletedBy: options.deletedBy || '',
        deleteReason: options.deleteReason || '',
        needsProducerReview: (options.needsProducerReview !== undefined) ?
          (['true','yes','1'].includes(String(options.needsProducerReview).toLowerCase())) :
          false,
        audit: auditEntry,
      });

      const refreshed = db.get(item.id) || item;
      
      if (utils.isJsonMode()) {
        output.json({ success: true, workItem: refreshed });
      } else {
        const format = resolveFormat(program);
        console.log(humanFormatWorkItem(refreshed, db, format));
      }
      // Trigger re-sort after create only when the create modified one of the
      // impactful fields (status, priority, risk, effort, stage). Honor caller
      // suppression via --no-re-sort and allow forcing synchronous re-sort via
      // --re-sort-sync.
      try {
        // Robustly detect caller intent for --no-re-sort (Commander may expose
        // the flag as `noReSort` or as `reSort: false` depending on context).
        const cliNoReSort = process.argv.includes('--no-re-sort') || process.argv.includes('--noReSort');
        const reSortNo = (((options as any).noReSort === true) || ((options as any).reSort === false) || cliNoReSort);
        const reSortSync = Boolean((options as any).reSortSync);
        const impactfulKeys = ['status','priority','risk','effort','stage'];
        const shouldReSort = impactfulKeys.some(k => normalized.provided.has(k));
        if (shouldReSort && !reSortNo && typeof (db as any).reSort === 'function') {
          if (reSortSync) (db as any).reSort();
          else void Promise.resolve().then(() => (db as any).reSort());
        }
      } catch (_e) {}
    });
}
