/**
 * packages/herdr/src/downtime-log-budget.ts — host-wide dispatch-budget
 * refusal vocabulary (WL-0MVGKHFT4003X6JW, split out of `downtime-log.ts`).
 *
 * Single responsibility: the **tokens and evidence shape** the decision log
 * uses to record a machine-scoped budget refusal, plus the guard that
 * recognises them. A pure leaf module — it imports nothing, so both the
 * decision-log writers and `host-dispatch-budget.admission.ts` can depend on
 * it without risking a cycle.
 *
 * Extracted verbatim from `downtime-log.ts`; behaviour is unchanged.
 */

/**
 * Host-wide dispatch-budget refusal tokens (WL-0MVXY0ZYW009NEJD F5, parent
 * WL-0MVXWQFGV000D2AB).
 *
 * The decision log is the VOCABULARY OF RECORD for the machine-scoped budget
 * (F1 ledger, admission F3/F2): the admission module imports these constants
 * instead of spelling its own strings, so the decision entry, the header token
 * (`decisionHeaderToken`) and the stderr skip line can never drift into a
 * second spelling of the same refusal.
 *
 *  - `host-budget-implement` — the implement tier is at/over `maxImplement`
 *    (or the tier is disabled with `maxImplement: 0`);
 *  - `host-budget-audit` — the same for the audit tier at any cap other than 1
 *    (the retired marker's `audit-host-saturated` token is kept at cap 1 so
 *    existing consumers are unchanged — it is NOT one of these tokens);
 *  - `host-budget-unknown` — the ledger could not be trusted; the dispatcher
 *    failed closed and repairs the ledger from live state.
 */
export const HOST_BUDGET_IMPLEMENT_REASON = 'host-budget-implement';
/** Audit-tier counterpart of {@link HOST_BUDGET_IMPLEMENT_REASON}. */
export const HOST_BUDGET_AUDIT_REASON = 'host-budget-audit';
/** The ledger could not be trusted (fail closed + repair). */
export const HOST_BUDGET_UNKNOWN_REASON = 'host-budget-unknown';

/** Every host-budget decision reason, in the order they are documented. */
export const HOST_BUDGET_DECISION_REASONS = [
  HOST_BUDGET_IMPLEMENT_REASON,
  HOST_BUDGET_AUDIT_REASON,
  HOST_BUDGET_UNKNOWN_REASON,
] as const;

/** One of the host-budget refusal tokens. */
export type HostBudgetDecisionReason = (typeof HOST_BUDGET_DECISION_REASONS)[number];

/**
 * True when `reason` is a host-budget refusal token.
 *
 * Used by the dispatcher to decide whether a no-dispatch outcome is a budget
 * refusal (emit the `Downtime … tier skipped: <reason>` stderr line, attach
 * the `budget` evidence) and by the starvation tracker's feeder to keep an
 * operator-imposed budget stop OUT of the capacity-starvation episode
 * (WL-0MVXY0ZYW009NEJD AC6).
 */
export function isHostBudgetDecisionReason(
  reason: unknown,
): reason is HostBudgetDecisionReason {
  return (
    typeof reason === 'string' &&
    (HOST_BUDGET_DECISION_REASONS as readonly string[]).includes(reason)
  );
}

/**
 * Host-budget evidence figure carried on a decision entry (F5 AC1): the
 * tier's observed in-flight count and the cap it was compared against.
 *
 * The same `{ live, max }` shape the dispatcher's dispatch outcome reports, so
 * the decision log, the stderr skip line and the worklist counter quote one
 * set of numbers.
 */
export interface HostBudgetEvidence {
  live: number;
  max: number;
}
