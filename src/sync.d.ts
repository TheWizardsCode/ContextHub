/**
 * Sync functionality for merging local and remote work items with conflict resolution
 */
import { WorkItem, Comment, ConflictDetail, DependencyEdge, AuditResult } from './types.js';
export interface GitTarget {
    remote: string;
    branch: string;
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
    conflicts: string[];
    conflictDetails: ConflictDetail[];
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
export declare function mergeWorkItems(localItems: WorkItem[], remoteItems: WorkItem[], options?: MergeOptions): {
    merged: WorkItem[];
    conflicts: string[];
    conflictDetails: ConflictDetail[];
};
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
export declare function isOwnProjectItemId(id: string, projectPrefix: string): boolean;
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
export declare function filterRemoteDataByPrefix(items: WorkItem[], comments: Comment[], edges: DependencyEdge[], audits: AuditResult[], projectPrefix: string): {
    items: WorkItem[];
    comments: Comment[];
    edges: DependencyEdge[];
    audits: AuditResult[];
    droppedItems: string[];
};
/**
 * Merge two sets of comments
 * Comments are immutable after creation (except explicit updates), so we use createdAt + id for deduplication
 */
export declare function mergeComments(localComments: Comment[], remoteComments: Comment[]): {
    merged: Comment[];
    conflicts: string[];
};
/**
 * Merge audit results by unique work item id.
 * Local audits take precedence over remote ones.
 */
export declare function mergeAuditResults(localAudits: AuditResult[], remoteAudits: AuditResult[]): {
    merged: AuditResult[];
};
/**
 * Merge dependency edges by unique from/to pairs.
 */
export declare function mergeDependencyEdges(localEdges: DependencyEdge[], remoteEdges: DependencyEdge[]): {
    merged: DependencyEdge[];
};
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
export declare function assertDataFileInCwdRepo(dataFilePath: string): Promise<void>;
declare function getRemoteTrackingRef(remote: string, branchOrRef: string): string;
export declare const _testOnly_getRemoteTrackingRef: typeof getRemoteTrackingRef;
export declare function getRemoteDataFileContent(dataFilePath: string, target: GitTarget): Promise<string | null>;
export declare function gitPushDataFileToBranch(repoDataFilePath: string, commitMessage: string, target: GitTarget): Promise<void>;
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
export declare function rewriteAndForcePushDataFile(repoDataFilePath: string, commitMessage: string, target: GitTarget): Promise<string>;
export {};
//# sourceMappingURL=sync.d.ts.map