import type { WorkItem } from '../types.js';
import type { MoveMode } from './types.js';

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
  /** Cached result of buildVisibleNodes. Null when the cache is stale. */
  cachedVisibleNodes: VisibleNode[] | null;
};

export type VisibleNode = { item: Item; depth: number; hasChildren: boolean };

const toSortableSortIndex = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
};

const toSortableTime = (value: unknown): number => {
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

export const sortBySortIndexDateAndId = (a: Item, b: Item): number => {
  const aSort = toSortableSortIndex((a as any).sortIndex);
  const bSort = toSortableSortIndex((b as any).sortIndex);
  if (aSort !== bSort) return aSort - bSort;

  const createdDiff = toSortableTime((a as any).createdAt) - toSortableTime((b as any).createdAt);
  if (createdDiff !== 0) return createdDiff;

  return String(a.id || '').localeCompare(String(b.id || ''));
};

export const isClosedStatus = (status: WorkItem['status'] | string | undefined): boolean =>
  (status === 'completed' || status === 'deleted') ?? false;

export const filterVisibleItems = (items: Item[], showClosed: boolean): Item[] =>
  showClosed ? items.slice() : items.filter((item: Item) => !isClosedStatus(item.status));

export const rebuildTreeState = (state: TuiState): void => {
  const t0 = Date.now();
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
  state.roots.sort(sortBySortIndexDateAndId);

  // prune expanded nodes that are no longer present
  for (const id of Array.from(state.expanded)) {
    if (!state.itemsById.has(id)) state.expanded.delete(id);
  }

  // Invalidate the visible-node cache so the next buildVisibleNodes call
  // performs a full traversal and repopulates it.
  state.cachedVisibleNodes = null;
  // Lightweight timing to help diagnose expensive tree rebuilds in the TUI
  try {
    const dur = Date.now() - t0;
    // Expose on the state for tests/inspection when perf debugging is enabled
    (state as any).__lastRebuildMs = dur;
  } catch (_) {}
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
    cachedVisibleNodes: null,
  };

  if (persistedExpanded && Array.isArray(persistedExpanded)) {
    for (const id of persistedExpanded) state.expanded.add(id);
  }

  rebuildTreeState(state);
  return state;
};

export const buildVisibleNodes = (state: TuiState): VisibleNode[] => {
  const t0 = Date.now();
  const out: VisibleNode[] = [];

  function visit(it: Item, depth: number) {
    const children = (state.childrenMap.get(it.id) || []).slice().sort(sortBySortIndexDateAndId);
    out.push({ item: it, depth, hasChildren: children.length > 0 });
    if (children.length > 0 && state.expanded.has(it.id)) {
      for (const c of children) visit(c, depth + 1);
    }
  }

  for (const r of state.roots) visit(r, 0);
  try { (state as any).__lastBuildVisibleMs = Date.now() - t0; } catch (_) {}
  state.cachedVisibleNodes = out;
  return out;
};

/**
 * Build the visible VisibleNode sub-list for the children of a given item,
 * traversing only nodes that are currently expanded. Used by incremental
 * expand to splice in just the new subtree rather than rebuilding everything.
 */
function buildSubtreeNodes(state: TuiState, parentId: string, depth: number): VisibleNode[] {
  const out: VisibleNode[] = [];
  const children = (state.childrenMap.get(parentId) || []).slice().sort(sortBySortIndexDateAndId);
  for (const child of children) {
    const grandchildren = state.childrenMap.get(child.id) || [];
    out.push({ item: child, depth, hasChildren: grandchildren.length > 0 });
    if (grandchildren.length > 0 && state.expanded.has(child.id)) {
      out.push(...buildSubtreeNodes(state, child.id, depth + 1));
    }
  }
  return out;
}

/**
 * Incrementally expand the node at `nodeIdx` in the cached visible-node list.
 *
 * Instead of re-traversing the entire tree, this function:
 *  1. Sets the node as expanded in `state.expanded`.
 *  2. Builds only the newly visible subtree.
 *  3. Splices the subtree into `state.cachedVisibleNodes`.
 *
 * Falls back to a full `buildVisibleNodes` traversal if the cache is stale.
 */
export const incrementalExpand = (state: TuiState, nodeIdx: number): VisibleNode[] => {
  const cached = state.cachedVisibleNodes;
  if (!cached) return buildVisibleNodes(state);

  const node = cached[nodeIdx];
  if (!node || !node.hasChildren) return cached;
  if (state.expanded.has(node.item.id)) return cached;

  state.expanded.add(node.item.id);
  const subtree = buildSubtreeNodes(state, node.item.id, node.depth + 1);
  const newVisible = cached.slice(0, nodeIdx + 1).concat(subtree, cached.slice(nodeIdx + 1));
  state.cachedVisibleNodes = newVisible;
  return newVisible;
};

/**
 * Incrementally collapse the node at `nodeIdx` in the cached visible-node list.
 *
 * Instead of re-traversing the entire tree, this function:
 *  1. Removes the node from `state.expanded`.
 *  2. Finds the contiguous block of descendants that follow the node in the
 *     visible list (all nodes at a greater depth).
 *  3. Removes that block from `state.cachedVisibleNodes`.
 *
 * Falls back to a full `buildVisibleNodes` traversal if the cache is stale.
 */
export const incrementalCollapse = (state: TuiState, nodeIdx: number): VisibleNode[] => {
  const cached = state.cachedVisibleNodes;
  if (!cached) return buildVisibleNodes(state);

  const node = cached[nodeIdx];
  if (!node) return cached;

  state.expanded.delete(node.item.id);

  // Find the end of the descendant block: all nodes with depth > node.depth
  // that immediately follow the collapsed node are now hidden.
  let endIdx = nodeIdx + 1;
  while (endIdx < cached.length && cached[endIdx].depth > node.depth) endIdx++;

  if (endIdx === nodeIdx + 1) {
    // No visible descendants – nothing to remove.
    return cached;
  }

  const newVisible = cached.slice(0, nodeIdx + 1).concat(cached.slice(endIdx));
  state.cachedVisibleNodes = newVisible;
  return newVisible;
};

export const expandAncestorsForInProgress = (state: TuiState): void => {
  const inProgressItems = state.currentVisibleItems.filter((item) => {
    return item.status === 'in-progress';
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
