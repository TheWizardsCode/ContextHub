import { WorkItem, Comment } from './types.js';
import { GithubConfig, GithubIssueRecord } from './github.js';
export interface SyncedItem {
    action: 'created' | 'updated' | 'closed';
    id: string;
    title: string;
    issueNumber: number;
}
export interface SyncErrorItem {
    id: string;
    title: string;
    error: string;
}
export interface GithubSyncResult {
    updated: number;
    created: number;
    closed: number;
    skipped: number;
    errors: string[];
    syncedItems: SyncedItem[];
    errorItems: SyncErrorItem[];
    commentsCreated?: number;
    commentsUpdated?: number;
}
export interface GithubSyncTiming {
    totalMs: number;
    upsertMs: number;
    commentListMs: number;
    commentUpsertMs: number;
    hierarchyCheckMs: number;
    hierarchyLinkMs: number;
    hierarchyVerifyMs: number;
}
export interface GithubProgress {
    phase: 'push' | 'import' | 'close-check' | 'hierarchy' | 'comments' | 'saving';
    current: number;
    total: number;
    rate?: number;
    etaMs?: number | null;
    note?: string;
    lastError?: string | null;
    throttler?: {
        active: number;
        queueLength: number;
        tokens?: number;
        rate?: number;
        burst?: number;
        concurrency?: number;
    } | null;
}
export declare function upsertIssuesFromWorkItems(items: WorkItem[], comments: Comment[], config: GithubConfig, onProgress?: (progress: GithubProgress) => void, onVerboseLog?: (message: string) => void, persistComment?: (comment: Comment) => void): Promise<{
    updatedItems: WorkItem[];
    result: GithubSyncResult;
    timing: GithubSyncTiming;
}>;
/**
 * Represents a field that was changed during import label resolution.
 * Used for audit logging and JSON output.
 */
export interface FieldChange {
    workItemId: string;
    field: string;
    oldValue: string;
    newValue: string;
    source: 'github-label';
    timestamp: string;
}
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
export declare function resolveLabelField(localValue: string, localUpdatedAt: string, remoteValue: string, events: import('./github.js').LabelEvent[], category: string, labelPrefix: string, issueUpdatedAt: string): {
    resolvedValue: string;
    changed: boolean;
    eventTimestamp: string | null;
};
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
export declare function resolveAllLabelFields(localItem: WorkItem, labelFields: {
    status: string;
    priority: string;
    stage: string;
    issueType: string;
    risk: string;
    effort: string;
}, events: import('./github.js').LabelEvent[], labelPrefix: string, issueUpdatedAt: string): {
    resolvedFields: Record<string, string>;
    fieldChanges: FieldChange[];
};
export declare function importIssuesToWorkItems(items: WorkItem[], config: GithubConfig, options?: {
    since?: string;
    createNew?: boolean;
    generateId?: () => string;
    generateCommentId?: () => string;
    onProgress?: (progress: GithubProgress) => void;
    skipCloseCheck?: boolean;
}): Promise<{
    updatedItems: WorkItem[];
    createdItems: WorkItem[];
    issues: GithubIssueRecord[];
    updatedIds: Set<string>;
    mergedItems: WorkItem[];
    conflictDetails: {
        conflicts: string[];
        conflictDetails: import('./types.js').ConflictDetail[];
    };
    markersFound: number;
    fieldChanges: FieldChange[];
    importedComments: Comment[];
}>;
//# sourceMappingURL=github-sync.d.ts.map