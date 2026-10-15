/**
 * packages/herdr/src/worklist-blocked-by-cache.test.ts — Regression tests
 * for the `Blocked By` metadata-line flicker fix (WL-0MV8Q5X8U004KKAP).
 *
 * Root cause: `resolveMetaBlockers` implemented two live render states for a
 * blocked item (async `wl dep list` lookup pending → no `Blocked By` rows;
 * resolved → rows), and `doRefresh` cleared the per-item `blockerCache` on
 * EVERY list refresh. Every refresh therefore re-entered the unresolved
 * frame for a full lookup (~0.5–2 s) before the `.finally(render())` flipped
 * it back — an endless on/off flicker under the frequent refresh traffic of
 * a live workspace (DB-change watch, auto-sync counter bumps, `wl next`
 * re-sorts).
 *
 * The fix: the blocker cache SURVIVES refreshes. Entries are reused while the
 * item's payload signature (status/stage/updatedAt) is unchanged, the
 * in-flight lookup is memoised per item (single-flight), and while a
 * re-resolve is in flight the last known value is still served
 * (stale-while-revalidate) — so a stable selection shows exactly ONE
 * unresolved→resolved transition, and refresh cycles never spawn a duplicate
 * `wl dep list` nor blank the panel.
 *
 * These tests drive the real TUI (`runWorklistTui`) with a mock that replaces
 * `fetchBlockersForItem` and a fake DB-change watch (the same event source
 * the RCA identifies as the flicker cadence driver), then inspect the
 * rendered frames + spawn count.
 *
 * Run: npx vitest run packages/herdr/src/worklist-blocked-by-cache.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mock } from 'vitest';

vi.mock('./auto-sync.js', () => ({
  runSync: vi.fn().mockResolvedValue({ success: true }),
  createSyncTimer: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  clampSyncInterval: vi.fn((v: number) => v),
}));

vi.mock('./notify.js', () => ({
  showToast: vi.fn(),
}));

// Replace the fetcher's blocker/aux lookups with controllable mocks; keep the
// rest of the fetcher real (setWorklogDir / exec seam stay functional).
vi.mock('./fetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fetcher.js')>();
  return {
    ...actual,
    fetchActionableCount: vi.fn().mockResolvedValue(0),
    fetchReviewQueueState: vi.fn().mockResolvedValue(undefined),
    fetchChildrenForItem: vi.fn().mockResolvedValue([]),
    fetchChildrenForItems: vi.fn().mockResolvedValue(new Map()),
    fetchBlockersForItem: vi.fn(),
  };
});

import { runWorklistTui, formatDetailContent, formatTooltipLines, ANSI } from './worklist.js';
import { fetchBlockersForItem, setWorklogDir, resetWorklogDir, type WorkItem } from './fetcher.js';
import { setLogPath, resetLogPath } from './command-log.js';
import { loadShortcutConfig } from './shortcut-config.js';

const blockerMock = vi.mocked(fetchBlockersForItem);

// ---------------------------------------------------------------------------
// Fake stdin/stdout harness (same pattern as worklist-integration.test.ts)
// ---------------------------------------------------------------------------

let dataHandler: ((chunk: Buffer) => void) | undefined;
let writes: string[];
let tmpDir: string;
/** Captured DB-change onChange callback (the flicker cadence source). */
let watchChange: (() => void) | undefined;

/** Fake DB-change watch: captures the onChange callback the TUI registers. */
function fakeDbWatch(
  _cacheDir: string,
  _worklogDir: string,
  onChange: () => void,
): { active: boolean; dispose: Mock; close: Mock } {
  watchChange = onChange;
  return { active: true, dispose: vi.fn(), close: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  blockerMock.mockReset();
  watchChange = undefined;
  dataHandler = undefined;
  writes = [];
  setLogPath(join(tmpdir(), `herdr-blkcache-cmdlog-${process.pid}-${Date.now()}.json`));
  tmpDir = mkdtempSync(join(tmpdir(), 'herdr-blkcache-'));
  setWorklogDir(tmpDir);

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
  resetWorklogDir();
  resetLogPath();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Small async tick helper so awaited promises settle. */
function settle(ms = 15): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeItem(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return { id, title: `Item ${id}`, status: 'open', updatedAt: '2026-01-01T00:00:00.000Z', ...over };
}

/** The blocked-by fixture: a dependency-blocked item, selected by default. */
function blockedItem(over: Partial<WorkItem> = {}): WorkItem {
  return makeItem('WL-BLOCKED', { status: 'blocked', ...over });
}

/**
 * Start the real TUI with a mutable item feed and the fake DB-change watch.
 * `onWatch()` (below) triggers one `doRefresh` the same way the production
 * `db-change.ts` watch does.
 */
function startTui(items: WorkItem[]): { tui: Promise<WorkItem | undefined>; feed: { items: WorkItem[] } } {
  const feed = { items };
  const tui = runWorklistTui(
    async () => feed.items,
    feed.items,
    loadShortcutConfig(),
    {
      autoRefresh: true,
      refreshIntervalMs: 3_600_000, // effectively never fires; dbWatch drives refreshes
      autoSync: false,
      showHelpText: false,
      dbWatch: fakeDbWatch as any,
    },
  );
  return { tui, feed };
}

/** Trigger one DB-change-watch refresh (the flicker cadence source). */
async function watchRefresh(): Promise<void> {
  expect(watchChange).toBeDefined();
  watchChange!();
  await settle();
}

/** Quit the TUI and await its promise (cleans up timers/listeners). */
async function quit(tui: Promise<WorkItem | undefined>): Promise<void> {
  dataHandler?.(Buffer.from('q'));
  await tui.catch(() => undefined);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Reconstruct complete render frames from the raw stdout writes. Each render
 * writes `ANSI.clear` + `ANSI.cursorHome` + body; splitting the concatenated
 * stream on `ANSI.clear` yields one segment per render. Only list-mode frames
 * with the `Work Items` header are kept (excludes, e.g., form overlays).
 */
function frames(): string[] {
  return writes
    .join('')
    .split(ANSI.clear)
    .map((seg) => stripAnsi(seg.replace(/^\x1b\[H/, '')))
    .filter((seg) => seg.includes('Work Items'));
}

// ---------------------------------------------------------------------------
// AC1/AC2/AC3: stable frames, single spawn, one transition per selection
// ---------------------------------------------------------------------------

describe('Blocked By flicker fix (WL-0MV8Q5X8U004KKAP)', () => {
  it('keeps the Blocked By line present across repeated refresh triggers, spawning the lookup once', async () => {
    blockerMock.mockResolvedValue([{ id: 'WL-B1', title: 'First blocker' }]);
    const { tui, feed } = startTui([blockedItem(), makeItem('WL-OTHER')]);
    try {
      // Initial render + resolution (one unresolved→resolved transition).
      await settle();
      await vi.waitFor(() => expect(blockerMock).toHaveBeenCalledTimes(1));
      expect(blockerMock).toHaveBeenCalledWith('WL-BLOCKED');

      // Capture the frame set once resolved.
      await vi.waitFor(() => expect(frames().some((f) => f.includes('Blocked By'))).toBe(true));
      const allFrames = frames();
      const resolvedIdx = allFrames.findIndex((f) => f.includes('Blocked By'));
      expect(resolvedIdx).toBeGreaterThan(-1);

      // Three consecutive refresh cycles (DB-change watch) with the DB
      // otherwise idle: the line must stay put and the lookup must NOT re-run.
      for (let i = 0; i < 3; i += 1) {
        await watchRefresh();
      }
      expect(blockerMock).toHaveBeenCalledTimes(1);

      // Every frame AFTER the resolved one still carries the line: once
      // resolved, no refresh drops it (exactly one transition, never an
      // oscillating pair).
      const post = frames();
      for (const f of post.slice(resolvedIdx)) {
        expect(f).toMatch(/Blocked By\s+WL-B1/);
      }
      expect(post.length).toBeGreaterThan(resolvedIdx);

      // The selection survived the refreshes (same item still selected).
      const last = post[post.length - 1];
      expect(last).toContain('WL-BLOCKED');
      expect(feed.items).toHaveLength(2);
    } finally {
      await quit(tui);
    }
  });

  it('single-flights the lookup: concurrent refreshes while a lookup is pending never duplicate the spawn', async () => {
    let resolveLookup!: (v: { id: string; title: string }[]) => void;
    blockerMock.mockImplementationOnce(
      () => new Promise((r) => { resolveLookup = r; }),
    );
    const { tui } = startTui([blockedItem(), makeItem('WL-OTHER')]);
    try {
      await settle();
      // First render started the lookup; it is still pending.
      expect(blockerMock).toHaveBeenCalledTimes(1);

      // Refresh storm while pending: none may spawn a second lookup.
      await watchRefresh();
      await watchRefresh();
      await watchRefresh();
      expect(blockerMock).toHaveBeenCalledTimes(1);

      // Resolve — the cached rows land and the follow-up render shows them
      // (one unresolved→resolved transition).
      resolveLookup([{ id: 'WL-B1', title: 'First blocker' }]);
      await settle();
      await vi.waitFor(() => expect(frames()[frames().length - 1]).toMatch(/Blocked By\s+WL-B1/));
      expect(blockerMock).toHaveBeenCalledTimes(1);
    } finally {
      await quit(tui);
    }
  });

  it('re-resolves only when the item’s own signature changes, serving the stale line while re-resolving', async () => {
    blockerMock
      .mockResolvedValueOnce([{ id: 'WL-B1', title: 'First blocker' }])
      .mockResolvedValueOnce([{ id: 'WL-B2', title: 'Second blocker' }]);
    const { tui, feed } = startTui([blockedItem(), makeItem('WL-OTHER')]);
    try {
      await settle();
      await vi.waitFor(() => expect(blockerMock).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(frames()[frames().length - 1]).toMatch(/Blocked By\s+WL-B1/));

      // A refresh that leaves the payload untouched (same status/stage/
      // updatedAt) reuses the cache — no new spawn.
      await watchRefresh();
      expect(blockerMock).toHaveBeenCalledTimes(1);

      // A refresh where the item CHANGED (e.g. a dependency write bumped
      // updatedAt) invalidates only that entry and re-resolves once.
      feed.items = [
        blockedItem({ updatedAt: '2026-01-02T00:00:00.000Z' }),
        makeItem('WL-OTHER'),
      ];
      await watchRefresh();
      await vi.waitFor(() => expect(blockerMock).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(frames()[frames().length - 1]).toMatch(/Blocked By\s+WL-B2/));
    } finally {
      await quit(tui);
    }
  });

  it('fail-open: a rejected lookup yields no rows and never breaks rendering', async () => {
    blockerMock.mockRejectedValue(new Error('wl exploded'));
    const { tui } = startTui([blockedItem(), makeItem('WL-OTHER')]);
    try {
      await settle();
      await watchRefresh();
      await vi.waitFor(() => {
        const post = frames();
        expect(post[post.length - 1]).toContain('WL-BLOCKED');
      });
      const post = frames();
      expect(post[post.length - 1]).not.toContain('Blocked By');
    } finally {
      await quit(tui);
    }
  });

  it('unblocked selections render byte-for-byte without Blocked By rows across refreshes', async () => {
    blockerMock.mockResolvedValue([]);
    const { tui } = startTui([makeItem('WL-PLAIN'), makeItem('WL-OTHER')]);
    try {
      await settle();
      await watchRefresh();
      await watchRefresh();
      const post = frames();
      for (const f of post) {
        expect(f).not.toContain('Blocked By');
      }
    } finally {
      await quit(tui);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5: detail-view/tooltip parity decision (documented out of scope)
// ---------------------------------------------------------------------------

describe('detail-view/tooltip parity decision (WL-0MV8Q5X8U004KKAP AC-5)', () => {
  it('formatDetailContent omits Blocked By (documented divergence; metadata panel is canonical)', () => {
    const item = blockedItem();
    const lines = formatDetailContent(item, 80).join('\n');
    expect(lines).toContain(item.id);
    // Pins the documented-out-of-scope decision: the detail view does NOT
    // render the list metadata panel's Blocked By rows (see the NOTE on the
    // function). If parity is later implemented, this test must flip.
    expect(lines).not.toContain('Blocked By');
  });

  it('formatTooltipLines omits Blocked By (documented divergence)', () => {
    const lines = formatTooltipLines(blockedItem(), '!!wl dep add', undefined, 80);
    expect(lines.join('\n')).not.toContain('Blocked By');
  });
});
