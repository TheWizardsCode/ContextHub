/**
 * packages/herdr/src/worklist-help.test.ts — Test-first pins for the `?`
 * help-screen overlay (parent WL-0MTV97GV20088CS7, AC3/AC4/AC6; test-first
 * child WL-0MV85R0JD004CHAE; implementation child WL-0MV85R14Y003RII9).
 *
 * The help screen does not exist yet, so every body here asserts the
 * POST-IMPLEMENTATION behaviour and is committed with `it.fails` — the suite
 * stays GREEN while the assertions are RED (the repo's documented TDD
 * pattern; see packages/herdr/src/downtime-worker.assignee-claim.test.ts and
 * packages/herdr/src/coordination-dispatch.test.ts). The implementation child
 * WL-0MV85R14Y003RII9 flips each `it.fails` to `it` once the overlay lands.
 *
 * Everything is pinned through the REAL `runWorklistTui` render loop over a
 * fake TTY (the same technique as the composed-footer tests in
 * worklist.test.ts). That keeps the contract at the observable-behaviour
 * level: an implementation may add a `'help'` ViewMode branch, a dedicated
 * formatter, or anything else, as long as `?` opens the overlay and the
 * rendered frame satisfies these assertions.
 *
 * AC map (this item):
 *   AC1 — `?` opens help; `?`, `Esc` and `q` each return to list mode.
 *   AC2 — dismissing help leaves selection (and the rest of list state) intact.
 *   AC3 — the rendered help enumerates the live `ShortcutRegistry` commands,
 *          grouped by chord leader, with chord/label/description.
 *   AC4 — the help stays within the `rows - 1` pane budget on a short pane and
 *          keeps the dismiss keys discoverable.
 *   AC5 — the help is not offered when `showHelpText: false`.
 *
 * Run through the test skill (`/skill:test`); do not invoke vitest directly.
 */

import { describe, it, expect, vi } from 'vitest';
import { runWorklistTui, ANSI } from './worklist.js';
import { loadShortcutConfig, ShortcutRegistry, type ShortcutEntry } from './shortcut-config.js';
import { setExecFileAsync, resetExecFileAsync, type WorkItem } from './fetcher.js';

// ── Fixtures ───────────────────────────────────────────────────────────

/** Minimal WorkItem with the fields the list renderer reads. */
function makeItem(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Item ${id}`,
    status: 'open',
    stage: 'plan_complete',
    ...overrides,
  };
}

/**
 * A label that appears ONLY in the full help enumeration — the list-mode
 * footer collapses the `c` leader family to `c:create...`, so `create quick`
 * is a reliable "the help overlay is open" signal.
 */
const HELP_MARKER = 'create quick';
const DISMISS_KEYS_RE = /Esc|Escape/;

/** Strip all ANSI escape sequences for text assertions. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[^[]/g, '');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type StdinListener = (chunk: Buffer) => void;

interface Harness {
  /** Send a single decoded key to the TUI. */
  press(key: string): void;
  /** The raw, unstripped last frame (ANSI included). */
  rawFrame(): string;
  /** The stripped last frame used for text assertions. */
  frame(): string;
  /** Poll until the stripped frame satisfies `predicate`. */
  waitForFrame(predicate: (frame: string) => boolean, label: string, timeoutMs?: number): Promise<void>;
  /** The visible shortcut entries the footer path uses for the selected item. */
  visibleEntries(): ShortcutEntry[];
}

interface TuiOptions {
  showHelpText?: boolean;
  rows?: number;
  cols?: number;
  registry?: ShortcutRegistry;
  onCommand?: (...args: unknown[]) => void;
  onDowntimeToggle?: () => void;
}

/** Force `getTermSize()` to report a deterministic pane size. */
function overrideStdoutSize(rows: number, cols: number): () => void {
  const hadRows = Object.prototype.hasOwnProperty.call(process.stdout, 'rows');
  const hadCols = Object.prototype.hasOwnProperty.call(process.stdout, 'columns');
  const prevRows = (process.stdout as unknown as { rows?: number }).rows;
  const prevCols = (process.stdout as unknown as { columns?: number }).columns;
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true, writable: true });
  return () => {
    if (hadRows) Object.defineProperty(process.stdout, 'rows', { value: prevRows, configurable: true, writable: true });
    else delete (process.stdout as unknown as { rows?: number }).rows;
    if (hadCols) Object.defineProperty(process.stdout, 'columns', { value: prevCols, configurable: true, writable: true });
    else delete (process.stdout as unknown as { columns?: number }).columns;
  };
}

/**
 * Drive the real TUI in a fake TTY for the duration of `body`.
 *
 * Installation mirrors the composed-footer harness in worklist.test.ts: a
 * fake TTY stdin records data listeners, `process.stdout.write` is captured
 * so individual frames can be reconstructed, and the `execFileAsync` seam is
 * stubbed so no real `wl`/`herdr` process is spawned. Cleanup ALWAYS runs:
 * the TUI is quit (repeatedly sending `q` covers the help→list→quit path),
 * the promise is drained, and every global is restored — a failing assertion
 * never leaks the event loop.
 */
async function runWithTui(
  items: WorkItem[],
  body: (h: Harness) => Promise<void>,
  options: TuiOptions = {},
): Promise<void> {
  const restoreSize = overrideStdoutSize(options.rows ?? 24, options.cols ?? 100);
  const dataListeners: StdinListener[] = [];
  const writes: string[] = [];
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
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as any);
  const origStdin = (process as unknown as { stdin: unknown }).stdin;
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true, writable: true });
  setExecFileAsync((async () => ({ stdout: '{"count": 0}' })) as any);

  const rawFrame = (): string => {
    const all = writes.join('');
    const idx = all.lastIndexOf(ANSI.clear);
    return idx >= 0 ? all.slice(idx + ANSI.clear.length) : all;
  };
  const frame = (): string => stripAnsi(rawFrame());

  const harness: Harness = {
    press: (key: string) => {
      dataListeners.forEach((cb) => cb(Buffer.from(key)));
    },
    rawFrame,
    frame,
    waitForFrame: async (predicate, label, timeoutMs = 5000) => {
      try {
        await vi.waitFor(
          () => {
            if (!predicate(frame())) throw new Error(`frame did not satisfy: ${label}`);
          },
          { timeout: timeoutMs, interval: 20 },
        );
      } catch {
        throw new Error(`waitForFrame(${label}) failed. Last frame:\n${frame()}`);
      }
    },
    visibleEntries: () =>
      loadShortcutConfig()
        .getEntriesForStage('plan_complete', false, undefined)
        .filter((e) => e.view === 'list' || e.view === 'both'),
  };

  let tui: Promise<WorkItem | undefined> | undefined;
  try {
    tui = runWorklistTui(
      async () => items,
      items,
      options.registry ?? loadShortcutConfig(),
      {
        autoRefresh: false,
        autoSync: false,
        showHelpText: options.showHelpText ?? true,
        onCommand: options.onCommand as any,
        onDowntimeToggle: options.onDowntimeToggle,
      },
    );
    await vi.waitFor(() => {
      expect(writes.length).toBeGreaterThan(0);
    });
    await body(harness);
  } finally {
    // Quit the TUI. `q` first dismisses help (if open), a second `q` quits.
    if (tui) {
      for (let attempt = 0; attempt < 4; attempt++) {
        dataListeners.forEach((cb) => cb(Buffer.from('q')));
        const settled = await Promise.race([
          tui.then(() => true, () => true),
          delay(60).then(() => false),
        ]);
        if (settled) break;
      }
      await tui.catch(() => undefined);
    }
    Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true, writable: true });
    writeSpy.mockRestore();
    resetExecFileAsync();
    restoreSize();
  }
}

const isHelpOpen = (f: string): boolean => f.includes(HELP_MARKER) || DISMISS_KEYS_RE.test(f);
const isListMode = (f: string): boolean => f.includes('Work Items') && !f.includes(HELP_MARKER);

// ── AC1: `?` opens help; `?`/Esc/`q` each return to list ───────────────

describe('help screen overlay — open/dismiss (WL-0MV85R0JD004CHAE)', () => {
  it.fails('opens on ? and dismisses with ?, Esc and q back to list mode', async () => {
    const items = [makeItem('A'), makeItem('B'), makeItem('C')];
    await runWithTui(items, async (h) => {
      // ? opens the overlay.
      h.press('?');
      await h.waitForFrame(isHelpOpen, 'help open after ?');

      // ? dismisses it.
      h.press('?');
      await h.waitForFrame(isListMode, 'list after ? dismiss');

      // Esc dismisses it.
      h.press('?');
      await h.waitForFrame(isHelpOpen, 'help open again after ?');
      h.press('\x1b');
      await h.waitForFrame(isListMode, 'list after Esc dismiss');

      // q dismisses it WITHOUT quitting the TUI (a further ? still works).
      h.press('?');
      await h.waitForFrame(isHelpOpen, 'help open again before q');
      h.press('q');
      await h.waitForFrame(isListMode, 'list after q dismiss');
      h.press('?');
      await h.waitForFrame(isHelpOpen, 'help still reachable after q (did not quit)');
    });
  });

  // ── AC2: dismissing help mutates no list state ─────────────────────

  it.fails('leaves the selection unchanged after help is dismissed', async () => {
    const items = [makeItem('A'), makeItem('B'), makeItem('C')];
    await runWithTui(items, async (h) => {
      // Move the cursor onto item B, then capture the exact list frame.
      h.press('j');
      await h.waitForFrame((f) => f.includes('▸ Item B'), 'selection on Item B');
      const listFrameBefore = h.rawFrame();

      // Open then dismiss help.
      h.press('?');
      await h.waitForFrame(isHelpOpen, 'help open');
      h.press('q');
      await h.waitForFrame(isListMode, 'list after dismiss');

      // The whole frame is byte-identical — selection, scroll, filters and
      // navigation stack are untouched (a full-pane overlay is display-only).
      expect(h.rawFrame()).toBe(listFrameBefore);
      expect(h.frame()).toContain('▸ Item B');
    });
  });

  it.fails('is display-only — keys pressed while help is open dispatch nothing', async () => {
    const items = [makeItem('A')];
    const onCommand = vi.fn();
    const onDowntimeToggle = vi.fn();
    await runWithTui(
      items,
      async (h) => {
        h.press('?');
        await h.waitForFrame(isHelpOpen, 'help open');

        // Keys that WOULD dispatch in list mode must be inert while help is
        // open (the `d` downtime toggle and the `i` implement shortcut).
        h.press('d');
        h.press('i');
        await delay(80);

        expect(onDowntimeToggle).not.toHaveBeenCalled();
        expect(onCommand).not.toHaveBeenCalled();
        // Still in help mode (no command ran, no mode change).
        expect(isHelpOpen(h.frame())).toBe(true);
      },
      { onCommand: onCommand as any, onDowntimeToggle },
    );
  });
});

// ── AC3: command enumeration from the live registry ─────────────────────

describe('help screen overlay — command enumeration (WL-0MV85R0JD004CHAE)', () => {
  it.fails('enumerates every visible registry shortcut, grouped by chord leader', async () => {
    const items = [makeItem('A')];
    await runWithTui(
      items,
      async (h) => {
        h.press('?');
        await h.waitForFrame(isHelpOpen, 'help open');

        const visible = h.visibleEntries();
        expect(visible.length).toBeGreaterThan(10);
        const frame = h.frame();

        // Every visible shortcut's label is present (enumeration is complete).
        for (const entry of visible) {
          const label = entry.label ?? entry.command;
          expect(frame, `help should list label "${label}"`).toContain(label);
        }

        // Multi-key families are grouped by their shared leader: both `c`
        // sub-chords are enumerated, not collapsed to a single hint.
        expect(frame).toContain('create intake');
        expect(frame).toContain('create quick');

        // Each entry shows a short description (not just a bare label).
        expect(frame).toContain('Toggle downtime dispatch');
        expect(frame).toContain('Create a new work item');
        expect(frame).toContain('Run the implement workflow');
      },
      { cols: 200 },
    );
  });

  it.fails('derives the command list from the live ShortcutRegistry', async () => {
    const items = [makeItem('A')];
    const sentinel: ShortcutEntry = {
      command: '/skill:audit <id>',
      view: 'list',
      chord: ['Z'],
      label: 'sentinel help command',
      description: 'Sentinel description visible only in the help overlay.',
    };
    const registry = new ShortcutRegistry([sentinel]);
    await runWithTui(
      items,
      async (h) => {
        h.press('?');
        await h.waitForFrame(isHelpOpen, 'help open from live registry');
        const frame = h.frame();
        expect(frame).toContain('sentinel help command');
        expect(frame).toContain('Sentinel description');
        // The chord itself is rendered (a future shortcut appears automatically).
        expect(frame).toContain('Z');
      },
      { registry, cols: 120 },
    );
  });
});

// ── AC4: pane-height budget + discoverable dismiss keys ─────────────────

describe('help screen overlay — small-pane behaviour (WL-0MV85R0JD004CHAE)', () => {
  it.fails('stays within the rows - 1 budget on a short pane and keeps dismiss keys discoverable', async () => {
    const rows = 12;
    const items = [makeItem('A'), makeItem('B'), makeItem('C')];
    await runWithTui(
      items,
      async (h) => {
        h.press('?');
        await h.waitForFrame(isHelpOpen, 'help open on short pane');

        const lines = h.frame().split('\n');
        expect(lines.length).toBeLessThanOrEqual(rows - 1);

        // The dismiss keys remain discoverable even when content is clipped.
        expect(h.frame()).toMatch(DISMISS_KEYS_RE);
        expect(h.frame()).toContain('?');
      },
      { rows, cols: 100 },
    );
  });
});

// ── AC5: showHelpText gate ──────────────────────────────────────────────

describe('help screen overlay — showHelpText gate (WL-0MV85R0JD004CHAE)', () => {
  it.fails('honours showHelpText: false while offering help when enabled', async () => {
    const items = [makeItem('A')];

    // Enabled: `?` opens the help overlay.
    await runWithTui(
      items,
      async (h) => {
        h.press('?');
        await h.waitForFrame(isHelpOpen, 'help open when enabled');
        expect(h.frame()).toMatch(DISMISS_KEYS_RE);
      },
      { showHelpText: true },
    );

    // Disabled: `?` is a no-op — the list stays and no help is offered.
    await runWithTui(
      items,
      async (h) => {
        h.press('?');
        await delay(120);
        expect(h.frame()).not.toContain(HELP_MARKER);
        expect(h.frame()).toContain('Work Items');
      },
      { showHelpText: false },
    );
  });
});
