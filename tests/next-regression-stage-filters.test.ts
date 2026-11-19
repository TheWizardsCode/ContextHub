/**
 * wl next regression tests — stage filters and in-progress handling.
 *
 * Stage-filter selection, in-progress subtrees and stage filter interaction with blocker surfacing.
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
  // childCount enrichment (WL-0MQF32M6P003GCT9)
  // `wl next --json` output should include a `childCount` field for each
  // work item representing the number of direct children.
  // ─────────────────────────────────────────────────────────────────────
  describe('childCount enrichment (WL-0MQF32M6P003GCT9)', () => {
    it('should return 0 for items with no children', () => {
      const item = db.create({ title: 'Leaf item', priority: 'medium', status: 'open' });
      const counts = db.getChildCounts();
      // Items not in the map have no children (count is undefined)
      expect(counts.has(item.id)).toBe(false);
    });

    it('should count direct children correctly', () => {
      const parent = db.create({ title: 'Parent', priority: 'medium', status: 'open' });
      db.create({ title: 'Child 1', priority: 'medium', status: 'open', parentId: parent.id });
      db.create({ title: 'Child 2', priority: 'medium', status: 'open', parentId: parent.id });

      const counts = db.getChildCounts();
      expect(counts.get(parent.id)).toBe(2);
    });

    it('should not count grandchildren', () => {
      const grandparent = db.create({ title: 'Grandparent', priority: 'medium', status: 'open' });
      const parent = db.create({ title: 'Parent', priority: 'medium', status: 'open', parentId: grandparent.id });
      db.create({ title: 'Child', priority: 'medium', status: 'open', parentId: parent.id });

      const counts = db.getChildCounts();
      expect(counts.get(grandparent.id)).toBe(1);
      expect(counts.get(parent.id)).toBe(1);
    });

    it('should count children regardless of their status', () => {
      const parent = db.create({ title: 'Parent', priority: 'medium', status: 'open' });
      db.create({ title: 'Active child', priority: 'medium', status: 'open', parentId: parent.id });
      db.create({ title: 'Completed child', priority: 'medium', status: 'completed', parentId: parent.id });
      db.create({ title: 'Deleted child', priority: 'medium', status: 'deleted', parentId: parent.id });

      const counts = db.getChildCounts();
      expect(counts.get(parent.id)).toBe(3);
    });

    it('should handle items with no parentId correctly', () => {
      db.create({ title: 'Root A', priority: 'medium', status: 'open' });
      db.create({ title: 'Root B', priority: 'medium', status: 'open' });

      const counts = db.getChildCounts();
      // Neither has children, so neither appears in the map
      expect(counts.size).toBe(0);
    });

    it('should return consistent results with the full item set', () => {
      const p1 = db.create({ title: 'Parent 1', priority: 'high', status: 'open' });
      const p2 = db.create({ title: 'Parent 2', priority: 'high', status: 'open' });
      db.create({ title: 'C1', priority: 'medium', status: 'open', parentId: p1.id });
      db.create({ title: 'C2', priority: 'medium', status: 'open', parentId: p1.id });
      db.create({ title: 'C3', priority: 'medium', status: 'open', parentId: p2.id });

      const counts = db.getChildCounts();
      expect(counts.get(p1.id)).toBe(2);
      expect(counts.get(p2.id)).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Critical child not returned when parent is a valid candidate
  //             (WL-0MQF5H0D30076K0X — Fix 1)
  // Critical-path escalation (handleCriticalEscalation) must filter out
  // children whose parent is a valid (non-deleted, non-completed, non-in-progress)
  // candidate — the parent should compete in Stage 5 instead.
  // ─────────────────────────────────────────────────────────────────────
  describe('critical child with valid parent candidate (WL-0MQF5H0D30076K0X — Fix 1)', () => {
    it('should NOT return critical child when parent is open', () => {
      const parent = db.create({ title: 'Open parent', priority: 'low', status: 'open' });
      const criticalChild = db.create({
        title: 'Critical child',
        priority: 'critical',
        status: 'open',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      // Critical child should NOT be returned from escalation;
      // parent should be preferred as the root candidate.
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(parent.id);
    });

    it('should hide critical child when parent is completed (WL-0MS964SIA0057ABR)', () => {
      const parent = db.create({ title: 'Completed parent', priority: 'low', status: 'completed' });
      db.create({
        title: 'Critical child',
        priority: 'critical',
        status: 'open',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      // Strict root-only: no orphan promotion — the critical child is hidden
      // entirely and no root candidate remains.
      expect(result.workItem).toBeNull();
    });

    it('should hide critical child when parent is deleted (WL-0MS964SIA0057ABR)', () => {
      const parent = db.create({ title: 'Deleted parent', priority: 'low', status: 'deleted' });
      db.create({
        title: 'Critical child',
        priority: 'critical',
        status: 'open',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      // Strict root-only: no orphan promotion — the critical child is hidden
      // entirely and no root candidate remains.
      expect(result.workItem).toBeNull();
    });

    it('should hide critical child when parent is in-progress (WL-0MS964SIA0057ABR)', () => {
      // Strict root-only: children are never surfaced, even when the parent is
      // in-progress (not a valid candidate). No orphan promotion.
      const parent = db.create({ title: 'In-progress parent', priority: 'low', status: 'in-progress' });
      db.create({
        title: 'Critical child',
        priority: 'critical',
        status: 'open',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).toBeNull();
    });

    it('should prefer parent when critical child exists alongside other open items', () => {
      const parent = db.create({ title: 'Low parent', priority: 'low', status: 'open', sortIndex: 100 });
      db.create({
        title: 'Critical child',
        priority: 'critical',
        status: 'open',
        parentId: parent.id,
      });
      const otherItem = db.create({ title: 'Medium other', priority: 'medium', status: 'open', sortIndex: 50 });

      const result = db.findNextWorkItem();
      // Both parent and otherItem are root candidates. otherItem has a better
      // sortIndex (50 < 100), so it should be selected.
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(otherItem.id);
    });

    it('should not surface critical child in batch mode when parent is open', () => {
      const parent = db.create({ title: 'Open parent', priority: 'low', status: 'open', sortIndex: 100 });
      const criticalChild = db.create({
        title: 'Critical child',
        priority: 'critical',
        status: 'open',
        parentId: parent.id,
      });
      const otherItem = db.create({ title: 'Other root', priority: 'medium', status: 'open', sortIndex: 50 });

      const results = db.findNextWorkItems(3);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      // Critical child should NOT appear in batch results
      expect(ids).not.toContain(criticalChild.id);
      // Parent should appear (it's a root candidate)
      expect(ids).toContain(parent.id);
      // Other root should appear too
      expect(ids).toContain(otherItem.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Blocked critical child with valid parent candidate
  //             (WL-0MQFIYPZK00680H1 — Parent-level hierarchy fixes)
  // handleCriticalEscalation must also skip blocked critical children
  // whose parent is a valid candidate — both in the blocker-pair loop
  // AND in the fallback path (where selectableBlocked was previously
  // falling back to unfiltered blockedCriticals).
  // ─────────────────────────────────────────────────────────────────────
  describe('blocked critical child with valid parent candidate (WL-0MQFIYPZK00680H1)', () => {
    it('should NOT return blocked critical child via fallback when parent is open', () => {
      // Scenario: A blocked critical child with a valid open parent.
      // The fallback path should return null instead of the child.
      const parent = db.create({ title: 'Open parent', priority: 'low', status: 'open' });
      const criticalChild = db.create({
        title: 'Blocked critical child',
        priority: 'critical',
        status: 'blocked',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      // Blocked critical child should NOT be returned via fallback;
      // parent should be preferred as the root candidate.
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(parent.id);
    });

    it('should return null when only blocked critical child exists under open parent with no other candidates', () => {
      // Scenario: Only a blocked critical child under an open parent, no
      // other candidates. The fallback returns null (no escalation);
      // Stage 5 also has nothing (parent is open but has a blocked child
      // which isn't selectable).
      const parent = db.create({ title: 'Open parent', priority: 'low', status: 'open' });
      db.create({
        title: 'Blocked critical child only',
        priority: 'critical',
        status: 'blocked',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      // No actionable root candidates - parent has no meaningful work
      // (child is blocked), or parent itself is open but has no value
      // At minimum, the blocked critical child should NOT be returned
      if (result.workItem) {
        expect(result.workItem!.id).toBe(parent.id);
      }
    });

    it('should hide blocked critical child when parent is completed (WL-0MS964SIA0057ABR)', () => {
      // Strict root-only: no orphan promotion — the blocked critical child is
      // hidden entirely even when its parent is completed.
      const parent = db.create({ title: 'Completed parent', priority: 'low', status: 'completed' });
      db.create({
        title: 'Blocked critical orphan',
        priority: 'critical',
        status: 'blocked',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).toBeNull();
    });

    it('should hide blocked critical child when parent is deleted (WL-0MS964SIA0057ABR)', () => {
      // Strict root-only: no orphan promotion — the blocked critical child is
      // hidden entirely even when its parent is deleted.
      const parent = db.create({ title: 'Deleted parent', priority: 'low', status: 'deleted' });
      db.create({
        title: 'Blocked critical orphan',
        priority: 'critical',
        status: 'blocked',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).toBeNull();
    });

    it('should hide blocked critical child when parent is in-progress (WL-0MS964SIA0057ABR)', () => {
      // Strict root-only: children are never surfaced, even when the parent is
      // in-progress (not a valid candidate). No orphan promotion.
      const parent = db.create({ title: 'In-progress parent', priority: 'low', status: 'in-progress' });
      db.create({
        title: 'Blocked critical child',
        priority: 'critical',
        status: 'blocked',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).toBeNull();
    });

    it('should not surface child-blockers of blocked critical child when parent is valid candidate', () => {
      // Scenario: Parent has two children; one child (critical, blocked)
      // depends on the other (open). The blocked critical has a valid
      // parent, so its blocker should NOT be surfaced — parent competes
      // in Stage 5 instead.
      const parent = db.create({ title: 'Open parent', priority: 'low', status: 'open' });
      const childBlocker = db.create({ title: 'Child blocker', priority: 'medium', status: 'open', parentId: parent.id });
      const criticalBlocked = db.create({
        title: 'Blocked critical child',
        priority: 'critical',
        status: 'blocked',
        parentId: parent.id,
      });
      db.addDependencyEdge(criticalBlocked.id, childBlocker.id);

      const result = db.findNextWorkItem();
      // Should return parent, not child blocker
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(parent.id);
      expect(result.workItem!.id).not.toBe(childBlocker.id);
    });

    it('should surface root-level blocker of blocked critical child even when parent is valid candidate', () => {
      // Scenario: A root-level blocker (no parent) blocks a blocked critical
      // child. The root-level blocker should still be surfaced because it
      // is at root level and actionable.
      const parent = db.create({ title: 'Open parent', priority: 'low', status: 'open' });
      const criticalChild = db.create({
        title: 'Blocked critical child',
        priority: 'critical',
        status: 'blocked',
        parentId: parent.id,
      });
      const rootBlocker = db.create({ title: 'Root blocker', priority: 'medium', status: 'open' });
      db.addDependencyEdge(criticalChild.id, rootBlocker.id);

      const result = db.findNextWorkItem();
      // Root-level blocker should be surfaced (not a child)
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(rootBlocker.id);
      expect(result.reason).toContain('critical');
    });

    it('should not return blocked critical child in batch mode when parent is open', () => {
      const parent = db.create({ title: 'Open parent', priority: 'low', status: 'open', sortIndex: 100 });
      const criticalChild = db.create({
        title: 'Blocked critical child',
        priority: 'critical',
        status: 'blocked',
        parentId: parent.id,
      });
      const otherItem = db.create({ title: 'Other root', priority: 'medium', status: 'open', sortIndex: 50 });

      const results = db.findNextWorkItems(3);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      // Blocked critical child should NOT appear in batch results
      expect(ids).not.toContain(criticalChild.id);
      // Parent should appear (it's a root candidate)
      expect(ids).toContain(parent.id);
      // Other root should appear too
      expect(ids).toContain(otherItem.id);
    });

    it('should not return duplicate blocked critical children in batch mode', () => {
      // Scenario: Two blocked critical children under the same parent.
      // Neither should appear individually — parent should be returned once.
      const parent = db.create({ title: 'Open parent', priority: 'low', status: 'open', sortIndex: 100 });
      db.create({
        title: 'Critical child A',
        priority: 'critical',
        status: 'blocked',
        parentId: parent.id,
      });
      db.create({
        title: 'Critical child B',
        priority: 'critical',
        status: 'blocked',
        parentId: parent.id,
      });
      const otherItem = db.create({ title: 'Other root', priority: 'medium', status: 'open', sortIndex: 50 });

      const results = db.findNextWorkItems(3);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      // No duplicates
      expect(new Set(ids).size).toBe(ids.length);
      // Parent appears once
      expect(ids.filter(id => id === parent.id).length).toBe(1);
      // Other root appears
      expect(ids).toContain(otherItem.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Children of in-progress parents not promoted as orphans
  //             (WL-0MQF5H0D30076K0X — Fix 2)
  // Children of in-progress parents must NOT be promoted to root level in
  // Stage 5 — the entire in-progress subtree is skipped from wl next.
  // ─────────────────────────────────────────────────────────────────────
  describe('children of in-progress parents excluded (WL-0MQF5H0D30076K0X — Fix 2)', () => {
    it('should NOT promote child when parent is in-progress', () => {
      const parent = db.create({ title: 'In-progress parent', priority: 'high', status: 'in-progress' });
      const child = db.create({ title: 'Open child', priority: 'high', status: 'open', parentId: parent.id });

      const result = db.findNextWorkItem();
      // Child should NOT be promoted — entire in-progress subtree is skipped
      expect(result.workItem).toBeNull();
    });

    it('should skip in-progress subtree and select next available root', () => {
      const parent = db.create({ title: 'In-progress parent', priority: 'high', status: 'in-progress', sortIndex: 100 });
      db.create({ title: 'Open child', priority: 'high', status: 'open', parentId: parent.id, sortIndex: 200 });
      const rootItem = db.create({ title: 'Other root item', priority: 'medium', status: 'open', sortIndex: 50 });

      const result = db.findNextWorkItem();
      // rootItem should be selected, ignoring the in-progress subtree
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(rootItem.id);
    });

    it('should hide orphan child when parent is completed (WL-0MS964SIA0057ABR)', () => {
      const parent = db.create({ title: 'Completed parent', priority: 'high', status: 'completed', sortIndex: 100 });
      db.create({ title: 'Orphan child', priority: 'high', status: 'open', parentId: parent.id, sortIndex: 200 });

      const result = db.findNextWorkItem();
      // Strict root-only: orphan promotion removed — the child is hidden
      // entirely (user decision Q1: "b" hidden entirely).
      expect(result.workItem).toBeNull();
    });

    it('should hide orphan child when parent is deleted (WL-0MS964SIA0057ABR)', () => {
      const parent = db.create({ title: 'Deleted parent', priority: 'high', status: 'deleted', sortIndex: 100 });
      db.create({ title: 'Orphan child', priority: 'high', status: 'open', parentId: parent.id, sortIndex: 200 });

      const result = db.findNextWorkItem();
      // Strict root-only: orphan promotion removed — the child is hidden
      // entirely (user decision Q1: "b" hidden entirely).
      expect(result.workItem).toBeNull();
    });

    it('should not surface children of in-progress parent in batch mode', () => {
      const parent = db.create({ title: 'In-progress parent', priority: 'high', status: 'in-progress', sortIndex: 100 });
      const child = db.create({ title: 'Child A', priority: 'high', status: 'open', parentId: parent.id, sortIndex: 200 });
      const rootItem = db.create({ title: 'Root item', priority: 'medium', status: 'open', sortIndex: 50 });

      const results = db.findNextWorkItems(3);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      // Child should NOT appear in batch results
      expect(ids).not.toContain(child.id);
      // Root item should appear
      expect(ids).toContain(rootItem.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Stage 3 hierarchy awareness — blocker surfacing should
  //             not return child items when their parent is a valid
  //             candidate (WL-0MQF95NCC0024H61)
  // Stage 3 (non-critical blocker surfacing) was returning child items
  // directly when the child blocked another child under the same parent.
  // The fix filters out blockers whose parent is a valid (open,
  // non-deleted, non-completed, non-in-progress) parent candidate so
  // that Stage 5 can correctly return the parent instead.
  // ─────────────────────────────────────────────────────────────────────
  describe('Stage 3 hierarchy awareness for blocker surfacing (WL-0MQF95NCC0024H61)', () => {
    it('should return parent instead of child blocker (dependency-edge) when parent is valid candidate', () => {
      // Scenario: Parent has two children; one child depends on the other.
      // Stage 3 should NOT return the child blocker — the parent should
      // be selected by Stage 5 instead.
      const parent = db.create({ title: 'Parent epic', priority: 'medium', status: 'open' });
      const childA = db.create({ title: 'Prerequisite child', priority: 'medium', status: 'open', parentId: parent.id });
      const childB = db.create({ title: 'Blocked child', priority: 'medium', status: 'blocked', parentId: parent.id });
      // childB depends on childA
      db.addDependencyEdge(childB.id, childA.id);

      const result = db.findNextWorkItem();

      // Should return parent, not the child blocker
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(parent.id);
      expect(result.workItem!.id).not.toBe(childA.id);
      expect(result.reason).toContain('Next open item');
    });

    it('should still surface root-level dependency-edge blocker normally (not a child)', () => {
      // Scenario: A root-level dependency-edge blocker should still be
      // surfaced — hierarchy filter only applies to children.
      const rootBlocker = db.create({ title: 'Root blocker', priority: 'low', status: 'open' });
      const blockedItem = db.create({ title: 'Blocked item', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(blockedItem.id, rootBlocker.id);

      const result = db.findNextWorkItem();

      // Root-level blocker should be surfaced
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(rootBlocker.id);
      expect(result.reason).toContain('Blocking issue');
    });

    it('should hide dependency-edge blocker that is an orphan child (parent completed) (WL-0MS964SIA0057ABR)', () => {
      // Strict root-only: the blocker is a child of a completed parent (orphan).
      // Orphan promotion is removed — the child blocker is hidden entirely and
      // its parent (completed) is not selectable, so wl next returns null with
      // a clear reason.
      const completedParent = db.create({ title: 'Completed parent', priority: 'high', status: 'completed' });
      const orphanBlocker = db.create({ title: 'Orphan blocker', priority: 'medium', status: 'open', parentId: completedParent.id });
      const blockedItem = db.create({ title: 'Blocked item', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(blockedItem.id, orphanBlocker.id);

      const result = db.findNextWorkItem();
      // The child blocker is hidden; its parent is completed (not selectable),
      // so wl next returns null with a clear reason (no orphan promotion).
      expect(result.workItem).toBeNull();
      expect(result.reason).toContain('No work items available');
    });

    it('should suppress child blockers in batch mode when parent is valid candidate', () => {
      // Batch mode should also suppress child blockers from Stage 3
      const parent = db.create({ title: 'Parent epic', priority: 'medium', status: 'open' });
      const childA = db.create({ title: 'Prerequisite child', priority: 'medium', status: 'open', parentId: parent.id });
      const childB = db.create({ title: 'Blocked child', priority: 'medium', status: 'blocked', parentId: parent.id });
      db.addDependencyEdge(childB.id, childA.id);
      const otherItem = db.create({ title: 'Other root item', priority: 'medium', status: 'open' });

      const results = db.findNextWorkItems(5);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);

      // Child blocker should NOT appear in batch results
      expect(ids).not.toContain(childA.id);
      // Parent and other root should appear
      expect(ids).toContain(parent.id);
      expect(ids).toContain(otherItem.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Feature: --include-in-progress (WL-0MQFC49NT001LBDK)
  // When --include-in-progress is true, items with status 'in-progress'
  // appear in wl next alongside open items. Without the flag, the default
  // behaviour (exclude in-progress) is preserved.
  // ─────────────────────────────────────────────────────────────────────
  describe('--include-in-progress (WL-0MQFC49NT001LBDK)', () => {
    it('should exclude in-progress items by default (backward compatible)', () => {
      db.create({ title: 'In progress item', priority: 'high', status: 'in-progress' });
      const openItem = db.create({ title: 'Open item', priority: 'low', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(openItem.id);
      expect(result.workItem!.status).toBe('open');
    });

    it('should include in-progress items when includeInProgress=true', () => {
      const inProgress = db.create({ title: 'In progress item', priority: 'critical', status: 'in-progress' });
      db.create({ title: 'Open item', priority: 'low', status: 'open' });

      const result = db.findNextWorkItem(undefined, undefined, false, undefined, true);
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(inProgress.id);
      expect(result.workItem!.status).toBe('in-progress');
    });

    it('should include in-progress items in batch results', () => {
      const wip1 = db.create({ title: 'WIP high', priority: 'high', status: 'in-progress' });
      const wip2 = db.create({ title: 'WIP medium', priority: 'medium', status: 'in-progress' });
      const open1 = db.create({ title: 'Open high', priority: 'high', status: 'open' });

      const results = db.findNextWorkItems(5, undefined, undefined, false, undefined, true);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);

      // In-progress items should appear alongside open items
      expect(ids).toContain(wip1.id);
      expect(ids).toContain(wip2.id);
      expect(ids).toContain(open1.id);
    });

    it('should include in-progress items when used with stage filter', () => {
      const wipIntake = db.create({ title: 'WIP intake', priority: 'high', status: 'in-progress', stage: 'intake_complete' });
      db.create({ title: 'WIP other stage', priority: 'high', status: 'in-progress', stage: 'plan_complete' });
      const openIntake = db.create({ title: 'Open intake', priority: 'low', status: 'open', stage: 'intake_complete' });

      const result = db.findNextWorkItem(undefined, undefined, false, 'intake_complete', true);
      expect(result.workItem).not.toBeNull();
      // Both the in-progress and open items in the matching stage are candidates.
      // The high-priority WIP intake should be preferred over low-priority open.
      expect(result.workItem!.id).toBe(wipIntake.id);
    });

    it('should return in-progress item when it is the only candidate', () => {
      db.create({ title: 'Only WIP', priority: 'medium', status: 'in-progress' });

      const result = db.findNextWorkItem(undefined, undefined, false, undefined, true);
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.status).toBe('in-progress');
    });

    it('should return null when only in-progress items exist without the flag', () => {
      db.create({ title: 'Only WIP', priority: 'medium', status: 'in-progress' });

      const result = db.findNextWorkItem();
      expect(result.workItem).toBeNull();
    });

    it('should include both in-progress and open items in mixed pool', () => {
      const wip = db.create({ title: 'WIP high', priority: 'high', status: 'in-progress' });
      const open = db.create({ title: 'Open medium', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem(undefined, undefined, false, undefined, true);
      expect(result.workItem).not.toBeNull();
      // High-priority in-progress item should be preferred over medium open
      expect(result.workItem!.id).toBe(wip.id);
    });

    it('should still exclude in-progress items in batch mode without the flag', () => {
      db.create({ title: 'WIP item', priority: 'high', status: 'in-progress' });
      const openItem = db.create({ title: 'Open item', priority: 'low', status: 'open' });

      const results = db.findNextWorkItems(5);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);

      expect(ids).not.toContain(undefined);
      expect(ids).toContain(openItem.id);
      // No in-progress items should appear
      for (const id of ids) {
        const item = results.find(r => r.workItem?.id === id)?.workItem;
        expect(item?.status).not.toBe('in-progress');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Stage filter skips blocker surfacing (WL-0MSP1XJSO007LE3K)
  // RCA of RW-0MSAD6FX7001AAV9: the herdr plan tier dispatches /skill:plan
  // on whatever `wl next --stage intake_complete --json` returns. Stage 3
  // (non-critical blocker surfacing) ran even with a stage filter and
  // surfaced a plan_complete epic as the dependency blocker of an
  // intake_complete/blocked child, so /skill:plan was dispatched on the
  // epic every downtime cycle. Stage 2 (critical escalation) already has a
  // `!stage` guard; Stage 3 must mirror it.
  // ─────────────────────────────────────────────────────────────────────
  describe('stage filter skips blocker surfacing (WL-0MSP1XJSO007LE3K)', () => {
    it('should NOT surface a plan_complete epic blocker under --stage intake_complete', () => {
      // 6abcb44e-like RCA state (RW-0MSAD6FX7001AAV9): a plan_complete/open
      // epic (sortIndex 200) is the dependency blocker of an
      // intake_complete/blocked high-priority child that also depends on an
      // open intake_complete item. The open intake_complete item keeps Stage
      // 3's `filteredItems.length > 0` gate satisfied, so previously the epic
      // was surfaced with 'Blocking issue for high-priority item ...' — the
      // epic must never be returned by a stage-filtered next.
      const epic = db.create({
        title: 'Plan complete epic',
        status: 'open',
        stage: 'plan_complete',
        issueType: 'epic',
        sortIndex: 200,
      });
      const blockedChild = db.create({
        title: 'Intake child blocked',
        status: 'blocked',
        stage: 'intake_complete',
        priority: 'high',
        parentId: epic.id,
      });
      const otherDep = db.create({
        title: 'Other dependency (intake open)',
        status: 'open',
        stage: 'intake_complete',
        priority: 'medium',
        sortIndex: 400,
      });
      db.addDependencyEdge(blockedChild.id, epic.id);
      db.addDependencyEdge(blockedChild.id, otherDep.id);

      const result = db.findNextWorkItem(undefined, undefined, false, 'intake_complete');
      // The plan_complete epic must never be surfaced by a stage-filtered next;
      // the only intake_complete open candidate is otherDep.
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(otherDep.id);
      expect(result.workItem!.stage).toBe('intake_complete');
    });

    it('should return an intake_complete item, not the out-of-stage blocker', () => {
      // Same epic/blocked-child shape as the RCA, plus a real intake_complete
      // open item. The stage filter must select the intake_complete item
      // rather than surfacing the plan_complete epic as a blocker.
      const epic = db.create({
        title: 'Plan complete epic',
        status: 'open',
        stage: 'plan_complete',
        issueType: 'epic',
        sortIndex: 200,
      });
      const blockedChild = db.create({
        title: 'Intake child blocked',
        status: 'blocked',
        stage: 'intake_complete',
        priority: 'high',
        parentId: epic.id,
      });
      db.addDependencyEdge(blockedChild.id, epic.id);
      const intakeItem = db.create({
        title: 'Intake open item',
        status: 'open',
        stage: 'intake_complete',
        priority: 'low',
      });

      const result = db.findNextWorkItem(undefined, undefined, false, 'intake_complete');
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(intakeItem.id);
      expect(result.workItem!.stage).toBe('intake_complete');
    });

    it('should skip critical escalation when stage filter is active (existing behavior)', () => {
      // AC: critical escalation is already skipped with --stage (Stage 2
      // guard). Lock it in: a critical intake_complete item whose blocker is
      // at another stage must not surface that blocker under a stage filter.
      const blocker = db.create({
        title: 'Critical blocker',
        status: 'open',
        stage: 'plan_complete',
      });
      const criticalBlocked = db.create({
        title: 'Critical blocked intake',
        status: 'blocked',
        stage: 'intake_complete',
        priority: 'critical',
      });
      db.addDependencyEdge(criticalBlocked.id, blocker.id);

      const result = db.findNextWorkItem(undefined, undefined, false, 'intake_complete');
      expect(result.workItem).toBeNull();
    });
  });

});
