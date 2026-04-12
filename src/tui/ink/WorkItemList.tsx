/**
 * WorkItemList — Ink-based left-pane list of work items with tree structure.
 */

import React, { type FC, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { VisibleNode } from '../state.js';

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'red',
  high: 'yellow',
  medium: 'cyan',
  low: 'green',
};

const STATUS_SYMBOLS: Record<string, string> = {
  open: '○',
  'in-progress': '◉',
  completed: '✓',
  blocked: '⊘',
  deleted: '✗',
};

function buildTreeLine(node: VisibleNode, selected: boolean, isMoveSource: boolean): string {
  const { item, depth, hasChildren } = node;
  const indent = '  '.repeat(depth);
  const expand = hasChildren ? '▶ ' : '  ';
  const status = STATUS_SYMBOLS[item.status] ?? '○';
  const title = item.title.length > 40 ? item.title.slice(0, 37) + '...' : item.title;
  const moveMarker = isMoveSource ? '[M] ' : '';
  return `${indent}${expand}${status} ${moveMarker}${title}`;
}

export interface WorkItemListProps {
  nodes: VisibleNode[];
  selectedIndex: number;
  isFocused: boolean;
  moveSourceId?: string | null;
  width?: number;
  height?: number;
}

export const WorkItemList: FC<WorkItemListProps> = ({
  nodes,
  selectedIndex,
  isFocused,
  moveSourceId,
  width = 50,
  height = 20,
}) => {
  // Calculate scroll window to keep selected item visible
  const startIdx = useMemo(() => {
    const maxVisible = height - 2; // subtract border rows
    if (selectedIndex < maxVisible) return 0;
    return selectedIndex - maxVisible + 1;
  }, [selectedIndex, height]);

  const visibleNodes = useMemo(() => {
    const maxVisible = height - 2;
    return nodes.slice(startIdx, startIdx + maxVisible);
  }, [nodes, startIdx, height]);

  const borderColor = isFocused ? 'green' : 'white';

  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      width={width}
      height={height}
      flexDirection="column"
    >
      <Box>
        <Text bold color="white">
          {' Work Items '}
        </Text>
        <Text dimColor>
          {' '}({nodes.length} items)
        </Text>
      </Box>
      {visibleNodes.map((node, i) => {
        const globalIdx = startIdx + i;
        const isSelected = globalIdx === selectedIndex;
        const isMoveSource = moveSourceId != null && node.item.id === moveSourceId;
        const line = buildTreeLine(node, isSelected, isMoveSource);
        const priorityColor = PRIORITY_COLORS[node.item.priority] ?? 'white';

        return (
          <Box key={node.item.id}>
            <Text
              backgroundColor={isSelected ? 'blue' : undefined}
              color={isMoveSource ? 'yellow' : priorityColor}
              bold={isSelected}
              wrap="truncate"
            >
              {line.padEnd(width - 2)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};
