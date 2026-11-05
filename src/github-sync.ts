/**
 * src/github-sync.ts — public barrel of the github-sync flows.
 *
 * Concern: the stable public surface consumers import. The push flow
 * (`./github-sync/push.js`) is re-exported alongside the result/progress types
 * (`./github-sync/types.js`), the label-resolution helpers
 * (`./github-sync/labels.js`) and the import flow still declared here. The
 * implementation modules depend on `../github.js` and their siblings, never on
 * this barrel, so the dependency direction stays barrel → modules →
 * `../github.js`.
 *
 * Decomposed from the 1,339-line monolith (WL-0MVGKH9Z900178UF); this barrel is
 * now a thin façade under the 1,000-line ceiling.
 */

import { WorkItem, Comment, WorkItemRiskLevel, WorkItemEffortLevel } from './types.js';
import { theme } from './theme.js';
import {
  GithubConfig,
  GithubIssueRecord,
  GithubIssueComment,
  stripWorklogMarkers,
  extractWorklogId,
  extractWorklogCommentId,
  extractParentId,
  extractParentIssueNumber,
  extractChildIds,
  extractChildIssueNumbers,
  getIssueHierarchyAsync,
  getGithubIssueAsync,
  listGithubIssuesAsync,
  listGithubIssueCommentsAsync,
  issueToWorkItemFields,
  LabelEventCache,
  fetchLabelEventsAsync,
  labelFieldsDiffer,
} from './github.js';
import throttler from './github-throttler.js';
import { mergeWorkItems } from './sync.js';
import { createProgressEmitter } from './github-sync/progress.js';
import { LABEL_FIELD_CATEGORIES, resolveAllLabelFields } from './github-sync/labels.js';
import type { FieldChange } from './github-sync/labels.js';
import { stableItemKeyForImport } from './github-sync/util.js';

// The result/timing/progress type declarations moved to `./github-sync/types.js`
// (WL-0MW0JF5YE008LV1R) and the label-resolution declarations to
// `./github-sync/labels.js` (WL-0MW0JF7QN007E1JU); re-exporting them here keeps
// all of them importable from `'./github-sync.js'` unchanged. The local
// `import type` below supplies the names the import flow still declared in this
// module uses.
export type {
  SyncedItem,
  SyncErrorItem,
  GithubSyncResult,
  GithubSyncTiming,
  GithubProgress,
} from './github-sync/types.js';
export type { FieldChange } from './github-sync/labels.js';

import type { GithubProgress } from './github-sync/types.js';

// The push flow (issue/comment upsert plus parent/child hierarchy linking) moved
// to `./github-sync/push.js` (WL-0MW0JF9QG008E791). Re-exporting it here keeps
// the public function importable from `'./github-sync.js'` unchanged.
export { upsertIssuesFromWorkItems } from './github-sync/push.js';

// Label-derived field resolution moved to `./github-sync/labels.js`
// (WL-0MW0JF7QN007E1JU). Re-exported here so the public functions stay
// importable from `'./github-sync.js'` unchanged; `LABEL_FIELD_CATEGORIES` is
// family-internal (the import flow iterates it) and is imported, not
// re-exported, at the top of this module.
export { resolveLabelField, resolveAllLabelFields } from './github-sync/labels.js';

export async function importIssuesToWorkItems(
  items: WorkItem[],
  config: GithubConfig,
  options?: { since?: string; createNew?: boolean; generateId?: () => string; generateCommentId?: () => string; onProgress?: (progress: GithubProgress) => void; skipCloseCheck?: boolean }
): Promise<{
  updatedItems: WorkItem[];
  createdItems: WorkItem[];
  issues: GithubIssueRecord[];
  updatedIds: Set<string>;
  mergedItems: WorkItem[];
  conflictDetails: { conflicts: string[]; conflictDetails: import('./types.js').ConflictDetail[] };
  markersFound: number;
  fieldChanges: FieldChange[];
  importedComments: Comment[];
}> {
  const since = options?.since;
  const createNew = options?.createNew === true;
  const generateId = options?.generateId;
  const generateCommentId = options?.generateCommentId;
  const onProgress = options?.onProgress;
  // Progress: one shared emitter bound to this flow's per-phase stats
  // (WL-0MW0JF6TH00749I2).
  const emitProgressImport = createProgressEmitter(() => {
    const t = throttler as any;
    return typeof throttler !== 'undefined' && t.getStats ? t.getStats() : undefined;
  });
  const skipCloseCheck = options?.skipCloseCheck ?? Boolean(since);
  if (onProgress) {
    emitProgressImport(onProgress, 'import', 0, 1, 'fetching issues');
  }
  const issues = await listGithubIssuesAsync(config, since);
  const byId = new Map(items.map(item => [item.id, item]));
  const byIssueNumber = new Map<number, WorkItem>();
  for (const item of items) {
    if (item.githubIssueNumber) {
      byIssueNumber.set(item.githubIssueNumber, item);
    }
  }

  const hierarchyByIssueNumber = new Map<number, { parentIssueNumber: number | null; childIssueNumbers: number[] }>();
  const parentIssueNumbers = issues
    .filter(issue => (issue.subIssuesSummary?.total ?? 0) > 0)
    .map(issue => issue.number);
  const parentByChildIssueNumber = new Map<number, number>();
  let hierarchyChecked = 0;
  for (const issueNumber of parentIssueNumbers) {
    if (onProgress) {
      emitProgressImport(onProgress, 'hierarchy', hierarchyChecked + 1, parentIssueNumbers.length || 1);
    }
    hierarchyChecked += 1;
    try {
      const hierarchy = await getIssueHierarchyAsync(config, issueNumber);
      hierarchyByIssueNumber.set(issueNumber, hierarchy);
      for (const childNumber of hierarchy.childIssueNumbers) {
        parentByChildIssueNumber.set(childNumber, issueNumber);
      }
    } catch {
      continue;
    }
  }

  const remoteItemsById = new Map<string, WorkItem>();
  const issueMetaById = new Map<string, { number: number; id: number; updatedAt: string }>();
  const parentHints = new Map<string, string>();
  const childHints = new Map<string, string[]>();
  const parentIssueHints = new Map<string, number>();
  const childIssueHints = new Map<string, number[]>();
  const seenIssueNumbers = new Set<number>();
  let markersFound = 0;
  const allFieldChanges: FieldChange[] = [];
  const labelEventCache = new LabelEventCache();

  // Track which issues need event-based resolution (issue number -> local item + label fields)
  const pendingResolutions: Array<{
    issueNumber: number;
    itemId: string;
    localItem: WorkItem;
    labelFields: { status: string; priority: string; stage: string; issueType: string; risk: string; effort: string };
    issueUpdatedAt: string;
  }> = [];

  // Track the authoritative GitHub issue state (open/closed) per work item ID.
  // GitHub issue state is NOT a label-derived field — it is authoritative and
  // must survive the timestamp-based mergeWorkItems resolution. This map is
  // populated during Phase 1 and Phase 2, then used after merge to enforce
  // the correct status regardless of which side "won" the timestamp comparison.
  const issueClosedById = new Map<string, boolean>();

  const shouldReplaceRemote = (existingUpdatedAt: string | null | undefined, nextUpdatedAt: string): boolean => {
    if (!existingUpdatedAt) {
      return true;
    }
    const existingTime = new Date(existingUpdatedAt).getTime();
    const nextTime = new Date(nextUpdatedAt).getTime();
    if (Number.isNaN(existingTime) && Number.isNaN(nextTime)) {
      return true;
    }
    if (Number.isNaN(existingTime)) {
      return true;
    }
    if (Number.isNaN(nextTime)) {
      return false;
    }
    return nextTime >= existingTime;
  };

  let processed = 0;
  for (const issue of issues) {
    if (onProgress) {
      emitProgressImport(onProgress, 'import', processed + 1, issues.length);
    }
    const markerId = extractWorklogId(issue.body);
    if (markerId) {
      markersFound += 1;
    }
    const parentId = extractParentId(issue.body);
    const childIds = extractChildIds(issue.body);
    const existingByMarker = markerId ? byId.get(markerId) : undefined;
    const existing = existingByMarker || byIssueNumber.get(issue.number);
    const updatedAt = issue.updatedAt;
    const labelFields = issueToWorkItemFields(issue, config.labelPrefix);
    const isClosed = issue.state === 'closed';

    if (!existing && isClosed) {
      processed += 1;
      continue;
    }

    if (!existing && !markerId && !createNew) {
      processed += 1;
      continue;
    }

    if (!existing && !markerId && createNew && !generateId) {
      processed += 1;
      continue;
    }

    const newId = existing?.id || markerId || generateId!();
    const base: WorkItem = existing
      ? { ...existing }
      : {
          id: newId,
          title: 'Untitled',
          description: '',
          status: 'open',
          priority: 'medium',
          sortIndex: 0,
          parentId: null,
          createdAt: updatedAt,
          updatedAt: updatedAt,
          tags: [],
          assignee: '',
          stage: '',
          issueType: '',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '',
          effort: '',
        };

    const tags = labelFields.tags.length > 0
      ? Array.from(new Set([...(base.tags || []), ...labelFields.tags]))
      : base.tags;

    const remoteItem: WorkItem = {
      ...base,
      title: issue.title || base.title,
      description: issue.body ? stripWorklogMarkers(issue.body) : base.description,
      status: isClosed ? 'completed' : (labelFields.status || base.status),
      priority: labelFields.priority || base.priority,
      tags,
      risk: (labelFields.risk || base.risk) as WorkItemRiskLevel | '',
      effort: (labelFields.effort || base.effort) as WorkItemEffortLevel | '',
      stage: labelFields.stage || base.stage,
      issueType: labelFields.issueType || base.issueType,
      updatedAt: updatedAt,
    };

    const hierarchy = hierarchyByIssueNumber.get(issue.number);
    const parentIssueNumber = parentByChildIssueNumber.get(issue.number)
      ?? hierarchy?.parentIssueNumber
      ?? extractParentIssueNumber(issue.body);
    const childIssueNumbers = hierarchy?.childIssueNumbers ?? extractChildIssueNumbers(issue.body);

    const existingMeta = issueMetaById.get(remoteItem.id);
    const shouldReplace = existingMeta
      ? shouldReplaceRemote(existingMeta.updatedAt, issue.updatedAt)
      : true;
    if (existingMeta) {
      const removedIssueNumber = shouldReplace ? existingMeta.number : issue.number;
      const removedIssueUrl = `https://github.com/${config.repo}/issues/${removedIssueNumber}`;
       console.error(
         theme.text.error(
           `Duplicate Worklog marker detected for ${remoteItem.id}. `
           + `Duplicates should not occur. Ignoring ${removedIssueUrl} during sync. `
           + 'Remove the duplicate from GitHub after confirming it has no additional content of value.'
         )
       );
      if (!shouldReplace) {
        seenIssueNumbers.add(issue.number);
        processed += 1;
        continue;
      }
    }
    if (shouldReplace) {
      remoteItemsById.set(remoteItem.id, remoteItem);
      issueClosedById.set(remoteItem.id, isClosed);
      issueMetaById.set(remoteItem.id, {
        number: issue.number,
        id: issue.id,
        updatedAt: issue.updatedAt,
      });
      if (parentId) {
        parentHints.set(remoteItem.id, parentId);
      } else {
        parentHints.delete(remoteItem.id);
      }
      if (childIds.length > 0) {
        childHints.set(remoteItem.id, childIds);
      } else {
        childHints.delete(remoteItem.id);
      }
      if (parentIssueNumber) {
        parentIssueHints.set(remoteItem.id, parentIssueNumber);
      } else {
        parentIssueHints.delete(remoteItem.id);
      }
      if (childIssueNumbers.length > 0) {
        childIssueHints.set(remoteItem.id, childIssueNumbers);
      } else {
        childIssueHints.delete(remoteItem.id);
      }

      // Queue event-based resolution for items where label fields differ from local
      if (existing && labelFieldsDiffer(labelFields, existing)) {
        pendingResolutions.push({
          issueNumber: issue.number,
          itemId: remoteItem.id,
          localItem: existing,
          labelFields,
          issueUpdatedAt: issue.updatedAt,
        });
      }
    }
    seenIssueNumbers.add(issue.number);
    processed += 1;
  }

  if (!skipCloseCheck) {
    let checked = 0;
    for (const item of items) {
      if (!item.githubIssueNumber) {
        checked += 1;
        continue;
      }
      if (seenIssueNumbers.has(item.githubIssueNumber)) {
        checked += 1;
        continue;
      }
      if (onProgress) {
        emitProgressImport(onProgress, 'close-check', checked + 1, items.length);
      }
      try {
      const issue = await getGithubIssueAsync(config, item.githubIssueNumber);
      const hierarchy = hierarchyByIssueNumber.get(issue.number);
      const parentIssueNumber = parentByChildIssueNumber.get(issue.number)
        ?? hierarchy?.parentIssueNumber
        ?? extractParentIssueNumber(issue.body);
      const childIssueNumbers = hierarchy?.childIssueNumbers ?? extractChildIssueNumbers(issue.body);
        const parentId = extractParentId(issue.body);
        const childIds = extractChildIds(issue.body);
        const isClosed = issue.state === 'closed';

        // Skip open issues where the local item is also not completed (no state change)
        if (!isClosed && item.status !== 'completed') {
          checked += 1;
          continue;
        }

        const existingUpdatedAt = item.githubIssueUpdatedAt ? new Date(item.githubIssueUpdatedAt).getTime() : null;
        const issueUpdatedAt = new Date(issue.updatedAt).getTime();
        // Skip when the issue hasn't changed and the local status already matches
        // the expected state (completed for closed issues, non-completed for open)
        if (existingUpdatedAt !== null && existingUpdatedAt >= issueUpdatedAt) {
          if (isClosed && item.status === 'completed') {
            checked += 1;
            continue;
          }
          if (!isClosed && item.status !== 'completed') {
            checked += 1;
            continue;
          }
        }

        const labelFields = issueToWorkItemFields(issue, config.labelPrefix);
        const tags = labelFields.tags.length > 0
          ? Array.from(new Set([...item.tags, ...labelFields.tags]))
          : item.tags;
          remoteItemsById.set(item.id, {
            ...item,
            title: issue.title || item.title,
            description: issue.body ? stripWorklogMarkers(issue.body) : item.description,
            status: isClosed ? 'completed' : (labelFields.status || item.status),
            priority: labelFields.priority || item.priority,
            tags,
            risk: (labelFields.risk || item.risk) as WorkItemRiskLevel | '',
            effort: (labelFields.effort || item.effort) as WorkItemEffortLevel | '',
            stage: labelFields.stage || item.stage,
            issueType: labelFields.issueType || item.issueType,
            updatedAt: issue.updatedAt,
          });
        issueClosedById.set(item.id, isClosed);
        if (parentId) {
          parentHints.set(item.id, parentId);
        }
        if (childIds.length > 0) {
          childHints.set(item.id, childIds);
        }
        if (parentIssueNumber) {
          parentIssueHints.set(item.id, parentIssueNumber);
        }
        if (childIssueNumbers.length > 0) {
          childIssueHints.set(item.id, childIssueNumbers);
        }
        issueMetaById.set(item.id, {
          number: issue.number,
          id: issue.id,
          updatedAt: issue.updatedAt,
        });

        // Queue event-based resolution for close-check items where label fields differ
        if (labelFieldsDiffer(labelFields, item)) {
          pendingResolutions.push({
            issueNumber: issue.number,
            itemId: item.id,
            localItem: item,
            labelFields,
            issueUpdatedAt: issue.updatedAt,
          });
        }

        checked += 1;
      } catch {
        checked += 1;
        continue;
      }
    }
  }

  // Resolve label conflicts using event timelines for items where fields differ
  for (const pending of pendingResolutions) {
    const events = await fetchLabelEventsAsync(config, pending.issueNumber, labelEventCache);
    const { resolvedFields, fieldChanges } = resolveAllLabelFields(
      pending.localItem,
      pending.labelFields,
      events,
      config.labelPrefix,
      pending.issueUpdatedAt
    );

    // Apply resolved values to the remote item already stored in remoteItemsById
    const remoteItem = remoteItemsById.get(pending.itemId);
    if (remoteItem) {
      // Apply all resolved fields — this reverts fields to local values where
      // local is newer, and keeps remote values where remote is newer
      for (const { field, category } of LABEL_FIELD_CATEGORIES) {
        if (resolvedFields[field] !== undefined) {
          (remoteItem as any)[field] = resolvedFields[field];
        }
      }
      allFieldChanges.push(...fieldChanges);
    }
  }

  const remoteItems = Array.from(remoteItemsById.values());
  const mergeResult = mergeWorkItems(items, remoteItems, {
    defaultValueFields: ['status'],
    sameTimestampStrategy: 'local',
  });
  const mergedItems = mergeResult.merged.map(item => {
    const meta = issueMetaById.get(item.id);
    const parentId = parentHints.get(item.id) ?? null;
    if (!meta) {
      return parentId ? { ...item, parentId } : item;
    }
    return {
      ...item,
      parentId: parentId ?? item.parentId,
      githubIssueNumber: meta.number,
      githubIssueId: meta.id,
      githubIssueUpdatedAt: meta.updatedAt,
    };
  });

  // Re-apply label event resolutions that may have been overridden by mergeWorkItems.
  // Label event timestamps provide per-field precision that the item-level updatedAt
  // comparison in mergeWorkItems cannot capture. When a label event is newer than the
  // local updatedAt for a specific field, that resolution must take precedence even if
  // the overall item-level merge preferred local values.
  if (allFieldChanges.length > 0) {
    const mergedById = new Map(mergedItems.map(item => [item.id, item]));
    for (const change of allFieldChanges) {
      const item = mergedById.get(change.workItemId);
      if (item) {
        (item as any)[change.field] = change.newValue;
      }
    }
  }

  // Enforce authoritative GitHub issue state (open/closed) on the merged items.
  // Unlike label-derived fields (priority, stage, etc.) which are subject to
  // event-timestamp resolution, the issue state (open vs closed) is an
  // authoritative signal from GitHub that must always propagate regardless of
  // which side "won" the timestamp-based merge. Without this, a reopened issue
  // whose local updatedAt is newer than the issue updatedAt would remain
  // 'completed' after merge because mergeWorkItems prefers the newer local value.
  if (issueClosedById.size > 0) {
    const mergedById = new Map(mergedItems.map(item => [item.id, item]));
    for (const [itemId, isClosed] of issueClosedById.entries()) {
      const item = mergedById.get(itemId);
      if (!item) {
        continue;
      }
      const expectedStatus = isClosed ? 'completed' : 'open';
      if (isClosed && item.status !== 'completed') {
        item.status = 'completed';
      } else if (!isClosed && item.status === 'completed') {
        item.status = expectedStatus;
      }
    }
  }

  if (childHints.size > 0) {
    const itemsById = new Map(mergedItems.map(item => [item.id, item]));
    for (const [parentId, childIds] of childHints.entries()) {
      for (const childId of childIds) {
        const child = itemsById.get(childId);
        if (!child) {
          continue;
        }
        child.parentId = parentId;
      }
    }
  }

  if (parentIssueHints.size > 0) {
    const itemsByIssue = new Map<number, WorkItem>();
    for (const item of mergedItems) {
      if (item.githubIssueNumber) {
        itemsByIssue.set(item.githubIssueNumber, item);
      }
    }
    for (const [childId, parentIssueNumber] of parentIssueHints.entries()) {
      const child = mergedItems.find(item => item.id === childId);
      const parent = itemsByIssue.get(parentIssueNumber);
      if (!child || !parent) {
        continue;
      }
      child.parentId = parent.id;
    }
  }

  if (childIssueHints.size > 0) {
    const itemsByIssue = new Map<number, WorkItem>();
    for (const item of mergedItems) {
      if (item.githubIssueNumber) {
        itemsByIssue.set(item.githubIssueNumber, item);
      }
    }
    for (const [parentId, issueNumbers] of childIssueHints.entries()) {
      for (const issueNumber of issueNumbers) {
        const child = itemsByIssue.get(issueNumber);
        if (!child) {
          continue;
        }
        child.parentId = parentId;
      }
    }
  }

  const localById = new Map(items.map(item => [item.id, item]));
  const updatedItems: WorkItem[] = [];
  const createdItems: WorkItem[] = [];
  const updatedIds = new Set<string>();

  for (const item of mergedItems) {
    const local = localById.get(item.id);
    if (!local) {
      createdItems.push(item);
      continue;
    }
    if (stableItemKeyForImport(local) !== stableItemKeyForImport(item)) {
      updatedItems.push(item);
      updatedIds.add(item.id);
    }
  }

  // ── Import comments from GitHub issues ────────────────────────────────
  const importedComments: Comment[] = [];
  // Build a lookup: issueNumber -> workItemId from mergedItems
  const itemIdByIssueNumber = new Map<number, string>();
  for (const item of mergedItems) {
    if (item.githubIssueNumber) {
      itemIdByIssueNumber.set(item.githubIssueNumber, item.id);
    }
  }

  // Only fetch comments for issues that changed since the local GitHub snapshot
  // (or for newly-created mappings). This avoids per-issue comment API calls for
  // unchanged issues during full imports.
  const localByIdForComments = new Map(items.map(item => [item.id, item]));
  const shouldFetchCommentsForIssue = (issueNumber: number): boolean => {
    const workItemId = itemIdByIssueNumber.get(issueNumber);
    if (!workItemId) {
      return false;
    }
    const local = localByIdForComments.get(workItemId);
    if (!local) {
      return true;
    }
    const issueMeta = issueMetaById.get(workItemId);
    if (!issueMeta || !issueMeta.updatedAt) {
      return true;
    }
    if (!local.githubIssueUpdatedAt) {
      return true;
    }
    const remoteMs = new Date(issueMeta.updatedAt).getTime();
    const localMs = new Date(local.githubIssueUpdatedAt).getTime();
    if (Number.isNaN(remoteMs) || Number.isNaN(localMs)) {
      return true;
    }
    return remoteMs > localMs;
  };

  const commentIssueNumbers = [...seenIssueNumbers].filter(shouldFetchCommentsForIssue);
  const commentIssueTotal = commentIssueNumbers.length;
  let commentIssueIndex = 0;
  for (const issueNumber of commentIssueNumbers) {
    commentIssueIndex++;
    emitProgressImport(onProgress, 'comments', commentIssueIndex, commentIssueTotal || 1);
    const workItemId = itemIdByIssueNumber.get(issueNumber);
    if (!workItemId) continue;

    let ghComments: GithubIssueComment[];
    try {
      ghComments = await listGithubIssueCommentsAsync(config, issueNumber);
    } catch {
      continue;
    }

    for (const ghComment of ghComments) {
      // Skip worklog-originated comments (pushed from Worklog → GitHub)
      const worklogCommentId = extractWorklogCommentId(ghComment.body || undefined);
      if (worklogCommentId) continue;

      // Skip comments with no meaningful body
      if (!ghComment.body || !ghComment.body.trim()) continue;

      const commentId = generateCommentId ? generateCommentId() : `gh-${ghComment.id}`;
      importedComments.push({
        id: commentId,
        workItemId,
        author: ghComment.author || 'unknown',
        comment: ghComment.body,
        createdAt: ghComment.updatedAt,
        references: [],
        githubCommentId: ghComment.id,
        githubCommentUpdatedAt: ghComment.updatedAt,
      });
    }
  }

  return {
    updatedItems,
    createdItems,
    issues,
    updatedIds,
    mergedItems,
    conflictDetails: {
      conflicts: mergeResult.conflicts,
      conflictDetails: mergeResult.conflictDetails,
    },
    markersFound,
    fieldChanges: allFieldChanges,
    importedComments,
  };
}
