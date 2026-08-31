/**
 * Benchmark: impact of a large WAL on read latency.
 *
 * Work item: WL-0MT5J3X1R009A6I6 — Measure read latency impact of large WAL
 *
 * Reproduces the scenario behind the observed 16MB `worklog.db-wal` under
 * concurrent writer load (WL-0MSG8EG7P002MX2I): a writer whose checkpointing
 * cannot keep up (simulated deterministically with `wal_autocheckpoint = 0` on
 * the writer connection) accumulates WAL frames far past SQLite's default
 * 1000-page (~4MB) threshold. Read queries executed while the large WAL exists
 * must scan the WAL for the latest version of every page; after a
 * `PRAGMA wal_checkpoint(TRUNCATE)` those pages live in the main DB file.
 *
 * Usage:
 *   npx tsx bench/wal-read-latency.ts              # run benchmark, text output
 *   npx tsx bench/wal-read-latency.ts --json       # machine-readable output
 *
 * Options:
 *   --items N         work items to create (default 3000)
 *   --desc-kb N       item description size in KiB (default 2)
 *   --wal-target-mb   target WAL size in MiB (default 16, matching observed)
 *   --iterations      query repetitions per phase (default 7, median reported)
 *   --keep            keep temp artifacts (default false)
 *   --json            JSON output for agent consumption
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import Database from 'better-sqlite3';
import { SqlitePersistentStore } from '../src/persistent-store.js';
import type { WorkItem } from '../src/types.js';

interface Options {
  items: number;
  walTargetMb: number;
  iterations: number;
  descKb: number;
  keep: boolean;
  json: boolean;
}

const DEFAULTS: Options = {
  items: 3000,
  walTargetMb: 16,
  iterations: 7,
  descKb: 2,
  keep: false,
  json: false,
};

function parseArgs(argv: string[]): Options {
  const options = { ...DEFAULTS };
  const args = argv.slice(2);
  const readValue = (index: number): string | undefined => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) return undefined;
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--items': {
        const value = readValue(i);
        if (value) options.items = Number(value);
        break;
      }
      case '--wal-target-mb': {
        const value = readValue(i);
        if (value) options.walTargetMb = Number(value);
        break;
      }
      case '--iterations': {
        const value = readValue(i);
        if (value) options.iterations = Number(value);
        break;
      }
      case '--desc-kb': {
        const value = readValue(i);
        if (value) options.descKb = Number(value);
        break;
      }
      case '--keep':
        options.keep = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        break;
    }
  }
  return options;
}

// ── DB helpers ──────────────────────────────────────────────────────

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function walSizeBytes(dbPath: string): number {
  const walPath = `${dbPath}-wal`;
  try {
    return fs.statSync(walPath).size;
  } catch {
    return 0;
  }
}

function makeWorkItem(index: number, items: number, descKb: number): WorkItem {
  // Realistic content: title + description with enough text that rows span
  // multiple 4KB pages (Worklog item descriptions are multi-KB markdown).
  const desc = `Work item ${index} of ${items}. ${'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(Math.max(8, (descKb * 1024) / 124))}`;
  const id = `BENCH-${String(index).padStart(8, '0').toUpperCase()}`;
  return {
    id,
    title: `Benchmark work item ${index}`,
    description: desc,
    status: 'open',
    priority: 'medium',
    sortIndex: (index + 1) * 10,
    parentId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: ['bench'],
    assignee: '',
    stage: 'intake_complete',
    issueType: 'feature',
    createdBy: 'benchmark',
    deletedBy: '',
    deleteReason: '',
    risk: 'Low' as const,
    effort: 'S' as const,
  };
}

// ── Measurements ────────────────────────────────────────────────────

function medianMs(rows: number[]): number {
  const sorted = [...rows].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Run the exact read SQL mirrors of the store's hot paths on a read-only
 * connection. Mirrors:
 *   - PersistentStore.getAllWorkItems:      SELECT * FROM workitems
 *   - PersistentStore.getWorkItem(id):      SELECT * FROM workitems WHERE id = ?
 *   - searchFts:                            SELECT ... FROM worklog_fts WHERE worklog_fts MATCH ?
 */
function measurePhase(dbPath: string, iterations: number, itemIds: string[]): {
  getAllMedianMs: number;
  getByIdMedianMs: number;
  searchMedianMs: number;
} {
  const getAll: number[] = [];
  const getById: number[] = [];
  const search: number[] = [];

  for (let i = 0; i < iterations; i += 1) {
    // One fresh read-only connection per iteration (no schema-init writes,
    // so the measurement isolates WAL-scan cost without triggering
    // auto-checkpoint from the reader). A small SQLite page cache keeps the
    // full-table scan disk/WAL-bound so the WAL effect is not masked by a
    // warm per-connection cache holding the whole table.
    const conn = new Database(dbPath, { readonly: true });
    conn.pragma('cache_size = -2048'); // 2MiB
    try {
      const getAllStmt = conn.prepare('SELECT * FROM workitems');
      const getAllStart = process.hrtime.bigint();
      getAllStmt.all();
      getAll.push(Number(process.hrtime.bigint() - getAllStart) / 1e6);

      const getByIdStmt = conn.prepare('SELECT * FROM workitems WHERE id = ?');
      const id = itemIds[i % itemIds.length];
      const getByIdStart = process.hrtime.bigint();
      getByIdStmt.get(id);
      getById.push(Number(process.hrtime.bigint() - getByIdStart) / 1e6);

      const searchStmt = conn.prepare(
        "SELECT * FROM worklog_fts WHERE worklog_fts MATCH 'benchmark*' LIMIT 50"
      );
      const searchStart = process.hrtime.bigint();
      searchStmt.all();
      search.push(Number(process.hrtime.bigint() - searchStart) / 1e6);
    } finally {
      conn.close();
    }
  }

  return {
    getAllMedianMs: medianMs(getAll),
    getByIdMedianMs: medianMs(getById),
    searchMedianMs: medianMs(search),
  };
}

function pct(largeMs: number, smallMs: number): number {
  if (smallMs <= 0) return 0;
  return ((largeMs - smallMs) / smallMs) * 100;
}

// ── Benchmark runner (exported for tests / CLI) ────────────────────

export interface WalReadLatencyResult {
  items: number;
  walTargetMiB: number;
  iterations: number;
  walSizeLargeMiB: number;
  walCheckpoint: unknown[];
  phaseResults: Array<{
    phase: string;
    walMiB: number;
    getAllMedianMs: number;
    getByIdMedianMs: number;
    searchMedianMs: number;
  }>;
  delta: { getAllSlowerPct: number; getByIdSlowerPct: number; searchSlowerPct: number };
  dbPath: string;
}

/**
 * Run the full benchmark: build a temp worklog DB (real schema), grow a
 * large WAL on a writer connection with auto-checkpoint disabled, measure
 * reads, `wal_checkpoint(TRUNCATE)`, measure reads again. Returns the
 * summary (and removes the temp dir unless `--keep`).
 */
export function runBenchmark(argv: string[]): WalReadLatencyResult {
  const options = parseArgs(argv);
  const tempDir = createTempDir('wl-wal-bench-');
  const dbPath = path.join(tempDir, 'worklog.db');

  try {
    // 1. Create the real schema (store ctor runs schema init + WAL pragmas).
    const store = new SqlitePersistentStore(dbPath);
    const items = Array.from({ length: options.items }, (_, i) => makeWorkItem(i, options.items, options.descKb));
    store.importData(items, []);
    // Compact: baseline data is small and fully checkpointed on the way out.
    store.close();

    const itemIds = items.map((i) => i.id);

    // 2. Simulate "checkpointing cannot keep up": a writer connection with
    //    auto-checkpoint disabled bloats the WAL to the target size.
    const writer = new Database(dbPath);
    // Disable automatic checkpointing on the writer so WAL frames genuinely
    // accumulate (mirrors the spawn-storm case where concurrent writers
    // outpace any single connection's between-transaction checkpoint).
    writer.pragma('wal_autocheckpoint = 0');
    const walTargetBytes = options.walTargetMb * 1024 * 1024;
    const bloatStmt = writer.prepare('UPDATE workitems SET description = ? WHERE id = ?');
    // Content must CHANGE every write: SQLite treats an UPDATE that sets the
    // same value as a no-op (no page rewrite, no WAL frame).
    let bloatSeq = 0;
    const nextBloat = () => `bloat-${bloatSeq++}: ${'x'.repeat(8 * 1024)}`;
    // Bloat in small committed batches and check the WAL size after each
    // commit — the on-disk WAL size only reflects committed frames, so
    // checking inside one giant transaction gives stale sizes.
    const BATCH = 64;
    while (walSizeBytes(dbPath) < walTargetBytes) {
      const batch = itemIds.slice(0, Math.min(BATCH, itemIds.length));
      const tx = writer.transaction(() => {
        for (const id of batch) bloatStmt.run(nextBloat(), id);
      });
      tx();
    }
    const walMb = walSizeBytes(dbPath) / (1024 * 1024);

    // 3. Measure reads while the large WAL exists (writer stays open so no
    //    checkpoint-on-close fires mid-measurement).
    const before = measurePhase(dbPath, options.iterations, itemIds);

    // 4. Force a TRUNCATE checkpoint (merges WAL into the main DB file).
    const checkpoint = writer.pragma('wal_checkpoint(TRUNCATE)') as unknown[];
    writer.close();

    // 5. Measure the same reads again with the WAL fully merged.
    const after = measurePhase(dbPath, options.iterations, itemIds);

    return {
      items: options.items,
      walTargetMiB: options.walTargetMb,
      iterations: options.iterations,
      walSizeLargeMiB: walMb,
      walCheckpoint: checkpoint,
      phaseResults: [
        { phase: 'large-wal', walMiB: walMb, ...before },
        { phase: 'after-checkpoint', walMiB: 0, ...after },
      ],
      delta: {
        getAllSlowerPct: pct(before.getAllMedianMs, after.getAllMedianMs),
        getByIdSlowerPct: pct(before.getByIdMedianMs, after.getByIdMedianMs),
        searchSlowerPct: pct(before.searchMedianMs, after.searchMedianMs),
      },
      dbPath,
    };
  } finally {
    if (!options.keep) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  const summary = runBenchmark(process.argv);
  if (options.json) {
    console.log(JSON.stringify({ ...summary, timestamp: new Date().toISOString() }, null, 2));
  } else {
    console.log('WAL read-latency benchmark');
    console.log(`- items: ${summary.items}`);
    console.log(`- walTargetMiB: ${summary.walTargetMiB}`);
    console.log(`- iterations: ${summary.iterations}`);
    console.log(`- large WAL size: ${summary.walSizeLargeMiB.toFixed(2)} MiB`);
    console.log(`- wal_checkpoint(TRUNCATE): ${JSON.stringify(summary.walCheckpoint)}`);
    console.log('');
    console.table(summary.phaseResults.map((r) => ({
      phase: r.phase,
      'WAL MiB': r.walMiB,
      'getAllWorkItems ms': r.getAllMedianMs,
      'getWorkItem(id) ms': r.getByIdMedianMs,
      'searchFts ms': r.searchMedianMs,
    })));
    console.log('');
    console.log('Large-WAL vs checkpointed slowdown:');
    console.log(`  getAllWorkItems:  ${summary.delta.getAllSlowerPct.toFixed(1)}%`);
    console.log(`  getWorkItem(id):  ${summary.delta.getByIdSlowerPct.toFixed(1)}%`);
    console.log(`  searchFts:        ${summary.delta.searchSlowerPct.toFixed(1)}%`);
    console.log(`  dbPath: ${summary.dbPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('benchmark failed:', err);
    process.exitCode = 1;
  });
}