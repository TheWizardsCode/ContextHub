import React, {useEffect, useRef, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {VirtualList} from '../virtual-list.js';
import {fileLog} from '../logger.js';

export type InkItem = {id: string; title: string};

export default function InkVirtualList({
  items,
  height = 10,
  onSelect,
  onOpenDialog,
  showSelectionMarker = false,
}: {
  items: InkItem[];
  height?: number;
  onSelect?: (idx: number) => void;
  onOpenDialog?: () => void;
  showSelectionMarker?: boolean;
}) {
  // Debug log to help headless tests diagnose render issues during integration.
  fileLog(`[InkVirtualList] mount: items=${items.length}, height=${height}`);
  // avoid generic type-argument on useRef which can fail in some TS configs
  const vlRef = useRef(null as unknown as VirtualList | null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const itemsRef = useRef(items);

  if (vlRef.current === null) {
    vlRef.current = new VirtualList({totalItems: items.length, viewportHeight: Math.max(1, height)});
  }

  useEffect(() => {
    itemsRef.current = items;
    const vl = vlRef.current!;
    // Do not intercept non-navigation keys — let parents handle them. This
    // avoids swallowing dialog/open events registered higher in the tree.
    // Preserve selection by id if possible when items change
    const currentId = itemsRef.current[vl.selectedIndex]?.id;
    vl.setTotalItems(items.length);
    // Try to keep selection on the same id if it still exists
    if (currentId) {
    const newIdx = items.findIndex((it) => it.id === currentId);
      if (newIdx !== -1) {
        vl.selectAbsolute(newIdx);
      }
    }
    // Update component state from VirtualList
    setSelectedIdx(vl.selectedIndex);
  }, [items]);

  useEffect(() => {
    const vl = vlRef.current!;
    vl.setViewportHeight(Math.max(1, height));
    // Sync state
    setSelectedIdx(vl.selectedIndex);
  }, [height]);

  const notify = (idx: number) => {
    setSelectedIdx(idx);
    if (typeof onSelect === 'function') onSelect(idx);
  };

  // Capture input in the list for navigation and forward dialog open
  // requests to the parent via onOpenDialog.
  {
    fileLog('[InkVirtualList] registering useInput handler');
    useInput((input: string, key: any) => {
      const vl = vlRef.current!;
      // Forward dialog open requests to parent handler on next tick so
      // parent handlers can react without racing.
      if (input === 'o' && typeof onOpenDialog === 'function') {
        // Call parent handler synchronously so headless tests observing the
        // immediate frame will see the dialog present.
        onOpenDialog();
        return;
      }

      // Normalize arrow key detection. Different environments may provide
      // boolean flags (key.up/key.down), or a name (key.name), or raw escape
      // sequences in `input`/`key.sequence`. Be permissive so arrow keys work
      // consistently across terminals and test harnesses.
      const seq = (key && (key.sequence || key.name)) || '';
      const isDown = !!(key && (key.down || key.name === 'down' || seq === '\u001b[B' || seq === '\u001b\[B')) || input === 'j';
      const isUp = !!(key && (key.up || key.name === 'up' || seq === '\u001b[A' || seq === '\u001b\[A')) || input === 'k';

      if (isDown) {
        vl.moveBy(1);
        notify(vl.selectedIndex);
      }
      if (isUp) {
        vl.moveBy(-1);
        notify(vl.selectedIndex);
      }
      if (input === 'g') {
        vl.selectAbsolute(0);
        notify(vl.selectedIndex);
      }
      if (input === 'G') {
        vl.selectAbsolute(vl.totalItems - 1);
        notify(vl.selectedIndex);
      }
      if (key.pageDown) {
        vl.moveBy(vl.viewportHeight - 1);
        notify(vl.selectedIndex);
      }
      if (key.pageUp) {
        vl.moveBy(-(vl.viewportHeight - 1));
        notify(vl.selectedIndex);
      }
    });
  }

  const vl = vlRef.current!;
  // VirtualList is implemented in JS; avoid using explicit generic type args here
  const visible = (vl.slice(items as any) as InkItem[]);
  const selInView = vl.selectedIndexInViewport;

  return (
    <Box flexDirection="column" height={height} borderStyle="round" padding={1}>
      <Text bold>Items</Text>
      <Box marginTop={1} flexDirection="column">
        {visible.map((it: InkItem, i: number) => (
          <Text key={it.id}>{i === selInView ? '→ ' : '  '}{it.title}</Text>
        ))}
      </Box>
      {/* Optional selection marker for headless tests */}
      {showSelectionMarker ? <Text>{`__SEL__${vl.selectedIndex}__`}</Text> : null}
    </Box>
  );
}
