import { describe, it, expect } from 'vitest';
import { createTuiState, rebuildTreeState, buildVisibleNodes, filterVisibleItems, sortBySortIndexDateAndId } from '../../src/tui/state.js';

type WI = {
  id: string;
  title: string;
  status: string;
  priority?: string;
  sortIndex?: number;
  parentId?: string | null;
  createdAt?: string | Date;
};

describe('TUI state helpers', () => {
  it('handles empty list', () => {
    const state = createTuiState([], false, undefined as any);
    expect(state.currentVisibleItems.length).toBe(0);
    expect(buildVisibleNodes(state)).toHaveLength(0);
  });

  it('creates a single root and visible node', () => {
    const items: WI[] = [{ id: '1', title: 'Root', status: 'open', createdAt: new Date().toISOString() }];
    const state = createTuiState(items as any, false, undefined as any);
    expect(state.roots.length).toBe(1);
    const visible = buildVisibleNodes(state);
    expect(visible).toHaveLength(1);
    expect(visible[0].depth).toBe(0);
    expect(visible[0].item.id).toBe('1');
  });

  it('shows children only when parent is expanded', () => {
    const items: WI[] = [
      { id: 'p', title: 'Parent', status: 'open', createdAt: '2020-01-01T00:00:00Z' },
      { id: 'c', title: 'Child', status: 'open', parentId: 'p', createdAt: '2020-01-02T00:00:00Z' },
    ];
    const state = createTuiState(items as any, false, undefined as any);
    // by default parent not expanded
    expect(buildVisibleNodes(state).some(n => n.item.id === 'c')).toBe(false);

    // expand parent
    state.expanded.add('p');
    rebuildTreeState(state);
    const visible = buildVisibleNodes(state);
    expect(visible.some(n => n.item.id === 'c')).toBe(true);
    const childNode = visible.find(n => n.item.id === 'c')!;
    expect(childNode.depth).toBe(1);
  });

  it('prunes expanded ids that no longer exist', () => {
    const items: WI[] = [{ id: 'a', title: 'A', status: 'open', createdAt: '2020-01-01T00:00:00Z' }];
    const state = createTuiState(items as any, false, ['missing'] as any);
    // createTuiState performs an initial rebuild so missing ids should be pruned
    expect(state.expanded.has('missing')).toBe(false);
  });

  it('respects showClosed flag when filtering visible items', () => {
    const items: WI[] = [
      { id: 'open', title: 'Open', status: 'open', createdAt: '2020-01-01T00:00:00Z' },
      { id: 'done', title: 'Done', status: 'completed', createdAt: '2020-01-02T00:00:00Z' },
    ];
    const filteredFalse = filterVisibleItems(items as any, false);
    expect(filteredFalse.some(i => i.id === 'done')).toBe(false);
    const filteredTrue = filterVisibleItems(items as any, true);
    expect(filteredTrue.some(i => i.id === 'done')).toBe(true);
  });

  it('sorts roots by sortIndex then createdAt deterministically', () => {
    const items: WI[] = [
      { id: 'a', title: 'A', status: 'open', priority: 'medium', createdAt: '2020-01-02T00:00:00Z', sortIndex: 300 },
      { id: 'b', title: 'B', status: 'open', priority: 'medium', createdAt: '2020-01-01T00:00:00Z', sortIndex: 100 },
    ];
    const state = createTuiState(items as any, false, undefined as any);
    // roots should be sorted by sortIndex first (b then a)
    expect(state.roots.map(r => r.id)).toEqual(['b', 'a']);
  });

  it('falls back to createdAt then id when sortIndex ties', () => {
    const items: WI[] = [
      { id: 'c', title: 'C', status: 'open', createdAt: '2020-01-02T00:00:00Z' },
      { id: 'a', title: 'A', status: 'open', createdAt: '2020-01-02T00:00:00Z' },
      { id: 'b', title: 'B', status: 'open', createdAt: '2020-01-01T00:00:00Z' },
    ];

    const sorted = items.slice().sort(sortBySortIndexDateAndId as any);
    expect(sorted.map(item => item.id)).toEqual(['b', 'a', 'c']);
  });
});
