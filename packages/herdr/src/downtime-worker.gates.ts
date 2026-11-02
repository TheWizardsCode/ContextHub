/**
 * packages/herdr/src/downtime-worker.gates.ts — dispatchability gates for the
 * downtime worker.
 *
 * Single responsibility: every decision that answers "may the worker dispatch
 * this item right now?" — the dispatch-tier classifier
 * (`classifyItemForDispatch`, which applies the soft-delete, assignee and
 * producer-review holds owned by `downtime-worker.selection.ts`), the
 * leaf-vs-parent audit-scope classifier (`classifyAuditScope`, the fail-closed
 * mapping every leaf-aware audit gate reads), the per-item leaf-aware audit
 * slot minimum (`auditItemEligible`, parent WL-0MSORQ8Y4004YT63 C3), the
 * critical-first escalation guard, the audit-batch depth/cap status, the
 * review-queue depth gate, the critical-only window-extension escape hatch and
 * the per-item dispatch-attempt budget.
 *
 * Moved verbatim out of `downtime-worker.ts` (parent WL-0MVF3F9A7000HKP7;
 * child WL-0MVLIHZZI004D7EK). No behaviour change: gate ordering, fail-closed
 * defaults, hold reason strings, the `needsProducerReview` exclusion,
 * non-terminal cooldown semantics and the review-queue depth arithmetic are
 * all unchanged. Every work-item provenance comment below travels with the
 * code it documents.
 *
 * Layering: this module imports only concrete siblings (constants, types,
 * selection, `downtime-log`) — never `./downtime-worker.js` (the barrel
 * re-exports it, so an edge back would invert the layering). It also performs
 * no value import of `./stalled-work.js` (the pre-existing `stalled-work ↔
 * downtime-worker` cycle stays type-only), so no runtime cycle can form — which
 * is why `isAttemptBudgetExhausted`, which `stalled-work.ts` imports back, is
 * safe to host here.
 *
 * The two deps-taking signatures name the dependency slice they read
 * ({@link DowntimeGateDeps}, {@link AuditBatchOutcomeShape}) structurally, the
 * same convention the pane module uses, because `DowntimeWorkerDeps` and
 * `DowntimeDispatchOutcome` still live in the barrel. Every caller keeps
 * passing the full deps/outcome object unchanged.
 */

import { isAuditFresh } from '@worklog/shared/icons';
import {
  DEFAULT_BROWSE_ITEM_COUNT,
  DOWNTIME_AUDIT_MIN_FREE_SLOTS,
  DOWNTIME_AUDIT_RECENCY_WINDOW_MS,
  DOWNTIME_DISPATCH_EXTEND_MAX,
  DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS,
} from './downtime-worker.constants.js';
import {
  countAttempts as _countAttempts,
  type DowntimeLogEntry,
} from './downtime-log.js';
import {
  effortOrdinal,
  isAssigneeHeld,
  isSoftDeleted,
  riskOrdinal,
} from './downtime-worker.selection.js';
import type { ClassifyGateToken } from './downtime-worker.offer-attribution.js';
import type {
  CriticalFirstGuardDecision,
  DowntimeActiveAuditResult,
  DowntimeClaimExpected,
  DowntimeDispatchKind,
  DowntimeHerdrItem,
  DowntimeHerdrListResult,
  DowntimeItemInfo,
  DowntimeItemResult,
  DowntimeNextResult,
  DowntimeSkillKind,
  InFlightPanes,
} from './downtime-worker.types.js';

/**
 * The gates-facing slice of `DowntimeWorkerDeps` — the only dependency
 * boundaries the helpers below touch, named structurally so this module never
 * imports the barrel (`DowntimeWorkerDeps` lives in `downtime-worker.ts`).
 *
 * Every member is the same optional method `DowntimeWorkerDeps` declares, so
 * callers keep passing the full deps object unchanged: the review-queue
 * reader's `deps.getReviewQueueCount`, the window-extension's
 * `deps.getHerdrListHead` and the budget flag's optional
 * `deps.markNeedsProducerReview`. Naming only what is called here keeps the
 * layering acyclic without changing any call site or any runtime behaviour.
 */
export interface DowntimeGateDeps {
  /**
   * Herdr list head fetch (WL-0MTK1ILM2009QYB2): the canonical ranking
   * (fetcher → smart-selection → grouping). Returns ordered candidates
   * (already ranked); dispatcher applies safety gates as sequential filters.
   * Fail-closed `{ok:false}` on a wl/parse failure (a strike), otherwise
   * `{ok:true, items:[…]}` (empty when genuinely empty).
   */
  getHerdrListHead(cwd: string, limit?: number): Promise<DowntimeHerdrListResult>;
  /**
   * Count completed/in_review root items for the review-queue depth gate
   * (WL-0MT2UQWOR007CYY9): `wl list --status completed --stage in_review
   * --root-only --json`, bounded by `DOWNTIME_WL_TIMEOUT_MS`. Returns the
   * count, or `null` on failure — a failure means "gate active" (only
   * critical implements remain eligible), consistent with the code-freeze
   * ambiguous ⇒ frozen convention.
   */
  getReviewQueueCount(cwd: string): Promise<number | null>;
  /**
   * Best-effort producer-review flag write for a budget-exhausted item
   * (WL-0MUKYEXMK0033MFK AC3): marks the item `needsProducerReview` so a
   * human decides whether the dispatch budget should be extended. Optional:
   * a missing dep is fail-open (the budget filter still skips the item).
   */
  markNeedsProducerReview?(itemId: string, cwd: string): Promise<boolean>;
  /**
   * Leaf-vs-parent scope lookup for an audit candidate (parent
   * WL-0MSORQ8Y4004YT63 C1/C2, see `DowntimeWorkerDeps.
   * getAuditCandidateScope`). Consulted ONLY in the leaf-audit slot band by
   * {@link auditItemEligible}; optional so a deps object without it degrades
   * fail-closed (treated as a parent).
   */
  getAuditCandidateScope?(itemId: string, cwd: string): Promise<AuditCandidateScopeResult>;
}

/**
 * The `DowntimeDispatchOutcome` slice {@link finalizeAuditBatchOutcome} reads
 * and writes, named structurally so this module never imports the barrel
 * (`DowntimeDispatchOutcome` lives in `downtime-worker.ts`). The generic
 * preserves the caller's full outcome type at every call site.
 */
export interface AuditBatchOutcomeShape {
  dispatched: boolean;
  kind?: DowntimeDispatchKind;
  reason?: string;
  auditBatch?: DowntimeAuditBatchStatus;
}

/**
 * Decide whether a critical-first candidate may be escalated, given the
 * item-scoped in-flight state and the dispatched-marker age.
 *
 * Replaces the previously UNCONDITIONAL marker bypass (WL-0MU6UL3XY001M3VT)
 * with a layered bound that is neither blind fail-closed nor blind fail-open
 * (parent WL-0MUBEZ6PE002WLP4, approved plan Q4):
 *
 *  1. a live `working` pane for the item        → SKIP  (`in-flight-pane`)
 *  2. query succeeded and found no live pane    → ESCALATE (`no-live-pane`)
 *  3. query failed/unparseable                  → fall back to the marker TTL:
 *       fresh marker (age <= staleWindow)       → SKIP  (`in-flight-unverified`)
 *       stale/absent marker                     → ESCALATE (`marker-stale-escalation`)
 *
 * This keeps the critical escalation path able to progress a genuinely stuck
 * item (AC3.1/AC3.2 — the 2026-09-18 starvation fix is preserved) while
 * making a duplicate impossible whenever a pane is PROVEN in-flight. A pane
 * query outage cannot starve escalation permanently: it only defers it until
 * the marker goes stale (bounded by `markerStaleWindowMs`).
 */
export function evaluateCriticalFirstGuard(
  itemId: string,
  inFlight: InFlightPanes,
  markerDispatchedAt: string | undefined,
  now: number,
  markerStaleWindowMs: number,
): CriticalFirstGuardDecision {
  if (inFlight.itemIds.has(itemId)) {
    return { escalate: false, reason: 'in-flight-pane' };
  }
  if (inFlight.available) {
    return { escalate: true, reason: 'no-live-pane' };
  }
  // The pane query could not prove in-flight state — defer to the marker TTL.
  let fresh = false;
  if (typeof markerDispatchedAt === 'string' && markerDispatchedAt !== '') {
    const dispatchedAt = Date.parse(markerDispatchedAt);
    fresh =
      Number.isFinite(dispatchedAt) &&
      now - dispatchedAt <= markerStaleWindowMs;
  }
  return fresh
    ? { escalate: false, reason: 'in-flight-unverified' }
    : { escalate: true, reason: 'marker-stale-escalation' };
}

/**
 * Depth-aware audit-batch status (parent WL-0MVEDM8OT007WDRS AC1/AC2/AC3).
 *
 * `depth` is the audit-eligible depth derived from the ALREADY-FETCHED Herdr
 * head (no extra `wl` subprocess); `cap` is the clamped
 * `downtimeAuditBatchMax`; `remaining` is the number of continuation audits
 * still available AFTER the dispatch that produced this status (0 when the
 * batch is inactive or its cap is consumed). `active` is true only while
 * batching is engaged: `depth >= browseItemCount`, `cap > 1` and a
 * continuation budget was available before the dispatch.
 */
export interface DowntimeAuditBatchStatus {
  active: boolean;
  depth: number;
  cap: number;
  remaining: number;
}

/**
 * Expected claim state per tier (RCA WL-0MSRBFFLN005W3VT design point 1):
 * the pre-dispatch claim only applies while the item is still in the exact
 * state the tier selected it in. The audit tier selects `completed` /
 * `in_review` items; every other tier selects `open` items at their stage.
 */
export const TIER_EXPECTED: Record<DowntimeSkillKind, DowntimeClaimExpected> = {
  audit: { status: 'completed', stage: 'in_review' },
  implement: { status: 'open', stage: 'plan_complete' },
  plan: { status: 'open', stage: 'intake_complete' },
  intake: { status: 'open', stage: 'idea' },
  'risk-effort': { status: 'open', stage: 'plan_complete' },
};

// ── Leaf-vs-parent audit scope (parent WL-0MSORQ8Y4004YT63, C1/C2) ────
//
// A leaf audit is a SINGLE Pi session (1 slot); a parent audit fans out to
// its children (2 slots at `AUDIT_PHASE2_PARALLELISM=1`). The scope lookup
// itself (`getAuditCandidateScope`, `wl show <id> --children --json`) is a
// dependency seam owned by the worker's dep boundary; everything below is
// the pure, exhaustively-tested mapping the dispatch gates consume.

/**
 * How much capacity an audit candidate needs: a `leaf` audit runs one session,
 * a `parent` audit fans out to its children (parent AC2/AC3,
 * WL-0MSORQ8Y4004YT63).
 */
export type AuditScope = 'leaf' | 'parent';

/**
 * Result of the audit-candidate scope lookup (`DowntimeWorkerDeps.
 * getAuditCandidateScope`). `{ ok: true, scope }` means a trustworthy
 * classification was made; `{ ok: false }` means the lookup could not be
 * trusted (CLI error, timeout, parse failure, missing/malformed `children`
 * payload, or a non-root candidate) and MUST be treated as a parent.
 *
 * Declared here (structurally, like {@link DowntimeGateDeps}) so the pure
 * classifier and its consumers never have to import the barrel.
 */
export interface AuditCandidateScopeResult {
  ok: boolean;
  scope?: AuditScope;
}

/**
 * Map an audit-candidate scope lookup to the scope the gates use.
 *
 * **Fail-closed** (parent AC1/AC3): anything other than an explicit, trusted
 * `'leaf'` — `{ ok: false }`, a missing `scope`, an unexpected token, or no
 * result at all — is a `'parent'`, so an untrustworthy lookup always restores
 * the conservative all-slots-style gate and never relaxes dispatch. Pure: no
 * I/O, no deps, exhaustively covered by
 * `downtime-worker.leaf-audit.test.ts`.
 */
export function classifyAuditScope(
  result: AuditCandidateScopeResult | null | undefined,
): AuditScope {
  if (!result || result.ok !== true) return 'parent';
  return result.scope === 'leaf' ? 'leaf' : 'parent';
}

/**
 * True when a free-slot count falls in the LEAF-AUDIT band — at or above the
 * leaf minimum and below the parent minimum (with the shipped constants:
 * exactly one free slot). Only this band requires a scope lookup; every other
 * count is decided by the slot number alone (parent WL-0MSORQ8Y4004YT63 C3).
 */
export function isLeafAuditSlotBand(freeSlots: number | undefined): boolean {
  if (freeSlots === undefined) return false;
  return (
    freeSlots >= DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS &&
    freeSlots < DOWNTIME_AUDIT_MIN_FREE_SLOTS
  );
}

/**
 * Per-item audit slot eligibility (parent WL-0MSORQ8Y4004YT63 C3).
 *
 * Replaces the tick-level `freeSlots >= DOWNTIME_AUDIT_MIN_FREE_SLOTS`
 * boolean with a per-CANDIDATE decision, because the minimum now depends on
 * the candidate's scope:
 *
 *  - `freeSlots === undefined` → eligible (direct-API fail-open, unchanged).
 *  - `freeSlots >= DOWNTIME_AUDIT_MIN_FREE_SLOTS` → eligible IMMEDIATELY and
 *    with NO scope lookup: the parent audit's minimum is untouched and the
 *    normal case adds zero extra `wl` calls (AC1).
 *  - `freeSlots < DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS` → ineligible with no
 *    lookup (no slot can host even a single-session audit).
 *  - leaf band (`DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS <= freeSlots <
 *    DOWNTIME_AUDIT_MIN_FREE_SLOTS`) → classify the candidate's scope and
 *    dispatch ONLY a trusted `'leaf'`. A `'parent'`, an `{ok:false}` lookup, a
 *    thrown/absent lookup or an unexpected token is skipped exactly as today
 *    (fail-closed, AC2).
 *
 * The same helper is the single definition every audit selection path shares,
 * so the decision for a given candidate/free-slot pair is identical on the
 * legacy tier chain, the Herdr head filter and the critical-first scan
 * (AC3).
 */
export async function auditItemEligible(
  deps: Pick<DowntimeGateDeps, 'getAuditCandidateScope'>,
  candidate: { id: string },
  freeSlots: number | undefined,
  cwd: string,
): Promise<boolean> {
  if (freeSlots === undefined) return true; // direct API caller — unchanged
  if (freeSlots >= DOWNTIME_AUDIT_MIN_FREE_SLOTS) return true; // parent ceiling, no lookup
  if (freeSlots < DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS) return false; // no slot at all
  // Leaf band: only a trusted leaf may consume the single free slot.
  let result: AuditCandidateScopeResult | null | undefined;
  try {
    result =
      typeof deps.getAuditCandidateScope === 'function'
        ? await deps.getAuditCandidateScope(candidate.id, cwd)
        : null;
  } catch {
    result = null; // fail-closed: an untrustworthy lookup is a parent
  }
  return classifyAuditScope(result) === 'leaf';
}

// ── Relaxed leaf-audit TICK admission (WL-0MVV1F0HK009JQAP C4) ────────
//
// The tick's idle-duration gate normally requires `downtimeRequiredFreeSlots`
// (default 2 of 3) slots to be continuously free before ANY dispatch is
// considered. Relaxing only the per-item audit minimum (C3) therefore changed
// nothing in production: the tick never reached the dispatch filters in the
// single-free-slot band. This slice relaxes the TICK requirement for one
// positively classified LEAF audit candidate, and pins the relaxed slot to
// that item so no other tier can consume it under the relaxed policy.

/**
 * A relaxed leaf-audit admission for ONE tick (WL-0MVV1F0HK009JQAP C4).
 *
 * Produced by {@link probeLeafAuditAdmission} when the per-slot idle tracker
 * reports the leaf band (`DOWNTIME_LEAF_AUDIT_MIN_FREE_SLOTS <=
 * thresholdMetCount < downtimeRequiredFreeSlots`) and the peeked audit
 * candidate is a trusted `leaf`. The tick then admits the dispatch for THIS
 * item only: every non-audit tier is ineligible and the audit tier admits no
 * other candidate.
 */
export interface LeafAuditAdmission {
  /** The audit candidate the relaxed slot is pinned to. */
  itemId: string;
  /** Free unowned slots the admitting poll observed. */
  freeSlots: number;
  /** Free slots continuously idle for the full threshold (same-slot identity). */
  thresholdMetCount: number;
  /** The configured minimum the tick would normally require. */
  requiredFreeSlots: number;
}

/**
 * Outcome of the leaf-band audit peek. `non-leaf` carries the rejected
 * candidate so the tick can emit the `audit-tier-budget-skipped` observation
 * (the audit tier's 2-slot minimum is exactly why it was skipped);
 * `no-candidate` and `unavailable` are silent — today's behaviour, no
 * relaxation and no new token.
 */
export type LeafAuditAdmissionProbe =
  | { kind: 'admitted'; admission: LeafAuditAdmission }
  | { kind: 'non-leaf'; itemId: string; scope: AuditScope }
  | { kind: 'no-candidate' }
  | { kind: 'unavailable' };

/**
 * The dependency slice the leaf-band peek reads, named structurally like
 * {@link DowntimeGateDeps} so this module never imports the barrel.
 */
export interface LeafAuditAdmissionDeps {
  getActiveAudit(cwd: string): Promise<DowntimeActiveAuditResult>;
  getNextAuditCandidate(cwd: string): Promise<DowntimeNextResult>;
  getAuditCandidateScope?(itemId: string, cwd: string): Promise<AuditCandidateScopeResult>;
}

/**
 * Peek the audit candidate for a relaxed leaf-audit tick.
 *
 * Composition of the EXISTING dependency seams — no new `wl` call, no second
 * selection rule: the active-audit single-flight check runs first (an audit
 * already in flight means there is no relaxed slot to hand out), then
 * `getNextAuditCandidate` (which already applies the dispatched-marker and
 * freshness exclusions), then the leaf-vs-parent scope lookup classified by
 * {@link classifyAuditScope}.
 *
 * **Fail-closed:** `{ ok: false }` on either lookup, a missing scope lookup, a
 * `parent` candidate, a `needsProducerReview` candidate, or an absent
 * candidate never relaxes the tick — every one of them restores today's
 * behaviour exactly (no admission, no extra dispatch).
 */
export async function probeLeafAuditAdmission(
  deps: LeafAuditAdmissionDeps,
  cwd: string,
  evidence: { freeSlots: number; thresholdMetCount: number; requiredFreeSlots: number },
): Promise<LeafAuditAdmissionProbe> {
  // Active-audit single-flight (WL-0MT3PHW4I002SNOV). An unanswerable check
  // is not an empty one: fail closed and keep today's gate.
  let active: DowntimeActiveAuditResult;
  try {
    active = await deps.getActiveAudit(cwd);
  } catch {
    return { kind: 'unavailable' };
  }
  if (!active.ok || active.active) return { kind: 'unavailable' };

  let next: DowntimeNextResult;
  try {
    next = await deps.getNextAuditCandidate(cwd);
  } catch {
    return { kind: 'unavailable' };
  }
  if (!next.ok) return { kind: 'unavailable' };
  if (next.candidate === null) return { kind: 'no-candidate' };
  // A budget-exhausted candidate is already flagged for producer review and
  // the dispatcher would skip it — never relax the tick for it.
  if (next.candidate.needsProducerReview === true) return { kind: 'no-candidate' };

  let result: AuditCandidateScopeResult | null | undefined;
  try {
    result =
      typeof deps.getAuditCandidateScope === 'function'
        ? await deps.getAuditCandidateScope(next.candidate.id, cwd)
        : null;
  } catch {
    result = null; // fail-closed: an untrustworthy lookup is a parent
  }
  const scope = classifyAuditScope(result);
  if (scope !== 'leaf') return { kind: 'non-leaf', itemId: next.candidate.id, scope };
  return { kind: 'admitted', admission: { itemId: next.candidate.id, ...evidence } };
}

/**
 * The dependency slice the COORDINATION leaf-band peek reads
 * (WL-0MVV1F130009VZ1P). Structurally named, like {@link LeafAuditAdmissionDeps},
 * so this module never imports the barrel.
 */
export interface CoordinationLeafAuditDeps {
  /**
   * Re-fetch one offered item in its own worklog root — the same seam the
   * leader's dispatch-time re-validation uses. Optional: absent means the
   * offers cannot be inspected, so the peek fails closed (`unavailable`).
   */
  fetchItem?(itemId: string, cwd: string): Promise<DowntimeItemResult>;
  /**
   * Active-audit single-flight read for an offer's root: an audit already in
   * flight means there is no relaxed slot to hand out.
   */
  getActiveAudit(cwd: string): Promise<DowntimeActiveAuditResult>;
  /** Leaf-vs-parent scope lookup (see {@link DowntimeGateDeps}). */
  getAuditCandidateScope?(itemId: string, cwd: string): Promise<AuditCandidateScopeResult>;
}

/** The offer shape the coordination peek iterates (file order preserved). */
export interface CoordinationOfferRef {
  workItemId: string;
  worklogRoot: string;
}

/**
 * Peek the COORDINATION offer list for a relaxed leaf-audit admission
 * (WL-0MVV1F130009VZ1P, C5 — the leader-path sibling of
 * {@link probeLeafAuditAdmission}).
 *
 * The direct path peeks the single instance's own `getNextAuditCandidate`;
 * the leader dispatches from the shared offer list, so its relaxed-tick slot
 * must be pinned to an item that is actually OFFERED. The offers are therefore
 * scanned in file order with the leader's own dispatch-time re-validation
 * seams (`fetchItem` → `classifyItemForDispatchDetail`), and the first offer
 * that is an eligible root audit candidate with a trusted `leaf` scope is
 * admitted. No new ranking, no second eligibility definition: the same
 * classifier and the same {@link classifyAuditScope} the dispatch loop uses.
 *
 * **Fail-closed** — every case restores today's behaviour (no relaxation):
 * no usable offer → `no-candidate`; unwired `fetchItem`, a throwing/`{ok:false}`
 * active-audit read, or every offer fetch failing → `unavailable`; a
 * parent/unknown scope → `non-leaf` (so the tick still records the
 * `audit-tier-budget-skipped` observation). Per-offer fetch failures are
 * tolerated (fail-open per instance, exactly as the leader's offer loop).
 */
export async function probeCoordinationLeafAuditAdmission(
  deps: CoordinationLeafAuditDeps,
  offers: readonly CoordinationOfferRef[],
  evidence: { freeSlots: number; thresholdMetCount: number; requiredFreeSlots: number },
  now: number = Date.now(),
): Promise<LeafAuditAdmissionProbe> {
  const usable = offers.filter(
    (offer) => offer.workItemId.length > 0 && offer.worklogRoot.length > 0,
  );
  if (usable.length === 0) return { kind: 'no-candidate' };
  if (typeof deps.fetchItem !== 'function') return { kind: 'unavailable' };

  let fetched = 0;
  let nonLeaf: { itemId: string; scope: AuditScope } | null = null;
  for (const offer of usable) {
    let result: DowntimeItemResult;
    try {
      result = await deps.fetchItem(offer.workItemId, offer.worklogRoot);
    } catch {
      continue; // fail-open per instance, mirroring the leader's offer loop
    }
    if (!result.ok) continue;
    fetched += 1;
    // Same classifier the leader applies at dispatch time: only an eligible
    // audit candidate can consume the relaxed slot.
    if (classifyItemForDispatchDetail(result.info, now).kind !== 'audit') continue;
    // Active-audit single-flight (WL-0MT3PHW4I002SNOV): an unanswerable or
    // active read is a refusal — never relax past a running audit.
    let active: DowntimeActiveAuditResult;
    try {
      active = await deps.getActiveAudit(offer.worklogRoot);
    } catch {
      return { kind: 'unavailable' };
    }
    if (!active.ok || active.active) return { kind: 'unavailable' };

    let scope: AuditCandidateScopeResult | null | undefined;
    try {
      scope =
        typeof deps.getAuditCandidateScope === 'function'
          ? await deps.getAuditCandidateScope(result.info.id, offer.worklogRoot)
          : null;
    } catch {
      scope = null; // fail-closed: an untrustworthy lookup is a parent
    }
    const classified = classifyAuditScope(scope);
    if (classified === 'leaf') {
      return {
        kind: 'admitted',
        admission: { itemId: result.info.id, ...evidence },
      };
    }
    if (nonLeaf === null) nonLeaf = { itemId: result.info.id, scope: classified };
  }

  if (nonLeaf !== null) return { kind: 'non-leaf', itemId: nonLeaf.itemId, scope: nonLeaf.scope };
  return fetched === 0 ? { kind: 'unavailable' } : { kind: 'no-candidate' };
}

/**
 * True when a dispatch attempt may consider an audit candidate under a relaxed
 * leaf-audit admission pin (WL-0MVV1F0HK009JQAP C4).
 *
 * An absent pin (`undefined`) means no relaxation is in play, so every
 * candidate is considered exactly as today; a present pin admits ONLY the
 * pinned item, so the relaxed single slot can never be consumed by a second
 * leaf audit selected after the peek.
 */
export function auditPinAdmits(pinnedItemId: string | undefined, candidateId: string): boolean {
  return pinnedItemId === undefined || pinnedItemId === candidateId;
}

// ── Review-queue depth gate — shared (WL-0MT2UQWOR007CYY9 gate re-wired
// onto the live Herdr path by WL-0MTTSWC1X005P4VD) ────────────────────
// Root cause B2: the gate originally lived ONLY in the legacy tier chain
// (dead whenever the Herdr head is non-empty), so non-critical implements
// kept dispatching into a deep review queue. The gate now applies
// identically in `dispatchFromHerdrList` (direct dispatch),
// `computeMostImportantItem` (coordination offer computation) and
// `dispatchFromCoordination` (leader dispatch): while the ROOT-ONLY
// `completed`/`in_review` count is at/over `browseItemCount`, NON-CRITICAL
// `implement`-kind candidates are held. Audits (the queue drain), plan,
// intake and critical implements flow unconditionally. A deep queue with
// nothing audit-needed reports the neutral reason 'review-queue-hold'
// (never 'no-candidate' / cooldown) so polling resumes immediately when
// the queue thins. Fail-closed: a count-query failure activates the gate
// (only critical implements remain eligible) — the same convention as the
// code-freeze 'ambiguous ⇒ frozen' rule.

/** Neutral outcome reason when a deep review queue holds the only candidates. */
export const REVIEW_QUEUE_HOLD_REASON = 'review-queue-hold';

/** Result of one bounded review-queue depth read. */
export interface ReviewQueueGateResult {
  /** True when the queue is at/over threshold (deep) — fail-closed on query failure. */
  deep: boolean;
  /** Raw root-only completed/in_review count; null when the count query failed. */
  count: number | null;
  /** The threshold applied (browseItemCount). */
  threshold: number;
}

/**
 * Read the review-queue depth ONCE per dispatch/offer computation
 * (`wl list --status completed --stage in_review --root-only`, bounded by
 * `DOWNTIME_WL_TIMEOUT_MS` inside the dep). A failure or unparseable
 * output resolves `{deep: true, count: null}` — fail-closed (gate
 * active: only critical implements remain eligible). Never throws.
 */
export async function readReviewQueueGate(
  deps: DowntimeGateDeps,
  cwd: string,
  browseItemCount: number = DEFAULT_BROWSE_ITEM_COUNT,
): Promise<ReviewQueueGateResult> {
  let count: number | null;
  try {
    count = await deps.getReviewQueueCount(cwd);
  } catch {
    count = null;
  }
  return {
    deep: count === null || count >= browseItemCount,
    count,
    threshold: browseItemCount,
  };
}

/**
 * Audit-eligible depth derived from the ALREADY-FETCHED Herdr head (parent
 * WL-0MVEDM8OT007WDRS AC1). Root `completed`/`in_review` items (mandatory in
 * the head) are classified with the SAME eligibility definition as the
 * dispatch path — `classifyItemForDispatch` — so no second eligibility
 * definition exists and no extra `wl` subprocess is added to the common
 * dispatch path. The classifier excludes fresh-audited items, producer-review
 * holds, assignee-held items and soft-deleted items.
 *
 * `now` is injectable for deterministic tests.
 */
export function computeAuditEligibleDepth(
  items: DowntimeHerdrItem[],
  now: number = Date.now(),
): number {
  let depth = 0;
  for (const item of items) {
    const info: DowntimeItemInfo = {
      id: item.id,
      title: item.title,
      status: item.status,
      stage: item.stage,
      priority: item.priority,
      risk: item.risk,
      effort: item.effort,
      auditedAt: item.auditedAt,
      updatedAt: item.updatedAt,
      sortIndex: item.sortIndex,
      deletedBy: item.deletedBy,
      assignee: item.assignee,
      needsProducerReview: item.needsProducerReview,
    };
    if (classifyItemForDispatch(info, now) === 'audit') depth += 1;
  }
  return depth;
}

/**
 * Resolve the depth-aware audit-batch status for a DISPATCHED audit outcome
 * (parent WL-0MVEDM8OT007WDRS AC1). The batch is engaged only while the
 * audit-eligible depth is at/over `browseItemCount`, the clamped cap is above
 * 1 (`1` = legacy/off) and a continuation budget was available BEFORE this
 * dispatch (absent `auditBatchRemaining` initialises the budget to the cap —
 * the first dispatch of a batch). `remaining` is the budget AFTER this
 * dispatch; an inactive batch always reports `remaining: 0`.
 */
export function resolveAuditBatchStatus(
  cap: number,
  depth: number,
  threshold: number,
  remainingBefore: number,
): DowntimeAuditBatchStatus {
  const active = cap > 1 && depth >= threshold && remainingBefore > 0;
  return {
    active,
    depth,
    cap,
    remaining: active ? Math.max(0, remainingBefore - 1) : 0,
  };
}

// Hard post-selection failures that END an audit batch without a continuation
// surface (parent WL-0MVEDM8OT007WDRS AC3): the item was claimed/marked and
// the dispatch failed — the caller's strike/skip semantics decide. These
// outcomes keep the historical shape (no `auditBatch` field at all), the same
// signal a non-continuation dispatch uses.
const AUDIT_BATCH_HARD_FAILURE_REASONS = new Set([
  'spawn-failed',
  'wl-error',
  'marker-write-failed',
  'claim-rolled-back',
  'anchor-unavailable',
]);

/**
 * Attach the audit-batch surface to one dispatch outcome (parent
 * WL-0MVFE1BTB0084T17):
 *
 *  - a dispatched AUDIT outcome gets its resolved status (active only when
 *    the depth/cap/budget conditions hold);
 *  - a dispatched NON-audit outcome never carries `auditBatch` (regression
 *    safety — non-audit dispatch resets the tracker and never arms a batch);
 *  - a hard failure (spawn-failed / marker-write-failed / claim-rolled-back /
 *    anchor-unavailable / wl-error) keeps today's shape — no `auditBatch`;
 *  - every other non-dispatched outcome (a gate refused a continuation)
 *    reports an explicit INACTIVE status so the worker knows the batch is
 *    over without relaxing any gate.
 */
export function finalizeAuditBatchOutcome<Outcome extends AuditBatchOutcomeShape>(
  outcome: Outcome,
  ctx: { depth: number; cap: number; threshold: number; remainingBefore: number },
): Outcome {
  if (outcome.dispatched) {
    if (outcome.kind !== 'audit') return outcome;
    return {
      ...outcome,
      auditBatch: resolveAuditBatchStatus(
        ctx.cap,
        ctx.depth,
        ctx.threshold,
        ctx.remainingBefore,
      ),
    };
  }
  if (outcome.auditBatch !== undefined) return outcome;
  if (outcome.reason !== undefined && AUDIT_BATCH_HARD_FAILURE_REASONS.has(outcome.reason)) {
    return outcome;
  }
  return {
    ...outcome,
    auditBatch: { active: false, depth: ctx.depth, cap: ctx.cap, remaining: 0 },
  };
}

/**
 * Apply the gate to one classified candidate: TRUE only for a NON-CRITICAL
 * `implement`-kind candidate while the review queue is deep. Audits/plan/
 * intake and critical-priority implements are never held (audits are the
 * queue drain; critical work is never throttled). A null gate (not read —
 * e.g. frozen, where implements are already paused) never holds.
 */
export function isImplementHeldByReviewGate(
  kind: DowntimeSkillKind,
  candidate: { priority?: string },
  gate: ReviewQueueGateResult | null,
): boolean {
  if (kind !== 'implement') return false;
  if (gate === null || !gate.deep) return false;
  return candidate.priority !== 'critical';
}

// ── Critical-only dispatch-window escape hatch (WL-0MUNS8X97007C9H9) ─────────────────
/**
 * Fetch the CRITICAL-ONLY extended Herdr head for dispatch
 * (WL-0MU6UL3GQ0015AA5, restricted by WL-0MUNS8X97007C9H9 AC2/AC4).
 *
 * The dispatcher consumes the Herdr list head produced by the canonical
 * ranking path (fetcher → smart-selection → grouping), windowed to the live
 * `browseItemCount` so the head equals the rendered sprint view. Every
 * `critical` item is mandatory in that view, so this helper is a DEFENSIVE
 * safety net: it re-reads the SAME ranking path with a larger window
 * (`current.length + DOWNTIME_DISPATCH_EXTEND_MAX`) and returns only the
 * `critical` items NOT already present in `current`, preserving the canonical
 * order. NON-CRITICAL items beyond the sprint view are never returned — the
 * operator must be able to see any work the dispatcher acts on.
 *
 * It is a WINDOW EXTENSION, never a second ranking: the same
 * `selectWorkItems` / `regroupWorkItems` contract decides the order, just
 * with more items included.
 *
 * Fail-open: an absent optional `limit` support (test mocks ignoring the
 * argument), a `{ok:false}` CLI failure, a thrown error, or an extended head
 * that adds nothing all resolve `[]` — the caller's terminal reason is then
 * unchanged, so the extension can never convert a defined outcome into a
 * new failure. Returning `[]` also makes the extension idempotent for mocks
 * that ignore the limit (the extended head equals the current head).
 */
export async function fetchExtendedHerdrItems(
  deps: DowntimeGateDeps,
  cwd: string,
  current: DowntimeHerdrItem[],
  opts: { includeNonCritical?: boolean } = {},
): Promise<DowntimeHerdrItem[]> {
  try {
    const extended = await deps.getHerdrListHead(
      cwd,
      current.length + DOWNTIME_DISPATCH_EXTEND_MAX,
    );
    if (!extended.ok) return [];
    const seen = new Set(current.map((i) => i.id));
    // Critical-only escape hatch: a non-critical item beyond the sprint view
    // is never dispatchable (WL-0MUNS8X97007C9H9 AC2/AC4). When
    // `includeNonCritical` is true (used by the own-backlog fallback — parent
    // WL-0MUU4XFU90008E24), the filter is lifted so any ranked item in the
    // extended tail is returned.
    return extended.items.filter((i) =>
      !seen.has(i.id) && (opts.includeNonCritical === true || i.priority === 'critical'),
    );
  } catch {
    return []; // fail-open: the extension never breaks a defined outcome
  }
}

/**
 * True when the per-item, per-kind dispatch-ATTEMPT budget is exhausted
 * (WL-0MUKYEXMK0033MFK AC1/AC2): the rolling dispatch log records
 * `maxAttempts` or more dispatch attempts for this `(itemId, kind)` at the
 * item's CURRENT stage.
 *
 * The count is derived from the log (`countAttempts`), scoped to the current
 * stage so a stage advancement resets the budget (AC4), and fail-open: a
 * missing/corrupt/empty log yields 0 (AC7e). A non-finite or < 1 cap is
 * likewise fail-open (never blocks dispatch).
 */
export function isAttemptBudgetExhausted(
  entries: DowntimeLogEntry[],
  itemId: string,
  kind: DowntimeSkillKind,
  itemStage: string | undefined,
  maxAttempts: number,
): boolean {
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) return false; // fail-open
  return _countAttempts(entries, itemId, kind, itemStage) >= maxAttempts;
}

/**
 * Best-effort producer-review flag for a budget-exhausted item
 * (WL-0MUKYEXMK0033MFK AC3). Never throws; a missing dep or a failed write is
 * swallowed — the caller still skips the item via the budget filter, so the
 * flag is retried on the next cycle (fail-closed).
 */
export async function flagBudgetExhausted(
  deps: DowntimeGateDeps,
  itemId: string,
  cwd: string,
): Promise<void> {
  if (typeof deps.markNeedsProducerReview !== 'function') return;
  try {
    await deps.markNeedsProducerReview(itemId, cwd);
  } catch {
    // fail-closed: a flag write failure must never crash the worker
  }
}

/**
 * Classify a fetched work item into its coordinator dispatch tier, or null
 * when it is not currently dispatchable (fail-closed on ambiguous state):
 *
 *  - `completed` + `in_review` + no fresh audit + within the 7-day audit
 *    recency window → `audit` (same freshness/recency semantics as the
 *    audit tier's `selectAuditCandidate`; `auditedAt` enriched by the
 *    fetchItem dep — absent auditedAt means not fresh → audit-eligible).
 *  - `open`/`blocked` + `plan_complete` + effort ≤ Medium (risk cap removed)
 *    → `implement` (the effort cap is belt-and-suspenders client-side).
 *  - `open`/`blocked` + `intake_complete` → `plan`.
 *  - `open`/`blocked` + `idea` → `intake`.
 *  - Every other state (in_progress already claimed, completed with a
 *    fresh audit, past the recency window, above the effort cap,
 *    unknown status/stage) → null (never dispatched).
 *
 * `now` is injectable for deterministic tests.
 */
export function classifyItemForDispatch(
  info: DowntimeItemInfo,
  now: number = Date.now(),
): DowntimeSkillKind | null {
  return classifyItemForDispatchDetail(info, now).kind;
}

/**
 * The attributed form of {@link classifyItemForDispatch}
 * (WL-0MVR8FKMU009XTED AC1): the same classification, plus the STABLE gate
 * token when the item is not dispatchable. The wrapper above keeps the
 * published classifier contract byte-identical — every existing caller and
 * test sees the same `DowntimeSkillKind | null` — while the offer computation
 * uses this form to explain an empty window (`all-window-items-held`,
 * `all-window-items-gated`) without a second classification pass.
 */
export function classifyItemForDispatchDetail(
  info: DowntimeItemInfo,
  now: number = Date.now(),
): { kind: DowntimeSkillKind; gate?: undefined } | { kind: null; gate: ClassifyGateToken } {
  // Exclude soft-deleted items (SA-0MUJBLZC60085DI9 AC3): a non-empty
  // `deletedBy` is the authoritative deletion marker — the item must never
  // be dispatched, even if its status/stage would otherwise qualify.
  if (isSoftDeleted(info)) return { kind: null, gate: 'soft-deleted' };
  // Exclude items needing producer review (parent WL-0MTIAL65N004T22F AC1).
  // Items flagged for producer review must NOT be auto-dispatched at any tier.
  if (info.needsProducerReview === true) return { kind: null, gate: 'producer-review' };
  // Assignee hold (WL-0MV85WCJJ0087VMP): an item held by a non-empty
  // assignee is never auto-dispatched at any tier. Assigning an item to a
  // human/agent (e.g. the producer) makes it non-dispatchable, and the
  // audit-tier claim's `--if-assignee ""` CAS would fail stale anyway.
  if (isAssigneeHeld(info)) return { kind: null, gate: 'assignee-hold' };
  const status = typeof info.status === 'string' ? info.status : '';
  const stage = typeof info.stage === 'string' ? info.stage : '';
  if (status === 'completed') {
    if (stage !== 'in_review') return { kind: null, gate: 'not-dispatchable' };
    // Audit tier: no FRESH audit (auditedAt absent/older than updatedAt
    // semantics per isAuditFresh). A missing auditedAt means not fresh →
    // audit-eligible (the audit tier's conservative default). Fingerprints
    // are used when both sides are available; otherwise the time gate applies.
    if (isAuditFresh(info.auditedAt, info.updatedAt, info.fingerprint, info.currentFingerprint)) {
      return { kind: null, gate: 'audit-fresh' };
    }
    // 7-day recency window (mirrors selectAuditCandidate): an item not
    // modified within the window is not a candidate; missing updatedAt is
    // included (absent data must not silently drop candidates).
    if (typeof info.updatedAt === 'string' && info.updatedAt.length > 0) {
      const updated = new Date(info.updatedAt).getTime();
      if (Number.isNaN(updated)) return { kind: null, gate: 'not-dispatchable' }; // unparseable → fail-closed
      if (now - updated > DOWNTIME_AUDIT_RECENCY_WINDOW_MS) {
        return { kind: null, gate: 'audit-recency' };
      }
    }
    return { kind: 'audit' };
  }
  if (status !== 'open' && status !== 'blocked') return { kind: null, gate: 'not-dispatchable' };
  if (stage === 'idea') return { kind: 'intake' };
  if (stage === 'intake_complete') return { kind: 'plan' };
  if (stage === 'plan_complete') {
    // Items missing risk/effort (root cause C, WL-0MTTSWCJR003OMN7):
    // dispatch a risk-effort evaluation so the fields get populated and
    // the item becomes implement-dispatchable on the next pass.
    const risk = riskOrdinal(info.risk);
    const effort = effortOrdinal(info.effort);
    if (risk === null || effort === null) return { kind: 'risk-effort' };
    // Effort cap (≤ Medium) — the risk cap was removed so high-risk items
    // reach implement dispatch instead of being stranded (an open/blocked
    // item with populated risk/effort otherwise has no dispatch kind).
    if (effort > 3) return { kind: null, gate: 'effort-cap' };
    return { kind: 'implement' };
  }
  // Retired `in_progress` stage (WL-0MTTSWCJR003OMN7 — OSL dead zones;
  // WL-0MTYL7DX9000MZOH — claim must not hard-strike): items stuck on the
  // retired stage are invisible to all dispatch tiers. Map them into the
  // pipeline by dispatching a skill evaluation that will advance them to
  // the correct stage. The CLAIM for such an item CASes on the item's
  // ACTUAL retired stage and atomically migrates it to the tier's target
  // stage (`claimWorkItem` migrateStage) — without that, `wl update`'s
  // status/stage validation rejects the claim and the dispatcher records a
  // hard wl-error strike (three strikes → 60-min pause loop).
  if (stage === 'in_progress') {
    // Always dispatch risk-effort for retired-stage items: it evaluates
    // both fields AND confirms the stage is correct, producing a single
    // efficient re-evaluation that advances the item to its proper stage.
    return { kind: 'risk-effort' };
  }
  return { kind: null, gate: 'not-dispatchable' };
}
