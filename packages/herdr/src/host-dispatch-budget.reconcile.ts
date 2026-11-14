/**
 * packages/herdr/src/host-dispatch-budget.reconcile.ts — reconcile the dispatch
 * budget ledger with the panes actually running, on the worker tick
 * (WL-0MWFJDEY5002FBRE, parent WL-0MWFJD1RV008FCCR).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The ledger's two reconciliation primitives — `reap` (stale, pane-less) and
 * `sweepClosedPanes` (confirmed but pane gone) — used to run only from the
 * pane-close reaper (`index.ts` `sweepBudgetLedger`, `pane-close-cli.ts`) and
 * from `liveCount`'s opportunistic reap. The pane-close reaper had not run
 * since 12 Nov, so:
 *
 *  - a dead confirmed entry (`AH-0MW0KSCU20096B02` / `w50:p64`, heartbeat
 *    19:27) still sat in the ledger hours after its pane closed;
 *  - a pane-less entry (the confirm was missed) was permanently uncountable —
 *    the implement tier requires a live pane — and was only removed when
 *    something happened to call a reaping read;
 *  - reap/sweep write failures were swallowed, so a failing write looked
 *    exactly like "nothing to reap".
 *
 * This pass therefore runs on the worker tick at a bounded cadence, uses the
 * machine-wide trusted pane list, performs NO write when that read failed
 * (UNKNOWN ≠ empty), ADOPTS a pane-less entry whose pane has since appeared,
 * and reports every failure to the caller so it can be surfaced instead of
 * swallowed.
 *
 * ## Contract
 *
 *  - `livePanes: undefined` (a failed/unparseable read) ⇒ nothing is written
 *    at all: no sweep, no reap, no adoption. The tick's dispatch decision is
 *    untouched (this pass never gates anything).
 *  - Idempotent: a second pass over an already-clean ledger is a pure read (no
 *    writes, no failures).
 *  - Fail-open for dispatch: a failed write is REPORTED, never thrown, and
 *    never changes a dispatch decision.
 */

import {
  readBudget,
  reap,
  reserve,
  sweepClosedPanes,
  type HostBudgetEntry,
  type HostBudgetKind,
  type HostBudgetLivePane,
  type HostBudgetOptions,
} from './host-dispatch-budget.js';
import { decodeBudgetPaneLabel } from './host-dispatch-budget.repair.js';

/**
 * Bounded cadence for the tick reconciliation pass (documented constant).
 *
 * One minute: fast enough that the in-flight figure self-heals within a tick or
 * two of a dispatch starting/finishing, slow enough that the two machine-wide
 * ledger writes it may perform stay far below the tick rate (~10 s).
 */
export const HOST_BUDGET_RECONCILE_INTERVAL_MS = 60_000;

/** One reconciliation failure, reported (never thrown) to the caller. */
export interface BudgetReconcileFailure {
  /** Which write failed. */
  op: 'sweep' | 'reap' | 'adopt';
  /** Human-readable cause (the ledger's own failure reason). */
  message: string;
}

/** What one reconciliation pass did. */
export interface BudgetReconcileOutcome {
  /** False when the pane list was UNKNOWN — nothing was read or written. */
  ran: boolean;
  /** Confirmed entries dropped because their pane has closed. */
  swept: number;
  /** Stale, pane-less entries dropped. */
  reaped: number;
  /** Panes written back onto pane-less entries (adoption). */
  adopted: { itemId: string; kind: HostBudgetKind; paneId: string }[];
  /** Writes that failed — surfaced by the caller, never fatal. */
  failures: BudgetReconcileFailure[];
}

/**
 * True when the tick's reconciliation pass is due (cadence gate).
 *
 * Kept here so the tick module stays inside the split-family line ceiling: the
 * caller only compares the gate, bumps the timestamp and fires the pass.
 */
export function budgetReconcileDue(lastPassAt: number, tickNow: number): boolean {
  return tickNow - lastPassAt >= HOST_BUDGET_RECONCILE_INTERVAL_MS;
}

/**
 * Reconcile the machine ledger against the trusted live pane list.
 *
 * Steps, in order (each best-effort and independently reported):
 *
 *  1. `sweepClosedPanes` — a confirmed entry whose pane is gone is dropped
 *     within one cadence, whatever its heartbeat age.
 *  2. `reap` — stale, pane-less entries are dropped.
 *  3. adoption — a pane-less implement/audit entry is re-confirmed with the
 *     pane id of a matching live dispatcher pane for the same `(kind, itemId)`,
 *     so the confirm is no longer a single racy attempt.
 *
 * Never throws.
 */
export function reconcileBudgetLedger(
  livePanes: readonly HostBudgetLivePane[] | undefined,
  opts: HostBudgetOptions = {},
): BudgetReconcileOutcome {
  const outcome: BudgetReconcileOutcome = {
    ran: false,
    swept: 0,
    reaped: 0,
    adopted: [],
    failures: [],
  };
  // An UNKNOWN pane read must never be treated as "no panes": an empty list
  // would sweep every confirmed entry off the ledger.
  if (livePanes === undefined) return outcome;
  outcome.ran = true;

  const swept = sweepClosedPanes(livePanes, { ...opts, reason: 'reconcile-sweep' });
  if (swept.ok) outcome.swept = swept.reaped;
  else outcome.failures.push({ op: 'sweep', message: describeFailure(swept) });

  const reaped = reap(livePanes, { ...opts, reason: 'reconcile-reap' });
  if (reaped.ok) outcome.reaped = reaped.reaped;
  else outcome.failures.push({ op: 'reap', message: describeFailure(reaped) });

  // ── Adoption ─────────────────────────────────────────────────────────
  // Read AFTER the sweep/reap so a just-removed entry is not re-adopted.
  const read = readBudget(opts);
  if (!read.ok) {
    // A corrupt ledger is a repair problem, not a reconciliation one: report it
    // once so the operator sees it, and leave the bytes untouched.
    outcome.failures.push({ op: 'adopt', message: describeFailure(read) });
    return outcome;
  }
  const paneLess = read.ledger.entries.filter(
    (entry) => entry.paneId === undefined || entry.paneId === '',
  );
  if (paneLess.length === 0) return outcome;

  const byKey = new Map<string, { paneId: string }>();
  for (const pane of livePanes) {
    if (typeof pane.paneId !== 'string' || pane.paneId === '') continue;
    const decoded = decodeBudgetPaneLabel(pane.title);
    if (decoded.kind === null || decoded.itemId === null) continue;
    const key = `${decoded.kind}:${decoded.itemId}`;
    if (!byKey.has(key)) byKey.set(key, { paneId: pane.paneId });
  }

  for (const entry of paneLess) {
    const match = byKey.get(`${entry.kind}:${entry.itemId}`);
    if (match === undefined) continue;
    // Re-confirm the SAME attempt (the entry's token is preserved), writing the
    // pane id back — exactly what the post-spawn confirm would have done.
    const confirmed = reserve(
      {
        kind: entry.kind,
        itemId: entry.itemId,
        instanceId: entry.instanceId,
        root: entry.root,
        paneId: match.paneId,
        op: 'confirm',
        ...(entry.attemptId !== undefined ? { attemptId: entry.attemptId } : {}),
        ...(entry.override !== undefined ? { override: entry.override } : {}),
      },
      { ...opts, reason: 'reconcile-adopt' },
    );
    if (confirmed.ok) {
      outcome.adopted.push({ itemId: entry.itemId, kind: entry.kind, paneId: match.paneId });
    } else {
      outcome.failures.push({ op: 'adopt', message: describeFailure(confirmed) });
    }
  }
  return outcome;
}

/** One-line description of a ledger failure, for the surfaced stderr line. */
export function describeFailure(failure: { reason?: string }): string {
  return failure.reason ?? 'unknown';
}

/**
 * The `(kind, itemId)` pairs of entries still waiting for their pane id.
 *
 * Exported for the operator surfaces/diagnostics; the reconciliation itself
 * derives them inside its own read.
 */
export function paneLessEntries(
  entries: readonly HostBudgetEntry[],
): HostBudgetEntry[] {
  return entries.filter((entry) => entry.paneId === undefined || entry.paneId === '');
}
