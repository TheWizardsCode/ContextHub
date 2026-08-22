/**
 * Tests for per-record-type last-export watermarks used by delta (incremental)
 * sync (WL-0MT2KWFUJ001OGHF / parent WL-0MSAKUBKW006FN8Q).
 *
 * Dirty tracking is stored in the `last_export_timestamps` DB table, exposed
 * through the public `WorklogDatabase` API:
 *   - `getLastExportTimestamps()`  — read the watermarks
 *   - `markLastExportTimestamps()` — advance watermarks after a successful push
 *   - `exportForSync({ since })`   — filter records by watermark (delta export)
 *
 * These tests pin observable behaviour through that public API: watermark
 * read/write round-trip, per-type filtering in delta exports, full-export
 * auto-advance of watermarks, and no-baseline → full export.
 *
 * The jsonl service is injected as a mock so the shared module is tested in
 * isolation (the CLI wires the real implementation in src/database.ts).
 *
 * Run: npx vitest run packages/shared/src/dirty-tracking.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorklogDatabase, WorklogDatabaseServices } from './database.js';
import { WorkItem } from './types.js';

const FIXED_TS = '2026-01-01T00:00:00.000Z';
const LATER_TS = '2026-02-01T00:00:00.000Z';

/** Build a complete WorkItem with a fixed timestamp. */
function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WI-0001',
    title: 'Fix the bug',
    description: 'A description with some detail.',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    tags: [],
    assignee: '',
    stage: 'idea',
    issueType: 'bug',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    needsProducerReview: false,
    ...overrides,
  };
}

/** A mock jsonl service that records the arrays handed to exportToJsonlAsync. */
function makeJsonlService() {
  const calls: Array<{ items: WorkItem[]; kind?: string }> = [];
  const exportToJsonlAsync = vi.fn(async (items: WorkItem[], _comments: any[], _path: string, _deps: any[], _audits: any[], options?: any): Promise<number> => {
    calls.push({ items: items as WorkItem[], kind: options?.kind });
    return 0;
  });
  return {
    service: {
      jsonl: {
        importFromJsonl: vi.fn(() => ({ items: [], comments: [], dependencyEdges: [], auditResults: [] })),
        importFromJsonlContent: vi.fn(() => ({ items: [], comments: [], dependencyEdges: [], auditResults: [] })),
        exportToJsonlAsync,
        getDefaultDataPath: vi.fn(() => ''),
      },
    } as unknown as WorklogDatabaseServices,
    calls,
    exportToJsonlAsync,
  };
}

let tempDir: string;
let db: WorklogDatabase;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wl-dirty-tracking-'));
  db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('last-export watermark round-trip (WL-0MT2KWFUJ001OGHF)', () => {
  it('returns an empty set when no watermarks have ever been recorded', () => {
    expect(db.getLastExportTimestamps()).toEqual({});
  });

  it('persists and reads all four per-type watermarks', () => {
    const ts = {
      workitems: FIXED_TS,
      comments: LATER_TS,
      edges: '2026-03-01T00:00:00.000Z',
      audit_results: '2026-04-01T00:00:00.000Z',
    };
    db.markLastExportTimestamps(ts);
    expect(db.getLastExportTimestamps()).toEqual(ts);
  });

  it('updates only the provided types, leaving others untouched', () => {
    db.markLastExportTimestamps({ workitems: FIXED_TS });
    db.markLastExportTimestamps({ comments: LATER_TS });
    const current = db.getLastExportTimestamps();
    expect(current.workitems).toBe(FIXED_TS);
    expect(current.comments).toBe(LATER_TS);
    expect(current.edges).toBeUndefined();
    expect(current.audit_results).toBeUndefined();
  });

  it('survives a database reopen (persisted, not in-memory)', () => {
    const dbPath = join(tempDir, 'worklog.db');
    const jsonlPath = join(tempDir, 'data.jsonl');
    db.markLastExportTimestamps({ workitems: FIXED_TS, comments: LATER_TS });
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true);
    expect(db.getLastExportTimestamps().workitems).toBe(FIXED_TS);
    expect(db.getLastExportTimestamps().comments).toBe(LATER_TS);
  });
});

describe('exportForSync delta filtering by watermark (WL-0MT2KXPOQ009G026)', () => {
  it('delta mode with no watermarks falls back to a full export (no baseline)', async () => {
    const { service, calls } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ id: 'WI-0001', updatedAt: FIXED_TS }), makeItem({ id: 'WI-0002', updatedAt: LATER_TS })]);

    // No baseline has ever been recorded → delta must degrade to full export.
    await db.exportForSync({ mode: 'delta' });

    expect(calls.length).toBe(1);
    expect(calls[0].items.length).toBe(2);
  });

  it('delta mode reads stored watermarks automatically (no explicit since)', async () => {
    const { service, calls } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ id: 'WI-0001', updatedAt: FIXED_TS }), makeItem({ id: 'WI-0002', updatedAt: LATER_TS })]);
    db.markLastExportTimestamps({ workitems: FIXED_TS });

    // Only WI-0002 was updated after the stored watermark (strict >).
    await db.exportForSync({ mode: 'delta' });

    expect(calls.length).toBe(1);
    expect(calls[0].items.map((i: WorkItem) => i.id)).toEqual(['WI-0002']);
    // The writer must receive the delta kind so the JSONL carries a delta header.
    expect(calls[0].kind).toBe('delta');
  });

  it('delta mode advances no watermarks on export', async () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.markLastExportTimestamps({ workitems: FIXED_TS });
    await db.exportForSync({ mode: 'delta' });
    expect(db.getLastExportTimestamps().workitems).toBe(FIXED_TS);
  });

  it('explicit since overrides stored watermarks in delta mode', async () => {
    const { service, calls } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ id: 'WI-0001', updatedAt: FIXED_TS }), makeItem({ id: 'WI-0002', updatedAt: LATER_TS })]);
    db.markLastExportTimestamps({ workitems: LATER_TS });

    // Stored watermark LATER_TS would export nothing; the explicit since=FIXED_TS
    // takes precedence and leaves WI-0002 dirty.
    await db.exportForSync({ mode: 'delta', since: { workitems: FIXED_TS } });
    expect(calls[0].items.map((i: WorkItem) => i.id)).toEqual(['WI-0002']);
  });

  it('exports only items updated after the workitems watermark', async () => {
    const { service, calls } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ id: 'WI-0001', updatedAt: FIXED_TS }), makeItem({ id: 'WI-0002', updatedAt: LATER_TS })]);
    await db.exportForSync({ mode: 'delta', since: { workitems: FIXED_TS } });

    expect(calls.length).toBe(1);
    const ids = calls[0].items.map((i: WorkItem) => i.id);
    expect(ids).toEqual(['WI-0002']);
  });

  it('exports only comments created after the comments watermark', async () => {
    const { service, calls } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ id: 'WI-0001' })]);
    db.createComment({ workItemId: 'WI-0001', author: 'a', comment: 'old', references: [] });
    const oldComment = db.getAllComments()[0];
    await db.exportForSync({ mode: 'delta', since: { comments: oldComment.createdAt } });

    const commentCalls = (service.jsonl as any).exportToJsonlAsync.mock.calls;
    const exportedComments = commentCalls[0][1];
    expect(exportedComments.length).toBe(0);
  });

  it('exports edges created after the edges watermark', async () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ id: 'WI-0001' }), makeItem({ id: 'WI-0002' })]);
    db.addDependencyEdge('WI-0001', 'WI-0002');
    const edge = db.getAllDependencyEdges()[0];
    await db.exportForSync({ mode: 'delta', since: { edges: edge.createdAt } });

    const edgeCalls = (service.jsonl as any).exportToJsonlAsync.mock.calls;
    const exportedEdges = edgeCalls[0][3];
    expect(exportedEdges.length).toBe(0);
  });

  it('exports audit results after the audit_results watermark', async () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ id: 'WI-0001' })]);
    db.saveAuditResult({ workItemId: 'WI-0001', readyToClose: true, auditedAt: LATER_TS, summary: 's', rawOutput: null, author: 'a' });
    await db.exportForSync({ mode: 'delta', since: { audit_results: FIXED_TS } });

    const auditCalls = (service.jsonl as any).exportToJsonlAsync.mock.calls;
    const exportedAudits = auditCalls[0][4];
    expect(exportedAudits.length).toBe(1);
    expect(exportedAudits[0].workItemId).toBe('WI-0001');
  });

  it('with no watermark filter exports everything (full baseline)', async () => {
    const { service, calls } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ id: 'WI-0001' }), makeItem({ id: 'WI-0002' })]);
    await db.exportForSync({});

    expect(calls.length).toBe(1);
    expect(calls[0].items.length).toBe(2);
  });
});

describe('watermark advancement on the push path (WL-0MT2KY0RQ008F50Q)', () => {
  it('a full export does NOT auto-advance watermarks (push path advances after success)', async () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem()]);
    await db.exportForSync({});

    // AC5: exporting alone must never advance the baseline — a failed push
    // would otherwise skip unpublished records on the next delta.
    expect(db.getLastExportTimestamps()).toEqual({});
  });

  it('the push path advances all four watermarks after a successful full push', () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem()]);

    // performSync contract: export → push → markLastExportTimestamps(now).
    db.markLastExportTimestamps({
      workitems: LATER_TS,
      comments: LATER_TS,
      edges: LATER_TS,
      audit_results: LATER_TS,
    });
    const ts = db.getLastExportTimestamps();
    expect(ts.workitems).toBe(LATER_TS);
    expect(ts.comments).toBe(LATER_TS);
    expect(ts.edges).toBe(LATER_TS);
    expect(ts.audit_results).toBe(LATER_TS);
  });

  it('does NOT auto-advance watermarks on a delta export', async () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.markLastExportTimestamps({ workitems: FIXED_TS });
    await db.exportForSync({ since: { workitems: FIXED_TS }, mode: 'delta' });
    expect(db.getLastExportTimestamps().workitems).toBe(FIXED_TS);
  });
});

describe('dirty-record counts (WL-0MT2KY0RQ008F50Q §5.4 zero-change fast path)', () => {
  it('no baseline → everything is dirty', () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem(), makeItem({ id: 'WI-0002' })]);
    db.createComment({ workItemId: 'WI-0001', author: 'a', comment: 'c', references: [] });
    db.addDependencyEdge('WI-0001', 'WI-0002');

    const dirty = db.countDirtyRecords();
    expect(dirty.items).toBe(2);
    expect(dirty.comments).toBe(1);
    expect(dirty.edges).toBe(1);
    expect(dirty.audits).toBe(0);
    expect(dirty.total).toBe(4);
  });

  it('watermark at the newest timestamp → nothing is dirty', () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ updatedAt: FIXED_TS })]);
    // createComment stamps the comment and touches the parent item with NOW —
    // so advance the watermarks to a point AFTER the comment was created,
    // which is the realistic push-path sequence (export → push → mark).
    db.createComment({ workItemId: 'WI-0001', author: 'a', comment: 'c', references: [] });
    const after = new Date().toISOString();
    db.markLastExportTimestamps({
      workitems: after,
      comments: after,
    });

    const dirty = db.countDirtyRecords();
    expect(dirty.items).toBe(0);
    expect(dirty.comments).toBe(0);
    expect(dirty.total).toBe(0);
  });

  it('records updated after the watermark are dirty (strict >)', () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ updatedAt: FIXED_TS }), makeItem({ id: 'WI-0002', updatedAt: LATER_TS })]);
    db.markLastExportTimestamps({ workitems: FIXED_TS });

    expect(db.countDirtyRecords().items).toBe(1);
    expect(db.countDirtyRecords().total).toBe(1);
  });
});

describe('delta-sync cadence metadata (WL-0MT2KY0RQ008F50Q §5.3)', () => {
  it('defaults to zero count and zero bytes', () => {
    expect(db.getDeltaSyncMetadata()).toEqual({ deltaSyncCount: 0, deltaBytes: 0 });
  });

  it('round-trips the delta count and accumulated bytes', () => {
    db.setDeltaSyncMetadata(7, 123456);
    expect(db.getDeltaSyncMetadata()).toEqual({ deltaSyncCount: 7, deltaBytes: 123456 });
  });

  it('survives a database reopen (persisted, not in-memory)', () => {
    const dbPath = join(tempDir, 'worklog.db');
    const jsonlPath = join(tempDir, 'data.jsonl');
    db.setDeltaSyncMetadata(3, 999);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true);
    expect(db.getDeltaSyncMetadata()).toEqual({ deltaSyncCount: 3, deltaBytes: 999 });
  });

  it('does not collide with per-type watermarks', () => {
    db.setDeltaSyncMetadata(2, 42);
    db.markLastExportTimestamps({ workitems: FIXED_TS });
    expect(db.getLastExportTimestamps().workitems).toBe(FIXED_TS);
    expect(db.getLastExportTimestamps().comments).toBeUndefined();
    const all = db.getDeltaSyncMetadata();
    expect(all).toEqual({ deltaSyncCount: 2, deltaBytes: 42 });
  });
});
// ── WL-0MT2KZH0I005XUWE: deletion propagation through delta export/merge ──

describe('deletion propagation (WL-0MT2KZH0I005XUWE §4.3)', () => {
  it('AC1: a soft-deleted record is included in the delta export (updatedAt bumped by delete)', async () => {
    const { service, calls } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ id: 'WI-0001', updatedAt: FIXED_TS }), makeItem({ id: 'WI-0002', updatedAt: FIXED_TS })]);
    db.markLastExportTimestamps({ workitems: FIXED_TS });

    // Delete WI-0002: deleteSingle bumps updatedAt to now → dirty predicate fires.
    db.delete('WI-0002');
    const deleted = db.get('WI-0002');
    expect(deleted?.status).toBe('deleted');
    expect(deleted?.updatedAt).not.toBe(FIXED_TS);

    await db.exportForSync({ mode: 'delta' });
    expect(calls.length).toBe(1);
    const ids = calls[0].items.map((i: WorkItem) => i.id);
    expect(ids).toContain('WI-0002');
    const deletedExported = calls[0].items.find((i: WorkItem) => i.id === 'WI-0002');
    expect(deletedExported?.status).toBe('deleted');
  });

  it('AC3: upserting a delta deleted record into the local store converges (pull side)', async () => {
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, makeJsonlService() as any);
    db.import([makeItem({ id: 'WI-0001', status: 'completed', stage: 'in_review', updatedAt: FIXED_TS })]);
    expect(db.get('WI-0001')?.status).toBe('completed');

    // A peer deleted WI-0001; its delta record carries status deleted + newer ts.
    const now = new Date().toISOString();
    db.upsertItems([makeItem({ id: 'WI-0001', status: 'deleted', stage: 'in_review', updatedAt: now })]);

    // Converged: local must reflect the remote delete even though it was completed.
    expect(db.get('WI-0001')?.status).toBe('deleted');
  });
});
