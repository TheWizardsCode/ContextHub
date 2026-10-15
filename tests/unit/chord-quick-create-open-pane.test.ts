/**
 * tests/unit/chord-quick-create-open-pane.test.ts — `c q` (create quick)
 * runs in the background without a pane (WL-0MV6J5JXL002D8C4).
 *
 * The bunded `c q` entry in `packages/herdr/src/shortcuts.json` carries
 * `"open_pane": false`. Its command template contains form-collected
 * placeholders (`<title>`, `<description>`, `<priority default='medium'>`),
 * so it is dispatched through the placeholder form dialog — the same path
 * the sibling fix WL-0MV6J4HQ0009OJPQ taught to honour `openPane`. These
 * tests drive the real `runWorklistTui` input loop with the production
 * shortcut registry to assert that:
 *
 *   - the bundled `c q` entry is marked `openPane: false`;
 *   - submitting the quick-create form forwards `openPane === false` (no
 *     pane) plus the completion-refresh hook to `onCommand`;
 *   - invoking the forwarded refresh hook actually refreshes the list
 *     (the new item appears when the background `wl create` exits);
 *   - other form-driven shortcuts (`c n`) keep the default pane-opening
 *     flag (absent → unchanged behaviour).
 *
 * This file lives under `tests/unit/` (the canonical agent suite in
 * `.pi/test-config.json`) so the regression is enforced by the full-suite
 * gate, following the precedent of `tests/unit/form-dialog-open-pane.test.ts`
 * (WL-0MUU173V8008IA5E).
 *
 * Run: npx vitest run tests/unit/chord-quick-create-open-pane.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWorklistTui, type WorkItem } from '../../packages/herdr/src/worklist.js';
import { loadShortcutConfig } from '../../packages/herdr/src/shortcut-config.js';
import { setLogPath, resetLogPath } from '../../packages/herdr/src/command-log.js';
import { setExecFileAsync, resetExecFileAsync } from '../../packages/herdr/src/fetcher.js';

type StdinListener = (chunk: Buffer) => void;

const ITEMS: WorkItem[] = [{ id: 'TEST-1', title: 'Item TEST-1', status: 'open' }];

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

let logDir: string;

beforeEach(() => {
  // Isolate the command log so a dispatched form command never touches the
  // user's real ~/.config/herdr log.
  logDir = mkdtempSync(join(tmpdir(), 'herdr-cq-open-pane-'));
  setLogPath(join(logDir, 'cmdlog.json'));
});

afterEach(() => {
  resetLogPath();
  resetExecFileAsync();
  rmSync(logDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Fake-TTY harness (mirrors form-dialog-open-pane.test.ts): swap
 * `process.stdin` for a fake TTY that records data listeners and capture
 * `process.stdout` writes. All `wl` subprocesses are stubbed via
 * `setExecFileAsync` so the loop never spawns a real CLI.
 */
function setupFakeTty(): {
  dataListeners: StdinListener[];
  writes: string[];
  restore: () => void;
} {
  const dataListeners: StdinListener[] = [];
  const fakeStdin = {
    isTTY: true,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    on: (ev: string, cb: StdinListener) => {
      if (ev === 'data') dataListeners.push(cb);
    },
    removeListener: (ev: string, cb: StdinListener) => {
      if (ev === 'data') {
        const i = dataListeners.indexOf(cb);
        if (i >= 0) dataListeners.splice(i, 1);
      }
    },
  };
  const writes: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as any);
  const origStdin = (process as any).stdin;
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true, writable: true });
  setExecFileAsync((async () => ({ stdout: '{"count": 0}' })) as any);
  return {
    dataListeners,
    writes,
    restore: () => {
      Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true, writable: true });
      writeSpy.mockRestore();
      resetExecFileAsync();
    },
  };
}

/**
 * Drive the real `c q` flow against the production shortcut registry:
 * complete the chord, wait for the quick-create form, fill title +
 * description (priority keeps its inline default), submit, and return the
 * `onCommand` spy. `fetcher` is the list-refresh data source (counted for
 * the completion-refresh assertion) and `withOwnOnRefresh` controls whether
 * the test injects its own refresh hook (isolating the forwarded-arg
 * assertion) or lets the TUI wire its internal `doRefresh`.
 */
async function driveQuickCreate(
  options: { fetcher?: ReturnType<typeof vi.fn>; withOwnOnRefresh?: boolean } = {},
): Promise<{ onCommand: ReturnType<typeof vi.fn>; onRefresh: ReturnType<typeof vi.fn> }> {
  const { fetcher = vi.fn(async () => ITEMS), withOwnOnRefresh = false } = options;
  const { dataListeners, writes, restore } = setupFakeTty();
  const onCommand = vi.fn();
  const ownOnRefresh = vi.fn();
  const press = async (key: string): Promise<void> => {
    dataListeners.forEach(cb => cb(Buffer.from(key)));
    await tick();
  };
  let tui: Promise<WorkItem | undefined> | undefined;
  try {
    tui = runWorklistTui(fetcher as any, ITEMS, loadShortcutConfig(), {
      autoRefresh: false,
      autoSync: false,
      onCommand,
      ...(withOwnOnRefresh ? { onRefresh: ownOnRefresh } : {}),
    });
    await vi.waitFor(() => {
      expect(dataListeners.length).toBeGreaterThan(0);
    });
    // Complete the `c q` chord → the quick-create form dialog opens.
    await press('c');
    await press('q');
    await vi.waitFor(() => {
      expect(writes.join('')).toContain('Command Input');
    });
    // Fill the form: title, tab to description, priority keeps its inline
    // default 'medium' (matches chord-quick-create.test.ts).
    for (const ch of 'My title') await press(ch);
    await press('\t');
    for (const ch of 'My desc') await press(ch);
    await press('\r'); // submit
    await vi.waitFor(() => {
      expect(onCommand).toHaveBeenCalled();
    });
    return { onCommand, onRefresh: ownOnRefresh };
  } finally {
    dataListeners.forEach(cb => cb(Buffer.from('q')));
    if (tui) await tui.catch(() => undefined);
    restore();
  }
}

describe('c q quick create runs without a pane (WL-0MV6J5JXL002D8C4)', () => {
  it('marks the bundled c-q entry open_pane: false (config opt-in)', () => {
    const registry = loadShortcutConfig();
    const entry = registry.lookupChordEntry(['c', 'q'], 'list');
    expect(entry).toBeDefined();
    expect(entry?.openPane).toBe(false);
    expect(entry?.command).toBe(
      "!!wl create -t <title> -d <description> -p <priority default='medium'>",
    );
  });

  it('dispatches wl create with openPane === false and the refresh hook on form submit', async () => {
    const { onCommand, onRefresh } = await driveQuickCreate({ withOwnOnRefresh: true });
    expect(onCommand).toHaveBeenCalledTimes(1);
    // Form-dialog dispatch forwards the inherited open_pane flag (3rd arg
    // false → background, no pane) plus the completion-refresh hook (4th
    // arg) so the list updates when `wl create` exits (WL-0MV6J4HQ0009OJPQ,
    // WL-0MT1KB70U0012X6T). Shell-route values are POSIX single-quoted.
    expect(onCommand).toHaveBeenCalledWith(
      "!!wl create -t 'My title' -d 'My desc' -p 'medium'",
      undefined, // model
      false, // openPane → no pane opens
      onRefresh,
    );
  });

  it('refreshes the list when the background create completes (completion refresh)', async () => {
    const fetcher = vi.fn(async () => ITEMS);
    const { onCommand } = await driveQuickCreate({ fetcher });
    const call = onCommand.mock.calls[0] as [
      string,
      unknown,
      unknown,
      () => Promise<void>,
    ];
    // initialItems is supplied → no startup fetch; the ONLY refresh must be
    // the one the forwarded completion hook triggers.
    expect(fetcher).not.toHaveBeenCalled();
    expect(typeof call[3]).toBe('function');
    await call[3](); // background `wl create` exited → onRefresh fires
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalled();
    });
  });

  it('leaves other form-driven shortcuts on the default pane-opening path', () => {
    const registry = loadShortcutConfig();
    // c-n (create intake) is form-driven (<description> placeholder) but
    // does NOT opt in — the flag must stay absent so it opens a pane
    // exactly as before (AC5).
    expect(registry.lookupChordEntry(['c', 'n'], 'list')?.openPane).toBeUndefined();
    // And no bundled pane-opening shortcut was accidentally flagged false
    // beyond the documented quiet set (covers AC5 wholesale).
    const quiet = new Set([
      'a,y', 'a,r', 'c,q', 'u,p,l', 'u,p,m', 'u,p,h', 'u,p,c', 'x,c', 'x,d',
    ]);
    for (const entry of registry.getEntries()) {
      const key = entry.chord.join(',');
      if (entry.openPane === false) {
        expect(quiet.has(key)).toBe(true);
      }
    }
  });
});
