/**
 * src/github-sync/import.ts — orchestrator of the GitHub → worklog import flow.
 *
 * Concern: `importIssuesToWorkItems`, the public entry point of the import.
 * It owns the *order* of the phases and the shape of the result, and nothing
 * else: the issue fetch, hierarchy resolution and hint maps live in
 * `./import-hierarchy.js`, the close-check pass in `./import-close-check.js`,
 * the comment import in `./import-comments.js`, the label event resolution in
 * `./labels.js`, the progress emitter in `./progress.js` and the shared
 * comparison helpers in `./util.js`.
 *
 * The mutation order is the contract and must not be reordered: scan the
 * listing (recording remote items, authoritative open/closed state, hints and
 * queued label resolutions) → close-check pass → resolve label fields from the
 * event timeline → merge with `mergeWorkItems` → stamp issue metadata and
 * worklog parent hints → re-apply the label resolutions the merge may have
 * overridden → enforce the authoritative open/closed state → apply the
 * hierarchy parent/child hints → diff the merged items against the local ones
 * (`stableItemKeyForImport`) → import the comments.
 *
 * Extracted from `src/github-sync.ts` (WL-0MW0JFANE006VCGO, child 7 of 8 of the
 * WL-0MVGKH9Z900178UF `src/github-sync.ts` decomposition). Move-only: the
 * options, the return shape, the marker counting, the duplicate-marker warning
 * with its `shouldReplaceRemote` tie-break, the progress phases and every merge
 * / enforcement / hint step behave exactly as before. This module imports the
 * `../github.js` barrel and its sibling modules; it never imports the
 * `./github-sync.js` barrel.
 */

import { WorkItem, Comment, WorkItemRiskLevel, WorkItemEffortLevel } from '../types.js';
import { theme } from '../theme.js';
import {
  GithubConfig,
  GithubIssueRecord,
  stripWorklogMarkers,
  extractWorklogId,
  extractParentId,
  extractParentIssueNumber,
  extractChildIds,
  extractChildIssueNumbers,
  issueToWorkItemFields,
  LabelEventCache,
  fetchLabelEventsAsync,
  labelFieldsDiffer,
} from '../github.js';
import throttler from '../github-throttler.js';
import { mergeWorkItems } from '../sync.js';
import { createProgressEmitter } from './progress.js';
import { LABEL_FIELD_CATEGORIES, resolveAllLabelFields } from './labels.js';
import type { FieldChange } from './labels.js';
import { stableItemKeyForImport } from './util.js';
import {
  applyParentChildHints,
  applyParentHintsAndIssueMetadata,
  createImportScanState,
  fetchIssuesAndHierarchy,
  recordIssueHints,
} from './import-hierarchy.js';
import { runImportCloseCheck } from './import-close-check.js';
import { importIssueComments } from './import-comments.js';
import type { GithubProgress } from './types.js';

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
  conflictDetails: { conflicts: string[]; conflictDetails: import('../types.js').ConflictDetail[] };
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

  const {
    issues,
    hierarchyByIssueNumber,
    parentByChildIssueNumber,
  } = await fetchIssuesAndHierarchy(config, since, onProgress, emitProgressImport);

  const byId = new Map(items.map(item => [item.id, item]));
  const byIssueNumber = new Map<number, WorkItem>();
  for (const item of items) {
    if (item.githubIssueNumber) {
      byIssueNumber.set(item.githubIssueNumber, item);
    }
  }

  const state = createImportScanState(hierarchyByIssueNumber, parentByChildIssueNumber);
  let markersFound = 0;
  const allFieldChanges: FieldChange[] = [];
  const labelEventCache = new LabelEventCache();

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

    const existingMeta = state.issueMetaById.get(remoteItem.id);
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
        state.seenIssueNumbers.add(issue.number);
        processed += 1;
        continue;
      }
    }
    if (shouldReplace) {
      state.remoteItemsById.set(remoteItem.id, remoteItem);
      state.issueClosedById.set(remoteItem.id, isClosed);
      state.issueMetaById.set(remoteItem.id, {
        number: issue.number,
        id: issue.id,
        updatedAt: issue.updatedAt,
      });
      recordIssueHints(state, remoteItem.id, {
        parentId,
        childIds,
        parentIssueNumber,
        childIssueNumbers,
      });

      // Queue event-based resolution for items where label fields differ from local
      if (existing && labelFieldsDiffer(labelFields, existing)) {
        state.pendingResolutions.push({
          issueNumber: issue.number,
          itemId: remoteItem.id,
          localItem: existing,
          labelFields,
          issueUpdatedAt: issue.updatedAt,
        });
      }
    }
    state.seenIssueNumbers.add(issue.number);
    processed += 1;
  }

  await runImportCloseCheck({
    items,
    config,
    state,
    skipCloseCheck,
    onProgress,
    emitProgress: emitProgressImport,
  });

  // Resolve label conflicts using event timelines for items where fields differ
  for (const pending of state.pendingResolutions) {
    const events = await fetchLabelEventsAsync(config, pending.issueNumber, labelEventCache);
    const { resolvedFields, fieldChanges } = resolveAllLabelFields(
      pending.localItem,
      pending.labelFields,
      events,
      config.labelPrefix,
      pending.issueUpdatedAt
    );

    // Apply resolved values to the remote item already stored in remoteItemsById
    const remoteItem = state.remoteItemsById.get(pending.itemId);
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

  const remoteItems = Array.from(state.remoteItemsById.values());
  const mergeResult = mergeWorkItems(items, remoteItems, {
    defaultValueFields: ['status'],
    sameTimestampStrategy: 'local',
  });
  const mergedItems = applyParentHintsAndIssueMetadata(mergeResult.merged, state);

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
  if (state.issueClosedById.size > 0) {
    const mergedById = new Map(mergedItems.map(item => [item.id, item]));
    for (const [itemId, isClosed] of state.issueClosedById.entries()) {
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

  applyParentChildHints(mergedItems, state);

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

  const importedComments = await importIssueComments({
    config,
    items,
    mergedItems,
    state,
    generateCommentId,
    onProgress,
    emitProgress: emitProgressImport,
  });

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
