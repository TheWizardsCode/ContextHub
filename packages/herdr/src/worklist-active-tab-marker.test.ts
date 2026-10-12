/**
 * packages/herdr/src/worklist-active-tab-marker.test.ts — Integration tests
 * for the tab-based in-progress marker in the selection list
 * (WL-0MV1BWETT005GSUJ).
 *
 * The producer rejected the hydrator-only fix: "I see no markers on active
 * items that have open panes." The selection list's in-progress marker must
 * therefore reflect **tab existence**, not only the worklog status the
 * demotion loop maintains. `runWorklistTui` accepts an `applyActiveTabMarkers`
 * seam (injected by `index.ts`; a no-op in tests); the refresh cycle marks
 * every item with an exact-match tab in the current workspace as `in-progress`
 * before rendering.
 *
 * Run: npx vitest run packages/herdr/src/worklist-active-tab-marker.test.ts
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
import { applyActiveTabMarkers as applyTabMarkersToItems, type HydratorTab } from './hydrator.js';

const IN_PROGRESS_ICON = '\u{1F504}'; // 🔄
const OPEN_ICON = '\u{1F513}'; // 🔓

// Realistic work-item IDs: `collectTabWorkItemIds` only matches labels that
// look exactly like a work-item ID (prefix + dash + 6+ base36 chars).
const ITEM = 'WL-0MV1BWETT005GSUJ';
const OTHER_ITEM = 'WL-0MV24T2VJ007Q49J';

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

describe('worklist — tab-based in-progress marker', () => {
  it('shows the in-progress marker for a worklog-open item with a matching workspace tab', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    setExecFileAsync(makeExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: ITEM, title: 'Tab is open', status: 'open', stage: 'plan_complete' },
    ]);
    const listTabs = vi.fn(async (_workspaceId?: string): Promise<HydratorTab[]> => [
      { tab_id: 'w1:t1', label: ITEM, workspace_id: 'w1' },
    ]);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      applyActiveTabMarkers: (items) => applyTabMarkersToItems(items, listTabs, 'w1'),
    });
    await vi.advanceTimersByTimeAsync(0);

    // First auto-refresh applies the tab marker before rendering.
    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).toContain(ITEM);
    expect(output).toContain(IN_PROGRESS_ICON);
    expect(output).not.toContain(OPEN_ICON);
    // The tab lookup is scoped to the current workspace.
    expect(listTabs).toHaveBeenCalledWith('w1');

    await quit(p);
  });

  it('keeps the open marker when no tab matches the item', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    setExecFileAsync(makeExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: OTHER_ITEM, title: 'No tab open', status: 'open', stage: 'plan_complete' },
    ]);
    const listTabs = vi.fn(async (): Promise<HydratorTab[]> => [
      { tab_id: 'w1:t1', label: ITEM, workspace_id: 'w1' },
    ]);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      applyActiveTabMarkers: (items) => applyTabMarkersToItems(items, listTabs, 'w1'),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).toContain(OTHER_ITEM);
    expect(output).toContain(OPEN_ICON);
    expect(output).not.toContain(IN_PROGRESS_ICON);

    await quit(p);
  });

  it('does not mark an item whose tab is in another workspace', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    setExecFileAsync(makeExecMock() as any);

    const fetcher = vi.fn(async (): Promise<WorkItem[]> => [
      { id: 'WL-0MV25EE4E0028KDI', title: 'Tab elsewhere', status: 'open', stage: 'plan_complete' },
    ]);
    const listTabs = vi.fn(async (): Promise<HydratorTab[]> => [
      { tab_id: 'w2:t1', label: 'WL-0MV25EE4E0028KDI', workspace_id: 'w2' },
    ]);

    const p = runWorklistTui(fetcher, [], undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
      applyActiveTabMarkers: (items) => applyTabMarkersToItems(items, listTabs, 'w1'),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).toContain(OPEN_ICON);
    expect(output).not.toContain(IN_PROGRESS_ICON);

    await quit(p);
  });
});
