/**
 * Sync command - Sync work items with git repository
 */

import type { PluginContext } from '../plugin-types.js';
import type { SyncOptions, SyncDebugOptions } from '../cli-types.js';
import type { WorkItem, Comment, DependencyEdge } from '../types.js';
import type { GitTarget, SyncResult } from '../sync.js';
import { getRemoteDataFileContent, gitPushDataFileToBranch, mergeWorkItems, mergeComments, mergeDependencyEdges } from '../sync.js';
import { DEFAULT_GIT_REMOTE, DEFAULT_GIT_BRANCH } from '../sync-defaults.js';
import { importFromJsonlContent } from '../jsonl.js';
import { mergeAuditResults } from '../sync.js';
import { loadConfig } from '../config.js';
import { displayConflictDetails } from './helpers.js';
import { createLogFileWriter, getWorklogLogPath, logConflictDetails } from '../logging.js';
import { withFileLock, getLockPathForJsonl } from '../file-lock.js';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';

const execAsync = promisify(childProcess.exec);

function getSyncDefaults(config?: ReturnType<typeof loadConfig>) {
  return {
    gitRemote: config?.syncRemote || DEFAULT_GIT_REMOTE,
    gitBranch: config?.syncBranch || DEFAULT_GIT_BRANCH,
  };
}

async function performSync(
  program: any,
  dataPath: string,
  getDatabase: (prefix?: string) => any,
  options: {
    file: string;
    prefix?: string;
    gitRemote: string;
    gitBranch: string;
    push: boolean;
    dryRun: boolean;
    silent?: boolean;
  }
): Promise<SyncResult> {
  const isJsonMode = program.opts().json;
  const isVerbose = program.opts().verbose;
  const isSilent = options.silent || false;
  const logPath = getWorklogLogPath('sync.log');
  const logLine = createLogFileWriter(logPath);
  logLine(`--- sync start ${new Date().toISOString()} file=${options.file} ---`);
  logLine(`Options json=${isJsonMode} verbose=${isVerbose} dryRun=${options.dryRun} push=${options.push}`);
  logLine(`Starting sync for ${options.file}...`);
  
  const db = getDatabase(options.prefix);
  const localItems = db.getAll();
  const localComments = db.getAllComments();
  const localEdges = db.getAllDependencyEdges();
  logLine(`Local state: ${localItems.length} work items, ${localComments.length} comments`);
  
  if (!isJsonMode && !isSilent) {
    console.log(`Starting sync for ${options.file}...`);
    console.log(`Local state: ${localItems.length} work items, ${localComments.length} comments`);
    
    if (options.dryRun) {
      console.log('\n[DRY RUN MODE - No changes will be made]');
    }
    
    console.log('\nPulling latest changes from git...');
  }
  
  const gitTarget: GitTarget = {
    remote: options.gitRemote,
    branch: options.gitBranch,
  };

  let remoteItems: WorkItem[] = [];
  let remoteComments: Comment[] = [];
  let remoteEdges: DependencyEdge[] = [];

  const localAudits = db.getAllAuditResults();
  
  const remoteContent = await getRemoteDataFileContent(options.file, gitTarget);
  let remoteAudits: any[] = [];
  if (remoteContent) {
    const remoteData = importFromJsonlContent(remoteContent);
    remoteItems = remoteData.items;
    remoteComments = remoteData.comments;
    remoteEdges = remoteData.dependencyEdges || [];
    remoteAudits = remoteData.auditResults || [];
  }

  if (!isJsonMode && !isSilent) {
    console.log(`Remote state: ${remoteItems.length} work items, ${remoteComments.length} comments`);
  }
  logLine(`Remote state: ${remoteItems.length} work items, ${remoteComments.length} comments`);
  
  if (!isJsonMode && !isSilent) {
    console.log('\nMerging work items...');
  }
  const itemMergeResult = mergeWorkItems(localItems, remoteItems);
  
  if (!isJsonMode && !isSilent) {
    console.log('Merging comments...');
  }
  const commentMergeResult = mergeComments(localComments, remoteComments);
  const edgeMergeResult = mergeDependencyEdges(localEdges, remoteEdges || []);
  
  if (!isJsonMode && !isSilent) {
    console.log('Merging audit results...');
  }
  const auditMergeResult = mergeAuditResults(localAudits, remoteAudits);
  
  const itemsAdded = itemMergeResult.merged.length - localItems.length;
  const itemsUpdated = itemMergeResult.conflicts.filter(c => c.includes('Conflicting fields') || c.includes('Same updatedAt')).length;
  const itemsUnchanged = Math.max(0, localItems.length - Math.max(0, itemsUpdated));
  const commentsAdded = commentMergeResult.merged.length - localComments.length;
  const commentsUnchanged = Math.max(0, localComments.length - Math.max(0, commentsAdded));

  const result: SyncResult = {
    itemsAdded,
    itemsUpdated,
    itemsUnchanged,
    commentsAdded,
    commentsUnchanged,
    conflicts: itemMergeResult.conflicts,
    conflictDetails: itemMergeResult.conflictDetails
  };
  
  const finalizeLog = () => {
    logLine(`Sync summary itemsAdded=${result.itemsAdded} itemsUpdated=${result.itemsUpdated} itemsUnchanged=${result.itemsUnchanged}`);
    logLine(`Sync summary commentsAdded=${result.commentsAdded} commentsUnchanged=${result.commentsUnchanged}`);
    logLine(`--- sync end ${new Date().toISOString()} ---`);
  };

  if (isJsonMode && !isSilent) {
    if (options.dryRun) {
      console.log(JSON.stringify({
        success: true,
        dryRun: true,
        sync: {
          file: options.file,
          localState: {
            workItems: localItems.length,
            comments: localComments.length
          },
          remoteState: {
            workItems: remoteItems.length,
            comments: remoteComments.length
          },
          summary: result
        }
      }, null, 2));
      logConflictDetails(result, itemMergeResult.merged, logLine);
      finalizeLog();
      return result;
    }
  } else if (!isSilent) {
    if (isVerbose) {
      displayConflictDetails(result, itemMergeResult.merged);
    } else {
      logLine('Conflict details suppressed (run with --verbose to print).');
    }
    
    console.log('\nSync summary:');
    console.log(`  Work items added: ${result.itemsAdded}`);
    console.log(`  Work items updated: ${result.itemsUpdated}`);
    console.log(`  Work items unchanged: ${result.itemsUnchanged}`);
    console.log(`  Comments added: ${result.commentsAdded}`);
    console.log(`  Comments unchanged: ${result.commentsUnchanged}`);
    console.log(`  Total work items: ${itemMergeResult.merged.length}`);
    console.log(`  Total comments: ${commentMergeResult.merged.length}`);
    
    if (options.dryRun) {
      console.log('\n[DRY RUN MODE - No changes were made]');
      logConflictDetails(result, itemMergeResult.merged, logLine);
      finalizeLog();
      return result;
    }
  }
  
  if (options.dryRun) {
    logConflictDetails(result, itemMergeResult.merged, logLine);
    finalizeLog();
    return result;
  }
  
  const config = loadConfig();
  const autoSyncEnabled = config?.autoSync === true;
  if (autoSyncEnabled) {
    db.setAutoSync(false);
  }
  // SAFETY: db.import() is destructive (clears all items before inserting).
  // This is safe here because itemMergeResult.merged is the complete merged
  // set of local + remote items — no data is lost.
  db.import(itemMergeResult.merged, edgeMergeResult.merged, auditMergeResult.merged);
  db.importComments(commentMergeResult.merged);
  if (autoSyncEnabled) {
    db.setAutoSync(true, () => Promise.resolve());
  }
  
  if (!isJsonMode && !isSilent) {
    console.log('\nMerged data saved locally');
  }

  // Ephemeral JSONL pattern: Export SQLite → JSONL → Push → Delete local JSONL
  // JSONL only exists transiently during sync operations
  // Provide a small progress handler so CLI users see export progress.
  const progressHandler = (evt: { type: 'progress' | 'done' | 'error'; percent?: number; itemsProcessed?: number; mtimeMs?: number; error?: string }) => {
    if (isJsonMode) return; // avoid polluting JSON output
    try {
      if (evt.type === 'progress') {
        const pct = typeof evt.percent === 'number' ? `${evt.percent}%` : '';
        const items = typeof evt.itemsProcessed === 'number' ? ` ${evt.itemsProcessed} processed` : '';
        // Write to stderr and keep carriage return so it updates in place
        process.stderr.write(`\rExporting JSONL: ${pct}${items}`);
      } else if (evt.type === 'done') {
        process.stderr.write('\rExport complete.                      \n');
      } else if (evt.type === 'error') {
        process.stderr.write('\rExport error: ' + (evt.error || 'unknown') + '\n');
      }
    } catch {
      // ignore handler errors
    }
  };

  const jsonlPath = await db.exportForSync({ onProgress: progressHandler });
  
  if (options.push) {
    if (!isJsonMode && !isSilent) {
      console.log('\nPushing changes to git...');
    }
    
    try {
      await gitPushDataFileToBranch(jsonlPath, 'Sync work items and comments', gitTarget);
      if (!isJsonMode && !isSilent) {
        console.log('Changes pushed successfully');
      }
      
      // Delete local JSONL file after successful push (ephemeral pattern)
      // Only delete if push succeeded - keep for retry on failure
      db.deleteLocalJsonl();
      
      if (!isJsonMode && !isSilent) {
        console.log('Local JSONL file cleaned up (ephemeral pattern)');
      }
    } catch (pushError) {
      // Push failed - keep JSONL for retry, but report the error
      if (!isJsonMode && !isSilent) {
        console.log('\nPush failed - local JSONL file retained for retry');
      }
      throw pushError;
    }
  } else {
    if (!isJsonMode && !isSilent) {
      console.log('\nSkipping git push (--no-push flag)');
      console.log('Local JSONL file retained (ephemeral pattern - file will be deleted on next successful push)');
    }
  }
  
  if (isJsonMode && !isSilent) {
    console.log(JSON.stringify({
      success: true,
      message: 'Sync completed successfully',
      sync: {
        file: options.file,
        summary: result,
        pushed: options.push
      }
    }, null, 2));
  } else if (!isSilent) {
    console.log('\n✓ Sync completed successfully');
  }

  logConflictDetails(result, itemMergeResult.merged, logLine);
  finalizeLog();
  
  return result;
}

async function getGitInfo(remote: string): Promise<{ repoRoot?: string; currentBranch?: string; remoteUrl?: string; error?: string }> {
  try {
    const { stdout: repoRoot } = await execAsync('git rev-parse --show-toplevel');
    const { stdout: currentBranch } = await execAsync('git rev-parse --abbrev-ref HEAD');
    let remoteUrl: string | undefined;
    try {
      const { stdout } = await execAsync(`git remote get-url ${remote}`);
      remoteUrl = stdout.trim();
    } catch {
      remoteUrl = undefined;
    }
    return {
      repoRoot: repoRoot.trim(),
      currentBranch: currentBranch.trim(),
      remoteUrl
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function getLocalDataInfo(filePath: string): { exists: boolean; items: number; comments: number; bytes: number } {
  if (!fs.existsSync(filePath)) {
    return { exists: false, items: 0, comments: 0, bytes: 0 };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const data = importFromJsonlContent(content);
  const bytes = Buffer.byteLength(content, 'utf-8');
  return {
    exists: true,
    items: data.items.length,
    comments: data.comments.length,
    bytes
  };
}

export default function register(ctx: PluginContext): void {
  const { program, dataPath, output, utils } = ctx;

  const syncCommand = program
    .command('sync')
    .description('Sync work items with git repository (pull, merge with conflict resolution, and push)')
    .option('-f, --file <filepath>', 'Data file path', dataPath)
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--git-remote <remote>', 'Git remote to use for syncing data', DEFAULT_GIT_REMOTE)
    .option('--git-branch <ref>', 'Git ref to store worklog data (use refs/worklog/data to avoid GitHub PR banners)', DEFAULT_GIT_BRANCH)
    .option('--no-push', 'Skip pushing changes back to git')
    .option('--dry-run', 'Show what would be synced without making changes')
    .option('--no-re-sort', 'Skip automatic re-sort after sync')
    .option('--re-sort-sync', 'Force a synchronous re-sort after sync', false)
    .action(async (options: SyncOptions) => {
      utils.requireInitialized();
      const isJsonMode = utils.isJsonMode();

      const config = utils.getConfig();
      const defaults = getSyncDefaults(config || undefined);
      const gitRemote = options.gitRemote || defaults.gitRemote;
      const gitBranch = options.gitBranch || defaults.gitBranch;
      
      // Re-sort control options (apply once after batch completes)
      const reSortNo = Boolean((options as any).noReSort) || false;
      const reSortSync = Boolean((options as any).reSortSync) || false;

      try {
        const lockPath = getLockPathForJsonl(options.file || dataPath);
        await withFileLock(lockPath, () =>
          performSync(program, dataPath, utils.getDatabase, {
            file: options.file || dataPath,
            prefix: options.prefix,
            gitRemote,
            gitBranch,
            push: options.push ?? true,
            dryRun: options.dryRun ?? false,
            silent: false
          })
        );
      } catch (error) {
        if (isJsonMode) {
          output.json({
            success: false,
            error: (error as Error).message
          });
        } else {
          console.error('\n✗ Sync failed:', (error as Error).message);
        }
        process.exit(1);
      }

      // After sync completes, run a single re-sort unless disabled
      try {
        const db = utils.getDatabase(options.prefix);
        if (!reSortNo && typeof (db as any).reSort === 'function') {
          if (reSortSync) (db as any).reSort();
          else void Promise.resolve().then(() => (db as any).reSort());
        }
      } catch (_e) {}
    });

  syncCommand
    .command('debug')
    .description('Show sync diagnostics (data path, git ref, local/remote counts)')
    .option('-f, --file <filepath>', 'Data file path', dataPath)
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--git-remote <remote>', 'Git remote to use for syncing data', DEFAULT_GIT_REMOTE)
    .option('--git-branch <ref>', 'Git ref to store worklog data (use refs/worklog/data to avoid GitHub PR banners)', DEFAULT_GIT_BRANCH)
    .action(async (options: SyncDebugOptions) => {
      utils.requireInitialized();
      const isJsonMode = utils.isJsonMode();

      const config = utils.getConfig();
      const defaults = getSyncDefaults(config || undefined);
      const gitRemote = options.gitRemote || defaults.gitRemote;
      const gitBranch = options.gitBranch || defaults.gitBranch;
      const filePath = options.file || dataPath;

      const gitInfo = await getGitInfo(gitRemote);
      const localInfo = getLocalDataInfo(filePath);
      let remoteInfo: { exists: boolean; items: number; comments: number; bytes: number; error?: string } = {
        exists: false,
        items: 0,
        comments: 0,
        bytes: 0
      };

      try {
        const gitTarget: GitTarget = { remote: gitRemote, branch: gitBranch };
        const remoteContent = await getRemoteDataFileContent(filePath, gitTarget);
        if (remoteContent) {
          const remoteData = importFromJsonlContent(remoteContent);
          remoteInfo = {
            exists: true,
            items: remoteData.items.length,
            comments: remoteData.comments.length,
            bytes: Buffer.byteLength(remoteContent, 'utf-8')
          };
        }
      } catch (error) {
        remoteInfo = {
          exists: false,
          items: 0,
          comments: 0,
          bytes: 0,
          error: (error as Error).message
        };
      }

      const payload = {
        success: true,
        debug: {
          file: filePath,
          git: {
            remote: gitRemote,
            branch: gitBranch,
            repoRoot: gitInfo.repoRoot,
            currentBranch: gitInfo.currentBranch,
            remoteUrl: gitInfo.remoteUrl,
            error: gitInfo.error
          },
          local: localInfo,
          remote: remoteInfo
        }
      };

      if (isJsonMode) {
        output.json(payload);
        return;
      }

      console.log('Sync Debug');
      console.log(`Data file: ${filePath}`);
      console.log(`Git remote: ${gitRemote}`);
      console.log(`Git ref: ${gitBranch}`);
      if (gitInfo.repoRoot) console.log(`Repo root: ${gitInfo.repoRoot}`);
      if (gitInfo.currentBranch) console.log(`Current branch: ${gitInfo.currentBranch}`);
      if (gitInfo.remoteUrl) console.log(`Remote URL: ${gitInfo.remoteUrl}`);
      if (gitInfo.error) console.log(`Git error: ${gitInfo.error}`);
      console.log(`Local data: ${localInfo.exists ? 'present' : 'missing'} (${localInfo.items} items, ${localInfo.comments} comments, ${localInfo.bytes} bytes)`);
      if (remoteInfo.error) {
        console.log(`Remote data: error (${remoteInfo.error})`);
      } else {
        console.log(`Remote data: ${remoteInfo.exists ? 'present' : 'missing'} (${remoteInfo.items} items, ${remoteInfo.comments} comments, ${remoteInfo.bytes} bytes)`);
      }
    });
}
