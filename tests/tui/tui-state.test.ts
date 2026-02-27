import { describe, expect, it } from 'vitest';
import {
  buildVisibleNodes,
  createTuiState,
  rebuildTreeState,
  filterVisibleItems,
  expandAncestorsForInProgress,
} from '../../src/commands/tui.js';

type Item = {
  id: string;
  title: string;
  status: 'open' | 'in-progress' | 'completed' | 'deleted';
  parentId?: string | null;
  priority?: string;
  createdAt?: string;
  updatedAt?: string;
};

const makeItem = (id: string, status: Item['status'], parentId?: string | null): Item => ({
  id,
  title: id,
  status,
  parentId: parentId ?? null,
  priority: 'medium',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe('tui state helpers', () => {
  it('filters closed items when showClosed=false', () => {
    const items = [
      makeItem('WL-1', 'open'),
      makeItem('WL-2', 'completed'),
      makeItem('WL-3', 'deleted'),
    ];

    const visible = filterVisibleItems(items as any, false);
    expect(visible.map(item => item.id)).toEqual(['WL-1']);
  });

  it('keeps closed items when showClosed=true', () => {
    const items = [
      makeItem('WL-1', 'open'),
      makeItem('WL-2', 'completed'),
      makeItem('WL-3', 'deleted'),
    ];

    const visible = filterVisibleItems(items as any, true);
    expect(visible.map(item => item.id)).toEqual(['WL-1', 'WL-2', 'WL-3']);
  });

  it('builds roots/children and prunes missing expanded ids', () => {
    const items = [
      makeItem('WL-1', 'open'),
      makeItem('WL-2', 'open', 'WL-1'),
      makeItem('WL-3', 'open', 'WL-1'),
    ];

    const state = createTuiState(items as any, true, ['WL-1', 'WL-missing']);
    rebuildTreeState(state);

    expect(state.roots.map(item => item.id)).toEqual(['WL-1']);
    expect(state.childrenMap.get('WL-1')?.map(item => item.id)).toEqual(['WL-2', 'WL-3']);
    expect(state.expanded.has('WL-1')).toBe(true);
    expect(state.expanded.has('WL-missing')).toBe(false);
  });

  it('buildVisibleNodes respects expanded state', () => {
    const items = [
      makeItem('WL-1', 'open'),
      makeItem('WL-2', 'open', 'WL-1'),
      makeItem('WL-3', 'open', 'WL-1'),
    ];

    const state = createTuiState(items as any, true, []);
    rebuildTreeState(state);

    const collapsed = buildVisibleNodes(state);
    expect(collapsed.map(node => node.item.id)).toEqual(['WL-1']);

    state.expanded.add('WL-1');
    const expanded = buildVisibleNodes(state);
    expect(expanded.map(node => node.item.id)).toEqual(['WL-1', 'WL-2', 'WL-3']);
  });

  it('expands ancestors for in-progress items', () => {
    const items = [
      makeItem('WL-1', 'open'),
      makeItem('WL-2', 'in-progress', 'WL-1'),
      makeItem('WL-3', 'open', 'WL-2'),
    ];

    const state = createTuiState(items as any, true, []);
    rebuildTreeState(state);

    expandAncestorsForInProgress(state);

    expect(state.expanded.has('WL-1')).toBe(true);
    expect(state.expanded.has('WL-2')).toBe(false);
  });

  it('expands ancestors when status uses hyphenated form', () => {
    // Status values are normalized to hyphenated form on write/import,
    // so 'in-progress' is the canonical form. Underscore form ('in_progress')
    // should not appear in stored data.
    const items = [
      makeItem('WL-1', 'open'),
      { ...makeItem('WL-2', 'open', 'WL-1'), status: 'in-progress' },
      makeItem('WL-3', 'open', 'WL-2'),
    ];

    const state = createTuiState(items as any, true, []);
    rebuildTreeState(state);

    expandAncestorsForInProgress(state);

    expect(state.expanded.has('WL-1')).toBe(true);
  });
});
