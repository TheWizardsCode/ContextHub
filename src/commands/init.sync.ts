/**
 * init sync — one-shot database/JSONL/git bootstrap for `wl init`.
 *
 * Single responsibility: on `wl init`, merge the local SQLite store with the
 * remote data file, persist the merged set under the store mutation lock and
 * push the result to the sync branch. Declares no prompts, no path
 * provisioning and no command wiring, and never imports `init.ts` or
 * `init.register.ts`.
 *
 * Dependency direction: `init.paths.ts` (sync defaults) plus the existing
 * `../config.js`, `../database.js`, `../jsonl.js`, `../sync.js`,
 * `../sync-defaults.js` and `../mutation-lock.js` modules.
 */

import type { DependencyEdge } from '../types.js';
import { loadConfig } from '../config.js';
import { exportToJsonlAsync, importFromJsonlContent } from '../jsonl.js';
import { getRemoteDataFileContent, gitPushDataFileToBranch, mergeWorkItems, mergeComments, mergeDependencyEdges, mergeAuditResults } from '../sync.js';
import { DEFAULT_GIT_REMOTE, DEFAULT_GIT_BRANCH } from '../sync-defaults.js';
import { withStoreMutationLock } from '../mutation-lock.js';
import { getSyncDefaults } from './init.paths.js';

export async function performInitSync(dataPath: string, prefix?: string, isJsonMode: boolean = false): Promise<void> {
  const config = loadConfig();
  const defaults = getSyncDefaults(config || undefined);
  // Create DB to import items and comments separately.
  // We'll write the merged JSONL once after both imports are applied.
  const db = new (await import('../database.js')).WorklogDatabase(
    prefix || config?.prefix || 'WL',
    undefined,
    dataPath
  );
  
  const localItems = db.getAll();
  const localComments = db.getAllComments();
  const localEdges = db.getAllDependencyEdges();
  const localAudits = db.getAllAuditResults();
  
  // The sync target is always well-defined: `getSyncDefaults` resolves the
  // configured remote/branch and the package defaults are the last resort when
  // a caller's config leaves them empty.
  const gitTarget = {
    remote: defaults.gitRemote || DEFAULT_GIT_REMOTE,
    branch: defaults.gitBranch || DEFAULT_GIT_BRANCH,
  };
  const remoteContent = await getRemoteDataFileContent(dataPath, gitTarget);
  
  let remoteItems: any[] = [];
  let remoteComments: any[] = [];
  let remoteEdges: DependencyEdge[] = [];
  let remoteAudits: any[] = [];
  if (remoteContent) {
    const remoteData = importFromJsonlContent(remoteContent);
    remoteItems = remoteData.items;
    remoteComments = remoteData.comments;
    remoteEdges = remoteData.dependencyEdges || [];
    remoteAudits = remoteData.auditResults || [];
  }
  
  const itemMergeResult = mergeWorkItems(localItems, remoteItems);
  const commentMergeResult = mergeComments(localComments, remoteComments);
  const edgeMergeResult = mergeDependencyEdges(localEdges, remoteEdges);
  const auditMergeResult = mergeAuditResults(localAudits, remoteAudits);
  
  const autoSyncEnabled = config?.autoSync === true;
  if (autoSyncEnabled) {
    db.setAutoSync(false);
  }
  // SAFETY: db.import() is destructive (clears all items before inserting).
  // This is safe here because itemMergeResult.merged is the complete merged
  // set of local + remote items — no data is lost. The whole import runs
  // under the store mutation lock so a concurrent `wl sync` cannot clobber
  // the initial population (WL-0MUVSQ4EO00092E7).
  withStoreMutationLock(dataPath, () => {
    db.import(itemMergeResult.merged, edgeMergeResult.merged, auditMergeResult.merged);
    db.importComments(commentMergeResult.merged);
  });
  if (autoSyncEnabled) {
    db.setAutoSync(true, () => Promise.resolve());
  }
  
  await exportToJsonlAsync(itemMergeResult.merged, commentMergeResult.merged, dataPath, edgeMergeResult.merged);
  await gitPushDataFileToBranch(dataPath, 'Sync work items and comments', gitTarget);
}
