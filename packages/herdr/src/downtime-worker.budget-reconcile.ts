/**
 * packages/herdr/src/downtime-worker.budget-reconcile.ts — the worker tick's
 * host-budget reconciliation PASS (WL-0MWFJDEY5002FBRE, parent
 * WL-0MWFJD1RV008FCCR).
 *
 * Split out of `downtime-worker.orchestrator-tick.ts` to keep that module
 * inside the split-family line ceiling: the tick only owns the cadence GATE,
 * this module owns the pass itself.
 *
 * The pass reads the machine-wide trusted pane list and hands it to
 * {@link reconcileBudgetLedger}: a confirmed entry whose pane has closed is
 * dropped within one cadence, a stale pane-less entry is reaped, and a
 * pane-less entry whose pane has since appeared is re-confirmed (adopted). A
 * FAILED pane read is UNKNOWN — never "no panes" — so nothing is written.
 *
 * Failures are SURFACED (one stderr line + one non-blocking decision entry)
 * instead of swallowed, and nothing here can change a dispatch decision: the
 * pass never gates and never throws.
 *
 * Test isolation (WL-0MWJPVWB6002208H): the ledger is resolved through the
 * SAME policy as the coordination file (`resolveEffectiveDir`) — a tmp-root
 * worker (every unit-test harness) reconciles its OWN root ledger, so the
 * first-tick pass can never contend with the real worker or parallel vitest
 * workers on the shared `~/.herdr/downtime` lock, and never sweeps real
 * entries against the test mocks' pane list. Production worklog roots
 * resolve to the machine dir exactly as before.
 */

import { HOST_BUDGET_RECONCILE_INTERVAL_MS } from './host-dispatch-budget.reconcile.js';
import { recordDecision } from './downtime-worker.orchestrator-dispatch.js';
import type {
  OrchestratorConfig,
  OrchestratorContext,
} from './downtime-worker.orchestrator-dispatch.js';
import { reconcileBudgetLedger } from './host-dispatch-budget.reconcile.js';
import type { HostBudgetLivePane } from './host-dispatch-budget.js';
import { liveBudgetPanesFromRecords } from './host-dispatch-budget.live-panes.js';
import { resolveEffectiveDir } from './coordination.js';

/**
 * Cadence-gated, fire-and-forget reconciliation pass for the worker tick.
 *
 * The caller must NOT await it (the single-flight dispatch guard relies on the
 * first in-flight tick setting `dispatching` before a second tick reaches its
 * check). Returns whether the pass ran, so callers can keep their own
 * timestamps if they do not use `ctx.lastBudgetReconcileAt`.
 */
export function maybeRunBudgetReconcilePass(
  ctx: OrchestratorContext,
  cfg: OrchestratorConfig,
  tickNow: number,
  warn: (message: string) => void,
): void {
  if (tickNow - ctx.lastBudgetReconcileAt < HOST_BUDGET_RECONCILE_INTERVAL_MS) return;
  ctx.lastBudgetReconcileAt = tickNow;
  void reconcileHostBudgetPass(ctx, cfg, warn);
}
export async function reconcileHostBudgetPass(
  ctx: OrchestratorContext,
  cfg: OrchestratorConfig,
  warn: (message: string) => void,
): Promise<void> {
  const deps = ctx.opts.deps;
  let panes: HostBudgetLivePane[] | undefined;
  if (typeof deps.getRunningDowntimePanes === 'function') {
    try {
      const read = await deps.getRunningDowntimePanes(cfg.cwd);
      // Only an authoritative read is usable: `ok:false` is the tri-state
      // UNKNOWN that the ledger must never treat as an empty list (an empty
      // list would sweep every confirmed entry off the ledger).
      panes = read.ok
        ? liveBudgetPanesFromRecords(read.records ?? [])
        : undefined;
    } catch {
      panes = undefined;
    }
  }

  let outcome;
  try {
    // Target the SAME dir the coordination file resolves to, not the machine
    // ledger unconditionally: a tmp-root worker (every unit-test harness) is
    // sandboxed to its own root, so the first-tick pass can never contend
    // with the real worker / parallel vitest workers on the shared
    // `~/.herdr/downtime` lock and never sweeps real ledger entries against
    // the test mocks' pane list (WL-0MWJPVWB6002208H). Production worklog
    // roots resolve to the machine dir exactly as before.
    outcome = reconcileBudgetLedger(panes, {
      dir: resolveEffectiveDir(cfg.cwd),
      actor: `herdr:${process.pid}`,
    });
  } catch (err) {
    warn(`budget reconcile pass threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (outcome.failures.length === 0) return;

  const summary = outcome.failures.map((failure) => `${failure.op}:${failure.message}`).join(', ');
  try {
    process.stderr.write(
      `[worklog-plugin] Downtime budget reconciliation failed — ${summary}\n`,
    );
  } catch {
    // fail-safe: a stderr failure must never crash the worker
  }
  // Non-blocking observation: the capacity fields are inert here, so the entry
  // exists purely so the failure is queryable from the decision log.
  void recordDecision(
    ctx,
    cfg.cwd,
    'host-budget-reconcile-failed',
    {
      freeSlots: 0,
      totalSlots: 0,
      ownerPresent: false,
      runningPanes: null,
      contentionDepth: 0,
      detail:
        `${summary} (swept=${outcome.swept}, reaped=${outcome.reaped}, ` +
        `adopted=${outcome.adopted.length})`,
    },
    { blocking: false },
  );
}
