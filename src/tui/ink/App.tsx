/**
 * App — Root Ink TUI component.
 *
 * Composes the WorkItemList, DetailPane, MetadataPane, StatusBar, and
 * HelpModal into a full-screen layout driven by keyboard input.
 */

import React, { type FC, useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { WorkItem } from '../../types.js';
import { WorkItemList } from './WorkItemList.js';
import { DetailPane } from './DetailPane.js';
import { MetadataPane } from './MetadataPane.js';
import { StatusBar, type FocusPane } from './StatusBar.js';
import { HelpModal } from './HelpModal.js';
import { useWorkItems } from './useWorkItems.js';
import { useToast } from './useToast.js';

export interface AppProps {
  /** Initial set of work items to display. */
  items: WorkItem[];
  /** Called when a work item should be refreshed from disk. */
  onRefresh?: () => Promise<WorkItem[]>;
  /** Terminal dimensions */
  columns?: number;
  rows?: number;
}

const FOCUS_ORDER: FocusPane[] = ['list', 'detail', 'metadata'];

export const App: FC<AppProps> = ({
  items,
  onRefresh,
  columns = 120,
  rows = 30,
}) => {
  const { exit } = useApp();
  const [workItems, actions] = useWorkItems(items);
  const [focusPane, setFocusPane] = useState<FocusPane>('list');
  const [showHelp, setShowHelp] = useState(false);
  const [detailScroll, setDetailScroll] = useState(0);
  const [toast, showToast] = useToast();

  // Layout dimensions
  const listWidth = Math.floor(columns * 0.65);
  const rightWidth = columns - listWidth;
  const metaHeight = Math.floor(rows * 0.5);
  const detailHeight = rows - metaHeight - 1; // subtract status bar

  const cycleFocus = useCallback((reverse = false) => {
    setFocusPane(prev => {
      const idx = FOCUS_ORDER.indexOf(prev);
      const next = reverse
        ? (idx - 1 + FOCUS_ORDER.length) % FOCUS_ORDER.length
        : (idx + 1) % FOCUS_ORDER.length;
      return FOCUS_ORDER[next];
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    if (!onRefresh) {
      showToast('No refresh handler configured', 'warning');
      return;
    }
    try {
      const newItems = await onRefresh();
      actions.reload(newItems);
      showToast(`Reloaded ${newItems.length} items`, 'success');
    } catch (err) {
      showToast(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [onRefresh, actions, showToast]);

  useInput((input, key) => {
    // Global shortcuts (all panes)
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (input === 'q' && !showHelp) {
      exit();
      return;
    }
    if (input === 'h') {
      setShowHelp(prev => !prev);
      return;
    }
    if (key.escape && showHelp) {
      setShowHelp(false);
      return;
    }
    if (showHelp) return;

    if (key.tab && !key.shift) {
      cycleFocus(false);
      return;
    }
    if (key.tab && key.shift) {
      cycleFocus(true);
      return;
    }

    // List pane navigation
    if (focusPane === 'list') {
      if (key.upArrow || input === 'k') {
        actions.moveUp();
        setDetailScroll(0);
        return;
      }
      if (key.downArrow || input === 'j') {
        actions.moveDown();
        setDetailScroll(0);
        return;
      }
      if (key.rightArrow || key.return) {
        const node = workItems.nodes[workItems.selectedIndex];
        if (node?.hasChildren) {
          actions.expandNode(node.item.id);
        }
        return;
      }
      if (key.leftArrow) {
        const node = workItems.nodes[workItems.selectedIndex];
        if (node) {
          actions.collapseNode(node.item.id);
        }
        return;
      }
      if (input === ' ') {
        const node = workItems.nodes[workItems.selectedIndex];
        if (node) {
          actions.toggleExpanded(node.item.id);
        }
        return;
      }
      if (input === 'r') {
        void handleRefresh();
        return;
      }
      if (input === 'c') {
        actions.toggleShowClosed();
        return;
      }
    }

    // Detail pane scrolling
    if (focusPane === 'detail') {
      if (key.upArrow || input === 'k') {
        setDetailScroll(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setDetailScroll(prev => prev + 1);
        return;
      }
    }
  });

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {showHelp ? (
        <Box justifyContent="center" alignItems="center" width={columns} height={rows - 1}>
          <HelpModal onClose={() => setShowHelp(false)} />
        </Box>
      ) : (
        <Box flexDirection="row" flexGrow={1}>
          {/* Left pane: work item list */}
          <WorkItemList
            nodes={workItems.nodes}
            selectedIndex={workItems.selectedIndex}
            isFocused={focusPane === 'list'}
            width={listWidth}
            height={rows - 1}
          />
          {/* Right panes: metadata + detail */}
          <Box flexDirection="column" width={rightWidth}>
            <MetadataPane
              item={workItems.selectedItem}
              isFocused={focusPane === 'metadata'}
              width={rightWidth}
              height={metaHeight}
            />
            <DetailPane
              item={workItems.selectedItem}
              isFocused={focusPane === 'detail'}
              width={rightWidth}
              height={detailHeight}
              scrollOffset={detailScroll}
            />
          </Box>
        </Box>
      )}
      {/* Status bar / toast */}
      <StatusBar
        focusPane={focusPane}
        message={toast?.message}
        messageType={toast?.type}
        width={columns}
      />
    </Box>
  );
};
