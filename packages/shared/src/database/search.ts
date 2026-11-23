/**
 * packages/shared/src/database/search.ts — full-text (FTS5) and semantic
 * search for the `database.ts` decomposition.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Slice: WL-0MVOBP8MC0093Y7T (extract search, sync and import-export).
 *
 * ## Responsibility
 *
 * Everything that answers "find items by text": the FTS5 availability probe
 * (`ftsAvailable`), the ID-aware `search` entry point (exact-ID
 * short-circuit, bare-token prefix resolution, partial-ID substring matching,
 * FTS5 query with an application-level `searchFallback` when FTS5 is absent,
 * auto-quoting of invalid FTS syntax), the `rebuildFtsIndex` recovery path,
 * and the semantic-index lifecycle — lazy `WorklogSearch` creation
 * (`getOrCreateSearch`) plus the background index/remove hooks the item
 * write paths call (`triggerSemanticIndex`, `removeFromSemanticIndex`).
 *
 * ## Boundary
 *
 * **Belongs here.** Query execution, query-syntax recovery, FTS rebuild, and
 * the semantic (embedding) index. Reads the store through
 * `WorklogDatabaseContext`; `rebuildFtsIndex` delegates the actual rebuild to
 * the store. The write paths that keep the FTS rows fresh
 * (`upsertFtsEntry`/`deleteFtsEntry`) live with the concern that writes the
 * record — this module never writes item rows.
 *
 * **Does NOT belong here.** Work-item/hierarchy CRUD (`work-items.ts`,
 * `hierarchy.ts`), sort/`wl next` selection (`sort.ts`, `next-pipeline.ts`,
 * `priority.ts`, `critical-escalation.ts`), dependencies and comments
 * (`dependencies.ts`, `comments.ts`), audits (`audit.ts`), and Git/JSONL sync
 * (`sync.ts`, `import-export.ts`). No knowledge of the `WorklogDatabase`
 * façade; the extracted-module graph stays acyclic.
 *
 * `WorklogDatabase` keeps a thin delegating member per function so the façade
 * surface is unchanged (parent AC — public API untouched).
 */

import * as path from 'path';
import { WorkItem } from '../types.js';
import { FtsSearchResult } from '../persistent-store.js';
import { WorklogDatabaseContext, getPrefix } from './context.js';

/**
 * Get or lazily create a WorklogSearch instance for semantic indexing.
 *
 * Returns null when the embedder is not available (no OPENAI_API_KEY set),
 * so callers can skip indexing gracefully. The handle is cached on the shared
 * context so every caller sees the same instance.
 */
export function getOrCreateSearch(ctx: WorklogDatabaseContext): any | null {
  if (ctx._semanticSearch) return ctx._semanticSearch;

  const searchSvc = ctx.services.search;
  if (!searchSvc) return null;

  const embedder = searchSvc.getDefaultEmbedder();
  if (!embedder.available) return null;

  const worklogDir = path.dirname(ctx.jsonlPath);
  const storePath = searchSvc.getEmbeddingStorePath(worklogDir);
  const store = new searchSvc.EmbeddingStore(storePath);
  ctx._semanticSearch = searchSvc.createSearch(store, embedder);
  return ctx._semanticSearch;
}

/**
 * Index a single work item for semantic search in the background.
 * No-op when no embedder is configured.
 */
export function triggerSemanticIndex(ctx: WorklogDatabaseContext, item: WorkItem): void {
  const search = getOrCreateSearch(ctx);
  if (!search) return;

  // Get comments for this item (needed for content hash)
  const comments = ctx.store.getCommentsForWorkItem(item.id);
  const commentText = comments.map(c => c.comment).join('\n');

  // Launch as a background task so create/update is not blocked
  const runtime = ctx.services.runtime?.getRuntime?.();
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
export function removeFromSemanticIndex(ctx: WorklogDatabaseContext, itemId: string): void {
  const search = getOrCreateSearch(ctx);
  if (!search) return;
  search.removeWorkItem(itemId);
}

/**
 * Whether FTS5 full-text search is available in the underlying SQLite build
 */
export function ftsAvailable(ctx: WorklogDatabaseContext): boolean {
  return ctx.store.ftsAvailable;
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
export function search(
  ctx: WorklogDatabaseContext,
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
  ctx.services.searchMetrics?.increment?.('search.total');
  const idResults: FtsSearchResult[] = [];
  const seenIds = new Set<string>();

  const tokens = query.trim().split(/\s+/).filter(t => t.length > 0);
  const prefix = getPrefix(ctx);

  for (const token of tokens) {
    const upper = token.toUpperCase();

    // --- Exact-ID check (with prefix already present) ---
    if (upper.includes('-')) {
      const item = ctx.store.getWorkItem(upper);
      if (item && !seenIds.has(item.id)) {
        seenIds.add(item.id);
        idResults.push({
          itemId: item.id,
          rank: -Infinity,
          snippet: item.title,
          matchedColumn: 'id',
        });
        ctx.services.searchMetrics?.increment?.('search.exact_id');
        continue;
      }
    }

    // --- Prefix resolution: bare token → PREFIX-TOKEN ---
    if (!upper.includes('-') && /^[A-Z0-9]+$/.test(upper) && upper.length >= 8) {
      const prefixed = `${prefix}-${upper}`;
      const item = ctx.store.getWorkItem(prefixed);
      if (item && !seenIds.has(item.id)) {
        seenIds.add(item.id);
        idResults.push({
          itemId: item.id,
          rank: -Infinity,
          snippet: item.title,
          matchedColumn: 'id',
        });
        ctx.services.searchMetrics?.increment?.('search.prefix_resolved');
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
        const partials = ctx.store.findByIdSubstring(substr);
        for (const p of partials) {
          if (!seenIds.has(p.id)) {
            seenIds.add(p.id);
            idResults.push({
              itemId: p.id,
              rank: -1000,
              snippet: p.title,
              matchedColumn: 'id',
            });
            ctx.services.searchMetrics?.increment?.('search.partial_id');
          }
        }
      }
    }
  }

  // --- Regular FTS / fallback search ---
  let ftsUsed = false;
  let ftsResults: FtsSearchResult[] = [];
  let warning: string | undefined;

  if (ctx.store.ftsAvailable) {
    try {
      ftsResults = ctx.store.searchFts(query, options);
      ftsUsed = true;
      ctx.services.searchMetrics?.increment?.('search.fts');
    } catch (err) {
      // The raw query tripped the FTS5 parser (e.g. an unquoted punctuated
      // term like `v0.1.11` or a file path). Retry as a quoted phrase so
      // users searching for version strings / paths still get results, and
      // signal the auto-quote with a warning so it is never silent.
      const message = err instanceof Error ? err.message : String(err);
      const escaped = query.replace(/\\"/g, '').replace(/"/g, '""');
      let quotedResults: FtsSearchResult[];
      try {
        quotedResults = ctx.store.searchFts(`"${escaped}"`, options);
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
      ctx.services.searchMetrics?.increment?.('search.fts');
      warning = `query "${query}" was auto-quoted as a phrase because it is not valid FTS5 syntax: ${message}`;
    }
  } else {
    if (!ctx.silent) {
      ctx.writeHooks.debug('FTS5 is not available; falling back to application-level search');
    }
    ftsResults = ctx.store.searchFallback(query, options);
    ctx.services.searchMetrics?.increment?.('search.fallback');
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
export function rebuildFtsIndex(ctx: WorklogDatabaseContext): { indexed: number } {
  return ctx.store.rebuildFtsIndex();
}
