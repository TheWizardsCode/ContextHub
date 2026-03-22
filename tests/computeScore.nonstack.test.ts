import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';
import { WorklogDatabase } from '../src/database.js';

describe('computeScore non-stacking invariant', () => {
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

  it('applies only the in-progress boost (not ancestor boost) when item is itself in-progress', async () => {
    // Create a high-priority open item, then an in-progress parent (medium)
    const highOpen = db.create({ title: 'High open item', priority: 'high' });
    // ensure a deterministic createdAt ordering
    await new Promise(resolve => setTimeout(resolve, 10));
    const parent = db.create({ title: 'In-progress parent', priority: 'medium', status: 'in-progress' });
    db.create({ title: 'In-progress child', priority: 'medium', status: 'in-progress', parentId: parent.id });

    db.reSort();

    const updatedHighOpen = db.get(highOpen.id)!;
    const updatedParent = db.get(parent.id)!;

    // With correct non-stacking: highOpen should sort above parent
    expect(updatedHighOpen.sortIndex).toBeLessThan(updatedParent.sortIndex);
  });
});
