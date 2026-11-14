/**
 * packages/herdr/src/host-dispatch-budget.reconcile.test.ts — tick
 * reconciliation of the budget ledger (WL-0MWFJDEY5002FBRE, parent
 * WL-0MWFJD1RV008FCCR).
 *
 * The two reconciliation primitives (`reap`, `sweepClosedPanes`) used to run
 * only from the pane-close reaper — which had not run since 12 Nov — and from
 * `liveCount`'s opportunistic reap, whose write failures were swallowed. So a
 * dead confirmed entry lingered for hours, a pane-less entry was permanently
 * uncountable, and a failing write was indistinguishable from "nothing to
 * reap".
 *
 * This suite pins the tick pass: bounded cadence, trusted pane list only, adopt
 * a pane-less entry whose pane appeared, surface write failures, and stay
 * idempotent.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  HOST_BUDGET_RECONCILE_INTERVAL_MS,
  reconcileBudgetLedger,
} from './host-dispatch-budget.reconcile.js';
import { budgetLedgerPath, readBudget } from './host-dispatch-budget.js';
import {
  makeBudgetEntry,
  makeLivePaneList,
  readBudgetLedger,
  withMachineDir,
  writeBudgetLedger,
  writeRawBudgetLedger,
} from './host-dispatch-budget.fixtures.js';
import { runPaneMaintenance } from './downtime-worker.orchestrator-tick.js';
import type { OrchestratorContext } from './downtime-worker.orchestrator-dispatch.js';
import type { OrchestratorConfig } from './downtime-worker.orchestrator-dispatch.js';

const NOW = Date.parse('2026-11-13T22:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const implementPane = (itemId: string) => `Downtime triggered implement Do it - ${itemId}`;

describe('cadence constant', () => {
  it('is bounded and documented', () => {
    // One minute: the figure self-heals within a tick or two of a change while
    // the two possible ledger writes stay far below the ~10 s tick rate.
    expect(HOST_BUDGET_RECONCILE_INTERVAL_MS).toBe(60_000);
  });
});

describe('reconcileBudgetLedger', () => {
  it('drops a confirmed entry whose pane has closed — the 2026-11-13 dead entry (AC2)', async () => {
    await withMachineDir((dir) => {
      // The dead entry from the RCA: confirmed, its pane long gone, heartbeat
      // 19:27 while the pane list no longer lists it.
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          itemId: 'AH-0MW0KSCU20096B02',
          paneId: 'w50:p64',
          heartbeatAt: new Date(NOW - HOUR).toISOString(),
        }),
        makeBudgetEntry({ itemId: 'WL-LIVE', paneId: 'w50:p65' }),
      ]);

      const outcome = reconcileBudgetLedger(
        makeLivePaneList([{ paneId: 'w50:p65', title: implementPane('WL-LIVE') }]),
        { dir, now: NOW },
      );

      expect(outcome).toMatchObject({ ran: true, swept: 1, failures: [] });
      expect(readBudgetLedger(dir)?.entries.map((entry) => entry.itemId)).toEqual(['WL-LIVE']);
    });
  });

  it('reaps a stale, pane-less entry', async () => {
    await withMachineDir((dir) => {
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          itemId: 'WL-STALE',
          heartbeatAt: new Date(NOW - 3 * HOUR).toISOString(),
        }),
      ]);

      const outcome = reconcileBudgetLedger(makeLivePaneList([]), { dir, now: NOW });

      expect(outcome.swept + outcome.reaped).toBeGreaterThanOrEqual(1);
      expect(readBudgetLedger(dir)?.entries).toEqual([]);
    });
  });

  it('ADOPTS a pane-less entry whose pane has appeared (AC3)', async () => {
    await withMachineDir((dir) => {
      // The confirm was missed: the entry has no pane id but the pane exists.
      writeBudgetLedger(dir, [
        makeBudgetEntry({ itemId: 'WL-RUNNING', heartbeatAt: new Date(NOW).toISOString() }),
      ]);

      const outcome = reconcileBudgetLedger(
        makeLivePaneList([{ paneId: 'p:1', title: implementPane('WL-RUNNING') }]),
        { dir, now: NOW },
      );

      expect(outcome.adopted).toEqual([
        { itemId: 'WL-RUNNING', kind: 'implement', paneId: 'p:1' },
      ]);
      expect(readBudgetLedger(dir)?.entries[0].paneId).toBe('p:1');
    });
  });

  it('adopts through a decorated or manually-triggered label too', async () => {
    await withMachineDir((dir) => {
      writeBudgetLedger(dir, [
        makeBudgetEntry({ itemId: 'WL-DECORATED', heartbeatAt: new Date(NOW).toISOString() }),
        makeBudgetEntry({
          kind: 'audit',
          itemId: 'WL-MANUAL',
          heartbeatAt: new Date(NOW).toISOString(),
        }),
      ]);

      const outcome = reconcileBudgetLedger(
        makeLivePaneList([
          { paneId: 'p:1', title: '⚠️ Downtime triggered implement Do it - WL-DECORATED' },
          { paneId: 'p:2', title: 'Manually triggered audit Audit it - WL-MANUAL' },
        ]),
        { dir, now: NOW },
      );

      expect(outcome.adopted.map((entry) => entry.paneId).sort()).toEqual(['p:1', 'p:2']);
    });
  });

  it('writes NOTHING when the pane list is UNKNOWN (AC1)', async () => {
    await withMachineDir((dir) => {
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          itemId: 'WL-DEAD',
          paneId: 'p:dead',
          heartbeatAt: new Date(NOW - 3 * HOUR).toISOString(),
        }),
        makeBudgetEntry({ itemId: 'WL-PANELESS', heartbeatAt: new Date(NOW).toISOString() }),
      ]);
      const before = readFileSync(budgetLedgerPath(dir), 'utf8');

      const outcome = reconcileBudgetLedger(undefined, { dir, now: NOW });

      expect(outcome).toMatchObject({ ran: false, swept: 0, reaped: 0, adopted: [], failures: [] });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(before);
    });
  });

  it('is idempotent: a second pass is a pure read (no failures, no change)', async () => {
    await withMachineDir((dir) => {
      writeBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-LIVE', paneId: 'p:1' })]);
      const panes = makeLivePaneList([{ paneId: 'p:1', title: implementPane('WL-LIVE') }]);

      expect(reconcileBudgetLedger(panes, { dir, now: NOW })).toMatchObject({
        swept: 0,
        reaped: 0,
        adopted: [],
        failures: [],
      });
      const afterFirst = readFileSync(budgetLedgerPath(dir), 'utf8');
      expect(reconcileBudgetLedger(panes, { dir, now: NOW })).toMatchObject({
        swept: 0,
        reaped: 0,
        adopted: [],
        failures: [],
      });
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(afterFirst);
    });
  });

  it('reports a corrupt ledger instead of throwing, and leaves it untouched', async () => {
    await withMachineDir((dir) => {
      const corrupt = '{ not json';
      writeRawBudgetLedger(dir, corrupt);

      const outcome = reconcileBudgetLedger(makeLivePaneList([]), { dir, now: NOW });

      // Every step that touches the ledger refuses a document it cannot trust,
      // so the pass reports all three and writes nothing.
      expect(outcome.failures.map((failure) => failure.op).sort()).toEqual([
        'adopt',
        'reap',
        'sweep',
      ]);
      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(corrupt);
    });
  });

  it('reports a write failure rather than throwing (lock contention)', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          itemId: 'WL-DEAD',
          paneId: 'p:dead',
          heartbeatAt: new Date(NOW - 3 * HOUR).toISOString(),
        }),
      ]);
      // Hold the coordination lock so the sweep's write cannot proceed.
      const { tryAcquireCoordLock } = await import('./coordination.js');
      const lock = tryAcquireCoordLock(dir);
      expect(lock).not.toBeNull();
      try {
        const outcome = reconcileBudgetLedger(makeLivePaneList([]), { dir, now: NOW });
        expect(outcome.failures.length).toBeGreaterThan(0);
        expect(outcome.failures[0].op).toBe('sweep');
        // Best-effort: the corrupt/contended path never throws.
        expect(readBudget({ dir }).ok).toBe(true);
      } finally {
        lock?.();
      }
    });
  });
});

// ── Tick wiring ───────────────────────────────────────────────────────

describe('the worker tick runs the reconciliation at a bounded cadence (AC1)', () => {
  /** Minimal orchestrator context for `runPaneMaintenance`. */
  function makeContext(
    getRunningDowntimePanes: () => Promise<{
      ok: boolean;
      count?: number;
      records?: { paneId: string; label?: string }[];
    }>,
  ): OrchestratorContext {
    return {
      opts: { deps: { getRunningDowntimePanes } },
      instanceId: 'instance-test',
      lastPaneMonitorAt: 0,
      lastPaneCloseReaperAt: 0,
      lastBudgetReconcileAt: 0,
    } as unknown as OrchestratorContext;
  }

  const cfg = { cwd: '/repo', paneClose: undefined } as unknown as OrchestratorConfig;

  it('runs a pass when the cadence has elapsed, and not before', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetLedger(dir, [makeBudgetEntry({ itemId: 'WL-LIVE', paneId: 'p:1' })]);
      const listing = vi.fn(async () => ({
        ok: true,
        count: 1,
        records: [{ paneId: 'p:2', label: implementPane('WL-EXTRA') }],
      }));
      const ctx = makeContext(listing);
      const firstTick = HOST_BUDGET_RECONCILE_INTERVAL_MS;

      runPaneMaintenance(ctx, cfg, firstTick);
      // Fire-and-forget: let the pass settle.
      await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(1));

      // A second tick inside the cadence does not re-read the pane list.
      runPaneMaintenance(ctx, cfg, firstTick + HOST_BUDGET_RECONCILE_INTERVAL_MS - 1);
      await Promise.resolve();
      expect(listing).toHaveBeenCalledTimes(1);

      // Past the cadence it runs again.
      runPaneMaintenance(ctx, cfg, firstTick + HOST_BUDGET_RECONCILE_INTERVAL_MS);
      await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(2));
    });
  });

  it('an UNKNOWN pane read performs no write (AC1)', async () => {
    await withMachineDir(async (dir) => {
      writeBudgetLedger(dir, [
        makeBudgetEntry({
          itemId: 'WL-DEAD',
          paneId: 'p:dead',
          heartbeatAt: new Date(Date.now() - 3 * HOUR).toISOString(),
        }),
      ]);
      const before = readFileSync(budgetLedgerPath(dir), 'utf8');
      const ctx = makeContext(async () => ({ ok: false }));

      runPaneMaintenance(ctx, cfg, HOST_BUDGET_RECONCILE_INTERVAL_MS);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(readFileSync(budgetLedgerPath(dir), 'utf8')).toBe(before);
    });
  });
});
