/**
 * Undelete command — restore one or more soft-deleted work items.
 *
 * Soft delete is otherwise a one-way door: `wl update` refuses every field
 * mutation on a soft-deleted item except the delete-attribution fields
 * themselves (`--deleted-by` / `--delete-reason`), so before this command the
 * only CLI advice was "create a new work item instead" — which throws away the
 * item's comments, its children and their dependency edges. `wl undelete` is
 * the sanctioned recovery path (WL-0MWMRNL2W003W5R3).
 *
 * Semantics:
 *
 *   - The tombstone (`deletedBy` / `deleteReason`) is cleared and the item
 *     returns to a live status. Stage, priority, type, tags and every other
 *     field are preserved — the delete kept the stage, so the restore must too.
 *   - Status defaults to the first live status that can carry the item's
 *     current stage (`open`, then `in-progress`, `completed`, `blocked`, per
 *     the project's `statusStageCompatibility`). An item deleted while `in
 *     review` therefore comes back `completed` rather than losing its stage.
 *     `--status` overrides the choice.
 *   - `assignee` is cleared by default: a stale claim is a scheduling hold, and
 *     a restore must never silently re-arm one. `--assignee` sets it.
 *   - **Recursive by default**, mirroring `wl delete`: descendants whose
 *     `deleteReason` starts with `cascade from <id>` are restored with the
 *     parent. A descendant retired in its own right (a different reason) is
 *     reported `skipped` and left deleted — a restore is not a blanket
 *     resurrection.
 *   - Idempotent: an item that is not soft-deleted is a `skipped`/`already
 *     live` result, never an error. Every id in a batch is processed
 *     independently and the command exits non-zero only for hard failures
 *     (unknown id, invalid `--status`), matching `wl update`/`wl delete`.
 *   - `--dry-run` reports exactly what would be restored and mutates nothing.
 *   - An audit comment records the restoring identity plus the previous
 *     `deletedBy` / `deleteReason` / `status`, so the delete history is
 *     recoverable from the item itself.
 *   - Auto-sync runs **once** after the batch (never per id), exactly as
 *     `wl delete` does, so the restore propagates instead of being undone by
 *     the next pull. `--no-sync` opts out.
 *
 * The soft-delete guard in `wl update` is deliberately left untouched: this
 * command is the recovery path, not another field-mutation loophole.
 */

import type { PluginContext } from '../plugin-types.js';
import type { UndeleteOptions } from '../cli-types.js';
import type { WorkItem } from '../types.js';
import { performSync, getSyncDefaults } from './sync.js';
import { getConfiguredUserEmail } from '../sync.js';
import { withStoreMutationLock } from '../mutation-lock.js';
import { isSoftDeleted } from '@worklog/shared/predicates';
import {
  canValidateStatusStage,
  validateStatusStageCompatibility,
  validateStatusStageInput,
} from './status-stage-validation.js';

/** The `deleteReason` prefix `wl delete` writes on cascade-deleted descendants. */
const cascadePrefix = (parentId: string): string => `cascade from ${parentId}`;

/**
 * Stage → preferred restore status.
 *
 * The compatibility tables are permissive in places (an explicit
 * `in-progress` + `in_review` bridge exists for the audit runner), so a plain
 * "first compatible status" scan would restore a deleted review-stage item as
 * `in-progress`. The semantic mapping below is tried first and validated
 * against the compatibility rules before it is accepted.
 */
const STAGE_PREFERRED_STATUS: Readonly<Record<string, string>> = {
  in_review: 'completed',
  done: 'completed',
  in_progress: 'in-progress',
};

/** Statuses tried, in order, when the stage has no semantic preference. */
const DEFAULT_STATUS_CANDIDATES = ['open', 'in-progress', 'completed', 'blocked'] as const;

/** Per-id result for a batch undelete invocation. */
interface UndeleteResult {
  id: string;
  success: boolean;
  /** Present on failures (and on skips for a human-readable reason). */
  error?: string;
  /** Human-readable summary for this id. */
  message?: string;
  /** The id that was restored (single-id convenience field). */
  restoredId?: string;
  /** The post-restore snapshot (absent on a skip/failure). */
  restoredWorkItem?: WorkItem;
  /** The pre-restore snapshot, so callers can see what was recovered. */
  previousDeletedBy?: string;
  previousDeleteReason?: string;
  previousStatus?: string;
  /** The status the item was restored to. */
  status?: string;
  /** Whether the recursive descendant restore was applied. */
  recursive?: boolean;
  /** Descendants restored (or, with --dry-run, that would be restored). */
  restoredDescendantsCount?: number;
  restoredDescendants?: Array<{ id: string; title: string; previousDeleteReason?: string }>;
  /** Descendants deliberately left deleted (retired in their own right). */
  skippedDescendants?: Array<{ id: string; title: string; deleteReason?: string }>;
  /** True when the id was a no-op (duplicate id, or the item is already live). */
  skipped?: boolean;
  /** Why the id was skipped. */
  skippedReason?: string;
  /** Dry-run only: this id would have been restored. */
  wouldRestore?: boolean;
}

export default function register(ctx: PluginContext): void {
  const { program, dataPath, output, utils } = ctx;

  program
    .command('undelete <ids...>')
    .description(
      'Restore one or more soft-deleted work items (clears the delete tombstone). ' +
        'Recursively restores cascade-deleted children by default.'
    )
    .option('--prefix <prefix>', 'Override the default prefix')
    .option(
      '--status <status>',
      'Status to restore to (default: the first live status compatible with the item stage)'
    )
    .option('--assignee <assignee>', 'Assignee to record on restore (default: cleared)')
    .option('--no-recursive', 'Restore only the specified items, leaving cascade-deleted children deleted')
    .option('--no-sync', 'Skip auto-sync after restoring')
    .option('--dry-run', 'Report what would be restored without mutating anything')
    .option(
      '--restored-by <restoredBy>',
      'Identity recorded in the audit comment (default: the configured git identity)'
    )
    .action(async (ids: string[], options: UndeleteOptions) =>
      withStoreMutationLock(dataPath, async () => {
        utils.requireInitialized();
        const db = utils.getDatabase(options.prefix);
        const isJsonMode = utils.isJsonMode();

        // Recursive is the default; only disabled when --no-recursive is set.
        const recursive = options.recursive !== false;
        const dryRun = options.dryRun === true;

        const flagRestoredBy =
          typeof options.restoredBy === 'string' ? options.restoredBy.trim() : '';
        const restoredBy = flagRestoredBy || (await getConfiguredUserEmail()) || 'unknown';

        const config = utils.getConfig();
        const canValidate = canValidateStatusStage(config);

        // Validate the requested status once, up front: an unknown or
        // `deleted` status is a usage error for the whole invocation.
        let requestedStatus: string | undefined;
        if (options.status !== undefined) {
          const raw = String(options.status).trim();
          if (!raw) {
            const message = 'Error: --status must be a non-empty string';
            if (isJsonMode) output.json({ success: false, error: message });
            else console.error(message);
            process.exit(1);
          }
          try {
            requestedStatus = canValidate
              ? validateStatusStageInput({ status: raw }, config).status
              : raw;
          } catch (error) {
            const message = `Error: ${error instanceof Error ? error.message : String(error)}`;
            if (isJsonMode) output.json({ success: false, error: message });
            else console.error(message);
            process.exit(1);
          }
          if (requestedStatus === 'deleted') {
            const message =
              'Error: --status deleted would keep the item soft-deleted; ' +
              'pass the live status to restore it to (default: derived from its stage)';
            if (isJsonMode) output.json({ success: false, error: message });
            else console.error(message);
            process.exit(1);
          }
        }

        /**
         * Pick the status a restored item should carry.
         *
         * An explicit `--status` wins. Otherwise prefer the first live status
         * that can carry the item's current stage, so a restore never has to
         * wipe the stage to stay valid. When no live status fits (an unusual
         * stage/status configuration), fall back to `open` and clear the stage
         * — reported in the result so the caller can see the trade.
         */
        const resolveStatus = (
          item: WorkItem
        ): { status: string; stage: string; stageCleared: boolean } => {
          if (requestedStatus) {
            if (!canValidate) return { status: requestedStatus, stage: item.stage, stageCleared: false };
            try {
              validateStatusStageCompatibility(requestedStatus, item.stage, validateStatusStageInput({}, config).rules);
              return { status: requestedStatus, stage: item.stage, stageCleared: false };
            } catch {
              // The caller asked for a status that cannot carry this stage:
              // clear the stage rather than refuse the restore.
              return { status: requestedStatus, stage: '', stageCleared: true };
            }
          }
          if (!canValidate) return { status: 'open', stage: item.stage, stageCleared: false };
          const rules = validateStatusStageInput({}, config).rules;
          // Semantic preference first (a review-stage item restores as
          // `completed`, not as the permissive `in-progress` bridge).
          const preferred = STAGE_PREFERRED_STATUS[item.stage];
          if (preferred) {
            try {
              validateStatusStageCompatibility(preferred, item.stage, rules);
              return { status: preferred, stage: item.stage, stageCleared: false };
            } catch {
              // Fall through to the ordered scan.
            }
          }
          for (const candidate of DEFAULT_STATUS_CANDIDATES) {
            try {
              validateStatusStageCompatibility(candidate, item.stage, rules);
              return { status: candidate, stage: item.stage, stageCleared: false };
            } catch {
              continue;
            }
          }
          return { status: 'open', stage: '', stageCleared: true };
        };

        const results: UndeleteResult[] = [];
        const seen = new Set<string>();

        for (const rawId of ids) {
          const normalizedId = utils.normalizeCliId(rawId, options.prefix) || rawId;
          const idLookup = normalizedId.toUpperCase();

          if (seen.has(idLookup)) {
            results.push({
              id: normalizedId,
              success: true,
              skipped: true,
              skippedReason: 'duplicate id in this invocation',
              message: `Skipped work item: ${normalizedId} (duplicate id in this invocation)`,
            });
            continue;
          }
          seen.add(idLookup);

          const existing = db.get(idLookup);
          if (!existing) {
            const message = `Work item not found: ${normalizedId}`;
            results.push({ id: normalizedId, success: false, error: message, message });
            continue;
          }

          if (!isSoftDeleted(existing)) {
            results.push({
              id: normalizedId,
              success: true,
              skipped: true,
              skippedReason: 'already live',
              restoredId: normalizedId,
              previousStatus: existing.status,
              status: existing.status,
              message: `Skipped work item: ${normalizedId} (already live)`,
            });
            continue;
          }

          // Split the descendants into "swept with this parent" (restore) and
          // "retired in its own right" (leave deleted).
          const descendants = recursive ? db.getDescendants(idLookup) : [];
          const prefix = cascadePrefix(normalizedId);
          const swept: WorkItem[] = [];
          const retired: WorkItem[] = [];
          for (const descendant of descendants) {
            if (!isSoftDeleted(descendant)) continue;
            const reason = String(descendant.deleteReason ?? '');
            if (reason.startsWith(prefix)) swept.push(descendant);
            else retired.push(descendant);
          }

          const target = resolveStatus(existing);
          // `reconcileSelf: false` — the requested restore status is an
          // explicit operator decision and must not be re-derived from the
          // dependency graph (which would snap a `--status blocked` restore
          // back to `open`). Dependent items are still reconciled by the DB
          // layer, so restoring a parent unblocks its children as usual.
          const restoreOne = (item: WorkItem, status: string, stage: string): WorkItem | null =>
            db.update(
              item.id,
              {
                status: status as WorkItem['status'],
                stage,
                deletedBy: '',
                deleteReason: '',
                assignee: options.assignee ?? '',
              },
              { reconcileSelf: false }
            );

          if (dryRun) {
            results.push({
              id: normalizedId,
              success: true,
              wouldRestore: true,
              restoredId: normalizedId,
              previousDeletedBy: existing.deletedBy ?? '',
              previousDeleteReason: existing.deleteReason ?? '',
              previousStatus: existing.status,
              status: target.status,
              recursive,
              restoredDescendantsCount: swept.length,
              restoredDescendants: swept.map((d) => ({
                id: d.id,
                title: d.title,
                previousDeleteReason: d.deleteReason ?? '',
              })),
              ...(retired.length > 0
                ? {
                    skippedDescendants: retired.map((d) => ({
                      id: d.id,
                      title: d.title,
                      deleteReason: d.deleteReason ?? '',
                    })),
                  }
                : {}),
              message:
                `Would restore work item: ${normalizedId}` +
                (swept.length > 0 ? ` and ${swept.length} descendant(s)` : ''),
            });
            continue;
          }

          const restoredDescendants: Array<{ id: string; title: string; previousDeleteReason?: string }> = [];
          for (const descendant of swept) {
            const descendantTarget = resolveStatus(descendant);
            const restoredDescendant = restoreOne(
              descendant,
              descendantTarget.status,
              descendantTarget.stage
            );
            if (restoredDescendant) {
              restoredDescendants.push({
                id: descendant.id,
                title: descendant.title,
                previousDeleteReason: descendant.deleteReason ?? '',
              });
            }
          }

          const restored = restoreOne(existing, target.status, target.stage);
          if (!restored) {
            const message = `Work item not found: ${normalizedId}`;
            results.push({ id: normalizedId, success: false, error: message, message });
            continue;
          }

          // Audit comment (AC2): the item itself carries why it disappeared and
          // who brought it back, so the delete/restore history survives log
          // rotation. Best-effort — a comment failure never undoes a restore.
          try {
            db.createComment({
              workItemId: restored.id,
              author: restoredBy,
              comment:
                `Restored from soft-delete via \`wl undelete\`. ` +
                `Previous status: ${existing.status}; ` +
                `deletedBy: ${existing.deletedBy || '(none)'}; ` +
                `deleteReason: ${existing.deleteReason || '(none)'}. ` +
                `Restored to status: ${target.status}` +
                (target.stageCleared ? ' (stage cleared: it was not compatible with the status)' : '') +
                (restoredDescendants.length > 0
                  ? `; restored ${restoredDescendants.length} cascade-deleted descendant(s)`
                  : '') +
                '.',
            });
          } catch {
            // Never fail a restore on the audit comment.
          }

          const childrenText =
            restoredDescendants.length > 0
              ? ` and ${restoredDescendants.length} descendant(s)`
              : '';
          const result: UndeleteResult = {
            id: normalizedId,
            success: true,
            message: `Restored work item: ${normalizedId}${childrenText}`,
            restoredId: normalizedId,
            restoredWorkItem: restored,
            previousDeletedBy: existing.deletedBy ?? '',
            previousDeleteReason: existing.deleteReason ?? '',
            previousStatus: existing.status,
            status: target.status,
            recursive,
          };
          if (restoredDescendants.length > 0) {
            result.restoredDescendantsCount = restoredDescendants.length;
            result.restoredDescendants = restoredDescendants;
          }
          if (retired.length > 0) {
            result.skippedDescendants = retired.map((d) => ({
              id: d.id,
              title: d.title,
              deleteReason: d.deleteReason ?? '',
            }));
          }
          results.push(result);
        }

        // `--dry-run` rows are reports, not restorations: they must never be
        // counted as such (or trigger the post-batch sync).
        const restoredCount = dryRun
          ? 0
          : results.filter((r) => r.success && !r.skipped).length;
        const failedCount = results.filter((r) => !r.success).length;
        const anyFailures = failedCount > 0;

        if (isJsonMode) {
          if (results.length === 1) {
            const r = results[0];
            if (r.success) {
              output.json({
                success: true,
                message: r.message,
                restoredId: r.restoredId ?? r.id,
                restoredWorkItem: r.restoredWorkItem,
                previousDeletedBy: r.previousDeletedBy,
                previousDeleteReason: r.previousDeleteReason,
                previousStatus: r.previousStatus,
                status: r.status,
                recursive: r.recursive ?? recursive,
                ...(dryRun ? { dryRun: true, wouldRestore: r.wouldRestore === true } : {}),
                ...(r.skipped ? { skipped: true, skippedReason: r.skippedReason } : {}),
                ...(r.restoredDescendantsCount !== undefined
                  ? {
                      restoredDescendantsCount: r.restoredDescendantsCount,
                      restoredDescendants: r.restoredDescendants,
                    }
                  : {}),
                ...(r.skippedDescendants ? { skippedDescendants: r.skippedDescendants } : {}),
                restored: restoredCount,
                failed: failedCount,
                results,
              });
            } else {
              output.json({
                success: false,
                error: r.error,
                ...(dryRun ? { dryRun: true } : {}),
                restored: restoredCount,
                failed: failedCount,
                results,
              });
            }
          } else {
            output.json({
              success: !anyFailures,
              ...(dryRun ? { dryRun: true } : {}),
              restored: restoredCount,
              failed: failedCount,
              results,
            });
          }
        } else {
          for (const r of results) {
            if (r.success) {
              console.log(r.message ?? `Restored work item: ${r.id}`);
            } else {
              console.error(r.error ?? `Failed to restore work item: ${r.id}`);
            }
          }
        }

        // Auto-sync once, after every id is processed. Skipped for --no-sync,
        // for --dry-run and when nothing was actually restored — the same
        // contract `wl delete` uses, so a restore propagates to peers instead
        // of being undone by the next pull.
        const skipSync =
          (options as any).sync === false || (options as any).noSync === true || dryRun;
        if (!skipSync && restoredCount > 0) {
          try {
            const defaults = getSyncDefaults(config || undefined);
            await performSync(dataPath, utils.getDatabase, {
              file: dataPath,
              prefix: options.prefix,
              gitRemote: defaults.gitRemote,
              gitBranch: defaults.gitBranch,
              push: true,
              dryRun: false,
              silent: true,
              isJsonMode,
              isVerbose: false,
            });
          } catch (syncError) {
            // Sync failure must not abort the restore — it is already committed
            // locally. Warn so the operator can sync by hand.
            const message = syncError instanceof Error ? syncError.message : String(syncError);
            console.error(`Warning: auto-sync after undelete failed: ${message}`);
          }
        }

        if (anyFailures) process.exit(1);
      }),
    );
}
