/**
 * Tests for the `wl create` dedup guard query (WL-0MSTNG2QF0049B97).
 *
 * `WorklogDatabase.getRecentDuplicate()` finds the most recent non-terminal
 * work item whose title matches under case/whitespace normalization within
 * a recent time window. The `wl create` CLI uses it so that agent retries of
 * an identical create command become no-ops instead of producing
 * byte-identical twin items.
 *
 * All assertions go through the public API (`import`/`getRecentDuplicate`)
 * so the tests pin observable query behaviour, not implementation details.
 *
 * Run: npx vitest run packages/shared/src/database-dedup.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorklogDatabase, normalizeTitleForMatch } from './database.js';
import type { WorkItem } from './types.js';

const NOW = Date.now();
const FIXED_TS = new Date(NOW).toISOString();
const FIVE_MINUTES = 5 * 60 * 1000;

/** Build a complete WorkItem with a fixed recent timestamp. */
function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'TEST-0001',
    title: 'Same Title',
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    tags: [],
    assignee: '',
    stage: 'idea',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    needsProducerReview: false,
    ...overrides,
  };
}

let tempDir: string;
let db: WorklogDatabase;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wl-db-dedup-'));
  db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('normalizeTitleForMatch', () => {
  it('lowercases and strips all whitespace so title variants compare equal', () => {
    expect(normalizeTitleForMatch('Same Title')).toBe('sametitle');
    expect(normalizeTitleForMatch('same  title')).toBe('sametitle');
    expect(normalizeTitleForMatch(' same\t title \n')).toBe('sametitle');
    expect(normalizeTitleForMatch('')).toBe('');
  });
});

describe('WorklogDatabase.getRecentDuplicate', () => {
  it('returns a recent non-terminal item with a case/whitespace-normalized title match', () => {
    db.import([makeItem({ id: 'TEST-0001', title: 'Same Title' })]);
    expect(db.getRecentDuplicate('same  title', FIVE_MINUTES)?.id).toBe('TEST-0001');
  });

  it('returns null when no title matches', () => {
    db.import([makeItem({ id: 'TEST-0001', title: 'Other Title' })]);
    expect(db.getRecentDuplicate('Same Title', FIVE_MINUTES)).toBeNull();
  });

  it('returns null when the only match is a completed (terminal) item', () => {
    db.import([makeItem({ id: 'TEST-0001', title: 'Same Title', status: 'completed' })]);
    expect(db.getRecentDuplicate('Same Title', FIVE_MINUTES)).toBeNull();
  });

  it('returns null when the only match is a deleted (terminal) item', () => {
    db.import([makeItem({ id: 'TEST-0001', title: 'Same Title', status: 'deleted' })]);
    expect(db.getRecentDuplicate('Same Title', FIVE_MINUTES)).toBeNull();
  });

  it('matches non-terminal in-progress and blocked items', () => {
    db.import([makeItem({ id: 'TEST-0001', title: 'In Progress Item', status: 'in-progress' })]);
    expect(db.getRecentDuplicate('In Progress Item', FIVE_MINUTES)?.id).toBe('TEST-0001');

    db.import([makeItem({ id: 'TEST-0002', title: 'Blocked Item', status: 'blocked' })]);
    expect(db.getRecentDuplicate('Blocked Item', FIVE_MINUTES)?.id).toBe('TEST-0002');
  });

  it('returns null when the match is older than the window', () => {
    const old = new Date(NOW - 10 * 60 * 1000).toISOString();
    db.import([makeItem({ id: 'TEST-0001', title: 'Same Title', createdAt: old })]);
    expect(db.getRecentDuplicate('Same Title', FIVE_MINUTES)).toBeNull();
  });

  it('returns null when the match is exactly at the window cutoff', () => {
    const atCutoff = new Date(NOW - FIVE_MINUTES).toISOString();
    db.import([makeItem({ id: 'TEST-0001', title: 'Same Title', createdAt: atCutoff })]);
    // createdAt > cutoff is strictly greater — an item created exactly at the
    // cutoff (i.e. 5 minutes ago) is outside the window.
    expect(db.getRecentDuplicate('Same Title', FIVE_MINUTES)).toBeNull();
  });

  it('respects prefix scope: items under another prefix are not matched', () => {
    db.import([makeItem({ id: 'OTHER-0001', title: 'Same Title' })]);
    expect(db.getRecentDuplicate('Same Title', FIVE_MINUTES)).toBeNull();
  });

  it('honours an explicit prefix override', () => {
    db.import([makeItem({ id: 'OTHER-0001', title: 'Same Title' })]);
    expect(db.getRecentDuplicate('Same Title', FIVE_MINUTES, 'OTHER')?.id).toBe('OTHER-0001');
  });

  it('returns the newest matching item when several match', () => {
    db.import([
      makeItem({ id: 'TEST-0001', title: 'Same Title', createdAt: new Date(NOW - 60_000).toISOString() }),
      makeItem({ id: 'TEST-0002', title: 'same  title', createdAt: FIXED_TS }),
    ]);
    expect(db.getRecentDuplicate('Same Title', FIVE_MINUTES)?.id).toBe('TEST-0002');
  });
});
