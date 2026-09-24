/**
 * packages/herdr/src/pane-lifecycle.ts — Pane-lifecycle monitor (pure logic)
 *
 * Supporting logic for the downtime worker's automatic pane lifecycle
 * management (WL-0MU308WSF0002JWN): dispatched panes stay open forever
 * unless an operator closes them manually. This module classifies each
 * dispatched pane's current state into a lifecycle outcome and decides
 * whether the pane should be auto-closed (everything except `implement`,
 * which is never auto-closed — AC6).
 *
 * The module is deliberately PURE (no fs / no herdr / no wl): the worker
 * gathers the dispatch markers + current item states, this module decides,
 * and the worker performs the log append + pane close. That keeps the
 * decision logic trivially testable and the fail-closed I/O at the
 * orchestration boundary.
 *
 * Outcomes (AC1):
 *  - `closed-as-intake-complete` — an `intake` pane's item reached
 *    `intake_complete` (or beyond).
 *  - `closed-as-plan-complete` — a `plan`/`risk-effort` pane's item reached
 *    `plan_complete` (risk-effort additionally requires risk+effort set).
 *  - `audit-passed` / `audit-failed` — an `audit` pane's item has a
 *    recorded audit result (`readyToClose`).
 *  - `requires-attention` — the pane ended (or is blocked) without reaching
 *    a closeable terminal: agent session ended early, an item awaiting
 *    producer review, an audit that never recorded a result, or an
 *    `implement` pane that reached `in_review` (logged, NOT closed — AC4).
 */

import type { DowntimeLogEntry, PaneLifecycleKind } from './downtime-log.js';

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Stable machine-readable reason for a lifecycle decision. Used as part of
 * the idempotency key so a state CHANGE (e.g. `requires-attention` because
 * the agent ended → `requires-attention` because the item later reached
 * `in_review`) is logged again while a repeated identical state is not
 * (intake Q&A: "if the pane is still open and the item changes again, log
 * the new state").
 */
export type PaneLifecycleReasonCode =
  | 'none'
  | 'agent-ended-no-terminal'
  | 'reached-in-review'
  | 'audit-ended-no-result'
  | 'risk-effort-incomplete'
  | 'producer-review';

/**
 * One dispatched pane reconstructed from the rolling dispatch log. The
 * enrichment entry (WL-0MUBVL251006JAQ0) records `paneId` alongside the
 * marker fields; a dispatch with no enrichment (older entries, or a failed
 * pane-id resolution) cannot be auto-closed.
 */
export interface DispatchedPane {
  itemId: string;
  itemTitle: string;
  paneId: string;
  kind: PaneLifecycleKind;
  dispatchedAt: string;
  /** Worklog stage at dispatch (change-guard marker). */
  stage?: string;
}

/**
 * The subset of the current work-item state the lifecycle classifier
 * consults. Every field is optional / tolerant so a partially fetched or
 * malformed item never throws.
 */
export interface PaneItemState {
  id: string;
  title?: string;
  status?: string;
  stage?: string;
  risk?: string;
  effort?: string;
  auditedAt?: string | null;
  /**
   * Recorded audit verdict (`readyToClose`). `false` explicitly means the
   * audit FAILED; `true`/`null`/absent (with an `auditedAt`) means passed
   * (an audit with no recorded readyToClose is treated as a pass — the
   * historical default, WL-0MTH7G2O1004BHN5).
   */
  auditResult?: boolean | null;
  needsProducerReview?: boolean;
  /** Agent session state for the pane (idle/working/blocked/done/unknown). */
  agentState?: string;
}

/** A decision for one dispatched pane. */
export interface PaneLifecycleDecision {
  outcome: import('./downtime-log.js').PaneLifecycleOutcome;
  /** Human-readable summary reason (always populated). */
  reason: string;
  /** Stable idempotency reason code. */
  reasonCode: PaneLifecycleReasonCode;
  /** Whether the worker should close the pane. `false` only for `implement`. */
  close: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────

/** Worklog stage rank — higher means further through the lifecycle. */
const STAGE_RANK: Record<string, number> = {
  idea: 0,
  intake_complete: 1,
  plan_complete: 2,
  in_review: 3,
};

/** The dispatch kinds the pane-lifecycle monitor manages. */
const LIFECYCLE_KINDS: readonly PaneLifecycleKind[] = [
  'plan',
  'intake',
  'audit',
  'risk-effort',
  'implement',
];

// ── Helpers ───────────────────────────────────────────────────────────

function isLifecycleKind(kind: unknown): kind is PaneLifecycleKind {
  return typeof kind === 'string' && (LIFECYCLE_KINDS as readonly string[]).includes(kind);
}

function stageRank(stage: string | undefined): number {
  if (typeof stage !== 'string') return -1;
  return STAGE_RANK[stage] ?? -1;
}

/**
 * AC6: `implement` panes are NEVER auto-closed — the operator closes them
 * manually. Every other kind (plan / intake / audit / risk-effort) is
 * auto-closed once its lifecycle outcome is determined.
 */
export function shouldAutoClosePane(kind: PaneLifecycleKind): boolean {
  return kind !== 'implement';
}

/**
 * Build the idempotency key for one (pane, outcome, reason) triple. A
 * pane-close entry with a matching key suppresses a duplicate log entry on
 * a later tick.
 */
export function paneLifecycleKey(
  paneId: string,
  outcome: string,
  reasonCode: string,
): string {
  return `${paneId}::${outcome}::${reasonCode}`;
}

// ── Collection from the rolling log ───────────────────────────────────

/**
 * Reconstruct the set of dispatched panes from the rolling dispatch log:
 * every entry that carries BOTH an `itemId` and a resolved `paneId` of a
 * managed kind. Spawn-failed entries are excluded (the pane never
 * appeared). The LAST entry per pane id wins (a re-dispatch updates the
 * marker), so the returned list holds at most one record per pane.
 */
export function collectDispatchedPanes(entries: DowntimeLogEntry[]): DispatchedPane[] {
  const byPane = new Map<string, DispatchedPane>();
  for (const e of entries) {
    if (e.outcome === 'spawn-failed') continue;
    if (!isLifecycleKind(e.kind)) continue;
    if (typeof e.itemId !== 'string' || e.itemId === '') continue;
    if (typeof e.paneId !== 'string' || e.paneId === '') continue;
    byPane.set(e.paneId, {
      itemId: e.itemId,
      itemTitle: typeof e.title === 'string' && e.title !== '' ? e.title : e.itemId,
      paneId: e.paneId,
      kind: e.kind,
      dispatchedAt: typeof e.dispatchedAt === 'string' ? e.dispatchedAt : '',
      stage: typeof e.stage === 'string' ? e.stage : undefined,
    });
  }
  return [...byPane.values()];
}

/**
 * Build the set of lifecycle keys already recorded in the log, so the
 * monitor never writes a duplicate pane-close entry for an unchanged state.
 */
export function loggedPaneLifecycleKeys(entries: DowntimeLogEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const e of entries) {
    if (e.entryType !== 'pane-close') continue;
    if (typeof e.paneId !== 'string' || e.paneId === '') continue;
    const outcome = typeof e.outcome === 'string' ? e.outcome : '';
    const reasonCode = typeof e.reasonCode === 'string' ? e.reasonCode : 'none';
    keys.add(paneLifecycleKey(e.paneId, outcome, reasonCode));
  }
  return keys;
}

// ── Classification ────────────────────────────────────────────────────

function decision(
  kind: PaneLifecycleKind,
  outcome: PaneLifecycleDecision['outcome'],
  reason: string,
  reasonCode: PaneLifecycleReasonCode,
): PaneLifecycleDecision {
  return { outcome, reason, reasonCode, close: shouldAutoClosePane(kind) };
}

/**
 * Classify one dispatched pane's lifecycle outcome from its current item
 * state. Returns `null` when the pane has not yet reached any terminal or
 * attention state (i.e. the agent is still legitimately working) — the
 * caller logs/closes nothing this tick.
 *
 * `agentDone` is the authoritative "the pane's agent session has ended"
 * signal (the pane is gone from `herdr agent list`, or reported `done`);
 * it is passed explicitly so the pure classifier never queries herdr.
 *
 * Precedence (first match wins):
 *  1. audit result recorded (`auditedAt`)            → audit-passed/failed (AC5)
 *  2. kind terminal reached                          → closed-as-* (AC2); for
 *     `implement` this is `in_review` and is logged only, never closed (AC4/AC6)
 *  3. item awaiting producer review                  → requires-attention (AC3)
 *  4. agent session ended without a terminal         → requires-attention (AC3)
 *  5. otherwise                                      → null (still running)
 */
export function classifyPaneLifecycle(
  dispatch: DispatchedPane,
  item: PaneItemState | null,
  agentDone: boolean,
): PaneLifecycleDecision | null {
  const kind = dispatch.kind;
  const title = item?.title ?? dispatch.itemTitle;

  // 1. Audit panes (AC5): complete when the item has a recorded audit.
  if (kind === 'audit') {
    if (item && typeof item.auditedAt === 'string' && item.auditedAt !== '') {
      const passed = item.auditResult !== false;
      return decision(
        kind,
        passed ? 'audit-passed' : 'audit-failed',
        passed
          ? `audit recorded for ${title} — passed`
          : `audit recorded for ${title} — failed`,
        'none',
      );
    }
    if (item?.needsProducerReview === true) {
      return decision(
        kind,
        'requires-attention',
        `${title} is awaiting producer review before the audit can complete`,
        'producer-review',
      );
    }
    if (agentDone) {
      return decision(
        kind,
        'requires-attention',
        `audit agent session ended without recording an audit result for ${title}`,
        'audit-ended-no-result',
      );
    }
    return null; // audit still in flight
  }

  // 2. Kind terminal reached.
  if (item) {
    const rank = stageRank(item.stage);
    if (kind === 'intake' && rank >= stageRank('intake_complete')) {
      return decision(
        kind,
        'closed-as-intake-complete',
        `${title} advanced to ${item.stage ?? 'intake_complete'} — intake complete`,
        'none',
      );
    }
    if (kind === 'plan' && rank >= stageRank('plan_complete')) {
      return decision(
        kind,
        'closed-as-plan-complete',
        `${title} advanced to ${item.stage ?? 'plan_complete'} — plan complete`,
        'none',
      );
    }
    if (kind === 'risk-effort') {
      const populated =
        typeof item.risk === 'string' && item.risk !== '' &&
        typeof item.effort === 'string' && item.effort !== '';
      if (rank >= stageRank('plan_complete') && populated) {
        return decision(
          kind,
          'closed-as-plan-complete',
          `${title} has risk/effort populated at ${item.stage ?? 'plan_complete'} — risk-effort complete`,
          'none',
        );
      }
      if (agentDone && rank >= stageRank('plan_complete') && !populated) {
        return decision(
          kind,
          'requires-attention',
          `risk-effort agent session ended without populating risk/effort for ${title}`,
          'risk-effort-incomplete',
        );
      }
      if (agentDone) {
        return decision(
          kind,
          'requires-attention',
          `risk-effort agent session ended before reaching plan_complete for ${title}`,
          'agent-ended-no-terminal',
        );
      }
      return null;
    }
    // implement (AC4/AC6): reaching in_review completes the implementation
    // but the pane is NEVER auto-closed — log the event for the operator.
    if (kind === 'implement' && rank >= stageRank('in_review')) {
      return decision(
        kind,
        'requires-attention',
        `${title} reached in_review — implement panes are not auto-closed (AC6); close manually`,
        'reached-in-review',
      );
    }
  }

  // 3. Producer-review gate (AC3): a review-blocked item is not making
  // progress — flag it so the pane does not linger silently.
  if (item?.needsProducerReview === true) {
    return decision(
      kind,
      'requires-attention',
      `${title} is awaiting producer review`,
      'producer-review',
    );
  }

  // 4. Agent session ended without reaching a closeable terminal (AC3).
  if (agentDone) {
    return decision(
      kind,
      'requires-attention',
      `${title} agent session ended without reaching a terminal stage`,
      'agent-ended-no-terminal',
    );
  }

  // 5. Still running.
  return null;
}
