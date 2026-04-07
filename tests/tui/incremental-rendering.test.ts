import { describe, it, expect } from 'vitest';
import { performance } from 'perf_hooks';
import {
  createTuiState,
  rebuildTreeState,
  buildVisibleNodes,
  incrementalExpand,
  incrementalCollapse,
} from '../../src/tui/state.js';

// ── helpers ───────────────────────────────────────────────────────────────────

type WI = {
  id: string;
  title: string;
  status: string;
  parentId?: string | null;
  sortIndex?: number;
  createdAt?: string;
};

function makeItem(id: string, parentId?: string | null): WI {
  return {
    id,
    title: `Item ${id}`,
    status: 'open',
    parentId: parentId ?? null,
    sortIndex: 0,
    createdAt: new Date().toISOString(),
  };
}

// ── Unit tests: incremental expand ───────────────────────────────────────────

describe('incrementalExpand', () => {
  it('returns cached nodes unchanged when node has no children', () => {
    const items = [makeItem('r'), makeItem('c', 'r')];
    const state = createTuiState(items as any, false, []);
    // prime the cache without expanding
    buildVisibleNodes(state);
    // node 0 ('r') has children but is not expanded — visible list = ['r']
    // Trying to expand a leaf at index 0 that has no children in visible list
    // i.e. 'r' has hasChildren=true but its children are hidden — expand it
    const initial = state.cachedVisibleNodes!.slice();
    expect(initial.length).toBe(1);

    const after = incrementalExpand(state, 0);
    expect(after.length).toBe(2);
    expect(after[0].item.id).toBe('r');
    expect(after[1].item.id).toBe('c');
    expect(state.expanded.has('r')).toBe(true);
    expect(state.cachedVisibleNodes).toBe(after);
  });

  it('returns cache unchanged when node is already expanded', () => {
    const items = [makeItem('r'), makeItem('c', 'r')];
    const state = createTuiState(items as any, false, ['r']);
    buildVisibleNodes(state);
    const before = state.cachedVisibleNodes!;
    const after = incrementalExpand(state, 0);
    expect(after).toBe(before); // same reference — no work done
  });

  it('falls back to full build when cache is stale', () => {
    const items = [makeItem('r'), makeItem('c', 'r')];
    const state = createTuiState(items as any, false, []);
    // do not call buildVisibleNodes — cache stays null
    expect(state.cachedVisibleNodes).toBeNull();
    const after = incrementalExpand(state, 0);
    expect(after.length).toBeGreaterThan(0);
    expect(state.cachedVisibleNodes).toBe(after);
  });

  it('inserts nested subtree at the correct position', () => {
    // root1 -> child1 -> grandchild1
    // root2
    const items = [
      makeItem('root1'),
      makeItem('child1', 'root1'),
      makeItem('grand1', 'child1'),
      makeItem('root2'),
    ];
    const state = createTuiState(items as any, false, ['root1']);
    buildVisibleNodes(state);
    // visible: root1, child1 (hasChildren=true but collapsed), root2
    expect(state.cachedVisibleNodes!.map(n => n.item.id)).toEqual(['root1', 'child1', 'root2']);

    // expand child1 (index 1)
    const after = incrementalExpand(state, 1);
    expect(after.map(n => n.item.id)).toEqual(['root1', 'child1', 'grand1', 'root2']);
  });
});

// ── Unit tests: incremental collapse ─────────────────────────────────────────

describe('incrementalCollapse', () => {
  it('removes visible descendants on collapse', () => {
    const items = [makeItem('r'), makeItem('c', 'r')];
    const state = createTuiState(items as any, false, ['r']);
    buildVisibleNodes(state);
    expect(state.cachedVisibleNodes!.length).toBe(2);

    const after = incrementalCollapse(state, 0);
    expect(after.length).toBe(1);
    expect(after[0].item.id).toBe('r');
    expect(state.expanded.has('r')).toBe(false);
    expect(state.cachedVisibleNodes).toBe(after);
  });

  it('returns cache unchanged when node has no visible descendants', () => {
    const items = [makeItem('r'), makeItem('c', 'r')];
    const state = createTuiState(items as any, false, []);
    buildVisibleNodes(state);
    // 'r' not expanded — no visible descendants
    const before = state.cachedVisibleNodes!;
    const after = incrementalCollapse(state, 0);
    expect(after).toBe(before);
  });

  it('falls back to full build when cache is stale', () => {
    const items = [makeItem('r'), makeItem('c', 'r')];
    const state = createTuiState(items as any, false, ['r']);
    state.cachedVisibleNodes = null; // simulate stale cache
    const after = incrementalCollapse(state, 0);
    expect(after.length).toBeGreaterThan(0);
  });

  it('collapses multiple levels of descendants at once', () => {
    const items = [
      makeItem('r'),
      makeItem('c', 'r'),
      makeItem('gc', 'c'),
    ];
    const state = createTuiState(items as any, false, ['r', 'c']);
    buildVisibleNodes(state);
    // visible: r, c, gc
    expect(state.cachedVisibleNodes!.map(n => n.item.id)).toEqual(['r', 'c', 'gc']);

    const after = incrementalCollapse(state, 0);
    expect(after.map(n => n.item.id)).toEqual(['r']);
  });
});

// ── Regression: cache is invalidated on rebuild ───────────────────────────────

describe('cache invalidation', () => {
  it('sets cachedVisibleNodes to null when rebuildTreeState is called', () => {
    const items = [makeItem('r')];
    const state = createTuiState(items as any, false, []);
    buildVisibleNodes(state);
    expect(state.cachedVisibleNodes).not.toBeNull();

    rebuildTreeState(state);
    expect(state.cachedVisibleNodes).toBeNull();
  });

  it('rebuild followed by buildVisibleNodes repopulates the cache', () => {
    const items = [makeItem('r'), makeItem('c', 'r')];
    const state = createTuiState(items as any, false, ['r']);
    buildVisibleNodes(state);
    expect(state.cachedVisibleNodes!.length).toBe(2);

    rebuildTreeState(state);
    expect(state.cachedVisibleNodes).toBeNull();

    const fresh = buildVisibleNodes(state);
    expect(fresh.length).toBe(2);
    expect(state.cachedVisibleNodes).toBe(fresh);
  });
});

// ── 30-item benchmark ─────────────────────────────────────────────────────────

const ROOT_COUNT = 10;
const CHILDREN_PER_ROOT = 2;
const MAX_MEDIAN_LATENCY_MS = 200;

describe('30-item benchmark', () => {
  /**
   * Build a 30-item tree: 10 root items, each with 2 children.
   * Expand all roots, then measure expand/collapse latency with the
   * incremental renderer.  The median must stay under 200 ms.
   */
  it('median expand/collapse latency under 200 ms for a 30-item tree', () => {
    const items: WI[] = [];
    const rootIds: string[] = [];

    for (let r = 0; r < ROOT_COUNT; r++) {
      const rid = `root-${r}`;
      rootIds.push(rid);
      items.push(makeItem(rid));
      for (let c = 0; c < CHILDREN_PER_ROOT; c++) {
        items.push(makeItem(`child-${r}-${c}`, rid));
      }
    }

    const state = createTuiState(items as any, false, []);

    // Expand all roots so children are visible, then prime the cache.
    for (const rid of rootIds) state.expanded.add(rid);
    rebuildTreeState(state);
    buildVisibleNodes(state);

    expect(state.cachedVisibleNodes!.length).toBe(ROOT_COUNT * (1 + CHILDREN_PER_ROOT));

    // Measure collapse + expand for each root in sequence.
    const durations: number[] = [];

    // locate the index of each root in the current visible list
    for (const rid of rootIds) {
      const visibleBeforeCollapse = state.cachedVisibleNodes!;
      const rootIdx = visibleBeforeCollapse.findIndex(n => n.item.id === rid);
      if (rootIdx < 0) continue;

      const t0 = performance.now();
      incrementalCollapse(state, rootIdx);
      const t1 = performance.now();
      durations.push(t1 - t0);

      // root is now collapsed — expand it back
      const visibleAfterCollapse = state.cachedVisibleNodes!;
      const rootIdxAfter = visibleAfterCollapse.findIndex(n => n.item.id === rid);
      if (rootIdxAfter < 0) continue;

      const t2 = performance.now();
      incrementalExpand(state, rootIdxAfter);
      const t3 = performance.now();
      durations.push(t3 - t2);
    }

    expect(durations.length).toBeGreaterThan(0);

    durations.sort((a, b) => a - b);
    const medianMs = durations[Math.floor(durations.length / 2)];

    expect(
      medianMs,
      `Median expand/collapse latency ${medianMs.toFixed(2)} ms must be < ${MAX_MEDIAN_LATENCY_MS} ms`,
    ).toBeLessThan(MAX_MEDIAN_LATENCY_MS);
  });

  /**
   * Smoke test: visible node count stays consistent through sequential
   * expand / collapse operations.
   */
  it('visible node count is consistent after repeated incremental expand/collapse', () => {
    const items: WI[] = [];
    const rootIds: string[] = [];

    for (let r = 0; r < ROOT_COUNT; r++) {
      const rid = `root-${r}`;
      rootIds.push(rid);
      items.push(makeItem(rid));
      for (let c = 0; c < CHILDREN_PER_ROOT; c++) {
        items.push(makeItem(`child-${r}-${c}`, rid));
      }
    }

    const state = createTuiState(items as any, false, []);
    rebuildTreeState(state);
    buildVisibleNodes(state);

    // All roots collapsed initially — ROOT_COUNT visible items
    expect(state.cachedVisibleNodes!.length).toBe(ROOT_COUNT);

    // Expand all roots one by one
    for (const rid of rootIds) {
      const idx = state.cachedVisibleNodes!.findIndex(n => n.item.id === rid);
      incrementalExpand(state, idx);
    }
    expect(state.cachedVisibleNodes!.length).toBe(ROOT_COUNT * (1 + CHILDREN_PER_ROOT));

    // Collapse all roots one by one
    // Walk backwards so indices don't shift under us
    for (const rid of [...rootIds].reverse()) {
      const idx = state.cachedVisibleNodes!.findIndex(n => n.item.id === rid);
      if (idx >= 0) incrementalCollapse(state, idx);
    }
    expect(state.cachedVisibleNodes!.length).toBe(ROOT_COUNT);

    // Cross-check against a fresh full traversal
    const freshVisible = buildVisibleNodes(
      createTuiState(items as any, false, []),
    );
    expect(freshVisible.length).toBe(ROOT_COUNT);
  });
});
