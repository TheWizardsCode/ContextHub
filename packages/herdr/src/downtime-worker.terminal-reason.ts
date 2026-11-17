/**
 * packages/herdr/src/downtime-worker.terminal-reason.ts — the leader's
 * terminal-reason precedence chain.
 *
 * Extracted verbatim from `downtime-worker.coordination-leader.ts` (work item
 * WL-0MWDVN2HN004CQ1O) so the tier-aware offer iteration fits inside the
 * 1,000-line split-guard ceiling. Responsibility: ONE pure decision — when
 * nothing dispatched, why? It reads only the hold flags the tick already
 * recorded; it never fetches, gates or dispatches anything, and it is a
 * sibling of the offer-selection module rather than a second gate definition.
 *
 * Precedence (module contract; WL-0MWBT76WY00298AY AC5, extended by
 * WL-0MWDDHVF2004PTYX AC2): `code-freeze` → CPU → review-queue → non-terminal
 * cooldown → attempt budget → in-flight → leaf-audit pin → AUDIT budget → host
 * budget → `no-candidate`. The audit-budget rung sits ABOVE the host-budget
 * rung because an audit refusal with `detail: 'http-404'` is a BROKEN PROXY
 * CONTRACT, not the weakest ambient statement — it must never be masked by
 * `host-budget-implement`. The host-budget rung stays last: it is the weakest,
 * most ambient statement ("some budgeted candidate was refused this tick").
 * Any stronger hold that also fired keeps its own reason; with no other hold,
 * the neutral refusal (its `{live, max}` evidence, and the failing exchange on
 * `detail` for an audit-budget refusal) is reported instead of `no-candidate`,
 * so no cooldown/strike is recorded.
 */

import { LEAF_AUDIT_PIN_HOLD_REASON } from './downtime-worker.constants.js';
import type { DowntimeDispatchOutcome } from './downtime-worker.dispatch-contract.js';
import { CPU_SATURATED_REASON } from './downtime-worker.dispatch-cpu-gate.js';
import { REVIEW_QUEUE_HOLD_REASON } from './downtime-worker.gates.js';
import type { HeadScanHolds } from './downtime-worker.head-scan.js';

/** Everything the precedence chain reads: the flags + evidence a tick recorded. */
export interface TerminalReasonInput {
  frozen: boolean;
  cpuHold: boolean;
  /** CPU gate evidence spread into the refusal (empty when the gate is open). */
  cpuEvidence: object;
  /** Holds recorded by the own-head scan (fallback, sweep, batch continuation). */
  ownHeadHolds: HeadScanHolds;
  reviewHold: boolean;
  cooldownHold: boolean;
  budgetHold: boolean;
  inFlightHold: boolean;
  pinHeld: boolean;
  /** `undefined` = no relaxed leaf-audit tick, so the pin rung is not armed. */
  pinnedAuditItemId: string | undefined;
  /** First audit-budget refusal recorded by this tick's offer path. */
  auditBudgetHold: DowntimeDispatchOutcome | undefined;
  /** First host-budget refusal recorded by this tick's offer path. */
  hostBudgetHold: DowntimeDispatchOutcome | undefined;
}

/**
 * Resolve the neutral terminal outcome for a tick that dispatched nothing.
 * Pure: same input, same output — no I/O, no side effects.
 */
export function resolveTerminalOutcome(input: TerminalReasonInput): DowntimeDispatchOutcome {
  const { ownHeadHolds } = input;
  if (input.frozen) return { dispatched: false, reason: 'code-freeze' };
  if (input.cpuHold || ownHeadHolds.cpu) {
    return { ...input.cpuEvidence, dispatched: false, reason: CPU_SATURATED_REASON };
  }
  if (input.reviewHold || ownHeadHolds.review) {
    return { dispatched: false, reason: REVIEW_QUEUE_HOLD_REASON };
  }
  if (input.cooldownHold || ownHeadHolds.cooldown) {
    return { dispatched: false, reason: 'non-terminal-cooldown' };
  }
  if (input.budgetHold || ownHeadHolds.budget) {
    return { dispatched: false, reason: 'attempt-budget-exhausted' };
  }
  if (input.inFlightHold || ownHeadHolds.inFlight) {
    return { dispatched: false, reason: 'in-flight-pane' };
  }
  // A relaxed leaf-audit tick reserved its single free slot for the pinned
  // audit item: that reservation — not an empty backlog — is the reason
  // (parity with the direct path, C4/C5). Neutral, so no no-candidate
  // cooldown and no strike.
  if (input.pinHeld || input.pinnedAuditItemId !== undefined) {
    return { dispatched: false, reason: LEAF_AUDIT_PIN_HOLD_REASON };
  }
  // AUDIT-budget refusal (WL-0MWDDHVF2004PTYX AC1/AC2): the proxy-owned audit
  // budget stopped the audit tier. Neutral — no cooldown, no strike; the next
  // idle tick re-checks. Reported BEFORE any implement/host-budget hold so a
  // broken proxy contract (`audit-budget-unknown` + `detail: 'http-404'`) is
  // never masked by `host-budget-implement`.
  if (input.auditBudgetHold !== undefined) return input.auditBudgetHold;
  const ownAudit = ownHeadHolds.auditBudget;
  if (ownAudit !== undefined) {
    return {
      dispatched: false,
      reason: ownAudit.reason,
      ...(ownAudit.budget !== undefined ? { budget: ownAudit.budget } : {}),
      ...(ownAudit.detail !== undefined ? { detail: ownAudit.detail } : {}),
    };
  }
  // Host-budget refusal (F3 AC5): a machine-wide cap, not an empty backlog,
  // stopped the budgeted tier. Neutral — no cooldown, no strike; the next idle
  // tick re-checks the ledger.
  if (input.hostBudgetHold !== undefined) return input.hostBudgetHold;
  const ownHost = ownHeadHolds.hostBudget;
  if (ownHost !== undefined) {
    return {
      dispatched: false,
      reason: ownHost.reason,
      ...(ownHost.budget !== undefined ? { budget: ownHost.budget } : {}),
    };
  }
  return { dispatched: false, reason: 'no-candidate' };
}
