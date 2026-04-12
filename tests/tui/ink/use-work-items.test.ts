/**
 * Tests for the useWorkItems hook.
 *
 * These tests verify that the hook correctly manages work item state and
 * integrates with the shared TUI state module.
 */

import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../../../src/types.js';
import { createTuiState, rebuildTreeState, buildVisibleNodes } from '../../../src/tui/state.js';

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WL-TEST-001',
    title: 'Test work item',
    description: 'A test description',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    assignee: '',
    stage: '',
    issueType: 'task',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  };
}

describe('useWorkItems hook integration (state module)', () => {
  it('creates empty state from empty items', () => {
    const state = createTuiState([], false);
    rebuildTreeState(state);
    const nodes = buildVisibleNodes(state);
    expect(nodes).toHaveLength(0);
  });

  it('builds visible nodes from flat items', () => {
    const items = [
      makeItem({ id: 'WL-1', title: 'Item 1' }),
      makeItem({ id: 'WL-2', title: 'Item 2' }),
      makeItem({ id: 'WL-3', title: 'Item 3' }),
    ];
    const state = createTuiState(items, false);
    rebuildTreeState(state);
    const nodes = buildVisibleNodes(state);
    expect(nodes).toHaveLength(3);
    expect(nodes[0].item.id).toBe('WL-1');
    expect(nodes[0].depth).toBe(0);
    expect(nodes[0].hasChildren).toBe(false);
  });

  it('builds tree structure for parent-child items', () => {
    const items = [
      makeItem({ id: 'WL-PARENT', title: 'Parent', parentId: null }),
      makeItem({ id: 'WL-CHILD', title: 'Child', parentId: 'WL-PARENT' }),
    ];
    const state = createTuiState(items, false);
    rebuildTreeState(state);

    // By default the parent is not expanded so only parent is visible
    const nodes = buildVisibleNodes(state);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].item.id).toBe('WL-PARENT');
    expect(nodes[0].hasChildren).toBe(true);
  });

  it('expands a parent to show children', () => {
    const items = [
      makeItem({ id: 'WL-PARENT', title: 'Parent', parentId: null }),
      makeItem({ id: 'WL-CHILD', title: 'Child', parentId: 'WL-PARENT' }),
    ];
    const state = createTuiState(items, false);
    rebuildTreeState(state);
    state.expanded.add('WL-PARENT');
    state.cachedVisibleNodes = null;

    const nodes = buildVisibleNodes(state);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].item.id).toBe('WL-PARENT');
    expect(nodes[1].item.id).toBe('WL-CHILD');
    expect(nodes[1].depth).toBe(1);
  });

  it('respects showClosed flag', () => {
    const items = [
      makeItem({ id: 'WL-OPEN', title: 'Open', status: 'open' }),
      makeItem({ id: 'WL-DONE', title: 'Done', status: 'completed' }),
    ];

    // With showClosed=false, completed item is excluded
    const stateHidden = createTuiState(items, false);
    rebuildTreeState(stateHidden);
    const nodesHidden = buildVisibleNodes(stateHidden);
    expect(nodesHidden.some(n => n.item.id === 'WL-DONE')).toBe(false);

    // With showClosed=true, completed item is shown
    const stateShown = createTuiState(items, true);
    rebuildTreeState(stateShown);
    const nodesShown = buildVisibleNodes(stateShown);
    expect(nodesShown.some(n => n.item.id === 'WL-DONE')).toBe(true);
  });

  it('correctly collapses a previously expanded parent', () => {
    const items = [
      makeItem({ id: 'WL-PARENT', title: 'Parent', parentId: null }),
      makeItem({ id: 'WL-CHILD', title: 'Child', parentId: 'WL-PARENT' }),
    ];
    const state = createTuiState(items, false);
    rebuildTreeState(state);

    // Expand
    state.expanded.add('WL-PARENT');
    state.cachedVisibleNodes = null;
    expect(buildVisibleNodes(state)).toHaveLength(2);

    // Collapse
    state.expanded.delete('WL-PARENT');
    state.cachedVisibleNodes = null;
    expect(buildVisibleNodes(state)).toHaveLength(1);
  });
});
