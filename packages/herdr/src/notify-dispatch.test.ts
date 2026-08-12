/**
 * packages/herdr/src/notify-dispatch.test.ts — Integration tests verifying
 * that the worklist TUI dispatches toast notifications via showToast()
 * instead of appending a bottom-line status to the pane output
 * (WL-0MSACL482002RNYH).
 *
 * Run: npx vitest run packages/herdr/src/notify-dispatch.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before worklist.js is imported)
// ---------------------------------------------------------------------------

vi.mock('./fetcher.js', () => ({
  fetchActionableCount: vi.fn().mockResolvedValue(5),
  fetchChildrenForItem: vi.fn().mockResolvedValue([]),
  getWorklogDir: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./auto-sync.js', () => ({
  runSync: vi.fn().mockResolvedValue({ success: true }),
  createSyncTimer: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  clampSyncInterval: vi.fn((v: number) => v),
  heartbeatTtlForInterval: vi.fn(() => 45_000),
}));

vi.mock('./notify.js', () => ({
  showToast: vi.fn(),
}));

import { runWorklistTui } from './worklist.js';
import { showToast } from './notify.js';
import { runSync } from './auto-sync.js';
import { ShortcutRegistry } from './shortcut-config.js';

const mockShowToast = showToast as Mock;
const mockRunSync = runSync as Mock;

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness
// ---------------------------------------------------------------------------

/** Captures the 'data' listener registered by runWorklistTui. */
let dataHandler: ((chunk: Buffer) => void) | undefined;
/** Every string written to stdout during a run. */
let writes: string[];

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];

  // Define missing stdin properties (vitest's process.stdin may not expose them)
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
  vi.restoreAllMocks();
});

/** Small async tick helper so awaited promises settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runWorklistTui toast dispatch', () => {
  it('does not sync on S (manual sync removed) and writes no bottom line', async () => {
    const p = runWorklistTui(async () => [], [], undefined, {
      autoRefresh: false,
      autoSync: false,
      showHelpText: false,
    });
    // Let initial render settle
    await tick();

    // Manual sync was removed (WL-0MSGG5N5Z0074TLY): pressing S must NOT
    // spawn `wl sync` (auto-sync on the timer is the only sync source).
    dataHandler?.(Buffer.from('S'));
    await tick();
    await tick();

    expect(mockRunSync).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();

    // Quit
    dataHandler?.(Buffer.from('q'));
    await p;

    // The pane output must never contain a bottom-line notification append
    const rendered = writes.filter((w) => !w.includes('\x1b[')).join('');
    expect(rendered).not.toContain('[Synced]');
    expect(rendered).not.toContain('[Refreshed');
  });

  it('dispatches a Sync failed toast with the error body on auto-sync failure', async () => {
    mockRunSync.mockResolvedValueOnce({ success: false, error: 'lock held' });
    const p = runWorklistTui(async () => [], [], undefined, {
      autoRefresh: false,
      autoSync: true,
      syncIntervalMs: 60_000,
      showHelpText: false,
    });
    await tick();
    // The auto-sync task fires immediately on scheduler start
    // (fireImmediately), so the failing sync surfaces its toast without
    // waiting for the full interval.
    await tick();

    expect(mockShowToast).toHaveBeenCalledWith('Sync failed', { body: 'lock held' });

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('never writes a notification bottom line for any render', async () => {
    const p = runWorklistTui(async () => [], [], undefined, {
      autoRefresh: false,
      autoSync: false,
      showHelpText: false,
    });
    await tick();

    dataHandler?.(Buffer.from('j')); // navigate — triggers render
    await tick();
    dataHandler?.(Buffer.from('q'));
    await p;

    const rendered = writes.filter((w) => !w.includes('\x1b[')).join('');
    // No '[Refreshed', '[Synced', 'Sent:', 'Skipped:', 'Error:' bottom lines
    expect(rendered).not.toMatch(/\[(Refreshed|Synced|Refresh failed|Sync failed)/);
    expect(rendered).not.toMatch(/\n(Sent|Skipped|Error):/);
  });
});

describe('form command dispatch — single onCommand per submission (WL-0MSAL0RN1009YNJ7)', () => {
  const createIntakeRegistry = () => new ShortcutRegistry([
    {
      chord: ['c'],
      command: '/intake\n<desc>\nPriority: medium',
      view: 'both',
      description: 'Create a new work item with a description and priority.',
    },
  ]);

  it('dispatches onCommand exactly once when the create-new intake form is submitted', async () => {
    const onCommand = vi.fn();
    const p = runWorklistTui(async () => [], [], createIntakeRegistry(), {
      autoRefresh: false,
      autoSync: false,
      showHelpText: false,
      onCommand,
    });
    await tick();

    // Press 'c' — opens the Command Input form (unknown identifier <desc>)
    dataHandler?.(Buffer.from('c'));
    await tick();

    // Type a description (one keypress per char) and submit with Enter
    for (const ch of 'My new item') {
      dataHandler?.(Buffer.from(ch));
      await tick();
    }
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();

    // Regression: the form's onSubmit callback AND the onData 'submitted'
    // branch both used to call onCommand, spawning TWO pi panes.
    expect(onCommand).toHaveBeenCalledTimes(1);
    // The registry entry carries no model, so the second arg is undefined.
    expect(onCommand).toHaveBeenCalledWith('/intake\nMy new item\nPriority: medium', undefined);

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('shows exactly one Sent toast per form submission', async () => {
    const onCommand = vi.fn();
    const p = runWorklistTui(async () => [], [], createIntakeRegistry(), {
      autoRefresh: false,
      autoSync: false,
      showHelpText: false,
      onCommand,
    });
    await tick();

    dataHandler?.(Buffer.from('c'));
    await tick();
    for (const ch of 'desc') {
      dataHandler?.(Buffer.from(ch));
      await tick();
    }
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();

    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith('Sent', expect.objectContaining({ body: expect.stringContaining('/intake') }));

    dataHandler?.(Buffer.from('q'));
    await p;
  });
});

describe('model propagation through TUI dispatch (WL-0MSD48ZFC0043AO3)', () => {
  const createModelRegistry = () => new ShortcutRegistry([
    {
      chord: ['i'],
      command: '/skill:implement <id>',
      view: 'both',
      label: 'implement',
      model: 'code',
      stages: ['intake_complete', 'plan_complete', 'in_progress'],
    },
    {
      chord: ['a', 'a'],
      command: '/skill:audit <id>',
      view: 'both',
      label: 'audit automatic',
      model: 'plan',
      stages: ['in_review'],
    },
  ]);

  it('passes the shortcut model to onCommand on single-key dispatch', async () => {
    const onCommand = vi.fn();
    const items = [{ id: 'WL-001', title: 'Item', status: 'open', stage: 'plan_complete' }];
    const p = runWorklistTui(async () => items, items, createModelRegistry(), {
      autoRefresh: false,
      autoSync: false,
      showHelpText: false,
      onCommand,
    });
    await tick();

    dataHandler?.(Buffer.from('i'));
    await tick();
    await tick();

    expect(onCommand).toHaveBeenCalledWith('/skill:implement WL-001', 'code');

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('passes the shortcut model to onCommand on multi-key chord dispatch', async () => {
    const onCommand = vi.fn();
    const items = [{ id: 'WL-001', title: 'Item', status: 'open', stage: 'in_review' }];
    const p = runWorklistTui(async () => items, items, createModelRegistry(), {
      autoRefresh: false,
      autoSync: false,
      showHelpText: false,
      onCommand,
    });
    await tick();

    dataHandler?.(Buffer.from('a'));
    await tick();
    dataHandler?.(Buffer.from('a'));
    await tick();
    await tick();

    expect(onCommand).toHaveBeenCalledWith('/skill:audit WL-001', 'plan');

    dataHandler?.(Buffer.from('q'));
    await p;
  });

  it('passes the shortcut model to onCommand after form submission', async () => {
    const onCommand = vi.fn();
    const registry = new ShortcutRegistry([
      {
        chord: ['c'],
        command: '/intake <description>',
        view: 'both',
        description: 'Create a new work item.',
        model: 'plan',
      },
    ]);
    const p = runWorklistTui(async () => [], [], registry, {
      autoRefresh: false,
      autoSync: false,
      showHelpText: false,
      onCommand,
    });
    await tick();

    // 'c' opens the Command Input form (unknown identifier <description>)
    dataHandler?.(Buffer.from('c'));
    await tick();
    for (const ch of 'My item') {
      dataHandler?.(Buffer.from(ch));
      await tick();
    }
    dataHandler?.(Buffer.from('\r'));
    await tick();
    await tick();

    expect(onCommand).toHaveBeenCalledWith('/intake My item', 'plan');

    dataHandler?.(Buffer.from('q'));
    await p;
  });
});
