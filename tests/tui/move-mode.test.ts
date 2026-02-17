import { describe, it, expect } from 'vitest';
import {
  createTuiState,
  rebuildTreeState,
  getDescendants,
  enterMoveMode,
  exitMoveMode,
} from '../../src/tui/state.js';

type WI = {
  id: string;
  title: string;
  status: string;
  priority?: string;
  parentId?: string | null;
  createdAt?: string | Date;
};

const makeItem = (id: string, parentId?: string | null): WI => ({
  id,
  title: id,
  status: 'open',
  priority: 'medium',
  parentId: parentId ?? null,
  createdAt: new Date().toISOString(),
});

describe('getDescendants', () => {
  it('returns empty set for item with no children', () => {
    const items = [makeItem('A')];
    const state = createTuiState(items as any, true, undefined as any);
    expect(getDescendants(state, 'A').size).toBe(0);
  });

  it('returns empty set for item not in the tree', () => {
    const items = [makeItem('A')];
    const state = createTuiState(items as any, true, undefined as any);
    expect(getDescendants(state, 'NONEXISTENT').size).toBe(0);
  });

  it('returns direct children', () => {
    const items = [makeItem('A'), makeItem('B', 'A'), makeItem('C', 'A')];
    const state = createTuiState(items as any, true, undefined as any);
    const desc = getDescendants(state, 'A');
    expect(desc.size).toBe(2);
    expect(desc.has('B')).toBe(true);
    expect(desc.has('C')).toBe(true);
  });

  it('returns all descendants at 5 nesting levels', () => {
    // A -> B -> C -> D -> E -> F
    const items = [
      makeItem('A'),
      makeItem('B', 'A'),
      makeItem('C', 'B'),
      makeItem('D', 'C'),
      makeItem('E', 'D'),
      makeItem('F', 'E'),
    ];
    const state = createTuiState(items as any, true, undefined as any);
    const desc = getDescendants(state, 'A');
    expect(desc.size).toBe(5);
    expect(desc.has('B')).toBe(true);
    expect(desc.has('C')).toBe(true);
    expect(desc.has('D')).toBe(true);
    expect(desc.has('E')).toBe(true);
    expect(desc.has('F')).toBe(true);
    // A is NOT a descendant of itself
    expect(desc.has('A')).toBe(false);
  });

  it('handles branching tree correctly', () => {
    // A -> B, A -> C, B -> D, C -> E
    const items = [
      makeItem('A'),
      makeItem('B', 'A'),
      makeItem('C', 'A'),
      makeItem('D', 'B'),
      makeItem('E', 'C'),
    ];
    const state = createTuiState(items as any, true, undefined as any);
    const descA = getDescendants(state, 'A');
    expect(descA.size).toBe(4);
    expect(descA.has('B')).toBe(true);
    expect(descA.has('C')).toBe(true);
    expect(descA.has('D')).toBe(true);
    expect(descA.has('E')).toBe(true);

    // Descendants of B should only include D
    const descB = getDescendants(state, 'B');
    expect(descB.size).toBe(1);
    expect(descB.has('D')).toBe(true);
  });

  it('returns empty set for a leaf node', () => {
    const items = [makeItem('A'), makeItem('B', 'A')];
    const state = createTuiState(items as any, true, undefined as any);
    expect(getDescendants(state, 'B').size).toBe(0);
  });

  it('does not include siblings', () => {
    const items = [makeItem('A'), makeItem('B', 'A'), makeItem('C', 'A')];
    const state = createTuiState(items as any, true, undefined as any);
    const descB = getDescendants(state, 'B');
    expect(descB.has('C')).toBe(false);
    expect(descB.has('A')).toBe(false);
  });
});

describe('enterMoveMode / exitMoveMode', () => {
  it('enters move mode and sets state correctly', () => {
    const items = [makeItem('A'), makeItem('B', 'A'), makeItem('C', 'B')];
    const state = createTuiState(items as any, true, undefined as any);

    expect(state.moveMode).toBeNull();

    enterMoveMode(state, 'A');

    expect(state.moveMode).not.toBeNull();
    expect(state.moveMode!.active).toBe(true);
    expect(state.moveMode!.sourceId).toBe('A');
    expect(state.moveMode!.descendantIds.has('B')).toBe(true);
    expect(state.moveMode!.descendantIds.has('C')).toBe(true);
  });

  it('exits move mode and clears state', () => {
    const items = [makeItem('A'), makeItem('B', 'A')];
    const state = createTuiState(items as any, true, undefined as any);

    enterMoveMode(state, 'A');
    expect(state.moveMode).not.toBeNull();

    exitMoveMode(state);
    expect(state.moveMode).toBeNull();
  });

  it('entering move mode on a leaf sets empty descendantIds', () => {
    const items = [makeItem('A'), makeItem('B', 'A')];
    const state = createTuiState(items as any, true, undefined as any);

    enterMoveMode(state, 'B');
    expect(state.moveMode!.sourceId).toBe('B');
    expect(state.moveMode!.descendantIds.size).toBe(0);
  });

  it('re-entering move mode replaces previous state', () => {
    const items = [makeItem('A'), makeItem('B', 'A'), makeItem('C')];
    const state = createTuiState(items as any, true, undefined as any);

    enterMoveMode(state, 'A');
    expect(state.moveMode!.sourceId).toBe('A');
    expect(state.moveMode!.descendantIds.has('B')).toBe(true);

    enterMoveMode(state, 'C');
    expect(state.moveMode!.sourceId).toBe('C');
    expect(state.moveMode!.descendantIds.size).toBe(0);
  });

  it('moveMode state persists across rebuildTreeState', () => {
    const items = [makeItem('A'), makeItem('B', 'A')];
    const state = createTuiState(items as any, true, undefined as any);

    enterMoveMode(state, 'A');
    rebuildTreeState(state);

    // moveMode is NOT cleared by rebuildTreeState — the controller manages its lifecycle
    expect(state.moveMode).not.toBeNull();
    expect(state.moveMode!.sourceId).toBe('A');
  });
});
