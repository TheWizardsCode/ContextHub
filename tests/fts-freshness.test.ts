/**
 * Tests for FTS index freshness and query-error surfacing.
 *
 * Covers the gaps identified in WL-0MSLW8UCP001771K:
 *   - import()/upsertItems() do not update the FTS index
 *   - reconcile paths do not update the FTS index
 *   - FTS5 syntax errors are silently swallowed
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorklogDatabase } from '../src/database.js';
import { createTempDir, cleanupTempDir, createTempDbPath, createTempJsonlPath } from './test-utils.js';

describe('FTS index freshness', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  describe('import() freshness', () => {
    it('should find imported items in search without rebuilding the index', () => {
      const now = new Date().toISOString();
      db.import([
        {
          id: 'TEST-0000000000000001',
          title: 'Imported bug fix',
          description: 'This item was imported via sync',
          status: 'open',
          priority: 'high',
          sortIndex: 1,
          tags: ['bug'],
          createdAt: now,
          updatedAt: now,
        },
      ]);

      // No rebuild — search should find the imported item
      const { results } = db.search('imported bug');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].itemId).toBe('TEST-0000000000000001');
    });

    it('should find imported comments in search without rebuilding the index', () => {
      const now = new Date().toISOString();
      const item = {
        id: 'TEST-0000000000000002',
        title: 'Imported with comments',
        description: 'Has searchable comments',
        status: 'open',
        priority: 'medium',
        sortIndex: 1,
        tags: [],
        createdAt: now,
        updatedAt: now,
      };

      // Import the item first (without comments — comments are synced separately)
      db.import([item]);

      // Then import the comment via the comment-specific import path
      db.importComments([
        {
          id: 'TEST-CMT-0000000000000001',
          workItemId: item.id,
          author: 'sync-agent',
          comment: 'shipped in v0.1.11',
          createdAt: now,
          references: [],
        },
      ]);

      // Search should find the comment text immediately
      const { results } = db.search('shipped in');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].itemId).toBe(item.id);
    });

    it('should not find deleted-imported items (FTS stale entries removed by re-index)', () => {
      const now = new Date().toISOString();
      // First, create and then import with the same item removed
      db.create({ title: 'Old item to be removed' });
      db.import([]); // Import empty list — clears everything

      const { results } = db.search('old item');
      expect(results.length).toBe(0);
    });

    it('should handle repeated imports idempotently (no duplicate FTS rows)', () => {
      const now = new Date().toISOString();
      const item = {
        id: 'TEST-0000000000000003',
        title: 'Repeated import test',
        description: 'Imported multiple times',
        status: 'open',
        priority: 'low',
        sortIndex: 1,
        tags: [],
        createdAt: now,
        updatedAt: now,
      };

      db.import([item]);
      db.import([item]);
      db.import([item]);

      // Should still find exactly one match
      const { results } = db.search('repeated import');
      const matching = results.filter(r => r.itemId === item.id);
      expect(matching.length).toBe(1);
    });
  });

  describe('upsertItems() freshness', () => {
    it('should find newly upserted items in search without rebuilding the index', () => {
      const now = new Date().toISOString();
      // Create initial items
      db.create({ title: 'Existing item' });

      // Upsert new items
      db.upsertItems([
        {
          id: 'TEST-0000000000000004',
          title: 'Newly upserted item',
          description: 'This item was upserted',
          status: 'open',
          priority: 'medium',
          sortIndex: 1,
          tags: ['delta'],
          createdAt: now,
          updatedAt: now,
        },
      ]);

      // Should be searchable without rebuild
      const { results } = db.search('newly upserted');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].itemId).toBe('TEST-0000000000000004');
    });

    it('should find updated items with changed text in search without rebuilding', () => {
      const item = db.create({ title: 'Original title', description: 'Original desc' });

      // Update the item via upsertItems
      db.upsertItems([
        {
          ...item,
          title: 'Updated title with keyword',
          description: 'Completely new description content here',
          updatedAt: new Date().toISOString(),
        },
      ]);

      // The new text should be searchable
      const { results: newResults } = db.search('updated title keyword');
      expect(newResults.length).toBeGreaterThanOrEqual(1);
      expect(newResults[0].itemId).toBe(item.id);
    });
  });

  describe('reconcile status freshness', () => {
    it('should reflect status change from reconcile in status-filtered search', () => {
      // Create an open item
      const item = db.create({ title: 'Reconcile test item', status: 'open' });

      // Create a blocker
      const blocker = db.create({ title: 'Blocker item' });
      db.addDependencyEdge(item.id, blocker.id);

      // Block the item (simulating what the dependency system does)
      db.update(item.id, { status: 'blocked' });

      // Status-filtered search should reflect blocked status
      const blockedResults = db.search('reconcile', { status: 'blocked' });
      expect(blockedResults.results.length).toBeGreaterThanOrEqual(1);

      // Now complete the blocker
      db.update(blocker.id, { status: 'completed' });

      // Reconcile should unblock the dependent
      db.reconcileDependentStatus(item.id);

      // Now status-filtered search should show it as open, not blocked
      const openResults = db.search('reconcile', { status: 'open' });
      expect(openResults.results.length).toBeGreaterThanOrEqual(1);
      const openFound = openResults.results.find(r => r.itemId === item.id);
      expect(openFound).toBeDefined();

      const blockedResultsAfter = db.search('reconcile', { status: 'blocked' });
      const blockedFound = blockedResultsAfter.results.find(r => r.itemId === item.id);
      expect(blockedFound).toBeUndefined();
    });
  });

  describe('create + comment freshness (AC1)', () => {
    it('finds a freshly created item and its comment without rebuilding (AC1)', () => {
      const item = db.create({ title: 'Create-fresh item', description: 'description body' });
      db.createComment({
        workItemId: item.id,
        author: 'tester',
        comment: 'shipped in v1.0.0',
      });

      // Title searchable immediately (no rebuild)
      const titleResults = db.search('create-fresh');
      expect(titleResults.results.length).toBeGreaterThanOrEqual(1);

      // Comment text searchable immediately (no rebuild)
      const commentResults = db.search('shipped in');
      expect(commentResults.results.length).toBeGreaterThanOrEqual(1);
      expect(commentResults.results[0].itemId).toBe(item.id);
    });
  });

  describe('delete freshness (AC3)', () => {
    it('removes a deleted item from search results (AC3)', () => {
      const item = db.create({ title: 'Doomed item', description: 'this will be deleted' });

      const before = db.search('doomed');
      expect(before.results.length).toBeGreaterThanOrEqual(1);

      db.delete(item.id);

      // Deleted (soft) items are hidden from search by default
      const after = db.search('doomed');
      expect(after.results.find(r => r.itemId === item.id)).toBeUndefined();
    });

    it('removes a deleted comment from search results (AC3)', () => {
      const item = db.create({ title: 'Comment host item' });
      const comment = db.createComment({
        workItemId: item.id,
        author: 'tester',
        comment: 'ephemeral comment text',
      });

      const before = db.search('ephemeral comment');
      expect(before.results.find(r => r.itemId === item.id)).toBeDefined();

      db.deleteComment(comment.id);

      const after = db.search('ephemeral comment');
      expect(after.results.find(r => r.itemId === item.id)).toBeUndefined();
    });
  });
});

describe('FTS query-error surfacing', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('should auto-quote punctuated terms and issue a warning (never silent)', () => {
    db.create({ title: 'Release v0.1.11' });

    // A punctuated term like v0.1.11 trips the FTS5 parser.
    // Per producer Q2 decision: auto-quote as a phrase + visible warning.
    const { results, warning } = db.search('v0.1.11');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(warning).toBeDefined();
    expect(warning).toContain('auto-quoted');
  });

  it('should auto-quote file-path style queries with a warning', () => {
    db.create({ title: 'Fix indentation in src/lib/util.ts' });

    const { results, warning } = db.search('src/lib/util.ts');
    // The phrase "src/lib/util.ts" matches the title if indexed; at a
    // minimum the query must not throw or return silently without warning.
    expect(warning).toBeDefined();
    expect(warning).toContain('auto-quoted');
  });

  it('should surface a hard error when auto-quoting also fails', () => {
    db.create({ title: 'Some work item' });

    // A null byte is invalid even inside a quoted FTS5 phrase, so the
    // auto-quote retry also fails and the error must be surfaced (never
    // a silent empty result).
    expect(() => db.search('\u0000foo')).toThrow(/invalid query syntax/i);
  });

  it('should still find quoted phrase matches without a warning', () => {
    db.create({ title: 'Release v0.1.11' });

    // Quoted phrase is already valid FTS5 — no auto-quote, no warning
    const { results, warning } = db.search('"v0.1.11"');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(warning).toBeUndefined();
  });

  it('should return empty results for genuinely non-matching queries', () => {
    db.create({ title: 'Some work item' });

    // A valid query that simply has no matches should return empty with no warning
    const { results, warning } = db.search('xyznonexistentkeyword12345');
    expect(results.length).toBe(0);
    expect(warning).toBeUndefined();
  });
});
