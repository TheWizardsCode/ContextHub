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
/**
 * Persistent embedding store backed by a JSON sidecar file.
 *
 * Keyed by work item ID with content-hash staleness detection.
 * Follows the llm-wiki `embeddings.json` pattern.
 */
export declare class EmbeddingStore {
    private items;
    private dirty;
    private readonly filePath;
    constructor(filePath: string);
    /** Load index from disk */
    private load;
    /** Save index to disk if dirty */
    save(): void;
    /** Get an embedding record by item ID */
    get(itemId: string): EmbeddingRecord | null;
    /** Set (upsert) an embedding record */
    set(itemId: string, embedding: number[], contentHash: string): void;
    /** Delete an embedding record */
    delete(itemId: string): void;
    /** Check whether a stored embedding is stale (or missing) */
    isStale(itemId: string, currentContentHash: string): boolean;
    /** Get all embedding records */
    getAll(): Record<string, EmbeddingRecord>;
    /** Number of stored embeddings */
    size(): number;
    /** Clear all embeddings */
    clear(): void;
}
/**
 * Compute a deterministic content hash for a work item's indexable fields.
 * Used for staleness detection — if the hash matches the stored hash, the
 * embedding is up-to-date and doesn't need to be regenerated.
 */
export declare function contentHash(content: IndexableContent): string;
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
export declare class OpenAIEmbedder implements Embedder {
    readonly available: boolean;
    private readonly apiKey;
    private readonly baseUrl;
    private readonly model;
    constructor(config?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        hasExplicitConfig?: boolean;
    });
    generateEmbedding(text: string): Promise<number[]>;
}
/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
export declare function cosineSimilarity(a: number[], b: number[]): number;
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
export declare function fuseScores(lexical: FuseInput[], semantic: FuseInput[], options?: FuseOptions): FusedResult[];
/**
 * WorklogSearch orchestrates embedding generation, storage, and hybrid search.
 */
export declare class WorklogSearch {
    readonly store: EmbeddingStore;
    readonly embedder: Embedder;
    constructor(store: EmbeddingStore, embedder: Embedder);
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
    searchSync(query: string, lexicalResults: FuseInput[], semanticOption?: boolean | 'auto', options?: FuseOptions): FusedResult[];
    /** Cache for query embeddings to avoid redundant API calls */
    private queryEmbeddingCache;
    /**
     * Get (or compute) the embedding for a query string.
     * Uses in-memory cache to avoid redundant API calls for repeated searches.
     */
    private getCachedQueryEmbedding;
    /**
     * Pre-compute query embedding asynchronously and cache it.
     * Call this when the embedder is available to enable semantic search.
     */
    precomputeQueryEmbedding(query: string): Promise<number[] | null>;
    /**
     * Rank all cached embeddings by cosine similarity to the query embedding.
     */
    private rankByCachedEmbeddings;
    /**
     * Index a single work item for semantic search.
     *
     * Computes the content hash and skips indexing if the embedding is
     * already up-to-date (staleness detection).
     *
     * @returns true if the item was indexed, false if it was skipped (up-to-date)
     */
    indexWorkItem(content: IndexableContent, itemId: string): Promise<boolean>;
    /**
     * Remove a work item from the embedding index.
     */
    removeWorkItem(itemId: string): void;
    /**
     * Reindex all work items in the background.
     * Uses the runtime's single-flight guard for dedup.
     */
    reindexAll(items: Array<{
        id: string;
    } & IndexableContent>): void;
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
export declare function getDefaultEmbedder(): Embedder;
/**
 * Create a WorklogSearch instance with the given store and embedder.
 * If no embedder is provided, the default OpenAI embedder is used.
 */
export declare function createSearch(store: EmbeddingStore, embedder?: Embedder): WorklogSearch;
/**
 * Resolve the path to the embedding index file based on the worklog directory.
 */
export declare function getEmbeddingStorePath(worklogDir: string): string;
//# sourceMappingURL=search.d.ts.map