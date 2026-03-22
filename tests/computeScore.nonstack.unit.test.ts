import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';
import { WorklogDatabase } from '../src/database.js';

describe('computeScore non-stacking unit', () => {
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

  it('applies only the in-progress boost (not ancestor boost) when item is in-progress', async () => {
    const highOpen = db.create({ title: 'High open item', priority: 'high' });
    // ensure deterministic ordering
    await new Promise(resolve => setTimeout(resolve, 10));
    const parent = db.create({ title: 'In-progress parent', priority: 'medium', status: 'in-progress' });
    const child = db.create({ title: 'In-progress child', priority: 'medium', status: 'in-progress', parentId: parent.id });

    // Build ancestorsOfInProgress set using the same logic as sortItemsByScore
    const items = db.getAll();
    const ancestorsOfInProgress = new Set<string>();
    for (const it of items) {
      if (it.status === 'in-progress') {
        let currentParentId = it.parentId ?? null;
        let depth = 0;
        while (currentParentId && depth < 50) {
          ancestorsOfInProgress.add(currentParentId);
          const p = db.get(currentParentId);
          currentParentId = p?.parentId ?? null;
          depth++;
        }
      }
    }

    const now = Date.now();
    const compute = (item: any) => (db as any).computeScore(item, now, 'ignore', ancestorsOfInProgress);

    // Compute additive baseline by forcing multiplier to 1 (status=open and no ancestor boost)
    const additiveParent = (db as any).computeScore({ ...parent, status: 'open' }, now, 'ignore', new Set());
    const finalParent = compute(parent);

    // Sanity: child is in-progress so parent is included in ancestorsOfInProgress
    expect(ancestorsOfInProgress.has(parent.id)).toBe(true);

    // finalParent should equal additiveParent * 1.5 (in-progress boost) and not * 1.25
    expect(finalParent).toBeCloseTo(additiveParent * 1.5, 6);
    expect(finalParent).not.toBeCloseTo(additiveParent * 1.25, 6);
  });
});
