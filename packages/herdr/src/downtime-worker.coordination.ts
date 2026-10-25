/**
 * packages/herdr/src/downtime-worker.coordination.ts — the coordination OFFER
 * computation.
 *
 * Single responsibility: compute the ONE item an instance OFFERS to the
 * coordination leader — the tier rank, the candidate shape and the sequential
 * safety filters over the instance's own Herdr list head — without dispatching
 * anything.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Extracted verbatim from `downtime-worker.ts` by WL-0MVLII1AO007TTRK (extract
 * downtime-worker coordination modules). No behaviour change: the tier order,
 * the offer filter chain, the neutral hold reasons and the result
 * discriminants are unchanged — the 15 `downtime-worker.*` suites plus
 * `coordination-dispatch.test.ts` are the preservation gate. The leader half of
 * the same section (gated dispatch, batch runtime, check-in) lives in
 * `downtime-worker.coordination-leader.ts`, which imports this module; the
 * dependency runs one way only (offer computation never imports the leader).
 */

import { DEFAULT_BROWSE_ITEM_COUNT, resolveSprintViewWindow } from './browse-window.js';
import { DEFAULT_DOWNTIME_CPU_GATE_PERCENT } from './host-cpu.js';
import {
  COORDINATION_TIER_ORDER,
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
  type CoordinationTierKind,
} from './downtime-worker.constants.js';
import { resolveCpuGate, type HostCpuGateDeps } from './downtime-worker.dispatch-cpu-gate.js';
import { selectCriticalFirstCandidates } from './downtime-worker.dispatch-filter.js';
import type { DowntimeDispatchDeps } from './downtime-worker.dispatch-contract.js';
import {
  REVIEW_QUEUE_HOLD_REASON,
  classifyItemForDispatch,
  evaluateCriticalFirstGuard,
  fetchExtendedHerdrItems,
  flagBudgetExhausted,
  isAttemptBudgetExhausted,
  isImplementHeldByReviewGate,
  readReviewQueueGate,
  type DowntimeGateDeps,
  type ReviewQueueGateResult,
} from './downtime-worker.gates.js';
import {
  dispatchedItemMarkers as _dispatchedMarkers,
  isNonTerminalCooldownActive as _isNonTerminalCooldownActive,
  markerStillExcludes as _markerStillExcludes,
  readDowntimeLogEntries as _readDowntimeEntries,
  type DispatchMarker,
} from './downtime-log.js';
import { resolveInFlightPanes } from './downtime-worker.pane.js';
import { resumeStalledWorkIfAble } from './downtime-worker.stalled-resume.js';
import type {
  DowntimeCandidate,
  DowntimeHerdrItem,
  DowntimeItemInfo,
  DowntimeSkillKind,
  DowntimeStage,
  MostImportantItemResult,
} from './downtime-worker.types.js';

/**
 * The offer-facing dependency slice: the dispatch seams the offer computation
 * calls plus the review-queue gate and host-CPU seams. Named structurally so
 * this module never imports the barrel (`CoordinationDeps` lives in
 * `downtime-worker.ts`); every member is the same method the barrel declares,
 * so callers keep passing the full deps object unchanged.
 */
export type CoordinationDeps = DowntimeDispatchDeps & DowntimeGateDeps & HostCpuGateDeps;

// ── Leader-election coordination dispatch (parent WL-0MST3OJ8S0001ROL) ──

/**
 * Rank of a dispatch kind in the coordinator tier priority (audit >>
 * implement >> plan >> intake). Unknown/null kinds rank below every tier
 * (-1) — never dispatchable.
 */
export function coordinationTierRank(kind: DowntimeSkillKind | null): number {
  if (kind === null) return -1;
  const idx = COORDINATION_TIER_ORDER.indexOf(kind as CoordinationTierKind);
  return idx === -1 ? -1 : idx;
}

/** Build a dispatch candidate from fetched item info. */
export function toCoordinationCandidate(info: DowntimeItemInfo): DowntimeCandidate {
  return {
    id: info.id,
    title: info.title ?? '',
    stage: (info.stage as DowntimeStage) ?? 'idea',
    status: info.status,
    priority: info.priority,
    sortIndex: info.sortIndex,
    needsProducerReview: info.needsProducerReview,
  };
}

/**
 * Compute this instance's most-important dispatchable work item (parent
 * AC3 / AC5): the FIRST item of ITS OWN worklog's Herdr selection list
 * (the canonical ranking — fetcher → smart-selection → grouping,
 * WL-0MTK1ILM2009QYB2 "dispatcher == Herdr list head") that passes the
 * sequential dispatch filters. This feeds the coordination check-in
 * OFFER: the entry an instance stores in the shared coordination file is
 * exactly its current Herdr list head, so the leader never has to
 * re-rank an offer against a second ordering (see
 * `dispatchFromCoordination`).
 *
 * The filters mirror the direct dispatch path (`dispatchFromHerdrList`)
 * but WITHOUT dispatching:
 *  - scheduled prompts are skipped (they have no work item);
 *  - `classifyItemForDispatch` enforces the producer-review gate
 *    (WL-0MTIAL65N004T22F) plus the audit freshness/recency window and
 *    the implement risk/effort caps;
 *  - the dispatched-marker exclusions (audit/implement/plan/intake marker
 *    sets, WL-0MSLIY8ZR004QUSY) ensure an item already dispatched by this
 *    worker is never offered again — the durable marker stays the source
 *    of truth;
 *  - the code-freeze split-by-skill pauses audit/implement offers while
 *    frozen (plan/intake still offer) — the same freeze semantics as the
 *    dispatch path (WL-0MSQ0RPQP00636JY);
 *  - the review-queue depth gate (WL-0MT2UQWOR007CYY9, rewired by
 *    WL-0MTTSWC1X005P4VD) holds a NON-CRITICAL implement offer while the
 *    root's completed/in_review queue is deep — audits (the queue drain),
 *    plan, intake and critical implements still offer; when ONLY held
 *    implements remain the result is `{ok:true, reviewQueueHold:true}`
 *    (never `noCandidate`), so the no-candidate cooldown is not entered
 *    while the queue drains.
 *  - the non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5) holds an
 *    item whose previous same-kind pane closed without reaching a terminal
 *    stage until `downtimeNonTerminalCooldownMs` elapses (or the item
 *    advances past its dispatched-at stage); when ONLY cooldown-held items
 *    remain the result is `{ok:true, nonTerminalCooldownHold:true}` (never
 *    `noCandidate`), so the no-candidate cooldown is not entered.
 *
 * Active-audit single-flight and the free-slot minimums are
 * dispatch-time gates, so they are NOT applied to an offer.
 *
 * A Herdr-list lookup failure resolves `{ok:false}` (fail-open: the
 * caller keeps the existing entry — a transient wl error must never drop
 * a valid offer); an empty list or a fully-filtered list resolves
 * `{ok:true, noCandidate:true}` (a genuine empty backlog — the caller may
 * remove the own entry).
 */
export async function computeMostImportantItem(
  deps: CoordinationDeps,
  cwd: string,
  now: number = Date.now(),
  browseItemCount: number = DEFAULT_BROWSE_ITEM_COUNT,
  markerStaleWindowMs: number = DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  nonTerminalCooldownMs: number = DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  maxAttempts: number = DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  stallScanEnabled: boolean = true,
  stallThresholdMs: number = DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
  cpuGatePercent: number = DEFAULT_DOWNTIME_CPU_GATE_PERCENT,
): Promise<MostImportantItemResult> {
  // The check-in (and the worker's no-candidate probe) requires the Herdr
  // head lookup: without it there is no canonical ranking to offer from —
  // fail closed to `{ok:false}` (the caller keeps the existing entry).
  if (typeof deps.getHerdrListHead !== 'function') {
    return { ok: false, error: 'getHerdrListHead unavailable' };
  }
  const freezeStatus = deps.readCodeFreezeStatus(cwd);
  const frozen = freezeStatus === 'frozen' || freezeStatus === 'ambiguous';
  // Host-CPU gate (WL-0MVK0UO3Q002TXW6 AC4): the OFFER computation is
  // deliberately NOT gated — suppressing audit/implement offers would strip
  // the leader's candidate list and drive the 60-minute `no-candidate`
  // cooldown, so dispatch would not resume promptly after CPU recovers. Only
  // the stalled-resume side effect below is skipped while saturated (AC3).
  const cpuSaturated = resolveCpuGate(deps, cpuGatePercent).saturated;

  // ── Stalled-work scan (WL-0MUYMBSA90092QV2 AC4) ──
  // Consult the scan FIRST, before any new-item selection: a successfully
  // resumed stalled pane is the preferred work, so the instance offers
  // NOTHING this cycle (the caller keeps its entry / does not pause).
  if (stallScanEnabled) {
    const resumed = await resumeStalledWorkIfAble(deps, cwd, {
      enabled: stallScanEnabled,
      frozen,
      cpuSaturated,
      thresholdMs: stallThresholdMs,
      nonTerminalCooldownMs,
      maxAttempts,
      now,
    });
    if (resumed) return { ok: true, stalledResume: true };
  }

  // The dispatch window is the sprint view: the live per-root
  // `browseItemCount`, clamped exactly as the TUI worklist does
  // (WL-0MUNS8X97007C9H9 AC1). Passing the effective value means the head —
  // and therefore every candidate — equals the rendered view.
  const sprintWindow = resolveSprintViewWindow(browseItemCount);

  const head = await deps.getHerdrListHead(cwd, sprintWindow);
  if (!head.ok) return { ok: false, error: head.error }; // CLI error — fail-open (entry kept)
  if (head.items.length === 0) return { ok: true, noCandidate: true };

  // Dispatched-marker exclusion (mirrors dispatchFromHerdrList): read the
  // shared rolling dispatch log for THIS worklog root so an item already
  // dispatched by this worker is never offered to the coordinator again.
  const entries = await _readDowntimeEntries(cwd);
  // Staleness-aware success-marker maps (WL-0MU6UL0RJ008IHGT): id → the
  // dispatched-at stage + timestamp, read once per offer computation and
  // consulted through `markerStillExcludes` below. A SUCCESS marker excludes
  // only while the item is STILL at the marker's dispatched-at stage AND the
  // marker is fresh (age ≤ markerStaleWindowMs); a stale marker at an
  // unchanged stage is released so a stranded item is re-offered (AC4).
  const markerMaps: Record<DowntimeSkillKind, Map<string, DispatchMarker>> = {
    audit: _dispatchedMarkers(entries, 'audit'),
    implement: _dispatchedMarkers(entries, 'implement'),
    plan: _dispatchedMarkers(entries, 'plan'),
    intake: _dispatchedMarkers(entries, 'intake'),
    'risk-effort': _dispatchedMarkers(entries, 'risk-effort'),
  };

  // Review-queue depth gate: read lazily (memoized) only when an
  // implement-kind candidate is actually the would-be offer — one bounded
  // wl list per offer computation when needed (WL-0MTTSWC1X005P4VD).
  let reviewGate: ReviewQueueGateResult | null | undefined;
  const reviewGateForQueue = async (): Promise<ReviewQueueGateResult | null> => {
    if (reviewGate === undefined) {
      // Frozen already pauses audit/implement offers (filter below), so the
      // gate is never consulted under a freeze.
      reviewGate = frozen ? null : await readReviewQueueGate(deps, cwd, sprintWindow);
    }
    return reviewGate;
  };
  let heldByReviewQueue = false;
  // Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5): neutral hold —
  // the backlog is not empty, so the caller must not pause.
  let heldByCooldown = false;
  // Per-item/per-kind attempt-budget hold (WL-0MUKYEXMK0033MFK): neutral hold
  // — the backlog is not empty, so the caller must not pause. An item already
  // flagged this call is recorded so the producer-review flag is set at most
  // once (AC7c).
  let heldByBudget = false;
  const flaggedForBudget = new Set<string>();

  // Item-scoped in-flight guard (WL-0MUBEZ6PE002WLP4 / F4
  // WL-0MUBVKYH5009CGBI): resolved for THIS instance's OWN root (`cwd`) —
  // never the leader's root (WL-0MTQ14W7L003II5A cross-root invariant).
  // Resolved lazily via the shared F3 resolver; unavailable resolves to the
  // marker-TTL fallback inside the decision table.
  const inFlight = await resolveInFlightPanes(deps, cwd);
  let heldByInFlight = false;

  // Critical-first scan (WL-0MU6UL3XY001M3VT): a critical item blocked by a
  // NON-SAFETY filter (stale dispatched marker, review-queue depth hold) must
  // still be OFFERED — otherwise the check-in floats a lower-priority head
  // item and the leader never dispatches the critical work. Safety gates
  // (`needsProducerReview`, code-freeze split-by-skill) still apply inside the
  // helper; free-slot minimums and active-audit single-flight remain
  // dispatch-time gates and are intentionally not applied to an offer.
  //
  // In-flight guard (F4): a critical item with a live working pane is NOT
  // offered — the scan continues to the next critical candidate, then to the
  // normal window, so the instance offers its next dispatchable head item
  // instead of floating an in-flight duplicate (AC2.7).
  for (const criticalFirst of selectCriticalFirstCandidates(head.items, now, frozen)) {
    const marker = markerMaps[criticalFirst.kind]?.get(criticalFirst.item.id);
    const guard = evaluateCriticalFirstGuard(
      criticalFirst.item.id,
      inFlight,
      marker?.dispatchedAt,
      now,
      markerStaleWindowMs,
    );
    if (!guard.escalate) {
      heldByInFlight = true;
      continue;
    }
    // Per-item/per-kind attempt budget (WL-0MUKYEXMK0033MFK AC1/AC2/AC3): a
    // critical item that has exhausted its automatic attempts is flagged and
    // NOT offered. Evaluated after the in-flight guard so a live pane is
    // never pre-empted.
    if (isAttemptBudgetExhausted(entries, criticalFirst.item.id, criticalFirst.kind, criticalFirst.item.stage, maxAttempts)) {
      if (!flaggedForBudget.has(criticalFirst.item.id)) {
        flaggedForBudget.add(criticalFirst.item.id);
        await flagBudgetExhausted(deps, criticalFirst.item.id, cwd);
      }
      heldByBudget = true;
      continue;
    }
    const candidate: DowntimeCandidate = {
      id: criticalFirst.item.id,
      title: criticalFirst.item.title,
      stage: criticalFirst.kind === 'audit'
        ? 'audit'
        : ((criticalFirst.item.stage as DowntimeStage) ?? 'idea'),
      status: criticalFirst.item.status,
      priority: criticalFirst.item.priority,
      sortIndex: criticalFirst.item.sortIndex,
    };
    return { ok: true, kind: criticalFirst.kind, candidate };
  }

  /**
   * Scan one ordered candidate window for the first offerable item (the
   * sequential filters mirror `dispatchFromHerdrList`). Returns null when
   * nothing in the window is offerable; `heldByReviewQueue` records whether
   * the only reason was the deep-queue hold of a non-critical implement.
   */
  const findOfferIn = async (
    items: DowntimeHerdrItem[],
  ): Promise<{ ok: true; kind: DowntimeSkillKind; candidate: DowntimeCandidate } | null> => {
    for (const item of items) {
      const k = classifyItemForDispatch(item, now);
      if (k === null) continue; // review-gate + freshness/recency + caps
      // Dispatched-marker exclusion per kind, staleness-aware
      // (WL-0MU6UL0RJ008IHGT): exclude only while the item is STILL at the
      // marker's dispatched-at stage AND the marker is fresh; a stale marker
      // at an unchanged stage releases. Audit/implement use the id-guard mode
      // (legacy stage-less markers stay protected while fresh); the stage-
      // guard tiers release a legacy marker.
      const marker = markerMaps[k]?.get(item.id);
      if (
        marker !== undefined &&
        _markerStillExcludes(
          marker,
          item.stage,
          now,
          markerStaleWindowMs,
          k === 'audit' || k === 'implement' ? 'id-guard' : 'stage-guard',
        )
      ) {
        continue;
      }
      // Per-item/per-kind attempt budget (WL-0MUKYEXMK0033MFK AC1/AC2/AC3):
      // flag the item for producer review and do not offer it once its
      // attempts at the current stage reach the cap. Neutral hold (AC5).
      if (isAttemptBudgetExhausted(entries, item.id, k, item.stage, maxAttempts)) {
        if (!flaggedForBudget.has(item.id)) {
          flaggedForBudget.add(item.id);
          await flagBudgetExhausted(deps, item.id, cwd);
        }
        heldByBudget = true;
        continue;
      }
      // Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5): neutral
      // sequential filter (same placement as the dispatch path).
      if (_isNonTerminalCooldownActive(entries, item.id, k, item.stage, nonTerminalCooldownMs, now)) {
        heldByCooldown = true;
        continue;
      }
      // Code-freeze split-by-skill: audit+implement+risk-effort offers pause
      // during a freeze/ambiguous marker (plan/intake still offer).
      if (frozen && (k === 'audit' || k === 'implement' || k === 'risk-effort')) continue;
      // In-flight guard (F4): never offer a CRITICAL item with a live working
      // pane — the same item-scoped decision table as the dispatch path.
      if (item.priority === 'critical') {
        const guard = evaluateCriticalFirstGuard(item.id, inFlight, marker?.dispatchedAt, now, markerStaleWindowMs);
        if (!guard.escalate) {
          heldByInFlight = true;
          continue;
        }
      }
      // Review-queue depth gate (WL-0MT2UQWOR007CYY9, live-path rewire by
      // WL-0MTTSWC1X005P4VD): hold a NON-CRITICAL implement offer while the
      // queue is deep — the instance then offers its next dispatchable head
      // item (audit/plan/intake) instead of floating a held implement.
      if (k === 'implement') {
        const gate = await reviewGateForQueue();
        if (isImplementHeldByReviewGate(k, item, gate)) {
          heldByReviewQueue = true;
          continue;
        }
      }
      const candidate: DowntimeCandidate = {
        id: item.id,
        title: item.title,
        stage: k === 'audit' ? 'audit' : ((item.stage as DowntimeStage) ?? 'idea'),
        status: item.status,
        priority: item.priority,
        sortIndex: item.sortIndex,
      };
      return { ok: true, kind: k, candidate };
    }
    return null;
  };

  const offer = await findOfferIn(head.items);
  if (offer !== null) return offer;

  // ── Extended dispatch window (WL-0MU6UL3GQ0015AA5) ──
  // Mandatory items (critical + completed/in_review) always occupy the head
  // and consume its slots, so the only offerable item can lie beyond the
  // window. Re-read the SAME ranking path with a bounded larger window and
  // scan only the newly visible items; a window extension, never a second
  // ranking. Runs for every filtered-exhaustion reason (plan/intake offers
  // remain valid under a code-freeze); the terminal result below is
  // unchanged when the extension adds nothing.
  const extendedItems = await fetchExtendedHerdrItems(deps, cwd, head.items);
  if (extendedItems.length > 0) {
    const extendedOffer = await findOfferIn(extendedItems);
    if (extendedOffer !== null) return extendedOffer;
  }

  // Herdr list was non-empty but every item was filtered by a safety gate
  // (or is non-dispatchable). When the ONLY reason nothing was offered is
  // the deep-queue hold of non-critical implements, report the distinct
  // `reviewQueueHold` result — the backlog is NOT empty, so the caller
  // must not treat this as a genuine no-candidate (no cooldown; polling
  // resumes immediately when the queue drains below the threshold).
  return heldByReviewQueue
    ? { ok: true, reviewQueueHold: true }
    : heldByCooldown
      ? { ok: true, nonTerminalCooldownHold: true }
      : heldByBudget
        ? { ok: true, attemptBudgetHold: true }
        : heldByInFlight
          ? { ok: true, inFlightHold: true }
          : { ok: true, noCandidate: true };
}
