/**
 * packages/herdr/src/downtime-worker.idle.ts — downtime-worker idle
 * evaluation and idle-duration tracking.
 *
 * Single responsibility: decide whether the local LLM pool is idle — the
 * full global idle checks, the fail-closed per-slot evaluation, the
 * spare-capacity mode and the prefill-gate pacing — and track how long the
 * pool (globally or per slot) has been continuously free.
 *
 * Moved verbatim out of `downtime-worker.ts` (parent WL-0MVF3F9A7000HKP7;
 * child WL-0MVLIHY1P002WP0D). No behaviour change: evaluation order,
 * fail-closed defaults, thresholds, the `N < total slots` degradation and
 * the spare-capacity per-slot mode (WL-0MT32F90V008UAD2) are unchanged.
 *
 * Layering: imports only `./downtime-worker.types.js` (types are erased at
 * runtime) and `./downtime-worker.constants.js` (the `reportedIdleSeconds`
 * re-export below); never the barrel (`downtime-worker.ts`) and never
 * `./stalled-work.js`, so no runtime cycle can form.
 */

import type {
  IdleTracker,
  LlamaSlot,
  LlamaStatus,
  PerSlotIdleTracker,
  PrefillPacing,
} from './downtime-worker.types.js';

/**
 * Proxy-authoritative local idle age, declared once in
 * `./downtime-worker.constants.js` (landed there by the constants/types
 * child) and re-exported from the idle module so the idle semantics are
 * consumable from one place. No second declaration, no behaviour change.
 */
export { reportedIdleSeconds } from './downtime-worker.constants.js';

// ── Idle detection (implemented) ──────────────────────────────────────

/**
 * The FULL global idle checks used by `isIdleStatus` and the all-slots-free
 * (`N ≤ 0` / `N ≥ total`) path of `evaluateIdle`: llama-server up, no active
 * local query (the sole busy signal), no model switch, no local lease. The
 * spare-capacity path uses the relaxed `perSlotGlobalIdleChecks` instead
 * (spare-capacity dispatch, parent WL-0MT32F90V008UAD2).
 *
 * `local_active_query` is the SOLE busy signal for the query gate:
 * `true` → busy, `false` → not busy from queries. ABSENT on pre-fix proxies
 * → busy (fail-closed), preventing dispatch when the busy signal is
 * unverifiable. With schema-v2 truthful `lease_state` the coarse global
 * lease flag is superseded by per-slot availability (LP-0MVGDUVGE0024YAI).
 */
function globalIdleChecks(status: LlamaStatus): boolean {
  if (!status.llama_server_running) return false;
  // `local_active_query` is the sole busy signal (LP-0MSL2ZLLS009RVKR):
  // true → busy, false → not busy, absent (pre-fix proxy) → busy (fail-closed).
  if (status.local_active_query !== false) return false;
  if (status.model_switch_in_progress) return false;
  // Schema v2 (LP-0MVGDUVGE0024YAI): truthful per-slot lease_state supersedes
  // the coarse global `local_lease_active` flag — an `idle_leased` slot is
  // reserved-but-idle and must not block dispatch. Without truthful
  // per-slot lease state keep the fail-closed global gate.
  if (!hasTruthfulLeaseState(status) && status.local_lease_active) return false;
  return true;
}

/**
 * True when the payload carries schema-v2 truthful per-slot lease state:
 * version >= 2 AND every reported slot has a `lease_state`. A mixed or
 * pre-v2 payload returns false, so the legacy `owner_session_id` /
 * `local_lease_active` rules apply unchanged.
 */
function hasTruthfulLeaseState(status: LlamaStatus): boolean {
  return (
    typeof status.status_schema_version === 'number' &&
    status.status_schema_version >= 2 &&
    Array.isArray(status.slots) &&
    status.slots.length > 0 &&
    status.slots.every((slot) => slot.lease_state !== undefined)
  );
}

/**
 * Per-slot-safe global checks (spare-capacity dispatch, parent
 * WL-0MT32F90V008UAD2): in per-slot identity mode, ONLY llama-server-up and
 * no-model-switch remain GLOBAL gates — `local_active_query` /
 * `local_lease_active` are superseded by the per-slot
 * `is_processing` signal (the busy slot holding the operator's query/lease IS
 * the active work the operator wants to run alongside; it must not block
 * dispatch into the free slots, LP-0MSG5TA7Y002GN39 Q&A). Used by the
 * spare-capacity path of `evaluateIdle` and `createDowntimeWorker.tick()`;
 * the all-slots-free path keeps the full `globalIdleChecks` (fail-closed).
 *
 * Exported (not part of the intended public API): the orchestrator tick in
 * `downtime-worker.ts` reuses these helpers directly after the split.
 */
export function perSlotGlobalIdleChecks(status: LlamaStatus): boolean {
  if (!status.llama_server_running) return false;
  if (status.model_switch_in_progress) return false;
  return true;
}

/**
 * True when a slot reports a live Local Proxy owner (AC5, parent
 * WL-0MTYZXSLN008HZOW): a non-empty `owner_session_id`. On PRE-v2 payloads
 * this means the slot must never be considered free for a new dispatch until
 * `release-lease-on-exit.mjs` releases it. With schema-v2 `lease_state`
 * (LP-0MVGDUVGE0024YAI) use {@link isSlotAvailableForDispatch} instead — an
 * `idle_leased` slot is owned but still dispatchable capacity.
 */
export function isSlotOwned(slot: LlamaSlot): boolean {
  return typeof slot.owner_session_id === 'string' && slot.owner_session_id.length > 0;
}

/**
 * True when a slot is dispatchable capacity.
 *
 * Fail-closed: a slot without an explicit boolean `is_processing` is treated
 * as busy. With schema-v2 `lease_state` (LP-0MVGDUVGE0024YAI) only
 * `generating` is busy — `idle_leased` is reserved-but-idle and `free` is
 * available. On pre-v2 payloads the legacy `owner_session_id` rule applies:
 * any live owner lease makes the slot busy (AC5, WL-0MTYZXSLN008HZOW).
 */
export function isSlotAvailableForDispatch(slot: LlamaSlot): boolean {
  if (typeof slot.is_processing !== 'boolean' || slot.is_processing) return false;
  if (slot.lease_state !== undefined) return slot.lease_state !== 'generating';
  return !isSlotOwned(slot);
}

/**
 * Count slots eligible for a new dispatch. Fail-closed: a slot without an
 * explicit boolean `is_processing` is treated as processing (busy).
 *
 * Schema v2 (LP-0MVGDUVGE0024YAI): eligibility follows `lease_state`, so an
 * `idle_leased` slot counts as capacity even though it still carries an
 * owner. On pre-v2 payloads an owned slot remains busy (legacy behaviour,
 * AC5).
 */
export function countFreeUnownedSlots(slots: LlamaSlot[]): number {
  let count = 0;
  for (const slot of slots) {
    if (!isSlotAvailableForDispatch(slot)) continue;
    count += 1;
  }
  return count;
}

/**
 * Usable per-slot identity (WL-0MUFP30T2003OX1F; fail-closed contract
 * WL-0MUXVPXAZ005RESW): the `slots` array is only trustworthy when it is
 * NON-EMPTY and NOT flagged stale by the proxy. An empty array (`slots: []`)
 * means "no per-slot detail available" — NOT "zero free slots" — and
 * `slots_stale: true` means the counts came from the proxy's last-known
 * cache after a failed /slots query, so the detail cannot be paired with
 * them. `null` signals "unusable"; callers MUST fail closed (no dispatch)
 * rather than falling back to the untrusted `available_slots` count.
 *
 * Exported (not part of the intended public API): the orchestrator tick in
 * `downtime-worker.ts` reuses these helpers directly after the split.
 */
export function usablePerSlotSlots(status: LlamaStatus): LlamaSlot[] | null {
  if (!Array.isArray(status.slots)) return null;
  if (status.slots.length === 0) return null;
  if (status.slots_stale === true) return null;
  return status.slots;
}

/**
 * True when the poll itself reports LIVE local activity
 * (WL-0MVHSZR9C0012NQY AC3): a busy/owned slot, a coarse live lease (only
 * when the payload carries no truthful per-slot `lease_state`, mirroring
 * `globalIdleChecks`), or a live contention/gate waiter.
 *
 * Activity evidence ALWAYS outranks the proxy's reported
 * `local_idle_seconds`: a contradictory payload (large idle age + live work)
 * is refused the idle-age shortcut and falls back to the local tracker
 * exactly as a pre-feature proxy would (fail closed, never dispatch on
 * unverifiable signals). Per-slot continuous-free semantics are untouched —
 * this only decides whether the GLOBAL idle age may satisfy the DURATION
 * requirement on this poll.
 *
 * Exported (not part of the intended public API): the orchestrator tick in
 * `downtime-worker.ts` reuses these helpers directly after the split.
 */
export function pollShowsLocalActivity(
  status: LlamaStatus,
  slots: LlamaSlot[],
  contentionDepth: number,
): boolean {
  if (contentionDepth > 0) return true;
  // Schema v2: truthful per-slot `lease_state` supersedes the coarse global
  // flag (an `idle_leased` slot is reserved-but-idle capacity).
  if (!hasTruthfulLeaseState(status) && status.local_lease_active === true) return true;
  return slots.some((slot) => !isSlotAvailableForDispatch(slot));
}

/**
 * True when the proxy reports an idle state for the required free-slot
 * count:
 *
 *  - llama-server is running,
 *  - no active query or model switch, and (on pre-v2 payloads) no local
 *    lease — with schema-v2 truthful `lease_state` the per-slot state
 *    decides, so `idle_leased` does not block dispatch,
 *  - `requiredFreeSlots <= 0` (default) requires ALL slots free
 *    (`available_slots >= total_slots`) with `total_slots > 0`,
 *  - a positive N requires at least N slots free; N > total_slots can never
 *    be satisfied, so it is never idle,
 *  - ambiguous responses (missing/non-finite fields, `total_slots` 0) are
 *    busy (fail-closed).
 */
export function isIdleStatus(status: LlamaStatus, requiredFreeSlots: number): boolean {
  if (!globalIdleChecks(status)) return false;

  const total = status.total_slots;
  if (!Number.isFinite(total) || total <= 0) return false; // ambiguous → busy

  const available = status.available_slots;
  if (!Number.isFinite(available) || available < 0) return false;

  const required = requiredFreeSlots <= 0 ? total : requiredFreeSlots;
  if (required > total) return false; // N > total_slots can never be idle
  return available >= required;
}

/**
 * Runtime idle evaluation. Fail-closed contract (WL-0MUXVPXAZ005RESW): the
 * per-slot `slots` array is the ONLY trusted availability source. When it is
 * unusable — absent, empty (`slots: []`), or flagged stale
 * (`slots_stale: true`) — `usablePerSlotSlots` returns null and this
 * function returns false, so no dispatch can be admitted from the untrusted
 * `available_slots` count.
 *
 * With usable per-slot detail:
 *  - spare-capacity mode (0 < N < total): the relaxed global gate applies
 *    (server up + no model switch only) — a query/lease tied to a busy slot
 *    is the operator's own session and must not block dispatch into the
 *    free slots (parent WL-0MT32F90V008UAD2). The budget is the per-slot
 *    free count.
 *  - all-slots-free mode (N ≤ 0 / N ≥ total): the full `globalIdleChecks`
 *    apply (unchanged). N ≤ 0 requires every slot free; N > total can never
 *    be satisfied.
 */
export function evaluateIdle(status: LlamaStatus, requiredFreeSlots: number): boolean {
  // Schema-v2 defensive cross-check (LP-0MVGDUVGE0024YAI AC4): a saturated
  // pool is never idle, even if the per-slot detail looks inconsistent.
  if (status.capacity_hint === 'saturated') return false;

  const total = status.total_slots;
  if (!Number.isFinite(total) || total <= 0) return false; // ambiguous → busy

  // Fail-closed (WL-0MUXVPXAZ005RESW): without usable per-slot detail there
  // is no trustworthy availability signal — never fall back to the count.
  const perSlotSlots = usablePerSlotSlots(status);
  if (perSlotSlots === null) return false;

  const spareCapacity = requiredFreeSlots > 0 && requiredFreeSlots < total;
  if (spareCapacity) {
    if (!perSlotGlobalIdleChecks(status)) return false;
  } else if (!globalIdleChecks(status)) {
    return false;
  }

  const required = requiredFreeSlots <= 0 ? total : requiredFreeSlots;
  if (required > total) return false; // N > total_slots can never be idle
  // Fail-closed counting: an entry without an explicit boolean
  // `is_processing` is treated as processing (busy), never free. Owned
  // slots (live lease) are excluded (AC5, WL-0MTYZXSLN008HZOW).
  return countFreeUnownedSlots(perSlotSlots) >= required;
}

// ── Prefill-gate pacing (WL-0MVHSZRZQ00482QX) ────────────────────────


/**
 * Compute the prefill pacing decision for one poll.
 *
 * PACING ONLY REDUCES CONCURRENCY: a missing/disabled cap leaves
 * `capacityBudget` `undefined` (today's free-slot-only budget), and the
 * caller takes `min(freeSlots, capacityBudget)`. `prefill_gate_waiters > 0`
 * is contention evidence equivalent to a non-empty `contention_queue_depth`.
 * A projected wait is deferred only when BOTH the ETA and the admission
 * budget are present and finite — a missing value never blocks dispatch.
 *
 * ETA-deferral prerequisites (parent WL-0MVPRZU0A000TSWD):
 *  - calibration (AC1): `prefill_eta_calibrated === false` → fail open — the
 *    proxy's own admission guard is inert below `MIN_CALIBRATION_SAMPLES`, so
 *    an uncalibrated estimate never paces. `undefined` (legacy proxy) keeps
 *    today's behaviour.
 *  - occupancy-only (AC2): the paced queue term is the wait behind OTHER
 *    prefills (`queue_eta_occupancy_seconds`); the newcomer's own prefill
 *    never blocks dispatch, and an absent occupancy ETA is zero occupancy.
 *  - per-slot (AC4): a slot's `prefill_eta_seconds` counts only when the
 *    slot is actually busy.
 */
export function evaluatePrefillPacing(
  status: LlamaStatus,
  slots: LlamaSlot[] | null,
): PrefillPacing {
  const pacing: PrefillPacing = {};

  const inFlight = status.local_prefills_in_flight;
  if (typeof inFlight === 'number') pacing.inFlight = inFlight;
  const cap = status.local_max_concurrent_prefills;
  if (typeof cap === 'number') pacing.cap = cap;
  const gateWaiters = status.prefill_gate_waiters;
  if (typeof gateWaiters === 'number') pacing.gateWaiters = gateWaiters;
  const budget = status.prefill_budget_seconds;
  if (typeof budget === 'number') pacing.budgetSeconds = budget;
  const queueEta = status.queue_eta_seconds;
  if (typeof queueEta === 'number') pacing.queueEtaSeconds = queueEta;
  // Occupancy/calibration evidence (LP-0MVGDUV5E005UWBQ, parent
  // WL-0MVPRZU0A000TSWD AC3): carried on the pacing decision whenever served
  // so a paced tick is diagnosable even before the decision-record evidence.
  const queueEtaOccupancy = status.queue_eta_occupancy_seconds;
  if (typeof queueEtaOccupancy === 'number') {
    pacing.queueEtaOccupancySeconds = queueEtaOccupancy;
  }
  const queueEtaBusySlots = status.queue_eta_busy_slots;
  if (typeof queueEtaBusySlots === 'number') {
    pacing.queueEtaBusySlots = queueEtaBusySlots;
  }
  const calibrated = status.prefill_eta_calibrated;
  if (typeof calibrated === 'boolean') pacing.prefillEtaCalibrated = calibrated;

  // Per-slot ETA (parent AC4): only slots that are ACTUALLY busy contribute
  // their `prefill_eta_seconds` — an idle pool's stale per-slot ETA is the
  // newcomer's own cost, never a queue wait it must respect.
  if (slots !== null) {
    for (const slot of slots) {
      if (!isSlotBusyWithPrefill(slot)) continue;
      const eta = slot.prefill_eta_seconds;
      if (typeof eta !== 'number') continue;
      if (pacing.maxSlotPrefillEtaSeconds === undefined || eta > pacing.maxSlotPrefillEtaSeconds) {
        pacing.maxSlotPrefillEtaSeconds = eta;
      }
    }
  }

  // Prefill capacity budget: only a POSITIVE cap with a known in-flight count
  // can pace. `cap === 0` disables the gate (unbounded); an absent cap or
  // in-flight count cannot be judged → unbounded (today's behaviour). This
  // fail-closed counter is untouched by the calibration/occupancy rules.
  if (typeof cap === 'number' && cap > 0 && typeof inFlight === 'number') {
    pacing.capacityBudget = inFlight >= cap ? 0 : cap - inFlight;
  }

  // Deferral precedence: gate waiters (contention) → cap saturated → ETA.
  // `prefill-cap` and `prefill-gate` keep their precedence while the proxy is
  // uncalibrated (parent AC1) — only the ETA term is calibration-gated.
  if (typeof gateWaiters === 'number' && gateWaiters > 0) {
    pacing.deferReason = 'prefill-gate';
    return pacing;
  }
  if (pacing.capacityBudget === 0) {
    pacing.deferReason = 'prefill-cap';
    return pacing;
  }
  // ETA deferral (parent WL-0MVPRZU0A000TSWD): calibration is a prerequisite
  // (AC1, fail open), the queue term is occupancy-only (AC2) and the per-slot
  // term only counts busy slots (AC4, computed above).
  if (typeof budget !== 'number') return pacing; // absent budget → cannot judge
  if (calibrated === false) return pacing; // AC1: fail open while uncalibrated
  const queueTerm = queueEtaTerm(status);
  const slotEtaExceeds =
    pacing.maxSlotPrefillEtaSeconds !== undefined &&
    pacing.maxSlotPrefillEtaSeconds > budget;
  if (queueTerm > budget || slotEtaExceeds) pacing.deferReason = 'prefill-eta';
  return pacing;
}

/**
 * Whether a slot is genuinely prefilling (parent AC4): the only slots whose
 * per-slot `prefill_eta_seconds` a newcomer would wait behind. An
 * `idle_leased` / `free` slot carries no in-flight prefill the pool must
 * respect.
 */
function isSlotBusyWithPrefill(slot: LlamaSlot): boolean {
  return slot.is_processing === true || slot.lease_state === 'generating';
}

/**
 * The queue ETA term that may pace dispatch (parent WL-0MVPRZU0A000TSWD
 * AC2): the OCCUPANCY wait — the wait behind OTHER in-flight prefills —
 * never the newcomer's own prefill:
 *
 *  - `queue_eta_occupancy_seconds` when served is that term directly;
 *  - on a LEGACY proxy (no calibration signal) the total `queue_eta_seconds`
 *    keeps today's behaviour (AC1), so the term is the total;
 *  - on a calibration-aware proxy whose occupancy fields are absent the
 *    total is used only when occupancy evidence exists
 *    (`local_prefills_in_flight > 0` or a busy slot) — otherwise the pool
 *    has no occupancy to wait behind;
 *  - any other shape (an occupancy field served but unusable) is ZERO
 *    occupancy — an absent occupancy ETA never means "unknown ⇒ defer"
 *    (parent AC4 / this item's AC6).
 */
function queueEtaTerm(status: LlamaStatus): number {
  const occupancy = status.queue_eta_occupancy_seconds;
  if (typeof occupancy === 'number') return occupancy;
  const totalEta = status.queue_eta_seconds;
  const occupancyFieldsAbsent =
    occupancy === undefined && status.queue_eta_busy_slots === undefined;
  if (occupancyFieldsAbsent && status.prefill_eta_calibrated === undefined) {
    // Legacy proxy: no calibration signal → today's total-ETA behaviour.
    return typeof totalEta === 'number' ? totalEta : 0;
  }
  if (occupancyFieldsAbsent && typeof totalEta === 'number' && hasOccupancyEvidence(status)) {
    // Calibrated proxy that did not serve the split: genuine contention is
    // the only justification for the total (own + occupancy) fallback.
    return totalEta;
  }
  return 0;
}

/**
 * True when the poll carries evidence of OTHER in-flight prefills the
 * newcomer would queue behind: the proxy's own in-flight counter above zero,
 * or a busy slot in the per-slot detail (parent AC2 fallback rule).
 */
function hasOccupancyEvidence(status: LlamaStatus): boolean {
  if (typeof status.local_prefills_in_flight === 'number' && status.local_prefills_in_flight > 0) {
    return true;
  }
  if (Array.isArray(status.slots)) {
    return status.slots.some((slot) => isSlotBusyWithPrefill(slot));
  }
  return false;
}

// ── Idle-duration tracker (implemented — F3) ──────────────────────────


/**
 * Continuous idle-duration tracker. `idleSince` is set on the first idle
 * poll and kept fixed for the whole idle run (so consecutive idle polls
 * advance the run); ANY busy poll resets it to null. A dispatch therefore
 * only fires after the idle state has been continuous for the full
 * threshold, and a fresh full idle period is required after any busy poll.
 */
export function createIdleTracker(): IdleTracker {
  let idleSince: number | null = null;
  return {
    get idleSince(): number | null {
      return idleSince;
    },
    record(isIdle: boolean, now: number = Date.now()): void {
      idleSince = isIdle ? (idleSince ?? now) : null;
    },
    isThresholdMet(thresholdMs: number, now: number = Date.now()): boolean {
      if (idleSince === null) return false;
      return now - idleSince >= thresholdMs;
    },
  };
}

// ── Per-slot idle tracker (WL-0MSG7P9N8009PCKG) ───────────────────────


/**
 * Map-backed per-slot idle tracker. `idleSince` is set on each slot's first
 * free poll and kept fixed across consecutive free polls; the slot's own
 * timer resets (null) when it reports processing or disappears from a poll.
 */
export function createPerSlotIdleTracker(): PerSlotIdleTracker {
  const idleSince = new Map<string, number | null>();
  return {
    get idleSince(): ReadonlyMap<string, number | null> {
      return idleSince;
    },
    record(slots: LlamaSlot[], now: number = Date.now()): void {
      const reported = new Set<string>();
      for (const slot of slots) {
        reported.add(slot.slot_id);
        if (!isSlotAvailableForDispatch(slot)) {
          // Processing / generating / pre-v2-owned → this slot's timer resets.
          idleSince.set(slot.slot_id, null);
        } else {
          idleSince.set(slot.slot_id, idleSince.get(slot.slot_id) ?? now);
        }
      }
      // Fail-closed: any known slot not reported this poll is treated as
      // busy (its timer resets) — a slot is only ever considered free when
      // the proxy explicitly says so.
      for (const slotId of [...idleSince.keys()]) {
        if (!reported.has(slotId)) idleSince.set(slotId, null);
      }
    },
    thresholdMetCount(thresholdMs: number, now: number = Date.now()): number {
      let count = 0;
      for (const since of idleSince.values()) {
        if (since !== null && now - since >= thresholdMs) count += 1;
      }
      return count;
    },
  };
}

