/**
 * packages/herdr/src/pane-close-scheduler.test.ts — Tests for the periodic
 * pane-close reaper scheduling (WL-0MUJW9FFW009008M / WL-0MUJL1NAH0042GOS).
 *
 * The scheduler is pure orchestration over injected `ReaperDeps`, so these
 * tests assert on close-call counts and result summaries without any real
 * herdr/session I/O.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ReaperDeps, PaneStatus } from './pane-close-reaper';
import {
  DEFAULT_PANE_CLOSE_ENABLED,
  DEFAULT_PANE_CLOSE_IDLE_THRESHOLD_MINUTES,
  MIN_PANE_CLOSE_IDLE_THRESHOLD_MINUTES,
  MAX_PANE_CLOSE_IDLE_THRESHOLD_MINUTES,
  clampPaneCloseIdleThresholdMinutes,
  runScheduledPaneClose,
} from './pane-close-scheduler';

const THRESHOLD_MIN = 30;

function pane(overrides: Partial<PaneStatus> = {}): PaneStatus {
  return {
    id: 'pane-001',
    kind: 'plan',
    itemId: 'WL-TEST001',
    title: 'Test pane',
    lastAssistantText: '',
    agentProcessAlive: true,
    idleMs: 0,
    needsProducerReview: false,
    isInvokingPane: false,
    childProcessCount: 0,
    ...overrides,
  };
}

function makeDeps(panes: PaneStatus[]): {
  deps: ReaperDeps;
  closePane: ReturnType<typeof vi.fn>;
  listPanes: ReturnType<typeof vi.fn>;
} {
  const closePane = vi.fn().mockResolvedValue({ success: true });
  const listPanes = vi.fn().mockResolvedValue(panes);
  return {
    closePane,
    listPanes,
    deps: {
      listPanes,
      closePane,
      terminateProcessGroup: vi.fn().mockResolvedValue({ terminated: true }),
    },
  };
}

describe('pane-close defaults and clamps', () => {
  it('is enabled by default with a 30-minute idle threshold', () => {
    expect(DEFAULT_PANE_CLOSE_ENABLED).toBe(true);
    expect(DEFAULT_PANE_CLOSE_IDLE_THRESHOLD_MINUTES).toBe(30);
  });

  it('clamps the threshold into [1, 1440] minutes', () => {
    expect(clampPaneCloseIdleThresholdMinutes(0)).toBe(MIN_PANE_CLOSE_IDLE_THRESHOLD_MINUTES);
    expect(clampPaneCloseIdleThresholdMinutes(-5)).toBe(MIN_PANE_CLOSE_IDLE_THRESHOLD_MINUTES);
    expect(clampPaneCloseIdleThresholdMinutes(2000)).toBe(MAX_PANE_CLOSE_IDLE_THRESHOLD_MINUTES);
    expect(clampPaneCloseIdleThresholdMinutes(45)).toBe(45);
  });

  it('falls back to the default for a non-finite value', () => {
    expect(clampPaneCloseIdleThresholdMinutes(Number.NaN)).toBe(
      DEFAULT_PANE_CLOSE_IDLE_THRESHOLD_MINUTES,
    );
  });
});

describe('runScheduledPaneClose — enabled guard', () => {
  it('makes zero close calls when disabled', async () => {
    const { deps, closePane, listPanes } = makeDeps([
      pane({ lastAssistantText: '</end_session>', agentProcessAlive: false }),
    ]);
    const result = await runScheduledPaneClose(deps, {
      paneCloseEnabled: false,
      paneCloseIdleThresholdMinutes: THRESHOLD_MIN,
    });
    expect(result.enabled).toBe(false);
    expect(closePane).not.toHaveBeenCalled();
    expect(listPanes).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
  });

  it('closes eligible panes when enabled', async () => {
    const { deps, closePane } = makeDeps([
      pane({ id: 'p1', lastAssistantText: '</end_session>', agentProcessAlive: false }),
    ]);
    const result = await runScheduledPaneClose(deps, {
      paneCloseEnabled: true,
      paneCloseIdleThresholdMinutes: THRESHOLD_MIN,
    });
    expect(result.enabled).toBe(true);
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(result.closed).toBe(1);
  });

  it('uses the configured idle threshold', async () => {
    const { deps, closePane } = makeDeps([
      pane({ id: 'p1', agentProcessAlive: true, idleMs: 6 * 60 * 1000 }),
    ]);
    // 5-minute threshold → the 6-minute idle pane is reaped.
    await runScheduledPaneClose(deps, {
      paneCloseEnabled: true,
      paneCloseIdleThresholdMinutes: 5,
    });
    expect(closePane).toHaveBeenCalledTimes(1);
  });
});

describe('runScheduledPaneClose — fail-closed', () => {
  it('catches a reaper throw and returns an error without throwing', async () => {
    const onWarn = vi.fn();
    const deps: ReaperDeps = {
      listPanes: vi.fn().mockRejectedValue(new Error('herdr exploded')),
      closePane: vi.fn(),
      terminateProcessGroup: vi.fn(),
    };
    const result = await runScheduledPaneClose(
      deps,
      { paneCloseEnabled: true, paneCloseIdleThresholdMinutes: THRESHOLD_MIN },
      { onWarn },
    );
    expect(result.error).toContain('herdr exploded');
    expect(result.closed).toBe(0);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });
});

describe('runScheduledPaneClose — coexistence with the dispatch monitor', () => {
  it('skips panes the dispatch monitor already closed', async () => {
    const { deps, closePane } = makeDeps([
      pane({ id: 'handled', lastAssistantText: '</end_session>', agentProcessAlive: false }),
      pane({ id: 'fresh', lastAssistantText: '</end_session>', agentProcessAlive: false }),
    ]);
    const result = await runScheduledPaneClose(
      deps,
      { paneCloseEnabled: true, paneCloseIdleThresholdMinutes: THRESHOLD_MIN },
      { alreadyClosedPaneIds: new Set(['handled']) },
    );
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane).toHaveBeenCalledWith('fresh');
    expect(result.evaluated).toBe(1);
  });
});

describe('paneCloseReaperDue — worker cadence gate', () => {
  it('is not due when disabled', async () => {
    const { paneCloseReaperDue } = await import('./pane-close-scheduler');
    expect(paneCloseReaperDue({ enabled: false }, 0, 10_000_000)).toBe(false);
    expect(paneCloseReaperDue(undefined, 0, 10_000_000)).toBe(false);
  });

  it('is due on the first tick (lastRunAt 0)', async () => {
    const { paneCloseReaperDue } = await import('./pane-close-scheduler');
    // A real worker tick carries a large epoch timestamp, so lastRunAt=0 is
    // always due on the first tick.
    expect(paneCloseReaperDue({ enabled: true }, 0, 1_700_000_000_000)).toBe(true);
  });

  it('respects the default 60 s interval', async () => {
    const { paneCloseReaperDue, PANE_CLOSE_REAPER_INTERVAL_MS } = await import(
      './pane-close-scheduler'
    );
    expect(paneCloseReaperDue({ enabled: true }, 1_000, 1_000 + PANE_CLOSE_REAPER_INTERVAL_MS - 1)).toBe(false);
    expect(paneCloseReaperDue({ enabled: true }, 1_000, 1_000 + PANE_CLOSE_REAPER_INTERVAL_MS)).toBe(true);
  });

  it('honours a custom interval', async () => {
    const { paneCloseReaperDue } = await import('./pane-close-scheduler');
    expect(paneCloseReaperDue({ enabled: true, intervalMs: 5_000 }, 1_000, 5_999)).toBe(false);
    expect(paneCloseReaperDue({ enabled: true, intervalMs: 5_000 }, 1_000, 6_000)).toBe(true);
  });
});
