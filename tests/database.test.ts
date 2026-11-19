/**
 * Tests for WorklogDatabase
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
  describe('create', () => {
    it('should create a work item with required fields', () => {
      const item = db.create({
        title: 'Test task',
      });

      expect(item).toBeDefined();
      expect(item.id).toMatch(/^TEST-[A-Z0-9]+$/);
      expect(item.title).toBe('Test task');
      expect(item.description).toBe('');
      expect(item.status).toBe('open');
      expect(item.priority).toBe('medium');
      expect(item.sortIndex).toBe(0);
      expect(item.parentId).toBe(null);
      expect(item.tags).toEqual([]);
      expect(item.assignee).toBe('');
      expect(item.stage).toBe('');
      expect(item.issueType).toBe('');
      expect(item.createdBy).toBe('');
      expect(item.deletedBy).toBe('');
      expect(item.deleteReason).toBe('');
      expect(item.risk).toBe('');
      expect(item.effort).toBe('');
      expect(item.githubIssueNumber).toBeUndefined();
      expect(item.githubIssueId).toBeUndefined();
      expect(item.githubIssueUpdatedAt).toBeUndefined();
      expect(item.createdAt).toBeDefined();
      expect(item.updatedAt).toBeDefined();
    });

    it('should create a work item with all optional fields', () => {
      const item = db.create({
        title: 'Full task',
        description: 'A complete description',
        status: 'in-progress',
        priority: 'high',
        tags: ['feature', 'backend'],
        assignee: 'john.doe',
        stage: 'development',
        issueType: 'task',
        createdBy: 'john.doe',
      });

      expect(item.title).toBe('Full task');
      expect(item.description).toBe('A complete description');
      expect(item.status).toBe('in-progress');
      expect(item.priority).toBe('high');
      expect(item.tags).toEqual(['feature', 'backend']);
      expect(item.assignee).toBe('john.doe');
      expect(item.stage).toBe('development');
      expect(item.issueType).toBe('task');
      expect(item.createdBy).toBe('john.doe');
    });

    it('should create a work item with a structured audit', () => {
      const item = db.create({
        title: 'Audited item',
        description: 'Success criteria: ship it',
      });
      // Write audit to the audit_results table
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: new Date().toISOString(),
        author: 'tester',
        summary: 'Ready to close: Yes',
        rawOutput: null,
      });

      const auditResult = db.getAuditResult(item.id);
      expect(auditResult).not.toBeNull();
      expect(auditResult?.author).toBe('tester');
      expect(auditResult?.summary).toBe('Ready to close: Yes');
    });

    it('should set updatedAt = auditedAt atomically on saveAuditResult (WL-0MT8KTE3E001Q1D9)', () => {
      const item = db.create({
        title: 'Audited item for freshness test',
        description: 'Testing audit freshness clock',
      });
      const auditedAt = new Date().toISOString();
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt: auditedAt,
        author: 'tester',
        summary: 'Ready to close: Yes',
        rawOutput: null,
      });
      const updated = db.get(item.id);
      expect(updated?.updatedAt).toBe(auditedAt);
    });

    it('audit-then-comment ordering: comment moves activityAt only, audit stays fresh (WL-0MTHRY9NP004R9MC)', () => {
      const item = db.create({ title: 'Ordering test', description: 'audit then comment' });
      const auditedAt = new Date().toISOString();
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt,
        author: 'tester',
        summary: 'Ready to close: Yes',
        rawOutput: null,
      });
      const beforeComment = db.get(item.id)!;
      db.createComment({ workItemId: item.id, author: 'tester', comment: 'Follow-up note' });
      const itemAfterComment = db.get(item.id)!;
      const auditResult = db.getAuditResult(item.id)!;
      // Post-audit comment activity bumps activityAt only; the audit-relevant
      // content timestamp is unchanged, so the audit stays fresh
      // (WL-0MUBVH6JM0093KVM).
      expect(itemAfterComment.updatedAt).toBe(beforeComment.updatedAt);
      expect(itemAfterComment.activityAt).toBeDefined();
      expect(isAuditFresh(auditResult.auditedAt, itemAfterComment.updatedAt)).toBe(true);
    });

    it('comment after audit keeps audit fresh via isAuditFresh (WL-0MTHRSZJK008ATDB)', () => {
      const item = db.create({ title: 'Freshness regression: comment after audit', description: 'regression' });
      const auditedAt = new Date().toISOString();
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: true,
        auditedAt,
        author: 'tester',
        summary: 'Ready to close: Yes',
        rawOutput: null,
      });
      const beforeComment = db.get(item.id)!;
      db.createComment({ workItemId: item.id, author: 'tester', comment: 'Just a comment after the audit' });
      const afterComment = db.get(item.id)!;
      const auditResult = db.getAuditResult(item.id)!;
      expect(auditResult.auditedAt).toBe(auditedAt);
      // The comment does not move updatedAt, so the audit is fresh and the TUI
      // keeps the passed icon (not stale).
      expect(afterComment.updatedAt).toBe(beforeComment.updatedAt);
      expect(isAuditFresh(auditResult.auditedAt, afterComment.updatedAt)).toBe(true);
    });

    it('should create a work item with a parent', () => {
      const parent = db.create({ title: 'Parent task' });
      const child = db.create({
        title: 'Child task',
        parentId: parent.id,
      });

      expect(child.parentId).toBe(parent.id);
    });

    it('should generate unique IDs for multiple items', () => {
      const item1 = db.create({ title: 'Task 1' });
      const item2 = db.create({ title: 'Task 2' });
      const item3 = db.create({ title: 'Task 3' });

      expect(item1.id).not.toBe(item2.id);
      expect(item2.id).not.toBe(item3.id);
      expect(item1.id).not.toBe(item3.id);
    });
  });

  describe('status normalization on write', () => {
    it('should normalize underscore-form status on create', () => {
      // Use 'as any' to simulate legacy/user input with underscore-form status
      const item = db.create({ title: 'Test', status: 'in_progress' as any });
      expect(item.status).toBe('in-progress');

      // Verify persisted value is also normalized
      const retrieved = db.get(item.id);
      expect(retrieved?.status).toBe('in-progress');
    });

    it('should normalize underscore-form status on update', () => {
      const item = db.create({ title: 'Test' });
      expect(item.status).toBe('open');

      const updated = db.update(item.id, { status: 'in_progress' as any });
      expect(updated?.status).toBe('in-progress');

      // Verify persisted value is also normalized
      const retrieved = db.get(item.id);
      expect(retrieved?.status).toBe('in-progress');
    });

    it('should leave already-hyphenated status unchanged', () => {
      const item = db.create({ title: 'Test', status: 'in-progress' });
      expect(item.status).toBe('in-progress');
    });

    it('should normalize status when querying with underscore form', () => {
      db.create({ title: 'Test', status: 'in-progress' });
      // Query using underscore form — should still find the item
      const results = db.list({ status: ['in_progress'] as any });
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('in-progress');
    });
  });

  describe('get', () => {
    it('should retrieve a work item by ID', () => {
      const created = db.create({ title: 'Test task' });
      const retrieved = db.get(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.title).toBe('Test task');
    });

    it('should return null for non-existent ID', () => {
      const result = db.get('TEST-NONEXISTENT');
      expect(result).toBe(null);
    });
  });

  describe('list', () => {
    beforeEach(() => {
      // Create test data
      db.create({ title: 'Task 1', status: 'open', priority: 'high' });
      db.create({ title: 'Task 2', status: 'in-progress', priority: 'medium' });
      db.create({ title: 'Task 3', status: 'completed', priority: 'low' });
      db.create({ title: 'Task 4', status: 'open', priority: 'high', tags: ['backend'] });
      db.create({ title: 'Task 5', status: 'blocked', priority: 'critical', assignee: 'alice' });
    });

    it('should list all work items when no filters are provided', () => {
      const items = db.list({});
      expect(items).toHaveLength(5);
    });

    it('should filter by status', () => {
      const openItems = db.list({ status: ['open'] });
      expect(openItems).toHaveLength(2);
      openItems.forEach(item => expect(item.status).toBe('open'));
    });

    it('should filter by multiple statuses', () => {
      const items = db.list({ status: ['open', 'completed'] });
      expect(items).toHaveLength(3);
      const statuses = items.map(item => item.status);
      expect(statuses.filter(s => s === 'open')).toHaveLength(2);
      expect(statuses.filter(s => s === 'completed')).toHaveLength(1);
    });

    it('should filter by priority', () => {
      const highPriorityItems = db.list({ priority: 'high' });
      expect(highPriorityItems).toHaveLength(2);
      highPriorityItems.forEach(item => expect(item.priority).toBe('high'));
    });

    it('should filter by status and priority', () => {
      const items = db.list({ status: ['open'], priority: 'high' });
      expect(items).toHaveLength(2);
      items.forEach(item => {
        expect(item.status).toBe('open');
        expect(item.priority).toBe('high');
      });
    });

    it('should combine multiple statuses with priority', () => {
      const items = db.list({ status: ['open', 'blocked'], priority: 'high' });
      expect(items).toHaveLength(2);
      const statuses = items.map(item => item.status);
      expect(statuses.filter(s => s === 'open')).toHaveLength(2);
      items.forEach(item => {
        expect(item.priority).toBe('high');
      });
    });

    it('should filter by tags', () => {
      const items = db.list({ tags: ['backend'] });
      expect(items).toHaveLength(1);
      expect(items[0].tags).toContain('backend');
    });

    it('should filter by assignee', () => {
      const items = db.list({ assignee: 'alice' });
      expect(items).toHaveLength(1);
      expect(items[0].assignee).toBe('alice');
    });

    it('should filter by parentId null (root items)', () => {
      const items = db.list({ parentId: null });
      expect(items).toHaveLength(5);
    });

    it('should filter rootOnly to items without a parent (WL-0MS964SIA0057ABR)', () => {
      const parent = db.create({ title: 'Parent', status: 'open', priority: 'medium' });
      db.create({ title: 'Child', status: 'open', priority: 'medium', parentId: parent.id });
      const items = db.list({ rootOnly: true });
      expect(items.length).toBeGreaterThan(0);
      items.forEach(item => expect(item.parentId).toBeNull());
      expect(items.some(item => item.id === parent.id)).toBe(true);
      expect(items.some(item => item.title === 'Child')).toBe(false);
    });

    it('rootOnly combines with other filters (WL-0MS964SIA0057ABR)', () => {
      const parent = db.create({ title: 'Critical parent', status: 'open', priority: 'critical' });
      db.create({ title: 'Critical child', status: 'open', priority: 'critical', parentId: parent.id });
      db.create({ title: 'Low root', status: 'open', priority: 'low' });
      const items = db.list({ rootOnly: true, priority: 'critical' });
      // Seeded Task 5 (critical) is also a root item, so at least the new
      // critical parent and Task 5 must match; the critical child must not.
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(items.every(item => item.parentId === null)).toBe(true);
      expect(items.some(item => item.title === 'Critical parent')).toBe(true);
      expect(items.some(item => item.title === 'Critical child')).toBe(false);
    });

    it('rootOnly does not affect --parent child lookup (WL-0MS964SIA0057ABR)', () => {
      const parent = db.create({ title: 'Parent', status: 'open', priority: 'medium' });
      const child = db.create({ title: 'Child', status: 'open', priority: 'medium', parentId: parent.id });
      const items = db.list({ parentId: parent.id });
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(child.id);
    });

  });

  describe('update', () => {
    it('should update a work item title', async () => {
      const item = db.create({ title: 'Original title' });
      // Wait a moment to ensure updatedAt timestamp will be different
      await new Promise(resolve => setTimeout(resolve, 10));
      const updated = db.update(item.id, { title: 'Updated title' });

      expect(updated).toBeDefined();
      expect(updated?.title).toBe('Updated title');
      expect(updated?.id).toBe(item.id);
      expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(item.updatedAt).getTime()
      );
    });

    it('should update multiple fields', () => {
      const item = db.create({ title: 'Task' });
      const updated = db.update(item.id, {
        title: 'Updated task',
        status: 'in-progress',
        priority: 'high',
        description: 'New description',
      });

      expect(updated?.title).toBe('Updated task');
      expect(updated?.status).toBe('in-progress');
      expect(updated?.priority).toBe('high');
      expect(updated?.description).toBe('New description');
    });

    it('should update structured audit fields', () => {
      const item = db.create({ title: 'Task' });
      // Write audit to the audit_results table
      db.saveAuditResult({
        workItemId: item.id,
        readyToClose: false,
        auditedAt: new Date().toISOString(),
        author: 'updater',
        summary: 'Ready to close: No',
        rawOutput: null,
      });

      const auditResult = db.getAuditResult(item.id);
      expect(auditResult).not.toBeNull();
      expect(auditResult?.author).toBe('updater');
      expect(auditResult?.summary).toBe('Ready to close: No');
    });

    it('should return null for non-existent ID', () => {
      const result = db.update('TEST-NONEXISTENT', { title: 'Updated' });
      expect(result).toBe(null);
    });
  });

  describe('delete', () => {
    it('should delete a work item', () => {
      const item = db.create({ title: 'To delete' });
      const deleted = db.delete(item.id);

      expect(deleted).toBe(true);
      const updated = db.get(item.id);
      expect(updated).not.toBe(null);
      expect(updated?.status).toBe('deleted');
      expect(updated?.stage).toBe('');
    });

    it('should not regress deleted status after dependent reconciliation', () => {
      const blocker = db.create({ title: 'Blocker' });
      const dependent = db.create({ title: 'Dependent' });
      db.addDependencyEdge(dependent.id, blocker.id);

      const deleted = db.delete(blocker.id);
      expect(deleted).toBe(true);

      const updated = db.get(blocker.id);
      expect(updated?.status).toBe('deleted');
    });

    it('should return false for non-existent ID', () => {
      const result = db.delete('TEST-NONEXISTENT');
      expect(result).toBe(false);
    });

    it('should recursively delete children when deleting a parent', () => {
      const parent = db.create({ title: 'Parent' });
      const child1 = db.create({ title: 'Child 1', parentId: parent.id });
      const child2 = db.create({ title: 'Child 2', parentId: parent.id });

      const deleted = db.delete(parent.id);
      expect(deleted).toBe(true);

      // Parent should be marked as deleted
      expect(db.get(parent.id)?.status).toBe('deleted');
      // Children should also be marked as deleted
      expect(db.get(child1.id)?.status).toBe('deleted');
      expect(db.get(child2.id)?.status).toBe('deleted');
    });

    it('should recursively delete nested descendants (grandchildren)', () => {
      const grandparent = db.create({ title: 'Grandparent' });
      const parent = db.create({ title: 'Parent', parentId: grandparent.id });
      const child = db.create({ title: 'Child', parentId: parent.id });

      const deleted = db.delete(grandparent.id);
      expect(deleted).toBe(true);

      expect(db.get(grandparent.id)?.status).toBe('deleted');
      expect(db.get(parent.id)?.status).toBe('deleted');
      expect(db.get(child.id)?.status).toBe('deleted');
    });

    it('should not delete siblings or unrelated items when deleting a parent', () => {
      const parent1 = db.create({ title: 'Parent 1' });
      const parent2 = db.create({ title: 'Parent 2' });
      const childOf1 = db.create({ title: 'Child of 1', parentId: parent1.id });
      const childOf2 = db.create({ title: 'Child of 2', parentId: parent2.id });
      const unrelated = db.create({ title: 'Unrelated' });

      db.delete(parent1.id);

      // parent1 and its child should be deleted
      expect(db.get(parent1.id)?.status).toBe('deleted');
      expect(db.get(childOf1.id)?.status).toBe('deleted');
      // parent2, its child, and unrelated should remain
      expect(db.get(parent2.id)?.status).not.toBe('deleted');
      expect(db.get(childOf2.id)?.status).not.toBe('deleted');
      expect(db.get(unrelated.id)?.status).not.toBe('deleted');
    });

    it('should handle delete with no children (no regression)', () => {
      const item = db.create({ title: 'No children' });
      const deleted = db.delete(item.id);

      expect(deleted).toBe(true);
      expect(db.get(item.id)?.status).toBe('deleted');
    });
  });

  describe('getChildren', () => {
    it('should return children of a work item', () => {
      const parent = db.create({ title: 'Parent' });
      const child1 = db.create({ title: 'Child 1', parentId: parent.id });
      const child2 = db.create({ title: 'Child 2', parentId: parent.id });
      db.create({ title: 'Other task' }); // Unrelated task

      const children = db.getChildren(parent.id);
      expect(children).toHaveLength(2);
      expect(children.map(c => c.id)).toContain(child1.id);
      expect(children.map(c => c.id)).toContain(child2.id);
    });

    it('should return empty array for item with no children', () => {
      const item = db.create({ title: 'No children' });
      const children = db.getChildren(item.id);
      expect(children).toEqual([]);
    });
  });

  describe('getDescendants', () => {
    it('should return all descendants including nested children', () => {
      const parent = db.create({ title: 'Parent' });
      const child1 = db.create({ title: 'Child 1', parentId: parent.id });
      const child2 = db.create({ title: 'Child 2', parentId: parent.id });
      const grandchild = db.create({ title: 'Grandchild', parentId: child1.id });

      const descendants = db.getDescendants(parent.id);
      expect(descendants).toHaveLength(3);
      expect(descendants.map(d => d.id)).toContain(child1.id);
      expect(descendants.map(d => d.id)).toContain(child2.id);
      expect(descendants.map(d => d.id)).toContain(grandchild.id);
    });
  });

  describe('cascadePriorityDowngrade', () => {
    it('should downgrade critical children to high when parent is downgraded', () => {
      const parent = db.create({ title: 'Parent', priority: 'critical' });
      const child1 = db.create({ title: 'Child 1', priority: 'critical', parentId: parent.id });
      const child2 = db.create({ title: 'Child 2', priority: 'critical', parentId: parent.id });

      const downgraded = db.cascadePriorityDowngrade(parent.id, 'high');

      expect(downgraded.map(c => c.id).sort()).toEqual([child1.id, child2.id].sort());
      expect(db.get(child1.id)?.priority).toBe('high');
      expect(db.get(child2.id)?.priority).toBe('high');
      // Parent itself is untouched by the cascade
      expect(db.get(parent.id)?.priority).toBe('critical');
    });

    it('should leave children already at high or below unaffected', () => {
      const parent = db.create({ title: 'Parent', priority: 'critical' });
      const highChild = db.create({ title: 'High child', priority: 'high', parentId: parent.id });
      const mediumChild = db.create({ title: 'Medium child', priority: 'medium', parentId: parent.id });
      const lowChild = db.create({ title: 'Low child', priority: 'low', parentId: parent.id });
      const criticalChild = db.create({ title: 'Critical child', priority: 'critical', parentId: parent.id });

      const downgraded = db.cascadePriorityDowngrade(parent.id, 'medium');

      expect(downgraded.map(c => c.id)).toEqual([criticalChild.id]);
      expect(db.get(highChild.id)?.priority).toBe('high');
      expect(db.get(mediumChild.id)?.priority).toBe('medium');
      expect(db.get(lowChild.id)?.priority).toBe('low');
      expect(db.get(criticalChild.id)?.priority).toBe('high');
    });

    it('should return an empty array when no critical children exist', () => {
      const parent = db.create({ title: 'Parent', priority: 'critical' });
      const child = db.create({ title: 'Child', priority: 'high', parentId: parent.id });

      const downgraded = db.cascadePriorityDowngrade(parent.id, 'high');

      expect(downgraded).toEqual([]);
      expect(db.get(child.id)?.priority).toBe('high');
    });

    it('should be a no-op when new priority is still critical (critical to critical)', () => {
      const parent = db.create({ title: 'Parent', priority: 'critical' });
      const child = db.create({ title: 'Child', priority: 'critical', parentId: parent.id });

      const downgraded = db.cascadePriorityDowngrade(parent.id, 'critical');

      expect(downgraded).toEqual([]);
      expect(db.get(child.id)?.priority).toBe('critical');
    });

    it('should only downgrade direct children, not grandchildren', () => {
      const parent = db.create({ title: 'Parent', priority: 'critical' });
      const child = db.create({ title: 'Child', priority: 'critical', parentId: parent.id });
      const grandchild = db.create({ title: 'Grandchild', priority: 'critical', parentId: child.id });

      const downgraded = db.cascadePriorityDowngrade(parent.id, 'high');

      expect(downgraded.map(c => c.id)).toEqual([child.id]);
      expect(db.get(child.id)?.priority).toBe('high');
      expect(db.get(grandchild.id)?.priority).toBe('critical');
    });
  });

  // -------------------------------------------------------------------------
  // cascadePriorityPromote — contract pins (test-first slice WL-0MWETWBS3006D4OI,
  // primitive landed with WL-0MWETWNSO001UL2M)
  //
  // Contract (parent WL-0MWDD2JE6006CL7I, operator answer Q1-B): a `critical`
  // item promotes every non-critical ancestor to `critical`, transitively to
  // the root.
  //
  // Pinned semantics:
  //   * only ancestors are promoted; the critical item itself is untouched
  //   * the walk runs from the direct parent up to the root (nearest first)
  //   * an ancestor already at `critical` is skipped but does NOT stop the
  //     walk — higher non-critical ancestors are still promoted to the root
  //   * returns the promoted ancestors as `WorkItem[]` in walk order, empty
  //     when nothing was promoted
  //   * no-op when the item is not `critical` or has no parent
  //   * unrelated branches are never touched
  // -------------------------------------------------------------------------
  describe('cascadePriorityPromote', () => {
    it('should promote the direct parent of a critical child', () => {
      const parent = db.create({ title: 'Parent', priority: 'medium' });
      const child = db.create({ title: 'Critical child', priority: 'critical', parentId: parent.id });

      const promoted = cascadePriorityPromote(db, child.id);

      expect(promoted.map(a => a.id)).toEqual([parent.id]);
      expect(promoted[0].priority).toBe('critical');
      expect(db.get(parent.id)?.priority).toBe('critical');
      // The critical item itself is never part of the promoted-ancestor list.
      expect(db.get(child.id)?.priority).toBe('critical');
    });

    it('should promote every ancestor transitively to the root, nearest first', () => {
      const root = db.create({ title: 'Root', priority: 'high' });
      const middle = db.create({ title: 'Middle', priority: 'low', parentId: root.id });
      const parent = db.create({ title: 'Parent', priority: 'medium', parentId: middle.id });
      const child = db.create({ title: 'Child', priority: 'critical', parentId: parent.id });

      const promoted = cascadePriorityPromote(db, child.id);

      expect(promoted.map(a => a.id)).toEqual([parent.id, middle.id, root.id]);
      expect(promoted.every(a => a.priority === 'critical')).toBe(true);
      expect(db.get(parent.id)?.priority).toBe('critical');
      expect(db.get(middle.id)?.priority).toBe('critical');
      expect(db.get(root.id)?.priority).toBe('critical');
    });

    it('should skip an already-critical ancestor but keep promoting higher ancestors', () => {
      const root = db.create({ title: 'Root', priority: 'high' });
      const alreadyCritical = db.create({ title: 'Already critical', priority: 'critical', parentId: root.id });
      const parent = db.create({ title: 'Parent', priority: 'low', parentId: alreadyCritical.id });
      const child = db.create({ title: 'Child', priority: 'critical', parentId: parent.id });

      const promoted = cascadePriorityPromote(db, child.id);

      // The already-critical ancestor is skipped, but the walk continues to
      // the non-critical root above it.
      expect(promoted.map(a => a.id)).toEqual([parent.id, root.id]);
      expect(promoted.map(a => a.id)).not.toContain(alreadyCritical.id);
      expect(db.get(alreadyCritical.id)?.priority).toBe('critical');
      expect(db.get(root.id)?.priority).toBe('critical');
    });

    it('should be a no-op when the item is not critical', () => {
      const parent = db.create({ title: 'Parent', priority: 'medium' });
      const child = db.create({ title: 'High child', priority: 'high', parentId: parent.id });

      const promoted = cascadePriorityPromote(db, child.id);

      expect(promoted).toEqual([]);
      expect(db.get(parent.id)?.priority).toBe('medium');
    });

    it('should be a no-op for a critical item without a parent', () => {
      const root = db.create({ title: 'Critical root', priority: 'critical' });

      const promoted = cascadePriorityPromote(db, root.id);

      expect(promoted).toEqual([]);
      expect(db.get(root.id)?.priority).toBe('critical');
    });

    it('should return an empty list when every ancestor is already critical', () => {
      const root = db.create({ title: 'Root', priority: 'critical' });
      const parent = db.create({ title: 'Parent', priority: 'critical', parentId: root.id });
      const child = db.create({ title: 'Child', priority: 'critical', parentId: parent.id });

      const promoted = cascadePriorityPromote(db, child.id);

      expect(promoted).toEqual([]);
      expect(db.get(parent.id)?.priority).toBe('critical');
      expect(db.get(root.id)?.priority).toBe('critical');
    });

    it('should be idempotent: a second promotion promotes nothing', () => {
      const parent = db.create({ title: 'Parent', priority: 'medium' });
      const child = db.create({ title: 'Child', priority: 'critical', parentId: parent.id });

      expect(cascadePriorityPromote(db, child.id).map(a => a.id)).toEqual([parent.id]);
      expect(cascadePriorityPromote(db, child.id)).toEqual([]);
    });

    it('should leave unrelated branches untouched', () => {
      const otherRoot = db.create({ title: 'Other root', priority: 'medium' });
      const otherChild = db.create({ title: 'Other child', priority: 'high', parentId: otherRoot.id });
      const root = db.create({ title: 'Root', priority: 'high' });
      const parent = db.create({ title: 'Parent', priority: 'medium', parentId: root.id });
      const child = db.create({ title: 'Child', priority: 'critical', parentId: parent.id });

      const promoted = cascadePriorityPromote(db, child.id);

      expect(promoted.map(a => a.id)).toEqual([parent.id, root.id]);
      expect(db.get(otherRoot.id)?.priority).toBe('medium');
      expect(db.get(otherChild.id)?.priority).toBe('high');
    });
  });

  describe('demoteParentOnChildAdded', () => {
    it('should demote a completed/in_review parent to open/plan_complete', () => {
      const parent = db.create({ title: 'Parent', status: 'completed', stage: 'in_review' });

      const demoted = db.demoteParentOnChildAdded(parent.id);

      expect(demoted).not.toBeNull();
      expect(demoted!.parent.id).toBe(parent.id);
      expect(demoted!.from).toEqual({ status: 'completed', stage: 'in_review' });
      expect(demoted!.to).toEqual({ status: 'open', stage: 'plan_complete' });
      // Persisted in the DB
      const refreshed = db.get(parent.id);
      expect(refreshed?.status).toBe('open');
      expect(refreshed?.stage).toBe('plan_complete');
    });

    it('should demote a completed/done parent to open/plan_complete', () => {
      const parent = db.create({ title: 'Parent', status: 'completed', stage: 'done' });

      const demoted = db.demoteParentOnChildAdded(parent.id);

      expect(demoted).not.toBeNull();
      expect(demoted!.from).toEqual({ status: 'completed', stage: 'done' });
      expect(demoted!.to).toEqual({ status: 'open', stage: 'plan_complete' });
      expect(db.get(parent.id)?.status).toBe('open');
      expect(db.get(parent.id)?.stage).toBe('plan_complete');
    });

    it('should demote a parent in the in_review stage regardless of status', () => {
      // in_review normally pairs with completed, but the rule keys on the
      // stage axis too, so a parent stuck at stage in_review is demoted.
      const parent = db.create({ title: 'Parent', status: 'completed', stage: 'in_review' });

      const demoted = db.demoteParentOnChildAdded(parent.id);

      expect(demoted).not.toBeNull();
      expect(demoted!.to).toEqual({ status: 'open', stage: 'plan_complete' });
    });

    it('should be a no-op for parents that are not completed/in_review', () => {
      const openParent = db.create({ title: 'Open parent', status: 'open', stage: 'plan_complete' });
      const inProgressParent = db.create({ title: 'In-progress parent', status: 'in-progress', stage: 'in_progress' });
      const ideaParent = db.create({ title: 'Idea parent', status: 'open', stage: 'idea' });

      expect(db.demoteParentOnChildAdded(openParent.id)).toBeNull();
      expect(db.demoteParentOnChildAdded(inProgressParent.id)).toBeNull();
      expect(db.demoteParentOnChildAdded(ideaParent.id)).toBeNull();
      // Untouched
      expect(db.get(openParent.id)?.status).toBe('open');
      expect(db.get(openParent.id)?.stage).toBe('plan_complete');
      expect(db.get(inProgressParent.id)?.status).toBe('in-progress');
      expect(db.get(ideaParent.id)?.stage).toBe('idea');
    });

    it('should return null for a missing parent', () => {
      expect(db.demoteParentOnChildAdded('TEST-NONEXISTENT')).toBeNull();
    });

    it('should only demote the direct parent, leaving ancestors untouched', () => {
      const grandparent = db.create({ title: 'Grandparent', status: 'completed', stage: 'done' });
      const parent = db.create({ title: 'Parent', status: 'completed', stage: 'done', parentId: grandparent.id });

      const demoted = db.demoteParentOnChildAdded(parent.id);

      expect(demoted?.parent.id).toBe(parent.id);
      expect(db.get(parent.id)?.status).toBe('open');
      // Ancestor propagation is out of scope — grandparent stays completed
      expect(db.get(grandparent.id)?.status).toBe('completed');
      expect(db.get(grandparent.id)?.stage).toBe('done');
    });
  });

  describe('revertToPlanComplete', () => {
    it('should revert a completed/in_review item to open/plan_complete', () => {
      const item = db.create({ title: 'Item', status: 'completed', stage: 'in_review' });

      const reverted = db.revertToPlanComplete(item.id);

      expect(reverted).not.toBeNull();
      expect(reverted!.item.id).toBe(item.id);
      expect(reverted!.from).toEqual({ status: 'completed', stage: 'in_review' });
      expect(reverted!.to).toEqual({ status: 'open', stage: 'plan_complete' });
      // Persisted in the DB
      const refreshed = db.get(item.id);
      expect(refreshed?.status).toBe('open');
      expect(refreshed?.stage).toBe('plan_complete');
    });

    it('should preserve the item priority on reversion', () => {
      const item = db.create({ title: 'Item', status: 'completed', stage: 'in_review', priority: 'high' });

      const reverted = db.revertToPlanComplete(item.id);

      expect(reverted).not.toBeNull();
      expect(reverted!.item.priority).toBe('high');
      expect(db.get(item.id)?.priority).toBe('high');
    });

    it('should be a no-op for done items', () => {
      const doneItem = db.create({ title: 'Done item', status: 'completed', stage: 'done' });

      expect(db.revertToPlanComplete(doneItem.id)).toBeNull();
      expect(db.get(doneItem.id)?.status).toBe('completed');
      expect(db.get(doneItem.id)?.stage).toBe('done');
    });

    it('should be a no-op for items that are not completed/in_review', () => {
      const openItem = db.create({ title: 'Open item', status: 'open', stage: 'plan_complete' });
      const inProgressItem = db.create({ title: 'In-progress item', status: 'in-progress', stage: 'in_progress' });
      const ideaItem = db.create({ title: 'Idea item', status: 'open', stage: 'idea' });

      expect(db.revertToPlanComplete(openItem.id)).toBeNull();
      expect(db.revertToPlanComplete(inProgressItem.id)).toBeNull();
      expect(db.revertToPlanComplete(ideaItem.id)).toBeNull();
      // Untouched
      expect(db.get(openItem.id)?.status).toBe('open');
      expect(db.get(openItem.id)?.stage).toBe('plan_complete');
      expect(db.get(inProgressItem.id)?.status).toBe('in-progress');
      expect(db.get(ideaItem.id)?.stage).toBe('idea');
    });

    it('should return null for a missing item', () => {
      expect(db.revertToPlanComplete('TEST-NONEXISTENT')).toBeNull();
    });

    it('should be idempotent: reverting an already-open item is a no-op', () => {
      const item = db.create({ title: 'Item', status: 'completed', stage: 'in_review' });

      db.revertToPlanComplete(item.id);
      expect(db.revertToPlanComplete(item.id)).toBeNull();
      expect(db.get(item.id)?.status).toBe('open');
      expect(db.get(item.id)?.stage).toBe('plan_complete');
    });
  });

  describe('comments', () => {
    let workItemId: string;

    beforeEach(() => {
      const item = db.create({ title: 'Task with comments' });
      workItemId = item.id;
    });

    it('should create a comment', () => {
      const comment = db.createComment({
        workItemId,
        author: 'John Doe',
        comment: 'This is a comment',
      });

      expect(comment).toBeDefined();
      expect(comment?.id).toMatch(/^TEST-C[A-Z0-9]+$/);
      expect(comment?.workItemId).toBe(workItemId);
      expect(comment?.author).toBe('John Doe');
      expect(comment?.comment).toBe('This is a comment');
      expect(comment?.references).toEqual([]);
    });

    it('should create a comment with references', () => {
      const comment = db.createComment({
        workItemId,
        author: 'Jane Doe',
        comment: 'Comment with references',
        references: ['TEST-123', 'src/file.ts', 'https://example.com'],
      });

      expect(comment?.references).toEqual(['TEST-123', 'src/file.ts', 'https://example.com']);
    });

    it('should get a comment by ID', () => {
      const created = db.createComment({
        workItemId,
        author: 'John',
        comment: 'Test',
      });
      const retrieved = db.getComment(created!.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created!.id);
    });

    it('should list comments for a work item', () => {
      db.createComment({ workItemId, author: 'A', comment: 'Comment 1' });
      db.createComment({ workItemId, author: 'B', comment: 'Comment 2' });

      const comments = db.getCommentsForWorkItem(workItemId);
      expect(comments).toHaveLength(2);
    });

    it('should update a comment', () => {
      const comment = db.createComment({
        workItemId,
        author: 'John',
        comment: 'Original',
      });
      const updated = db.updateComment(comment!.id, {
        comment: 'Updated comment',
      });

      expect(updated?.comment).toBe('Updated comment');
      expect(updated?.author).toBe('John');
    });

    it('should delete a comment', () => {
      const comment = db.createComment({
        workItemId,
        author: 'John',
        comment: 'To delete',
      });
      const deleted = db.deleteComment(comment!.id);

      expect(deleted).toBe(true);
      expect(db.getComment(comment!.id)).toBe(null);
    });
  });

});
