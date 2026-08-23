/**
 * Persistent database for work items with SQLite backend
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { WorkItem, WorkItemPriority, CreateWorkItemInput, UpdateWorkItemInput, WorkItemQuery, Comment, CreateCommentInput, UpdateCommentInput, NextWorkItemResult, DependencyEdge, AuditResult, DemotedParent, RevertedItem } from './types.js';
import { SqlitePersistentStore, FtsSearchResult, PersistentStoreServices, PersistentStoreCacheOptions, LastExportTimestamps } from './persistent-store.js';
import { normalizeStatusValue } from './status-stage-rules.js';

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
 * Result of a conditional update (`updateIfMatches`, the CAS claim).
 * `ok:true` carries the updated item; `ok:false` distinguishes "no such
 * item" from "item no longer in the expected status/stage" (another
 * process won the race).
 */
export interface UpdateIfMatchesResult {
  ok: boolean;
  reason?: 'not-found' | 'stale';
  item?: WorkItem;
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
interface EdgeCache {
  /** inbound dependency edges: toId -> edges[] (items that depend on this item) */
  inbound: Map<string, DependencyEdge[]>;
  /** outbound dependency edges: fromId -> edges[] (items this item depends on) */
  outbound: Map<string, DependencyEdge[]>;
  /** All work items indexed by id for O(1) lookup */
  itemsById: Map<string, WorkItem>;
  /**
   * Children of each parentId (including non-closed children).
   * Built once from loaded items to avoid per-item SQL queries for getChildren().
   */
  childrenByParent: Map<string, WorkItem[]>;
}

/**
 * Build a map of parentId -> direct children from a list of work items.
 */
function buildChildrenByParent(items: WorkItem[]): Map<string, WorkItem[]> {
  const map = new Map<string, WorkItem[]>();
  for (const item of items) {
    if (item.parentId) {
      let list = map.get(item.parentId);
      if (!list) {
        list = [];
        map.set(item.parentId, list);
      }
      list.push(item);
    }
  }
  return map;
}

const UNIQUE_TIME_LENGTH = 9;
const UNIQUE_SEQUENCE_LENGTH = 2;
const UNIQUE_RANDOM_BYTES = 3;
const UNIQUE_RANDOM_LENGTH = 5;
const UNIQUE_ID_LENGTH = UNIQUE_TIME_LENGTH + UNIQUE_SEQUENCE_LENGTH + UNIQUE_RANDOM_LENGTH;
const MAX_ID_GENERATION_ATTEMPTS = 10;

/**
 * Normalize a title into a canonical dedup-comparison key: case-folded with
 * ALL whitespace removed (tabs/newlines collapse away too). `"Same Title"`,
 * `"same  title"` and `" same\ttitle "` all normalize to `"sametitle"` so
 * retried create commands with cosmetic title differences still match
 * (WL-0MSTNG2QF0049B97). The SQL side of `getRecentDuplicate` applies the
 * same transformation to stored titles.
 */
export function normalizeTitleForMatch(title: string): string {
  return title.replace(/\s+/g, '').toLowerCase();
}

export class WorklogDatabase {
  private store: SqlitePersistentStore;
  private prefix: string;
  private jsonlPath: string;
  private silent: boolean;
  private autoSync: boolean;
  private syncProvider?: () => Promise<void>;
  private lockPath: string;
  private _lastIdTime: number = 0;
  private _idSequence: number = 0;
  private _semanticSearch: any | null = null;
  private services: WorklogDatabaseServices;

  constructor(
    prefix: string = 'WI',
    dbPath?: string,
    jsonlPath?: string,
    silent: boolean = false,
    autoSync: boolean = false,
    syncProvider?: () => Promise<void>,
    services?: WorklogDatabaseServices
  ) {
    this.services = services ?? {};
    this.prefix = prefix;
    this.jsonlPath = jsonlPath || (this.services.jsonl?.getDefaultDataPath?.() ?? '.worklog/data.jsonl');
    this.silent = silent;
    this.autoSync = autoSync;
    this.syncProvider = syncProvider;
    this.lockPath = (this.services.fileLock?.getLockPathForJsonl?.(this.jsonlPath) ?? path.join(path.dirname(this.jsonlPath), '.lock'));
    
    // Use default DB path if not provided
    const defaultDbPath = path.join(path.dirname(this.jsonlPath), 'worklog.db');
    const actualDbPath = dbPath || defaultDbPath;
    
    this.store = new SqlitePersistentStore(actualDbPath, !silent, this.services.persistentStoreServices, this.services.cacheOptions);
    
    // Refresh from JSONL only if SQLite is empty (ephemeral JSONL pattern)
    // In the ephemeral pattern, SQLite is the sole runtime source of truth.
    // JSONL only exists transiently during sync operations.
    const itemCount = this.store.countWorkItems();
    if (itemCount === 0) {
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

  private sortItemsByScore(items: WorkItem[], recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore', edgeCache?: EdgeCache): WorkItem[] {
    const now = Date.now();
    const cache = edgeCache ?? this.buildEdgeCache(items);

    // Pre-compute ancestors of in-progress items for O(1) per-item lookup.
    // For each in-progress item, walk up the parent chain and record ancestor IDs.
    const MAX_ANCESTOR_DEPTH = 50;
    const ancestorsOfInProgress = new Set<string>();
    for (const item of items) {
      if (item.status === 'in-progress') {
        let currentParentId = item.parentId ?? null;
        let depth = 0;
        while (currentParentId && depth < MAX_ANCESTOR_DEPTH) {
          ancestorsOfInProgress.add(currentParentId);
          const parent = cache.itemsById.get(currentParentId);
          currentParentId = parent?.parentId ?? null;
          depth++;
        }
      }
    }

    return items.slice().sort((a, b) => {
      const scoreA = this.computeScore(a, now, recencyPolicy, ancestorsOfInProgress, cache);
      const scoreB = this.computeScore(b, now, recencyPolicy, ancestorsOfInProgress, cache);
      if (scoreB !== scoreA) return scoreB - scoreA;
      const createdA = new Date(a.createdAt).getTime();
      const createdB = new Date(b.createdAt).getTime();
      if (createdA !== createdB) return createdA - createdB;
      return a.id.localeCompare(b.id);
    });
  }

  private computeSortIndexOrder(): WorkItem[] {
    const items = this.store.getAllWorkItems();
    const childrenByParent = new Map<string | null, WorkItem[]>();

    for (const item of items) {
      const parentKey = item.parentId ?? null;
      const list = childrenByParent.get(parentKey);
      if (list) {
        list.push(item);
      } else {
        childrenByParent.set(parentKey, [item]);
      }
    }

    const order: WorkItem[] = [];
    const sortSiblings = (list: WorkItem[]): WorkItem[] => {
      return list.slice().sort((a, b) => {
        if (a.sortIndex !== b.sortIndex) {
          return a.sortIndex - b.sortIndex;
        }
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      });
    };

    const traverse = (parentId: string | null) => {
      const children = childrenByParent.get(parentId) || [];
      const sorted = sortSiblings(children);
      for (const child of sorted) {
        order.push(child);
        traverse(child.id);
      }
    };

    traverse(null);
    return order;
  }

  assignSortIndexValues(gap: number): { updated: number } {
    const ordered = this.computeSortIndexOrder();
    let updated = 0;
    for (let index = 0; index < ordered.length; index += 1) {
      const item = ordered[index];
      const nextSortIndex = (index + 1) * gap;
      if (item.sortIndex !== nextSortIndex) {
        const updatedItem = {
          ...item,
          sortIndex: nextSortIndex,
          updatedAt: new Date().toISOString(),
        };
        this.store.saveWorkItem(updatedItem);
        updated += 1;
      }
    }
    this.triggerAutoSync();
    return { updated };
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
    const ordered = this
      .getAllOrderedByScore(recencyPolicy)
      .filter(item => item.status !== 'completed' && item.status !== 'deleted');
    return this.assignSortIndexValuesForItems(ordered, gap);
  }

  assignSortIndexValuesForItems(orderedItems: WorkItem[], gap: number): { updated: number } {
    const updated = this.store.batchUpdateSortIndices(orderedItems, gap);
    this.triggerAutoSync();
    return { updated };
  }

  previewSortIndexOrder(gap: number): Array<{ id: string; sortIndex: number } & WorkItem> {
    const ordered = this.computeSortIndexOrder();
    return ordered.map((item, index) => ({
      ...item,
      sortIndex: (index + 1) * gap,
    }));
  }

  previewSortIndexOrderForItems(items: WorkItem[], gap: number): Array<{ id: string; sortIndex: number } & WorkItem> {
    return items.map((item, index) => ({
      ...item,
      sortIndex: (index + 1) * gap,
    }));
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
  ): { results: FtsSearchResult[]; ftsUsed: boolean } {
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

    if (this.store.ftsAvailable) {
      ftsResults = this.store.searchFts(query, options);
      ftsUsed = true;
      this.services.searchMetrics?.increment?.('search.fts');
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

    return { results: merged, ftsUsed };
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
    const allEdges = this.store.getAllDependencyEdges();
    const allItems = items ?? this.store.getAllWorkItems();

    const inbound = new Map<string, DependencyEdge[]>();
    const outbound = new Map<string, DependencyEdge[]>();
    const itemsById = new Map<string, WorkItem>();

    for (const edge of allEdges) {
      // outbound: fromId -> edges (items that depend on others)
      let fromList = outbound.get(edge.fromId);
      if (!fromList) {
        fromList = [];
        outbound.set(edge.fromId, fromList);
      }
      fromList.push(edge);

      // inbound: toId -> edges (items that are depended upon)
      let toList = inbound.get(edge.toId);
      if (!toList) {
        toList = [];
        inbound.set(edge.toId, toList);
      }
      toList.push(edge);
    }

    for (const item of allItems) {
      itemsById.set(item.id, item);
    }

    // Build childrenByParent map once to avoid per-item SQL queries
    const childrenByParent = buildChildrenByParent(allItems);

    return { inbound, outbound, itemsById, childrenByParent };
  }

  // ── Audit Results ────────────────────────────────────────────────

  /**
   * Save or update an audit result for a work item (upsert).
   * Only the latest audit per work item is kept.
   */
  saveAuditResult(audit: { workItemId: string; readyToClose: boolean; auditedAt: string; summary: string | null; rawOutput: string | null; author: string | null }): void {
    this.store.saveAuditResult(audit);
  }

  /**
   * Get the audit result for a work item.
   * Returns null if no audit result exists.
   */
  getAuditResult(workItemId: string): { workItemId: string; readyToClose: boolean; auditedAt: string; summary: string | null; rawOutput: string | null; author: string | null } | null {
    return this.store.getAuditResult(workItemId);
  }

  /**
   * Delete the audit result for a work item.
   */
  deleteAuditResult(workItemId: string): boolean {
    return this.store.deleteAuditResult(workItemId);
  }

  /**
   * Get all audit results (for JSONL export / sync).
   */
  getAllAuditResults(): AuditResult[] {
    return this.store.getAllAuditResults();
  }

  /**
   * Import audit results (upsert, bulk).
   */
  importAuditResults(audits: AuditResult[]): void {
    this.store.saveAuditResults(audits);
    this.triggerAutoSync();
  }

  /**
   * Set the prefix for this database
   */
  setPrefix(prefix: string): void {
    this.prefix = prefix;
  }

  /**
   * Get the current prefix
   */
  getPrefix(): string {
    return this.prefix;
  }

  /**
   * Generate a unique ID for a work item
   */
  private generateId(): string {
    for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
      const id = `${this.prefix}-${this.generateUniqueId()}`;
      if (!this.store.getWorkItem(id)) {
        return id;
      }
    }
    throw new Error('Unable to generate a unique work item ID');
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
    for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
      const id = `${this.prefix}-C${this.generateUniqueId()}`;
      if (!this.store.getComment(id)) {
        return id;
      }
    }
    throw new Error('Unable to generate a unique comment ID');
  }

  /**
   * Generate a globally unique, human-readable identifier.
   * Uses a sequence counter to ensure deterministic ordering when multiple
   * IDs are generated within the same millisecond.
   */
  private generateUniqueId(): string {
    const now = Date.now();
    if (now !== this._lastIdTime) {
      this._lastIdTime = now;
      this._idSequence = 0;
    } else {
      this._idSequence++;
    }
    const timeRaw = now.toString(36).toUpperCase();
    if (timeRaw.length > UNIQUE_TIME_LENGTH) {
      throw new Error('Timestamp overflow while generating unique ID');
    }
    const timePart = timeRaw.padStart(UNIQUE_TIME_LENGTH, '0');
    const randomBytesValue = randomBytes(UNIQUE_RANDOM_BYTES);
    const randomNumber = randomBytesValue.readUIntBE(0, UNIQUE_RANDOM_BYTES);
    const randomPart = randomNumber.toString(36).toUpperCase().padStart(UNIQUE_RANDOM_LENGTH, '0');
    const sequencePart = this._idSequence.toString(36).toUpperCase().padStart(2, '0');
    const id = `${timePart}${sequencePart}${randomPart}`;
    if (id.length !== UNIQUE_ID_LENGTH) {
      throw new Error('Generated unique ID has unexpected length');
    }
    return id;
  }

  /**
   * Create a new work item
   */
  create(input: CreateWorkItemInput): WorkItem {
    const id = this.generateId();
    const now = new Date().toISOString();
    
      const item: WorkItem = {
      id,
      title: input.title,
      description: input.description || '',
      status: (normalizeStatusValue(input.status) ?? input.status ?? 'open') as WorkItem['status'],
      priority: input.priority || 'medium',
      sortIndex: input.sortIndex ?? 0,
      parentId: input.parentId || null,
      createdAt: now,
      updatedAt: now,
      tags: input.tags || [],
      assignee: input.assignee || '',
      stage: input.stage || '',

      issueType: input.issueType || '',
      createdBy: input.createdBy || '',
      deletedBy: input.deletedBy || '',
      deleteReason: input.deleteReason || '',
      risk: input.risk || '',
      effort: input.effort || '',
      githubIssueNumber: undefined,
      githubIssueId: undefined,
      githubIssueUpdatedAt: undefined,
      // default for the new flag
      needsProducerReview: input.needsProducerReview ?? false,
    };

    this.store.saveWorkItem(item);
    this.store.upsertFtsEntry(item);
    this.triggerSemanticIndex(item);
    // Clear comment caches that triggerSemanticIndex may have populated
    // with stale (empty) data, so subsequent reads see fresh results.
    this.store.clearCommentCaches();
    this.triggerAutoSync();
    return item;
  }

  createWithNextSortIndex(input: CreateWorkItemInput, gap: number = 100): WorkItem {
    const siblings = this.store
      .getAllWorkItems()
      .filter(item => item.parentId === (input.parentId ?? null));
      const ordered = this.orderBySortIndex(siblings);
      const maxSortIndex = ordered.reduce((max, item) => Math.max(max, item.sortIndex ?? 0), 0);
    const sortIndex = maxSortIndex + gap;
    return this.create({ ...input, sortIndex });
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
   */
  getRecentDuplicate(title: string, windowMs: number, prefix?: string): WorkItem | null {
    const effectivePrefix = (prefix ?? this.prefix).toUpperCase();
    return this.store.getRecentDuplicateByNormalizedTitle(
      normalizeTitleForMatch(title),
      windowMs,
      effectivePrefix,
    );
  }

  /**
   * Get a work item by ID
   */
  get(id: string): WorkItem | null {
    return this.store.getWorkItem(id);
  }

  /**
   * Conditional update (compare-and-swap, RCA WL-0MSRBFFLN005W3VT design
   * point 1): apply `input` ONLY if the item's current status/stage match the
   * expected guard. Runs the check and the write inside a single `BEGIN
   * IMMEDIATE` transaction (see `PersistentStore.transactionImmediate`), so
   * two concurrent `wl update --if-status/--if-stage` processes serialize on
   * the SQLite write lock: exactly one observes the expected state and wins;
   * the loser observes the winner's committed transition and fails `stale`
   * without writing.
   *
   * @returns `{ok:true, item}` on success; `{ok:false, reason:'not-found'}`
   * when the id is absent; `{ok:false, reason:'stale'}` when the guard
   * mismatch means another process already changed the item.
   */
  updateIfMatches(
    id: string,
    input: UpdateWorkItemInput,
    expected: { status?: string; stage?: string } = {},
  ): UpdateIfMatchesResult {
    return this.store.transactionImmediate(() => {
      const current = this.store.getWorkItem(id);
      if (!current) {
        return { ok: false, reason: 'not-found' };
      }
      if (expected.status !== undefined) {
        const want = normalizeStatusValue(expected.status) ?? expected.status;
        const have = normalizeStatusValue(current.status) ?? current.status;
        if (want !== have) {
          return { ok: false, reason: 'stale' };
        }
      }
      if (expected.stage !== undefined && current.stage !== expected.stage) {
        return { ok: false, reason: 'stale' };
      }
      const updated = this.update(id, input);
      return updated ? { ok: true, item: updated } : { ok: false, reason: 'not-found' };
    });
  }

  /**
   * Update a work item
   */
  update(id: string, input: UpdateWorkItemInput): WorkItem | null {
    const item = this.store.getWorkItem(id);
    if (!item) {
      return null;
    }

    const previousStatus = item.status;
    const previousStage = item.stage;

    // Build the new state to detect what actually changed
    const updated: WorkItem = {
      ...item,
      ...input,
      id: item.id, // Prevent ID changes
      // Normalize status to canonical hyphenated form (e.g. in_progress -> in-progress)
      status: (normalizeStatusValue(input.status ?? item.status) ?? item.status) as WorkItem['status'],
      createdAt: item.createdAt, // Prevent createdAt changes
      githubIssueNumber: item.githubIssueNumber,
      githubIssueId: item.githubIssueId,
      githubIssueUpdatedAt: item.githubIssueUpdatedAt,
    };

    // Detect whether any tracked field actually changed.  If the update is a
    // no-op (same values as the existing item), preserve the original
    // updatedAt to avoid silent re-timestamping during bulk operations.
    // Note: githubIssueNumber/Id/UpdatedAt are intentionally excluded from
    // this comparison because the update method above explicitly preserves
    // the existing values for these fields (prevents manual update from
    // overwriting GitHub metadata). Only hasWorkItemChanged() checks them.
    const contentFieldsToCompare: (keyof WorkItem)[] = [
      'title', 'description', 'status', 'priority', 'sortIndex', 'parentId',
      'tags', 'assignee', 'stage', 'issueType', 'risk', 'effort'
    ];
    const fieldsToCompare: (keyof WorkItem)[] = [
      ...contentFieldsToCompare,
      'needsProducerReview'
    ];
    // Shared comparator: whitespace-only diffs in title/description are not
    // semantic changes (WL-0MSORD6HC005QVZX). Same normalization as
    // hasWorkItemChanged().
    const hasChanged = this.compareTrackedFields(item, updated, fieldsToCompare);

    if (!hasChanged) {
      // Nothing changed — preserve original updatedAt and return early
      // without writing to the store or triggering autoSync.
      updated.updatedAt = item.updatedAt;
      return updated;
    }

    // At least one tracked field changed.  Check whether a content field
    // actually changed — only then bump the timestamp.  This prevents
    // needsProducerReview-only flips from invalidating audits
    // (WL-0MSN6ZCTN0027U2R).  A metadata-only change still persists the
    // flag but preserves the timestamp so that existing audits remain fresh.
    const contentChanged = this.compareTrackedFields(item, updated, contentFieldsToCompare);
    if (contentChanged) {
      updated.updatedAt = new Date().toISOString();
    } else {
      // Metadata-only change (e.g. needsProducerReview): preserve the
      // original updatedAt so existing audits remain fresh.
      updated.updatedAt = item.updatedAt;
    }

    if (process.env.WL_DEBUG_SQL_BINDINGS) {
      try {
        const repr: any = {};
        for (const k of Object.keys(updated)) {
          try {
            const v = (updated as any)[k];
            repr[k] = { type: v === null ? 'null' : typeof v, constructor: v && v.constructor ? v.constructor.name : null };
          } catch (_e) {
            repr[k] = { type: 'unreadable' };
          }
        }
        console.error('WL_DEBUG_SQL_BINDINGS WorklogDatabase.update prepared updated types:', JSON.stringify(repr, null, 2));
        // Also log description to capture non-string values
        try { console.error('WL_DEBUG_SQL_BINDINGS WorklogDatabase.update description value:', (updated as any).description); } catch (_e) { /* ignore */ }
      } catch (_e) {
        console.error('WL_DEBUG_SQL_BINDINGS WorklogDatabase.update: failed to prepare updated log');
      }
    }

    this.store.saveWorkItem(updated);
    this.store.upsertFtsEntry(updated);
    this.triggerSemanticIndex(updated);
    this.triggerAutoSync();

    if (previousStatus !== updated.status || previousStage !== updated.stage) {
      // Reconcile the item itself (e.g., re-block when reopened while
      // active blockers still exist, or unblock when all blockers completed
      // if the item was previously manually blocked without blockers).
      this.reconcileDependentStatus(id);
      // Reconcile all items that depend on this item
      if (this.listDependencyEdgesTo(id).length > 0) {
        this.reconcileDependentsForTarget(id);
      }
    }
    return updated;
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
   */
  delete(id: string, recursive: boolean = true): boolean {
    const item = this.store.getWorkItem(id);
    if (!item) {
      return false;
    }

    // Recursively delete all descendants first (children, grandchildren, etc.)
    if (recursive) {
      const descendants = this.getDescendants(id);
      // Delete from leaf to root so parent-child relationships are handled
      // in reverse depth order (descendants sorted deepest-first)
      const deepestFirst = [...descendants].sort((a, b) => {
        const depthA = this.getDepth(a.id);
        const depthB = this.getDepth(b.id);
        return depthB - depthA;
      });
      for (const descendant of deepestFirst) {
        this.deleteSingle(descendant.id);
      }
    }

    // Now delete the item itself
    return this.deleteSingle(id);
  }

  /**
   * Internal: Mark a single work item as deleted (no recursive child handling).
   */
  private deleteSingle(id: string): boolean {
    const item = this.store.getWorkItem(id);
    if (!item) {
      return false;
    }

    const updated: WorkItem = {
      ...item,
      status: 'deleted',
      // Preserve the existing stage so UI/clients can still show where the
      // item was in the workflow when it was deleted. Clearing the stage
      // caused unexpected regressions in clients/tests that expect the
      // original stage to be retained.
      stage: item.stage,
      updatedAt: new Date().toISOString(),
    };

    this.store.saveWorkItem(updated);
    this.store.deleteFtsEntry(id);
    this.removeFromSemanticIndex(id);
    this.triggerAutoSync();
    if (this.listDependencyEdgesTo(id).length > 0) {
      this.reconcileDependentsForTarget(id);
    }
    return true;
  }

  /**
   * List all work items
   */
  list(query?: WorkItemQuery): WorkItem[] {
    let items = this.store.getAllWorkItems();

      if (query) {
      if (query.status && query.status.length > 0) {
        // Status values are normalized to hyphenated form on write/import,
        // so we normalize each query value for comparison.
        const normalizedStatuses = query.status.map(s => normalizeStatusValue(s) ?? s);
        items = items.filter(item => normalizedStatuses.includes(item.status));
      }
      if (query.priority) {
        items = items.filter(item => item.priority === query.priority);
      }
      if (query.parentId !== undefined) {
        items = items.filter(item => item.parentId === query.parentId);
      }
      if (query.rootOnly) {
        items = items.filter(item => item.parentId === null);
      }
      if (query.tags && query.tags.length > 0) {
        items = items.filter(item => 
          query.tags!.some(tag => item.tags.includes(tag))
        );
      }
      if (query.assignee) {
        items = items.filter(item => item.assignee === query.assignee);
      }
      if (query.stage) {
        items = items.filter(item => item.stage === query.stage);
      }
      if (query.issueType) {
        items = items.filter(item => item.issueType === query.issueType);
      }
      if (query.createdBy) {
        items = items.filter(item => item.createdBy === query.createdBy);
      }
      if (query.deletedBy) {
        items = items.filter(item => item.deletedBy === query.deletedBy);
      }
      if (query.deleteReason) {
        items = items.filter(item => item.deleteReason === query.deleteReason);
      }
      if (query.needsProducerReview !== undefined) {
        items = items.filter(item => Boolean(item.needsProducerReview) === Boolean(query.needsProducerReview));
      }
    }

    return items;
  }

  /**
   * Get children of a work item
   */
  getChildren(parentId: string): WorkItem[] {
    return this.store.getAllWorkItems().filter(
      item => item.parentId === parentId
    );
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
   */
  cascadePriorityDowngrade(parentId: string, newPriority: WorkItemPriority): WorkItem[] {
    if (newPriority === 'critical') {
      return [];
    }
    const downgraded: WorkItem[] = [];
    const children = this.getChildren(parentId);
    for (const child of children) {
      if (child.priority === 'critical') {
        const updated = this.update(child.id, { priority: 'high' });
        if (updated) {
          downgraded.push(updated);
        }
      }
    }
    return downgraded;
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
   */
  demoteParentOnChildAdded(parentId: string): DemotedParent | null {
    const parent = this.get(parentId);
    if (!parent) {
      return null;
    }
    const eligible = parent.status === 'completed' || parent.stage === 'in_review';
    if (!eligible) {
      return null;
    }
    const from = { status: parent.status, stage: parent.stage };
    const updated = this.update(parentId, { status: 'open', stage: 'plan_complete' });
    if (!updated) {
      return null;
    }
    return {
      parent: updated,
      from,
      to: { status: updated.status, stage: updated.stage },
    };
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
   */
  revertToPlanComplete(itemId: string): RevertedItem | null {
    const item = this.get(itemId);
    if (!item) {
      return null;
    }
    const eligible = item.status === 'completed' && item.stage === 'in_review';
    if (!eligible) {
      return null;
    }
    const from = { status: item.status, stage: item.stage };
    const updated = this.update(itemId, { status: 'open', stage: 'plan_complete' });
    if (!updated) {
      return null;
    }
    return {
      item: updated,
      from,
      to: { status: updated.status, stage: updated.stage },
    };
  }

  /**
   * Get the number of direct children for each work item.
   * Returns a Map<itemId, count>.
   * If items is provided, only counts within that subset; otherwise uses all items.
   * This is more efficient than calling getChildren() for every item individually
   * because it computes the full map in a single O(n) pass.
   */
  getChildCounts(items?: WorkItem[]): Map<string, number> {
    const source = items ?? this.store.getAllWorkItems();
    const counts = new Map<string, number>();
    for (const item of source) {
      if (item.parentId) {
        counts.set(item.parentId, (counts.get(item.parentId) ?? 0) + 1);
      }
    }
    return counts;
  }

  /**
   * Get children that are not closed or deleted
   */
  private getNonClosedChildren(parentId: string, edgeCache?: EdgeCache): WorkItem[] {
    const children = edgeCache
      ? (edgeCache.childrenByParent.get(parentId) ?? [])
      : this.getChildren(parentId);
    return children.filter(
      item => item.status !== 'completed' && item.status !== 'deleted'
    );
  }

  /**
   * Get all descendants (children, grandchildren, etc.) of a work item
   */
  getDescendants(parentId: string): WorkItem[] {
    const descendants: WorkItem[] = [];
    const children = this.getChildren(parentId);
    
    for (const child of children) {
      descendants.push(child);
      descendants.push(...this.getDescendants(child.id));
    }
    
    return descendants;
  }

  /**
   * Check if a work item is a leaf node (has no children)
   */
  isLeafNode(itemId: string): boolean {
    return this.getChildren(itemId).length === 0;
  }

  /**
   * Get all leaf nodes that are descendants of a parent item
   */
  getLeafDescendants(parentId: string): WorkItem[] {
    const descendants = this.getDescendants(parentId);
    return descendants.filter(item => this.isLeafNode(item.id));
  }

  /**
   * Get the depth of an item in the tree (root = 0)
   */
  private getDepth(itemId: string): number {
    let depth = 0;
    let current = this.get(itemId);

    while (current && current.parentId) {
      depth += 1;
      current = this.get(current.parentId);
    }

    return depth;
  }

  /**
   * Ordinal rank of a risk level on the canonical scale
   * (Low < Medium < High < Severe/Critical). Both the type-level spelling
   * ('Severe') and the icon-scale spelling ('critical') map to the top
   * rank. Agents may produce verbose risk fields like "Medium — NVIDIA
   * driver changes…"; extract the leading keyword before any delimiter.
   * Unset/unknown values map to null (fail-closed: they are never
   * matched by an at-most risk filter).
   */
  private riskOrdinal(risk: string | undefined | null): number | null {
    // Extract the leading keyword before any delimiter (—, -, :, whitespace).
    const normalized = (risk ?? '').trim().toLowerCase().split(/[-:–—\s]+/)[0];
    switch (normalized) {
      case 'low': return 1;
      case 'medium': return 2;
      case 'high': return 3;
      case 'severe':
      case 'critical': return 4;
      default: return null;
    }
  }

  /**
   * Ordinal rank of an effort level on the canonical scale
   * (Extra Small < Small < Medium < Large < Extra Large). Accepts both the
   * short CLI spellings (XS/S/M/L/XL) and the long-form effort-and-risk
   * skill spellings (extra small/small/medium/large/extra large),
   * normalized case-insensitively. Agents may produce verbose effort fields
   * like "1–4 hours — Small. Diagnostic investigation…"; extract the
   * keyword via exact match on stripped string first, then fall back to
   * word-boundary search.
   * Unset/unknown values map to null (fail-closed: they are never matched
   * by an at-most effort filter).
   */
  private effortOrdinal(effort: string | undefined | null): number | null {
    const normalized = (effort ?? '').trim().toLowerCase();
    // Try exact match on stripped version first (simple cases: "small", "medium",
    // "Extra Small" → "extrasmall"). If that fails, fall back to searching for
    // the keyword anywhere in the string — agents produce verbose fields like
    // "1–4 hours — Small. Diagnostic investigation…" (keyword after the dash).
    const stripped = normalized.replace(/[\s-]+/g, '');
    switch (stripped) {
      case 'xs':
      case 'extrasmall': return 1;
      case 's':
      case 'small': return 2;
      case 'm':
      case 'medium': return 3;
      case 'l':
      case 'large': return 4;
      case 'xl':
      case 'extralarge': return 5;
      default:
        // Fallback: search for the keyword bounded by non-word characters.
        // Checked in order of specificity (longest first) so "small" wins over "s".
        if (/(?:^|\W)extrasmall(?:\W|$)/.test(normalized)) return 1;
        if (/(?:^|\W)xs(?:\W|$)/.test(normalized)) return 1;
        if (/(?:^|\W)small(?:\W|$)/.test(normalized)) return 2;
        if (/(?:^|\W)s(?:\W|$)/.test(normalized)) return 2;
        if (/(?:^|\W)extralarge(?:\W|$)/.test(normalized)) return 5;
        if (/(?:^|\W)large(?:\W|$)/.test(normalized)) return 4;
        if (/(?:^|\W)xl(?:\W|$)/.test(normalized)) return 5;
        return null;
    }
  }

  /**
   * True when an item satisfies the optional at-most risk/effort filters.
   * Fail-closed: an unset/unknown risk or effort on the item (or an invalid
   * filter level) never matches.
   */
  private matchesRiskEffort(item: WorkItem, risk?: string, effort?: string): boolean {
    if (risk !== undefined && risk !== '') {
      const level = this.riskOrdinal(risk);
      const ord = this.riskOrdinal(item.risk);
      if (level === null || ord === null || ord > level) return false;
    }
    if (effort !== undefined && effort !== '') {
      const level = this.effortOrdinal(effort);
      const ord = this.effortOrdinal(item.effort);
      if (level === null || ord === null || ord > level) return false;
    }
    return true;
  }

  /**
   * Get numeric priority value for comparisons
   */
  private getPriorityValue(priority?: string): number {
    const priorityOrder: { [key: string]: number } = {
      'critical': 4,
      'high': 3,
      'medium': 2,
      'low': 1,
    };

    if (!priority) return 0;
    return priorityOrder[priority] ?? 0;
  }

  /**
   * Compute the effective priority of a candidate work item.
   *
   * Effective priority is the maximum of:
   *   - The item's own priority
   *   - The priority of any active (non-completed, non-deleted) item that
   *     depends on this item (i.e., this item is a prerequisite for)
   *
   * This implements transparent, deterministic priority inheritance:
   * an item that blocks a critical task is elevated to critical effective
   * priority for tie-breaking in sortIndex selection.
   *
   * Results are cached in the optional `cache` map to avoid redundant
   * dependency lookups across a candidate pool.
   *
   * @returns Object with numeric value, human-readable reason, and optional
   *          inheritedFrom item ID
   */
  computeEffectivePriority(
    item: WorkItem,
    cache?: Map<string, { value: number; reason: string; inheritedFrom?: string }>,
    edgeCache?: EdgeCache,
    items?: WorkItem[]
  ): { value: number; reason: string; inheritedFrom?: string } {
    // Check cache first
    if (cache) {
      const cached = cache.get(item.id);
      if (cached) return cached;
    }

    const ownValue = this.getPriorityValue(item.priority);
    let maxInheritedValue = 0;
    let inheritedFromId: string | undefined;
    let inheritedFromPriority: string | undefined;

    // Check inbound dependency edges: items that depend on this item
    const inboundEdges = edgeCache
      ? (edgeCache.inbound.get(item.id) ?? [])
      : this.listDependencyEdgesTo(item.id);
    for (const edge of inboundEdges) {
      const dependent = edgeCache
        ? (edgeCache.itemsById.get(edge.fromId) ?? null)
        : this.get(edge.fromId);
      if (!dependent) continue;
      // Only inherit from active items (not completed or deleted)
      if (dependent.status === 'completed' || dependent.status === 'deleted') continue;
      // Skip dependents that are in an in-progress parent subtree —
      // children of in-progress parents must not influence priority
      // inheritance for their blockers, as they should be invisible to
      // the selection algorithm.
      if (items && this.isInProgressSubtree(dependent, items)) continue;
      const depValue = this.getPriorityValue(dependent.priority);
      if (depValue > maxInheritedValue) {
        maxInheritedValue = depValue;
        inheritedFromId = dependent.id;
        inheritedFromPriority = dependent.priority;
      }
    }

    // Also check if this item is a child that implicitly blocks its parent
    if (item.parentId) {
      const parent = edgeCache
        ? (edgeCache.itemsById.get(item.parentId) ?? null)
        : this.get(item.parentId);
      if (parent && parent.status !== 'completed' && parent.status !== 'deleted') {
        // A non-closed child blocks its parent — inherit parent's priority
        const parentValue = this.getPriorityValue(parent.priority);
        if (parentValue > maxInheritedValue) {
          maxInheritedValue = parentValue;
          inheritedFromId = parent.id;
          inheritedFromPriority = parent.priority;
        }
      }
    }

    const effectiveValue = Math.max(ownValue, maxInheritedValue);

    let result: { value: number; reason: string; inheritedFrom?: string };
    if (effectiveValue > ownValue && inheritedFromId) {
      result = {
        value: effectiveValue,
        reason: `effective priority: ${inheritedFromPriority}, inherited from ${inheritedFromId}`,
        inheritedFrom: inheritedFromId,
      };
    } else {
      result = {
        value: ownValue,
        reason: `own priority: ${item.priority || 'none'}`,
      };
    }

    // Cache the result
    if (cache) {
      cache.set(item.id, result);
    }

    return result;
  }

  /**
   * Select the highest priority blocking candidate with critical reference
   */
  private selectHighestPriorityBlocking(pairs: { blocking: WorkItem; critical: WorkItem }[], sortOrderCache?: WorkItem[]): { blocking: WorkItem; critical: WorkItem } | null {
    if (pairs.length === 0) {
      return null;
    }

    const orderedBlocking = this.orderBySortIndex(pairs.map(pair => pair.blocking), sortOrderCache);
    const selected = orderedBlocking[0];
    return selected ? pairs.find(pair => pair.blocking.id === selected.id) ?? null : null;
  }

  /**
   * Handle critical-path escalation (Stage 2 of the next-item algorithm).
   *
   * Critical items are always prioritized above non-critical items:
   *   - Unblocked criticals are selected first by sortIndex (priority+age fallback).
   *   - Blocked criticals surface their direct blocker (child or dependency edge)
   *     with the highest effective priority.
   *   - An unblocked critical always wins over a blocker of a non-critical item.
   *
   * Operates on the FULL item set so that critical items outside the
   * assignee/search filter are still considered — only the final blocker
   * selection is filtered by assignee/search.
   *
   * @returns NextWorkItemResult if critical escalation selects an item, null otherwise
   */
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
    const {
      assignee,
      searchTerm,
      risk,
      effort,
      excluded,
      debugPrefix = '[critical]',
      includeInProgress = false,
      edgeCache,
    } = options;

    // Find all critical items from the full set, excluding only
    // deleted items (these are never actionable).
    // In-progress items are excluded by default (not actionable for escalation)
    // unless --include-in-progress is set.
    // Items in the in_review stage are preserved even if their status
    // is 'completed' since they need to appear in wl next for review.
    // Items in the done stage are excluded (terminal, not actionable)
    // (WL-0MSGRJWRX0068W3W).
    const criticalItems = allItems.filter(
      item =>
        item.priority === 'critical' &&
        item.status !== 'deleted' &&
        (item.status !== 'completed' || item.stage === 'in_review') &&
        item.stage !== 'done' &&
        (includeInProgress || item.status !== 'in-progress')
    );
    this.debug(`${debugPrefix} critical items from full set=${criticalItems.length}`);

    if (criticalItems.length === 0) {
      return null;
    }

    // ── Unblocked criticals ──
    // An item is "unblocked" if it is not blocked AND has no non-closed children
    // (children act as implicit blockers).
    const unblockedCriticals = criticalItems.filter(
      item => item.status !== 'blocked' && this.getNonClosedChildren(item.id, edgeCache).length === 0
    );
    this.debug(`${debugPrefix} unblocked criticals=${unblockedCriticals.length}`);

    if (unblockedCriticals.length > 0) {
      // Apply assignee/search to unblocked criticals — only return items
      // that match the caller's filters (including risk/effort).
      let selectable = this.applyFilters(unblockedCriticals, assignee, searchTerm)
        .filter(item => this.matchesRiskEffort(item, risk, effort));
      if (excluded && excluded.size > 0) {
        selectable = selectable.filter(item => !excluded.has(item.id));
      }
      this.debug(`${debugPrefix} unblocked criticals after filters=${selectable.length}`);

      if (selectable.length > 0) {
        // Strict root-only (WL-0MS964SIA0057ABR): only root criticals are
        // selectable here. Children are hidden entirely (no orphan promotion)
        // and their parent, if actionable, competes in Stage 5.
        selectable = selectable.filter(item => !item.parentId);
      }

      if (selectable.length > 0) {
        const selected = this.selectBySortIndex(selectable, undefined, options.sortOrderCache, options.edgeCache);
        this.debug(`${debugPrefix} selected unblocked critical=${selected?.id || ''} title="${selected?.title || ''}"`);
        return {
          workItem: selected,
          reason: `Next unblocked critical item by sort_index${selected ? ` (priority ${selected.priority})` : ''}`
        };
      }
    }

    // ── Blocked criticals ──
    // For each blocked critical, gather its direct blockers (children + dependency edges)
    // from the full item store, then select the best blocker that passes filters.
    const blockedCriticals = criticalItems.filter(
      item => item.status === 'blocked'
    );
    this.debug(`${debugPrefix} blocked criticals=${blockedCriticals.length}`);

    if (blockedCriticals.length > 0) {
      const blockingPairs: { blocking: WorkItem; critical: WorkItem }[] = [];

      for (const critical of blockedCriticals) {
        // If the blocked critical has a parent that is a valid (open, not
        // deleted/completed/in-progress) candidate, skip surfacing its
        // blockers — the parent will compete in Stage 5 (open item selection)
        // instead. This ensures that children are not surfaced individually
        // when their parent is a valid candidate (WL-0MQFIYPZK00680H1).
        if (critical.parentId) {
          const critParent = allItems.find(p => p.id === critical.parentId);
          if (
            critParent &&
            critParent.status !== 'deleted' &&
            critParent.status !== 'completed' &&
            critParent.status !== 'in-progress'
          ) {
            this.debug(`${debugPrefix}   skip blocker pairs for ${critical.id} (valid parent ${critical.parentId})`);
            continue;
          }
        }

        // Child blockers (non-closed children implicitly block a parent)
        const blockingChildren = this.getNonClosedChildren(critical.id, options.edgeCache);
        for (const child of blockingChildren) {
          if (excluded?.has(child.id)) continue;
          blockingPairs.push({ blocking: child, critical });
          this.debug(`${debugPrefix}   blocker: child ${child.id} ("${child.title}") blocks critical ${critical.id}`);
        }

        // Dependency-edge blockers
        const dependencyBlockers = this.getActiveDependencyBlockers(critical.id, options.edgeCache);
        for (const blocker of dependencyBlockers) {
          if (excluded?.has(blocker.id)) continue;
          blockingPairs.push({ blocking: blocker, critical });
          this.debug(`${debugPrefix}   blocker: dep ${blocker.id} ("${blocker.title}") blocks critical ${critical.id}`);
        }
      }

      // Apply assignee/search filters to the blockers only
      const filteredBlockingPairs = blockingPairs.filter(pair =>
        this.applyFilters([pair.blocking], assignee, searchTerm).length > 0
      ).filter(pair => this.matchesRiskEffort(pair.blocking, risk, effort));
      this.debug(`${debugPrefix} blocking candidates=${blockingPairs.length} after filters=${filteredBlockingPairs.length}`);

      // Strict root-only (WL-0MS964SIA0057ABR): never surface child blockers.
      // Resolve each blocker to its root parent when the parent is selectable;
      // drop blockers whose parent is not selectable (children are hidden
      // entirely — no orphan promotion).
      const rootBlockingPairs: { blocking: WorkItem; critical: WorkItem }[] = [];
      for (const pair of filteredBlockingPairs) {
        const resolved = this.resolveBlockerToRoot(pair.blocking, allItems, assignee, searchTerm, excluded);
        if (resolved && this.matchesRiskEffort(resolved, risk, effort)) {
          rootBlockingPairs.push({ blocking: resolved, critical: pair.critical });
        }
      }
      this.debug(`${debugPrefix} root-resolved blocking candidates=${rootBlockingPairs.length}`);

      const selectedBlocking = this.selectHighestPriorityBlocking(rootBlockingPairs, options.sortOrderCache);

      if (selectedBlocking) {
        this.debug(`${debugPrefix} selected blocker=${selectedBlocking.blocking.id} ("${selectedBlocking.blocking.title}") for critical ${selectedBlocking.critical.id}`);
        return {
          workItem: selectedBlocking.blocking,
          reason: `Blocking issue for critical item ${selectedBlocking.critical.id} (${selectedBlocking.critical.title})`
        };
      }

      // No actionable blocker found — return the blocked critical itself as a
      // last resort so the user is aware of the stuck critical item.
      let selectableBlocked = this.applyFilters(blockedCriticals, assignee, searchTerm)
        .filter(item => this.matchesRiskEffort(item, risk, effort));
      if (excluded && excluded.size > 0) {
        selectableBlocked = selectableBlocked.filter(item => !excluded.has(item.id));
      }
      // Strict root-only (WL-0MS964SIA0057ABR): only root blocked criticals
      // are eligible for the last-resort selection. Children are hidden
      // entirely (no orphan promotion).
      selectableBlocked = selectableBlocked.filter(item => !item.parentId);
      if (selectableBlocked.length === 0) {
        this.debug(`${debugPrefix} all blocked criticals filtered out by root-only filter — returning null`);
        return null;
      }
      const selectedBlockedCritical = this.selectBySortIndex(selectableBlocked, undefined, options.sortOrderCache, options.edgeCache);
      this.debug(`${debugPrefix} selected blocked critical (fallback)=${selectedBlockedCritical?.id || ''}`);
      return {
        workItem: selectedBlockedCritical,
        reason: 'Blocked critical work item with no identifiable blocking issues'
      };
    }

    // No critical items to escalate
    return null;
  }

  /**
   * Compute a score for an item. Defaults: recencyPolicy='ignore'.
   * Higher score == more desirable.
   */
   private computeScore(
    item: WorkItem,
    now: number,
    recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore',
    ancestorsOfInProgress?: Set<string>,
    edgeCache?: EdgeCache
  ): number {
    // Weights are intentionally fixed and not configurable per request
    //
    // Ranking precedence (highest to lowest):
    //   1. priority          — primary ranking (weight 1000 per level)
    //   2. blocksHighPriority — boost for items that unblock high/critical work
    //   3. in-progress multipliers — boost active items and their ancestors
    //   4. blocked penalty   — heavy penalty for blocked items
    //   5. age / effort / recency — fine-grained tie-breakers
    const WEIGHTS = {
      priority: 1000,
      blocksHighPriority: 500,  // boost when this item unblocks high/critical items
      age: 10, // per day
      updated: 100, // recency boost/penalty
      blocked: -10000,
      effort: 20,
    };

    let score = 0;

    // Priority base
    score += this.getPriorityValue(item.priority) * WEIGHTS.priority;

    // Blocks-high-priority boost: if this item is a dependency prerequisite for
    // active items with high or critical priority, add a proportional boost.
    // This ensures that among equal-priority peers, unblockers rank higher.
    // Uses store-direct access to avoid per-item refreshFromJsonlIfNewer overhead
    // (consistent with the dependency filter at the top of findNextWorkItemFromItems).
    // When edgeCache is provided, uses pre-loaded in-memory Maps instead of
    // per-item SQL queries, eliminating the N+1 query pattern (Bottleneck 1).
    const inboundEdges = edgeCache
      ? (edgeCache.inbound.get(item.id) ?? [])
      : this.store.getDependencyEdgesTo(item.id);
    let maxBlockedPriorityValue = 0;
    for (const edge of inboundEdges) {
      const dependent = edgeCache
        ? (edgeCache.itemsById.get(edge.fromId) ?? null)
        : this.store.getWorkItem(edge.fromId);
      if (dependent && dependent.status !== 'completed' && dependent.status !== 'deleted') {
        const depPriority = this.getPriorityValue(dependent.priority);
        // Only boost for high (3) or critical (4) dependents
        if (depPriority >= 3 && depPriority > maxBlockedPriorityValue) {
          maxBlockedPriorityValue = depPriority;
        }
      }
    }
    if (maxBlockedPriorityValue > 0) {
      // Proportional: critical (4) gets a larger boost than high (3).
      // Scale: high=1.0x, critical=1.33x of the base weight.
      score += (maxBlockedPriorityValue / 3) * WEIGHTS.blocksHighPriority;
    }

    // In-review boost: items awaiting review are surfaced above medium- and
    // low-priority items but below critical- and high-priority items.
    // 600 points = 0.6 * priority weight (1000), which places in-review items
    // in a band between high (3000) and medium (2000) priority levels:
    //   - Critical (4000) + in-review (600) = 4600 > high (3000) ✓
    //   - High (3000) + in-review (600) = 3600 > medium (2000) ✓
    //   - Medium (2000) + in-review (600) = 2600 < high (3000) ✓
    //   - Medium (2000) + in-review (600) = 2600 > medium (2000, non-review) ✓
    //   - Low (1000) + in-review (600) = 1600 < medium (2000) ✓
    if (item.stage === 'in_review') {
      score += 600;
    }

    // Age (createdAt) - small boost per day to avoid starvation
    const ageDays = Math.max(0, (now - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24));
    score += Math.min(ageDays, 365) * WEIGHTS.age;

    // Effort: prefer smaller numeric efforts if present
    if (item.effort) {
      const effortVal = parseFloat(String(item.effort)) || 0;
      if (effortVal > 0) score += (1 / (1 + effortVal)) * WEIGHTS.effort;
    }

    // UpdatedAt recency policy
    if (recencyPolicy !== 'ignore' && item.updatedAt) {
      const updatedHours = (now - new Date(item.updatedAt).getTime()) / (1000 * 60 * 60);
      if (recencyPolicy === 'avoid') {
        // Penalty stronger when updated very recently, decays to zero by 72 hours
        const penaltyFactor = Math.max(0, (72 - updatedHours) / 72);
        score -= penaltyFactor * WEIGHTS.updated;
      } else if (recencyPolicy === 'prefer') {
        // Boost for recent updates (peak within ~48 hours)
        const boostFactor = Math.max(0, (48 - updatedHours) / 48);
        score += boostFactor * WEIGHTS.updated;
      }
    }

    // Blocked status - heavy penalty
    if (item.status === 'blocked') score += WEIGHTS.blocked;

    // In-progress score multiplier boosts (applied after all additive components).
    // Non-stacking: direct in-progress boost takes precedence over ancestor boost.
    // Blocked items receive no boost (the -10000 penalty remains dominant).
    const IN_PROGRESS_BOOST = 1.5;
    const PARENT_IN_PROGRESS_BOOST = 1.25;
    // Apply in-progress / ancestor multipliers non-stacking.
    // Use an explicit multiplier variable to avoid any accidental
    // double-application of boosts if this code is refactored in future.
    let multiplier = 1;
    if (item.status !== 'blocked') {
      if (item.status === 'in-progress') {
        multiplier = IN_PROGRESS_BOOST;
      } else if (ancestorsOfInProgress?.has(item.id)) {
        multiplier = PARENT_IN_PROGRESS_BOOST;
      }
    }
    score *= multiplier;

    return score;
  }

  private orderBySortIndex(items: WorkItem[], sortOrderCache?: WorkItem[]): WorkItem[] {
    const orderedAll = sortOrderCache ?? this.store.getAllWorkItemsOrderedByHierarchySortIndexSkipCompleted();
    const positions = new Map(orderedAll.map((item, index) => [item.id, index]));
    return items.slice().sort((a, b) => {
      const aPos = positions.get(a.id);
      const bPos = positions.get(b.id);
      if (aPos === undefined && bPos === undefined) {
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      }
      if (aPos === undefined) return 1;
      if (bPos === undefined) return -1;
      if (aPos !== bPos) return aPos - bPos;
      return a.id.localeCompare(b.id);
    });
  }

  private selectBySortIndex(
    items: WorkItem[],
    effectivePriorityCache?: Map<string, { value: number; reason: string; inheritedFrom?: string }>,
    sortOrderCache?: WorkItem[],
    edgeCache?: EdgeCache,
    allItems?: WorkItem[]
  ): WorkItem | null {
    if (!items || items.length === 0) return null;
    // When all sortIndex values are the same (including all-zero), fall back to
    // effective priority (descending) then createdAt (ascending / oldest first).
    // Effective priority accounts for priority inheritance from blocked dependents.
    const firstSortIndex = items[0].sortIndex ?? 0;
    const allSame = items.every(item => (item.sortIndex ?? 0) === firstSortIndex);
    if (allSame) {
      const cache = effectivePriorityCache ?? new Map();
      const sorted = items.slice().sort((a, b) => {
        const aEffective = this.computeEffectivePriority(a, cache, edgeCache, allItems);
        const bEffective = this.computeEffectivePriority(b, cache, edgeCache, allItems);
        const priDiff = bEffective.value - aEffective.value;
        if (priDiff !== 0) return priDiff;
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      });
      return sorted[0] ?? null;
    }
    return this.orderBySortIndex(items, sortOrderCache)[0] ?? null;
  }

  /**
   * Consolidated filter pipeline for wl next candidate selection.
   *
   * Removes non-actionable items in a single pass and returns two pools:
   *   - candidates: fully filtered items ready for selection
   *   - criticalPool: items filtered before dep-blocking, with assignee/search
   *     applied, so that critical-path escalation can still find blocked
   *     critical items and surface their blockers
   *
   * Filter stages (in order):
   *   0. Apply stage filter first if specified (before other removals)
   *   1. Remove deleted items
   *   2. Remove completed items (preserving in_review stage)
   *   3. Remove in-progress items (wl next skips items already being worked on)
   *   4. Remove excluded items (batch mode)
   *   5. Apply assignee and search filters
   *   --- criticalPool snapshot taken here ---
   *   6. Remove dependency-blocked items (unless includeBlocked)
   */
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
    const {
      assignee,
      searchTerm,
      stage,
      risk,
      effort,
      excluded,
      includeBlocked = false,
      includeInProgress = false,
      debugPrefix = '[filter]',
    } = options;

    let pool = items;
    this.debug(`${debugPrefix} filter: total=${pool.length}`);

    // 1. Apply stage filter first if specified (before removing completed/deleted)
    if (stage) {
      pool = pool.filter(item => item.stage === stage);
      this.debug(`${debugPrefix} filter: after stage=${stage}=${pool.length}`);
    }

    // 2. Remove deleted items
    pool = pool.filter(item => item.status !== 'deleted');
    this.debug(`${debugPrefix} filter: after deleted=${pool.length}`);

    // 3. Remove completed items (unless stage filter was applied - user is
    //    explicitly filtering by stage and may want completed items in that stage).
    //    Also preserve items in the in_review stage - they need to appear in
    //    wl next for review even though their status is 'completed'.
    //    Also exclude items in the done stage by default (WL-0MSGRJWRX0068W3W) -
    //    done items are terminal and not actionable; explicit --stage done still works.
    if (!stage) {
      pool = pool.filter(
        item =>
          (item.status !== 'completed' || item.stage === 'in_review') &&
          item.stage !== 'done'
      );
      this.debug(`${debugPrefix} filter: after completed/done=${pool.length}`);
    }

    // 4. Remove in-progress items by default (wl next recommends what to work on next,
    //    not what's already being worked on). Skip this filter when --include-in-progress
    //    is set so items already being worked on appear in the output.
    if (!includeInProgress) {
      pool = pool.filter(item => item.status !== 'in-progress');
      this.debug(`${debugPrefix} filter: after in-progress=${pool.length}`);
    } else {
      this.debug(`${debugPrefix} filter: skip in-progress (includeInProgress=true)`);
    }

    // 5. Remove excluded items (batch mode)
    if (excluded && excluded.size > 0) {
      pool = pool.filter(item => !excluded.has(item.id));
      this.debug(`${debugPrefix} filter: after excluded=${pool.length}`);
    }

    // 7. Apply assignee and search filters
    pool = this.applyFilters(pool, assignee, searchTerm);
    this.debug(`${debugPrefix} filter: after assignee/search=${pool.length}`);

    // 7b. Apply risk/effort at-most filters (ordinal, fail-closed on unset).
    // An item is eligible only when its risk ≤ the filter level (Low < Medium
    // < High < Severe) and its effort ≤ the filter level (Extra Small < Small
    // < Medium < Large < Extra Large). Items with unset/empty risk or effort
    // are NEVER matched — an absent estimate is not "≤ low/small" (AC2).
    if (risk !== undefined && risk !== '') {
      const riskLevel = this.riskOrdinal(risk);
      if (riskLevel === null) {
        // Invalid filter level → fail-closed: match nothing.
        pool = [];
      } else {
        pool = pool.filter(item => {
          const ord = this.riskOrdinal(item.risk);
          return ord !== null && ord <= riskLevel;
        });
      }
      this.debug(`${debugPrefix} filter: after risk=${risk}=${pool.length}`);
    }
    if (effort !== undefined && effort !== '') {
      const effortLevel = this.effortOrdinal(effort);
      if (effortLevel === null) {
        // Invalid filter level → fail-closed: match nothing.
        pool = [];
      } else {
        pool = pool.filter(item => {
          const ord = this.effortOrdinal(item.effort);
          return ord !== null && ord <= effortLevel;
        });
      }
      this.debug(`${debugPrefix} filter: after effort=${effort}=${pool.length}`);
    }

    // Snapshot for critical-path escalation (before dep-blocker removal)
    const criticalPool = pool;

    // 8. Remove dependency-blocked items unless opted in
    let candidates = pool;
    if (!includeBlocked) {
      const ec = options.edgeCache;
      candidates = pool.filter(item => {
        const edges = ec
          ? (ec.outbound.get(item.id) ?? [])
          : this.store.getDependencyEdgesFrom(item.id);
        for (const edge of edges) {
          const target = ec
            ? (ec.itemsById.get(edge.toId) ?? null)
            : this.store.getWorkItem(edge.toId);
          if (this.isDependencyActive(target ?? null)) {
            return false;
          }
        }
        return true;
      });
      this.debug(`${debugPrefix} filter: after dep-blocked=${candidates.length}`);
    }

    return { candidates, criticalPool };
  }

  /**
   * Shared next-item selection logic to keep single-item and batch results aligned.
   *
   * Selection proceeds through several phases:
   *   1. Filter candidates via filterCandidates() pipeline.
   *   2. Critical-path escalation: if a critical item is blocked, surface its direct
   *      blocker immediately (bypasses scoring).
   *   3. Non-critical blocker surfacing: if a non-critical blocked item has priority
   *      >= the best open competitor, surface its blocker so the dependency is resolved.
   *   4. Open item selection: SortIndex-based ranking among remaining candidates;
   *      when all sortIndex values are equal, effective priority (descending,
   *      accounting for priority inheritance from blocked dependents) then age
   *      (ascending) break ties.
   */

  /**
   * Resolve a would-be-surfaced blocker to a root-level item (strict root-only,
   * WL-0MS964SIA0057ABR).
   *
   * - Root blockers (no parentId) are returned as-is.
   * - A child blocker is resolved to its parent when the parent is selectable
   *   (a root-level item with an actionable status and no active dependency
   *   blockers, matching the Stage 5 candidate rules). The parent is the unit
   *   of work and is surfaced instead of the child.
   * - Returns null when the blocker is a child whose parent is not selectable
   *   (e.g. the parent is closed/completed/deleted/in-progress/blocked). Such
   *   children are hidden entirely — never promoted to root.
   */
  private resolveBlockerToRoot(
    blocker: WorkItem,
    allItems: WorkItem[],
    assignee?: string,
    searchTerm?: string,
    excluded?: Set<string>
  ): WorkItem | null {
    if (!blocker.parentId) {
      return blocker; // already a root blocker
    }
    const parent = allItems.find(p => p.id === blocker.parentId);
    if (!parent) {
      // Parent is missing (deleted) — the child is an orphan; hidden entirely.
      return null;
    }
    // The parent itself must be a root item (no grandparent) so the surfaced
    // item is always root-level.
    if (parent.parentId) {
      return null;
    }
    // Parent must be actionable and not dependency-blocked (matching Stage 5
    // candidate rules: open, not deleted/completed/in-progress/blocked).
    if (
      parent.status === 'deleted' ||
      parent.status === 'completed' ||
      parent.status === 'in-progress' ||
      parent.status === 'blocked'
    ) {
      return null;
    }
    if (this.getActiveDependencyBlockers(parent.id).length > 0) {
      return null;
    }
    if (excluded?.has(parent.id)) {
      return null;
    }
    if (this.applyFilters([parent], assignee, searchTerm).length === 0) {
      return null;
    }
    return parent;
  }

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
    this.debug(`${debugPrefix} assignee=${assignee || ''} search=${searchTerm || ''} stage=${stage || ''} excluded=${excluded?.size || 0} risk=${risk || ''} effort=${effort || ''}`);

    // Build the sort-order cache once from the pre-loaded items array.
    // This avoids an extra full-table scan of all work items from the database.
    const sortOrderCache = this.store.orderItemsByHierarchySortIndexSkipCompleted(items);

    // Shared effective-priority cache: avoids redundant dependency lookups
    // across all selectBySortIndex calls within this invocation.
    const effectivePriorityCache = new Map<string, { value: number; reason: string; inheritedFrom?: string }>();

    // ── Stage 1: Filter pipeline ──
    const { candidates: filteredItems, criticalPool } = this.filterCandidates(items, {
      assignee,
      searchTerm,
      stage,
      risk,
      effort,
      excluded,
      includeBlocked,
      includeInProgress,
      debugPrefix,
      edgeCache,
    });

    // ── Stage 2: Critical-path escalation ──
    // Delegated to handleCriticalEscalation() which operates on the full
    // item set so that critical items outside the assignee/search filter
    // can still surface their blockers.
    // Skip critical escalation when stage filter is specified - user is
    // explicitly filtering by stage and doesn't want escalation to override it.
    if (!stage) {
      const criticalResult = this.handleCriticalEscalation(items, {
        assignee,
        searchTerm,
        excluded,
        includeInProgress,
        risk,
        effort,
        debugPrefix: `${debugPrefix} [critical]`,
        edgeCache,
        sortOrderCache,
      });
      if (criticalResult) {
        return criticalResult;
      }
    }

    // ── Stage 3: Non-critical blocker surfacing ──
    // For non-critical blocked items whose priority is >= the best open
    // competitor, surface their blocker so that the dependency is resolved
    // first.  This mirrors the old selectDeepestInProgress blocked-item
    // handling that was removed during the filter-pipeline consolidation.
    //
    // Blocked items in an in-progress parent subtree are excluded from
    // Stage 3 — the parent represents the unit of work and children should
    // be hidden from wl next results. The existing isInProgressSubtree()
    // filter in Stage 5 already ensures this for open items; Stage 3 must
    // apply the same filtering for blocker surfacing.
    //
    // Skip non-critical blocker surfacing when a stage filter is specified —
    // mirroring the Stage 2 guard above: the user is explicitly filtering by
    // stage and blocker surfacing must not surface items at other stages
    // (WL-0MSP1XJSO007LE3K). A blocker's own stage is not constrained by the
    // stage-filtered candidate pool, so surfacing it would violate the filter.
    // Strict root-only (WL-0MS964SIA0057ABR): tracks whether any would-be
    // blocker was a hidden child whose parent is not selectable. If no blocker
    // can be surfaced and no root candidate remains in Stage 5, wl next
    // returns null with a clear reason rather than surfacing the child.
    let droppedHiddenChildBlocker = false;

    if (!stage) {
      const nonCriticalBlocked = criticalPool.filter(
        item => item.status === 'blocked' && item.priority !== 'critical'
      ).filter(item => !this.isInProgressSubtree(item, items));
      this.debug(`${debugPrefix} non-critical blocked=${nonCriticalBlocked.length}`);

      if (nonCriticalBlocked.length > 0 && filteredItems.length > 0) {
        // Find the highest priority value among open candidates
        const bestCompetitorPriority = Math.max(
          ...filteredItems.map(item => this.getPriorityValue(item.priority))
        );
  
        // Sort blocked items by priority descending so we handle the most
        // important blocked item first
        const sortedBlocked = nonCriticalBlocked.slice().sort(
          (a, b) => this.getPriorityValue(b.priority) - this.getPriorityValue(a.priority)
        );
  
        for (const blockedItem of sortedBlocked) {
          const blockedPriority = this.getPriorityValue(blockedItem.priority);
          if (blockedPriority < bestCompetitorPriority) {
            // Blocked item is lower priority than best open candidate — skip
            continue;
          }
  
          // Blocked item priority >= best competitor: surface its blocker
          const blockingPairs: { blocking: WorkItem; blocked: WorkItem }[] = [];
  
          // Check dependency blockers
          const dependencyBlockers = this.getActiveDependencyBlockers(blockedItem.id, edgeCache);
          for (const blocker of dependencyBlockers) {
            if (excluded?.has(blocker.id)) continue;
            blockingPairs.push({ blocking: blocker, blocked: blockedItem });
          }
  
          // Check child blockers
          const blockingChildren = this.getNonClosedChildren(blockedItem.id, edgeCache);
          for (const child of blockingChildren) {
            if (excluded?.has(child.id)) continue;
            blockingPairs.push({ blocking: child, blocked: blockedItem });
          }
  
          // Apply assignee/search filters to blockers
          let filteredBlockers = blockingPairs.filter(pair =>
            this.applyFilters([pair.blocking], assignee, searchTerm).length > 0
          ).filter(pair => this.matchesRiskEffort(pair.blocking, risk, effort));
  
          // Strict root-only (WL-0MS964SIA0057ABR): child blockers are never
          // surfaced by wl next.
          //  - A child blocker whose parent is a selectable actionable root
          //    candidate is dropped — the parent competes in Stage 5 (open item
          //    selection) and is the unit of work surfaced there.
          //  - A child blocker whose parent is NOT selectable is hidden entirely
          //    (no orphan promotion); if no surfacable blocker remains and no
          //    root candidate exists, wl next returns null with a clear reason.
          const rootOnlyBlockers: { blocking: WorkItem; blocked: WorkItem }[] = [];
          for (const pair of filteredBlockers) {
            if (!pair.blocking.parentId) {
              // Root-level blocker — surfacing it is fine.
              rootOnlyBlockers.push(pair);
              continue;
            }
            // Child blocker: resolve to parent when selectable, else hidden.
            const resolved = this.resolveBlockerToRoot(pair.blocking, items, assignee, searchTerm, excluded);
            if (resolved) {
              // Parent is selectable — it competes in Stage 5 (existing
              // hierarchy awareness, WL-0MQF95NCC0024H61).
              this.debug(`${debugPrefix}   drop child blocker ${pair.blocking.id} (selectable parent ${resolved.id} competes in Stage 5)`);
            } else {
              droppedHiddenChildBlocker = true;
            }
          }
          filteredBlockers = rootOnlyBlockers;
  
          // Filter out blockers that belong to an in-progress parent subtree —
          // children of in-progress parents must not appear as independent
          // wl next results from any stage, including blocker surfacing.
          // This complements the in-progress subtree filter above on the
          // blocked item itself and the existing isInProgressSubtree() filter
          // in Stage 5 (open item selection).
          filteredBlockers = filteredBlockers.filter(pair =>
            !this.isInProgressSubtree(pair.blocking, items)
          );
  
          this.debug(`${debugPrefix} blocker-surfacing: blockedItem=${blockedItem.id} pri=${blockedItem.priority} blockers=${filteredBlockers.length}`);
  
          if (filteredBlockers.length > 0) {
            // Select the best blocker by sort index
            const orderedBlockers = this.orderBySortIndex(filteredBlockers.map(p => p.blocking), sortOrderCache);
            const selectedBlocker = orderedBlockers[0];
            if (selectedBlocker) {
              const pair = filteredBlockers.find(p => p.blocking.id === selectedBlocker.id)!;
              return {
                workItem: selectedBlocker,
                reason: `Blocking issue for ${pair.blocked.priority}-priority item ${pair.blocked.id} (${pair.blocked.title})`
              };
            }
          }
        }
      }
    } // end if (!stage) — Stage 3 skipped under stage filter

    // ── Stage 5: Open item selection ──
    // Select among filtered candidates, returning the best root item
    // without descending into children.
    if (filteredItems.length === 0) {
      return { workItem: null, reason: 'No work items available' };
    }
    this.debug(`${debugPrefix} open candidates=${filteredItems.length}`);

    // Identify root-level candidates: items with no parent. Strict root-only
    // (WL-0MS964SIA0057ABR): orphan promotion is removed — children whose
    // parent is closed/deleted/not in the candidate pool are NOT promoted
    // and are not returned by wl next.
    // Children of in-progress parents are excluded — the entire in-progress
    // subtree should be skipped from wl next recommendations.
    const rootCandidates = filteredItems.filter(item => !item.parentId)
      .filter(item => !this.isInProgressSubtree(item, items));
    this.debug(`${debugPrefix} root candidates=${rootCandidates.length}`);

    if (rootCandidates.length === 0) {
      // Fallback: no root-level candidates. Strict root-only — do not
      // descend into children, and do not promote orphans.
      // Still exclude items in an in-progress subtree even in the fallback path
      // so that the entire in-progress subtree is skipped.
      const fallbackItems = filteredItems.filter(item => !item.parentId && !this.isInProgressSubtree(item, items));
      if (fallbackItems.length === 0) {
        // Clear reason when blockers were hidden children (WL-0MS964SIA0057ABR):
        // the child is hidden entirely and its parent is not selectable.
        if (droppedHiddenChildBlocker) {
          return {
            workItem: null,
            reason: 'No work items available — blockers are child items whose parents are not selectable (children are hidden from wl next)'
          };
        }
        return { workItem: null, reason: 'No work items available' };
      }
      const selected = this.selectBySortIndex(fallbackItems, effectivePriorityCache, sortOrderCache, edgeCache, items);
      this.debug(`${debugPrefix} selected open (fallback)=${selected?.id || ''}`);
      const effectiveInfo = selected ? this.computeEffectivePriority(selected, effectivePriorityCache, edgeCache, items) : null;
      return {
        workItem: selected,
        reason: `Next open item by sort_index${selected ? ` (${effectiveInfo?.inheritedFrom ? effectiveInfo.reason : `priority ${selected.priority}`})` : ''}`
      };
    }

    const selectedRoot = this.selectBySortIndex(rootCandidates, effectivePriorityCache, sortOrderCache, edgeCache, items);
    this.debug(`${debugPrefix} selected root=${selectedRoot?.id || ''}`);

    if (!selectedRoot) {
      return { workItem: null, reason: 'No work items available' };
    }

    // Return the selected root directly — do NOT descend into children.
    // The parent represents the unit of work; children are tracked within it.
    const rootEffectiveInfo = this.computeEffectivePriority(selectedRoot, effectivePriorityCache, edgeCache, items);
    return {
      workItem: selectedRoot,
      reason: `Next open item by sort_index${rootEffectiveInfo ? ` (${rootEffectiveInfo.inheritedFrom ? rootEffectiveInfo.reason : `priority ${selectedRoot.priority}`})` : ''}`
    };
  }

  /**
   * Find the next work item to work on based on priority and creation time
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
    const items = this.store.getAllWorkItems();
    const edgeCache = this.buildEdgeCache(items);
    return this.findNextWorkItemFromItems(items, assignee, searchTerm, undefined, '[next]', includeBlocked, stage, includeInProgress, edgeCache, risk, effort);
  }

  /**
   * Find multiple next work items (up to `count`) using the same selection logic
   * as `findNextWorkItem`, but excluding already-selected items between iterations.
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
    const results: NextWorkItemResult[] = [];
    const excluded = new Set<string>();

    // Load all items and dependency edges once, reuse across batch iterations
    // to avoid N+1 database loads (Bottleneck 4: batch reloads all items per iteration)
    const allItems = this.store.getAllWorkItems();
    const edgeCache = this.buildEdgeCache(allItems);

    for (let i = 0; i < count; i += 1) {
      const result = this.findNextWorkItemFromItems(
        allItems,
        assignee,
        searchTerm,
        excluded,
        `[next batch ${i + 1}/${count}]`,
        includeBlocked,
        stage,
        includeInProgress,
        edgeCache,
        risk,
        effort
      );

      results.push(result);
      if (result.workItem) {
        excluded.add(result.workItem.id);
        // Also exclude all descendants so children of returned parents
        // are never surfaced in batch results (AC #4)
        const descendants = this.getDescendants(result.workItem.id);
        for (const desc of descendants) {
          excluded.add(desc.id);
        }
      }
    }

    return results;
  }

  /**
   * Apply assignee and search term filters to a list of work items
   */
  private applyFilters(items: WorkItem[], assignee?: string, searchTerm?: string): WorkItem[] {
    let filtered = items;

    // Filter by assignee if provided
    if (assignee) {
      filtered = filtered.filter(item => item.assignee === assignee);
    }

    // Filter by search term if provided (fuzzy match against id, title, description, and comments)
    if (searchTerm) {
      const lowerSearchTerm = searchTerm.toLowerCase();

      // Batch-load all comments once into a Map<workItemId, commentText[]>
      // to avoid N+1 per-item comment queries (Bottleneck 5)
      const allComments = this.store.getAllComments();
      const commentsByItemId = new Map<string, string[]>();
      for (const comment of allComments) {
        let list = commentsByItemId.get(comment.workItemId);
        if (!list) {
          list = [];
          commentsByItemId.set(comment.workItemId, list);
        }
        list.push(comment.comment);
      }

      filtered = filtered.filter(item => {
        const idMatch = item.id.toLowerCase().includes(lowerSearchTerm);
        // Check title and description
        const titleMatch = item.title.toLowerCase().includes(lowerSearchTerm);
        const descriptionMatch = item.description?.toLowerCase().includes(lowerSearchTerm) || false;

        // Check comments from the pre-loaded batch
        const itemComments = commentsByItemId.get(item.id);
        const commentMatch = itemComments
          ? itemComments.some(comment => comment.toLowerCase().includes(lowerSearchTerm))
          : false;

        return idMatch || titleMatch || descriptionMatch || commentMatch;
      });
    }

    return filtered;
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
    const items = this.store.getAllWorkItems();
    const cache = this.buildEdgeCache(items);
    return this.sortItemsByScore(items, recencyPolicy, cache);
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
   * (WL-0MSORD6HC005QVZX). All other fields use strict equality; arrays
   * (tags) are compared by value.
   *
   * Shared by {@link hasWorkItemChanged} (16-field tracked set, used by
   * import()/upsertItems()) and the no-op guard in {@link update} (13-field
   * set, excluding the GitHub metadata fields).
   */
  private compareTrackedFields(oldItem: WorkItem, newItem: WorkItem, fields: (keyof WorkItem)[]): boolean {
    return fields.some(f => {
      const oldVal = oldItem[f];
      const newVal = newItem[f];
      if (f === 'title' || f === 'description') {
        // Whitespace-only differences (trailing newline strip/normalization)
        // are not semantic changes — compare normalized text only.
        return String(oldVal ?? '').trim() !== String(newVal ?? '').trim();
      }
      if (Array.isArray(oldVal) && Array.isArray(newVal)) {
        return JSON.stringify(oldVal) !== JSON.stringify(newVal);
      }
      return oldVal !== newVal;
    });
  }

  /**
   * Compare an existing work item against a candidate and return true if any
   * tracked field has semantically changed.
   *
   * Uses the same field set and comparison logic as the no-op guard in {@link update}
   * (via {@link compareTrackedFields}).
   */
  private hasWorkItemChanged(oldItem: WorkItem, newItem: WorkItem): boolean {
    const fieldsToCompare: (keyof WorkItem)[] = [
      'title', 'description', 'status', 'priority', 'sortIndex', 'parentId',
      'tags', 'assignee', 'stage', 'issueType', 'risk', 'effort',
      'needsProducerReview', 'githubIssueNumber', 'githubIssueId',
      'githubIssueUpdatedAt'
    ];
    return this.compareTrackedFields(oldItem, newItem, fieldsToCompare);
  }

  /**
   * Import work items by **replacing** all existing data.
   *
   * **WARNING — DESTRUCTIVE**: This method calls `clearWorkItems()` (DELETE
   * FROM workitems) before re-inserting the provided items. If `dependencyEdges`
   * is supplied it also calls `clearDependencyEdges()` first. Any items or
   * edges NOT included in the arguments will be permanently deleted.
   *
   * **Atomic**: The clear-and-re-insert cycle is wrapped in a SQLite
   * transaction so that concurrent readers always see either the old
   * complete state or the new complete state — never an empty or
   * partially-populated database. This prevents the race condition where
   * another Pi TUI instance's selection list appears empty or stale during
   * a sync operation.
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
   * Comparison is whitespace-insensitive for `title` and `description`
   * (via {@link compareTrackedFields}): trailing-newline strips / leading or
   * trailing whitespace / blank-line runs do NOT count as semantic changes,
   * so `wl sync` does not re-timestamp items whose meaningful content never
   * changed (WL-0MSORD6HC005QVZX). The incoming (normalized) content is still
   * persisted — only `updatedAt` is preserved.
   *
   * @param items - The full set of work items to store.
   * @param dependencyEdges - Optional full set of dependency edges. When
   *   provided, existing edges are cleared and replaced with these.
   * @param auditResults - Optional full set of audit results. When provided,
   *   existing audit results are replaced with these.
   */
  import(items: WorkItem[], dependencyEdges?: DependencyEdge[], auditResults?: AuditResult[]): void {
    // Snapshot existing items before clearing so we can detect unchanged items
    // and preserve their updatedAt timestamps.
    const existingItems = new Map<string, WorkItem>();
    for (const existing of this.store.getAllWorkItems()) {
      existingItems.set(existing.id, existing);
    }

    // Wrap the clear-and-re-insert in a transaction so that concurrent
    // readers never see an empty or partially-populated database during sync.
    // This matches the pattern used by SqlitePersistentStore.importData().
    this.store.transaction(() => {
      this.store.clearWorkItems();
      for (const item of items) {
        const existing = existingItems.get(item.id);
        if (existing && !this.hasWorkItemChanged(existing, item)) {
          // No semantic change — preserve the existing updatedAt
          this.store.saveWorkItem({ ...item, updatedAt: existing.updatedAt });
        } else if (existing) {
          // Semantic change detected — bump the timestamp
          this.store.saveWorkItem({ ...item, updatedAt: new Date().toISOString() });
        } else {
          // New item — use the incoming updatedAt as-is
          this.store.saveWorkItem(item);
        }
      }
      if (dependencyEdges) {
        this.store.clearDependencyEdges();
        for (const edge of dependencyEdges) {
          if (this.store.getWorkItem(edge.fromId) && this.store.getWorkItem(edge.toId)) {
            this.store.saveDependencyEdge(edge);
          }
        }
      }
      if (auditResults) {
        this.store.saveAuditResults(auditResults);
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
   * whitespace-insensitive for `title`/`description`), the save is entirely
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
      // Either a new item or a semantic change — bump the timestamp
      const itemToSave = existing
        ? { ...item, updatedAt: new Date().toISOString() }
        : item;
      this.store.saveWorkItem(itemToSave);
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
     this.touchWorkItemUpdatedAt(input.workItemId);
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
     this.touchWorkItemUpdatedAt(comment.workItemId);
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
        this.touchWorkItemUpdatedAt(comment.workItemId);
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
   */
  upsertComments(comments: Comment[]): void {
    for (const comment of comments) {
      this.store.saveComment(comment);
    }
    this.triggerAutoSync();
  }

  /**
   * Import comments
   */
  importComments(comments: Comment[]): void {
    this.store.clearComments();
    for (const comment of comments) {
      this.store.saveComment(comment);
    }
    this.triggerAutoSync();
  }

  private touchWorkItemUpdatedAt(workItemId: string): void {
    const item = this.store.getWorkItem(workItemId);
    if (!item) {
      return;
    }
    this.store.saveWorkItem({
      ...item,
      updatedAt: new Date().toISOString(),
    });
  }
}
