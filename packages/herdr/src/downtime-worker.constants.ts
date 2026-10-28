/**
 * packages/herdr/src/downtime-worker.constants.ts — downtime-worker tuning
 * constants and decision helpers.
 *
 * Single responsibility: the tuning constants, coordination tier ordering
 * and decision-entry helpers (`decisionHeaderToken`, `CapacityEvidence`,
 * `DecisionEntryFields`, `capacityEvidence`, `reportedIdleSeconds`).
 * Moved verbatim out of `downtime-worker.ts` (parent WL-0MVF3F9A7000HKP7;
 * promised deliverable of WL-0MVLIHXD1004L0UO, falsely marked complete —
 * landed via WL-0MVN6UUEH009GID8). No behaviour change.
 */

import type { HostCpuSource } from './host-cpu.js';
import type { LlamaSlot, LlamaStatus } from './downtime-worker.types.js';

// ── Constants ─────────────────────────────────────────────────────────

/** Proxy status endpoint path. */
export const DOWNTIME_STATUS_PATH = '/llama/local/status';
/**
 * Local capacity reservation endpoint path (parent WL-0MVIKRFP0005JDL8):
 * `POST {proxyUrl}/llama/local/reserve`. ABSENT on older proxies — the
 * caller fails open to today's polling behaviour (AC2).
 */
export const LOCAL_RESERVE_PATH = '/llama/local/reserve';
/**
 * Request/response header carrying the granted reservation ticket id
 * (`X-Local-Reservation: <ticketId>`), sent on the pane's FIRST request
 * (parent AC1).
 */
export const LOCAL_RESERVATION_HEADER = 'X-Local-Reservation';
/** Per-turn locality preference header (parent AC4, implemented in C4). */
export const LOCAL_PREFERENCE_HEADER = 'X-Local-Preference';
/**
 * Response header reporting the route the proxy actually took (parent AC4).
 * The per-turn preference itself travels on `X-Local-Preference`; the
 * pane-launch env var is `LOCAL_PREFERENCE_ENV_VAR` (re-exported above from
 * `./local-preference.ts`). Absent headers = no route-log entry and no
 * behaviour change (C4 fail-open contract).
 */
export const LOCAL_ROUTE_HEADER = 'X-Local-Route';
/** Response header reporting why a request fell back off the local route (parent AC4). */
export const LOCAL_FALLBACK_REASON_HEADER = 'X-Local-Fallback-Reason';
/**
 * Pane-launch environment variable carrying a granted reservation ticket id
 * from the dispatcher to the spawned pi session (`send-to-pi.sh` /
 * `run-pi-agent.sh`). The Worklog pi extension (parent slice C4) turns it
 * into `X-Local-Reservation` on the pane's FIRST provider request.
 */
export const LOCAL_RESERVATION_TICKET_ENV = 'PI_LOCAL_RESERVATION_TICKET';
/** Hard floor for the poll interval (must not hammer the proxy). */
export const DOWNTIME_POLL_INTERVAL_FLOOR_MS = 10_000;
/** Defensive floor for the idle threshold (prevents immediate dispatch). */
export const DOWNTIME_IDLE_THRESHOLD_FLOOR_MS = 1_000;
export const DEFAULT_DOWNTIME_POLL_INTERVAL_MS = 10_000;
/**
 * Default LLM idle threshold: 75 seconds. Chosen so that the slot-exhaustion
 * cooldown (1 min) has elapsed before the Dispatcher considers a slot fresh
 * enough for a new work item — this gives currently-active sessions the
 * opportunity to reclaim the slot first.
 */
export const DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS = 75_000;
/**
 * Default required-free-slots count: 2 of 3 slots (spare-capacity dispatch,
 * parent WL-0MT32F90V008UAD2). At least two slots must be free before
 * downtime work is dispatched, so one operator session slot is always
 * reserved for interactive work. A value of 0 means ALL slots must be free
 * (the pre-spare-capacity default); any positive integer N is accepted.
 */
export const DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS = 2;
/**
 * Minimum free slots required for an AUDIT dispatch (parent
 * WL-0MT32F90V008UAD2 AC3, machine-wide budget WL-0MTF0KLO10043YAN AC4 /
 * WL-0MTII48OV008P2QU F5): an audit pane needs a second slot for its
 * Phase 2 child deep-analysis (`AUDIT_PHASE2_PARALLELISM=1` — the child
 * runs strictly after the parent, so parent + one child = 2 local slots,
 * WL-0MSORQ1RG005DGUS). Applied as an ADDITIONAL selection-time check on
 * the latest polled status; the idle-duration gate (configured N) is
 * unchanged. Single machine-wide budget (one leader poll, one snapshot) -
 * see WL-0MT50LKAK001EF5Q bounded concurrent dispatches: the same cap
 * source, no per-worklog duplication. `AUDIT_PHASE2_PARALLELISM=1` → 2
 * slots minimum.
 */
export const DOWNTIME_AUDIT_MIN_FREE_SLOTS = 2;
/**
 * Minimum free slots required for a single-pane dispatch (implement /
 * plan / intake / scheduled tiers, parent WL-0MT32F90V008UAD2 AC3, F5
 * WL-0MTII48OV008P2QU single budget): each pane consumes exactly one local
 * slot, so ≥1 free slot suffices. Machine-wide, not per-worklog — shares
 * the single leader snapshot with WL-0MT50LKAK001EF5Q (one cap source).
 */
export const DOWNTIME_PANE_MIN_FREE_SLOTS = 1;
/**
 * Minimum interval between identical no-dispatch decision-log entries
 * (WL-0MU8808ZY0091JIA AC3): a healthy idle/gate-blocked loop must not flood
 * `.worklog/downtime-coordination.log`. A repeated refusal with the SAME
 * reason is suppressed until this window elapses; a reason CHANGE is always
 * logged immediately. 10 minutes → at most 6 identical lines per hour.
 */
export const DOWNTIME_DECISION_LOG_MIN_INTERVAL_MS = 10 * 60_000;
/**
 * Short, stable header token for a no-dispatch reason (WL-0MU8808ZY0091JIA
 * AC4). Distinct from the plain idle/busy labels so "idle slots but no
 * dispatches" is visible in the herdr header. The RAW reason is what gets
 * logged; only the header label is abbreviated.
 */
export function decisionHeaderToken(reason: string): string {
  switch (reason) {
    case 'slot-owned':
      return 'slot-owner';
    case 'proxy-contention':
      return 'contention';
    case 'review-queue-hold':
      return 'review-queue';
    case 'slots-unavailable':
      return 'no-slots';
    case 'capacity-saturated':
      return 'saturated';
    case 'prefill-gate':
    case 'prefill-cap':
    case 'prefill-eta':
      // Prefill pacing refusals (WL-0MVHSZRZQ00482QX): each keeps its own
      // distinct header token so a paced stop is distinguishable from
      // `contention`, `slot-owner` and `no-slots` in the herdr header.
      return reason;
    case 'reserved-fallback':
    case 'queue-full':
      // Reserve-handshake refusals (parent WL-0MVIKRFP0005JDL8, slice C2):
      // each reason keeps its own distinct token, so a reservation deferral
      // is never collapsed into `no-slots` / `contention` and the operator
      // can tell WHY no ticket was granted from the herdr header alone.
      return reason;
    case 'idle-window-spent':
      // Idle-window launch fence (parent AC3, slice C3): this instance
      // already launched from this idle window and the proxy has not yet
      // reported that launch, so its headroom cannot be trusted yet. Distinct
      // from every paced stop (`prefill-gate` / `prefill-cap` / `prefill-eta`)
      // and from `reservation-lost` below.
      return 'window-spent';
    case 'reservation-refused':
      // Reserve-handshake refusal observed on the DISPATCH path (slice C3):
      // the proxy declined the admission ticket. The proxy's own vocabulary
      // (`prefill-gate` / `queue-full` / …) is carried as `reservationReason`
      // evidence, but the header token must NOT collapse into the paced-stop
      // tokens — an operator has to be able to tell a lost reservation race
      // (`reservation-lost`) from herdr's own pacing (`prefill-gate` /
      // `prefill-cap`).
      return 'reservation-lost';
    default:
      return reason;
  }
}
/**
 * Schema-v2 capacity evidence attached to a no-dispatch decision entry
 * (LP-0MVGDUVGE0024YAI): the pool summary, payload version and the observed
 * per-slot lease/phase/ETA detail. Purely observability — no gate reads it.
 */
interface CapacityEvidence {
  capacityHint?: string;
  statusSchemaVersion?: number;
  idleLeasedSlots?: number;
  generatingSlots?: number;
  slotPhases?: Record<string, string>;
  slotPrefillEtaSeconds?: Record<string, number>;
  /**
   * Prefill serialisation-gate evidence (LP-0MVGDUUV3001XFRJ,
   * WL-0MVHSZRZQ00482QX): the in-flight/cap counters, the live gate waiters
   * and the prefill-ETA guard's queue ETA / admission budget. Attached to
   * every polled decision so a paced stop is diagnosable from the log alone.
   */
  prefillsInFlight?: number;
  maxConcurrentPrefills?: number;
  prefillGateWaiters?: number;
  prefillBudgetSeconds?: number;
  queueEtaSeconds?: number;
  /**
   * Occupancy/calibration evidence (parent WL-0MVPRZU0A000TSWD AC3): the
   * wait behind OTHER in-flight prefills, the busy-slot count that wait is
   * composed of, and whether the proxy's estimate is calibrated. Recorded
   * whenever served — on a legacy proxy (fields absent) they are simply
   * omitted — so a paced tick is diagnosable from the log alone.
   */
  queueEtaOccupancySeconds?: number;
  queueEtaBusySlots?: number;
  prefillEtaCalibrated?: boolean;
  /**
   * Authoritative local idle-age evidence (LP-0MVGD9Z8Z0055Y5J,
   * WL-0MVHSZR9C0012NQY): the proxy's reported idle age in seconds and the
   * source of the last local activity. Observability only — they let an
   * operator see WHY a tick was admitted or deferred without reading the
   * proxy. Absent on pre-feature proxies (and when malformed).
   */
  localIdleSeconds?: number;
  localLastActivitySource?: string;
}
/**
 * Evidence fields shared by EVERY polled no-dispatch decision entry
 * (WL-0MU8808ZY0091JIA). Extracted from `recordDecision` so the
 * capacity-starvation observation (WL-0MVKNC2N50025HXE AC3) carries exactly
 * the same evidence schema as the refusal it extends — one shape, no
 * duplication, and an unchanged on-disk format for existing readers.
 */
export interface DecisionEntryFields extends CapacityEvidence {
  freeSlots: number;
  totalSlots: number;
  ownerPresent: boolean;
  runningPanes: number | null;
  contentionDepth: number;
  /** Depth-aware audit-batch metadata (parent WL-0MVEDM8OT007WDRS AC5). */
  auditBatchDepth?: number;
  auditBatchCap?: number;
  auditBatchRemaining?: number;
  /** Why an armed batch ended (`cap` reached / `depth` dropped, AC5). */
  auditBatchEndReason?: string;
  /**
   * Local-capacity reservation evidence (parent WL-0MVIKRFP0005JDL8 AC4,
   * slice C2): recorded on every polled decision entry produced by a
   * dispatch attempt that asked the proxy for a ticket. `reservationTicket`
   * is the granted gate ticket (id + grant time), `admit` is the proxy's
   * verdict for this poll, `projectedWaitS` its projected wait before local
   * capacity and `retryAfterS` its `retry_after_s` deferral advice (refusals
   * only). `reservationReleased` marks a granted ticket that could not be
   * forwarded to a pane (spawn failure) and is therefore treated as
   * released/expired — a ticket is never leaked or reused. Observability
   * only: no gate reads these fields, and an older proxy (fail-open)
   * records none of them.
   */
  reservationTicket?: { id: string; grantedAt: string };
  admit?: boolean;
  projectedWaitS?: number;
  retryAfterS?: number;
  reservationReleased?: boolean;
  /**
   * The proxy's OWN refusal reason (`reservation-refused` entries only,
   * parent AC3 slice C3). The entry's `reason` is the grouped
   * `reservation-refused` token (so the header reads `reservation-lost`,
   * distinct from a paced `prefill-gate`/`prefill-cap` stop) and this field
   * preserves the proxy's open vocabulary for diagnosis.
   */
  reservationReason?: string;
  /**
   * Launches this instance made in the current idle window that the proxy's
   * `local_prefills_in_flight` has not yet accounted for (parent AC3 slice
   * C3; the entry's reason is `idle-window-spent`). Evidence only — the
   * guard itself refuses the tick before any dispatch attempt.
   */
  pendingLaunches?: number;
  /**
   * Host-CPU gate evidence (WL-0MVK0UO3Q002TXW6 AC4): the measured host CPU
   * utilisation (0–100 %), its source (`proc-stat` delta vs `loadavg`
   * fallback) and the configured threshold. Present on a `cpu-saturated`
   * refusal so the hold is diagnosable from the decision log alone; absent on
   * every non-CPU decision, which keeps the existing log shape.
   */
  hostCpuPercent?: number;
  hostCpuSource?: HostCpuSource;
  cpuGatePercent?: number;
  /**
   * Audit-tier budget-skip evidence (WL-0MVR8FI4Q0007CGR AC5). On the
   * `audit-tier-budget-skipped` observation token: the prefill-capacity
   * headroom (`cap - inFlight`; absent when the cap is disabled/unserved),
   * the prefill-paced `effectiveFreeSlots` and the tier whose minimum the
   * raw `freeSlots` budget did not meet (`skippedTier: 'audit'`). Together
   * with the mandatory `freeSlots` field this makes the prefill-concurrency
   * vs slot-count distinction fully diagnosable from the log alone.
   */
  capacityBudget?: number;
  effectiveFreeSlots?: number;
  skippedTier?: string;
}
export function capacityEvidence(
  status: LlamaStatus,
  slots: LlamaSlot[] | null,
): CapacityEvidence {
  const evidence: CapacityEvidence = {};
  if (status.capacity_hint !== undefined) evidence.capacityHint = status.capacity_hint;
  if (status.status_schema_version !== undefined) {
    evidence.statusSchemaVersion = status.status_schema_version;
  }
  // Prefill serialisation-gate evidence (WL-0MVHSZRZQ00482QX): recorded on
  // every polled decision (even when the per-slot detail is unusable) so a
  // paced tick always shows the proxy's own gate state.
  if (typeof status.local_prefills_in_flight === 'number') {
    evidence.prefillsInFlight = status.local_prefills_in_flight;
  }
  if (typeof status.local_max_concurrent_prefills === 'number') {
    evidence.maxConcurrentPrefills = status.local_max_concurrent_prefills;
  }
  if (typeof status.prefill_gate_waiters === 'number') {
    evidence.prefillGateWaiters = status.prefill_gate_waiters;
  }
  if (typeof status.prefill_budget_seconds === 'number') {
    evidence.prefillBudgetSeconds = status.prefill_budget_seconds;
  }
  if (typeof status.queue_eta_seconds === 'number') {
    evidence.queueEtaSeconds = status.queue_eta_seconds;
  }
  // Occupancy/calibration terms (parent WL-0MVPRZU0A000TSWD AC3): extracted
  // whenever served so a paced stop shows "waiting behind other prefills"
  // apart from "waiting on my own cold prefill"; absent on a legacy proxy.
  if (typeof status.queue_eta_occupancy_seconds === 'number') {
    evidence.queueEtaOccupancySeconds = status.queue_eta_occupancy_seconds;
  }
  if (typeof status.queue_eta_busy_slots === 'number') {
    evidence.queueEtaBusySlots = status.queue_eta_busy_slots;
  }
  if (typeof status.prefill_eta_calibrated === 'boolean') {
    evidence.prefillEtaCalibrated = status.prefill_eta_calibrated;
  }
  // Idle-age evidence is attached on EVERY polled decision (even when the
  // per-slot detail is unusable) so a refused/deferred tick always shows the
  // proxy's own idle-age answer (WL-0MVHSZR9C0012NQY AC7).
  const idleSeconds = reportedIdleSeconds(status);
  if (idleSeconds !== null) evidence.localIdleSeconds = idleSeconds;
  if (status.local_last_activity_source !== undefined) {
    evidence.localLastActivitySource = status.local_last_activity_source;
  }
  if (slots === null) return evidence;
  if (slots.some((slot) => slot.lease_state !== undefined)) {
    evidence.idleLeasedSlots = slots.filter(
      (slot) => slot.lease_state === 'idle_leased',
    ).length;
    evidence.generatingSlots = slots.filter(
      (slot) => slot.lease_state === 'generating',
    ).length;
  }
  const phases: Record<string, string> = {};
  const etas: Record<string, number> = {};
  for (const slot of slots) {
    if (slot.phase !== undefined && slot.phase !== null) phases[slot.slot_id] = slot.phase;
    if (typeof slot.prefill_eta_seconds === 'number') {
      etas[slot.slot_id] = slot.prefill_eta_seconds;
    }
  }
  if (Object.keys(phases).length > 0) evidence.slotPhases = phases;
  if (Object.keys(etas).length > 0) evidence.slotPrefillEtaSeconds = etas;
  return evidence;
}
/** Sane floor for the no-candidate cooldown (the pause cannot be disabled or set trivially small). */
export const DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS = 60_000;
/** Default pause after a genuine empty backlog: 60 minutes. */
export const DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS = 3_600_000;
/**
 * Default minimum cooldown (WL-0MUKYERLZ006ELL5) between successive downtime
 * dispatches of the same `(item, kind)` after a pane closed WITHOUT reaching a
 * terminal stage (`agent-ended-no-terminal`, `audit-ended-no-result`, or any
 * future non-terminal code). Prevents a repeatedly failing session from being
 * re-selected immediately and wasting local-LLM slots. Default 30 minutes.
 */
export const DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS = 30 * 60 * 1000;
/**
 * Hard floor for the non-terminal cooldown (1 minute): a defensive minimum so
 * the control cannot be disabled or set trivially small (no immediate retry).
 */
export const DOWNTIME_NON_TERMINAL_COOLDOWN_FLOOR_MS = 60 * 1000;
/**
 * Hard ceiling for the non-terminal cooldown (24 hours): above this a
 * repeatedly-failing item could be stranded indefinitely.
 */
export const DOWNTIME_NON_TERMINAL_COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;
/**
 * Default per-item, per-kind dispatch-ATTEMPT cap (WL-0MUKYEXMK0033MFK).
 *
 * After this many dispatch attempts (panes opened) for the same `(item,
 * kind)` at the SAME worklog stage, the item is excluded from further
 * automatic dispatch of that kind and flagged for producer review. Chosen
 * from the observed pattern (2–4 non-terminal retries before human
 * intervention is warranted).
 */
export const DEFAULT_DOWNTIME_MAX_ATTEMPTS = 3;
/** Hard floor for `maxAttempts` (1): at least one automatic attempt is always allowed. */
export const DOWNTIME_MAX_ATTEMPTS_MIN = 1;
/** Hard ceiling for `maxAttempts` (10): above this the cap is effectively disabled. */
export const DOWNTIME_MAX_ATTEMPTS_MAX = 10;
/**
 * Default depth-aware audit-batch cap (`downtimeAuditBatchMax`, parent
 * WL-0MVEDM8OT007WDRS AC1).
 *
 * Bounds how many SEQUENTIAL audit dispatches one continuous idle window
 * may issue when the audit-eligible depth reaches `browseItemCount`. The
 * default `2` is conservative: batching is on (the queue drains without a
 * fresh full idle period between audits) but the per-window LLM load stays
 * small.
 */
export const DEFAULT_DOWNTIME_AUDIT_BATCH_MAX = 2;
/**
 * Hard floor for `downtimeAuditBatchMax` (1): `1` means batching OFF and
 * restores the legacy single-dispatch-per-idle-window behaviour.
 */
export const DOWNTIME_AUDIT_BATCH_MAX_MIN = 1;
/**
 * Hard ceiling for `downtimeAuditBatchMax` (5): mirrors the audit skill's
 * `AUDIT_BATCH_MAX_ITEMS` — above this the per-window LLM load is unbounded.
 */
export const DOWNTIME_AUDIT_BATCH_MAX_MAX = 5;
/**
 * Per-process dispatch-PIPELINE single-flight bound (WL-0MT50LKAK001EF5Q).
 *
 * This bounds PIPELINES (claim → marker → spawn), NOT live panes. There is
 * deliberately NO client-side limit on the number of dispatched panes
 * (WL-0MU2EP6JL006A1U3): panes stay open until an operator closes them, so a
 * pane count can never be the concurrency limiter — the local LLM idle /
 * free-slot check is (each running agent holds a proxy slot/lease).
 */
export const DISPATCH_PIPELINE_SINGLE_FLIGHT = 1;
/**
 * Default review-queue depth threshold (`browseItemCount`, parent
 * WL-0MT2UQWOR007CYY9): when the ROOT-ONLY `completed`/`in_review` count
 * reaches this, the review queue is "deep" and NON-CRITICAL implement
 * dispatch is held until audits / producer review drain it back below.
 * Re-read live from settings each tick (no restart); root-only counting
 * via `wl list --status completed --stage in_review --root-only --json`.
 *
 * The canonical definition lives in the leaf `browse-window.ts` module
 * (shared with the TUI sprint view without an import cycle,
 * WL-0MUNS8X97007C9H9 AC1); re-exported here for backward compatibility.
 */
export { DEFAULT_BROWSE_ITEM_COUNT } from './browse-window.js';
/**
 * Maximum number of additional items to fetch when extending the dispatch
 * window (WL-0MU6UL3GQ0015AA5; restricted to critical-only by
 * WL-0MUNS8X97007C9H9 AC2/AC4).
 *
 * The dispatcher head is the sprint view, so a defensive out-of-window read
 * re-checks the SAME ranking path with a window of
 * `head length + DOWNTIME_DISPATCH_EXTEND_MAX` items. The extension returns
 * ONLY `critical` items: every non-critical candidate must be visible in the
 * sprint view, so a non-critical item beyond `browseItemCount` is never
 * dispatched. Because all `critical` items are mandatory in the view, this
 * escape hatch is normally a no-op.
 *
 * The extension is bounded: at most `head length + 30` items are ever scanned
 * per dispatch cycle. The TUI worklist continues to show exactly
 * `browseItemCount` items (clamped 1–50).
 */
export const DOWNTIME_DISPATCH_EXTEND_MAX = 30;
/**
 * Audit-tier recency window: a completed/in_review candidate is only
 * dispatched for audit when it was modified within the last 7 days.
 */
export const DOWNTIME_AUDIT_RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Stale-audit window (WL-0MT3PHW4I002SNOV): an audit dispatch marker older
 * than this is treated as stale — the audit pane may have crashed without
 * updating the work item — and is ignored by the active-audit single-flight
 * check, so a NEW audit dispatch can proceed. Only one audit is active at a
 * time during downtime dispatch.
 */
export const DOWNTIME_AUDIT_STALE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
/**
 * Default dispatched success-marker staleness window (WL-0MU6UL0RJ008IHGT):
 * a SUCCESS dispatch marker whose item is STILL at the marker's dispatched-at
 * stage is released once its age exceeds this window — a pane that spawned
 * but whose agent never advanced the item (crash, manual close, silent
 * failure) must not strand the item permanently. Default 24 hours.
 */
export const DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Pane-lifecycle monitor cadence (WL-0MU308WSF0002JWN): the worker re-checks
 * dispatched panes for terminal states at most once per this interval,
 * bounding the per-tick worklog queries ("reasonable polling cadence" —
 * parent Constraint) while still closing completed panes promptly. Overridable
 * per tick via the optional `paneLifecycleIntervalMs` config field.
 *
 * NOTE: the monitor itself is currently DISABLED — see
 * `PANE_LIFECYCLE_MONITOR_ENABLED` below.
 */
export const DOWNTIME_PANE_LIFECYCLE_INTERVAL_MS = 30_000;
/**
 * Mechanism B (dispatch-monitor pane auto-close, `pane-lifecycle.ts`) is
 * DISABLED (WL-0MUMEKDK0008LKH8).
 *
 * The classifier was observed to close panes prematurely (stage-propagation
 * lag; `requires-attention` outcomes still closing) and to race with the
 * scheduled reaper (Mechanism A) — the two mechanisms share only a
 * non-atomic idempotency key, so a pane could be closed twice. It is switched
 * off here until its design is revisited; the scheduled reaper
 * (`pane-close-scheduler.ts`) is the only active auto-close path. The
 * classifier and its unit tests are retained for that future redesign — do
 * not re-enable without reworking the double-close race. See
 * `docs/dev/downtime-dispatcher.md` and `packages/herdr/README.md`.
 */
export const PANE_LIFECYCLE_MONITOR_ENABLED: boolean = false;
/**
 * Hard floor for the success-marker staleness window (1 h): below this the
 * age release would fire while a dispatched pane is plausibly still running,
 * weakening duplicate-dispatch protection for genuinely in-flight work.
 */
export const DOWNTIME_MARKER_STALE_WINDOW_FLOOR_MS = 60 * 60 * 1000;
/**
 * Hard ceiling for the success-marker staleness window (7 days): above this
 * a stranded item could be excluded for a week, reintroducing the original
 * permanent-stranding failure mode at a large but bounded scale.
 */
export const DOWNTIME_MARKER_STALE_WINDOW_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Default for the pre-dispatch stalled-work scan (WL-0MUYMBK6H005PY16):
 * enabled. The scan prefers resuming an existing stalled pane over opening a
 * new one; it can be turned off without a code change.
 */
export const DEFAULT_DOWNTIME_STALL_SCAN_ENABLED = true;
/**
 * Default stall threshold (WL-0MUYMBK6H005PY16): 5 minutes, aligned with the
 * pane-closure reaper's grace period. A pane is a stall candidate only once
 * its not-`working` state has persisted at least this long.
 */
export const DEFAULT_DOWNTIME_STALL_THRESHOLD_MS = 5 * 60 * 1000;
/**
 * Hard floor for the stall threshold (60 s): below this the scan would resume
 * panes that are merely between tool calls, hijacking active sessions.
 */
export const MIN_DOWNTIME_STALL_THRESHOLD_MS = 60 * 1000;
/**
 * Hard ceiling for the stall threshold (60 min): above this a genuinely
 * stalled pane could sit unattended for over an hour, defeating the feature.
 */
export const MAX_DOWNTIME_STALL_THRESHOLD_MS = 60 * 60 * 1000;
/**
 * Default progress window before a live-agent pane is reported as
 * long-running (WL-0MVKNC2N50025HXE AC2): 3 hours. Comfortably longer than a
 * legitimate implement/audit session's normal stage transition, while short
 * enough that an overnight session making no progress surfaces the same night.
 *
 * Defined here (the dispatcher's settings owner) so `long-running-panes.ts`
 * imports it and the worker needs only a TYPE import of that module — no
 * runtime import cycle (the same layering as the stall threshold).
 */
export const DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS = 3 * 60 * 60 * 1000;
/** Hard floor for the long-running window (1 h) — below this, normal sessions alert. */
export const DOWNTIME_LONG_RUNNING_THRESHOLD_FLOOR_MS = 60 * 60 * 1000;
/** Hard ceiling for the long-running window (48 h). */
export const DOWNTIME_LONG_RUNNING_THRESHOLD_MAX_MS = 48 * 60 * 60 * 1000;
/**
 * Three-strike rule: this many consecutive CLI-error dispatch outcomes
 * pause the worker entirely (after logging the persistent error).
 */
export const DOWNTIME_ERROR_STRIKE_LIMIT = 3;
/**
 * Timeout for the downtime worker's `wl` CLI invocations (`getNextItem` /
 * `getNextAuditCandidate` in index.ts): a hung `wl` child must be killed
 * and the lookup fail closed (a CLI-error strike) within a bounded time
 * instead of wedging the dispatch task until the pane restarts
 * (WL-0MSJIPHD0001L1J9). 10s is comfortably above the healthy ~0.15s wl
 * latency and below the CLI's own 60s safety timeout (used as the upper
 * bound for this value).
 */
export const DOWNTIME_WL_TIMEOUT_MS = 10_000;
/**
 * Bounded transient-retry for `wl` CLI invocations (WL-0MTOTCETU004YYIU
 * AC3): a single `SQLITE_BUSY` / `database is locked` / timeout is a
 * transient contention that must not burn a strike. The caller retries
 * with exponential backoff within the same dispatch tick so one transient
 * does not cascade into the three-strike 60-min cooldown. Only the
 * patterns below are retried — parse/author-gate errors fail fast.
 */
export function isTransientDowntimeError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes('sqlite_busy') || m.includes('sqlite busy')) return true;
  if (m.includes('database is locked') || m.includes('database table is locked')) return true;
  // "database busy" variants — better-sqlite3 busy_timeout contention
  if (m.includes('database') && m.includes('busy')) return true;
  return false;
}
/**
 * Execute `fn` with bounded retry on transient `wl` errors only.
 * Retries `retries` times (default 2 → up to 3 total attempts) with
 * exponential backoff `baseDelayMs * 2^attempt` (default 50ms → 50,100ms).
 * Non-transient errors throw immediately. The total extra wall-clock
 * added is < 200ms so the tick stays well inside DOWNTIME_RUN_TIMEOUT_MS.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  baseDelayMs = 50,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = isTransientDowntimeError(msg);
      if (!transient || attempt === retries) throw err;
      const delay = baseDelayMs * (1 << attempt);
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastErr as Error;
}
/**
 * Scheduler-level watchdog bound for ONE downtime-worker tick run
 * (WL-0MSJIPHD0001L1J9): the maximum wall-clock time a scheduler run may
 * take before it is abandoned and the task's single-flight flag is reset so
 * the next tick retries — a hung run can never permanently wedge the
 * downtime task. Chosen comfortably above the worst-case bounded dispatch
 * path (5s proxy poll + up to three 10s wl lookups + 3s claim + 5s dispatch
 * comment ≈ 45s) so healthy runs never trip it, while a hung run still
 * recovers within a minute instead of wedging until a pane restart.
 */
export const DOWNTIME_RUN_TIMEOUT_MS = 60_000;
export const DEFAULT_DOWNTIME_PROXY_URL = 'http://192.168.0.199:8000';
export const DEFAULT_DOWNTIME_MODEL = 'plan';
/**
 * Default coordination check-in interval: 5 minutes (WL-0MTMPSCL8000O45H,
 * parent AC3 — was 30 min). Every instance re-verifies/updates its entry
 * in the shared coordination file at this cadence. The leader checks in
 * more often (WL-0MTOCBP1D009P4U3) — see DEFAULT_LEADER_CHECK_IN_MS.
 */
export const DEFAULT_COORDINATION_CHECK_IN_MS = 5 * 60 * 1000;
/**
 * Leader coordination check-in interval (WL-0MTOCBP1D009P4U3): the leader
 * re-offers every 4 minutes so offers stay fresh and the lease is renewed
 * inside the 5-minute TTL with ~1 min grace. Non-leaders use
 * DEFAULT_COORDINATION_CHECK_IN_MS (5 min, WL-0MTMPSCL8000O45H).
 */
export const DEFAULT_LEADER_CHECK_IN_MS = 4 * 60 * 1000;
/**
 * Maximum local DISPATCH-lease TTL (seconds) the llama-proxy can hold a
 * local slot — the cross-repo contract from `llm-manager`
 * (`proxy/proxy/router_helpers.py`, WL-0MU8809SZ0022VZG).
 *
 * The lease is ADAPTIVE, not a fixed ~180 s: a static base plus
 * generation-proportional extension, capped at
 * `local_dispatch_lease_max_seconds` (default 1500 s), with chunk/prefill
 * refresh buffers that keep it alive while a stream is active. A long agent
 * generation therefore holds the lease for its WHOLE run — the RCA observed a
 * dispatched-pane lease run 836 s → 0 (WL-0MU87ZGPP0029V28).
 *
 * The dispatcher MUST NOT assume leases expire after ~180 s. It does not WAIT
 * OUT a lease: it dispatches into genuinely free UNOWNED slots (the per-slot
 * gate, WL-0MU8807BI008C9ME) and only the count-based single-slot path treats
 * a held lease as blocking. If `llm-manager` changes the default, revisit
 * this constant and `docs/dev/downtime-dispatcher.md`.
 */
export const LOCAL_DISPATCH_LEASE_MAX_SECONDS = 1500;
/**
 * Retired coordination tier ordering (parent AC4 → WL-0MTK1ILM2009QYB2).
 * The coordination leader no longer re-ranks offers by tier: it dispatches
 * the OFFER list in file order (each offer is its root's Herdr list head,
 * WL-0MTK1ILM2009QYB2 "dispatcher == Herdr list head"; see
 * `dispatchFromCoordination`). This constant and `coordinationTierRank`
 * are kept exported only for the module's tier-rank unit tests — nothing
 * on the dispatch path calls them.
 */
export const COORDINATION_TIER_ORDER = ['audit', 'critical', 'implement', 'plan', 'risk-effort', 'intake'] as const;
export type CoordinationTierKind = (typeof COORDINATION_TIER_ORDER)[number];
/**
 * The proxy-reported local idle age in SECONDS when it is usable, else
 * `null` (WL-0MVHSZR9C0012NQY). Fail-closed/backward compatible: an absent,
 * non-finite or negative value is never treated as "idle forever" — it
 * returns `null` so the caller falls back to the local idle tracker exactly
 * as a pre-feature proxy would.
 */
export function reportedIdleSeconds(status: LlamaStatus): number | null {
  const seconds = status.local_idle_seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  return seconds;
}
