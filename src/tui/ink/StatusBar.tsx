/**
 * StatusBar — Ink-based footer bar that shows available keyboard shortcuts
 * and transient status/toast messages.
 */

import React, { type FC } from 'react';
import { Box, Text } from 'ink';

export type FocusPane = 'list' | 'detail' | 'metadata';

const HELP_HINTS: Record<FocusPane, string[]> = {
  list: ['↑↓ navigate', '→/enter expand', '← collapse', 'n create', 'e edit', 'd delete', 'r refresh', '/ search', 'h help', 'q quit'],
  detail: ['↑↓ scroll', 'Tab focus', 'q quit'],
  metadata: ['↑↓ scroll', 'Tab focus', 'q quit'],
};

export interface StatusBarProps {
  focusPane: FocusPane;
  message?: string | null;
  messageType?: 'info' | 'success' | 'error' | 'warning';
  width?: number;
}

export const StatusBar: FC<StatusBarProps> = ({
  focusPane,
  message,
  messageType = 'info',
  width = 80,
}) => {
  const messageColor: Record<string, string> = {
    info: 'cyan',
    success: 'green',
    error: 'red',
    warning: 'yellow',
  };

  const hints = HELP_HINTS[focusPane] ?? HELP_HINTS.list;
  const hintText = hints.join('  ');

  return (
    <Box width={width} height={1}>
      {message ? (
        <Text color={messageColor[messageType] ?? 'cyan'} bold>
          {message}
        </Text>
      ) : (
        <Text color="white" dimColor>
          {hintText}
        </Text>
      )}
    </Box>
  );
};
