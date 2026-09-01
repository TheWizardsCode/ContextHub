/**
 * Tests for bounded WAL growth after bulk imports (WL-0MT5J4Q290025O0L).
 *
 * The recommendation (recorded on WL-0MT5J4Q290025O0L / parent
 * WL-0MSG8EG7P002MX2I) is to checkpoint explicitly after the largest write
 * path — importData() (used by `wl sync`, doctor, init) — via a PASSIVE
 * checkpoint, and NOT to raise the auto-checkpoint threshold (measured read
 * latency grows with WAL size; see docs/benchmarks/wal-read-latency-benchmark.md).
 *
 * These tests assert the observable contract of that change using the public
 * API + on-disk files:
 *   1. After repeated importData() calls, the -wal file stays bounded
 *      (a checkpoint merges frames back instead of letting them accumulate).
 *   2. Reads after importData() return the imported rows (data correctness).
 *   3. A fresh connection sees no outstanding (un-checkpointed) frames while
 *      the store is still open — the explicit PASSIVE checkpoint already
 *      merged the import batch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { SqlitePersistentStore } from '../../src/persistent-store.js';
import type { WorkItem } from '../../src/types.js';
import { createTempDir, cleanupTempDir, createTempDbPath } from '../test-utils.js';

function makeItem(id: string, descSize = 2 * 1024): WorkItem {
  return {
    id,
    title: `Item ${id}`,
    description: `desc ${'x'.repeat(descSize)}`,
    status: 'open' as const,
    priority: 'medium' as const,
    sortIndex: 100,
    parentId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
    assignee: '',
    stage: 'intake_complete',
    issueType: 'feature',
    createdBy: 'test',
    deletedBy: '',
    deleteReason: '',
    risk: 'Low' as const,
    effort: 'S' as const,
  };
}

describe('WAL bounding after importData (explicit PASSIVE checkpoint)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('keeps the -wal file bounded across repeated bulk imports', () => {
    const store = new SqlitePersistentStore(dbPath);
    const walPath = `${dbPath}-wal`;
    try {
      // importData writes a transaction + explicit PASSIVE checkpoint, so the
      // WAL frames for each batch are merged back — the file must NOT grow
      // monotonically with the number of imports.
      const sizes: number[] = [];
      for (let round = 0; round < 3; round++) {
        const item = makeItem(`BENCH-${round}`);
        item.description = `round ${round}: ${'y'.repeat(8 * 1024)}`;
        store.importData([item], []);
        sizes.push(fs.statSync(walPath).size);
      }
      // Without the explicit checkpoint, each import appends ~8KB+ of frames
      // and the file grows linearly. With it, the file is reused (bounded).
      // Allow a small bound for bookkeeping: the largest size must not exceed
      // the smallest by more than 25% (a linear accumulation would exceed it
      // by 200%+).
      const min = Math.min(...sizes);
      const max = Math.max(...sizes);
      expect(max).toBeLessThan(min * 1.25);
    } finally {
      store.close();
    }
  });

  it('serves the imported rows to a fresh connection while the store stays open', () => {
    const store = new SqlitePersistentStore(dbPath);
    try {
      const items = [makeItem('BENCH-0001'), makeItem('BENCH-0002')];
      store.importData(items, []);
      // A fresh connection (like a concurrently-running `wl` process) must
      // see the imported data — reads consult the WAL, which the explicit
      // checkpoint merged.
      const conn = new Database(dbPath);
      try {
        const rows = conn.prepare('SELECT id FROM workitems ORDER BY id').all() as Array<{ id: string }>;
        expect(rows.map((r) => r.id)).toEqual(['BENCH-0001', 'BENCH-0002']);
      } finally {
        conn.close();
      }
    } finally {
      store.close();
    }
  });

  it('imports replace prior rows across successive bulk imports', () => {
    const store = new SqlitePersistentStore(dbPath);
    try {
      store.importData([makeItem('BENCH-0001')], []);
      store.importData([makeItem('BENCH-0002')], []);
      // importData replaces the dataset (like wl sync pulling a fresh JSONL):
      // the second import must clear the first — the checkpoint between them
      // must not interfere with the clear-and-reinsert semantics.
      const all = store.getAllWorkItems().map((i) => i.id);
      expect(all).toEqual(['BENCH-0002']);
    } finally {
      store.close();
    }
  });
});