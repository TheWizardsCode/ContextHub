/**
 * GitHub command - GitHub Issue sync commands (push and import)
 */

import type { PluginContext } from '../plugin-types.js';
import { getRepoFromGitRemote, normalizeGithubLabelPrefix } from '../github.js';
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
    .option('--force', 'Deprecated alias for --all (bypass pre-filter and process all items)', false)
    .option('--no-update-timestamp', 'Do not write last-push timestamp after push')
    .option('--id <work-item-id>', 'Push a single work item by ID')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (options) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const isJsonMode = utils.isJsonMode();
      const isVerbose = program.opts().verbose;
      let lastProgress = '';
      let lastProgressLength = 0;
      const logLine = createLogFileWriter(getWorklogLogPath('github_sync.log'));
      logLine(`--- github push start ${new Date().toISOString()} ---`);
      logLine(`Options json=${isJsonMode} verbose=${isVerbose}`);

      const renderProgress = (progress: GithubProgress) => {
        if (isJsonMode || process.stdout.isTTY !== true) {
          return;
        }
        const label = progress.phase === 'push'
          ? 'Push'
          : progress.phase === 'import'
            ? 'Import'
            : progress.phase === 'hierarchy'
              ? 'Hierarchy'
              : progress.phase === 'comments'
                ? 'Comments'
                : progress.phase === 'saving'
                  ? 'Saving'
                  : 'Close check';
        const message = `${label}: ${progress.current}/${progress.total}`;
        if (message === lastProgress) {
          return;
        }
        lastProgress = message;
        const padded = `${message} `.padEnd(lastProgressLength, ' ');
        lastProgressLength = padded.length;
        process.stdout.write(`\r${padded}`);
        if (progress.current === progress.total) {
          process.stdout.write('\n');
          lastProgress = '';
          lastProgressLength = 0;
        }
      };

      try {
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

        const forceAll = Boolean(options.all) || Boolean(options.force);
        if (forceAll) {
          // Bypass pre-filter when --all (or deprecated --force) specified
          if (!isJsonMode) console.log(`Full push (--all): processing all ${items.length} items`);
          logLine('github push: --all mode enabled - processing all items');
        } else {
          // Pre-filter items to only those changed since last push or never pushed
          try {
            const { readLastPushTimestamp, filterItemsForPush } = await import('../github-pre-filter.js');
            lastPush = readLastPushTimestamp(dbForMetadata);
            const { filteredItems, filteredComments, totalCandidates, skippedCount } = filterItemsForPush(items, comments, lastPush);
            itemsToProcess = filteredItems;
            commentsToProcess = filteredComments;
            if (!isJsonMode) {
              console.log(`Processing ${itemsToProcess.length} of ${totalCandidates} items (${skippedCount} skipped, unchanged since last push)`);
            }
            logLine(`github push: pre-filtered items lastPush=${lastPush ?? 'none'} processed=${itemsToProcess.length} totalCandidates=${totalCandidates} skipped=${skippedCount}`);
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
          const singleItem = itemsToProcess.find(i => i.id === options.id);
          if (!singleItem) {
            throw new Error(`Work item '${options.id}' not found (or not a candidate for push).`);
          }
          itemsToProcess = [singleItem];
          commentsToProcess = commentsToProcess.filter(c => c.workItemId === options.id);
          logLine(`github push: --id mode; pushing single item ${options.id}`);
        }

        // Capture push-start timestamp BEFORE processing begins so that items
        // modified during the push window are re-processed on the next run.
        const pushStartTimestamp = new Date().toISOString();

        const verboseLog = isVerbose && !isJsonMode
          ? (message: string) => console.log(message)
          : undefined;

        // Process items in fixed batches of 10 so progress is persisted after
        // each batch and a single failure does not require reprocessing everything.
        const BATCH_SIZE = 10;
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

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const batchStart = batchIndex * BATCH_SIZE;
          const batchItems = itemsToProcess.slice(batchStart, batchStart + BATCH_SIZE);
          // Guard: skip if slice is empty (can only happen when itemsToProcess is empty
          // and totalBatches was clamped to 1 via Math.max above).
          if (batchItems.length === 0) {
            break;
          }

          const batchComments = batchItems.flatMap(item => commentsByItemId.get(item.id) ?? []);

          logLine(`github push: batch ${batchIndex + 1}/${totalBatches} items=${batchItems.length}`);

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
            const batchMsg = `Batch ${batchIndex + 1}/${totalBatches} failed: ${(batchError as Error).message}`;
            logLine(`github push: ${batchMsg}`);
            throw new Error(batchMsg);
          }

          // Persist updated item mappings immediately after each successful batch.
          if (batchResult.updatedItems.length > 0) {
            db.upsertItems(batchResult.updatedItems);
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

          timing.totalMs += batchResult.timing.totalMs;
          timing.upsertMs += batchResult.timing.upsertMs;
          timing.commentListMs += batchResult.timing.commentListMs;
          timing.commentUpsertMs += batchResult.timing.commentUpsertMs;
          timing.hierarchyCheckMs += batchResult.timing.hierarchyCheckMs;
          timing.hierarchyLinkMs += batchResult.timing.hierarchyLinkMs;
          timing.hierarchyVerifyMs += batchResult.timing.hierarchyVerifyMs;
        }

        // Update the last-push timestamp unless --no-update-timestamp was provided.
        // Uses pushStartTimestamp captured before processing so items modified
        // during the push are re-processed on the next run.
        try {
          const { writeLastPushTimestamp } = await import('../github-pre-filter.js');
          // Commander creates a negated option as `updateTimestamp` (true by default)
          // while some callers may inspect `noUpdateTimestamp`. Support both forms here.
          const skipUpdateTimestamp = Boolean(options.noUpdateTimestamp) || options.updateTimestamp === false;
          if (skipUpdateTimestamp) {
            logLine('github push: skipping last-push timestamp update due to --no-update-timestamp');
            if (!isJsonMode) console.log('Note: last-push timestamp was not updated (--no-update-timestamp)');
          } else {
            writeLastPushTimestamp(pushStartTimestamp, dbForMetadata);
            if (forceAll) {
              // In --all mode still update timestamp but record that it was a full push
              logLine(`github push: full push (--all) completed - lastPush updated to ${pushStartTimestamp}`);
            } else {
              logLine(`github push: lastPush updated from ${lastPush ?? 'none'} to ${pushStartTimestamp}`);
            }
          }
        } catch (_err) {
          // non-fatal
          logLine('github push: failed to write last-push timestamp');
        }

        logLine(`Repo ${githubConfig.repo}`);
        logLine(`Push summary created=${result.created} updated=${result.updated} closed=${result.closed} skipped=${result.skipped}`);
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
          const errorItemsJson = result.errorItems.map(ei => ({
            id: ei.id,
            title: ei.title,
            error: ei.error,
          }));
          output.json({
            success: true,
            ...result,
            syncedItems: syncedItemsWithUrls,
            errorItems: errorItemsJson,
            repo: githubConfig.repo,
          });
        } else {
          console.log(`GitHub sync complete (${githubConfig.repo})`);
          console.log(`  Created: ${result.created}`);
          console.log(`  Updated: ${result.updated}`);
          console.log(`  Closed: ${result.closed}`);
          console.log(`  Skipped: ${result.skipped}`);
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
    .option('--since <iso>', 'Only import issues updated since ISO timestamp')
    .option('--create-new', 'Create new work items for issues without markers')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (options) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const isJsonMode = utils.isJsonMode();
      const isVerbose = program.opts().verbose;
      let lastProgress = '';
      let lastProgressLength = 0;
      const logLine = createLogFileWriter(getWorklogLogPath('github_sync.log'));
      logLine(`--- github import start ${new Date().toISOString()} ---`);
      logLine(`Options json=${isJsonMode} verbose=${isVerbose} createNew=${options.createNew ?? ''} since=${options.since || ''}`);

      const renderProgress = (progress: GithubProgress) => {
        if (isJsonMode || process.stdout.isTTY !== true) {
          return;
        }
        const label = progress.phase === 'push'
          ? 'Push'
          : progress.phase === 'import'
            ? 'Import'
            : progress.phase === 'hierarchy'
              ? 'Hierarchy'
              : progress.phase === 'comments'
                ? 'Comments'
                : progress.phase === 'saving'
                  ? 'Saving'
                  : 'Close check';
        const message = `${label}: ${progress.current}/${progress.total}`;
        if (message === lastProgress) {
          return;
        }
        lastProgress = message;
        const padded = `${message} `.padEnd(lastProgressLength, ' ');
        lastProgressLength = padded.length;
        process.stdout.write(`\r${padded}`);
        if (progress.current === progress.total) {
          process.stdout.write('\n');
          lastProgress = '';
          lastProgressLength = 0;
        }
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
        logLine(`--- github import end ${new Date().toISOString()} ---`);
      } catch (error) {
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
