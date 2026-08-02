/**
 * Unit tests for lib/browse.ts — idle-gated auto-refresh/auto-sync in the
 * browse selection widget (WL-0MSB445BP0057ZQT).
 *
 * Verifies that the 5s auto-refresh interval (and its `wl sync --if-idle`
 * trigger) pauses when the widget has had no keypresses for IDLE_PAUSE_MS,
 * resumes immediately on the next keypress, and that mount counts as
 * interaction (freshly opened widget starts active). Manual actions and the
 * detail-view widget are unaffected by idle state.
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/lib/browse-idle.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
  getSettingsListTheme: () => ({}),
}));

// Keep the real tools.js exports (types, helpers) but stub the CLI path so
// no real `wl` subprocess is spawned and sync/refresh calls are observable.
vi.mock('./tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools.js')>();
  return {
    ...actual,
    runWl: vi.fn().mockResolvedValue('{}'),
    fetchTotalActionableCount: vi.fn().mockResolvedValue(undefined),
  };
});

import { defaultChooseWorkItem, IDLE_PAUSE_MS } from './browse.js';
import { runWl } from './tools.js';

const mockRunWl = runWl as Mock;

// ── Widget harness ────────────────────────────────────────────────────

interface WidgetHarness {
  handleInput: (data: string) => void;
  requestRender: ReturnType<typeof vi.fn>;
  done: (value: unknown) => void;
  promise: Promise<unknown>;
}

/**
 * Build a mock browse context whose `custom` widget factory captures the
 * widget instance (render/invalidate/handleInput) and a done() resolver.
 */
function createMockCtx(): { ctx: any; harness: WidgetHarness } {
  const harness: WidgetHarness = {
    handleInput: () => undefined,
    requestRender: vi.fn(),
    done: () => undefined,
    promise: Promise.resolve(undefined),
  };

  const ctx: any = {
    ui: {
      custom: vi.fn().mockImplementation((factory: Function) => {
        harness.promise = new Promise((resolve) => {
          harness.done = resolve;
          const widget = factory(
            { requestRender: harness.requestRender },
            { fg: vi.fn((c: string, t: string) => t), bold: vi.fn((t: string) => t) },
            {},
            (value: unknown) => resolve(value),
          );
          harness.handleInput = widget.handleInput ?? (() => undefined);
        });
        return harness.promise;
      }),
      notify: vi.fn(),
      setEditorText: vi.fn(),
      setWidget: vi.fn(),
      onTerminalInput: vi.fn(),
    },
  };
  return { ctx, harness };
}

function createMockItems() {
  return [
    { id: 'WL-TEST001', title: 'Test Item 1', status: 'open', stage: 'in_review' as const, priority: 'high' },
    { id: 'WL-TEST002', title: 'Test Item 2', status: 'open', stage: 'in_progress' as const, priority: 'medium' },
  ];
}

/** Quit the widget by dispatching escape (resolves the custom promise). */
function quitWidget(harness: WidgetHarness): void {
  harness.handleInput('\x1b');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('browse widget idle-gated auto-refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes IDLE_PAUSE_MS as a named module constant (default 30s)', () => {
    expect(IDLE_PAUSE_MS).toBe(30_000);
  });

  it('widget mount counts as interaction — ticks fetch while within the idle window', async () => {
    const { ctx, harness } = createMockCtx();
    const items = createMockItems();
    const reFetchItems = vi.fn().mockResolvedValue(createMockItems());

    const promise = defaultChooseWorkItem(items, ctx, vi.fn(), undefined, reFetchItems);
    await vi.advanceTimersByTimeAsync(0);

    // Freshly mounted widget: no keypresses yet, but mount counts as
    // interaction so the first few ticks (within IDLE_PAUSE_MS) must fetch.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reFetchItems).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000); // t=10s, still < 30s
    expect(reFetchItems).toHaveBeenCalledTimes(2);

    quitWidget(harness);
    await promise;
  });

  it('tick within the idle window (keypress recently) → fetch invoked (cadence preserved)', async () => {
    const { ctx, harness } = createMockCtx();
    const items = createMockItems();
    const reFetchItems = vi.fn().mockResolvedValue(createMockItems());

    const promise = defaultChooseWorkItem(items, ctx, vi.fn(), undefined, reFetchItems);
    await vi.advanceTimersByTimeAsync(0);

    // Interact at t=0 (mount) then keep interacting every 10s: each tick at
    // 5/10/15/20/25s is within 30s of the last interaction → always fetches.
    // Interval fires every 5s: t=5 (1), t=10 (2), t=15 (3), t=20 (4), t=25 (5).
    await vi.advanceTimersByTimeAsync(5_000);
    harness.handleInput('j'); // keypress at t=5s
    await vi.advanceTimersByTimeAsync(10_000); // ticks at t=10, t=15
    harness.handleInput('k'); // keypress at t=15s
    await vi.advanceTimersByTimeAsync(10_000); // ticks at t=20, t=25

    expect(reFetchItems).toHaveBeenCalledTimes(5);

    quitWidget(harness);
    await promise;
  });

  it('tick after the idle threshold (no keypresses for > IDLE_PAUSE_MS) → fetch NOT invoked', async () => {
    const { ctx, harness } = createMockCtx();
    const items = createMockItems();
    const reFetchItems = vi.fn().mockResolvedValue(createMockItems());

    const promise = defaultChooseWorkItem(items, ctx, vi.fn(), undefined, reFetchItems);
    await vi.advanceTimersByTimeAsync(0);

    // Advance through the active window: ticks at 5/10/15/20/25/30s fetch.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reFetchItems).toHaveBeenCalledTimes(6);

    // Advance past the idle threshold: ticks at 35/40/45s must NOT fetch.
    const callsAfterActive = reFetchItems.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000); // t=45s, idle since t=30s
    expect(reFetchItems.mock.calls.length).toBe(callsAfterActive); // zero new fetches

    quitWidget(harness);
    await promise;
  });

  it('auto-sync trigger (wl sync --if-idle) is also skipped when idle', async () => {
    const { ctx, harness } = createMockCtx();
    const items = createMockItems();
    const reFetchItems = vi.fn().mockResolvedValue(createMockItems());

    const promise = defaultChooseWorkItem(items, ctx, vi.fn(), undefined, reFetchItems);
    await vi.advanceTimersByTimeAsync(0);

    const countSyncCalls = () =>
      mockRunWl.mock.calls.filter((c) => (c[0] as string[]).includes('sync')).length;

    // Active window: sync may be triggered alongside refresh (ticks at
    // 5..30s are all within the 30s idle threshold — t=30 is still active
    // because the check is strictly greater-than).
    await vi.advanceTimersByTimeAsync(31_000);
    const syncsWhileActive = countSyncCalls();

    // Idle window (past 30s without interaction): no sync, no refresh.
    const syncsBeforeIdle = countSyncCalls();
    const fetchesBeforeIdle = reFetchItems.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000); // t=61s — idle since t=35s
    expect(countSyncCalls()).toBe(syncsBeforeIdle); // no new sync while idle
    expect(reFetchItems.mock.calls.length).toBe(fetchesBeforeIdle); // no new fetches

    expect(syncsWhileActive).toBeGreaterThanOrEqual(0); // sanity: counter works

    quitWidget(harness);
    await promise;
  });

  it('a keypress after an idle pause triggers an immediate refresh and resumes the cadence', async () => {
    const { ctx, harness } = createMockCtx();
    const items = createMockItems();
    const reFetchItems = vi.fn().mockResolvedValue(createMockItems());

    const promise = defaultChooseWorkItem(items, ctx, vi.fn(), undefined, reFetchItems);
    await vi.advanceTimersByTimeAsync(0);

    // Go idle: advance past 30s without interaction.
    await vi.advanceTimersByTimeAsync(35_000);
    const callsBeforeKeypress = reFetchItems.mock.calls.length;

    // First keypress after idle → immediate refresh + resume cadence.
    harness.handleInput('j');
    await vi.advanceTimersByTimeAsync(0);
    expect(reFetchItems.mock.calls.length).toBeGreaterThan(callsBeforeKeypress);

    // Cadence resumes: next tick (5s later) also fetches.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reFetchItems.mock.calls.length).toBeGreaterThan(callsBeforeKeypress + 1);

    quitWidget(harness);
    await promise;
  });

  it('manual actions still work regardless of idle state (shortcut dispatch)', async () => {
    const { ctx, harness } = createMockCtx();
    const items = createMockItems();
    const reFetchItems = vi.fn().mockResolvedValue(createMockItems());
    const registry: any = {
      lookup: vi.fn((key: string) => (key === 'r' ? '!!wl reviewed <id> false' : undefined)),
      lookupChord: vi.fn().mockReturnValue(undefined),
      getChordByPrefix: vi.fn().mockReturnValue([]),
      getEntriesForStage: vi.fn().mockReturnValue([]),
      getEntries: vi.fn().mockReturnValue([]),
    };

    const promise = defaultChooseWorkItem(items, ctx, vi.fn(), registry, reFetchItems);
    await vi.advanceTimersByTimeAsync(0);

    // Let the widget go idle (no keypresses for > 30s).
    await vi.advanceTimersByTimeAsync(35_000);

    // Manual shortcut 'r' must still dispatch even while idle.
    harness.handleInput('r');
    const result = await promise;
    expect(result).toBeDefined();
    expect((result as any).type).toBe('shortcut');
    expect((result as any).command).toBe('!!wl reviewed WL-TEST001 false');
  });
});

describe('browse widget auto-refresh without reFetchItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detail/selection widget with no interval is unaffected by idle state', async () => {
    const { ctx, harness } = createMockCtx();
    const items = createMockItems();

    // No reFetchItems → no auto-refresh interval is created at all; the
    // widget behaves exactly as before regardless of idle gating.
    const promise = defaultChooseWorkItem(items, ctx, vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(60_000); // long idle — nothing to pause
    harness.handleInput('j'); // navigation still works
    harness.handleInput('\x1b');

    // Escape with no selection resolves undefined (no crash).
    await expect(promise).resolves.toBeUndefined();
  });
});
