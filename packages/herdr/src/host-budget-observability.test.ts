/**
 * packages/herdr/src/host-budget-observability.test.ts — convergence of the
 * four host-budget observability surfaces (WL-0MVXY0ZYW009NEJD F5, parent
 * WL-0MVXWQFGV000D2AB).
 *
 * Parent AC10 / this item's AC5: the decision log entry, the header token, the
 * stderr skip line and the worklist `implement n/max · audit n/max` counter all
 * reflect the SAME counts, derived from ONE reader — so a stop is never silent
 * and the numbers can never drift between surfaces.
 *
 * AC6: a machine-budget refusal is an operator-imposed stop, NOT capacity
 * starvation — it must neither start nor extend a starvation episode (the
 * tracker state is left exactly as it was).
 *
 * The tests drive the real worker tick (`createDowntimeWorker`) with the REAL
 * admission reader (`admitHostDispatch`) over an isolated machine coordination
 * dir, so nothing here re-implements the counting.
 */

import { writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDowntimePoller,
  createDowntimeWorker,
  decisionHeaderToken,
  type LlamaStatus,
} from './downtime-worker.js';
import { admitHostDispatch } from './host-dispatch-budget.admission.js';
import { budgetConfigPath } from './host-dispatch-budget.js';
import {
  makeBudgetEntry,
  makeLivePaneList,
  withMachineDir,
  writeBudgetLedger,
} from './host-dispatch-budget.fixtures.js';
import {
  hostBudgetStatusText,
  readHostBudgetStatus,
} from './host-budget-status.js';
import type { CoordinationLogEntry } from './downtime-log.js';
import {
  idleAllSlotsFree,
  jsonResponseFixture,
  makeDeps,
} from './downtime-worker.fixtures.js';

/** Deterministic clock: 2026-11-03T12:00:00.000Z. */
const T0 = Date.parse('2026-11-03T12:00:00.000Z');
const MINUTE = 60 * 1000;
const ALERT_WINDOW = 5 * 60 * 1000; // clamped floor — a test-scale window

const cleanEnv: Readonly<Record<string, string | undefined>> = {};

/** The implement candidate the legacy tier offers when a slot is free. */
const implementCandidate = {
  id: 'WL-IMP-NEW',
  title: 'Implement me',
  stage: 'plan_complete' as const,
  status: 'open',
};

/** Schema-v2 saturated pool: both slots generating, no free capacity. */
function saturatedStatus(): LlamaStatus {
  return {
    llama_server_running: true,
    local_active_query: true,
    model_switch_in_progress: false,
    local_lease_active: true,
    available_slots: 0,
    total_slots: 2,
    status_schema_version: 2,
    capacity_hint: 'saturated',
    local_prefills_in_flight: 1,
    local_max_concurrent_prefills: 1,
    prefill_gate_waiters: 1,
    contention_queue_depth: 0,
    slots: [
      { slot_id: 'slot-1', is_processing: true, lease_state: 'generating', phase: 'decode' },
      { slot_id: 'slot-2', is_processing: true, lease_state: 'generating', phase: 'decode' },
    ],
  };
}

function writeCaps(dir: string, caps: Record<string, number>): void {
  writeFileSync(budgetConfigPath(dir), JSON.stringify(caps) + '\n', 'utf8');
}

interface HarnessOpts {
  dir: string;
  cwd: string;
  livePanes: ReturnType<typeof makeLivePaneList>;
  now: number;
  status: LlamaStatus | (() => LlamaStatus);
  recordDecision: (entry: CoordinationLogEntry, cwd: string) => Promise<void>;
  capacityStarvationAlertMs?: number;
}

/** One real worker over an isolated machine dir, with the real admission read. */
function makeHarness(opts: HarnessOpts) {
  const poller = createDowntimePoller('http://proxy:8000', async () =>
    jsonResponseFixture(typeof opts.status === 'function' ? opts.status() : opts.status),
  );
  const deps = makeDeps({
    getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
    // Exactly the production wiring: the dispatcher's ONE admission reader,
    // pointed at the isolated machine dir and the machine-wide pane list.
    admitHostDispatch: vi.fn(async (input: { itemId: string; kind: 'implement' | 'audit' }) =>
      admitHostDispatch(
        {
          kind: input.kind,
          itemId: input.itemId,
          instanceId: 'test-instance',
          root: opts.cwd,
        },
        { dir: opts.dir, livePanes: opts.livePanes, now: opts.now, env: cleanEnv },
      ),
    ),
    recordDecision: opts.recordDecision,
  });
  const worker = createDowntimeWorker({
    poller,
    deps,
    config: () => ({
      enabled: true,
      thresholdMs: 0,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: opts.cwd,
      noCandidateCooldownMs: 3_600_000,
      browseItemCount: 20,
      ...(opts.capacityStarvationAlertMs !== undefined
        ? { capacityStarvationAlertMs: opts.capacityStarvationAlertMs }
        : {}),
    }),
  });
  return { worker, deps };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Drain the `void recordDecision(...)` microtask chain after a tick. */
async function flushDecisionLog(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('host-budget observability convergence (AC5)', () => {
  it('decision log, header token, stderr line and counter agree on one ledger state', async () => {
    await withMachineDir(async (dir) => {
      const cwd = '/repo';
      const livePanes = makeLivePaneList([
        { paneId: 'pane-1', itemId: 'WL-IMP-1' },
        { paneId: 'pane-2', itemId: 'WL-IMP-2' },
      ]);
      writeCaps(dir, { maxImplement: 2, maxAudit: 1 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-IMP-1',
          paneId: 'pane-1',
          heartbeatAt: new Date(T0).toISOString(),
        }),
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-IMP-2',
          paneId: 'pane-2',
          heartbeatAt: new Date(T0).toISOString(),
        }),
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-AUD-1',
          paneId: 'pane-3',
          heartbeatAt: new Date(T0).toISOString(),
        }),
      ]);

      const recordDecision = vi.fn().mockResolvedValue(undefined);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        const { worker, deps } = makeHarness({
          dir,
          cwd,
          livePanes,
          now: T0,
          status: idleAllSlotsFree,
          recordDecision,
        });

        await worker.tick();
        await flushDecisionLog();

        // Nothing spawned, and the tier really was consulted exactly once.
        expect(deps.spawnAgentPane).not.toHaveBeenCalled();
        expect(deps.admitHostDispatch).toHaveBeenCalledTimes(1);
        expect(deps.admitHostDispatch).toHaveBeenCalledWith({
          itemId: 'WL-IMP-NEW',
          kind: 'implement',
          cwd,
        });

        // ── Surface 1: the decision log entry carries the refusal AND the
        //    `{ live, max }` evidence.
        const entry = recordDecision.mock.calls
          .map((call) => call[0] as CoordinationLogEntry)
          .find((candidate) => candidate.reason === 'host-budget-implement');
        expect(entry).toBeDefined();
        expect(entry?.budget).toEqual({ live: 2, max: 2 });

        // ── Surface 2: the header token.
        expect(decisionHeaderToken(entry?.reason as string)).toBe('budget-implement');

        // ── Surface 3: the stderr skip line quotes the same figures.
        expect(stderrSpy).toHaveBeenCalledWith(
          '[worklog-plugin] Downtime implement tier skipped: host-budget-implement (live=2, max=2)\n',
        );

        // ── Surface 4: the worklist counter, from the one read-only reader.
        const status = readHostBudgetStatus({
          dir,
          livePanes,
          now: T0,
          env: cleanEnv,
        });
        expect(status).toEqual({
          implement: { live: entry?.budget?.live, max: entry?.budget?.max },
          audit: { live: 1, max: 1 },
        });
        const counter = hostBudgetStatusText(status);
        expect(counter).toBe('[budget: implement 2/2 · audit 1/1]');
        // Cross-surface agreement, stated as one assertion: the counter's
        // implement figures are the decision entry's evidence.
        expect(counter).toContain(`implement ${entry?.budget?.live}/${entry?.budget?.max}`);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  it('an audit-tier budget stop reports the audit token on every surface', async () => {
    await withMachineDir(async (dir) => {
      const cwd = '/repo';
      writeCaps(dir, { maxImplement: 2, maxAudit: 2 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-AUD-1',
          paneId: 'pane-9',
          heartbeatAt: new Date(T0).toISOString(),
        }),
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-AUD-2',
          paneId: 'pane-10',
          heartbeatAt: new Date(T0).toISOString(),
        }),
      ]);

      const recordDecision = vi.fn().mockResolvedValue(undefined);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        // The audit tier's admission pre-check is the `getActiveAudit` dep in
        // production; it reports the host-wide cap decision it read.
        const deps = makeDeps({
          getActiveAudit: vi.fn().mockResolvedValue({
            ok: true,
            active: true,
            source: 'host-wide',
            reason: 'host-budget-audit',
            budget: { live: 2, max: 2 },
          }),
          getNextImplementCandidate: vi.fn().mockResolvedValue(null),
          getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
          recordDecision,
        });
        const worker = createDowntimeWorker({
          poller: createDowntimePoller('http://proxy:8000', async () =>
            jsonResponseFixture(idleAllSlotsFree),
          ),
          deps,
          config: () => ({
            enabled: true,
            thresholdMs: 0,
            requiredFreeSlots: 0,
            model: 'plan',
            cwd,
            noCandidateCooldownMs: 3_600_000,
            browseItemCount: 20,
          }),
        });
        await worker.tick();
        await flushDecisionLog();

        const entry = recordDecision.mock.calls
          .map((call) => call[0] as CoordinationLogEntry)
          .find((candidate) => candidate.reason === 'host-budget-audit');
        expect(entry?.budget).toEqual({ live: 2, max: 2 });
        expect(decisionHeaderToken('host-budget-audit')).toBe('budget-audit');
        expect(stderrSpy).toHaveBeenCalledWith(
          '[worklog-plugin] Downtime audit tier skipped: host-budget-audit (live=2, max=2)\n',
        );
        const counter = hostBudgetStatusText(
          readHostBudgetStatus({ dir, livePanes: [], now: T0, env: cleanEnv }),
        );
        expect(counter).toBe('[budget: implement 0/2 · audit 2/2]');
        expect(counter).toContain(`audit ${entry?.budget?.live}/${entry?.budget?.max}`);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});

describe('host-budget refusal is not capacity starvation (AC6)', () => {
  it('leaves the starvation episode state unchanged', async () => {
    await withMachineDir(async (dir) => {
      const cwd = '/repo';
      const livePanes = makeLivePaneList([
        { paneId: 'pane-1', itemId: 'WL-IMP-1' },
        { paneId: 'pane-2', itemId: 'WL-IMP-2' },
      ]);
      writeCaps(dir, { maxImplement: 2, maxAudit: 1 });
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-IMP-1',
          paneId: 'pane-1',
          heartbeatAt: new Date(T0).toISOString(),
        }),
        makeBudgetEntry({
          kind: 'implement',
          itemId: 'WL-IMP-2',
          paneId: 'pane-2',
          heartbeatAt: new Date(T0).toISOString(),
        }),
      ]);

      const recordDecision = vi.fn().mockResolvedValue(undefined);
      let current: LlamaStatus = saturatedStatus();
      const { worker } = makeHarness({
        dir,
        cwd,
        livePanes,
        now: T0,
        status: () => current,
        recordDecision,
        capacityStarvationAlertMs: ALERT_WINDOW,
      });

      vi.useFakeTimers();
      vi.setSystemTime(T0);

      // 1. A capacity refusal STARTS an episode.
      await worker.tick();
      await flushDecisionLog();
      expect(recordDecision.mock.calls.map((c) => (c[0] as CoordinationLogEntry).reason)).toEqual([
        'capacity-saturated',
      ]);

      // 2. Capacity is back, but the host budget is at its cap: the tick ends
      //    on a BUDGET refusal. If that were fed to the starvation tracker it
      //    would RESET the episode (a non-capacity reason), silently masking
      //    the starvation stretch.
      current = idleAllSlotsFree;
      vi.setSystemTime(T0 + MINUTE);
      await worker.tick();
      await flushDecisionLog();
      expect(recordDecision.mock.calls.map((c) => (c[0] as CoordinationLogEntry).reason)).toEqual([
        'capacity-saturated',
        'host-budget-implement',
      ]);

      // 3. Capacity is starved again, past the alert window measured from the
      //    ORIGINAL refusal. The episode survived the budget stop, so the
      //    signal still fires and still dates from step 1 — and the budget tick
      //    never counted as a capacity refusal.
      current = saturatedStatus();
      vi.setSystemTime(T0 + ALERT_WINDOW + 1);
      await worker.tick();
      await flushDecisionLog();

      const reasons = recordDecision.mock.calls.map((c) => (c[0] as CoordinationLogEntry).reason);
      expect(reasons).toContain('capacity-starved');
      const starved = recordDecision.mock.calls
        .map((call) => call[0] as CoordinationLogEntry)
        .find((entry) => entry.reason === 'capacity-starved');
      expect(Date.parse(starved?.starvedSince as string)).toBe(T0);
      expect(starved?.consecutiveCapacityRefusals).toBe(2);
      expect(starved?.lastCapacityReason).toBe('capacity-saturated');
    });
  });
});
