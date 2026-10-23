/**
 * Persist write-detection regression tests (WL-0MVK6S4HM005GBCO).
 *
 * Parent epic WL-0MVK3WRY9009KV6P requires `wl sync` to stop re-importing and
 * re-indexing the whole store when the merge result is unchanged. F2 measured
 * the persist phase at ~97 % of the `wl sync` pipeline with 78–90 % of the CPU
 * inside `upsertFtsEntry` (WL-0MVJV2NNG00771C6): `db.import()` cleared every
 * work item, re-saved every item and re-indexed every FTS row, and
 * `db.importComments()` did the same for all comments and all items. A
 * no-change sync therefore paid the whole cost.
 *
 * These tests instrument the persistent store's write methods (the spies keep
 * the real implementations, so they count actual real-path writes) and pin the
 * write-detection contract that the persist rewrite must keep:
 *
 *   1. `import()` of an identical full record set performs ZERO record writes
 *      (`saveWorkItem` / `saveDependencyEdge` / `saveAuditResults`) and ZERO
 *      FTS upserts — no destructive clear-and-re-insert on a no-op;
 *   2. `importComments()` of an identical comment set performs ZERO
 *      `saveComment` writes and ZERO FTS upserts;
 *   3. a CHANGED import writes only the differing records: one changed work
 *      item → a single `saveWorkItem` + one FTS upsert for it, one
 *      added/removed/changed comment → a single `saveComment` and FTS upkeep
 *      only for the affected parent item(s);
 *   4. records absent from the incoming full snapshot are still deleted
 *      (items, comments, edges, audits) and their FTS rows removed —
 *      destructive-replace semantics are preserved.
 *
 * The delta path (`upsertComments()`) must likewise look up only the affected
 * parents instead of scanning every item (parent AC3).
 *
 * The default suite is `tests/cli` + `tests/unit` (`.pi/test-config.json`), so
 * these live here rather than only in `packages/shared/src/database.test.ts`
 * (which carries the pre-existing `import()`/`upsertItems()` semantics tests)
 * — otherwise the regression would never run at the dev-push gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorklogDatabase } from '../../src/database.js';
import { WorkItem, Comment, DependencyEdge, AuditResult } from '../../src/types.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from '../test-utils.js';

const FIXED_TS = '2026-01-01T00:00:00.000Z';

/**
 * Structural view of the persistent store's write surface. The store is a
 * private field of WorklogDatabase; casting to this shape lets the tests spy
 * on the exact methods the persist path calls without widening the production
 * API for tests.
 */
interface StoreWriteSurface {
  saveWorkItem(item: WorkItem): void;
  saveComment(comment: Comment): void;
  saveDependencyEdge(edge: DependencyEdge): void;
  saveAuditResults(audits: AuditResult[]): void;
  upsertFtsEntry(item: WorkItem): void;
  deleteFtsEntry(itemId: string): void;
  clearWorkItems(): void;
  clearComments(): void;
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WI-0001',
    title: 'Fix the bug',
    description: 'A description with some detail.',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    tags: [],
    assignee: '',
    stage: 'idea',
    issueType: 'bug',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    needsProducerReview: false,
    ...overrides,
  };
}

function makeComment(id: string, itemId: string, text: string): Comment {
  return {
    id,
    workItemId: itemId,
    author: 'test@example.com',
    comment: text,
    createdAt: FIXED_TS,
    references: [],
  };
}

function makeEdge(fromId: string, toId: string, createdAt = FIXED_TS): DependencyEdge {
  return { fromId, toId, createdAt };
}

function makeAudit(workItemId: string, overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    workItemId,
    readyToClose: false,
    auditedAt: FIXED_TS,
    summary: 'summary',
    rawOutput: null,
    author: 'AUDITOR',
    ...overrides,
  };
}

describe('persist write-detection (WL-0MVK6S4HM005GBCO)', () => {
  let tempDir: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    db = new WorklogDatabase(
      'TEST',
      createTempDbPath(tempDir),
      createTempJsonlPath(tempDir),
      true,
      false,
    );
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  function storeOf(): StoreWriteSurface {
    return (db as unknown as { store: StoreWriteSurface }).store;
  }

  /** Instrument every write method the persist path uses (real impls kept). */
  function instrument() {
    const store = storeOf();
    return {
      saveWorkItem: vi.spyOn(store, 'saveWorkItem'),
      saveComment: vi.spyOn(store, 'saveComment'),
      saveDependencyEdge: vi.spyOn(store, 'saveDependencyEdge'),
      saveAuditResults: vi.spyOn(store, 'saveAuditResults'),
      upsertFtsEntry: vi.spyOn(store, 'upsertFtsEntry'),
      deleteFtsEntry: vi.spyOn(store, 'deleteFtsEntry'),
      clearWorkItems: vi.spyOn(store, 'clearWorkItems'),
      clearComments: vi.spyOn(store, 'clearComments'),
    };
  }

  describe('no-change imports', () => {
    it('import() of an identical full record set performs zero record writes and zero FTS upserts', () => {
      const items = [
        makeItem({ id: 'WI-0001' }),
        makeItem({ id: 'WI-0002', title: 'Second item' }),
      ];
      const edges = [makeEdge('WI-0001', 'WI-0002')];
      const audits = [makeAudit('WI-0001')];
      db.import(items, edges, audits);

      const w = instrument();
      db.import(items, edges, audits);

      expect(w.saveWorkItem).not.toHaveBeenCalled();
      expect(w.saveDependencyEdge).not.toHaveBeenCalled();
      expect(w.saveAuditResults).not.toHaveBeenCalled();
      expect(w.upsertFtsEntry).not.toHaveBeenCalled();
      expect(w.clearWorkItems).not.toHaveBeenCalled();
      // State is untouched by the no-change re-import.
      expect(db.getAll().length).toBe(2);
      expect(db.getAllDependencyEdges().length).toBe(1);
      expect(db.getAllAuditResults().length).toBe(1);
    });

    it('importComments() of an identical comment set performs zero saveComment writes and zero FTS upserts', () => {
      db.import([makeItem({ id: 'WI-0001' })]);
      const comment = makeComment('C-1', 'WI-0001', 'hello');
      db.importComments([comment]);

      const w = instrument();
      db.importComments([comment]);

      expect(w.saveComment).not.toHaveBeenCalled();
      expect(w.upsertFtsEntry).not.toHaveBeenCalled();
      expect(w.clearComments).not.toHaveBeenCalled();
      expect(db.getAllComments().length).toBe(1);
    });
  });

  describe('changed imports', () => {
    it('import() with one changed work item writes exactly that item and its FTS row (siblings untouched)', () => {
      db.import([
        makeItem({ id: 'WI-0001' }),
        makeItem({ id: 'WI-0002', title: 'Second item' }),
      ]);

      const w = instrument();
      db.import([
        makeItem({ id: 'WI-0001', title: 'First item changed' }),
        makeItem({ id: 'WI-0002', title: 'Second item' }),
      ]);

      expect(w.saveWorkItem).toHaveBeenCalledTimes(1);
      expect(w.saveWorkItem.mock.calls[0][0].id).toBe('WI-0001');
      expect(w.upsertFtsEntry).toHaveBeenCalledTimes(1);
      expect(w.upsertFtsEntry.mock.calls[0][0].id).toBe('WI-0001');
      // Unchanged sibling is not rewritten.
      expect(db.get('WI-0002')?.title).toBe('Second item');
      expect(db.get('WI-0001')?.title).toBe('First item changed');
    });

    it('import() does not rewrite unchanged dependency edges or audit results when items change', () => {
      const items = [
        makeItem({ id: 'WI-0001' }),
        makeItem({ id: 'WI-0002', title: 'Second item' }),
      ];
      const edges = [makeEdge('WI-0001', 'WI-0002')];
      const audits = [makeAudit('WI-0001')];
      db.import(items, edges, audits);

      const w = instrument();
      db.import(
        [
          makeItem({ id: 'WI-0001', title: 'changed' }),
          makeItem({ id: 'WI-0002', title: 'Second item' }),
        ],
        edges,
        audits,
      );

      expect(w.saveWorkItem).toHaveBeenCalledTimes(1);
      expect(w.saveDependencyEdge).not.toHaveBeenCalled();
      expect(w.saveAuditResults).not.toHaveBeenCalled();
    });

    it('an identical item carrying a later incoming activityAt is persisted without bumping updatedAt', () => {
      db.import([makeItem({ id: 'WI-0001' })]);

      const w = instrument();
      db.import([{ ...makeItem({ id: 'WI-0001' }), activityAt: '2026-06-01T00:00:00.000Z' }]);

      expect(w.saveWorkItem).toHaveBeenCalledTimes(1);
      const saved = db.get('WI-0001');
      expect(saved?.activityAt).toBe('2026-06-01T00:00:00.000Z');
      expect(saved?.updatedAt).toBe(FIXED_TS);
    });

    it('importComments() with one added comment writes exactly that comment and FTS-upserts only its parent', () => {
      db.import([
        makeItem({ id: 'WI-0001' }),
        makeItem({ id: 'WI-0002', title: 'Second item' }),
      ]);
      db.importComments([makeComment('C-1', 'WI-0001', 'original')]);

      const w = instrument();
      db.importComments([
        makeComment('C-1', 'WI-0001', 'original'),
        makeComment('C-2', 'WI-0002', 'new comment'),
      ]);

      expect(w.saveComment).toHaveBeenCalledTimes(1);
      expect(w.saveComment.mock.calls[0][0].id).toBe('C-2');
      expect(w.upsertFtsEntry).toHaveBeenCalledTimes(1);
      expect(w.upsertFtsEntry.mock.calls[0][0].id).toBe('WI-0002');
    });

    it('importComments() with one removed comment deletes it and FTS-upserts only its parent', () => {
      db.import([
        makeItem({ id: 'WI-0001' }),
        makeItem({ id: 'WI-0002', title: 'Second item' }),
      ]);
      db.importComments([
        makeComment('C-1', 'WI-0001', 'keep me'),
        makeComment('C-2', 'WI-0002', 'drop me'),
      ]);

      const w = instrument();
      db.importComments([makeComment('C-1', 'WI-0001', 'keep me')]);

      expect(w.saveComment).not.toHaveBeenCalled();
      expect(w.upsertFtsEntry).toHaveBeenCalledTimes(1);
      expect(w.upsertFtsEntry.mock.calls[0][0].id).toBe('WI-0002');
      expect(db.getComment('C-2')).toBeNull();
    });

    it('importComments() with one changed comment writes only that comment and FTS-upserts its parent', () => {
      db.import([makeItem({ id: 'WI-0001' })]);
      db.importComments([makeComment('C-1', 'WI-0001', 'before')]);

      const w = instrument();
      db.importComments([makeComment('C-1', 'WI-0001', 'after')]);

      expect(w.saveComment).toHaveBeenCalledTimes(1);
      expect(w.saveComment.mock.calls[0][0].id).toBe('C-1');
      expect(w.upsertFtsEntry).toHaveBeenCalledTimes(1);
      expect(w.upsertFtsEntry.mock.calls[0][0].id).toBe('WI-0001');
      expect(db.getComment('C-1')?.comment).toBe('after');
    });

    it('upsertComments() performs FTS upkeep only for the affected parent items', () => {
      db.import([
        makeItem({ id: 'WI-0001' }),
        makeItem({ id: 'WI-0002', title: 'Second item' }),
      ]);
      db.importComments([
        makeComment('C-1', 'WI-0001', 'a'),
        makeComment('C-2', 'WI-0002', 'b'),
      ]);

      const w = instrument();
      db.upsertComments([makeComment('C-2', 'WI-0002', 'b updated')]);

      expect(w.saveComment).toHaveBeenCalledTimes(1);
      expect(w.upsertFtsEntry).toHaveBeenCalledTimes(1);
      expect(w.upsertFtsEntry.mock.calls[0][0].id).toBe('WI-0002');
    });
  });

  describe('destructive replace is preserved', () => {
    it('import() still deletes records absent from the incoming set and removes their FTS rows', () => {
      db.import([
        makeItem({ id: 'WI-0001' }),
        makeItem({ id: 'WI-0002', title: 'Second item' }),
      ]);
      db.createComment({ workItemId: 'WI-0001', author: 'tester', comment: 'a comment on A' });
      db.addDependencyEdge('WI-0001', 'WI-0002');
      db.saveAuditResult({
        workItemId: 'WI-0001',
        readyToClose: true,
        auditedAt: FIXED_TS,
        summary: 'ok',
        rawOutput: null,
        author: 'auditor',
      });

      const w = instrument();
      db.import([makeItem({ id: 'WI-0002', title: 'Second item' })]);

      // Item removed → its comments, edge and audit cascade; FTS row removed.
      expect(db.get('WI-0001')).toBeNull();
      expect(db.getCommentsForWorkItem('WI-0001')).toEqual([]);
      expect(db.getAllDependencyEdges().length).toBe(0);
      expect(db.getAllAuditResults().length).toBe(0);
      expect(w.deleteFtsEntry).toHaveBeenCalledWith('WI-0001');
      // The removed item is no longer searchable.
      expect(db.search('Fix the bug').results.some(r => r.itemId === 'WI-0001')).toBe(false);
      // Pure-deletion import: nothing is re-saved.
      expect(w.saveWorkItem).not.toHaveBeenCalled();
    });

    it('import() with an empty snapshot still clears every item and its FTS rows', () => {
      db.import([
        makeItem({ id: 'WI-0001' }),
        makeItem({ id: 'WI-0002', title: 'Second item' }),
      ]);

      const w = instrument();
      db.import([]);

      expect(db.getAll().length).toBe(0);
      expect(w.deleteFtsEntry).toHaveBeenCalledTimes(2);
      expect(w.saveWorkItem).not.toHaveBeenCalled();
      expect(db.search('Fix the bug').results.length).toBe(0);
    });
  });

  describe('transactional atomicity (AC4 — one transaction per record type)', () => {
    it('importComments() rolls back the whole comment snapshot when a save fails mid-transaction', () => {
      db.import([
        makeItem({ id: 'WI-0001' }),
        makeItem({ id: 'WI-0002', title: 'Second item' }),
      ]);
      db.importComments([
        makeComment('C-1', 'WI-0001', 'one'),
        makeComment('C-2', 'WI-0001', 'two'),
        makeComment('C-3', 'WI-0002', 'three'),
      ]);

      const store = storeOf();
      const realSaveComment = store.saveComment.bind(store);
      let saves = 0;
      const spy = vi.spyOn(store, 'saveComment').mockImplementation(comment => {
        saves += 1;
        if (saves === 2) {
          throw new Error('simulated save failure');
        }
        realSaveComment(comment);
      });

      // Incoming snapshot is missing C-2 (delete) and changes C-1 + C-3
      // (two saves; the second one throws).
      expect(() =>
        db.importComments([
          makeComment('C-1', 'WI-0001', 'one updated'),
          makeComment('C-3', 'WI-0002', 'three updated'),
        ]),
      ).toThrow('simulated save failure');
      spy.mockRestore();

      // Nothing from the failed snapshot survives — not the C-2 deletion and
      // not the already-executed C-1 save.
      expect(db.getComment('C-1')?.comment).toBe('one');
      expect(db.getComment('C-2')?.comment).toBe('two');
      expect(db.getComment('C-3')?.comment).toBe('three');
      expect(db.getAllComments().length).toBe(3);
    });

    it('import() rolls back every record type when a save fails mid-transaction', () => {
      const items = [
        makeItem({ id: 'WI-0001' }),
        makeItem({ id: 'WI-0002', title: 'Second item' }),
      ];
      db.import(items, [makeEdge('WI-0001', 'WI-0002')]);

      const store = storeOf();
      const realSaveWorkItem = store.saveWorkItem.bind(store);
      let saves = 0;
      const spy = vi.spyOn(store, 'saveWorkItem').mockImplementation(item => {
        saves += 1;
        if (saves === 2) {
          throw new Error('simulated save failure');
        }
        realSaveWorkItem(item);
      });

      // Incoming snapshot removes WI-0002, changes WI-0001 and adds WI-0003.
      // The WI-0003 save throws after WI-0001 was already written.
      expect(() =>
        db.import([
          makeItem({ id: 'WI-0001', title: 'changed' }),
          makeItem({ id: 'WI-0003', title: 'third item' }),
        ]),
      ).toThrow('simulated save failure');
      spy.mockRestore();

      // The whole differential persist is atomic: the deletion, the changed
      // item and the new item are all rolled back together.
      expect(db.get('WI-0001')?.title).toBe('Fix the bug');
      expect(db.get('WI-0002')?.title).toBe('Second item');
      expect(db.get('WI-0003')).toBeNull();
      // The edge cascaded from the (rolled-back) WI-0002 delete is restored.
      expect(db.getAllDependencyEdges().map(e => `${e.fromId}->${e.toId}`)).toEqual([
        'WI-0001->WI-0002',
      ]);
    });
  });
});
