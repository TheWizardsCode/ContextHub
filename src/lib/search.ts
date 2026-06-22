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
import { getRuntime } from './runtime.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single embedding record persisted in the store */
export interface EmbeddingRecord {
  /** Embedding vector (array of floats) */
  embedding: number[];
  /** Content hash for staleness detection */
  contentHash: string;
  /** ISO timestamp of when this embedding was last updated */
  updatedAt: string;
}

/** Index file structure on disk */
export interface EmbeddingIndex {
  version: number;
  items: Record<string, EmbeddingRecord>;
}

/** Input to the fuseScores hybrid scoring function */
export interface FuseInput {
  itemId: string;
  /** BM25 rank (FTS) or cosine similarity (semantic) — lower is better for BM25, higher is better for cosine similarity */
  rank: number;
  snippet: string;
  matchedColumn: string;
}

/** A fused result from hybrid scoring */
export interface FusedResult {
  itemId: string;
  /** Blended score between 0 and 1 (higher = more relevant) */
  score: number;
  snippet: string;
  matchedColumn: string;
}

/** Options for fuseScores */
export interface FuseOptions {
  /** Weight for lexical (FTS) scores in the blend (0.0 to 1.0, default 0.5) */
  lexicalWeight?: number;
  /** Weight for semantic scores in the blend (0.0 to 1.0, default 0.5) */
  semanticWeight?: number;
}

/** Embedder interface — abstraction over embedding providers */
export interface Embedder {
  /** Whether this embedder is available/configured */
  readonly available: boolean;
  /** Generate an embedding vector for the given text */
  generateEmbedding(text: string): Promise<number[]>;
}

/** Content for content hash computation */
export interface IndexableContent {
  title: string;
  description: string;
  tags: string[];
  comments: string;
}

/** Options for WorklogSearch */
export interface SearchOptions {
  /** Max results to return (default: 20) */
  limit?: number;
  /** Whether to use semantic enhancement (default: true when embedder is available) */
  semantic?: boolean;
  /** Lexical weight for hybrid scoring (default: 0.5) */
  lexicalWeight?: number;
  /** Semantic weight for hybrid scoring (default: 0.5) */
  semanticWeight?: number;
}

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
  private items: Record<string, EmbeddingRecord> = {};
  private dirty = false;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /** Load index from disk */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(raw) as EmbeddingIndex;
        if (data && data.items && typeof data.items === 'object') {
          this.items = data.items;
        }
      }
    } catch {
      // File corruption or missing — start with empty index
      this.items = {};
    }
  }

  /** Save index to disk if dirty */
  save(): void {
    if (!this.dirty) return;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data: EmbeddingIndex = {
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
  get(itemId: string): EmbeddingRecord | null {
    return this.items[itemId] ?? null;
  }

  /** Set (upsert) an embedding record */
  set(itemId: string, embedding: number[], contentHash: string): void {
    this.items[itemId] = {
      embedding,
      contentHash,
      updatedAt: new Date().toISOString(),
    };
    this.dirty = true;
  }

  /** Delete an embedding record */
  delete(itemId: string): void {
    if (this.items[itemId]) {
      delete this.items[itemId];
      this.dirty = true;
    }
  }

  /** Check whether a stored embedding is stale (or missing) */
  isStale(itemId: string, currentContentHash: string): boolean {
    const record = this.items[itemId];
    if (!record) return true;
    return record.contentHash !== currentContentHash;
  }

  /** Get all embedding records */
  getAll(): Record<string, EmbeddingRecord> {
    return { ...this.items };
  }

  /** Number of stored embeddings */
  size(): number {
    return Object.keys(this.items).length;
  }

  /** Clear all embeddings */
  clear(): void {
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
export function contentHash(content: IndexableContent): string {
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
 * Reads configuration from environment variables:
 *   OPENAI_API_KEY           — API key (required for operation)
 *   OPENAI_BASE_URL          — API base URL (default: https://api.openai.com/v1)
 *   OPENAI_EMBEDDING_MODEL   — Model name (default: text-embedding-3-small)
 */
export class OpenAIEmbedder implements Embedder {
  readonly available: boolean;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || '';
    this.baseUrl = process.env.OPENAI_BASE_URL || DEFAULT_EMBEDDING_BASE_URL;
    this.model = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
    this.available = this.apiKey.length > 0;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.available) {
      throw new Error('OpenAI embedder is not configured. Set OPENAI_API_KEY.');
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/embeddings`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: text,
        model: this.model,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

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
export function cosineSimilarity(a: number[], b: number[]): number {
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
  if (magnitude === 0) return 0;

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
export function fuseScores(
  lexical: FuseInput[],
  semantic: FuseInput[],
  options: FuseOptions = {},
): FusedResult[] {
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
  const allIds = new Set<string>([...lexicalMap.keys(), ...semanticMap.keys()]);
  const fused: FusedResult[] = [];

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
function normalizeSemanticOnly(items: FuseInput[]): FusedResult[] {
  const normalized = normalizeSemantic(items);
  return items.map(item => ({
    itemId: item.itemId,
    score: normalized.get(item.itemId)?.normalizedScore ?? 0,
    snippet: item.snippet,
    matchedColumn: item.matchedColumn,
  })).sort((a, b) => b.score - a.score);
}

/** Normalize lexical-only results */
function normalizeLexicalOnly(items: FuseInput[]): FusedResult[] {
  const normalized = normalizeLexical(items);
  return items.map(item => ({
    itemId: item.itemId,
    score: normalized.get(item.itemId)?.normalizedScore ?? 0,
    snippet: item.snippet,
    matchedColumn: item.matchedColumn,
  })).sort((a, b) => b.score - a.score);
}

interface NormalizedEntry {
  normalizedScore: number;
  snippet: string;
  matchedColumn: string;
}

/**
 * Normalize lexical (BM25) scores.
 * BM25: lower rank = better match.
 * Invert and min-max normalize so that best match = 1.0.
 * Special values: -Infinity (exact ID match) → 1.0
 */
function normalizeLexical(items: FuseInput[]): Map<string, NormalizedEntry> {
  const map = new Map<string, NormalizedEntry>();

  if (items.length === 0) return map;

  // Find min/max ranks (handle -Infinity)
  let minRank = Infinity;
  let maxRank = -Infinity;

  for (const item of items) {
    if (item.rank === -Infinity) {
      // Exact ID match — always perfect score
      continue;
    }
    if (item.rank < minRank) minRank = item.rank;
    if (item.rank > maxRank) maxRank = item.rank;
  }

  for (const item of items) {
    let normalizedScore: number;

    if (item.rank === -Infinity) {
      normalizedScore = 1.0;
    } else if (maxRank === minRank) {
      normalizedScore = 1.0; // All ranks equal
    } else {
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
function normalizeSemantic(items: FuseInput[]): Map<string, NormalizedEntry> {
  const map = new Map<string, NormalizedEntry>();

  if (items.length === 0) return map;

  let minSim = Infinity;
  let maxSim = -Infinity;

  for (const item of items) {
    if (item.rank < minSim) minSim = item.rank;
    if (item.rank > maxSim) maxSim = item.rank;
  }

  for (const item of items) {
    let normalizedScore: number;

    if (maxSim === minSim) {
      normalizedScore = 1.0;
    } else {
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
  readonly store: EmbeddingStore;
  readonly embedder: Embedder;

  constructor(store: EmbeddingStore, embedder: Embedder) {
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
  searchSync(
    query: string,
    lexicalResults: FuseInput[],
    semanticOption: boolean | 'auto' = 'auto',
    options?: FuseOptions,
  ): FusedResult[] {
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
  private queryEmbeddingCache = new Map<string, number[]>();

  /**
   * Get (or compute) the embedding for a query string.
   * Uses in-memory cache to avoid redundant API calls for repeated searches.
   */
  private getCachedQueryEmbedding(query: string): number[] | null {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;

    const cached = this.queryEmbeddingCache.get(normalized);
    if (cached) return cached;

    // If embedder is not available, we can't compute query embeddings
    // This is fine — we fall back to lexical-only
    return null;
  }

  /**
   * Pre-compute query embedding asynchronously and cache it.
   * Call this when the embedder is available to enable semantic search.
   */
  async precomputeQueryEmbedding(query: string): Promise<number[] | null> {
    if (!this.embedder.available) return null;

    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;

    try {
      const embedding = await this.embedder.generateEmbedding(normalized);
      this.queryEmbeddingCache.set(normalized, embedding);
      return embedding;
    } catch {
      // Embedding generation failed — semantic search degrades gracefully
      return null;
    }
  }

  /**
   * Rank all cached embeddings by cosine similarity to the query embedding.
   */
  private rankByCachedEmbeddings(queryEmbedding: number[]): FuseInput[] {
    const results: FuseInput[] = [];
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
  async indexWorkItem(content: IndexableContent, itemId: string): Promise<boolean> {
    if (!this.embedder.available) return false;

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
    } catch {
      // Embedding generation failed — skip silently; will retry on next mutation
      return false;
    }
  }

  /**
   * Remove a work item from the embedding index.
   */
  removeWorkItem(itemId: string): void {
    this.store.delete(itemId);
    this.store.save();
  }

  /**
   * Reindex all work items in the background.
   * Uses the runtime's single-flight guard for dedup.
   */
  reindexAll(items: Array<{ id: string } & IndexableContent>): void {
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

let _defaultEmbedder: Embedder | null = null;

/**
 * Get or create the default embedder (OpenAI-compatible).
 * Returns a noop embedder that reports `available: false` when not configured.
 */
export function getDefaultEmbedder(): Embedder {
  if (!_defaultEmbedder) {
    _defaultEmbedder = new OpenAIEmbedder();
  }
  return _defaultEmbedder;
}

/**
 * Create a WorklogSearch instance with the given store and embedder.
 * If no embedder is provided, the default OpenAI embedder is used.
 */
export function createSearch(
  store: EmbeddingStore,
  embedder?: Embedder,
): WorklogSearch {
  return new WorklogSearch(store, embedder ?? getDefaultEmbedder());
}

/**
 * Resolve the path to the embedding index file based on the worklog directory.
 */
export function getEmbeddingStorePath(worklogDir: string): string {
  return path.join(worklogDir, 'embedding-index.json');
}
