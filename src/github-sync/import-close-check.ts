/**
 * src/github-sync/import-close-check.ts — the close-check phase of the
 * github-sync import flow.
 *
 * Concern: the second scan pass of the import. The issue loop only inspects
 * issues that came back from the listing (`since`-filtered); the close-check
 * phase revisits every local item that carries a `githubIssueNumber` but was
 * *not* in that listing, fetches it individually and folds its state, label
 * fields and parent/child hints into the same scan state. It is what makes a
 * closed (or reopened) issue propagate when it fell outside the listing window.
 *
 * The phase is a no-op when the caller passes `skipCloseCheck` (the import
 * defaults it to `true` when a `since` window is supplied). It reads and writes
 * the shared {@link ImportScanState} and returns nothing: the merged items are
 * produced by the orchestrator after the phase has run.
 *
 * Extracted from `src/github-sync.ts` (WL-0MW0JFANE006VCGO, child 7 of 8 of the
 * WL-0MVGKH9Z900178UF `src/github-sync.ts` decomposition). Move-only: the skip
 * rules (open issue with a non-completed item, an unchanged issue whose local
 * status already matches), the timestamp comparison, the label-derived remote
 * item construction, the `close-check` progress phase and the swallow-and-skip
 * behaviour of a failed issue fetch are unchanged. GitHub helpers come from the
 * `../github.js` barrel; this module never imports the `./github-sync.js`
 * barrel.
 */

import type { WorkItem, WorkItemRiskLevel, WorkItemEffortLevel } from '../types.js';
import {
  GithubConfig,
  getGithubIssueAsync,
  extractParentId,
  extractParentIssueNumber,
  extractChildIds,
  extractChildIssueNumbers,
  issueToWorkItemFields,
  stripWorklogMarkers,
  labelFieldsDiffer,
} from '../github.js';
import { recordCloseCheckIssueHints } from './import-hierarchy.js';
import type { ImportScanState } from './import-hierarchy.js';
import type { ProgressCallback, ProgressEmitter } from './progress.js';

/** Inputs of the close-check phase. */
export interface ImportCloseCheckOptions {
  /** The local items the import started from. */
  items: WorkItem[];
  /** GitHub connection/label-prefix configuration. */
  config: GithubConfig;
  /** The scan state the phase folds its findings into. */
  state: ImportScanState;
  /** When true the phase does nothing (a `since` window was supplied). */
  skipCloseCheck: boolean;
  /** Optional progress consumer. */
  onProgress?: ProgressCallback;
  /** The flow's progress emitter. */
  emitProgress: ProgressEmitter;
}

/**
 * Run the close-check phase over every local item with a GitHub issue number
 * that the issue loop did not see.
 */
export async function runImportCloseCheck(options: ImportCloseCheckOptions): Promise<void> {
  const { items, config, state, onProgress, emitProgress } = options;
  if (options.skipCloseCheck) {
    return;
  }
  let checked = 0;
  for (const item of items) {
    if (!item.githubIssueNumber) {
      checked += 1;
      continue;
    }
    if (state.seenIssueNumbers.has(item.githubIssueNumber)) {
      checked += 1;
      continue;
    }
    if (onProgress) {
      emitProgress(onProgress, 'close-check', checked + 1, items.length);
    }
    try {
    const issue = await getGithubIssueAsync(config, item.githubIssueNumber);
    const hierarchy = state.hierarchyByIssueNumber.get(issue.number);
    const parentIssueNumber = state.parentByChildIssueNumber.get(issue.number)
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
        state.remoteItemsById.set(item.id, {
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
      state.issueClosedById.set(item.id, isClosed);
      recordCloseCheckIssueHints(state, item.id, {
        parentId,
        childIds,
        parentIssueNumber,
        childIssueNumbers,
      });
      state.issueMetaById.set(item.id, {
        number: issue.number,
        id: issue.id,
        updatedAt: issue.updatedAt,
      });

      // Queue event-based resolution for close-check items where label fields differ
      if (labelFieldsDiffer(labelFields, item)) {
        state.pendingResolutions.push({
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
