/**
 * packages/herdr/src/worklist-nested-expand.test.ts — TUI-level tests for
 * expanding second-level (and deeper) children in the Herdr worklist
 * (WL-0MSQ3FH1K000MMJW).
 *
 * Before the fix, Tab/Enter only toggled TOP-LEVEL items: the select and
 * toggle-expand handlers gated expansion on `depth === undefined`, and
 * getFlattenedItems() never recursed past one level, so grandchildren were
 * unreachable from the worklist UI. These tests drive the real
 * `runWorklistTui` with a production-shaped fetcher/exec mock and assert:
 *
 *  1. Tab on a child (depth ≥ 1) with childCount > 0 fetches ITS children
 *     on demand via `wl list --parent <child-id>` and renders them inline.
 *  2. The fetched grandchildren carry the correct depth (parent depth + 1).
 *  3. Collapsing the child removes the grandchildren from the list.
 *  4. Nested expanded state survives the auto-refresh cycle.
 *
 * Run: npx vitest run packages/herdr/src/worklist-nested-expand.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before worklist.js is imported)
// ---------------------------------------------------------------------------
// Keep the REAL fetcher + visibility modules (so the exec seam and PollGate
// run for real) but avoid real `wl`/`herdr` process spawns by injecting a
// mock execFileAsync via setExecFileAsync() in each test.

vi.mock('./auto-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auto-sync.js')>();
  return {
    ...actual,
    // Keep the real scheduler/sync plumbing but stub runSync so no real
    // `wl sync` is spawned.
    runSync: vi.fn().mockResolvedValue({ success: true }),
  };
});

vi.mock('./notify.js', () => ({
  showToast: vi.fn(),
}));

import { runWorklistTui } from './worklist.js';
import { setExecFileAsync, resetExecFileAsync } from './fetcher.js';
import type { WorkItem } from './fetcher.js';

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as worklist-expand-refresh.test.ts)
// ---------------------------------------------------------------------------

let dataHandler: ((chunk: Buffer) => void) | undefined;
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
  resetExecFileAsync();
  delete process.env.HERDR_PANE_ID;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Quit the TUI and await its promise (cleans up timers/listeners). */
async function quit(p: Promise<unknown>): Promise<void> {
  dataHandler?.(Buffer.from('q'));
  await p;
}

/**
 * Build a production-shaped work item: no `children` array unless given
 * (normalizeItem never populates it), childCount present, depth set for
 * fetched children.
 */
function makeItem(id: string, depth: number | undefined, childCount: number, children?: WorkItem[]): WorkItem {
  return {
    id,
    title: `Item ${id}`,
    status: 'open',
    ...(depth !== undefined ? { depth } : {}),
    ...(childCount > 0 ? { childCount } : {}),
    ...(children ? { children } : {}),
  };
}

/**
 * Exec-mock helper: visible pane (focused=true) so auto-refresh ticks fire.
 * `wl list --parent P` returns the top-level parent's children (FEATURE
 * with childCount 2); `wl list --parent FEATURE` returns its grandchildren
 * (TASK-1, TASK-2). Records every --parent fetch so tests can assert the
 * on-demand fetch target and depth.
 */
function makeNestedExecMock(): { mock: Mock; parentFetches: Array<{ parentId: string }> } {
  const parentFetches: Array<{ parentId: string }> = [];
  const mock = vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'herdr' && args[0] === 'pane' && args[1] === 'get') {
      return {
        stdout: JSON.stringify({
          id: 'cli:pane:get',
          result: { pane: { focused: true } },
        }),
        stderr: '',
      };
    }
    const parentIdx = args.indexOf('--parent');
    if (args.includes('list') && parentIdx >= 0) {
      const parentId = args[parentIdx + 1];
      parentFetches.push({ parentId });
      if (parentId === 'P') {
        return {
          stdout: JSON.stringify({
            workItems: [makeItem('FEATURE', 1, 2), makeItem('FEATURE-2', 1, 0)],
          }),
          stderr: '',
        };
      }
      if (parentId === 'FEATURE') {
        return {
          stdout: JSON.stringify({
            workItems: [makeItem('TASK-1', 2, 0), makeItem('TASK-2', 2, 0)],
          }),
          stderr: '',
        };
      }
      return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
    }
    if (args.includes('list') && args.includes('--status')) {
      return { stdout: JSON.stringify({ count: 5 }), stderr: '' };
    }
    return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
  });
  return { mock, parentFetches };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('nested expansion (WL-0MSQ3FH1K000MMJW)', () => {
  it('Tab on a child fetches its grandchildren on demand and renders them at depth 2', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const { mock, parentFetches } = makeNestedExecMock();
    setExecFileAsync(mock as any);

    const fetcher = vi.fn().mockResolvedValue([makeItem('P', undefined, 1)]);
    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Tab on P: fetch FEATURE (depth 1) on demand and expand P.
    dataHandler?.(Buffer.from('\t'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.join('')).toContain('FEATURE');
    expect(parentFetches).toEqual([{ parentId: 'P' }]);

    // Select FEATURE with ↓: the first ↓ lands on the group heading row
    // (FEATURE carries an "Other" group stamp from regroupWorkItems while P
    // has none, so a heading row is interleaved — selectable per
    // WL-0MSL5MPSZ003TG94 AC2), the second ↓ lands on FEATURE.
    writes.length = 0;
    dataHandler?.(Buffer.from('j'));
    await vi.advanceTimersByTimeAsync(0);
    dataHandler?.(Buffer.from('j'));
    await vi.advanceTimersByTimeAsync(0);

    // Tab on FEATURE: fetch grandchildren (TASK-1, TASK-2) on demand.
    dataHandler?.(Buffer.from('\t'));
    await vi.advanceTimersByTimeAsync(0);

    expect(parentFetches).toEqual([{ parentId: 'P' }, { parentId: 'FEATURE' }]);
    const output = writes.join('');
    expect(output).toContain('TASK-1');
    expect(output).toContain('TASK-2');

    await quit(p);
  });

  it('collapsing the child removes the grandchildren from the list', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeNestedExecMock().mock as any);

    const fetcher = vi.fn().mockResolvedValue([makeItem('P', undefined, 1)]);
    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Expand P, move to FEATURE (↓ lands on the group heading first —
    // headings are selectable rows per WL-0MSL5MPSZ003TG94 AC2), expand
    // FEATURE.
    dataHandler?.(Buffer.from('\t'));
    await vi.advanceTimersByTimeAsync(0);
    dataHandler?.(Buffer.from('j'));
    await vi.advanceTimersByTimeAsync(0);
    dataHandler?.(Buffer.from('j'));
    await vi.advanceTimersByTimeAsync(0);
    dataHandler?.(Buffer.from('\t'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.join('')).toContain('TASK-1');

    // Tab on FEATURE again → collapse → grandchildren gone.
    writes.length = 0;
    dataHandler?.(Buffer.from('\t'));
    await vi.advanceTimersByTimeAsync(0);
    const collapsedOutput = writes.join('');
    expect(collapsedOutput).not.toContain('TASK-1');
    expect(collapsedOutput).not.toContain('TASK-2');
    expect(collapsedOutput).toContain('FEATURE');

    await quit(p);
  });

  it('nested expanded state survives the auto-refresh cycle', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const { mock } = makeNestedExecMock();
    setExecFileAsync(mock as any);

    // Startup fetch returns P; the refresh tick returns a NEW P object
    // (fresh title) — production fetcher shape (children-less).
    const fetcher = vi.fn()
      .mockResolvedValueOnce([makeItem('P', undefined, 1)])
      .mockResolvedValueOnce([{ ...makeItem('P', undefined, 1), title: 'P (refreshed)' }]);

    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // Expand P → FEATURE, then FEATURE → TASK-1/TASK-2. The ↓ keys pass
    // through the interleaved heading row (selectable per
    // WL-0MSL5MPSZ003TG94 AC2).
    dataHandler?.(Buffer.from('\t'));
    await vi.advanceTimersByTimeAsync(0);
    dataHandler?.(Buffer.from('j'));
    await vi.advanceTimersByTimeAsync(0);
    dataHandler?.(Buffer.from('j'));
    await vi.advanceTimersByTimeAsync(0);
    dataHandler?.(Buffer.from('\t'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.join('')).toContain('TASK-1');

    // Auto-refresh tick: the refreshed P must keep FEATURE expanded with
    // its grandchildren visible — no re-collapse (AC-4).
    writes.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).toContain('P (refreshed)');
    expect(output).toContain('FEATURE');
    expect(output).toContain('TASK-1');
    expect(output).toContain('TASK-2');

    await quit(p);
  });

  it('Enter on a child with children toggles expansion instead of opening the detail view', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeNestedExecMock().mock as any);

    const fetcher = vi.fn().mockResolvedValue([makeItem('P', undefined, 1)]);
    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Expand P with Tab (fetches FEATURE), select FEATURE (↓ lands on the
    // interleaved heading row first — selectable per WL-0MSL5MPSZ003TG94
    // AC2), then Tab-expand FEATURE so its grandchildren are loaded.
    dataHandler?.(Buffer.from('\t'));
    await vi.advanceTimersByTimeAsync(0);
    dataHandler?.(Buffer.from('j'));
    await vi.advanceTimersByTimeAsync(0);
    dataHandler?.(Buffer.from('j'));
    await vi.advanceTimersByTimeAsync(0);
    dataHandler?.(Buffer.from('\t'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.join('')).toContain('TASK-1');

    // Enter on FEATURE (children now loaded): toggles collapse — the detail
    // view must NOT open (matching top-level Enter behavior).
    writes.length = 0;
    dataHandler?.(Buffer.from('\r'));
    await vi.advanceTimersByTimeAsync(0);
    const output = writes.join('');
    expect(output).not.toContain('TASK-1');
    expect(output).not.toContain('TASK-2');
    expect(output).toContain('FEATURE');

    await quit(p);
  });
});
