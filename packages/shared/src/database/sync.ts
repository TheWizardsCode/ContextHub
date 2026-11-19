/**
 * packages/shared/src/database/sync.ts — Git/JSONL synchronisation for the
 * `database.ts` decomposition.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP8MC0093Y7T (extract search, sync and import-export).
 *
 * ## Responsibility
 *
 * The ephemeral-JSONL sync protocol and the metadata it maintains:
 *
 * - `refreshFromGit` — pull the remote data file, merge it with local
 *   SQLite state (via the injected sync service), persist the merge, and
 *   delete the local JSONL file (ephemeral pattern).
 * - `exportForSync` — write the current state (full or delta, selected by
 *   per-record-type watermarks) to the local JSONL file for a push.
 * - Watermarks and cadence metadata — `getLastExportTimestamps`,
 *   `markLastExportTimestamps`, `countDirtyRecords`,
 *   `getDeltaSyncMetadata`, `setDeltaSyncMetadata`.
 * - `deleteLocalJsonl` and the constructor's `refreshFromJsonlIfNewer`
 *   bootstrap (SQLite is empty → import a legacy/newer JSONL file).
 * - The auto-sync triggers — `setAutoSync` / `triggerAutoSync` — that the
 *   write paths call through `ctx.writeHooks.triggerAutoSync()`.
 *
 * ## Boundary
 *
 * **Belongs here.** Everything about moving the whole store to or from
 * JSONL/Git, plus the watermarks that make the move incremental. Reads and
 * writes the store through `WorklogDatabaseContext` (`store`,
 * `services.jsonl`, `services.sync`, `jsonlPath`); the auto-sync state lives
 * in `ctx.syncState` (a plain mutable holder so this module stays a set of
 * pure functions over the context).
 *
 * **Does NOT belong here.** Record-level merge/diff semantics — the store and
 * the injected `services.sync` merger own those. Also out of scope:
 * the destructive/incremental in-process snapshot import (`import-export.ts`),
 * FTS/semantic search (`search.ts`), work-item CRUD, sorting/selection,
 * dependencies, comments and audits. No knowledge of the `WorklogDatabase`
 * façade; the extracted-module graph stays acyclic.
 *
 * `WorklogDatabase` keeps a thin delegating member per function so the façade
 * surface is unchanged (parent AC — public API untouched).
 */

import * as fs from 'fs';
import { LastExportTimestamps } from '../persistent-store.js';
import { GitTarget, WorklogDatabaseContext } from './context.js';

/**
 * Enable or disable auto-sync and (optionally) replace the sync provider.
 *
 * State lives in `ctx.syncState` so `triggerAutoSync` remains a pure function
 * over the shared context.
 */
export function setAutoSync(
  ctx: WorklogDatabaseContext,
  enabled: boolean,
  provider?: () => Promise<void>,
): void {
  ctx.syncState.autoSync = enabled;
  if (provider) {
    ctx.syncState.syncProvider = provider;
  }
}

/**
 * Trigger the configured auto-sync provider, if auto-sync is enabled and a
 * provider was supplied. Fire-and-forget: the caller never awaits the sync.
 */
export function triggerAutoSync(ctx: WorklogDatabaseContext): void {
  if (!ctx.syncState.autoSync || !ctx.syncState.syncProvider) {
    return;
  }
  void ctx.syncState.syncProvider();
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
export async function refreshFromGit(
  ctx: WorklogDatabaseContext,
  target: GitTarget,
): Promise<{
  success: boolean;
  itemsAdded: number;
  itemsUpdated: number;
  commentsAdded: number;
  error?: string;
}> {
  const syncSvc = ctx.services.sync;
  const jsonlSvc = ctx.services.jsonl;
  if (!syncSvc || !jsonlSvc) {
    return { success: false, itemsAdded: 0, itemsUpdated: 0, commentsAdded: 0, error: 'Sync services not provided to WorklogDatabase' };
  }

  try {
    // Fetch remote content
    const remoteContent = await syncSvc.getRemoteDataFileContent(ctx.jsonlPath, target);

    if (!remoteContent) {
      // No remote data yet (first sync) - this is OK
      return { success: true, itemsAdded: 0, itemsUpdated: 0, commentsAdded: 0 };
    }

    // Parse remote data
    const { items: remoteItems, comments: remoteComments, dependencyEdges, auditResults: remoteAudits } = jsonlSvc.importFromJsonlContent(remoteContent);

    // Get local state
    const localItems = ctx.store.getAllWorkItems();
    const localComments = ctx.store.getAllComments();
    const localEdges = ctx.store.getAllDependencyEdges();
    const localAudits = ctx.store.getAllAuditResults();

    // Merge data
    const itemMergeResult = syncSvc.mergeWorkItems(localItems, remoteItems);
    const commentMergeResult = syncSvc.mergeComments(localComments, remoteComments);
    const auditMergeResult = syncSvc.mergeAuditResults(localAudits, remoteAudits);

    // Calculate changes
    const itemsAdded = Math.max(0, itemMergeResult.merged.length - localItems.length);
    const itemsUpdated = itemMergeResult.conflicts.length;
    const commentsAdded = Math.max(0, commentMergeResult.merged.length - localComments.length);

    // Import merged data to SQLite
    ctx.store.importData(itemMergeResult.merged, commentMergeResult.merged);

    // Import dependency edges
    for (const edge of dependencyEdges) {
      if (ctx.store.getWorkItem(edge.fromId) && ctx.store.getWorkItem(edge.toId)) {
        ctx.store.saveDependencyEdge(edge);
      }
    }

    // Import audit results
    if (auditMergeResult.merged.length > 0) {
      ctx.store.saveAuditResults(auditMergeResult.merged);
    }

    // Update metadata to prevent re-import of the same data
    const now = Date.now();
    ctx.store.setMetadata('lastJsonlImportMtime', now.toString());
    ctx.store.setMetadata('lastJsonlImportAt', new Date().toISOString());

    // Delete local JSONL file (ephemeral pattern)
    if (fs.existsSync(ctx.jsonlPath)) {
      fs.unlinkSync(ctx.jsonlPath);
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
export async function exportForSync(ctx: WorklogDatabaseContext, options?: any): Promise<string> {
  const jsonlSvc = ctx.services.jsonl;
  if (!jsonlSvc) {
    throw new Error('jsonl services not provided to WorklogDatabase — cannot export for sync');
  }

  const mode: 'full' | 'delta' =
    options?.mode === 'delta' && process.env.WL_DELTA_EXPORT_DISABLED !== '1' ? 'delta' : 'full';

  // In delta mode resolve the per-type watermarks: explicit `since` wins,
  // otherwise read the stored watermarks (no baseline → full fallback).
  let since: LastExportTimestamps | undefined;
  if (mode === 'delta') {
    const candidate = options?.since ?? getLastExportTimestamps(ctx);
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
    ? ctx.store.getAllWorkItems().filter(i => i.updatedAt && new Date(i.updatedAt).getTime() > new Date(wItems).getTime())
    : ctx.store.getAllWorkItems();
  const comments = wComments
    ? ctx.store.getAllComments().filter(c => c.createdAt && new Date(c.createdAt).getTime() > new Date(wComments).getTime())
    : ctx.store.getAllComments();
  const dependencyEdges = wEdges
    ? ctx.store.getAllDependencyEdges().filter(e => e.createdAt && new Date(e.createdAt).getTime() > new Date(wEdges).getTime())
    : ctx.store.getAllDependencyEdges();
  const auditResults = wAudits
    ? ctx.store.getAllAuditResults().filter(a => a.auditedAt && new Date(a.auditedAt).getTime() > new Date(wAudits).getTime())
    : ctx.store.getAllAuditResults();

  // Export to JSONL — the `kind` is surfaced to the JSONL writer so the
  // output carries a sync header distinguishing full vs delta
  // (WL-0MT2KXPOQ009G026).
  await jsonlSvc.exportToJsonlAsync(items, comments, ctx.jsonlPath, dependencyEdges, auditResults, { onProgress: options?.onProgress, kind: mode });

  // Watermark advancement is deliberately NOT performed here in any mode:
  // the push path advances them only AFTER a successful push
  // (markLastExportTimestamps, WL-0MT2KY0RQ008F50Q AC5). A failed push must
  // not advance the baseline past data that was never published.

  return ctx.jsonlPath;
}

/**
 * Read the per-record-type last-export watermarks used by delta sync
 * (WL-0MT2KWFUJ001OGHF). If none have ever been recorded, returns an empty
 * object — callers treat that as "no baseline → full export".
 */
export function getLastExportTimestamps(ctx: WorklogDatabaseContext): LastExportTimestamps {
  return ctx.store.getLastExportTimestamps();
}

/**
 * Advance the per-record-type last-export watermarks (after a successful
 * delta push, or a whole-store import that publishes all records). Only the
 * provided types are updated; others are left untouched.
 */
export function markLastExportTimestamps(ctx: WorklogDatabaseContext, ts: LastExportTimestamps): void {
  ctx.store.setLastExportTimestamps(ts);
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
export function countDirtyRecords(ctx: WorklogDatabaseContext): { items: number; comments: number; edges: number; audits: number; total: number } {
  const wm = getLastExportTimestamps(ctx);
  const wItems = wm.workitems;
  const wComments = wm.comments;
  const wEdges = wm.edges;
  const wAudits = wm.audit_results;

  const items = wItems
    ? ctx.store.getAllWorkItems().filter(i => i.updatedAt && new Date(i.updatedAt).getTime() > new Date(wItems).getTime()).length
    : ctx.store.getAllWorkItems().length;
  const comments = wComments
    ? ctx.store.getAllComments().filter(c => c.createdAt && new Date(c.createdAt).getTime() > new Date(wComments).getTime()).length
    : ctx.store.getAllComments().length;
  const edges = wEdges
    ? ctx.store.getAllDependencyEdges().filter(e => e.createdAt && new Date(e.createdAt).getTime() > new Date(wEdges).getTime()).length
    : ctx.store.getAllDependencyEdges().length;
  const audits = wAudits
    ? ctx.store.getAllAuditResults().filter(a => a.auditedAt && new Date(a.auditedAt).getTime() > new Date(wAudits).getTime()).length
    : ctx.store.getAllAuditResults().length;

  return { items, comments, edges, audits, total: items + comments + edges + audits };
}

/**
 * Read the delta-sync cadence metadata (WL-0MT2KY0RQ008F50Q §5.3): the
 * number of consecutive delta syncs since the last full snapshot, and the
 * accumulated JSONL bytes pushed in that window. Used to decide when the
 * next full snapshot is due (defaults: every 10 delta syncs OR 1 MB).
 */
export function getDeltaSyncMetadata(ctx: WorklogDatabaseContext): { deltaSyncCount: number; deltaBytes: number } {
  return ctx.store.getDeltaSyncMetadata();
}

/**
 * Persist the delta-sync cadence metadata ({@link getDeltaSyncMetadata}).
 */
export function setDeltaSyncMetadata(ctx: WorklogDatabaseContext, deltaSyncCount: number, deltaBytes: number): void {
  ctx.store.setDeltaSyncMetadata(deltaSyncCount, deltaBytes);
}

/**
 * Delete the local JSONL file.
 * This should be called after successful Git push (ephemeral pattern).
 */
export function deleteLocalJsonl(ctx: WorklogDatabaseContext): void {
  if (fs.existsSync(ctx.jsonlPath)) {
    fs.unlinkSync(ctx.jsonlPath);
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
export function refreshFromJsonlIfNewer(ctx: WorklogDatabaseContext): void {
  if (!fs.existsSync(ctx.jsonlPath)) {
    return; // No JSONL file, nothing to refresh from
  }

  try {
    const jsonlStats = fs.statSync(ctx.jsonlPath);
    // Use Math.floor to match the precision of stored mtime (which is stored via Math.floor().toString())
    const jsonlMtime = Math.floor(jsonlStats.mtimeMs);

    const metadata = ctx.store.getAllMetadata();
    const lastImportMtime = metadata.lastJsonlImportMtime;
    const lastExportMtimeStr = ctx.store.getMetadata('lastJsonlExportMtime');
    const lastExportMtime = lastExportMtimeStr ? Number(lastExportMtimeStr) : undefined;

    // If DB is empty or JSONL is newer, refresh from JSONL
    const itemCount = ctx.store.countWorkItems();
    // Avoid re-importing a file we just exported ourselves. If the JSONL mtime equals the
    // last export mtime recorded in the DB, skip the refresh. Otherwise fall back to the
    // previous logic (DB empty or JSONL newer than last import).
    const isOurExport = lastExportMtime !== undefined && Math.abs(jsonlMtime - lastExportMtime) < 1;
    const shouldRefresh = !isOurExport && (itemCount === 0 || !lastImportMtime || jsonlMtime > lastImportMtime);

    if (shouldRefresh) {
      if (!ctx.silent) {
        // Debug: send to stderr so JSON stdout is preserved for --json mode
        ctx.writeHooks.debug(`Refreshing database from ${ctx.jsonlPath}...`);
      }
      const jsonlResult = ctx.services.jsonl?.importFromJsonl?.(ctx.jsonlPath) ?? { items: [], comments: [], dependencyEdges: [], auditResults: [] };
      const { items: jsonlItems, comments: jsonlComments, dependencyEdges, auditResults: jsonlAuditResults } = jsonlResult;
      ctx.store.importData(jsonlItems, jsonlComments);
      for (const edge of dependencyEdges) {
        if (ctx.store.getWorkItem(edge.fromId) && ctx.store.getWorkItem(edge.toId)) {
          ctx.store.saveDependencyEdge(edge);
        }
      }

      // Import audit results (they are included in JSONL but must be explicitly upserted)
      if (jsonlAuditResults.length > 0) {
        ctx.store.saveAuditResults(jsonlAuditResults);
      }

      // Update metadata
      // Use Math.floor to match the precision of parseInt when reading back
      ctx.store.setMetadata('lastJsonlImportMtime', Math.floor(jsonlMtime).toString());
      ctx.store.setMetadata('lastJsonlImportAt', new Date().toISOString());

      if (!ctx.silent) {
        ctx.writeHooks.debug(`Loaded ${jsonlItems.length} work items, ${jsonlComments.length} comments, and ${jsonlAuditResults.length} audit results from JSONL`);
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
