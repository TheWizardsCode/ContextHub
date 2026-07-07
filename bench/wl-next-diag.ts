/**
 * Diagnostic timing for wl next pipeline.
 * Measures each stage independently to find bottlenecks.
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { WorklogDatabase } from '../src/database.js';

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-diag-'));
const dbPath = path.join(tmpdir, 'perf.db');
const jsonlPath = path.join(tmpdir, 'perf.jsonl');
const db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, false);

const NUM_ITEMS = 1000;
const allItems: any[] = [];
const priorities = ['critical', 'high', 'medium', 'low'] as const;

for (let i = 0; i < NUM_ITEMS; i++) {
  const parentId = i > 20 ? allItems[Math.floor(Math.random() * Math.min(i, 30))]?.id : undefined;
  const item = db.create({
    title: `Item ${i}`,
    priority: priorities[i % 4],
    description: `Desc ${i}`,
    parentId,
  });
  allItems.push(item);
}

for (let i = 0; i < 200 && i + 1 < allItems.length; i++) {
  try { db.addDependencyEdge(allItems[i].id, allItems[(i + 5) % allItems.length].id); } catch {}
}

console.log(`Dataset: ${NUM_ITEMS} items`);

let t0: number;

// Time 1: getAllWorkItems
t0 = Date.now();
for (let i = 0; i < 5; i++) db.store.getAllWorkItems();
console.log(`getAllWorkItems ×5: ${Date.now() - t0}ms avg=${(Date.now() - t0) / 5}ms`);

// Time 2: getAllDependencyEdges  
t0 = Date.now();
for (let i = 0; i < 5; i++) db.store.getAllDependencyEdges();
console.log(`getAllDependencyEdges ×5: ${Date.now() - t0}ms avg=${(Date.now() - t0) / 5}ms`);

// Time 3: buildEdgeCache
t0 = Date.now();
const items = db.store.getAllWorkItems();
for (let i = 0; i < 5; i++) (db as any).buildEdgeCache(items);
console.log(`buildEdgeCache ×5: ${Date.now() - t0}ms avg=${(Date.now() - t0) / 5}ms`);

// Time 4: orderItemsByHierarchySortIndexSkipCompleted
t0 = Date.now();
for (let i = 0; i < 5; i++) db.store.orderItemsByHierarchySortIndexSkipCompleted(items);
console.log(`orderItemsByHierarchySortIndexSkipCompleted ×5: ${Date.now() - t0}ms avg=${(Date.now() - t0) / 5}ms`);

// Time 5: getChildren (individual queries)
t0 = Date.now();
for (let i = 0; i < 100; i++) db.getChildren(items[i].id);
console.log(`getChildren ×100: ${Date.now() - t0}ms avg=${(Date.now() - t0) / 100}ms`);

// Time 6: findNextWorkItem
t0 = Date.now();
for (let i = 0; i < 5; i++) {
  const r = db.findNextWorkItem();
  if (!r) console.error('no result');
}
console.log(`findNextWorkItem ×5: ${Date.now() - t0}ms avg=${(Date.now() - t0) / 5}ms`);

// Time 7: getAllComments
t0 = Date.now();
for (let i = 0; i < 5; i++) db.store.getAllComments();
console.log(`getAllComments ×5: ${Date.now() - t0}ms avg=${(Date.now() - t0) / 5}ms`);

// Time 8: findNextWorkItem with search
t0 = Date.now();
for (let i = 0; i < 3; i++) db.findNextWorkItem(undefined, 'test');
console.log(`findNextWorkItem with search ×3: ${Date.now() - t0}ms avg=${(Date.now() - t0) / 3}ms`);

db.close();
fs.rmSync(tmpdir, { recursive: true, force: true });
