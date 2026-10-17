/**
 * packages/herdr/src/worklist-active-pane-marker.test.ts — Integration tests
 * for the pane-title-based in-progress marker in the selection list
 * (WL-0MV1BWETT005GSUJ).
 *
 * The producer rejected the tab-label fix as unreliable and directed a single
 * simple rule: "Look for a pane in this workspace with the work item id as
 * the title. If it exists then work item is busy." The selection list's
 * in-progress marker must therefore reflect **pane-title existence**, not
 * only the worklog status the demotion loop maintains. `runWorklistTui`
 * accepts an `applyActivePaneMarkers` seam (injected by `index.ts`; a no-op
 * in tests); the refresh cycle marks every item whose work-item ID appears in
 * a current-workspace pane title as `in-progress` before rendering.
 *
 * Run: npx vitest run packages/herdr/src/worklist-active-pane-marker.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('./auto-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auto-sync.js')>();
  return {
    ...actual,
    runSync: vi.fn().mockResolvedValue({ success: true }),
  };
});

vi.mock('./notify.js', () => ({
  showToast: vi.fn(),
}));

import { runWorklistTui } from './worklist.js';
import { setExecFileAsync, resetExecFileAsync } from './fetcher.js';
import type { WorkItem } from './fetcher.js';
import { applyActivePaneMarkers as applyPaneMarkersToItems, type HydratorPane } from './hydrator.js';

const IN_PROGRESS_ICON = '\u{1F504}'; // 🔄
const OPEN_ICON = '\u{1F513}'; // 🔓
const GREEN_CIRCLE = '\u{1F7E2}'; // 🟢 — green circle (work-item pane open)

// Realistic work-item IDs (prefix + dash + 6+ base36 chars).
const ITEM = 'WL-0MV1BWETT005GSUJ';
const OTHER_ITEM = 'WL-0MV24T2VJ007Q49J';

/** A realistic dispatched pane title: the ID survives as a trailing suffix. */
const titleFor = (id: string): string => `Downtime triggered implement Foo - ${id}`;

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];

beforeEach(() => {
  vi.clearAllMocks();
  dataHandler = undefined;
  writes = [];

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
  resetExecFileAsync();
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_WORKSPACE_ID;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeExecMock(): Mock {
  return vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'herdr' && args[0] === 'pane' && args[1] === 'get') {
      return {
        stdout: JSON.stringify({ id: 'cli:pane:get', result: { pane: { focused: true } } }),
        stderr: '',
      };
    }
    if (args.includes('list') && args.includes('--status')) {
      return { stdout: JSON.stringify({ count: 1 }), stderr: '' };
    }
    return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
  });
}

async function quit(p: Promise<unknown>): Promise<void> {
  dataHandler?.(Buffer.from('q'));
  await p;
}

describe('worklist — pane-title-based in-progress marker', () => {
  it('shows the in-progress marker for a worklog-open item with a matching workspace pane title', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    setExecFileAsync(makeExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: ITEM, title: 'Pane is open', status: 'open', stage: 'plan_complete' },
    ]);
    const listActivePanes = vi.fn(
      async (_workspaceId?: string): Promise<HydratorPane[]> => [
        { pane_id: 'w1:p1', label: titleFor(ITEM), workspace_id: 'w1' },
      ],
    );

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      applyActivePaneMarkers: (items) => applyPaneMarkersToItems(items, listActivePanes, 'w1'),
    });
    await vi.advanceTimersByTimeAsync(0);

    // First auto-refresh applies the pane marker before rendering.
    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).toContain(ITEM);
    expect(output).toContain(IN_PROGRESS_ICON);
    expect(output).not.toContain(OPEN_ICON);
    // The open pane also shows the green-circle icon (agent slot).
    expect(output).toContain(GREEN_CIRCLE);
    // The pane lookup is scoped to the current workspace.
    expect(listActivePanes).toHaveBeenCalledWith('w1');

    await quit(p);
  });

  it('keeps the open marker when no pane title matches the item', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    setExecFileAsync(makeExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: OTHER_ITEM, title: 'No pane open', status: 'open', stage: 'plan_complete' },
    ]);
    const listActivePanes = vi.fn(async (): Promise<HydratorPane[]> => [
      { pane_id: 'w1:p1', label: titleFor(ITEM), workspace_id: 'w1' },
    ]);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      applyActivePaneMarkers: (items) => applyPaneMarkersToItems(items, listActivePanes, 'w1'),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).toContain(OTHER_ITEM);
    expect(output).toContain(OPEN_ICON);
    expect(output).not.toContain(IN_PROGRESS_ICON);
    // No matching pane → no green circle (never appears without an open pane).
    expect(output).not.toContain(GREEN_CIRCLE);

    await quit(p);
  });

  it('does not mark an item whose pane is in another workspace', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    setExecFileAsync(makeExecMock() as any);

    const OTHER = 'WL-0MV25EE4E0028KDI';
    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: OTHER, title: 'Pane elsewhere', status: 'open', stage: 'plan_complete' },
    ]);
    const listActivePanes = vi.fn(async (): Promise<HydratorPane[]> => [
      { pane_id: 'w2:p1', label: titleFor(OTHER), workspace_id: 'w2' },
    ]);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      applyActivePaneMarkers: (items) => applyPaneMarkersToItems(items, listActivePanes, 'w1'),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).toContain(OPEN_ICON);
    expect(output).not.toContain(IN_PROGRESS_ICON);

    await quit(p);
  });

  it('clears the marker within one hydrator cadence when the pane closes (no DB change, no wl refetch)', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    setExecFileAsync(makeExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: ITEM, title: 'Pane is open', status: 'open', stage: 'plan_complete' },
    ]);
    // Mutable pane set: the item starts with a matching pane title, then the
    // pane is closed while the worklog DB stays untouched.
    let panes: HydratorPane[] = [{ pane_id: 'w1:p1', label: titleFor(ITEM), workspace_id: 'w1' }];
    const listActivePanes = vi.fn(async (): Promise<HydratorPane[]> => panes);

    const p = runWorklistTui(
      fetcher,
      [{ id: ITEM, title: 'Pane is open', status: 'open', stage: 'plan_complete' }],
      undefined,
      {
        autoRefresh: true,
        // Longer than the marker cadence so ONLY the new active-pane-marker
        // task (not the DB-gated refresh tick) can update the marker here.
        refreshIntervalMs: 5 * 60_000,
        autoSync: false,
        showHelpText: false,
        applyActivePaneMarkers: (items) => applyPaneMarkersToItems(items, listActivePanes, 'w1'),
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    // Initial load marks the item (matching pane title is open) — in-progress
    // marker AND green circle.
    expect(writes.join('')).toContain(IN_PROGRESS_ICON);
    expect(writes.join('')).toContain(GREEN_CIRCLE);

    // Close the pane; the next marker cadence must clear BOTH the marker and
    // the green circle even though no worklog write (DB change) happened and
    // the refresh tick is disabled for the duration of this test.
    panes = [];
    writes.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).toContain(ITEM);
    expect(output).toContain(OPEN_ICON);
    expect(output).not.toContain(IN_PROGRESS_ICON);
    expect(output).not.toContain(GREEN_CIRCLE);
    expect(listActivePanes.mock.calls.length).toBeGreaterThan(1);

    await quit(p);
  });
});
