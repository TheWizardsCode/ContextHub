/**
 * packages/herdr/src/downtime-worker.types.ts — downtime-worker core data
 * types.
 *
 * Single responsibility: the pure-data type surface (status/slot/poller,
 * candidates, results, panes) shared by the idle, poller and selection
 * modules. Dispatch-event/spawn/worker types stay in the monolith until
 * their owning children land.
 * Moved verbatim out of `downtime-worker.ts` (parent WL-0MVF3F9A7000HKP7;
 * promised deliverable of WL-0MVLIHXD1004L0UO, falsely marked complete —
 * landed via WL-0MVN6UUEH009GID8). No behaviour change.
 */

import type { HerdrAgentSession } from './pane-close-herdr.js';

// ── Types ─────────────────────────────────────────────────────────────

/** Shape of `GET /llama/local/status` as served by the llama-proxy. */
export interface LlamaStatus {
  llama_server_running: boolean;
  /**
   * LOCAL-only query activity (served by proxies exposing the
   * `local_active_queries` counter, LP-0MSL2ZLLS009RVKR). This is the
   * SOLE busy signal for idle detection: `local_active_query=true` means
   * busy (dispatch inhibited), `local_active_query=false` means idle.
   * ABSENT on pre-fix proxies — absence is treated as busy (fail-closed)
   * to prevent silent degraded dispatch on unverifiable signals.
   */
  local_active_query?: boolean;
  model_switch_in_progress: boolean;
  local_lease_active: boolean;
  available_slots: number;
  total_slots: number;
  current_model?: string;
  local_owner_session_id?: string | null;
  /**
   * Every owner session id reported by the proxy, normalised across the
   * legacy string form and the current array form (WL-0MU88086A0089US4):
   * array elements that are HTTP(S) URLs (the proxy's own base URL, e.g.
   * `"http://localhost:8080"`) are excluded, and a legacy string yields a
   * single-element array. Empty when no owner is reported. Kept alongside
   * `local_owner_session_id` (the first id) for backward compatibility.
   */
  local_owner_session_ids?: string[];
  local_owner_lease_remaining_seconds?: number | null;
  /**
   * Proxy-reported LIVE contention queue depth (AC6, parent
   * WL-0MTYZXSLN008HZOW): the number of requests CURRENTLY queued behind a
   * busy local slot. A positive value means dispatched panes are already
   * contending for the slot — the dispatcher backs off until the queue
   * drains. ABSENT on pre-feature proxies (treated as 0 — no contention
   * evidence). This is the SOLE contention gate signal
   * (WL-0MU1DWXO600153OI).
   */
  contention_queue_depth?: number;
  /**
   * Proxy-reported CUMULATIVE queue metric: the number of requests that have
   * EVER queued on this proxy process (never decremented; resets only on a
   * proxy restart). Telemetry only — it MUST NOT gate dispatch
   * (WL-0MU1DWXO600153OI): a past queue event leaves this > 0 forever, which
   * would keep the dispatcher backed off even with an empty queue. ABSENT on
   * pre-feature proxies.
   */
  contention_queued_count?: number;
  /**
   * Proxy degradation flag (LP-0MSVP7XJ6008QPKX; fail-closed contract
   * WL-0MUXVPXAZ005RESW): `true` when the served slot COUNTS came from the
   * proxy's last-known cache because the fresh `/slots` query failed. The
   * per-slot `slots` detail then cannot be trusted/paired with the counts,
   * so per-slot detail is UNUSABLE and the worker fails closed (no
   * dispatch) rather than falling back to the untrusted count. ABSENT on
   * pre-feature proxies (treated as not stale).
   */
  slots_stale?: boolean;
  /**
   * Per-slot identity (LP-0MSG5TA7Y002GN39): served by proxies that expose
   * slot-level detail, and the ONLY trusted availability source
   * (WL-0MUXVPXAZ005RESW). When present and non-stale, the downtime worker
   * tracks idle duration PER SLOT ID so a configured N requires the SAME N
   * slots continuously free. ABSENT on pre-feature proxies, and an EMPTY
   * array means "no per-slot detail available" (WL-0MUFP30T2003OX1F) —
   * never "zero free slots"; in both cases the worker fails closed (no
   * dispatch) rather than falling back to the count.
   */
  slots?: LlamaSlot[];
  /**
   * Schema-v2 payload version (LP-0MVGDUVGE0024YAI). ABSENT on pre-v2
   * proxies. Consumers must gate new behaviour on a value >= 2.
   */
  status_schema_version?: number;
  /**
   * Schema-v2 pool summary (LP-0MVGDUVGE0024YAI). Defensive: `saturated`
   * never admits a dispatch, even when the per-slot detail looks free
   * (inconsistent payloads fail closed). ABSENT on pre-v2 proxies.
   */
  capacity_hint?: LlamaCapacityHint;
  /**
   * Schema-v2 admission-guard wait budget in seconds; advisory/observability
   * only in this consumer. ABSENT on pre-v2 proxies.
   */
  prefill_budget_seconds?: number | null;
  /**
   * Prefill serialisation gate (LP-0MVGDUUV3001XFRJ, WL-0MVHSZRZQ00482QX):
   * the number of local prefills CURRENTLY in flight. Availability-affecting:
   * a malformed (non-finite / negative) value rejects the poll (fail-closed),
   * mirroring `contention_queue_depth`. ABSENT on pre-feature proxies (no
   * prefill pacing — today's behaviour exactly).
   */
  local_prefills_in_flight?: number;
  /**
   * The proxy's effective prefill concurrency cap: `1` = serialised (the
   * default), `0` = gate disabled (the cap becomes the slot pool). When
   * `> 0` and `local_prefills_in_flight >= local_max_concurrent_prefills`
   * the prefill capacity budget is 0 for that tick. Availability-affecting
   * (malformed → poll rejected). ABSENT on pre-feature proxies.
   */
  local_max_concurrent_prefills?: number;
  /**
   * Requests waiting on the proxy's prefill gate — the live
   * contention-queue depth for the gate. `> 0` is contention evidence,
   * equivalent to a non-empty `contention_queue_depth`
   * (WL-0MVHSZRZQ00482QX AC3). Availability-affecting (malformed → poll
   * rejected). ABSENT on pre-feature proxies.
   */
  prefill_gate_waiters?: number;
  /**
   * Prefill-ETA guard's projected queue wait in seconds
   * (LP-0MVGDUV5E005UWBQ): when present and finite together with
   * `prefill_budget_seconds` and above it, the dispatcher defers rather than
   * parking a pane behind a doomed wait. Advisory (a malformed value
   * degrades to undefined and never blocks dispatch). ABSENT on pre-feature
   * proxies.
   */
  queue_eta_seconds?: number | null;
  /**
   * PROXY-AUTHORITATIVE local idle age in SECONDS (LP-0MVGD9Z8Z0055Y5J,
   * WL-0MVHSZR9C0012NQY): the monotonic idle age of the local backend,
   * updated by the proxy on dispatch start, on every forwarded SSE chunk and
   * on request finish. Its baseline is the PROXY PROCESS start, so a freshly
   * restarted proxy reports its true idle age rather than "unknown".
   *
   * When present and finite it is the AUTHORITATIVE idle-age signal for
   * threshold qualification: `>= thresholdSeconds` satisfies the duration
   * requirement on this poll (no local accumulation needed — the GPU may have
   * been idle for hours before this worker started polling), and
   * `< thresholdSeconds` refuses regardless of an older local tracker run.
   * ABSENT on pre-feature proxies (or malformed/non-finite) → the local
   * tracker decides exactly as before.
   */
  local_idle_seconds?: number;
  /**
   * Wall-clock timestamp (ISO string) of the last local activity
   * (LP-0MVGD9Z8Z0055Y5J): operator-facing evidence recorded in the decision
   * log. Never a gate. ABSENT on pre-feature proxies; malformed values
   * degrade to undefined (never reject the poll).
   */
  local_last_activity_at?: string;
  /**
   * What last touched the local backend (LP-0MVGD9Z8Z0055Y5J): `dispatch` /
   * `chunk` / `finish` / startup … Operator-facing evidence in the decision
   * log — it explains WHY the backend is busy/idle. Never a gate. ABSENT on
   * pre-feature proxies; malformed values degrade to undefined.
   */
  local_last_activity_source?: string;
}
/**
 * Per-slot detail served inside `LlamaStatus.slots` (NORMALIZED by
 * `parseLlamaStatus`). The proxy (observability.py) serves `slot_id` as an
 * INTEGER (`slot.get("id", i)`); the parser coerces numeric ids to strings
 * and clamps negatives to 0 (WL-0MSVRMAWM007QNR5), so the normalized
 * `slot_id` is always a non-empty string — the per-slot idle tracker keys
 * its timers by it.
 *
 * Schema v2 (LP-0MVGDUVGE0024YAI) adds `lease_state`, `phase`,
 * `context_tokens` and `prefill_eta_seconds`; all are additive, so a pre-v2
 * payload parses exactly as before.
 */
export interface LlamaSlot {
  slot_id: string;
  is_processing: boolean;
  /**
   * Per-slot Local Proxy owner session id (AC5, parent WL-0MTYZXSLN008HZOW):
   * the pi session currently holding this slot's lease, or undefined/null
   * when the slot is unowned. ABSENT on pre-feature proxies. On pre-v2
   * payloads (no `lease_state`) a non-null owner is NEVER considered free
   * for a new dispatch; with schema-v2 `lease_state` the lease state is
   * authoritative and `idle_leased` IS dispatchable capacity
   * (LP-0MVGDUVGE0024YAI).
   */
  owner_session_id?: string | null;
  /**
   * Schema-v2 lease state (LP-0MVGDUVGE0024YAI). ABSENT on pre-v2 proxies.
   * Availability uses this when present: only `generating` is busy.
   */
  lease_state?: LlamaSlotLeaseState;
  /** Schema-v2 phase inference; advisory only (never gates dispatch). */
  phase?: LlamaSlotPhase | null;
  /** Schema-v2 prompt progress; advisory only. */
  context_tokens?: number | null;
  /** Schema-v2 calibrated prefill cost; advisory only. */
  prefill_eta_seconds?: number | null;
}
/**
 * Per-slot lease state served by schema-v2 proxies (LP-0MVGDUVGE0024YAI):
 * `generating` while a prefill/decode is in flight, `idle_leased` when the
 * slot is not processing but a live lease still reserves it (including the
 * post-stream cooldown), and `free` otherwise. Only `generating` is
 * genuinely busy; `idle_leased` is the reserved-but-idle case the upstream
 * change removes from the false-busy set.
 */
export type LlamaSlotLeaseState = 'generating' | 'idle_leased' | 'free';
/** Proxy-side per-slot phase inference (schema v2; null when not processing). */
export type LlamaSlotPhase = 'prefill' | 'decode';
/**
 * One-field summary of whether the local pool is genuinely working
 * (schema v2): `idle` = at least one free slot or every occupied slot is
 * `idle_leased`; `prefill_bound` = no free slot and at least one prefill;
 * `saturated` = no free slot and every occupied slot is decoding.
 */
export type LlamaCapacityHint = 'idle' | 'prefill_bound' | 'saturated';
/**
 * Per-tick prefill pacing decision derived from the proxy's serialisation
 * gate (LP-0MVGDUUV3001XFRJ) and prefill-ETA guard (LP-0MVGDUV5E005UWBQ).
 *
 * Every field is optional and absent on a pre-feature proxy, so an absent
 * gate restores today's free-slot-only budget exactly (`capacityBudget`
 * `undefined`, `deferReason` `undefined`).
 */
export interface PrefillPacing {
  /** `local_prefills_in_flight` when served. */
  inFlight?: number;
  /** `local_max_concurrent_prefills` when served (`0` = gate disabled). */
  cap?: number;
  /** `prefill_gate_waiters` when served (live gate queue depth). */
  gateWaiters?: number;
  /** `prefill_budget_seconds` when served (the admission wait budget). */
  budgetSeconds?: number;
  /** `queue_eta_seconds` when served (projected queue wait). */
  queueEtaSeconds?: number;
  /** Highest per-slot `prefill_eta_seconds` observed in flight. */
  maxSlotPrefillEtaSeconds?: number;
  /**
   * Remaining prefill concurrency headroom: `0` while the cap is reached,
   * otherwise `cap - inFlight` (at least 1). `undefined` = unbounded — the
   * cap is absent or `0`, or the in-flight count is not served, so pacing
   * must not reduce today's free-slot budget.
   */
  capacityBudget?: number;
  /**
   * Distinct reason a dispatch is paced this tick, in precedence order:
   * gate waiters (contention evidence) → cap saturated → projected wait
   * above the admission budget. `undefined` = no prefill pacing.
   */
  deferReason?: 'prefill-gate' | 'prefill-cap' | 'prefill-eta';
}
export interface IdleTracker {
  /** Idle-since timestamp (ms), or null when not currently in an idle run. */
  readonly idleSince: number | null;
  /**
   * Record one poll result. `isIdle` true starts (or continues) the idle
   * run; false resets it (idleSince = null).
   */
  record(isIdle: boolean, now?: number): void;
  /**
   * True once the current idle run has lasted `thresholdMs` or longer
   * continuously.
   */
  isThresholdMet(thresholdMs: number, now?: number): boolean;
}
/**
 * Per-slot idle-duration tracker: one timer per `slot_id` so a configured
 * N < total requires the SAME N slots continuously free for the full
 * threshold (LP-0MSG5TA7Y002GN39) — never transient any-N availability.
 */
export interface PerSlotIdleTracker {
  /** idle-since timestamp per slot_id; null = slot busy / timer reset. */
  readonly idleSince: ReadonlyMap<string, number | null>;
  /**
   * Record one per-slot poll. A free slot starts (first free poll) or
   * continues (subsequent free polls) its OWN timer; a processing slot
   * resets ONLY its own timer; a slot absent from the payload is
   * fail-closed to busy (its timer resets). An empty payload resets every
   * known slot timer (the global-busy reset path).
   */
  record(slots: LlamaSlot[], now?: number): void;
  /**
   * Number of slots continuously free for `thresholdMs` or longer.
   */
  thresholdMetCount(thresholdMs: number, now?: number): number;
}
/**
 * Minimal structural fetch signature (the DOM `fetch` type is not part of
 * this project's tsconfig lib). Node's global `fetch` satisfies it at
 * runtime.
 */
export type LlamaStatusFetcher = (
  url: string,
  init?: { signal?: unknown },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
/**
 * Locality priority the dispatcher asks the proxy to schedule a turn with.
 * Advisory to the proxy; unknown values are the proxy's to reject.
 */
export type LocalReservationPriority = 'interactive' | 'background';
/**
 * Prefix-cache expectation for the turn: `warm` (the proxy's cache should
 * serve the prefill), `cold` (it should not) or `unknown` (the caller cannot
 * tell — the proxy decides).
 */
export type LocalReservationCacheState = 'warm' | 'cold' | 'unknown';
/**
 * Request body for `POST /llama/local/reserve`: the pane's expected token
 * size, its scheduling priority and its cache state. The proxy contract is
 * additive-only, so extra fields are permitted and ignored by this consumer.
 */
export interface LocalReservationRequest {
  /** Expected prompt + completion token size for the turn. */
  expected_tokens: number;
  /** Scheduling priority the proxy may use to admit or refuse. */
  priority: LocalReservationPriority;
  /** Whether the proxy's prefix cache is expected to serve this prefill. */
  cache_state: LocalReservationCacheState;
  /** Additive fields are allowed (additive-only proxy contract). */
  [extra: string]: unknown;
}
/**
 * Granted reserve response body (`2xx`). Field names are the documented
 * contract; {@link parseLocalReservationResponse} additionally accepts the
 * `ticket` / `ttl_seconds` aliases while the proxy contract settles.
 */
export interface LocalReservationGrantedBody {
  ticket_id: string;
  ttl_s: number;
  [extra: string]: unknown;
}
/**
 * Refused reserve response body (`429`): `reason` is an OPEN vocabulary
 * (`reserved-fallback`, `prefill-gate`, `queue-full`, …) — consumers accept
 * any non-empty string and never branch on an unknown one.
 */
export interface LocalReservationRefusedBody {
  reason: string;
  retry_after_s: number;
  [extra: string]: unknown;
}
/** A granted gate ticket: its id goes on the pane's first request. */
export interface LocalReservationTicket {
  /** Gate ticket id, surfaced as `X-Local-Reservation`. */
  ticketId: string;
  /** Seconds the ticket remains valid (always finite and > 0). */
  ttlSeconds: number;
}
/** A refusal: defer by `retryAfterSeconds`, record `reason` as evidence. */
export interface LocalReservationRefusal {
  /** Proxy-supplied refusal reason (open vocabulary). */
  reason: string;
  /** Seconds to wait before asking again (finite, >= 0). */
  retryAfterSeconds: number;
}
/** Parsed reservation outcome: a ticket to claim with, or a refusal to defer on. */
export type LocalReservationResult =
  | { status: 'granted'; ticket: LocalReservationTicket }
  | { status: 'refused'; refusal: LocalReservationRefusal };
/**
 * Injectable POST boundary for the reserve handshake (mirrors the existing
 * `LlamaStatusFetcher` injectable-seam pattern; narrow enough that tests can
 * stub it with a plain object).
 */
export type LocalReserveFetcher = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: unknown },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
/**
 * The reserve client: asks the proxy for an admission ticket. Resolves the
 * typed result, or `null` on ANY unusable outcome (endpoint absent, server
 * error, timeout, malformed body) — NEVER throws. A `null` means "this proxy
 * does not reserve": the caller fails open to today's polling behaviour
 * (parent AC2).
 */
export type LocalReserveClient = (
  request: LocalReservationRequest,
) => Promise<LocalReservationResult | null>;
/** Observation-fed state for the one-per-idle-window launch fence. */
export interface IdleWindowLaunchObservation {
  /** True when the poll reports a continuous idle window (started/ongoing). */
  idle: boolean;
  /** `local_prefills_in_flight` when served (undefined = pre-feature proxy). */
  inFlight?: number;
  /** `local_max_concurrent_prefills` when served (0 = gate disabled). */
  cap?: number;
}
/** Verdict of {@link IdleWindowLaunchFence.admit}. */
export interface IdleWindowLaunchVerdict {
  ok: boolean;
  /** Refusal reason when `ok` is false (never a paced-stop token). */
  reason?: 'idle-window-spent';
}
/**
 * Per-instance one-per-idle-window launch fence (parent AC3, slice C3).
 * Holds once a successful launch has been recorded and releases when a
 * later observation proves the launched prefill has REGISTERED in the
 * proxy's counter, or the window ended, or the bounded grace elapsed.
 */
export interface IdleWindowLaunchFence {
  /** Record a successful launch from the CURRENT observation (instance state). */
  recordLaunch(now: number): void;
  /**
   * Observe one status ticket. Releases the fence when the launched pane's
   * prefill has advanced past the admission count (fresh headroom is
   * trustworthy again), when the window ends, or after the grace window.
   */
  observePoll(observation: IdleWindowLaunchObservation): void;
  /**
   * May a new launch be attempted now? Holds while launches recorded in the
   * current window are still unobserved (the status is stale).
   */
  admit(now: number): IdleWindowLaunchVerdict;
  /** Number of recorded-but-unobserved launches (decision-log evidence). */
  readonly pendingLaunches: number;
}
export interface DowntimePoller {
  /**
   * Poll `GET {proxyUrl}/llama/local/status` once. Resolves to the parsed
   * status, or null when the endpoint failed/timed out or the payload was
   * ambiguous (both cases are treated as busy by the caller). Overlapping
   * calls coalesce onto the in-flight poll (single-flight).
   */
  poll(): Promise<LlamaStatus | null>;
  /** True while a poll is in flight (single-flight guard for the loop). */
  isPolling(): boolean;
}
export type DowntimeStage = 'intake_complete' | 'idea' | 'audit' | 'implement';
/** Ordered Herdr list head item (canonical ranking: fetcher → smart-selection → grouping). */
export interface DowntimeHerdrItem {
  id: string;
  title: string;
  stage?: string;
  status?: string;
  priority?: string;
  risk?: string;
  effort?: string;
  auditedAt?: string | null;
  updatedAt?: string;
  sortIndex?: number;
  parentId?: string | null;
  /**
   * Soft-delete attribution (`wl delete` sets it; SA-0MUJBLZC60085DI9): a
   * non-empty value excludes the item from every dispatch path. Carried by
   * the fetcher's `WorkItem`.
   */
  deletedBy?: string;
  /**
   * Needs-producer-review flag (WL-0MTIAL65N004T22F): carried by the
   * fetcher's `WorkItem`; when `true` the item is not dispatchable — the
   * producer-review gate is a sequential filter on the Herdr sequence
   * (via `classifyItemForDispatch`) for both the direct dispatcher and
   * the check-in offer computation.
   */
  needsProducerReview?: boolean;
  /**
   * Current assignee (empty/absent = unassigned). A non-empty assignee is a
   * scheduling hold: the item is held by a human/agent and must not be
   * dispatched at any tier (WL-0MV85WCJJ0087VMP).
   */
  assignee?: string;
}
export type DowntimeHerdrListResult =
  | { ok: true; items: DowntimeHerdrItem[] }
  | { ok: false; error?: string };
export type DowntimeSkillKind = 'plan' | 'intake' | 'audit' | 'implement' | 'risk-effort';
/**
 * Every dispatch kind recorded in the rolling audit log: the worklog tiers
 * plus the scheduled-prompts tier (WL-0MSS1Q5ER007QDKX), which has no work
 * item (kind `scheduled`, log-only markers), plus the risk-effort evaluation
 * tier (WL-0MTTSWCJR003OMN7) that populates missing risk/effort on plan_complete
 * items so they become implement-dispatchable.
 */
export type DowntimeDispatchKind = DowntimeSkillKind | 'scheduled';
export interface DowntimeCandidate {
  id: string;
  title: string;
  stage: DowntimeStage;
  /**
   * Worklog status of the candidate (`open` or `blocked` for selectable
   * plan/intake/implement items; `completed` for audit candidates). The
   * plan/intake/implement selection filters client-side to `status` being
   * `open` or `blocked` (RCA WL-0MSRBFFLN005W3VT amplifier fix): `wl next
   * --stage X` keeps completed items under a stage filter, so without this
   * guard a completed/in_review item whose stage matches could be dispatched
   * for /skill:plan or /skill:intake.
   */
  status?: string;
  /** wl next priority order preserved for deterministic selection. */
  sortIndex?: number;
  /** Worklog priority level (critical/high/medium/low) — round-robin grouping key. */
  priority?: string;
  /**
   * Soft-delete attribution (SA-0MUJBLZC60085DI9): a non-empty `deletedBy`
   * marks the item as deleted and excludes it from every `select*` filter.
   */
  deletedBy?: string;
  /**
   * Needs producer review flag (parent WL-0MTIAL65N004T22F): when `true`,
   * the item must NOT be auto-dispatched by the downtime worker — a human
   * producer must review it first. Absent/false/undefined → dispatchable.
   * Filtered in every `select*` function (AC1).
   */
  needsProducerReview?: boolean;
  /**
   * Current assignee (empty/absent = unassigned). A non-empty assignee is a
   * scheduling hold — the item is held by a human/agent and is excluded from
   * every `select*` filter (WL-0MV85WCJJ0087VMP).
   */
  assignee?: string;
}
/**
 * A candidate for the implement tier, parsed from
 * `wl next --stage plan_complete --risk low --effort small -n N --json`.
 * The `status` field distinguishes open items from completed epics that
 * `wl next` keeps under a stage filter (the implement tier must filter
 * client-side to `status === 'open'`, AC2). `sortIndex` preserves wl next's
 * priority order for deterministic selection.
 */
export interface ImplementCandidate {
  id: string;
  title: string;
  status: string;
  risk?: string;
  effort?: string;
  sortIndex?: number;
  /** Worklog priority level (critical/high/medium/low) — round-robin grouping key. */
  priority?: string;
  /** Soft-delete attribution (SA-0MUJBLZC60085DI9): non-empty ⇒ excluded from selection. */
  deletedBy?: string;
  /** Assignee hold (WL-0MV85WCJJ0087VMP): non-empty ⇒ excluded from selection. */
  assignee?: string;
  /**
   * Needs producer review flag (parent WL-0MTIAL65N004T22F): when `true`,
   * exclude from implement-tier selection (AC1).
   */
  needsProducerReview?: boolean;
}
/**
 * A completed/in_review item candidate for the downtime audit tier.
 * Parsed from `wl list --status completed --stage in_review --root-only
 * --json` — root-only (WL-0MSTLFW14000KPEC): only parent items (no
 * parentId) can be audit candidates; children are never dispatched
 * independently.
 */
export interface AuditCandidate {
  id: string;
  title: string;
  auditedAt?: string | null;
  updatedAt?: string;
  /** Stored content fingerprint from the audit result (optional). */
  fingerprint?: string | null;
  /** Current content fingerprint for the item, when the caller can compute it. */
  currentFingerprint?: string | null;
  sortIndex?: number;
  /** Worklog priority level (critical/high/medium/low) — round-robin grouping key. */
  priority?: string;
  /** Soft-delete attribution (SA-0MUJBLZC60085DI9): non-empty ⇒ excluded from selection. */
  deletedBy?: string;
  /**
   * Needs producer review flag (parent WL-0MTIAL65N004T22F): when `true`,
   * exclude from audit-tier selection (AC1).
   */
  needsProducerReview?: boolean;
  /**
   * Parent work item id when present. The audit-tier query is root-only
   * (`--root-only`, WL-0MSTLFW14000KPEC) so children never reach selection;
   * this field powers a belt-and-suspenders client-side guard that excludes
   * any child that would otherwise slip through (WL-0MUBVH8QG0020H9L AC2).
   */
  parentId?: string | null;
  /**
   * Current assignee (empty/absent = unassigned). A non-empty assignee is a
   * scheduling hold — the audit tier excludes it so a producer-held item is
   * never claimed (the claim's `--if-assignee ""` CAS would fail stale)
   * (WL-0MV85WCJJ0087VMP).
   */
  assignee?: string;
}
/**
 * Outcome of one `wl next --stage <stage> --json` lookup.
 *
 * `ok: true` means the CLI answered (candidate may still be null when the
 * stage is genuinely empty); `ok: false` means a transient wl/CLI failure
 * (fail-closed to busy — never a candidate). The distinction matters: an
 * empty backlog pauses the worker immediately, while a CLI failure counts
 * as one strike and only pauses after `DOWNTIME_ERROR_STRIKE_LIMIT`
 * consecutive failures (three-strike rule).
 */
export type DowntimeNextResult =
  | { ok: true; candidate: DowntimeCandidate | null }
  | { ok: false; error?: string };
/**
 * Enriched single-item view fetched by the leader for a coordination entry
 * (via `deps.fetchItem` — `wl show <id>` enriched with the audit timestamp
 * from the completed/in_review list query). Carries the fields the
 * coordinator needs to classify an item into its dispatch tier.
 */
export interface DowntimeItemInfo {
  id: string;
  title?: string;
  /** Worklog status (`open` | `completed` | `in_progress` | …). */
  status?: string;
  /** Worklog stage (idea | intake_complete | plan_complete | in_review | …). */
  stage?: string;
  /** Worklog priority level (critical/high/medium/low). */
  priority?: string;
  /** Risk level (Low/Medium/High/…). */
  risk?: string;
  /** Effort level (XS/S/M/L/XL). */
  effort?: string;
  /**
   * Current assignee (empty/absent = unassigned). A non-empty assignee is a
   * scheduling hold: the item is held by a human/agent and must not be
   * dispatched at any tier (WL-0MV85WCJJ0087VMP).
   */
  assignee?: string;
  /** Latest audit timestamp (enriched; absent on show-only items). */
  auditedAt?: string | null;
  /** Item update timestamp (audit-tier recency window). */
  updatedAt?: string;
  /** Stored content fingerprint from the audit result (optional). */
  fingerprint?: string | null;
  /** Current content fingerprint for the item, when the caller can compute it. */
  currentFingerprint?: string | null;
  /** wl priority order preserved for deterministic ordering. */
  sortIndex?: number;
  /**
   * Soft-delete attribution such as parsed from `wl show --json`
   * (SA-0MUJBLZC60085DI9): a non-empty `deletedBy` makes the item
   * non-dispatchable (`classifyItemForDispatch` returns null).
   */
  deletedBy?: string;
  /**
   * Needs producer review flag (parent WL-0MTIAL65N004T22F): when `true`,
   * exclude from classification (the item is not dispatchable) and the
   * coordination leader path skips it (AC3).
   */
  needsProducerReview?: boolean;
  /**
   * Recorded audit verdict (`auditResult.readyToClose` from `wl show
   * --json`, WL-0MU308WSF0002JWN): `false` means the audit FAILED; `true`
   * means it passed. Absent when the item has no recorded audit result.
   */
  auditResult?: boolean | null;
}
/**
 * Outcome of one `fetchItem` lookup: `{ok:true}` with the item info, or
 * `{ok:false}` on a wl/CLI failure or an unparseable item (fail-closed —
 * never a silent skip).
 */
export type DowntimeItemResult =
  | { ok: true; info: DowntimeItemInfo }
  | { ok: false; error?: string };
/**
 * Outcome of the check-in most-important-item computation. `{ok:true,
 * kind/candidate}` — a dispatchable item was found; `{ok:true,
 * noCandidate:true}` — the instance genuinely has nothing dispatchable
 * (its own entry may be removed); `{ok:false}` — wl/CLI errors occurred
 * during the computation (fail-open: keep the existing entry, retry at
 * the next check-in).
 */
export type MostImportantItemResult =
  | { ok: true; kind: DowntimeSkillKind; candidate: DowntimeCandidate }
  | { ok: true; noCandidate: true }
  /** Deep review queue + only held non-critical implements remain: nothing offerable NOW, but the backlog is NOT empty — the caller must not pause (WL-0MTTSWC1X005P4VD AC2). */
  | { ok: true; reviewQueueHold: true }
  /** Every remaining offerable candidate is a critical item already in flight (live working pane): nothing offerable NOW, but the backlog is NOT empty — the caller must not pause or drop the entry (WL-0MUBVKYH5009CGBI / F4). */
  | { ok: true; inFlightHold: true }
  /** The only remaining offerable candidates are held by the non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5): nothing offerable NOW, but the backlog is NOT empty — the caller must not pause or drop the entry. */
  | { ok: true; nonTerminalCooldownHold: true }
  /** The only remaining offerable candidates have exhausted their per-item/per-kind attempt budget (WL-0MUKYEXMK0033MFK): nothing offerable NOW, but the backlog is NOT empty — the caller must not pause or drop the entry. */
  | { ok: true; attemptBudgetHold: true }
  /** A stalled pane was resumed in place this cycle (WL-0MUYMBSA90092QV2): the instance must NOT offer new work — the resumed pane is the preferred work. Neutral: not an error, not a CLI strike, not a no-candidate cooldown. */
  | { ok: true; stalledResume: true }
  | { ok: false; error?: string };
/**
 * Expected state for the pre-dispatch claim (compare-and-swap, RCA
 * WL-0MSRBFFLN005W3VT design point 1): the claim transition to
 * `in_progress` only applies while the item is still in the state the tier
 * selected it in. `status` matches the stored hyphenated status
 * (`open`/`completed`/...); `stage` matches the worklog stage.
 */
export interface DowntimeClaimExpected {
  status?: string;
  stage?: string;
  /**
   * The claiming agent's assignee (WL-0MV85WD400091OZ6). Carried from the
   * claim to the failure rollback so the recovery can clear ONLY this claim's
   * assignee (guarded by `--if-assignee <agent>`) — a failed dispatch must
   * never leave a non-empty assignee (a non-empty assignee acts as a
   * scheduling hold and would make the item permanently undispatchable).
   */
  assignee?: string;
}
/**
 * Outcome of a pre-dispatch claim. `ok:true` means THIS pane won the
 * claim; `ok:false` with reason `stale` means another pane claimed the item
 * first (or its state changed since selection) — the dispatch MUST abort;
 * `ok:false` with reason `error` is a wl CLI failure (counted as a
 * wl-error strike).
 */
export type DowntimeClaimResult =
  | { ok: true }
  | { ok: false; reason: 'stale' | 'error'; error?: string };
/**
 * Result of the active-audit single-flight check (WL-0MT3PHW4I002SNOV).
 *
 *  - `{ok:true, active:true}` — a non-stale `kind=audit` dispatch marker
 *    maps to an item still `in_progress` (dispatched but not yet
 *    completed/reviewed): an audit is running, so the audit tier must be
 *    skipped this tick (outcome reason `audit-in-flight`).
 *  - `{ok:true, active:false}` — no non-stale marker maps to an
 *    `in_progress` item: the audit tier may proceed (audits stay strictly
 *    sequential — never fan-out).
 *  - `{ok:false}` — the check could not complete (e.g. worklog query
 *    failure): fail-open — the audit tier is skipped and dispatch falls
 *    through to the next tier; all dispatch is never blocked by an
 *    unanswerable check.
 */
export type DowntimeActiveAuditResult =
  | { ok: true; active: boolean; source?: 'host-wide' | 'per-worklog' }
  | { ok: false; error?: string };
/**
 * Result of the running-downtime-panes liveness query (AC1/AC3, parent
 * WL-0MTYZXSLN008HZOW). `count` is the number of dispatched downtime panes
 * that are STILL ALIVE (their pi agent session is live in a Herdr pane),
 * machine-wide and therefore across roots and leader/instance restarts.
 *
 *  - `{ok:true, count}` — the query succeeded; `count` is authoritative.
 *  - `{ok:false}` — the query could not complete (herdr unavailable):
 *    fail-closed — the dispatcher treats the running-pane bound as reached
 *    (no dispatch) rather than risk over-dispatch on unknown state.
 */
export type RunningPanesResult =
  | { ok: true; count: number; paneIds?: string[]; records?: HerdrPaneRecord[] }
  | { ok: false; error?: string };
/** One parsed `herdr pane list` record (only the fields liveness needs). */
export interface HerdrPaneRecord {
  paneId: string;
  label?: string;
  agent?: string;
  agentStatus?: string;
  /** Pane working directory (worklog-root hint for cross-root resume). */
  cwd?: string;
  /** Raw `agent_session` field (session log path + agent metadata). */
  agentSession?: HerdrAgentSession;
}
/**
 * Item-scoped in-flight state, resolved ONCE per idle cycle and threaded into
 * the dispatch loops (WL-0MUBEZ6PE002WLP4 / F3 WL-0MUBVKXQJ000L8EO).
 *
 * Tri-state, not a boolean, because the correct behaviour differs between
 * "no live pane" and "could not find out":
 *
 *  - `available: true`  — the pane query succeeded; `itemIds` is authoritatively
 *    the set of items with a live working pane. A candidate in the set is
 *    skipped; a candidate outside it is escalated.
 *  - `available: false` — the query failed/was unparseable, OR the dep is not
 *    wired. The caller falls back to the dispatched-marker TTL so escalation
 *    is never permanently starved and a duplicate is never permitted while an
 *    item is proven in-flight.
 */
export interface InFlightPanes {
  available: boolean;
  itemIds: Set<string>;
}
/** The shared "nothing is provably in flight" value (also the fail-open fallback). */
export const NO_IN_FLIGHT_PANES: InFlightPanes = { available: true, itemIds: new Set() };
/** Why the critical-first guard reached its escalate/skip decision (WL-0MUBEZ6PE002WLP4). */
export type CriticalFirstGuardReason =
  | 'in-flight-pane'
  | 'no-live-pane'
  | 'in-flight-unverified'
  | 'marker-stale-escalation';
/** The critical-first guard's verdict for one candidate. */
export interface CriticalFirstGuardDecision {
  /** True when the candidate may be escalated; false when a live/unverified pane holds it. */
  escalate: boolean;
  /** Machine-readable reason (also the AC6 selectionReason vocabulary). */
  reason: CriticalFirstGuardReason;
}
