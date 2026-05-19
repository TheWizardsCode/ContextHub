/**
 * GitHub command - GitHub Issue sync commands (push and import)
 */

import type { PluginContext } from '../plugin-types.js';
import { getRepoFromGitRemote, normalizeGithubLabelPrefix, SecondaryRateLimitError, setVerboseLogger } from '../github.js';
import { getLockPathForJsonl, withFileLock } from '../file-lock.js';
import { resolveWorklogDir } from '../worklog-paths.js';
import path from 'node:path';
import { ProgressReporter, ProgressMode } from '../progress.js';
import throttler from '../github-throttler.js';
import { upsertIssuesFromWorkItems, importIssuesToWorkItems, GithubProgress, GithubSyncResult, SyncedItem, SyncErrorItem, FieldChange } from '../github-sync.js';
import { loadConfig } from '../config.js';
import { displayConflictDetails } from './helpers.js';
import { createLogFileWriter, getWorklogLogPath, logConflictDetails } from '../logging.js';
import { delegateWorkItem, type DelegateResult } from '../delegate-helper.js';

export function resolveGithubConfig(options: { repo?: string; labelPrefix?: string }) {
  const config = loadConfig();
  const repo = options.repo || config?.githubRepo || getRepoFromGitRemote();
  if (!repo) {
    throw new Error('GitHub repo not configured. Set githubRepo in config or use --repo.');
  }
  const labelPrefix = normalizeGithubLabelPrefix(options.labelPrefix || config?.githubLabelPrefix);
  return { repo, labelPrefix };
}

function resolveGithubImportCreateNew(options: { createNew?: boolean }): boolean {
  if (typeof options.createNew === 'boolean') {
    return options.createNew;
  }
  const config = loadConfig();
  return config?.githubImportCreateNew !== false;
}

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  const githubCommand = program
    .command('github')
    .alias('gh')
    .description('GitHub Issue sync commands');

  githubCommand
    .command('push')
    .description('Mirror work items to GitHub Issues')
    .option('--repo <owner/name>', 'GitHub repo (owner/name)')
    .option('--label-prefix <prefix>', 'Label prefix for Worklog labels (default: wl:)')
    .option('--all', 'Force a full push of all items, ignoring the last-push timestamp')
    .option('--force', 'Deprecated: use --all instead', false)
    .option('--no-update-timestamp', 'Do not write last-push timestamp after push')
    .option('--id <work-item-id>', 'Push a single work item by ID')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--no-re-sort', 'Skip automatic re-sort after github push')
    .option('--re-sort-sync', 'Force a synchronous re-sort after github push', false)
    .option('--progress <mode>', 'progress reporting mode (auto|json|human|quiet)', 'auto')
    .action(async (options) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      // Control single re-sort after github push batch completes
      const reSortNo = Boolean((options as any).noReSort) || false;
      const reSortSync = Boolean((options as any).reSortSync) || false;
      const isJsonMode = utils.isJsonMode();
      const isVerbose = program.opts().verbose;
      // Enable verbose GitHub API logging (to stderr) when --verbose is used
      try { setVerboseLogger(isVerbose ? ((m: string) => console.error(m)) : null); } catch (_) {}
      let lastProgress = '';
      let lastProgressLength = 0;
      const BATCH_SIZE = 10;
      let pushTotalItems = 0;
      let pushTotalBatches = 1;
      let currentBatchIndex = 0;
      let currentBatchLength = 0;
      const logLine = createLogFileWriter(getWorklogLogPath('github_sync.log'));
      logLine(`--- github push start ${new Date().toISOString()} ---`);
      logLine(`Options json=${isJsonMode} verbose=${isVerbose}`);

      const writeProgressMessage = (message: string, complete = false) => {
        if (message === lastProgress) {
          return;
        }
        lastProgress = message;
        const padded = `${message} `.padEnd(lastProgressLength, ' ');
        lastProgressLength = padded.length;
        process.stdout.write(`\r${padded}`);
        if (complete) {
          process.stdout.write('\n');
          lastProgress = '';
          lastProgressLength = 0;
        }
      };

      const progressMode = (options as any).progress as ProgressMode | undefined;
      const progressReporter = new ProgressReporter({ mode: progressMode ?? (isJsonMode ? 'json' : undefined) });
      const renderProgress = (progress: GithubProgress) => {
        if (progress.phase === 'push') {
          const totalItems = Math.max(pushTotalItems, 0);
          let message: string;
          if (totalItems === 0) {
            message = 'Push: Batch 0/0 Item 0/0';
          } else {
            const totalBatches = Math.max(pushTotalBatches, 1);
            const batchIdx = Math.min(currentBatchIndex, totalBatches - 1);
            const batchItemCount = currentBatchLength > 0
              ? currentBatchLength
              : Math.min(Math.max(totalItems - batchIdx * BATCH_SIZE, 0), BATCH_SIZE);
            const itemNumberInBatch = Math.min(Math.max(progress.current, 1), batchItemCount || BATCH_SIZE);
            message = `Push: Batch ${batchIdx + 1}/${totalBatches} Item ${itemNumberInBatch}/${batchItemCount || BATCH_SIZE}`;
          }
          // Append throttler stats to push message for diagnostic visibility
          try {
            const s = throttler?.getStats?.();
            if (s) message = `${message} (queue=${s.queueLength} active=${s.active} retries=${s.retryCount} errors=${s.errorCount})`; 
          } catch (_) {}
          progressReporter.render({ phase: 'push', current: progress.current, total: progress.total, note: message });
          return;
        }
        // For non-push phases include throttler snapshot in the note when available
        try {
          const s = throttler?.getStats?.();
          if (s) {
            const note = `queue=${s.queueLength} active=${s.active} retries=${s.retryCount} errors=${s.errorCount}`;
            progressReporter.render({ phase: progress.phase, current: progress.current, total: progress.total, note });
            return;
          }
        } catch (_) {}
        progressReporter.render(progress as any);
      };

      try {
        // Acquire a per-repo file lock to serialize github push operations and
        // avoid races where concurrent push runs update the last-push timestamp
        // out-of-band and cause items to be skipped. Use the JSONL path as the
        // lock target so it is repo-scoped and consistent with other file-locks.
        const jsonlPath = path.join(resolveWorklogDir(), 'worklog-data.jsonl');
        const lockPath = getLockPathForJsonl(jsonlPath);
        await withFileLock(lockPath, async () => {
          const githubConfig = resolveGithubConfig({ repo: options.repo, labelPrefix: options.labelPrefix });
          const repoUrl = `https://github.com/${githubConfig.repo}/issues`;
          if (!isJsonMode) {
            console.log(`Pushing to ${repoUrl}`);
          }
          const items = db.getAll();
          const comments = db.getAllComments();

          let itemsToProcess = items;
          let commentsToProcess = comments;
          let lastPush: string | null = null;
          // Pass DB to timestamp helpers when available so they may use metadata
          const dbForMetadata = typeof db.getAll === 'function' && typeof (db as any).store === 'object' ? (db as any).store : undefined;

          // Eagerly capture writeLastPushTimestamp when the pre-filter module is
          // available.  It may be resolved during the pre-filter import below or
          // via a standalone import before the batch loop.
          let _writeLastPushTimestamp: ((ts: string, db?: { setMetadata?: (k: string, v: string) => void }, repo?: string | null) => void) | null = null;

          const forceAll = Boolean(options.all) || Boolean(options.force);
        if (options.force && !options.all) {
          if (!isJsonMode) console.error('Warning: --force is deprecated and will be removed in a future release. Use --all instead.');
          logLine('github push: --force is deprecated; use --all instead');
        }
        // Pre-filter skip counts are accumulated alongside upsert skip counts to
        // produce the total skip count reported in CLI output.
        let preFilterSkippedCount = 0;
        let preFilterDeletedWithoutIssueCount = 0;
        if (forceAll) {
          // Bypass pre-filter when --all (or deprecated --force) specified
          if (!isJsonMode) console.log(`Full push (--all): processing all ${items.length} items`);
          logLine('github push: --all mode enabled - processing all items');
          // Still need the timestamp writer even in --all mode; resolve it here.
          if (!_writeLastPushTimestamp) {
            try {
              const mod = await import('../github-pre-filter.js');
              _writeLastPushTimestamp = mod.writeLastPushTimestamp;
            } catch (_err) {
              logLine('github push: failed to load writeLastPushTimestamp; timestamps will not be updated');
            }
          }
        } else {
          // Pre-filter items to only those changed since last push or never pushed
          try {
            const preFilterMod = await import('../github-pre-filter.js');
            _writeLastPushTimestamp = preFilterMod.writeLastPushTimestamp;
            // Read last-push using a repo-scoped key when available to avoid
            // cross-repo timestamp collisions in multi-repo runs.
            lastPush = preFilterMod.readLastPushTimestamp(dbForMetadata, githubConfig.repo);
            const { filteredItems, filteredComments, totalCandidates, skippedCount, deletedWithoutIssueCount } = preFilterMod.filterItemsForPush(items, comments, lastPush);
            itemsToProcess = filteredItems;
            commentsToProcess = filteredComments;
            preFilterSkippedCount = skippedCount;
            preFilterDeletedWithoutIssueCount = deletedWithoutIssueCount;
            if (!isJsonMode) {
              const parts: string[] = [];
              if (skippedCount > 0) parts.push(`${skippedCount} unchanged since last push`);
              if (deletedWithoutIssueCount > 0) parts.push(`${deletedWithoutIssueCount} deleted without issue number`);
              const skipMsg = parts.length > 0 ? ` — ${parts.join(', ')}` : '';
              console.log(`Processing ${itemsToProcess.length} of ${items.length} items (${preFilterSkippedCount + preFilterDeletedWithoutIssueCount} skipped${skipMsg})`);
            }
            logLine(`github push: pre-filtered items lastPush=${lastPush ?? 'none'} processed=${itemsToProcess.length} totalItems=${items.length} skipped=${skippedCount} deletedWithoutIssue=${deletedWithoutIssueCount}`);
          } catch (err) {
            // If pre-filter module fails, fall back to original behavior but log the error
            const msg = `Pre-filter failed: ${(err as Error).message}. Continuing without pre-filter.`;
            if (!isJsonMode) console.error(msg);
            logLine(`github push: ${msg}`);
            itemsToProcess = items;
            commentsToProcess = comments;
          }
        }

        // --id: restrict to a single work item when provided
        if (options.id) {
          // When --id is supplied, bypass the pre-filter and always push the
          // specified work item (do not require it to be a candidate in the
          // pre-filtered set). This ensures explicit single-item pushes always
          // run even if the pre-filter would otherwise exclude the item.
          const singleItem = items.find(i => i.id === options.id);
          if (!singleItem) {
            throw new Error(`Work item '${options.id}' not found.`);
          }
          itemsToProcess = [singleItem];
          commentsToProcess = comments.filter(c => c.workItemId === options.id);
          logLine(`github push: --id mode; pushing single item ${options.id}`);
        }

        // Defensive: ensure we didn't miss any items that were updated since
        // the last push timestamp. In rare race conditions or when the
        // pre-filter behaved unexpectedly, an item with updatedAt > lastPush
        // might be missing from itemsToProcess. Add any such items now so the
        // push run is robust.
        if (!forceAll && lastPush) {
          try {
            const lastMs = new Date(lastPush).getTime();
            if (!Number.isNaN(lastMs)) {
              const existingIds = new Set(itemsToProcess.map(i => i.id));
              const additional = items.filter(it => !existingIds.has(it.id)).filter(it => {
                const updatedMs = new Date(it.updatedAt).getTime();
                return !Number.isNaN(updatedMs) && updatedMs > lastMs;
              });
              if (additional.length > 0) {
                // Append additional items preserving the natural order from `items`.
                for (const it of items) {
                  if (additional.find(a => a.id === it.id)) itemsToProcess.push(it);
                }
                // Add comments for additional items
                for (const c of comments) {
                  if (additional.find(a => a.id === c.workItemId)) commentsToProcess.push(c);
                }
                logLine(`github push: added ${additional.length} item(s) newer than lastPush`);
              }
            }
          } catch (_) {}
        }

        // Capture push-start timestamp BEFORE processing begins so that items
        // modified during the push window are re-processed on the next run.
        const pushStartTimestamp = new Date().toISOString();

        const verboseLog = isVerbose && !isJsonMode
          ? (message: string) => console.log(message)
          : undefined;

        pushTotalItems = itemsToProcess.length;

        // Diagnostic: log whether the target item is present in the candidate list
        try {
          const containsTarget = itemsToProcess.some(i => i.id === 'WL-0MM8SU2R20PTDQ9I');
          logLine(`github push: itemsToProcess=${itemsToProcess.length} containsTarget=${containsTarget}`);
          try { console.error(`DEBUG: itemsToProcess=${itemsToProcess.length} containsTarget=${containsTarget}`); } catch (_) {}
        } catch (_) {}

        // Process items in fixed batches of 10 so progress is persisted after
        // each batch and a single failure does not require reprocessing everything.
        const totalBatches = Math.max(Math.ceil(itemsToProcess.length / BATCH_SIZE), 1);
        const result: GithubSyncResult = {
          updated: 0, created: 0, closed: 0, skipped: 0,
          errors: [], syncedItems: [], errorItems: [],
          commentsCreated: 0, commentsUpdated: 0,
        };
        const timing = {
          totalMs: 0, upsertMs: 0, commentListMs: 0, commentUpsertMs: 0,
          hierarchyCheckMs: 0, hierarchyLinkMs: 0, hierarchyVerifyMs: 0,
        };

        // Build a map of comments by item ID so we can pass only relevant
        // comments to each batch without scanning the full list every time.
        const commentsByItemId = new Map<string, typeof commentsToProcess>();
        for (const comment of commentsToProcess) {
          const list = commentsByItemId.get(comment.workItemId) ?? [];
          list.push(comment);
          commentsByItemId.set(comment.workItemId, list);
        }

        pushTotalBatches = totalBatches;

        // Resolve timestamp writer once before the loop so we can update
        // the last-push timestamp after each successful batch.  The flag
        // `--no-update-timestamp` (Commander exposes as `updateTimestamp`
        // defaulting to true) suppresses all writes.
        const skipUpdateTimestamp = Boolean(options.noUpdateTimestamp) || options.updateTimestamp === false;
        // _writeLastPushTimestamp was resolved during the pre-filter import above
        // (or set to null when pre-filter is unavailable / --no-update-timestamp).
        let writeTimestamp = skipUpdateTimestamp ? null : _writeLastPushTimestamp;

        let lastPersistedBatch = 0;
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const batchStart = batchIndex * BATCH_SIZE;
          const batchItems = itemsToProcess.slice(batchStart, batchStart + BATCH_SIZE);
          // Guard: skip if slice is empty (can only happen when itemsToProcess is empty
          // and totalBatches was clamped to 1 via Math.max above).
          if (batchItems.length === 0) {
            break;
          }

          const batchComments = batchItems.flatMap(item => commentsByItemId.get(item.id) ?? []);
          currentBatchIndex = batchIndex;
          currentBatchLength = batchItems.length;

          logLine(`github push: batch ${batchIndex + 1}/${totalBatches} items=${batchItems.length}`);
          // Diagnostic: list batch item ids for debugging why items may be skipped
          try {
            logLine(`github push: batch ${batchIndex + 1} ids=${batchItems.map(i => i.id).join(',')}`);
          } catch (_) {}
          try {
            // Also print to stderr so interactive runs show diagnostics immediately
            console.error(`DEBUG: batch ${batchIndex + 1} ids=${batchItems.map(i => i.id).join(',')}`);
          } catch (_) {}

          let batchResult;
          try {
            batchResult = await upsertIssuesFromWorkItems(
              batchItems,
              batchComments,
              githubConfig,
              renderProgress,
              verboseLog,
              // persistComment - write back github mapping to DB
              (comment) => db.updateComment(comment.id, {
                githubCommentId: comment.githubCommentId ?? null,
                githubCommentUpdatedAt: comment.githubCommentUpdatedAt ?? null,
              })
            );
          } catch (batchError) {
            // If this was a GitHub secondary-rate-limit/abuse detection error,
            // abort the full sync immediately and surface a clear report.
            if (batchError instanceof SecondaryRateLimitError) {
              const details = batchError as SecondaryRateLimitError;
              const batchNumber = batchIndex + 1;
              const failingItems = batchItems.map(i => ({ id: i.id, title: i.title }));
              const reportMsg = `Secondary rate limit detected during GitHub push (batch ${batchNumber}/${totalBatches}). Aborting sync.`;
              logLine(`github push: ${reportMsg}`);
              logLine(`github push: last persisted batch: ${lastPersistedBatch}`);
              logLine(`github push: failing batch items: ${JSON.stringify(failingItems)}`);
              if (details.stderr) logLine(`github push: stderr: ${details.stderr}`);
              if (details.stdout) logLine(`github push: stdout: ${details.stdout}`);

              const userMsg = `GitHub secondary rate limit encountered (HTTP 403 / abuse detection). ` +
                `Stopped after batch ${batchNumber}/${totalBatches}. Last persisted batch: ${lastPersistedBatch}. ` +
                `Please retry later. See logs for details.`;

              if (!isJsonMode) {
                console.error(userMsg);
                if (details.stderr) console.error(`GitHub stderr:\n${details.stderr}`);
              }

              output.error(userMsg, {
                success: false,
                error: details.message || 'secondary rate limit',
                secondaryRateLimit: true,
                repo: githubConfig.repo,
                batch: { index: batchNumber, total: totalBatches, items: failingItems },
                lastPersistedBatch,
                pushStartTimestamp,
                stderr: details.stderr,
                stdout: details.stdout,
              });
              process.exit(1);
            }

            const batchMsg = `Batch ${batchIndex + 1}/${totalBatches} failed: ${(batchError as Error).message}`;
            logLine(`github push: ${batchMsg}`);
            throw new Error(batchMsg);
          }

        // Persist updated item mappings immediately after each successful batch.
          if (batchResult.updatedItems.length > 0) {
            db.upsertItems(batchResult.updatedItems);
            // Throttle state sync writes to reduce GitHub secondary rate limiting.
            // Small delay between writes (default 150ms) helps avoid bursts.
            try {
              const delayMs = Number(process.env.WL_SYNC_WRITE_DELAY_MS || '150');
              if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
            } catch (_) {}
            // Mark this batch as successfully persisted
            lastPersistedBatch = batchIndex + 1;
          }

          // Accumulate results across batches.
          result.updated += batchResult.result.updated;
          result.created += batchResult.result.created;
          result.closed += batchResult.result.closed;
          result.skipped += batchResult.result.skipped;
          result.errors.push(...batchResult.result.errors);
          result.syncedItems.push(...batchResult.result.syncedItems);
          result.errorItems.push(...batchResult.result.errorItems);
          result.commentsCreated = (result.commentsCreated ?? 0) + (batchResult.result.commentsCreated ?? 0);
          result.commentsUpdated = (result.commentsUpdated ?? 0) + (batchResult.result.commentsUpdated ?? 0);

          if (batchResult.result.errors.length > 0) {
            const batchErrorMessage = `github push: batch ${batchIndex + 1}/${totalBatches} errors (${batchResult.result.errors.length}): ${batchResult.result.errors.join(' | ')}`;
            logLine(batchErrorMessage);
            if (!isJsonMode) {
              console.error(batchErrorMessage);
            }
          }

          // Advance the last-push timestamp after each successful batch so
          // interrupted or re-run pushes skip already-synced batches.  Items
          // modified during the push window will still be picked up because
          // pushStartTimestamp was captured before processing began.
          if (writeTimestamp) {
            try {
              writeTimestamp(pushStartTimestamp, dbForMetadata, githubConfig.repo);
              logLine(`github push: batch ${batchIndex + 1}/${totalBatches} timestamp updated to ${pushStartTimestamp}`);
            } catch (_tsErr) {
              logLine(`github push: batch ${batchIndex + 1}/${totalBatches} failed to update timestamp`);
            }
          }

          timing.totalMs += batchResult.timing.totalMs;
          timing.upsertMs += batchResult.timing.upsertMs;
          timing.commentListMs += batchResult.timing.commentListMs;
          timing.commentUpsertMs += batchResult.timing.commentUpsertMs;
          timing.hierarchyCheckMs += batchResult.timing.hierarchyCheckMs;
          timing.hierarchyLinkMs += batchResult.timing.hierarchyLinkMs;
          timing.hierarchyVerifyMs += batchResult.timing.hierarchyVerifyMs;
        }

        // Final timestamp write: per-batch writes cover the common case.
        // This final write handles the edge case where there are zero items to
        // push (the batch loop breaks immediately), ensuring the timestamp is
        // still recorded so the next run doesn\'t re-process items that have
        // already been pushed.
        if (skipUpdateTimestamp) {
          logLine('github push: skipping last-push timestamp update due to --no-update-timestamp');
          if (!isJsonMode) console.log('Note: last-push timestamp was not updated (--no-update-timestamp)');
        } else {
          // Final write to cover zero-item edge case only; per-batch writes
          // already updated the timestamp for normal flows.
          if (writeTimestamp) {
            try {
              writeTimestamp(pushStartTimestamp, dbForMetadata, githubConfig.repo);
            } catch (_tsErr) {
              logLine('github push: failed to write final last-push timestamp');
            }
          }
          if (forceAll) {
            logLine(`github push: full push (--all) completed - lastPush updated to ${pushStartTimestamp}`);
          } else {
            logLine(`github push: lastPush updated from ${lastPush ?? 'none'} to ${pushStartTimestamp}`);
          }
        }

        // Combine skip counts: pre-filter skipped deleted-without-issue items and
        // unchanged items, while upsert reports items skipped because they were
        // already up-to-date. The total skip count is the sum of both.
        const totalSkipped = result.skipped + preFilterSkippedCount + preFilterDeletedWithoutIssueCount;
        logLine(`Repo ${githubConfig.repo}`);
        logLine(`Push summary created=${result.created} updated=${result.updated} closed=${result.closed} skipped=${totalSkipped} (preFilter=${preFilterSkippedCount} deletedWithoutIssue=${preFilterDeletedWithoutIssueCount} upsert=${result.skipped})`);
        if ((result.commentsCreated || 0) > 0 || (result.commentsUpdated || 0) > 0) {
          logLine(`Comment summary created=${result.commentsCreated || 0} updated=${result.commentsUpdated || 0}`);
        }
        if (result.errors.length > 0) {
          logLine(`Errors (${result.errors.length}): ${result.errors.join(' | ')}`);
        }
        logLine(`Timing totalMs=${timing.totalMs} upsertMs=${timing.upsertMs} commentListMs=${timing.commentListMs} commentUpsertMs=${timing.commentUpsertMs}`);
        logLine(`Timing hierarchyCheckMs=${timing.hierarchyCheckMs} hierarchyLinkMs=${timing.hierarchyLinkMs} hierarchyVerifyMs=${timing.hierarchyVerifyMs}`);
        // If metrics were recorded, log them as well
        const metrics = (timing as any).__metrics || {};
        const metricPairs = Object.keys(metrics).map(k => `${k}=${metrics[k]}`);
        if (metricPairs.length > 0) logLine(`Metrics ${metricPairs.join(' ')}`);

        if (isJsonMode) {
          const syncedItemsWithUrls = result.syncedItems.map(si => ({
            action: si.action,
            id: si.id,
            title: si.title,
            url: `https://github.com/${githubConfig.repo}/issues/${si.issueNumber}`,
          }));
          output.json({
            success: true,
            preFilterSkipped: preFilterSkippedCount,
            preFilterDeletedWithoutIssue: preFilterDeletedWithoutIssueCount,
            updated: result.updated,
            created: result.created,
            closed: result.closed,
            skipped: totalSkipped,
            errors: result.errors,
            syncedItems: syncedItemsWithUrls,
            errorItems: result.errorItems,
            commentsCreated: result.commentsCreated,
            commentsUpdated: result.commentsUpdated,
            repo: githubConfig.repo,
          });
        } else {
          // Trigger a single re-sort after github push unless disabled
          try {
            if (!reSortNo) {
              if (typeof (db as any).reSort === 'function') {
                if (reSortSync) (db as any).reSort();
                else void Promise.resolve().then(() => (db as any).reSort());
              }
            }
          } catch (_e) {}

          console.log(`GitHub sync complete (${githubConfig.repo})`);
          console.log(`  Created: ${result.created}`);
          console.log(`  Updated: ${result.updated}`);
          console.log(`  Closed: ${result.closed}`);
          console.log(`  Skipped: ${totalSkipped}`);
          if (preFilterSkippedCount > 0 || preFilterDeletedWithoutIssueCount > 0) {
            const skipParts: string[] = [];
            if (preFilterSkippedCount > 0) skipParts.push(`${preFilterSkippedCount} unchanged since last push`);
            if (preFilterDeletedWithoutIssueCount > 0) skipParts.push(`${preFilterDeletedWithoutIssueCount} deleted without issue number`);
            if (result.skipped > 0) skipParts.push(`${result.skipped} up-to-date`);
            console.log(`    (${skipParts.join(', ')})`);
          }
          if (forceAll) console.log('  Note: --all was used; pre-filter was bypassed');
          if ((result.commentsCreated || 0) > 0 || (result.commentsUpdated || 0) > 0) {
            console.log(`  Comments created: ${result.commentsCreated || 0}`);
            console.log(`  Comments updated: ${result.commentsUpdated || 0}`);
          }
          if (result.errors.length > 0) {
            console.log(`  Errors: ${result.errors.length}`);
            console.log('  Hint: re-run with --json to view error details');
          }
          // Per-item sync output
          if (result.syncedItems.length > 0) {
            console.log('');
            console.log('  Synced items:');
            for (const si of result.syncedItems) {
              const url = `https://github.com/${githubConfig.repo}/issues/${si.issueNumber}`;
              const actionLabel = si.action.padEnd(7);
              console.log(`    ${actionLabel}  ${si.id}  ${si.title}  ${url}`);
            }
          }
          if (result.errorItems.length > 0) {
            console.log('');
            console.log('  Errors:');
            for (const ei of result.errorItems) {
              console.log(`    ${ei.id}  ${ei.title}  ${ei.error}`);
            }
          }
            if (isVerbose) {
              console.log('  Timing breakdown:');
              console.log(`    Total: ${(timing.totalMs / 1000).toFixed(2)}s`);
              console.log(`    Issue upserts: ${(timing.upsertMs / 1000).toFixed(2)}s`);
              console.log(`    Comment list: ${(timing.commentListMs / 1000).toFixed(2)}s`);
              console.log(`    Comment upserts: ${(timing.commentUpsertMs / 1000).toFixed(2)}s`);
              console.log(`    Hierarchy check: ${(timing.hierarchyCheckMs / 1000).toFixed(2)}s`);
              console.log(`    Hierarchy link: ${(timing.hierarchyLinkMs / 1000).toFixed(2)}s`);
              console.log(`    Hierarchy verify: ${(timing.hierarchyVerifyMs / 1000).toFixed(2)}s`);
              // Display metric counts
              const metrics = (timing as any).__metrics || {};
              if (Object.keys(metrics).length > 0) {
                console.log('  API call counts:');
                for (const key of Object.keys(metrics)) {
                  console.log(`    ${key}: ${metrics[key]}`);
                }
              }
            }
        }
        logLine(`--- github push end ${new Date().toISOString()} ---`);
          });
      } catch (error) {
        logLine(`GitHub sync failed: ${(error as Error).message}`);
        output.error(`GitHub sync failed: ${(error as Error).message}`, { success: false, error: (error as Error).message });
        process.exit(1);
      }
    });

  githubCommand
    .command('import')
    .description('Import updates from GitHub Issues')
    .option('--repo <owner/name>', 'GitHub repo (owner/name)')
    .option('--label-prefix <prefix>', 'Label prefix for Worklog labels (default: wl:)')
    .option('--since <iso>', 'Only import issues updated since ISO timestamp (incremental mode; skips full close-check sweep)')
    .option('--create-new', 'Create new work items for issues without markers')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--progress <mode>', 'progress reporting mode (auto|json|human|quiet)', 'auto')
    .action(async (options) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const isJsonMode = utils.isJsonMode();
      const isVerbose = program.opts().verbose;
      // Enable verbose GitHub API logging (to stderr) when --verbose is used
      try { setVerboseLogger(isVerbose ? ((m: string) => console.error(m)) : null); } catch (_) {}
      let lastProgress = '';
      let lastProgressLength = 0;
      const logLine = createLogFileWriter(getWorklogLogPath('github_sync.log'));
      logLine(`--- github import start ${new Date().toISOString()} ---`);
      logLine(`Options json=${isJsonMode} verbose=${isVerbose} createNew=${options.createNew ?? ''} since=${options.since || ''}`);

      const progressMode = (options as any).progress as ProgressMode | undefined;
      const progressReporter = new ProgressReporter({ mode: progressMode ?? (isJsonMode ? 'json' : undefined) });
      const heartbeatIntervalRaw = Number(process.env.WL_GH_IMPORT_HEARTBEAT_MS || '15000');
      const heartbeatIntervalMs = Number.isFinite(heartbeatIntervalRaw) ? Math.max(1000, heartbeatIntervalRaw) : 15000;
      let postImportHeartbeatStarted = false;
      let initialFetchHeartbeatActive = false;
      const renderProgress = (progress: GithubProgress) => {
        const isInitialFetchProgress = progress.phase === 'import' && progress.current === 0 && progress.total === 1;

        if (isInitialFetchProgress && !initialFetchHeartbeatActive) {
          progressReporter.startHeartbeat({
            intervalMs: heartbeatIntervalMs,
            notePrefix: 'heartbeat (issue-list-fetch)',
          });
          initialFetchHeartbeatActive = true;
        } else if (initialFetchHeartbeatActive && !isInitialFetchProgress) {
          progressReporter.stopHeartbeat();
          initialFetchHeartbeatActive = false;
        }

        if (
          !postImportHeartbeatStarted
          && progress.phase === 'import'
          && progress.total > 0
          && progress.current >= progress.total
        ) {
          progressReporter.startHeartbeat({
            intervalMs: heartbeatIntervalMs,
            notePrefix: 'heartbeat (post-import)',
          });
          postImportHeartbeatStarted = true;
        }
        try {
          const s = throttler?.getStats?.();
          if (s) {
            const note = `queue=${s.queueLength} active=${s.active} retries=${s.retryCount} errors=${s.errorCount}`;
            progressReporter.render({ phase: progress.phase, current: progress.current, total: progress.total, note } as any);
            return;
          }
        } catch (_) {}
        progressReporter.render(progress as any);
      };

      try {
        const githubConfig = resolveGithubConfig({ repo: options.repo, labelPrefix: options.labelPrefix });
        const repoUrl = `https://github.com/${githubConfig.repo}/issues`;
        if (!isJsonMode) {
          console.log(`Importing from ${repoUrl}`);
        }
        const items = db.getAll();
        const createNew = resolveGithubImportCreateNew({ createNew: options.createNew });
        const { updatedItems, createdItems, issues, updatedIds, mergedItems, conflictDetails, markersFound, fieldChanges, importedComments } = await importIssuesToWorkItems(items, githubConfig, {
          since: options.since,
          createNew,
          generateId: () => db.generateWorkItemId(),
          generateCommentId: () => db.generatePublicCommentId(),
          onProgress: renderProgress,
        });

        if (mergedItems.length > 0) {
          renderProgress({ phase: 'saving', current: 1, total: 2 });
          db.upsertItems(mergedItems);
        }

        // Persist imported GitHub comments
        if (importedComments.length > 0) {
          renderProgress({ phase: 'saving', current: 2, total: 2 });
          const existingComments = db.getAllComments();
          // Merge: keep existing, add new ones that don't clash by githubCommentId
          const existingGhIds = new Set(
            existingComments
              .filter(c => c.githubCommentId !== undefined)
              .map(c => c.githubCommentId!)
          );
          const newComments = importedComments.filter(
            c => c.githubCommentId === undefined || !existingGhIds.has(c.githubCommentId)
          );
          if (newComments.length > 0) {
            db.importComments([...existingComments, ...newComments]);
          }
        }

        if (createNew && createdItems.length > 0) {
          const { updatedItems: markedItems } = await upsertIssuesFromWorkItems(mergedItems, db.getAllComments(), githubConfig, renderProgress);
          if (markedItems.length > 0) {
            db.upsertItems(markedItems);
          }
        }

        logLine(`Repo ${githubConfig.repo}`);
        logLine(`Import summary updated=${updatedItems.length} created=${createdItems.length} totalIssues=${issues.length} markers=${markersFound}`);
        logLine(`Import config createNew=${createNew} since=${options.since || ''}`);
        for (const fc of fieldChanges) {
          logLine(`[import] ${fc.workItemId} ${fc.field}: ${fc.oldValue} → ${fc.newValue} (source: ${fc.source}, ${fc.timestamp})`);
        }
        logConflictDetails(
          {
            itemsAdded: createdItems.length,
            itemsUpdated: updatedItems.length,
            itemsUnchanged: Math.max(items.length - updatedIds.size, 0),
            commentsAdded: 0,
            commentsUnchanged: 0,
            conflicts: conflictDetails.conflicts,
            conflictDetails: conflictDetails.conflictDetails,
          },
          mergedItems,
          logLine,
          { repoUrl: `https://github.com/${githubConfig.repo}` }
        );

        if (isJsonMode) {
          output.json({
            success: true,
            repo: githubConfig.repo,
            updated: updatedItems.length,
            created: createdItems.length,
            totalIssues: issues.length,
            createNew,
            fieldChanges,
          });
        } else {
          const unchanged = Math.max(items.length - updatedIds.size, 0);
          const totalItems = unchanged + updatedIds.size + createdItems.length;
          const openIssues = issues.filter(issue => issue.state === 'open').length;
          const closedIssues = issues.length - openIssues;
          console.log(`GitHub import complete (${githubConfig.repo})`);
          console.log(`  Work items added: ${createdItems.length}`);
          console.log(`  Work items updated: ${updatedItems.length}`);
          console.log(`  Work items unchanged: ${unchanged}`);
          console.log(`  Issues scanned: ${issues.length} (open: ${openIssues}, closed: ${closedIssues}, worklog: ${markersFound})`);
          console.log(`  Create new: ${createNew ? 'enabled' : 'disabled'}`);
          console.log(`  Total work items: ${totalItems}`);
          if (isVerbose) {
            if (fieldChanges.length > 0) {
              console.log(`  Label-resolved field changes:`);
              for (const fc of fieldChanges) {
                console.log(`    [import] ${fc.workItemId} ${fc.field}: ${fc.oldValue} → ${fc.newValue} (source: ${fc.source}, ${fc.timestamp})`);
              }
            }
            displayConflictDetails(
              {
                itemsAdded: createdItems.length,
                itemsUpdated: updatedItems.length,
                itemsUnchanged: unchanged,
                commentsAdded: 0,
                commentsUnchanged: 0,
                conflicts: conflictDetails.conflicts,
                conflictDetails: conflictDetails.conflictDetails,
              },
              mergedItems,
              { repoUrl: `https://github.com/${githubConfig.repo}` }
            );
          }
        }
        progressReporter.stopHeartbeat();
        logLine(`--- github import end ${new Date().toISOString()} ---`);
      } catch (error) {
        progressReporter.stopHeartbeat();
        logLine(`GitHub import failed: ${(error as Error).message}`);
        output.error(`GitHub import failed: ${(error as Error).message}`, { success: false, error: (error as Error).message });
        process.exit(1);
      }
    });

  githubCommand
    .command('delegate <id>')
    .description('Delegate a work item to GitHub Copilot coding agent')
    .option('--force', 'Bypass do-not-delegate tag guard rail', false)
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (id: string, options: { force?: boolean; prefix?: string }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const isJsonMode = utils.isJsonMode();

      // Resolve work item
      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;
      const item = db.get(normalizedId);
      if (!item) {
        output.error(`Work item not found: ${normalizedId}`, {
          success: false,
          error: `Work item not found: ${normalizedId}`,
        });
        process.exit(1);
      }

      // CLI-specific guard rail: interactive children prompt
      // (The helper handles children as a non-blocking warning, but the CLI
      //  gives the user a chance to abort in interactive mode.)
      const children = db.getChildren(normalizedId);
      if (children.length > 0) {
        const nonClosedChildren = children.filter(
          c => c.status !== 'completed' && c.status !== 'deleted'
        );
        if (nonClosedChildren.length > 0) {
          const isInteractive = !isJsonMode && process.stdout.isTTY === true && process.stdin.isTTY === true;
          if (isInteractive) {
            const readline = await import('node:readline');
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise<string>(resolve => {
              rl.question(
                `Work item ${normalizedId} has ${nonClosedChildren.length} open child item(s). ` +
                `Only the specified item will be delegated. Continue? (y/N): `,
                resolve
              );
            });
            rl.close();
            if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
              if (!isJsonMode) {
                console.log('Delegation cancelled.');
              }
              process.exit(0);
            }
          }
        }
      }

      // Resolve GitHub config and delegate via shared helper
      let result: DelegateResult;
      try {
        const githubConfig = resolveGithubConfig({ repo: (options as any).repo, labelPrefix: (options as any).labelPrefix });

        result = await delegateWorkItem(
          db,
          githubConfig,
          normalizedId,
          { force: options.force },
        );
      } catch (error) {
        const message = `Delegation failed: ${(error as Error).message}`;
        output.error(message, {
          success: false,
          error: (error as Error).message,
          workItemId: normalizedId,
        });
        process.exit(1);
        return; // unreachable, but satisfies TS that result is assigned
      }

      // Print warnings (children, force-override) in non-JSON mode
      if (!isJsonMode && result.warnings) {
        for (const w of result.warnings) {
          console.log(`Warning: ${w}`);
        }
      }

      if (!result.success) {
        // Map helper error keys to CLI output
        if (result.error === 'do-not-delegate') {
          const message = `Work item ${normalizedId} has a "do-not-delegate" tag. Use --force to override.`;
          output.error(message, {
            success: false,
            error: 'do-not-delegate',
            workItemId: normalizedId,
          });
          process.exit(1);
        }

        // Assignment failure — helper already added comment and re-pushed
        if (result.pushed && result.assigned === false && result.issueNumber) {
          const failureMessage =
            `Failed to assign @copilot to GitHub issue #${result.issueNumber}: ${result.error}. Local state was not updated.`;
          output.error(failureMessage, {
            success: false,
            error: result.error,
            workItemId: normalizedId,
            issueNumber: result.issueNumber,
            issueUrl: result.issueUrl,
            pushed: true,
            assigned: false,
          });
          process.exit(1);
        }

        // Generic failure (push error, issue number resolution, etc.)
        const message = `Delegation failed: ${result.error}`;
        output.error(message, {
          success: false,
          error: result.error,
          workItemId: normalizedId,
        });
        process.exit(1);
      }

      // Success path
      if (isJsonMode) {
        output.json({
          success: true,
          workItemId: normalizedId,
          issueNumber: result.issueNumber,
          issueUrl: result.issueUrl,
          pushed: true,
          assigned: true,
        });
      } else {
        console.log(`Pushing to GitHub... done.`);
        console.log(`Assigning to @copilot... done.`);
        console.log(`Done. Issue: ${result.issueUrl}`);
      }
    });
}
