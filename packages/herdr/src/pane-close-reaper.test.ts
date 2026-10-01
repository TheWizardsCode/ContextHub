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

describe('reaper — dead agent does not close (WL-0MUMEJHT9004EQPI)', () => {
  it('keeps a session whose agent process is gone (operator may need output)', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'intake',
      lastAssistantText: '',
      agentProcessAlive: false,
      idleMs: 5_000,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.close).toBe(false);
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

describe('reaper — idempotent close via alreadyClosedPaneIds (AC1.5)', () => {
  // Regression: the reaper and lifecycle monitor must not race; a pane can be
  // closed at most once. The alreadyClosedPaneIds guard prevents the reaper
  // from closing a pane it has already handled in a previous run.
  it('skips a pane whose id is in alreadyClosedPaneIds', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [
      pane({ id: 'pane-001', lastAssistantText: '</end_session>', agentProcessAlive: false }),
      pane({ id: 'pane-002', lastAssistantText: '</end_session>', agentProcessAlive: false }),
    ];
    const deps = makeDeps(panes);

    // First run — both panes are eligible
    const results1 = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(results1).toHaveLength(2);
    expect(deps.closePane).toHaveBeenCalledTimes(2);

    // Collect the pane IDs that were closed
    const closedPaneIds = new Set(
      results1.filter((r) => r.success).map((r) => r.paneId),
    );

    // Second run with alreadyClosedPaneIds — both panes are skipped entirely:
    // no results are emitted and closePane is not called again.
    deps.closePane.mockClear();
    const results2 = await runReaper(deps, {
      idleThresholdMs: THRESHOLD_MS,
      alreadyClosedPaneIds: closedPaneIds,
    });
    expect(results2).toHaveLength(0);
    expect(deps.closePane).not.toHaveBeenCalled();
  });

  it('processes only panes absent from alreadyClosedPaneIds', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [
      pane({ id: 'pane-001', lastAssistantText: '</end_session>', agentProcessAlive: false }),
      pane({ id: 'pane-002', lastAssistantText: '</end_session>', agentProcessAlive: false }),
    ];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, {
      idleThresholdMs: THRESHOLD_MS,
      alreadyClosedPaneIds: new Set(['pane-001']),
    });
    expect(results).toHaveLength(1);
    expect(results[0].paneId).toBe('pane-002');
    expect(results[0].decision.close).toBe(true);
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(deps.closePane).toHaveBeenCalledWith('pane-002');
  });

  it('empty alreadyClosedPaneIds has no effect — all panes processed', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({ id: 'pane-001', lastAssistantText: '</end_session>', agentProcessAlive: false })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, {
      idleThresholdMs: THRESHOLD_MS,
      alreadyClosedPaneIds: new Set<string>(),
    });
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].decision.close).toBe(true);
  });

  it('a non-closeable pane in alreadyClosedPaneIds is still skipped without closing', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({ id: 'pane-001', kind: 'implement' })];
    const deps = makeDeps(panes);
    // Even if an implement pane id is (wrongly) in the closed set, the reaper
    // must not close it — it is skipped before classification.
    const results = await runReaper(deps, {
      idleThresholdMs: THRESHOLD_MS,
      alreadyClosedPaneIds: new Set(['pane-001']),
    });
    expect(results).toHaveLength(0);
    expect(deps.closePane).not.toHaveBeenCalled();
  });
});

describe('reaper — grace period (parent AC5)', () => {
  const GRACE_MS = 5 * 60 * 1000;

  it('does not close a pane within its grace window (marker)', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'plan',
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
      ageSinceDispatchMs: 60_000,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS, gracePeriodMs: GRACE_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision).toMatchObject({ close: false, reasonCode: 'grace-period' });
  });

  it('does not close exactly at the grace boundary', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
      ageSinceDispatchMs: GRACE_MS,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS, gracePeriodMs: GRACE_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.reasonCode).toBe('grace-period');
  });

  it('closes normally once past the grace window', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
      ageSinceDispatchMs: GRACE_MS + 1,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS, gracePeriodMs: GRACE_MS });
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(results[0].decision.reasonCode).toBe('marker');
  });

  it('an absent pane age cannot trigger the grace guard (closes on marker)', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS, gracePeriodMs: GRACE_MS });
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(results[0].decision.reasonCode).toBe('marker');
  });

  it('grace 0 disables the guard (marker closes)', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
      ageSinceDispatchMs: 1,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS, gracePeriodMs: 0 });
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(results[0].decision.reasonCode).toBe('marker');
  });

  it('grace longer than the idle threshold still blocks an idle close', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      agentProcessAlive: true,
      idleMs: 6 * 60 * 1000,
      ageSinceDispatchMs: 10 * 60 * 1000,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, {
      idleThresholdMs: 5 * 60 * 1000,
      gracePeriodMs: 60 * 60 * 1000,
    });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.reasonCode).toBe('grace-period');
  });
});

describe('reaper — active-agent signal pass-through (parent AC3.3)', () => {
  it('keeps a pane open when it has recent file modifications', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      agentProcessAlive: true,
      idleMs: THRESHOLD_MS + 1,
      hasRecentFileModifications: true,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision).toMatchObject({ close: false, reasonCode: 'active' });
  });

  it('keeps a pane open when it has active network connections', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      agentProcessAlive: true,
      idleMs: THRESHOLD_MS + 1,
      hasActiveNetworkConnections: true,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.reasonCode).toBe('active');
  });

  it('closes on the idle threshold when no activity signal is present (backwards compatible)', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({ agentProcessAlive: true, idleMs: THRESHOLD_MS + 1 })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(results[0].decision.reasonCode).toBe('idle-threshold');
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

// ── CLI parsing and ledger ────────────────────────────────────────────

describe('parseReaperArgs', () => {
  it('parses --dry-run', async () => {
    const { parseReaperArgs } = await import('./pane-close-reaper');
    expect(parseReaperArgs(['--dry-run'])).toEqual({ dryRun: true });
  });

  it('parses --threshold-minutes <n> into milliseconds', async () => {
    const { parseReaperArgs } = await import('./pane-close-reaper');
    expect(parseReaperArgs(['--threshold-minutes', '5'])).toEqual({
      idleThresholdMs: 5 * 60 * 1000,
    });
  });

  it('parses --ledger <path>', async () => {
    const { parseReaperArgs } = await import('./pane-close-reaper');
    expect(parseReaperArgs(['--ledger', '/tmp/x.jsonl'])).toEqual({
      ledgerPath: '/tmp/x.jsonl',
    });
  });

  it('ignores invalid threshold values', async () => {
    const { parseReaperArgs } = await import('./pane-close-reaper');
    expect(parseReaperArgs(['--threshold-minutes', 'not-a-number'])).toEqual({});
    expect(parseReaperArgs(['--threshold-minutes', '-1'])).toEqual({});
  });

  it('parses combined flags', async () => {
    const { parseReaperArgs } = await import('./pane-close-reaper');
    expect(parseReaperArgs(['--dry-run', '--threshold-minutes', '10', '--ledger', '/tmp/l.jsonl'])).toEqual({
      dryRun: true,
      idleThresholdMs: 10 * 60 * 1000,
      ledgerPath: '/tmp/l.jsonl',
    });
  });

  it('parses --json (WL-0MUJMXVPO0016DZM)', async () => {
    const { parseReaperArgs } = await import('./pane-close-reaper');
    expect(parseReaperArgs(['--json'])).toEqual({ json: true });
  });

  it('parses --workspace <id> (WL-0MUJMXVPO0016DZM AC1)', async () => {
    const { parseReaperArgs } = await import('./pane-close-reaper');
    expect(parseReaperArgs(['--workspace', 'w2V'])).toEqual({ workspace: 'w2V' });
  });
});

describe('runReaper — workspace scoping (WL-0MUJMXVPO0016DZM AC1)', () => {
  it('excludes panes belonging to a different workspace', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [
      pane({ id: 'w1:p1', workspaceId: 'w1', lastAssistantText: '</end_session>', agentProcessAlive: false }),
      pane({ id: 'w2:p2', workspaceId: 'w2', lastAssistantText: '</end_session>', agentProcessAlive: false }),
    ];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { workspace: 'w1', dryRun: true });
    expect(results.map((r) => r.paneId)).toEqual(['w1:p1']);
  });

  it('retains panes with an unknown workspace (tolerant)', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({ id: 'w9:p9', workspaceId: undefined })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { workspace: 'w1', dryRun: true });
    expect(results.map((r) => r.paneId)).toEqual(['w9:p9']);
  });
});

describe('runReaper — ledger writing', () => {
  it('appends one JSONL ledger row per evaluated pane', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'reaper-ledger-'));
    const ledgerPath = join(dir, 'ledger.jsonl');
    try {
      const panes = [
        pane({ id: 'p1', lastAssistantText: '</end_session>', agentProcessAlive: false }),
        pane({ id: 'p2', lastAssistantText: '', agentProcessAlive: false }),
      ];
      const deps = makeDeps(panes);
      await runReaper(deps, { idleThresholdMs: THRESHOLD_MS, ledgerPath });

      const lines = readFileSync(ledgerPath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0].paneId).toBe('p1');
      expect(lines[0].decision.reasonCode).toBe('marker');
      expect(lines[1].paneId).toBe('p2');
      expect(lines[1].decision.reasonCode).toBe('dead-agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runReaper — detailed reason snapshot in the ledger (parent AC4.1/AC4.2/AC4.3)', () => {
  it('writes the reasonSnapshot alongside the decision and timestamp', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'reaper-snapshot-'));
    const ledgerPath = join(dir, 'ledger.jsonl');
    try {
      const panes = [pane({
        id: 'p1',
        kind: 'plan',
        lastAssistantText: '</end_session>',
        agentProcessAlive: false,
        idleMs: 1234,
        itemStage: 'plan_complete',
      })];
      const deps = makeDeps(panes);
      await runReaper(deps, { idleThresholdMs: THRESHOLD_MS, ledgerPath });
      const row = JSON.parse(readFileSync(ledgerPath, 'utf8').trim());
      expect(typeof row.timestamp).toBe('string');
      expect(row.decision.reasonCode).toBe('marker');
      expect(row.reasonSnapshot).toMatchObject({
        kind: 'plan',
        agentProcessAlive: false,
        idleMs: 1234,
        itemStage: 'plan_complete',
        needsProducerReview: false,
        childProcessCount: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws and still writes rows for malformed or absent snapshots', async () => {
    const { writeLedgerRow } = await import('./pane-close-reaper');
    type CloseDecisionShape = import('./pane-close').CloseDecision;
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'reaper-snapshot-bad-'));
    const ledgerPath = join(dir, 'ledger.jsonl');
    try {
      // A deliberately malformed snapshot (not an object) must be dropped
      // without throwing.
      writeLedgerRow(ledgerPath, {
        paneId: 'p1',
        paneTitle: 'T',
        decision: {
          close: true,
          reasonCode: 'marker',
          reasonSnapshot: 'garbage',
        } as unknown as CloseDecisionShape,
        success: true,
      });
      // An absent snapshot is omitted entirely.
      writeLedgerRow(ledgerPath, {
        paneId: 'p2',
        paneTitle: 'T2',
        decision: { close: false, reasonCode: 'active' },
        success: true,
      });

      const rows = readFileSync(ledgerPath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(rows).toHaveLength(2);
      expect(rows[0].paneId).toBe('p1');
      expect(rows[0].reasonSnapshot).toBeUndefined();
      expect(rows[1].paneId).toBe('p2');
      expect(rows[1].reasonSnapshot).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runReaperCli', () => {
  it('emits a JSON document on stdout in --json mode (WL-0MUJMXVPO0016DZM)', async () => {
    const { runReaperCli } = await import('./pane-close-reaper');
    const panes = [
      pane({
        id: 'w1:p1',
        itemId: 'WL-0ABC123',
        workspaceId: 'w1',
        lastAssistantText: '</end_session>',
        agentProcessAlive: false,
      }),
    ];
    const deps = makeDeps(panes);
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line);
    });
    try {
      const code = await runReaperCli(deps, ['--json']);
      expect(code).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
    const output = JSON.parse(logged.join('\n'));
    expect(output.evaluated).toBe(1);
    expect(output.dryRun).toBe(false);
    // Bridge envelope fields required by the pane-triage skill
    // (WL-0MUJMXVPO0016DZM child AC2).
    expect(output).toHaveProperty('invokingPaneId');
    expect(typeof output.timestamp).toBe('string');
    expect(output.panes[0]).toMatchObject({
      paneId: 'w1:p1',
      itemId: 'WL-0ABC123',
      workspaceId: 'w1',
      kind: 'plan',
      close: true,
      reasonCode: 'marker',
      needsProducerReview: false,
    });
    expect(Array.isArray(output.panes[0].sessionTail)).toBe(true);
  });

  it('returns exit code 0 when all closes succeed', async () => {
    const { runReaperCli } = await import('./pane-close-reaper');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'reaper-cli-'));
    try {
      const planPanes = [pane({ id: 'p1', lastAssistantText: '</end_session>', agentProcessAlive: false })];
      const deps = makeDeps(planPanes);
      const code = await runReaperCli(deps, ['--dry-run', '--ledger', join(dir, 'l.jsonl')]);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns exit code 1 when a close fails', async () => {
    const { runReaperCli } = await import('./pane-close-reaper');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'reaper-cli-fail-'));
    try {
      const panes = [pane({ id: 'p1', lastAssistantText: '</end_session>', agentProcessAlive: false })];
      const deps: ReaperDeps = {
        listPanes: vi.fn().mockResolvedValue(panes),
        closePane: vi.fn().mockRejectedValue(new Error('boom')),
        terminateProcessGroup: vi.fn().mockResolvedValue({ terminated: true }),
      };
      const code = await runReaperCli(deps, ['--ledger', join(dir, 'l.jsonl')]);
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reaper — reuses extractFinalAssistantText (AC6)', () => {
  it('derives the marker from raw session entries and closes', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'plan',
      lastAssistantText: '', // deliberately empty — entries are authoritative
      sessionEntries: [
        { type: 'user', text: 'go' },
        { type: 'assistant', text: 'Finished.\n\n</end_session>' },
      ],
      agentProcessAlive: false,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(results[0].decision.reasonCode).toBe('marker');
  });

  it('does not close when session entries lack the marker', async () => {
    const { runReaper } = await import('./pane-close-reaper');
    const panes = [pane({
      kind: 'plan',
      lastAssistantText: '</end_session>', // stale text ignored when entries present
      sessionEntries: [{ type: 'assistant', text: 'Still working.' }],
      agentProcessAlive: true,
      idleMs: 1_000,
    })];
    const deps = makeDeps(panes);
    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.reasonCode).toBe('active');
  });
});
