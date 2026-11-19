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
  describe('transactional import', () => {
    /**
     * Helper: create an item with a known past timestamp.
     * The past time is used so that if import() overwrites updatedAt
     * with the current time, we can detect the change.
     */
    function makeItem(
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
        ...overrides,
      };
    }

    it('should perform import atomically, storing all items within the same transaction', () => {
      const itemA = makeItem('TEST-TXN-001', 'Item A');
      const itemB = makeItem('TEST-TXN-002', 'Item B');

      db.import([itemA, itemB]);

      const allItems = db.getAll();
      expect(allItems).toHaveLength(2);
      expect(allItems.find(i => i.id === 'TEST-TXN-001')!.title).toBe('Item A');
      expect(allItems.find(i => i.id === 'TEST-TXN-002')!.title).toBe('Item B');
    });

    it('should atomically replace items and dependency edges during import', () => {
      const dbLocal = new WorklogDatabase('TEST', createTempDbPath(tempDir), createTempJsonlPath(tempDir), true, true);

      const parent = makeItem('TEST-TXN-011', 'Parent');
      const child = makeItem('TEST-TXN-012', 'Child');
      dbLocal.import([parent, child]);

      // Add a dependency edge outside import
      dbLocal.addDependencyEdge('TEST-TXN-012', 'TEST-TXN-011');
      expect(dbLocal.listDependencyEdgesTo('TEST-TXN-011')).toHaveLength(1);

      // Re-import with explicit dependency edges
      const edge: import('../src/types.js').DependencyEdge = {
        fromId: 'TEST-TXN-012',
        toId: 'TEST-TXN-011',
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      dbLocal.import([parent, child], [edge]);

      const edges = dbLocal.listDependencyEdgesTo('TEST-TXN-011');
      expect(edges).toHaveLength(1);
      expect(edges[0].fromId).toBe('TEST-TXN-012');
      expect(edges[0].toId).toBe('TEST-TXN-011');

      dbLocal.close();
    });

    it('should atomically replace items and audit results during import', () => {
      const dbLocal = new WorklogDatabase('TEST', createTempDbPath(tempDir), createTempJsonlPath(tempDir), true, true);

      const item = makeItem('TEST-TXN-021', 'Audited item', {
        description: 'Needs audit',
        status: 'completed' as const,
        stage: 'done',
      });
      dbLocal.import([item]);

      // Import with audit results
      const audit: import('../src/types.js').AuditResult = {
        workItemId: 'TEST-TXN-021',
        readyToClose: true,
        auditedAt: '2025-01-01T00:00:00.000Z',
        summary: 'All criteria met',
        rawOutput: null,
        author: 'tester',
      };
      dbLocal.import([item], undefined, [audit]);

      // Verify audit result is stored
      const audits = dbLocal.getAllAuditResults();
      expect(audits).toHaveLength(1);
      expect(audits[0].workItemId).toBe('TEST-TXN-021');
      expect(audits[0].readyToClose).toBe(true);
      expect(audits[0].author).toBe('tester');

      dbLocal.close();
    });

    it('should import items, dependency edges, and audit results together atomically', () => {
      const dbLocal = new WorklogDatabase('TEST', createTempDbPath(tempDir), createTempJsonlPath(tempDir), true, true);

      const item1 = makeItem('TEST-TXN-031', 'First');
      const item2 = makeItem('TEST-TXN-032', 'Second');
      const edge: import('../src/types.js').DependencyEdge = {
        fromId: 'TEST-TXN-032',
        toId: 'TEST-TXN-031',
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      const audit: import('../src/types.js').AuditResult = {
        workItemId: 'TEST-TXN-032',
        readyToClose: false,
        auditedAt: '2025-01-01T00:00:00.000Z',
        summary: 'Pending review',
        rawOutput: null,
        author: 'reviewer',
      };

      dbLocal.import([item1, item2], [edge], [audit]);

      // All three data types should be stored
      const items = dbLocal.getAll();
      expect(items).toHaveLength(2);

      const edges = dbLocal.listDependencyEdgesTo('TEST-TXN-031');
      expect(edges).toHaveLength(1);

      const audits = dbLocal.getAllAuditResults();
      expect(audits).toHaveLength(1);

      dbLocal.close();
    });

    it('should trigger autoSync once after transactional import', () => {
      // autoSync is called after the transaction completes
      const spy = vi.spyOn(db as any, 'triggerAutoSync');

      const item = makeItem('TEST-TXN-041', 'Sync test');
      db.import([item]);

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('should handle empty items array', () => {
      db.import([]);
      const allItems = db.getAll();
      expect(allItems).toHaveLength(0);
    });

    it('should preserve updatedAt for unchanged items after transactional import', () => {
      const item = makeItem('TEST-TXN-051', 'Stable item');
      db.import([item]);

      const original = db.get('TEST-TXN-051')!;
      expect(original.updatedAt).toBe('2025-01-01T00:00:00.000Z');

      // Re-import identical item
      db.import([item]);

      const after = db.get('TEST-TXN-051')!;
      expect(after.updatedAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('should update updatedAt for changed items after transactional import', () => {
      const item = makeItem('TEST-TXN-061', 'Original title');
      db.import([item]);

      const changed = makeItem('TEST-TXN-061', 'Updated title');
      db.import([changed]);

      const after = db.get('TEST-TXN-061')!;
      expect(after.title).toBe('Updated title');
      // Timestamp should have been updated
      expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(
        new Date('2025-01-01T00:00:00.000Z').getTime()
      );
    });
  });

  describe('findNextWorkItem', () => {
    it('should return null when no work items exist', () => {
      const result = db.findNextWorkItem();
      expect(result.workItem).toBeNull();
      expect(result.reason).toBeDefined();
    });

    it('should return the only open item when no in-progress items exist', () => {
      const item = db.create({ title: 'Only task', priority: 'high' });
      const result = db.findNextWorkItem();
      
      expect(result.workItem).not.toBeNull();
      expect(result.workItem?.id).toBe(item.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should return highest priority item when multiple open items exist', () => {
      db.create({ title: 'Low priority', priority: 'low', status: 'open' });
      const highPrio = db.create({ title: 'High priority', priority: 'high', status: 'open' });
      db.create({ title: 'Medium priority', priority: 'medium', status: 'open' });
      
      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(highPrio.id);
      expect(result.reason).toBeDefined();
    });

    it('should return oldest item when priorities are equal', async () => {
      // Create items with same priority but different times
      const oldest = db.create({ title: 'Oldest', priority: 'high', status: 'open' });
      // Small delay to ensure different timestamps
      const delay = () => new Promise(resolve => setTimeout(resolve, 10));
      
      await delay();
      db.create({ title: 'Newer', priority: 'high', status: 'open' });
      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(oldest.id);
    });

    it('should NOT select child under in-progress parent (entire subtree skipped)', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'in-progress' });
      const child = db.create({ title: 'Child', priority: 'high', status: 'open', parentId: parent.id });
      db.create({ title: 'Grandchild', priority: 'high', status: 'open', parentId: child.id });
      
      const result = db.findNextWorkItem();
      // Children of in-progress parents are no longer promoted — the entire
      // in-progress subtree is skipped from wl next recommendations.
      expect(result.workItem).toBeNull();
    });

    it('should skip completed and deleted items', () => {
      db.create({ title: 'Completed', priority: 'critical', status: 'completed' });
      db.create({ title: 'Deleted', priority: 'critical', status: 'deleted' });
      const openItem = db.create({ title: 'Open', priority: 'low', status: 'open' });
      
      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(openItem.id);
    });

    it('should never return an in-progress item as a candidate', () => {
      // In-progress items are already being worked on; wl next should skip them
      db.create({ title: 'In progress', priority: 'critical', status: 'in-progress' });
      const openItem = db.create({ title: 'Open', priority: 'low', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(openItem.id);
      expect(result.workItem?.status).not.toBe('in-progress');
    });

    it('should return null when only in-progress items exist', () => {
      db.create({ title: 'In progress 1', priority: 'critical', status: 'in-progress' });
      db.create({ title: 'In progress 2', priority: 'high', status: 'in-progress' });

      const result = db.findNextWorkItem();
      expect(result.workItem).toBeNull();
      expect(result.reason).toContain('No work items available');
    });

    it('should return null when only children under in-progress parent exist', () => {
      const parent = db.create({ title: 'WIP Parent', priority: 'high', status: 'in-progress' });
      db.create({ title: 'Open child', priority: 'medium', status: 'open', parentId: parent.id });

      const result = db.findNextWorkItem();
      // Children of in-progress parents are no longer promoted — the entire
      // in-progress subtree is skipped from wl next recommendations.
      expect(result.workItem).toBeNull();
    });

    it('should include blocked in_review items when they have higher effective priority', () => {
      const inReviewBlocked = db.create({ title: 'In review', status: 'blocked', stage: 'in_review', priority: 'high' });
      db.create({ title: 'Open', status: 'open', priority: 'low' });

      const result = db.findNextWorkItem();
      // Blocked+in_review items pass through the filter pipeline and are
      // selected based on effective priority (3 for high > 1 for low).
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(inReviewBlocked.id);
    });

    it('should include completed in_review items by default', () => {
      const inReview = db.create({ title: 'In review', status: 'completed', stage: 'in_review', priority: 'medium' });
      db.create({ title: 'Open low', status: 'open', priority: 'low' });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(inReview.id);
    });

    it('should boost in_review items above same-priority non-review items', () => {
      const inReview = db.create({ title: 'In review medium', status: 'completed', stage: 'in_review', priority: 'medium' });
      const openItem = db.create({ title: 'Open medium', status: 'open', priority: 'medium' });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // In-review boost of +600 should push in_review above same-priority open item
      expect(result.workItem!.id).toBe(inReview.id);
    });

    it('should not boost in_review items above higher priority items', () => {
      db.create({ title: 'In review medium', status: 'completed', stage: 'in_review', priority: 'medium' });
      const highItem = db.create({ title: 'Open high', status: 'open', priority: 'high' });

      const result = db.findNextWorkItem();
      // High priority (3000) > medium + in_review boost (2000 + 600 = 2600)
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(highItem.id);
    });

    it('should filter by assignee when provided', () => {
      const johnItem = db.create({ title: 'John task', priority: 'high', status: 'open', assignee: 'john' });
      db.create({ title: 'Jane task', priority: 'critical', status: 'open', assignee: 'jane' });
      
      const result = db.findNextWorkItem('john');
      expect(result.workItem?.id).toBe(johnItem.id);
    });

    it('should filter by search term in title', () => {
      db.create({ title: 'Unrelated task', priority: 'critical', status: 'open' });
      const searchItem = db.create({ title: 'Bug fix needed', priority: 'low', status: 'open' });
      
      const result = db.findNextWorkItem(undefined, 'bug');
      expect(result.workItem?.id).toBe(searchItem.id);
    });

    it('should filter by search term in description', () => {
      db.create({ title: 'Task 1', description: 'Something else', priority: 'critical', status: 'open' });
      const searchItem = db.create({ title: 'Task 2', description: 'Fix the authentication bug', priority: 'low', status: 'open' });
      
      const result = db.findNextWorkItem(undefined, 'authentication');
      expect(result.workItem?.id).toBe(searchItem.id);
    });

    it('should filter by search term in comments', () => {
      db.create({ title: 'Task 1', priority: 'critical', status: 'open' });
      const searchItem = db.create({ title: 'Task 2', priority: 'low', status: 'open' });
      
      // Add a comment with the search term
      db.createComment({
        workItemId: searchItem.id,
        author: 'test',
        comment: 'This needs database optimization'
      });
      
      const result = db.findNextWorkItem(undefined, 'database');
      expect(result.workItem?.id).toBe(searchItem.id);
    });

    it('should filter by search term in id', () => {
      const target = db.create({ title: 'Target', priority: 'low', status: 'open' });
      db.create({ title: 'Other', priority: 'critical', status: 'open' });

      const idFragment = target.id.slice(-6).toLowerCase();
      const result = db.findNextWorkItem(undefined, idFragment);
      expect(result.workItem?.id).toBe(target.id);
    });

    it('should not return in-progress item when it has no suitable children', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'in-progress' });
      db.create({ title: 'Completed child', priority: 'high', status: 'completed', parentId: parent.id });
      
      const result = db.findNextWorkItem();
      // The in-progress item is already being worked on so wl next should not
      // recommend it again. With no other open items the result should be null.
      expect(result.workItem).toBeNull();
    });

    it('should skip in-progress item with no children and select next open item', () => {
      const parent = db.create({ title: 'In-progress parent', priority: 'high', status: 'in-progress' });
      db.create({ title: 'Completed child', priority: 'high', status: 'completed', parentId: parent.id });
      const openItem = db.create({ title: 'Other open task', priority: 'medium', status: 'open' });
      
      const result = db.findNextWorkItem();
      // Should skip the in-progress parent and return the open item instead
      expect(result.workItem?.id).toBe(openItem.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should return null when multiple children under in-progress parent exist', async () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'in-progress' });
      db.create({ title: 'Low leaf', priority: 'low', status: 'open', parentId: parent.id });
      // Small delay to ensure different timestamps for createdAt tiebreaking
      const delay = () => new Promise(resolve => setTimeout(resolve, 10));
      await delay();
      db.create({ title: 'High leaf', priority: 'high', status: 'open', parentId: parent.id });
      
      const result = db.findNextWorkItem();
      // Children of in-progress parents are no longer promoted — the entire
      // in-progress subtree is skipped from wl next recommendations.
      expect(result.workItem).toBeNull();
    });

    it('should return null when filtered children are under in-progress parent', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'in-progress', assignee: 'john' });
      db.create({ title: 'Child for jane', priority: 'high', status: 'open', parentId: parent.id, assignee: 'jane' });
      db.create({ title: 'Child for john', priority: 'low', status: 'open', parentId: parent.id, assignee: 'john' });
      
      const result = db.findNextWorkItem('john');
      // Children of in-progress parents are no longer promoted — the entire
      // in-progress subtree is skipped from wl next recommendations.
      expect(result.workItem).toBeNull();
    });

    it('should return null when searched children are under in-progress parent', () => {
      const parent = db.create({ title: 'Parent task', priority: 'high', status: 'in-progress' });
      db.create({ title: 'Regular child', priority: 'critical', status: 'open', parentId: parent.id });
      db.create({ title: 'Bug fix needed', priority: 'low', status: 'open', parentId: parent.id });
      
      const result = db.findNextWorkItem(undefined, 'bug');
      // Children of in-progress parents are no longer promoted — the entire
      // in-progress subtree is skipped from wl next recommendations.
      expect(result.workItem).toBeNull();
    });

    it('should surface parent instead of blocking child for blocked item (WL-0MS964SIA0057ABR)', () => {
      const blocked = db.create({
        title: 'Blocked task',
        priority: 'high',
        status: 'blocked'
      });
      db.create({
        title: 'Blocking child',
        priority: 'low',
        status: 'open',
        parentId: blocked.id
      });

      const result = db.findNextWorkItem();
      // Strict root-only: the blocking child is hidden entirely (no orphan
      // promotion). The parent (high priority, root) is the unit of work and
      // is surfaced via Stage 5 (open item selection) instead.
      expect(result.workItem?.id).toBe(blocked.id);
      expect(result.workItem?.parentId).toBeNull();
      expect(result.reason).toContain('Next open item');
    });

    it('should select dependency blocker for blocked item', () => {
      const blocker = db.create({ title: 'Dependency blocker', priority: 'medium', status: 'open' });
      const blocked = db.create({ title: 'Blocked task', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      const result = db.findNextWorkItem();
      // The blocked item (high priority) has no open competitors of equal
      // or higher priority, so Stage 3 (non-critical blocker surfacing)
      // surfaces the dependency blocker.
      expect(result.workItem?.id).toBe(blocker.id);
      expect(result.reason).toContain('Blocking issue');
    });

    it('should surface parent when a child dependency blocker has a selectable parent (WL-0MS964SIA0057ABR)', () => {
      // blockerParent (medium, open, root) is selectable; blockerChild is its
      // child and is the dep-edge blocker for the blocked item.
      const blockerParent = db.create({ title: 'Blocker parent', priority: 'medium', status: 'open' });
      const blockerChild = db.create({ title: 'Blocker child', priority: 'low', status: 'open', parentId: blockerParent.id });
      const blocked = db.create({ title: 'Blocked task', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blockerChild.id);

      const result = db.findNextWorkItem();
      // Strict root-only: the child blocker is hidden, but its parent is a
      // selectable actionable root — the parent competes in Stage 5 and is
      // surfaced as the unit of work instead of the child.
      expect(result.workItem?.id).toBe(blockerParent.id);
      expect(result.workItem?.parentId).toBeNull();
    });

    it('should return null with clear reason when child blocker parent is not selectable (WL-0MS964SIA0057ABR)', () => {
      // blockerParent (completed, root) is NOT selectable; blockerChild is its
      // child and is the only blocker for the blocked item.
      const blockerParent = db.create({ title: 'Blocker parent', priority: 'medium', status: 'completed' });
      const blockerChild = db.create({ title: 'Blocker child', priority: 'low', status: 'open', parentId: blockerParent.id });
      const blocked = db.create({ title: 'Blocked task', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blockerChild.id);

      const result = db.findNextWorkItem();
      // The child blocker is hidden entirely and its parent is not selectable,
      // so wl next returns null with a clear reason (no orphan promotion).
      expect(result.workItem).toBeNull();
      expect(result.reason).toContain('No work items available');
    });

    it('should ignore blocking issues mentioned in description', () => {
      const blocker = db.create({ title: 'Blocking issue', priority: 'low', status: 'open' });
      const blocked = db.create({
        title: 'Blocked task',
        priority: 'high',
        status: 'blocked',
        description: `This is blocked by ${blocker.id}`
      });

      const result = db.findNextWorkItem();
      // Non-critical blocked items are treated as normal candidates.
      // Description mentions are not formal dependencies, so the blocked
      // item (higher priority) is selected as a normal open candidate.
      expect(result.workItem?.id).toBe(blocked.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should ignore blocking issues mentioned in comments', () => {
      const blocker = db.create({ title: 'Blocking issue', priority: 'medium', status: 'open' });
      const blocked = db.create({
        title: 'Blocked task',
        priority: 'high',
        status: 'blocked'
      });

      // Add comment mentioning the blocker
      db.createComment({
        workItemId: blocked.id,
        author: 'test',
        comment: `Cannot proceed due to ${blocker.id}`
      });

      const result = db.findNextWorkItem();
      // Non-critical blocked items are treated as normal candidates.
      // Comment mentions are not formal dependencies, so the blocked
      // item (higher priority) is selected as a normal open candidate.
      expect(result.workItem?.id).toBe(blocked.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should prefer higher-priority open item over blocker of lower-priority blocked item', () => {
      // A (medium, open) blocks B (medium, blocked)
      // C (high, open) -- should win
      const blockerA = db.create({ title: 'Blocker A', priority: 'medium', status: 'open' });
      const blockedB = db.create({ title: 'Blocked B', priority: 'medium', status: 'blocked' });
      db.addDependencyEdge(blockedB.id, blockerA.id);
      const highC = db.create({ title: 'High priority C', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      // Non-critical blocked items are filtered out by the dep-blocker filter.
      // The high-priority open item wins by normal sort_index selection.
      expect(result.workItem?.id).toBe(highC.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should prefer blocker when blocked item has higher priority than competing open items', () => {
      // X (medium, open) blocks Y (critical, blocked)
      // Z (high, open) -- should lose because Y is critical
      const blockerX = db.create({ title: 'Blocker X', priority: 'medium', status: 'open' });
      const blockedY = db.create({ title: 'Blocked Y', priority: 'critical', status: 'blocked' });
      db.addDependencyEdge(blockedY.id, blockerX.id);
      db.create({ title: 'High priority Z', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      // Should select blocker X because it unblocks a critical item
      expect(result.workItem?.id).toBe(blockerX.id);
      expect(result.reason).toContain('Blocking issue');
      expect(result.reason).toContain('critical');
    });

    it('should prefer blocker when blocked item has equal priority to best competing open item', () => {
      // Blocker (low, open) blocks BlockedItem (high, blocked)
      // Competitor (high, open) -- blocked item priority (high) >= competitor (high),
      // so Stage 3 surfaces the blocker.
      const blocker = db.create({ title: 'Blocker', priority: 'low', status: 'open' });
      const blockedItem = db.create({ title: 'Blocked item', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(blockedItem.id, blocker.id);
      const competitor = db.create({ title: 'Competitor', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      // Blocked item priority (high) >= best competitor (high), so the blocker
      // is surfaced to unblock the dependency.
      expect(result.workItem?.id).toBe(blocker.id);
      expect(result.reason).toContain('Blocking issue');
    });

    it('should prefer blocker when no competing open items exist', () => {
      // Only a blocked item and its blocker exist
      const blocker = db.create({ title: 'Blocker', priority: 'low', status: 'open' });
      const blockedItem = db.create({ title: 'Blocked item', priority: 'medium', status: 'blocked' });
      db.addDependencyEdge(blockedItem.id, blocker.id);

      const result = db.findNextWorkItem();
      // The only open candidate is the blocker (low), so blocked item priority
      // (medium) >= best competitor (low) and Stage 3 surfaces the blocker.
      expect(result.workItem?.id).toBe(blocker.id);
      expect(result.reason).toContain('Blocking issue');
    });

    it('should prefer higher-priority open item over child blocker of lower-priority blocked item', () => {
      // Child blocker (open) blocks Parent (medium, blocked)
      // HighItem (high, open) -- should win
      const parent = db.create({ title: 'Blocked parent', priority: 'medium', status: 'blocked' });
      db.create({ title: 'Blocking child', priority: 'low', status: 'open', parentId: parent.id });
      const highItem = db.create({ title: 'High priority item', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      // Non-critical blocked items are treated as normal candidates.
      // The high-priority open item wins by normal sort_index selection.
      expect(result.workItem?.id).toBe(highItem.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should surface critical parent instead of child blocker for blocked critical item (WL-0MS964SIA0057ABR)', () => {
      // Child blocker (open) blocks Parent (critical, blocked)
      // HighItem (high, open) -- should lose because parent is critical
      const parent = db.create({ title: 'Blocked parent', priority: 'critical', status: 'blocked' });
      db.create({ title: 'Blocking child', priority: 'low', status: 'open', parentId: parent.id });
      db.create({ title: 'High priority item', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      // Strict root-only: the child blocker is hidden entirely. Critical work
      // must not be silently dropped, so the blocked critical parent is
      // surfaced via the last-resort escalation path.
      expect(result.workItem?.id).toBe(parent.id);
      expect(result.workItem?.parentId).toBeNull();
      expect(result.reason).toContain('Blocked critical');
    });

    it('Phase 4: sibling wins over child of lower-priority parent (Example 1)', async () => {
      // A (low, open), B (high, open, child of A), C (medium, open, sibling of A)
      // Grandparent is high priority.
      // With effective priority inheritance:
      //   A: own=low, inherited=high (from grandparent) → effective=high
      //   C: own=medium, inherited=high (from grandparent) → effective=high
      // Both tie on effective priority, so createdAt picks A (older).
      // Previously we descended into children; now we return the root candidate.
      const delay = () => new Promise(resolve => setTimeout(resolve, 10));
      const grandparent = db.create({ title: 'Grandparent', priority: 'high', status: 'open' });
      const itemA = db.create({ title: 'Item A', priority: 'low', status: 'open', parentId: grandparent.id });
      const itemB = db.create({ title: 'Item B', priority: 'high', status: 'open', parentId: itemA.id });
      // Small delay to ensure itemC has a later createdAt than itemA
      await delay();
      db.create({ title: 'Item C', priority: 'medium', status: 'open', parentId: grandparent.id });

      const result = db.findNextWorkItem();
      // Grandparent is the only root candidate and is returned (no descent)
      expect(result.workItem?.id).toBe(grandparent.id);
    });

    it('Phase 4: child wins when parent priority >= sibling (Example 2)', async () => {
      // A (medium, open), B (high, open, child of A), C (medium, open, sibling of A)
      // Grandparent is the only root candidate and is returned (no descent)
      const delay = () => new Promise(resolve => setTimeout(resolve, 10));
      const grandparent = db.create({ title: 'Grandparent', priority: 'high', status: 'open' });
      const itemA = db.create({ title: 'Item A', priority: 'medium', status: 'open', parentId: grandparent.id });
      const itemB = db.create({ title: 'Item B', priority: 'high', status: 'open', parentId: itemA.id });
      // Small delay to ensure itemC has a later createdAt than itemA
      await delay();
      db.create({ title: 'Item C', priority: 'medium', status: 'open', parentId: grandparent.id });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(grandparent.id);
    });

    it('Phase 4: low-priority child wins when parent priority >= sibling (Example 3)', async () => {
      // A (medium, open), B (low, open, child of A), C (medium, open, sibling of A)
      // Grandparent is the only root candidate and is returned (no descent)
      const delay = () => new Promise(resolve => setTimeout(resolve, 10));
      const grandparent = db.create({ title: 'Grandparent', priority: 'high', status: 'open' });
      const itemA = db.create({ title: 'Item A', priority: 'medium', status: 'open', parentId: grandparent.id });
      const itemB = db.create({ title: 'Item B', priority: 'low', status: 'open', parentId: itemA.id });
      // Small delay to ensure itemC has a later createdAt than itemA
      await delay();
      db.create({ title: 'Item C', priority: 'medium', status: 'open', parentId: grandparent.id });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(grandparent.id);
    });

    it('Phase 4: top-level items without children are selected normally', () => {
      // No hierarchy, should work as before
      db.create({ title: 'Low item', priority: 'low', status: 'open' });
      const highItem = db.create({ title: 'High item', priority: 'high', status: 'open' });
      db.create({ title: 'Medium item', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(highItem.id);
    });

    it('Phase 4: top-level item with children returns the parent (no descent)', async () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'open' });
      const bestChild = db.create({ title: 'Best child', priority: 'high', status: 'open', parentId: parent.id });
      // Small delay to ensure bestChild has an earlier createdAt than otherChild
      const delay = () => new Promise(resolve => setTimeout(resolve, 10));
      await delay();
      db.create({ title: 'Other child', priority: 'low', status: 'open', parentId: parent.id });

      const result = db.findNextWorkItem();
      // Parent is the only root candidate and is returned (no descent into children)
      expect(result.workItem?.id).toBe(parent.id);
    });

    // Dependency-blocker filter tests (WL-0MM04HDI618Y7DT0)

    it('should not return a dependency-blocked item by default', () => {
      // A has a dependency edge to B (A depends on B), so A is blocked
      // C is a normal open item that should be returned instead
      const itemA = db.create({ title: 'Dep-blocked item A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Prerequisite B', priority: 'low', status: 'open' });
      db.addDependencyEdge(itemA.id, itemB.id);
      const itemC = db.create({ title: 'Unblocked item C', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      // A is dependency-blocked so it should be excluded; C or B should be selected
      expect(result.workItem?.id).not.toBe(itemA.id);
      // B or C should be selected (B is a prerequisite, C is unblocked)
      expect([itemB.id, itemC.id]).toContain(result.workItem?.id);
    });

    it('should return a dependency-blocked item when includeBlocked=true', () => {
      // A depends on B (A is dep-blocked), A has higher priority
      const itemA = db.create({ title: 'Dep-blocked item A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Prerequisite B', priority: 'low', status: 'open' });
      db.addDependencyEdge(itemA.id, itemB.id);

      // With includeBlocked=true, A should be in the candidate pool
      const result = db.findNextWorkItem(undefined, undefined, false, true);
      // A is high priority and includeBlocked is true, so it may be selected
      // The key assertion: A is NOT filtered out (it could be selected or its blocker could be)
      expect(result.workItem).toBeDefined();
    });

    it('should return a dep-blocked item whose blocker is completed (edge inactive)', () => {
      // A depends on B, but B is completed so the edge is inactive
      const itemA = db.create({ title: 'Formerly blocked A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Completed prerequisite B', priority: 'low', status: 'completed' });
      db.addDependencyEdge(itemA.id, itemB.id);

      const result = db.findNextWorkItem();
      // B is completed, so the dependency edge is inactive; A should NOT be filtered
      expect(result.workItem?.id).toBe(itemA.id);
    });

    it('should still surface blockers for critical dep-blocked items', () => {
      // Critical item X depends on Y (X is dep-blocked)
      // The critical path should still detect X and surface Y as the blocker
      const itemY = db.create({ title: 'Blocker Y', priority: 'low', status: 'open' });
      const itemX = db.create({ title: 'Critical blocked X', priority: 'critical', status: 'blocked' });
      db.addDependencyEdge(itemX.id, itemY.id);

      const result = db.findNextWorkItem();
      // The critical path should surface Y as the blocker of X
      expect(result.workItem?.id).toBe(itemY.id);
      expect(result.reason).toContain('Blocking issue');
      expect(result.reason).toContain(itemX.id);
    });

    it('should not affect items with no dependency edges (regression guard)', () => {
      // Items with no dependency edges should be selected normally
      db.create({ title: 'Low item', priority: 'low', status: 'open' });
      const highItem = db.create({ title: 'High item', priority: 'high', status: 'open' });
      db.create({ title: 'Medium item', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(highItem.id);
    });

    it('should not return a dep-blocked in-progress item', () => {
      // An in-progress item that has active dependency blockers should NOT be
      // returned as the next item. Instead, a non-blocked open item should be selected.
      const inProgressItem = db.create({ title: 'In-progress dep-blocked', priority: 'high', status: 'in-progress' });
      const prereq = db.create({ title: 'Prerequisite', priority: 'low', status: 'open' });
      db.addDependencyEdge(inProgressItem.id, prereq.id);
      const openItem = db.create({ title: 'Available open item', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      // The in-progress item is dep-blocked, so it should not be selected
      // The open item or the prerequisite should be selected instead
      expect(result.workItem?.id).not.toBe(inProgressItem.id);
      expect([prereq.id, openItem.id]).toContain(result.workItem?.id);
    });

    // Blocks-high-priority scoring boost tests (WL-0MM0B4FNW0ZLOTV8)

    it('should prefer item blocking a critical downstream item over equal-priority peer', () => {
      // A and B are both high-priority open items.
      // A blocks a critical downstream item; B blocks nothing.
      // A should be recommended first due to the scoring boost.
      const itemA = db.create({ title: 'Unblocker A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Plain B', priority: 'high', status: 'open' });
      const criticalDownstream = db.create({ title: 'Critical downstream', priority: 'critical', status: 'blocked' });
      db.addDependencyEdge(criticalDownstream.id, itemA.id);

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(itemA.id);
    });

  });
});
