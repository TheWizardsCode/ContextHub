/**
 * SQLite-based persistent storage for work items and comments
 */
import { WorkItem, Comment, DependencyEdge, AuditResult } from './types.js';
/**
 * Result from a full-text search query
 */
export interface FtsSearchResult {
    /** The work item ID */
    itemId: string;
    /** BM25 relevance score (lower = more relevant in SQLite FTS5) */
    rank: number;
    /** Snippet with highlighted matches */
    snippet: string;
    /** Which column the snippet was extracted from */
    matchedColumn: string;
}
interface DbMetadata {
    lastJsonlImportMtime?: number;
    lastJsonlImportAt?: string;
    schemaVersion: number;
}
/**
 * Normalize a single value for use as a better-sqlite3 binding parameter.
 * better-sqlite3 only accepts: number, string, bigint, Buffer, or null.
 * This function converts unsupported types:
 *  - undefined  -> null
 *  - null       -> null (passthrough)
 *  - boolean    -> 1 or 0
 *  - Date       -> ISO 8601 string via toISOString()
 *  - object/array -> JSON string via JSON.stringify (fallback to String())
 *  - number, string, bigint, Buffer -> passthrough
 */
export declare function normalizeSqliteValue(v: unknown): number | string | bigint | Buffer | null;
/**
 * Normalize an array of values for use as better-sqlite3 binding parameters.
 * Applies {@link normalizeSqliteValue} to each element.
 */
export declare function normalizeSqliteBindings(values: unknown[]): Array<number | string | bigint | Buffer | null>;
/**
 * Unescape backslash escape sequences in a plain-text string before persisting.
 * Converts common two-character escape artifacts (e.g. backslash-n from CLI
 * argument passing) into their actual character equivalents so stored text is
 * human-readable and free of accidental escape artifacts.
 *
 * Only the following sequences are converted (single-pass, left-to-right):
 *   \n  -> newline
 *   \t  -> tab
 *   \r  -> carriage return
 *   \\  -> single backslash
 *
 * All other characters (including quotes and backticks) are left unchanged.
 * This function must NOT be applied to JSON strings or structured fields.
 */
export declare function unescapeText(s: string): string;
export declare class SqlitePersistentStore {
    private db;
    private dbPath;
    private verbose;
    private _ftsAvailable;
    constructor(dbPath: string, verbose?: boolean);
    /**
     * Whether FTS5 full-text search is available in this SQLite build
     */
    get ftsAvailable(): boolean;
    /**
     * Initialize database schema
     */
    private initializeSchema;
    /**
     * Get metadata value
     */
    getMetadata(key: string): string | null;
    /**
     * Set metadata value
     */
    setMetadata(key: string, value: string): void;
    /**
     * Get all metadata
     */
    getAllMetadata(): DbMetadata;
    /**
     * Save a work item
     */
    saveWorkItem(item: WorkItem): void;
    /**
     * Get a work item by ID
     */
    getWorkItem(id: string): WorkItem | null;
    /**
     * Count work items
     */
    countWorkItems(): number;
    /**
     * Get all work items
     */
    getAllWorkItems(): WorkItem[];
    /**
     * Batch-update sortIndex values for a list of work items.
     * Uses a single transaction to reduce write overhead.
     * Each item at index i gets sortIndex = (i + 1) * gap.
     * Only updates items whose sortIndex actually changes.
     *
     * @returns The number of items whose sortIndex was changed.
     */
    batchUpdateSortIndices(orderedItems: WorkItem[], gap: number): number;
    getAllWorkItemsOrderedByHierarchySortIndex(): WorkItem[];
    /**
     * Get all work items ordered by hierarchy sort index, but skip completed/deleted
     * subtrees. Open children under completed/deleted parents are promoted to root
     * level so they don't inherit traversal priority from their completed ancestors.
     */
    getAllWorkItemsOrderedByHierarchySortIndexSkipCompleted(): WorkItem[];
    /**
     * Like getAllWorkItemsOrderedByHierarchySortIndexSkipCompleted(), but operates
     * on a pre-loaded items array instead of loading from the database.
     * This avoids redundant full-table scans when the caller already has items.
     */
    orderItemsByHierarchySortIndexSkipCompleted(items: WorkItem[]): WorkItem[];
    /**
     * Delete a work item
     */
    deleteWorkItem(id: string): boolean;
    /**
     * Clear all work items
     */
    clearWorkItems(): void;
    /**
     * Save a comment
     */
    saveComment(comment: Comment): void;
    /**
     * Get a comment by ID
     */
    getComment(id: string): Comment | null;
    /**
     * Get all comments
     */
    getAllComments(): Comment[];
    /**
     * Get comments for a work item
     */
    getCommentsForWorkItem(workItemId: string): Comment[];
    /**
     * Delete a comment
     */
    deleteComment(id: string): boolean;
    /**
     * Clear all comments
     */
    clearComments(): void;
    /**
     * Clear all dependency edges
     */
    clearDependencyEdges(): void;
    /**
     * Import work items and comments (replaces existing data)
     */
    importData(items: WorkItem[], comments: Comment[]): void;
    /**
     * Create or update a dependency edge
     */
    saveDependencyEdge(edge: DependencyEdge): void;
    /**
     * Remove a dependency edge
     */
    deleteDependencyEdge(fromId: string, toId: string): boolean;
    /**
     * List all dependency edges
     */
    getAllDependencyEdges(): DependencyEdge[];
    /**
     * List outbound dependency edges (fromId depends on toId)
     */
    getDependencyEdgesFrom(fromId: string): DependencyEdge[];
    /**
     * List inbound dependency edges (items that depend on toId)
     */
    getDependencyEdgesTo(toId: string): DependencyEdge[];
    /**
     * Remove all dependency edges for a work item
     */
    deleteDependencyEdgesForItem(itemId: string): number;
    /**
     * Save or update an audit result for a work item (upsert).
     * Only the latest audit per work item is kept.
     */
    saveAuditResult(audit: {
        workItemId: string;
        readyToClose: boolean;
        auditedAt: string;
        summary: string | null;
        rawOutput: string | null;
        author: string | null;
    }): void;
    /**
     * Get the audit result for a work item.
     * Returns null if no audit result exists.
     */
    getAuditResult(workItemId: string): {
        workItemId: string;
        readyToClose: boolean;
        auditedAt: string;
        summary: string | null;
        rawOutput: string | null;
        author: string | null;
    } | null;
    /**
     * Delete the audit result for a work item.
     */
    deleteAuditResult(workItemId: string): boolean;
    /**
     * Get all audit results (for JSONL export / sync).
     */
    getAllAuditResults(): AuditResult[];
    /**
     * Save or update audit results (upsert, bulk).
     */
    saveAuditResults(audits: {
        workItemId: string;
        readyToClose: boolean;
        auditedAt: string;
        summary: string | null;
        rawOutput: string | null;
        author: string | null;
    }[]): void;
    /**
     * Detect whether FTS5 is available and create the virtual table if so.
     * Returns true when FTS5 is usable, false otherwise (caller should fall
     * back to application-level search).
     */
    private initializeFts;
    /**
     * Upsert a single work item into the FTS index.
     * Collects all comments for the item and concatenates them into a single
     * text blob so comment content is searchable.
     */
    upsertFtsEntry(item: WorkItem): void;
    /**
     * Remove a work item from the FTS index
     */
    deleteFtsEntry(itemId: string): void;
    /**
     * Rebuild the entire FTS index from the current workitems and comments tables.
     * This drops and recreates the FTS table then inserts all items.
     */
    rebuildFtsIndex(): {
        indexed: number;
    };
    /**
     * Search the FTS index using an FTS5 MATCH expression.
     * Returns results ranked by BM25 relevance (most relevant first).
     *
     * @param query - FTS5 query string (supports phrases, prefix*, OR, AND, NOT)
     * @param options - Optional filters and limits
     */
    searchFts(query: string, options?: {
        status?: string;
        parentId?: string;
        tags?: string[];
        limit?: number;
        priority?: string;
        assignee?: string;
        stage?: string;
        deleted?: boolean;
        needsProducerReview?: boolean;
        issueType?: string;
    }): FtsSearchResult[];
    /**
     * Perform a simple application-level text search as a fallback when FTS5
     * is not available. Searches title, description, tags and comment bodies
     * using case-insensitive substring matching with basic relevance scoring.
     */
    searchFallback(query: string, options?: {
        status?: string;
        parentId?: string;
        tags?: string[];
        limit?: number;
        priority?: string;
        assignee?: string;
        stage?: string;
        deleted?: boolean;
        needsProducerReview?: boolean;
        issueType?: string;
    }): FtsSearchResult[];
    /**
     * Count occurrences of a substring in a string
     */
    private countOccurrences;
    /**
     * Generate a snippet around the first occurrence of a term
     */
    private generateSnippet;
    /**
     * Find work items whose ID contains the given substring (case-insensitive).
     * Used for partial-ID matching when the query token length is >= 8 characters.
     */
    findByIdSubstring(substr: string): WorkItem[];
    /**
     * Close database connection
     */
    close(): void;
    /**
     * Convert database row to WorkItem
     */
    private rowToWorkItem;
    /**
     * Convert database row to Comment
     */
    private rowToComment;
    /**
     * Convert database row to DependencyEdge
     */
    private rowToDependencyEdge;
}
export {};
//# sourceMappingURL=persistent-store.d.ts.map