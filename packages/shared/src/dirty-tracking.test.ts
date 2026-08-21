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
  const calls: Array<{ items: WorkItem[] }> = [];
  const exportToJsonlAsync = vi.fn(async (items: WorkItem[], _comments: any[], _path: string, _deps: any[], _audits: any[], _options?: any): Promise<number> => {
    calls.push({ items: items as WorkItem[] });
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

describe('exportForSync delta filtering by watermark (WL-0MT2KWFUJ001OGHF)', () => {
  it('exports only items updated after the workitems watermark', async () => {
    const { service, calls } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ id: 'WI-0001', updatedAt: FIXED_TS }), makeItem({ id: 'WI-0002', updatedAt: LATER_TS })]);
    await db.exportForSync({ since: { workitems: FIXED_TS } });

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
    await db.exportForSync({ since: { comments: oldComment.createdAt } });

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
    await db.exportForSync({ since: { edges: edge.createdAt } });

    const edgeCalls = (service.jsonl as any).exportToJsonlAsync.mock.calls;
    const exportedEdges = edgeCalls[0][3];
    expect(exportedEdges.length).toBe(0);
  });

  it('exports audit results after the audit_results watermark', async () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem({ id: 'WI-0001' })]);
    db.saveAuditResult({ workItemId: 'WI-0001', readyToClose: true, auditedAt: LATER_TS, summary: 's', rawOutput: null, author: 'a' });
    await db.exportForSync({ since: { audit_results: FIXED_TS } });

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

describe('full-export watermark auto-advance (WL-0MT2KWFUJ001OGHF)', () => {
  it('advances all four watermarks after a full export', async () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.import([makeItem()]);
    await db.exportForSync({});
    const ts = db.getLastExportTimestamps();
    expect(ts.workitems).toBeDefined();
    expect(ts.comments).toBeDefined();
    expect(ts.edges).toBeDefined();
    expect(ts.audit_results).toBeDefined();
  });

  it('does NOT auto-advance watermarks on a delta export', async () => {
    const { service } = makeJsonlService();
    db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true, false, undefined, service);
    db.markLastExportTimestamps({ workitems: FIXED_TS });
    await db.exportForSync({ since: { workitems: FIXED_TS }, mode: 'delta' });
    expect(db.getLastExportTimestamps().workitems).toBe(FIXED_TS);
  });
});