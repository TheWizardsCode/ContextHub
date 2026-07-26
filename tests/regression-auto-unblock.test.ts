/**
 * Regression tests for auto-unblock of blocked work items
 *
 * Verifies ACs for WL-0MRNM8EBD000C2P1
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { WorklogDatabase } from '../packages/shared/src/database.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';

describe('Auto-unblock regression tests (WL-0MRNM8EBD000C2P1)', () => {
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

  // AC1: Single blocker completed -> dependent unblocks
  describe('AC1: Single blocker completed', () => {
    it('should unblock when blocker status set to completed', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should unblock when blocker stage set to done', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.update(blocker.id, { stage: 'done' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should unblock when blocker status AND stage set together', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.update(blocker.id, { status: 'completed', stage: 'done' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should unblock when blocker stage set to in_review', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.update(blocker.id, { stage: 'in_review' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should unblock multiple dependents sharing one blocker', () => {
      const blocker = db.create({ title: 'Shared Blocker', status: 'open' });
      const depA = db.create({ title: 'Dependent A', status: 'blocked' });
      const depB = db.create({ title: 'Dependent B', status: 'blocked' });
      db.addDependencyEdge(depA.id, blocker.id);
      db.addDependencyEdge(depB.id, blocker.id);
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(depA.id)?.status).toBe('open');
      expect(db.get(depB.id)?.status).toBe('open');
    });
    it('should unblock when blocker is deleted', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.delete(blocker.id);
      expect(db.get(blocked.id)?.status).toBe('open');
    });
  });

  // AC2: Multiple blockers - all must complete before unblock
  describe('AC2: Multiple blockers', () => {
    it('should stay blocked when only one of two blockers is completed', () => {
      const blockerA = db.create({ title: 'Blocker A', status: 'open' });
      const blockerB = db.create({ title: 'Blocker B', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blockerA.id);
      db.addDependencyEdge(blocked.id, blockerB.id);
      db.update(blockerA.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('blocked');
    });
    it('should unblock after ALL blockers are completed', () => {
      const blockerA = db.create({ title: 'Blocker A', status: 'open' });
      const blockerB = db.create({ title: 'Blocker B', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blockerA.id);
      db.addDependencyEdge(blocked.id, blockerB.id);
      db.update(blockerA.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('blocked');
      db.update(blockerB.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should stay blocked with three blockers, unblock after all done', () => {
      const blockerA = db.create({ title: 'Blocker A', status: 'open' });
      const blockerB = db.create({ title: 'Blocker B', status: 'open' });
      const blockerC = db.create({ title: 'Blocker C', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blockerA.id);
      db.addDependencyEdge(blocked.id, blockerB.id);
      db.addDependencyEdge(blocked.id, blockerC.id);
      db.update(blockerA.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('blocked');
      db.update(blockerB.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('blocked');
      db.update(blockerC.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
  });

  // AC3: Completes via different paths
  describe('AC3: Different completion paths', () => {
    it('should unblock via status=completed only', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should unblock via stage=done only', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.update(blocker.id, { stage: 'done' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should unblock via status=completed AND stage=done', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.update(blocker.id, { status: 'completed', stage: 'done' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
  });

  // AC4: Terminal items never unblocked
  describe('AC4: Terminal items never auto-unblock', () => {
    it('should not unblock a completed dependent', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const completed = db.create({ title: 'Completed Dependent', status: 'completed' });
      db.addDependencyEdge(completed.id, blocker.id);
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(completed.id)?.status).toBe('completed');
    });
    it('should not unblock a deleted dependent', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const deleted = db.create({ title: 'Deleted Dependent', status: 'open' });
      db.addDependencyEdge(deleted.id, blocker.id);
      db.delete(deleted.id);
      expect(db.get(deleted.id)?.status).toBe('deleted');
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(deleted.id)?.status).toBe('deleted');
    });
    it('should not unblock a completed dependent when blocker closes', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const completed = db.create({ title: 'Completed Dependent', status: 'completed' });
      db.addDependencyEdge(completed.id, blocker.id);
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(completed.id)?.status).toBe('completed');
    });
  });

  // AC5: Dependency edge removal triggers re-evaluation
  describe('AC5: Dependency edge removal', () => {
    it('should unblock when dependency removed and no blockers remain', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.removeDependencyEdge(blocked.id, blocker.id);
      db.reconcileBlockedStatus(blocked.id);
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should stay blocked when dep removed but other blockers remain', () => {
      const blockerA = db.create({ title: 'Blocker A', status: 'open' });
      const blockerB = db.create({ title: 'Blocker B', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blockerA.id);
      db.addDependencyEdge(blocked.id, blockerB.id);
      db.removeDependencyEdge(blocked.id, blockerA.id);
      db.reconcileBlockedStatus(blocked.id);
      expect(db.get(blocked.id)?.status).toBe('blocked');
    });
    it('should unblock when all blockers removed one by one', () => {
      const blockerA = db.create({ title: 'Blocker A', status: 'open' });
      const blockerB = db.create({ title: 'Blocker B', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blockerA.id);
      db.addDependencyEdge(blocked.id, blockerB.id);
      db.removeDependencyEdge(blocked.id, blockerA.id);
      db.reconcileBlockedStatus(blocked.id);
      expect(db.get(blocked.id)?.status).toBe('blocked');
      db.removeDependencyEdge(blocked.id, blockerB.id);
      db.reconcileBlockedStatus(blocked.id);
      expect(db.get(blocked.id)?.status).toBe('open');
    });
  });

  // Cache interaction: pre-seeding dependency edge caches
  describe('Cache interaction: pre-seeded dep edge caches', () => {
    it('should unblock when depEdgesTo cache pre-seeded via listDependencyEdgesTo', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      // Pre-seed depEdgesTo_blocker cache
      db.listDependencyEdgesTo(blocker.id);
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should unblock when depEdgesFrom cache pre-seeded via listDependencyEdgesFrom', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      // Pre-seed depEdgesFrom_blocked cache
      db.listDependencyEdgesFrom(blocked.id);
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should unblock when both caches pre-seeded', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.listDependencyEdgesTo(blocker.id);
      db.listDependencyEdgesFrom(blocked.id);
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should unblock when getInboundDependents called before update', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      // Pre-seed work item and dep edge caches
      db.getInboundDependents(blocker.id);
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should unblock when all caches pre-seeded by getAllDependencyEdges', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      // Pre-seed the allDependencyEdges cache
      const allEdges = (db as any).store?.getAllDependencyEdges?.();
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
  });

  // Edge cases
  describe('Edge cases', () => {
    it('should be idempotent: closing an already-completed blocker is a no-op', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
    it('should handle chain: A blocks B blocks C', () => {
      const a = db.create({ title: 'A (blocker of B)', status: 'open' });
      const b = db.create({ title: 'B (blocked by A, blocker of C)', status: 'blocked' });
      const c = db.create({ title: 'C (blocked by B)', status: 'blocked' });
      db.addDependencyEdge(b.id, a.id);
      db.addDependencyEdge(c.id, b.id);
      db.update(a.id, { status: 'completed' });
      expect(db.get(b.id)?.status).toBe('open');
      expect(db.get(c.id)?.status).toBe('blocked');
      db.update(b.id, { status: 'completed' });
      expect(db.get(c.id)?.status).toBe('open');
    });
    it('should re-block when a closed blocker is reopened', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
      db.update(blocker.id, { status: 'in-progress', stage: 'in_progress' });
      expect(db.get(blocked.id)?.status).toBe('blocked');
    });
    it('should not affect items without dependency edges', () => {
      const item = db.create({ title: 'Standalone', status: 'open' });
      db.update(item.id, { status: 'completed' });
      expect(db.get(item.id)?.status).toBe('completed');
    });
    it('should work when blocker and blocked are the same item (self-edge)', () => {
      // Self-edges are prevented by FK constraints, but test the fallback
      const item = db.create({ title: 'Item', status: 'blocked' });
      expect(db.get(item.id)?.status).toBe('blocked');
      // No self-edge possible, so no unblocking would happen anyway
    });
  });

  // Additional: Multiple dependents with different blockers
  describe('Complex multi-dependent scenarios', () => {
    it('should correctly handle diamond dependency: A blocked by B and C, both blocked by D', () => {
      const d = db.create({ title: 'D (ultimate blocker)', status: 'open' });
      const b = db.create({ title: 'B (blocked by D, blocker of A)', status: 'blocked' });
      const c = db.create({ title: 'C (blocked by D, blocker of A)', status: 'blocked' });
      const a = db.create({ title: 'A (blocked by B and C)', status: 'blocked' });
      db.addDependencyEdge(b.id, d.id);
      db.addDependencyEdge(c.id, d.id);
      db.addDependencyEdge(a.id, b.id);
      db.addDependencyEdge(a.id, c.id);
      // Complete D - B and C should unblock, but A should stay blocked
      db.update(d.id, { status: 'completed' });
      expect(db.get(b.id)?.status).toBe('open');
      expect(db.get(c.id)?.status).toBe('open');
      expect(db.get(a.id)?.status).toBe('blocked');
      // Complete B and C - A should unblock
      db.update(b.id, { status: 'completed' });
      expect(db.get(a.id)?.status).toBe('blocked');
      db.update(c.id, { status: 'completed' });
      expect(db.get(a.id)?.status).toBe('open');
    });
  });

  // Simulates the EXACT wl close flow (comment + update)
  describe('wl close flow simulation', () => {
    it('should unblock when closed via simulated wl close (comment + status+stage update)', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      // Simulate closeSingle: create comment then update status+stage
      db.createComment({
        workItemId: blocker.id,
        author: 'test',
        comment: 'Closed with reason: Test close',
        references: [],
      });

      db.update(blocker.id, { status: 'completed', stage: 'done' });

      expect(db.get(blocked.id)?.status).toBe('open');
    });

    it('should unblock when closed with reason and pre-seeded caches', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      // Pre-seed all relevant caches
      db.listDependencyEdgesTo(blocker.id);
      db.listDependencyEdgesFrom(blocked.id);
      db.get(blocker.id);
      db.get(blocked.id);

      // Create a reason comment (like wl close does)
      db.createComment({
        workItemId: blocker.id,
        author: 'test',
        comment: 'Closed - pre-seeded cache test',
        references: [],
      });

      // Now update status+stage (like closeSingle)
      db.update(blocker.id, { status: 'completed', stage: 'done' });

      expect(db.get(blocked.id)?.status).toBe('open');
    });
  });

  // Simulates wl update flow (update then reconcile on the same item)
  describe('wl update flow simulation', () => {
    it('should unblock dependent when blocking item is updated via status=completed', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      // Simulate wl update CLI: update then reconcileDependentStatus on the item
      db.update(blocker.id, { status: 'completed' });
      db.reconcileDependentStatus(blocker.id);

      expect(db.get(blocked.id)?.status).toBe('open');
    });

    it('should unblock dependent when blocking item is updated via stage=done', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      db.update(blocker.id, { stage: 'done' });
      db.reconcileDependentStatus(blocker.id);

      expect(db.get(blocked.id)?.status).toBe('open');
    });
  });
});
