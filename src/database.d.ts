/**
 * Persistent database for work items with SQLite backend
 *
 * Thin re-export wrapper for the canonical WorklogDatabase class from
 * @worklog/shared. This module wires in CLI-specific services (JSONL,
 * sync, file-lock, search metrics, runtime, semantic search) so that
 * existing CLI code continues to work identically.
 */
import { WorklogDatabase as SharedWorklogDatabase, type WorklogDatabaseServices, type GitTarget, type JsonlImportResult } from '@worklog/shared';
export type { WorklogDatabaseServices, GitTarget, JsonlImportResult };
/**
 * CLI-configured WorklogDatabase that automatically wires in all
 * CLI-specific services (JSONL, sync, file-lock, search metrics, etc.).
 *
 * Backward-compatible constructor signature — existing callers like
 * `new WorklogDatabase(prefix, dbPath, jsonlPath, silent, autoSync, syncProvider)`
 * continue to work identically.
 */
export declare class WorklogDatabase extends SharedWorklogDatabase {
    constructor(prefix?: string, dbPath?: string, jsonlPath?: string, silent?: boolean, autoSync?: boolean, syncProvider?: () => Promise<void>);
}
//# sourceMappingURL=database.d.ts.map