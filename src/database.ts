/**
 * Persistent database for work items with SQLite backend
 *
 * Thin re-export wrapper for the canonical WorklogDatabase class from
 * @worklog/shared. This module wires in CLI-specific services (JSONL,
 * sync, file-lock, search metrics, runtime, semantic search) so that
 * existing CLI code continues to work identically.
 */

import {
  WorklogDatabase as SharedWorklogDatabase,
  type WorklogDatabaseServices,
  type GitTarget,
  type JsonlImportResult,
} from '@worklog/shared';
import { SqlitePersistentStore, FtsSearchResult } from './persistent-store.js';
import { importFromJsonl, importFromJsonlContent, exportToJsonlAsync, getDefaultDataPath } from './jsonl.js';
import { mergeWorkItems, mergeComments, mergeAuditResults, getRemoteDataFileContent } from './sync.js';
import { withFileLock, getLockPathForJsonl } from './file-lock.js';
import * as searchMetrics from './search-metrics.js';
import { normalizeStatusValue } from './status-stage-rules.js';
import { getRuntime } from './lib/runtime.js';
import {
  EmbeddingStore,
  getDefaultEmbedder,
  createSearch,
  getEmbeddingStorePath,
  WorklogSearch,
} from './lib/search.js';

// ── Build default CLI services ─────────────────────────────────────────

function createDefaultServices(): WorklogDatabaseServices {
  return {
    jsonl: {
      importFromJsonl,
      importFromJsonlContent,
      exportToJsonlAsync,
      getDefaultDataPath,
    },
    sync: {
      mergeWorkItems,
      mergeComments,
      mergeAuditResults,
      getRemoteDataFileContent,
    },
    fileLock: {
      withFileLock,
      getLockPathForJsonl,
    },
    searchMetrics: {
      increment: (key: string) => searchMetrics.increment(key),
    },
    runtime: {
      getRuntime,
    },
    search: {
      getDefaultEmbedder,
      getEmbeddingStorePath,
      EmbeddingStore,
      createSearch,
      WorklogSearch,
    },
  };
}

// ── Re-export types used by other modules ──────────────────────────────

export type { WorklogDatabaseServices, GitTarget, JsonlImportResult };

// ── CLI-specific subclass ──────────────────────────────────────────────

/**
 * CLI-configured WorklogDatabase that automatically wires in all
 * CLI-specific services (JSONL, sync, file-lock, search metrics, etc.).
 *
 * Backward-compatible constructor signature — existing callers like
 * `new WorklogDatabase(prefix, dbPath, jsonlPath, silent, autoSync, syncProvider)`
 * continue to work identically.
 */
export class WorklogDatabase extends SharedWorklogDatabase {
  constructor(
    prefix: string = 'WI',
    dbPath?: string,
    jsonlPath?: string,
    silent: boolean = false,
    autoSync: boolean = false,
    syncProvider?: () => Promise<void>,
  ) {
    const services = createDefaultServices();
    super(prefix, dbPath, jsonlPath, silent, autoSync, syncProvider, services);
  }
}
