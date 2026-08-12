/**
 * Sync functionality for merging local and remote work items with conflict resolution
 */

import { WorkItem, Comment, ConflictDetail, ConflictFieldDetail, DependencyEdge, AuditResult } from './types.js';
import { isDefaultValue, stableValueKey, stableItemKey, mergeTags } from './sync/merge-utils.js';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { contextExec, withinWorktreeContext, killProcessesForWorktree, type TrackedExecResult } from './process-lifecycle.js';

/**
 * Git exports GIT_DIR (and GIT_WORK_TREE / GIT_INDEX_FILE) when it invokes
 * hooks, and `wl sync` spawned from a hook inherits them. A leaked GIT_DIR
 * redirects `git -C <path> ...` commands to the CALLER's worktree (its
 * index/HEAD/refs) instead of the repository named on the command line —
 * which produced destructive "Sync work items and comments" commits on
 * worktree branches (WL-0MS99Y6R40028Q9G). Every git command in this module
 * therefore runs with those variables cleared, matching git's own behavior
 * of unsetting them for hook child processes.
 */
function sanitizeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  delete clean.GIT_DIR;
  delete clean.GIT_WORK_TREE;
  delete clean.GIT_INDEX_FILE;
  return clean;
}

async function gitExecAsync(
  command: string,
  options?: { cwd?: string }
): Promise<TrackedExecResult> {
  return contextExec(command, { ...options, env: sanitizeGitEnv(process.env) });
}

const execAsync = gitExecAsync;

// git show of large JSONL can exceed Node's exec() maxBuffer.
// Use spawn to stream the output when reading remote content.
async function execGitCaptureStdout(args: string[], options?: { cwd?: string }): Promise<string> {
  return await new Promise((resolve, reject) => {
    // On Windows, shell: true is required so spawn can resolve .cmd/.bat
    // wrappers. Pass args as a single command string to avoid the
    // DEP0190 deprecation warning about unescaped args with shell=true.
    const useShell = process.platform === 'win32';
    const childEnv = sanitizeGitEnv(process.env);
    const child = useShell
      ? childProcess.spawn(`git ${args.map(a => escapeShellArg(a)).join(' ')}`, [], {
          cwd: options?.cwd,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
        })
      : childProcess.spawn('git', args, {
          cwd: options?.cwd,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      reject(new Error(err.trim() || `git ${args.join(' ')} failed with code ${code}`));
    });
  });
}

export interface GitTarget {
  remote: string;
  branch: string; // may be a branch name or a full ref (e.g. refs/worklog/data)
}

/**
 * Escape a string for safe use in shell commands
 */
function escapeShellArg(arg: string): string {
  if (process.platform === 'win32') {
    // Windows cmd.exe uses double quotes; escape internal double quotes
    return '"' + arg.replace(/"/g, '\\"') + '"';
  }
  // Unix: use single quotes and escape any single quotes within the string
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  itemsAdded: number;
  itemsUpdated: number;
  itemsUnchanged: number;
  commentsAdded: number;
  commentsUnchanged: number;
  conflicts: string[]; // Legacy text-based conflicts (for backward compatibility)
  conflictDetails: ConflictDetail[]; // Detailed conflict information
}

export interface MergeOptions {
  defaultValueFields?: Array<keyof WorkItem>;
  sameTimestampStrategy?: 'lexicographic' | 'local' | 'remote';
}


/**
 * Merge two sets of work items with intelligent field-level conflict resolution
 * Strategy: For each field, prefer non-default values, or use the value from the newer version
 * This heuristic allows merging changes from both versions without needing a common ancestor
 */
export function mergeWorkItems(
  localItems: WorkItem[],
  remoteItems: WorkItem[],
  options?: MergeOptions
): { merged: WorkItem[], conflicts: string[], conflictDetails: ConflictDetail[] } {
  const conflicts: string[] = [];
  const conflictDetails: ConflictDetail[] = [];
  const mergedMap = indexItemsById(localItems);

  for (const remoteItem of remoteItems) {
    mergeRemoteItem(mergedMap, remoteItem, options, conflicts, conflictDetails);
  }

  return {
    merged: Array.from(mergedMap.values()),
    conflicts,
    conflictDetails
  };
}

function indexItemsById(items: WorkItem[]): Map<string, WorkItem> {
  const mergedMap = new Map<string, WorkItem>();
  for (const item of items) {
    mergedMap.set(item.id, item);
  }
  return mergedMap;
}

function mergeRemoteItem(
  mergedMap: Map<string, WorkItem>,
  remoteItem: WorkItem,
  options: MergeOptions | undefined,
  conflicts: string[],
  conflictDetails: ConflictDetail[]
): void {
  const localItem = mergedMap.get(remoteItem.id);

  if (!localItem) {
    mergedMap.set(remoteItem.id, remoteItem);
    return;
  }

  const localUpdated = new Date(localItem.updatedAt).getTime();
  const remoteUpdated = new Date(remoteItem.updatedAt).getTime();

  if (stableItemKey(localItem) === stableItemKey(remoteItem)) {
    return;
  }

  if (localUpdated === remoteUpdated) {
    const sameTimestampMerge = mergeSameTimestampItems(localItem, remoteItem, options);
    mergedMap.set(remoteItem.id, sameTimestampMerge.merged);
    conflicts.push(...sameTimestampMerge.conflictMessages);
    if (sameTimestampMerge.conflictDetail) {
      conflictDetails.push(sameTimestampMerge.conflictDetail);
    }
    return;
  }

  const differentTimestampMerge = mergeDifferentTimestampItems(localItem, remoteItem, options);
  mergedMap.set(remoteItem.id, differentTimestampMerge.merged);
  conflicts.push(...differentTimestampMerge.conflictMessages);
  if (differentTimestampMerge.conflictDetail) {
    conflictDetails.push(differentTimestampMerge.conflictDetail);
  }
}

/**
 * Cross-project prefix filter (SA-0MSC0BM1V0032UYT) — defense-in-depth.
 *
 * `assertDataFileInCwdRepo` (WL-0MSAH26DD001XXST) blocks syncs whose data
 * file lives in a different git repo than the process cwd, but a stale
 * long-running process (loaded pre-fix modules) or a bypassed repo-context
 * check can still reach the merge step with foreign data. This filter makes
 * the merge itself prefix-aware: work items whose ID prefix does not match
 * the project prefix are never imported, and their comments, dependency
 * edges and audit results are dropped with them.
 *
 * IDs without a '-' separator cannot be classified and are kept, matching
 * `wl doctor foreign-items` behaviour.
 *
 * @param id - The work item ID (e.g. `WL-0MSAH2A71000MUA3`).
 * @param projectPrefix - The project's configured prefix (e.g. `WL`), matched case-insensitively.
 * @returns True when the item belongs to the project (or is unclassifiable).
 */
export function isOwnProjectItemId(id: string, projectPrefix: string): boolean {
  const dash = id.indexOf('-');
  if (dash <= 0) {
    return true; // no dash, or leading dash — cannot be classified (consistent with doctor)
  }
  return id.slice(0, dash).toUpperCase() === projectPrefix.toUpperCase();
}

/**
 * Filter remote sync data so only records belonging to the project prefix
 * can enter the merge. Comments, dependency edges and audit results that
 * reference dropped foreign items are removed with them.
 *
 * @param items - Remote work items fetched from the remote ref.
 * @param comments - Remote comments.
 * @param edges - Remote dependency edges.
 * @param audits - Remote audit results.
 * @param projectPrefix - The project's configured prefix (case-insensitive).
 * @returns The filtered sets plus the IDs of dropped foreign items (for observability).
 */
export function filterRemoteDataByPrefix(
  items: WorkItem[],
  comments: Comment[],
  edges: DependencyEdge[],
  audits: AuditResult[],
  projectPrefix: string
): {
  items: WorkItem[];
  comments: Comment[];
  edges: DependencyEdge[];
  audits: AuditResult[];
  droppedItems: string[];
} {
  const allowedItemIds = new Set<string>();
  const keptItems: WorkItem[] = [];
  const droppedItems: string[] = [];

  for (const item of items) {
    if (isOwnProjectItemId(item.id, projectPrefix)) {
      allowedItemIds.add(item.id);
      keptItems.push(item);
    } else {
      droppedItems.push(item.id);
    }
  }

  const keptComments = comments.filter(c => allowedItemIds.has(c.workItemId));
  const keptEdges = edges.filter(e => allowedItemIds.has(e.fromId) && allowedItemIds.has(e.toId));
  const keptAudits = audits.filter(a => allowedItemIds.has(a.workItemId));

  return {
    items: keptItems,
    comments: keptComments,
    edges: keptEdges,
    audits: keptAudits,
    droppedItems,
  };
}

/**
 * Terminal (closed) workflow stages. An item with `completed` status and a
 * terminal stage is a protected close state: it must never be silently
 * reverted by a stale remote `open`/`in_progress` copy during merge.
 *
 * `in_review` is the standard 'ready for review' state after a pi audit — a
 * closed state until manually reopened (WL-0MSPZP7FE009YXPG).
 *
 * Whitelist per approved plan: {done, in_review}. Custom stages are NOT
 * protected and fall back to normal timestamp/lexicographic resolution.
 */
export function isTerminalStage(stage: string | undefined): boolean {
  return stage === 'done' || stage === 'in_review';
}

function mergeSameTimestampItems(
  localItem: WorkItem,
  remoteItem: WorkItem,
  options: MergeOptions | undefined
): { merged: WorkItem; conflictMessages: string[]; conflictDetail: ConflictDetail | null } {
  const sameTimestampStrategy = options?.sameTimestampStrategy ?? 'lexicographic';
  const sameTimestampLabel = sameTimestampStrategy === 'lexicographic'
    ? 'merged deterministically'
    : `merged using ${sameTimestampStrategy} preference`;
  const merged: WorkItem = { ...localItem };
  const fields: (keyof WorkItem)[] = ['title', 'description', 'status', 'priority', 'sortIndex', 'parentId', 'tags', 'assignee', 'stage', 'issueType', 'createdBy', 'deletedBy', 'deleteReason'];
  const mergedFields: string[] = [];
  const fieldDetails: ConflictFieldDetail[] = [];

  for (const field of fields) {
    const localValue = localItem[field];
    const remoteValue = remoteItem[field];
    const valuesEqual = stableValueKey(localValue) === stableValueKey(remoteValue);
    if (valuesEqual) continue;

    if (field === 'tags') {
      const mergedTags = mergeTags(localValue as string[] | undefined, remoteValue as string[] | undefined);
      (merged as any)[field] = mergedTags;
      mergedFields.push('tags (union)');
      fieldDetails.push({
        field: 'tags',
        localValue,
        remoteValue,
        chosenValue: mergedTags,
        chosenSource: 'merged',
        reason: 'union of both tag sets'
      });
      continue;
    }

    const localIsDefault = isDefaultValue(localValue, field, options);
    const remoteIsDefault = isDefaultValue(remoteValue, field, options);

    // Special handling for close state (status=completed + terminal stage):
    // When one version has a close and the other has a different non-close status/stage,
    // prefer the close values. This prevents an unrelated field change on a different
    // client from silently reverting a close operation.
    if (field === 'status') {
      const localIsClose = localValue === 'completed' && (isTerminalStage(localItem.stage) || isTerminalStage(remoteItem.stage));
      const remoteIsClose = remoteValue === 'completed' && (isTerminalStage(remoteItem.stage) || isTerminalStage(localItem.stage));
      if (localIsClose && !remoteIsClose) {
        (merged as any)[field] = localValue;
        mergedFields.push(`${field} (close preserved from local)`);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue: localValue,
          chosenSource: 'local',
          reason: 'local has completed status (close)'
        });
        continue;
      }
      if (remoteIsClose && !localIsClose) {
        (merged as any)[field] = remoteValue;
        mergedFields.push(`${field} (close preserved from remote)`);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue: remoteValue,
          chosenSource: 'remote',
          reason: 'remote has completed status (close)'
        });
        continue;
      }
    }
    if (field === 'stage') {
      const localIsCloseStage = isTerminalStage(localValue as string) && (localItem.status === 'completed' || remoteItem.status === 'completed');
      const remoteIsCloseStage = isTerminalStage(remoteValue as string) && (remoteItem.status === 'completed' || localItem.status === 'completed');
      if (localIsCloseStage && !remoteIsCloseStage) {
        (merged as any)[field] = localValue;
        mergedFields.push(`${field} (close preserved from local)`);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue: localValue,
          chosenSource: 'local',
          reason: 'local has done stage (close)'
        });
        continue;
      }
      if (remoteIsCloseStage && !localIsCloseStage) {
        (merged as any)[field] = remoteValue;
        mergedFields.push(`${field} (close preserved from remote)`);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue: remoteValue,
          chosenSource: 'remote',
          reason: 'remote has done stage (close)'
        });
        continue;
      }
    }
    if (localIsDefault && !remoteIsDefault) {
      (merged as any)[field] = remoteValue;
      mergedFields.push(`${field} (from remote)`);
      fieldDetails.push({
        field,
        localValue,
        remoteValue,
        chosenValue: remoteValue,
        chosenSource: 'remote',
        reason: 'remote has value, local is default'
      });
    } else if (!localIsDefault && remoteIsDefault) {
      mergedFields.push(`${field} (from local)`);
      fieldDetails.push({
        field,
        localValue,
        remoteValue,
        chosenValue: localValue,
        chosenSource: 'local',
        reason: 'local has value, remote is default'
      });
    } else {
      const localKey = stableValueKey(localValue);
      const remoteKey = stableValueKey(remoteValue);
      const chooseRemote = sameTimestampStrategy === 'remote'
        ? true
        : sameTimestampStrategy === 'local'
          ? false
          : remoteKey > localKey;
      const reason = sameTimestampStrategy === 'lexicographic'
        ? 'deterministic tie-breaker (lexicographic)'
        : `same-timestamp preference (${sameTimestampStrategy})`;
      if (chooseRemote) {
        (merged as any)[field] = remoteValue;
        mergedFields.push(`${field} (tie-break: remote)`);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue: remoteValue,
          chosenSource: 'remote',
          reason
        });
      } else {
        mergedFields.push(`${field} (tie-break: local)`);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue: localValue,
          chosenSource: 'local',
          reason
        });
      }
    }
  }

  // Bump updatedAt so next sync has an unambiguous winner.
  merged.updatedAt = new Date().toISOString();
  merged.createdAt = localItem.createdAt;

  const conflictMessages: string[] = [
    `${remoteItem.id}: Same updatedAt but different content - ${sameTimestampLabel} and bumped updatedAt`
  ];
  if (mergedFields.length > 0) {
    conflictMessages.push(`${remoteItem.id}: Merged fields [${mergedFields.join(', ')}]`);
  }

  const conflictDetail = fieldDetails.length > 0
    ? {
      itemId: remoteItem.id,
      conflictType: 'same-timestamp' as const,
      fields: fieldDetails,
      localUpdatedAt: localItem.updatedAt,
      remoteUpdatedAt: remoteItem.updatedAt
    }
    : null;

  return { merged, conflictMessages, conflictDetail };
}

function mergeDifferentTimestampItems(
  localItem: WorkItem,
  remoteItem: WorkItem,
  options: MergeOptions | undefined
): { merged: WorkItem; conflictMessages: string[]; conflictDetail: ConflictDetail | null } {
  const isRemoteNewer = new Date(remoteItem.updatedAt).getTime() > new Date(localItem.updatedAt).getTime();
  const merged: WorkItem = { ...localItem };
  const fields: (keyof WorkItem)[] = ['title', 'description', 'status', 'priority', 'sortIndex', 'parentId', 'tags', 'assignee', 'stage', 'issueType', 'createdBy', 'deletedBy', 'deleteReason'];
  const mergedFields: string[] = [];
  const conflictedFields: string[] = [];
  const fieldDetails: ConflictFieldDetail[] = [];

  for (const field of fields) {
    const localValue = localItem[field];
    const remoteValue = remoteItem[field];

    let valuesEqual = false;
    if (Array.isArray(localValue) && Array.isArray(remoteValue)) {
      valuesEqual = JSON.stringify([...localValue].sort()) === JSON.stringify([...remoteValue].sort());
    } else {
      valuesEqual = localValue === remoteValue;
    }

    if (!valuesEqual) {
      const localIsDefault = isDefaultValue(localValue, field, options);
      const remoteIsDefault = isDefaultValue(remoteValue, field, options);

      if (field === 'tags') {
        const mergedTags = mergeTags(localValue as string[] | undefined, remoteValue as string[] | undefined);
        (merged as any)[field] = mergedTags;
        mergedFields.push('tags (union)');
        fieldDetails.push({
          field: 'tags',
          localValue,
          remoteValue,
          chosenValue: mergedTags,
          chosenSource: 'merged',
          reason: 'union of both tag sets'
        });
        continue;
      }

      // Special handling for close state (status=completed + terminal stage):
      // When one version has a close and the other has a different non-close status/stage,
      // prefer the close values. This prevents an unrelated field change on a different
      // client from silently reverting a close operation.
      //
      // In mergeDifferentTimestampItems, close-preservation for the REMOTE side is
      // only applied when isRemoteNewer is true. If local is newer, the local intent
      // (e.g., reopening a closed item) is respected rather than the remote close.
      if (field === 'status') {
        const localIsClose = localValue === 'completed' && (isTerminalStage(localItem.stage) || isTerminalStage(remoteItem.stage));
        const remoteIsClose = remoteValue === 'completed' && (isTerminalStage(remoteItem.stage) || isTerminalStage(localItem.stage));
        if (localIsClose && !remoteIsClose) {
          (merged as any)[field] = localValue;
          mergedFields.push(`${field} (close preserved from local)`);
          fieldDetails.push({
            field,
            localValue,
            remoteValue,
            chosenValue: localValue,
            chosenSource: 'local',
            reason: 'local has completed status (close)'
          });
          continue;
        }
        if (remoteIsClose && !localIsClose) {
          // Only preserve remote close when remote is newer.
          // If local is newer, the local intent (e.g., reopening) is respected
          // and we fall through to normal timestamp-based resolution below.
          if (isRemoteNewer) {
            (merged as any)[field] = remoteValue;
            mergedFields.push(`${field} (close preserved from remote)`);
            fieldDetails.push({
              field,
              localValue,
              remoteValue,
              chosenValue: remoteValue,
              chosenSource: 'remote',
              reason: 'remote has completed status (close)'
            });
            continue;
          }
          // Fall through to normal resolution when local is newer
        }
      }
      if (field === 'stage') {
        const localIsCloseStage = isTerminalStage(localValue as string) && (localItem.status === 'completed' || remoteItem.status === 'completed');
        const remoteIsCloseStage = isTerminalStage(remoteValue as string) && (remoteItem.status === 'completed' || localItem.status === 'completed');
        if (localIsCloseStage && !remoteIsCloseStage) {
          (merged as any)[field] = localValue;
          mergedFields.push(`${field} (close preserved from local)`);
          fieldDetails.push({
            field,
            localValue,
            remoteValue,
            chosenValue: localValue,
            chosenSource: 'local',
            reason: 'local has done stage (close)'
          });
          continue;
        }
        if (remoteIsCloseStage && !localIsCloseStage) {
          // Only preserve remote close stage when remote is newer.
          // If local is newer, the local intent (e.g., reopening) is respected
          // and we fall through to normal timestamp-based resolution below.
          if (isRemoteNewer) {
            (merged as any)[field] = remoteValue;
            mergedFields.push(`${field} (close preserved from remote)`);
            fieldDetails.push({
              field,
              localValue,
              remoteValue,
              chosenValue: remoteValue,
              chosenSource: 'remote',
              reason: 'remote has done stage (close)'
            });
            continue;
          }
          // Fall through to normal resolution when local is newer
        }
      }
      if (localIsDefault && !remoteIsDefault) {
        (merged as any)[field] = remoteValue;
        mergedFields.push(`${field} (from remote)`);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue: remoteValue,
          chosenSource: 'remote',
          reason: 'remote has value, local is default'
        });
      } else if (!localIsDefault && remoteIsDefault) {
        mergedFields.push(`${field} (from local)`);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue: localValue,
          chosenSource: 'local',
          reason: 'local has value, remote is default'
        });
      } else if (isRemoteNewer) {
        (merged as any)[field] = remoteValue;
        conflictedFields.push(field);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue: remoteValue,
          chosenSource: 'remote',
          reason: `remote is newer (${remoteItem.updatedAt})`
        });
      } else {
        conflictedFields.push(field);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue: localValue,
          chosenSource: 'local',
          reason: `local is newer (${localItem.updatedAt})`
        });
      }
    }
  }

  merged.updatedAt = isRemoteNewer ? remoteItem.updatedAt : localItem.updatedAt;
  merged.createdAt = localItem.createdAt;

  const conflictMessages: string[] = [];
  if (conflictedFields.length > 0) {
    conflictMessages.push(
      `${remoteItem.id}: Conflicting fields [${conflictedFields.join(', ')}] resolved using ${isRemoteNewer ? 'remote' : 'local'} values (${isRemoteNewer ? 'remote' : 'local'}: ${isRemoteNewer ? remoteItem.updatedAt : localItem.updatedAt}, ${isRemoteNewer ? 'local' : 'remote'}: ${isRemoteNewer ? localItem.updatedAt : remoteItem.updatedAt})`
    );
  }
  if (mergedFields.length > 0) {
    conflictMessages.push(`${remoteItem.id}: Merged fields [${mergedFields.join(', ')}]`);
  }

  const conflictDetail = fieldDetails.length > 0
    ? {
      itemId: remoteItem.id,
      conflictType: 'different-timestamp' as const,
      fields: fieldDetails,
      localUpdatedAt: localItem.updatedAt,
      remoteUpdatedAt: remoteItem.updatedAt
    }
    : null;

  return { merged, conflictMessages, conflictDetail };
}

/**
 * Merge two sets of comments
 * Comments are immutable after creation (except explicit updates), so we use createdAt + id for deduplication
 */
export function mergeComments(
  localComments: Comment[],
  remoteComments: Comment[]
): { merged: Comment[], conflicts: string[] } {
  const mergedMap = new Map<string, Comment>();
  
  // Add all local comments to the map
  localComments.forEach(comment => {
    mergedMap.set(comment.id, comment);
  });
  
  // Add remote comments (deduplicate by id)
  remoteComments.forEach(remoteComment => {
    if (!mergedMap.has(remoteComment.id)) {
      mergedMap.set(remoteComment.id, remoteComment);
    }
  });
  
  return {
    merged: Array.from(mergedMap.values()),
    conflicts: [] // Comments don't have conflicts in this simple model
  };
}

/**
 * Merge audit results by unique work item id.
 * Local audits take precedence over remote ones.
 */
export function mergeAuditResults(
  localAudits: AuditResult[],
  remoteAudits: AuditResult[]
): { merged: AuditResult[] } {
  const mergedMap = new Map<string, AuditResult>();
  
  // Add all local audit results to the map
  localAudits.forEach(audit => {
    mergedMap.set(audit.workItemId, audit);
  });
  
  // Add remote audit results (deduplicate by workItemId, local wins)
  remoteAudits.forEach(remoteAudit => {
    if (!mergedMap.has(remoteAudit.workItemId)) {
      mergedMap.set(remoteAudit.workItemId, remoteAudit);
    }
  });
  
  return {
    merged: Array.from(mergedMap.values()),
  };
}

/**
 * Merge dependency edges by unique from/to pairs.
 */
export function mergeDependencyEdges(
  localEdges: DependencyEdge[],
  remoteEdges: DependencyEdge[]
): { merged: DependencyEdge[] } {
  const merged = new Map<string, DependencyEdge>();
  for (const edge of localEdges) {
    merged.set(`${edge.fromId}::${edge.toId}`, edge);
  }
  for (const edge of remoteEdges) {
    const key = `${edge.fromId}::${edge.toId}`;
    if (!merged.has(key)) {
      merged.set(key, edge);
    }
  }
  return { merged: Array.from(merged.values()) };
}

async function getRepoRoot(): Promise<string> {
  const { stdout } = await execAsync('git rev-parse --show-toplevel');
  return stdout.trim();
}

/**
 * Find the git repo root that owns `filePath` (by running git from the file's
 * directory). Returns null when the file is not inside a git repository.
 */
async function getRepoRootForPath(filePath: string): Promise<string | null> {
  const dir = path.dirname(path.resolve(filePath));
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: dir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Cross-project sync guard (WL-0MSAH26DD001XXST).
 *
 * `wl sync --worklog-dir <proj>/.worklog` run from inside a DIFFERENT git
 * repo used to fetch the cwd repo's remote worklog ref (because the `-f`
 * default was resolved from the cwd before the override applied) and merge
 * it into <proj>'s database, then push the polluted union back to <proj>'s
 * remote. This guard fails loudly whenever the data file lives in a
 * different git repository than the process cwd, so a sync can never merge
 * foreign-prefix items from another project.
 */
export async function assertDataFileInCwdRepo(dataFilePath: string): Promise<void> {
  let cwdRepoRoot: string | null = null;
  try {
    cwdRepoRoot = (await getRepoRoot()).trim() || null;
  } catch {
    // cwd is not inside a git repository; existing code paths report that.
  }

  const dataRepoRoot = await getRepoRootForPath(dataFilePath);

  if (cwdRepoRoot && dataRepoRoot && cwdRepoRoot !== dataRepoRoot) {
    throw new Error(
      `Cross-project sync blocked: data file '${dataFilePath}' belongs to git repository '${dataRepoRoot}', ` +
      `but this command is running inside git repository '${cwdRepoRoot}'. ` +
      `Merging would combine two projects' worklog data (WL-0MSAH26DD001XXST). ` +
      `Run 'wl sync' from inside '${dataRepoRoot}' or remove the --worklog-dir flag.`
    );
  }
  if (cwdRepoRoot && !dataRepoRoot) {
    throw new Error(
      `Cross-project sync blocked: data file '${dataFilePath}' is not inside a git repository, ` +
      `but this command is running inside git repository '${cwdRepoRoot}'. ` +
      `Run 'wl sync' from inside a directory in the same repository as '${dataFilePath}'.`
    );
  }
  if (!cwdRepoRoot && dataRepoRoot) {
    throw new Error(
      `Cross-project sync blocked: data file '${dataFilePath}' belongs to git repository '${dataRepoRoot}', ` +
      `but the current directory is not inside a git repository. ` +
      `Run 'wl sync' from inside '${dataRepoRoot}'.`
    );
  }
}

async function fetchRemote(remote: string): Promise<void> {
  await execAsync(`git fetch ${escapeShellArg(remote)}`);
}

function getRemoteTrackingRef(remote: string, branchOrRef: string): string {
  // For a named branch like "worklog-data", track it as refs/remotes/origin/worklog-data.
  // For an explicit ref like "refs/worklog/data", DO NOT track it under refs/remotes/...
  // because that namespace is reserved for remote-tracking branches and can collide with
  // real branches like "worklog/data" and/or reject non-fast-forward updates.
  //
  // Instead, keep a local-only tracking ref under refs/worklog/remotes/<remote>/...
  if (branchOrRef.startsWith('refs/')) {
    const suffix = branchOrRef.slice('refs/'.length);
    return `refs/worklog/remotes/${remote}/${suffix}`;
  }

  return `refs/remotes/${remote}/${branchOrRef}`;
}

// Exposed for unit tests.
export const _testOnly_getRemoteTrackingRef = getRemoteTrackingRef;

async function refExists(ref: string): Promise<boolean> {
  try {
    await execAsync(`git show-ref --verify --quiet ${escapeShellArg(ref)}`);
    return true;
  } catch {
    return false;
  }
}

async function fetchTargetRef(target: GitTarget): Promise<{ hasRemote: boolean; remoteTrackingRef: string }> {
  const remoteTrackingRef = getRemoteTrackingRef(target.remote, target.branch);

  if (target.branch.startsWith('refs/')) {
    // Default git fetch refspec does not include custom refs/*, so fetch it explicitly.
    // If it doesn't exist yet, treat as "no remote".
    try {
      await execAsync(
        // Force-update the local tracking ref so stale/colliding local refs don't block sync.
        `git fetch ${escapeShellArg(target.remote)} ${escapeShellArg(`+${target.branch}:${remoteTrackingRef}`)}`
      );
    } catch {
      // Avoid silently treating fetch failures as "ref missing"; that can lead to overwriting
      // an existing remote data ref from an orphan branch.
      let remoteExists = false;
      try {
        const { stdout } = await execAsync(
          `git ls-remote --exit-code ${escapeShellArg(target.remote)} ${escapeShellArg(target.branch)}`
        );
        remoteExists = !!stdout.trim();
      } catch {
        remoteExists = false;
      }

      if (remoteExists) {
        throw new Error(`Failed to fetch existing remote ref ${target.branch} from ${target.remote}`);
      }

      return { hasRemote: false, remoteTrackingRef };
    }

    const hasRemote = await refExists(remoteTrackingRef);
    if (!hasRemote) {
      // If the remote ref exists but we can't materialize a local tracking ref,
      // treat it as an error to avoid overwriting the remote from an orphan branch.
      let remoteExists = false;
      try {
        const { stdout } = await execAsync(
          `git ls-remote --exit-code ${escapeShellArg(target.remote)} ${escapeShellArg(target.branch)}`
        );
        remoteExists = !!stdout.trim();
      } catch {
        remoteExists = false;
      }

      if (remoteExists) {
        throw new Error(`Failed to create local tracking ref for ${target.branch} from ${target.remote}`);
      }
    }

    return { hasRemote, remoteTrackingRef };
  }

  // Standard branch fetch. This will populate refs/remotes/<remote>/<branch>.
  await execAsync(`git fetch ${escapeShellArg(target.remote)} ${escapeShellArg(target.branch)}`);
  return { hasRemote: await refExists(remoteTrackingRef), remoteTrackingRef };
}

function getRepoRelativePath(repoRootPath: string, filePath: string): { absolutePath: string; relativePath: string } {
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(repoRootPath, absolutePath);
  return { absolutePath, relativePath };
}

export async function getRemoteDataFileContent(dataFilePath: string, target: GitTarget): Promise<string | null> {
  // Cross-project safety guard: never read the remote worklog ref of a
  // different repository than the one owning the data file.
  await assertDataFileInCwdRepo(dataFilePath);

  // Check if we're in a git repository
  await execAsync('git rev-parse --git-dir');

  const repoRootPath = await getRepoRoot();
  const { relativePath } = getRepoRelativePath(repoRootPath, dataFilePath);

  const { hasRemote, remoteTrackingRef } = await fetchTargetRef(target);
  if (!hasRemote) {
    return null;
  }

  const refAndPath = `${remoteTrackingRef}:${relativePath}`;
  try {
    // Avoid exec() maxBuffer issues for large JSONL.
    return await execGitCaptureStdout(['show', refAndPath]);
  } catch {
    return null;
  }
}

function removeWorktreeFiles(worktreePath: string): void {
  for (const name of fs.readdirSync(worktreePath)) {
    if (name === '.git') continue;
    fs.rmSync(path.join(worktreePath, name), { recursive: true, force: true });
  }
}

async function listTrackedFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await execAsync(`git -C ${escapeShellArg(worktreePath)} ls-files -z`);
  if (!stdout) return [];
  return stdout.split('\0').map(s => s.trim()).filter(Boolean);
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function withTempWorktree<T>(
  repoRootPath: string,
  target: GitTarget,
  run: (worktreePath: string) => Promise<T>,
  options?: { forceOrphan?: boolean }
): Promise<T> {
  const worklogDir = path.join(repoRootPath, '.worklog');
  ensureDir(worklogDir);

  const tmpRoot = fs.mkdtempSync(path.join(worklogDir, 'tmp-worktree-'));
  const worktreePath = path.join(tmpRoot, 'wt');

  // When forceOrphan is set (ref rewrite), bypass the remote fetch entirely:
  // fetching the polluted remote ref would re-import foreign items into the
  // local tracking ref. Instead create a fresh orphan branch from HEAD.
  const { hasRemote, remoteTrackingRef } = options?.forceOrphan
    ? { hasRemote: false, remoteTrackingRef: '' }
    : await fetchTargetRef(target);
  const baseRef = hasRemote ? remoteTrackingRef : 'HEAD';

  try {
    try {
      await execAsync(`git worktree add --detach ${escapeShellArg(worktreePath)} ${escapeShellArg(baseRef)}`);
    } catch (err) {
      // Unborn-HEAD translation (SA-0MSG57UNY009DE51): when the worktree
      // would be created from local HEAD on a repo with no commits yet, git
      // fails with a cryptic error. Surface an actionable message naming the
      // cause and remedy instead.
      if (baseRef === 'HEAD') {
        const raw = (err as Error).message || '';
        if (/HEAD/.test(raw) && /(not a commit|invalid reference|cannot be created from|not a valid object name)/i.test(raw)) {
          throw new Error(
            'Cannot sync: this repository has no commits yet, so git cannot create ' +
            'a temporary worktree from HEAD. Create an initial commit first ' +
            '(e.g. `git commit --allow-empty -m "chore: initial"`), or run ' +
            '`wl sync --no-push` to keep worklog data local.'
          );
        }
      }
      throw err;
    }

    // If remote branch doesn't exist, create an orphan branch in the temp worktree.
    if (!hasRemote) {
      // Create an orphan local branch name; it doesn't need to include refs/.
      const localBranchName = target.branch.startsWith('refs/') ? target.branch.slice('refs/'.length) : target.branch;

      // If the local branch already exists (e.g. from a previous sync), delete it
      // first so that `checkout --orphan` can succeed.
      try {
        await execAsync(`git show-ref --verify --quiet ${escapeShellArg('refs/heads/' + localBranchName)}`);
        // Branch exists — delete it so the orphan checkout below can recreate it.
        await execAsync(`git branch -D ${escapeShellArg(localBranchName)}`);
      } catch {
        // Branch does not exist — this is the first sync, proceed normally.
      }

      await execAsync(`git -C ${escapeShellArg(worktreePath)} checkout --orphan ${escapeShellArg(localBranchName)}`);
      // `checkout --orphan` keeps the index populated with the previously checked-out files.
      // Clear the index + working tree so the branch starts empty.
      try {
        await execAsync(`git -C ${escapeShellArg(worktreePath)} rm -rf .`);
      } catch {
        // ignore
      }
      removeWorktreeFiles(worktreePath);
      try {
        await execAsync(`git -C ${escapeShellArg(worktreePath)} clean -fdx`);
      } catch {
        // ignore
      }
    }

    // Set worktree context so that any child processes spawned inside
    // `run()` are automatically registered with the process lifecycle
    // module for cleanup.
    const restore = withinWorktreeContext(worktreePath);
    try {
      return await run(worktreePath);
    } finally {
      restore();
    }
  } finally {
    // Kill any tracked processes spawned inside the worktree BEFORE
    // removing it, to prevent orphaned processes.
    try {
      killProcessesForWorktree(worktreePath);
    } catch {
      // ignore — best-effort cleanup
    }
    try {
      await execAsync(`git worktree remove --force ${escapeShellArg(worktreePath)}`);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export async function gitPushDataFileToBranch(
  repoDataFilePath: string,
  commitMessage: string,
  target: GitTarget
): Promise<void> {
  // Cross-project safety guard: never push the data file to a different
  // repository's remote ref than the one owning the file.
  await assertDataFileInCwdRepo(repoDataFilePath);

  // SAFETY GUARD: reject pushes to regular branches or tags.
  // Worklog data must only be stored on dedicated refs under refs/worklog/
  // to prevent accidental corruption of the project working tree.
  // See WL-0MQRBT8BS00355AB for the bug this prevents.
  const branch = target.branch;
  if (branch.startsWith('refs/heads/') || branch.startsWith('refs/tags/')) {
    throw new Error(
      `Refusing to push worklog data to '${branch}'. ` +
      `Worklog data must be pushed to a dedicated ref under refs/worklog/ ` +
      `(e.g. refs/worklog/data). Use WORKLOG_SKIP_PRE_PUSH=1 to bypass the pre-push hook.`
    );
  }
  // This pushes ONLY the data file by committing it on a dedicated branch
  // in a temporary worktree based on the remote branch tip.
  await execAsync('git rev-parse --git-dir');

  const repoRootPath = await getRepoRoot();
  const { relativePath } = getRepoRelativePath(repoRootPath, repoDataFilePath);
  const srcAbsPath = path.resolve(repoDataFilePath);

  if (!fs.existsSync(srcAbsPath)) {
    return;
  }

  await withTempWorktree(repoRootPath, target, async (worktreePath) => {
    // Ensure the dedicated data branch contains ONLY the JSONL file.
    // If it was previously polluted with other repo files, we remove them here.
    try {
      const tracked = await listTrackedFiles(worktreePath);
      const others = tracked.filter(p => p !== relativePath);
      if (others.length > 0) {
        for (const p of others) {
          await execAsync(`git -C ${escapeShellArg(worktreePath)} rm -r -- ${escapeShellArg(p)}`);
        }
        await execAsync(`git -C ${escapeShellArg(worktreePath)} clean -fdx`);
      }
    } catch {
      // ignore; we'll still proceed to commit the JSONL file
    }

    const dstAbsPath = path.join(worktreePath, relativePath);
    ensureDir(path.dirname(dstAbsPath));
    fs.copyFileSync(srcAbsPath, dstAbsPath);

    const escapedMsg = escapeShellArg(commitMessage);
    const escapedRel = escapeShellArg(relativePath);

    // Stage and commit only the JSONL file.
    // The data file typically lives under `.worklog/`, which is commonly gitignored in the main repo.
    // Force-add so this dedicated ref can still track it.
    await execAsync(`git -C ${escapeShellArg(worktreePath)} add -f -- ${escapedRel}`);
    const { stdout: staged } = await execAsync(
      `git -C ${escapeShellArg(worktreePath)} diff --cached --name-only -- ${escapedRel}`
    );
    if (!staged.trim()) {
      return;
    }

    await execAsync(`git -C ${escapeShellArg(worktreePath)} commit -m ${escapedMsg}`);

    // Push only this commit to the dedicated ref.
    const pushTarget = target.branch.startsWith('refs/') ? target.branch : `refs/heads/${target.branch}`;
    await execAsync(
      `git -C ${escapeShellArg(worktreePath)} push --no-verify ${escapeShellArg(target.remote)} HEAD:${escapeShellArg(pushTarget)}`
    );
  });
}

/**
 * Rewrite a project's worklog data ref so it contains ONLY the given JSONL,
 * force-pushing a fresh orphan commit that bypasses the polluted remote history.
 *
 * This is the remote-ref cleanup half of `wl doctor foreign-items --apply --push`.
 * Unlike `gitPushDataFileToBranch` (which fetches and merges the remote ref
 * first — re-importing foreign items), this function NEVER fetches the remote:
 * it creates an orphan branch containing only the clean JSONL, force-pushes it
 * to `refs/worklog/data`, and updates the local tracking ref to match.
 *
 * Safety: rejects pushes to regular branches/tags (only dedicated refs under
 * `refs/worklog/` are allowed), matching `gitPushDataFileToBranch`.
 *
 * @param repoDataFilePath - Path to the clean JSONL file to publish.
 * @param commitMessage - Commit message for the rewritten ref.
 * @param target - Git remote + branch/ref target.
 * @returns The SHA of the rewritten ref tip.
 */
export async function rewriteAndForcePushDataFile(
  repoDataFilePath: string,
  commitMessage: string,
  target: GitTarget
): Promise<string> {
  // Cross-project safety guard: never push a data file to a different
  // repository's remote ref than the one owning the file.
  await assertDataFileInCwdRepo(repoDataFilePath);

  // SAFETY GUARD: reject pushes to regular branches or tags.
  // Worklog data must only be stored on dedicated refs under refs/worklog/.
  const branch = target.branch;
  if (branch.startsWith('refs/heads/') || branch.startsWith('refs/tags/')) {
    throw new Error(
      `Refusing to push worklog data to '${branch}'. ` +
      `Worklog data must be pushed to a dedicated ref under refs/worklog/ ` +
      `(e.g. refs/worklog/data).`
    );
  }

  await execAsync('git rev-parse --git-dir');

  const repoRootPath = await getRepoRoot();
  const { relativePath } = getRepoRelativePath(repoRootPath, repoDataFilePath);
  const srcAbsPath = path.resolve(repoDataFilePath);

  if (!fs.existsSync(srcAbsPath)) {
    throw new Error(`Worklog data file not found: ${srcAbsPath}`);
  }

  const remoteTrackingRef = getRemoteTrackingRef(target.remote, branch);
  const pushTarget = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  let tipSha = '';

  await withTempWorktree(repoRootPath, target, async (worktreePath) => {
    const dstAbsPath = path.join(worktreePath, relativePath);
    ensureDir(path.dirname(dstAbsPath));
    fs.copyFileSync(srcAbsPath, dstAbsPath);

    const escapedMsg = escapeShellArg(commitMessage);
    const escapedRel = escapeShellArg(relativePath);

    // Stage and commit only the JSONL file (force-add: .worklog/ is gitignored).
    await execAsync(`git -C ${escapeShellArg(worktreePath)} add -f -- ${escapedRel}`);
    const { stdout: staged } = await execAsync(
      `git -C ${escapeShellArg(worktreePath)} diff --cached --name-only -- ${escapedRel}`
    );
    if (!staged.trim()) {
      throw new Error('Nothing staged for the rewrite; aborting to avoid an empty ref');
    }

    await execAsync(`git -C ${escapeShellArg(worktreePath)} commit -m ${escapedMsg}`);

    // Force-push the orphan commit, replacing the polluted remote ref entirely.
    await execAsync(
      `git -C ${escapeShellArg(worktreePath)} push --force --no-verify ${escapeShellArg(target.remote)} HEAD:${escapeShellArg(pushTarget)}`
    );

    const { stdout } = await execAsync(`git -C ${escapeShellArg(worktreePath)} rev-parse HEAD`);
    tipSha = stdout.trim();
  }, { forceOrphan: true });

  // Update the local tracking ref so a subsequent `wl sync` reads the clean
  // ref (refs/worklog/remotes/<remote>/...) instead of the polluted one.
  if (tipSha) {
    await execAsync(`git update-ref ${escapeShellArg(remoteTrackingRef)} ${escapeShellArg(tipSha)}`);
  }

  return tipSha;
}
