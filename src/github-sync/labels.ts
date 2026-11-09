/**
 * src/github-sync/labels.ts — label-derived field resolution of the
 * github-sync import flow.
 *
 * Concern: turning the single-valued labels of a GitHub issue (`stage:`,
 * `priority:`, `status:`, `type:`, `risk:`, `effort:`) into resolved work-item
 * field values. Every resolution is event-timestamp based: the most recent
 * label event for a category competes with the local `updatedAt`, the newer
 * side wins and local wins a tie. The rules live here — in one reviewable
 * place — so the import flow reads as orchestration, and the `FieldChange`
 * audit records are produced by the same code that decides the winner.
 *
 * Moved verbatim from `src/github-sync.ts` (WL-0MW0JF7QN007E1JU, child 4 of 8
 * of the WL-0MVGKH9Z900178UF `src/github-sync.ts` decomposition). Move-only:
 * the category suffixes, the tie-breaking rule, the result shapes and the
 * timestamps are unchanged. Label helpers are imported from the `../github.js`
 * barrel (never a `src/github/*` internal), and this module never imports the
 * `./github-sync.js` barrel.
 *
 * `FieldChange` remains declared in `./types.js` (the parent plan and child 2,
 * WL-0MW0JF5YE008LV1R, freeze all six declarations there); this module
 * re-exports it so the label-resolution surface is self-contained.
 */

import { getLatestLabelEventTimestamp } from '../github.js';
import type { LabelEvent } from '../github.js';
import type { WorkItem } from '../types.js';
import type { FieldChange } from './types.js';

export type { FieldChange };

/**
 * Label categories mapped to their WorkItem field names and label prefix suffixes.
 */
export const LABEL_FIELD_CATEGORIES: Array<{ field: string; category: string }> = [
  { field: 'stage', category: 'stage:' },
  { field: 'priority', category: 'priority:' },
  { field: 'status', category: 'status:' },
  { field: 'issueType', category: 'type:' },
  { field: 'risk', category: 'risk:' },
  { field: 'effort', category: 'effort:' },
];

/**
 * Resolve a single label-derived field using event timestamps.
 *
 * Compares the most recent label event timestamp for the given category
 * against the local updatedAt. If the label event is newer, returns the
 * remote (label-derived) value. If local is newer or equal, returns the
 * local value. When no events exist for the category, falls back to using
 * the issue updatedAt timestamp.
 *
 * @param localValue - Current local work item field value
 * @param localUpdatedAt - Local work item's updatedAt timestamp
 * @param remoteValue - Value extracted from GitHub labels
 * @param events - Sorted label events for the issue
 * @param category - Label category suffix (e.g. 'stage:', 'priority:')
 * @param labelPrefix - Worklog label prefix (e.g. 'wl:')
 * @param issueUpdatedAt - GitHub issue updatedAt as fallback timestamp
 * @returns Resolution result with the chosen value and whether it changed
 */
export function resolveLabelField(
  localValue: string,
  localUpdatedAt: string,
  remoteValue: string,
  events: LabelEvent[],
  category: string,
  labelPrefix: string,
  issueUpdatedAt: string
): { resolvedValue: string; changed: boolean; eventTimestamp: string | null } {
  // If the remote value is empty (no label for this category), keep local
  if (!remoteValue) {
    return { resolvedValue: localValue, changed: false, eventTimestamp: null };
  }

  // If the values are the same, no change needed
  if (remoteValue === localValue) {
    return { resolvedValue: localValue, changed: false, eventTimestamp: null };
  }

  // Find the most recent label event timestamp for this category
  const eventTimestamp = getLatestLabelEventTimestamp(events, labelPrefix, category);

  // Use event timestamp if available, otherwise fall back to issue updatedAt
  const effectiveTimestamp = eventTimestamp || issueUpdatedAt;

  const localTime = new Date(localUpdatedAt).getTime();
  const remoteTime = new Date(effectiveTimestamp).getTime();

  // If remote timestamp is newer, apply remote value
  if (remoteTime > localTime) {
    return { resolvedValue: remoteValue, changed: true, eventTimestamp: effectiveTimestamp };
  }

  // Local wins on equal or newer timestamps
  return { resolvedValue: localValue, changed: false, eventTimestamp: effectiveTimestamp };
}

/**
 * Resolve all label-derived fields for a work item against its local values.
 *
 * For each label-derived field category, compares event timestamps to local
 * updatedAt and determines the winning value. Produces a list of FieldChange
 * records for any fields that were updated from GitHub labels.
 *
 * @param localItem - The local work item
 * @param labelFields - Fields extracted from GitHub labels
 * @param events - Sorted label events for the issue
 * @param labelPrefix - Worklog label prefix
 * @param issueUpdatedAt - GitHub issue updatedAt as fallback timestamp
 * @returns Object with resolved field values and array of field changes
 */
export function resolveAllLabelFields(
  localItem: WorkItem,
  labelFields: { status: string; priority: string; stage: string; issueType: string; risk: string; effort: string },
  events: LabelEvent[],
  labelPrefix: string,
  issueUpdatedAt: string
): { resolvedFields: Record<string, string>; fieldChanges: FieldChange[] } {
  const resolvedFields: Record<string, string> = {};
  const fieldChanges: FieldChange[] = [];

  for (const { field, category } of LABEL_FIELD_CATEGORIES) {
    const localValue = String((localItem as any)[field] || '');
    const remoteValue = String((labelFields as any)[field] || '');

    const result = resolveLabelField(
      localValue,
      localItem.updatedAt,
      remoteValue,
      events,
      category,
      labelPrefix,
      issueUpdatedAt
    );

    resolvedFields[field] = result.resolvedValue;

    if (result.changed) {
      fieldChanges.push({
        workItemId: localItem.id,
        field,
        oldValue: localValue,
        newValue: result.resolvedValue,
        source: 'github-label',
        timestamp: result.eventTimestamp || issueUpdatedAt,
      });
    }
  }

  return { resolvedFields, fieldChanges };
}
