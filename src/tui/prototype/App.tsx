import React, {useEffect, useState} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import InkVirtualList from '../components/ink-virtual-list.js';
import {fileLog, setVerbose as setFileLogVerbose} from '../logger.js';
// ink-text-input may not provide types compatible with this project; import dynamically if available
let TextInput: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  TextInput = require('ink-text-input').default;
} catch (_) {
  TextInput = (props: any) => null;
}

export type Item = {id: string; title: string; body: string};

const sampleData: Item[] = [
  {id: '1', title: 'First item', body: 'Detail for first item'},
  {id: '2', title: 'Second item', body: 'Detail for second item'},
  {id: '3', title: 'Third item', body: 'Detail for third item'},
];

export function PrototypeList({items, selected, onSelect, width, height}: {items: Item[]; selected: number; onSelect: (i: number) => void; width?: string | number; height?: string | number}) {
  useInput((input: string, key: any) => {
    if (input === 'j' || key?.down) onSelect(Math.min(items.length - 1, selected + 1));
    if (input === 'k' || key?.up) onSelect(Math.max(0, selected - 1));
    if (input === 'g') onSelect(0);
    if (input === 'G') onSelect(items.length - 1);
  });

  return (
    <Box flexDirection="column" borderStyle="round" padding={1} marginRight={1} width={width} height={height}>
      <Text bold>Work Items</Text>
      <Box marginTop={1} flexDirection="column">
        {items.map((it, i) => (
          <Text key={it.id}>{i === selected ? '→ ' : '  '}{it.title}</Text>
        ))}
      </Box>
    </Box>
  );
}

export function PrototypeDetail({item, height}: {item: Item; height?: string | number}) {
  return (
    <Box flexDirection="column" borderStyle="round" padding={1} flexGrow={1} height={height}>
      <Text bold>{item.title}</Text>
      <Text>{item.body}</Text>
    </Box>
  );
}

export function PrototypeDialog({visible, onClose, width, height}: {visible: boolean; onClose: (value?: string) => void; width?: string | number; height?: string | number}) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!visible) setValue('');
  }, [visible]);

  useInput((_: string, key: any) => {
    if (!visible) return;
    if (key?.escape) onClose();
  });

  if (!visible) return null;
  try { fileLog(`[PrototypeDialog] render visible=${visible}`); } catch (_) {}

  return (
    <Box flexDirection="column" borderStyle="single" padding={1} width={width ?? '100%'} height={height ?? '100%'}>
      <Text>Enter text (Enter to submit, Esc to cancel)</Text>
      <Box marginTop={1}>
        <TextInput value={value} onChange={setValue} onSubmit={(val: string) => onClose(val)} />
      </Box>
    </Box>
  );
}

export default function App({headless, verbose}: {headless?: boolean; verbose?: boolean}) {
  const [items] = useState(sampleData);
  const [selected, setSelected] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const {stdout} = useStdout();
  const [termSize, setTermSize] = useState({columns: stdout.columns || (process.stdout && (process.stdout as any).columns) || 80, rows: stdout.rows || (process.stdout && (process.stdout as any).rows) || 24});
  const logDebug = (...parts: any[]) => {
    if (!verbose) return;
    try { fileLog(`[tui-prototype] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`); } catch (_) {}
  };

  // Ensure file-logger honors the App verbose flag
  useEffect(() => {
    try { setFileLogVerbose(Boolean(verbose)); } catch (_) {}
  }, [verbose]);

  // Listen to terminal resize events (stdout 'resize' and SIGWINCH) so the UI
  // updates when tmux panes are resized. Some environments won't emit 'resize'
  // on stdout, so also listen for SIGWINCH on the process.
  useEffect(() => {
    let _debounceId: NodeJS.Timeout | null = null;
    const getMeasuredSize = (): {columns: number; rows: number} => {
      let cols = stdout.columns || (process.stdout && (process.stdout as any).columns) || 0;
      let rows = stdout.rows || (process.stdout && (process.stdout as any).rows) || 0;

      // Try stream getWindowSize APIs
      try {
        if (process.stdout && typeof (process.stdout as any).getWindowSize === 'function') {
          const s = (process.stdout as any).getWindowSize();
          if (Array.isArray(s)) { cols = s[0] || cols; rows = s[1] || rows; }
        }
      } catch (_) {}

      try {
        if (process.stderr && typeof (process.stderr as any).getWindowSize === 'function') {
          const s = (process.stderr as any).getWindowSize();
          if (Array.isArray(s)) { cols = s[0] || cols; rows = s[1] || rows; }
        }
      } catch (_) {}

      // Try tty.getWindowSize by fd (more reliable in some environments)
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
        const tty = require('tty');
        if (typeof tty.getWindowSize === 'function') {
          // Prefer using the controlling terminal if possible. In tmux/npm
          // wrapper cases process.stdout.fd may not refer to the real tty.
          let fd = (process.stdout && (process.stdout as any).fd) || 1;
          try {
            // Try opening /dev/tty which should point to the active controlling TTY
            const fs = require('fs');
            try {
              const ttyFd = fs.openSync('/dev/tty', 'r');
              try {
                const s = tty.getWindowSize(ttyFd);
                if (Array.isArray(s)) { cols = s[0] || cols; rows = s[1] || rows; }
              } catch (_) {
                // fallback to process.stdout fd
                const s = tty.getWindowSize(fd);
                if (Array.isArray(s)) { cols = s[0] || cols; rows = s[1] || rows; }
              } finally {
                try { fs.closeSync(ttyFd); } catch (_) {}
              }
            } catch (_) {
              // couldn't open /dev/tty — fall back to process.stdout fd
              try {
                const s = tty.getWindowSize(fd);
                if (Array.isArray(s)) { cols = s[0] || cols; rows = s[1] || rows; }
              } catch (_) {}
            }
          } catch (_) {}
        }
      } catch (_) {}

      // As last resort use environment
      try { cols = cols || Number(process.env.COLUMNS) || cols; } catch (_) {}
      try { rows = rows || Number(process.env.LINES) || rows; } catch (_) {}

      // Fall back to sensible defaults
      if (!cols || cols <= 0) cols = 80;
      if (!rows || rows <= 0) rows = 24;

      return {columns: cols, rows};
    };

   const update = () => {
      const measured = getMeasuredSize();
      logDebug(`resize detected: columns=${measured.columns}, rows=${measured.rows}`);
      try { require('../logger').fileLog(`[App] resize detected: columns=${measured.columns}, rows=${measured.rows}`); } catch (_) {}
      // Debounce layout updates to avoid flicker during rapid resize events.
      if (_debounceId) clearTimeout(_debounceId);
      _debounceId = setTimeout(() => {
        setTermSize(measured);
        _debounceId = null;
      }, 80);
    };

    update();

    try {
      if (stdout && typeof (stdout as any).on === 'function') (stdout as any).on('resize', update);
    } catch (_) {}

    try {
      process.on('SIGWINCH', update);
    } catch (_) {}

    // Polling fallback: some environments (certain tmux setups) don't
    // reliably emit resize events. Poll getWindowSize periodically and
    // apply updates when the size changes.
    const pollId = setInterval(() => {
      try {
        let cols = stdout.columns || (process.stdout && (process.stdout as any).columns) || 80;
        let rows = stdout.rows || (process.stdout && (process.stdout as any).rows) || 24;
        if (process.stdout && typeof (process.stdout as any).getWindowSize === 'function') {
          const s = (process.stdout as any).getWindowSize();
          if (Array.isArray(s)) { cols = s[0] || cols; rows = s[1] || rows; }
        }
        if (process.stderr && typeof (process.stderr as any).getWindowSize === 'function') {
          const s = (process.stderr as any).getWindowSize();
          if (Array.isArray(s)) { cols = s[0] || cols; rows = s[1] || rows; }
        }
        if (cols !== termSize.columns || rows !== termSize.rows) {
          if (verbose) logDebug(`[tui-prototype] poll resize: columns=${cols}, rows=${rows}`);
          setTermSize({columns: cols, rows});
        }
      } catch (_) {}
    }, 300);

    return () => {
      try { if (stdout && typeof (stdout as any).removeListener === 'function') (stdout as any).removeListener('resize', update); } catch (_) {}
      try { process.removeListener('SIGWINCH', update); } catch (_) {}
      try { clearInterval(pollId); } catch (_) {}
    };
  }, [stdout]);

  useInput((input: string, key: any) => {
    try { require('../logger').fileLog(`[App] useInput got input=${JSON.stringify(input)} key=${JSON.stringify(key)}`); } catch (_) {}
    if (input === 'q') process.exit(0);
    if (input === 'o') setDialogOpen(true);
  });

  useEffect(() => {
    if (headless) {
      // In headless/demo mode open dialog, set a value and close after a short delay.
      // Use a slightly longer delay to ensure headless test harness sees the
      // dialog before it auto-closes.
      setDialogOpen(true);
      const t = setTimeout(() => {
        // simulate submit by closing with a value
        setDialogOpen(false);
      }, 600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [headless]);

  const footerHeight = 1;

  // Use flex-based sizing instead of rigid numeric heights. This is more
  // reliable across tmux/pty environments — let the root container grow to
  // the available terminal area and let children share space with flexGrow.
  // Debug: log computed layout values when verbose so we can diagnose
  // why the UI might not occupy the full terminal area in tmux.
  useEffect(() => {
    if (!verbose) return undefined;
    try {
      logDebug(`layout: termSize=${JSON.stringify(termSize)}, footerHeight=${footerHeight}`);
      logDebug(`stdout.columns=${(stdout as any).columns}, stdout.rows=${(stdout as any).rows}, process.stdout.columns=${(process.stdout as any).columns}, process.stdout.rows=${(process.stdout as any).rows}`);
      try {
        logDebug(`process.stdout.getWindowSize=${typeof (process.stdout as any).getWindowSize === 'function' ? JSON.stringify((process.stdout as any).getWindowSize()) : 'n/a'}`);
      } catch (_) {}
    } catch (_) {}
    return undefined;
  }, [termSize, footerHeight, stdout, verbose]);

  return (
    (() => {
      try { fileLog(`[App] render: dialogOpen=${String(dialogOpen)}, headless=${String(headless)}`); } catch (_) {}
    })(),
    // Explicit height ensures Ink measures the root to the current terminal
    // height (needed for some pty/tmux setups where flexGrow alone is not enough).
    // Avoid forcing a remount on every resize (remounts cause flicker).
    // Subtract 1 from the measured rows to avoid off-by-one overflow in some
    // tmux/pty combinations where borders/padding make the layout exceed the
    // visible area by one line on first render.
    <Box flexDirection="column" height={Math.max(1, termSize.rows - 1)}>
      {/* Top row: list (left) and metadata (right) */}
      <Box flexDirection="row" flexGrow={1}>
          <Box flexGrow={2} padding={0} height="100%">
          {/* Use the InkVirtualList (virtualized) in the prototype so arrow keys and
             behavior mirror the real TUI component. We compute a numeric height
             from the measured terminal rows to give it enough room. */}
          <InkVirtualList
            items={items}
            height={Math.max(1, termSize.rows - footerHeight - 6)}
            onSelect={(i: number) => setSelected(i)}
            onOpenDialog={() => setDialogOpen(true)}
          />
        </Box>
        <Box flexDirection="column" borderStyle="round" padding={0} flexGrow={1}>
          <Text bold>Metadata</Text>
          <Box marginTop={1}>
            <Text>ID: {items[selected].id}</Text>
            <Text>Type: demo</Text>
            <Text>Updated: just now</Text>
          </Box>
        </Box>
      </Box>

      {/* Bottom row: detail pane */}
      <Box flexGrow={2}>
        <PrototypeDetail item={items[selected]} />
      </Box>

      {/* Footer */}
      <Box height={footerHeight}>
        <Text dimColor>{dialogOpen ? "Enter text (Enter to submit, Esc to cancel)" : "Press 'o' to open dialog, 'q' to quit. Use j/k to navigate."}</Text>
      </Box>

      {/* Dialog overlay (rendered last so it appears on top) */}
      {dialogOpen && (
        <Box position="absolute" top={0} left={0} width="100%" height="100%" borderStyle="single" padding={0}>
          <PrototypeDialog
            visible={dialogOpen}
            onClose={() => setDialogOpen(false)}
            width={termSize.columns}
            height={termSize.rows}
          />
        </Box>
      )}
    </Box>
  );
}
