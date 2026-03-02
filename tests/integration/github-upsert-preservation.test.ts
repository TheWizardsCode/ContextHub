/**
 * Integration tests: GitHub flow upsert preserves existing data.
 *
 * These tests use a real SQLite database (no mocks) to verify that the
 * non-destructive `db.upsertItems()` path — now used by all GitHub flows
 * (push, import, import-then-push, delegate) — preserves work items,
 * comments, and dependency edges that are not part of the upserted subset.
 *
 * Each test:
 *  1. Creates multiple work items with comments and dependency edges.
 *  2. Upserts a subset (simulating the GitHub flow output).
 *  3. Asserts all non-affected items, comments, and edges are intact.
 *
 * A companion "regression guard" test demonstrates that the old destructive
 * `db.import()` would wipe non-affected items, proving the fix is necessary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorklogDatabase } from '../../src/database.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonlPath,
  createTempDbPath,
} from '../test-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up a fresh database with a known set of items, comments, and edges. */
function seedDatabase(db: WorklogDatabase) {
  // Create 5 items to simulate a realistic worklog
  const itemA = db.create({ title: 'Item A — unrelated epic' });
  const itemB = db.create({ title: 'Item B — unrelated bug' });
  const itemC = db.create({ title: 'Item C — target for delegation' });
  const itemD = db.create({ title: 'Item D — child of C', parentId: itemC.id });
  const itemE = db.create({ title: 'Item E — another unrelated task' });

  // Add comments to various items
  const commentA1 = db.createComment({ workItemId: itemA.id, author: 'alice', comment: 'Started investigating' });
  const commentA2 = db.createComment({ workItemId: itemA.id, author: 'bob', comment: 'Looks good to me' });
  const commentB1 = db.createComment({ workItemId: itemB.id, author: 'carol', comment: 'Reproduced the bug' });
  const commentC1 = db.createComment({ workItemId: itemC.id, author: 'dave', comment: 'Delegating to copilot' });
  const commentE1 = db.createComment({ workItemId: itemE.id, author: 'eve', comment: 'Polish pass needed' });

  // Add dependency edges: A depends on B, B depends on E, D depends on C
  const edgeAB = db.addDependencyEdge(itemA.id, itemB.id);
  const edgeBE = db.addDependencyEdge(itemB.id, itemE.id);
  const edgeDC = db.addDependencyEdge(itemD.id, itemC.id);

  return {
    items: { A: itemA, B: itemB, C: itemC, D: itemD, E: itemE },
    comments: { A1: commentA1!, A2: commentA2!, B1: commentB1!, C1: commentC1!, E1: commentE1! },
    edges: { AB: edgeAB!, BE: edgeBE!, DC: edgeDC! },
  };
}

/** Assert that ALL seeded items still exist (by id and title). */
function assertAllItemsExist(db: WorklogDatabase, seed: ReturnType<typeof seedDatabase>) {
  const all = db.getAll();
  const ids = new Set(all.map(i => i.id));
  for (const [label, item] of Object.entries(seed.items)) {
    expect(ids.has(item.id), `Item ${label} (${item.id}) should still exist`).toBe(true);
  }
  expect(all.length).toBeGreaterThanOrEqual(Object.keys(seed.items).length);
}

/** Assert that ALL seeded comments still exist and point to the right work items. */
function assertAllCommentsExist(db: WorklogDatabase, seed: ReturnType<typeof seedDatabase>) {
  const allComments = db.getAllComments();
  const commentIds = new Set(allComments.map(c => c.id));
  for (const [label, comment] of Object.entries(seed.comments)) {
    expect(commentIds.has(comment.id), `Comment ${label} (${comment.id}) should still exist`).toBe(true);
    const found = allComments.find(c => c.id === comment.id);
    expect(found!.workItemId).toBe(comment.workItemId);
    expect(found!.author).toBe(comment.author);
  }
}

/** Assert that ALL seeded dependency edges still exist. */
function assertAllEdgesExist(db: WorklogDatabase, seed: ReturnType<typeof seedDatabase>) {
  for (const [label, edge] of Object.entries(seed.edges)) {
    const edgesFrom = db.listDependencyEdgesFrom(edge.fromId);
    const match = edgesFrom.find(e => e.toId === edge.toId);
    expect(match, `Edge ${label} (${edge.fromId} -> ${edge.toId}) should still exist`).toBeDefined();
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GitHub flow upsert preserves existing data (integration)', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  // -----------------------------------------------------------------------
  // Delegate scenario
  // -----------------------------------------------------------------------

  it('delegate: upserting a single item preserves all other items, comments, and edges', () => {
    const seed = seedDatabase(db);

    // Simulate the delegate flow: upsert only item C with GitHub metadata
    const updatedC = {
      ...seed.items.C,
      githubIssueNumber: 42,
      githubIssueId: 4200,
      status: 'in-progress' as const,
      assignee: '@github-copilot',
    };
    db.upsertItems([updatedC]);

    // Item C should be updated
    const refreshedC = db.get(seed.items.C.id);
    expect(refreshedC).toBeDefined();
    expect(refreshedC!.githubIssueNumber).toBe(42);
    expect(refreshedC!.status).toBe('in-progress');
    expect(refreshedC!.assignee).toBe('@github-copilot');

    // ALL other items, comments, and edges must be preserved
    assertAllItemsExist(db, seed);
    assertAllCommentsExist(db, seed);
    assertAllEdgesExist(db, seed);
  });

  // -----------------------------------------------------------------------
  // Push scenario
  // -----------------------------------------------------------------------

  it('push: upserting a batch of pushed items preserves non-pushed items', () => {
    const seed = seedDatabase(db);

    // Simulate push flow: only items A and B were pushed to GitHub
    const updatedA = { ...seed.items.A, githubIssueNumber: 100 };
    const updatedB = { ...seed.items.B, githubIssueNumber: 101 };
    db.upsertItems([updatedA, updatedB]);

    // Pushed items should be updated
    expect(db.get(seed.items.A.id)!.githubIssueNumber).toBe(100);
    expect(db.get(seed.items.B.id)!.githubIssueNumber).toBe(101);

    // Non-pushed items (C, D, E) must be preserved
    assertAllItemsExist(db, seed);
    assertAllCommentsExist(db, seed);
    assertAllEdgesExist(db, seed);
  });

  // -----------------------------------------------------------------------
  // Import-then-push scenario
  // -----------------------------------------------------------------------

  it('import-then-push: upserting merged items preserves unrelated items', () => {
    const seed = seedDatabase(db);

    // Simulate import-then-push: items A, B, C were imported/merged, then re-pushed
    const markedA = { ...seed.items.A, githubIssueNumber: 200, githubIssueId: 2000 };
    const markedB = { ...seed.items.B, githubIssueNumber: 201, githubIssueId: 2010 };
    const markedC = { ...seed.items.C, githubIssueNumber: 202, githubIssueId: 2020 };
    db.upsertItems([markedA, markedB, markedC]);

    // Merged items should have GitHub metadata
    expect(db.get(seed.items.A.id)!.githubIssueNumber).toBe(200);
    expect(db.get(seed.items.B.id)!.githubIssueNumber).toBe(201);
    expect(db.get(seed.items.C.id)!.githubIssueNumber).toBe(202);

    // Non-merged items (D, E) must be preserved
    assertAllItemsExist(db, seed);
    assertAllCommentsExist(db, seed);
    assertAllEdgesExist(db, seed);
  });

  // -----------------------------------------------------------------------
  // Edge preservation details
  // -----------------------------------------------------------------------

  it('upsert preserves dependency edges even when the upserted item is an endpoint', () => {
    const seed = seedDatabase(db);

    // Item A has edge A->B. Upsert item A with changes.
    const updatedA = { ...seed.items.A, title: 'Item A — updated via push' };
    db.upsertItems([updatedA]);

    // Edge A->B should still exist
    const edgesFromA = db.listDependencyEdgesFrom(seed.items.A.id);
    expect(edgesFromA.length).toBe(1);
    expect(edgesFromA[0].toId).toBe(seed.items.B.id);

    // Edge B->E (not involving the upserted item) should also exist
    const edgesFromB = db.listDependencyEdgesFrom(seed.items.B.id);
    expect(edgesFromB.length).toBe(1);
    expect(edgesFromB[0].toId).toBe(seed.items.E.id);
  });

  it('upsert can add new dependency edges for the upserted item', () => {
    const seed = seedDatabase(db);

    // Upsert item E with a new edge: E depends on A
    const updatedE = { ...seed.items.E, title: 'Item E — now depends on A' };
    db.upsertItems(
      [updatedE],
      [{ fromId: seed.items.E.id, toId: seed.items.A.id, createdAt: new Date().toISOString() }],
    );

    // New edge E->A should exist
    const edgesFromE = db.listDependencyEdgesFrom(seed.items.E.id);
    const newEdge = edgesFromE.find(e => e.toId === seed.items.A.id);
    expect(newEdge).toBeDefined();

    // All original edges should still exist
    assertAllEdgesExist(db, seed);
  });

  // -----------------------------------------------------------------------
  // Comment preservation details
  // -----------------------------------------------------------------------

  it('comments on non-upserted items remain intact after upsert', () => {
    const seed = seedDatabase(db);

    // Upsert only item C — items A, B, E have comments
    db.upsertItems([{ ...seed.items.C, status: 'in-progress' as const }]);

    // Check item A's comments specifically
    const commentsA = db.getCommentsForWorkItem(seed.items.A.id);
    expect(commentsA.length).toBe(2);
    expect(commentsA.map(c => c.author).sort()).toEqual(['alice', 'bob']);

    // Check item B's comments
    const commentsB = db.getCommentsForWorkItem(seed.items.B.id);
    expect(commentsB.length).toBe(1);
    expect(commentsB[0].author).toBe('carol');

    // Check item E's comments
    const commentsE = db.getCommentsForWorkItem(seed.items.E.id);
    expect(commentsE.length).toBe(1);
    expect(commentsE[0].author).toBe('eve');

    // Check item C's comment is also preserved
    const commentsC = db.getCommentsForWorkItem(seed.items.C.id);
    expect(commentsC.length).toBe(1);
    expect(commentsC[0].author).toBe('dave');
  });

  // -----------------------------------------------------------------------
  // JSONL export integrity
  // -----------------------------------------------------------------------

  it('JSONL roundtrip preserves all items after upsert', () => {
    const seed = seedDatabase(db);

    // Upsert a single item
    db.upsertItems([{ ...seed.items.C, githubIssueNumber: 99 }]);

    // Close and re-open from JSONL to verify the export is complete
    db.close();
    const db2 = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);

    try {
      assertAllItemsExist(db2, seed);
      assertAllCommentsExist(db2, seed);
      assertAllEdgesExist(db2, seed);

      // The upserted change should persist
      expect(db2.get(seed.items.C.id)!.githubIssueNumber).toBe(99);
    } finally {
      db2.close();
    }

    // Re-open for afterEach cleanup
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
  });

  // -----------------------------------------------------------------------
  // Regression guard: db.import() IS destructive
  // -----------------------------------------------------------------------

  it('REGRESSION GUARD: db.import() with a partial set DESTROYS non-included items', () => {
    const seed = seedDatabase(db);

    // Use the destructive import() with only item C — this is the old bug
    db.import([{ ...seed.items.C, githubIssueNumber: 42 }]);

    // Only item C should remain; all others are destroyed
    const all = db.getAll();
    expect(all.length).toBe(1);
    expect(all[0].id).toBe(seed.items.C.id);

    // Items A, B, D, E are gone
    expect(db.get(seed.items.A.id)).toBeNull();
    expect(db.get(seed.items.B.id)).toBeNull();
    expect(db.get(seed.items.D.id)).toBeNull();
    expect(db.get(seed.items.E.id)).toBeNull();

    // Edges involving destroyed items are gone
    expect(db.listDependencyEdgesFrom(seed.items.A.id).length).toBe(0);
    expect(db.listDependencyEdgesFrom(seed.items.B.id).length).toBe(0);
    expect(db.listDependencyEdgesFrom(seed.items.D.id).length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Concurrent-style scenario: multiple sequential upserts
  // -----------------------------------------------------------------------

  it('multiple sequential upserts each preserve all data from previous operations', () => {
    const seed = seedDatabase(db);

    // First upsert: delegate item C
    db.upsertItems([{ ...seed.items.C, githubIssueNumber: 300, assignee: '@copilot' }]);

    // Second upsert: push item A
    db.upsertItems([{ ...seed.items.A, githubIssueNumber: 301 }]);

    // Third upsert: push items B and E
    db.upsertItems([
      { ...seed.items.B, githubIssueNumber: 302 },
      { ...seed.items.E, githubIssueNumber: 303 },
    ]);

    // All items should exist with their latest updates
    const all = db.getAll();
    expect(all.length).toBe(5);
    expect(db.get(seed.items.C.id)!.githubIssueNumber).toBe(300);
    expect(db.get(seed.items.A.id)!.githubIssueNumber).toBe(301);
    expect(db.get(seed.items.B.id)!.githubIssueNumber).toBe(302);
    expect(db.get(seed.items.E.id)!.githubIssueNumber).toBe(303);

    // Item D (never upserted) should still exist untouched
    const dItem = db.get(seed.items.D.id);
    expect(dItem).toBeDefined();
    expect(dItem!.title).toBe('Item D — child of C');

    // All comments and edges preserved
    assertAllCommentsExist(db, seed);
    assertAllEdgesExist(db, seed);
  });
});
