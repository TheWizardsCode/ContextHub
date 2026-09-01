/**
 * Tests for the pickFields() projection helper.
 *
 * Verifies:
 * - Field selection returns only the requested fields
 * - `id` is always included regardless of request
 * - Unknown fields are rejected with a clear error listing valid fields
 * - Empty field list returns only `id`
 * - undefined fields returns the full item
 *
 * Run: npx vitest run packages/shared/src/fields.test.ts
 */

import { describe, it, expect } from 'vitest';
import type { WorkItem } from './types.js';
import { pickFields, VALID_FIELDS } from './fields.js';

const SAMPLE_ITEM: WorkItem = {
  id: 'WL-000000000000000000',
  title: 'Test item',
  description: 'A long description with lots of content',
  status: 'open',
  priority: 'medium',
  sortIndex: 100,
  parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  tags: ['tag1', 'tag2'],
  assignee: 'alice',
  stage: 'intake_complete',
  issueType: 'feature',
  createdBy: '',
  deletedBy: '',
  deleteReason: '',
  risk: 'Low',
  effort: 'M',
  needsProducerReview: false,
};

describe('pickFields', () => {
  it('returns only the requested fields', () => {
    const result = pickFields(SAMPLE_ITEM, ['id', 'title', 'status']);
    const keys = Object.keys(result);
    expect(keys).toEqual(['id', 'title', 'status']);
    expect(result.id).toBe('WL-000000000000000000');
    expect(result.title).toBe('Test item');
    expect(result.status).toBe('open');
  });

  it('always includes id even if not requested', () => {
    const result = pickFields(SAMPLE_ITEM, ['title', 'status']);
    const keys = Object.keys(result);
    expect(keys).toContain('id');
    expect(result.id).toBe('WL-000000000000000000');
    expect(result.title).toBe('Test item');
    expect(result.status).toBe('open');
    expect('description' in result).toBe(false);
  });

  it('throws on unknown field names listing valid fields', () => {
    expect(() => pickFields(SAMPLE_ITEM, ['id', 'bogusField'])).toThrow(
      /Unknown fields/
    );
  });

  it('throws on multiple unknown fields', () => {
    expect(() => pickFields(SAMPLE_ITEM, ['nonexistent', 'alsoFake'])).toThrow(
      /Unknown fields/
    );
  });

  it('empty field list returns only id', () => {
    const result = pickFields(SAMPLE_ITEM, []);
    const keys = Object.keys(result);
    expect(keys).toEqual(['id']);
  });

  it('undefined fields returns the full item (all keys preserved)', () => {
    const result = pickFields(SAMPLE_ITEM, undefined);
    expect(result).toBe(SAMPLE_ITEM);
    const keys = Object.keys(result);
    expect(keys).toContain('id');
    expect(keys).toContain('title');
    expect(keys).toContain('description');
  });

  it('null fields returns the full item', () => {
    const result = pickFields(SAMPLE_ITEM, null as any);
    expect(result).toBe(SAMPLE_ITEM);
  });

  it('returns all specified fields including optional ones', () => {
    const result = pickFields(SAMPLE_ITEM, [
      'id',
      'title',
      'status',
      'stage',
      'priority',
      'issueType',
      'assignee',
      'tags',
      'createdAt',
      'updatedAt',
      'parentId',
      'needsProducerReview',
      'sortIndex',
    ]);
    const keys = Object.keys(result);
    expect(keys.length).toBe(13);
    expect(result.id).toBe('WL-000000000000000000');
    expect(result.sortIndex).toBe(100);
    expect(result.needsProducerReview).toBe(false);
    expect(result.tags).toEqual(['tag1', 'tag2']);
    expect(result.parentId).toBeNull();
  });

  it('handles items with extra properties not in VALID_FIELDS', () => {
    const extraItem = { ...SAMPLE_ITEM, githubIssueNumber: 42 };
    const result = pickFields(extraItem, ['id', 'title']);
    const keys = Object.keys(result);
    expect(keys).toEqual(['id', 'title']);
    expect('githubIssueNumber' in result).toBe(false);
  });

  it('VALID_FIELDS includes all expected fields', () => {
    expect(VALID_FIELDS).toEqual(
      expect.arrayContaining([
        'id',
        'title',
        'description',
        'status',
        'stage',
        'priority',
        'issueType',
        'assignee',
        'tags',
        'createdAt',
        'updatedAt',
        'parentId',
        'needsProducerReview',
        'sortIndex',
      ])
    );
  });

  it('VALID_FIELDS has no unexpected entries', () => {
    expect(VALID_FIELDS).toHaveLength(14);
  });
});
