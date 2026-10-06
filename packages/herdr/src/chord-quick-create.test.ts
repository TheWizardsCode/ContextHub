/**
 * packages/herdr/src/chord-quick-create.test.ts — Regression tests for the
 * `c q` (create quick) chord (WL-0MTCLB50D0026YA7).
 *
 * The `c q` chord's second key is `q`, which is also the TUI's quit key.
 * The quit-key handler originally ran BEFORE chord-mode handling, so
 * pressing `c` then `q` exited the extension instead of opening the
 * quick-create form (reported by manual review: "Using c-q crashed the
 * herdr extension").
 *
 * These tests drive the real runWorklistTui input loop with the production
 * shortcut registry (`loadShortcutConfig`) to verify that:
 *   - `c` then `q` opens the quick-create form (it does NOT quit), and
 *   - the form dispatches the expected `wl create` command on submit.
 *
 * Run: npx vitest run packages/herdr/src/chord-quick-create.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before worklist.js is imported)
// ---------------------------------------------------------------------------

vi.mock('./fetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fetcher.js')>();
  return {
    ...actual,
    fetchActionableCount: vi.fn().mockResolvedValue(0),
    fetchChildrenForItem: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('./auto-sync.js', () => ({
  runSync: vi.fn().mockResolvedValue({ success: true }),
  createSyncTimer: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  clampSyncInterval: vi.fn((v: number) => v),
}));

vi.mock('./notify.js', () => ({
  showToast: vi.fn(),
}));

import { runWorklistTui } from './worklist.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { setLogPath, resetLogPath } from './command-log.js';

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as notify-dispatch.test.ts)
// ---------------------------------------------------------------------------

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];

  // Isolate the command log so dispatched commands never touch the user's
  // real ~/.config/herdr log.
  tmpDir = mkdtempSync(join(tmpdir(), 'herdr-cqc-'));
  setLogPath(join(tmpDir, 'cmdlog.json'));

  for (const prop of ['on', 'removeListener', 'pause', 'resume', 'setRawMode'] as const) {
    if (!(prop in process.stdin)) {
      Object.defineProperty(process.stdin, prop, {
        value: vi.fn(),
        configurable: true,
        writable: true,
      });
    }
  }
  (process.stdin as any).on = vi.fn((event: string, cb: (chunk: Buffer) => void) => {
    if (event === 'data') dataHandler = cb;
    return process.stdin;
  });
  (process.stdin as any).removeListener = vi.fn(() => process.stdin);
  (process.stdin as any).pause = vi.fn(() => process.stdin);
  (process.stdin as any).resume = vi.fn(() => process.stdin);
  (process.stdin as any).setRawMode = vi.fn(() => process.stdin);
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

  vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => {
    writes.push(String(s));
    return true;
  }) as any);
  vi.spyOn(process.stdout, 'on').mockImplementation((() => process.stdout as any) as any);
  vi.spyOn(process.stdout, 'removeListener').mockImplementation((() => process.stdout as any) as any);
});

afterEach(() => {
  resetLogPath();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Small async tick helper so awaited promises settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

/**
 * The last full render written to stdout. Since every render starts with
 * ANSI.clear + cursorHome, the last write is a complete redraw.
 */
function lastRender(): string {
  return writes[writes.length - 1] ?? '';
}

/** True when the quick-create form page is the current render. */
function quickCreateFormShowing(): boolean {
  const out = lastRender();
  return out.includes('Command Input') && out.includes('title') && out.includes('description');
}

function startTui(onCommand?: (c: string, model?: string) => void): Promise<unknown> {
  return runWorklistTui(async () => [], [], loadShortcutConfig(), {
    autoRefresh: false,
    autoSync: false,
    showHelpText: false,
    onCommand,
  });
}

describe('c q (create quick) chord (WL-0MTCLB50D0026YA7)', () => {
  it('opens the quick-create form instead of quitting the extension', async () => {
    const p = startTui();
    await tick();

    // Press the leader key `c`, then `q`. Historically `q` quit the TUI
    // here because the quit-key handler ran before chord-mode handling.
    dataHandler?.(Buffer.from('c'));
    await tick();
    dataHandler?.(Buffer.from('q'));
    await tick();

    // The form must be open. If `q` had quit the extension, the last render
    // would not be the quick-create form.
    expect(quickCreateFormShowing()).toBe(true);

    // Clean up: cancel the form, then quit.
    dataHandler?.(Buffer.from('\x1b'));
    await tick();
    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('dispatches wl create with the form values on submit', async () => {
    const onCommand = vi.fn();
    const p = startTui(onCommand);
    await tick();

    dataHandler?.(Buffer.from('c'));
    await tick();
    dataHandler?.(Buffer.from('q'));
    await tick();

    // title
    for (const ch of 'My title') {
      dataHandler?.(Buffer.from(ch));
      await tick();
    }
    // description
    dataHandler?.(Buffer.from('\t'));
    await tick();
    for (const ch of 'My desc') {
      dataHandler?.(Buffer.from(ch));
      await tick();
    }
    // priority keeps its inline default 'medium'
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();

    expect(onCommand).toHaveBeenCalledTimes(1);
    // Shell-route values are POSIX single-quoted (form-dialog.ts).
    expect(onCommand).toHaveBeenCalledWith(
      "!!wl create -t 'My title' -d 'My desc' -p 'medium'",
      undefined,
    );

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('still quits on a bare q when no chord is pending', async () => {
    const p = startTui();
    await tick();

    dataHandler?.(Buffer.from('q'));
    const result = await p;
    expect(result).toBeUndefined();
  });
});
