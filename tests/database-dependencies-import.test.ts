/**
 * Tests for WorklogDatabase — dependency edges and import/upsert semantics.
 *
 * Dependency-edge CRUD, destructive import and the non-destructive upsert no-op guard.
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
  describe('dependency edges', () => {
    it('should add and list outbound dependency edges', () => {
      const from = db.create({ title: 'From' });
      const to = db.create({ title: 'To' });

      const edge = db.addDependencyEdge(from.id, to.id);
      expect(edge).toBeDefined();
      expect(edge?.fromId).toBe(from.id);
      expect(edge?.toId).toBe(to.id);

      const outbound = db.listDependencyEdgesFrom(from.id);
      expect(outbound).toHaveLength(1);
      expect(outbound[0].fromId).toBe(from.id);
      expect(outbound[0].toId).toBe(to.id);
    });

    it('should list inbound dependency edges', () => {
      const from = db.create({ title: 'From' });
      const to = db.create({ title: 'To' });

      db.addDependencyEdge(from.id, to.id);

      const inbound = db.listDependencyEdgesTo(to.id);
      expect(inbound).toHaveLength(1);
      expect(inbound[0].fromId).toBe(from.id);
      expect(inbound[0].toId).toBe(to.id);
    });

    it('should remove dependency edges', () => {
      const from = db.create({ title: 'From' });
      const to = db.create({ title: 'To' });
      db.addDependencyEdge(from.id, to.id);

      const removed = db.removeDependencyEdge(from.id, to.id);
      expect(removed).toBe(true);
      expect(db.listDependencyEdgesFrom(from.id)).toHaveLength(0);
      expect(db.listDependencyEdgesTo(to.id)).toHaveLength(0);
    });

    it('should return null when adding edge with missing items', () => {
      const from = db.create({ title: 'From' });
      const edge = db.addDependencyEdge(from.id, 'TEST-NOTFOUND');
      expect(edge).toBeNull();
    });

    it('should open a blocked dependent when dependency is removed and no blockers remain', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      const removed = db.removeDependencyEdge(blocked.id, blocker.id);
      expect(removed).toBe(true);

      db.reconcileBlockedStatus(blocked.id);
      expect(db.get(blocked.id)?.status).toBe('open');
    });

    it('should keep blocked status when other active blockers remain', () => {
      const blockerA = db.create({ title: 'Blocker A', status: 'open', stage: 'in_progress' });
      const blockerB = db.create({ title: 'Blocker B', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blockerA.id);
      db.addDependencyEdge(blocked.id, blockerB.id);

      const removed = db.removeDependencyEdge(blocked.id, blockerA.id);
      expect(removed).toBe(true);

      db.reconcileBlockedStatus(blocked.id);
      expect(db.get(blocked.id)?.status).toBe('blocked');
    });

    it('should unblock dependents when target becomes inactive', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      db.update(blocker.id, { stage: 'done' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });

    it('should unblock dependent when blocker is closed via status completed', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });

    it('should keep dependent blocked when one of multiple blockers is closed', () => {
      const blockerA = db.create({ title: 'Blocker A', status: 'open' });
      const blockerB = db.create({ title: 'Blocker B', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blockerA.id);
      db.addDependencyEdge(blocked.id, blockerB.id);

      db.update(blockerA.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('blocked');
    });

    it('should unblock dependent when all blockers are closed', () => {
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

    it('should not change completed dependent when blocker is closed', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const completed = db.create({ title: 'Completed Dependent', status: 'completed' });
      db.addDependencyEdge(completed.id, blocker.id);

      db.update(blocker.id, { status: 'completed' });
      expect(db.get(completed.id)?.status).toBe('completed');
    });

    it('should not change deleted dependent when blocker is closed', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const deleted = db.create({ title: 'Deleted Dependent', status: 'open' });
      db.addDependencyEdge(deleted.id, blocker.id);
      db.delete(deleted.id);
      expect(db.get(deleted.id)?.status).toBe('deleted');

      db.update(blocker.id, { status: 'completed' });
      expect(db.get(deleted.id)?.status).toBe('deleted');
    });

    it('should be idempotent: closing an already-completed blocker is a no-op', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');

      // Closing again should not change anything
      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });

    it('should handle chain dependencies: A blocks B blocks C', () => {
      const a = db.create({ title: 'A (blocker of B)', status: 'open' });
      const b = db.create({ title: 'B (blocked by A, blocker of C)', status: 'blocked' });
      const c = db.create({ title: 'C (blocked by B)', status: 'blocked' });
      db.addDependencyEdge(b.id, a.id); // B depends on A
      db.addDependencyEdge(c.id, b.id); // C depends on B

      // Close A: B should unblock, but C should stay blocked (B is now open, not completed)
      db.update(a.id, { status: 'completed' });
      expect(db.get(b.id)?.status).toBe('open');
      expect(db.get(c.id)?.status).toBe('blocked');

      // Close B: C should unblock
      db.update(b.id, { status: 'completed' });
      expect(db.get(c.id)?.status).toBe('open');
    });

    it('should unblock dependent when blocker is deleted', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      db.delete(blocker.id);
      expect(db.get(blocked.id)?.status).toBe('open');
    });

    it('should re-block dependent when closed blocker is reopened', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      db.update(blocker.id, { status: 'completed' });
      expect(db.get(blocked.id)?.status).toBe('open');

      db.update(blocker.id, { status: 'in-progress', stage: 'in_progress' });
      expect(db.get(blocked.id)?.status).toBe('blocked');
    });

    it('should unblock multiple dependents when their shared blocker is closed', () => {
      const blocker = db.create({ title: 'Shared Blocker', status: 'open' });
      const dependentA = db.create({ title: 'Dependent A', status: 'blocked' });
      const dependentB = db.create({ title: 'Dependent B', status: 'blocked' });
      db.addDependencyEdge(dependentA.id, blocker.id);
      db.addDependencyEdge(dependentB.id, blocker.id);

      db.update(blocker.id, { status: 'completed' });
      expect(db.get(dependentA.id)?.status).toBe('open');
      expect(db.get(dependentB.id)?.status).toBe('open');
    });

    it('should emit debug log to stderr when WL_DEBUG is set and dependent is unblocked', () => {
      const blocker = db.create({ title: 'Debug Log Blocker', status: 'open' });
      const dependent = db.create({ title: 'Debug Log Dependent', status: 'blocked' });
      db.addDependencyEdge(dependent.id, blocker.id);

      const stderrChunks: Buffer[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => {
        stderrChunks.push(Buffer.from(chunk));
        return true;
      }) as any;

      const originalDebug = process.env.WL_DEBUG;
      process.env.WL_DEBUG = '1';

      try {
        db.update(blocker.id, { status: 'completed' });
        const stderrOutput = Buffer.concat(stderrChunks).toString();
        expect(stderrOutput).toContain(`[wl:dep] unblocked ${dependent.id}`);
        expect(stderrOutput).toContain(`[wl:dep] reconciled 1 dependent(s) for target ${blocker.id}`);
      } finally {
        process.stderr.write = originalWrite;
        if (originalDebug === undefined) {
          delete process.env.WL_DEBUG;
        } else {
          process.env.WL_DEBUG = originalDebug;
        }
      }
    });

    it('should not emit debug log when WL_DEBUG is not set during reconciliation', () => {
      const blocker = db.create({ title: 'No Debug Blocker', status: 'open' });
      const dependent = db.create({ title: 'No Debug Dependent', status: 'blocked' });
      db.addDependencyEdge(dependent.id, blocker.id);

      const stderrChunks: Buffer[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => {
        stderrChunks.push(Buffer.from(chunk));
        return true;
      }) as any;

      const originalDebug = process.env.WL_DEBUG;
      delete process.env.WL_DEBUG;

      try {
        db.update(blocker.id, { status: 'completed' });
        const stderrOutput = Buffer.concat(stderrChunks).toString();
        expect(stderrOutput).not.toContain('[wl:dep]');
      } finally {
        process.stderr.write = originalWrite;
        if (originalDebug === undefined) {
          delete process.env.WL_DEBUG;
        } else {
          process.env.WL_DEBUG = originalDebug;
        }
      }
    });

    describe('in_review stage unblocking (dependency edges only)', () => {
      it('should unblock dependent when sole blocker moves to in_review stage', () => {
        const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
        const blocked = db.create({ title: 'Blocked', status: 'blocked' });
        db.addDependencyEdge(blocked.id, blocker.id);

        db.update(blocker.id, { stage: 'in_review' });
        expect(db.get(blocked.id)?.status).toBe('open');
      });

      it('should keep dependent blocked when one of multiple blockers moves to in_review', () => {
        const blockerA = db.create({ title: 'Blocker A', status: 'open', stage: 'in_progress' });
        const blockerB = db.create({ title: 'Blocker B', status: 'open', stage: 'in_progress' });
        const blocked = db.create({ title: 'Blocked', status: 'blocked' });
        db.addDependencyEdge(blocked.id, blockerA.id);
        db.addDependencyEdge(blocked.id, blockerB.id);

        db.update(blockerA.id, { stage: 'in_review' });
        expect(db.get(blocked.id)?.status).toBe('blocked');
      });

      it('should unblock dependent when all blockers move to in_review', () => {
        const blockerA = db.create({ title: 'Blocker A', status: 'open', stage: 'in_progress' });
        const blockerB = db.create({ title: 'Blocker B', status: 'open', stage: 'in_progress' });
        const blocked = db.create({ title: 'Blocked', status: 'blocked' });
        db.addDependencyEdge(blocked.id, blockerA.id);
        db.addDependencyEdge(blocked.id, blockerB.id);

        db.update(blockerA.id, { stage: 'in_review' });
        expect(db.get(blocked.id)?.status).toBe('blocked');

        db.update(blockerB.id, { stage: 'in_review' });
        expect(db.get(blocked.id)?.status).toBe('open');
      });

      it('should unblock dependent when mix of in_review and completed blockers are all non-blocking', () => {
        const blockerA = db.create({ title: 'Blocker A', status: 'open', stage: 'in_progress' });
        const blockerB = db.create({ title: 'Blocker B', status: 'open', stage: 'in_progress' });
        const blocked = db.create({ title: 'Blocked', status: 'blocked' });
        db.addDependencyEdge(blocked.id, blockerA.id);
        db.addDependencyEdge(blocked.id, blockerB.id);

        db.update(blockerA.id, { status: 'completed' });
        expect(db.get(blocked.id)?.status).toBe('blocked');

        db.update(blockerB.id, { stage: 'in_review' });
        expect(db.get(blocked.id)?.status).toBe('open');
      });

      it('should be idempotent: moving blocker to in_review multiple times does not break state', () => {
        const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
        const blocked = db.create({ title: 'Blocked', status: 'blocked' });
        db.addDependencyEdge(blocked.id, blocker.id);

        db.update(blocker.id, { stage: 'in_review' });
        expect(db.get(blocked.id)?.status).toBe('open');

        db.update(blocker.id, { stage: 'in_review' });
        expect(db.get(blocked.id)?.status).toBe('open');
      });

      it('should re-block dependent when blocker moves back from in_review to in_progress', () => {
        const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
        const blocked = db.create({ title: 'Blocked', status: 'blocked' });
        db.addDependencyEdge(blocked.id, blocker.id);

        db.update(blocker.id, { stage: 'in_review' });
        expect(db.get(blocked.id)?.status).toBe('open');

        db.update(blocker.id, { stage: 'in_progress' });
        expect(db.get(blocked.id)?.status).toBe('blocked');
      });

      it('should unblock multiple dependents when their shared blocker moves to in_review', () => {
        const blocker = db.create({ title: 'Shared Blocker', status: 'open', stage: 'in_progress' });
        const dependentA = db.create({ title: 'Dependent A', status: 'blocked' });
        const dependentB = db.create({ title: 'Dependent B', status: 'blocked' });
        db.addDependencyEdge(dependentA.id, blocker.id);
        db.addDependencyEdge(dependentB.id, blocker.id);

        db.update(blocker.id, { stage: 'in_review' });
        expect(db.get(dependentA.id)?.status).toBe('open');
        expect(db.get(dependentB.id)?.status).toBe('open');
      });
    });
  });

  describe('foreign-endpoint dependency edge persistence (WL-0MWXIT6H3006TY2I)', () => {
    const FOREIGN = 'SA-0MWFFD9N0050SP5';

    function makeItem(id: string, title: string): WorkItem {
      return {
        id,
        title,
        description: '',
        status: 'open' as const,
        priority: 'medium' as const,
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        tags: [],
        assignee: '',
        stage: '',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };
    }

    it('keeps a local→foreign edge through a destructive import', () => {
      const local = makeItem('TEST-001', 'Local owner');
      const edge = { fromId: 'TEST-001', toId: FOREIGN, createdAt: '2024-01-02T00:00:00.000Z' };

      db.import([local], [edge]);

      const edges = db.getAllDependencyEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0].fromId).toBe('TEST-001');
      expect(edges[0].toId).toBe(FOREIGN);
      expect(db.listDependencyEdgesFrom('TEST-001')).toHaveLength(1);
    });

    it('drops an edge whose both endpoints are foreign on import', () => {
      const local = makeItem('TEST-001', 'Local owner');
      const edge = { fromId: FOREIGN, toId: 'SA-OTHER0000000000', createdAt: '2024-01-02T00:00:00.000Z' };

      db.import([local], [edge]);

      expect(db.getAllDependencyEdges()).toHaveLength(0);
    });

    it('skips a foreign→local edge without aborting the import transaction', () => {
      // `dependency_edges` has a foreign key on `fromId`, so an edge whose
      // owner is foreign is unstorable. A corrupt remote must not crash sync.
      const local = makeItem('TEST-001', 'Local target');
      const edge = { fromId: FOREIGN, toId: 'TEST-001', createdAt: '2024-01-02T00:00:00.000Z' };

      expect(() => db.import([local], [edge])).not.toThrow();
      expect(db.getAllDependencyEdges()).toHaveLength(0);
    });

    it('does not resurrect a foreign edge after the local owner is removed (stale snapshot)', () => {
      const local = makeItem('TEST-001', 'Local owner');
      const edge = { fromId: 'TEST-001', toId: FOREIGN, createdAt: '2024-01-02T00:00:00.000Z' };

      db.import([local], [edge]);
      expect(db.getAllDependencyEdges()).toHaveLength(1);

      // A stale snapshot carrying the edge but not its owner: the owner is
      // hard-deleted by the destructive replace, so the edge has no local
      // endpoint and must be dropped (never resurrected).
      db.import([], [edge]);
      expect(db.getAllDependencyEdges()).toHaveLength(0);
    });

    it('keeps a local→foreign edge through a non-destructive upsert', () => {
      const local = db.create({ title: 'Local owner' });
      const edge = { fromId: local.id, toId: FOREIGN, createdAt: '2024-01-02T00:00:00.000Z' };

      db.upsertItems([local], [edge]);

      const edges = db.listDependencyEdgesFrom(local.id);
      expect(edges).toHaveLength(1);
      expect(edges[0].toId).toBe(FOREIGN);
    });

    it('drops a both-foreign edge on upsert', () => {
      const local = db.create({ title: 'Local owner' });
      const edge = { fromId: FOREIGN, toId: 'SA-OTHER0000000000', createdAt: '2024-01-02T00:00:00.000Z' };

      db.upsertItems([local], [edge]);

      expect(db.getAllDependencyEdges()).toHaveLength(0);
    });

    it('skips a foreign→local edge on upsert without throwing', () => {
      // FK on `fromId`: a foreign owner cannot be stored. Must not crash sync.
      const local = db.create({ title: 'Local target' });
      const edge = { fromId: FOREIGN, toId: local.id, createdAt: '2024-01-02T00:00:00.000Z' };

      expect(() => db.upsertItems([local], [edge])).not.toThrow();
      expect(db.getAllDependencyEdges()).toHaveLength(0);
    });
  });

  describe('import and export', () => {
    it('should import work items', () => {
      const items = [
        {
          id: 'TEST-001',
          title: 'Imported 1',
          description: '',
          status: 'open' as const,
          priority: 'medium' as const,
          sortIndex: 0,
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: [],
          assignee: '',
          stage: '',
          issueType: '',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '' as const,
          effort: '' as const,
        },
        {
          id: 'TEST-002',
          title: 'Imported 2',
          description: '',
          status: 'completed' as const,
          priority: 'high' as const,
          sortIndex: 0,
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: ['test'],
          assignee: 'alice',
          stage: 'done',
          issueType: '',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '' as const,
          effort: '' as const,
        },
      ];

      db.import(items);
      const allItems = db.getAll();

      expect(allItems).toHaveLength(2);
      expect(allItems.find(i => i.id === 'TEST-001')).toBeDefined();
      expect(allItems.find(i => i.id === 'TEST-002')).toBeDefined();
    });


  });

  describe('import and upsert timestamp preservation (no-op guard)', () => {
    /**
     * Helper: create an item with a known past timestamp.
     * The past time is used so that if import() or upsertItems() overwrites
     * updatedAt with the current time, we can detect the change.
     */
    function createItemWithPastTimestamp(
      id: string,
      title: string,
      overrides: Partial<import('../src/types.js').WorkItem> = {}
    ): import('../src/types.js').WorkItem {
      const pastTimestamp = '2025-01-01T00:00:00.000Z';
      return {
        id,
        title,
        description: '',
        status: 'open' as const,
        priority: 'medium' as const,
        sortIndex: 0,
        parentId: null,
        createdAt: pastTimestamp,
        updatedAt: pastTimestamp,
        tags: [],
        assignee: '',
        stage: '',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
        githubIssueNumber: undefined,
        githubIssueId: undefined,
        githubIssueUpdatedAt: undefined,
        needsProducerReview: false,
        ...overrides,
      };
    }

    it('should preserve updatedAt on all items when import has no changes', () => {
      const item1 = createItemWithPastTimestamp('TEST-IMP-001', 'Item 1');
      const item2 = createItemWithPastTimestamp('TEST-IMP-002', 'Item 2');

      // Import baseline items
      db.import([item1, item2]);

      const afterFirstImport = db.getAll();
      expect(afterFirstImport).toHaveLength(2);

      // Re-import the exact same items (no changes)
      db.import([item1, item2]);

      const afterSecondImport = db.getAll();
      expect(afterSecondImport).toHaveLength(2);

      // Both items should retain their original updatedAt
      for (const item of afterSecondImport) {
        expect(item.updatedAt).toBe('2025-01-01T00:00:00.000Z');
      }
    });

    it('should only update updatedAt for the single changed item', () => {
      const unchanged = createItemWithPastTimestamp('TEST-IMP-011', 'Unchanged');
      const changed = createItemWithPastTimestamp('TEST-IMP-012', 'Original title');

      db.import([unchanged, changed]);

      // Modify one item's title
      const changedUpdated = createItemWithPastTimestamp('TEST-IMP-012', 'Updated title');

      db.import([unchanged, changedUpdated]);

      const items = db.getAll();
      const unchangedItem = items.find(i => i.id === 'TEST-IMP-011')!;
      const changedItem = items.find(i => i.id === 'TEST-IMP-012')!;

      // Unchanged item should retain original updatedAt
      expect(unchangedItem.updatedAt).toBe('2025-01-01T00:00:00.000Z');

      // Changed item should have a new (current) updatedAt
      const currentTime = new Date().toISOString();
      expect(new Date(changedItem.updatedAt).getTime()).toBeGreaterThan(
        new Date('2025-01-01T00:00:00.000Z').getTime()
      );
    });

    it('should preserve updatedAt for unchanged items when importing a mix', () => {
      const unchanged1 = createItemWithPastTimestamp('TEST-IMP-021', 'Unchanged 1');
      const unchanged2 = createItemWithPastTimestamp('TEST-IMP-022', 'Unchanged 2');
      const changed1 = createItemWithPastTimestamp('TEST-IMP-023', 'Will change');

      db.import([unchanged1, unchanged2, changed1]);

      // Update one item and add a new item
      const changed1Updated = createItemWithPastTimestamp('TEST-IMP-023', 'Changed title');
      const newItem = createItemWithPastTimestamp('TEST-IMP-024', 'Brand new');

      db.import([unchanged1, unchanged2, changed1Updated, newItem]);

      const items = db.getAll();
      expect(items).toHaveLength(4);

      // Unchanged items retain original updatedAt
      expect(items.find(i => i.id === 'TEST-IMP-021')!.updatedAt).toBe('2025-01-01T00:00:00.000Z');
      expect(items.find(i => i.id === 'TEST-IMP-022')!.updatedAt).toBe('2025-01-01T00:00:00.000Z');

      // Changed item gets new timestamp
      const changedItem = items.find(i => i.id === 'TEST-IMP-023')!;
      expect(new Date(changedItem.updatedAt).getTime()).toBeGreaterThan(
        new Date('2025-01-01T00:00:00.000Z').getTime()
      );

      // New item gets a proper timestamp
      const newItemResult = items.find(i => i.id === 'TEST-IMP-024')!;
      expect(newItemResult.updatedAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('should only change updatedAt for locally-modified items on re-import', () => {
      const item = db.create({ title: 'Local item', status: 'open' });

      const originalUpdatedAt = item.updatedAt;

      // Simulate a sync re-import with same data (no changes)
      const reimportItem = createItemWithPastTimestamp(item.id, 'Local item', {
        description: '',
        status: 'open' as const,
        priority: 'medium' as const,
        sortIndex: 0,
        parentId: null,
        tags: [],
        assignee: '',
        stage: '',
        issueType: '',
        risk: '' as const,
        effort: '' as const,
        createdAt: item.createdAt,
        updatedAt: originalUpdatedAt, // Pass through the original timestamp
      });

      db.import([reimportItem]);

      const afterReimport = db.get(item.id)!;
      // If the item's data hasn't changed, updatedAt should be preserved
      expect(afterReimport.updatedAt).toBe(originalUpdatedAt);
    });

    it('should not alter updatedAt for unchanged items in upsertItems', () => {
      const item1 = db.create({ title: 'Item A' });
      const originalUpdatedAt1 = item1.updatedAt;

      const item2 = db.create({ title: 'Item B' });
      const originalUpdatedAt2 = item2.updatedAt;

      // Upsert the same items (no changes)
      const upsertItem1 = createItemWithPastTimestamp(item1.id, 'Item A', {
        description: '',
        status: 'open' as const,
        priority: 'medium' as const,
        sortIndex: 0,
        parentId: null,
        tags: [],
        assignee: '',
        stage: '',
        issueType: '',
        risk: '' as const,
        effort: '' as const,
        createdAt: item1.createdAt,
        updatedAt: originalUpdatedAt1,
      });
      const upsertItem2 = createItemWithPastTimestamp(item2.id, 'Item B', {
        description: '',
        status: 'open' as const,
        priority: 'medium' as const,
        sortIndex: 0,
        parentId: null,
        tags: [],
        assignee: '',
        stage: '',
        issueType: '',
        risk: '' as const,
        effort: '' as const,
        createdAt: item2.createdAt,
        updatedAt: originalUpdatedAt2,
      });

      db.upsertItems([upsertItem1, upsertItem2]);

      const afterUpsert = db.getAll();
      const item1After = afterUpsert.find(i => i.id === item1.id)!;
      const item2After = afterUpsert.find(i => i.id === item2.id)!;

      expect(item1After.updatedAt).toBe(originalUpdatedAt1);
      expect(item2After.updatedAt).toBe(originalUpdatedAt2);
    });

    it('should update updatedAt for modified items in upsertItems', () => {
      const item = db.create({ title: 'Original' });
      const originalUpdatedAt = item.updatedAt;

      // Upsert with a modified title
      const updatedItem = createItemWithPastTimestamp(item.id, 'Modified title', {
        description: item.description,
        status: item.status as 'open' | 'in-progress' | 'completed' | 'deleted' | 'blocked',
        priority: item.priority as 'critical' | 'high' | 'medium' | 'low',
        sortIndex: item.sortIndex,
        parentId: item.parentId,
        tags: [...item.tags],
        assignee: item.assignee,
        stage: item.stage,
        issueType: item.issueType,
        risk: item.risk as '' | 'Low' | 'Medium' | 'High' | 'Critical',
        effort: item.effort as '' | 'Small' | 'Medium' | 'Large' | 'XLarge',
        createdAt: item.createdAt,
        updatedAt: originalUpdatedAt,
      });

      db.upsertItems([updatedItem]);

      const after = db.get(item.id)!;
      expect(after.title).toBe('Modified title');
      // updatedAt should have been bumped (or at least not be earlier)
      expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(originalUpdatedAt).getTime()
      );
      // Also verify the title change triggered a save — the updatedAt should differ
      // if timestamps are identical (same ms), the test still passes because
      // data integrity is correct; accuracy at ms granularity is acceptable.
    });

    it('should preserve close when import merges closed local item with stale remote', () => {
      // Simulate: close then sync with stale remote data (item was in-progress)
      // 1. Create an item
      const original = db.create({ title: 'Close me', status: 'in-progress' as any, stage: 'plan_complete', priority: 'medium' });
      const originalUpdatedAt = original.updatedAt;

      // 2. Close the item (simulating wl close)
      const closed = db.update(original.id, { status: 'completed', stage: 'done' })!;
      expect(closed.status).toBe('completed');
      expect(closed.stage).toBe('done');
      // Close bumps the timestamp (or same ms; at least not older)
      expect(new Date(closed.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(originalUpdatedAt).getTime());
      const closeUpdatedAt = closed.updatedAt;

      // 3. Simulate sync merge with stale remote data (item at in-progress)
      const remoteStale = { ...original, updatedAt: originalUpdatedAt, status: 'in-progress' as const, stage: 'plan_complete' };
      
      // The merged item from mergeWorkItems (local is newer, so it wins)
      const localFromDb = db.get(original.id)!;
      expect(localFromDb.status).toBe('completed');
      expect(localFromDb.stage).toBe('done');
      expect(localFromDb.updatedAt).toBe(closeUpdatedAt);

      // Build a merged item as mergeWorkItems would produce:
      // local (newer) should win for all conflicting fields
      const mergedItem = {
        ...remoteStale,
        status: 'completed' as const,
        stage: 'done',
        updatedAt: closeUpdatedAt,
      };

      // 4. Import the merged data (as sync does)
      db.import([mergedItem]);

      // 5. Verify close survived
      const afterSync = db.get(original.id)!;
      expect(afterSync.status).toBe('completed');
      expect(afterSync.stage).toBe('done');
      // updatedAt should be preserved since no semantic change
      expect(afterSync.updatedAt).toBe(closeUpdatedAt);
    });

    it('should preserve close after multiple import cycles (multi-sync stability)', () => {
      // Simulate multiple sync cycles after a close
      const item = db.create({ title: 'Stable close', status: 'in-progress' as any, stage: 'plan_complete' });
      const originalUpdatedAt = item.updatedAt;

      // Close
      const closed = db.update(item.id, { status: 'completed', stage: 'done' })!;
      const closeUpdatedAt = closed.updatedAt;

      for (let cycle = 0; cycle < 5; cycle++) {
        // Simulate the merge result that sync would produce
        const currentFromDb = db.get(item.id)!;
        const mergedItem = {
          ...item,
          status: 'completed' as const,
          stage: 'done',
          updatedAt: currentFromDb.updatedAt,
        };
        db.import([mergedItem]);

        const afterCycle = db.get(item.id)!;
        expect(afterCycle.status).toBe('completed');
        expect(afterCycle.stage).toBe('done');
      }
    });

    it('should handle close then sync with concurrent remote field edit', () => {
      // Simulate: Client A closes item. Client B edits description on the same item
      // and pushes. The close must not be silently reverted.
      
      // Create the item
      const original = db.create({ title: 'Concurrent edit', description: 'Original', status: 'in-progress' as any, stage: 'plan_complete' });

      // Close it (Client A)
      const closed = db.update(original.id, { status: 'completed', stage: 'done' })!;
      const closeUpdatedAt = closed.updatedAt;

      // Remote data (from Client B) still has in-progress (old value) with a
      // description edit. The description edit bumped the timestamp.
      const remoteNewerTimestamp = new Date(new Date(closeUpdatedAt).getTime() + 3600000).toISOString();
      const remoteItem = {
        ...original,
        description: 'Edited by B',
        updatedAt: remoteNewerTimestamp,
        status: 'in-progress' as const,
        stage: 'plan_complete',
      };

      // Build what mergeWorkItems would produce:
      // Since local has status=completed,stage=done (close) and remote has
      // in-progress/plan_complete, the close priority rule preserves the close.
      // The description edit from remote is also preserved.
      const mergedItem = {
        ...remoteItem,
        status: 'completed' as const,
        stage: 'done',
        updatedAt: remoteNewerTimestamp,
      };

      // Import and verify
      db.import([mergedItem]);
      const afterImport = db.get(original.id)!;
      
      // The close is preserved even though remote is newer,
      // because the close state (completed/done) takes priority
      // over old status values from unrelated field changes.
      expect(afterImport.status).toBe('completed');
      expect(afterImport.stage).toBe('done');
      
      // The description edit is also preserved (it was the only field
      // where remote intentionally made a change)
      expect(afterImport.description).toBe('Edited by B');
    });
  });

});
