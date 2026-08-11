/**
 * Delegate orchestration helper — shared by CLI and TUI.
 *
 * Extracts the delegate flow (guard rails -> push -> assign -> local state
 * update) from the CLI action handler into a reusable async function that
 * returns a structured result.  Never calls `process.exit()` or writes to
 * `console.log`.
 */
import type { WorkItem, Comment } from './types.js';
import type { GithubConfig } from './github.js';
/** Structured result returned by `delegateWorkItem`. */
export interface DelegateResult {
    success: boolean;
    workItemId: string;
    issueNumber?: number;
    issueUrl?: string;
    pushed?: boolean;
    assigned?: boolean;
    /** Human-readable error key or message when `success` is false. */
    error?: string;
    /** Warning messages that were produced but did not prevent delegation. */
    warnings?: string[];
}
/** Options accepted by `delegateWorkItem`. */
export interface DelegateOptions {
    /** Override the do-not-delegate tag guard rail. */
    force?: boolean;
    /** Optional callback invoked at each major step of the delegate flow. */
    onProgress?: (step: string) => void;
}
/**
 * Subset of `WorklogDatabase` that `delegateWorkItem` depends on.  This
 * allows the TUI and tests to pass any object that satisfies the contract
 * without importing the full database module.
 */
export interface DelegateDb {
    get(id: string): WorkItem | null;
    getAll(): WorkItem[];
    getAllComments(): Comment[];
    getChildren(parentId: string): WorkItem[];
    update(id: string, input: Record<string, unknown>): WorkItem | null;
    upsertItems(items: WorkItem[]): void;
    createComment(input: {
        workItemId: string;
        author: string;
        comment: string;
    }): Comment | null;
}
type UpsertFn = typeof import('./github-sync.js').upsertIssuesFromWorkItems;
type AssignFn = typeof import('./github.js').assignGithubIssueAsync;
/**
 * Execute the full delegate flow for a single work item:
 *
 * 1. Resolve item from DB (guard: not-found)
 * 2. Guard rail: do-not-delegate tag
 * 3. Guard rail: open children warning (non-blocking)
 * 4. Push item to GitHub via upsert
 * 5. Resolve GitHub issue number
 * 6. Assign @copilot
 * 7. On failure: add comment, re-push
 * 8. On success: update local state, re-push labels
 *
 * The function never throws under normal operation -- all error paths
 * return `{ success: false, error: ... }`.
 */
export declare function delegateWorkItem(db: DelegateDb, githubConfig: GithubConfig, itemId: string, options?: DelegateOptions, 
/** Optional override for upsertIssuesFromWorkItems (useful for testing). */
_upsertFn?: UpsertFn, 
/** Optional override for assignGithubIssueAsync (useful for testing). */
_assignFn?: AssignFn): Promise<DelegateResult>;
export {};
//# sourceMappingURL=delegate-helper.d.ts.map