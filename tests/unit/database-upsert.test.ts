/**
 * Tests for WorklogDatabase.upsertItems()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { WorklogDatabase } from '../../src/database.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from '../test-utils.js';

describe('WorklogDatabase.upsertItems', () => {
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

  it('should upsert a single item without deleting existing items', () => {
    // Arrange: create two existing items
    const itemA = db.create({ title: 'Item A' });
    const itemB = db.create({ title: 'Item B' });

    // Act: upsert a new item C
    const itemC = {
      ...db.create({ title: 'Item C - placeholder' }),
      title: 'Item C - upserted',
    };
    // Delete the placeholder before upserting
    db.delete(itemC.id);
    db.upsertItems([{ ...itemC }]);

    // Assert: all three items exist
    const all = db.getAll();
    expect(all.length).toBe(3);
    expect(all.find(i => i.id === itemA.id)).toBeDefined();
    expect(all.find(i => i.id === itemB.id)).toBeDefined();
    const upserted = all.find(i => i.id === itemC.id);
    expect(upserted).toBeDefined();
    expect(upserted!.title).toBe('Item C - upserted');
  });

  it('should update an existing item in place via upsert', () => {
    // Arrange: create an item
    const item = db.create({ title: 'Original title' });

    // Act: upsert the same item with a new title
    db.upsertItems([{ ...item, title: 'Updated title', updatedAt: new Date().toISOString() }]);

    // Assert: the item is updated, not duplicated
    const all = db.getAll();
    expect(all.length).toBe(1);
    expect(all[0].title).toBe('Updated title');
  });

  it('should not delete any items when upserting an empty array', () => {
    // Arrange: create items
    const itemA = db.create({ title: 'Item A' });
    const itemB = db.create({ title: 'Item B' });

    // Act: upsert empty array
    db.upsertItems([]);

    // Assert: both items still exist
    const all = db.getAll();
    expect(all.length).toBe(2);
    expect(all.find(i => i.id === itemA.id)).toBeDefined();
    expect(all.find(i => i.id === itemB.id)).toBeDefined();
  });

  it('should not trigger export/sync when upserting an empty array', () => {
    // Arrange: create an item so JSONL has content, then record mtime
    db.create({ title: 'Existing item' });
    const statBefore = fs.statSync(jsonlPath);
    const mtimeBefore = statBefore.mtimeMs;

    // Small delay to ensure mtime difference is detectable
    const until = Date.now() + 50;
    while (Date.now() < until) { /* wait */ }

    // Act: upsert empty array
    db.upsertItems([]);

    // Assert: JSONL file was not re-written
    const statAfter = fs.statSync(jsonlPath);
    expect(statAfter.mtimeMs).toBe(mtimeBefore);
  });

  it('should preserve existing items when upserting a subset', () => {
    // Arrange: create three items
    const itemA = db.create({ title: 'Item A' });
    const itemB = db.create({ title: 'Item B' });
    const itemC = db.create({ title: 'Item C' });

    // Act: upsert only itemA with an update
    db.upsertItems([{ ...itemA, title: 'Item A - updated' }]);

    // Assert: all three items exist, only A is updated
    const all = db.getAll();
    expect(all.length).toBe(3);
    expect(all.find(i => i.id === itemA.id)!.title).toBe('Item A - updated');
    expect(all.find(i => i.id === itemB.id)!.title).toBe('Item B');
    expect(all.find(i => i.id === itemC.id)!.title).toBe('Item C');
  });

  it('should upsert dependency edges only for affected items', () => {
    // Arrange: create items and an existing edge
    const itemA = db.create({ title: 'Item A' });
    const itemB = db.create({ title: 'Item B' });
    const itemC = db.create({ title: 'Item C' });
    db.addDependencyEdge(itemA.id, itemB.id); // A depends on B

    // Act: upsert itemC with a new edge (C depends on A)
    db.upsertItems(
      [{ ...itemC, title: 'Item C - updated' }],
      [
        { fromId: itemC.id, toId: itemA.id, createdAt: new Date().toISOString() },
      ],
    );

    // Assert: original edge (A->B) is preserved, new edge (C->A) added
    const edgesFromA = db.listDependencyEdgesFrom(itemA.id);
    expect(edgesFromA.length).toBe(1);
    expect(edgesFromA[0].toId).toBe(itemB.id);

    const edgesFromC = db.listDependencyEdgesFrom(itemC.id);
    expect(edgesFromC.length).toBe(1);
    expect(edgesFromC[0].toId).toBe(itemA.id);
  });

  it('should ignore dependency edges where both endpoints are outside affected items', () => {
    // Arrange: create items
    const itemA = db.create({ title: 'Item A' });
    const itemB = db.create({ title: 'Item B' });
    const itemC = db.create({ title: 'Item C' });

    // Act: upsert itemC but pass an edge between A and B (neither is in the upsert set)
    db.upsertItems(
      [{ ...itemC, title: 'Item C - updated' }],
      [
        { fromId: itemA.id, toId: itemB.id, createdAt: new Date().toISOString() },
      ],
    );

    // Assert: the A->B edge was NOT created because neither A nor B is in the affected set
    const edgesFromA = db.listDependencyEdgesFrom(itemA.id);
    expect(edgesFromA.length).toBe(0);
  });

  it('should upsert edges where one endpoint is in the affected set', () => {
    // Arrange: create items
    const itemA = db.create({ title: 'Item A' });
    const itemB = db.create({ title: 'Item B' });

    // Act: upsert itemA with an edge (A depends on B) — A is in the affected set
    db.upsertItems(
      [{ ...itemA, title: 'Item A - updated' }],
      [
        { fromId: itemA.id, toId: itemB.id, createdAt: new Date().toISOString() },
      ],
    );

    // Assert: edge was created
    const edgesFromA = db.listDependencyEdgesFrom(itemA.id);
    expect(edgesFromA.length).toBe(1);
    expect(edgesFromA[0].toId).toBe(itemB.id);
  });

  it('should skip edges where referenced items do not exist in the database', () => {
    // Arrange: create one item
    const itemA = db.create({ title: 'Item A' });

    // Act: upsert itemA with an edge referencing a non-existent item
    db.upsertItems(
      [{ ...itemA }],
      [
        { fromId: itemA.id, toId: 'TEST-NONEXISTENT', createdAt: new Date().toISOString() },
      ],
    );

    // Assert: no edge created
    const edgesFromA = db.listDependencyEdgesFrom(itemA.id);
    expect(edgesFromA.length).toBe(0);
  });

  it('should not clear existing dependency edges when upserting', () => {
    // Arrange: create items with existing edges
    const itemA = db.create({ title: 'Item A' });
    const itemB = db.create({ title: 'Item B' });
    const itemC = db.create({ title: 'Item C' });
    db.addDependencyEdge(itemA.id, itemB.id); // A depends on B
    db.addDependencyEdge(itemB.id, itemC.id); // B depends on C

    // Act: upsert a totally new item with no edges
    const itemD = {
      ...db.create({ title: 'Item D - placeholder' }),
      title: 'Item D - upserted',
    };
    db.delete(itemD.id);
    db.upsertItems([{ ...itemD }]);

    // Assert: all original edges are preserved
    const edgesFromA = db.listDependencyEdgesFrom(itemA.id);
    expect(edgesFromA.length).toBe(1);
    expect(edgesFromA[0].toId).toBe(itemB.id);

    const edgesFromB = db.listDependencyEdgesFrom(itemB.id);
    expect(edgesFromB.length).toBe(1);
    expect(edgesFromB[0].toId).toBe(itemC.id);
  });

  it('should export to JSONL after upserting non-empty items', () => {
    // Arrange: create an item so JSONL exists
    db.create({ title: 'Existing item' });
    const statBefore = fs.statSync(jsonlPath);
    const mtimeBefore = statBefore.mtimeMs;

    // Small delay to ensure mtime difference is detectable
    const until = Date.now() + 50;
    while (Date.now() < until) { /* wait */ }

    // Act: upsert a new item
    const item = db.create({ title: 'Placeholder' });
    db.delete(item.id);

    // Wait again after delete export
    const until2 = Date.now() + 50;
    while (Date.now() < until2) { /* wait */ }
    const statAfterDelete = fs.statSync(jsonlPath);
    const mtimeAfterDelete = statAfterDelete.mtimeMs;

    // Wait to detect next mtime change
    const until3 = Date.now() + 50;
    while (Date.now() < until3) { /* wait */ }

    db.upsertItems([{ ...item, title: 'Upserted' }]);

    // Assert: JSONL file was re-written
    const statAfter = fs.statSync(jsonlPath);
    expect(statAfter.mtimeMs).toBeGreaterThan(mtimeAfterDelete);
  });

  it('should handle upserting multiple items at once', () => {
    // Arrange: create existing items
    const itemA = db.create({ title: 'Item A' });
    const itemB = db.create({ title: 'Item B' });

    // Act: upsert both with updates plus a new item
    const itemC = {
      ...db.create({ title: 'Item C - placeholder' }),
      title: 'Item C - new',
    };
    db.delete(itemC.id);

    db.upsertItems([
      { ...itemA, title: 'Item A - batch updated' },
      { ...itemB, title: 'Item B - batch updated' },
      { ...itemC },
    ]);

    // Assert: all three items exist with correct titles
    const all = db.getAll();
    expect(all.length).toBe(3);
    expect(all.find(i => i.id === itemA.id)!.title).toBe('Item A - batch updated');
    expect(all.find(i => i.id === itemB.id)!.title).toBe('Item B - batch updated');
    expect(all.find(i => i.id === itemC.id)!.title).toBe('Item C - new');
  });

  it('should not modify the existing import() method behavior', () => {
    // Arrange: create items
    const itemA = db.create({ title: 'Item A' });
    const itemB = db.create({ title: 'Item B' });

    // Act: use import() with only one item (the destructive path)
    db.import([{ ...itemA, title: 'Item A - imported' }]);

    // Assert: import() still clears all items first (only itemA exists)
    const all = db.getAll();
    expect(all.length).toBe(1);
    expect(all[0].title).toBe('Item A - imported');
  });
});
