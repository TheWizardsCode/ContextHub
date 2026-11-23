/**
 * Tests for WorklogDatabase — transactional import and the wl next selection pipeline.
 *
 * Transactional import atomicity and the first half of the `findNextWorkItem` pipeline.
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
  describe('findNextWorkItem', () => {
    it('should prefer item blocking a high downstream item over equal-priority peer blocking nothing', () => {
      // A and B are both medium-priority open items.
      // A blocks a high-priority downstream item; B blocks nothing.
      // A should be recommended first.
      const itemA = db.create({ title: 'Unblocker A', priority: 'medium', status: 'open' });
      const itemB = db.create({ title: 'Plain B', priority: 'medium', status: 'open' });
      const highDownstream = db.create({ title: 'High downstream', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(highDownstream.id, itemA.id);

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(itemA.id);
    });

    it('should preserve priority dominance: high-priority item beats medium that blocks high', () => {
      // A is high priority, blocks nothing.
      // B is medium priority, blocks a high-priority downstream item.
      // A should still win because priority (weight 1000) dominates the boost (weight 500).
      // Note: we use status:'open' on the downstream to avoid triggering the
      // blocker-surfacing code path (which handles blocked items specially and
      // preempts scoring). The dependency edge still exists so the boost applies.
      const itemA = db.create({ title: 'High priority A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Medium unblocker B', priority: 'medium', status: 'open' });
      const highDownstream = db.create({ title: 'High downstream', priority: 'high', status: 'open' });
      db.addDependencyEdge(highDownstream.id, itemB.id);

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(itemA.id);
    });

    it('should prefer item blocking multiple high-priority items over one blocking a single high-priority item', () => {
      // A blocks two high-priority downstream items; B blocks one.
      // Both A and B are equal-priority. A should score higher.
      // Note: the boost uses max blocked priority, not count, so this tests
      // that the item blocking a critical item beats one blocking only high.
      const itemA = db.create({ title: 'Unblocker A', priority: 'medium', status: 'open' });
      const itemB = db.create({ title: 'Unblocker B', priority: 'medium', status: 'open' });
      const criticalDownstream = db.create({ title: 'Critical downstream', priority: 'critical', status: 'blocked' });
      const highDownstream = db.create({ title: 'High downstream', priority: 'high', status: 'blocked' });
      // A blocks a critical item (higher boost)
      db.addDependencyEdge(criticalDownstream.id, itemA.id);
      // B blocks only a high item (lower boost)
      db.addDependencyEdge(highDownstream.id, itemB.id);

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(itemA.id);
    });

    it('should fall through to existing heuristics when blocks-high-priority scores are equal', async () => {
      // A and B are equal priority and both block high-priority items (equal boost).
      // Tie-breaker should fall through to existing heuristics (older item first).
      const itemA = db.create({ title: 'Unblocker A', priority: 'medium', status: 'open' });
      const delay = () => new Promise(resolve => setTimeout(resolve, 10));
      await delay();
      const itemB = db.create({ title: 'Unblocker B', priority: 'medium', status: 'open' });
      const highDownstream1 = db.create({ title: 'High downstream 1', priority: 'high', status: 'blocked' });
      const highDownstream2 = db.create({ title: 'High downstream 2', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(highDownstream1.id, itemA.id);
      db.addDependencyEdge(highDownstream2.id, itemB.id);

      const result = db.findNextWorkItem();
      // A is older and has the same boost, so it should be selected
      expect(result.workItem?.id).toBe(itemA.id);
    });

    it('should NOT boost an item that only blocks low/medium priority items', async () => {
      // A blocks a low-priority item (no boost applied for low).
      // B blocks nothing but has the same priority.
      // Both should be treated equally (no boost), falling through to age heuristic.
      const itemA = db.create({ title: 'Blocks low A', priority: 'medium', status: 'open' });
      const lowDownstream = db.create({ title: 'Low downstream', priority: 'low', status: 'open' });
      db.addDependencyEdge(lowDownstream.id, itemA.id);
      const delay = () => new Promise(resolve => setTimeout(resolve, 10));
      await delay();
      const itemB = db.create({ title: 'Plain B', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      // A should be selected due to age (older), NOT because of a boost
      // The key assertion: A does NOT get a blocks-high-priority boost for low items
      expect(result.workItem?.id).toBe(itemA.id);

      // Verify the reverse: if B is older, B wins (no boost on A for medium downstream)
      const db2TempDir = createTempDir();
      const db2Path = createTempDbPath(db2TempDir);
      const db2JsonlPath = createTempJsonlPath(db2TempDir);
      const db2 = new WorklogDatabase('TEST', db2Path, db2JsonlPath, true, true);
      try {
        const olderB = db2.create({ title: 'Older plain B', priority: 'medium', status: 'open' });
        await delay();
        const newerA = db2.create({ title: 'Blocks medium A', priority: 'medium', status: 'open' });
        const medDownstream = db2.create({ title: 'Medium downstream', priority: 'medium', status: 'open' });
        db2.addDependencyEdge(medDownstream.id, newerA.id);

        const result2 = db2.findNextWorkItem();
        // B is older and A has no boost (medium doesn't qualify), so B wins
        expect(result2.workItem?.id).toBe(olderB.id);
      } finally {
        db2.close();
        cleanupTempDir(db2TempDir);
      }
    });

    it('should not boost for completed or deleted downstream items', async () => {
      // A blocks a critical downstream item that is already completed.
      // No boost should apply because the dependency is inactive.
      const delay = () => new Promise(resolve => setTimeout(resolve, 10));
      const itemA = db.create({ title: 'Unblocker A', priority: 'medium', status: 'open' });
      await delay();
      const itemB = db.create({ title: 'Plain B', priority: 'medium', status: 'open' });
      const completedCritical = db.create({ title: 'Completed critical', priority: 'critical', status: 'completed' });
      db.addDependencyEdge(completedCritical.id, itemA.id);

      const result = db.findNextWorkItem();
      // A should NOT get a boost because the downstream is completed
      // Both are equal priority with no boost; A is older so A still wins by age
      expect(result.workItem?.id).toBe(itemA.id);

      // Verify with deleted status too
      const db2TempDir = createTempDir();
      const db2Path = createTempDbPath(db2TempDir);
      const db2JsonlPath = createTempJsonlPath(db2TempDir);
      const db2 = new WorklogDatabase('TEST', db2Path, db2JsonlPath, true, true);
      try {
        const olderB2 = db2.create({ title: 'Older B', priority: 'medium', status: 'open' });
        await delay();
        const newerA2 = db2.create({ title: 'Blocks deleted A', priority: 'medium', status: 'open' });
        const deletedCritical = db2.create({ title: 'Deleted critical', priority: 'critical', status: 'deleted' });
        db2.addDependencyEdge(deletedCritical.id, newerA2.id);

        const result2 = db2.findNextWorkItem();
        // No boost for deleted items; B is older so B wins
        expect(result2.workItem?.id).toBe(olderB2.id);
      } finally {
        db2.close();
        cleanupTempDir(db2TempDir);
      }
    });

    // WL-0MQI1SX4W0018V9O: Stage 3 in-progress subtree filtering
    // Blocked children of in-progress parents should not have their blockers surfaced
    // because the parent represents the unit of work.

    it('should not surface dependency blocker for blocked child of in-progress parent', () => {
      // Parent (in-progress) -> Child (blocked) depends on Blocker (open)
      // Because the child is in an in-progress subtree, Stage 3 should NOT surface
      // the blocker. Instead, a higher-priority open competitor should win.
      const parent = db.create({ title: 'In-progress parent', priority: 'high', status: 'in-progress' });
      const child = db.create({ title: 'Blocked child', priority: 'high', status: 'blocked', parentId: parent.id });
      const blocker = db.create({ title: 'Dependency blocker', priority: 'low', status: 'open' });
      db.addDependencyEdge(child.id, blocker.id);
      const competitor = db.create({ title: 'Open competitor', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      // The blocker should NOT be surfaced because the blocked child is in
      // an in-progress parent subtree. The medium-priority competitor should win.
      expect(result.workItem?.id).toBe(competitor.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should not surface dependency blocker for blocked child of in-progress parent with no competitor', () => {
      // Parent (in-progress) -> Child (blocked) depends on Blocker (open)
      // No other open items exist. The blocker should NOT be surfaced because
      // the blocked child is in an in-progress subtree.
      const parent = db.create({ title: 'In-progress parent', priority: 'high', status: 'in-progress' });
      const child = db.create({ title: 'Blocked child', priority: 'high', status: 'blocked', parentId: parent.id });
      const blocker = db.create({ title: 'Dependency blocker', priority: 'low', status: 'open' });
      db.addDependencyEdge(child.id, blocker.id);

      const result = db.findNextWorkItem();
      // The blocker itself is a valid open item not in an in-progress subtree.
      // When no other open items exist, the blocker should be returned as the
      // next available work item (blocker-surfacing via Stage 3 is correctly
      // skipped, but the blocker still competes in Stage 5 as a normal candidate).
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(blocker.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should not surface child blocker for blocked child of in-progress parent', () => {
      // Parent (in-progress) -> Child (blocked, has its own child blocker)
      // The blocking child should NOT be surfaced because the blocked child
      // is in an in-progress subtree.
      const parent = db.create({ title: 'In-progress parent', priority: 'high', status: 'in-progress' });
      const child = db.create({ title: 'Blocked child', priority: 'high', status: 'blocked', parentId: parent.id });
      const childBlocker = db.create({ title: 'Blocking child', priority: 'low', status: 'open', parentId: child.id });
      const competitor = db.create({ title: 'Open competitor', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      // The child blocker should NOT be surfaced. Competitor should win.
      expect(result.workItem?.id).toBe(competitor.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should not surface blocker when blocker itself is in an in-progress subtree', () => {
      // BlockedItem (blocked, high) depends on Blocker (open, child of in-progress parent)
      // The blocker is in an in-progress subtree, so Stage 3 should filter it out.
      const blockerParent = db.create({ title: 'Blocker in-progress parent', priority: 'high', status: 'in-progress' });
      const blocker = db.create({ title: 'Blocker in subtree', priority: 'low', status: 'open', parentId: blockerParent.id });
      const blocked = db.create({ title: 'Blocked item', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);
      const competitor = db.create({ title: 'Open competitor', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      // The blocker should be filtered out because it's in an in-progress subtree.
      expect(result.workItem?.id).toBe(competitor.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should still surface blocker for blocked item NOT in in-progress subtree (regression guard)', () => {
      // Normal case: blocked item (not in in-progress subtree) with dependency blocker.
      // Stage 3 should still surface the blocker.
      const blocker = db.create({ title: 'Normal blocker', priority: 'medium', status: 'open' });
      const blocked = db.create({ title: 'Normal blocked item', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      const result = db.findNextWorkItem();
      // Existing behavior preserved: blocker should be surfaced.
      expect(result.workItem?.id).toBe(blocker.id);
      expect(result.reason).toContain('Blocking issue');
    });

    it('should surface blocker for critical blocked child of in-progress parent (critical exempt)', () => {
      // Critical items are exempt from in-progress subtree filtering.
      // A critical blocked item should still have its blocker surfaced.
      const parent = db.create({ title: 'In-progress parent', priority: 'high', status: 'in-progress' });
      const criticalChild = db.create({ title: 'Critical blocked child', priority: 'critical', status: 'blocked', parentId: parent.id });
      const blocker = db.create({ title: 'Critical blocker', priority: 'low', status: 'open' });
      db.addDependencyEdge(criticalChild.id, blocker.id);

      const result = db.findNextWorkItem();
      // Critical blocked items are handled by Stage 2 (critical escalation),
      // so the blocker should still be surfaced.
      expect(result.workItem?.id).toBe(blocker.id);
      expect(result.reason).toContain('Blocking issue');
    });

    it('should not surface blocker for deeply nested blocked item under in-progress grandparent', () => {
      // Grandparent (in-progress) -> Parent (open) -> Child (blocked, depends on Blocker)
      // The child is in an in-progress subtree (grandparent is in-progress).
      const grandparent = db.create({ title: 'In-progress grandparent', priority: 'high', status: 'in-progress' });
      const parent = db.create({ title: 'Open parent', priority: 'medium', status: 'open', parentId: grandparent.id });
      const child = db.create({ title: 'Blocked child', priority: 'high', status: 'blocked', parentId: parent.id });
      const blocker = db.create({ title: 'Dependency blocker', priority: 'low', status: 'open' });
      db.addDependencyEdge(child.id, blocker.id);
      const competitor = db.create({ title: 'Open competitor', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      // The child is in an in-progress subtree (grandparent), so blocker should not surface.
      expect(result.workItem?.id).toBe(competitor.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should not surface blocker when includeInProgress=true and blocked child is in in-progress subtree', () => {
      // Same as first test but with --include-in-progress. The child should still
      // be filtered from Stage 3 blocker surfacing.
      const parent = db.create({ title: 'In-progress parent', priority: 'high', status: 'in-progress' });
      const child = db.create({ title: 'Blocked child', priority: 'high', status: 'blocked', parentId: parent.id });
      const blocker = db.create({ title: 'Dependency blocker', priority: 'low', status: 'open' });
      db.addDependencyEdge(child.id, blocker.id);
      const competitor = db.create({ title: 'Open competitor', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem(undefined, undefined, false, undefined, true);
      // Even with includeInProgress=true, blocked children of in-progress parents
      // should not have their blockers surfaced. However, when includeInProgress
      // is true, the in-progress parent itself is a valid candidate and has the
      // highest effective priority (high).
      expect(result.workItem?.id).toBe(parent.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    // Fixture-based integration test (WL-0MM0B4V7L1YSH0W7)
    // Uses a generalized JSONL fixture inspired by ToneForge's dependency chain
    // to verify that findNextWorkItem prefers an unblocker over equal-priority peers.
    describe('fixture: next-ranking with dependency chain', () => {
      let fixtureTempDir: string;
      let fixtureDb: WorklogDatabase;

      beforeEach(() => {
        fixtureTempDir = createTempDir();
        const fixtureSource = path.resolve(__dirname, 'fixtures', 'next-ranking-fixture.jsonl');
        const fixtureJsonlPath = createTempJsonlPath(fixtureTempDir);
        const fixtureDbPath = createTempDbPath(fixtureTempDir);
        // Copy fixture to temp dir so the database can import it
        fs.copyFileSync(fixtureSource, fixtureJsonlPath);
        fixtureDb = new WorklogDatabase('FIX', fixtureDbPath, fixtureJsonlPath, false, true);
      });

      afterEach(() => {
        fixtureDb.close();
        cleanupTempDir(fixtureTempDir);
      });

      it('should prefer medium-priority unblocker over equal-priority peers when it blocks a high-priority item', () => {
        // Fixture layout:
        //   FIX-PHASE1 (high, completed) -- foundation
        //   FIX-PHASE2 (medium, open)    -- blocks FIX-PHASE3 (high)
        //   FIX-PHASE3 (high, open)      -- depends on FIX-PHASE2
        //   FIX-PHASE4 (high, open)      -- depends on FIX-PHASE3
        //   FIX-DISTRACT-A (medium, open) -- no dependencies
        //   FIX-DISTRACT-B (medium, open) -- no dependencies
        //
        // Without the scoring boost, FIX-PHASE2 would tie with FIX-DISTRACT-A
        // and FIX-DISTRACT-B on priority, and age tie-breakers would be used.
        // With the boost, FIX-PHASE2 should be preferred because it blocks
        // high-priority FIX-PHASE3.

        const result = fixtureDb.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        expect(result.workItem!.id).toBe('FIX-PHASE2');
      });

      it('should include unblocking context in the reason string', () => {
        const result = fixtureDb.findNextWorkItem();
        expect(result.reason).toBeDefined();
        // The reason should mention the scoring mechanism
        expect(result.reason!.toLowerCase()).toMatch(/score|rank|prior/);
      });

      it('should select a high-priority item over the medium unblocker when one exists and is unblocked', () => {
        // Regression guard: if we add an unblocked high-priority item that does NOT
        // depend on anything, it should still beat the medium-priority unblocker.
        // This verifies priority dominance is preserved.
        const highItem = fixtureDb.create({ title: 'Urgent high item', priority: 'high', status: 'open' });

        const result = fixtureDb.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        // The new unblocked high-priority item should beat the medium unblocker
        // because priority weight (1000) > blocks-high-priority boost (500)
        expect(result.workItem!.id).toBe(highItem.id);
      });
    });

    // WL-0MS964SIA0057ABR: orphan promotion is REMOVED — children whose
    // parent is closed/deleted are hidden entirely from wl next (strict
    // root-only). The old WL-0MM1CD2IJ1R2ZI5J promotion behavior is
    // superseded.
    describe('strict root-only: no orphan promotion (WL-0MS964SIA0057ABR)', () => {
      it('hides open child under completed parent (orphan not promoted)', () => {
        // Root epic (completed, sortIndex=100)
        //   └── Child feature (completed, sortIndex=200)
        //         └── Orphan task (open, low, sortIndex=300)
        // Root feature (open, medium, sortIndex=500)
        const rootEpic = db.create({ title: 'CLI Epic', priority: 'high', status: 'completed', issueType: 'epic', sortIndex: 100 });
        const childFeature = db.create({ title: 'Add dep command', priority: 'high', status: 'completed', parentId: rootEpic.id, sortIndex: 200 });
        const orphan = db.create({ title: 'Docs follow-up', priority: 'low', status: 'open', parentId: childFeature.id, sortIndex: 300 });
        const rootFeature = db.create({ title: 'Slash Command Palette', priority: 'medium', status: 'open', sortIndex: 500 });

        const result = db.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        // The orphan is hidden entirely — only the root feature is selectable.
        expect(result.workItem!.id).toBe(rootFeature.id);
      });

      it('hides deeply nested orphan when all ancestors are completed', () => {
        // Deep hierarchy: all ancestors completed
        // Root (completed, sortIndex=100)
        //   └── L1 (completed, sortIndex=200)
        //         └── L2 (completed, sortIndex=300)
        //               └── Orphan (open, medium, sortIndex=400)
        // Another root (open, medium, sortIndex=50)
        const root = db.create({ title: 'Root', priority: 'high', status: 'completed', sortIndex: 100 });
        const l1 = db.create({ title: 'L1', priority: 'high', status: 'completed', parentId: root.id, sortIndex: 200 });
        const l2 = db.create({ title: 'L2', priority: 'high', status: 'completed', parentId: l1.id, sortIndex: 300 });
        const orphan = db.create({ title: 'Deep orphan', priority: 'medium', status: 'open', parentId: l2.id, sortIndex: 400 });
        const anotherRoot = db.create({ title: 'Another root', priority: 'medium', status: 'open', sortIndex: 50 });

        const result = db.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        // Orphan is hidden; anotherRoot is the only root candidate.
        expect(result.workItem!.id).toBe(anotherRoot.id);
      });

      it('should not promote child when parent is still open (non-completed)', () => {
        // Parent is open (not completed) -> child stays under parent in hierarchy
        // Parent is returned directly (no descent into children)
        const parent = db.create({ title: 'Open parent', priority: 'medium', status: 'open', sortIndex: 100 });
        const child = db.create({ title: 'Child task', priority: 'medium', status: 'open', parentId: parent.id, sortIndex: 200 });
        const otherRoot = db.create({ title: 'Other root', priority: 'medium', status: 'open', sortIndex: 300 });

        const result = db.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        // Parent has lower sortIndex so it gets selected as root candidate
        expect(result.workItem!.id).toBe(parent.id);
      });

      it('hides orphan under deleted parent (not promoted)', () => {
        const deletedParent = db.create({ title: 'Deleted parent', priority: 'high', status: 'deleted', sortIndex: 100 });
        const orphan = db.create({ title: 'Orphan under deleted', priority: 'medium', status: 'open', parentId: deletedParent.id, sortIndex: 200 });
        const rootItem = db.create({ title: 'Root item', priority: 'medium', status: 'open', sortIndex: 50 });

        const result = db.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        // Orphan is hidden; rootItem is the only root candidate.
        expect(result.workItem!.id).toBe(rootItem.id);
      });

      it('returns null when only orphans exist under closed parents', () => {
        const closedParent = db.create({ title: 'Closed parent', priority: 'high', status: 'completed', sortIndex: 100 });
        db.create({ title: 'Only orphan', priority: 'medium', status: 'open', parentId: closedParent.id, sortIndex: 200 });

        const result = db.findNextWorkItem();
        // No root-level candidates remain — orphan is hidden entirely.
        expect(result.workItem).toBeNull();
      });

      it('never returns a child even for critical orphans under closed parents', () => {
        const closedParent = db.create({ title: 'Closed parent', priority: 'high', status: 'completed', sortIndex: 100 });
        db.create({ title: 'Critical orphan', priority: 'critical', status: 'open', parentId: closedParent.id, sortIndex: 200 });

        const result = db.findNextWorkItem();
        // Critical children are also hidden entirely (no promotion).
        expect(result.workItem).toBeNull();
      });
    });

    // WL-0MM1CD3SP1CO6NK9: epics should be included in candidate list
    describe('epic inclusion in candidate list', () => {
      it('should surface a childless epic as a candidate', () => {
        const epic = db.create({ title: 'Important epic', priority: 'high', status: 'open', issueType: 'epic', sortIndex: 100 });

        const result = db.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        expect(result.workItem!.id).toBe(epic.id);
      });

      it('should surface a critical childless epic over lower-priority non-epics', () => {
        const lowTask = db.create({ title: 'Low task', priority: 'low', status: 'open', sortIndex: 50 });
        const criticalEpic = db.create({ title: 'Critical epic', priority: 'critical', status: 'open', issueType: 'epic', sortIndex: 200 });

        const result = db.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        // Critical items get special handling and should be surfaced first
        expect(result.workItem!.id).toBe(criticalEpic.id);
      });

      it('should return the epic itself when children exist (no descent)', () => {
        const epic = db.create({ title: 'Parent epic', priority: 'high', status: 'open', issueType: 'epic', sortIndex: 100 });
        const child = db.create({ title: 'Child task', priority: 'medium', status: 'open', parentId: epic.id, sortIndex: 200 });

        const result = db.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        // Return the epic root candidate directly (no descent into children)
        expect(result.workItem!.id).toBe(epic.id);
      });

      it('should return the epic itself when all children are completed', () => {
        const epic = db.create({ title: 'Nearly done epic', priority: 'high', status: 'open', issueType: 'epic', sortIndex: 100 });
        db.create({ title: 'Done child', priority: 'medium', status: 'completed', parentId: epic.id, sortIndex: 200 });

        const result = db.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        expect(result.workItem!.id).toBe(epic.id);
      });
    });

    // WL-0MNUOLCB20008HVX: --stage filter tests
    describe('stage filter', () => {
      it('should filter by stage idea', () => {
        const ideaItem = db.create({ title: 'Idea task', priority: 'low', status: 'open', stage: 'idea' });
        db.create({ title: 'In progress task', priority: 'high', status: 'open', stage: 'in_progress' });
        db.create({ title: 'Done task', priority: 'critical', status: 'completed', stage: 'done' });

        const result = db.findNextWorkItem(undefined, undefined, false, 'idea');
        expect(result.workItem).not.toBeNull();
        expect(result.workItem!.id).toBe(ideaItem.id);
        expect(result.workItem!.stage).toBe('idea');
      });

      it('should filter by stage in_progress', () => {
        db.create({ title: 'Idea task', priority: 'critical', status: 'open', stage: 'idea' });
        const inProgressItem = db.create({ title: 'In progress task', priority: 'low', status: 'open', stage: 'in_progress' });

        const result = db.findNextWorkItem(undefined, undefined, false, 'in_progress');
        expect(result.workItem).not.toBeNull();
        expect(result.workItem!.id).toBe(inProgressItem.id);
        expect(result.workItem!.stage).toBe('in_progress');
      });

      it('should filter by stage done', () => {
        db.create({ title: 'Idea task', priority: 'critical', status: 'open', stage: 'idea' });
        const doneItem = db.create({ title: 'Done task', priority: 'low', status: 'completed', stage: 'done' });

        const result = db.findNextWorkItem(undefined, undefined, false, 'done');
        expect(result.workItem).not.toBeNull();
        expect(result.workItem!.id).toBe(doneItem.id);
        expect(result.workItem!.stage).toBe('done');
      });

      // WL-0MSGRJWRX0068W3W: done items excluded from default wl next results
      it('should exclude completed done items by default', () => {
        db.create({ title: 'Done task', priority: 'critical', status: 'completed', stage: 'done' });
        const openItem = db.create({ title: 'Open task', priority: 'low', status: 'open', stage: 'idea' });

        const result = db.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        expect(result.workItem!.id).toBe(openItem.id);
        expect(result.workItem!.stage).not.toBe('done');
      });

      it('should exclude done items even when status is not completed', () => {
        db.create({ title: 'Open status done', priority: 'critical', status: 'open', stage: 'done' });
        const openItem = db.create({ title: 'Open task', priority: 'low', status: 'open', stage: 'idea' });

        const result = db.findNextWorkItem();
        expect(result.workItem).not.toBeNull();
        expect(result.workItem!.id).toBe(openItem.id);
        expect(result.workItem!.stage).not.toBe('done');
      });

      it('should return null when only done items exist', () => {
        db.create({ title: 'Done only', priority: 'critical', status: 'completed', stage: 'done' });

        const result = db.findNextWorkItem();
        expect(result.workItem).toBeNull();
      });

      it('should exclude done items from batch results (WL-0MSGRJWRX0068W3W)', () => {
        db.create({ title: 'Done A', priority: 'critical', status: 'completed', stage: 'done' });
        db.create({ title: 'Done B', priority: 'high', status: 'open', stage: 'done' });
        const a = db.create({ title: 'Open A', priority: 'medium', status: 'open', stage: 'idea' });
        const b = db.create({ title: 'Open B', priority: 'low', status: 'open', stage: 'idea' });

        const results = db.findNextWorkItems(5);
        const ids = results.map(r => r.workItem?.id).filter(Boolean);
        expect(ids).toEqual([a.id, b.id]);
        for (const r of results) {
          if (r.workItem) {
            expect(r.workItem.stage).not.toBe('done');
          }
        }
      });

      it('should still return done items with explicit --stage done opt-in', () => {
        const doneItem = db.create({ title: 'Done opt-in', priority: 'low', status: 'completed', stage: 'done' });

        const result = db.findNextWorkItem(undefined, undefined, false, 'done');
        expect(result.workItem).not.toBeNull();
        expect(result.workItem!.id).toBe(doneItem.id);
      });

      it('should return null when no items match the stage filter', () => {
        db.create({ title: 'Idea task', priority: 'high', status: 'open', stage: 'idea' });
        db.create({ title: 'In progress task', priority: 'high', status: 'open', stage: 'in_progress' });

        const result = db.findNextWorkItem(undefined, undefined, false, 'plan_complete');
        expect(result.workItem).toBeNull();
      });

      it('should combine stage filter with assignee filter', () => {
        const janeIdea = db.create({ title: 'Jane idea task', priority: 'low', status: 'open', stage: 'idea', assignee: 'jane' });
        db.create({ title: 'Jane in progress task', priority: 'high', status: 'open', stage: 'in_progress', assignee: 'jane' });
        db.create({ title: 'John idea task', priority: 'critical', status: 'open', stage: 'idea', assignee: 'john' });

        const result = db.findNextWorkItem('jane', undefined, false, 'idea');
        expect(result.workItem).not.toBeNull();
        expect(result.workItem!.id).toBe(janeIdea.id);
      });

      it('should combine stage filter with search filter', () => {
        db.create({ title: 'Bug fix idea', priority: 'low', status: 'open', stage: 'idea' });
        db.create({ title: 'Feature idea', priority: 'high', status: 'open', stage: 'idea' });
        db.create({ title: 'Bug fix in progress', priority: 'critical', status: 'open', stage: 'in_progress' });

        const result = db.findNextWorkItem(undefined, 'bug', false, 'idea');
        expect(result.workItem).not.toBeNull();
        expect(result.workItem!.stage).toBe('idea');
        expect(result.workItem!.title.toLowerCase()).toContain('bug');
      });
    });

    describe('findNextWorkItems with stage filter', () => {
      it('should return multiple items filtered by stage', () => {
        const idea1 = db.create({ title: 'Idea task 1', priority: 'high', status: 'open', stage: 'idea' });
        const idea2 = db.create({ title: 'Idea task 2', priority: 'medium', status: 'open', stage: 'idea' });
        db.create({ title: 'In progress task', priority: 'critical', status: 'open', stage: 'in_progress' });

        const results = db.findNextWorkItems(3, undefined, undefined, false, 'idea');
        expect(results).toHaveLength(3);
        expect(results[0].workItem!.id).toBe(idea1.id);
        expect(results[1].workItem!.id).toBe(idea2.id);
        expect(results[2].workItem).toBeNull();
      });

      it('should handle batch mode with stage filter when items run out', () => {
        const idea1 = db.create({ title: 'Idea task 1', priority: 'high', status: 'open', stage: 'idea' });

        const results = db.findNextWorkItems(3, undefined, undefined, false, 'idea');
        expect(results).toHaveLength(3);
        expect(results[0].workItem!.id).toBe(idea1.id);
        expect(results[1].workItem).toBeNull();
        expect(results[2].workItem).toBeNull();
      });
    });
  });

});
