import { WorkItem, Comment, WorkItemStatus, WorkItemPriority } from './types.js';
export declare function setVerboseLogger(logger: ((msg: string) => void) | null): void;
export interface GithubConfig {
    repo: string;
    labelPrefix: string;
}
export interface GithubIssueRecord {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: 'open' | 'closed';
    labels: string[];
    updatedAt: string;
    subIssuesSummary?: {
        total: number;
        completed: number;
    };
}
export interface GithubIssueComment {
    id: number;
    body: string | null;
    updatedAt: string;
    author?: string;
}
export declare function ghApiAsyncScheduled(command: string, input?: string): Promise<string>;
export declare function ghApiDetailedScheduled(command: string, input?: string): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
}>;
export declare function ghApiJsonScheduled(command: string, input?: string): Promise<any>;
export declare function isSecondaryRateLimitText(text?: string): boolean;
export declare class SecondaryRateLimitError extends Error {
    stdout?: string;
    stderr?: string;
    constructor(message?: string, details?: {
        stdout?: string;
        stderr?: string;
    });
}
/**
 * Returns true when `label` is a worklog single-valued category label (e.g.
 * `wl:stage:idea`, `wl:priority:high`) or a bare legacy status label (e.g.
 * `wl:open`).
 *
 * Tags (`wl:tag:*`) are excluded because multiple tags are valid on a single
 * issue.
 */
export declare function isSingleValueCategoryLabel(label: string, labelPrefix: string): boolean;
export declare function normalizeGithubLabelPrefix(prefix?: string): string;
export declare function parseRepoSlug(repo: string): {
    owner: string;
    name: string;
};
export declare function getRepoFromGitRemote(): string | null;
export declare function buildWorklogMarker(workItemId: string): string;
export declare function buildWorklogCommentMarker(commentId: string): string;
export declare function stripWorklogMarkers(body?: string | null): string;
export declare function extractWorklogId(body?: string | null): string | null;
export declare function extractWorklogCommentId(body?: string | null): string | null;
export declare function extractParentId(body?: string | null): string | null;
export declare function extractParentIssueNumber(body?: string | null): number | null;
export interface IssueHierarchy {
    parentIssueNumber: number | null;
    childIssueNumbers: number[];
}
export declare function getIssueHierarchy(config: GithubConfig, issueNumber: number): IssueHierarchy;
export declare function getIssueNodeIdAsync(config: GithubConfig, issueNumber: number): Promise<string>;
export declare function getIssueHierarchyAsync(config: GithubConfig, issueNumber: number): Promise<IssueHierarchy>;
export declare function addSubIssueLink(config: GithubConfig, parentIssueNumber: number, childIssueNumber: number, cache?: Map<number, string>): void;
export declare function addSubIssueLinkResult(config: GithubConfig, parentIssueNumber: number, childIssueNumber: number, cache?: Map<number, string>): {
    ok: boolean;
    error?: string;
};
export declare function addSubIssueLinkAsync(config: GithubConfig, parentIssueNumber: number, childIssueNumber: number, cache?: Map<number, string>): Promise<void>;
export declare function addSubIssueLinkResultAsync(config: GithubConfig, parentIssueNumber: number, childIssueNumber: number, cache?: Map<number, string>): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function listParentIssueNumbersFromTimeline(config: GithubConfig, issueNumber: number): number[];
export declare function extractChildIds(body?: string | null): string[];
export declare function extractChildIssueNumbers(body?: string | null): number[];
export declare function workItemToIssuePayload(item: WorkItem, comments: Comment[], labelPrefix: string, allItems?: WorkItem[]): {
    title: string;
    body: string;
    labels: string[];
    state: 'open' | 'closed';
};
/**
 * @deprecated Use `listGithubIssueCommentsAsync` instead. This function blocks the event loop.
 * Migration: Replace `listGithubIssueComments(config, issueNumber)` with `await listGithubIssueCommentsAsync(config, issueNumber)`.
 */
export declare function listGithubIssueComments(config: GithubConfig, issueNumber: number): GithubIssueComment[];
export declare function listGithubIssueCommentsAsync(config: GithubConfig, issueNumber: number): Promise<GithubIssueComment[]>;
/**
 * @deprecated Use `createGithubIssueCommentAsync` instead. This function blocks the event loop.
 * Migration: Replace `createGithubIssueComment(config, issueNumber, body)` with `await createGithubIssueCommentAsync(config, issueNumber, body)`.
 */
export declare function createGithubIssueComment(config: GithubConfig, issueNumber: number, body: string): GithubIssueComment;
export declare function createGithubIssueCommentAsync(config: GithubConfig, issueNumber: number, body: string): Promise<GithubIssueComment>;
/**
 * @deprecated Use `updateGithubIssueCommentAsync` instead. This function blocks the event loop.
 * Migration: Replace `updateGithubIssueComment(config, commentId, body)` with `await updateGithubIssueCommentAsync(config, commentId, body)`.
 */
export declare function updateGithubIssueComment(config: GithubConfig, commentId: number, body: string): GithubIssueComment;
export declare function updateGithubIssueCommentAsync(config: GithubConfig, commentId: number, body: string): Promise<GithubIssueComment>;
/**
 * @deprecated Use `getGithubIssueCommentAsync` instead. This function blocks the event loop.
 * Migration: Replace `getGithubIssueComment(config, commentId)` with `await getGithubIssueCommentAsync(config, commentId)`.
 */
export declare function getGithubIssueComment(config: GithubConfig, commentId: number): GithubIssueComment;
export declare function getGithubIssueCommentAsync(config: GithubConfig, commentId: number): Promise<GithubIssueComment>;
export interface AssignGithubIssueResult {
    ok: boolean;
    error?: string;
}
/**
 * Assign a GitHub user to an issue via `gh issue edit --add-assignee`.
 *
 * Uses `runGhDetailedAsync` with rate-limit retry/backoff. On failure returns
 * `{ ok: false, error: <stderr> }` without throwing.
 */
export declare function assignGithubIssueAsync(config: GithubConfig, issueNumber: number, assignee: string, retries?: number): Promise<AssignGithubIssueResult>;
/**
 * Synchronous variant of `assignGithubIssueAsync`. Calls `runGhDetailed`
 * directly (no retry/backoff). Returns `{ ok: false, error }` on failure
 * without throwing.
 */
export declare function assignGithubIssue(config: GithubConfig, issueNumber: number, assignee: string): AssignGithubIssueResult;
export declare function issueToWorkItemFields(issue: GithubIssueRecord, labelPrefix: string): {
    status: WorkItemStatus;
    priority: WorkItemPriority;
    tags: string[];
    risk: string;
    effort: string;
    stage: string;
    issueType: string;
};
/**
 * @deprecated Use `createGithubIssueAsync` instead. This function blocks the event loop.
 * Migration: Replace `createGithubIssue(config, payload)` with `await createGithubIssueAsync(config, payload)`.
 */
export declare function createGithubIssue(config: GithubConfig, payload: {
    title: string;
    body: string;
    labels: string[];
}): GithubIssueRecord;
export declare function ensureGithubLabelsAsync(config: GithubConfig, labels: string[]): Promise<void>;
export declare function createGithubIssueAsync(config: GithubConfig, payload: {
    title: string;
    body: string;
    labels: string[];
}): Promise<GithubIssueRecord>;
export declare function updateGithubIssueAsync(config: GithubConfig, issueNumber: number, payload: {
    title: string;
    body: string;
    labels: string[];
    state: 'open' | 'closed';
}): Promise<GithubIssueRecord>;
export declare function getGithubIssueAsync(config: GithubConfig, issueNumber: number): Promise<GithubIssueRecord>;
export declare function listGithubIssuesAsync(config: GithubConfig, since?: string): Promise<GithubIssueRecord[]>;
/**
 * @deprecated Use `updateGithubIssueAsync` instead. This function blocks the event loop.
 * Migration: Replace `updateGithubIssue(config, issueNumber, payload)` with `await updateGithubIssueAsync(config, issueNumber, payload)`.
 */
export declare function updateGithubIssue(config: GithubConfig, issueNumber: number, payload: {
    title: string;
    body: string;
    labels: string[];
    state: 'open' | 'closed';
}): GithubIssueRecord;
/**
 * @deprecated Use `listGithubIssuesAsync` instead. This function blocks the event loop.
 * Migration: Replace `listGithubIssues(config, since)` with `await listGithubIssuesAsync(config, since)`.
 */
export declare function listGithubIssues(config: GithubConfig, since?: string): GithubIssueRecord[];
/**
 * @deprecated Use `getGithubIssueAsync` instead. This function blocks the event loop.
 * Migration: Replace `getGithubIssue(config, issueNumber)` with `await getGithubIssueAsync(config, issueNumber)`.
 */
export declare function getGithubIssue(config: GithubConfig, issueNumber: number): GithubIssueRecord;
/**
 * Represents a single label add/remove event from the GitHub issue events API.
 */
export interface LabelEvent {
    /** The full label name, e.g. "wl:stage:done" */
    label: string;
    /** Whether the label was added or removed */
    action: 'labeled' | 'unlabeled';
    /** ISO-8601 timestamp of the event */
    createdAt: string;
}
/**
 * In-memory cache for label events, scoped to a single import run.
 * Prevents redundant API calls for the same issue within one run.
 */
export declare class LabelEventCache {
    private cache;
    has(issueNumber: number): boolean;
    get(issueNumber: number): LabelEvent[] | undefined;
    set(issueNumber: number, events: LabelEvent[]): void;
    clear(): void;
    get size(): number;
}
/**
 * Fetch label events for a GitHub issue via the events API endpoint.
 *
 * Filters events to only those with action='labeled' or action='unlabeled'
 * where the label name starts with the configured prefix.
 *
 * Uses the in-memory cache to avoid redundant API calls within a single
 * import run. Falls back to an empty array on API failure.
 *
 * @param config - GitHub configuration with repo and label prefix
 * @param issueNumber - The issue number to fetch events for
 * @param cache - In-memory cache scoped to the import run
 * @returns Array of filtered label events, sorted by createdAt ascending
 */
export declare function fetchLabelEventsAsync(config: GithubConfig, issueNumber: number, cache: LabelEventCache): Promise<LabelEvent[]>;
/**
 * Check whether label-derived fields from a GitHub issue differ from local
 * work item values. Used to determine whether event fetching is necessary.
 *
 * @param labelFields - Fields extracted from GitHub issue labels
 * @param localItem - The local work item to compare against
 * @returns true if any label-derived field differs from the local value
 */
export declare function labelFieldsDiffer(labelFields: {
    status: WorkItemStatus;
    priority: WorkItemPriority;
    stage: string;
    issueType: string;
    risk: string;
    effort: string;
}, localItem: {
    status: WorkItemStatus;
    priority: WorkItemPriority;
    stage: string;
    issueType: string;
    risk: string;
    effort: string;
}): boolean;
/**
 * Get the most recent label event timestamp for a specific label category.
 * Looks through events for the last 'labeled' action matching the given
 * category prefix (e.g. 'stage:', 'priority:').
 *
 * @param events - Sorted array of label events (ascending by createdAt)
 * @param labelPrefix - The worklog label prefix (e.g. 'wl:')
 * @param category - The category to search for (e.g. 'stage:', 'priority:')
 * @returns The createdAt timestamp of the most recent matching event, or null
 */
export declare function getLatestLabelEventTimestamp(events: LabelEvent[], labelPrefix: string, category: string): string | null;
//# sourceMappingURL=github.d.ts.map