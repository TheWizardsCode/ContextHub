/**
 * Tests for sync operations - merging work items and comments
 * These tests focus on the complex merge logic with conflict resolution
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeWorkItems, mergeComments } from '../src/sync.js';
import { isDefaultValue } from '../src/sync/merge-utils.js';
import { WorklogDatabase } from '../src/database.js';

// Only imported for unit testing the ref-name mapping.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { _testOnly_getRemoteTrackingRef } from '../src/sync.js';
import { WorkItem, Comment } from '../src/types.js';

describe('Sync Operations', () => {

  describe('git ref naming', () => {
    it('should map explicit refs/* to local refs/worklog/remotes/* tracking refs', () => {
      expect(_testOnly_getRemoteTrackingRef('origin', 'refs/worklog/data')).toBe(
        'refs/worklog/remotes/origin/worklog/data'
      );
    });

    it('should map normal branches to refs/remotes/* tracking refs', () => {
      expect(_testOnly_getRemoteTrackingRef('origin', 'main')).toBe('refs/remotes/origin/main');
    });
  });

  describe('mergeWorkItems', () => {
    it('should merge when local has items and remote is empty', () => {
      const localItems: WorkItem[] = [
        {
          id: 'WI-001',
          title: 'Local task',
          description: '',
          status: 'open',
          priority: 'medium',
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
        },
      ];

      const result = mergeWorkItems(localItems, []);

      expect(result.merged).toHaveLength(1);
      expect(result.merged[0].id).toBe('WI-001');
      expect(result.conflicts).toHaveLength(0);
    });

    it('should merge when remote has new items', () => {
      const localItems: WorkItem[] = [
        {
          id: 'WI-001',
          title: 'Local task',
          description: '',
          status: 'open',
          priority: 'medium',
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
        },
      ];

      const remoteItems: WorkItem[] = [
        {
          id: 'WI-002',
          title: 'Remote task',
          description: '',
          status: 'completed',
          priority: 'high',
          sortIndex: 0,
          parentId: null,
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
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
      ];

      const result = mergeWorkItems(localItems, remoteItems);

      expect(result.merged).toHaveLength(2);
      expect(result.merged.map(i => i.id).sort()).toEqual(['WI-001', 'WI-002']);
      expect(result.conflicts).toHaveLength(0);
    });

    it('should keep identical items without conflicts', () => {
      const item: WorkItem = {
        id: 'WI-001',
        title: 'Same task',
        description: 'Same description',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        tags: ['tag1', 'tag2'],
        assignee: 'john',
        stage: 'dev',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const result = mergeWorkItems([item], [item]);

      expect(result.merged).toHaveLength(1);
      expect(result.merged[0]).toEqual(item);
      expect(result.conflicts).toHaveLength(0);
    });

    it('should use remote value when local has default and remote has non-default', () => {
      const localItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: '',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T01:00:00.000Z',
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

      const remoteItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: 'Added description',
        status: 'in-progress',
        priority: 'high',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T02:00:00.000Z',
        tags: ['feature'],
        assignee: 'alice',
        stage: 'development',
        issueType: 'task',
        createdBy: 'alice',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const result = mergeWorkItems([localItem], [remoteItem]);

      expect(result.merged).toHaveLength(1);
      expect(result.merged[0].description).toBe('Added description');
      expect(result.merged[0].status).toBe('in-progress');
      expect(result.merged[0].priority).toBe('high');
      expect(result.merged[0].tags).toEqual(['feature']);
      expect(result.merged[0].assignee).toBe('alice');
      expect(result.merged[0].stage).toBe('development');
    });

    it('should use local value when remote has default and local has non-default', () => {
      const localItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: 'Local description',
        status: 'completed',
        priority: 'critical',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T02:00:00.000Z',
        tags: ['backend'],
        assignee: 'bob',
        stage: 'testing',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const remoteItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: '',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T01:00:00.000Z',
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

      const result = mergeWorkItems([localItem], [remoteItem]);

      expect(result.merged).toHaveLength(1);
      expect(result.merged[0].description).toBe('Local description');
      expect(result.merged[0].status).toBe('completed');
      expect(result.merged[0].priority).toBe('critical');
      expect(result.merged[0].tags).toEqual(['backend']);
      expect(result.merged[0].assignee).toBe('bob');
      expect(result.merged[0].stage).toBe('testing');
    });

    it('should use newer timestamp when both have non-default values', () => {
      const localItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: 'Local description',
        status: 'in-progress',
        priority: 'high',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T10:00:00.000Z',
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

      const remoteItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: 'Remote description',
        status: 'completed',
        priority: 'low',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T12:00:00.000Z',
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

      const result = mergeWorkItems([localItem], [remoteItem]);

      expect(result.merged).toHaveLength(1);
      // Remote is newer, so use remote values
      expect(result.merged[0].description).toBe('Remote description');
      expect(result.merged[0].status).toBe('completed');
      expect(result.merged[0].priority).toBe('low');
      expect(result.conflicts.length).toBeGreaterThan(0);
    });

    it('should merge tags as union when both have non-default tags', () => {
      const localItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: '',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T10:00:00.000Z',
        tags: ['local-tag', 'shared-tag'],
        assignee: '',
        stage: '',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const remoteItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: '',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T12:00:00.000Z',
        tags: ['remote-tag', 'shared-tag'],
        assignee: '',
        stage: '',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const result = mergeWorkItems([localItem], [remoteItem]);

      expect(result.merged).toHaveLength(1);
      expect(result.merged[0].tags.sort()).toEqual(['local-tag', 'remote-tag', 'shared-tag']);
    });

    it('preserves explicit null parentId when local unparent is newer', () => {
      const localItem: WorkItem = {
        id: 'WI-010',
        title: 'Child item',
        description: '',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null, // local removed parent
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T12:00:00.000Z', // newer
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

      const remoteItem: WorkItem = {
        id: 'WI-010',
        title: 'Child item',
        description: '',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: 'WI-000', // remote still has parent
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T10:00:00.000Z', // older
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

      const result = mergeWorkItems([localItem], [remoteItem]);
      expect(result.merged).toHaveLength(1);
      // Local explicit null parentId (unparent) is newer and must be preserved
      expect(result.merged[0].parentId).toBeNull();
    });

    it('should handle same timestamp with different content deterministically', () => {
      const localItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: 'Description A',
        status: 'in-progress',
        priority: 'high',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T10:00:00.000Z',
        tags: [],
        assignee: 'alice',
        stage: 'dev',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const remoteItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: 'Description B',
        status: 'completed',
        priority: 'low',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T10:00:00.000Z',
        tags: [],
        assignee: 'bob',
        stage: 'testing',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const result = mergeWorkItems([localItem], [remoteItem]);

      expect(result.merged).toHaveLength(1);
      // Should bump updatedAt
      expect(result.merged[0].updatedAt).not.toBe('2024-01-01T10:00:00.000Z');
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts.some(c => c.includes('Same updatedAt'))).toBe(true);
    });

    it('should prefer lexicographic tie-breaker by default', () => {
      const localItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: 'alpha',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T10:00:00.000Z',
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

      const remoteItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: 'zulu',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T10:00:00.000Z',
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

      const result = mergeWorkItems([localItem], [remoteItem]);

      expect(result.merged).toHaveLength(1);
      expect(result.merged[0].description).toBe('zulu');
      expect(result.conflicts.some(c => c.includes('Same updatedAt'))).toBe(true);
    });

    it('should preserve createdAt from local item', () => {
      const localItem: WorkItem = {
        id: 'WI-001',
        title: 'Task',
        description: '',
        status: 'open',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T10:00:00.000Z',
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

      const remoteItem: WorkItem = {
        id: 'WI-001',
        title: 'Updated task',
        description: '',
        status: 'completed',
        priority: 'high',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-01T12:00:00.000Z',
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

      const result = mergeWorkItems([localItem], [remoteItem]);

      expect(result.merged[0].createdAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should merge multiple items correctly', () => {
      const localItems: WorkItem[] = [
        {
          id: 'WI-001',
          title: 'Local only',
          description: '',
          status: 'open',
          priority: 'medium',
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
        },
        {
          id: 'WI-002',
          title: 'Modified locally',
          description: 'Local mod',
          status: 'in-progress',
          priority: 'high',
          sortIndex: 0,
          parentId: null,
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T10:00:00.000Z',
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
      ];

      const remoteItems: WorkItem[] = [
        {
          id: 'WI-002',
          title: 'Modified remotely',
          description: 'Remote mod',
          status: 'completed',
          priority: 'low',
          sortIndex: 0,
          parentId: null,
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T12:00:00.000Z',
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
          id: 'WI-003',
          title: 'Remote only',
          description: '',
          status: 'open',
          priority: 'medium',
          sortIndex: 0,
          parentId: null,
          createdAt: '2024-01-03T00:00:00.000Z',
          updatedAt: '2024-01-03T00:00:00.000Z',
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
      ];

      const result = mergeWorkItems(localItems, remoteItems);

      expect(result.merged).toHaveLength(3);
      expect(result.merged.map(i => i.id).sort()).toEqual(['WI-001', 'WI-002', 'WI-003']);
      
      // WI-001 should be unchanged (local only)
      const item1 = result.merged.find(i => i.id === 'WI-001');
      expect(item1?.title).toBe('Local only');

      // WI-002 should use remote values (remote is newer)
      const item2 = result.merged.find(i => i.id === 'WI-002');
      expect(item2?.title).toBe('Modified remotely');
      expect(item2?.status).toBe('completed');

      // WI-003 should be added (remote only)
      const item3 = result.merged.find(i => i.id === 'WI-003');
      expect(item3?.title).toBe('Remote only');
    });

    it('should preserve close when local is newer (close-then-sync scenario)', () => {
      const localAfterClose: WorkItem = {
        id: 'WI-001',
        title: 'Task to close',
        description: 'Some description',
        status: 'completed',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-06-01T12:00:00.000Z', // fresh close timestamp
        tags: ['bug'],
        assignee: 'alice',
        stage: 'done',
        issueType: 'bug',
        createdBy: 'alice',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const remoteStale: WorkItem = {
        id: 'WI-001',
        title: 'Task to close',
        description: 'Some description',
        status: 'in-progress',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z', // old timestamp before close
        tags: ['bug'],
        assignee: 'alice',
        stage: 'plan_complete',
        issueType: 'bug',
        createdBy: 'alice',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      // Merge: local (just closed) is newer than remote (stale)
      const result = mergeWorkItems([localAfterClose], [remoteStale]);

      expect(result.merged).toHaveLength(1);
      const merged = result.merged[0];

      // The close must survive: status remains completed, stage remains done
      expect(merged.status).toBe('completed');
      expect(merged.stage).toBe('done');
      // updatedAt should be the local (newer) timestamp
      expect(merged.updatedAt).toBe('2024-06-01T12:00:00.000Z');
    });

    it('should preserve close across multiple sync cycles (no drift)', () => {
      // Simulate: close then first sync
      const localAfterClose: WorkItem = {
        id: 'WI-002',
        title: 'Persistent close',
        description: '',
        status: 'completed',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-06-01T12:00:00.000Z',
        tags: [],
        assignee: '',
        stage: 'done',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const remoteStale: WorkItem = {
        id: 'WI-002',
        title: 'Persistent close',
        description: '',
        status: 'in-progress',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        tags: [],
        assignee: '',
        stage: 'plan_complete',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      // First sync cycle
      const firstSync = mergeWorkItems([localAfterClose], [remoteStale]);
      expect(firstSync.merged[0].status).toBe('completed');
      expect(firstSync.merged[0].stage).toBe('done');

      // Simulate the merged result becoming the new "local"
      const localAfterFirstSync = firstSync.merged[0];

      // Remote after first sync also has the merged data (sync pushed it)
      const remoteAfterFirstSync: WorkItem = { ...localAfterFirstSync };

      // Second sync cycle: both local and remote have same data
      const secondSync = mergeWorkItems([localAfterFirstSync], [remoteAfterFirstSync]);
      expect(secondSync.merged).toHaveLength(1);
      expect(secondSync.merged[0].status).toBe('completed');
      expect(secondSync.merged[0].stage).toBe('done');

      // Third sync cycle: still stable
      const thirdSync = mergeWorkItems([secondSync.merged[0]], [{ ...secondSync.merged[0] }]);
      expect(thirdSync.merged[0].status).toBe('completed');
      expect(thirdSync.merged[0].stage).toBe('done');
    });

    it('should not revert close when remote has newer non-conflicting field changes', () => {
      // Scenario: Local item was closed. Remote has a newer timestamp
      // from a non-conflicting change (e.g., description edited on another machine).
      // The close (status/stage change) must not be reverted even though remote is newer.

      const localClosed: WorkItem = {
        id: 'WI-003',
        title: 'Closed item',
        description: 'Original description',
        status: 'completed',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-06-02T10:00:00.000Z', // close time
        tags: [],
        assignee: '',
        stage: 'done',
        issueType: 'bug',
        createdBy: 'alice',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      // Remote is newer but still has old status/stage
      // Description was changed remotely after the close
      const remoteNewer: WorkItem = {
        id: 'WI-003',
        title: 'Closed item',
        description: 'Modified description remotely',
        status: 'in-progress',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-06-02T12:00:00.000Z', // newer than close!
        tags: [],
        assignee: '',
        stage: 'plan_complete',
        issueType: 'bug',
        createdBy: 'alice',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const result = mergeWorkItems([localClosed], [remoteNewer]);

      expect(result.merged).toHaveLength(1);
      const merged = result.merged[0];

      // With the close-priority merge rule, the close state (completed/done)
      // is preserved even though remote is newer. The description edit from
      // remote is also preserved because it was the only field where remote
      // intentionally made a change.
      expect(merged.status).toBe('completed');
      expect(merged.stage).toBe('done');
      expect(merged.description).toBe('Modified description remotely');
    });

    it('should handle same-timestamp close conflict deterministically', () => {
      // Edge case: local and remote have the same updatedAt timestamp
      // but different status values (local: completed, remote: in-progress).
      // The close priority rule ensures the close (completed/done) wins.

      const sameTimestamp = '2024-06-01T12:00:00.000Z';

      const localClosed: WorkItem = {
        id: 'WI-004',
        title: 'Same ts item',
        description: '',
        status: 'completed',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: sameTimestamp,
        tags: [],
        assignee: '',
        stage: 'done',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const remoteInProgress: WorkItem = {
        id: 'WI-004',
        title: 'Same ts item',
        description: '',
        status: 'in-progress',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: sameTimestamp,
        tags: [],
        assignee: '',
        stage: 'plan_complete',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const result = mergeWorkItems([localClosed], [remoteInProgress]);

      expect(result.merged).toHaveLength(1);
      const merged = result.merged[0];

      // The close state (completed/done) takes priority regardless of
      // the lexicographic tie-breaker. The close is preserved.
      expect(merged.status).toBe('completed');
      expect(merged.stage).toBe('done');
      // The updatedAt should be bumped to break the tie for next sync
      expect(merged.updatedAt).not.toBe(sameTimestamp);
    });

    it('should preserve close when remote is newer with non-close field change', () => {
      // AC 3: When Client A closes an item and Client B modifies a different
      // field (e.g., description), the close must NOT be reverted even though
      // remote has a newer timestamp.

      const localClosed: WorkItem = {
        id: 'WI-005',
        title: 'Close survives remote edit',
        description: 'Original description',
        status: 'completed',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-06-01T12:00:00.000Z', // close timestamp
        tags: [],
        assignee: '',
        stage: 'done',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      // Remote has a newer timestamp (description edited on another client)
      // but the status is still in-progress (was never closed)
      const remoteNewer: WorkItem = {
        id: 'WI-005',
        title: 'Close survives remote edit',
        description: 'Edited by remote client',
        status: 'in-progress',
        priority: 'medium',
        sortIndex: 0,
        parentId: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-06-01T14:00:00.000Z', // newer than close!
        tags: [],
        assignee: '',
        stage: 'plan_complete',
        issueType: '',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '' as const,
        effort: '' as const,
      };

      const result = mergeWorkItems([localClosed], [remoteNewer]);

      expect(result.merged).toHaveLength(1);
      const merged = result.merged[0];

      // Close state (completed/done) is preserved because our close-priority
      // rule detects that local has the close state and remote doesn't.
      expect(merged.status).toBe('completed');
      expect(merged.stage).toBe('done');

      // The description edit from remote is also preserved (it was the only
      // field where remote intentionally made a change)
      expect(merged.description).toBe('Edited by remote client');
    });
  });

  describe('merge utils', () => {
    it('treats empty values as defaults unless configured otherwise', () => {
      expect(isDefaultValue('', 'title')).toBe(true);
      expect(isDefaultValue([], 'tags')).toBe(true);
      expect(isDefaultValue('', 'issueType')).toBe(true);
      expect(isDefaultValue('', 'issueType', { defaultValueFields: ['issueType'] })).toBe(false);
    });
  });

  describe('mergeComments', () => {
    it('should merge when local has comments and remote is empty', () => {
      const localComments: Comment[] = [
        {
          id: 'WI-C001',
          workItemId: 'WI-001',
          author: 'Alice',
          comment: 'Local comment',
          createdAt: '2024-01-01T00:00:00.000Z',
          references: [],
        },
      ];

      const result = mergeComments(localComments, []);

      expect(result.merged).toHaveLength(1);
      expect(result.merged[0].id).toBe('WI-C001');
      expect(result.conflicts).toHaveLength(0);
    });

    it('should add remote comments that do not exist locally', () => {
      const localComments: Comment[] = [
        {
          id: 'WI-C001',
          workItemId: 'WI-001',
          author: 'Alice',
          comment: 'Local',
          createdAt: '2024-01-01T00:00:00.000Z',
          references: [],
        },
      ];

      const remoteComments: Comment[] = [
        {
          id: 'WI-C002',
          workItemId: 'WI-001',
          author: 'Bob',
          comment: 'Remote',
          createdAt: '2024-01-02T00:00:00.000Z',
          references: [],
        },
      ];

      const result = mergeComments(localComments, remoteComments);

      expect(result.merged).toHaveLength(2);
      expect(result.merged.map(c => c.id).sort()).toEqual(['WI-C001', 'WI-C002']);
    });

    it('should deduplicate comments by ID', () => {
      const comment: Comment = {
        id: 'WI-C001',
        workItemId: 'WI-001',
        author: 'Alice',
        comment: 'Same comment',
        createdAt: '2024-01-01T00:00:00.000Z',
        references: [],
      };

      const result = mergeComments([comment], [comment]);

      expect(result.merged).toHaveLength(1);
      expect(result.conflicts).toHaveLength(0);
    });

    it('should preserve local version when IDs match', () => {
      const localComment: Comment = {
        id: 'WI-C001',
        workItemId: 'WI-001',
        author: 'Alice',
        comment: 'Local version',
        createdAt: '2024-01-01T00:00:00.000Z',
        references: ['ref1'],
      };

      const remoteComment: Comment = {
        id: 'WI-C001',
        workItemId: 'WI-001',
        author: 'Bob',
        comment: 'Remote version',
        createdAt: '2024-01-02T00:00:00.000Z',
        references: ['ref2'],
      };

      const result = mergeComments([localComment], [remoteComment]);

      expect(result.merged).toHaveLength(1);
      // Local version should be preserved
      expect(result.merged[0].author).toBe('Alice');
      expect(result.merged[0].comment).toBe('Local version');
    });
  });
});
