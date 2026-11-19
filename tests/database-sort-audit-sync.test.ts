/**
 * Tests for WorklogDatabase — JSONL refresh, sorting, caching and audit boosts.
 *
 * JSONL refresh fallback, re-sort ordering, caching and the audit-freshness boosts.
 *
 * Split mechanically from `tests/database.test.ts`
 * (WL-0MVOBP8MC0093Y7T, lockstep with the `database.ts` decomposition: a test
 * file over 1,000 lines is split along describe boundaries). Describe titles,
 * assertions and fixtures are unchanged; only the file boundary (and the
 * duplicated preamble) changed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WorklogDatabase } from '../src/database.js';
import type { WorkItem } from '../src/types.js';
import { isAuditFresh } from '@worklog/shared/icons';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';

/**
 * Invoke the `cascadePriorityPromote` façade member under test.
 *
 * Returns the promoted ancestors as `WorkItem[]` in walk order — the direct
 * parent first, then each successive ancestor up to the root — mirroring
 * `cascadePriorityDowngrade`, which returns the affected children.
 */
function cascadePriorityPromote(database: WorklogDatabase, itemId: string): WorkItem[] {
  return database.cascadePriorityPromote(itemId);
}

describe('WorklogDatabase', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    if (fs.existsSync(jsonlPath)) {
      fs.unlinkSync(jsonlPath);
    }
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });
  describe('refreshFromJsonlIfNewer - graceful fallback', () => {
    it('should fall back to cached SQLite data when JSONL is corrupted', () => {
      // Step 1: Create a database and populate it with a work item
      const item = db.create({ title: 'Cached item', description: 'Should survive corruption' });
      const itemId = item.id;

      // Step 2: Close the database so the SQLite cache is flushed
      db.close();

      // Step 3: Corrupt the JSONL file with invalid content
      fs.writeFileSync(jsonlPath, '{{{{not valid json at all!!!!\n{broken\n');

      // Step 4: Bump the mtime so the DB thinks JSONL is newer and needs refresh
      const futureTime = new Date(Date.now() + 60_000);
      fs.utimesSync(jsonlPath, futureTime, futureTime);

      // Step 5: Re-open the database — constructor calls refreshFromJsonlIfNewer()
      // This must NOT throw despite the corrupted JSONL
      const db2 = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);

      // Step 6: The previously-cached work item should still be accessible
      const retrieved = db2.get(itemId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.title).toBe('Cached item');
      expect(retrieved!.description).toBe('Should survive corruption');

      db2.close();
    });



    it('should not emit debug log when WL_DEBUG is not set and JSONL is corrupted', () => {
      db.create({ title: 'Silent fallback item' });
      db.close();

      // Corrupt the JSONL
      fs.writeFileSync(jsonlPath, '<<<INVALID>>>\n');
      const futureTime = new Date(Date.now() + 60_000);
      fs.utimesSync(jsonlPath, futureTime, futureTime);

      // Capture stderr
      const stderrChunks: Buffer[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: any, ...args: any[]) => {
        stderrChunks.push(Buffer.from(chunk));
        return true;
      }) as any;

      const originalDebug = process.env.WL_DEBUG;
      delete process.env.WL_DEBUG;

      try {
        const db2 = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
        db2.close();

        const stderrOutput = Buffer.concat(stderrChunks).toString();
        expect(stderrOutput).not.toContain('[wl:db] JSONL parse failed');
      } finally {
        process.stderr.write = originalWrite;
        if (originalDebug !== undefined) {
          process.env.WL_DEBUG = originalDebug;
        }
      }
    });
  });

  describe('reSort', () => {
    it('should re-sort active items by score and reassign sortIndex', () => {
      // Create items with sortIndex order that contradicts priority order
      // High priority item has a high sortIndex (should be last by position)
      db.create({ title: 'Low priority', priority: 'low', sortIndex: 100 });
      const high = db.create({ title: 'High priority', priority: 'high', sortIndex: 500 });

      const result = db.reSort();

      expect(result.updated).toBeGreaterThan(0);
      // After re-sort, high priority should have a lower sortIndex
      const updatedHigh = db.get(high.id)!;
      expect(updatedHigh.sortIndex).toBeLessThan(500);
    });

    it('should not re-sort completed or deleted items', () => {
      const active = db.create({ title: 'Active', sortIndex: 200 });
      const completed = db.create({ title: 'Completed', status: 'completed', sortIndex: 100 });
      const toDelete = db.create({ title: 'Deleted', sortIndex: 50 });
      db.delete(toDelete.id);

      db.reSort();

      // Completed item should not have its sortIndex changed
      const updatedCompleted = db.get(completed.id)!;
      expect(updatedCompleted.sortIndex).toBe(100);
    });

    it('should accept a recency policy parameter', () => {
      db.create({ title: 'Task A', priority: 'medium', sortIndex: 200 });
      db.create({ title: 'Task B', priority: 'medium', sortIndex: 100 });

      // Should not throw with any valid policy
      expect(() => db.reSort('prefer')).not.toThrow();
      expect(() => db.reSort('avoid')).not.toThrow();
      expect(() => db.reSort('ignore')).not.toThrow();
    });

    it('should accept a custom gap parameter', () => {
      db.create({ title: 'Task A', priority: 'high', sortIndex: 500 });
      db.create({ title: 'Task B', priority: 'low', sortIndex: 100 });

      db.reSort('ignore', 50);

      // With gap=50, sortIndex values should be 50, 100
      const items = db.getAll().filter(i => i.status !== 'completed' && i.status !== 'deleted');
      const sortValues = items.map(i => i.sortIndex).sort((a, b) => a - b);
      expect(sortValues).toEqual([50, 100]);
    });

    it('should cause findNextWorkItem to select high priority item despite stale sortIndex', () => {
      // Simulate the TableauCardEngine scenario:
      // A high-priority item has a high sortIndex (buried), a medium-priority item has a low sortIndex (at top)
      db.create({ title: 'Medium task', priority: 'medium', sortIndex: 100 });
      const high = db.create({ title: 'High priority task', priority: 'high', sortIndex: 5000 });

      // Without re-sort, medium task would be selected (lower sortIndex)
      // After re-sort, high priority task should be selected
      db.reSort();
      const result = db.findNextWorkItem();

      expect(result.workItem?.id).toBe(high.id);
    });

    it('should preserve stale sortIndex order when reSort is NOT called (--no-re-sort behavior)', () => {
      // Create items where sortIndex contradicts priority:
      // Medium priority has low sortIndex (top position), high priority has high sortIndex (buried)
      const medium = db.create({ title: 'Medium task', priority: 'medium', sortIndex: 100 });
      db.create({ title: 'High priority task', priority: 'high', sortIndex: 5000 });

      // Without calling reSort(), findNextWorkItem should use the stale sortIndex order.
      // The medium-priority item has sortIndex=100 which is lower than 5000,
      // so it should be selected first (sortIndex ascending = higher priority position).
      const result = db.findNextWorkItem();

      expect(result.workItem?.id).toBe(medium.id);
    });

    it('should change ordering based on recency policy (prefer vs avoid)', () => {
      // Create two items with the same priority so recency is the tie-breaker
      const itemA = db.create({ title: 'Task A - recently updated', priority: 'medium', sortIndex: 200 });
      const itemB = db.create({ title: 'Task B - old update', priority: 'medium', sortIndex: 100 });

      const store = (db as any).store;
      const now = new Date();
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

      // Manipulate the activity stamp directly via the store (the recency
      // policy keys on activityAt, which includes comment activity;
      // WL-0MUBVH6JM0093KVM):
      // Task A: active just now (very recent — within both 48h prefer and 72h avoid windows)
      // Task B: active 5 days ago (stale — beyond both windows, so no recency effect)
      store.saveWorkItem({ ...db.get(itemA.id)!, updatedAt: now.toISOString(), activityAt: now.toISOString() });
      store.saveWorkItem({ ...db.get(itemB.id)!, updatedAt: fiveDaysAgo.toISOString(), activityAt: fiveDaysAgo.toISOString() });

      // With 'prefer' policy: recently-updated Task A gets a recency BOOST,
      // so it should have a better (lower) sortIndex after re-sort
      db.reSort('prefer');
      const afterPreferA = db.get(itemA.id)!;
      const afterPreferB = db.get(itemB.id)!;
      expect(afterPreferA.sortIndex).toBeLessThan(afterPreferB.sortIndex);

      // Re-apply the activity-stamp manipulation before the second policy run.
      store.saveWorkItem({ ...db.get(itemA.id)!, updatedAt: now.toISOString(), activityAt: now.toISOString() });
      store.saveWorkItem({ ...db.get(itemB.id)!, updatedAt: fiveDaysAgo.toISOString(), activityAt: fiveDaysAgo.toISOString() });

      // With 'avoid' policy: recently-updated Task A gets a recency PENALTY,
      // so it should have a worse (higher) sortIndex after re-sort
      db.reSort('avoid');
      const afterAvoidA = db.get(itemA.id)!;
      const afterAvoidB = db.get(itemB.id)!;
      expect(afterAvoidA.sortIndex).toBeGreaterThan(afterAvoidB.sortIndex);
    });
  });

  describe('in-progress boost in computeScore / reSort', () => {
    it('should boost an in-progress item above a same-priority open item', () => {
      const open = db.create({ title: 'Open item', priority: 'medium' });
      const inProgress = db.create({ title: 'In-progress item', priority: 'medium', status: 'in-progress' });

      db.reSort();

      const updatedOpen = db.get(open.id)!;
      const updatedInProgress = db.get(inProgress.id)!;
      // In-progress item should sort first (lower sortIndex = higher rank)
      expect(updatedInProgress.sortIndex).toBeLessThan(updatedOpen.sortIndex);
    });

    it('should boost an ancestor of an in-progress item above a same-priority open item', () => {
      const parent = db.create({ title: 'Parent epic', priority: 'medium' });
      const child = db.create({ title: 'In-progress child', priority: 'medium', status: 'in-progress', parentId: parent.id });
      const unrelated = db.create({ title: 'Unrelated open item', priority: 'medium' });

      // Suppress unused-variable lint warning
      void child;

      db.reSort();

      const updatedParent = db.get(parent.id)!;
      const updatedUnrelated = db.get(unrelated.id)!;
      // Parent with in-progress child should sort above the unrelated open item
      expect(updatedParent.sortIndex).toBeLessThan(updatedUnrelated.sortIndex);
    });

    it('should apply only the in-progress boost (not ancestor boost) when item is itself in-progress', async () => {
      // Strategy: create a high-priority open item and then (after a small delay
      // to guarantee a later createdAt) a medium-priority in-progress parent
      // with an in-progress child.
      //
      // Score maths (freshly created, no deps/effort, negligible age):
      //   high open base   = 3 * 1000 = 3000
      //   medium IP parent = 2 * 1000 = 2000
      //     correct  (1.5x only):     2000 * 1.5   = 3000  → tie, high wins on createdAt (older)
      //     incorrect (1.5x * 1.25x): 2000 * 1.875 = 3750  → parent wins, test fails
      //
      // The delay ensures createdAt differs so the tie-breaker is deterministic.
      const highOpen = db.create({ title: 'High open item', priority: 'high' });
      await new Promise(resolve => setTimeout(resolve, 10));
      const parent = db.create({ title: 'In-progress parent', priority: 'medium', status: 'in-progress' });
      const child = db.create({ title: 'In-progress child', priority: 'medium', status: 'in-progress', parentId: parent.id });

      void child;

      db.reSort();

      const updatedHighOpen = db.get(highOpen.id)!;
      const updatedParent = db.get(parent.id)!;
      // With correct non-stacking 1.5x: scores tie at ~3000, high item wins on createdAt (older).
      // With incorrect stacking 1.875x: parent would score ~3750 and sort first — test fails.
      expect(updatedHighOpen.sortIndex).toBeLessThan(updatedParent.sortIndex);
    });

    it('should not boost a blocked item even if it is an ancestor of an in-progress item', () => {
      const blockedParent = db.create({ title: 'Blocked parent', priority: 'medium', status: 'blocked' });
      db.create({ title: 'In-progress child', priority: 'medium', status: 'in-progress', parentId: blockedParent.id });
      const open = db.create({ title: 'Open item', priority: 'medium' });

      db.reSort();

      const updatedBlockedParent = db.get(blockedParent.id)!;
      const updatedOpen = db.get(open.id)!;
      // Blocked parent should still sort below the open item due to -10000 penalty
      expect(updatedBlockedParent.sortIndex).toBeGreaterThan(updatedOpen.sortIndex);
    });

    it('should not modify the stored priority field when applying in-progress boost', () => {
      const item = db.create({ title: 'In-progress item', priority: 'medium', status: 'in-progress' });

      db.reSort();

      const updated = db.get(item.id)!;
      expect(updated.priority).toBe('medium');
    });

    it('should still boost ancestor when multiple in-progress children exist at different depths', () => {
      const grandparent = db.create({ title: 'Grandparent', priority: 'medium' });
      const parent = db.create({ title: 'Parent', priority: 'medium', parentId: grandparent.id });
      db.create({ title: 'In-progress grandchild', priority: 'medium', status: 'in-progress', parentId: parent.id });
      const unrelated = db.create({ title: 'Unrelated open item', priority: 'medium' });

      db.reSort();

      const updatedGrandparent = db.get(grandparent.id)!;
      const updatedUnrelated = db.get(unrelated.id)!;
      // Grandparent should be boosted because it is an ancestor of an in-progress item
      expect(updatedGrandparent.sortIndex).toBeLessThan(updatedUnrelated.sortIndex);
    });

    it('should boost all ancestors when in-progress items exist at multiple depths', () => {
      // Two in-progress items in the same lineage: child and grandchild.
      // Both the parent and grandparent should receive the 1.25x ancestor boost,
      // and the de-duplication in the ancestor set should not cause any issues.
      const grandparent = db.create({ title: 'Grandparent', priority: 'medium' });
      const parent = db.create({ title: 'In-progress parent', priority: 'medium', status: 'in-progress', parentId: grandparent.id });
      db.create({ title: 'In-progress grandchild', priority: 'medium', status: 'in-progress', parentId: parent.id });
      const unrelatedOpen = db.create({ title: 'Unrelated open item', priority: 'medium' });

      db.reSort();

      const updatedGrandparent = db.get(grandparent.id)!;
      const updatedParent = db.get(parent.id)!;
      const updatedUnrelated = db.get(unrelatedOpen.id)!;
      // Grandparent gets 1.25x ancestor boost → sorts above unrelated open
      expect(updatedGrandparent.sortIndex).toBeLessThan(updatedUnrelated.sortIndex);
      // Parent is itself in-progress → gets the 1.5x boost (not stacked with ancestor 1.25x)
      expect(updatedParent.sortIndex).toBeLessThan(updatedGrandparent.sortIndex);
    });

    it('should not boost ancestor when in-progress child is completed', () => {
      // Create unrelated FIRST so that age tie-break favours it (older = sorts first).
      // If the ancestor boost were incorrectly still applied after the child is completed,
      // the parent would sort above unrelated despite being younger.
      const unrelated = db.create({ title: 'Unrelated open item', priority: 'medium' });
      const parent = db.create({ title: 'Parent', priority: 'medium' });
      const child = db.create({ title: 'Child', priority: 'medium', status: 'in-progress', parentId: parent.id });

      // Close the in-progress child — parent should lose its ancestor boost
      db.update(child.id, { status: 'completed' });

      db.reSort();

      const updatedParent = db.get(parent.id)!;
      const updatedUnrelated = db.get(unrelated.id)!;
      // Parent no longer has any in-progress descendants; no ancestor boost.
      // With equal priority and no boost, createdAt is the tie-breaker:
      // unrelated was created first so it sorts first (lower sortIndex).
      expect(updatedUnrelated.sortIndex).toBeLessThan(updatedParent.sortIndex);
    });
  });

  describe('exportForSync', () => {
    it('exports asynchronously and returns the JSONL path', async () => {
      db.create({ title: 'Async export item' });

      const exportedPath = await db.exportForSync();

      expect(exportedPath).toBe(jsonlPath);
      expect(fs.existsSync(jsonlPath)).toBe(true);

      const content = fs.readFileSync(jsonlPath, 'utf-8').trim();
      expect(content.length).toBeGreaterThan(0);
      const lines = content.split('\n');
      expect(lines.length).toBeGreaterThan(0);
    });
  });

  // ── Caching (Phase 5) ─────────────────────────────────────────────

  describe('caching', () => {
    it('getAll returns cached results and invalidates on write', () => {
      expect(db.getAll()).toEqual([]);

      const item = db.create({ title: 'Cache test item' });

      const all = db.getAll();
      expect(all.length).toBe(1);
      expect(all[0].id).toBe(item.id);

      db.create({ title: 'Second item' });
      expect(db.getAll().length).toBe(2);
    });

    it('get returns correct item after create and update', () => {
      const item = db.create({ title: 'Get cache test' });

      expect(db.get(item.id)?.title).toBe('Get cache test');

      db.update(item.id, { title: 'Updated title' });

      expect(db.get(item.id)?.title).toBe('Updated title');
    });

    it('get returns deleted item status after delete', () => {
      const item = db.create({ title: 'Delete from cache' });

      expect(db.get(item.id)).not.toBeNull();

      db.delete(item.id);

      const deletedItem = db.get(item.id);
      expect(deletedItem).not.toBeNull();
      expect(deletedItem?.status).toBe('deleted');
    });

    it('comment creation invalidates comment caches', () => {
      const item = db.create({ title: 'Comment cache test' });

      expect(db.getCommentsForWorkItem(item.id)).toEqual([]);

      db.createComment({
        workItemId: item.id,
        author: 'tester',
        comment: 'A test comment',
      });

      const comments = db.getCommentsForWorkItem(item.id);
      expect(comments.length).toBe(1);
      expect(comments[0].comment).toBe('A test comment');
    });

    it('dependency edge creation invalidates edge caches', () => {
      const item1 = db.create({ title: 'Dep source' });
      const item2 = db.create({ title: 'Dep target' });

      expect(db.listDependencyEdgesFrom(item1.id)).toEqual([]);
      expect(db.listDependencyEdgesTo(item2.id)).toEqual([]);

      db.addDependencyEdge(item1.id, item2.id);

      expect(db.listDependencyEdgesFrom(item1.id).length).toBe(1);
      expect(db.listDependencyEdgesTo(item2.id).length).toBe(1);
    });

    it('getChildCounts is correct after adding children', () => {
      const parent = db.create({ title: 'Parent' });

      const counts1 = db.getChildCounts();
      expect(counts1.get(parent.id)).toBeUndefined();

      db.create({ title: 'Child', parentId: parent.id });

      const counts2 = db.getChildCounts();
      expect(counts2.get(parent.id)).toBe(1);
    });
  });

  describe('audit-not-ready boost (WL-0MTH7G2O1004BHN5)', () => {
    it('reSort: low + fresh audited-not-ready outranks high unaudited', async () => {
      const high = db.create({ title: 'High unaudited', priority: 'high', sortIndex: 100 });
      await new Promise(resolve => setTimeout(resolve, 10));
      const low = db.create({ title: 'Low audited not-ready', priority: 'low', sortIndex: 200 });

      db.saveAuditResult({
        workItemId: low.id,
        readyToClose: false,
        auditedAt: new Date().toISOString(),
        summary: null,
        rawOutput: null,
        author: null,
      });

      db.reSort();

      const updatedHigh = db.get(high.id)!;
      const updatedLow = db.get(low.id)!;
      expect(updatedLow.sortIndex).toBeLessThan(updatedHigh.sortIndex);
    });

    it('reSort: low + fresh audited-not-ready outranks medium unaudited; within-tier tie-break is oldest-first then id', async () => {
      const medium = db.create({ title: 'Medium unaudited', priority: 'medium', sortIndex: 100 });
      await new Promise(resolve => setTimeout(resolve, 10));
      const low1 = db.create({ title: 'Low audited not-ready A', priority: 'low', sortIndex: 200 });
      await new Promise(resolve => setTimeout(resolve, 10));
      const low2 = db.create({ title: 'Low audited not-ready B', priority: 'low', sortIndex: 300 });

      const nowIso = new Date().toISOString();
      for (const item of [low1, low2]) {
        db.saveAuditResult({
          workItemId: item.id,
          readyToClose: false,
          auditedAt: nowIso,
          summary: null,
          rawOutput: null,
          author: null,
        });
      }

      db.reSort();

      expect(db.get(low1.id)!.sortIndex).toBeLessThan(db.get(medium.id)!.sortIndex);
      expect(db.get(low1.id)!.sortIndex).toBeLessThan(db.get(low2.id)!.sortIndex);
    });

    it('reSort: critical unaudited outranks non-critical audited-not-ready', async () => {
      const critical = db.create({ title: 'Critical unaudited', priority: 'critical', sortIndex: 500 });
      await new Promise(resolve => setTimeout(resolve, 10));
      const lowAudited = db.create({ title: 'Low audited not-ready', priority: 'low', sortIndex: 100 });

      db.saveAuditResult({
        workItemId: lowAudited.id,
        readyToClose: false,
        auditedAt: new Date().toISOString(),
        summary: null,
        rawOutput: null,
        author: null,
      });

      db.reSort();

      expect(db.get(critical.id)!.sortIndex).toBeLessThan(db.get(lowAudited.id)!.sortIndex);
    });

    it('reSort: ready_to_close=true, missing audit, and stale audit receive no boost', async () => {
      const base = db.create({ title: 'Medium base unaudited', priority: 'medium', sortIndex: 100 });
      await new Promise(resolve => setTimeout(resolve, 10));
      const ready = db.create({ title: 'Low ready-to-close', priority: 'low', sortIndex: 200 });
      await new Promise(resolve => setTimeout(resolve, 10));
      const missing = db.create({ title: 'Low missing audit', priority: 'low', sortIndex: 300 });
      await new Promise(resolve => setTimeout(resolve, 10));
      const stale = db.create({ title: 'Low stale audited-not-ready', priority: 'low', sortIndex: 400 });

      db.saveAuditResult({
        workItemId: ready.id,
        readyToClose: true,
        auditedAt: new Date().toISOString(),
        summary: null,
        rawOutput: null,
        author: null,
      });
      // missing stays with no audit row.
      void base;
      void missing;

      // Make the audit stale: save with auditedAt now, then advance updatedAt 61 s
      // into the future (saveAuditResult sets updatedAt=auditedAt, so the
      // advance must happen *after* the save to achieve staleness).
      const staleAuditedAt = new Date().toISOString();
      db.saveAuditResult({
        workItemId: stale.id,
        readyToClose: false,
        auditedAt: staleAuditedAt,
        summary: null,
        rawOutput: null,
        author: null,
      });
      const futureUpdatedAt = new Date(new Date(staleAuditedAt).getTime() + 61_000).toISOString();
      // Bump updatedAt via a title save so the stale audit is detectable.
      const bumpRes = db.update(stale.id, { title: db.get(stale.id)!.title });
      void bumpRes;
      // Force updatedAt to the deterministic future value.
      try {
        const ps: any = db.store;
        ps.db.prepare('UPDATE workitems SET updatedAt = ? WHERE id = ?').run(futureUpdatedAt, stale.id);
        ps.invalidateWorkItemCaches();
        ps.cacheInvalidate(`workitem_${stale.id}`);
      } catch (e) { /* best-effort */ }
      const after = db.get(stale.id)!;
      expect(new Date(db.getAuditResult(stale.id)!.auditedAt).getTime()).toBeLessThan(
        new Date(after.updatedAt).getTime(),
      );

      db.reSort();

      expect(db.get(ready.id)!.sortIndex).toBeGreaterThan(db.get(base.id)!.sortIndex);
      expect(db.get(missing.id)!.sortIndex).toBeGreaterThan(db.get(base.id)!.sortIndex);
      expect(db.get(stale.id)!.sortIndex).toBeGreaterThan(db.get(base.id)!.sortIndex);
    });

    it('selectBySortIndex fallback (all sortIndex equal): audit-not-ready outranks unaudited before effective-priority/age', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      const lowAudited = db.create({ title: 'Low audited not-ready', priority: 'low', sortIndex: 0 });
      await new Promise(resolve => setTimeout(resolve, 10));
      const mediumUnaudited = db.create({ title: 'Medium unaudited', priority: 'medium', sortIndex: 0 });
      // Ensure both items share sortIndex 0 so the all-equal fallback path is taken.
      expect(db.get(lowAudited.id)!.sortIndex).toBe(0);
      expect(db.get(mediumUnaudited.id)!.sortIndex).toBe(0);

      db.saveAuditResult({
        workItemId: lowAudited.id,
        readyToClose: false,
        auditedAt: new Date().toISOString(),
        summary: null,
        rawOutput: null,
        author: null,
      });

      // Without reSort (which would diverge sortIndex), request findNextWorkItem with
      // the equal-sortIndex tie-break — it should pick the audited item first.
      const first = db.findNextWorkItem();
      expect(first.workItem?.id).toBe(lowAudited.id);

      const batch = db.findNextWorkItems(2);
      expect(batch[0].workItem?.id).toBe(lowAudited.id);
      expect(batch[1].workItem?.id).toBe(mediumUnaudited.id);
    });

    it('selectBySortIndex fallback with all sortIndex equal still lets critical outrank audited non-critical', () => {
      const critical = db.create({ title: 'Critical unaudited', priority: 'critical', sortIndex: 0 });
      const lowAudited = db.create({ title: 'Low audited not-ready', priority: 'low', sortIndex: 0 });

      db.saveAuditResult({
        workItemId: lowAudited.id,
        readyToClose: false,
        auditedAt: new Date().toISOString(),
        summary: null,
        rawOutput: null,
        author: null,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(critical.id);
    });

    it('wl next --no-re-sort with divergent sortIndex still reflects audit tier: low audited-not-ready outranks medium unaudited despite stale higher sortIndex', () => {
      // Stale sortIndex scenario that previously defeated AC3: without the
      // selectBySortIndex tier prefix, sortIndex order is respected verbatim
      // and audit freshness is ignored. The fix must make audit tier win
      // even when sortIndex diverges (WL-0MTH7G2O1004BHN5 / audit AC3).
      const mediumUnaudited = db.create({ title: 'Medium unaudited', priority: 'medium', sortIndex: 100 });
      const lowAudited = db.create({ title: 'Low audited not-ready stale sortIndex 5000', priority: 'low', sortIndex: 5000 });

      db.saveAuditResult({
        workItemId: lowAudited.id,
        readyToClose: false,
        auditedAt: new Date().toISOString(),
        summary: null,
        rawOutput: null,
        author: null,
      });

      // No reSort — stale indices diverge. selectBySortIndex divergent path
      // (audit tier prefix before sortIndex) must still pick the audited item.
      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(lowAudited.id);
      // Batch should also preserve boosted order without a reSort.
      const batch = db.findNextWorkItems(2);
      expect(batch[0].workItem?.id).toBe(lowAudited.id);
      expect(batch[1].workItem?.id).toBe(mediumUnaudited.id);
    });

    it('wl next --no-re-sort with divergent sortIndex keeps critical ahead of audited non-critical', () => {
      // Mirrors the stale-index case but ensures critical is still hard-top-tier
      // when the divergent path is taken (critical boundary in divergent branch).
      const lowAudited = db.create({ title: 'Low audited not-ready stale sortIndex 100', priority: 'low', sortIndex: 100 });
      const critical = db.create({ title: 'Critical unaudited stale sortIndex 5000', priority: 'critical', sortIndex: 5000 });

      db.saveAuditResult({
        workItemId: lowAudited.id,
        readyToClose: false,
        auditedAt: new Date().toISOString(),
        summary: null,
        rawOutput: null,
        author: null,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(critical.id);
    });
  });

  describe('audit-freshness agreement with the shared predicate (WL-0MUBVH7ZR009PP80)', () => {
    const saveNotReadyAudit = (workItemId: string, auditedAt: string): void => {
      db.saveAuditResult({
        workItemId,
        readyToClose: false,
        auditedAt,
        summary: null,
        rawOutput: null,
        author: null,
      });
    };

    // saveAuditResult sets updatedAt = auditedAt atomically, so a content
    // write after the save moves updatedAt away from the audit within the
    // ordering tier. That is how the within/beyond-tolerance cases are built
    // deterministically (30 s inside the 60 s band, 120 s outside).
    const auditThenContentWrite = (id: string, ageMs: number): void => {
      saveNotReadyAudit(id, new Date(Date.now() - ageMs).toISOString());
      db.update(id, { description: `content tweak at ${Date.now()}` });
    };

    // Force updatedAt to a deterministic value (the audit's own persistence
    // sets updatedAt = auditedAt atomically, so a clearly-newer audit can only
    // be constructed by rewinding updatedAt).
    const setUpdatedAt = (id: string, iso: string): void => {
      const ps: any = db.store;
      ps.db.prepare('UPDATE workitems SET updatedAt = ? WHERE id = ?').run(iso, id);
      ps.invalidateWorkItemCaches();
      ps.cacheInvalidate(`workitem_${id}`);
    };

    it('reSort: a clearly-newer audit (auditedAt > updatedAt) is boosted, agreeing with isAuditFresh', async () => {
      // Regression guard for the symmetric-gate mistake (WL-0MUBVH7ZR009PP80):
      // an audit that postdates the item's last content change covers it and
      // must be treated as fresh, not stale.
      const medium = db.create({ title: 'Medium unaudited', priority: 'medium', sortIndex: 100 });
      const low = db.create({ title: 'Low audit later than update', priority: 'low', sortIndex: 200 });

      saveNotReadyAudit(low.id, new Date().toISOString());
      setUpdatedAt(low.id, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
      expect(isAuditFresh(db.getAuditResult(low.id)!.auditedAt, db.get(low.id)!.updatedAt)).toBe(true);

      db.reSort();
      expect(db.get(low.id)!.sortIndex).toBeLessThan(db.get(medium.id)!.sortIndex);
    });

    it('reSort: a within-tolerance audited-not-ready item is boosted, agreeing with isAuditFresh', async () => {
      const medium = db.create({ title: 'Medium unaudited', priority: 'medium', sortIndex: 100 });
      const low = db.create({ title: 'Low audited 30 s ago', priority: 'low', sortIndex: 200 });

      auditThenContentWrite(low.id, 30_000);
      expect(isAuditFresh(db.getAuditResult(low.id)!.auditedAt, db.get(low.id)!.updatedAt)).toBe(true);

      db.reSort();
      expect(db.get(low.id)!.sortIndex).toBeLessThan(db.get(medium.id)!.sortIndex);
    });

    it('reSort: a stale audited-not-ready item is not boosted, agreeing with isAuditFresh', async () => {
      const medium = db.create({ title: 'Medium baseline', priority: 'medium', sortIndex: 100 });
      const low = db.create({ title: 'Low audited 120 s ago', priority: 'low', sortIndex: 200 });

      auditThenContentWrite(low.id, 120_000);
      expect(isAuditFresh(db.getAuditResult(low.id)!.auditedAt, db.get(low.id)!.updatedAt)).toBe(false);

      db.reSort();
      expect(db.get(medium.id)!.sortIndex).toBeLessThan(db.get(low.id)!.sortIndex);
    });

    it('selectBySortIndex fallback: a within-tolerance audited-not-ready item outranks unaudited, agreeing with isAuditFresh', async () => {
      const low = db.create({ title: 'Low audited fresh', priority: 'low', sortIndex: 0 });
      const medium = db.create({ title: 'Medium unaudited', priority: 'medium', sortIndex: 0 });

      auditThenContentWrite(low.id, 30_000);
      expect(isAuditFresh(db.getAuditResult(low.id)!.auditedAt, db.get(low.id)!.updatedAt)).toBe(true);
      // All sortIndex values still coincide, so the all-equal fallback path runs.
      expect(db.get(low.id)!.sortIndex).toBe(0);
      expect(db.get(medium.id)!.sortIndex).toBe(0);

      expect(db.findNextWorkItem().workItem?.id).toBe(low.id);
    });

    it('a missing audit receives no boost, agreeing with isAuditFresh', async () => {
      const medium = db.create({ title: 'Medium baseline', priority: 'medium', sortIndex: 100 });
      const low = db.create({ title: 'Low no audit', priority: 'low', sortIndex: 200 });

      expect(isAuditFresh(null, db.get(low.id)!.updatedAt)).toBe(false);

      db.reSort();
      expect(db.get(medium.id)!.sortIndex).toBeLessThan(db.get(low.id)!.sortIndex);
    });

    it('AC7: critical still outranks a within-tolerance audited-not-ready non-critical item', async () => {
      const critical = db.create({ title: 'Critical unaudited', priority: 'critical', sortIndex: 0 });
      const low = db.create({ title: 'Low audited fresh', priority: 'low', sortIndex: 0 });

      auditThenContentWrite(low.id, 30_000);
      expect(isAuditFresh(db.getAuditResult(low.id)!.auditedAt, db.get(low.id)!.updatedAt)).toBe(true);

      expect(db.findNextWorkItem().workItem?.id).toBe(critical.id);
    });
  });

});
