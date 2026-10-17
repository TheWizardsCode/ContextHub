/**
 * tests/unit/form-dialog-open-pane.test.ts — Form-dialog dispatch honours
 * `open_pane: false` (WL-0MV6J4HQ0009OJPQ).
 *
 * A shortcut that combines an unknown placeholder (e.g. `a-r`'s `<reason>`)
 * with `open_pane: false` is routed through the placeholder form dialog. The
 * form's onSubmit must forward `openPane`/`onRefresh`/`focus` with the same
 * arity rules as the placeholder-free dispatch paths, otherwise the flag is
 * dropped and a pane opens against the shortcut's explicit opt-out.
 *
 * Layer note: this is an end-to-end test of the herdr form-dialog dispatch
 * path, so it lives under `tests/unit/` (the canonical agent suite in
 * `.pi/test-config.json`) rather than `packages/herdr/src/worklist.test.ts`,
 * which the configured suite does not run (WL-0MUU173V8008IA5E). It drives
 * the real `runWorklistTui` input loop with a fake TTY.
 *
 * Run: npx vitest run tests/unit/form-dialog-open-pane.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWorklistTui, type WorkItem } from '../../packages/herdr/src/worklist.js';
import { ShortcutRegistry } from '../../packages/herdr/src/shortcut-config.js';
import { setLogPath, resetLogPath } from '../../packages/herdr/src/command-log.js';
import { setExecFileAsync, resetExecFileAsync } from '../../packages/herdr/src/fetcher.js';

type StdinListener = (chunk: Buffer) => void;

const ITEMS: WorkItem[] = [{ id: 'TEST-123', title: 'Item TEST-123', status: 'open' }];

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

let logDir: string;

beforeEach(() => {
  // Isolate the command log so a dispatched form command never touches the
  // user's real ~/.config/herdr log.
  logDir = mkdtempSync(join(tmpdir(), 'herdr-form-open-pane-'));
  setLogPath(join(logDir, 'cmdlog.json'));
});

afterEach(() => {
  resetLogPath();
  resetExecFileAsync();
  rmSync(logDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Fake-TTY harness (mirrors the composed-footer / chord-quick-create
 * harnesses): swap `process.stdin` for a fake TTY that records data
 * listeners and captures `process.stdout` writes.
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
 * A placeholder shortcut (`<title>` is an unknown identifier) with the flag
 * under test. No `stages` gate so the chord resolves from the default
 * (unfiltered) list view.
 */
function registryWith(openPane: boolean | undefined, focus = false): ShortcutRegistry {
  return new ShortcutRegistry([
    {
      chord: ['z', 'z'],
      command: '!!wl update <id> --title <title>',
      view: 'both',
      label: 'custom placeholder',
      ...(openPane === undefined ? {} : { openPane }),
      ...(focus ? { focus: true } : {}),
    },
  ]);
}

/**
 * Drive the real input loop: chord → form → type → submit, then return the
 * `onCommand`/`onRefresh` spies for assertions.
 */
async function driveForm(
  openPane: boolean | undefined,
  focus = false,
  value = 'mytitle',
): Promise<{ onCommand: ReturnType<typeof vi.fn>; onRefresh: ReturnType<typeof vi.fn> }> {
  const { dataListeners, writes, restore } = setupFakeTty();
  const onCommand = vi.fn();
  const onRefresh = vi.fn();
  const press = async (key: string): Promise<void> => {
    dataListeners.forEach(cb => cb(Buffer.from(key)));
    await tick();
  };
  let tui: Promise<WorkItem | undefined> | undefined;
  try {
    tui = runWorklistTui(async () => ITEMS, ITEMS, registryWith(openPane, focus), {
      autoRefresh: false,
      autoSync: false,
      onCommand,
      onRefresh,
    });
    await vi.waitFor(() => {
      expect(dataListeners.length).toBeGreaterThan(0);
      expect(writes.length).toBeGreaterThan(0);
    });
    // Complete the `z z` chord → the placeholder form dialog opens.
    await press('z');
    await press('z');
    await vi.waitFor(() => {
      expect(writes.join('')).toContain('Command Input');
    });
    // Type the placeholder value and submit.
    for (const ch of value) await press(ch);
    await press('\r');
    await vi.waitFor(() => {
      expect(onCommand).toHaveBeenCalled();
    });
    return { onCommand, onRefresh };
  } finally {
    dataListeners.forEach(cb => cb(Buffer.from('q')));
    if (tui) await tui.catch(() => undefined);
    restore();
  }
}

describe('form-dialog dispatch honours open_pane: false (WL-0MV6J4HQ0009OJPQ)', () => {
  it('forwards openPane=false and onRefresh for a background placeholder shortcut', async () => {
    const { onCommand, onRefresh } = await driveForm(false);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith(
      "!!wl update TEST-123 --title 'mytitle'",
      undefined,
      false,
      onRefresh,
    );
  });

  it('keeps the default (pane-opening) dispatch for a placeholder shortcut without open_pane', async () => {
    const { onCommand } = await driveForm(undefined);
    expect(onCommand).toHaveBeenCalledTimes(1);
    // openPane is undefined → index.ts falls back to `openPane ?? true` and
    // opens a pane exactly as before (byte-compatible 2-arg call).
    expect(onCommand).toHaveBeenCalledWith(
      "!!wl update TEST-123 --title 'mytitle'",
      undefined,
    );
  });

  it('forwards focus=true for a placeholder shortcut with focus and no open_pane', async () => {
    const { onCommand } = await driveForm(undefined, true);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith(
      "!!wl update TEST-123 --title 'mytitle'",
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
  });
});
