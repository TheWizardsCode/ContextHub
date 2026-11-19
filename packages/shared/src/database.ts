/**
 * Persistent database for work items with SQLite backend.
 *
 * This file is the **façade** of the decomposed shared data layer: the
 * `WorklogDatabase` class keeps the public surface while each concern lives in
 * its own module under `./database/` (`context`, `work-items`, `hierarchy`,
 * `priority`, `next-pipeline`, `critical-escalation`, `sort`, `audit`,
 * `dependencies`, `comments`, `search`, `sync`, `import-export`). Every member
 * below that is not class plumbing is a thin delegate with its original
 * signature; see `packages/shared/README.md` (Package Structure) for the
 * responsibility map (WL-0MVGKGHNR0019OLT / WL-0MVOBP8MC0093Y7T).
 */

import * as fs from 'fs';
import * as path from 'path';
import { WorkItem, WorkItemPriority, CreateWorkItemInput, UpdateWorkItemInput, WorkItemQuery, Comment, CreateCommentInput, UpdateCommentInput, NextWorkItemResult, DependencyEdge, ForeignDependencyView, AuditResult, AuditWaiver, DemotedParent, RevertedItem } from './types.js';
import { SqlitePersistentStore, FtsSearchResult, PersistentStoreServices, PersistentStoreCacheOptions, LastExportTimestamps } from './persistent-store.js';
// Self-referencing package export (WL-0MSJ4BT4Z002HH9B grep guard forbids a
// relative `icons.js` import; `@worklog/shared/icons` is the canonical path
// even from within the shared package).
import type { AuditInvalidationVerdict } from '@worklog/shared/icons';
import {
  EdgeCache,
  ForeignDependencyResolver,
  GitTarget,
  JsonlImportResult,
  WorklogDatabaseServices,
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
import type { CandidateExclusion } from './database/context.js';
import { handleCriticalEscalation } from './database/critical-escalation.js';
// Sort-index and audit modules — thin-delegate targets (WL-0MVOBP2Q2002ZYCF).
// Method implementations moved here; the class members below delegate.
import * as auditModule from './database/audit.js';
import * as sortModule from './database/sort.js';
// Work-item and hierarchy modules — thin-delegate targets (WL-0MVOBP4J6003ZKML).
// Method implementations moved here; the class members below delegate.
import * as workItemsModule from './database/work-items.js';
import type { UpdateOptions } from './database/work-items.js';
import * as hierarchyModule from './database/hierarchy.js';
// Dependency-edge and comment modules — thin-delegate targets
// (WL-0MVOBP6K0007574C). Method implementations moved here; the class members
// below delegate with their ORIGINAL signatures.
import * as dependenciesModule from './database/dependencies.js';
import * as commentsModule from './database/comments.js';
// Search, sync and import/export modules — thin-delegate targets
// (WL-0MVOBP8MC0093Y7T). Method implementations moved here; the class members
// below delegate with their ORIGINAL signatures.
import * as searchModule from './database/search.js';
import * as syncModule from './database/sync.js';
import * as importExportModule from './database/import-export.js';

export {
  normalizeTitleForMatch,
  UpdateIfMatchesResult,
  GitTarget,
  JsonlImportResult,
  WorklogDatabaseServices,
} from './database/context.js';

// ── Injectable service types ────────────────────────────────────────────


/**
 * Open-mode options for {@link WorklogDatabase} (F6 — WL-0MVJV2PX4005JH8D).
 *
 * `readOnly` opens the store READONLY and skips all schema/FTS DDL, turning
 * the cold open into a few-ms pragma-only open; a write attempt fails instead
 * of mutating the store.
 */
export interface WorklogDatabaseOptions {
  /** Open the store read-only and skip DDL when the schema is present. */
  readOnly?: boolean;
}


export class WorklogDatabase {
  private store: SqlitePersistentStore;
  private jsonlPath: string;
  private silent: boolean;
  private lockPath: string;
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
      jsonlPath: this.jsonlPath,
      _semanticSearch: null,
      syncState: { autoSync, syncProvider },
      _lastIdTime: 0,
      _idSequence: 0,
      hooks: {
        debug: (message) => this.debug(message),
        getNonClosedChildren: (parentId, edgeCache) => this.getNonClosedChildren(parentId, edgeCache),
        getActiveDependencyBlockers: (itemId, edgeCache) => this.getActiveDependencyBlockers(itemId, edgeCache),
        isInProgressSubtree: (item, allItems) => this.isInProgressSubtree(item, allItems),
        isDependencyActive: (target) => this.isDependencyActive(target),
        isLocalWorkItem: (id) => this.get(id) !== null,
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
        debug: (message) => this.debug(message),
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
    // The file existence check comes first: with no JSONL present the refresh is
    // a guaranteed no-op, so a warm open does not pay a COUNT query just to
    // discover that (WL-0MVWLBZG4003A803).
    if (
      options.readOnly !== true &&
      fs.existsSync(this.jsonlPath) &&
      this.store.countWorkItems() === 0
    ) {
      this.refreshFromJsonlIfNewer();
    }
  }

  /** Enable/disable auto-sync and optionally replace its provider. Implementation in `./database/sync.js` (WL-0MVOBP8MC0093Y7T). */
  setAutoSync(enabled: boolean, provider?: () => Promise<void>): void {
    syncModule.setAutoSync(this.ctx, enabled, provider);
  }

  /** Fire the configured auto-sync provider (no-op when disabled). Implementation in `./database/sync.js` (WL-0MVOBP8MC0093Y7T). */
  triggerAutoSync(): void {
    syncModule.triggerAutoSync(this.ctx);
  }

  /** Lazily create the semantic-search handle (null without an embedder). Implementation in `./database/search.js` (WL-0MVOBP8MC0093Y7T). */
  private getOrCreateSearch(): any | null {
    return searchModule.getOrCreateSearch(this.ctx);
  }

  /** Index a work item for semantic search in the background. Implementation in `./database/search.js` (WL-0MVOBP8MC0093Y7T). */
  private triggerSemanticIndex(item: WorkItem): void {
    searchModule.triggerSemanticIndex(this.ctx, item);
  }

  /** Remove a work item from the semantic search index. Implementation in `./database/search.js` (WL-0MVOBP8MC0093Y7T). */
  private removeFromSemanticIndex(itemId: string): void {
    searchModule.removeFromSemanticIndex(this.ctx, itemId);
  }

  /** Refresh database from Git remote (merge + delete local JSONL). Implementation in `./database/sync.js` (WL-0MVOBP8MC0093Y7T). */
  async refreshFromGit(target: GitTarget): Promise<{
    success: boolean;
    itemsAdded: number;
    itemsUpdated: number;
    commentsAdded: number;
    error?: string;
  }> {
    return syncModule.refreshFromGit(this.ctx, target);
  }

  /** Export current database state to JSONL for sync operations. Implementation in `./database/sync.js` (WL-0MVOBP8MC0093Y7T). */
  async exportForSync(options?: any): Promise<string> {
    return syncModule.exportForSync(this.ctx, options);
  }

  /** Read the per-record-type last-export watermarks (delta sync). Implementation in `./database/sync.js` (WL-0MVOBP8MC0093Y7T). */
  getLastExportTimestamps(): LastExportTimestamps {
    return syncModule.getLastExportTimestamps(this.ctx);
  }

  /** Advance the per-record-type last-export watermarks. Implementation in `./database/sync.js` (WL-0MVOBP8MC0093Y7T). */
  markLastExportTimestamps(ts: LastExportTimestamps): void {
    syncModule.markLastExportTimestamps(this.ctx, ts);
  }

  /** Count dirty records per type from the stored watermarks. Implementation in `./database/sync.js` (WL-0MVOBP8MC0093Y7T). */
  countDirtyRecords(): { items: number; comments: number; edges: number; audits: number; total: number } {
    return syncModule.countDirtyRecords(this.ctx);
  }

  /** Read the delta-sync cadence metadata. Implementation in `./database/sync.js` (WL-0MVOBP8MC0093Y7T). */
  getDeltaSyncMetadata(): { deltaSyncCount: number; deltaBytes: number } {
    return syncModule.getDeltaSyncMetadata(this.ctx);
  }

  /** Persist the delta-sync cadence metadata. Implementation in `./database/sync.js` (WL-0MVOBP8MC0093Y7T). */
  setDeltaSyncMetadata(deltaSyncCount: number, deltaBytes: number): void {
    syncModule.setDeltaSyncMetadata(this.ctx, deltaSyncCount, deltaBytes);
  }

  /** Delete the local JSONL file (ephemeral pattern). Implementation in `./database/sync.js` (WL-0MVOBP8MC0093Y7T). */
  deleteLocalJsonl(): void {
    syncModule.deleteLocalJsonl(this.ctx);
  }

  /** Refresh the store from a newer/unimported JSONL file (bootstrapping). Implementation in `./database/sync.js` (WL-0MVOBP8MC0093Y7T). */
  private refreshFromJsonlIfNewer(): void {
    syncModule.refreshFromJsonlIfNewer(this.ctx);
  }

  private debug(message: string): void {
    if (this.silent) return;
    console.error(message);
  }

  /** Fold stored + incoming audits, keeping the newest per item. Implementation in `./database/import-export.js` (WL-0MVOBP8MC0093Y7T). */
  private mergeAuditsNewestWins(stored: AuditResult[], incoming: AuditResult[]): AuditResult[] {
    return importExportModule.mergeAuditsNewestWins(this.ctx, stored, incoming);
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

  /** Re-sort all active items by score and reassign sortIndex. Implementation in `./database/sort.js` (WL-0MVOBP2Q2002ZYCF). */
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

  /** Whether FTS5 full-text search is available. Implementation in `./database/search.js` (WL-0MVOBP8MC0093Y7T). */
  get ftsAvailable(): boolean {
    return searchModule.ftsAvailable(this.ctx);
  }

  /** ID-aware FTS5 search with application-level fallback. Implementation in `./database/search.js` (WL-0MVOBP8MC0093Y7T). */
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
    return searchModule.search(this.ctx, query, options);
  }

  /** Rebuild the FTS index from scratch. Useful for backfill or recovery. Implementation in `./database/search.js` (WL-0MVOBP8MC0093Y7T). */
  rebuildFtsIndex(): { indexed: number } {
    return searchModule.rebuildFtsIndex(this.ctx);
  }

  /** Close the underlying database connection (releases file locks on Windows). */
  close(): void {
    this.store.close();
  }

  /**
   * Build an EdgeCache from all dependency edges and work items, eliminating
   * N+1 query patterns (`@param items` skips a redundant load).
   */
  private buildEdgeCache(items?: WorkItem[]): EdgeCache {
    return _buildEdgeCache(this.ctx, items);
  }

  // ── Audit Results ────────────────────────────────────────────────

  /** Save or update the audit result for a work item. Implementation in `./database/audit.js` (WL-0MVOBP2Q2002ZYCF). */
  saveAuditResult(audit: { workItemId: string; readyToClose: boolean; auditedAt: string; summary: string | null; rawOutput: string | null; author: string | null; fingerprint?: string | null }): void {
    auditModule.saveAuditResult(this.ctx, audit);
  }

  /** Fresh/reinstate/re-audit verdict for a stored audit. Implementation in `./database/audit.js` (WL-0MVOBP2Q2002ZYCF). */
  reconcileAuditInvalidation(
    workItemId: string,
    currentFingerprint?: string | null,
  ): AuditInvalidationVerdict {
    return auditModule.reconcileAuditInvalidation(this.ctx, workItemId, currentFingerprint);
  }

  /** Get the audit result for a work item (null when none). Implementation in `./database/audit.js` (WL-0MVOBP2Q2002ZYCF). */
  getAuditResult(workItemId: string): { workItemId: string; readyToClose: boolean; auditedAt: string; summary: string | null; rawOutput: string | null; author: string | null; fingerprint: string | null } | null {
    return auditModule.getAuditResult(this.ctx, workItemId);
  }

  /**
   * Delete the audit result for a work item.
   */
  deleteAuditResult(workItemId: string): boolean {
    return auditModule.deleteAuditResult(this.ctx, workItemId);
  }

  /** Record a durable audit-gap waiver on a work item. Implementation in `./database/audit.js` (WL-0MVOBP2Q2002ZYCF). */
  setAuditWaiver(id: string, waiver: AuditWaiver): WorkItem | null {
    return auditModule.setAuditWaiver(this.ctx, this.ctx.writeHooks, id, waiver);
  }

  /** Remove an explicit audit-gap waiver (idempotent). Implementation in `./database/audit.js` (WL-0MVOBP2Q2002ZYCF). */
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

  /** Create a new work item. Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML). */
  create(input: CreateWorkItemInput): WorkItem {
    return workItemsModule.create(this.ctx, this.ctx.itemHooks, input);
  }

  /** Create a work item after the last sibling in hierarchy order. Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML). */
  createWithNextSortIndex(input: CreateWorkItemInput, gap: number = 100): WorkItem {
    return workItemsModule.createWithNextSortIndex(this.ctx, this.ctx.itemHooks, input, gap);
  }

  /** Most recent non-terminal item with a matching title. Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML). */
  getRecentDuplicate(title: string, windowMs: number, prefix?: string): WorkItem | null {
    return workItemsModule.getRecentDuplicate(this.ctx, title, windowMs, prefix);
  }

  /**
   * Get a work item by ID
   */
  get(id: string): WorkItem | null {
    return workItemsModule.get(this.ctx, id);
  }

  /** Conditional update (compare-and-swap). Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML). */
  updateIfMatches(
    id: string,
    input: UpdateWorkItemInput,
    expected: { status?: string; stage?: string; assignee?: string } = {},
    options: UpdateOptions = {},
  ): UpdateIfMatchesResult {
    return workItemsModule.updateIfMatches(this.ctx, this.ctx.itemHooks, id, input, expected, options);
  }

  /**
   * Update a work item
   *
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  update(id: string, input: UpdateWorkItemInput, options: UpdateOptions = {}): WorkItem | null {
    return workItemsModule.update(this.ctx, this.ctx.itemHooks, id, input, options);
  }

  /** Delete a work item (recursive by default). Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML); the module exports `deleteWorkItem` because `delete` is reserved. */
  delete(id: string, recursive: boolean = true, opts?: { deletedBy?: string; deleteReason?: string }): boolean {
    return workItemsModule.deleteWorkItem(this.ctx, this.ctx.itemHooks, id, recursive, opts);
  }

  /** Internal: delete a single work item without recursive child handling. Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML). */
  private deleteSingle(id: string, opts?: { deletedBy?: string; deleteReason?: string }): boolean {
    return workItemsModule.deleteSingle(this.ctx, this.ctx.itemHooks, id, opts);
  }

  /**
   * Soft-delete predicate: `status === 'deleted'` or a non-empty `deletedBy`,
   * keeping visibility and mutability in agreement (WL-0MW7S20IC001F3AP).
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  isSoftDeleted(item: Pick<WorkItem, 'status' | 'deletedBy'>): boolean {
    return workItemsModule.isSoftDeleted(item);
  }

  /**
   * List all work items
   *
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  list(query?: WorkItemQuery): WorkItem[] {
    return workItemsModule.list(this.ctx, query);
  }

  /** Get children of a work item. Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML). */
  getChildren(parentId: string): WorkItem[] {
    return hierarchyModule.getChildren(this.ctx, parentId);
  }

  /** Cascade a priority downgrade to direct children. Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML). */
  cascadePriorityDowngrade(parentId: string, newPriority: WorkItemPriority): WorkItem[] {
    return hierarchyModule.cascadePriorityDowngrade(this.ctx, this.ctx.itemHooks, parentId, newPriority);
  }

  /**
   * Cascade a priority promotion up the ancestor chain: every non-critical
   * ancestor of a `critical` item becomes `critical` (WL-0MWETWNSO001UL2M).
   * Implementation in `./database/hierarchy.js`.
   */
  cascadePriorityPromote(itemId: string): WorkItem[] {
    return hierarchyModule.cascadePriorityPromote(this.ctx, this.ctx.itemHooks, itemId);
  }

  /**
   * Demote the direct parent (to `open`/`plan_complete`) when a new child is
   * attached, so its lifecycle state reflects unfinished children.
   * Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML).
   */
  demoteParentOnChildAdded(parentId: string): DemotedParent | null {
    return hierarchyModule.demoteParentOnChildAdded(this.ctx, this.ctx.itemHooks, parentId);
  }

  /** Revert an item to `open`/`plan_complete` after a not-ready-to-close audit. Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML). */
  revertToPlanComplete(itemId: string): RevertedItem | null {
    return hierarchyModule.revertToPlanComplete(this.ctx, this.ctx.itemHooks, itemId);
  }

  /** Get the number of direct children for each work item. Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML). */
  getChildCounts(items?: WorkItem[]): Map<string, number> {
    return hierarchyModule.getChildCounts(this.ctx, items);
  }

  /** Get children that are not closed or deleted. Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML). */
  private getNonClosedChildren(parentId: string, edgeCache?: EdgeCache): WorkItem[] {
    return hierarchyModule.getNonClosedChildren(this.ctx, parentId, edgeCache);
  }

  /** Get all descendants (children, grandchildren, etc.) of a work item. Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML). */
  getDescendants(parentId: string): WorkItem[] {
    return hierarchyModule.getDescendants(this.ctx, parentId);
  }

  /** Check if a work item is a leaf node (has no children). Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML). */
  isLeafNode(itemId: string): boolean {
    return hierarchyModule.isLeafNode(this.ctx, itemId);
  }

  /** Get all leaf nodes that are descendants of a parent item. Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML). */
  getLeafDescendants(parentId: string): WorkItem[] {
    return hierarchyModule.getLeafDescendants(this.ctx, parentId);
  }

  /** Get the depth of an item in the tree (root = 0). Implementation in `./database/hierarchy.js` (WL-0MVOBP4J6003ZKML). */
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

  /** Effective-priority tie-breaker. Implementation in `./database/priority.js` (WL-0MVOBP0U5007BAZD). */
  computeEffectivePriority(
    item: WorkItem,
    cache?: Map<string, { value: number; reason: string; inheritedFrom?: string }>,
    edgeCache?: EdgeCache,
    items?: WorkItem[]
  ): { value: number; reason: string; inheritedFrom?: string } {
    return computeEffectivePriority(this.ctx, this.ctx.hooks, item, cache, edgeCache, items);
  }

  /** Delegates to `selectHighestPriorityBlocking` in `./database/next-pipeline.js`. */
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

  /** Delegates to `resolveBlockerToRoot` in `./database/next-pipeline.js`. */
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

  /** Find the next work item by priority/creation time. Implementation in `./database/next-pipeline.js` (WL-0MVOBP0U5007BAZD). */
  findNextWorkItem(
    assignee?: string,
    searchTerm?: string,
    includeBlocked: boolean = false,
    stage?: string,
    includeInProgress: boolean = false,
    risk?: string,
    effort?: string,
    /**
     * Hide items this read surface must not select — e.g. not-yet-started
     * items (`startOn` in the future), WL-0MWMGET8N009KG33.
     */
    excludeItem?: CandidateExclusion
  ): NextWorkItemResult {
    return findNextWorkItem(this.ctx, this.ctx.hooks, assignee, searchTerm, includeBlocked, stage, includeInProgress, risk, effort, excludeItem);
  }

  /** Find up to `count` next work items (same selection logic, excluding already-selected). Implementation in `./database/next-pipeline.js` (WL-0MVOBP0U5007BAZD). */
  findNextWorkItems(
    count: number,
    assignee?: string,
    searchTerm?: string,
    includeBlocked: boolean = false,
    stage?: string,
    includeInProgress: boolean = false,
    risk?: string,
    effort?: string,
    /** Hide items this read surface must not select (see {@link CandidateExclusion}). */
    excludeItem?: CandidateExclusion
  ): NextWorkItemResult[] {
    return findNextWorkItems(this.ctx, this.ctx.hooks, count, assignee, searchTerm, includeBlocked, stage, includeInProgress, risk, effort, excludeItem);
  }

  /** Delegates to `applyFilters` in `./database/next-pipeline.js`. */
  private applyFilters(items: WorkItem[], assignee?: string, searchTerm?: string): WorkItem[] {
    return applyFilters(this.ctx, items, assignee, searchTerm);
  }

  /** Clear all work items (useful for import). Implementation in `./database/import-export.js` (WL-0MVOBP8MC0093Y7T). */
  clear(): void {
    importExportModule.clear(this.ctx);
  }

  /** Get all work items as an array. Implementation in `./database/import-export.js` (WL-0MVOBP8MC0093Y7T). */
  getAll(): WorkItem[] {
    return importExportModule.getAll(this.ctx);
  }

  /**
   * Ids of live rows whose stored `startOn` column is `NULL`/blank — a stored
   * value that violates the field's "always populated with the effective
   * instant" invariant, i.e. a back-fill migration that has not run
   * (WL-0MWMGEPY2004EDZ8). Used by the `wl doctor` `startOn.missing` check.
   */
  getItemIdsMissingStartOn(): string[] {
    return this.store.getItemIdsMissingStartOn();
  }

  getAllOrderedByHierarchySortIndex(): WorkItem[] {
    return importExportModule.getAllOrderedByHierarchySortIndex(this.ctx);
  }

  getAllOrderedByScore(recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore'): WorkItem[] {
    return sortModule.getAllOrderedByScore(this.ctx, recencyPolicy);
  }

  /**
   * True when any tracked field changed semantically: whitespace-normalised
   * title/description, `Boolean()`-normalised `needsProducerReview` and the
   * effective `startOn` (`startOn ?? createdAt`); shared by
   * {@link hasWorkItemChanged} and the no-op guard in {@link update}.
   * Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
   */
  private compareTrackedFields(oldItem: WorkItem, newItem: WorkItem, fields: (keyof WorkItem)[]): boolean {
    return workItemsModule.compareTrackedFields(oldItem, newItem, fields);
  }

  /** True when any tracked field of a work item changed semantically. Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML). */
  private hasWorkItemChanged(oldItem: WorkItem, newItem: WorkItem): boolean {
    //. Implementation in `./database/work-items.js` (WL-0MVOBP4J6003ZKML).
    return workItemsModule.hasWorkItemChanged(oldItem, newItem);
  }

  /** Import work items by **replacing** all existing data. Implementation in `./database/import-export.js` (WL-0MVOBP8MC0093Y7T). */
  import(items: WorkItem[], dependencyEdges?: DependencyEdge[], auditResults?: AuditResult[]): void {
    importExportModule.importWorkItems(this.ctx, items, dependencyEdges, auditResults);
  }

  /** Upsert work items non-destructively (items not provided are preserved). Implementation in `./database/import-export.js` (WL-0MVOBP8MC0093Y7T). */
  upsertItems(items: WorkItem[], dependencyEdges?: DependencyEdge[]): void {
    importExportModule.upsertItems(this.ctx, items, dependencyEdges);
  }

  /**
   * Add a dependency edge (fromId depends on toId)
   *
   * `toId` may reference a foreign (cross-project) item when the caller passes
   * `allowForeignTarget` after validating it read-only against the sibling
   * store (D2 — WL-0MVWABT2Z001XMSD).
   *
   * Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C).
   */
  addDependencyEdge(
    fromId: string,
    toId: string,
    options: dependenciesModule.AddDependencyEdgeOptions = {},
  ): DependencyEdge | null {
    return dependenciesModule.addDependencyEdge(this.ctx, fromId, toId, options);
  }

  /** Remove a dependency edge (fromId depends on toId). Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C). */
  removeDependencyEdge(fromId: string, toId: string): boolean {
    return dependenciesModule.removeDependencyEdge(this.ctx, fromId, toId);
  }

  /** List outbound dependency edges (fromId depends on toId). Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C). */
  listDependencyEdgesFrom(fromId: string): DependencyEdge[] {
    return dependenciesModule.listDependencyEdgesFrom(this.ctx, fromId);
  }

  /** List inbound dependency edges (items that depend on toId). Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C). */
  listDependencyEdgesTo(toId: string): DependencyEdge[] {
    return dependenciesModule.listDependencyEdgesTo(this.ctx, toId);
  }

  /** Delegates to `isDependencyActive` in `./database/dependencies.js`. */
  private isDependencyActive(target: WorkItem | null): boolean {
    return dependenciesModule.isDependencyActive(target);
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

  /** Items this item depends on whose dependency is still active. Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C). */
  private getActiveDependencyBlockers(itemId: string, edgeCache?: EdgeCache): WorkItem[] {
    return dependenciesModule.getActiveDependencyBlockers(this.ctx, itemId, edgeCache);
  }

  /** The items that depend on `targetId`. Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C). */
  getInboundDependents(targetId: string): WorkItem[] {
    return dependenciesModule.getInboundDependents(this.ctx, targetId);
  }

  /**
   * The foreign (cross-project) dependency edges of `itemId`, resolved from
   * their own stores and reported in the shared view every gating surface
   * emits. Empty when the item has no foreign edges or no resolver is
   * injected.
   *
   * Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C).
   */
  getForeignDependencyViews(itemId: string, edgeCache?: EdgeCache): ForeignDependencyView[] {
    return dependenciesModule.getForeignDependencyViews(this.ctx, itemId, edgeCache);
  }

  /**
   * True when `itemId` depends on at least one still-active item.
   *
   * Foreign (cross-project) targets are resolved from their own store; an
   * unresolved target keeps the dependent blocked (D3 fail-safe).
   *
   * Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C).
   */
  hasActiveBlockers(itemId: string, edgeCache?: EdgeCache): boolean {
    return dependenciesModule.hasActiveBlockers(this.ctx, itemId, edgeCache);
  }

  /** Set or clear `blocked` for an item purely from its active blockers. Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C). */
  reconcileBlockedStatus(itemId: string): boolean {
    return dependenciesModule.reconcileBlockedStatus(this.ctx, itemId);
  }

  /** Reconcile one item's own `blocked`/`open` status from its blockers. Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C). */
  reconcileDependentStatus(itemId: string): boolean {
    return dependenciesModule.reconcileDependentStatus(this.ctx, itemId);
  }

  /** Reconcile every item that depends on `targetId`. Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C). */
  reconcileDependentsForTarget(targetId: string): number {
    return dependenciesModule.reconcileDependentsForTarget(this.ctx, targetId);
  }

  /** Create a new comment. Implementation in `./database/comments.js` (WL-0MVOBP6K0007574C). */
  createComment(input: CreateCommentInput): Comment | null {
    return commentsModule.createComment(this.ctx, this.ctx.writeHooks, input);
  }

  /** Get a comment by ID. Implementation in `./database/comments.js` (WL-0MVOBP6K0007574C). */
  getComment(id: string): Comment | null {
    return commentsModule.getComment(this.ctx, id);
  }

  /** Update a comment. Implementation in `./database/comments.js` (WL-0MVOBP6K0007574C). */
  updateComment(id: string, input: UpdateCommentInput): Comment | null {
    return commentsModule.updateComment(this.ctx, this.ctx.writeHooks, id, input);
  }

  /** Delete a comment. Implementation in `./database/comments.js` (WL-0MVOBP6K0007574C). */
  deleteComment(id: string): boolean {
    return commentsModule.deleteComment(this.ctx, this.ctx.writeHooks, id);
  }

  /** Get all comments for a work item. Implementation in `./database/comments.js` (WL-0MVOBP6K0007574C). */
  getCommentsForWorkItem(workItemId: string): Comment[] {
    return commentsModule.getCommentsForWorkItem(this.ctx, workItemId);
  }

  /** Get all comments as an array. Implementation in `./database/comments.js` (WL-0MVOBP6K0007574C). */
  getAllComments(): Comment[] {
    return commentsModule.getAllComments(this.ctx);
  }

  /** All dependency edges in the store (used by JSONL export / sync). Implementation in `./database/dependencies.js` (WL-0MVOBP6K0007574C). */
  getAllDependencyEdges(): DependencyEdge[] {
    return dependenciesModule.getAllDependencyEdges(this.ctx);
  }

  /** Upsert comments non-destructively (incremental-sync delta pull). Implementation in `./database/comments.js` (WL-0MVOBP6K0007574C). */
  upsertComments(comments: Comment[]): void {
    commentsModule.upsertComments(this.ctx, this.ctx.writeHooks, comments);
  }

  /** Import comments destructively (full-snapshot sync). Implementation in `./database/comments.js` (WL-0MVOBP6K0007574C). */
  importComments(comments: Comment[]): void {
    commentsModule.importComments(this.ctx, this.ctx.writeHooks, comments);
  }

  /** True when a stored comment differs from an incoming one. Implementation in `./database/comments.js` (WL-0MVOBP6K0007574C). */
  private hasCommentChanged(stored: Comment, incoming: Comment): boolean {
    return commentsModule.hasCommentChanged(stored, incoming);
  }

  /** Bump a work item's activityAt on comment activity. Implementation in `./database/comments.js` (WL-0MVOBP6K0007574C). */
  private touchWorkItemActivityAt(workItemId: string): void {
    commentsModule.touchWorkItemActivityAt(this.ctx, workItemId);
  }
}
