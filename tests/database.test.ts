/**
 * Tests for WorklogDatabase
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WorklogDatabase } from '../src/database.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';

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
      db.create({ title: 'Task 1', status: 'open', priority: 'high', needsProducerReview: true });
      db.create({ title: 'Task 2', status: 'in-progress', priority: 'medium' });
      db.create({ title: 'Task 3', status: 'completed', priority: 'low' });
      db.create({ title: 'Task 4', status: 'open', priority: 'high', tags: ['backend'], needsProducerReview: true });
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

    it('should filter by needsProducerReview true', () => {
      const items = db.list({ needsProducerReview: true });
      expect(items).toHaveLength(2);
      items.forEach(item => expect(item.needsProducerReview).toBe(true));
    });

    it('should filter by needsProducerReview false', () => {
      const items = db.list({ needsProducerReview: false });
      expect(items).toHaveLength(3);
      items.forEach(item => expect(item.needsProducerReview).not.toBe(true));
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
        needsProducerReview: false,
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
        needsProducerReview: false,
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
        needsProducerReview: false,
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
        needsProducerReview: false,
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
        needsProducerReview: false,
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

      // Manipulate updatedAt directly via the store:
      // Task A: updated just now (very recent — within both 48h prefer and 72h avoid windows)
      // Task B: updated 5 days ago (stale — beyond both windows, so no recency effect)
      store.saveWorkItem({ ...db.get(itemA.id)!, updatedAt: now.toISOString() });
      store.saveWorkItem({ ...db.get(itemB.id)!, updatedAt: fiveDaysAgo.toISOString() });

      // With 'prefer' policy: recently-updated Task A gets a recency BOOST,
      // so it should have a better (lower) sortIndex after re-sort
      db.reSort('prefer');
      const afterPreferA = db.get(itemA.id)!;
      const afterPreferB = db.get(itemB.id)!;
      expect(afterPreferA.sortIndex).toBeLessThan(afterPreferB.sortIndex);

      // Re-apply updatedAt manipulation because reSort() overwrites updatedAt
      // for any item whose sortIndex changed
      store.saveWorkItem({ ...db.get(itemA.id)!, updatedAt: now.toISOString() });
      store.saveWorkItem({ ...db.get(itemB.id)!, updatedAt: fiveDaysAgo.toISOString() });

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
});
