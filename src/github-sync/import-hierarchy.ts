/**
 * src/github-sync/import-hierarchy.ts — issue fetch, hierarchy resolution and
 * parent/child hint maps of the github-sync import flow.
 *
 * Concern: everything the import flow needs *before* it can decide what a
 * remote issue means — the issue fetch itself (`listGithubIssuesAsync`), the
 * sub-issue hierarchy maps built from `getIssueHierarchyAsync`, and the four
 * hint maps that carry the marker-derived and hierarchy-derived parent/child
 * relationships (worklog `parentId`/`childIds` markers and GitHub
 * `parentIssueNumber`/`childIssueNumbers`) from the scan phases to the merge
 * phase, where they are applied to the merged items.
 *
 * The maps live in one `ImportScanState` that the scan phases (this module, the
 * close-check phase and the orchestrator's issue loop) fill in and the merge
 * phase reads, so the hint bookkeeping rules — including the difference between
 * the issue loop (a hint set *replaces* or *clears* the entry) and the
 * close-check phase (a hint is only ever set, never cleared) — are defined once.
 *
 * Extracted from `src/github-sync.ts` (WL-0MW0JFANE006VCGO, child 7 of 8 of the
 * WL-0MVGKH9Z900178UF `src/github-sync.ts` decomposition). Move-only: the
 * hierarchy query order, the swallowing of a failed hierarchy fetch, the
 * progress phases (`import` / `hierarchy`), the three hint-application passes
 * and their iteration order are unchanged. GitHub helpers come from the
 * `../github.js` barrel; this module never imports the `./github-sync.js`
 * barrel.
 */

import type { WorkItem } from '../types.js';
import {
  GithubConfig,
  GithubIssueRecord,
  getIssueHierarchyAsync,
  listGithubIssuesAsync,
} from '../github.js';
import type { IssueHierarchy } from '../github.js';
import type { ProgressCallback, ProgressEmitter } from './progress.js';

/**
 * The label-derived field values the import flow compares against the local
 * item when it queues an event-based resolution.
 */
export interface ImportLabelFields {
  status: string;
  priority: string;
  stage: string;
  issueType: string;
  risk: string;
  effort: string;
}

/**
 * An issue whose label-derived fields differ from the local item, queued for
 * event-timeline resolution once both scan phases have run.
 */
export interface PendingResolution {
  issueNumber: number;
  itemId: string;
  localItem: WorkItem;
  labelFields: ImportLabelFields;
  issueUpdatedAt: string;
}

/**
 * The mutable scan state the import phases share.
 *
 * The two scan phases (the orchestrator's issue loop and the close-check
 * phase) record what they learned here; the label-resolution, merge,
 * enforcement and hint-application steps then read it.
 */
export interface ImportScanState {
  /** Sub-issue hierarchy per parent issue number (fetch-time snapshot). */
  hierarchyByIssueNumber: Map<number, IssueHierarchy>;
  /** Child issue number → parent issue number, inverted from the hierarchy. */
  parentByChildIssueNumber: Map<number, number>;
  /** The remote item the import resolved for a work-item id. */
  remoteItemsById: Map<string, WorkItem>;
  /** GitHub issue identity/timestamp recorded for a work-item id. */
  issueMetaById: Map<string, { number: number; id: number; updatedAt: string }>;
  /** Worklog-marker parent hints (`parentId` marker) per work-item id. */
  parentHints: Map<string, string>;
  /** Worklog-marker child hints (`childIds` markers) per work-item id. */
  childHints: Map<string, string[]>;
  /** Hierarchy parent-issue hints (parent issue number) per work-item id. */
  parentIssueHints: Map<string, number>;
  /** Hierarchy child-issue hints (child issue numbers) per work-item id. */
  childIssueHints: Map<string, number[]>;
  /** Issue numbers the issue loop already accounted for. */
  seenIssueNumbers: Set<number>;
  /** Queued label-field resolutions, in discovery order. */
  pendingResolutions: PendingResolution[];
  /**
   * Authoritative GitHub issue state (open/closed) per work item id.
   *
   * GitHub issue state is NOT a label-derived field — it is authoritative and
   * must survive the timestamp-based mergeWorkItems resolution. This map is
   * populated during Phase 1 and Phase 2, then used after merge to enforce
   * the correct status regardless of which side "won" the timestamp
   * comparison.
   */
  issueClosedById: Map<string, boolean>;
}

/** The parent/child hint values a scan phase records for one work item. */
export interface IssueHintInput {
  parentId?: string | null;
  childIds: string[];
  parentIssueNumber?: number | null;
  childIssueNumbers: number[];
}

/** Create an empty scan state seeded with the fetch-time hierarchy maps. */
export function createImportScanState(
  hierarchyByIssueNumber: Map<number, IssueHierarchy>,
  parentByChildIssueNumber: Map<number, number>,
): ImportScanState {
  return {
    hierarchyByIssueNumber,
    parentByChildIssueNumber,
    remoteItemsById: new Map<string, WorkItem>(),
    issueMetaById: new Map<string, { number: number; id: number; updatedAt: string }>(),
    parentHints: new Map<string, string>(),
    childHints: new Map<string, string[]>(),
    parentIssueHints: new Map<string, number>(),
    childIssueHints: new Map<string, number[]>(),
    seenIssueNumbers: new Set<number>(),
    pendingResolutions: [],
    issueClosedById: new Map<string, boolean>(),
  };
}

/**
 * Fetch the issues and resolve their sub-issue hierarchy.
 *
 * Emits the `import` phase start event, lists the issues (`since` filtered by
 * the caller) and then queries the hierarchy of every issue that reports
 * sub-issues. A hierarchy query that throws is skipped, leaving that issue's
 * children to the marker-derived hints — exactly as before.
 */
export async function fetchIssuesAndHierarchy(
  config: GithubConfig,
  since: string | undefined,
  onProgress: ProgressCallback | undefined,
  emitProgress: ProgressEmitter,
): Promise<{
  issues: GithubIssueRecord[];
  hierarchyByIssueNumber: Map<number, IssueHierarchy>;
  parentByChildIssueNumber: Map<number, number>;
}> {
  if (onProgress) {
    emitProgress(onProgress, 'import', 0, 1, 'fetching issues');
  }
  const issues = await listGithubIssuesAsync(config, since);

  const hierarchyByIssueNumber = new Map<number, IssueHierarchy>();
  const parentIssueNumbers = issues
    .filter(issue => (issue.subIssuesSummary?.total ?? 0) > 0)
    .map(issue => issue.number);
  const parentByChildIssueNumber = new Map<number, number>();
  let hierarchyChecked = 0;
  for (const issueNumber of parentIssueNumbers) {
    if (onProgress) {
      emitProgress(onProgress, 'hierarchy', hierarchyChecked + 1, parentIssueNumbers.length || 1);
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

  return { issues, hierarchyByIssueNumber, parentByChildIssueNumber };
}

/**
 * Record the hints of an issue visited by the orchestrator's issue loop.
 *
 * A present hint replaces the entry; an absent one *clears* it, so a marker
 * removed on GitHub removes the local hint instead of leaving a stale one.
 */
export function recordIssueHints(
  state: ImportScanState,
  itemId: string,
  hints: IssueHintInput,
): void {
  if (hints.parentId) {
    state.parentHints.set(itemId, hints.parentId);
  } else {
    state.parentHints.delete(itemId);
  }
  if (hints.childIds.length > 0) {
    state.childHints.set(itemId, hints.childIds);
  } else {
    state.childHints.delete(itemId);
  }
  if (hints.parentIssueNumber) {
    state.parentIssueHints.set(itemId, hints.parentIssueNumber);
  } else {
    state.parentIssueHints.delete(itemId);
  }
  if (hints.childIssueNumbers.length > 0) {
    state.childIssueHints.set(itemId, hints.childIssueNumbers);
  } else {
    state.childIssueHints.delete(itemId);
  }
}

/**
 * Record the hints of an issue visited by the close-check phase.
 *
 * Unlike {@link recordIssueHints} the close-check phase only ever *adds* a
 * hint: it revisits an issue the issue loop did not see, so it must not clear
 * an entry another issue already established.
 */
export function recordCloseCheckIssueHints(
  state: ImportScanState,
  itemId: string,
  hints: IssueHintInput,
): void {
  if (hints.parentId) {
    state.parentHints.set(itemId, hints.parentId);
  }
  if (hints.childIds.length > 0) {
    state.childHints.set(itemId, hints.childIds);
  }
  if (hints.parentIssueNumber) {
    state.parentIssueHints.set(itemId, hints.parentIssueNumber);
  }
  if (hints.childIssueNumbers.length > 0) {
    state.childIssueHints.set(itemId, hints.childIssueNumbers);
  }
}

/**
 * Stamp each merged item with its worklog parent hint and GitHub issue
 * identity, leaving an item without recorded remote metadata untouched.
 */
export function applyParentHintsAndIssueMetadata(
  merged: WorkItem[],
  state: ImportScanState,
): WorkItem[] {
  return merged.map(item => {
    const meta = state.issueMetaById.get(item.id);
    const parentId = state.parentHints.get(item.id) ?? null;
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
}

/**
 * Apply the hierarchy- and marker-derived parent/child hints to the merged
 * items, in the historical order: `childHints` (marker child ids) first, then
 * `parentIssueHints` (hierarchy parent numbers), then `childIssueHints`
 * (hierarchy child numbers). A hint naming an item or issue that is not part of
 * this import is skipped.
 */
export function applyParentChildHints(
  mergedItems: WorkItem[],
  state: ImportScanState,
): void {
  if (state.childHints.size > 0) {
    const itemsById = new Map(mergedItems.map(item => [item.id, item]));
    for (const [parentId, childIds] of state.childHints.entries()) {
      for (const childId of childIds) {
        const child = itemsById.get(childId);
        if (!child) {
          continue;
        }
        child.parentId = parentId;
      }
    }
  }

  if (state.parentIssueHints.size > 0) {
    const itemsByIssue = new Map<number, WorkItem>();
    for (const item of mergedItems) {
      if (item.githubIssueNumber) {
        itemsByIssue.set(item.githubIssueNumber, item);
      }
    }
    for (const [childId, parentIssueNumber] of state.parentIssueHints.entries()) {
      const child = mergedItems.find(item => item.id === childId);
      const parent = itemsByIssue.get(parentIssueNumber);
      if (!child || !parent) {
        continue;
      }
      child.parentId = parent.id;
    }
  }

  if (state.childIssueHints.size > 0) {
    const itemsByIssue = new Map<number, WorkItem>();
    for (const item of mergedItems) {
      if (item.githubIssueNumber) {
        itemsByIssue.set(item.githubIssueNumber, item);
      }
    }
    for (const [parentId, issueNumbers] of state.childIssueHints.entries()) {
      for (const issueNumber of issueNumbers) {
        const child = itemsByIssue.get(issueNumber);
        if (!child) {
          continue;
        }
        child.parentId = parentId;
      }
    }
  }
}
