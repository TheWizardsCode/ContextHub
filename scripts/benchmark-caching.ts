/**
 * Benchmark script for in-memory caching in SqlitePersistentStore (Phase 5).
 *
 * Compares read performance with caching enabled vs disabled for the key
 * read operations (getWorkItem, getAllWorkItems, getCommentsForWorkItem,
 * getAllDependencyEdges).
 *
 * Usage:
 *   npm run build:shared
 *   npx tsx scripts/benchmark-caching.ts
 *
 * Environment variables:
 *   WL_BENCH_ITERATIONS  - Number of iterations per benchmark (default: 1000)
 *   WL_BENCH_ITEM_COUNT  - Number of work items to create (default: 100)
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Lazy-import the SqlitePersistentStore from the built shared package.
let SqlitePersistentStore: any;

try {
  const mod = await import('../packages/shared/dist/persistent-store.js');
  SqlitePersistentStore = mod.SqlitePersistentStore;
} catch {
  console.error('ERROR: Could not load SqlitePersistentStore from packages/shared/dist/persistent-store.js');
  console.error('Run `npm run build:shared` first.');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────

function randomId(prefix = 'BENCH'): string {
  return `${prefix}-${randomBytes(8).toString('hex').toUpperCase()}`;
}

function createTempDbPath(dir: string): string {
  return path.join(dir, 'bench.db');
}

// ── Benchmark runner ───────────────────────────────────────────────────

async function runBenchmark(label: string, fn: (store: any) => void, iterations: number, dbPath: string): Promise<{ cached: number; uncached: number }> {
  // --- Cached run (TTL = 60s so all reads hit cache) ---
  const cachedStore = new SqlitePersistentStore(dbPath, false, undefined, { enabled: true, ttlMs: 60000, maxEntries: 500 });
  // Warm up the cache
  fn(cachedStore);

  const cachedStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn(cachedStore);
  }
  const cachedMs = performance.now() - cachedStart;
  cachedStore.close();

  // --- Uncached run (TTL = 0 disables cache) ---
  const uncachedStore = new SqlitePersistentStore(dbPath, false, undefined, { enabled: false });
  // Warm up (no caching, so this just primes SQLite page cache)
  fn(uncachedStore);

  const uncachedStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn(uncachedStore);
  }
  const uncachedMs = performance.now() - uncachedStart;
  uncachedStore.close();

  return { cached: cachedMs, uncached: uncachedMs };
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// ── Main ───────────────────────────────────────────────────────────────

const ITERATIONS = parseInt(process.env.WL_BENCH_ITERATIONS ?? '1000', 10);
const ITEM_COUNT = parseInt(process.env.WL_BENCH_ITEM_COUNT ?? '100', 10);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-bench-cache-'));
const dbPath = createTempDbPath(tempDir);

console.log('═══════════════════════════════════════════════════════════');
console.log('  SqlitePersistentStore Cache Benchmark (Phase 5)');
console.log(`  Iterations: ${ITERATIONS.toLocaleString()}`);
console.log(`  Work items: ${ITEM_COUNT.toLocaleString()}`);
console.log('═══════════════════════════════════════════════════════════');
console.log();

// Set up test data
console.log('Setting up test data...');
const setupStore = new SqlitePersistentStore(dbPath, false, undefined, { enabled: false });
const itemIds: string[] = [];
for (let i = 0; i < ITEM_COUNT; i++) {
  const id = randomId();
  itemIds.push(id);
  setupStore.saveWorkItem({
    id,
    title: `Benchmark item ${i}`,
    description: `This is test item number ${i} for the caching benchmark. `.repeat(10),
    status: 'open',
    priority: 'medium',
    sortIndex: i * 100,
    parentId: i > 0 ? itemIds[Math.floor(i / 2)] : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: ['benchmark', `group-${i % 5}`],
    assignee: i % 3 === 0 ? 'alice' : i % 3 === 1 ? 'bob' : 'charlie',
    stage: i % 2 === 0 ? 'intake_complete' : 'plan_complete',
    issueType: 'task',
    createdBy: 'benchmark',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    needsProducerReview: false,
  });
}
// Add some comments
for (let i = 0; i < ITEM_COUNT / 2; i++) {
  if (itemIds[i]) {
    setupStore.saveComment({
      id: `BENCH-C${i}`,
      workItemId: itemIds[i],
      author: 'benchmark',
      comment: `This is a benchmark comment for item ${i}`,
      createdAt: new Date().toISOString(),
      references: [],
    });
  }
}
// Add some dependency edges
for (let i = 1; i < ITEM_COUNT; i++) {
  setupStore.saveDependencyEdge({
    fromId: itemIds[i],
    toId: itemIds[0],
    createdAt: new Date().toISOString(),
  });
}
setupStore.close();
console.log(`Created ${ITEM_COUNT} items, ~${Math.floor(ITEM_COUNT/2)} comments, ${ITEM_COUNT-1} dependency edges`);
console.log();

// ── Benchmark 1: getWorkItem ───────────────────────────────────────────
console.log('▶ Benchmark 1: getWorkItem()');
const r1 = await runBenchmark('getWorkItem', (store) => {
  store.getWorkItem(itemIds[Math.floor(Math.random() * itemIds.length)]);
}, ITERATIONS, dbPath);
console.log(`  Cached:   ${formatMs(r1.cached)}`);
console.log(`  Uncached: ${formatMs(r1.uncached)}`);
const imp1 = r1.uncached > 0 ? (r1.uncached / Math.max(r1.cached, 0.001)).toFixed(1) : 'N/A';
console.log(`  Speedup:  ${imp1}x`);
console.log();

// ── Benchmark 2: getAllWorkItems ───────────────────────────────────────
console.log('▶ Benchmark 2: getAllWorkItems()');
const r2 = await runBenchmark('getAllWorkItems', (store) => {
  store.getAllWorkItems();
}, Math.max(1, Math.floor(ITERATIONS / 10)), dbPath);
console.log(`  Cached:   ${formatMs(r2.cached)}`);
console.log(`  Uncached: ${formatMs(r2.uncached)}`);
const imp2 = r2.uncached > 0 ? (r2.uncached / Math.max(r2.cached, 0.001)).toFixed(1) : 'N/A';
console.log(`  Speedup:  ${imp2}x`);
console.log();

// ── Benchmark 3: getCommentsForWorkItem ────────────────────────────────
console.log('▶ Benchmark 3: getCommentsForWorkItem()');
const r3 = await runBenchmark('getCommentsForWorkItem', (store) => {
  store.getCommentsForWorkItem(itemIds[Math.floor(Math.random() * Math.min(ITEM_COUNT/2, itemIds.length))]);
}, ITERATIONS, dbPath);
console.log(`  Cached:   ${formatMs(r3.cached)}`);
console.log(`  Uncached: ${formatMs(r3.uncached)}`);
const imp3 = r3.uncached > 0 ? (r3.uncached / Math.max(r3.cached, 0.001)).toFixed(1) : 'N/A';
console.log(`  Speedup:  ${imp3}x`);
console.log();

// ── Benchmark 4: getAllDependencyEdges ─────────────────────────────────
console.log('▶ Benchmark 4: getAllDependencyEdges()');
const r4 = await runBenchmark('getAllDependencyEdges', (store) => {
  store.getAllDependencyEdges();
}, Math.max(1, Math.floor(ITERATIONS / 10)), dbPath);
console.log(`  Cached:   ${formatMs(r4.cached)}`);
console.log(`  Uncached: ${formatMs(r4.uncached)}`);
const imp4 = r4.uncached > 0 ? (r4.uncached / Math.max(r4.cached, 0.001)).toFixed(1) : 'N/A';
console.log(`  Speedup:  ${imp4}x`);
console.log();

// ── Benchmark 5: Mixed workload with cache invalidation ──
console.log('▶ Benchmark 5: Mixed workload (10% writes, 90% reads)');
const mixedIterations = Math.max(1, Math.floor(ITERATIONS / 5));
const mixedStore = new SqlitePersistentStore(dbPath, false, undefined, { enabled: true, ttlMs: 60000, maxEntries: 500 });
// Warm up cache
for (let i = 0; i < 10; i++) {
  mixedStore.getAllWorkItems();
  mixedStore.getWorkItem(itemIds[0]);
}
const mixedStart = performance.now();
for (let i = 0; i < mixedIterations; i++) {
  if (i % 10 === 0) {
    mixedStore.saveWorkItem({
      ...mixedStore.getWorkItem(itemIds[0])!,
      title: `Updated ${i}`,
      updatedAt: new Date().toISOString(),
    });
  }
  mixedStore.getWorkItem(itemIds[Math.floor(Math.random() * itemIds.length)]);
}
const mixedMs = performance.now() - mixedStart;
mixedStore.close();
console.log(`  ${mixedIterations} operations:`);
console.log(`  Total:    ${formatMs(mixedMs)}`);
console.log(`  Avg/op:   ${(mixedMs / mixedIterations).toFixed(3)}ms`);
console.log();

// ── Summary ────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════');
console.log('  Summary');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  getWorkItem()           : ${imp1}x faster`);
console.log(`  getAllWorkItems()       : ${imp2}x faster`);
console.log(`  getCommentsForWorkItem(): ${imp3}x faster`);
console.log(`  getAllDependencyEdges() : ${imp4}x faster`);
console.log();

// Clean up
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('✓ Temp database cleaned up.');
