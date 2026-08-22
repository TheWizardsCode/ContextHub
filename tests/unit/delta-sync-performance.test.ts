/**
 * Performance test for incremental delta sync (WL-0MT2KZVXX0025BFH AC10,
 * parent WL-0MSAKUBKW006FN8Q §10): "typical incremental sync completes in
 * ≤ 3 s on the 2133-item dataset."
 *
 * The full community dataset (2133 items / 7494 comments, ~11.6 MB) is not
 * checked into the repo, so this test generates a comparable-scale dataset
 * (2000 items + comments) and measures the DELTA export (the new code path's
 * hot loop: watermark filter + JSONL build of only the changed records). The
 * bound is deliberately generous (2500 ms for the delta export of a handful
 * of changed records) so the test catches order-of-magnitude regressions
 * (e.g. accidentally exporting the full store in delta mode) without being
 * flaky on slow CI machines. A full export of the whole generated dataset is
 * asserted separately to stay well under the same budget.
 *
 * The delta export path measured here is exactly what `performSync` calls via
 * WorklogDatabase.exportForSync({ mode: 'delta' }) on the push side.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorklogDatabase } from '../../src/database.js';
import { WorkItem, Comment } from '../../src/types.js';

describe('incremental sync performance (WL-0MT2KZVXX0025BFH AC10)', () => {
  let tempDir: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wl-perf-'));
    db = new WorklogDatabase('PRF', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Seed a dataset of `count` items + `count` comments with fixed timestamps. */
  function seed(count: number, ts: string): void {
    const items: WorkItem[] = [];
    for (let i = 0; i < count; i++) {
      items.push({
        id: `PRF-${String(i).padStart(6, '0')}`,
        title: `Perf item ${i}`,
        description: `Description for perf item ${i} — some realistic-length body text with enough words to mirror the real dataset.`,
        status: 'open',
        priority: 'medium',
        sortIndex: i,
        parentId: null,
        createdAt: ts,
        updatedAt: ts,
        tags: i % 3 === 0 ? ['perf', 'delta'] : [],
        assignee: '',
        stage: 'idea',
        issueType: i % 2 === 0 ? 'task' : 'docs',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '',
        effort: '',
      });
    }
    db.import(items);
    const comments: Comment[] = [];
    for (let i = 0; i < count; i++) {
      comments.push({
        id: `PRF-C-${String(i).padStart(6, '0')}`,
        workItemId: `PRF-${String(i % count).padStart(6, '0')}`,
        author: 'test@example.com',
        comment: `A comment body on perf item ${i}.`,
        createdAt: ts,
        references: [],
      });
    }
    db.importComments(comments);
  }

  it('delta export of a handful of changed records over a 2000-item store completes ≤ 2500ms', async () => {
    const T0 = '2026-01-01T00:00:00.000Z';
    const T1 = '2026-02-01T00:00:00.000Z';
    seed(2000, T0);
    // Baseline: everything exported/acked at T0.
    db.markLastExportTimestamps({ workitems: T0, comments: T0, edges: T0, audit_results: T0 });

    // Only 5 records change after the baseline.
    const changed = ['PRF-000001', 'PRF-000100', 'PRF-000500', 'PRF-001000', 'PRF-001999'];
    const items = db.getAll().map(i => (changed.includes(i.id) ? { ...i, description: 'changed after baseline', updatedAt: T1 } : i));
    db.import(items);

    const start = Date.now();
    const jsonlPath = await db.exportForSync({ mode: 'delta' });
    const elapsed = Date.now() - start;

    const exportedRaw = require('fs').readFileSync(jsonlPath, 'utf-8');
    const lines = exportedRaw.trim().split('\n').filter(Boolean);
    // Lines: [header] + 1 JSONL per exported record; the header carries
    // __worklog_sync__ so data lines are everything else.
    const dataLines = lines.filter(l => !l.includes('__worklog_sync__'));
    // Delta exports ONLY the changed records (proportional payload, AC1/§5.2).
    expect(dataLines.length).toBe(changed.length);
    expect(elapsed).toBeLessThan(2500);
  }, 15000);

  it('full export of a 2000-item store completes ≤ 2500ms (delta-mode peer path)', async () => {
    const T0 = '2026-01-01T00:00:00.000Z';
    seed(2000, T0);

    const start = Date.now();
    await db.exportForSync({ mode: 'full' });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2500);
  }, 15000);
});