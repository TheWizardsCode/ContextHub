import React, {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from 'ink-text-input';

export type Item = {id: string; title: string; body: string};

const sampleData: Item[] = [
  {id: '1', title: 'First item', body: 'Detail for first item'},
  {id: '2', title: 'Second item', body: 'Detail for second item'},
  {id: '3', title: 'Third item', body: 'Detail for third item'},
];

export function PrototypeList({items, selected, onSelect}: {items: Item[]; selected: number; onSelect: (i: number) => void}) {
  useInput((input, key) => {
    if (input === 'j' || key.down) onSelect(Math.min(items.length - 1, selected + 1));
    if (input === 'k' || key.up) onSelect(Math.max(0, selected - 1));
    if (input === 'g') onSelect(0);
    if (input === 'G') onSelect(items.length - 1);
  });

  return (
    <Box flexDirection="column" borderStyle="round" padding={1} marginRight={1} width={30}>
      <Text bold>Items</Text>
      {items.map((it, i) => (
        <Text key={it.id}>{i === selected ? '→ ' : '  '}{it.title}</Text>
      ))}
    </Box>
  );
}

export function PrototypeDetail({item}: {item: Item}) {
  return (
    <Box flexDirection="column" borderStyle="round" padding={1} flexGrow={1}>
      <Text bold>{item.title}</Text>
      <Text>{item.body}</Text>
    </Box>
  );
}

export function PrototypeDialog({visible, onClose}: {visible: boolean; onClose: (value?: string) => void}) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!visible) setValue('');
  }, [visible]);

  useInput((_, key) => {
    if (!visible) return;
    if (key.escape) onClose();
  });

  if (!visible) return null;

  return (
    <Box flexDirection="column" borderStyle="single" padding={1} width={60}>
      <Text>Enter text (Enter to submit, Esc to cancel)</Text>
      <Box marginTop={1}>
        <TextInput value={value} onChange={setValue} onSubmit={(val) => onClose(val)} />
      </Box>
    </Box>
  );
}

export default function App({headless}: {headless?: boolean}) {
  const [items] = useState<Item[]>(sampleData);
  const [selected, setSelected] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  useInput((input, key) => {
    if (input === 'q') process.exit(0);
    if (input === 'o') setDialogOpen(true);
  });

  useEffect(() => {
    if (headless) {
      // In headless/demo mode open dialog, set a value and close after a short delay.
      setDialogOpen(true);
      const t = setTimeout(() => {
        // simulate submit by closing with a value
        setDialogOpen(false);
      }, 200);
      return () => clearTimeout(t);
    }
  }, [headless]);

  return (
    <Box>
      <PrototypeList items={items} selected={selected} onSelect={setSelected} />
      <Box flexDirection="column" flexGrow={1}>
        <PrototypeDetail item={items[selected]} />
        <Box marginTop={1}>
          <Text dimColor>Press 'o' to open dialog, 'q' to quit. Use j/k to navigate.</Text>
        </Box>
        <Box marginTop={1}>
          <PrototypeDialog visible={dialogOpen} onClose={() => setDialogOpen(false)} />
        </Box>
      </Box>
    </Box>
  );
}
