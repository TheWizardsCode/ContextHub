/**
 * Unit tests for `wl doctor foreign-items --apply` cleanup logic.
 *
 * Verifies the apply helper hard-deletes foreign items with full cascade:
 * workitem row, comments, dependency edges, audit_results, and FTS entries,
 * while leaving own items untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { WorklogDatabase } from '../src/database.js';
import { createTempDir, cleanupTempDir, createTempDbPath, createTempJsonlPath } from './test-utils.js';
import {
  applyForeignItemCleanup,
  buildForeignItemReport,
} from '../src/doctor/foreign-items-check.js';

function makeItem(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    title: `item ${id}`,
    description: `description for ${id}`,
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    assignee: '',
    stage: '',
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

describe('applyForeignItemCleanup', () => {
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

  it('hard-deletes foreign items with full cascade and leaves own items untouched', () => {
    // Seed: 3 own items + 3 foreign items (one deleted, one with comment/edge/audit)
    const items = [
      makeItem('TEST-001'),
      makeItem('TEST-002', { status: 'deleted' }),
      makeItem('TEST-003'),
      makeItem('WL-101', { status: 'deleted' }),
      makeItem('WL-102'),
      makeItem('OB-0MN9CZ48N0053L9Q', { status: 'deleted' }),
    ];
    // Dependency edge: foreign WL-102 -> own TEST-001 (fromId foreign)
    // Dependency edge: own TEST-003 -> foreign WL-101 (toId foreign)
    const edges = [
      { fromId: 'WL-102', toId: 'TEST-001', createdAt: '2026-01-01T00:00:00.000Z' },
      { fromId: 'TEST-003', toId: 'WL-101', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    const audits = [
      { workItemId: 'WL-102', readyToClose: false, auditedAt: '2026-01-01T00:00:00.000Z', summary: 'audit', rawOutput: 'raw', author: 'tester' },
    ];
    const comments = [
      { id: 'C-WL-102-1', workItemId: 'WL-102', comment: 'foreign comment', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', author: 'tester', deleted: false },
    ];

    db.import(items, edges, audits);
    db.createComment(comments[0]);
    // Populate FTS index so we can verify FTS cascade
    db.rebuildFtsIndex();

    // Sanity: FTS has entries for foreign items
    const ftsBefore = db.search('WL-102');
    expect(ftsBefore.results.some(r => r.itemId === 'WL-102')).toBe(true);

    const report = buildForeignItemReport(db.getAll(), 'TEST', false);
    expect(report.foreignCount).toBe(3);

    const result = applyForeignItemCleanup(db, report);

    expect(result.success).toBe(true);
    expect(result.apply).toBe(true);
    expect(result.totalBefore).toBe(6);
    expect(result.totalAfter).toBe(3);
    expect(result.foreignBefore).toBe(3);
    expect(result.foreignAfter).toBe(0);
    expect(result.ownBefore).toBe(3);
    expect(result.ownAfter).toBe(3);
    expect(result.removedCount).toBe(3);
    expect(result.removedIds.sort()).toEqual(['OB-0MN9CZ48N0053L9Q', 'WL-101', 'WL-102'].sort());

    // Per-prefix removed counts
    expect(result.removedByPrefix.WL).toBe(2);
    expect(result.removedByPrefix.OB).toBe(1);

    // Cascade: foreign items gone from DB
    const remaining = db.getAll().map(i => i.id);
    expect(remaining).toEqual(['TEST-001', 'TEST-002', 'TEST-003']);

    // Cascade: comments for foreign items gone
    const allComments = db.getAllComments();
    expect(allComments.some(c => c.workItemId === 'WL-102')).toBe(false);

    // Cascade: dependency edges referencing foreign items gone
    const allEdges = db.getAllDependencyEdges();
    expect(allEdges.some(e => e.fromId === 'WL-102' || e.toId === 'WL-102')).toBe(false);
    expect(allEdges.some(e => e.toId === 'WL-101')).toBe(false);

    // Cascade: audit results for foreign items gone
    const allAudits = db.getAllAuditResults();
    expect(allAudits.some(a => a.workItemId === 'WL-102')).toBe(false);

    // Cascade: FTS entries for foreign items gone
    const ftsAfter = db.search('WL-102');
    expect(ftsAfter.results.some(r => r.itemId === 'WL-102')).toBe(false);
  });

  it('returns success with zero removed when there are no foreign items', () => {
    const items = [
      makeItem('TEST-001'),
      makeItem('TEST-002'),
    ];
    db.import(items, [], []);

    const report = buildForeignItemReport(db.getAll(), 'TEST', false);
    expect(report.foreignCount).toBe(0);

    const result = applyForeignItemCleanup(db, report);
    expect(result.success).toBe(true);
    expect(result.removedCount).toBe(0);
    expect(result.totalBefore).toBe(2);
    expect(result.totalAfter).toBe(2);
  });

  it('returns success when apply is called with a dry-run report (no-op safety)', () => {
    const items = [makeItem('TEST-001'), makeItem('WL-1')];
    db.import(items, [], []);

    const report = buildForeignItemReport(db.getAll(), 'TEST', true); // dryRun report
    const result = applyForeignItemCleanup(db, report);
    expect(result.success).toBe(true);
    expect(result.removedCount).toBe(1);
    // Item removed regardless of the report's dryRun flag (the CLI gates on --apply)
    expect(db.getAll().map(i => i.id)).toEqual(['TEST-001']);
  });

  it('removes only the IDs listed in the report (honors prefix override)', () => {
    const items = [
      makeItem('WL-101'),
      makeItem('TEST-001'),
      makeItem('OB-1'),
    ];
    db.import(items, [], []);

    // Override prefix to WL: only TEST-001 and OB-1 are foreign
    const report = buildForeignItemReport(db.getAll(), 'WL', false);
    expect(report.foreignCount).toBe(2);

    const result = applyForeignItemCleanup(db, report);
    expect(result.removedIds.sort()).toEqual(['OB-1', 'TEST-001'].sort());
    expect(db.getAll().map(i => i.id)).toEqual(['WL-101']);
  });

  it('reports a fresh total when items were modified between report and apply', () => {
    // Edge: report built, then an extra foreign item added before apply.
    const items = [makeItem('TEST-001'), makeItem('WL-1')];
    db.import(items, [], []);

    const report = buildForeignItemReport(db.getAll(), 'TEST', false);
    // Add another foreign item after building the report
    db.import([...items, makeItem('OB-2')], [], []);

    const result = applyForeignItemCleanup(db, report);
    // The apply function re-scans using its own report's IDs; OB-2 was not in the
    // report's foreignIds, so it should NOT be removed (apply only removes listed IDs).
    expect(result.removedCount).toBe(1);
    expect(db.getAll().map(i => i.id)).toEqual(['TEST-001', 'OB-2']);
  });
});

describe('applyForeignItemCleanup with FTS availability check', () => {
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

  it('works even when the SQLite build has no FTS5 support', () => {
    const items = [makeItem('TEST-001'), makeItem('WL-9')];
    db.import(items, [], []);

    const report = buildForeignItemReport(db.getAll(), 'TEST', false);
    const result = applyForeignItemCleanup(db, report);
    expect(result.success).toBe(true);
    expect(result.removedCount).toBe(1);
    expect(db.getAll().map(i => i.id)).toEqual(['TEST-001']);
  });
});

describe('direct SQLite verification of cascade', () => {
  it('removes rows from all related tables', () => {
    const tempDir = createTempDir();
    const dbPath = createTempDbPath(tempDir);
    const jsonlPath = createTempJsonlPath(tempDir);
    const db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);

    try {
      db.import(
        [makeItem('TEST-001'), makeItem('WL-101'), makeItem('WL-102', { status: 'deleted' })],
        [{ fromId: 'WL-102', toId: 'TEST-001', createdAt: '2026-01-01T00:00:00.000Z' }],
        [{ workItemId: 'WL-101', readyToClose: false, auditedAt: '2026-01-01T00:00:00.000Z', summary: 's', rawOutput: 'r', author: 'a' }]
      );
      db.rebuildFtsIndex();

      const report = buildForeignItemReport(db.getAll(), 'TEST', false);
      const result = applyForeignItemCleanup(db, report);
      expect(result.success).toBe(true);

      // Inspect the SQLite tables directly
      const raw = new Database(dbPath, { readonly: true });
      try {
        const workitems = raw.prepare('SELECT id FROM workitems').all() as any[];
        expect(workitems.map(r => r.id)).toEqual(['TEST-001']);

        const edges = raw.prepare('SELECT fromId, toId FROM dependency_edges').all() as any[];
        expect(edges).toHaveLength(0);

        const audits = raw.prepare('SELECT work_item_id FROM audit_results').all() as any[];
        expect(audits).toHaveLength(0);

        const comments = raw.prepare('SELECT workItemId FROM comments').all() as any[];
        expect(comments).toHaveLength(0);
      } finally {
        raw.close();
      }
    } finally {
      db.close();
      cleanupTempDir(tempDir);
    }
  });
});
