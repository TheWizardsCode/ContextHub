/**
 * wl next regression tests — critical escalation and priority inheritance.
 *
 * Critical-priority escalation and blocker/subtree priority inheritance.
 *
 * Split mechanically from `tests/next-regression.test.ts`
 * (WL-0MVOBP8MC0093Y7T, lockstep with the `database.ts` decomposition: a test
 * file over 1,000 lines is split along describe boundaries). Describe titles,
 * assertions and fixtures are unchanged; only the file boundary (and the
 * duplicated preamble) changed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WorklogDatabase } from '../src/database.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonlPath,
  createTempDbPath,
  wait,
} from './test-utils.js';

describe('wl next regression tests (WL-0MM2FKKOW1H0C0G4)', () => {
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
  // ─────────────────────────────────────────────────────────────────────
  // Critical Escalation (WL-0MM346MLV0THH548)
  // handleCriticalEscalation() operates on the full item set.
  // Unblocked criticals win over all non-criticals; blocked criticals
  // surface their direct blocker (child or dependency edge).
  // ─────────────────────────────────────────────────────────────────────
  describe('critical escalation (WL-0MM346MLV0THH548)', () => {
    it('should hide child blocker of critical item assigned to a different user (WL-0MS964SIA0057ABR)', async () => {
      // Critical item assigned to Bob is blocked by a task assigned to Alice.
      // Strict root-only: the child blocker is hidden entirely (no orphan
      // promotion). Alice's own root work (high priority) is surfaced instead.
      const critical = db.create({
        title: 'Critical Bob item',
        priority: 'critical',
        status: 'blocked',
        assignee: 'bob',
      });
      db.create({
        title: 'Alice blocker',
        priority: 'medium',
        status: 'open',
        assignee: 'alice',
        parentId: critical.id,
      });
      await wait(10);
      const aliceTask = db.create({
        title: 'Alice normal task',
        priority: 'high',
        status: 'open',
        assignee: 'alice',
      });

      const result = db.findNextWorkItem('alice');
      expect(result.workItem).not.toBeNull();
      // The child blocker is hidden; alice's root-level task is the unit of work.
      expect(result.workItem!.id).toBe(aliceTask.id);
      expect(result.workItem!.parentId).toBeNull();
    });

    it('should surface dep-edge blocker of critical item from full set', async () => {
      // Critical item has a dependency-edge blocker. The blocker is not
      // assigned to anyone, but should still be surfaced.
      const critical = db.create({
        title: 'Critical with dep',
        priority: 'critical',
        status: 'blocked',
        assignee: 'bob',
      });
      const blocker = db.create({
        title: 'Dependency blocker',
        priority: 'medium',
        status: 'open',
      });
      db.addDependencyEdge(critical.id, blocker.id);
      await wait(10);
      db.create({
        title: 'Other task',
        priority: 'high',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(blocker.id);
      expect(result.reason).toContain('critical');
    });

    it('should prefer unblocked critical over non-critical items regardless of sortIndex', async () => {
      // Even if a non-critical has a better sortIndex, the unblocked critical wins.
      db.create({
        title: 'Non-critical first',
        priority: 'high',
        status: 'open',
        sortIndex: 1,
      });
      await wait(10);
      const critical = db.create({
        title: 'Critical item',
        priority: 'critical',
        status: 'open',
        sortIndex: 999,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(critical.id);
      expect(result.reason).toContain('critical');
    });

    it('should select among multiple unblocked criticals by sortIndex', () => {
      db.create({
        title: 'Critical A',
        priority: 'critical',
        status: 'open',
        sortIndex: 300,
      });
      const criticalB = db.create({
        title: 'Critical B',
        priority: 'critical',
        status: 'open',
        sortIndex: 100,
      });
      db.create({
        title: 'Critical C',
        priority: 'critical',
        status: 'open',
        sortIndex: 200,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(criticalB.id);
    });

    it('should fall back to priority+age when all criticals have same sortIndex', async () => {
      const criticalOld = db.create({
        title: 'Critical old',
        priority: 'critical',
        status: 'open',
        sortIndex: 0,
      });
      await wait(10);
      db.create({
        title: 'Critical new',
        priority: 'critical',
        status: 'open',
        sortIndex: 0,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Same priority, same sortIndex — oldest wins
      expect(result.workItem!.id).toBe(criticalOld.id);
    });

    it('should return blocked critical as last resort when no blockers found', () => {
      // A blocked critical with no children and no dep edges
      const critical = db.create({
        title: 'Stuck critical',
        priority: 'critical',
        status: 'blocked',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(critical.id);
      expect(result.reason).toContain('no identifiable blocking issues');
    });

    it('should surface blocked+in_review critical when it has no blockers', () => {
      const critical = db.create({
        title: 'In review critical',
        priority: 'critical',
        status: 'blocked',
        stage: 'in_review',
      });
      db.create({
        title: 'Open low',
        priority: 'low',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      // Blocked+in_review critical passes through the filter pipeline.
      // Since it's critical and has no blockers, the critical escalation
      // path selects it.
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(critical.id);
    });

    it('should surface completed+in_review critical by default', () => {
      const critical = db.create({
        title: 'In review critical',
        priority: 'critical',
        status: 'completed',
        stage: 'in_review',
      });
      db.create({
        title: 'Open low',
        priority: 'low',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Critical priority (4000) + in_review boost (600) > low priority (1000)
      expect(result.workItem!.id).toBe(critical.id);
    });

    it('should hide child blocker from outside search filter for critical item (WL-0MS964SIA0057ABR)', async () => {
      // Critical item mentions "infra" in its title but its blocker mentions "auth".
      // Strict root-only: the child blocker is hidden entirely. Searching for
      // "auth" surfaces alice's/any root-level auth work instead.
      const critical = db.create({
        title: 'Critical infra issue',
        priority: 'critical',
        status: 'blocked',
      });
      db.create({
        title: 'Auth service fix',
        priority: 'medium',
        status: 'open',
        parentId: critical.id,
      });
      await wait(10);
      const authDocs = db.create({
        title: 'Auth docs update',
        priority: 'low',
        status: 'open',
      });

      const result = db.findNextWorkItem(undefined, 'auth');
      expect(result.workItem).not.toBeNull();
      // The child blocker is hidden; the root-level auth item is surfaced.
      expect(result.workItem!.id).toBe(authDocs.id);
      expect(result.workItem!.parentId).toBeNull();
    });

    it('should handle critical with both child and dep-edge blockers', async () => {
      // Critical item has both a child and a dep-edge blocker.
      // Either blocker may be selected depending on hierarchy sort order;
      // the important thing is that one of them is surfaced.
      const critical = db.create({
        title: 'Critical with both',
        priority: 'critical',
        status: 'blocked',
      });
      const childBlocker = db.create({
        title: 'Child blocker',
        priority: 'medium',
        status: 'open',
        parentId: critical.id,
        sortIndex: 200,
      });
      const depBlocker = db.create({
        title: 'Dep blocker',
        priority: 'medium',
        status: 'open',
        sortIndex: 100,
      });
      db.addDependencyEdge(critical.id, depBlocker.id);

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Either blocker is acceptable; both unblock the critical
      const selectedId = result.workItem!.id;
      expect([childBlocker.id, depBlocker.id]).toContain(selectedId);
      expect(result.reason).toContain('critical');
    });

    it('should hide child blockers in batch mode (WL-0MS964SIA0057ABR)', async () => {
      const critical = db.create({
        title: 'Critical parent',
        priority: 'critical',
        status: 'blocked',
      });
      db.create({
        title: 'First child',
        priority: 'high',
        status: 'open',
        parentId: critical.id,
        sortIndex: 100,
      });
      await wait(10);
      db.create({
        title: 'Second child',
        priority: 'high',
        status: 'open',
        parentId: critical.id,
        sortIndex: 200,
      });

      const results = db.findNextWorkItems(2);
      // Strict root-only: the child blockers are hidden. The blocked critical
      // parent is surfaced via the last-resort escalation path; no child items
      // appear in any batch result.
      expect(results.length).toBeGreaterThan(0);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(ids[0]).toBe(critical.id);
      for (const r of results) {
        if (r.workItem) {
          expect(r.workItem.parentId).toBeNull();
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Blocker priority inheritance (WL-0MM346ZBD1YSKKSV)
  // When all sortIndex values are equal, selectBySortIndex falls back to
  // effective priority (max of own priority and priority inherited from
  // blocked dependents or parent items) then createdAt (oldest first).
  // ─────────────────────────────────────────────────────────────────────
  describe('blocker priority inheritance (WL-0MM346ZBD1YSKKSV)', () => {
    it('should elevate a low-priority item that blocks a critical item via dependency edge', async () => {
      // lowBlocker (low, open) blocks criticalItem (critical, blocked) via dep edge
      // mediumItem (medium, open) — would normally win by own priority
      // Expected: lowBlocker wins because it inherits critical effective priority
      const criticalItem = db.create({
        title: 'Critical blocked',
        priority: 'critical',
        status: 'blocked',
      });
      await wait(10);
      const lowBlocker = db.create({
        title: 'Low blocker',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(criticalItem.id, lowBlocker.id);
      await wait(10);
      const mediumItem = db.create({
        title: 'Medium standalone',
        priority: 'medium',
        status: 'open',
      });

      // Critical blocked items are handled by Stage 2 (critical escalation),
      // so the low blocker should be surfaced as a critical blocker.
      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(lowBlocker.id);
      expect(result.reason).toContain('Blocking issue');
    });

    it('should prefer higher effective priority over raw priority when sortIndex values are equal', async () => {
      // Two open items, same sortIndex (default 0):
      //   itemA (low, open) — blocks highBlocked (high, blocked) via dep edge
      //   itemB (medium, open) — standalone
      // itemA effective priority = high (inherited), itemB effective = medium (own)
      // Expected: itemA wins because its effective priority is higher
      //
      // Note: If the high blocked item triggers Stage 3 blocker surfacing,
      // itemA is surfaced as a blocker. Either way, itemA should be selected.
      const highBlocked = db.create({
        title: 'High blocked',
        priority: 'high',
        status: 'blocked',
      });
      await wait(10);
      const itemA = db.create({
        title: 'Low blocker of high',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(highBlocked.id, itemA.id);
      await wait(10);
      db.create({
        title: 'Medium standalone',
        priority: 'medium',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(itemA.id);
    });

    it('should return parent instead of descending into children', async () => {
      // parent (high, open), childA (low, open, child of parent), childB (low, open, child of parent)
      // Parent is returned directly without descending into children.
      const parent = db.create({
        title: 'High parent',
        priority: 'high',
        status: 'open',
      });
      await wait(10);
      const childA = db.create({
        title: 'Child A',
        priority: 'low',
        status: 'open',
        parentId: parent.id,
      });
      await wait(10);
      db.create({
        title: 'Child B',
        priority: 'low',
        status: 'open',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Parent is the only root candidate; returned directly (no descent)
      expect(result.workItem!.id).toBe(parent.id);
    });

    it('should not inherit priority from completed dependents', async () => {
      // completedItem (critical, completed) depends on itemA (low, open) via dep edge
      // itemB (medium, open) — standalone
      // itemA should NOT inherit from completed dependent → effective = low
      // Expected: itemB wins (medium > low)
      const completedItem = db.create({
        title: 'Completed critical',
        priority: 'critical',
        status: 'completed',
      });
      await wait(10);
      const itemA = db.create({
        title: 'Low item',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(completedItem.id, itemA.id);
      await wait(10);
      const itemB = db.create({
        title: 'Medium item',
        priority: 'medium',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(itemB.id);
    });

    it('should not inherit priority from deleted parent', async () => {
      // parent (critical, deleted) has childA (low, open)
      // itemB (medium, open)
      // childA should NOT inherit from deleted parent → effective = low
      // Expected: itemB wins (medium > low)
      db.create({
        title: 'Deleted critical parent',
        priority: 'critical',
        status: 'deleted',
      });
      // Create itemB first so it doesn't win by createdAt
      const itemB = db.create({
        title: 'Medium item',
        priority: 'medium',
        status: 'open',
      });
      await wait(10);
      // Note: parentId still references the deleted parent, but inheritance
      // should skip deleted parents.
      db.create({
        title: 'Child of deleted',
        priority: 'low',
        status: 'open',
        parentId: undefined, // Deleted parents' children are effectively orphans
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(itemB.id);
    });

    it('should take the maximum of own priority and inherited priority', async () => {
      // itemA (high, open) blocks mediumBlocked (medium, blocked) via dep edge
      // itemA own = high, inherited from dependent = medium → effective = high (own wins)
      // itemB (high, open)
      // Both have effective=high; itemA is older → itemA wins by createdAt
      const mediumBlocked = db.create({
        title: 'Medium blocked',
        priority: 'medium',
        status: 'blocked',
      });
      await wait(10);
      const itemA = db.create({
        title: 'High blocker',
        priority: 'high',
        status: 'open',
      });
      db.addDependencyEdge(mediumBlocked.id, itemA.id);
      await wait(10);
      db.create({
        title: 'High standalone',
        priority: 'high',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Both have effective=high; itemA wins by createdAt (older).
      // Note: mediumBlocked may trigger Stage 3 blocker surfacing if its
      // priority >= the best open competitor. Either way, itemA is selected.
      expect(result.workItem!.id).toBe(itemA.id);
    });

    it('should include effective priority info in reason string when priority is inherited', async () => {
      // parent (critical, open), child (low, open, child of parent)
      // No other candidates, so parent is returned. Reason should mention inheritance.
      const parent = db.create({
        title: 'Critical parent',
        priority: 'critical',
        status: 'open',
      });
      await wait(10);
      const child = db.create({
        title: 'Low child',
        priority: 'low',
        status: 'open',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Parent is the only root candidate; returned directly (no descent)
      expect(result.workItem!.id).toBe(parent.id);
      // Reason should mention the inherited priority (parent inherits from somewhere)
      // or at minimum contain 'priority'
      expect(result.reason).toContain('priority');
    });

    it('should show own priority in reason when no inheritance occurs', async () => {
      // Single high-priority item — no inheritance, reason should show own priority
      const item = db.create({
        title: 'High standalone',
        priority: 'high',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(item.id);
      expect(result.reason).toContain('priority high');
    });

    it('should inherit the highest priority among multiple dependents', async () => {
      // criticalDep (critical, blocked) depends on itemA via dep edge
      // highDep (high, blocked) depends on itemA via dep edge
      // itemA (low, open) — inherits critical (the highest)
      // itemB (high, open) — standalone
      // Expected: itemA wins via critical escalation (Stage 2) or effective priority
      const criticalDep = db.create({
        title: 'Critical dependent',
        priority: 'critical',
        status: 'blocked',
      });
      await wait(10);
      const highDep = db.create({
        title: 'High dependent',
        priority: 'high',
        status: 'blocked',
      });
      await wait(10);
      const itemA = db.create({
        title: 'Low multi-blocker',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(criticalDep.id, itemA.id);
      db.addDependencyEdge(highDep.id, itemA.id);
      await wait(10);
      db.create({
        title: 'High standalone',
        priority: 'high',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(itemA.id);
    });

    it('should use effective priority in batch mode across multiple selections', async () => {
      // itemA (low, open) blocks highBlocked (high, blocked) via dep edge → effective=high
      // itemB (medium, open) — standalone → effective=medium
      // itemC (low, open) — standalone → effective=low
      // Batch of 3: should order by effective priority
      const highBlocked = db.create({
        title: 'High blocked',
        priority: 'high',
        status: 'blocked',
      });
      await wait(10);
      const itemA = db.create({
        title: 'Low blocker',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(highBlocked.id, itemA.id);
      await wait(10);
      const itemB = db.create({
        title: 'Medium standalone',
        priority: 'medium',
        status: 'open',
      });
      await wait(10);
      const itemC = db.create({
        title: 'Low standalone',
        priority: 'low',
        status: 'open',
      });

      const results = db.findNextWorkItems(3);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      // itemA should be first (effective=high via blocker surfacing or effective priority)
      expect(ids[0]).toBe(itemA.id);
      // Remaining items should include both itemB and itemC
      expect(ids).toContain(itemB.id);
      expect(ids).toContain(itemC.id);
    });

    it('computeEffectivePriority returns correct result for item with no dependents', () => {
      const item = db.create({
        title: 'Standalone medium',
        priority: 'medium',
        status: 'open',
      });

      const result = db.computeEffectivePriority(item);
      expect(result.value).toBe(2); // medium = 2
      expect(result.reason).toContain('own priority: medium');
      expect(result.inheritedFrom).toBeUndefined();
    });

    it('computeEffectivePriority returns inherited priority from dependency edge', () => {
      const critical = db.create({
        title: 'Critical dependent',
        priority: 'critical',
        status: 'blocked',
      });
      const blocker = db.create({
        title: 'Low blocker',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(critical.id, blocker.id);

      const result = db.computeEffectivePriority(blocker);
      expect(result.value).toBe(4); // critical = 4
      expect(result.reason).toContain('inherited from');
      expect(result.reason).toContain(critical.id);
      expect(result.inheritedFrom).toBe(critical.id);
    });

    it('computeEffectivePriority returns inherited priority from parent', () => {
      const parent = db.create({
        title: 'High parent',
        priority: 'high',
        status: 'open',
      });
      const child = db.create({
        title: 'Low child',
        priority: 'low',
        status: 'open',
        parentId: parent.id,
      });

      const result = db.computeEffectivePriority(child);
      expect(result.value).toBe(3); // high = 3
      expect(result.reason).toContain('inherited from');
      expect(result.reason).toContain(parent.id);
      expect(result.inheritedFrom).toBe(parent.id);
    });

    it('computeEffectivePriority uses cache for repeated calls', () => {
      const item = db.create({
        title: 'Medium item',
        priority: 'medium',
        status: 'open',
      });

      const cache = new Map<string, { value: number; reason: string; inheritedFrom?: string }>();
      const result1 = db.computeEffectivePriority(item, cache);
      const result2 = db.computeEffectivePriority(item, cache);

      // Both calls should return the same object reference (from cache)
      expect(result1).toBe(result2);
      expect(cache.size).toBe(1);
      expect(cache.has(item.id)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Subtree priority inheritance (WL-0MVYCVSPN007CMAJ)
  // A root item's effective priority is the max of its own priority and the
  // priorities of its non-closed descendants (children, transitively through
  // grandchildren), so a root hosting a critical child ranks as critical even
  // though the child itself is hidden from `wl next` (strict root-only).
  // ─────────────────────────────────────────────────────────────────────
  describe('subtree priority inheritance (WL-0MVYCVSPN007CMAJ)', () => {
    it('computeEffectivePriority inherits critical priority from an open child', () => {
      const root = db.create({ title: 'Root', priority: 'high', status: 'open' });
      const criticalChild = db.create({
        title: 'Critical child',
        priority: 'critical',
        status: 'open',
        parentId: root.id,
      });

      const result = db.computeEffectivePriority(root);
      expect(result.value).toBe(4); // critical
      expect(result.inheritedFrom).toBe(criticalChild.id);
      expect(result.reason).toContain('inherited from');
      expect(result.reason).toContain(criticalChild.id);
    });

    it('inherits critical priority transitively through a grandchild', () => {
      const root = db.create({ title: 'Root', priority: 'high', status: 'open' });
      const child = db.create({
        title: 'Child',
        priority: 'medium',
        status: 'open',
        parentId: root.id,
      });
      const grandchild = db.create({
        title: 'Critical grandchild',
        priority: 'critical',
        status: 'open',
        parentId: child.id,
      });

      const result = db.computeEffectivePriority(root);
      expect(result.value).toBe(4);
      expect(result.inheritedFrom).toBe(grandchild.id);
      expect(result.reason).toContain(grandchild.id);
    });

    it('does not inherit from a completed critical child', () => {
      const root = db.create({ title: 'Root', priority: 'high', status: 'open' });
      db.create({
        title: 'Completed critical child',
        priority: 'critical',
        status: 'completed',
        parentId: root.id,
      });

      const result = db.computeEffectivePriority(root);
      expect(result.value).toBe(3); // own high
      expect(result.inheritedFrom).toBeUndefined();
    });

    it('does not inherit from a deleted critical child', () => {
      const root = db.create({ title: 'Root', priority: 'high', status: 'open' });
      db.create({
        title: 'Deleted critical child',
        priority: 'critical',
        status: 'deleted',
        parentId: root.id,
      });

      const result = db.computeEffectivePriority(root);
      expect(result.value).toBe(3); // own high
      expect(result.inheritedFrom).toBeUndefined();
    });

    it('does not inherit from a blocked critical child — its blockers carry the urgency', () => {
      // A blocked child's urgency is carried by *its own* blockers through
      // the dependents path, never by the parent: the parent must not
      // outrank a root-level blocker that unblocks the child
      // (WL-0MQFIYPZK00680H1).
      const root = db.create({ title: 'Root', priority: 'high', status: 'open' });
      db.create({
        title: 'Blocked critical child',
        priority: 'critical',
        status: 'blocked',
        parentId: root.id,
      });

      const result = db.computeEffectivePriority(root);
      expect(result.value).toBe(3); // own high
      expect(result.inheritedFrom).toBeUndefined();
    });

    it('takes the maximum of own priority and inherited child priority', () => {
      // Root is already critical (own) with a high child — effective stays
      // critical; no inheritedFrom is recorded for a lower child.
      const root = db.create({ title: 'Critical root', priority: 'critical', status: 'open' });
      db.create({
        title: 'High child',
        priority: 'high',
        status: 'open',
        parentId: root.id,
      });

      const result = db.computeEffectivePriority(root);
      expect(result.value).toBe(4);
      expect(result.inheritedFrom).toBeUndefined();
    });

    it('resolves deep subtree chains deterministically without recursion blow-up', () => {
      const root = db.create({ title: 'Deep root', priority: 'low', status: 'open' });
      let parent = root;
      for (let i = 0; i < 60; i += 1) {
        parent = db.create({
          title: `Level ${i}`,
          priority: 'low',
          status: 'open',
          parentId: parent.id,
        });
      }

      // All-low 60-deep chain: terminates and stays at own low priority
      // (no critical item anywhere in the subtree).
      const result = db.computeEffectivePriority(root);
      expect(result.value).toBe(1);
      expect(result.inheritedFrom).toBeUndefined();
    });

    it('still finds a critical descendant deep in the subtree', () => {
      const root = db.create({ title: 'Deep root', priority: 'low', status: 'open' });
      let parent = root;
      for (let i = 0; i < 49; i += 1) {
        parent = db.create({
          title: `Level ${i}`,
          priority: 'low',
          status: 'open',
          parentId: parent.id,
        });
      }
      const deepCritical = db.create({
        title: 'Deep critical leaf',
        priority: 'critical',
        status: 'open',
        parentId: parent.id,
      });

      const result = db.computeEffectivePriority(root);
      expect(result.value).toBe(4);
      expect(result.inheritedFrom).toBe(deepCritical.id);
    });

    it('is cycle-safe on a degenerate parentId cycle', () => {
      const root = db.create({ title: 'Root', priority: 'low', status: 'open' });
      const child = db.create({
        title: 'Child',
        priority: 'low',
        status: 'open',
        parentId: root.id,
      });
      // Degenerate: point the root back at its own child to form a cycle.
      db.update(root.id, { parentId: child.id });

      const result = db.computeEffectivePriority(root);
      // Terminates deterministically; never below own/inherited low.
      expect(result.value).toBeGreaterThanOrEqual(1);
    });

    it('wl next selects a root hosting a critical child over a standalone root', async () => {
      const rootWithCriticalChild = db.create({
        title: 'Root with critical child',
        priority: 'low',
        status: 'open',
      });
      db.create({
        title: 'Critical child',
        priority: 'critical',
        status: 'open',
        parentId: rootWithCriticalChild.id,
      });
      await wait(10);
      db.create({
        title: 'Standalone medium root',
        priority: 'medium',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Effective priority (critical via the hidden child) wins the
      // tie-break over the standalone medium root.
      expect(result.workItem!.id).toBe(rootWithCriticalChild.id);
    });

    it('never surfaces the critical child itself (single and batch, root-only)', () => {
      const parent = db.create({ title: 'Open parent', priority: 'low', status: 'open' });
      const criticalChild = db.create({
        title: 'Critical child',
        priority: 'critical',
        status: 'open',
        parentId: parent.id,
      });

      const single = db.findNextWorkItem();
      expect(single.workItem).not.toBeNull();
      expect(single.workItem!.id).toBe(parent.id);

      const batch = db.findNextWorkItems(3);
      const ids = batch.map(r => r.workItem?.id).filter(Boolean);
      expect(ids).not.toContain(criticalChild.id);
      expect(ids).toContain(parent.id);
    });
  });

});
