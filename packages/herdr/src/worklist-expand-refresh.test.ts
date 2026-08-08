/**
 * packages/herdr/src/worklist-expand-refresh.test.ts — TUI-level tests for
 * expanded items surviving a list refresh without collapsing
 * (WL-0MSBVBNGH002RDP5).
 *
 * The production fetcher returns fresh top-level item objects that never
 * carry a `children` array (normalizeItem drops it). Before the fix, a
 * refresh swapped those objects in and only re-fetched children afterwards,
 * so any render that fired in that window showed every expanded parent
 * collapsed (the "momentary collapse" flicker). These tests drive the real
 * `runWorklistTui` refresh path (auto-refresh timer tick) with
 * production-shaped fetcher responses and assert the expanded children stay
 * visible at every point of the refresh cycle.
 *
 * Run: npx vitest run packages/herdr/src/worklist-expand-refresh.test.ts
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
// Fake stdin/stdout harness (same pattern as worklist-inflight.test.ts)
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
 * Build a minimal child work item (fetcher-style, no nested children).
 */
function makeChild(id: string): WorkItem {
  return { id, title: `Child ${id}`, status: 'open' };
}

/**
 * Production-shaped top-level item: childCount present, NO `children` array
 * (normalizeItem never populates it).
 */
function makeTopLevel(id: string, title: string, childCount: number): WorkItem {
  return { id, title, status: 'open', childCount };
}

/**
 * Exec-mock helper: visible pane (focused=true) so auto-refresh ticks fire,
 * `wl list --parent` returns the expanded parent's children, and other wl
 * calls are benign.
 */
function makeChildrenExecMock(): Mock {
  return vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'herdr' && args[0] === 'pane' && args[1] === 'get') {
      return {
        stdout: JSON.stringify({
          id: 'cli:pane:get',
          result: { pane: { focused: true } },
        }),
        stderr: '',
      };
    }
    if (args.includes('list') && args.includes('--parent')) {
      return {
        stdout: JSON.stringify({
          workItems: [makeChild('C1'), makeChild('C2')],
        }),
        stderr: '',
      };
    }
    if (args.includes('list') && args.includes('--status')) {
      return { stdout: JSON.stringify({ count: 5 }), stderr: '' };
    }
    return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worklist expand-across-refresh (WL-0MSBVBNGH002RDP5)', () => {
  it('auto-refresh keeps expanded children visible — production fetcher shape (children-less objects)', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    setExecFileAsync(makeChildrenExecMock() as any);

    // Startup fetch returns the parent; the refresh tick returns a NEW parent
    // object (fresh title) that again lacks `children`.
    const fetcher = vi.fn()
      .mockResolvedValueOnce([makeTopLevel('P', 'Parent', 2)])
      .mockResolvedValueOnce([makeTopLevel('P', 'Parent (refreshed)', 2)]);

    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    fetcher.mockClear();

    // Expand the parent with Tab: children fetched on demand and shown.
    dataHandler?.(Buffer.from('\t'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.join('')).toContain('C1');
    expect(writes.join('')).toContain('C2');

    // Auto-refresh tick: the fetcher returns a NEW children-less parent
    // object. The expanded children must remain in the flattened view.
    writes.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);

    const output = writes.join('');
    expect(output).toContain('Parent (refreshed)');
    expect(output).toContain('C1');
    expect(output).toContain('C2');

    await quit(p);
  });

  it('a render fired mid-refresh (children re-fetch pending) keeps expanded children visible', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';

    // The refresh's children re-fetch is deferred so the test can fire a
    // render while the refresh cycle is still awaiting its children call.
    let childFetchCount = 0;
    let resolveDeferredChildren!: () => void;
    const deferredChildren = new Promise<void>((r) => { resolveDeferredChildren = r; });

    setExecFileAsync(vi.fn(async (bin: string, args: string[]) => {
      if (bin === 'herdr' && args[0] === 'pane' && args[1] === 'get') {
        return {
          stdout: JSON.stringify({
            id: 'cli:pane:get',
            result: { pane: { focused: true } },
          }),
          stderr: '',
        };
      }
      if (args.includes('list') && args.includes('--parent')) {
        childFetchCount += 1;
        if (childFetchCount === 1) {
          // Expand-time fetch: immediate.
          return { stdout: JSON.stringify({ workItems: [makeChild('C1'), makeChild('C2')] }), stderr: '' };
        }
        // Refresh-time re-fetch: deferred until the test resolves it.
        await deferredChildren;
        return { stdout: JSON.stringify({ workItems: [makeChild('C1'), makeChild('C2')] }), stderr: '' };
      }
      if (args.includes('list') && args.includes('--status')) {
        return { stdout: JSON.stringify({ count: 5 }), stderr: '' };
      }
      return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
    }) as any);

    const fetcher = vi.fn()
      .mockResolvedValueOnce([makeTopLevel('P', 'Parent', 2)])
      .mockResolvedValueOnce([makeTopLevel('P', 'Parent (refreshed)', 2)]);

    const p = runWorklistTui(fetcher, undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Expand the parent with Tab: children fetched and shown.
    dataHandler?.(Buffer.from('\t'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.join('')).toContain('C1');

    // Auto-refresh tick starts a refresh cycle; the children re-fetch is
    // still pending here (the swap has NOT happened yet).
    writes.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);

    // A render fired mid-refresh (keypress navigation) must still show the
    // expanded children — never a collapsed intermediate frame.
    writes.length = 0;
    dataHandler?.(Buffer.from('j'));
    await vi.advanceTimersByTimeAsync(0);
    const midRefreshOutput = writes.join('');
    expect(midRefreshOutput).toContain('C1');
    expect(midRefreshOutput).toContain('C2');

    // Complete the refresh: children re-fetch resolves, the atomic swap
    // applies, and the expanded view remains with fresh data.
    resolveDeferredChildren();
    await vi.advanceTimersByTimeAsync(0);
    const afterRefreshOutput = writes.join('');
    expect(afterRefreshOutput).toContain('Parent (refreshed)');
    expect(afterRefreshOutput).toContain('C1');
    expect(afterRefreshOutput).toContain('C2');

    await quit(p);
  });
});
