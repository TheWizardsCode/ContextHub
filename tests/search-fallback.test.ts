/**
 * Tests for application-level fallback search (runs when FTS5 is unavailable).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorklogDatabase } from '../src/database.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';

describe('searchFallback with new filter flags', () => {
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

  // Test the fallback search path directly via SqlitePersistentStore.searchFallback().
  // better-sqlite3 always includes FTS5, so we cannot disable it at the
  // WorklogDatabase level; calling searchFallback() on the store exercises
  // the application-level filtering code path that would run when FTS5 is
  // unavailable.

  describe('--priority filter (fallback)', () => {
    it('should filter by priority', () => {
      db.create({ title: 'Fbpriority alpha task', priority: 'high' });
      db.create({ title: 'Fbpriority alpha chore', priority: 'low' });

      const results = (db as any).store.searchFallback('fbpriority alpha', { priority: 'high' });
      expect(results.length).toBe(1);
      const item = db.get(results[0].itemId);
      expect(item?.priority).toBe('high');
    });
  });

  describe('--assignee filter (fallback)', () => {
    it('should filter by assignee', () => {
      db.create({ title: 'Fbassignee alpha work', assignee: 'alice' });
      db.create({ title: 'Fbassignee alpha work', assignee: 'bob' });

      const results = (db as any).store.searchFallback('fbassignee alpha', { assignee: 'alice' });
      expect(results.length).toBe(1);
      const item = db.get(results[0].itemId);
      expect(item?.assignee).toBe('alice');
    });
  });

  describe('--stage filter (fallback)', () => {
    it('should filter by stage', () => {
      db.create({ title: 'Fbstage alpha item', stage: 'review' });
      db.create({ title: 'Fbstage alpha item', stage: 'done' });

      const results = (db as any).store.searchFallback('fbstage alpha', { stage: 'review' });
      expect(results.length).toBe(1);
      const item = db.get(results[0].itemId);
      expect(item?.stage).toBe('review');
    });
  });

  describe('--issue-type filter (fallback)', () => {
    it('should filter by issueType', () => {
      db.create({ title: 'Fbtype alpha entry', issueType: 'epic' });
      db.create({ title: 'Fbtype alpha entry', issueType: 'task' });

      const results = (db as any).store.searchFallback('fbtype alpha', { issueType: 'epic' });
      expect(results.length).toBe(1);
      const item = db.get(results[0].itemId);
      expect(item?.issueType).toBe('epic');
    });
  });

  describe('--needs-producer-review filter (fallback)', () => {
    it('should filter by needsProducerReview true', () => {
      db.create({ title: 'Fbreview alpha item', needsProducerReview: true });
      db.create({ title: 'Fbreview alpha item', needsProducerReview: false });

      const results = (db as any).store.searchFallback('fbreview alpha', { needsProducerReview: true });
      expect(results.length).toBe(1);
      const item = db.get(results[0].itemId);
      expect(item?.needsProducerReview).toBe(true);
    });

    it('should filter by needsProducerReview false', () => {
      db.create({ title: 'Fbreview beta item', needsProducerReview: true });
      db.create({ title: 'Fbreview beta item', needsProducerReview: false });

      const results = (db as any).store.searchFallback('fbreview beta', { needsProducerReview: false });
      expect(results.length).toBe(1);
      const item = db.get(results[0].itemId);
      expect(item?.needsProducerReview).toBe(false);
    });
  });

  describe('--deleted filter (fallback)', () => {
    it('should exclude deleted items by default', () => {
      db.create({ title: 'Fbdeleted alpha item', status: 'open' });
      // Create an item with status 'deleted' directly (avoids db.delete
      // which would also remove the FTS entry, allowing us to verify the
      // fallback filter independently).
      db.create({ title: 'Fbdeleted alpha item', status: 'deleted' as any });

      const results = (db as any).store.searchFallback('fbdeleted alpha');
      expect(results.length).toBe(1);
      const item = db.get(results[0].itemId);
      expect(item?.status).toBe('open');
    });

    it('should include deleted items when deleted flag is set', () => {
      db.create({ title: 'Fbdeleted beta item', status: 'open' });
      db.create({ title: 'Fbdeleted beta item', status: 'deleted' as any });

      const results = (db as any).store.searchFallback('fbdeleted beta', { deleted: true });
      expect(results.length).toBe(2);
    });
  });

  describe('combined filters (fallback)', () => {
    it('should combine priority and assignee', () => {
      db.create({ title: 'Fbcombo alpha work', priority: 'high', assignee: 'alice' });
      db.create({ title: 'Fbcombo alpha work', priority: 'high', assignee: 'bob' });
      db.create({ title: 'Fbcombo alpha work', priority: 'low', assignee: 'alice' });

      const results = (db as any).store.searchFallback('fbcombo alpha', { priority: 'high', assignee: 'alice' });
      expect(results.length).toBe(1);
      const item = db.get(results[0].itemId);
      expect(item?.priority).toBe('high');
      expect(item?.assignee).toBe('alice');
    });

    it('should combine stage, issueType and needsProducerReview', () => {
      db.create({ title: 'Fbmulti alpha item', stage: 'review', issueType: 'bug', needsProducerReview: true });
      db.create({ title: 'Fbmulti alpha item', stage: 'review', issueType: 'bug', needsProducerReview: false });
      db.create({ title: 'Fbmulti alpha item', stage: 'done', issueType: 'bug', needsProducerReview: true });

      const results = (db as any).store.searchFallback('fbmulti alpha', { stage: 'review', issueType: 'bug', needsProducerReview: true });
      expect(results.length).toBe(1);
      const item = db.get(results[0].itemId);
      expect(item?.stage).toBe('review');
      expect(item?.issueType).toBe('bug');
      expect(item?.needsProducerReview).toBe(true);
    });
  });
});
