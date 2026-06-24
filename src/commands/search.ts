/**
 * Search command - Full-text search over work items
 *
 * Supports optional semantic search enhancement via the --semantic flag.
 * When embeddings are available, search results are fused with
 * cosine-similarity rankings for conceptually related results.
 */

import type { PluginContext } from '../plugin-types.js';
import type { SearchOptions } from '../cli-types.js';
import { formatTitleAndId } from './helpers.js';
import { theme } from '../theme.js';
import { resolveWorklogDir } from '../worklog-paths.js';
import {
  EmbeddingStore,
  getDefaultEmbedder,
  createSearch,
  getEmbeddingStorePath,
  type FusedResult,
} from '../lib/search.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  program
    .command('search')
    .description('Full-text search over work items (title, description, comments, tags' +
      '; use --semantic for hybrid semantic+lexical search)')
    .argument('[query]', 'Search query (supports phrases, prefix*, AND, OR, NOT)')
    .option('-s, --status <status>', 'Filter results by status')
    .option('-p, --priority <priority>', 'Filter by priority')
    .option('--parent <id>', 'Filter results by parent work item id')
    .option('--tags <tags>', 'Filter results by tags (comma-separated)')
    .option('-a, --assignee <assignee>', 'Filter by assignee')
    .option('--stage <stage>', 'Filter by stage')
    .option('--deleted', 'Include deleted items in results')
    .option('--needs-producer-review [value]', 'Filter by needsProducerReview flag (true|false|yes|no; default true when omitted)')
    .option('--issue-type <type>', 'Filter by issue type')
    .option('-l, --limit <n>', 'Maximum number of results (default: 20)')
    .option('--rebuild-index', 'Rebuild the FTS index from scratch before searching')
    .option('--semantic', 'Enable semantic search enhancement (hybrid lexical+semantic ranking)')
    .option('--semantic-only', 'Return only semantic search results (no lexical scoring)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (query: string | undefined, options: SearchOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options?.prefix);

      // Handle --rebuild-index
      if (options.rebuildIndex) {
        try {
          const ftsResult = db.rebuildFtsIndex();
          if (options.semantic || options.semanticOnly) {
            triggerSemanticRebuild(db);
          }
          if (utils.isJsonMode()) {
            output.json({ success: true, action: 'rebuild-index', indexed: ftsResult.indexed });
          } else {
            console.log(`FTS index rebuilt: ${ftsResult.indexed} work items indexed.`);
          }
          if (!query || query.trim() === '') {
            return;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output.error(`Failed to rebuild FTS index: ${message}`, {
            success: false,
            error: message,
          });
          process.exit(1);
        }
      }

      // Handle --rebuild-index
      if (options.rebuildIndex) {
        try {
          const result = db.rebuildFtsIndex();
          if (utils.isJsonMode()) {
            output.json({ success: true, action: 'rebuild-index', indexed: result.indexed });
          } else {
            console.log(`FTS index rebuilt: ${result.indexed} work items indexed.`);
          }
          // If no query was provided with --rebuild-index, exit after rebuilding
          if (!query || query.trim() === '') {
            return;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output.error(`Failed to rebuild FTS index: ${message}`, {
            success: false,
            error: message,
          });
          process.exit(1);
        }
      }

      // Require query if not doing --rebuild-index
      if (!query || query.trim() === '') {
        output.error('Please provide a search query, or use --rebuild-index to rebuild the index.', {
          success: false,
          error: 'missing query',
        });
        process.exit(1);
      }

      // Parse options
      const limit = options.limit ? parseInt(options.limit, 10) : 20;
      const tags = options.tags
        ? options.tags.split(',').map((t: string) => t.trim())
        : undefined;

      let parentId = options.parent;
      if (parentId) {
        parentId = utils.normalizeCliId(parentId, options.prefix) || parentId;
      }

      // Parse --needs-producer-review boolean flag (matching list.ts logic)
      let needsProducerReview: boolean | undefined;
      if (options.needsProducerReview !== undefined) {
        if (options.needsProducerReview === true) {
          needsProducerReview = true;
        } else {
          const raw = String(options.needsProducerReview).toLowerCase();
          const truthy = ['true', 'yes', '1', ''];
          const falsy = ['false', 'no', '0'];
          if (truthy.includes(raw)) needsProducerReview = true;
          else if (falsy.includes(raw)) needsProducerReview = false;
          else {
            output.error(`Invalid value for --needs-producer-review: ${options.needsProducerReview}`, { success: false, error: 'invalid-arg' });
            process.exit(1);
          }
        }
      }

      // Execute search
      const rawResults = db.search(query, {
        status: options.status,
        parentId,
        tags,
        limit: isNaN(limit) || limit < 1 ? 20 : limit,
        priority: options.priority,
        assignee: options.assignee,
        stage: options.stage,
        deleted: options.deleted,
        needsProducerReview,
        issueType: options.issueType,
      });

      let { results, ftsUsed } = rawResults;

      // ── Semantic search enhancement ──────────────────────────────
      if (options.semantic || options.semanticOnly) {
        const worklogDir = resolveWorklogDir();
        const storePath = getEmbeddingStorePath(worklogDir);
        const store = new EmbeddingStore(storePath);
        const embedder = getDefaultEmbedder();
        const search = createSearch(store, embedder);

        if (embedder.available) {
          // Fire-and-forget pre-computation so future searches use cached query embedding
          void search.precomputeQueryEmbedding(query);
        }

        const semanticMode = options.semanticOnly
          ? true
          : 'auto';

        if (semanticMode === true && !embedder.available) {
          output.error('Semantic search requires an embedding provider. Set OPENAI_API_KEY.', {
            success: false,
            error: 'no-embedder',
          });
          process.exit(1);
        }

        const lexicalInput = semanticMode === true
          ? []
          : results.map(r => ({
              itemId: r.itemId,
              rank: r.rank,
              snippet: r.snippet,
              matchedColumn: r.matchedColumn,
            }));

        const fusedResults = search.searchSync(
          query,
          lexicalInput,
          semanticMode,
          { lexicalWeight: 0.5, semanticWeight: 0.5 }
        );

        // Convert fused results back to the FtsSearchResult format for output
        const fusedIds = new Set(fusedResults.map(r => r.itemId));
        results = fusedResults.map(fr => {
          const original = rawResults.results.find(r => r.itemId === fr.itemId);
          return {
            itemId: fr.itemId,
            rank: -fr.score, // Negate so higher scores sort first (matching BM25 convention)
            snippet: fr.snippet || original?.snippet || '',
            matchedColumn: fr.matchedColumn || original?.matchedColumn || 'semantic',
          };
        });

        // Append items in the embedding store that had 0 fused score
        // (they still appeared due to lexical-only matching)
        for (const rr of rawResults.results) {
          if (!fusedIds.has(rr.itemId)) {
            results.push(rr);
          }
        }
      }

      if (utils.isJsonMode()) {
        const jsonResults = results.map(r => {
          const item = db.get(r.itemId);
          return {
            id: r.itemId,
            title: item?.title || '',
            status: item?.status || '',
            priority: item?.priority || '',
            score: r.rank,
            snippet: r.snippet,
            matchedField: r.matchedColumn,
          };
        });
        const outputPayload: Record<string, unknown> = {
          success: true,
          ftsAvailable: ftsUsed,
          count: jsonResults.length,
          results: jsonResults,
        };
        if (options.semantic || options.semanticOnly) {
          outputPayload.semanticAvailable = rawResults.ftsUsed;
        }
        output.json(outputPayload);
        return;
      }

      // Human-friendly output
      if (!ftsUsed) {
        console.log(theme.text.muted('(FTS5 not available; using fallback search)'));
        console.log('');
      }

      if (options.semantic && results.length > 0) {
        console.log(theme.text.muted('(Semantic search enabled)'));
        console.log('');
      }

      if (results.length === 0) {
        console.log('No results found.');
        return;
      }

      console.log(`Found ${results.length} result(s) for "${query}":\n`);

      for (const result of results) {
        const item = db.get(result.itemId);
        if (!item) continue;

        // Title line
        console.log(formatTitleAndId(item));

        // Metadata line
        const meta: string[] = [];
        meta.push(`Status: ${item.status}`);
        meta.push(`Priority: ${item.priority}`);
        if (item.assignee) meta.push(`Assignee: ${item.assignee}`);
        if (item.tags && item.tags.length > 0) meta.push(`Tags: ${item.tags.join(', ')}`);
        console.log(`  ${theme.text.muted(meta.join(' | '))}`);

        // Snippet line
        if (result.snippet) {
          const snippetLabel = theme.text.muted(`[${result.matchedColumn}]`);
          // Replace highlight markers << >> with chalk bold
          const highlighted = result.snippet
            .replace(/<<(.*?)>>/g, (_, match) => theme.text.warning(match));
          console.log(`  ${snippetLabel} ${highlighted}`);
        }

        console.log('');
      }
    });
}

/**
 * Trigger a full semantic reindex in the background.
 * Called when --rebuild-index is used with --semantic or --semantic-only.
 */
function triggerSemanticRebuild(db: any): void {
  try {
    const worklogDir = resolveWorklogDir();
    const storePath = getEmbeddingStorePath(worklogDir);
    const store = new EmbeddingStore(storePath);
    const embedder = getDefaultEmbedder();
    const search = createSearch(store, embedder);

    const items = typeof db.getAllWorkItems === 'function'
      ? db.getAllWorkItems()
      : [];

    // Precompute comments if db has the method
    const allComments = typeof db.getAllComments === 'function'
      ? db.getAllComments()
      : [];
    const commentsByItem = new Map<string, string[]>();
    for (const c of allComments) {
      const list = commentsByItem.get(c.workItemId) ?? [];
      list.push(c.comment ?? '');
      commentsByItem.set(c.workItemId, list);
    }

    search.reindexAll(items.map((item: any) => ({
      id: item.id,
      title: item.title ?? '',
      description: item.description ?? '',
      tags: item.tags ?? [],
      comments: (commentsByItem.get(item.id) ?? []).join('\n'),
    })));

    console.log('Semantic index rebuild triggered in background.');
  } catch {
    // Best-effort; do not fail the rebuild-index command
  }
}
