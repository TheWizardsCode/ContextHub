/**
 * packages/herdr/src/worklist-consolidated-refresh.test.ts — TUI-level
 * single-spawn default-view refresh (WL-0MVI0IW8V007DFM6, parent
 * WL-0MVGYLU0S004WZUS).
 *
 * A default-view `doRefresh` tick used to spawn five `wl` processes (four
 * mandatory `wl list` subsets + the `wl next` browse feed) plus a review-queue
 * query that the in-flight memo collapsed into one of them. The consolidated
 * read (WL-0MVI0IT4S0070G78) makes the whole tick ONE `wl worklist` spawn:
 *
 *   - the items come from that read;
 *   - the review-queue banner state derives from the same read (no separate
 *     `wl list --stage in_review` spawn);
 *   - filtered views keep their existing reads;
 *   - a failing consolidated read falls back to the per-subset path instead of
 *     blanking the view.
 *
 * These tests drive the REAL `runWorklistTui` refresh path with the real
 * fetcher and an injected `execFileAsync` seam, so the spawn count is the
 * production one.
 *
 * Run: npx vitest run packages/herdr/src/worklist-consolidated-refresh.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./auto-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auto-sync.js')>();
  return { ...actual, runSync: vi.fn().mockResolvedValue({ success: true }) };
});

vi.mock('./notify.js', () => ({ showToast: vi.fn() }));

import { runWorklistTui, fetchItemsForView } from './worklist.js';
import {
  setExecFileAsync,
  resetExecFileAsync,
  clearFetchMemo,
  fetchNextItems,
  type WorkItem,
} from './fetcher.js';

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
  clearFetchMemo();
  delete process.env.HERDR_PANE_ID;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function quit(p: Promise<unknown>): Promise<void> {
  dataHandler?.(Buffer.from('q'));
  await p;
}

function item(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: `Item ${id}`, status: 'open', priority: 'medium', stage: 'idea', ...extra };
}

/**
 * A consolidated bundle whose review queue is DEEP (25 completed/in_review
 * roots vs the default browseItemCount of 20) and has an outstanding audit, so
 * the banner copy proves the state came from this read.
 */
function bundlePayload(): Record<string, unknown> {
  const reviewQueue = Array.from({ length: 25 }, (_, i) =>
    item(`R-${i}`, { status: 'completed', stage: 'in_review', auditedAt: null }),
  );
  return {
    success: true,
    worklogDir: '/tmp/worklog/.worklog',
    requestedCount: 20,
    subsets: {
      critical: [],
      reviewQueue,
      inProgressRoots: [],
      blockedRoots: [],
      browse: [{ workItem: item('TOP-1'), reason: 'browse' }],
    },
  };
}

/** Exec seam: pane checks are focused; every `wl` call is recorded. */
function makeExecMock(options: { failWorklist?: boolean; fallbackItem?: boolean } = {}) {
  const calls: string[][] = [];
  const mock = vi.fn(async (_bin: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'pane' || args[0] === 'tab') {
      return {
        stdout: JSON.stringify({
          id: 'cli:get',
          result: { pane: { focused: true }, tab: { focused: true } },
        }),
        stderr: '',
      };
    }
    if (args.includes('worklist')) {
      if (options.failWorklist) throw new Error("error: unknown command 'worklist'");
      return { stdout: JSON.stringify(bundlePayload()), stderr: '' };
    }
    if (args.includes('list')) {
      return { stdout: JSON.stringify({ success: true, count: 0, workItems: [] }), stderr: '' };
    }
    if (args.includes('next')) {
      const results = options.fallbackItem
        ? [{ workItem: item('FALLBACK-1'), reason: 'next' }]
        : [];
      return { stdout: JSON.stringify({ success: true, results }), stderr: '' };
    }
    return { stdout: JSON.stringify({ success: true }), stderr: '' };
  });
  const wlCalls = (): string[][] => calls.filter((c) => c[0] !== 'pane' && c[0] !== 'tab');
  /**
   * Spawns that fetch *worklist data* — the browse feed or a mandatory subset.
   * Excludes unrelated reads in the same tick (e.g. the actionable-count
   * fallback `list --status open,in-progress,blocked`, which is a separate
   * concern and zero-spawn whenever an in-process DB is available).
   */
  const worklistDataSpawns = (from = 0): string[][] =>
    wlCalls().slice(from).filter((c) => {
      if (c.includes('worklist') || c.includes('next')) return true;
      return (
        c.includes('list') &&
        (c.includes('--priority') || c.includes('--stage') || c.includes('--root-only'))
      );
    });
  return { mock, wlCalls, worklistDataSpawns };
}

describe('default-view refresh: one consolidated wl read per tick', () => {
  it('issues exactly one wl spawn (worklist) for a default-view refresh tick', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const { mock, wlCalls, worklistDataSpawns } = makeExecMock();
    setExecFileAsync(mock as any);

    // Production default fetcher: a closure over the browse-item count
    // (index.ts passes `() => fetchNextItems(browseItemCount)`).
    const p = runWorklistTui(() => fetchNextItems(20), undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const baseline = wlCalls().length; // ignore the startup fetch

    await vi.advanceTimersByTimeAsync(30_000);

    const tickSpawns = worklistDataSpawns(baseline);
    expect(tickSpawns.map((c) => c.join(' '))).toHaveLength(1);
    expect(tickSpawns[0]).toContain('worklist');
    const tokens = tickSpawns.flat();
    expect(tokens).not.toContain('next');
    expect(tokens).not.toContain('list');

    await quit(p);
  });

  it('derives the review-queue banner state from the same read (no second spawn)', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const { mock, wlCalls, worklistDataSpawns } = makeExecMock();
    setExecFileAsync(mock as any);

    const p = runWorklistTui(() => fetchNextItems(20), undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const baseline = wlCalls().length;

    writes.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);

    // The banner copy can only come from the bundle's deep, un-audited review
    // queue — and the tick above still spawned exactly one `wl`.
    const output = writes.join('');
    expect(output).toContain('Review queue deep');
    expect(output).toContain('focus on audits');
    expect(worklistDataSpawns(baseline)).toHaveLength(1);

    await quit(p);
  });

  it('shows the per-subset fallback result when the consolidated read fails', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'w1:pCM';
    // Per-subset fallback: the consolidated read is unavailable, so `wl next`
    // + the mandatory `wl list` subsets must still populate the view.
    const { mock, wlCalls } = makeExecMock({ failWorklist: true, fallbackItem: true });
    setExecFileAsync(mock as any);

    const p = runWorklistTui(() => fetchNextItems(20), undefined, undefined, {
      autoRefresh: true,
      refreshIntervalMs: 30_000,
      autoSync: false,
      showHelpText: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    writes.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);

    // The fallback path ran (worklist attempted, then `next` + list subsets)
    // and the view still shows the item instead of blanking.
    const spawns = wlCalls();
    expect(spawns.some((c) => c.includes('worklist'))).toBe(true);
    expect(spawns.some((c) => c.includes('next'))).toBe(true);
    expect(writes.join('')).toContain('Item FALLBACK-1');

    await quit(p);
  });
});

describe('filtered views keep their existing reads', () => {
  it('stage and priority filters do not use the consolidated read', async () => {
    const { mock, wlCalls } = makeExecMock();
    setExecFileAsync(mock as any);
    const defaultFetcher = vi.fn(async () => [{ id: 'DEFAULT' } as WorkItem]);

    const staged = await fetchItemsForView('plan_complete', null, defaultFetcher, false, '/tmp');
    const priority = await fetchItemsForView(null, 'high', defaultFetcher, false, '/tmp');

    expect(staged).toEqual([]);
    expect(priority).toEqual([]);
    const commands = wlCalls().map((c) => c.join(' '));
    expect(commands.some((c) => c.includes('list') && c.includes('--stage'))).toBe(true);
    expect(commands.some((c) => c.includes('list') && c.includes('--priority'))).toBe(true);
    expect(commands.some((c) => c.includes('worklist'))).toBe(false);
    // The filtered paths do not fall back to the default fetcher on success.
    expect(defaultFetcher).not.toHaveBeenCalled();
  });

  it('the recent-dispatches view still merges live items from the default fetcher', async () => {
    const defaultFetcher = vi.fn(async () => [{ id: 'LIVE' } as WorkItem]);

    // No dispatch log in an empty cwd → log rows are empty, but the live
    // fetcher must still have been consulted (its failure fallback is what
    // keeps the view populated).
    const items = await fetchItemsForView(null, null, defaultFetcher, true, '/tmp/does-not-exist-wl-dispatch');
    expect(defaultFetcher).toHaveBeenCalledTimes(1);
    expect(Array.isArray(items)).toBe(true);
  });
});
