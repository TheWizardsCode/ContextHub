/**
 * DetailPane — Ink-based right-pane showing full description and comments of
 * the selected work item.
 */

import React, { type FC, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { WorkItem } from '../../types.js';

function formatDate(value: string | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function buildDetailLines(item: WorkItem): string[] {
  const lines: string[] = [];
  lines.push(`# ${item.title}`);
  lines.push('');
  if (item.description) {
    lines.push(...item.description.split('\n'));
    lines.push('');
  }
  if (item.tags && item.tags.length > 0) {
    lines.push(`Tags: ${item.tags.join(', ')}`);
  }
  lines.push(`Created: ${formatDate(item.createdAt)}`);
  if (item.updatedAt) {
    lines.push(`Updated: ${formatDate(item.updatedAt)}`);
  }
  return lines;
}

export interface DetailPaneProps {
  item: WorkItem | null;
  isFocused: boolean;
  width?: number;
  height?: number;
  scrollOffset?: number;
}

export const DetailPane: FC<DetailPaneProps> = ({
  item,
  isFocused,
  width = 50,
  height = 20,
  scrollOffset = 0,
}) => {
  const borderColor = isFocused ? 'green' : 'white';

  const lines = useMemo(() => {
    if (!item) return ['No item selected'];
    return buildDetailLines(item);
  }, [item]);

  const maxVisible = height - 2;
  const visibleLines = lines.slice(scrollOffset, scrollOffset + maxVisible);

  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      width={width}
      height={height}
      flexDirection="column"
    >
      <Text bold color="white">
        {' Description & Comments '}
      </Text>
      {visibleLines.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line || ' '}
        </Text>
      ))}
    </Box>
  );
};
