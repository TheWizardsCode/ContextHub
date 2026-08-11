/**
 * Semantic search module for Worklog
 *
 * Provides embedding generation, storage, and hybrid (lexical + semantic) search
 * for work items. All features are optional — when no embedder is configured,
 * the system gracefully falls back to FTS/full-text search.
 *
 * Architecture:
 *   Embedder (interface)         — abstraction over embedding providers
 *     OpenAIEmbedder             — OpenAI-compatible API embedder
 *   EmbeddingStore               — persistent JSON sidecar for embedding vectors
 *   contentHash()                — deterministic hash for staleness detection
 *   fuseScores()                 — hybrid scoring function
 *   createSearch()               — factory for WorklogSearch
 *   WorklogSearch                — orchestrator: index + search + reindex
 *
 * Inspired by the @zosmaai/pi-llm-wiki hybrid search pattern.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getRuntime } from './runtime.js';
// ---------------------------------------------------------------------------
// EmbeddingStore
// ---------------------------------------------------------------------------
const CURRENT_VERSION = 1;
/**
 * Persistent embedding store backed by a JSON sidecar file.
 *
 * Keyed by work item ID with content-hash staleness detection.
 * Follows the llm-wiki `embeddings.json` pattern.
 */
export class EmbeddingStore {
    items = {};
    dirty = false;
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
        this.load();
    }
    /** Load index from disk */
    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                const data = JSON.parse(raw);
                if (data && data.items && typeof data.items === 'object') {
                    this.items = data.items;
                }
            }
        }
        catch {
            // File corruption or missing — start with empty index
            this.items = {};
        }
    }
    /** Save index to disk if dirty */
    save() {
        if (!this.dirty)
            return;
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const data = {
            version: CURRENT_VERSION,
            items: this.items,
        };
        // Atomic write via temp file + rename
        const tmpPath = this.filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmpPath, this.filePath);
        this.dirty = false;
    }
    /** Get an embedding record by item ID */
    get(itemId) {
        return this.items[itemId] ?? null;
    }
    /** Set (upsert) an embedding record */
    set(itemId, embedding, contentHash) {
        this.items[itemId] = {
            embedding,
            contentHash,
            updatedAt: new Date().toISOString(),
        };
        this.dirty = true;
    }
    /** Delete an embedding record */
    delete(itemId) {
        if (this.items[itemId]) {
            delete this.items[itemId];
            this.dirty = true;
        }
    }
    /** Check whether a stored embedding is stale (or missing) */
    isStale(itemId, currentContentHash) {
        const record = this.items[itemId];
        if (!record)
            return true;
        return record.contentHash !== currentContentHash;
    }
    /** Get all embedding records */
    getAll() {
        return { ...this.items };
    }
    /** Number of stored embeddings */
    size() {
        return Object.keys(this.items).length;
    }
    /** Clear all embeddings */
    clear() {
        this.items = {};
        this.dirty = true;
    }
}
// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------
/**
 * Compute a deterministic content hash for a work item's indexable fields.
 * Used for staleness detection — if the hash matches the stored hash, the
 * embedding is up-to-date and doesn't need to be regenerated.
 */
export function contentHash(content) {
    const normalized = [
        content.title.trim().toLowerCase(),
        content.description.trim().toLowerCase(),
        content.tags.map(t => t.trim().toLowerCase()).sort().join(','),
        content.comments.trim().toLowerCase(),
    ].join('|');
    return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}
// ---------------------------------------------------------------------------
// Embedder implementations
// ---------------------------------------------------------------------------
/**
 * Default embedding configuration.
 */
const DEFAULT_EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
/**
 * OpenAI-compatible embedder.
 *
 * Configuration sources (highest priority first):
 *   1. Worklog config file (`.worklog/config.yaml` → `embedding.*` fields)
 *   2. Environment variables (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_EMBEDDING_MODEL`)
 *   3. Built-in defaults
 *
 * The embedder is considered **available** when any of these conditions hold:
 *   - An API key is set (config or env var)
 *   - An explicit embedding config section exists in `.worklog/config.yaml`
 *     (even without an API key — supports local providers like Ollama)
 *   - `OPENAI_BASE_URL` is set in the environment
 *   - `OPENAI_EMBEDDING_MODEL` is set in the environment
 *
 * When no API key is provided (e.g., local Ollama), the Authorization header
 * is omitted from API requests.
 */
export class OpenAIEmbedder {
    available;
    apiKey;
    baseUrl;
    model;
    constructor(config) {
        // Priority: 1) constructor config, 2) env vars, 3) defaults
        this.apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
        this.baseUrl = config?.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_EMBEDDING_BASE_URL;
        this.model = config?.model ?? process.env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
        // Available when:
        // - API key is set (cloud provider), OR
        // - Any embedding config is present (local provider, explicit user intent), OR
        // - OPENAI_BASE_URL or OPENAI_EMBEDDING_MODEL env vars are set (explicit choice)
        this.available = Boolean(this.apiKey ||
            config?.hasExplicitConfig ||
            process.env.OPENAI_BASE_URL ||
            process.env.OPENAI_EMBEDDING_MODEL);
    }
    async generateEmbedding(text) {
        if (!this.available) {
            throw new Error('Embedding provider is not configured. ' +
                'Set OPENAI_API_KEY, configure embedding in .worklog/config.yaml, ' +
                'or refer to CLI.md for local provider setup.');
        }
        const url = `${this.baseUrl.replace(/\/$/, '')}/embeddings`;
        // Build headers conditionally — local providers (Ollama) don't need auth
        const headers = {
            'Content-Type': 'application/json',
        };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                input: text,
                model: this.model,
            }),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Embedding API error: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
        }
        const data = await response.json();
        if (!data.data || data.data.length === 0) {
            throw new Error('Embedding API returned empty data');
        }
        return data.data[0].embedding;
    }
}
// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------
/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
export function cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0) {
        return 0;
    }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0)
        return 0;
    return dotProduct / magnitude;
}
// ---------------------------------------------------------------------------
// Hybrid scoring (fuseScores)
// ---------------------------------------------------------------------------
/**
 * Fuse lexical (FTS) and semantic (embedding) search results into a single
 * ranked list using configurable weights.
 *
 * Normalizes both score ranges to [0, 1] before blending.
 * - Lexical scores: BM25 ranks (lower is better) are inverted and min-max
 *   normalized so that lower rank = higher score.
 * - Semantic scores: cosine similarity (higher is better) is used as-is.
 *
 * Deduplication: if the same itemId appears in both lists, the two scores
 * are blended.
 */
export function fuseScores(lexical, semantic, options = {}) {
    const lexicalWeight = options.lexicalWeight ?? 0.5;
    const semanticWeight = options.semanticWeight ?? 0.5;
    // If both are empty, return empty
    if (lexical.length === 0 && semantic.length === 0) {
        return [];
    }
    // If one side is empty, return the other side ranked by its scores
    if (lexical.length === 0) {
        return normalizeSemanticOnly(semantic);
    }
    if (semantic.length === 0) {
        return normalizeLexicalOnly(lexical);
    }
    // Normalize lexical scores to [0, 1] where higher = better
    const lexicalMap = normalizeLexical(lexical);
    // Normalize semantic scores to [0, 1] where higher = better
    const semanticMap = normalizeSemantic(semantic);
    // Fuse: blend scores for items that exist in both lists
    const allIds = new Set([...lexicalMap.keys(), ...semanticMap.keys()]);
    const fused = [];
    for (const itemId of allIds) {
        const lexScore = lexicalMap.get(itemId)?.normalizedScore ?? 0;
        const semScore = semanticMap.get(itemId)?.normalizedScore ?? 0;
        const blended = lexScore * lexicalWeight + semScore * semanticWeight;
        // Pick the best snippet from whichever side has one
        const lexSnippet = lexicalMap.get(itemId)?.snippet ?? '';
        const semSnippet = semanticMap.get(itemId)?.snippet ?? '';
        const snippet = lexSnippet || semSnippet;
        const matchedColumn = lexSnippet
            ? (lexicalMap.get(itemId)?.matchedColumn ?? 'title')
            : (semanticMap.get(itemId)?.matchedColumn ?? 'semantic');
        fused.push({ itemId, score: blended, snippet, matchedColumn });
    }
    // Sort by score descending
    fused.sort((a, b) => b.score - a.score);
    return fused;
}
/** Normalize semantic-only results */
function normalizeSemanticOnly(items) {
    const normalized = normalizeSemantic(items);
    return items.map(item => ({
        itemId: item.itemId,
        score: normalized.get(item.itemId)?.normalizedScore ?? 0,
        snippet: item.snippet,
        matchedColumn: item.matchedColumn,
    })).sort((a, b) => b.score - a.score);
}
/** Normalize lexical-only results */
function normalizeLexicalOnly(items) {
    const normalized = normalizeLexical(items);
    return items.map(item => ({
        itemId: item.itemId,
        score: normalized.get(item.itemId)?.normalizedScore ?? 0,
        snippet: item.snippet,
        matchedColumn: item.matchedColumn,
    })).sort((a, b) => b.score - a.score);
}
/**
 * Normalize lexical (BM25) scores.
 * BM25: lower rank = better match.
 * Invert and min-max normalize so that best match = 1.0.
 * Special values: -Infinity (exact ID match) → 1.0
 */
function normalizeLexical(items) {
    const map = new Map();
    if (items.length === 0)
        return map;
    // Find min/max ranks (handle -Infinity)
    let minRank = Infinity;
    let maxRank = -Infinity;
    for (const item of items) {
        if (item.rank === -Infinity) {
            // Exact ID match — always perfect score
            continue;
        }
        if (item.rank < minRank)
            minRank = item.rank;
        if (item.rank > maxRank)
            maxRank = item.rank;
    }
    for (const item of items) {
        let normalizedScore;
        if (item.rank === -Infinity) {
            normalizedScore = 1.0;
        }
        else if (maxRank === minRank) {
            normalizedScore = 1.0; // All ranks equal
        }
        else {
            // Invert BM25 (lower rank = better) and normalize to [0, 1]
            normalizedScore = 1.0 - (item.rank - minRank) / (maxRank - minRank);
        }
        map.set(item.itemId, {
            normalizedScore,
            snippet: item.snippet,
            matchedColumn: item.matchedColumn,
        });
    }
    return map;
}
/**
 * Normalize semantic (cosine similarity) scores.
 * Higher similarity = better match, min-max normalize to [0, 1].
 */
function normalizeSemantic(items) {
    const map = new Map();
    if (items.length === 0)
        return map;
    let minSim = Infinity;
    let maxSim = -Infinity;
    for (const item of items) {
        if (item.rank < minSim)
            minSim = item.rank;
        if (item.rank > maxSim)
            maxSim = item.rank;
    }
    for (const item of items) {
        let normalizedScore;
        if (maxSim === minSim) {
            normalizedScore = 1.0;
        }
        else {
            normalizedScore = (item.rank - minSim) / (maxSim - minSim);
        }
        map.set(item.itemId, {
            normalizedScore,
            snippet: item.snippet,
            matchedColumn: item.matchedColumn,
        });
    }
    return map;
}
// ---------------------------------------------------------------------------
// WorklogSearch
// ---------------------------------------------------------------------------
/**
 * WorklogSearch orchestrates embedding generation, storage, and hybrid search.
 */
export class WorklogSearch {
    store;
    embedder;
    constructor(store, embedder) {
        this.store = store;
        this.embedder = embedder;
    }
    /**
     * Perform a synchronous hybrid search using pre-fetched lexical results.
     *
     * @param query - The search query text
     * @param lexicalResults - Results from FTS or fallback search
     * @param semanticOption - How to handle semantic search:
     *   - true: use cached embeddings for ranking (no API call)
     *   - false: skip semantic entirely
     * @param options - Scoring options
     * @returns Fused results sorted by blended relevance
     */
    searchSync(query, lexicalResults, semanticOption = 'auto', options) {
        const useSemantic = semanticOption === true || (semanticOption === 'auto' && this.embedder.available && this.store.size() > 0);
        if (!useSemantic) {
            return normalizeLexicalOnly(lexicalResults);
        }
        // Generate semantic results from cached embeddings
        const queryEmbedding = this.getCachedQueryEmbedding(query);
        const semanticResults = queryEmbedding
            ? this.rankByCachedEmbeddings(queryEmbedding)
            : [];
        if (semanticResults.length === 0) {
            return normalizeLexicalOnly(lexicalResults);
        }
        return fuseScores(lexicalResults, semanticResults, options);
    }
    /** Cache for query embeddings to avoid redundant API calls */
    queryEmbeddingCache = new Map();
    /**
     * Get (or compute) the embedding for a query string.
     * Uses in-memory cache to avoid redundant API calls for repeated searches.
     */
    getCachedQueryEmbedding(query) {
        const normalized = query.trim().toLowerCase();
        if (!normalized)
            return null;
        const cached = this.queryEmbeddingCache.get(normalized);
        if (cached)
            return cached;
        // If embedder is not available, we can't compute query embeddings
        // This is fine — we fall back to lexical-only
        return null;
    }
    /**
     * Pre-compute query embedding asynchronously and cache it.
     * Call this when the embedder is available to enable semantic search.
     */
    async precomputeQueryEmbedding(query) {
        if (!this.embedder.available)
            return null;
        const normalized = query.trim().toLowerCase();
        if (!normalized)
            return null;
        try {
            const embedding = await this.embedder.generateEmbedding(normalized);
            this.queryEmbeddingCache.set(normalized, embedding);
            return embedding;
        }
        catch {
            // Embedding generation failed — semantic search degrades gracefully
            return null;
        }
    }
    /**
     * Rank all cached embeddings by cosine similarity to the query embedding.
     */
    rankByCachedEmbeddings(queryEmbedding) {
        const results = [];
        const all = this.store.getAll();
        for (const [itemId, record] of Object.entries(all)) {
            const similarity = cosineSimilarity(queryEmbedding, record.embedding);
            if (similarity > 0) {
                results.push({
                    itemId,
                    rank: similarity,
                    snippet: '',
                    matchedColumn: 'semantic',
                });
            }
        }
        // Sort by similarity descending
        results.sort((a, b) => b.rank - a.rank);
        return results;
    }
    /**
     * Index a single work item for semantic search.
     *
     * Computes the content hash and skips indexing if the embedding is
     * already up-to-date (staleness detection).
     *
     * @returns true if the item was indexed, false if it was skipped (up-to-date)
     */
    async indexWorkItem(content, itemId) {
        if (!this.embedder.available)
            return false;
        const hash = contentHash(content);
        // Skip if embedding is up-to-date
        if (!this.store.isStale(itemId, hash)) {
            return false;
        }
        // Generate text for embedding (concatenate fields)
        const textForEmbedding = [
            content.title,
            content.description,
            content.tags.join(' '),
            content.comments,
        ].filter(s => s.length > 0).join('\n');
        if (!textForEmbedding.trim()) {
            return false;
        }
        try {
            const embedding = await this.embedder.generateEmbedding(textForEmbedding);
            this.store.set(itemId, embedding, hash);
            this.store.save();
            return true;
        }
        catch {
            // Embedding generation failed — skip silently; will retry on next mutation
            return false;
        }
    }
    /**
     * Remove a work item from the embedding index.
     */
    removeWorkItem(itemId) {
        this.store.delete(itemId);
        this.store.save();
    }
    /**
     * Reindex all work items in the background.
     * Uses the runtime's single-flight guard for dedup.
     */
    reindexAll(items) {
        getRuntime().launchTask('semantic-reindex', async () => {
            for (const item of items) {
                await this.indexWorkItem(item, item.id);
            }
        });
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
let _defaultEmbedder = null;
/**
 * Try to load embedding config from the worklog config file.
 *
 * Uses a `createRequire`-based synchronous require to call `loadConfigRelaxed()`
 * from `../config.js` without needing an async boundary. This is safe because
 * `loadConfigRelaxed()` is purely synchronous (reads a YAML file).
 */
function loadEmbeddingConfig() {
    try {
        const _require = createRequire(fileURLToPath(import.meta.url));
        const configModule = _require('../config.js');
        const config = configModule.loadConfigRelaxed();
        if (config?.embedding) {
            const ec = config.embedding;
            return {
                apiKey: ec.apiKey || undefined,
                baseUrl: ec.baseUrl || undefined,
                model: ec.model || undefined,
                hasExplicitConfig: true,
            };
        }
        return { hasExplicitConfig: false };
    }
    catch {
        return { hasExplicitConfig: false };
    }
}
/**
 * Get or create the default embedder (OpenAI-compatible).
 *
 * Configuration sources (highest priority first):
 *   1. `.worklog/config.yaml` → `embedding.*` fields
 *   2. Environment variables (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_EMBEDDING_MODEL`)
 *   3. Built-in defaults
 *
 * Returns an embedder with `available: false` when no configuration is found,
 * which causes all semantic search operations to gracefully fall back to
 * FTS-only search.
 */
export function getDefaultEmbedder() {
    if (!_defaultEmbedder) {
        const config = loadEmbeddingConfig();
        _defaultEmbedder = new OpenAIEmbedder(config ?? undefined);
    }
    return _defaultEmbedder;
}
/**
 * Create a WorklogSearch instance with the given store and embedder.
 * If no embedder is provided, the default OpenAI embedder is used.
 */
export function createSearch(store, embedder) {
    return new WorklogSearch(store, embedder ?? getDefaultEmbedder());
}
/**
 * Resolve the path to the embedding index file based on the worklog directory.
 */
export function getEmbeddingStorePath(worklogDir) {
    return path.join(worklogDir, 'embedding-index.json');
}
//# sourceMappingURL=search.js.map