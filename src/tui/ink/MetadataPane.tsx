/**
 * MetadataPane — Ink-based metadata panel for the selected work item.
 * Shows status, stage, priority, risk, effort, tags, and GitHub link.
 */

import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import type { WorkItem } from '../../types.js';

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'red',
  high: 'yellow',
  medium: 'cyan',
  low: 'green',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'white',
  'in-progress': 'cyan',
  completed: 'green',
  blocked: 'red',
  deleted: 'gray',
};

function row(label: string, value: string, valueColor?: string): React.ReactElement {
  return (
    <Box key={label}>
      <Text color="gray">{label.padEnd(12)}</Text>
      <Text color={valueColor ?? 'white'}>{value || '—'}</Text>
    </Box>
  );
}

export interface MetadataPaneProps {
  item: WorkItem | null;
  isFocused: boolean;
  width?: number;
  height?: number;
}

export const MetadataPane: FC<MetadataPaneProps> = ({
  item,
  isFocused,
  width = 35,
  height = 20,
}) => {
  const borderColor = isFocused ? 'green' : 'white';

  if (!item) {
    return (
      <Box borderStyle="single" borderColor={borderColor} width={width} height={height} flexDirection="column">
        <Text bold color="white">{' Metadata '}</Text>
      </Box>
    );
  }

  const rows: React.ReactElement[] = [
    row('Status', item.status, STATUS_COLORS[item.status] ?? 'white'),
    row('Stage', item.stage ?? '', 'cyan'),
    row('Priority', item.priority, PRIORITY_COLORS[item.priority] ?? 'white'),
    row('Risk', item.risk || '', 'yellow'),
    row('Effort', item.effort || '', 'yellow'),
    row('Assignee', item.assignee ?? ''),
    row('Issue Type', item.issueType ?? ''),
    row('Tags', item.tags?.join(', ') ?? ''),
    row('ID', item.id, 'gray'),
  ];

  if (item.githubIssueNumber) {
    rows.push(row('GitHub #', String(item.githubIssueNumber), 'cyan'));
  }

  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      width={width}
      height={height}
      flexDirection="column"
    >
      <Text bold color="white">
        {' Metadata '}
      </Text>
      {rows}
    </Box>
  );
};
