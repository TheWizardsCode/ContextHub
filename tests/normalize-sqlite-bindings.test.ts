/**
 * Tests for normalizeSqliteValue and normalizeSqliteBindings
 * (WL-0MLRSV1XF14KM6WT)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { normalizeSqliteValue, normalizeSqliteBindings } from '../src/persistent-store.js';
import { WorklogDatabase } from '../src/database.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';

// ---------------------------------------------------------------------------
// Unit tests for normalizeSqliteValue
// ---------------------------------------------------------------------------

describe('normalizeSqliteValue', () => {
  // --- Passthrough types ---------------------------------------------------

  it('passes through number values unchanged', () => {
    expect(normalizeSqliteValue(0)).toBe(0);
    expect(normalizeSqliteValue(42)).toBe(42);
    expect(normalizeSqliteValue(-1.5)).toBe(-1.5);
    expect(normalizeSqliteValue(NaN)).toBeNaN();
    expect(normalizeSqliteValue(Infinity)).toBe(Infinity);
  });

  it('passes through string values unchanged', () => {
    expect(normalizeSqliteValue('')).toBe('');
    expect(normalizeSqliteValue('hello')).toBe('hello');
    expect(normalizeSqliteValue('with "quotes"')).toBe('with "quotes"');
  });

  it('passes through bigint values unchanged', () => {
    expect(normalizeSqliteValue(BigInt(0))).toBe(BigInt(0));
    expect(normalizeSqliteValue(BigInt(999))).toBe(BigInt(999));
  });

  it('passes through Buffer values unchanged', () => {
    const buf = Buffer.from('test');
    expect(normalizeSqliteValue(buf)).toBe(buf);
  });

  it('passes through null unchanged', () => {
    expect(normalizeSqliteValue(null)).toBe(null);
  });

  // --- Conversions ---------------------------------------------------------

  it('converts undefined to null', () => {
    expect(normalizeSqliteValue(undefined)).toBe(null);
  });

  it('converts boolean true to 1', () => {
    expect(normalizeSqliteValue(true)).toBe(1);
  });

  it('converts boolean false to 0', () => {
    expect(normalizeSqliteValue(false)).toBe(0);
  });

  it('converts Date objects to ISO strings via toISOString()', () => {
    const d = new Date('2026-01-15T12:30:00.000Z');
    const result = normalizeSqliteValue(d);
    expect(result).toBe('2026-01-15T12:30:00.000Z');
    // Ensure it does NOT produce a double-quoted JSON string
    expect(result).not.toContain('"');
  });

  it('converts plain objects to JSON strings', () => {
    const obj = { key: 'value', nested: { a: 1 } };
    const result = normalizeSqliteValue(obj);
    expect(result).toBe(JSON.stringify(obj));
    expect(typeof result).toBe('string');
  });

  it('converts arrays to JSON strings', () => {
    const arr = ['a', 'b', 'c'];
    const result = normalizeSqliteValue(arr);
    expect(result).toBe(JSON.stringify(arr));
    expect(typeof result).toBe('string');
  });

  it('converts empty array to JSON string "[]"', () => {
    expect(normalizeSqliteValue([])).toBe('[]');
  });

  it('falls back to String() for non-JSON-serializable objects', () => {
    // Create a circular reference that JSON.stringify cannot handle
    const circular: any = {};
    circular.self = circular;
    const result = normalizeSqliteValue(circular);
    expect(typeof result).toBe('string');
    // Should produce the String() fallback representation
    expect(result).toBe('[object Object]');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for normalizeSqliteBindings (batch)
// ---------------------------------------------------------------------------

describe('normalizeSqliteBindings', () => {
  it('normalizes an array of mixed values', () => {
    const d = new Date('2026-06-01T00:00:00.000Z');
    const input: unknown[] = [
      'hello',
      42,
      true,
      false,
      null,
      undefined,
      d,
      ['tag1', 'tag2'],
      { key: 'val' },
    ];

    const result = normalizeSqliteBindings(input);

    expect(result).toEqual([
      'hello',
      42,
      1,
      0,
      null,
      null,
      '2026-06-01T00:00:00.000Z',
      '["tag1","tag2"]',
      '{"key":"val"}',
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(normalizeSqliteBindings([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip integration tests via WorklogDatabase
// ---------------------------------------------------------------------------

describe('SQLite binding round-trip', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('RT', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  it('round-trips a work item with all fields', () => {
    const created = db.create({
      title: 'Round-trip test',
      description: 'Testing binding normalization',
      priority: 'high',
      tags: ['alpha', 'beta'],
      assignee: 'agent',
      stage: 'idea',
      issueType: 'task',
      needsProducerReview: true,
    });

    const loaded = db.get(created.id);
    expect(loaded).toBeDefined();
    expect(loaded!.title).toBe('Round-trip test');
    expect(loaded!.description).toBe('Testing binding normalization');
    expect(loaded!.priority).toBe('high');
    expect(loaded!.tags).toEqual(['alpha', 'beta']);
    expect(loaded!.assignee).toBe('agent');
    expect(loaded!.stage).toBe('idea');
    expect(loaded!.issueType).toBe('task');
    expect(loaded!.needsProducerReview).toBe(true);
    // Date fields should be valid ISO strings
    expect(() => new Date(loaded!.createdAt).toISOString()).not.toThrow();
    expect(() => new Date(loaded!.updatedAt).toISOString()).not.toThrow();
  });

  it('round-trips a work item with needsProducerReview false', () => {
    const created = db.create({
      title: 'No review needed',
      needsProducerReview: false,
    });

    const loaded = db.get(created.id);
    expect(loaded).toBeDefined();
    expect(loaded!.needsProducerReview).toBe(false);
  });

  it('round-trips a work item with empty tags', () => {
    const created = db.create({
      title: 'Empty tags',
      tags: [],
    });

    const loaded = db.get(created.id);
    expect(loaded).toBeDefined();
    expect(loaded!.tags).toEqual([]);
  });

  it('round-trips a work item with null parentId', () => {
    const created = db.create({
      title: 'No parent',
      parentId: null,
    });

    const loaded = db.get(created.id);
    expect(loaded).toBeDefined();
    expect(loaded!.parentId).toBe(null);
  });

  it('round-trips a work item update preserving types', () => {
    const created = db.create({
      title: 'Will update',
      tags: ['original'],
      needsProducerReview: false,
    });

    const updated = db.update(created.id, {
      title: 'Updated title',
      tags: ['new', 'tags'],
      needsProducerReview: true,
      priority: 'critical',
    });

    expect(updated).toBeDefined();
    const loaded = db.get(created.id);
    expect(loaded!.title).toBe('Updated title');
    expect(loaded!.tags).toEqual(['new', 'tags']);
    expect(loaded!.needsProducerReview).toBe(true);
    expect(loaded!.priority).toBe('critical');
  });

  it('round-trips comments with references', () => {
    const item = db.create({ title: 'Comment test' });

    const comment = db.createComment({
      workItemId: item.id,
      author: 'test-agent',
      comment: 'A test comment',
      references: ['ref1', 'ref2'],
    });

    const comments = db.getCommentsForWorkItem(item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe('test-agent');
    expect(comments[0].comment).toBe('A test comment');
    expect(comments[0].references).toEqual(['ref1', 'ref2']);
  });

  it('round-trips comments with empty references', () => {
    const item = db.create({ title: 'Comment empty refs' });

    db.createComment({
      workItemId: item.id,
      author: 'test-agent',
      comment: 'No refs',
      references: [],
    });

    const comments = db.getCommentsForWorkItem(item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].references).toEqual([]);
  });

  it('round-trips dependency edges', () => {
    const a = db.create({ title: 'Item A' });
    const b = db.create({ title: 'Item B' });

    db.addDependencyEdge(a.id, b.id);

    const outbound = db.listDependencyEdgesFrom(a.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].toId).toBe(b.id);
  });
});
