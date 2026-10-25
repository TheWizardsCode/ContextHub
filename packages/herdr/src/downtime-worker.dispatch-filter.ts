/**
 * packages/herdr/src/downtime-worker.dispatch-filter.ts — the Herdr list-head
 * FILTER pipeline (WL-0MTK1ILM2009QYB2 AC1–2).
 *
 * Single responsibility: turn the ranked Herdr selection head into at most one
 * dispatch by applying every safety gate as a sequential FILTER on that
 * ordered sequence — never by ranking again. The critical-first scan bypasses
 * only the non-safety filters; the CAS claim inside the claim pipeline still
 * serialises concurrent panes.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Moved verbatim out of `downtime-worker.ts` by WL-0MVLII0NO007JJBA (extract
 * the downtime-worker dispatch pipeline). `selectCriticalFirstCandidates` and
 * `CriticalFirstCandidate` are consumer-facing and re-exported from the
 * barrel; the filter itself is internal to the dispatch entry. No behaviour
 * change: filter order, hold reasons and log lines are identical.
 */

import {
  classifyItemForDispatch,
  evaluateCriticalFirstGuard,
  flagBudgetExhausted,
  isAttemptBudgetExhausted,
  isImplementHeldByReviewGate,
  type ReviewQueueGateResult,
} from './downtime-worker.gates.js';
import {
  dispatchedItemMarkers as _dispatchedMarkers,
  isNonTerminalCooldownActive as _isNonTerminalCooldownActive,
  markerStillExcludes as _markerStillExcludes,
  readDowntimeLogEntries as _readDowntimeEntries,
  type DispatchMarker,
} from './downtime-log.js';
import type { LocalPreference } from './local-preference.js';
import type { DowntimeDispatchDeps, DowntimeDispatchOutcome } from './downtime-worker.dispatch-contract.js';
import { dispatchClaimedTier } from './downtime-worker.dispatch-claims.js';
import type {
  DowntimeCandidate,
  DowntimeHerdrItem,
  DowntimeSkillKind,
  DowntimeStage,
  InFlightPanes,
} from './downtime-worker.types.js';

// ── Herdr list-head filter dispatcher (WL-0MTK1ILM2009QYB2 AC1–2) ────

/** A critical Herdr-head item paired with the stage-appropriate dispatch kind. */
export interface CriticalFirstCandidate {
  item: DowntimeHerdrItem;
  kind: DowntimeSkillKind;
}

/**
 * Critical-first selection for the Herdr-head paths (WL-0MU6UL3XY001M3VT).
 *
 * Returns the open OR blocked critical items of a Herdr head that pass the
 * NON-BYPASSABLE safety gates, in deterministic order (lowest `sortIndex`
 * first — the historical critical-tier ordering):
 *
 *  - `needsProducerReview === true` excludes that candidate;
 *  - `classifyItemForDispatch` excludes non-dispatchable shapes (retired
 *    stage, missing fields, above-effort-cap `plan_complete`);
 *  - while the code-freeze marker is frozen OR ambiguous, the
 *    split-by-skill rule pauses audit/implement candidates while
 *    plan/intake/risk-effort prep still passes — matching the direct
 *    dispatch path's freeze filter (Q1).
 *
 * The NON-SAFETY filters that the HERDR paths deliberately bypass for
 * critical work — the dispatched-marker exclusion and the review-queue
 * depth hold — are NOT applied here, so a critical item held by a non-safety
 * filter is escalated rather than starved by lower-priority work (AC1/AC4a).
 * Free-slot minimums and the active-audit single-flight check are
 * dispatch-time gates: the direct dispatcher applies them after selection;
 * the offer computation intentionally does not (they are not offer gates).
 *
 * No second ranking is introduced (AC3): candidates always come from the
 * passed Herdr head, never a separate `wl list` lookup.
 */
export function selectCriticalFirstCandidates(
  items: DowntimeHerdrItem[],
  now: number = Date.now(),
  frozen: boolean = false,
): CriticalFirstCandidate[] {
  const sorted = items
    .filter((i) => i.priority === 'critical' && (i.status === 'open' || i.status === 'blocked') && i.needsProducerReview !== true)
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  const out: CriticalFirstCandidate[] = [];
  for (const item of sorted) {
    const kind = classifyItemForDispatch(item, now);
    if (kind === null) continue;
    // Safety gate: code-freeze/ambiguous split-by-skill (Q1).
    if (frozen && (kind === 'audit' || kind === 'implement')) continue;
    out.push({ item, kind });
  }
  return out;
}

export async function dispatchFromHerdrList(
  deps: DowntimeDispatchDeps,
  items: DowntimeHerdrItem[],
  ctx: { cwd: string; model: string; localPreference?: LocalPreference; freeSlots?: number; frozen: boolean; cpuSaturated: boolean; panesEligible: boolean; auditEligible: boolean; reviewGate: ReviewQueueGateResult | null; markerStaleWindowMs: number; nonTerminalCooldownMs: number; maxAttempts: number; inFlight: InFlightPanes },
  flags: { auditInFlight: boolean; auditCheckFailed: boolean; auditCheckError?: string; freshnessSkip: boolean; reviewHeld: boolean; cooldownHeld: boolean; budgetExhausted: boolean; cpuHeld: boolean; auditHostSaturated: boolean },
): Promise<DowntimeDispatchOutcome | null> {
  if (items.length === 0) return null;
  const entries = await _readDowntimeEntries(ctx.cwd);
  // Item ids already flagged this call so the producer-review flag is set at
  // most ONCE per dispatch even when the same critical item is visited by
  // both the critical-first scan and the normal scan (AC7c).
  const flaggedForBudget = new Set<string>();
  // Staleness-aware success-marker maps (WL-0MU6UL0RJ008IHGT): id → the
  // dispatched-at stage + timestamp, read once per dispatch and consulted
  // below through `markerStillExcludes`.
  const markerMaps: Record<DowntimeSkillKind, Map<string, DispatchMarker>> = {
    audit: _dispatchedMarkers(entries, 'audit'),
    implement: _dispatchedMarkers(entries, 'implement'),
    plan: _dispatchedMarkers(entries, 'plan'),
    intake: _dispatchedMarkers(entries, 'intake'),
    'risk-effort': _dispatchedMarkers(entries, 'risk-effort'),
  };

  // ── Critical-first scan (WL-0MU6UL3XY001M3VT) ──────────────────────
  // A critical item blocked by a NON-SAFETY filter (e.g. a stale dispatched
  // marker or the review-queue depth gate) must be escalated within one idle
  // cycle. The legacy critical-first tier (`dispatchDowntimeWork`) is dead
  // whenever the Herdr head is non-empty — which is always, since critical
  // items are mandatory-always in the head — so a blocked critical item is
  // otherwise skipped while lower-priority work consumes the window.
  //
  // `selectCriticalFirstCandidates` yields the eligible open critical items
  // (Herdr head, safety gates only); this loop bypasses the non-safety
  // filters (dispatched-marker exclusion, review-queue depth hold) and adds
  // the dispatch-time free-slot minimum. The CAS claim inside
  // `dispatchClaimedTier` still serialises concurrent panes (AC2).
  //
  // In-flight guard (WL-0MUBEZ6PE002WLP4 / F3 WL-0MUBVKXQJ000L8EO): the
  // marker bypass is NO LONGER unconditional. A critical item whose status has
  // reverted to `open` at its marker's stage while a dispatch pane is still
  // live (the confirmed H1+H5 duplicate mechanism) is skipped by the
  // item-scoped guard below — see `evaluateCriticalFirstGuard` for the full
  // decision table. Escalation of a genuinely stuck item is preserved (AC3).
  for (const { item: candidate, kind } of selectCriticalFirstCandidates(items, Date.now(), ctx.frozen)) {
    // Host-CPU gate (WL-0MVK0UO3Q002TXW6 AC2): while the host is saturated a
    // critical implement is refused too — saturation is exactly when starting
    // new heavy work does harm. Critical plan/intake prep still passes.
    if (ctx.cpuSaturated && (kind === 'audit' || kind === 'implement')) {
      flags.cpuHeld = true;
      continue;
    }
    // Safety gate: per-tier free-slot minimums (parent WL-0MT32F90UAD2 AC3).
    if (kind === 'audit' && !ctx.auditEligible) continue;
    if (kind !== 'audit' && !ctx.panesEligible) continue;
    // In-flight guard: never re-dispatch an item with a live working pane.
    const inFlightMarker = markerMaps[kind]?.get(candidate.id);
    const guard = evaluateCriticalFirstGuard(
      candidate.id,
      ctx.inFlight,
      inFlightMarker?.dispatchedAt,
      Date.now(),
      ctx.markerStaleWindowMs,
    );
    if (!guard.escalate) continue;
    // Per-item/per-kind attempt budget (WL-0MUKYEXMK0033MFK AC1/AC2/AC3): a
    // critical item that has exhausted its automatic attempts is flagged for
    // producer review and skipped — escalation, not starvation. The budget is
    // a stronger escalation than the in-flight guard, so it is evaluated
    // after the guard (a genuinely live pane is never pre-empted) but before
    // the dispatch attempt.
    if (isAttemptBudgetExhausted(entries, candidate.id, kind, candidate.stage, ctx.maxAttempts)) {
      if (!flaggedForBudget.has(candidate.id)) {
        flaggedForBudget.add(candidate.id);
        await flagBudgetExhausted(deps, candidate.id, ctx.cwd);
      }
      flags.budgetExhausted = true;
      continue;
    }
    const cand: DowntimeCandidate = {
      id: candidate.id,
      title: candidate.title,
      stage: kind === 'audit' ? 'audit' : (String(candidate.stage) as DowntimeStage),
      status: candidate.status,
      priority: candidate.priority,
      sortIndex: candidate.sortIndex,
    };
    const outcome = await dispatchClaimedTier(deps, kind, cand, {
      model: ctx.model,
      cwd: ctx.cwd,
      localPreference: ctx.localPreference,
      selectionPath: 'critical-first',
      selectionReason: guard.reason,
    });
    if (outcome.dispatched) return outcome;
    // A lost CAS race / marker-recovery rollback applies to one candidate:
    // try the next critical candidate, then fall through to the normal loop.
    if (outcome.reason === 'claim-failed' || outcome.reason === 'claim-rolled-back') continue;
    // Any other terminal outcome (wl-error, spawn-failed, anchor-unavailable)
    // is returned unchanged so the caller's strike/skip semantics are kept.
    return outcome;
  }

  for (const item of items) {
    // Classify solely by list-provided fields — `classifyItemForDispatch`
    // already enforces risk/effort/audit-freshness gates (WL-0MTK1ILM2009QYB2).
    const now = Date.now();
    const info = {
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
      parentId: item.parentId,
      deletedBy: item.deletedBy,
      // Assignee hold (WL-0MV85WCJJ0087VMP): carried into the classification
      // info so a held item is excluded by `classifyItemForDispatch` here too.
      assignee: item.assignee,
      needsProducerReview: item.needsProducerReview,
    };
    const k = classifyItemForDispatch(info, now);
    if (k === null) continue;
    // Active-audit single-flight check (WL-0MT3PHW4I002SNOV): runs BEFORE
    // dispatched-marker exclusion to match legacy tier behavior. While an
    // audit is in-flight the audit tier is skipped entirely, so we must
    // check this before filtering dispatched items (a dispatched item may
    // still be the active-audit item that should cause the skip).
    if (k === 'audit') {
      const active = await deps.getActiveAudit(ctx.cwd);
      if (active.ok) { if (active.active) { flags.auditInFlight = true; if (active.source === 'host-wide') { flags.auditHostSaturated = true; } continue; } } else { flags.auditCheckFailed = true; flags.auditCheckError = (active as { error?: string }).error ?? 'active-audit check failed'; continue; }
      try { if (await deps.hasFreshAudit(item.id, ctx.cwd)) { flags.freshnessSkip = true; continue; } } catch { /* fail-open */ }
    }
    // Dispatched-marker exclusion per kind — mirrors legacy tier exclusion
    // (WL-0MSLIY8ZR004QUSY/AC6) but applied as a filter on the Herdr head,
    // and staleness-aware (WL-0MU6UL0RJ008IHGT): a success marker excludes
    // ONLY while the item is STILL at the marker's dispatched-at stage AND
    // the marker is fresh (age ≤ ctx.markerStaleWindowMs). A stale marker at
    // an unchanged stage is released, so a pane that spawned but never
    // advanced the item can no longer strand it permanently (AC1); an
    // advanced item releases exactly as before (AC2). Audit/implement use
    // the id-guard mode (legacy stage-less markers stay protected while
    // fresh — duplicate-dispatch protection is never weakened); the
    // plan/intake/risk-effort stage-guard tiers release a legacy marker.
    const marker = markerMaps[k]?.get(item.id);
    if (
      marker !== undefined &&
      _markerStillExcludes(
        marker,
        item.stage,
        now,
        ctx.markerStaleWindowMs,
        k === 'audit' || k === 'implement' ? 'id-guard' : 'stage-guard',
      )
    ) {
      continue;
    }
    // Per-item/per-kind attempt budget (WL-0MUKYEXMK0033MFK AC1/AC2/AC3):
    // once the item has been dispatched `maxAttempts` times for this kind at
    // its current stage (including non-terminal closes — each is a marker),
    // it is flagged for producer review and excluded from further automatic
    // dispatch. Neutral sequential filter: never a strike, never
    // 'no-candidate' (AC5).
    if (isAttemptBudgetExhausted(entries, item.id, k, item.stage, ctx.maxAttempts)) {
      if (!flaggedForBudget.has(item.id)) {
        flaggedForBudget.add(item.id);
        await flagBudgetExhausted(deps, item.id, ctx.cwd);
      }
      flags.budgetExhausted = true;
      continue;
    }
    // Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5): a neutral
    // sequential filter — hold an item whose previous same-kind pane closed
    // without reaching a terminal stage until the cooldown elapses (or the
    // item advances past its dispatched-at stage). Never a strike, never
    // 'no-candidate'.
    if (_isNonTerminalCooldownActive(entries, item.id, k, item.stage, ctx.nonTerminalCooldownMs, now)) {
      flags.cooldownHeld = true;
      continue;
    }
    // Code-freeze split-by-skill: audit+implement dispatch pauses during
    // a freeze/ambiguous marker (plan/intake still dispatch).
    if (ctx.frozen && (k === 'audit' || k === 'implement')) continue;
    // Host-CPU gate (WL-0MVK0UO3Q002TXW6 AC2): refuse NEW audit/implement
    // dispatch at or above the threshold; plan/intake/risk-effort keep
    // flowing. Evaluated AFTER the code freeze so a dual-gated tick reports
    // `code-freeze` (AC4 precedence).
    if (ctx.cpuSaturated && (k === 'audit' || k === 'implement')) {
      flags.cpuHeld = true;
      continue;
    }
    // In-flight guard for CRITICAL candidates on the normal loop (AC2.5):
    // the same item-scoped decision table as the critical-first scan, so AC2
    // holds "regardless of selection path". Non-critical candidates keep the
    // marker/TTL behaviour unchanged (the marker already guards them; the
    // guard is scoped to critical items to avoid changing established
    // non-critical semantics — WL-0MUBEZ6PE002WLP4).
    if (item.priority === 'critical') {
      const guard = evaluateCriticalFirstGuard(
        item.id,
        ctx.inFlight,
        marker?.dispatchedAt,
        now,
        ctx.markerStaleWindowMs,
      );
      if (!guard.escalate) continue;
    }
    // Per-tier free-slot minimums (parent WL-0MT32F90V008UAD2 AC3).
    if (k === 'audit' && !ctx.auditEligible) continue;
    if (k !== 'audit' && !ctx.panesEligible) continue;
    // Review-queue depth gate (WL-0MT2UQWOR007CYY9, live-path rewire by
    // WL-0MTTSWC1X005P4VD): hold a NON-CRITICAL implement candidate while
    // the root-only completed/in_review queue is at/over browseItemCount —
    // the review bottleneck is not overloaded with new non-critical code.
    // Audits (the queue drain), plan, intake and critical implements flow
    // unconditionally (AC1/AC2). The hold is recorded so an otherwise-empty
    // backlog reports 'review-queue-hold' (never 'no-candidate' → no
    // cooldown; polling resumes the moment the queue thins).
    if (isImplementHeldByReviewGate(k, item, ctx.reviewGate)) {
      flags.reviewHeld = true;
      continue;
    }
    const cand: DowntimeCandidate = { id: item.id, title: item.title, stage: k === 'audit' ? 'audit' : (String(item.stage) as DowntimeStage), status: item.status, priority: item.priority, sortIndex: item.sortIndex };
    const outcome = await dispatchClaimedTier(deps, k, cand, {
      model: ctx.model,
      cwd: ctx.cwd,
      localPreference: ctx.localPreference,
      selectionPath: 'normal-scan',
      selectionReason: item.priority === 'critical' ? 'no-live-pane' : 'non-critical',
    });
    if (outcome.dispatched) return outcome;
    if (outcome.reason === 'claim-failed') continue;
    if (outcome.reason === 'claim-rolled-back') continue; // marker-write recovery (WL-0MT32F908002YFFA)
    return outcome;
  }
  return null;
}
