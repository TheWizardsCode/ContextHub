/**
 * Performance benchmark for `wl next` operations.
 *
 * Measures wall-clock time for the key wl next scenarios to validate
 * performance improvements and prevent regressions.
 *
 * Usage:
 *   npx tsx bench/wl-next-perf.ts          # Run all benchmarks
 *   npx tsx bench/wl-next-perf.ts --json   # JSON output for agent consumption
 *
 * Environment:
 *   WL_DATA_PATH=<path>  Path to a real worklog data.jsonl to benchmark against
 *                        a production dataset. If not set, uses a synthetic dataset.
 *
 * Expected targets (on real dataset with ~1355 items, ~274 edges, ~4592 comments):
 *   - wl next (default re-sort):        < 500ms
 *   - wl next --no-re-sort:             < 200ms
 *   - wl next -n 5 (batch):             < 1000ms
 *   - wl next --json:                   < 500ms
 *   - wl next --search "<term>":        < 1000ms
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorklogDatabase } from '../src/database.js';

// ── Configuration ────────────────────────────────────────────────────

const TARGETS = {
  reSort: { maxMs: 500, label: 'wl next (re-sort)' },
  noReSort: { maxMs: 200, label: 'wl next --no-re-sort' },
  batch5: { maxMs: 1000, label: 'wl next -n 5 (batch)' },
  json: { maxMs: 500, label: 'wl next --json' },
  search: { maxMs: 1000, label: 'wl next --search "<term>"' },
};

interface BenchmarkResult {
  name: string;
  durationMs: number;
  maxMs: number;
  passed: boolean;
  itemCount?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wl-perf-'));
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

function generateSyntheticData(db: WorklogDatabase, count: number): void {
  const priorities = ['critical', 'high', 'medium', 'low'] as const;
  const statuses = ['open', 'in-progress', 'completed', 'blocked'] as const;

  // Create parent items
  for (let i = 0; i < count / 2; i++) {
    const item = db.create({
      title: `Benchmark parent item ${i}`,
      priority: priorities[i % priorities.length],
      description: `Description for benchmark item ${i}. This contains some searchable text like "aardvark" and "zymurgy" for search benchmarks.`,
    });

    // Add some comments
    db.createComment({
      workItemId: item.id,
      author: 'benchmark',
      comment: `Comment for item ${i}. This also contains searchable terms like "platypus" and "xylophone".`,
    });

    // Add dependency edges (chain pattern)
    if (i > 0) {
      const prev = db.get(item.id - 1 as any); // Can't do this, use a different approach
    }
  }

  // Create child items (some with parents)
  for (let i = 0; i < count / 2; i++) {
    const parentId = i < count / 4 ? undefined : `BENCH-P${i % (count / 4)}`;
    const item = db.create({
      title: `Benchmark child item ${i}`,
      priority: priorities[i % priorities.length],
      parentId,
      description: `Description for child item ${i}.`,
    });
  }
}

// Add dependency edges using list of items
function addDependencyEdges(db: WorklogDatabase, items: any[], count: number): void {
  const edgesAdded = 0;
  for (let i = 0; i < items.length && edgesAdded < count; i++) {
    const from = items[i];
    const to = items[(i + 1) % items.length];
    if (from && to && from.id !== to.id) {
      try {
        db.addDependencyEdge(from.id, to.id);
      } catch {
        // Skip duplicate edges
      }
    }
  }
}

// ── Benchmark runner ────────────────────────────────────────────────

async function runBenchmarks(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'perf.db');
  const jsonlPath = path.join(tempDir, 'perf.jsonl');

  let db: WorklogDatabase;

  try {
    // Try to use real dataset if available
    const wlDataPath = process.env.WL_DATA_PATH;
    if (wlDataPath && fs.existsSync(wlDataPath)) {
      // Initialize from real dataset
      db = new WorklogDatabase('BENCH', dbPath, jsonlPath, true, false);
      fs.copyFileSync(wlDataPath, jsonlPath);
      db.refreshFromJsonlIfNewer();
    } else {
      // Create synthetic dataset
      db = new WorklogDatabase('BENCH', dbPath, jsonlPath, true, false);
      
      // Generate ~1000 items for benchmarking
      const NUM_ITEMS = 1000;
      const allItems: any[] = [];
      
      const priorities = ['critical', 'high', 'medium', 'low'] as const;
      
      // Create items with varying priorities
      for (let i = 0; i < NUM_ITEMS; i++) {
        const item = db.create({
          title: `Perf item ${i}`,
          priority: priorities[i % priorities.length],
          description: `Description for item ${i}. Searchable terms: platypus aardvark xylophone zymurgy ${i}.`,
        });
        allItems.push(item);
        
        // Add comments to some items
        if (i % 5 === 0) {
          db.createComment({
            workItemId: item.id,
            author: 'perf-bench',
            comment: `Comment for item ${i}. Contains searchable terms: mountain river forest ${i}.`,
          });
        }
      }
      
      // Add dependency edges (about 200)
      for (let i = 0; i < 200 && i + 1 < allItems.length; i++) {
        try {
          db.addDependencyEdge(allItems[i].id, allItems[(i + 5) % allItems.length].id);
        } catch {
          // skip
        }
      }
      
      console.error(`Created synthetic dataset: ${allItems.length} items`);
    }

    // Warmup: run once to ensure caches are warm (JIT compilation)
    const warmupStart = Date.now();
    db.findNextWorkItem();
    console.error(`Warmup: ${Date.now() - warmupStart}ms`);

    // Benchmark 1: wl next with re-sort (reSort + findNextWorkItem)
    console.error('\n--- Benchmark 1: wl next (re-sort) ---');
    const reSortStart = Date.now();
    db.reSort();
    const reSortMid = Date.now();
    const reSortResult = db.findNextWorkItem();
    const reSortEnd = Date.now();
    const reSortDuration = reSortEnd - reSortStart;
    console.error(`  reSort: ${reSortMid - reSortStart}ms, findNextWorkItem: ${reSortEnd - reSortMid}ms, total: ${reSortDuration}ms`);
    console.error(`  Result: ${reSortResult.workItem?.id ?? 'none'} (${reSortResult.reason || 'no reason'})`);
    results.push({
      name: TARGETS.reSort.label,
      durationMs: reSortDuration,
      maxMs: TARGETS.reSort.maxMs,
      passed: reSortDuration <= TARGETS.reSort.maxMs,
    });

    // Benchmark 2: wl next --no-re-sort (just findNextWorkItem)
    console.error('\n--- Benchmark 2: wl next --no-re-sort ---');
    const noReSortStart = Date.now();
    const noReSortResult = db.findNextWorkItem();
    const noReSortEnd = Date.now();
    const noReSortDuration = noReSortEnd - noReSortStart;
    console.error(`  findNextWorkItem: ${noReSortDuration}ms`);
    console.error(`  Result: ${noReSortResult.workItem?.id ?? 'none'}`);
    results.push({
      name: TARGETS.noReSort.label,
      durationMs: noReSortDuration,
      maxMs: TARGETS.noReSort.maxMs,
      passed: noReSortDuration <= TARGETS.noReSort.maxMs,
    });

    // Benchmark 3: batch mode (n=5)
    console.error('\n--- Benchmark 3: wl next -n 5 (batch) ---');
    const batchStart = Date.now();
    const batchResults = db.findNextWorkItems(5);
    const batchEnd = Date.now();
    const batchDuration = batchEnd - batchStart;
    console.error(`  findNextWorkItems(5): ${batchDuration}ms`);
    console.error(`  Results: ${batchResults.filter(r => r.workItem).length} items`);
    results.push({
      name: TARGETS.batch5.label,
      durationMs: batchDuration,
      maxMs: TARGETS.batch5.maxMs,
      passed: batchDuration <= TARGETS.batch5.maxMs,
    });

    // Benchmark 4: JSON mode (single item, with re-sort to reset)
    console.error('\n--- Benchmark 4: wl next --json ---');
    db.reSort();
    const jsonStart = Date.now();
    const jsonResult = db.findNextWorkItem();
    const jsonEnd = Date.now();
    const jsonDuration = jsonEnd - jsonStart;
    console.error(`  findNextWorkItem: ${jsonDuration}ms (equivalent to --json output)`);
    console.error(`  Result: ${jsonResult.workItem?.id ?? 'none'}`);
    results.push({
      name: TARGETS.json.label,
      durationMs: jsonDuration,
      maxMs: TARGETS.json.maxMs,
      passed: jsonDuration <= TARGETS.json.maxMs,
    });

    // Benchmark 5: search
    console.error('\n--- Benchmark 5: wl next --search "platypus" ---');
    const searchStart = Date.now();
    const searchResult = db.findNextWorkItem(undefined, 'platypus');
    const searchEnd = Date.now();
    const searchDuration = searchEnd - searchStart;
    console.error(`  findNextWorkItem with search: ${searchDuration}ms`);
    console.error(`  Result: ${searchResult.workItem?.id ?? 'none'}`);
    results.push({
      name: TARGETS.search.label,
      durationMs: searchDuration,
      maxMs: TARGETS.search.maxMs,
      passed: searchDuration <= TARGETS.search.maxMs,
    });

  } finally {
    db?.close();
    cleanupTempDir(tempDir);
  }

  return results;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const isJsonMode = process.argv.includes('--json');
  const results = await runBenchmarks();

  const allPassed = results.every(r => r.passed);
  const failed = results.filter(r => !r.passed);

  if (isJsonMode) {
    console.log(JSON.stringify({
      success: allPassed,
      results,
      summary: {
        total: results.length,
        passed: results.filter(r => r.passed).length,
        failed: failed.length,
      },
      targetsMet: allPassed ? 'All performance targets met' : `Failed targets: ${failed.map(f => f.name).join(', ')}`,
    }, null, 2));
  } else {
    console.log('\n========================================');
    console.log('  wl next Performance Benchmarks');
    console.log('========================================\n');

    for (const result of results) {
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      console.log(`  ${status}  ${result.name}`);
      console.log(`       ${result.durationMs}ms / ${result.maxMs}ms target`);
      console.log('');
    }

    console.log('----------------------------------------');
    if (allPassed) {
      console.log('  ✅ All performance targets met!\n');
    } else {
      console.log(`  ❌ ${failed.length} benchmark(s) failed targets:\n`);
      for (const f of failed) {
        console.log(`     - ${f.name}: ${f.durationMs}ms (target: ${f.maxMs}ms)`);
      }
      console.log('');
    }
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
