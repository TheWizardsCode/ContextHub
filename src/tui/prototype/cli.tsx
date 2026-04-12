#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import App from './App.js';
import {Readable, PassThrough} from 'stream';

const headless = process.env.TUI_DEMO === '1' || process.argv.includes('--demo');
const verbose = process.env.TUI_VERBOSE === '1' || process.argv.includes('--verbose');

const needFakeStdin = headless || !(process.stdin && (process.stdin as any).isTTY);
if (needFakeStdin) {
  // Create a minimal fake stdin that LOOKS like a TTY so Ink won't try to
  // enable raw mode (which fails in some CI/headless environments).
  // Use a PassThrough so we can forward any real stdin bytes into it when
  // available (npm sometimes runs scripts with stdin not marked as a TTY but
  // still providing data). The PassThrough also implements readable
  // semantics expected by Ink.
  const fakeStdin = new PassThrough() as unknown as NodeJS.ReadStream & {isTTY?: boolean; setRawMode?: (v: boolean) => NodeJS.ReadStream};
  fakeStdin.isTTY = true;
  fakeStdin.setRawMode = (_mode: boolean) => fakeStdin;
  // If a real stdin exists, forward its data into the fake stream so keyboard
  // events still flow when possible.
  try {
    if (process.stdin && typeof (process.stdin as any).pipe === 'function') {
      // resume if paused
      try { process.stdin.resume(); } catch (_) {}
      (process.stdin as any).pipe(fakeStdin);
    }
  } catch (_) {}

  // Render using fake stdin; stdout can remain the real stdout so output is visible
  render(React.createElement(App, {headless, verbose}), {stdin: fakeStdin});
} else {
  render(React.createElement(App, {headless, verbose}));
}
