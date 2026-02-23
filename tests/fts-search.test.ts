/**
 * Tests for FTS5 full-text search
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorklogDatabase } from '../src/database.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';

describe('FTS Search', () => {
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

  describe('ftsAvailable', () => {
    it('should report FTS5 as available', () => {
      // better-sqlite3 includes FTS5 by default
      expect(db.ftsAvailable).toBe(true);
    });
  });

  describe('search after create', () => {
    it('should find a work item by title', () => {
      db.create({ title: 'Database corruption fix' });
      const { results, ftsUsed } = db.search('database');
      expect(ftsUsed).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].itemId).toBeDefined();
    });

    it('should find a work item by description', () => {
      db.create({
        title: 'Simple title',
        description: 'This work item fixes a memory leak in the parser module',
      });
      const { results } = db.search('memory leak');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].matchedColumn).toBe('description');
    });

    it('should find a work item by tags', () => {
      db.create({
        title: 'Unrelated title',
        tags: ['frontend', 'react', 'performance'],
      });
      const { results } = db.search('react');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should return snippet with highlight markers', () => {
      db.create({ title: 'Implement caching layer for Redis' });
      const { results } = db.search('caching');
      expect(results.length).toBeGreaterThanOrEqual(1);
      // FTS5 snippets use << >> markers
      expect(results[0].snippet).toContain('<<');
      expect(results[0].snippet).toContain('>>');
    });

    it('should return empty results for non-matching query', () => {
      db.create({ title: 'Something completely different' });
      const { results } = db.search('xyznonexistent');
      expect(results.length).toBe(0);
    });

    it('should return empty results for empty query', () => {
      db.create({ title: 'Test item' });
      const { results } = db.search('');
      expect(results.length).toBe(0);
    });
  });

  describe('search with filters', () => {
    it('should filter by status', () => {
      db.create({ title: 'Open bug', status: 'open' });
      db.create({ title: 'Closed bug fix', status: 'completed' });

      const { results: openResults } = db.search('bug', { status: 'open' });
      expect(openResults.length).toBe(1);
      expect(openResults[0].itemId).toBeDefined();

      const { results: closedResults } = db.search('bug', { status: 'completed' });
      expect(closedResults.length).toBe(1);
    });

    it('should filter by parentId', () => {
      const parent = db.create({ title: 'Parent epic' });
      db.create({ title: 'Child feature work', parentId: parent.id });
      db.create({ title: 'Orphan feature work' });

      const { results } = db.search('feature', { parentId: parent.id });
      expect(results.length).toBe(1);
    });

    it('should filter by tags', () => {
      db.create({ title: 'Frontend widget', tags: ['frontend', 'ui'] });
      db.create({ title: 'Backend widget', tags: ['backend', 'api'] });

      const { results } = db.search('widget', { tags: ['frontend'] });
      expect(results.length).toBe(1);
    });

    it('should respect limit', () => {
      for (let i = 0; i < 10; i++) {
        db.create({ title: `Repeated search target item ${i}` });
      }

      const { results } = db.search('search target', { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('index updates on write', () => {
    it('should reflect updates in search results', () => {
      const item = db.create({ title: 'Original title alpha' });
      let { results } = db.search('alpha');
      expect(results.length).toBe(1);

      db.update(item.id, { title: 'Updated title beta' });
      ({ results } = db.search('alpha'));
      expect(results.length).toBe(0);

      ({ results } = db.search('beta'));
      expect(results.length).toBe(1);
    });

    it('should remove deleted items from search', () => {
      const item = db.create({ title: 'Deletable item gamma' });
      let { results } = db.search('gamma');
      expect(results.length).toBe(1);

      db.delete(item.id);
      ({ results } = db.search('gamma'));
      expect(results.length).toBe(0);
    });

    it('should index comment text and reflect comment changes', () => {
      const item = db.create({ title: 'Bug report' });

      // Add a comment and search for it
      db.createComment({
        workItemId: item.id,
        author: 'tester',
        comment: 'Reproduced the segfault on ARM64',
      });

      let { results } = db.search('segfault');
      expect(results.length).toBe(1);
      expect(results[0].itemId).toBe(item.id);

      // Update the comment
      const comments = db.getCommentsForWorkItem(item.id);
      db.updateComment(comments[0].id, { comment: 'Actually it was a null pointer dereference' });

      ({ results } = db.search('segfault'));
      expect(results.length).toBe(0);

      ({ results } = db.search('null pointer'));
      expect(results.length).toBe(1);
    });

    it('should update index when a comment is deleted', () => {
      const item = db.create({ title: 'Feature request' });
      const comment = db.createComment({
        workItemId: item.id,
        author: 'user',
        comment: 'Please add dark mode support',
      });

      let { results } = db.search('dark mode');
      expect(results.length).toBe(1);

      db.deleteComment(comment!.id);
      ({ results } = db.search('dark mode'));
      expect(results.length).toBe(0);
    });
  });

  describe('rebuildFtsIndex', () => {
    it('should rebuild the entire index', () => {
      db.create({ title: 'Rebuild test alpha' });
      db.create({ title: 'Rebuild test beta' });
      db.create({ title: 'Rebuild test gamma' });

      const { indexed } = db.rebuildFtsIndex();
      expect(indexed).toBe(3);

      const { results } = db.search('rebuild test');
      expect(results.length).toBe(3);
    });

    it('should include comments after rebuild', () => {
      const item = db.create({ title: 'Comment rebuild test' });
      db.createComment({
        workItemId: item.id,
        author: 'agent',
        comment: 'Unique searchable token xylophone',
      });

      db.rebuildFtsIndex();

      const { results } = db.search('xylophone');
      expect(results.length).toBe(1);
      expect(results[0].itemId).toBe(item.id);
    });
  });

  describe('ranking', () => {
    it('should rank title matches higher than description matches', () => {
      db.create({
        title: 'Authentication module',
        description: 'Handles user login and session management',
      });
      db.create({
        title: 'Session management refactor',
        description: 'Improve the authentication flow for better security',
      });

      const { results } = db.search('authentication');
      expect(results.length).toBe(2);
      // The item with "authentication" in the title should rank first
      // since title has weight 10 vs description weight 5
      expect(results[0].matchedColumn).toBe('title');
    });
  });

  describe('WorklogDatabase.search() method', () => {
    it('should return ftsUsed=true when FTS5 is available', () => {
      db.create({ title: 'Test search method' });
      const result = db.search('search method');
      expect(result.ftsUsed).toBe(true);
      expect(result.results.length).toBeGreaterThanOrEqual(1);
    });
  });
});
