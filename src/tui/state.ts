import type { WorkItem } from '../types.js';
import type { MoveMode } from './types.js';
import { sortByPriorityAndDate } from '../commands/helpers.js';

export type Item = WorkItem;

export type TuiState = {
  items: Item[];
  showClosed: boolean;
  currentVisibleItems: Item[];
  itemsById: Map<string, Item>;
  childrenMap: Map<string, Item[]>;
  roots: Item[];
  expanded: Set<string>;
  listLines: string[];
  moveMode: MoveMode | null;
};

export type VisibleNode = { item: Item; depth: number; hasChildren: boolean };

export const isClosedStatus = (status: WorkItem['status'] | string | undefined): boolean =>
  (status === 'completed' || status === 'deleted') ?? false;

export const filterVisibleItems = (items: Item[], showClosed: boolean): Item[] =>
  showClosed ? items.slice() : items.filter((item: Item) => !isClosedStatus(item.status));

export const rebuildTreeState = (state: TuiState): void => {
  state.currentVisibleItems = filterVisibleItems(state.items, state.showClosed);
  state.itemsById = new Map<string, Item>();
  for (const it of state.currentVisibleItems) state.itemsById.set(it.id, it);

  state.childrenMap = new Map<string, Item[]>();
  for (const it of state.currentVisibleItems) {
    const pid = (it as any).parentId;
    if (pid && state.itemsById.has(pid)) {
      const arr = state.childrenMap.get(pid) || [];
      arr.push(it);
      state.childrenMap.set(pid, arr);
    }
  }

  state.roots = state.currentVisibleItems.filter(it => !(it as any).parentId || !state.itemsById.has((it as any).parentId)).slice();
  state.roots.sort(sortByPriorityAndDate);

  // prune expanded nodes that are no longer present
  for (const id of Array.from(state.expanded)) {
    if (!state.itemsById.has(id)) state.expanded.delete(id);
  }
};

export const createTuiState = (items: Item[], showClosed: boolean, persistedExpanded?: string[] | null): TuiState => {
  const state: TuiState = {
    items: items.slice(),
    showClosed,
    currentVisibleItems: [],
    itemsById: new Map<string, Item>(),
    childrenMap: new Map<string, Item[]>(),
    roots: [],
    expanded: new Set<string>(),
    listLines: [],
    moveMode: null,
  };

  if (persistedExpanded && Array.isArray(persistedExpanded)) {
    for (const id of persistedExpanded) state.expanded.add(id);
  }

  rebuildTreeState(state);
  return state;
};

export const buildVisibleNodes = (state: TuiState): VisibleNode[] => {
  const out: VisibleNode[] = [];

  function visit(it: Item, depth: number) {
    const children = (state.childrenMap.get(it.id) || []).slice().sort(sortByPriorityAndDate);
    out.push({ item: it, depth, hasChildren: children.length > 0 });
    if (children.length > 0 && state.expanded.has(it.id)) {
      for (const c of children) visit(c, depth + 1);
    }
  }

  for (const r of state.roots) visit(r, 0);
  return out;
};

export const expandAncestorsForInProgress = (state: TuiState): void => {
  const inProgressItems = state.currentVisibleItems.filter((item) => {
    const status = typeof item.status === 'string' ? item.status.replace(/_/g, '-') : item.status;
    return status === 'in-progress';
  });
  for (const item of inProgressItems) {
    let cursor = item;
    while (cursor.parentId && state.itemsById.has(cursor.parentId)) {
      state.expanded.add(cursor.parentId);
      cursor = state.itemsById.get(cursor.parentId) as Item;
    }
  }
};

/**
 * Collect all descendant IDs of a given item, traversing the childrenMap
 * recursively. Returns an empty set if the item has no children or is not
 * found.
 */
export const getDescendants = (state: TuiState, itemId: string): Set<string> => {
  const result = new Set<string>();
  const stack = state.childrenMap.get(itemId)?.slice() || [];
  while (stack.length > 0) {
    const child = stack.pop()!;
    result.add(child.id);
    const grandchildren = state.childrenMap.get(child.id);
    if (grandchildren) {
      for (const gc of grandchildren) stack.push(gc);
    }
  }
  return result;
};

/**
 * Enter move mode: store the source item ID and pre-compute all descendant
 * IDs (invalid targets) so the UI can grey them out.
 */
export const enterMoveMode = (state: TuiState, sourceId: string): void => {
  state.moveMode = {
    active: true,
    sourceId,
    descendantIds: getDescendants(state, sourceId),
  };
};

/**
 * Exit move mode, clearing all move-related state.
 */
export const exitMoveMode = (state: TuiState): void => {
  state.moveMode = null;
};
