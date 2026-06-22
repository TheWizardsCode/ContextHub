/**
 * Tests for semantic search module (src/lib/search.ts)
 *
 * Tests cover:
 * - EmbeddingStore: read/write, staleness detection, edge cases
 * - fuseScores: hybrid scoring function
 * - Embedder interface: graceful degradation
 * - WorklogSearch: integration with FTS
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  EmbeddingStore,
  fuseScores,
  type EmbeddingRecord,
  type FuseInput,
  type FusedResult,
} from '../../src/lib/search.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';

// ---------------------------------------------------------------------------
// EmbeddingStore tests
// ---------------------------------------------------------------------------

describe('EmbeddingStore', () => {
  let tempDir: string;
  let storePath: string;
  let store: EmbeddingStore;

  beforeEach(() => {
    tempDir = createTempDir();
    storePath = path.join(tempDir, 'embedding-index.json');
    store = new EmbeddingStore(storePath);
  });

  afterEach(() => {
    store = null!;
    cleanupTempDir(tempDir);
  });

  it('should start with an empty index', () => {
    expect(store.size()).toBe(0);
  });

  it('should persist and retrieve an embedding', () => {
    store.set('WL-TEST-001', [0.1, 0.2, 0.3], 'hash1');

    const record = store.get('WL-TEST-001');
    expect(record).not.toBeNull();
    expect(record!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(record!.contentHash).toBe('hash1');
  });

  it('should update an existing embedding', () => {
    store.set('WL-TEST-001', [0.1, 0.2, 0.3], 'hash1');
    store.set('WL-TEST-001', [0.4, 0.5, 0.6], 'hash2');

    const record = store.get('WL-TEST-001');
    expect(record!.embedding).toEqual([0.4, 0.5, 0.6]);
    expect(record!.contentHash).toBe('hash2');
  });

  it('should delete an embedding', () => {
    store.set('WL-TEST-001', [0.1, 0.2, 0.3], 'hash1');
    store.delete('WL-TEST-001');

    expect(store.get('WL-TEST-001')).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('should persist to disk and reload', () => {
    store.set('WL-TEST-001', [0.1, 0.2, 0.3], 'hash1');
    store.set('WL-TEST-002', [0.4, 0.5, 0.6], 'hash2');
    store.save();

    // Create a new store instance pointing at the same file
    const store2 = new EmbeddingStore(storePath);
    expect(store2.size()).toBe(2);

    const r1 = store2.get('WL-TEST-001');
    expect(r1!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(r1!.contentHash).toBe('hash1');

    const r2 = store2.get('WL-TEST-002');
    expect(r2!.embedding).toEqual([0.4, 0.5, 0.6]);
    expect(r2!.contentHash).toBe('hash2');
  });

  it('should detect staleness via content hash', () => {
    store.set('WL-TEST-001', [0.1, 0.2, 0.3], 'hash1');
    expect(store.isStale('WL-TEST-001', 'hash1')).toBe(false);
    expect(store.isStale('WL-TEST-001', 'hash2')).toBe(true);
    expect(store.isStale('WL-TEST-999', 'any')).toBe(true);
  });

  it('should return null for missing entries', () => {
    expect(store.get('NONEXISTENT')).toBeNull();
  });

  it('should handle empty embedding vectors', () => {
    store.set('WL-TEST-001', [], 'hash1');
    const record = store.get('WL-TEST-001');
    expect(record).not.toBeNull();
    expect(record!.embedding).toEqual([]);
  });

  it('should handle many embeddings', () => {
    const count = 100;
    for (let i = 0; i < count; i++) {
      store.set(`WL-TEST-${i}`, [i * 0.01, i * 0.02], `hash-${i}`);
    }
    expect(store.size()).toBe(count);

    for (let i = 0; i < count; i++) {
      const r = store.get(`WL-TEST-${i}`);
      expect(r).not.toBeNull();
      expect(r!.embedding[0]).toBe(i * 0.01);
    }
  });

  it('should return all entries', () => {
    store.set('WL-TEST-001', [0.1, 0.2], 'hash1');
    store.set('WL-TEST-002', [0.3, 0.4], 'hash2');

    const all = store.getAll();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all['WL-TEST-001'].embedding).toEqual([0.1, 0.2]);
    expect(all['WL-TEST-002'].embedding).toEqual([0.3, 0.4]);
  });

  it('should survive save() with empty index', () => {
    store.save(); // Should not throw
    expect(store.size()).toBe(0);
  });

  it('should handle disk file corruption gracefully', () => {
    // Write corrupted JSON
    fs.writeFileSync(storePath, '{invalid json', 'utf-8');
    const store2 = new EmbeddingStore(storePath);
    expect(store2.size()).toBe(0); // Should recover with empty index
  });

  it('should clear all embeddings', () => {
    store.set('WL-TEST-001', [0.1], 'hash1');
    store.set('WL-TEST-002', [0.2], 'hash2');
    store.clear();

    expect(store.size()).toBe(0);
    expect(store.get('WL-TEST-001')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fuseScores tests
// ---------------------------------------------------------------------------

describe('fuseScores', () => {
  it('should return lexical results when no semantic results exist', () => {
    const lexical: FuseInput[] = [
      { itemId: 'A', rank: 1.0, snippet: 'snippet A', matchedColumn: 'title' },
      { itemId: 'B', rank: 2.0, snippet: 'snippet B', matchedColumn: 'title' },
    ];

    const result = fuseScores(lexical, [], { lexicalWeight: 1.0, semanticWeight: 0.0 });
    expect(result).toHaveLength(2);
    expect(result[0].itemId).toBe('A');
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it('should return semantic results when no lexical results exist', () => {
    const semantic: FuseInput[] = [
      { itemId: 'A', rank: 0.9, snippet: 'sem A', matchedColumn: 'semantic' },
      { itemId: 'B', rank: 0.6, snippet: 'sem B', matchedColumn: 'semantic' },
    ];

    const result = fuseScores([], semantic, { lexicalWeight: 0.0, semanticWeight: 1.0 });
    expect(result).toHaveLength(2);
    expect(result[0].itemId).toBe('A');
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it('should blend lexical and semantic scores', () => {
    // Item A: strong lexical match (rank 0.5), weak semantic (rank 0.3)
    // Item B: weak lexical match (rank 50.0), moderate semantic (rank 0.6)
    // Item C: moderate lexical match (rank 20.0), strong semantic (rank 0.9)
    // This ensures the blend distinguishes them clearly
    const lexical: FuseInput[] = [
      { itemId: 'A', rank: 0.5, snippet: 'snippet A', matchedColumn: 'title' },
      { itemId: 'B', rank: 50.0, snippet: 'snippet B', matchedColumn: 'title' },
      { itemId: 'C', rank: 20.0, snippet: 'snippet C', matchedColumn: 'title' },
    ];

    const semantic: FuseInput[] = [
      { itemId: 'A', rank: 0.3, snippet: 'sem A', matchedColumn: 'semantic' },
      { itemId: 'B', rank: 0.6, snippet: 'sem B', matchedColumn: 'semantic' },
      { itemId: 'C', rank: 0.9, snippet: 'sem C', matchedColumn: 'semantic' },
    ];

    // Equal weights: C should win (strong semantic + moderate lexical),
    // then A (strong lexical + weak semantic), then B
    const result = fuseScores(lexical, semantic, { lexicalWeight: 0.5, semanticWeight: 0.5 });
    expect(result).toHaveLength(3);
    expect(result[0].itemId).toBe('C');
    expect(result[1].itemId).toBe('A');
    expect(result[2].itemId).toBe('B');
  });

  it('should prefer lexical when weight is skewed', () => {
    const lexical: FuseInput[] = [
      { itemId: 'A', rank: 0.5, snippet: 'snippet A', matchedColumn: 'title' },
      { itemId: 'C', rank: 20.0, snippet: 'snippet C', matchedColumn: 'title' },
      { itemId: 'B', rank: 50.0, snippet: 'snippet B', matchedColumn: 'title' },
    ];

    const semantic: FuseInput[] = [
      { itemId: 'A', rank: 0.3, snippet: 'sem A', matchedColumn: 'semantic' },
      { itemId: 'C', rank: 0.9, snippet: 'sem C', matchedColumn: 'semantic' },
      { itemId: 'B', rank: 0.6, snippet: 'sem B', matchedColumn: 'semantic' },
    ];

    // Heavy lexical weight (0.9): A wins (best lexical)
    const result = fuseScores(lexical, semantic, { lexicalWeight: 0.9, semanticWeight: 0.1 });
    expect(result[0].itemId).toBe('A');
  });

  it('should prefer semantic when weight is skewed', () => {
    const lexical: FuseInput[] = [
      { itemId: 'A', rank: 0.5, snippet: 'snippet A', matchedColumn: 'title' },
      { itemId: 'C', rank: 20.0, snippet: 'snippet C', matchedColumn: 'title' },
      { itemId: 'B', rank: 50.0, snippet: 'snippet B', matchedColumn: 'title' },
    ];

    const semantic: FuseInput[] = [
      { itemId: 'A', rank: 0.3, snippet: 'sem A', matchedColumn: 'semantic' },
      { itemId: 'C', rank: 0.9, snippet: 'sem C', matchedColumn: 'semantic' },
      { itemId: 'B', rank: 0.6, snippet: 'sem B', matchedColumn: 'semantic' },
    ];

    // Heavy semantic weight (0.9): C wins (best semantic), B second (decent semantic + weak lexical)
    const result = fuseScores(lexical, semantic, { lexicalWeight: 0.1, semanticWeight: 0.9 });
    expect(result[0].itemId).toBe('C');
    expect(result[1].itemId).toBe('B');
    expect(result[2].itemId).toBe('A');
  });

  it('should handle empty inputs gracefully', () => {
    const result = fuseScores([], []);
    expect(result).toEqual([]);
  });

  it('should handle malformed ranks (negative, Infinity)', () => {
    const lexical: FuseInput[] = [
      { itemId: 'A', rank: -Infinity, snippet: 'exact match', matchedColumn: 'id' },
    ];

    const semantic: FuseInput[] = [
      { itemId: 'B', rank: 0.8, snippet: 'sem B', matchedColumn: 'semantic' },
    ];

    // Should not throw
    const result = fuseScores(lexical, semantic);
    expect(result.length).toBeGreaterThan(0);
  });

  it('should deduplicate items by itemId, preferring higher blended score', () => {
    // Same item appears in both lists
    const lexical: FuseInput[] = [
      { itemId: 'A', rank: 1.0, snippet: 'lex A', matchedColumn: 'title' },
    ];
    const semantic: FuseInput[] = [
      { itemId: 'A', rank: 0.9, snippet: 'sem A', matchedColumn: 'semantic' },
    ];

    const result = fuseScores(lexical, semantic);
    expect(result).toHaveLength(1);
    expect(result[0].itemId).toBe('A');
    // Score should be blended
    expect(result[0].score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// WorklogSearch integration tests
// ---------------------------------------------------------------------------

describe('WorklogSearch', () => {
  let tempDir: string;
  let storePath: string;
  let store: EmbeddingStore;

  beforeEach(() => {
    tempDir = createTempDir();
    storePath = path.join(tempDir, 'embedding-index.json');
    store = new EmbeddingStore(storePath);
  });

  afterEach(() => {
    store = null!;
    cleanupTempDir(tempDir);
  });

  describe('searchWithoutEmbedder', () => {
    it('should return lexical results when no embedder is configured', async () => {
      // Import dynamically to avoid side effects
      const mod = await import('../../src/lib/search.js');
      type Embedder = import('../../src/lib/search.js').Embedder;

      const noopEmbedder: Embedder = {
        available: false,
        generateEmbedding: async () => { throw new Error('Not configured'); },
      };

      const search = mod.createSearch(store, noopEmbedder);

      // Call searchSync should work without an embedder
      const result = search.searchSync(
        'test query',
        [
          { itemId: 'A', rank: 0.5, snippet: 'test snippet', matchedColumn: 'title' },
        ],
        []
      );

      expect(result).toHaveLength(1);
      expect(result[0].itemId).toBe('A');
    });
  });

  describe('contentHash', () => {
    it('should produce consistent hashes for the same content', async () => {
      const { contentHash } = await import('../../src/lib/search.js');

      const hash1 = contentHash({ title: 'Test', description: 'Desc', tags: ['tag1'], comments: 'com' });
      const hash2 = contentHash({ title: 'Test', description: 'Desc', tags: ['tag1'], comments: 'com' });
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', async () => {
      const { contentHash } = await import('../../src/lib/search.js');

      const hash1 = contentHash({ title: 'Test', description: 'Desc', tags: ['tag1'], comments: 'com' });
      const hash2 = contentHash({ title: 'Test', description: 'Changed', tags: ['tag1'], comments: 'com' });
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty fields', async () => {
      const { contentHash } = await import('../../src/lib/search.js');

      const hash = contentHash({ title: '', description: '', tags: [], comments: '' });
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
    });
  });
});
