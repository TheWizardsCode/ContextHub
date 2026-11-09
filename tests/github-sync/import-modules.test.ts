/**
 * tests/github-sync/import-modules.test.ts — behaviour of the extracted import
 * phase modules of the github-sync flow.
 *
 * `importIssuesToWorkItems` moved out of `src/github-sync.ts`
 * (WL-0MW0JFANE006VCGO, child 7 of 8 of the WL-0MVGKH9Z900178UF decomposition)
 * into an orchestrator plus three cohesive phase modules. The unchanged flow
 * suites (`github-import-label-resolution.test.ts`, `github-sync-comments.test.ts`,
 * `github-comment-import-push.test.ts`, `github-sync-deleted.test.ts`) remain
 * the end-to-end behaviour gate for the move — they exercise `fetchIssuesAndHierarchy`,
 * `runImportCloseCheck` and `importIssueComments` through the public
 * `importIssuesToWorkItems`. This file deliberately pins the *new seam* the
 * extraction introduced: the shared scan state and the hint/metadata helpers,
 * which are pure functions over plain maps and are therefore covered here
 * without mocking the github module at all.
 *
 * | Property | Why it matters |
 * |---|---|
 * | the two scan phases record hints differently — the issue loop replaces **and clears**, the close-check only sets | a marker removed on GitHub must clear the hint, while the close-check pass must never undo a hint another issue established |
 * | merged items are stamped with the marker parent hint and the GitHub issue identity | that mapping is what the next sync resolves items by |
 * | an item without metadata or hint is returned untouched (identity-preserved) | the merge must not churn items it knows nothing about |
 * | hint application runs marker child hints, then hierarchy parent hints, then hierarchy child hints | the later pass wins, so this order is the contract |
 * | hints naming items or issues outside the import are skipped | a partial `since` import must not invent parents |
 */

import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../../src/types.js';
import {
  applyParentChildHints,
  applyParentHintsAndIssueMetadata,
  createImportScanState,
  recordCloseCheckIssueHints,
  recordIssueHints,
} from '../../src/github-sync/import-hierarchy.js';

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: overrides.id,
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    tags: [],
    assignee: '',
    stage: '',
    issueType: '',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  } as WorkItem;
}

function emptyState() {
  return createImportScanState(new Map(), new Map());
}

describe('createImportScanState', () => {
  it('starts empty but seeded with the fetch-time hierarchy maps', () => {
    const hierarchy = new Map([[1, { parentIssueNumber: null, childIssueNumbers: [2] }]]);
    const parentByChild = new Map([[2, 1]]);

    const state = createImportScanState(hierarchy, parentByChild);

    // The hierarchy maps are the ones the fetch produced, not copies.
    expect(state.hierarchyByIssueNumber).toBe(hierarchy);
    expect(state.parentByChildIssueNumber).toBe(parentByChild);
    expect(state.remoteItemsById.size).toBe(0);
    expect(state.issueMetaById.size).toBe(0);
    expect(state.parentHints.size).toBe(0);
    expect(state.childHints.size).toBe(0);
    expect(state.parentIssueHints.size).toBe(0);
    expect(state.childIssueHints.size).toBe(0);
    expect(state.seenIssueNumbers.size).toBe(0);
    expect(state.pendingResolutions).toEqual([]);
    expect(state.issueClosedById.size).toBe(0);
  });

  it('gives each state its own maps so two imports never share scan results', () => {
    const first = emptyState();
    first.parentHints.set('WL-A', 'WL-P');
    first.seenIssueNumbers.add(1);

    const second = emptyState();

    expect(second.parentHints.size).toBe(0);
    expect(second.seenIssueNumbers.size).toBe(0);
  });
});

describe('recordIssueHints (issue-loop semantics)', () => {
  it('records every hint kind and replaces an existing one', () => {
    const state = emptyState();
    recordIssueHints(state, 'WL-A', {
      parentId: 'WL-P1',
      childIds: ['WL-C1'],
      parentIssueNumber: 5,
      childIssueNumbers: [6],
    });

    expect(state.parentHints.get('WL-A')).toBe('WL-P1');
    expect(state.childHints.get('WL-A')).toEqual(['WL-C1']);
    expect(state.parentIssueHints.get('WL-A')).toBe(5);
    expect(state.childIssueHints.get('WL-A')).toEqual([6]);

    recordIssueHints(state, 'WL-A', {
      parentId: 'WL-P2',
      childIds: ['WL-C2', 'WL-C3'],
      parentIssueNumber: 7,
      childIssueNumbers: [8, 9],
    });

    expect(state.parentHints.get('WL-A')).toBe('WL-P2');
    expect(state.childHints.get('WL-A')).toEqual(['WL-C2', 'WL-C3']);
    expect(state.parentIssueHints.get('WL-A')).toBe(7);
    expect(state.childIssueHints.get('WL-A')).toEqual([8, 9]);
  });

  it('clears a hint whose marker disappeared instead of leaving it stale', () => {
    const state = emptyState();
    recordIssueHints(state, 'WL-A', {
      parentId: 'WL-P',
      childIds: ['WL-C'],
      parentIssueNumber: 5,
      childIssueNumbers: [6],
    });

    recordIssueHints(state, 'WL-A', {
      parentId: null,
      childIds: [],
      parentIssueNumber: null,
      childIssueNumbers: [],
    });

    expect(state.parentHints.has('WL-A')).toBe(false);
    expect(state.childHints.has('WL-A')).toBe(false);
    expect(state.parentIssueHints.has('WL-A')).toBe(false);
    expect(state.childIssueHints.has('WL-A')).toBe(false);
  });

  it('treats a zero parent issue number as absent, like the marker parsers do', () => {
    const state = emptyState();
    recordIssueHints(state, 'WL-A', {
      parentId: '',
      childIds: [],
      parentIssueNumber: 0,
      childIssueNumbers: [],
    });

    expect(state.parentHints.has('WL-A')).toBe(false);
    expect(state.parentIssueHints.has('WL-A')).toBe(false);
  });
});

describe('recordCloseCheckIssueHints (close-check semantics)', () => {
  it('only ever sets a hint, never clears one', () => {
    const state = emptyState();
    recordIssueHints(state, 'WL-A', {
      parentId: 'WL-MARKER-PARENT',
      childIds: ['WL-MARKER-CHILD'],
      parentIssueNumber: 5,
      childIssueNumbers: [6],
    });

    // A close-check pass over the same item with no hints must be inert: the
    // issue loop owns clearing, because it is the pass that sees the markers.
    recordCloseCheckIssueHints(state, 'WL-A', {
      parentId: null,
      childIds: [],
      parentIssueNumber: null,
      childIssueNumbers: [],
    });

    expect(state.parentHints.get('WL-A')).toBe('WL-MARKER-PARENT');
    expect(state.childHints.get('WL-A')).toEqual(['WL-MARKER-CHILD']);
    expect(state.parentIssueHints.get('WL-A')).toBe(5);
    expect(state.childIssueHints.get('WL-A')).toEqual([6]);
  });

  it('records hints for an item the issue loop never saw', () => {
    const state = emptyState();

    recordCloseCheckIssueHints(state, 'WL-B', {
      parentId: 'WL-P',
      childIds: ['WL-C'],
      parentIssueNumber: 9,
      childIssueNumbers: [10],
    });

    expect(state.parentHints.get('WL-B')).toBe('WL-P');
    expect(state.childHints.get('WL-B')).toEqual(['WL-C']);
    expect(state.parentIssueHints.get('WL-B')).toBe(9);
    expect(state.childIssueHints.get('WL-B')).toEqual([10]);
  });
});

describe('applyParentHintsAndIssueMetadata', () => {
  it('stamps the GitHub issue identity and prefers the marker parent hint', () => {
    const state = emptyState();
    state.issueMetaById.set('WL-A', { number: 4, id: 404, updatedAt: '2025-02-01T00:00:00.000Z' });
    state.parentHints.set('WL-A', 'WL-REMOTE-PARENT');

    const [stamped] = applyParentHintsAndIssueMetadata(
      [makeItem({ id: 'WL-A', parentId: 'WL-LOCAL-PARENT' })],
      state,
    );

    expect(stamped).toEqual(
      makeItem({
        id: 'WL-A',
        parentId: 'WL-REMOTE-PARENT',
        githubIssueNumber: 4,
        githubIssueId: 404,
        githubIssueUpdatedAt: '2025-02-01T00:00:00.000Z',
      }),
    );
  });

  it('keeps the local parent when metadata exists without a parent hint', () => {
    const state = emptyState();
    state.issueMetaById.set('WL-A', { number: 4, id: 404, updatedAt: '2025-02-01T00:00:00.000Z' });

    const [stamped] = applyParentHintsAndIssueMetadata(
      [makeItem({ id: 'WL-A', parentId: 'WL-LOCAL-PARENT' })],
      state,
    );

    expect(stamped.parentId).toBe('WL-LOCAL-PARENT');
    expect(stamped.githubIssueNumber).toBe(4);
    expect(stamped.githubIssueId).toBe(404);
  });

  it('returns an item with neither metadata nor hint unchanged (same reference)', () => {
    const state = emptyState();
    const item = makeItem({ id: 'WL-A', parentId: 'WL-LOCAL-PARENT' });

    const [stamped] = applyParentHintsAndIssueMetadata([item], state);

    expect(stamped).toBe(item);
  });

  it('applies a marker parent hint to an item that has no GitHub metadata', () => {
    const state = emptyState();
    state.parentHints.set('WL-A', 'WL-P');

    const [stamped] = applyParentHintsAndIssueMetadata([makeItem({ id: 'WL-A' })], state);

    expect(stamped.parentId).toBe('WL-P');
    expect(stamped.githubIssueNumber).toBeUndefined();
  });

  it('stamps every item of the list and preserves list order', () => {
    const state = emptyState();
    state.issueMetaById.set('WL-B', { number: 2, id: 22, updatedAt: '2025-03-01T00:00:00.000Z' });

    const stamped = applyParentHintsAndIssueMetadata(
      [makeItem({ id: 'WL-A' }), makeItem({ id: 'WL-B' })],
      state,
    );

    expect(stamped.map((item) => item.id)).toEqual(['WL-A', 'WL-B']);
    expect(stamped[0].githubIssueNumber).toBeUndefined();
    expect(stamped[1].githubIssueNumber).toBe(2);
  });
});

describe('applyParentChildHints', () => {
  it('runs marker child hints first, then the hierarchy hints (later pass wins)', () => {
    const state = emptyState();
    state.childHints.set('WL-MARKER-PARENT', ['WL-X']);
    state.parentIssueHints.set('WL-X', 20);
    state.childIssueHints.set('WL-MARKER-PARENT', [30]);
    const markerChild = makeItem({ id: 'WL-X', githubIssueNumber: 10 });
    const hierarchyParent = makeItem({ id: 'WL-H', githubIssueNumber: 20 });
    const hierarchyChild = makeItem({ id: 'WL-C', githubIssueNumber: 30 });
    const merged = [markerChild, hierarchyParent, hierarchyChild];

    applyParentChildHints(merged, state);

    // The marker pass set WL-X's parent, then the hierarchy parent-issue pass
    // overrode it — the historical order, which the extraction must preserve.
    expect(markerChild.parentId).toBe('WL-H');
    expect(hierarchyChild.parentId).toBe('WL-MARKER-PARENT');
  });

  it('applies marker child hints without any hierarchy hint map', () => {
    const state = emptyState();
    state.childHints.set('WL-P', ['WL-C1', 'WL-C2']);
    const child1 = makeItem({ id: 'WL-C1' });
    const child2 = makeItem({ id: 'WL-C2' });

    applyParentChildHints([makeItem({ id: 'WL-P' }), child1, child2], state);

    expect(child1.parentId).toBe('WL-P');
    expect(child2.parentId).toBe('WL-P');
  });

  it('resolves a parent issue number to the imported item that carries it', () => {
    const state = emptyState();
    state.parentIssueHints.set('WL-CHILD', 77);
    const child = makeItem({ id: 'WL-CHILD', githubIssueNumber: 10 });
    const parent = makeItem({ id: 'WL-PARENT', githubIssueNumber: 77 });

    applyParentChildHints([child, parent], state);

    expect(child.parentId).toBe('WL-PARENT');
  });

  it('skips hints naming items or issues outside this import', () => {
    const state = emptyState();
    state.childHints.set('WL-MISSING-PARENT', ['WL-NOT-IMPORTED']);
    state.parentIssueHints.set('WL-A', 999);
    state.childIssueHints.set('WL-A', [888]);
    const item = makeItem({ id: 'WL-A', githubIssueNumber: 1 });

    applyParentChildHints([item], state);

    expect(item.parentId).toBeNull();
  });

  it('leaves parents untouched when no hint map holds an entry', () => {
    const state = emptyState();
    const item = makeItem({ id: 'WL-A', parentId: 'WL-KEEP' });

    applyParentChildHints([item], state);

    expect(item.parentId).toBe('WL-KEEP');
  });

  it('applies both hierarchy maps in one pass', () => {
    const state = emptyState();
    state.parentIssueHints.set('WL-CHILD', 20);
    state.childIssueHints.set('WL-PARENT', [30]);
    const parent = makeItem({ id: 'WL-PARENT', githubIssueNumber: 20 });
    const child = makeItem({ id: 'WL-CHILD', githubIssueNumber: 10 });
    const grandchild = makeItem({ id: 'WL-GRANDCHILD', githubIssueNumber: 30 });

    applyParentChildHints([parent, child, grandchild], state);

    expect(child.parentId).toBe('WL-PARENT');
    expect(grandchild.parentId).toBe('WL-PARENT');
  });
});
