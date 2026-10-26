/**
 * src/sync/field-merge.ts — same- and different-timestamp field merge.
 *
 * Concern: field-level conflict resolution for two copies of the same work
 * item — the by-id index and per-item merge driver (`indexItemsById`,
 * `mergeRemoteItem`), the deterministic tie-breaking at equal timestamps
 * (`mergeSameTimestampItems`) and the timestamp/close/regression-aware
 * resolution at different timestamps (`mergeDifferentTimestampItems`).
 *
 * `mergeRemoteItem` (and `indexItemsById`) live HERE, not in `./merge.ts`:
 * the public `mergeWorkItems` in `./merge.ts` calls them, so placing them in
 * `./merge.ts` would create a merge → field-merge → merge cycle
 * (WL-0MVP9QLWU003NV41 cycle constraint). They are exported for `./merge.ts`
 * only and are NOT added to the `./sync.js` public surface.
 *
 * Moved verbatim from `src/sync.ts` (WL-0MVP9QLWU003NV41, child 3 of 6 of the
 * WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). Move-only: no logic
 * edited, no signature changed, no symbol renamed.
 */

import type { WorkItem, ConflictDetail, ConflictFieldDetail } from '../types.js';
import type { MergeOptions } from './types.js';
import { isDefaultValue, stableValueKey, stableItemKey, mergeTags } from './merge-utils.js';
import {
  isValueRegression,
  isEmptyMeaningfulField,
  isTerminalStage,
  isAttributedDelete,
} from './merge-predicates.js';

export function indexItemsById(items: WorkItem[]): Map<string, WorkItem> {
  const mergedMap = new Map<string, WorkItem>();
  for (const item of items) {
    mergedMap.set(item.id, item);
  }
  return mergedMap;
}

export function mergeRemoteItem(
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

    const localIsDefault = !isEmptyMeaningfulField(field as string) && isDefaultValue(localValue, field, options);
    const remoteIsDefault = !isEmptyMeaningfulField(field as string) && isDefaultValue(remoteValue, field, options);

    // Special handling for close state (status=completed + terminal stage):
    // When one version has a close and the other has a different non-close status/stage,
    // prefer the close values. This prevents an unrelated field change on a different
    // client from silently reverting a close operation.
    //
    // DELETION PROPAGATION (WL-0MT2KZH0I005XUWE §4.3/AC2): at equal timestamps a
    // `deleted` status wins deterministically over any non-deleted value (including a
    // close) — deletion is terminal intent, and the same-timestamp strategy must not
    // resurrect a soft-deleted record (AC3 remote/local convergence).
    if (field === 'status') {
      if (localValue === 'deleted' || remoteValue === 'deleted') {
        const localDeleted = localValue === 'deleted';
        const remoteDeleted = remoteValue === 'deleted';
        const localAttributed = isAttributedDelete(localItem);
        const remoteAttributed = isAttributedDelete(remoteItem);

        // DELETE-SIDE PROTECTION (WL-0MSKZ30SK007K9TO): an UNATTRIBUTED soft-delete
        // (empty deletedBy/deleteReason) is not real intent — it must never override
        // a live remote/local item. A delete only wins when it is attributed, or when
        // BOTH sides are deleted (nothing live left to protect).
        if (localDeleted && !remoteDeleted && !localAttributed) {
          // Keep the live remote status; ignore the unattributed local delete.
          (merged as any)[field] = remoteValue;
          mergedFields.push(`${field} (unattributed local delete ignored, remote status kept)`);
          fieldDetails.push({
            field,
            localValue,
            remoteValue,
            chosenValue: remoteValue,
            chosenSource: 'remote',
            reason: 'local soft delete is unattributed (no deletedBy/deleteReason); remote live status kept'
          });
          continue;
        }
        if (remoteDeleted && !localDeleted && !remoteAttributed) {
          // Keep the local live status; ignore the unattributed remote delete.
          (merged as any)[field] = localValue;
          mergedFields.push(`${field} (unattributed remote delete ignored, local status kept)`);
          fieldDetails.push({
            field,
            localValue,
            remoteValue,
            chosenValue: localValue,
            chosenSource: 'local',
            reason: 'remote soft delete is unattributed (no deletedBy/deleteReason); local live status kept'
          });
          continue;
        }

        const chosenValue = localDeleted ? localValue : remoteValue;
        (merged as any)[field] = chosenValue;
        mergedFields.push(`${field} (deleted preserved)`);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue,
          chosenSource: chosenValue === localValue ? 'local' : 'remote',
          reason: localDeleted && remoteDeleted
            ? 'both sides soft-deleted — converged to deleted'
            : 'attributed soft delete is terminal and wins at equal timestamps'
        });
        continue;
      }
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

    // ── Regression guard (WL-0MSOYWZTH003JFVD) ──────────────────────
    // Detect when a merge-participating field regresses from a local
    // non-default value to a remote default (e.g. status: completed → open,
    // stage: done → idea, priority: high → medium).  The guard refuses the
    // import and reports the conflict unless acceptRegressions is true.
    // `assignee` is deliberately excluded (WL-0MV85WBZ2004VDUQ, Q1 option (a)).
    const mergeParticipatingFields = ['status', 'stage', 'priority'];
    if (mergeParticipatingFields.includes(field as string) && isValueRegression(localValue, remoteValue, field)) {
      const acceptRegressions = options?.acceptRegressions ?? false;
      if (!acceptRegressions) {
        // Refuse: keep local value, report regression conflict
        mergedFields.push(`${field} (regression refused, local kept)`);
        fieldDetails.push({
          field,
          localValue,
          remoteValue,
          chosenValue: localValue,
          chosenSource: 'local',
          reason: `regression detected: local ${String(localValue)} → remote ${String(remoteValue)} is a regression default; local value kept`
        });
        continue;
      }
      // With acceptRegressions=true, fall through to normal resolution.
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

  // Same-timestamp merges are quiescent: both sides share the identical updatedAt
  // by definition, so the merged item inherits it unchanged. No wall-clock stamp;
  // repeated syncs of the same divergence never advance updatedAt.
  merged.createdAt = localItem.createdAt;

  const conflictMessages: string[] = [
    `${remoteItem.id}: Same updatedAt but different content - ${sameTimestampLabel}`
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
      const localIsDefault = !isEmptyMeaningfulField(field as string) && isDefaultValue(localValue, field, options);
      const remoteIsDefault = !isEmptyMeaningfulField(field as string) && isDefaultValue(remoteValue, field, options);

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
      //
      // DELETION PROPAGATION (WL-0MT2KZH0I005XUWE §4.3/AC2): `deleted` is TERMINAL
      // intent and must never be blocked by close-preservation — deleting a
      // completed/in_review item (the delete command preserves the stage) would
      // otherwise never converge to the remote. When the NEWER side is `deleted`, its
      // status always wins; the newer timestamp already reflects the deletion time.
      //
      // DELETE-SIDE PROTECTION (WL-0MSKZ30SK007K9TO): an UNATTRIBUTED delete (empty
      // deletedBy/deleteReason) is not real intent and must never win by recency
      // alone — it would silently soft-delete an item the other side still considers
      // live. Unattributed deletes keep the live status; only ATTRIBUTED (or
      // both-sides-deleted) deletes propagate.
      if (field === 'status') {
        if (localValue === 'deleted' && remoteValue === 'deleted') {
          // Both sides soft-deleted — nothing live to protect; converge to deleted.
          (merged as any)[field] = 'deleted';
          mergedFields.push(`${field} (deleted from both)`);
          fieldDetails.push({
            field,
            localValue,
            remoteValue,
            chosenValue: 'deleted',
            chosenSource: 'both',
            reason: 'both sides soft-deleted — converged to deleted'
          });
          continue;
        }
        if (remoteValue === 'deleted' && isRemoteNewer) {
          if (isAttributedDelete(remoteItem)) {
            (merged as any)[field] = remoteValue;
            mergedFields.push(`${field} (deleted from remote)`);
            fieldDetails.push({
              field,
              localValue,
              remoteValue,
              chosenValue: remoteValue,
              chosenSource: 'remote',
              reason: 'remote records an attributed soft delete (newer timestamp)'
            });
          } else {
            // Keep the local live status; ignore the unattributed remote delete.
            (merged as any)[field] = localValue;
            mergedFields.push(`${field} (unattributed remote delete ignored, local status kept)`);
            fieldDetails.push({
              field,
              localValue,
              remoteValue,
              chosenValue: localValue,
              chosenSource: 'local',
              reason: 'remote soft delete is unattributed (no deletedBy/deleteReason); local live status kept'
            });
          }
          continue;
        }
        if (localValue === 'deleted' && !isRemoteNewer) {
          if (isAttributedDelete(localItem)) {
            (merged as any)[field] = localValue;
            mergedFields.push(`${field} (deleted from local)`);
            fieldDetails.push({
              field,
              localValue,
              remoteValue,
              chosenValue: localValue,
              chosenSource: 'local',
              reason: 'local records an attributed soft delete (newer timestamp)'
            });
          } else {
            // Keep the remote live status; ignore the unattributed local delete.
            (merged as any)[field] = remoteValue;
            mergedFields.push(`${field} (unattributed local delete ignored, remote status kept)`);
            fieldDetails.push({
              field,
              localValue,
              remoteValue,
              chosenValue: remoteValue,
              chosenSource: 'remote',
              reason: 'local soft delete is unattributed (no deletedBy/deleteReason); remote live status kept'
            });
          }
          continue;
        }
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

      // ── Regression guard (WL-0MSOYWZTH003JFVD) ─────────────────────
      // `assignee` is deliberately excluded (WL-0MV85WBZ2004VDUQ, Q1 option (a)).
      const mergeParticipatingFieldsDiff = ['status', 'stage', 'priority'];
      if (mergeParticipatingFieldsDiff.includes(field as string) && isValueRegression(localValue, remoteValue, field)) {
        const acceptRegressionsDiff = options?.acceptRegressions ?? false;
        if (!acceptRegressionsDiff) {
          mergedFields.push(`${field} (regression refused, local kept)`);
          fieldDetails.push({
            field,
            localValue,
            remoteValue,
            chosenValue: localValue,
            chosenSource: 'local',
            reason: `regression detected: local ${String(localValue)} → remote ${String(remoteValue)} is a regression default; local value kept`
          });
          continue;
        }
        // With acceptRegressions=true, fall through to normal resolution.
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
