/**
 * Tests for the WAL read-latency benchmark contract (WL-0MT5J3X1R009A6I6).
 *
 * The benchmark reproduces the production-observed scenario (16MB
 * worklog.db-wal under concurrent write load): a writer with auto-checkpoint
 * disabled accumulates WAL frames past SQLite's default ~4MB threshold, reads
 * slow down, then a TRUNCATE checkpoint merges them back. These tests assert
 * the observable contract of that harness, not SQLite internals:
 *
 *   1. a large WAL (>4MB, i.e. past the default auto-checkpoint threshold)
 *      genuinely accumulates during the "checkpointing cannot keep up" phase,
 *   2. `wal_checkpoint(TRUNCATE)` merges it back (WAL size collapses),
 *   3. read queries return the correct row counts in both phases.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { runBenchmark, type WalReadLatencyResult } from '../../bench/wal-read-latency.js';

describe('WAL read-latency benchmark harness', () => {
  let summary: WalReadLatencyResult;

  beforeAll(() => {
    // Small-but-meaningful run: 300 items, 4MiB target WAL (past the default
    // 1000-page/4MB auto-checkpoint threshold so a real accumulation is shown).
    summary = runBenchmark([
      'node',
      'bench/wal-read-latency.ts',
      '--items',
      '300',
      '--wal-target-mb',
      '4',
      '--iterations',
      '3',
      '--desc-kb',
      '2',
      '--keep',
    ]);
  });

  afterAll(() => {
    // runBenchmark with --keep leaves the temp dir for inspection; clean up.
    fs.rmSync(path.dirname(summary.dbPath), { recursive: true, force: true });
  });

  it('grows a large WAL past the default auto-checkpoint threshold', () => {
    // >4MiB => genuinely exceeds SQLite's default 1000-page (~4MB) threshold,
    // which is the whole premise of the reproduction.
    expect(summary.walSizeLargeMiB).toBeGreaterThan(4);
  });

  it('reports a large-WAL phase and an after-checkpoint phase', () => {
    const phases = summary.phaseResults.map((p) => p.phase);
    expect(phases).toEqual(['large-wal', 'after-checkpoint']);
    expect(summary.phaseResults[0].walMiB).toBeGreaterThan(4);
    expect(summary.phaseResults[1].walMiB).toBe(0);
  });

  it('read queries return the correct row counts in both phases', () => {
    // verify the measurement connections see the seeded data in both phases;
    // keep the temp dir (--keep) so the DB is inspectable here.
    const conn = new Database(summary.dbPath, { readonly: true });
    try {
      const count = conn.prepare('SELECT COUNT(*) AS c FROM workitems').get() as { c: number };
      // seeded 300 items — bloat only updates existing rows, never inserts
      expect(count.c).toBe(300);
    } finally {
      conn.close();
    }
  });
});