/**
 * HelpModal — Ink-based overlay showing keyboard shortcuts.
 */

import React, { type FC } from 'react';
import { Box, Text } from 'ink';

const SHORTCUTS = [
  { key: '↑ / k', desc: 'Move up' },
  { key: '↓ / j', desc: 'Move down' },
  { key: '→ / Enter', desc: 'Expand node' },
  { key: '←', desc: 'Collapse node' },
  { key: 'Space', desc: 'Toggle expand/collapse' },
  { key: 'Tab', desc: 'Cycle focus (list → detail → metadata)' },
  { key: 'Shift+Tab', desc: 'Cycle focus backwards' },
  { key: 'n', desc: 'Create new work item' },
  { key: 'e', desc: 'Edit selected item' },
  { key: 'd', desc: 'Delete selected item' },
  { key: 'r', desc: 'Refresh / reload items' },
  { key: '/', desc: 'Search / filter items' },
  { key: 'D', desc: 'Toggle do-not-delegate tag' },
  { key: 'v', desc: 'Cycle needs-producer-review filter' },
  { key: 'm', desc: 'Enter move/reparent mode' },
  { key: 'h', desc: 'Toggle this help' },
  { key: 'q / Esc', desc: 'Quit' },
];

export interface HelpModalProps {
  onClose: () => void;
}

export const HelpModal: FC<HelpModalProps> = ({ onClose: _onClose }) => {
  return (
    <Box
      borderStyle="double"
      borderColor="yellow"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="yellow">
        Keyboard Shortcuts
      </Text>
      <Text> </Text>
      {SHORTCUTS.map(({ key, desc }) => (
        <Box key={key}>
          <Text color="cyan" bold>
            {key.padEnd(18)}
          </Text>
          <Text>{desc}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>Press h or Esc to close</Text>
    </Box>
  );
};
