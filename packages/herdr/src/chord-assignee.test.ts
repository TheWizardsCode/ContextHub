/**
 * packages/herdr/src/chord-assignee.test.ts — Regression tests for the
 * assignee (owner-axis) chords `o p` / `o a` / `o n`
 * (WL-0MW51P7FO003AC74, child WL-0MWHV7VG5009JMTW).
 *
 * The `o` (owner) leader key gives operators one-key access to the
 * scheduling-hold semantics that drive dispatch, without hand-editing via
 * the CLI:
 *
 *   - `o p` — assignee = `producer` (persistent scheduling hold)
 *   - `o a` — assignee = `agent`    (session claim)
 *   - `o n` — clear the assignee    (dispatchable)
 *
 * These tests drive the real `runWorklistTui` input loop with the production
 * `loadShortcutConfig()` registry (merged over a temp worklog root whose
 * local `shortcuts.json` carries the three assignee chords) to verify that:
 *
 *   - each chord resolves against the focused item and dispatches the exact
 *     `!!wl update <id> --assignee <value>` command for the selected item;
 *   - the empty value is preserved for `o n` (the clear path);
 *   - the entries carry `open_pane: false` so the update runs in the
 *     background and the completion-refresh hook is forwarded (mirroring the
 *     `c q` quick-create chord, WL-0MTCLB50D0026YA7);
 *   - the existing `a` leader audit chords (`a a` / `a y` / `a r`) still
 *     resolve to their original commands — the new `o` family must not
 *     collide with them.
 *
 * Run: npx vitest run packages/herdr/src/chord-assignee.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    fetchBlockersForItem: vi.fn().mockResolvedValue([]),
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

import { runWorklistTui, type WorkItem } from './worklist.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { setLogPath, resetLogPath } from './command-log.js';

// ---------------------------------------------------------------------------
// Assignee (owner-axis) chord fixture
// ---------------------------------------------------------------------------

/**
 * The three assignee chords, in their production `shortcuts.json` shape
 * (AC1). They carry `open_pane: false` so the update runs in the background
 * and the completion-refresh hook fires when `wl update` exits (AC3).
 */
// Raw `shortcuts.json` shape (snake_case keys — `parseShortcutEntry` reads
// `open_pane`, not `openPane`).
const ASSIGNEE_SHORTCUTS = [
  {
    chord: ['o', 'p'],
    command: '!!wl update <id> --assignee producer',
    view: 'both',
    label: 'assignee producer',
    description: 'Set the focused item assignee to producer (persistent scheduling hold) (o p).',
    open_pane: false,
  },
  {
    chord: ['o', 'a'],
    command: '!!wl update <id> --assignee agent',
    view: 'both',
    label: 'assignee agent',
    description: 'Set the focused item assignee to agent (session claim) (o a).',
    open_pane: false,
  },
  {
    chord: ['o', 'n'],
    command: '!!wl update <id> --assignee ""',
    view: 'both',
    label: 'assignee clear',
    description: 'Clear the focused item assignee so it becomes dispatchable again (o n).',
    open_pane: false,
  },
];

const ITEMS: WorkItem[] = [{ id: 'TEST-1', title: 'Item TEST-1', status: 'open' }];

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as chord-quick-create.test.ts)
// ---------------------------------------------------------------------------

type StdinListener = (chunk: Buffer) => void;

let dataListeners: StdinListener[];
let writes: string[];
let tmpDir: string;

beforeEach(() => {
  dataListeners = [];
  writes = [];

  // A temp worklog root with a local shortcuts.json carrying the assignee
  // chords. `loadShortcutConfig(root)` merges it over the bundled defaults,
  // so the audit-family chords are still present for the collision checks.
  tmpDir = mkdtempSync(join(tmpdir(), 'herdr-assignee-chord-'));
  writeFileSync(
    join(tmpDir, 'shortcuts.json'),
    JSON.stringify(ASSIGNEE_SHORTCUTS, null, 2),
    'utf-8',
  );

  // Isolate the command log so dispatched commands never touch the user's
  // real ~/.config/herdr log.
  setLogPath(join(tmpDir, 'cmdlog.json'));

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
  Object.defineProperty(process, 'stdin', {
    value: fakeStdin,
    configurable: true,
    writable: true,
  });

  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as any);
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

interface DriveResult {
  onCommand: ReturnType<typeof vi.fn>;
  onRefresh: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
}

/**
 * Drive the real input loop: press the given chord keys against the focused
 * item (the first item, selected by default) and return the `onCommand`
 * spy. The registry is the production `loadShortcutConfig()` merged with the
 * temp local fixture.
 */
async function driveChord(
  keys: string[],
  options: { withOwnRefresh?: boolean } = {},
): Promise<DriveResult> {
  const { withOwnRefresh = true } = options;
  const onCommand = vi.fn();
  const onRefresh = vi.fn();
  const fetch = vi.fn(async () => ITEMS);

  const press = async (key: string): Promise<void> => {
    dataListeners.forEach((cb) => cb(Buffer.from(key)));
    await tick();
  };

  let tui: Promise<WorkItem | undefined> | undefined;
  try {
    tui = runWorklistTui(fetch, ITEMS, loadShortcutConfig(tmpDir), {
      autoRefresh: false,
      autoSync: false,
      onCommand,
      // When `withOwnRefresh` is false, let the TUI wire its internal
      // doRefresh so the forwarded completion hook actually refetches.
      ...(withOwnRefresh ? { onRefresh } : {}),
    });

    await vi.waitFor(() => {
      expect(dataListeners.length).toBeGreaterThan(0);
    });

    for (const key of keys) {
      await press(key);
    }

    await vi.waitFor(() => {
      expect(onCommand).toHaveBeenCalled();
    });

    return { onCommand, onRefresh, fetch };
  } finally {
    dataListeners.forEach((cb) => cb(Buffer.from('q')));
    if (tui) await tui.catch(() => undefined);
  }
}

describe('assignee chords o p / o a / o n (WL-0MWHV7VG5009JMTW)', () => {
  it('o p dispatches wl update --assignee producer against the focused item', async () => {
    const { onCommand, onRefresh, fetch } = await driveChord(['o', 'p']);

    expect(onCommand).toHaveBeenCalledTimes(1);
    // 3rd arg `false` → background (no pane); 4th arg is the completion
    // refresh hook (mirrors chord-quick-create's open_pane: false wiring);
    // 5th arg is the descriptive pane title threaded from the selected item.
    expect(onCommand).toHaveBeenCalledWith(
      '!!wl update TEST-1 --assignee producer',
      undefined,
      false,
      onRefresh,
      'Item TEST-1',
    );
    // Initial items were supplied — the ONLY refresh is the forwarded
    // completion hook, so dispatching alone must not refetch.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('o a dispatches wl update --assignee agent against the focused item', async () => {
    const { onCommand, onRefresh } = await driveChord(['o', 'a']);

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith(
      '!!wl update TEST-1 --assignee agent',
      undefined,
      false,
      onRefresh,
      'Item TEST-1',
    );
  });

  it('o n clears the assignee (empty value) against the focused item', async () => {
    const { onCommand, onRefresh } = await driveChord(['o', 'n']);

    expect(onCommand).toHaveBeenCalledTimes(1);
    // The empty assignee must survive placeholder resolution — clearing a
    // stale hold is the whole point of `o n`.
    expect(onCommand).toHaveBeenCalledWith(
      '!!wl update TEST-1 --assignee ""',
      undefined,
      false,
      onRefresh,
      'Item TEST-1',
    );
  });

  it('the forwarded completion-refresh hook refetches the list', async () => {
    const { onCommand, fetch } = await driveChord(['o', 'p'], { withOwnRefresh: false });
    const call = onCommand.mock.calls[0] as [string, unknown, unknown, () => Promise<void>];
    expect(typeof call[3]).toBe('function');
    await call[3]();
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
  });

  it('leaves the a-leader audit chords unchanged (no o-leader collision)', () => {
    const registry = loadShortcutConfig(tmpDir);

    // The new `o` family must not shadow the audit command family.
    expect(registry.lookupChordEntry(['a', 'a'], 'list')?.command).toBe('/skill:audit <id>');
    expect(registry.lookupChordEntry(['a', 'y'], 'list')?.command).toBe(
      "!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes --summary 'Approved by manual review'",
    );
    expect(registry.lookupChordEntry(['a', 'r'], 'list')?.command).toBe(
      "!!wl reviewed <id> false && wl update <id> --status open --stage plan_complete && wl audit-set <id> --ready-to-close no --summary 'Rejected by manual review. <reason>'",
    );

    // And each assignee chord resolves to its own distinct command.
    expect(registry.lookupChordEntry(['o', 'p'], 'list')?.command).toBe(
      '!!wl update <id> --assignee producer',
    );
    expect(registry.lookupChordEntry(['o', 'a'], 'list')?.command).toBe(
      '!!wl update <id> --assignee agent',
    );
    expect(registry.lookupChordEntry(['o', 'n'], 'list')?.command).toBe(
      '!!wl update <id> --assignee ""',
    );

    // The `o` leader is a new family — `a` remains the single audit leader.
    expect(registry.getChordByLeader('o', 'list').length).toBe(3);
    expect(registry.getChordByLeader('a', 'list').map((e) => e.chord.join(',')).sort()).toEqual([
      'a,a',
      'a,r',
      'a,y',
    ]);
  });
});
