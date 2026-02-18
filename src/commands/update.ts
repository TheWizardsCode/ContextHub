/**
 * Update command - Update a work item
 */

import type { PluginContext } from '../plugin-types.js';
import type { UpdateOptions } from '../cli-types.js';
import type { UpdateWorkItemInput, WorkItemStatus, WorkItemPriority, WorkItemRiskLevel, WorkItemEffortLevel } from '../types.js';
import { promises as fs } from 'fs';
import { humanFormatWorkItem, resolveFormat } from './helpers.js';
import { canValidateStatusStage, validateStatusStageCompatibility, validateStatusStageInput } from './status-stage-validation.js';
import { normalizeActionArgs } from './cli-utils.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('update <id...>')
    .description('Update a work item')
    .option('-t, --title <title>', 'New title')
    .option('-d, --description <description>', 'New description')
    .option('--description-file <file>', 'Read description from a file')
    .option('-s, --status <status>', 'New status')
    .option('-p, --priority <priority>', 'New priority')
    .option('-P, --parent <parentId>', 'New parent ID')
    .option('--tags <tags>', 'New tags (comma-separated)')
    .option('-a, --assignee <assignee>', 'New assignee')
    .option('--stage <stage>', 'New stage')
    .option('--risk <risk>', 'New risk level (Low, Medium, High, Severe)')
    .option('--effort <effort>', 'New effort level (XS, S, M, L, XL)')
    .option('--issue-type <issueType>', 'New issue type (interoperability field)')
    .option('--created-by <createdBy>', 'New created by (interoperability field)')
    .option('--deleted-by <deletedBy>', 'New deleted by (interoperability field)')
    .option('--delete-reason <deleteReason>', 'New delete reason (interoperability field)')
    .option('--needs-producer-review <true|false>', 'Set needsProducerReview flag (true|false|yes|no)')
    .option('--do-not-delegate <true|false>', 'Set or clear the do-not-delegate tag (true|false|yes|no)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (...rawArgs: any[]) => {
      const knownOptionKeys = [
        'title','description','descriptionFile','status','priority','parent','tags','assignee','stage','risk','effort','issueType','createdBy','deletedBy','deleteReason','needsProducerReview','doNotDelegate','prefix'
      ];

      const normalized = normalizeActionArgs(rawArgs, knownOptionKeys);
      const argsHint = rawArgs.map(a => Array.isArray(a) ? `array(${a.length})` : `${typeof a}:${String(a).slice(0,100)}`);
      if (process.env.WL_DEBUG_UPDATE_ACTION) {
        try { console.error('WL_DEBUG_UPDATE_ACTION rawArgs:', JSON.stringify(argsHint)); } catch (_e) { /* ignore */ }
      }

      let options: UpdateOptions = normalized.options as any || {};
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);

      const idsRaw = normalized.ids;

      if (process.env.WL_DEBUG_SQL_BINDINGS) {
        try { console.error('WL_DEBUG_SQL_BINDINGS update: idsRaw', JSON.stringify(idsRaw)); } catch (_) { }
      }

      if (idsRaw.length === 0) {
        output.error('No work item id(s) provided', { success: false, error: 'missing-arg' });
        process.exit(1);
      }

      // Precompute global candidates that don't require per-id state.
      // Use normalized.provided to detect whether the user supplied a flag.
      const hasProvided = (name: keyof UpdateOptions) => normalized.provided.has(name as string);

      if (process.env.WL_DEBUG_UPDATE_ACTION) {
        try {
          console.error('WL_DEBUG_UPDATE_ACTION optionsOwnNames:', JSON.stringify(Object.getOwnPropertyNames(options)));
          console.error('WL_DEBUG_UPDATE_ACTION optionsKeys:', JSON.stringify(Object.keys(options)));
          console.error('WL_DEBUG_UPDATE_ACTION has descriptionFile own:', Object.prototype.hasOwnProperty.call(options, 'descriptionFile'));
          console.error('WL_DEBUG_UPDATE_ACTION descriptionFile value:', String((options as any).descriptionFile));
        } catch (_e) { /* ignore */ }
      }
      const titleCandidate = hasProvided('title') ? options.title : undefined;
      let descriptionCandidate: string | undefined = undefined;
      if (hasProvided('description')) descriptionCandidate = options.description;
      if (hasProvided('descriptionFile')) {
        try {
          const contents = await fs.readFile(String(options.descriptionFile), 'utf8');
          descriptionCandidate = contents;
        } catch (err) {
          output.error(`Failed to read description file: ${options.descriptionFile}`);
          process.exit(1);
        }
      }
      const statusCandidate = hasProvided('status') ? options.status : undefined;
      const priorityCandidate = hasProvided('priority') ? options.priority : undefined;
      // Commander populates a `parent` property on option objects (the parent
      // command), so we must check that the user actually provided the
      // `--parent` flag. Use hasOwnProperty to detect presence of the option
      // on the parsed options object.
      const parentCandidate = hasProvided('parent')
        ? (utils.normalizeCliId(String(options.parent), options.prefix) || null)
        : undefined;
      const tagsCandidate = hasProvided('tags') && options.tags ? String(options.tags).split(',').map((t: string) => t.trim()) : undefined;
      const assigneeCandidate = hasProvided('assignee') ? options.assignee : undefined;
      const stageCandidate = hasProvided('stage') ? options.stage : undefined;
      const config = utils.getConfig();
      const riskCandidate = hasProvided('risk') ? options.risk as WorkItemRiskLevel | '' : undefined;
      const effortCandidate = hasProvided('effort') ? options.effort as WorkItemEffortLevel | '' : undefined;
      const issueTypeCandidate = hasProvided('issueType') ? options.issueType : undefined;
      const createdByCandidate = hasProvided('createdBy') ? options.createdBy : undefined;
      const deletedByCandidate = hasProvided('deletedBy') ? options.deletedBy : undefined;
      const deleteReasonCandidate = hasProvided('deleteReason') ? options.deleteReason : undefined;
      let needsProducerReviewCandidate: boolean | undefined;
      if (hasProvided('needsProducerReview')) {
        const raw = String(options.needsProducerReview).toLowerCase();
        const truthy = ['true', 'yes', '1'];
        const falsy = ['false', 'no', '0'];
        if (truthy.includes(raw)) needsProducerReviewCandidate = true;
        else if (falsy.includes(raw)) needsProducerReviewCandidate = false;
        else {
          output.error(`Invalid value for --needs-producer-review: ${options.needsProducerReview}`, { success: false, error: 'invalid-arg' });
          process.exit(1);
        }
      }

      let doNotDelegateRaw: string | undefined;
      if (hasProvided('doNotDelegate')) {
        doNotDelegateRaw = String(options.doNotDelegate).toLowerCase();
        const truthy = ['true', 'yes', '1'];
        const falsy = ['false', 'no', '0'];
        if (!truthy.includes(doNotDelegateRaw) && !falsy.includes(doNotDelegateRaw)) {
          output.error(`Invalid value for --do-not-delegate: ${options.doNotDelegate}`, { success: false, error: 'invalid-arg' });
          process.exit(1);
        }
      }

      const results: Array<any> = [];
      for (const rawId of idsRaw) {
        const normalizedId = utils.normalizeCliId(rawId, options.prefix) || rawId;
        const updates: UpdateWorkItemInput = {};
        if (titleCandidate) updates.title = titleCandidate;
        if (descriptionCandidate) updates.description = descriptionCandidate;
        if (priorityCandidate) updates.priority = priorityCandidate as WorkItemPriority;
        if (parentCandidate !== undefined) updates.parentId = parentCandidate;
        if (tagsCandidate) updates.tags = tagsCandidate;
        if (assigneeCandidate !== undefined) updates.assignee = assigneeCandidate;
        if (riskCandidate !== undefined) updates.risk = riskCandidate;
        if (effortCandidate !== undefined) updates.effort = effortCandidate;
        if (issueTypeCandidate !== undefined) updates.issueType = issueTypeCandidate;
        if (createdByCandidate !== undefined) updates.createdBy = createdByCandidate;
        if (deletedByCandidate !== undefined) updates.deletedBy = deletedByCandidate;
        if (deleteReasonCandidate !== undefined) updates.deleteReason = deleteReasonCandidate;
        if (needsProducerReviewCandidate !== undefined) updates.needsProducerReview = needsProducerReviewCandidate;

        // Validate status/stage per-id if needed.
        if ((statusCandidate !== undefined || stageCandidate !== undefined) && canValidateStatusStage(config)) {
          const current = db.get(normalizedId);
          if (!current) {
            const message = `Work item not found: ${normalizedId}`;
            results.push({ id: normalizedId, success: false, error: message });
            // continue to next id without aborting
            continue;
          }
          let normalizedStatus = current.status;
          let normalizedStage = current.stage;
          let warnings: string[] = [];
          try {
            const validation = validateStatusStageInput(
              {
                status: statusCandidate ?? current.status,
                stage: stageCandidate ?? current.stage,
              },
              config
            );
            normalizedStatus = validation.status as WorkItemStatus;
            normalizedStage = validation.stage;
            warnings = validation.warnings;
            validateStatusStageCompatibility(normalizedStatus, normalizedStage, validation.rules);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ id: normalizedId, success: false, error: message });
            continue;
          }
          for (const warning of warnings) {
            console.error(warning);
          }
          if (statusCandidate !== undefined) updates.status = normalizedStatus as WorkItemStatus;
          if (stageCandidate !== undefined) updates.stage = normalizedStage;
        }

        // Handle do-not-delegate per-id
        if (doNotDelegateRaw !== undefined) {
          const current = db.get(normalizedId);
          if (!current) {
            const message = `Work item not found: ${normalizedId}`;
            results.push({ id: normalizedId, success: false, error: message });
            continue;
          }
          const baseTags: string[] = updates.tags !== undefined ? updates.tags : (current.tags || []);
          const truthy = ['true', 'yes', '1'];
          let newTags: string[];
          if (truthy.includes(doNotDelegateRaw)) {
            newTags = Array.from(new Set([...baseTags, 'do-not-delegate']));
          } else {
            newTags = baseTags.filter(t => t !== 'do-not-delegate');
          }
          updates.tags = newTags;
        }

        if (process.env.WL_DEBUG_SQL_BINDINGS) {
          try {
            const currentBefore = db.get(normalizedId);
            console.error('WL_DEBUG_SQL_BINDINGS update: preparing to update', normalizedId, 'updates:', JSON.stringify(updates));
            if (currentBefore) {
              const keys: any = {};
              for (const k of Object.keys(currentBefore)) {
                try { keys[k] = typeof (currentBefore as any)[k]; } catch (_e) { keys[k] = 'unreadable'; }
              }
              console.error('WL_DEBUG_SQL_BINDINGS update: current item types:', JSON.stringify(keys));
            }
          } catch (_e) {
            console.error('WL_DEBUG_SQL_BINDINGS update: failed to log update context');
          }
        }

        const item = db.update(normalizedId, updates);
        if (!item) {
          const message = `Work item not found: ${normalizedId}`;
          results.push({ id: normalizedId, success: false, error: message });
          continue;
        }

        if (updates.status || updates.stage) {
          db.reconcileDependentStatus(normalizedId);
        }

        results.push({ id: normalizedId, success: true, workItem: item });
      }

      // Determine overall success
      const anyFailures = results.some(r => !r.success);
      if (utils.isJsonMode()) {
        // Preserve legacy single-id output shape for callers/tests that expect
        // `{ success, workItem }`. For batch updates return an array of
        // per-id results.
        if (results.length === 1) {
          const r = results[0];
          if (r.success) output.json({ success: true, workItem: r.workItem });
          else output.json({ success: false, error: r.error, id: r.id });
        } else {
          output.json({ success: !anyFailures, results });
        }
      } else {
        const format = resolveFormat(program);
        for (const r of results) {
          if (r.success) {
            console.log('Updated work item:');
            console.log(humanFormatWorkItem(r.workItem, db, format));
          } else {
            output.error(r.error, { success: false, error: r.error });
          }
        }
      }

      if (anyFailures) {
        // Ensure spawned CLI and in-process harness treat this as a failure.
        // Set exitCode for spawn semantics and call process.exit(1) so the
        // in-process runner (which replaces process.exit with a throwing
        // trap) will surface a non-zero exit code to execAsync.
        process.exitCode = 1;
        process.exit(1);
      }
    });
}
