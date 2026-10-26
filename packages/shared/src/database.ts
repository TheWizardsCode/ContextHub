/**
 * Persistent database for work items with SQLite backend
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { WorkItem, WorkItemPriority, CreateWorkItemInput, UpdateWorkItemInput, WorkItemQuery, Comment, CreateCommentInput, UpdateCommentInput, NextWorkItemResult, DependencyEdge, AuditResult, AuditWaiver, DemotedParent, RevertedItem } from './types.js';
import { SqlitePersistentStore, FtsSearchResult, PersistentStoreServices, PersistentStoreCacheOptions, LastExportTimestamps, unescapeText } from './persistent-store.js';
// Self-referencing package export (WL-0MSJ4BT4Z002HH9B grep guard forbids a
// relative `icons.js` import; `@worklog/shared/icons` is the canonical path
// even from within the shared package).
import type { AuditInvalidationVerdict } from '@worklog/shared/icons';
import {
  EdgeCache,
  generateId,
  generateCommentId,
  getPrefix,
  setPrefix,
  laterTimestamp,
  buildEdgeCache as _buildEdgeCache,
  UpdateIfMatchesResult,
} from './database/context.js';
// `wl next` selection modules — thin-delegate targets (WL-0MVOBP0U5007BAZD).
// Method implementations moved here; the class members below delegate.
import {
  riskOrdinal,
  effortOrdinal,
  matchesRiskEffort,
  getPriorityValue,
  computeEffectivePriority,
} from './database/priority.js';
import {
  findNextWorkItem,
  findNextWorkItemFromItems,
  findNextWorkItems,
  applyFilters,
  filterCandidates,
  resolveBlockerToRoot,
  selectHighestPriorityBlocking,
} from './database/next-pipeline.js';
import { handleCriticalEscalation } from './database/critical-escalation.js';
// Sort-index and audit modules — thin-delegate targets (WL-0MVOBP2Q2002ZYCF).
// Method implementations moved here; the class members below delegate.
import * as auditModule from './database/audit.js';
import * as sortModule from './database/sort.js';
// Work-item and hierarchy modules — thin-delegate targets (WL-0MVOBP4J6003ZKML).
// Method implementations moved here; the class members below delegate.
import * as workItemsModule from './database/work-items.js';
import * as hierarchyModule from './database/hierarchy.js';

export { normalizeTitleForMatch, UpdateIfMatchesResult } from './database/context.js';

// ── Injectable service types ────────────────────────────────────────────

/**
 * JSONL import result shape.
 */
export interface JsonlImportResult {
  items: WorkItem[];
  comments: Comment[];
  dependencyEdges: DependencyEdge[];
  auditResults: AuditResult[];
  /** Sync header kind when the file starts with a sync header (incremental sync). */
  kind?: 'full' | 'delta';
}

/**
 * Git sync target.
 */
export interface GitTarget {
  remote: string;
  branch: string;
}

/**
 * Open-mode options for {@link WorklogDatabase} (F6 — WL-0MVJV2PX4005JH8D).
 *
 * `readOnly` opens the SQLite store with SQLite's READONLY flag and skips all
 * schema/FTS DDL when the store is already initialised. It is the cheapest
 * safe handle for a reader that must never write (the Herdr refresh scope):
 * the ~46–70 ms cold open cost (schema DDL, additive-column probes, FTS
 * probe) becomes a few-ms pragma-only open on an already-initialised store,
 * and a write attempt fails instead of mutating the store.
 */
export interface WorklogDatabaseOptions {
  /** Open the store read-only and skip DDL when the schema is present. */
  readOnly?: boolean;
}

/**
 * Optional CLI-specific services injected into WorklogDatabase.
 * When not provided, features that depend on them become no-ops or throw
 * appropriate errors. This allows the class to be used in contexts (like the
 * TUI extension) where only core CRUD operations are needed.
 */
export interface WorklogDatabaseServices {
  /** JSONL import/export functions (needed for JSONL sync, exports) */
  jsonl?: {
    importFromJsonl: (path: string) => JsonlImportResult;
    importFromJsonlContent: (content: string) => JsonlImportResult;
    exportToJsonlAsync: (items: WorkItem[], comments: Comment[], path: string, deps: DependencyEdge[], audits: AuditResult[], options?: any) => Promise<number>;
    getDefaultDataPath: () => string;
  };

  /** Git sync operations */
  sync?: {
    mergeWorkItems: (local: WorkItem[], remote: WorkItem[]) => any;
    mergeComments: (local: Comment[], remote: Comment[]) => any;
    mergeAuditResults: (local: AuditResult[], remote: AuditResult[]) => any;
    getRemoteDataFileContent: (jsonlPath: string, target: GitTarget) => Promise<string | null>;
  };

  /** File-locking utilities */
  fileLock?: {
    withFileLock: (lockPath: string, fn: () => Promise<any>) => Promise<any>;
    getLockPathForJsonl: (jsonlPath: string) => string;
  };

  /** Search metrics (no-ops when omitted) */
  searchMetrics?: {
    increment: (key: string) => void;
  };

  /** Background task runtime */
  runtime?: {
    getRuntime: () => { launchTask: (name: string, fn: () => Promise<void>) => void };
  };

  /** Semantic search module */
  search?: {
    getDefaultEmbedder: () => any;
    getEmbeddingStorePath: (worklogDir: string) => string;
    EmbeddingStore: new (storePath: string) => any;
    createSearch: (store: any, embedder: any) => any;
    WorklogSearch: any;
  };

  /** Persistent store services (migration list, etc.) */
  persistentStoreServices?: PersistentStoreServices;

  /** Optional cache configuration for SqlitePersistentStore (Phase 5) */
  cacheOptions?: PersistentStoreCacheOptions;
}

// ── Pre-loaded cache types for wl next pipeline ─────────────────────────

/**
 * Pre-loaded cache of dependency edges and work items to eliminate N+1 queries
 * during the wl next selection pipeline.
 */
// normalizeTitleForMatch is re-exported at the top of this file.

export class WorklogDatabase {
  private store: SqlitePersistentStore;
  private jsonlPath: string;
  private silent: boolean;
  private autoSync: boolean;
  private syncProvider?: () => Promise<void>;
  private lockPath: string;
  private _semanticSearch: any | null = null;
  private services: WorklogDatabaseServices;
  /** Shared context built once in the constructor. */
  private ctx!: import('./database/context.js').WorklogDatabaseContext;

  constructor(
    prefix: string = 'WI',
    dbPath?: string,
    jsonlPath?: string,
    silent: boolean = false,
    autoSync: boolean = false,
    syncProvider?: () => Promise<void>,
    services?: WorklogDatabaseServices,
    options: WorklogDatabaseOptions = {}
  ) {
    this.services = services ?? {};
    this.jsonlPath = jsonlPath || (this.services.jsonl?.getDefaultDataPath?.() ?? '.worklog/data.jsonl');
    this.silent = silent;
    this.autoSync = autoSync;
    this.syncProvider = syncProvider;
    this.lockPath = (this.services.fileLock?.getLockPathForJsonl?.(this.jsonlPath) ?? path.join(path.dirname(this.jsonlPath), '.lock'));
    
    // Use default DB path if not provided
    const defaultDbPath = path.join(path.dirname(this.jsonlPath), 'worklog.db');
    const actualDbPath = dbPath || defaultDbPath;
    
    this.store = new SqlitePersistentStore(
      actualDbPath,
      !silent,
      this.services.persistentStoreServices,
      this.services.cacheOptions,
      { readOnly: options.readOnly === true },
    );
    
    // Build shared context after the store is initialised (helpers need store access).
    this.ctx = {
      store: this.store,
      prefix,
      services: this.services,
      silent,
      _lastIdTime: 0,
      _idSequence: 0,
      hooks: {
        debug: (message) => this.debug(message),
        getNonClosedChildren: (parentId, edgeCache) => this.getNonClosedChildren(parentId, edgeCache),
        getActiveDependencyBlockers: (itemId, edgeCache) => this.getActiveDependencyBlockers(itemId, edgeCache),
        isInProgressSubtree: (item, allItems) => this.isInProgressSubtree(item, allItems),
        isDependencyActive: (target) => this.isDependencyActive(target),
        getDescendants: (parentId) => this.getDescendants(parentId),
        orderBySortIndex: (items, sortOrderCache) => this.orderBySortIndex(items, sortOrderCache),
        selectBySortIndex: (items, effectivePriorityCache, sortOrderCache, edgeCache, allItems) =>
          this.selectBySortIndex(items, effectivePriorityCache, sortOrderCache, edgeCache, allItems),
        applyFilters: (items, assignee, searchTerm) => this.applyFilters(items, assignee, searchTerm),
        resolveBlockerToRoot: (blocker, allItems, assignee, searchTerm, excluded) =>
          this.resolveBlockerToRoot(blocker, allItems, assignee, searchTerm, excluded),
        selectHighestPriorityBlocking: (pairs, sortOrderCache) =>
          this.selectHighestPriorityBlocking(pairs, sortOrderCache),
      },
      writeHooks: {
        triggerAutoSync: () => this.triggerAutoSync(),
      },
      itemHooks: {
        orderBySortIndex: (items, sortOrderCache) => this.orderBySortIndex(items, sortOrderCache),
        getDescendants: (parentId) => this.getDescendants(parentId),
        getDepth: (itemId) => this.getDepth(itemId),
        triggerSemanticIndex: (item) => this.triggerSemanticIndex(item),
        removeFromSemanticIndex: (itemId) => this.removeFromSemanticIndex(itemId),
        reconcileDependentStatus: (itemId) => this.reconcileDependentStatus(itemId),
        listDependencyEdgesTo: (toId) => this.listDependencyEdgesTo(toId),
        reconcileDependentsForTarget: (targetId) => this.reconcileDependentsForTarget(targetId),
      },
    };
    
    // Refresh from JSONL only if SQLite is empty (ephemeral JSONL pattern)
    // In the ephemeral pattern, SQLite is the sole runtime source of truth.
    // JSONL only exists transiently during sync operations.
    // A read-only handle must NEVER write, so the JSONL refresh (an import
    // into SQLite) is skipped for it (F6): the store is opened as-is.
    const itemCount = this.store.countWorkItems();
    if (itemCount === 0 && options.readOnly !== true) {
      this.refreshFromJsonlIfNewer();
    }
  }

  setAutoSync(enabled: boolean, provider?: () => Promise<void>): void {
    this.autoSync = enabled;
    if (provider) {
      this.syncProvider = provider;
    }
  }

  triggerAutoSync(): void {
    if (!this.autoSync || !this.syncProvider) {
      return;
    }
    void this.syncProvider();
  }

  /**
   * Get or lazily create a WorklogSearch instance for semantic indexing.
   *
   * Returns null when the embedder is not available (no OPENAI_API_KEY set),
   * so callers can skip indexing gracefully.
   */
  private getOrCreateSearch(): any | null {
    if (this._semanticSearch) return this._semanticSearch;

    const searchSvc = this.services.search;
    if (!searchSvc) return null;

    const embedder = searchSvc.getDefaultEmbedder();
    if (!embedder.available) return null;

    const worklogDir = path.dirname(this.jsonlPath);
    const storePath = searchSvc.getEmbeddingStorePath(worklogDir);
    const store = new searchSvc.EmbeddingStore(storePath);
    this._semanticSearch = searchSvc.createSearch(store, embedder);
    return this._semanticSearch;
  }

  /**
   * Index a single work item for semantic search in the background.
   * No-op when no embedder is configured.
   */
  private triggerSemanticIndex(item: WorkItem): void {
    const search = this.getOrCreateSearch();
    if (!search) return;

    // Get comments for this item (needed for content hash)
    const comments = this.store.getCommentsForWorkItem(item.id);
    const commentText = comments.map(c => c.comment).join('\n');

    // Launch as a background task so create/update is not blocked
    const runtime = this.services.runtime?.getRuntime?.();
    if (!runtime) return;
    runtime.launchTask(`semantic-index-${item.id}`, async () => {
      await search.indexWorkItem(
        {
          title: item.title ?? '',
          description: item.description ?? '',
          tags: item.tags ?? [],
          comments: commentText,
        },
        item.id,
      );
    });
  }

  /**
   * Remove a work item from the semantic search index.
   * No-op when no embedder is configured.
   */
  private removeFromSemanticIndex(itemId: string): void {
    const search = this.getOrCreateSearch();
    if (!search) return;
    search.removeWorkItem(itemId);
  }

  /**
   * Refresh database from Git remote.
   * This implements the ephemeral JSONL pattern where:
   * 1. Pull JSONL from Git remote
   * 2. Merge with local SQLite data
   * 3. Delete local JSONL file
   * 
   * @param target Git target (remote and branch)
   * @returns Object with success flag, counts of items added/updated, and any error message
   */
  async refreshFromGit(target: GitTarget): Promise<{ 
    success: boolean; 
    itemsAdded: number;
    itemsUpdated: number;
    commentsAdded: number;
    error?: string;
  }> {
    const syncSvc = this.services.sync;
    const jsonlSvc = this.services.jsonl;
    if (!syncSvc || !jsonlSvc) {
      return { success: false, itemsAdded: 0, itemsUpdated: 0, commentsAdded: 0, error: 'Sync services not provided to WorklogDatabase' };
    }

    try {
      // Fetch remote content
      const remoteContent = await syncSvc.getRemoteDataFileContent(this.jsonlPath, target);
      
      if (!remoteContent) {
        // No remote data yet (first sync) - this is OK
        return { success: true, itemsAdded: 0, itemsUpdated: 0, commentsAdded: 0 };
      }

      // Parse remote data
      const { items: remoteItems, comments: remoteComments, dependencyEdges, auditResults: remoteAudits } = jsonlSvc.importFromJsonlContent(remoteContent);
      
      // Get local state
      const localItems = this.store.getAllWorkItems();
      const localComments = this.store.getAllComments();
      const localEdges = this.store.getAllDependencyEdges();
      const localAudits = this.store.getAllAuditResults();

      // Merge data
      const itemMergeResult = syncSvc.mergeWorkItems(localItems, remoteItems);
      const commentMergeResult = syncSvc.mergeComments(localComments, remoteComments);
      const auditMergeResult = syncSvc.mergeAuditResults(localAudits, remoteAudits);
      
      // Calculate changes
      const itemsAdded = Math.max(0, itemMergeResult.merged.length - localItems.length);
      const itemsUpdated = itemMergeResult.conflicts.length;
      const commentsAdded = Math.max(0, commentMergeResult.merged.length - localComments.length);

      // Import merged data to SQLite
      this.store.importData(itemMergeResult.merged, commentMergeResult.merged);
      
      // Import dependency edges
      for (const edge of dependencyEdges) {
        if (this.store.getWorkItem(edge.fromId) && this.store.getWorkItem(edge.toId)) {
          this.store.saveDependencyEdge(edge);
        }
      }
      
      // Import audit results
      if (auditMergeResult.merged.length > 0) {
        this.store.saveAuditResults(auditMergeResult.merged);
      }

      // Update metadata to prevent re-import of the same data
      const now = Date.now();
      this.store.setMetadata('lastJsonlImportMtime', now.toString());
      this.store.setMetadata('lastJsonlImportAt', new Date().toISOString());

      // Delete local JSONL file (ephemeral pattern)
      if (fs.existsSync(this.jsonlPath)) {
        fs.unlinkSync(this.jsonlPath);
      }

      return { 
        success: true, 
        itemsAdded, 
        itemsUpdated, 
        commentsAdded 
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Check for offline/network errors
      if (errorMessage.includes('Could not resolve host') || 
          errorMessage.includes('Network is unreachable') ||
          errorMessage.includes('Connection refused') ||
          errorMessage.includes('timeout')) {
        return { 
          success: false, 
          itemsAdded: 0, 
          itemsUpdated: 0, 
          commentsAdded: 0,
          error: 'Offline: Unable to reach Git remote. Please check your network connection.'
        };
      }
      
      // Check for merge conflicts
      if (errorMessage.includes('CONFLICT') || errorMessage.includes('merge conflict')) {
        return { 
          success: false, 
          itemsAdded: 0, 
          itemsUpdated: 0, 
          commentsAdded: 0,
          error: 'Merge conflict detected. Please resolve conflicts manually before syncing.'
        };
      }
      
      return { 
        success: false, 
        itemsAdded: 0, 
        itemsUpdated: 0, 
        commentsAdded: 0,
        error: errorMessage
      };
    }
  }

  /**
   * Export current database state to JSONL for sync operations.
   * This is used by the sync command before pushing to Git.
   * The JSONL file should be deleted after successful push (ephemeral pattern).
   *
   * Delta-aware export (WL-0MT2KXPOQ009G026 / WL-0MSAKUBKW006FN8Q):
   *
   * - `options.mode: 'full'` (default) — export ALL records.
   * - `options.mode: 'delta'` — export only records changed after the
   *   per-type watermarks. If `options.since` is provided it is used as the
   *   watermark set; otherwise the stored watermarks
   *   (`getLastExportTimestamps()`) are read automatically. When a type has no
   *   watermark (no baseline), ALL records of that type are exported for that
   *   type (full baseline per type). When NO watermarks exist at all, the
   *   delta degrades to a full export (the design's "no-baseline → full
   *   export" rule), because a delta with empty watermarks would be empty
   *   and lose data on the push side.
   *
   * Exporting NEVER auto-advances the watermarks in any mode — the push path
   * advances them only AFTER a successful push (markLastExportTimestamps,
   * WL-0MT2KY0RQ008F50Q AC5). A failed push must not advance the baseline
   * past data that was never published.
   *
   * @returns The path to the exported JSONL file
   */
  async exportForSync(options?: any): Promise<string> {
    const jsonlSvc = this.services.jsonl;
    if (!jsonlSvc) {
      throw new Error('jsonl services not provided to WorklogDatabase — cannot export for sync');
    }

    const mode: 'full' | 'delta' =
      options?.mode === 'delta' && process.env.WL_DELTA_EXPORT_DISABLED !== '1' ? 'delta' : 'full';

    // In delta mode resolve the per-type watermarks: explicit `since` wins,
    // otherwise read the stored watermarks (no baseline → full fallback).
    let since: LastExportTimestamps | undefined;
    if (mode === 'delta') {
      const candidate = options?.since ?? this.getLastExportTimestamps();
      const hasAnyWatermark = Boolean(candidate.workitems || candidate.comments || candidate.edges || candidate.audit_results);
      if (hasAnyWatermark) {
        since = candidate;
      }
      // No baseline at all — a delta would export nothing. Fall back to full
      // so the remote always receives a complete snapshot on first sync.
    }

    // Capture the resolved watermarks so the filter callbacks close over a
    // definite value (narrowing does not survive into the closures).
    const wItems = since?.workitems;
    const wComments = since?.comments;
    const wEdges = since?.edges;
    const wAudits = since?.audit_results;

    const items = wItems
      ? this.store.getAllWorkItems().filter(i => i.updatedAt && new Date(i.updatedAt).getTime() > new Date(wItems).getTime())
      : this.store.getAllWorkItems();
    const comments = wComments
      ? this.store.getAllComments().filter(c => c.createdAt && new Date(c.createdAt).getTime() > new Date(wComments).getTime())
      : this.store.getAllComments();
    const dependencyEdges = wEdges
      ? this.store.getAllDependencyEdges().filter(e => e.createdAt && new Date(e.createdAt).getTime() > new Date(wEdges).getTime())
      : this.store.getAllDependencyEdges();
    const auditResults = wAudits
      ? this.store.getAllAuditResults().filter(a => a.auditedAt && new Date(a.auditedAt).getTime() > new Date(wAudits).getTime())
      : this.store.getAllAuditResults();

    // Export to JSONL — the `kind` is surfaced to the JSONL writer so the
    // output carries a sync header distinguishing full vs delta
    // (WL-0MT2KXPOQ009G026).
    await jsonlSvc.exportToJsonlAsync(items, comments, this.jsonlPath, dependencyEdges, auditResults, { onProgress: options?.onProgress, kind: mode });

    // Watermark advancement is deliberately NOT performed here in any mode:
    // the push path advances them only AFTER a successful push
    // (markLastExportTimestamps, WL-0MT2KY0RQ008F50Q AC5). A failed push must
    // not advance the baseline past data that was never published.

    return this.jsonlPath;
  }

  /**
   * Read the per-record-type last-export watermarks used by delta sync
   * (WL-0MT2KWFUJ001OGHF). If none have ever been recorded, returns an empty
   * object — callers treat that as "no baseline → full export".
   */
  getLastExportTimestamps(): LastExportTimestamps {
    return this.store.getLastExportTimestamps();
  }

  /**
   * Advance the per-record-type last-export watermarks (after a successful
   * delta push, or a whole-store import that publishes all records). Only the
   * provided types are updated; others are left untouched.
   */
  markLastExportTimestamps(ts: LastExportTimestamps): void {
    this.store.setLastExportTimestamps(ts);
  }

  /**
   * Total number of dirty records across all four types given the stored
   * per-type watermarks (WL-0MT2KY0RQ008F50Q / WL-0MSAKUBKW006FN8Q §5.4
   * zero-change fast path). A record is dirty when its timestamp is strictly
   * greater than the watermark of its type. When a type has no watermark (no
   * baseline), every record of that type counts as dirty, and when NO
   * watermarks exist at all the store is treated as fully dirty (this is what
   * makes the very first sync a full export).
   */
  countDirtyRecords(): { items: number; comments: number; edges: number; audits: number; total: number } {
    const wm = this.getLastExportTimestamps();
    const wItems = wm.workitems;
    const wComments = wm.comments;
    const wEdges = wm.edges;
    const wAudits = wm.audit_results;

    const items = wItems
      ? this.store.getAllWorkItems().filter(i => i.updatedAt && new Date(i.updatedAt).getTime() > new Date(wItems).getTime()).length
      : this.store.getAllWorkItems().length;
    const comments = wComments
      ? this.store.getAllComments().filter(c => c.createdAt && new Date(c.createdAt).getTime() > new Date(wComments).getTime()).length
      : this.store.getAllComments().length;
    const edges = wEdges
      ? this.store.getAllDependencyEdges().filter(e => e.createdAt && new Date(e.createdAt).getTime() > new Date(wEdges).getTime()).length
      : this.store.getAllDependencyEdges().length;
    const audits = wAudits
      ? this.store.getAllAuditResults().filter(a => a.auditedAt && new Date(a.auditedAt).getTime() > new Date(wAudits).getTime()).length
      : this.store.getAllAuditResults().length;

    return { items, comments, edges, audits, total: items + comments + edges + audits };
  }

  /**
   * Read the delta-sync cadence metadata (WL-0MT2KY0RQ008F50Q §5.3): the
   * number of consecutive delta syncs since the last full snapshot, and the
   * accumulated JSONL bytes pushed in that window. Used to decide when the
   * next full snapshot is due (defaults: every 10 delta syncs OR 1 MB).
   */
  getDeltaSyncMetadata(): { deltaSyncCount: number; deltaBytes: number } {
    return this.store.getDeltaSyncMetadata();
  }

  /**
   * Persist the delta-sync cadence metadata ({@link getDeltaSyncMetadata}).
   */
  setDeltaSyncMetadata(deltaSyncCount: number, deltaBytes: number): void {
    this.store.setDeltaSyncMetadata(deltaSyncCount, deltaBytes);
  }

  /**
   * Delete the local JSONL file.
   * This should be called after successful Git push (ephemeral pattern).
   */
  deleteLocalJsonl(): void {
    if (fs.existsSync(this.jsonlPath)) {
      fs.unlinkSync(this.jsonlPath);
    }
  }

  /**
   * Refresh database from JSONL file if JSONL is newer.
   *
   * This method is intentionally **lockless** — it does not acquire the
   * exclusive file lock.  Because `exportToJsonl()` (in jsonl.ts) already
   * uses atomic write (temp-file + `renameSync`), readers will always see
   * either the old complete file or the new complete file, never a partial
   * write.  Removing the lock from this read path eliminates the contention
   * that previously caused lock timeout errors during concurrent
   * usage by agents and developers.
   *
   * If the JSONL file is transiently unavailable or corrupted (e.g. during
   * an atomic rename race on some filesystems), the method falls back to
   * the existing SQLite cache — see the try-catch around `importFromJsonl`.
   */
  private refreshFromJsonlIfNewer(): void {
    if (!fs.existsSync(this.jsonlPath)) {
      return; // No JSONL file, nothing to refresh from
    }

    try {
      const jsonlStats = fs.statSync(this.jsonlPath);
      // Use Math.floor to match the precision of stored mtime (which is stored via Math.floor().toString())
      const jsonlMtime = Math.floor(jsonlStats.mtimeMs);

      const metadata = this.store.getAllMetadata();
      const lastImportMtime = metadata.lastJsonlImportMtime;
      const lastExportMtimeStr = this.store.getMetadata('lastJsonlExportMtime');
      const lastExportMtime = lastExportMtimeStr ? Number(lastExportMtimeStr) : undefined;

      // If DB is empty or JSONL is newer, refresh from JSONL
      const itemCount = this.store.countWorkItems();
      // Avoid re-importing a file we just exported ourselves. If the JSONL mtime equals the
      // last export mtime recorded in the DB, skip the refresh. Otherwise fall back to the
      // previous logic (DB empty or JSONL newer than last import).
      const isOurExport = lastExportMtime !== undefined && Math.abs(jsonlMtime - lastExportMtime) < 1;
      const shouldRefresh = !isOurExport && (itemCount === 0 || !lastImportMtime || jsonlMtime > lastImportMtime);

      if (shouldRefresh) {
        if (!this.silent) {
          // Debug: send to stderr so JSON stdout is preserved for --json mode
          this.debug(`Refreshing database from ${this.jsonlPath}...`);
        }
        const jsonlResult = this.services.jsonl?.importFromJsonl?.(this.jsonlPath) ?? { items: [], comments: [], dependencyEdges: [], auditResults: [] };
        const { items: jsonlItems, comments: jsonlComments, dependencyEdges, auditResults: jsonlAuditResults } = jsonlResult;
        this.store.importData(jsonlItems, jsonlComments);
        for (const edge of dependencyEdges) {
          if (this.store.getWorkItem(edge.fromId) && this.store.getWorkItem(edge.toId)) {
            this.store.saveDependencyEdge(edge);
          }
        }

        // Import audit results (they are included in JSONL but must be explicitly upserted)
        if (jsonlAuditResults.length > 0) {
          this.store.saveAuditResults(jsonlAuditResults);
        }

        // Update metadata
        // Use Math.floor to match the precision of parseInt when reading back
        this.store.setMetadata('lastJsonlImportMtime', Math.floor(jsonlMtime).toString());
        this.store.setMetadata('lastJsonlImportAt', new Date().toISOString());

        if (!this.silent) {
          this.debug(`Loaded ${jsonlItems.length} work items, ${jsonlComments.length} comments, and ${jsonlAuditResults.length} audit results from JSONL`);
        }
      }
    } catch (error) {
      // Graceful fallback: if the JSONL file is transiently unavailable,
      // corrupted, or deleted between our existsSync check and the read,
      // silently fall back to the existing SQLite cache.  This is safe
      // because stale reads are acceptable for all read-only commands.
      if (process.env.WL_DEBUG) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[wl:db] JSONL parse failed, using cached data: ${message}\n`);
      }
    }
  }

  private debug(message: string): void {
    if (this.silent) return;
    console.error(message);
  }

  /**
   * Fold a stored audit set and an incoming audit set into one entry per work
   * item, keeping the newest audit by `auditedAt` (stored wins exact ties).
   *
   * Used by the destructive {@link import} path so a stale snapshot can never
   * downgrade a newer stored audit (SA-0MUJNFF3K009BF03). Delegates to the
   * injected sync merge when present, so this path shares the exact
   * last-write-wins semantics as `wl sync`; otherwise the same rule is applied
   * inline.
   */
  private mergeAuditsNewestWins(stored: AuditResult[], incoming: AuditResult[]): AuditResult[] {
    const syncSvc = this.services.sync;
    if (syncSvc?.mergeAuditResults) {
      return syncSvc.mergeAuditResults(stored, incoming).merged as AuditResult[];
    }

    const byId = new Map<string, AuditResult>();
    for (const audit of stored) byId.set(audit.workItemId, audit);

    const timeOf = (audit: AuditResult): number | null => {
      const ms = typeof audit.auditedAt === 'string' ? Date.parse(audit.auditedAt) : NaN;
      return Number.isFinite(ms) ? ms : null;
    };

    for (const audit of incoming) {
      const current = byId.get(audit.workItemId);
      if (!current) {
        byId.set(audit.workItemId, audit);
        continue;
      }
      const incomingMs = timeOf(audit);
      const currentMs = timeOf(current);
      if (incomingMs !== null && currentMs !== null && incomingMs > currentMs) {
        byId.set(audit.workItemId, audit);
      }
    }

    return Array.from(byId.values());
  }

  /** Delegates to {@link sortItemsByScore} in `./database/sort.js`. */
  private sortItemsByScore(items: WorkItem[], recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore', edgeCache?: EdgeCache): WorkItem[] {
    return sortModule.sortItemsByScore(this.ctx, items, recencyPolicy, edgeCache);
  }

  /** Delegates to {@link computeScore} in `./database/sort.js`. */
  private computeScore(
    item: WorkItem,
    now: number,
    recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore',
    ancestorsOfInProgress?: Set<string>,
    edgeCache?: EdgeCache,
    auditMap?: Map<string, AuditResult>
  ): number {
    return sortModule.computeScore(this.ctx, item, now, recencyPolicy, ancestorsOfInProgress, edgeCache, auditMap);
  }

  /** Delegates to {@link compareAuditNotReadyTier} in `./database/sort.js`. */
  private compareAuditNotReadyTier(
    a: WorkItem,
    b: WorkItem,
    auditMap: Map<string, AuditResult>,
    maxPriorityValue: number
  ): number {
    return sortModule.compareAuditNotReadyTier(a, b, auditMap, maxPriorityValue);
  }

  /** Delegates to {@link computeSortIndexOrder} in `./database/sort.js`. */
  private computeSortIndexOrder(): WorkItem[] {
    return sortModule.computeSortIndexOrder(this.ctx);
  }

  /** Delegates to {@link isAuditNotReadyFresh} in `./database/audit.js`. */
  private isAuditNotReadyFresh(audit: AuditResult | null | undefined, itemUpdatedAt: string | undefined): boolean {
    return auditModule.isAuditNotReadyFresh(audit, itemUpdatedAt);
  }

  /** Delegates to {@link buildAuditMapForItems} in `./database/audit.js`. */
  private buildAuditMapForItems(items: WorkItem[]): Map<string, AuditResult> {
    return auditModule.buildAuditMapForItems(this.ctx, items);
  }

  assignSortIndexValues(gap: number): { updated: number } {
    return sortModule.assignSortIndexValues(this.ctx, this.ctx.writeHooks, gap);
  }

  /**
   * Re-sort all active (non-completed, non-deleted) work items by score and
   * reassign their sortIndex values.  This is the same logic used by `wl re-sort`
   * and is called automatically by `wl next` unless `--no-re-sort` is passed.
   *
   * @param recencyPolicy - How to weight recency in the score calculation
   * @param gap - Gap between consecutive sortIndex values (default 100)
   * @returns The number of items whose sortIndex was updated
   */
  reSort(
    recencyPolicy: 'prefer' | 'avoid' | 'ignore' = 'ignore',
    gap: number = 100
  ): { updated: number } {
    return sortModule.reSort(this.ctx, this.ctx.writeHooks, recencyPolicy, gap);
  }

  assignSortIndexValuesForItems(orderedItems: WorkItem[], gap: number): { updated: number } {
    return sortModule.assignSortIndexValuesForItems(this.ctx, this.ctx.writeHooks, orderedItems, gap);
  }

  previewSortIndexOrder(gap: number): Array<{ id: string; sortIndex: number } & WorkItem> {
    return sortModule.previewSortIndexOrder(this.ctx, gap);
  }

  previewSortIndexOrderForItems(items: WorkItem[], gap: number): Array<{ id: string; sortIndex: number } & WorkItem> {
    return sortModule.previewSortIndexOrderForItems(items, gap);
  }

  // ── Full-Text Search ──────────────────────────────────────────────

  /**
   * Whether FTS5 full-text search is available in the underlying SQLite build
   */
  get ftsAvailable(): boolean {
    return this.store.ftsAvailable;
  }

  /**
   * Search work items using full-text search (FTS5) with automatic fallback
   * to application-level search when FTS5 is unavailable.
   *
   * ID-aware behaviour:
   *  1. Exact-ID short-circuit: if a token matches a work item ID exactly
   *     (case-insensitive, with or without the project prefix), the matching
   *     item is returned first with rank = -Infinity.
   *  2. Prefix resolution: bare tokens that look like IDs (alphanumeric,
   *     length >= 8) are tried with the repository's configured prefix.
   *  3. Partial-ID substring: tokens of length >= 8 that are not an exact
   *     match are used for substring matching against all work item IDs.
   *  4. Multi-token queries: each token is checked for ID-likeness; exact
   *     matches come first, then regular FTS/fallback results on the full
   *     original query (duplicates removed).
   */
  search(
    query: string,
    options?: {
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
    }
  ): { results: FtsSearchResult[]; ftsUsed: boolean; warning?: string } {
    this.services.searchMetrics?.increment?.('search.total');
    const idResults: FtsSearchResult[] = [];
    const seenIds = new Set<string>();

    const tokens = query.trim().split(/\s+/).filter(t => t.length > 0);
    const prefix = this.getPrefix();

    for (const token of tokens) {
      const upper = token.toUpperCase();

      // --- Exact-ID check (with prefix already present) ---
      if (upper.includes('-')) {
        const item = this.store.getWorkItem(upper);
        if (item && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          idResults.push({
            itemId: item.id,
            rank: -Infinity,
            snippet: item.title,
            matchedColumn: 'id',
          });
          this.services.searchMetrics?.increment?.('search.exact_id');
          continue;
        }
      }

      // --- Prefix resolution: bare token → PREFIX-TOKEN ---
      if (!upper.includes('-') && /^[A-Z0-9]+$/.test(upper) && upper.length >= 8) {
        const prefixed = `${prefix}-${upper}`;
        const item = this.store.getWorkItem(prefixed);
        if (item && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          idResults.push({
            itemId: item.id,
            rank: -Infinity,
            snippet: item.title,
            matchedColumn: 'id',
          });
          this.services.searchMetrics?.increment?.('search.prefix_resolved');
          continue;
        }
      }

      // --- Partial-ID substring match (>= 8 chars) ---
      // Use the original token (with dashes) for substring search so that
      // prefixed partial IDs like "WL-0MLZVROU" match "WL-0MLZVROU315KLUQX".
      // Also try the cleaned (dash-free) form for bare alphanumeric tokens.
      const cleaned = upper.replace(/[^A-Z0-9]/g, '');
      if (cleaned.length >= 8) {
        const candidates = upper.includes('-') ? [upper, cleaned] : [cleaned];
        for (const substr of candidates) {
          const partials = this.store.findByIdSubstring(substr);
          for (const p of partials) {
            if (!seenIds.has(p.id)) {
              seenIds.add(p.id);
              idResults.push({
                itemId: p.id,
                rank: -1000,
                snippet: p.title,
                matchedColumn: 'id',
              });
              this.services.searchMetrics?.increment?.('search.partial_id');
            }
          }
        }
      }
    }

    // --- Regular FTS / fallback search ---
    let ftsUsed = false;
    let ftsResults: FtsSearchResult[] = [];
    let warning: string | undefined;

    if (this.store.ftsAvailable) {
      try {
        ftsResults = this.store.searchFts(query, options);
        ftsUsed = true;
        this.services.searchMetrics?.increment?.('search.fts');
      } catch (err) {
        // The raw query tripped the FTS5 parser (e.g. an unquoted punctuated
        // term like `v0.1.11` or a file path). Retry as a quoted phrase so
        // users searching for version strings / paths still get results, and
        // signal the auto-quote with a warning so it is never silent.
        const message = err instanceof Error ? err.message : String(err);
        const escaped = query.replace(/\\"/g, '').replace(/"/g, '""');
        let quotedResults: FtsSearchResult[];
        try {
          quotedResults = this.store.searchFts(`"${escaped}"`, options);
        } catch (err2) {
          // Auto-quoting also failed — surface a hard, distinguishable error
          // so the user knows the query is invalid (never a silent empty list).
          const inner = err2 instanceof Error ? err2.message : String(err2);
          throw new Error(
            `invalid query syntax: "${query}" — quote phrases or punctuated terms. ${inner}`
          );
        }
        ftsResults = quotedResults;
        ftsUsed = true;
        this.services.searchMetrics?.increment?.('search.fts');
        warning = `query "${query}" was auto-quoted as a phrase because it is not valid FTS5 syntax: ${message}`;
      }
    } else {
      if (!this.silent) {
        this.debug('FTS5 is not available; falling back to application-level search');
      }
      ftsResults = this.store.searchFallback(query, options);
      this.services.searchMetrics?.increment?.('search.fallback');
    }

    // --- Merge: ID results first, then FTS results (deduped) ---
    const merged: FtsSearchResult[] = [...idResults];
    for (const r of ftsResults) {
      if (!seenIds.has(r.itemId)) {
        seenIds.add(r.itemId);
        merged.push(r);
      }
    }

    return { results: merged, ftsUsed, warning };
  }

  /**
   * Rebuild the FTS index from scratch. Useful for backfill or recovery.
   */
  rebuildFtsIndex(): { indexed: number } {
    return this.store.rebuildFtsIndex();
  }

  /**
   * Close the underlying database connection.
   * Must be called before removing temp directories on Windows
   * to release file locks.
   */
  close(): void {
    this.store.close();
  }

  /**
   * Build an EdgeCache from all dependency edges and work items.
   * Eliminates N+1 query patterns by loading all edges and items once
   * into in-memory Maps for O(1) lookups during computeScore() and
   * filterCandidates().
   *
   * @param items - Optional pre-loaded work items to avoid double-loading
   */
  private buildEdgeCache(items?: WorkItem[]): EdgeCache {
    return _buildEdgeCache(this.ctx, items);
  }

  // ── Audit Results ────────────────────────────────────────────────

  /**
   * Save or update an audit result for a work item (upsert).
   * Only the latest audit per work item is kept.
   */
  saveAuditResult(audit: { workItemId: string; readyToClose: boolean; auditedAt: string; summary: string | null; rawOutput: string | null; author: string | null; fingerprint?: string | null }): void {
    auditModule.saveAuditResult(this.ctx, audit);
  }

  /**
   * Decide whether a stored audit is fresh, should be re-instated, or must be
   * re-run — and automatically re-instate it when the only change since the
   * audit was non-semantic (WL-0MU1EWMHN000YUCG).
   *
   * Delegates to {@link SqlitePersistentStore.reconcileAuditInvalidation}, so
   * the automatic `updatedAt = auditedAt` reset and the decision live in the
   * store. Callers that can compute the item's current content fingerprint
   * pass it in; callers without git access omit it and get a fail-safe
   * `re-audit` verdict for any timestamp-stale audit.
   *
   * @param workItemId The work item whose audit is being reconciled.
   * @param currentFingerprint The item's current content fingerprint, when known.
   * @returns The invalidation verdict (`fresh` | `reinstate` | `re-audit`).
   */
  reconcileAuditInvalidation(
    workItemId: string,
    currentFingerprint?: string | null,
  ): AuditInvalidationVerdict {
    return auditModule.reconcileAuditInvalidation(this.ctx, workItemId, currentFingerprint);
  }

  /**
   * Get the audit result for a work item.
   * Returns null if no audit result exists.
   */
  getAuditResult(workItemId: string): { workItemId: string; readyToClose: boolean; auditedAt: string; summary: string | null; rawOutput: string | null; author: string | null; fingerprint: string | null } | null {
    return auditModule.getAuditResult(this.ctx, workItemId);
  }

  /**
   * Delete the audit result for a work item.
   */
  deleteAuditResult(workItemId: string): boolean {
    return auditModule.deleteAuditResult(this.ctx, workItemId);
  }

  /**
   * Record an explicit, durable audit-gap waiver on a work item
   * (WL-0MUBVH9FV0027COG).
   *
   * The waiver is persisted in the nullable `workitems.auditWaiver` JSON
   * column, surfaced by `wl show --json`, and round-trips through JSONL sync.
   * `updatedAt` is bumped so delta sync exports the change; a waiver is an
   * audit-relevant state change, so a previously fresh audit becomes stale —
   * the waiver still wins in {@link classifyAuditGap}, so the item is not
   * flagged.
   *
   * @returns the updated item, or `null` when the id does not exist.
   */
  setAuditWaiver(id: string, waiver: AuditWaiver): WorkItem | null {
    return auditModule.setAuditWaiver(this.ctx, this.ctx.writeHooks, id, waiver);
  }

  /**
   * Remove an explicit audit-gap waiver from a work item. Idempotent: an
   * item that is not waived is returned unchanged (no write).
   *
   * @returns the updated item, or `null` when the id does not exist.
   */
  clearAuditWaiver(id: string): WorkItem | null {
    return auditModule.clearAuditWaiver(this.ctx, this.ctx.writeHooks, id);
  }

  /**
   * Get all audit results (for JSONL export / sync).
   */
  getAllAuditResults(): AuditResult[] {
    return auditModule.getAllAuditResults(this.ctx);
  }

  /**
   * Import audit results (upsert, bulk).
   */
  importAuditResults(audits: AuditResult[]): void {
    auditModule.importAuditResults(this.ctx, this.ctx.writeHooks, audits);
  }

  /**
   * Set the prefix for this database
   */
  setPrefix(prefix: string): void {
    setPrefix(this.ctx, prefix);
  }

  /**
   * Get the current prefix
   */
  getPrefix(): string {
    return getPrefix(this.ctx);
  }

  /**
   * Generate a unique ID for a work item
   */
  private generateId(): string {
    return generateId(this.ctx);
  }

  generateWorkItemId(): string {
    return this.generateId();
  }

  /**
   * Generate a unique ID for a comment (public wrapper)
   */
  generatePublicCommentId(): string {
    return this.generateCommentId();
  }

  /**
   * Generate a unique ID for a comment
   */
  private generateCommentId(): string {
    return generateCommentId(this.ctx);
  }

  // ── Work-item and hierarchy delegates ──────────────────────────────
  // This cluster now lives in ./database/{work-items,hierarchy}.js
  // (WL-0MVOBP4J6003ZKML). Every member below keeps its ORIGINAL signature
  // and delegates to the extracted function, so the class surface is
  // unchanged. Members with no remaining in-façade caller are retained
  // deliberately: the split is move-only, and the delegating member documents
  // where the implementation went.

  /**
   * Create a new work item
   *
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  create(input: CreateWorkItemInput): WorkItem {
    return workItemsModule.create(this.ctx, this.ctx.itemHooks, input);
  }

  /**
   * Create a work item after the last sibling in hierarchy order.
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  createWithNextSortIndex(input: CreateWorkItemInput, gap: number = 100): WorkItem {
    return workItemsModule.createWithNextSortIndex(this.ctx, this.ctx.itemHooks, input, gap);
  }

  /**
   * Find the most recent non-terminal work item whose title matches `title`
   * under case/whitespace normalization and was created within `windowMs`.
   *
   * Backs the `wl create` dedup guard (WL-0MSTNG2QF0049B97): retrying an
   * identical create command (common when agents lose the tool result to
   * output trimming) must return the existing item instead of creating a
   * byte-identical twin. Only non-terminal items (open/in-progress/blocked)
   * within the recent window are considered — completed items and stale
   * same-title items are deliberately unrelated.
   *
   * @param title - The candidate title (compared case- and whitespace-
   *   insensitively against stored titles).
   * @param windowMs - Look-back window in milliseconds; only items created
   *   strictly after `now - windowMs` match.
   * @param prefix - Prefix scope; defaults to this database's prefix. Only
   *   items whose id starts with `<prefix>-` are considered.
   * @returns The newest matching item, or null when no match exists.
   *
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  getRecentDuplicate(title: string, windowMs: number, prefix?: string): WorkItem | null {
    return workItemsModule.getRecentDuplicate(this.ctx, title, windowMs, prefix);
  }

  /**
   * Get a work item by ID
   */
  get(id: string): WorkItem | null {
    return workItemsModule.get(this.ctx, id);
  }

  /**
   * Conditional update (compare-and-swap, RCA WL-0MSRBFFLN005W3VT design
   * point 1): apply `input` ONLY if the item's current status/stage/assignee
   * match the expected guard. Runs the check and the write inside a single
   * `BEGIN IMMEDIATE` transaction (see `PersistentStore.transactionImmediate`),
   * so two concurrent `wl update --if-status/--if-stage/--if-assignee`
   * processes serialize on the SQLite write lock: exactly one observes the
   * expected state and wins; the loser observes the winner's committed
   * transition and fails `stale` without writing.
   *
   * `expected.assignee` distinguishes an explicit empty-string guard (match
   * an unassigned item — the status-neutral audit-tier claim) from an omitted
   * guard (`undefined`): the empty string is a meaningful expected value, not
   * a "no guard" sentinel.
   *
   * @returns `{ok:true, item}` on success; `{ok:false, reason:'not-found'}`
   * when the id is absent; `{ok:false, reason:'stale'}` when the guard
   * mismatch means another process already changed the item.
   *
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  updateIfMatches(
    id: string,
    input: UpdateWorkItemInput,
    expected: { status?: string; stage?: string; assignee?: string } = {},
  ): UpdateIfMatchesResult {
    return workItemsModule.updateIfMatches(this.ctx, this.ctx.itemHooks, id, input, expected);
  }

  /**
   * Update a work item
   *
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  update(id: string, input: UpdateWorkItemInput): WorkItem | null {
    return workItemsModule.update(this.ctx, this.ctx.itemHooks, id, input);
  }

  /**
   * Delete a work item
   *
   * If the item has children, recursively deletes all descendants first,
   * then deletes the item itself. This prevents orphaned children from
   * remaining with stale parentId references.
   *
   * @param id - The ID of the work item to delete
   * @param recursive - Whether to recursively delete descendants (default: true)
   * @param opts - Optional attribution: deletedBy (identity) / deleteReason (why).
   *   Deletes are ATTRIBUTED (WL-0MSKZ30SK007K9TO, F4): pass non-empty values so
   *   the soft-delete carries real intent — unattributed deletes never
   *   merge-propagate over a live remote item (delete-side protection in the
   *   merge layer).
   *
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML; the
   * module exports it as `deleteWorkItem` because `delete` is a reserved word).
   */
  delete(id: string, recursive: boolean = true, opts?: { deletedBy?: string; deleteReason?: string }): boolean {
    return workItemsModule.deleteWorkItem(this.ctx, this.ctx.itemHooks, id, recursive, opts);
  }

  /**
   * Internal: delete a single work item without recursive child handling.
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  private deleteSingle(id: string, opts?: { deletedBy?: string; deleteReason?: string }): boolean {
    return workItemsModule.deleteSingle(this.ctx, this.ctx.itemHooks, id, opts);
  }

  /**
   * List all work items
   *
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  list(query?: WorkItemQuery): WorkItem[] {
    return workItemsModule.list(this.ctx, query);
  }

  /**
   * Get children of a work item
   *
   * Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML).
   */
  getChildren(parentId: string): WorkItem[] {
    return hierarchyModule.getChildren(this.ctx, parentId);
  }

  /**
   * Cascade a priority downgrade to direct children.
   *
   * When a work item's priority is reduced away from `critical`, any direct
   * children still at `critical` priority are downgraded to `high` so that
   * critical-priority subtasks of a non-critical parent are resolved.
   * Children already at `high`, `medium`, or `low` are left untouched, and
   * grandchildren are not affected.
   *
   * @param parentId - id of the work item whose children should be checked
   * @param newPriority - the parent's new priority; when still `critical`
   *   this is a no-op (no children are touched)
   * @returns the list of children whose priority was downgraded (empty if none)
   *
   * Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML).
   */
  cascadePriorityDowngrade(parentId: string, newPriority: WorkItemPriority): WorkItem[] {
    return hierarchyModule.cascadePriorityDowngrade(this.ctx, this.ctx.itemHooks, parentId, newPriority);
  }

  /**
   * Demote a parent work item when a child is added to it.
   *
   * A parent cannot be `completed` (status) or `in_review` (stage) while its
   * subtree is not finished. When a new child is attached to such a parent
   * (via `wl create --parent` or `wl update --parent`), the parent is moved
   * back to `open` / `plan_complete` so its lifecycle state always reflects
   * that it has uncompleted children.
   *
   * Only the direct parent is demoted; ancestors are left untouched.
   *
   * @param parentId - id of the parent that received the new child
   * @returns the demotion details (parent, from status/stage, to status/stage)
   *   or `null` when the parent is not in an eligible state (or does not exist)
   *
   * Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML).
   */
  demoteParentOnChildAdded(parentId: string): DemotedParent | null {
    return hierarchyModule.demoteParentOnChildAdded(this.ctx, this.ctx.itemHooks, parentId);
  }

  /**
   * Revert an item to `open`/`plan_complete` after a "not ready to close"
   * audit verdict.
   *
   * When an item in `in_review` (status `completed`) receives a
   * not-ready-to-close verdict ("Ready to close: No" via `--audit-text`, or
   * `--ready-to-close no` via `wl audit-set`), it is moved back to
   * `open`/`plan_complete` so it drops out of the ready-to-close queue and
   * returns to the planning queue for further work. The item's priority is
   * preserved (only status/stage change).
   *
   * Only items in exactly `completed`/`in_review` are reverted: a `done`
   * item or an item already `open`/`in-progress` is left untouched.
   *
   * @param itemId - id of the work item whose audit verdict is not-ready-to-close
   * @returns the reversion details (item, from status/stage, to status/stage)
   *   or `null` when the item is not in an eligible state (or does not exist)
   *
   * Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML).
   */
  revertToPlanComplete(itemId: string): RevertedItem | null {
    return hierarchyModule.revertToPlanComplete(this.ctx, this.ctx.itemHooks, itemId);
  }

  /**
   * Get the number of direct children for each work item.
   * Returns a Map<itemId, count>.
   * If items is provided, only counts within that subset; otherwise uses all items.
   * This is more efficient than calling getChildren() for every item individually
   * because it computes the full map in a single O(n) pass.
   *
   * Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML).
   */
  getChildCounts(items?: WorkItem[]): Map<string, number> {
    return hierarchyModule.getChildCounts(this.ctx, items);
  }

  /**
   * Get children that are not closed or deleted
   *
   * Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML).
   */
  private getNonClosedChildren(parentId: string, edgeCache?: EdgeCache): WorkItem[] {
    return hierarchyModule.getNonClosedChildren(this.ctx, parentId, edgeCache);
  }

  /**
   * Get all descendants (children, grandchildren, etc.) of a work item
   *
   * Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML).
   */
  getDescendants(parentId: string): WorkItem[] {
    return hierarchyModule.getDescendants(this.ctx, parentId);
  }

  /**
   * Check if a work item is a leaf node (has no children)
   *
   * Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML).
   */
  isLeafNode(itemId: string): boolean {
    return hierarchyModule.isLeafNode(this.ctx, itemId);
  }

  /**
   * Get all leaf nodes that are descendants of a parent item
   *
   * Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML).
   */
  getLeafDescendants(parentId: string): WorkItem[] {
    return hierarchyModule.getLeafDescendants(this.ctx, parentId);
  }

  /**
   * Get the depth of an item in the tree (root = 0)
   *
   * Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML).
   */
  private getDepth(itemId: string): number {
    return hierarchyModule.getDepth(this.ctx, itemId);
  }

  // ── `wl next` selection delegates ──────────────────────────────────────
  // This cluster now lives in ./database/{priority,next-pipeline,critical-escalation}.js
  // (WL-0MVOBP0U5007BAZD). Every member below keeps its ORIGINAL signature and
  // delegates to the extracted function, so the class surface is unchanged.
  // Members with no remaining in-façade caller are retained deliberately: the
  // split is move-only, and the delegating member documents where the
  // implementation went.

  /** Delegates to {@link riskOrdinal} in `./database/priority.js`. */
  private riskOrdinal(risk: string | undefined | null): number | null {
    return riskOrdinal(risk);
  }


  /** Delegates to {@link effortOrdinal} in `./database/priority.js`. */
  private effortOrdinal(effort: string | undefined | null): number | null {
    return effortOrdinal(effort);
  }


  /** Delegates to {@link matchesRiskEffort} in `./database/priority.js`. */
  private matchesRiskEffort(item: WorkItem, risk?: string, effort?: string): boolean {
    return matchesRiskEffort(item, risk, effort);
  }


  /** Delegates to {@link getPriorityValue} in `./database/priority.js`. */
  private getPriorityValue(priority?: string): number {
    return getPriorityValue(priority);
  }


  /**
   * Effective-priority tie-breaker — implementation in `./database/priority.js`
   * (WL-0MVOBP0U5007BAZD). Kept as a delegating member with an identical
   * signature so the public API is unchanged.
   */
  computeEffectivePriority(
    item: WorkItem,
    cache?: Map<string, { value: number; reason: string; inheritedFrom?: string }>,
    edgeCache?: EdgeCache,
    items?: WorkItem[]
  ): { value: number; reason: string; inheritedFrom?: string } {
    return computeEffectivePriority(this.ctx, this.ctx.hooks, item, cache, edgeCache, items);
  }


  /**
   * Delegates to {@link selectHighestPriorityBlocking} in `./database/next-pipeline.js`.
   * Retained here because the critical-escalation stage reaches it through the
   * context hooks (never by importing the module that imports it).
   */
  private selectHighestPriorityBlocking(pairs: { blocking: WorkItem; critical: WorkItem }[], sortOrderCache?: WorkItem[]): { blocking: WorkItem; critical: WorkItem } | null {
    return selectHighestPriorityBlocking(this.ctx.hooks, pairs, sortOrderCache);
  }


  /** Delegates to {@link handleCriticalEscalation} in `./database/critical-escalation.js`. */
  private handleCriticalEscalation(
    allItems: WorkItem[],
    options: {
      assignee?: string;
      searchTerm?: string;
      risk?: string;
      effort?: string;
      excluded?: Set<string>;
      debugPrefix?: string;
      includeInProgress?: boolean;
      edgeCache?: EdgeCache;
      sortOrderCache?: WorkItem[];
    } = {}
  ): NextWorkItemResult | null {
    return handleCriticalEscalation(this.ctx.hooks, allItems, options);
  }


  /** Delegates to {@link sortModule.orderBySortIndex} in `./database/sort.js`. */
  private orderBySortIndex(items: WorkItem[], sortOrderCache?: WorkItem[]): WorkItem[] {
    return sortModule.orderBySortIndex(this.ctx, items, sortOrderCache);
  }

  /** Delegates to {@link sortModule.selectBySortIndex} in `./database/sort.js`. */
  private selectBySortIndex(
    items: WorkItem[],
    effectivePriorityCache?: Map<string, { value: number; reason: string; inheritedFrom?: string }>,
    sortOrderCache?: WorkItem[],
    edgeCache?: EdgeCache,
    allItems?: WorkItem[]
  ): WorkItem | null {
    return sortModule.selectBySortIndex(this.ctx, this.ctx.hooks, items, effectivePriorityCache, sortOrderCache, edgeCache, allItems);
  }

  /** Delegates to {@link filterCandidates} in `./database/next-pipeline.js`. */
  private filterCandidates(
    items: WorkItem[],
    options: {
      assignee?: string;
      searchTerm?: string;
      stage?: string;
      risk?: string;
      effort?: string;
      excluded?: Set<string>;
      includeBlocked?: boolean;
      includeInProgress?: boolean;
      debugPrefix?: string;
      edgeCache?: EdgeCache;
    } = {}
  ): { candidates: WorkItem[]; criticalPool: WorkItem[] } {
    return filterCandidates(this.ctx, this.ctx.hooks, items, options);
  }


  /**

  /**
   * Delegates to {@link resolveBlockerToRoot} in `./database/next-pipeline.js`.
   * Retained here because the critical-escalation stage reaches it through the
   * context hooks (never by importing the module that imports it).
   */
  private resolveBlockerToRoot(
    blocker: WorkItem,
    allItems: WorkItem[],
    assignee?: string,
    searchTerm?: string,
    excluded?: Set<string>
  ): WorkItem | null {
    return resolveBlockerToRoot(this.ctx, this.ctx.hooks, blocker, allItems, assignee, searchTerm, excluded);
  }


  /** Delegates to {@link findNextWorkItemFromItems} in `./database/next-pipeline.js`. */
  private findNextWorkItemFromItems(
    items: WorkItem[],
    assignee?: string,
    searchTerm?: string,
    excluded?: Set<string>,
    debugPrefix: string = '[next]',
    includeBlocked: boolean = false,
    stage?: string,
    includeInProgress: boolean = false,
    edgeCache?: EdgeCache,
    risk?: string,
    effort?: string
  ): NextWorkItemResult {
    return findNextWorkItemFromItems(this.ctx, this.ctx.hooks, items, assignee, searchTerm, excluded, debugPrefix, includeBlocked, stage, includeInProgress, edgeCache, risk, effort);
  }


  /**
   * Find the next work item to work on based on priority and creation time
   * — implementation in `./database/next-pipeline.js` (WL-0MVOBP0U5007BAZD).
   * @param assignee - Optional assignee filter
   * @param searchTerm - Optional search term for fuzzy matching
   * @returns The next work item and a reason for the selection, or null if none found
   */
  findNextWorkItem(
    assignee?: string,
    searchTerm?: string,
    includeBlocked: boolean = false,
    stage?: string,
    includeInProgress: boolean = false,
    risk?: string,
    effort?: string
  ): NextWorkItemResult {
    return findNextWorkItem(this.ctx, this.ctx.hooks, assignee, searchTerm, includeBlocked, stage, includeInProgress, risk, effort);
  }


  /**
   * Find multiple next work items (up to `count`) using the same selection logic
   * as `findNextWorkItem`, but excluding already-selected items between iterations
   * — implementation in `./database/next-pipeline.js` (WL-0MVOBP0U5007BAZD).
   */
  findNextWorkItems(
    count: number,
    assignee?: string,
    searchTerm?: string,
    includeBlocked: boolean = false,
    stage?: string,
    includeInProgress: boolean = false,
    risk?: string,
    effort?: string
  ): NextWorkItemResult[] {
    return findNextWorkItems(this.ctx, this.ctx.hooks, count, assignee, searchTerm, includeBlocked, stage, includeInProgress, risk, effort);
  }


  /**
   * Delegates to {@link applyFilters} in `./database/next-pipeline.js`.
   * Retained here because the critical-escalation stage reaches it through the
   * context hooks (never by importing the module that imports it).
   */
  private applyFilters(items: WorkItem[], assignee?: string, searchTerm?: string): WorkItem[] {
    return applyFilters(this.ctx, items, assignee, searchTerm);
  }


  /**
   * Clear all work items (useful for import)
   */
  clear(): void {
    this.store.clearWorkItems();
  }

  /**
   * Get all work items as an array
   */
  getAll(): WorkItem[] {
    return this.store.getAllWorkItems();
  }

  getAllOrderedByHierarchySortIndex(): WorkItem[] {
    return this.store.getAllWorkItemsOrderedByHierarchySortIndex();
  }

  getAllOrderedByScore(recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore'): WorkItem[] {
    return sortModule.getAllOrderedByScore(this.ctx, recencyPolicy);
  }

  /**
   * Compare a set of tracked fields between two work items and return true if
   * any of them has semantically changed.
   *
   * `title` and `description` are whitespace-normalized before comparison
   * (leading/trailing whitespace, trailing newlines and blank-line runs are
   * stripped) so that whitespace-only differences do NOT count as semantic
   * changes — e.g. a second worklog store that strips trailing newlines from
   * descriptions would otherwise re-timestamp every item on every `wl sync`
   * (WL-0MSORD6HC005QVZX). `needsProducerReview` is normalised through
   * `Boolean()` so that an omitted flag (undefined on incoming items) is
   * equivalent to an explicit `false` (the value stored items round-trip
   * to) — no-op re-imports must not bump `updatedAt` (WL-0MVB9557U009LEIF).
   * All other fields use strict equality; arrays
   * (tags) are compared by value.
   *
   * Shared by {@link hasWorkItemChanged} (16-field tracked set, used by
   * import()/upsertItems()) and the no-op guard in {@link update} (13-field
   * set, excluding the GitHub metadata fields).
   *
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  private compareTrackedFields(oldItem: WorkItem, newItem: WorkItem, fields: (keyof WorkItem)[]): boolean {
    return workItemsModule.compareTrackedFields(oldItem, newItem, fields);
  }

  /**
   * Compare an existing work item against a candidate and return true if any
   * tracked field has semantically changed.
   *
   * Uses the same field set and comparison logic as the no-op guard in {@link update}
   * (via {@link compareTrackedFields}). `needsProducerReview` is compared via
   * `Boolean()` normalisation, so incoming items that omit the flag are not
   * treated as changed against stored `false` values (WL-0MVB9557U009LEIF).
   */
  private hasWorkItemChanged(oldItem: WorkItem, newItem: WorkItem): boolean {
    // Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
    return workItemsModule.hasWorkItemChanged(oldItem, newItem);
  }

  /**
   * Import work items by **replacing** all existing data.
   *
   * **WARNING — DESTRUCTIVE**: any items, edges or audits NOT included in the
   * arguments are permanently deleted (comments cascade with their item).
   *
   * **Change detection (WL-0MVK3WRY9009KV6P / WL-0MVK6S9TN00500UL)**: the
   * replace is now differential rather than clear-and-re-insert. Records whose
   * merged value is identical to the stored value are not written at all, and
   * their FTS row is left untouched, so a no-change sync performs zero record
   * writes and zero FTS writes (F2 measured `upsertFtsEntry` at 78–90 % of the
   * persist CPU when every row was rewritten). Deleted ids still have their
   * item row, comments, edges, audit row and FTS entry removed.
   *
   * **Atomic**: the whole differential persist runs in one SQLite transaction
   * so that concurrent readers always see either the old complete state or the
   * new complete state — never an empty or partially-populated database. This
   * prevents the race condition where another Pi TUI instance's selection list
   * appears empty or stale during a sync operation.
   *
   * Only call this method with a **complete** item set (e.g. the result of
   * merging local + remote data). For partial / incremental updates — such as
   * syncing a subset of items back from GitHub — use {@link upsertItems}
   * instead, which preserves items not in the provided array.
   *
   * **No-op guard**: Before clearing, this method snapshots existing items.
   * For each incoming item that already exists and has identical tracked fields
   * (title, description, status, priority, sortIndex, parentId, tags, assignee,
   * stage, issueType, risk, effort, needsProducerReview), the original
   * `updatedAt` is preserved so that sync operations do not silently
   * re-timestamp unchanged items. Changed items get a new `updatedAt`;
   * entirely new items use the incoming value as-is.
   *
   * `needsProducerReview` is compared via `Boolean()` normalisation (see
   * {@link compareTrackedFields}), so an omitted flag on incoming items is
   * treated as unchanged against a stored `false` — a no-op re-import must
   * not re-timestamp every item (WL-0MVB9557U009LEIF). A genuine flip to
   * `true` still counts as a change.
   *
   * Comparison is whitespace-insensitive for `title` and `description`
   * (via {@link compareTrackedFields}): trailing-newline strips / leading or
   * trailing whitespace / blank-line runs do NOT count as semantic changes,
   * so `wl sync` does not re-timestamp items whose meaningful content never
   * changed (WL-0MSORD6HC005QVZX). The incoming (normalized) content is still
   * persisted — only `updatedAt` is preserved.
   *
   * @param items - The full set of work items to store.
   * @param dependencyEdges - Optional full set of dependency edges. When
   *   provided, edges absent from this set are deleted and only new/changed
   *   edges are written.
   * @param auditResults - Optional full set of audit results. When provided,
   *   existing audit results are replaced with these — but never with an
   *   OLDER row than a stored one for the same item (monotonic,
   *   SA-0MUJNFF3K009BF03).
   */
  import(items: WorkItem[], dependencyEdges?: DependencyEdge[], auditResults?: AuditResult[]): void {
    // Snapshot the current state up front: it is the diff base for every
    // record type, so unchanged rows are never re-written.
    const existingItems = new Map<string, WorkItem>();
    for (const existing of this.store.getAllWorkItems()) {
      existingItems.set(existing.id, existing);
    }
    const storedAudits = this.store.getAllAuditResults();
    const storedEdges = dependencyEdges ? this.store.getAllDependencyEdges() : [];
    const importedIdSet = new Set(items.map(item => item.id));

    // Destructive-replace semantics are preserved: ids absent from the
    // incoming snapshot are deleted (their comments, edges and audit rows
    // cascade through the FK constraints, their FTS row is removed below).
    const removedIds = Array.from(existingItems.keys()).filter(id => !importedIdSet.has(id));

    // One transaction for the whole differential persist so concurrent
    // readers never see an empty or partially-populated database during sync.
    this.store.transaction(() => {
      for (const id of removedIds) {
        this.store.deleteWorkItem(id);
        if (this.store.ftsAvailable) {
          this.store.deleteFtsEntry(id);
        }
      }

      for (const item of items) {
        const existing = existingItems.get(item.id);
        let toSave: WorkItem;
        if (existing && !this.hasWorkItemChanged(existing, item)) {
          // Semantically unchanged — preserve the existing updatedAt and keep
          // the later activityAt. Only write when the merged activityAt
          // actually advances, so a true no-change import performs zero
          // writes (comment activity must never be lost — WL-0MUBVH6JM0093KVM).
          const activityAt = laterTimestamp(item.activityAt, existing.activityAt);
          if (activityAt === existing.activityAt) {
            continue;
          }
          toSave = { ...item, updatedAt: existing.updatedAt, activityAt };
        } else if (existing) {
          // Semantic change detected — bump the timestamp.
          toSave = {
            ...item,
            updatedAt: new Date().toISOString(),
            activityAt: laterTimestamp(item.activityAt, existing.activityAt),
          };
        } else {
          // New item — use the incoming updatedAt as-is.
          toSave = item;
        }
        this.store.saveWorkItem(toSave);
        // Keep FTS fresh only for the records actually written.
        if (this.store.ftsAvailable) {
          this.store.upsertFtsEntry(toSave);
        }
      }

      if (dependencyEdges) {
        // Replace the edge set differentially: drop edges absent from the
        // incoming set, write only new/changed edges whose endpoints exist.
        const desiredEdges = new Map<string, DependencyEdge>();
        for (const edge of dependencyEdges) {
          if (this.store.getWorkItem(edge.fromId) && this.store.getWorkItem(edge.toId)) {
            desiredEdges.set(`${edge.fromId}\u0000${edge.toId}`, edge);
          }
        }
        const storedEdgeKey = new Map<string, DependencyEdge>();
        for (const edge of storedEdges) {
          storedEdgeKey.set(`${edge.fromId}\u0000${edge.toId}`, edge);
        }
        for (const [key, edge] of storedEdgeKey) {
          if (!desiredEdges.has(key)) {
            this.store.deleteDependencyEdge(edge.fromId, edge.toId);
          }
        }
        for (const [key, edge] of desiredEdges) {
          const stored = storedEdgeKey.get(key);
          if (!stored || stored.createdAt !== edge.createdAt) {
            this.store.saveDependencyEdge(edge);
          }
        }
      }

      // Newest-wins: the incoming set replaces the stored set except where an
      // incoming row is strictly older than a stored row for the same item.
      // Only rows that actually differ from the stored value are written.
      const survivingAudits = storedAudits.filter(audit => importedIdSet.has(audit.workItemId));
      const mergedAudits = auditResults
        ? this.mergeAuditsNewestWins(survivingAudits, auditResults)
        : survivingAudits;
      const storedAuditByItem = new Map(storedAudits.map(audit => [audit.workItemId, audit]));
      const auditsToSave = mergedAudits.filter(audit => {
        const stored = storedAuditByItem.get(audit.workItemId);
        if (!stored) {
          return true;
        }
        return (
          stored.readyToClose !== audit.readyToClose ||
          stored.auditedAt !== audit.auditedAt ||
          (stored.summary ?? null) !== (audit.summary ?? null) ||
          (stored.rawOutput ?? null) !== (audit.rawOutput ?? null) ||
          (stored.author ?? null) !== (audit.author ?? null) ||
          (stored.fingerprint ?? null) !== (audit.fingerprint ?? null)
        );
      });
      if (auditsToSave.length > 0) {
        this.store.saveAuditResults(auditsToSave);
      }
    });

    this.triggerAutoSync();
  }

  /**
   * Upsert work items non-destructively (INSERT OR REPLACE without clearing).
   *
   * Unlike `import()`, this method does NOT call `clearWorkItems()` or
   * `clearDependencyEdges()`. It saves each provided item via the store's
   * `saveWorkItem()` (which uses INSERT … ON CONFLICT DO UPDATE) so that
   * existing items not in the provided array are preserved.
   *
   * **No-op guard**: For each item that already exists in the store AND has
   * identical tracked fields (same field set as {@link hasWorkItemChanged},
   * whitespace-insensitive for `title`/`description`, `Boolean()`-normalised
   * for `needsProducerReview`), the save is entirely
   * skipped — preserving the existing `updatedAt`. Items whose tracked fields
   * differ, or that are new, get a fresh `updatedAt` timestamp.
   *
   * When `dependencyEdges` is provided, only edges whose `fromId` or `toId`
   * belongs to the provided items are upserted; all other edges are untouched.
   *
   * If `items` is empty the method is a no-op (no export/sync triggered).
   */
  upsertItems(items: WorkItem[], dependencyEdges?: DependencyEdge[]): void {
    if (items.length === 0) {
      return;
    }

    for (const item of items) {
      const existing = this.store.getWorkItem(item.id);
      if (existing && !this.hasWorkItemChanged(existing, item)) {
        // No semantic change — skip the save entirely to preserve updatedAt
        continue;
      }
      // Either a new item or a semantic change — bump the timestamp, keeping
      // the later activityAt (comment activity must not be lost on sync).
      const itemToSave = existing
        ? { ...item, updatedAt: new Date().toISOString(), activityAt: laterTimestamp(item.activityAt, existing.activityAt) }
        : item;
      this.store.saveWorkItem(itemToSave);
      // Keep the FTS index fresh for the upserted item
      if (this.store.ftsAvailable) {
        this.store.upsertFtsEntry(itemToSave);
      }
    }

    if (dependencyEdges) {
      const affectedIds = new Set(items.map(i => i.id));
      for (const edge of dependencyEdges) {
        if (
          (affectedIds.has(edge.fromId) || affectedIds.has(edge.toId)) &&
          this.store.getWorkItem(edge.fromId) &&
          this.store.getWorkItem(edge.toId)
        ) {
          this.store.saveDependencyEdge(edge);
        }
      }
    }

    this.triggerAutoSync();
  }

  /**
   * Add a dependency edge (fromId depends on toId)
   */
  addDependencyEdge(fromId: string, toId: string): DependencyEdge | null {
    if (!this.store.getWorkItem(fromId) || !this.store.getWorkItem(toId)) {
      return null;
    }

    const edge: DependencyEdge = {
      fromId,
      toId,
      createdAt: new Date().toISOString(),
    };

    this.store.saveDependencyEdge(edge);
    this.triggerAutoSync();
    return edge;
  }

  /**
   * Remove a dependency edge (fromId depends on toId)
   */
  removeDependencyEdge(fromId: string, toId: string): boolean {
    const removed = this.store.deleteDependencyEdge(fromId, toId);
    if (removed) {
      this.triggerAutoSync();
    }
    return removed;
  }

  /**
   * List outbound dependency edges (fromId depends on toId)
   */
  listDependencyEdgesFrom(fromId: string): DependencyEdge[] {
    return this.store.getDependencyEdgesFrom(fromId);
  }

  /**
   * List inbound dependency edges (items that depend on toId)
   */
  listDependencyEdgesTo(toId: string): DependencyEdge[] {
    return this.store.getDependencyEdgesTo(toId);
  }

  private isDependencyActive(target: WorkItem | null): boolean {
    if (!target) {
      return false;
    }
    if (target.status === 'completed' || target.status === 'deleted') {
      return false;
    }
    if (target.stage === 'in_review' || target.stage === 'done') {
      return false;
    }
    return true;
  }

  /**
   * Check if an item is part of an in-progress subtree by walking up the
   * parent chain. Returns true if any ancestor has status 'in-progress'.
   */
  private isInProgressSubtree(item: WorkItem, allItems: WorkItem[]): boolean {
    if (!item.parentId) return false;
    const parent = allItems.find(p => p.id === item.parentId);
    if (!parent) return false;
    if (parent.status === 'in-progress') return true;
    return this.isInProgressSubtree(parent, allItems);
  }

  private getActiveDependencyBlockers(itemId: string, edgeCache?: EdgeCache): WorkItem[] {
    let edges: DependencyEdge[];
    if (edgeCache) {
      edges = edgeCache.outbound.get(itemId) ?? [];
    } else {
      edges = this.listDependencyEdgesFrom(itemId);
    }
    const blockers: WorkItem[] = [];
    for (const edge of edges) {
      const target = edgeCache
        ? (edgeCache.itemsById.get(edge.toId) ?? null)
        : this.get(edge.toId);
      if (this.isDependencyActive(target) && target) {
        blockers.push(target);
      }
    }
    return blockers;
  }

  getInboundDependents(targetId: string): WorkItem[] {
    const inbound = this.listDependencyEdgesTo(targetId);
    const dependents: WorkItem[] = [];
    for (const edge of inbound) {
      const dependent = this.get(edge.fromId);
      if (dependent) {
        dependents.push(dependent);
      }
    }
    return dependents;
  }

  hasActiveBlockers(itemId: string): boolean {
    const edges = this.listDependencyEdgesFrom(itemId);
    for (const edge of edges) {
      const target = this.get(edge.toId);
      if (this.isDependencyActive(target)) {
        return true;
      }
    }
    return false;
  }

  reconcileBlockedStatus(itemId: string): boolean {
    const item = this.get(itemId);
    if (!item) {
      return false;
    }
    if (item.status !== 'blocked') {
      return false;
    }
    if (this.hasActiveBlockers(itemId)) {
      return false;
    }

    const updated: WorkItem = {
      ...item,
      status: 'open',
      updatedAt: new Date().toISOString(),
    };
    this.store.saveWorkItem(updated);
    // Keep the FTS index fresh so status-filtered search reflects the change
    if (this.store.ftsAvailable) {
      this.store.upsertFtsEntry(updated);
    }
    this.triggerAutoSync();
    return true;
  }

  reconcileDependentStatus(itemId: string): boolean {
    const item = this.get(itemId);
    if (!item) {
      return false;
    }
    if (item.status === 'completed' || item.status === 'deleted') {
      return false;
    }

    if (this.hasActiveBlockers(itemId)) {
      if (item.status === 'blocked') {
        return false;
      }
      const updated: WorkItem = {
        ...item,
        status: 'blocked',
        updatedAt: new Date().toISOString(),
      };
      this.store.saveWorkItem(updated);
      // Keep the FTS index fresh so status-filtered search reflects the change
      if (this.store.ftsAvailable) {
        this.store.upsertFtsEntry(updated);
      }
      this.triggerAutoSync();
      if (process.env.WL_DEBUG) {
        process.stderr.write(`[wl:dep] re-blocked ${itemId} (active blockers remain)\n`);
      }
      return true;
    }

    if (item.status !== 'blocked') {
      return false;
    }

    const updated: WorkItem = {
      ...item,
      status: 'open',
      updatedAt: new Date().toISOString(),
    };
    this.store.saveWorkItem(updated);
    // Keep the FTS index fresh so status-filtered search reflects the change
    if (this.store.ftsAvailable) {
      this.store.upsertFtsEntry(updated);
    }
    this.triggerAutoSync();
    if (process.env.WL_DEBUG) {
      process.stderr.write(`[wl:dep] unblocked ${itemId} (no active blockers remain)\n`);
    }
    return true;
  }

  reconcileDependentsForTarget(targetId: string): number {
    const dependents = this.getInboundDependents(targetId);
    let updated = 0;
    for (const dependent of dependents) {
      if (this.reconcileDependentStatus(dependent.id)) {
        updated += 1;
      }
    }
    if (process.env.WL_DEBUG && updated > 0) {
      process.stderr.write(`[wl:dep] reconciled ${updated} dependent(s) for target ${targetId}\n`);
    }
    return updated;
  }

  /**
   * Create a new comment
   */
  createComment(input: CreateCommentInput): Comment | null {
    // Validate required fields
    if (!input.author || input.author.trim() === '') {
      throw new Error('Author is required');
    }
    if (!input.comment || input.comment.trim() === '') {
      throw new Error('Comment text is required');
    }
    
    // Verify that the work item exists
    if (!this.store.getWorkItem(input.workItemId)) {
      return null;
    }

    const id = this.generateCommentId();
    const now = new Date().toISOString();
    
    const comment: Comment = {
      id,
      workItemId: input.workItemId,
      author: input.author,
      comment: input.comment,
      createdAt: now,
      references: input.references || [],
      // Normalize nullable inputs: treat null as undefined
      githubCommentId: input.githubCommentId == null ? undefined : input.githubCommentId,
      githubCommentUpdatedAt: input.githubCommentUpdatedAt == null ? undefined : input.githubCommentUpdatedAt,
    };

    // Debug: log creation intent before saving (only when not silent)
     if (!this.silent) {
       // Send to stderr so JSON output on stdout is not contaminated
       this.debug(`WorklogDatabase.createComment: creating comment for ${input.workItemId} by ${input.author}`);
     }

     this.store.saveComment(comment);
     this.touchWorkItemActivityAt(input.workItemId);
     // Re-index the parent work item in FTS to include the new comment text
     const parentItem = this.store.getWorkItem(input.workItemId);
     if (parentItem) this.store.upsertFtsEntry(parentItem);
     this.triggerAutoSync();
     return comment;
  }

  /**
   * Get a comment by ID
   */
  getComment(id: string): Comment | null {
    return this.store.getComment(id);
  }

  /**
   * Update a comment
   */
  updateComment(id: string, input: UpdateCommentInput): Comment | null {
    const comment = this.store.getComment(id);
    if (!comment) {
      return null;
    }

    let updatedAny: any = {
      ...comment,
      ...input,
    };

    // Normalize nullable github mapping fields: convert null -> undefined
    if (updatedAny.githubCommentId == null) {
      updatedAny.githubCommentId = undefined;
    }
    if (updatedAny.githubCommentUpdatedAt == null) {
      updatedAny.githubCommentUpdatedAt = undefined;
    }

    // Prevent changing immutable fields
    const updated: Comment = {
      ...updatedAny,
      id: comment.id,
      workItemId: comment.workItemId,
      createdAt: comment.createdAt,
    } as Comment;

     this.store.saveComment(updated);
     this.touchWorkItemActivityAt(comment.workItemId);
     // Re-index the parent work item in FTS to reflect updated comment text
     const parentItem = this.store.getWorkItem(comment.workItemId);
     if (parentItem) this.store.upsertFtsEntry(parentItem);
     this.triggerAutoSync();
     return updated;
  }

  /**
   * Delete a comment
   */
  deleteComment(id: string): boolean {
     const comment = this.store.getComment(id);
     if (!comment) {
       return false;
     }
     const result = this.store.deleteComment(id);
      if (result) {
        this.touchWorkItemActivityAt(comment.workItemId);
        // Re-index the parent work item in FTS to reflect removed comment
        const parentItem = this.store.getWorkItem(comment.workItemId);
        if (parentItem) this.store.upsertFtsEntry(parentItem);
        this.triggerAutoSync();
      }
      return result;
  }

  /**
   * Get all comments for a work item
   */
  getCommentsForWorkItem(workItemId: string): Comment[] {
    return this.store.getCommentsForWorkItem(workItemId);
  }

  /**
   * Get all comments as an array
   */
  getAllComments(): Comment[] {
    return this.store.getAllComments();
  }

  getAllDependencyEdges(): DependencyEdge[] {
    return this.store.getAllDependencyEdges();
  }

  /**
   * Upsert comments non-destructively (incremental-sync delta pull,
   * WL-0MT2KYCNB000CYWV). Unlike {@link importComments} this does NOT clear
   * existing comments first: each provided comment is saved via the store's
   * INSERT OR REPLACE so local comments absent from the incoming delta are
   * preserved, while overlapping ids converge to the merged value.
   *
   * Change detection (WL-0MVK6S4HM005GBCO): unchanged comments are not
   * re-saved, and FTS upkeep is restricted to the affected parent items —
   * looked up by id instead of scanning every work item, so a comment merge
   * never re-indexes the whole store.
   */
  upsertComments(comments: Comment[]): void {
    const affectedItemIds = new Set<string>();
    for (const comment of comments) {
      const stored = this.store.getComment(comment.id);
      if (stored && !this.hasCommentChanged(stored, comment)) {
        continue;
      }
      this.store.saveComment(comment);
      affectedItemIds.add(comment.workItemId);
    }
    // Comment text is embedded in the parent item's FTS row, so refresh only
    // the affected parents.
    if (this.store.ftsAvailable && affectedItemIds.size > 0) {
      for (const id of affectedItemIds) {
        const item = this.store.getWorkItem(id);
        if (item) {
          this.store.upsertFtsEntry(item);
        }
      }
    }
    this.triggerAutoSync();
  }

  /**
   * Import comments destructively (full-snapshot sync).
   *
   * **Change detection (WL-0MVK6S4HM005GBCO)**: comments absent from the
   * incoming set are deleted, unchanged comments are not re-saved, and FTS
   * upkeep is restricted to the parents whose comment text actually changed —
   * a no-change comment import performs zero `saveComment` writes and zero FTS
   * writes instead of clearing and re-indexing every item.
   */
  importComments(comments: Comment[]): void {
    const existingById = new Map<string, Comment>();
    for (const stored of this.store.getAllComments()) {
      existingById.set(stored.id, stored);
    }
    const incomingIds = new Set(comments.map(comment => comment.id));
    // Parents whose FTS row (which embeds comment text) must be refreshed.
    const affectedItemIds = new Set<string>();

    // One transaction for the whole differential persist (clear/save/FTS), so
    // readers never observe a partially-applied comment snapshot.
    this.store.transaction(() => {
      for (const [id, stored] of existingById) {
        if (!incomingIds.has(id)) {
          this.store.deleteComment(id);
          affectedItemIds.add(stored.workItemId);
        }
      }
      for (const comment of comments) {
        const stored = existingById.get(comment.id);
        if (stored && !this.hasCommentChanged(stored, comment)) {
          continue;
        }
        this.store.saveComment(comment);
        affectedItemIds.add(comment.workItemId);
        // A comment that moved between items affects both parents.
        if (stored && stored.workItemId !== comment.workItemId) {
          affectedItemIds.add(stored.workItemId);
        }
      }

      // Re-index only the affected parents (FTS rows embed comment text).
      if (this.store.ftsAvailable) {
        for (const id of affectedItemIds) {
          const item = this.store.getWorkItem(id);
          if (item) {
            this.store.upsertFtsEntry(item);
          }
        }
      }
    });

    this.triggerAutoSync();
  }

  /**
   * Compare a stored comment with an incoming candidate and return true when
   * persisting the candidate would change the stored row.
   *
   * `saveComment()` stores comment text unescaped (`unescapeText`), so the
   * incoming text is normalised the same way before comparison — a re-import
   * of the identical snapshot must not look changed. Optional GitHub mapping
   * fields are normalised (null vs undefined are equivalent).
   */
  private hasCommentChanged(stored: Comment, incoming: Comment): boolean {
    return (
      stored.workItemId !== incoming.workItemId ||
      stored.author !== incoming.author ||
      stored.comment !== unescapeText(incoming.comment ?? '') ||
      stored.createdAt !== incoming.createdAt ||
      JSON.stringify(stored.references ?? []) !== JSON.stringify(incoming.references ?? []) ||
      (stored.githubCommentId ?? null) !== (incoming.githubCommentId ?? null) ||
      (stored.githubCommentUpdatedAt ?? null) !== (incoming.githubCommentUpdatedAt ?? null)
    );
  }

  /**
   * Record comment activity without moving the audit-relevant `updatedAt`.
   *
   * Comment create/update/delete bump `activityAt` only, so ordering/recency
   * features still observe the activity while audit freshness (computed
   * against the content timestamp `updatedAt`) is unaffected
   * (WL-0MUBVH6JM0093KVM). `saveWorkItem` keeps activityAt >= updatedAt.
   */
  private touchWorkItemActivityAt(workItemId: string): void {
    const item = this.store.getWorkItem(workItemId);
    if (!item) {
      return;
    }
    this.store.saveWorkItem({
      ...item,
      // updatedAt is intentionally preserved: comment activity must never
      // invalidate a valid audit (see isAuditFresh).
      activityAt: new Date().toISOString(),
    });
  }
}
