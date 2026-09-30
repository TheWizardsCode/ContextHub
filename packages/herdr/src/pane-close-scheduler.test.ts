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
  DEFAULT_PANE_CLOSE_GRACE_PERIOD_MINUTES,
  DEFAULT_PANE_CLOSE_IDLE_THRESHOLD_MINUTES,
  MIN_PANE_CLOSE_GRACE_PERIOD_MINUTES,
  MAX_PANE_CLOSE_GRACE_PERIOD_MINUTES,
  MIN_PANE_CLOSE_IDLE_THRESHOLD_MINUTES,
  MAX_PANE_CLOSE_IDLE_THRESHOLD_MINUTES,
  clampPaneCloseGracePeriodMinutes,
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
  it('is enabled by default with a 0-minute idle threshold (idle closing disabled)', () => {
    expect(DEFAULT_PANE_CLOSE_ENABLED).toBe(true);
    expect(DEFAULT_PANE_CLOSE_IDLE_THRESHOLD_MINUTES).toBe(0);
  });

  it('clamps the threshold into [0, 1440] minutes', () => {
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

describe('pane-close grace-period defaults and clamps (parent AC5)', () => {
  it('defaults the grace period to 5 minutes', () => {
    expect(DEFAULT_PANE_CLOSE_GRACE_PERIOD_MINUTES).toBe(5);
  });

  it('clamps the grace period into [1, 1440] minutes', () => {
    expect(clampPaneCloseGracePeriodMinutes(0)).toBe(MIN_PANE_CLOSE_GRACE_PERIOD_MINUTES);
    expect(clampPaneCloseGracePeriodMinutes(-5)).toBe(MIN_PANE_CLOSE_GRACE_PERIOD_MINUTES);
    expect(clampPaneCloseGracePeriodMinutes(2000)).toBe(MAX_PANE_CLOSE_GRACE_PERIOD_MINUTES);
    expect(clampPaneCloseGracePeriodMinutes(45)).toBe(45);
  });

  it('falls back to the default for a non-finite value', () => {
    expect(clampPaneCloseGracePeriodMinutes(Number.NaN)).toBe(
      DEFAULT_PANE_CLOSE_GRACE_PERIOD_MINUTES,
    );
  });
});

describe('runScheduledPaneClose — grace period pass-through (parent AC5)', () => {
  it('does not close a pane within the configured grace window', async () => {
    const { deps, closePane } = makeDeps([
      pane({
        id: 'p1',
        lastAssistantText: '</end_session>',
        agentProcessAlive: false,
        ageSinceDispatchMs: 60_000,
      }),
    ]);
    const result = await runScheduledPaneClose(deps, {
      paneCloseEnabled: true,
      paneCloseIdleThresholdMinutes: 0,
      paneCloseGracePeriodMinutes: 10,
    });
    expect(closePane).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
  });

  it('closes a pane past the configured grace window', async () => {
    const { deps, closePane } = makeDeps([
      pane({
        id: 'p1',
        lastAssistantText: '</end_session>',
        agentProcessAlive: false,
        ageSinceDispatchMs: 11 * 60 * 1000,
      }),
    ]);
    const result = await runScheduledPaneClose(deps, {
      paneCloseEnabled: true,
      paneCloseIdleThresholdMinutes: 0,
      paneCloseGracePeriodMinutes: 10,
    });
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(result.closed).toBe(1);
  });

  it('applies the 5-minute default when the setting is absent', async () => {
    const { deps, closePane } = makeDeps([
      pane({
        id: 'p1',
        lastAssistantText: '</end_session>',
        agentProcessAlive: false,
        ageSinceDispatchMs: 60_000,
      }),
    ]);
    await runScheduledPaneClose(deps, {
      paneCloseEnabled: true,
      paneCloseIdleThresholdMinutes: 0,
    });
    expect(closePane).not.toHaveBeenCalled();
  });

  it('a grace longer than the idle threshold still blocks an idle close', async () => {
    const { deps, closePane } = makeDeps([
      pane({
        id: 'p1',
        agentProcessAlive: true,
        idleMs: 6 * 60 * 1000,
        ageSinceDispatchMs: 10 * 60 * 1000,
      }),
    ]);
    await runScheduledPaneClose(deps, {
      paneCloseEnabled: true,
      paneCloseIdleThresholdMinutes: 5,
      paneCloseGracePeriodMinutes: 60,
    });
    expect(closePane).not.toHaveBeenCalled();
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
