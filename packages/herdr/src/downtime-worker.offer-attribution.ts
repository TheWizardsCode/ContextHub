/**
 * packages/herdr/src/downtime-worker.offer-attribution.ts — machine-readable
 * attribution for EMPTY OFFERS and SKIPPED TIERS.
 *
 * Work item: WL-0MVR8FKMU009XTED (parent WL-0MVR8EXR6009F05V).
 *
 * ## Why this module exists
 *
 * Three different roots failed to dispatch for three completely unrelated
 * reasons and all three produced the same log output: `workItemId: null` at
 * the check-in and a bare `no-candidate` at the leader. Diagnosing it required
 * reading the dispatcher's source and classifying 85 window items by hand.
 *
 * This module owns the STABLE vocabulary that makes a starved root
 * self-diagnosing:
 *
 *  - {@link DispatchGateToken} — why ONE candidate/offer was rejected
 *    (`assignee-hold`, `code-freeze`, `audit-slot-min`, …);
 *  - {@link EmptyOfferReason} — why a whole window produced no offer
 *    (`empty-window`, `all-window-items-held`, `all-window-items-gated`, …);
 *  - {@link summariseEmptyOffer} — the aggregation from per-item gate tokens
 *    to the empty-offer reason (including the sentinel values observed when
 *    the whole window is held);
 *  - `classifyWindowHold` / `heldAssigneesOf` — the SHARED classification
 *    helper the coordination-log token and the Herdr worklist surface both
 *    consume (child WL-0MVR8FN1D002SCIR reuses it; it must not re-derive the
 *    buckets). It lives in `downtime-worker.selection.ts` next to its only
 *    primitive `isAssigneeHeld`, so this module never imports back into the
 *    selection module (split-family import-cycle gate).
 *
 * ## Additive-only contract
 *
 * Nothing here decides anything: the tokens are derived from gates that have
 * already rejected the candidate, so a run with identical inputs dispatches
 * identically before and after. The vocabulary is stable (asserted in tests
 * and read by operators), and new tokens describe a SKIP/OBSERVATION, never a
 * new refusal.
 */

/**
 * Stable machine-readable token naming the gate that rejected one
 * candidate/offer. Every value is a promise to operators reading the decision
 * log, so they are never renamed (additions only).
 */
export type DispatchGateToken =
  /** `wl delete` set `deletedBy` (soft-deleted item). */
  | 'soft-deleted'
  /** `needsProducerReview` is set. */
  | 'producer-review'
  /** A non-empty `assignee` scheduling hold (producer sentinel `Map` …). */
  | 'assignee-hold'
  /** Status/stage shape is not dispatchable at any tier. */
  | 'not-dispatchable'
  /** Completed/in_review but a fresh audit already exists. */
  | 'audit-fresh'
  /** Completed/in_review but outside the audit recency window. */
  | 'audit-recency'
  /** `plan_complete` with an effort above the implement cap. */
  | 'effort-cap'
  /** A fresh dispatched marker still excludes the item (already dispatched). */
  | 'dispatched-marker'
  /** The per-item/per-kind dispatch-attempt budget is exhausted. */
  | 'attempt-budget-exhausted'
  /** The non-terminal pane-close cooldown still holds the item. */
  | 'non-terminal-cooldown'
  /** Code-freeze split-by-skill paused the audit/implement/risk-effort offer. */
  | 'code-freeze'
  /** The host-CPU gate refused new audit/implement work. */
  | 'cpu-saturated'
  /** The raw slot budget is below the tier's free-slot minimum (audit ≥ 2). */
  | 'audit-slot-min'
  /** The root's review queue is deep (non-critical implement held). */
  | 'review-queue-hold'
  /** A live working pane already exists for the (critical) item. */
  | 'in-flight-pane'
  /** No slot can host a pane this cycle (single-pane tier minimum unmet). */
  | 'slots-unavailable'
  /** The item could not be read (wl/CLI failure) — entry kept, fail-open. */
  | 'wl-error';

/**
 * The subset of {@link DispatchGateToken} produced by
 * `classifyItemForDispatch` when it maps an item to `null`. Kept as its own
 * union so the classifier's contract stays precise.
 */
export type ClassifyGateToken =
  | 'soft-deleted'
  | 'producer-review'
  | 'assignee-hold'
  | 'not-dispatchable'
  | 'audit-fresh'
  | 'audit-recency'
  | 'effort-cap';

/**
 * Stable machine-readable token naming WHY an offer computation produced
 * nothing. `empty-window`, `all-window-items-held` and `all-window-items-gated`
 * are new (WL-0MVR8FKMU009XTED); the remaining values reuse the terminal
 * vocabulary the dispatcher already published so existing consumers keep
 * working.
 */
export type EmptyOfferReason =
  /** The Herdr head lookup returned no items at all. */
  | 'empty-window'
  /** Every item in the window was rejected SOLELY by a non-empty assignee. */
  | 'all-window-items-held'
  /** Items were rejected by other gates; `dominantGate` names the leader. */
  | 'all-window-items-gated'
  /** Every rejection was the code-freeze split-by-skill pause. */
  | 'code-freeze'
  /** Every rejection was the deep review-queue hold. */
  | 'review-queue-hold'
  /** Every rejection was the per-item/per-kind attempt budget. */
  | 'attempt-budget-exhausted'
  /** Every rejection was the critical in-flight guard. */
  | 'in-flight-hold'
  /** Every rejection was the non-terminal pane-close cooldown. */
  | 'non-terminal-cooldown'
  /** A stalled pane was resumed in place, so no new offer was made. */
  | 'stalled-resume'
  /** No slot could host a pane (single-pane tier minimum unmet). */
  | 'slots-unavailable'
  /** The offer computation failed (wl/CLI error) — the entry is kept. */
  | 'wl-error';

/** One rejected candidate of an offer computation (in-memory attribution). */
export interface OfferRejection {
  /** The rejected work item's id. */
  itemId: string;
  /** The gate that rejected it. */
  gate: DispatchGateToken;
  /** The item's assignee when the gate was the scheduling hold. */
  assignee?: string;
}

/**
 * One offer the LEADER rejected at dispatch time (AC2). Logged on the
 * decision entry so a per-entry rejection can never be collapsed into a bare
 * `no-candidate`.
 */
export interface CoordinationOfferRejection {
  workItemId: string;
  worklogRoot: string;
  gate: DispatchGateToken;
  /** The offered item's assignee when it was a scheduling hold. */
  assignee?: string;
}

/** Aggregated, machine-readable explanation of an empty offer. */
export interface EmptyOfferAttribution {
  reason: EmptyOfferReason;
  /** Candidates inspected in the dispatch window(s) before the empty verdict. */
  windowSize: number;
  /** Distinct non-empty assignees observed on an all-held window (sorted). */
  heldAssignees?: string[];
  /** Gate that rejected the most candidates (`all-window-items-gated`). */
  dominantGate?: DispatchGateToken;
  /** Per-gate rejection counts, so "which gate dominated" is exact. */
  gateCounts?: Partial<Record<DispatchGateToken, number>>;
}

/**
 * Gate tokens that have a dedicated whole-window `EmptyOfferReason`: when
 * EVERY rejection shares one of these, the reason is the specific token
 * instead of the generic `all-window-items-gated`.
 */
const SOLE_GATE_REASON: Partial<Record<DispatchGateToken, EmptyOfferReason>> = {
  'code-freeze': 'code-freeze',
  'review-queue-hold': 'review-queue-hold',
  'attempt-budget-exhausted': 'attempt-budget-exhausted',
  'in-flight-pane': 'in-flight-hold',
  'non-terminal-cooldown': 'non-terminal-cooldown',
};

/** Distinct non-empty assignee strings of the given candidates (sorted). */
function uniqueNonEmpty(values: ReadonlyArray<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = (value ?? '').trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen].sort();
}

/** True when every rejection was the assignee scheduling hold (and ≥ 1). */
export function isWindowFullyHeld(
  rejections: ReadonlyArray<{ gate: DispatchGateToken }>,
): boolean {
  return rejections.length > 0 && rejections.every((r) => r.gate === 'assignee-hold');
}

/**
 * The gate that rejected the most candidates. Ties resolve to the FIRST gate
 * encountered, which is deterministic because the window is scanned in
 * canonical (Herdr head) order.
 */
export function dominantGateOf(
  rejections: ReadonlyArray<{ gate: DispatchGateToken }>,
): DispatchGateToken | null {
  const counts = new Map<DispatchGateToken, number>();
  let best: DispatchGateToken | null = null;
  let bestCount = 0;
  for (const rejection of rejections) {
    const next = (counts.get(rejection.gate) ?? 0) + 1;
    counts.set(rejection.gate, next);
    if (next > bestCount) {
      best = rejection.gate;
      bestCount = next;
    }
  }
  return best;
}

/** Per-gate rejection counts (deterministic insertion order). */
function gateCountsOf(
  rejections: ReadonlyArray<{ gate: DispatchGateToken }>,
): Partial<Record<DispatchGateToken, number>> {
  const counts: Partial<Record<DispatchGateToken, number>> = {};
  for (const rejection of rejections) {
    counts[rejection.gate] = (counts[rejection.gate] ?? 0) + 1;
  }
  return counts;
}

/**
 * Aggregate the per-candidate rejections of one offer computation into the
 * empty-offer attribution (AC1):
 *
 *  - `empty-window` — the head lookup returned nothing;
 *  - `all-window-items-held` — every candidate was rejected by the assignee
 *    hold alone (carries `.heldAssignees`, e.g. `['Map']`);
 *  - a dedicated token when every rejection shares one ({@link SOLE_GATE_REASON});
 *  - `all-window-items-gated` otherwise, carrying `dominantGate` + `gateCounts`.
 */
export function summariseEmptyOffer(offer: {
  windowSize: number;
  rejections: ReadonlyArray<OfferRejection>;
}): EmptyOfferAttribution {
  const { windowSize, rejections } = offer;
  if (windowSize === 0 || rejections.length === 0) {
    return { reason: 'empty-window', windowSize };
  }
  const gateCounts = gateCountsOf(rejections);
  const dominantGate = dominantGateOf(rejections) ?? undefined;
  if (isWindowFullyHeld(rejections)) {
    return {
      reason: 'all-window-items-held',
      windowSize,
      heldAssignees: uniqueNonEmpty(rejections.map((r) => r.assignee)),
      dominantGate,
      gateCounts,
    };
  }
  const soleGate = Object.keys(gateCounts).length === 1 ? rejections[0]?.gate : undefined;
  const soleReason = soleGate === undefined ? undefined : SOLE_GATE_REASON[soleGate];
  if (soleReason !== undefined) {
    return { reason: soleReason, windowSize, dominantGate, gateCounts };
  }
  return { reason: 'all-window-items-gated', windowSize, dominantGate, gateCounts };
}

/**
 * Attach per-entry rejections to an outcome, only when there are any — every
 * other outcome keeps its byte-identical shape (additive-only).
 */
export function withOfferRejections<T extends object>(
  outcome: T,
  rejections: readonly CoordinationOfferRejection[],
): T & { offerRejections?: CoordinationOfferRejection[] } {
  return rejections.length === 0 ? outcome : { ...outcome, offerRejections: [...rejections] };
}
