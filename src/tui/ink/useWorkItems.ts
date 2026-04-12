/**
 * useWorkItems — React hook for managing the work item list state in the Ink TUI.
 *
 * Wraps the shared TUI state module (src/tui/state.ts) so Ink components can
 * consume and update work item data reactively.
 */

import { useState, useCallback, useRef } from 'react';
import type { WorkItem } from '../../types.js';
import {
  createTuiState,
  rebuildTreeState,
  buildVisibleNodes,
  type TuiState,
  type VisibleNode,
} from '../state.js';

export interface WorkItemsState {
  nodes: VisibleNode[];
  selectedIndex: number;
  selectedItem: WorkItem | null;
  showClosed: boolean;
}

export interface WorkItemsActions {
  load(items: WorkItem[]): void;
  selectIndex(index: number): void;
  moveUp(): void;
  moveDown(): void;
  toggleExpanded(id: string): void;
  expandNode(id: string): void;
  collapseNode(id: string): void;
  toggleShowClosed(): void;
  reload(items: WorkItem[]): void;
}

export function useWorkItems(initialItems: WorkItem[] = []): [WorkItemsState, WorkItemsActions] {
  const stateRef = useRef<TuiState>(createTuiState(initialItems, false));
  const [nodes, setNodes] = useState<VisibleNode[]>(() => {
    rebuildTreeState(stateRef.current);
    return buildVisibleNodes(stateRef.current);
  });
  const [selectedIndex, setSelectedIndex] = useState(0);

  const refresh = useCallback(() => {
    const newNodes = buildVisibleNodes(stateRef.current);
    setNodes(newNodes);
  }, []);

  const load = useCallback((items: WorkItem[]) => {
    stateRef.current = createTuiState(items, stateRef.current.showClosed);
    rebuildTreeState(stateRef.current);
    refresh();
    setSelectedIndex(0);
  }, [refresh]);

  const reload = load;

  const selectIndex = useCallback((index: number) => {
    setSelectedIndex(prev => {
      const max = buildVisibleNodes(stateRef.current).length - 1;
      return Math.max(0, Math.min(index, max));
    });
  }, []);

  const moveUp = useCallback(() => {
    setSelectedIndex(prev => Math.max(0, prev - 1));
  }, []);

  const moveDown = useCallback(() => {
    const max = buildVisibleNodes(stateRef.current).length - 1;
    setSelectedIndex(prev => Math.min(max, prev + 1));
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    const s = stateRef.current;
    if (s.expanded.has(id)) {
      s.expanded.delete(id);
    } else {
      s.expanded.add(id);
    }
    s.cachedVisibleNodes = null;
    refresh();
  }, [refresh]);

  const expandNode = useCallback((id: string) => {
    const s = stateRef.current;
    s.expanded.add(id);
    s.cachedVisibleNodes = null;
    refresh();
  }, [refresh]);

  const collapseNode = useCallback((id: string) => {
    const s = stateRef.current;
    s.expanded.delete(id);
    s.cachedVisibleNodes = null;
    refresh();
  }, [refresh]);

  const toggleShowClosed = useCallback(() => {
    const s = stateRef.current;
    s.showClosed = !s.showClosed;
    rebuildTreeState(s);
    refresh();
    setSelectedIndex(0);
  }, [refresh]);

  const selectedItem = nodes[selectedIndex]?.item ?? null;

  return [
    { nodes, selectedIndex, selectedItem, showClosed: stateRef.current.showClosed },
    { load, selectIndex, moveUp, moveDown, toggleExpanded, expandNode, collapseNode, toggleShowClosed, reload },
  ];
}
