/**
 * GitHub command - GitHub Issue sync commands (push and import)
 */

import type { PluginContext } from '../plugin-types.js';
import { getRepoFromGitRemote, normalizeGithubLabelPrefix } from '../github.js';
import { upsertIssuesFromWorkItems, importIssuesToWorkItems, GithubProgress } from '../github-sync.js';
import { loadConfig } from '../config.js';
import { displayConflictDetails } from './helpers.js';
import { createLogFileWriter, getWorklogLogPath, logConflictDetails } from '../logging.js';

function resolveGithubConfig(options: { repo?: string; labelPrefix?: string }) {
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
    .option('--force', 'Bypass pre-filter and process all items')
    .option('--no-update-timestamp', 'Do not write last-push timestamp after push')
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

        if (options.force) {
          // Bypass pre-filter when --force specified
          if (!isJsonMode) console.log('Force push: processing all items (pre-filter bypassed)');
          logLine('github push: force mode enabled - processing all items');
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

        const verboseLog = isVerbose && !isJsonMode
          ? (message: string) => console.log(message)
          : undefined;
        const { updatedItems, result, timing } = await upsertIssuesFromWorkItems(
          itemsToProcess,
          commentsToProcess,
          githubConfig,
          renderProgress,
          verboseLog,
          // persistComment - write back github mapping to DB
          (comment) => db.updateComment(comment.id, {
            githubCommentId: comment.githubCommentId ?? null,
            githubCommentUpdatedAt: comment.githubCommentUpdatedAt ?? null,
          })
        );
        if (updatedItems.length > 0) {
          db.import(updatedItems);
        }

        // Update the last-push timestamp unless --no-update-timestamp was provided.
          try {
            const { writeLastPushTimestamp } = await import('../github-pre-filter.js');
            const nowIso = new Date().toISOString();
          // Commander creates a negated option as `updateTimestamp` (true by default)
          // while some callers may inspect `noUpdateTimestamp`. Support both forms here.
          const skipUpdateTimestamp = Boolean(options.noUpdateTimestamp) || options.updateTimestamp === false;
           if (skipUpdateTimestamp) {
              logLine('github push: skipping last-push timestamp update due to --no-update-timestamp');
              if (!isJsonMode) console.log('Note: last-push timestamp was not updated (--no-update-timestamp)');
            } else {
            writeLastPushTimestamp(nowIso, dbForMetadata);
            if (options.force) {
              // In force mode still update timestamp but record that it was a forced push
              logLine(`github push: force push completed - lastPush updated to ${nowIso}`);
            } else {
              logLine(`github push: lastPush updated from ${lastPush ?? 'none'} to ${nowIso}`);
            }
          }
        } catch (_err) {
          // non-fatal
          logLine('github push: failed to write last-push timestamp');
        }

        logLine(`Repo ${githubConfig.repo}`);
        logLine(`Push summary created=${result.created} updated=${result.updated} skipped=${result.skipped}`);
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
          output.json({ success: true, ...result, repo: githubConfig.repo });
        } else {
          console.log(`GitHub sync complete (${githubConfig.repo})`);
          console.log(`  Created: ${result.created}`);
          console.log(`  Updated: ${result.updated}`);
          console.log(`  Skipped: ${result.skipped}`);
          if (options.force) console.log('  Note: --force was used; pre-filter was bypassed');
          if ((result.commentsCreated || 0) > 0 || (result.commentsUpdated || 0) > 0) {
            console.log(`  Comments created: ${result.commentsCreated || 0}`);
            console.log(`  Comments updated: ${result.commentsUpdated || 0}`);
          }
          if (result.errors.length > 0) {
            console.log(`  Errors: ${result.errors.length}`);
            console.log('  Hint: re-run with --json to view error details');
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
        const { updatedItems, createdItems, issues, updatedIds, mergedItems, conflictDetails, markersFound } = importIssuesToWorkItems(items, githubConfig, {
          since: options.since,
          createNew,
          generateId: () => db.generateWorkItemId(),
          onProgress: renderProgress,
        });

        if (mergedItems.length > 0) {
          db.import(mergedItems);
        }

        if (createNew && createdItems.length > 0) {
          const { updatedItems: markedItems } = await upsertIssuesFromWorkItems(mergedItems, db.getAllComments(), githubConfig, renderProgress);
          if (markedItems.length > 0) {
            db.import(markedItems);
          }
        }

        logLine(`Repo ${githubConfig.repo}`);
        logLine(`Import summary updated=${updatedItems.length} created=${createdItems.length} totalIssues=${issues.length} markers=${markersFound}`);
        logLine(`Import config createNew=${createNew} since=${options.since || ''}`);
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
}
