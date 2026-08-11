/**
 * Shared helper functions for CLI commands
 */
import type { WorkItem, Comment } from '../types.js';
import type { SyncResult } from '../sync.js';
import type { WorklogDatabase } from '../database.js';
import type { Command } from 'commander';
export declare function formatValue(value: any): string;
export declare function sortByPriorityAndDate(a: WorkItem, b: WorkItem): number;
export declare function sortByPriorityDateAndId(a: WorkItem, b: WorkItem): number;
export declare function formatTitleAndId(item: WorkItem, prefix?: string): string;
export declare function formatTitleOnly(item: WorkItem): string;
/**
 * @deprecated Use `displayItemTreeWithFormat(items, db, format)` which delegates
 * to the human formatter and keeps `list` and `show` outputs consistent.
 */
export declare function displayItemTree(items: WorkItem[]): void;
export declare function displayItemTreeWithFormat(items: WorkItem[], db: WorklogDatabase | null, format: string): void;
/**
 * Render the same tree output as `displayItemTreeWithFormat` but return it as
 * a single string instead of printing directly. This is useful when callers
 * wish to pipe the output through a pager or otherwise capture it.
 */
export declare function displayItemTreeWithFormatToString(items: WorkItem[], db: WorklogDatabase | null, format: string): string;
export declare function humanFormatWorkItem(item: WorkItem, db: WorklogDatabase | null, format: string | undefined): string;
export declare function resolveFormat(program: Command, provided?: string): string;
export declare function humanFormatComment(comment: Comment, format?: string): string;
export declare function displayConflictDetails(result: SyncResult, mergedItems: WorkItem[], options?: {
    repoUrl?: string;
}): void;
/**
 * Wrap any command output in a standard success/error envelope.
 *
 * All commands using --json should ensure their top-level JSON shape
 * follows the pattern: `{ success: true/false, ...data }`.
 */
export declare function wrapJsonResponse<T extends Record<string, unknown> = Record<string, unknown>>(data: T, success?: boolean): {
    success: boolean;
} & T;
/**
 * Convenience: wrap an array of work items for an array-returning command.
 *
 * Array-returning commands (list, search, in-progress, recent) should use
 * the shape: `{ success: true, count, workItems: [...] }`.
 */
export declare function wrapWorkItemsResponse(workItems: unknown[], extraFields?: Record<string, unknown>): Record<string, unknown>;
/**
 * Convenience: wrap a single work item for an object-returning command.
 *
 * Object-returning commands (show, create, update, next single) should use
 * the shape: `{ success: true, workItem: {...}, ...extraFields }`.
 */
export declare function wrapWorkItemResponse(workItem: unknown, extraFields?: Record<string, unknown>): Record<string, unknown>;
/**
 * Extract file paths from a work item description.
 *
 * Looks for a "Key Files" or "Key Files:" section (case-insensitive, with or without bold markers,
 * and with or without a trailing colon, e.g. `**Key Files:**`, `## Key Files`, `key files:`, `Key Files`)
 * and extracts path-like strings from subsequent bullet list items.
 *
 * A path is considered valid if it:
 * - Contains at least one `/` (indicating a file in a directory)
 * - Ends with a file extension after a `.` (e.g., `.ts`, `.md`, `.json`)
 *
 * Items can be listed with or without backtick formatting.
 *
 * @param description - The work item description text
 * @returns Array of extracted file paths
 */
export declare function extractFilePaths(description: string): string[];
/**
 * Input item for grouping — must have an `id`, `stage`, and a list of `filePaths`.
 */
export interface GroupableItem {
    id: string;
    stage?: string;
    filePaths: string[];
    priority?: string;
}
/**
 * Result of assigning an item to a group.
 * `group` is a 1-indexed integer for ordering.
 * `groupLabel` is a human-readable label for display.
 */
export interface GroupAssignment {
    group: number;
    groupLabel: string;
}
//# sourceMappingURL=helpers.d.ts.map