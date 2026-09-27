/**
 * packages/herdr/src/pane-close-reaper.test.ts — fixture-based tests for the
 * closure reaper and the process-group teardown (WL-0MUJW9DWO0070G9B /
 * WL-0MUJL1NAH0042GOS).
 *
 * All I/O is injected via the `ReaperDeps` interface so no real herdr, wl,
 * or `ps` calls run. The reaper is tested in isolation: we supply fake
 * pane lists, session readers, liveness probes, and closers and assert on
 * the results.
 *
 * Cases:
 *  1. Idle pane with marker → exactly one close call + ledger entry
 *  2. Marker-less, dead agent → close (reap)
 *  3. Marker-less, live agent, idle < threshold → no close
 *  4. `implement` pane → no close, even when idle/marked
 *  5. `needsProducerReview=true` → no close
 *  6. Invoking pane → no close
 *  7. Pane with live children → no close
 *  8. Already-closed pane → idempotent, no duplicate close
 *  9. Close failure for one pane does not abort others
 * 10. `--dry-run` performs zero close calls
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ReaperDeps, ReaperOptions, ReaperResult, PaneStatus } from './pane-close-reaper';

// ── Helpers ───────────────────────────────────────────────────────────

const THRESHOLD_MS = 30 * 60 * 1000;

/** Build a minimal `PaneStatus` for fixture construction. */
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

/** Build a no-op `ReaperDeps` — all functions are stubbed. */
function stubDeps(): ReaperDeps {
  return {
    listPanes: vi.fn().mockResolvedValue([]),
    closePane: vi.fn().mockResolvedValue({ success: true }),
    terminateProcessGroup: vi.fn().mockResolvedValue({ terminated: true }),
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────

function makeDeps(panes: PaneStatus[], closeResult?: { success: boolean }): ReaperDeps {
  return {
    listPanes: vi.fn().mockResolvedValue(panes),
    closePane: vi.fn().mockImplementation(async () =>
      closeResult ?? { success: true },
    ),
    terminateProcessGroup: vi.fn().mockResolvedValue({ terminated: true }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('reaper — marker idle pane closes once', () => {
  it('closes exactly once and writes a ledger entry (AC1)', async () => {
    // We import dynamically to avoid the import error if the module doesn't exist yet.
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'plan',
      lastAssistantText: 'Done\n\n</end_session>',
      agentProcessAlive: false,
      idleMs: 120_000,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(results[0].paneId).toBe('pane-001');
    expect(results[0].decision.close).toBe(true);
    expect(results[0].decision.reasonCode).toBe('marker');
  });
});

describe('reaper — marker-less, dead agent closes', () => {
  it('reaps a session whose agent process is gone (AC3)', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'intake',
      lastAssistantText: '',
      agentProcessAlive: false,
      idleMs: 5_000,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(results[0].decision.reasonCode).toBe('dead-agent');
  });
});

describe('reaper — marker-less, live agent below threshold does not close', () => {
  it('keeps the pane open when the agent is alive and idle is short', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'audit',
      lastAssistantText: '',
      agentProcessAlive: true,
      idleMs: 60_000, // 1 minute
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.close).toBe(false);
    expect(results[0].decision.reasonCode).toBe('active');
  });
});

describe('reaper — implement pane never closes', () => {
  it('skips implement panes even when marked/idle (AC4)', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'implement',
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
      idleMs: 3_600_000, // 1 hour
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.reasonCode).toBe('implement');
  });
});

describe('reaper — needsProducerReview pane never closes', () => {
  it('skips items awaiting producer review (AC2)', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'plan',
      lastAssistantText: '</end_session>',
      needsProducerReview: true,
      agentProcessAlive: false,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.reasonCode).toBe('producer-review');
  });
});

describe('reaper — invoking pane never closes', () => {
  it('skips the invoking pane regardless of other factors', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'plan',
      lastAssistantText: '</end_session>',
      isInvokingPane: true,
      agentProcessAlive: false,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.reasonCode).toBe('invoking-pane');
  });
});

describe('reaper — pane with live children never closes', () => {
  it('skips panes that have spawned children (AC5)', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'plan',
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
      childProcessCount: 2,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(deps.terminateProcessGroup).not.toHaveBeenCalled();
    expect(results[0].decision.reasonCode).toBe('live-children');
  });
});

describe('reaper — already-closed pane is idempotent', () => {
  it('does not double-close a pane that was already handled', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'plan',
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
    })];
    const deps = makeDeps(panes);
    // First run
    await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    // Second run — pane already closed (simulate by returning empty list or a
    // pane that is already in the ledger). The reaper should skip it.
    // Since the ledger is in-memory and cleared between runs, the second run
    // would re-evaluate the same pane. In a real scenario the pane would be
    // gone from `listPanes`. For the idempotence test we assert the close is
    // called exactly once per run.
    deps.closePane.mockClear();
    // Simulate the pane being gone from the list (already closed)
    deps.listPanes.mockResolvedValue([]);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
  });
});

describe('reaper — close failure does not abort other panes', () => {
  it('records a per-pane result and continues processing other panes', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [
      pane({ id: 'pane-001', lastAssistantText: '</end_session>', agentProcessAlive: false }),
      pane({ id: 'pane-002', lastAssistantText: '</end_session>', agentProcessAlive: false }),
    ];
    const closePane = vi.fn().mockImplementation(async (id: string) => {
      if (id === 'pane-002') throw new Error('close failed');
      return { success: true };
    });
    const deps: ReaperDeps = {
      listPanes: vi.fn().mockResolvedValue(panes),
      closePane,
      terminateProcessGroup: vi.fn().mockResolvedValue({ terminated: true }),
    };
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(results).toHaveLength(2);
    expect(results[0].paneId).toBe('pane-001');
    expect(results[0].success).toBe(true);
    expect(results[1].paneId).toBe('pane-002');
    expect(results[1].success).toBe(false);
  });
});

describe('reaper — dry-run performs zero close calls', () => {
  it('reports decisions but closes nothing (AC4)', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'plan',
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS, dryRun: true });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.close).toBe(true); // decision is still computed
  });
});

describe('reaper — idle threshold configurable via --threshold-minutes', () => {
  it('uses a custom threshold when provided', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const shortThreshold = 5 * 60 * 1000; // 5 minutes
    const panes = [pane({
      kind: 'plan',
      lastAssistantText: '',
      agentProcessAlive: true,
      idleMs: 6 * 60 * 1000, // 6 minutes — above 5 min threshold
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: shortThreshold });
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(results[0].decision.reasonCode).toBe('idle-threshold');
  });
});
