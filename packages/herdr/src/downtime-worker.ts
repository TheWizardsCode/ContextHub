/**
 * packages/herdr/src/downtime-worker.ts — Local-LLM downtime worker (contract)
 *
 * Test-first contract for the herdr downtime worker (parent
 * WL-0MSF49FMW009M06K). Implemented in F1 (tests + fixtures), F2 (settings
 * clamps, poller, parsing, runtime idle evaluation) and F3 (idle tracker,
 * dispatch orchestration, pane spawn):
 *
 *  - `isIdleStatus` — idle detection from a `/llama/local/status` payload.
 *  - `evaluateIdle` — runtime idle evaluation with the fail-closed
 *    degradation for a configured N < total slots (no per-slot data yet) and
 *    the spare-capacity per-slot mode (relaxed global gate, parent
 *    WL-0MT32F90V008UAD2).
 *  - `parseLlamaStatus` / `fetchLocalStatus` / `createDowntimePoller` — the
 *    single-flight poller for `GET {proxyUrl}/llama/local/status` with
 *    per-poll timeout and fail-closed parsing.
 *  - `createIdleTracker` — continuous idle-duration tracker (idleSince vs
 *    threshold).
 *  - `dispatchDowntimeWork` — Herdr-list-head dispatch (WL-0MTK1ILM2009QYB2): consumes the Herdr selection list head
 *    (`deps.getHerdrListHead` = fetcher → smart-selection → grouping, the sole ranking path) and applies
 *    every remaining safety gate as a sequential FILTER on that ordered sequence (scheduled prompt first,
 *    then code-freeze, dispatched-marker, free-slot minimums, active-audit single-flight, freshness/recency,
 *    pre-dispatch CAS claim + per-process single-flight, then spawn). No second ranking implementation remains
 *    on the dispatch path (AC1–2). The former audit/implement/plan/intake tier ordering is retired.
 *    Code-freeze gate
 *    (WL-0MSQ0RPQP00636JY): the ship-it marker is re-read fresh on every
 *    dispatch; while frozen OR ambiguous (fail-closed) the audit and
 *    implement tiers are skipped (no new implementations/audits during a
 *    release) and plan/intake still dispatch; an empty plan/intake backlog
 *    during a freeze reports reason 'code-freeze' (never 'no-candidate'),
 *    so the freeze never triggers the no-candidate cooldown and dispatch
 *    resumes immediately when it lifts. The audit tier
 *    additionally excludes items the downtime worker has already dispatched
 *    for `/skill:audit` (durable dispatched-marker exclusion,
 *    WL-0MSLIY8ZR004QUSY) unless a fresh audit exists since, closing the
 *    re-selection loop where a dispatched run reverts the item to
 *    completed/in_review without recording a fresh audit. Every tier
 *    additionally excludes items with `needsProducerReview === true`
 *    (parent WL-0MTIAL65N004T22F): items flagged for producer review are
 *    never auto-dispatched, preventing the worker from consuming local
 *    slots on items awaiting a human decision. A tier-2 CLI error does
 *    NOT short-circuit: the idea tier is still attempted so a tier-3
 *    candidate can still dispatch.
 *    `wl next` failures are reported as `{ok:false}` (fail closed to busy)
 *    and are never mistaken for an empty backlog; three consecutive error
 *    outcomes pause the worker entirely after logging the persistent error
 *    via `deps.recordError` (three-strike rule, `DOWNTIME_ERROR_STRIKE_LIMIT`).
 *  - `buildDowntimePaneArgs` / `spawnDowntimePane` — send-to-pi.sh
 *    invocation (`--pane-name Downtime <kind>`, `--no-focus`, `--cwd`,
 *    `--model`), detached and unref'd; `error`/`exit` handlers capture a
 *    spawn failure or non-zero script exit so a failed pane is never
 *    logged as a successful dispatch (WL-0MSLWJ3I70031Z8U).
 *    `buildDowntimeSpawnOptions` bounds the dispatched audit fan-out:
 *    `AUDIT_PHASE2_PARALLELISM=1` makes the audit skill's Phase 2 child
 *    deep-analysis strictly sequential so a parent audit needs exactly
 *    2 local slots (parent + one child), fitting cheap mode's capacity
 *    (WL-0MSORQ1RG005DGUS).
 *  - `createDowntimeWorker` — per-tick orchestrator (poll → evaluate →
 *    track → dispatch) with settings re-read each tick, plus the
 *    no-candidate cooldown (WL-0MSI7DQL10016QYX): a genuine empty backlog
 *    in both stages pauses the worker entirely for
 *    `downtimeNoCandidateCooldownMs` (default 60 min) — no poll, no idle
 *    tracking, no dispatch — and resets the idle tracker so a fresh full
 *    idle period is required after the pause. Transient `wl` errors and the
 *    in-flight dispatch guard never trigger the cooldown; three consecutive
 *    CLI-error outcomes do (three-strike rule), after logging the
 *    persistent error via `deps.recordError`. In coordination mode
 *    (WL-0MTEZ4XZJ006Y9U7) an empty coordination file is an OFFER LIST,
 *    not the backlog: the leader removes each entry after dispatching, so
 *    an empty file is a transient gap — the tick probes the worklog
 *    (`computeMostImportantItem`) before pausing and only a genuinely
 *    empty backlog pauses (a probe CLI error is itself a three-strike
 *    event, never a silent pause). The cooldown gate runs AFTER the
 *    leader-election/check-in block so the 30-min check-in (the only
 *    re-offer mechanism) still lands during a pause, and a successful
 *    re-offer (`checkIn.updated && offered !== null`) cancels the pause
 *    immediately.
 *  - `buildDowntimePrompt` / `BLOCKED_QUESTIONS_INSTRUCTION` — dispatched
 *    agent prompt, including the blocked-questions instruction.
 *  - `clampDowntimePollInterval` / `clampDowntimeIdleThresholdMs` /
 *    `clampDowntimeRequiredFreeSlots` / `clampDowntimeNoCandidateCooldownMs`
 *    — settings clamps, wired into `settings.ts`.
 *  - `selectWithRotation` (WL-0MSSRED76008LGB6) — rotation-aware selection:
 *    within each tier, candidates sharing the same priority level are
 *    rotated round-robin via the shared durable cursor
 *    (`.worklog/downtime-round-robin.json`, `downtime-round-robin.ts`);
 *    fail-open — no registry / no priority → pre-rotation sortIndex order.
 *  - `jitterPollIntervalMs` (WL-0MSSRED76008LGB6) — probe jitter: the
 *    effective poll interval is jittered ±50% of
 *    `downtimePollIntervalMs` per reschedule so instances do not probe in
 *    lockstep; fail-open without a registry → static interval.
 *
 * Fail-closed behaviour (never dispatch, never throw) is the SAFE default
 * at every boundary.
 */

import { spawn } from 'node:child_process';
import { isAuditFresh } from '@worklog/shared/icons';
import type { CodeFreezeStatus } from './code-freeze.js';
import { disableMarkerExists, removeDisableMarker, writeDisableMarker } from './downtime-disable-marker.js';
import { fetchCompletedItemCount } from './fetcher.js';
import type { ScheduledPrompt } from './scheduled-prompts.js';
import type { RoundRobinRegistry } from './downtime-round-robin.js';
import {
  readCoordinationFile,
  getEntry,
  upsertEntry,
  removeEntry,
  type CoordinationEntry,
} from './coordination.js';
import {
  loadRoundRobinCursor,
  advanceRoot,
} from './downtime-round-robin-by-root.js';
import {
  createLeaderElectionManager,
  cleanupStaleElection,
  DEFAULT_LEASE_TTL_SECONDS,
} from './leader-election.js';
import { appendCoordinationLogEntry } from './downtime-log.js';
import {
  readDowntimeLogEntries as _readDowntimeEntries,
  auditDispatchedItemIds as _auditIds,
  implementDispatchedItemIds as _implIds,
  dispatchedItemStages as _dispatchedStages,
} from './downtime-log.js';
import { buildDowntimePaneTitle, MAX_PANE_TITLE_LENGTH } from './pane-title.js';

export type { ScheduledPrompt } from './scheduled-prompts.js';
export type { CoordinationEntry } from './coordination.js';

// ── Constants ─────────────────────────────────────────────────────────

/** Proxy status endpoint path. */
export const DOWNTIME_STATUS_PATH = '/llama/local/status';

/** Hard floor for the poll interval (must not hammer the proxy). */
export const DOWNTIME_POLL_INTERVAL_FLOOR_MS = 10_000;

/** Defensive floor for the idle threshold (prevents immediate dispatch). */
export const DOWNTIME_IDLE_THRESHOLD_FLOOR_MS = 1_000;

export const DEFAULT_DOWNTIME_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS = 60_000;

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

/** Sane floor for the no-candidate cooldown (the pause cannot be disabled or set trivially small). */
export const DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS = 60_000;

/** Default pause after a genuine empty backlog: 60 minutes. */
export const DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS = 3_600_000;

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
 * Default coordination check-in interval: 30 minutes (parent AC3).
 * Every instance re-verifies/updates its entry in the shared coordination
 * file at this cadence. The leader checks in more often
 * (WL-0MTOCBP1D009P4U3) — see DEFAULT_LEADER_CHECK_IN_MS.
 */
export const DEFAULT_COORDINATION_CHECK_IN_MS = 30 * 60 * 1000;

/**
 * Leader coordination check-in interval (WL-0MTOCBP1D009P4U3): the leader
 * re-offers every 4 minutes so offers stay fresh and the lease is renewed
 * inside the 5-minute TTL with ~1 min grace. Non-leaders stay at 30 min.
 */
export const DEFAULT_LEADER_CHECK_IN_MS = 4 * 60 * 1000;

/**
 * Coordinator tier priority (parent AC4): the leader dispatches the
 * highest-priority tier first — audit, then implement, then plan, then
 * intake. The scheduled-prompts tier (WL-0MSS1Q5ER007QDKX) is NOT part of
 * this order: like the legacy path, the coordination path checks it as a
 * FIRST dispatch stage (freeze-gated, before ANY coordination-tier work),
 * so a due prompt dispatches instead of reaching these tiers.
 */
export const COORDINATION_TIER_ORDER = ['audit', 'critical', 'implement', 'plan', 'intake'] as const;

export type CoordinationTierKind = (typeof COORDINATION_TIER_ORDER)[number];

// ── Types ─────────────────────────────────────────────────────────────

/** Shape of `GET /llama/local/status` as served by the llama-proxy. */
export interface LlamaStatus {
  llama_server_running: boolean;
  /**
   * GLOBAL query activity: any request in flight (local AND remote).
   *
   * This field is no longer used for idle/busy detection — the worker
   * exclusively uses `local_active_query`. Remote provider streams keep this
   * true while the local model is idle with free slots, so it cannot be used
   * as the busy signal (RCA WL-0MSK9TUCA00206M7). Present in the payload for
   * backwards compatibility with older proxy versions.
   */
  active_query: boolean;
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
  local_owner_lease_remaining_seconds?: number | null;
  /**
   * Per-slot identity (LP-0MSG5TA7Y002GN39): served by proxies that expose
   * slot-level detail. ABSENT on pre-feature proxies — the worker then
   * falls back to the count-based all-slots-free logic. When present, the
   * downtime worker tracks idle duration PER SLOT ID so a configured N
   * requires the SAME N slots continuously free.
   */
  slots?: LlamaSlot[];
}

/**
 * Per-slot detail served inside `LlamaStatus.slots` (NORMALIZED by
 * `parseLlamaStatus`). The proxy (observability.py) serves `slot_id` as an
 * INTEGER (`slot.get("id", i)`); the parser coerces numeric ids to strings
 * and clamps negatives to 0 (WL-0MSVRMAWM007QNR5), so the normalized
 * `slot_id` is always a non-empty string — the per-slot idle tracker keys
 * its timers by it.
 */
export interface LlamaSlot {
  slot_id: string;
  is_processing: boolean;
}

// ── Idle detection (implemented) ──────────────────────────────────────

/**
 * The FULL global idle checks used by `isIdleStatus` and the count-based
 * (non-per-slot) path of `evaluateIdle`: llama-server up, no active local
 * query (the sole busy signal), no model switch, no local lease. The
 * per-slot branch uses the relaxed `perSlotGlobalIdleChecks` instead
 * (spare-capacity dispatch, parent WL-0MT32F90V008UAD2).
 *
 * `local_active_query` is the SOLE busy signal for the query gate:
 * `true` → busy, `false` → not busy from queries. ABSENT on pre-fix proxies
 * → busy (fail-closed), preventing dispatch when the busy signal is
 * unverifiable.
 */
function globalIdleChecks(status: LlamaStatus): boolean {
  if (!status.llama_server_running) return false;
  // `local_active_query` is the sole busy signal (LP-0MSL2ZLLS009RVKR):
  // true → busy, false → not busy, absent (pre-fix proxy) → busy (fail-closed).
  if (status.local_active_query !== false) return false;
  if (status.model_switch_in_progress) return false;
  if (status.local_lease_active) return false;
  return true;
}

/**
 * Per-slot-safe global checks (spare-capacity dispatch, parent
 * WL-0MT32F90V008UAD2): in per-slot identity mode, ONLY llama-server-up and
 * no-model-switch remain GLOBAL gates — `active_query` /
 * `local_active_query` / `local_lease_active` are superseded by the per-slot
 * `is_processing` signal (the busy slot holding the operator's query/lease IS
 * the active work the operator wants to run alongside; it must not block
 * dispatch into the free slots, LP-0MSG5TA7Y002GN39 Q&A). Used exclusively by
 * the per-slot branches of `evaluateIdle` and `createDowntimeWorker.tick()`;
 * the count-based path keeps the full `globalIdleChecks` (fail-closed).
 */
function perSlotGlobalIdleChecks(status: LlamaStatus): boolean {
  if (!status.llama_server_running) return false;
  if (status.model_switch_in_progress) return false;
  return true;
}

/**
 * True when the proxy reports an idle state for the required free-slot
 * count:
 *
 *  - llama-server is running,
 *  - no active query, model switch, or local lease,
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
 * Runtime idle evaluation (F2). Same conditions as `isIdleStatus`, plus the
 * fail-closed fallback from planning decision Q7: while the proxy does not
 * expose per-slot identity (LP-0MSG5TA7Y002GN39), a configured N with
 * 0 < N < total slots degrades to requiring ALL slots free — stricter than
 * configured, never "any N slots" without same-slot identity. N > total
 * slots never dispatches (carried through `isIdleStatus`).
 *
 * Per-slot mode (LP-0MSG5TA7Y002GN39): when the payload serves per-slot
 * identity AND 0 < N < total, the free count comes from the slots array
 * (which identifies WHICH slots are free) so the same N slots can be
 * required; the count-based logic is unchanged for N ≤ 0 / N ≥ total.
 *
 * Spare-capacity relaxation (parent WL-0MT32F90V008UAD2): in per-slot mode
 * the global gate is the per-slot-safe subset (server up + no model switch
 * only) — a query/lease tied to a busy slot is the operator's own session
 * and must not block dispatch into the free slots (F1 tests AC1/AC2).
 */
export function evaluateIdle(status: LlamaStatus, requiredFreeSlots: number): boolean {
  const total = status.total_slots;
  if (!Number.isFinite(total) || total <= 0) return false; // ambiguous → busy

  // Per-slot mode: per-slot identity present AND 0 < N < total. The relaxed
  // global gate applies (server up + no model switch); the slot requirement
  // is the per-slot free count.
  if (
    Array.isArray(status.slots) &&
    requiredFreeSlots > 0 &&
    requiredFreeSlots < total
  ) {
    if (!perSlotGlobalIdleChecks(status)) return false;
    // Fail-closed counting: an entry without an explicit boolean
    // `is_processing` is treated as processing (busy), never free.
    const free = status.slots.filter(
      (s) => typeof s.is_processing === 'boolean' && !s.is_processing,
    ).length;
    return free >= requiredFreeSlots;
  }

  const effective = requiredFreeSlots > 0 && requiredFreeSlots < total
    ? total
    : requiredFreeSlots;
  return isIdleStatus(status, effective);
}

// ── Idle-duration tracker (implemented — F3) ──────────────────────────

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
        if (slot.is_processing) {
          idleSince.set(slot.slot_id, null); // own timer reset only
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

// ── Poller (implemented — F2) ────────────────────────────────────────

/**
 * Minimal structural fetch signature (the DOM `fetch` type is not part of
 * this project's tsconfig lib). Node's global `fetch` satisfies it at
 * runtime.
 */
export type LlamaStatusFetcher = (
  url: string,
  init?: { signal?: unknown },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Per-poll timeout: an unresponsive proxy must fail closed, not hang. */
export const DEFAULT_DOWNTIME_POLL_TIMEOUT_MS = 5_000;

/**
 * Fail-closed parse of a `GET /llama/local/status` payload. Returns null
 * (treated as busy by the caller) when required fields are missing or
 * malformed. `local_lease_active` is derived from the lease fields the
 * proxy actually serves when the boolean is not present.
 */
export function parseLlamaStatus(raw: unknown): LlamaStatus | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.llama_server_running !== 'boolean') return null;
  if (typeof o.active_query !== 'boolean') return null;
  if (typeof o.model_switch_in_progress !== 'boolean') return null;

  // Local-only signal (LP-0MSL2ZLLS009RVKR): absent on pre-fix proxies.
  // In isIdleStatus, absence → busy (fail-closed, no silent degraded
  // dispatch). A malformed (non-boolean) value is ambiguous → busy.
  let localActiveQuery: boolean | undefined;
  if (o.local_active_query !== undefined) {
    if (typeof o.local_active_query !== 'boolean') return null;
    localActiveQuery = o.local_active_query;
  }

  const available = o.available_slots;
  const total = o.total_slots;
  if (typeof available !== 'number' || !Number.isFinite(available) || available < 0) return null;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;

  let localLeaseActive: boolean;
  if (typeof o.local_lease_active === 'boolean') {
    localLeaseActive = o.local_lease_active;
  } else {
    // Derived from the lease fields served by the llama-proxy.
    const ownerSession = o.local_owner_session_id;
    const leaseSeconds = o.local_owner_lease_remaining_seconds;
    localLeaseActive =
      (typeof ownerSession === 'string' && ownerSession.length > 0) ||
      (typeof leaseSeconds === 'number' && Number.isFinite(leaseSeconds) && leaseSeconds > 0);
  }

  // Optional per-slot identity (LP-0MSG5TA7Y002GN39): absent on pre-feature
  // proxies (slots stays undefined — backward compatible). A malformed
  // array (non-array, entry missing/empty slot_id, non-boolean
  // is_processing, duplicate slot_ids) is ambiguous → null (busy,
  // fail-closed): per-slot tracking must never run on identity it cannot
  // trust. slot_id accepts BOTH the string contract and the proxy's
  // integer contract (`slot.get("id", i)` in observability.py): numeric
  // ids are coerced to strings and negatives clamped to 0
  // (WL-0MSVRMAWM007QNR5 — the Aug 15-16 zero-dispatch regression). An
  // empty array is valid (zero slots reported free).
  let slots: LlamaSlot[] | undefined;
  if (o.slots !== undefined) {
    if (!Array.isArray(o.slots)) return null;
    const parsed: LlamaSlot[] = [];
    const seen = new Set<string>();
    for (const entry of o.slots) {
      if (typeof entry !== 'object' || entry === null) return null;
      const slot = entry as Record<string, unknown>;
      // slot_id: string contract preserves the existing zero-length
      // rejection guard (empty identity is ambiguous); the proxy's
      // integer contract is accepted and coerced to string with negative
      // values clamped to 0 (WL-0MSVRMAWM007QNR5). A non-finite or
      // non-integer number is ambiguous → null (busy, fail-closed).
      let slotId: string;
      if (typeof slot.slot_id === 'string') {
        if (slot.slot_id.length === 0) return null;
        slotId = slot.slot_id;
      } else if (typeof slot.slot_id === 'number') {
        if (!Number.isFinite(slot.slot_id) || !Number.isInteger(slot.slot_id)) return null;
        slotId = String(Math.max(0, slot.slot_id));
      } else {
        return null;
      }
      if (typeof slot.is_processing !== 'boolean') return null;
      if (seen.has(slotId)) return null; // duplicate identity → ambiguous
      seen.add(slotId);
      parsed.push({ slot_id: slotId, is_processing: slot.is_processing });
    }
    slots = parsed;
  }

  return {
    llama_server_running: o.llama_server_running,
    active_query: o.active_query,
    local_active_query: localActiveQuery,
    model_switch_in_progress: o.model_switch_in_progress,
    local_lease_active: localLeaseActive,
    available_slots: available,
    total_slots: total,
    current_model: typeof o.current_model === 'string' ? o.current_model : undefined,
    local_owner_session_id:
      typeof o.local_owner_session_id === 'string' ? o.local_owner_session_id : undefined,
    local_owner_lease_remaining_seconds:
      typeof o.local_owner_lease_remaining_seconds === 'number'
        ? o.local_owner_lease_remaining_seconds
        : undefined,
    slots,
  };
}

/**
 * Fetch and parse `GET {url}/llama/local/status` with a per-poll timeout.
 * Every failure mode — network error, timeout, HTTP error status, invalid
 * JSON, ambiguous payload — resolves to null (busy); this function never
 * throws.
 */
export async function fetchLocalStatus(
  url: string,
  opts?: { timeoutMs?: number; fetcher?: LlamaStatusFetcher },
): Promise<LlamaStatus | null> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_DOWNTIME_POLL_TIMEOUT_MS;
  const fetcher = opts?.fetcher ?? (globalThis.fetch as unknown as LlamaStatusFetcher);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { signal: controller.signal });
    if (!res.ok) return null;
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      return null; // invalid JSON
    }
    return parseLlamaStatus(raw);
  } catch {
    return null; // network errors / timeouts → busy, never throw
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Single-flight poller for the llama-proxy status endpoint. `poll()` never
 * overlaps: a second call while one poll is in flight returns the same
 * in-flight promise.
 */
export function createDowntimePoller(
  proxyUrl: string,
  fetcher: LlamaStatusFetcher = globalThis.fetch as unknown as LlamaStatusFetcher,
  timeoutMs: number = DEFAULT_DOWNTIME_POLL_TIMEOUT_MS,
): DowntimePoller {
  let inFlight: Promise<LlamaStatus | null> | null = null;
  const url = `${proxyUrl.replace(/\/+$/, '')}${DOWNTIME_STATUS_PATH}`;

  return {
    poll(): Promise<LlamaStatus | null> {
      if (inFlight !== null) return inFlight;
      inFlight = fetchLocalStatus(url, { timeoutMs, fetcher }).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    isPolling(): boolean {
      return inFlight !== null;
    },
  };
}

// ── Dispatch (implemented — F3) ───────────────────────────────────────

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
}
export type DowntimeHerdrListResult =
  | { ok: true; items: DowntimeHerdrItem[] }
  | { ok: false; error?: string };
export type DowntimeSkillKind = 'plan' | 'intake' | 'audit' | 'implement';

/**
 * Every dispatch kind recorded in the rolling audit log: the worklog tiers
 * plus the scheduled-prompts tier (WL-0MSS1Q5ER007QDKX), which has no work
 * item (kind `scheduled`, log-only markers).
 */
export type DowntimeDispatchKind = DowntimeSkillKind | 'scheduled';

export interface DowntimeCandidate {
  id: string;
  title: string;
  stage: DowntimeStage;
  /**
   * Worklog status of the candidate (`open` for selectable plan/intake/
   * implement items; `completed` for audit candidates). The plan/intake tiers
   * filter client-side to `status === 'open'` (RCA WL-0MSRBFFLN005W3VT
   * amplifier fix): `wl next --stage X` keeps completed items under a stage
   * filter, so without this guard a completed/in_review item whose stage
   * matches could be dispatched for /skill:plan or /skill:intake.
   */
  status?: string;
  /** wl next priority order preserved for deterministic selection. */
  sortIndex?: number;
  /** Worklog priority level (critical/high/medium/low) — round-robin grouping key. */
  priority?: string;
  /**
   * Needs producer review flag (parent WL-0MTIAL65N004T22F): when `true`,
   * the item must NOT be auto-dispatched by the downtime worker — a human
   * producer must review it first. Absent/false/undefined → dispatchable.
   * Filtered in every `select*` function (AC1).
   */
  needsProducerReview?: boolean;
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
  sortIndex?: number;
  /** Worklog priority level (critical/high/medium/low) — round-robin grouping key. */
  priority?: string;
  /**
   * Needs producer review flag (parent WL-0MTIAL65N004T22F): when `true`,
   * exclude from audit-tier selection (AC1).
   */
  needsProducerReview?: boolean;
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
  /** Latest audit timestamp (enriched; absent on show-only items). */
  auditedAt?: string | null;
  /** Item update timestamp (audit-tier recency window). */
  updatedAt?: string;
  /** wl priority order preserved for deterministic ordering. */
  sortIndex?: number;
  /**
   * Needs producer review flag (parent WL-0MTIAL65N004T22F): when `true`,
   * exclude from classification (the item is not dispatchable) and the
   * coordination leader path skips it (AC3).
   */
  needsProducerReview?: boolean;
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
  | { ok: true; active: boolean }
  | { ok: false; error?: string };

/** External boundaries injected so the dispatch logic is testable. */
export interface DowntimeWorkerDeps {
  /**
   * Herdr list head fetch (WL-0MTK1ILM2009QYB2): the canonical ranking
   * (fetcher → smart-selection → grouping). Returns ordered candidates
   * (already ranked); dispatcher applies safety gates as sequential filters.
   * Fail-closed `{ok:false}` on a wl/parse failure (a strike), otherwise
   * `{ok:true, items:[…]}` (empty when genuinely empty).
   */
  getHerdrListHead(cwd: string): Promise<DowntimeHerdrListResult>;
  /**
   * Runs `wl next --stage <stage> -n 10 --json` and reports the first
   * selectable candidate (or a wl failure). `cwd` is the worklog root whose
   * `.worklog/downtime-dispatches.log` is consulted for the plan/intake
   * dispatched-marker change-guard (RCA WL-0MSRBFFLN005W3VT design point 3):
   * a candidate already dispatched for its tier while still at its
   * dispatched-at stage is excluded. A batch is fetched so excluding the
   * top candidate does not starve selection of the next one.
   */
  getNextItem(stage: DowntimeStage, cwd: string): Promise<DowntimeNextResult>;
  /**
   * Look up the next completed/in_review item WITHOUT a valid audit (the
   * audit dispatch tier, which runs before the implement/plan/intake tiers).
   * ROOT-ONLY (WL-0MSTLFW14000KPEC): the `wl list` lookup carries
   * `--root-only`, so completed/in_review children (items with a parentId)
   * are excluded server-side and are never dispatched independently — only
   * parent items are audit candidates (the producer reviews deliverable
   * units, whose audits cover their children).
   * Uses the same `DowntimeNextResult` error channel as `getNextItem`
   * (WL-0MSLWJ2KP0002SV0): `{ok:false}` is a wl/parse failure (a CLI-error
   * strike — never a candidate), while `{ok:true, candidate:null}` is a
   * GENUINELY empty audit tier. The distinction matters: a broken audit
   * lookup must never silently look like "no audit candidates" (which would
   * disable the audit dispatch tier forever without any observable trace).
   * `cwd` is the worklog root whose `.worklog/downtime-dispatches.log` is
   * consulted for the dispatched-marker exclusion (WL-0MSLIY8ZR004QUSY):
   * items the downtime worker already dispatched for `/skill:audit` are
   * never re-selected while they still lack a fresh audit.
   */
  getNextAuditCandidate(cwd: string): Promise<DowntimeNextResult>;
  /**
   * Active-audit single-flight check (WL-0MT3PHW4I002SNOV): true when any
   * non-stale `kind=audit` dispatch marker in the shared rolling dispatch
   * log (`<cwd>/.worklog/downtime-dispatches.log`) maps to an item still
   * `in_progress` — an audit was dispatched (by ANY instance, leader or
   * not) and has not yet completed/reviewed. The dispatcher consults this
   * before selecting an audit candidate and skips the audit tier while one
   * is active, keeping audits strictly sequential (never fan-out). A marker
   * older than `DOWNTIME_AUDIT_STALE_WINDOW_MS` (2h) is treated as stale
   * (the audit pane may have crashed without updating the work item) and
   * ignored. Fail-open: `{ok:false}` on a worklog-query failure — the
   * dispatcher then skips the audit tier and falls through to the next
   * tier rather than blocking all dispatch (fail-safe). `cwd` is the
   * worklog root the dispatch log lives under.
   */
  getActiveAudit(cwd: string): Promise<DowntimeActiveAuditResult>;
  /**
   * Look up the next implement-tier candidate (WL-0MSMAYPQP001FLR6): the
   * highest-priority open plan_complete item with risk ≤ Medium / effort ≤ Medium,
   * excluding dependency-blocked items (wl next default) and items already
   * dispatched for `/skill:implement` (kind `implement` dispatched markers,
   * AC6). Fail-closed: a wl failure yields null (no dispatch) — the
   * plan/intake fallback still runs. `cwd` is the worklog root whose
   * `.worklog/downtime-dispatches.log` is consulted for the marker set.
   */
  getNextImplementCandidate(cwd: string): Promise<DowntimeCandidate | null>;
  /**
   * Look up the next critical-first candidate (WL-0MT3FM8VA005XBHE): the
   * highest-priority open CRITICAL item at ANY stage (idea /
   * intake_complete / plan_complete), including dependency-blocked ones
   * (`wl list --priority critical --status open` does NOT exclude them —
   * unlike `wl next`), with the stage-appropriate skill mapping and the
   * plan_complete implement caps (decision Q2). The returned candidate is
   * the stage-appropriate dispatch target (kind derived via
   * `criticalSkillKind(candidate.stage)` by the tier). Fail-closed: a wl
   * failure resolves `{ok:false}` via the `DowntimeNextResult` error
   * channel (never a silent empty — a broken critical lookup must not
   * look like "no critical work"). `cwd` is the worklog root whose
   * `.worklog/downtime-dispatches.log` is consulted for the dispatched-
   * marker change-guard (an item already dispatched for its tier while
   * still at its dispatched-at stage is excluded).
   */
  getNextCriticalCandidate(cwd: string): Promise<DowntimeNextResult>;
  /**
   * Fetch ONE work item by id (leader-only coordination path): the leader
   * re-checks each coordination entry's item against its CURRENT worklog
   * state so a stale entry can never be dispatched on faith alone.
   * `cwd` is the entry's worklog root (the item lives in that worklog).
   * Fail-closed: `{ok:false}` on a wl failure or an unparseable/missing
   * item — the caller treats it as a CLI-error strike (never a silent
   * skip).
   *
   * Optional for backward compatibility: the legacy (non-coordination)
   * dispatch path never consults it; `createDowntimeDeps` always provides
   * it and `dispatchFromCoordination` (the leader path) fails closed
   * (`wl-error`) when it is absent.
   */
  fetchItem?(itemId: string, cwd: string): Promise<DowntimeItemResult>;
  /**
   * Re-check whether a work item already has a fresh audit (WL-0MT8KSTOE00871E7).
   * Called in the audit-tier dispatch path BETWEEN candidate selection and
   * dispatch to detect whether a valid audit was recorded in the interim
   * (e.g. by a human or another process). Resolves true when the item has
   * a fresh audit (auditedAt within 60s of updatedAt), false otherwise.
   * Fail-closed: `{ok:false}` on a wl/CLI failure → treated as "not fresh"
   * (the dispatch proceeds — conservative default, never blocks dispatch).
   *
   * Convenience wrapper: fetches the item and applies `isAuditFresh`.
   * A single dep on the worker boundary, testable without wl.
   */
  hasFreshAudit(itemId: string, cwd: string): Promise<boolean>;
  /**
   * Read the current code-freeze marker status (tri-state: 'frozen' /
   * 'not-frozen' / 'ambiguous'). `cwd` is the worklog root; the marker
   * lives at `<cwd>/.worklog/code-freeze.json`. Read fresh on EVERY
   * dispatch (never cached) so a freeze that starts or ends between idle
   * periods is honored on the next dispatch attempt (WL-0MSQ0RPQP00636JY).
   * Fail-closed: an 'ambiguous' marker is treated as frozen by the
   * dispatcher — no implement/audit dispatch while the marker cannot be
   * trusted.
   */
  readCodeFreezeStatus(cwd: string): CodeFreezeStatus;
  /**
   * Claim the item (CAS: `wl update <id> --status in_progress --if-status
   * <expected.status> [--if-stage <expected.stage>]`) BEFORE anything else.
   * Exactly one concurrent pane wins; a loser resolves `{ok:false,
   * reason:'stale'}` and the dispatcher aborts (no pane, no marker, no
   * success record). A `{ok:false, reason:'error'}` is a wl CLI failure
   * (a strike, never silently discarded — WL-0MSLWJ310000ND0X absorbed).
   */
  claimItem(itemId: string, expected: DowntimeClaimExpected): Promise<DowntimeClaimResult>;
  /**
   * Open a visible pi agent pane running the prompt (via send-to-pi.sh).
   * Resolves `{ok:true}` when the pane opened (or the probe window elapsed
   * with no failure — fire-and-forget); `{ok:false, error|exitCode}` on a
   * handled spawn `error` event or a non-zero script exit within the probe
   * window (no unhandled-exception crash, WL-0MSLWJ3I70031Z8U absorbed).
   * `paneName` overrides the default `Downtime <kind>` pane name — the
   * scheduled-prompts tier passes `Downtime <entryId>` (WL-0MSS1Q5ER007QDKX).
   * `itemTitle`/`itemId` thread the candidate's context so the pane is named
   * `Downtime triggered <kind> <title> - <id>` (WL-0MSJ4E8UA005KG9Y).
   */
  spawnAgentPane(
    prompt: string,
    opts: { model: string; cwd: string; paneName?: string; itemTitle?: string; itemId?: string },
  ): Promise<DowntimeSpawnResult>;
  /**
   * Audit trail for a successful dispatch: comment on the item + rolling
   * log entry under `.worklog`. Resolves TRUE only when the rolling-log
   * MARKER was written (the dispatched-marker source); a comment failure is
   * tolerated (the comment is a durable cross-machine trail, not the
   * marker). A false result makes the dispatcher ABORT before spawning — an
   * unmarked item is never dispatched (fail-closed, RCA design point 2).
   * Scheduled-prompt dispatches pass `noItemComment: true` — there is no
   * work item, so only the rolling-log marker is written (no wl comment).
   */
  recordDispatch(event: DowntimeDispatchEvent): Promise<boolean>;
  /**
   * Look up the first DUE scheduled prompt (WL-0MSS1Q5ER007QDKX): reads the
   * project-local config at `<cwd>/.worklog/scheduled-prompts.json` and
   * returns the first entry whose frequency threshold is met, in config
   * order. Absent or malformed config → null (fail-closed, logged): no
   * scheduled dispatch and the existing tiers are unaffected (`wl init` is
   * the provisioning path). A due entry resolves non-null — the caller
   * dispatches it instead of reaching the backlog tiers.
   */
  getDueScheduledPrompt(cwd: string): Promise<ScheduledPrompt | null>;
  /**
   * Persist a scheduled prompt's `lastTriggeredAt` (atomic tmp+rename) so a
   * delayed dispatch never fires more often than its frequency. Resolves
   * false on any failure — the dispatcher ABORTS the spawn (an unrecorded
   * dispatch never runs) and the entry stays due for the next idle slot.
   * Must never throw (fail-closed).
   */
  recordScheduledPromptTrigger(cwd: string, promptId: string, at: string): Promise<boolean>;
  /**
   * Record a spawn-failure trace for an attempted dispatch (audit-log
   * integrity, WL-0MSLWJ3I70031Z8U AC2): a failed pane spawn appends an
   * `outcome: 'spawn-failed'` entry with the error/exit trace to the
   * rolling log, so the log distinguishes "attempted" from "opened" and
   * never claims success for a pane that never appeared. Must never throw
   * (fail-closed): audit logging must not crash the worker.
   */
  recordDispatchFailure(event: DowntimeDispatchFailureEvent): Promise<void>;
  /**
   * Record a persistent CLI-error event (three consecutive wl failures).
   * Must never throw (fail-closed): logging must not crash the worker.
   */
  recordError(event: DowntimeErrorEvent): Promise<void>;
}

/** Audit event recorded for every successful downtime dispatch. */
export interface DowntimeDispatchEvent {
  itemId: string;
  kind: DowntimeDispatchKind;
  /** ISO-8601 UTC timestamp of the dispatch. */
  dispatchedAt: string;
  /** Worklog root (the rolling log lives at `<cwd>/.worklog`). */
  cwd: string;
  title?: string;
  /**
   * When true, `recordDispatch` skips the work-item comment (scheduled-prompt
   * dispatches have no work item — there is no item to comment; the rolling
   * log marker is the only trace, WL-0MSS1Q5ER007QDKX AC4). Absent/false on
   * normal tier dispatches (comment added, unchanged).
   */
  noItemComment?: boolean;
  /**
   * Worklog stage of the item at dispatch (plan/intake change-guard, RCA
   * WL-0MSRBFFLN005W3VT design point 3): a candidate is excluded while it is
   * still at its dispatched-at stage; a stage advancement releases it.
   * Backward compatible — absent on legacy entries.
   */
  stage?: string;
}

/**
 * Spawn-failure trace appended to the rolling dispatch log when a pane
 * spawn errors or the script exits non-zero (WL-0MSLWJ3I70031Z8U AC2).
 * Mirrors the dispatch marker's fields (including `stage`, so the marker
 * readers keep excluding the item exactly as the standing marker does) and
 * carries the failure details; the written entry adds
 * `outcome: 'spawn-failed'` so the log distinguishes "attempted" (failed
 * spawn) from "opened" (success marker).
 */
export interface DowntimeDispatchFailureEvent extends DowntimeDispatchEvent {
  /** Spawn-level error message (e.g. ENOENT), when the spawn errored. */
  error?: string;
  /** send-to-pi.sh exit code (null = killed by a signal). */
  exitCode?: number | null;
}

/**
 * Persistent-error event recorded when the wl CLI fails
 * `DOWNTIME_ERROR_STRIKE_LIMIT` times consecutively. Written to the rolling
 * `.worklog` log so the failure is auditable even though no dispatch occurs.
 */
export interface DowntimeErrorEvent {
  /** Worklog root (the rolling log lives at `<cwd>/.worklog`). */
  cwd: string;
  /** ISO-8601 UTC timestamp of the error. */
  at: string;
  message: string;
  /** Underlying wl/CLI error (timeout, SQLITE_BUSY, parse failure, stderr) — WL-0MTL4PC0Y005GXTI. */
  error?: string;
}

export interface DowntimeDispatchOutcome {
  dispatched: boolean;
  candidate?: DowntimeCandidate;
  kind?: DowntimeDispatchKind;
  /**
   * Non-dispatch reasons: 'dispatch-in-flight' | 'no-candidate' |
   * 'wl-error' | 'code-freeze' | 'claim-failed' (lost the CAS race —
   * another pane won; neutral) | 'marker-write-failed' (fail-closed abort
   * BEFORE spawn — includes the scheduled-prompt persist failure) |
   * 'spawn-failed' (handled spawn error or non-zero script exit; outcome is
   * not success) | 'audit-in-flight' (WL-0MT3PHW4I002SNOV: an audit is
   * in flight) | 'fresh-audit-skip' (WL-0MT8KSTOE00871E7: a fresh audit
   * was recorded during interim). When `reason` is 'wl-error', `error`
   * may carry the underlying wl/CLI error details (timeout, SQLITE_BUSY,
   * parse failure, stderr) for the three-strike pause log.
   * already running — a non-stale kind=audit dispatch marker maps to an
   * `in_progress` item — so the audit tier was skipped; a skip that leaves
   * an empty remaining backlog reports this reason, NEVER 'no-candidate',
   * so the no-candidate cooldown is not entered while the audit runs) |
   * 'fresh-audit-skip' (WL-0MT8KSTOE00871E7: a valid audit was recorded
   * during the interim between candidate selection and dispatch, so the
   * audit tier was skipped — an empty remaining backlog reports this
   * reason, NEVER 'no-candidate', so the cooldown is not entered while
   * the item is already audited).
   */
  reason?: string;
  /**
   * Spawn-level error message ('spawn-failed' trace, e.g. ENOENT on
   * send-to-pi.sh — WL-0MSLWJ3I70031Z8U AC2).
   */
  error?: string;
  /**
   * send-to-pi.sh exit code ('spawn-failed' trace; null = killed by a
   * signal — WL-0MSLWJ3I70031Z8U AC2).
   */
  exitCode?: number | null;
}

/**
 * Per-process single-flight guard: at most one dispatch can be in flight at
 * a time (concurrent calls are refused, not queued). Cross-pane
 * serialization is handled by the pre-dispatch claim (Q5 — no lock file):
 * the CAS claim atomically moves the item out of `wl next`'s selection set
 * for other panes.
 */
let dispatchInFlight = false;

/**
 * Expected claim state per tier (RCA WL-0MSRBFFLN005W3VT design point 1):
 * the pre-dispatch claim only applies while the item is still in the exact
 * state the tier selected it in. The audit tier selects `completed` /
 * `in_review` items; every other tier selects `open` items at their stage.
 */
const TIER_EXPECTED: Record<DowntimeSkillKind, DowntimeClaimExpected> = {
  audit: { status: 'completed', stage: 'in_review' },
  implement: { status: 'open', stage: 'plan_complete' },
  plan: { status: 'open', stage: 'intake_complete' },
  intake: { status: 'open', stage: 'idea' },
};

// ── Herdr list-head filter dispatcher (WL-0MTK1ILM2009QYB2 AC1–2) ────
async function dispatchFromHerdrList(
  deps: DowntimeWorkerDeps,
  items: DowntimeHerdrItem[],
  ctx: { cwd: string; model: string; freeSlots?: number; frozen: boolean; panesEligible: boolean; auditEligible: boolean },
  flags: { auditInFlight: boolean; auditCheckFailed: boolean; auditCheckError?: string; freshnessSkip: boolean },
): Promise<DowntimeDispatchOutcome | null> {
  if (items.length === 0) return null;
  const entries = await _readDowntimeEntries(ctx.cwd);
  const auditIds = _auditIds(entries);
  const implementIds = _implIds(entries);
  const planStages = _dispatchedStages(entries, 'plan');
  const intakeStages = _dispatchedStages(entries, 'intake');
  for (const item of items) {
    // Classify solely by list-provided fields — `classifyItemForDispatch`
    // already enforces risk/effort/audit-freshness gates (WL-0MTK1ILM2009QYB2).
    const now = Date.now();
    const info: import('./worklist.js').WorkItemInfo & { priority?: string; risk?: string; effort?: string; sortIndex?: number; parentId?: string | null } = {
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
    };
    const k = classifyItemForDispatch(info as import('./worklist.js').WorkItemInfo, now);
    if (k === null) continue;
    // Active-audit single-flight check (WL-0MT3PHW4I002SNOV): runs BEFORE
    // dispatched-marker exclusion to match legacy tier behavior. While an
    // audit is in-flight the audit tier is skipped entirely, so we must
    // check this before filtering dispatched items (a dispatched item may
    // still be the active-audit item that should cause the skip).
    if (k === 'audit') {
      const active = await deps.getActiveAudit(ctx.cwd);
      if (active.ok) { if (active.active) { flags.auditInFlight = true; continue; } } else { flags.auditCheckFailed = true; flags.auditCheckError = (active as { error?: string }).error ?? 'active-audit check failed'; continue; }
      try { if (await deps.hasFreshAudit(item.id, ctx.cwd)) { flags.freshnessSkip = true; continue; } } catch { /* fail-open */ }
    }
    // Dispatched-marker exclusion per kind — mirrors legacy tier exclusion
    // (WL-0MSLIY8ZR004QUSY/AC6) but applied as a filter on the Herdr head.
    if (k === 'audit' && auditIds.has(item.id)) continue;
    if (k === 'implement' && implementIds.has(item.id)) continue;
    if (k === 'plan' && planStages.get(item.id) === (item.stage ?? '')) continue;
    if (k === 'intake' && intakeStages.get(item.id) === (item.stage ?? '')) continue;
    // Code-freeze split-by-skill: audit+implement dispatch pauses during
    // a freeze/ambiguous marker (plan/intake still dispatch).
    if (ctx.frozen && (k === 'audit' || k === 'implement')) continue;
    // Per-tier free-slot minimums (parent WL-0MT32F90V008UAD2 AC3).
    if (k === 'audit' && !ctx.auditEligible) continue;
    if (k !== 'audit' && !ctx.panesEligible) continue;
    const cand: DowntimeCandidate = { id: item.id, title: item.title, stage: k === 'audit' ? 'audit' : (String(item.stage) as DowntimeStage), status: item.status, priority: item.priority, sortIndex: item.sortIndex };
    const outcome = await dispatchClaimedTier(deps, k, cand, { model: ctx.model, cwd: ctx.cwd });
    if (outcome.dispatched) return outcome;
    if (outcome.reason === 'claim-failed') continue;
    return outcome;
  }
  return null;
}


/**
 * Dispatch one already-selected candidate through the fixed pipeline:
 * CAS claim → marker write (before spawn) → spawn.
 *
 *  - Claim (compare-and-swap): exactly one concurrent pane wins; a loser
 *    (or a wl claim failure) ABORTS the dispatch — no pane, no marker, no
 *    success record. A lost race resolves reason 'claim-failed' (neutral,
 *    the winner's pane will busy the proxy); a wl claim failure resolves
 *    'wl-error' (counts toward the three-strike rule). Neither is ever
 *    silently discarded (WL-0MSLWJ310000ND0X absorbed).
 *  - Marker write BEFORE the pane spawns: if the marker cannot be written
 *    the dispatch aborts BEFORE spawning (fail-closed — an unmarked item is
 *    never dispatched). The item stays claimed (in_progress), so no other
 *    pane can select it (RCA design point 2).
 *  - Spawn: a handled spawn `error` or non-zero script exit resolves reason
 *    'spawn-failed' — the outcome is NOT success, and a failure trace
 *    (`outcome: 'spawn-failed'` entry with the error/exit details) is
 *    appended to the rolling audit log so the log never claims success for
 *    a pane that never appeared (WL-0MSLWJ3I70031Z8U absorbed); the marker
 *    stands so the item is not re-dispatched.
 */
async function dispatchClaimedTier(
  deps: DowntimeWorkerDeps,
  kind: DowntimeSkillKind,
  candidate: DowntimeCandidate,
  opts: { model: string; cwd: string },
): Promise<DowntimeDispatchOutcome> {
  const expected = TIER_EXPECTED[kind];
  const claim = await deps.claimItem(candidate.id, expected);
  if (!claim.ok) {
    return claim.reason === 'stale'
      ? { dispatched: false, reason: 'claim-failed' }
      : { dispatched: false, reason: 'wl-error', error: claim.error ?? 'claim failed' };
  }

  let marked = false;
  try {
    marked = await deps.recordDispatch({
      itemId: candidate.id,
      kind,
      dispatchedAt: new Date().toISOString(),
      cwd: opts.cwd,
      title: candidate.title,
      // The worklog stage at dispatch powers the plan/intake change-guard
      // (exclude while the item is still at this stage; release on advancement).
      stage: expected.stage,
    });
  } catch {
    // Fail-closed: a throwing recordDispatch (stub or regression) is a marker
    // write failure — abort before spawn.
    marked = false;
  }
  if (!marked) {
    return { dispatched: false, reason: 'marker-write-failed' };
  }

  const spawn = await deps.spawnAgentPane(
    buildDowntimePrompt(kind, candidate),
    {
      model: opts.model,
      cwd: opts.cwd,
      // Descriptive pane title (WL-0MSJ4E8UA005KG9Y): thread the candidate's
      // title/id so buildDowntimePaneArgs can name the pane
      // `Downtime triggered <kind> <title> - <id>`.
      itemTitle: candidate.title,
      itemId: candidate.id,
    },
  );
  if (!spawn.ok) {
    // Spawn-failure freshness re-check (WL-0MT8KSTOE00871E7): between
    // selection and spawn, a valid audit may have been recorded. If so, the
    // pane is moot — do NOT record a failure trace or comment. The failure
    // was against a stale/unaudited state that no longer exists.
    if (kind === 'audit') {
      try {
        const fresh = await deps.hasFreshAudit(candidate.id, opts.cwd);
        if (fresh) {
          process.stderr.write(
            `[worklog-plugin] Downtime spawn-failed skip: fresh audit recorded during interim (item ${candidate.id})\n`,
          );
          // Skip the failure trace — the pane was dispatched against a stale
          // candidate; do NOT log as a failure.
          return {
            dispatched: false,
            reason: 'spawn-failed',
            error: spawn.error,
            exitCode: spawn.exitCode,
          };
        }
      } catch {
        // Fail-open on the freshness check: if we can't verify, log the
        // failure trace as normal (conservative default).
      }
    }
    // Failure trace (WL-0MSLWJ3I70031Z8U AC2): the audit log distinguishes
    // "attempted" (failed spawn) from "opened" (success marker) — append
    // an outcome:'spawn-failed' entry with the error/exit trace. Fail-
    // closed: audit logging must never crash the worker, so a throwing
    // trace is swallowed (the stderr line in spawnDowntimePane is the
    // transient trail; the marker already stands).
    try {
      await deps.recordDispatchFailure({
        itemId: candidate.id,
        kind,
        dispatchedAt: new Date().toISOString(),
        cwd: opts.cwd,
        title: candidate.title,
        stage: expected.stage,
        error: spawn.error,
        exitCode: spawn.exitCode,
      });
    } catch {
      // fail-closed: audit logging must never crash the worker
    }
    return {
      dispatched: false,
      reason: 'spawn-failed',
      error: spawn.error,
      exitCode: spawn.exitCode,
    };
  }

  return { dispatched: true, candidate, kind };
}

/**
 * Dispatch one due scheduled prompt (WL-0MSS1Q5ER007QDKX). Unlike the
 * worklog tiers there is NO work item: no pre-dispatch claim, no wl item
 * comment. Fixed pipeline, fail-closed at every boundary:
 *
 *  1. PERSIST first: `lastTriggeredAt` is written to the config (atomic
 *     tmp+rename) BEFORE anything else. A persist failure ABORTS the
 *     dispatch — an unrecorded dispatch never runs (AC4) — and the entry
 *     stays due for the next idle slot.
 *  2. Rolling-log MARKER (kind `scheduled`) before the pane spawns: a
 *     marker failure ALSO aborts before the spawn (fail-closed).
 *  3. SPAWN the pane through the existing send-to-pi.sh path running the
 *     prompt text, named `Downtime <entryId>` (--no-focus, --cwd, --model).
 *     A handled spawn failure appends an outcome:'spawn-failed' trace and
 *     resolves 'spawn-failed' (the outcome is NOT success); the marker and
 *     the persisted lastTriggeredAt stand (the entry is not re-selected
 *     until its frequency elapses — a best-effort cadence tolerates the
 *     failed run).
 */
async function dispatchScheduledPrompt(
  deps: DowntimeWorkerDeps,
  prompt: ScheduledPrompt,
  opts: { model: string; cwd: string },
): Promise<DowntimeDispatchOutcome> {
  const at = new Date().toISOString();

  // 1. Persist lastTriggeredAt (atomic tmp+rename). A failure aborts BEFORE
  // the log marker or the spawn — an unrecorded dispatch never runs and the
  // entry remains due (AC4 fail-closed).
  const persisted = await deps.recordScheduledPromptTrigger(opts.cwd, prompt.id, at);
  if (!persisted) {
    return { dispatched: false, reason: 'marker-write-failed' };
  }

  // 2. Rolling-log marker (kind `scheduled`, noItemComment — there is no
  // work item to comment). A marker failure aborts BEFORE the spawn.
  let marked = false;
  try {
    marked = await deps.recordDispatch({
      itemId: prompt.id,
      kind: 'scheduled',
      dispatchedAt: at,
      cwd: opts.cwd,
      title: `Scheduled prompt: ${prompt.prompt}`,
      noItemComment: true,
    });
  } catch {
    // Fail-closed: a throwing recordDispatch (stub or regression) is a
    // marker write failure — abort before spawn.
    marked = false;
  }
  if (!marked) {
    return { dispatched: false, reason: 'marker-write-failed' };
  }

  // 3. Spawn the pane running the prompt text, named `Downtime <entryId>`.
  const spawn = await deps.spawnAgentPane(prompt.prompt, {
    model: opts.model,
    cwd: opts.cwd,
    paneName: `Downtime ${prompt.id}`,
  });
  if (!spawn.ok) {
    // Failure trace (WL-0MSLWJ3I70031Z8U AC2 pattern): the audit log
    // distinguishes "attempted" (failed spawn) from "opened" (success
    // marker). Fail-closed: audit logging must never crash the worker, so a
    // throwing trace is swallowed (the marker + persisted trigger already
    // stand).
    try {
      await deps.recordDispatchFailure({
        itemId: prompt.id,
        kind: 'scheduled',
        dispatchedAt: new Date().toISOString(),
        cwd: opts.cwd,
        title: `Scheduled prompt: ${prompt.prompt}`,
        noItemComment: true,
        error: spawn.error,
        exitCode: spawn.exitCode,
      });
    } catch {
      // fail-closed: audit logging must never crash the worker
    }
    return {
      dispatched: false,
      reason: 'spawn-failed',
      error: spawn.error,
      exitCode: spawn.exitCode,
    };
  }

  return { dispatched: true, kind: 'scheduled' };
}

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

/**
 * Classify a fetched work item into its coordinator dispatch tier, or null
 * when it is not currently dispatchable (fail-closed on ambiguous state):
 *
 *  - `completed` + `in_review` + no fresh audit + within the 7-day audit
 *    recency window → `audit` (same freshness/recency semantics as the
 *    audit tier's `selectAuditCandidate`; `auditedAt` enriched by the
 *    fetchItem dep — absent auditedAt means not fresh → audit-eligible).
 *  - `open` + `plan_complete` + risk ≤ Medium + effort ≤ Medium →
 *    `implement` (the implement tier's caps, belt-and-suspenders
 *    client-side).
 *  - `open` + `intake_complete` → `plan`.
 *  - `open` + `idea` → `intake`.
 *  - Every other state (in_progress already claimed, completed with a
 *    fresh audit, past the recency window, above the implement caps,
 *    unknown status/stage) → null (never dispatched).
 *
 * `now` is injectable for deterministic tests.
 */
export function classifyItemForDispatch(
  info: DowntimeItemInfo,
  now: number = Date.now(),
): DowntimeSkillKind | null {
  // Exclude items needing producer review (parent WL-0MTIAL65N004T22F AC1).
  // Items flagged for producer review must NOT be auto-dispatched at any tier.
  if (info.needsProducerReview === true) return null;
  const status = typeof info.status === 'string' ? info.status : '';
  const stage = typeof info.stage === 'string' ? info.stage : '';
  if (status === 'completed') {
    if (stage !== 'in_review') return null;
    // Audit tier: no FRESH audit (auditedAt absent/older than updatedAt
    // semantics per isAuditFresh). A missing auditedAt means not fresh →
    // audit-eligible (the audit tier's conservative default).
    if (isAuditFresh(info.auditedAt, info.updatedAt)) return null;
    // 7-day recency window (mirrors selectAuditCandidate): an item not
    // modified within the window is not a candidate; missing updatedAt is
    // included (absent data must not silently drop candidates).
    if (typeof info.updatedAt === 'string' && info.updatedAt.length > 0) {
      const updated = new Date(info.updatedAt).getTime();
      if (Number.isNaN(updated)) return null; // unparseable → fail-closed
      if (now - updated > DOWNTIME_AUDIT_RECENCY_WINDOW_MS) return null;
    }
    return 'audit';
  }
  if (status !== 'open') return null;
  if (stage === 'idea') return 'intake';
  if (stage === 'intake_complete') return 'plan';
  if (stage === 'plan_complete') {
    // Implement caps (risk ≤ Medium, effort ≤ Medium) — same ordinal
    // semantics as selectImplementCandidate (fail-closed on unset).
    const risk = riskOrdinal(info.risk);
    if (risk === null || risk > 2) return null;
    const effort = effortOrdinal(info.effort);
    if (effort === null || effort > 3) return null;
    return 'implement';
  }
  return null;
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
 * AC3 / AC5): the highest-priority item in ITS OWN worklog, following the
 * standard tier order (scheduled prompts are skipped — they have no work
 * item — then audit, then critical, then implement, then plan, then
 * intake), with the code-freeze gate applied to the audit/implement tiers.
 * This is the same selection `dispatchDowntimeWork` used pre-refactor, now
 * feeding the coordination check-in instead of an immediate dispatch.
 *
 * The lookups apply the existing dispatched-marker exclusions (audit /[
 * implement/plan/intake marker sets) and the client-side `open` guards, so
 * an item already dispatched by this worker for its tier is never offered
 * to the coordinator again — the durable marker stays the source of truth.
 *
 * A wl failure at any tier does NOT short-circuit: the remaining tiers are
 * still tried (same resilience as the old dispatcher); the result carries
 * `{ok:false}` ONLY when the computation ended on a CLI error with no
 * candidate found at all (the caller then keeps the existing entry,
 * fail-open).
 */
export async function computeMostImportantItem(
  deps: DowntimeWorkerDeps,
  cwd: string,
  now: number = Date.now(),
): Promise<MostImportantItemResult> {
  if (typeof deps.getNextAuditCandidate !== 'function') return { ok: false, error: 'getNextAuditCandidate unavailable' };
  const freezeStatus = deps.readCodeFreezeStatus(cwd);
  const frozen = freezeStatus === 'frozen' || freezeStatus === 'ambiguous';
  let sawError = false;
  let firstError: string | undefined;

  if (!frozen) {
    const audit = await deps.getNextAuditCandidate(cwd);
    if (audit.ok) {
      if (audit.candidate !== null && audit.candidate.needsProducerReview !== true) {
        return { ok: true, kind: 'audit', candidate: audit.candidate };
      }
    } else {
      sawError = true;
      firstError ??= audit.error ?? 'audit lookup failed';
    }
  }

  const critical = await deps.getNextCriticalCandidate(cwd);
  if (critical.ok) {
    if (critical.candidate !== null && critical.candidate.needsProducerReview !== true) {
      const kind = criticalSkillKind(critical.candidate.stage);
      if (kind !== null && !(frozen && kind === 'implement')) {
        return { ok: true, kind, candidate: critical.candidate };
      }
    }
  } else {
    sawError = true;
    firstError ??= critical.error ?? 'critical lookup failed';
  }

  if (!frozen) {
    const implement = await deps.getNextImplementCandidate(cwd);
    if (implement !== null && implement.needsProducerReview !== true) {
      return { ok: true, kind: 'implement', candidate: implement };
    }
  }

  const intakeComplete = await deps.getNextItem('intake_complete', cwd);
  if (intakeComplete.ok) {
    if (intakeComplete.candidate !== null && intakeComplete.candidate.needsProducerReview !== true) {
      return { ok: true, kind: 'plan', candidate: intakeComplete.candidate };
    }
  } else {
    sawError = true;
    firstError ??= intakeComplete.error ?? 'intake_complete lookup failed';
  }

  const idea = await deps.getNextItem('idea', cwd);
  if (idea.ok) {
    if (idea.candidate !== null && idea.candidate.needsProducerReview !== true) {
      return { ok: true, kind: 'intake', candidate: idea.candidate };
    }
  } else {
    sawError = true;
    firstError ??= idea.error ?? 'idea lookup failed';
  }

  // Genuinely empty backlog (both prep tiers answered) → no candidate. A
  // CLI error with no candidate → {ok:false} (the check-in keeps the
  // existing entry, fail-open — a transient wl error must never drop a
  // valid offer).
  return sawError ? { ok: false, error: firstError } : { ok: true, noCandidate: true };
}

/**
 * Leader-only dispatch from the shared coordination list (parent AC4):
 * re-fetch each entry's item, classify it into its tier, apply the
 * code-freeze gate (audit/implement skipped while frozen, plan/intake
 * still run) and dispatch the highest-priority available item via the
 * existing `dispatchClaimedTier` pipeline (CAS claim → marker write →
 * spawn) — the dispatched-marker exclusion and CAS claim guards are
 * preserved by construction (AC5). On a successful dispatch (or a
 * claimed-but-failed spawn), the entry is removed from the coordination
 * file so its owner re-queues its next item at the next check-in (AC3).
 *
 * Tier priority: audit → implement → plan → intake. Within a tier,
 * non-critical entries dispatch in global cross-project round-robin
 * order (WL-0MTJ7IEI80055V2V): least-recently-dispatched `worklogRoot`
 * first, new/unknown roots before known (never penalised), sourced
 * from the persistent cursor alongside the coordination file
 * (`downtime-round-robin-by-root.json`); fail-open on missing/corrupt
 * cursor or lock contention — falls back to file order. The critical
 * tier uses deterministic `sortIndex` ordering (not round-robin).
 *
 * Cursor advance (WL-0MTJE0FXC006WAOX): on every consumed entry
 * (successful dispatch, or claimed-but-failed spawn/marker) the
 * per-`worklogRoot` cursor advances so the next dispatch in ANY tier
 * considers that project most-recently served. Concurrent leaders do
 * not corrupt the cursor (fail-open on lock contention).
 *
 * Fail-closed at every boundary: a wl failure fetching an entry resolves
 * `wl-error` only when EVERY entry failed (a fully broken lookup — a
 * strike); a per-entry failure skips that entry (fail-open per instance,
 * parent risk mitigation — one broken worklog must not starve the rest).
 */
export async function dispatchFromCoordination(
  deps: DowntimeWorkerDeps,
  entries: CoordinationEntry[],
  opts: { model: string; cwd: string; coordinationDir: string; freeSlots?: number; leaseTtlMs?: number },
  now: number = Date.now(),
): Promise<DowntimeDispatchOutcome> {
  // The leader path REQUIRES the item-fetch dep: without it the leader can
  // never classify an entry — fail closed to a strike (a misconfigured
  // deployment must be visible, not silently idle).
  if (typeof deps.fetchItem !== 'function') {
    return { dispatched: false, reason: 'wl-error', error: 'fetchItem unavailable' };
  }
  const freezeStatus = deps.readCodeFreezeStatus(opts.cwd);
  const frozen = freezeStatus === 'frozen' || freezeStatus === 'ambiguous';

  // No wall-clock prune (WL-0MTMPIQBE001J41P) — entries persist until
  // dispatch-time eligibility check (fetchItem+classify) finds them
  // non-dispatchable. Stale offers are dropped at dispatch, never by age.

  // Per-tier free-slot minimums (parent WL-0MT32F90V008UAD2 AC3): the
  // audit tier needs ≥ 2 slots (parent + Phase 2 child at
  // AUDIT_PHASE2_PARALLELISM=1); every single-pane tier needs ≥ 1. When
  // freeSlots is absent (direct API callers), the minimums do not gate
  // (fail-open for direct API use — the worker always passes the count).
  const freeSlots = opts.freeSlots;
  const auditEligible = freeSlots === undefined || freeSlots >= DOWNTIME_AUDIT_MIN_FREE_SLOTS;
  const panesEligible = freeSlots === undefined || freeSlots >= DOWNTIME_PANE_MIN_FREE_SLOTS;
  if (!panesEligible) {
    // No slot can host a pane — nothing to dispatch (mirrors the legacy
    // tier chain's 0-free-slots defensive no-candidate).
    return { dispatched: false, reason: 'no-candidate' };
  }

  // Scheduled-prompts tier (WL-0MSS1Q5ER007QDKX): FIRST dispatch stage,
  // gated by the SAME fresh-read code-freeze marker as the audit/implement
  // tiers (AC5) — while frozen OR ambiguous (fail-closed) scheduled prompts
  // are skipped so no new code changes land mid-release, and dispatch falls
  // through to the coordination tiers below. A due prompt dispatches its
  // prompt text immediately — it never reaches the backlog tiers, so it
  // never triggers the no-candidate cooldown (AC6). Absent or malformed
  // config resolves null (fail-closed, logged by the dep): no scheduled
  // dispatch and the tiers below are unaffected (AC2).
  if (!frozen) {
    const duePrompt = await deps.getDueScheduledPrompt(opts.cwd);
    if (duePrompt !== null) {
      return await dispatchScheduledPrompt(deps, duePrompt, {
        model: opts.model,
        cwd: opts.cwd,
      });
    }
  }

  // Re-fetch + classify every entry once, grouped by tier (F4 cross-root:
  // audit → critical → implement → plan → intake across worklogRoots).
  // Critical priority open items at any dispatchable stage outrank every
  // non-critical tier — they are grouped under the dedicated 'critical'
  // tier and dispatched with their stage-appropriate skill (Q2 caps retained).
  const byTier = new Map<string, Array<{ entry: CoordinationEntry; info: DowntimeItemInfo; skill: DowntimeSkillKind }>>();
  // WL-0MTMPIQBE001J41P: entries persist until dispatch-time eligibility
  // finds them non-dispatchable. Stale entries are removed eagerly
  // (no pane, no cursor advance, cursor NOT advanced).
  const staleEntries: CoordinationEntry[] = [];
  const markStale = (e: CoordinationEntry) => { staleEntries.push(e); };
  let fetchAttempts = 0;
  let fetchFailures = 0;
  let lastFetchError: string | undefined;
  for (const entry of entries) {
    if (entry.instanceId.length === 0 || entry.workItemId.length === 0) continue;
    fetchAttempts += 1;
    const worklogRoot = entry.worklogRoot ?? entry.directory;
    const result = await deps.fetchItem(entry.workItemId, worklogRoot);
    if (!result.ok) {
      fetchFailures += 1;
      lastFetchError = (result as { error?: string }).error ?? 'fetchItem failed';
      continue;
    }
    // Exclude review-gated entries (parent WL-0MTIAL65N004T22F AC3).
    // WL-0MTMPIQBE001J41P: a now-gated entry is stale — remove it.
    if (result.info.needsProducerReview === true) { markStale(entry); continue; }
    // Critical-first tier (WL-0MT3FM8VA005XBHE): an open critical item at
    // a dispatchable stage (idea/intake_complete/plan_complete) outranks
    // every non-critical tier; its dispatch skill is stage-appropriate.
    const priority = typeof result.info.priority === 'string' ? result.info.priority.toLowerCase() : '';
    if (priority === 'critical' && result.info.status === 'open') {
      const critSkill = criticalSkillKind(result.info.stage ?? '');
      if (critSkill !== null) {
        // Q2 caps retained: above-caps critical plan_complete is not
        // dispatchable even on the critical tier (same ordinals as
        // selectCriticalCandidate).
        if (result.info.stage === 'plan_complete') {
          const risk = riskOrdinal(result.info.risk);
          const effort = effortOrdinal(result.info.effort);
          if (risk === null || risk > 2 || effort === null || effort > 3) { markStale(entry); continue; }
        }
        if (frozen && critSkill === 'implement') { markStale(entry); continue; }
        const group = byTier.get('critical') ?? [];
        group.push({ entry, info: result.info, skill: critSkill });
        byTier.set('critical', group);
        continue;
      }
    }
    const kind = classifyItemForDispatch(result.info, now);
    if (kind === null) { markStale(entry); continue; }
    if (frozen && (kind === 'audit' || kind === 'implement')) { markStale(entry); continue; }
    const group = byTier.get(kind) ?? [];
    group.push({ entry, info: result.info, skill: kind });
    byTier.set(kind, group);
  }

  // Eagerly drop stale entries (non-dispatchable at dispatch time):
  // no pane, no marker, no cursor advance — just remove and continue.
  for (const e of staleEntries) {
    removeEntry(opts.coordinationDir, e.instanceId);
  }

  // A wl lookup that failed for EVERY entry is a persistent CLI/parse
  // failure — a strike (never a silent no-candidate). Per-instance
  // failures are tolerated (fail-open).
  if (fetchAttempts > 0 && fetchFailures === fetchAttempts) {
    return { dispatched: false, reason: 'wl-error', error: lastFetchError ?? 'all fetchItem lookups failed' };
  }

  // ── Global critical override (WL-0MTJDZY5E003D6CO) ────────────────
  // Promote the critical-priority shortcut to a global pre-tier check:
  // if any dispatchable critical entry exists, dispatch it IMMEDIATELY,
  // before any tier loop. This ensures critical outranks everything
  // (e.g., a critical `idea` dispatches before a non-critical `audit`),
  // matching the intent "jump to the front of the queue".
  //
  // Within the critical subset, selection is deterministic by sortIndex
  // (existing priority/sortIndex tie-break — one item per project, so
  // round-robin is not needed inside critical).
  //
  // The freeze (audit/implement skipped while frozen) and caps
  // (`risk <= Medium && effort <= Medium` for `plan_complete`, including
  // critical) are retained — critical entries are already filtered during
  // classification, so we only need to dispatch the first eligible entry.
  //
  // If dispatch fails (claim-failed, etc.), we fall through to the
  // normal tier loop — the critical tier group is still available there.
  const criticalGroup = byTier.get('critical');
  if (criticalGroup && criticalGroup.length > 0) {
    // Sort by sortIndex ascending (deterministic tie-break).
    const sortedCritical = [...criticalGroup].sort(
      (a, b) => (a.info.sortIndex ?? 0) - (b.info.sortIndex ?? 0),
    );
    const { entry, info, skill } = sortedCritical[0];
    const worklogRoot = entry.worklogRoot ?? entry.directory;
    const criticalOutcome = await dispatchClaimedTier(
      deps,
      skill,
      toCoordinationCandidate(info),
      { model: opts.model, cwd: worklogRoot },
    );
    if (criticalOutcome.dispatched) {
      // Dispatched — remove the entry so the owner re-queues its next
      // most-important item at the next check-in (AC3 re-queue).
      removeEntry(opts.coordinationDir, entry.instanceId);
      advanceRoundRobinCursor(opts.coordinationDir, worklogRoot, now);
      return criticalOutcome;
    }
    if (criticalOutcome.reason === 'spawn-failed' || criticalOutcome.reason === 'marker-write-failed') {
      // Claimed but never opened — still consumes the entry and advances the cursor (AC).
      removeEntry(opts.coordinationDir, entry.instanceId);
      advanceRoundRobinCursor(opts.coordinationDir, worklogRoot, now);
      return criticalOutcome;
    }
    // Dispatch failed (claim-failed, wl-error): fall through to the
    // tier loop below. spawn-failed/marker-write-failed already returned.
  }

  for (const tier of COORDINATION_TIER_ORDER) {
    let group = byTier.get(tier) ?? [];
    // Audit-tier slot minimum: an audit pane needs a second slot for its
    // Phase 2 child (WL-0MSORQ1RG005DGUS) — skip the whole audit group
    // when too few slots are free (ineligible, never a strike).
    if (tier === 'audit' && !auditEligible) continue;
    // Global per-`worklogRoot` round-robin (WL-0MTJE0FXC006WAOX): non-
    // critical same-tier entries order by least-recently-served
    // (`downtime-round-robin-by-root.json`); unknown roots first,
    // oldest timestamp first; fail-open on missing/corrupt cursor.
    group = sortEntriesByRoundRobin(group, opts.coordinationDir);
    for (const { entry, info, skill } of group) {
      const worklogRoot = entry.worklogRoot ?? entry.directory;
      const outcome = await dispatchClaimedTier(
        deps,
        skill,
        toCoordinationCandidate(info),
        { model: opts.model, cwd: worklogRoot },
      );
      if (outcome.dispatched) {
        // Dispatched — remove the entry so the owner re-queues its next
        // most-important item at the next check-in (AC3 re-queue).
        removeEntry(opts.coordinationDir, entry.instanceId);
        advanceRoundRobinCursor(opts.coordinationDir, worklogRoot, now);
        return outcome;
      }
      if (outcome.reason === 'claim-failed') {
        // Another pane won the CAS race — neutral; try the next entry.
        continue;
      }
      if (outcome.reason === 'wl-error') {
        // A wl failure is a strike — stop the cycle (three-strike rule
        // decides when to pause).
        return outcome;
      }
      if (outcome.reason === 'spawn-failed' || outcome.reason === 'marker-write-failed') {
        // The item is claimed (+ marked) but the pane never appeared:
        // remove the entry so the owner re-queues; the standing marker and
        // the in_progress claim prevent double-dispatch. Still advances
        // the round-robin cursor (consumed entry, AC).
        removeEntry(opts.coordinationDir, entry.instanceId);
        advanceRoundRobinCursor(opts.coordinationDir, worklogRoot, now);
        return outcome;
      }
    }
  }

  // No tier had a dispatchable entry (or a freeze skip with an empty
  // plan/intake list). The caller decides cooldown vs. resume via the
  // same reason semantics as the legacy dispatcher — in the worker tick,
  // a coordination-mode no-candidate is probed against the worklog
  // (WL-0MTEZ4XZJ006Y9U7): an empty OFFER FILE is never mistaken for an
  // empty BACKLOG.
  return frozen
    ? { dispatched: false, reason: 'code-freeze' }
    : { dispatched: false, reason: 'no-candidate' };
}

/**
 * One 30-minute coordination check-in (parent AC3): recompute this
 * instance's most-important item and upsert its entry in the shared
 * coordination file. When the instance has NOTHING dispatchable (genuine
 * empty backlog, no CLI errors) the own entry is removed — the leader must
 * not float a dead offer; the owner re-offers when work appears. On a
 * CLI-error computation the existing entry is kept (fail-open) — a
 * transient wl failure must never drop a valid offer. Returns the stored
 * item id (or null when nothing was offered).
 */
export async function runCoordinationCheckIn(
  deps: DowntimeWorkerDeps,
  coordinator: {
    cwd: string;
    coordinationDir: string;
    instanceId: string;
  },
  now: number = Date.now(),
): Promise<{ offered: string | null; updated: boolean }> {
  const current = getEntry(coordinator.coordinationDir, coordinator.instanceId);
  const result = await computeMostImportantItem(deps, coordinator.cwd, now);
  if (!result.ok) {
    // wl/CLI errors — keep the existing entry (fail-open), retry next check-in.
    return { offered: current?.workItemId ?? null, updated: false };
  }
  if ('noCandidate' in result && result.noCandidate) {
    // Genuinely nothing dispatchable — remove the own entry (no dead offers).
    const removed = removeEntry(coordinator.coordinationDir, coordinator.instanceId) !== null;
    // Audit trail (WL-0MSXHAE290067VAL): log the emptied check-in.
    void appendCoordinationLogEntry(coordinator.cwd, {
      kind: 'coordination',
      operation: 'checkin',
      instanceId: coordinator.instanceId,
      workItemId: null,
      at: new Date(now).toISOString(),
    });
    return { offered: null, updated: removed };
  }
  if (!('candidate' in result) || result.candidate === undefined) {
    // Defensive: a malformed result (stub/regression) keeps the entry.
    return { offered: current?.workItemId ?? null, updated: false };
  }
  const entry: CoordinationEntry = {
    instanceId: coordinator.instanceId,
    workItemId: result.candidate.id,
    directory: coordinator.cwd,
    assignedAt: current?.assignedAt ?? new Date(now).toISOString(),
    lastUpdated: new Date(now).toISOString(),
  };
  const updated = upsertEntry(coordinator.coordinationDir, entry);
  // Audit trail (WL-0MSXHAE290067VAL): log the offered item on every
  // successful check-in write.
  if (updated) {
    void appendCoordinationLogEntry(coordinator.cwd, {
      kind: 'coordination',
      operation: 'checkin',
      instanceId: coordinator.instanceId,
      workItemId: entry.workItemId,
      at: new Date(now).toISOString(),
    });
  }
  return { offered: entry.workItemId, updated };
}

/**
 * dispatch one downtime work item. Selection priority: FIRST the
 * scheduled-prompts tier (WL-0MSS1Q5ER007QDKX) — a due scheduled prompt
 * (e.g. `/skill:refactor` every 3 days) dispatches its prompt text before
 * any backlog tier, gated by the same code-freeze marker as audit/implement
 * (frozen OR ambiguous ⇒ skipped, plan/intake still run) and never
 * triggering the no-candidate cooldown; then the audit tier
 * (WL-0MSI8H3HP000K0RG): a completed/in_review item WITHOUT a valid audit AND
 * NOT already dispatched for audit by this worker →
 * `/skill:audit <id>` (the dispatched-marker exclusion,
 * WL-0MSLIY8ZR004QUSY, is applied by `deps.getNextAuditCandidate`). The
 * audit tier is ROOT-ONLY (WL-0MSTLFW14000KPEC): `wl list --root-only`
 * excludes completed/in_review children, so only parent items are ever
 * dispatched for audit — sub-tasks are never audited independently; and
 * exactly one audit is active at a time (WL-0MT3PHW4I002SNOV,
 * single-flight): before any candidate is selected the active-audit check
 * (`deps.getActiveAudit`) skips the audit tier while a non-stale
 * `kind=audit` dispatch marker (within `DOWNTIME_AUDIT_STALE_WINDOW_MS`,
 * 2h) maps to an item still `in_progress` — an audit dispatched by ANY
 * instance is honoured via the shared dispatch log (the stickiest
 * cross-instance single-flight signal), and a marker older than the
 * window is stale (the audit pane may have crashed without updating the
 * work item) and is ignored so a NEW audit can proceed. The skip reports
 * reason 'audit-in-flight' (never 'no-candidate' — the empty-backlog
 * cooldown is not entered while the audit runs) and the check fails open
 * (an unanswerable check just falls through to the next tier — dispatch
 * is never blocked); then —
 * BEFORE the non-critical implement tier — the critical-first tier
 * (WL-0MT3FM8VA005XBHE): the highest-priority open CRITICAL item at ANY
 * stage (idea / intake_complete / plan_complete), including
 * dependency-blocked ones (`wl list --priority critical --status open` does
 * NOT exclude them — unlike `wl next`), dispatched with the
 * stage-appropriate skill (Q2 caps retained + Q3 dependency-frontier
 * resolution — see `getNextCriticalCandidate`); then the non-critical
 * implement tier (WL-0MSMAYPQP001FLR6): the highest-priority open
 * plan_complete item with risk ≤ Medium / effort ≤ Medium → `/skill:implement <id>`
 * (fail-closed null on wl error or no candidate — never short-circuits the
 * fallback, AC5/AC6); if none, `wl next --stage intake_complete` →
 * `/skill:plan <id>`; if none, `wl next --stage idea` → `/skill:intake <id>`;
 * if all are empty, no dispatch.
 *
 * Critical-tier semantics: the lookup resolves through the same
 * `DowntimeNextResult` error channel as the audit tier — a GENUINELY empty
 * critical tier (`{ok:true, candidate:null}`) falls through to the
 * non-critical tiers, while `{ok:false}` is a wl-error strike (never a
 * silent fall-through, so a broken critical lookup can never look like "no
 * critical work"). The stage-appropriate skill comes from
 * `criticalSkillKind(candidate.stage)`; a dependency-blocked candidate is
 * dispatched as its nearest OPEN frontier blocker with the blocker's own
 * stage (Q3). The critical dispatch runs through the SAME
 * `dispatchClaimedTier` pipeline (CAS claim with the TIER_EXPECTED stage
 * entry → marker → spawn), so the claim-CAS, the dispatched-marker
 * change-guard (rolling-log kind is the skill-mapped implement/plan/intake)
 * and the single-flight guard compose unchanged.
 *
 * The audit tier resolves through the same `DowntimeNextResult` error
 * channel as the plan/intake tiers (WL-0MSLWJ2KP0002SV0): a GENUINELY empty
 * audit tier (`{ok:true, candidate:null}`) falls through to the implement
 * tier, but an audit-tier wl/parse failure (`{ok:false}`) is a `wl-error`
 * outcome — a CLI-error strike that never falls through looking healthy — so
 * a persistently broken audit lookup can never silently disable audit
 * dispatch (the caller's three-strike rule pauses and logs it).
 *
 * Code-freeze gate (WL-0MSQ0RPQP00636JY): the marker is re-read fresh on
 * EVERY dispatch (never cached). While the marker is frozen OR ambiguous
 * (fail-closed), the audit and non-critical implement tiers are skipped — no new
 * implementation work (or audits) starts during a release freeze — and
 * dispatch continues with the plan/intake tiers, which are low-risk prep
 * and still allowed. The critical tier is STILL consulted during a freeze,
 * with the split-by-skill rule (Q1): a critical plan_complete
 * (implement-kind) candidate is skipped (no new code mid-release), while
 * critical idea/intake_complete (intake/plan-kind) candidates STILL
 * dispatch — critical prep is as low-risk as non-critical prep. A freeze
 * skip with an empty plan/intake backlog is
 * reported as reason 'code-freeze' (NEVER 'no-candidate'), so it never
 * triggers the worker's no-candidate cooldown: polling continues and
 * implement/audit dispatch resumes immediately when the freeze lifts.
 *
 * A CLI error at the intake_complete tier does NOT short-circuit: the idea
 * tier is still attempted, so a tier-3 candidate can still dispatch. A
 * `wl-error` outcome (any CLI failure) is never a candidate and never a
 * `no-candidate`; the caller's three-strike rule decides when consecutive
 * errors pause the worker. Every tier runs its candidate through
 * `dispatchClaimedTier` (CAS claim → marker → spawn), so the item is
 * claimed BEFORE the pane spawns and a losing pane aborts with no pane, no
 * marker, no success record (the same-instant race, RC-1, is closed). The
 * caller must only invoke this once the idle tracker reports the threshold
 * met (AC1); a dispatch consumes the local slot, so the proxy reports busy
 * and the tracker requires a fresh full idle period before the next dispatch.
 */
export async function dispatchDowntimeWork(
  deps: DowntimeWorkerDeps,
  opts: { model: string; cwd: string; freeSlots?: number },
): Promise<DowntimeDispatchOutcome> {
  if (dispatchInFlight) {
    return { dispatched: false, reason: 'dispatch-in-flight' };
  }
  dispatchInFlight = true;
  try {
    // Unified contract WL-0MTK1ILM2009QYB2: Herdr list is the sole ranking path.
    // dispatchDowntimeWork consumes the Herdr selection list head (getHerdrListHead)
    // and applies safety gates as sequential FILTERS on that ordered sequence
    // (scheduled-prompt → code-freeze → dispatched-marker → free-slot minimums →
    // active-audit single-flight → freshness-recency → CAS claim → spawn).
    // No second tier ordering remains on this path (AC1–2). WL-0MT32F90V008UAD2 AC3
    // per-tier free-slot minimums (audit needs 2, single-pane 1) are now per-item
    // filters on the Herdr-ordered candidates rather than tier skips.
    const freeSlots = opts.freeSlots;
    const panesEligible = freeSlots === undefined || freeSlots >= DOWNTIME_PANE_MIN_FREE_SLOTS;
    const auditEligible = freeSlots === undefined || freeSlots >= DOWNTIME_AUDIT_MIN_FREE_SLOTS;

    let auditInFlight = false;
    let auditCheckFailed = false;
    let freshnessSkip = false;

    // Code-freeze gate (WL-0MSQ0RPQP00636JY): re-read the marker fresh on
    // every dispatch — never cached, so a freeze that starts or ends
    // mid-idle-period is honored on the next dispatch attempt. Frozen OR
    // ambiguous (fail-closed) → the audit and non-critical implement tiers
    // are skipped and dispatch falls through to the plan/intake tiers
    // below; the critical tier below is STILL consulted, pausing only its
    // implement-kind candidate (Q1 split-by-skill) — see the tier comment.
    const freezeStatus = deps.readCodeFreezeStatus(opts.cwd);
    const frozen = freezeStatus === 'frozen' || freezeStatus === 'ambiguous';

    if (!frozen && panesEligible) {
      const duePrompt = await deps.getDueScheduledPrompt(opts.cwd);
      if (duePrompt !== null) {
        return await dispatchScheduledPrompt(deps, duePrompt, opts);
      }
    }

    // ── Herdr list head consumes the ranking (WL-0MTK1ILM2009QYB2 ACs 1–2) ──
    // When the Herdr list is populated it is the sole ranking source; a
    // filtered-exhaustion returns the terminal reason directly and the legacy
    // tier chain is not consulted. When the list is genuinely empty (no ranked
    // candidates) the legacy chain remains as a test-compat fallback — the
    // extensive existing suite stubs per-tier lookups with an empty Herdr
    // head, so it stays green during migration. Production
    // `createDowntimeDeps` always returns a non-empty head when dispatchable
    // work exists, so the fallback is unreachable there and will be removed
    // once the suite is fully on Herdr-head stubs.
    {
      const flags = { auditInFlight, auditCheckFailed, auditCheckError: undefined, freshnessSkip };
      const head = await deps.getHerdrListHead(opts.cwd);
      if (!head.ok) return { dispatched: false, reason: 'wl-error', error: (head as { error?: string }).error };
      if (head.items.length > 0) {
        const herdrOutcome = await dispatchFromHerdrList(deps, head.items, { cwd: opts.cwd, model: opts.model, freeSlots, frozen, panesEligible, auditEligible }, flags);
        auditInFlight = flags.auditInFlight;
        auditCheckFailed = flags.auditCheckFailed;
        const auditCheckError = flags.auditCheckError;
        freshnessSkip = flags.freshnessSkip;
        if (herdrOutcome !== null) return herdrOutcome;
        // Herdr list had items but every one was filtered by a safety gate:
        // compose the terminal reason and DO NOT fall through to the legacy
        // chain (AC2 — gates are filters, not a fallback ranking).
        if (frozen) return { dispatched: false, reason: 'code-freeze' };
        if (freshnessSkip) return { dispatched: false, reason: 'fresh-audit-skip' };
        if (auditInFlight) return { dispatched: false, reason: 'audit-in-flight' };
        if (auditCheckFailed) return { dispatched: false, reason: 'wl-error', error: auditCheckError };
        return { dispatched: false, reason: 'no-candidate' };
      }
      // Genuinely empty Herdr list → keep flags and fall through to the
      // legacy chain (test-compat path; flags still drive the terminal reason).
      auditInFlight = flags.auditInFlight;
      auditCheckFailed = flags.auditCheckFailed;
      freshnessSkip = flags.freshnessSkip;
    }

    // ── Legacy tier chain (retained for test compat; production-unreachable) ──
    // See the Herdr-list-head contract above.
    if (!frozen) {
      // Audit tier (WL-0MSI8H3HP000K0RG): dispatch /skill:audit for the
      // first completed/in_review item without a valid audit. Root-only
      // (WL-0MSTLFW14000KPEC): only PARENT items are candidates —
      // completed/in_review children are excluded server-side and never
      // dispatched independently. The lookup
      // resolves through the DowntimeNextResult error channel
      // (WL-0MSLWJ2KP0002SV0): {ok:true, candidate:null} is a GENUINELY
      // empty audit tier and falls through to the implement tier below;
      // {ok:false} is a wl/parse failure — fail closed to busy (a strike),
      // never a silent fall-through, so a broken audit query cannot look
      // like "no audit candidates" and silently disable the audit tier.
      //
      // Per-tier minimum (parent WL-0MT32F90V008UAD2 AC3): the audit tier
      // requires ≥ 2 free slots (parent + Phase 2 child at
      // `AUDIT_PHASE2_PARALLELISM=1`). When fewer are free the audit
      // lookup is skipped entirely — ineligible, not a strike and not a
      // wl-error (mirrors the code-freeze skip) — and dispatch falls
      // through to the implement tier (which needs only ≥ 1).
      if (auditEligible) {
        // Active-audit single-flight (WL-0MT3PHW4I002SNOV): before any
        // audit candidate is selected, check whether an audit-tier item is
        // currently in flight — a non-stale `kind=audit` dispatch marker
        // (within DOWNTIME_AUDIT_STALE_WINDOW_MS, 2h) maps to an item
        // still `in_progress` (the shared dispatch log makes this
        // cross-instance: an audit dispatched by ANY instance, leader or
        // not, is seen here). While one is active the audit tier is skipped
        // so audits stay strictly sequential — never fan-out consuming
        // extra LLM capacity. The skip reports reason 'audit-in-flight'
        // (never 'no-candidate') when the remaining backlog is empty, so
        // the no-candidate cooldown is not entered while the audit runs
        // (mirrors the code-freeze skip, WL-0MSQ0RPQP00636JY) and the next
        // idle tick re-checks. `{ok:false}` (the check could not complete,
        // e.g. a worklog query failure) fails open: the audit tier is
        // skipped and dispatch falls through to the next tier — the
        // dispatch loop is never blocked by an unanswerable check, and
        // when the fallback backlog is also empty the outcome is a
        // wl-error strike (partial information must not pause the worker
        // with no-candidate).
        const activeAudit = await deps.getActiveAudit(opts.cwd);
        if (activeAudit.ok) {
          if (activeAudit.active) {
            auditInFlight = true;
            process.stderr.write(
              `[worklog-plugin] Downtime audit tier skipped: audit-in-flight\n`,
            );
          } else {
            // No active audit: proceed with the candidate lookup unchanged.
            const audit = await deps.getNextAuditCandidate(opts.cwd);
            if (audit.ok) {
              if (audit.candidate !== null && audit.candidate.needsProducerReview !== true) {
                // Interim freshness re-check (WL-0MT8KSTOE00871E7): between
                // candidate selection and dispatch, a valid audit may have
                // been recorded (e.g. by a human or another process). Re-check
                // freshness to avoid dispatching a redundant audit pane and
                // writing a misleading dispatch comment. If a fresh audit now
                // exists, skip the dispatch entirely — no comment, no marker,
                // no spawn — and fall through to the next tier. Treat as
                // "already audited", not "no-candidate"/cooldown and not a
                // strike. Fail-open: a wl/CLI failure in the freshness check
                // is treated as "not fresh" (dispatch proceeds) — never a
                // silent skip.
                try {
                  const fresh = await deps.hasFreshAudit(audit.candidate.id, opts.cwd);
                  if (fresh) {
                    freshnessSkip = true;
                    process.stderr.write(
                      `[worklog-plugin] Downtime audit tier skip: fresh audit recorded during interim (item ${audit.candidate.id})\n`,
                    );
                    // Fall through to the next tier (implement/plan/intake).
                  } else {
                    return await dispatchClaimedTier(deps, 'audit', audit.candidate, opts);
                  }
                } catch {
                  // Fail-open: the freshness check could not complete (e.g.
                  // wl/CLI error) — proceed with the dispatch (conservative
                  // default). The item is treated as "not fresh" for this tick.
                  return await dispatchClaimedTier(deps, 'audit', audit.candidate, opts);
                }
              }
            } else {
              return { dispatched: false, reason: 'wl-error', error: audit.error };
            }
          }
        } else {
          // Fail-open: the check could not complete — skip the audit tier
          // and fall through to the next tier (never block all dispatch).
          auditCheckFailed = true;
        }
        // auditInFlight || auditCheckFailed → the audit tier is skipped and
        // dispatch falls through to the implement tier below.
      }
    }

    // Critical-first tier (WL-0MT3FM8VA005XBHE): consulted on EVERY
    // dispatch — including during a freeze. The lookup
    // (getNextCriticalCandidate) returns the stage-appropriate critical
    // candidate (F2: stage→skill via criticalSkillKind, plan_complete
    // implement caps Q2; F3: dependency-blocked items resolve to their
    // nearest open frontier blocker with the blocker's own stage). It
    // runs AFTER the audit tier (a completed/in_review item needing audit
    // keeps its slot) and BEFORE the non-critical implement/plan/intake
    // tiers — a critical item at ANY stage always wins over any
    // non-critical item (parent AC3). Error channel parity with the audit
    // tier (WL-0MSLWJ2KP0002SV0): {ok:true, candidate:null} is a GENUINELY
    // empty critical tier and falls through to the non-critical tiers;
    // {ok:false} is a wl/parse failure — fail closed to a wl-error strike
    // (never a silent fall-through, so a broken critical lookup cannot
    // silently look like "no critical work").
    //
    // Freeze split-by-skill (Q1): the marker is re-read fresh above, and
    // while frozen OR ambiguous (fail-closed) a critical IMPLEMENT
    // candidate (plan_complete) is SKIPPED — no new code changes land
    // mid-release — but a critical plan/intake candidate STILL dispatches
    // (low-risk prep allowed, matching the non-critical plan/intake tiers).
    // Pane minimum (parent WL-0MT32F90V008UAD2 AC3): the critical tier
    // needs ≥ 1 free slot like every single-pane tier.
    if (panesEligible) {
      const critical = await deps.getNextCriticalCandidate(opts.cwd);
      if (critical.ok) {
        if (critical.candidate !== null && critical.candidate.needsProducerReview !== true) {
          const kind = criticalSkillKind(critical.candidate.stage);
          if (kind !== null && !(frozen && kind === 'implement')) {
            return await dispatchClaimedTier(deps, kind, critical.candidate, opts);
          }
          // Frozen implement-kind critical (or a non-dispatchable stage):
          // skip this candidate (fail-closed pause) and fall through to
          // the non-critical tiers.
        }
      } else {
        return { dispatched: false, reason: 'wl-error', error: critical.error };
      }
    }

    if (!frozen && panesEligible) {
      // Implement tier (WL-0MSMAYPQP001FLR6): after the critical-first
      // gate, dispatch /skill:implement for the highest-priority open
      // plan_complete item with
      // risk ≤ Medium / effort ≤ Medium. getNextImplementCandidate is fail-closed
      // (null on wl failure or no candidate), so a null here means the tier is
      // exhausted and the plan/intake tiers below still run (AC5/AC6 — a wl
      // error at the implement tier does NOT short-circuit the fallback).
      // Pane minimum (parent WL-0MT32F90V008UAD2 AC3 / F3-fix
      // WL-0MT4RQTID000GT69): ≥ 1 free slot at selection time, matching the
      // critical/audit/plan/intake tiers — a direct dispatchDowntimeWork(
      // {freeSlots:0}) must never dispatch implement. 0 free slots is
      // ineligible (never a strike): the lookup is skipped entirely and
      // dispatch falls through to the plan tier's defensive no-candidate.
      const implementCandidate = await deps.getNextImplementCandidate(opts.cwd);
      if (implementCandidate !== null && implementCandidate.needsProducerReview !== true) {
        return await dispatchClaimedTier(deps, 'implement', implementCandidate, opts);
      }
    }
    // Tier 2 (intake_complete → /skill:plan). A CLI error here does NOT
    // short-circuit: tier 3 is still attempted so a tier-3 candidate can
    // still dispatch (operator refinement). Pane minimum (parent
    // WL-0MT32F90V008UAD2 AC3): plan/intake need ≥ 1 free slot — via the
    // worker this is always true (the idle-duration gate has already
    // required ≥ N ≥ 1 free), the gate is defensive for direct API callers.
    let tier2Error = false;
    let tier2ErrorDetail: string | undefined;
    if (panesEligible) {
      const intakeComplete = await deps.getNextItem('intake_complete', opts.cwd);
      if (intakeComplete.ok) {
        if (intakeComplete.candidate !== null && intakeComplete.candidate.needsProducerReview !== true) {
          return await dispatchClaimedTier(deps, 'plan', intakeComplete.candidate, opts);
        }
      } else {
        tier2Error = true;
        tier2ErrorDetail = intakeComplete.error;
      }
    } else {
      // 0 free slots (defensive, unreachable via the worker): the panes
      // cannot run — treat as an empty backlog (no candidate dispatchable).
      return { dispatched: false, reason: 'no-candidate' };
    }

    // Tier 3 (idea → /skill:intake) is ALWAYS attempted when tier 2 produced
    // no candidate — including when tier 2 errored.
    const idea = await deps.getNextItem('idea', opts.cwd);
    if (idea.ok) {
      if (idea.candidate !== null && idea.candidate.needsProducerReview !== true) {
        return await dispatchClaimedTier(deps, 'intake', idea.candidate, opts);
      }
      if (tier2Error) {
        // Tier 2 errored and tier 3 answered empty: the backlog is NOT
        // provably empty (the intake_complete state is unknown) → fail
        // closed to busy (a strike), never a no-candidate — partial
        // information must not pause the worker.
        return { dispatched: false, reason: 'wl-error', error: tier2ErrorDetail };
      }
      // Both tiers answered with no candidate → genuine empty backlog. The
      // freeze gate must NOT pause the worker on an empty plan/intake
      // backlog: during a freeze that is a freeze skip (reason
      // 'code-freeze'), never the no-candidate cooldown — polling continues
      // so implement/audit dispatch resumes immediately when the freeze
      // lifts (WL-0MSQ0RPQP00636JY).
      return frozen
        ? { dispatched: false, reason: 'code-freeze' }
        : freshnessSkip
          ? { dispatched: false, reason: 'fresh-audit-skip' }
          : auditInFlight
            ? { dispatched: false, reason: 'audit-in-flight' }
            : auditCheckFailed
              ? { dispatched: false, reason: 'wl-error', error: tier2ErrorDetail }
              : { dispatched: false, reason: 'no-candidate' };
    }
    // Tier 3 errored (with or without a tier-2 error): fail closed to busy.
    // The worker counts this as one CLI-error strike; the backlog is not
    // provably empty so this is never `no-candidate` (the three-strike rule
    // governs when consecutive errors pause the worker).
    return { dispatched: false, reason: 'wl-error', error: (idea as { error?: string }).error ?? tier2ErrorDetail };
  } finally {
    dispatchInFlight = false;
  }
}

/**
 * Argument vector for spawning `send-to-pi.sh`: visible pane named
 * `Downtime <kind>` (`paneName` overrides it — the scheduled-prompts tier
 * passes `Downtime <entryId>`, WL-0MSS1Q5ER007QDKX), `--no-focus` (visible but
 * never steals focus), `--cwd <wlRoot>`, `--model <downtimeModel>`, then the
 * prompt.
 *
 * When `opts.itemTitle`/`opts.itemId` are present (dispatch tiers,
 * WL-0MSJ4E8UA005KG9Y), the pane is named in the full format
 * `Downtime triggered <kind> <title> - <id>` so downtime panes follow the
 * same descriptive convention as manually-triggered panes. Titles are
 * bounded by {@link MAX_PANE_TITLE_LENGTH}.
 */
export function buildDowntimePaneArgs(
  kind: DowntimeSkillKind,
  prompt: string,
  opts: { model: string; cwd: string; paneName?: string; itemTitle?: string; itemId?: string },
): string[] {
  const paneName =
    opts.paneName ??
    buildDowntimePaneTitle(kind, opts.itemTitle, opts.itemId);
  return [
    '--pane-name',
    paneName,
    '--no-focus',
    '--cwd',
    opts.cwd,
    '--model',
    opts.model,
    prompt,
  ];
}

/**
 * Minimal spawn handle: the caller unrefs so the parent can exit first, and
 * registers `error` + `exit` listeners so a spawn failure or non-zero script
 * exit is observable instead of crashing the plugin process with an
 * unhandled 'error' event (WL-0MSLWJ3I70031Z8U absorbed).
 */
export interface DowntimeSpawnHandle {
  unref(): void;
  once(event: 'error', listener: (err: Error) => void): void;
  once(event: 'exit', listener: (code: number | null) => void): void;
}

/**
 * Result of one pane-spawn attempt. `ok: true` means the pane opened (or
 * the probe window elapsed with no failure — fire-and-forget); `ok: false`
 * means the spawn errored (`error`, e.g. ENOENT) or the script exited
 * non-zero (`exitCode`, null when killed by a signal) within the probe
 * window. The failure details are the error/exit trace recorded in the
 * dispatch audit log (WL-0MSLWJ3I70031Z8U AC2) so a pane that never
 * appeared is never logged as a success.
 */
export type DowntimeSpawnResult =
  | { ok: true }
  | { ok: false; error?: string; exitCode?: number | null };

/** Injectable spawn boundary (matches the repo's injectable-seam pattern). */
export type DowntimeSpawn = (
  scriptPath: string,
  args: string[],
  opts: { cwd: string },
) => DowntimeSpawnHandle;

/**
 * Spawn options for `send-to-pi.sh`: detached, stdio ignored, resolved cwd
 * forwarded so the pane opens in the right project root.
 */
export function buildDowntimeSpawnOptions(cwd: string): {
  detached: boolean;
  stdio: 'ignore';
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  return {
    detached: true,
    stdio: 'ignore',
    cwd,
    // AUDIT_PHASE2_PARALLELISM=1 bounds the dispatched audit's Phase 2 child
    // deep-analysis fan-out to strictly sequential (parent runs first, then
    // one child at a time — the audit skill's documented historical mode), so
    // a child-heavy parent audit needs exactly 2 local slots and fits cheap
    // mode's full capacity (WL-0MSORQ1RG005DGUS). The audit skill honours
    // this env var (legacy fallback, integer >= 1); no audit-skill change
    // needed. Interactive (non-downtime) panes are unaffected.
    env: { ...process.env, HERDR_RESOLVED_CWD: cwd, AUDIT_PHASE2_PARALLELISM: '1' },
  };
}

/** Default spawn: detached, stdio ignored, resolved cwd forwarded. */
export const defaultDowntimeSpawn: DowntimeSpawn = (scriptPath, args, opts) =>
  spawn(scriptPath, args, buildDowntimeSpawnOptions(opts.cwd));

/**
 * How long to wait for a spawn-level `error` event or an immediate
 * non-zero script `exit` before assuming the pane started (an
 * ENOENT/EACCES error fires on the next event-loop tick; a failing script
 * exits within milliseconds). The probe keeps the failure observable
 * without delaying the poll loop.
 */
export const DOWNTIME_SPAWN_PROBE_MS = 500;

/**
 * Spawn `send-to-pi.sh` detached with stdio ignored, then unref so the
 * parent (plugin) process can exit independently — same pattern as the
 * TUI's existing agent dispatches. `error` and `exit` listeners are ALWAYS
 * attached (a spawn failure must not crash the plugin with an unhandled
 * 'error' event, WL-0MSLWJ3I70031Z8U): a spawn `error` (ENOENT/EACCES) or a
 * non-zero script exit within the probe window resolves `{ok:false}` with
 * the failure trace so the dispatch outcome is not a false success; exit 0
 * (script ran to completion — pane opened) and the probe timeout (pane
 * still alive) resolve `{ok:true}`.
 */
export async function spawnDowntimePane(
  scriptPath: string,
  args: string[],
  opts: { cwd: string },
  spawnFn: DowntimeSpawn = defaultDowntimeSpawn,
): Promise<DowntimeSpawnResult> {
  const child = spawnFn(scriptPath, args, opts);
  child.unref();
  return new Promise<DowntimeSpawnResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: DowntimeSpawnResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => settle({ ok: true }), DOWNTIME_SPAWN_PROBE_MS);
    child.once('error', (err: Error) => {
      process.stderr.write(
        `[worklog-plugin] Downtime pane spawn failed: ${err.message}\n`,
      );
      settle({ ok: false, error: err.message });
    });
    child.once('exit', (code: number | null) => {
      // A non-zero exit (or null — killed by a signal) within the probe
      // window means the script failed to open the pane (e.g. send-to-pi.sh
      // errored); exit 0 means it ran to completion — the pane opened.
      if (code !== 0) {
        process.stderr.write(
          `[worklog-plugin] Downtime pane script exited non-zero ` +
            `(code ${String(code)}) before the probe window elapsed\n`,
        );
        settle({ ok: false, exitCode: code });
      } else {
        settle({ ok: true });
      }
    });
  });
}

// ── Worker orchestrator (implemented — F3) ────────────────────────────

/**
 * Per-tick configuration; re-read every tick so settings apply live.
 *
 * `override` (optional) is the per-instance in-memory enabled-state override:
 * `null` (default) follows the global setting; `true`/`false` force dispatch
 * on/off for THIS worker regardless of the global config. The override is
 * purely in-memory — it resets on plugin restart and never touches the shared
 * settings file (per-instance scoping, parent WL-0MSZ4NSOE007AQEF).
 */
export interface DowntimeWorkerConfig {
  poller: DowntimePoller;
  deps: DowntimeWorkerDeps;
  /**
   * Per-instance in-memory enabled override. `null` (default) = follow the
   * global setting; `true`/`false` force dispatch on/off for this worker.
   */
  override?: boolean | null;
  /** Re-read each tick so settings changes apply without a restart. */
  config(): {
    enabled: boolean;
    thresholdMs: number;
    requiredFreeSlots: number;
    model: string;
    cwd: string;
    /** Pause duration after a genuine empty backlog (no-candidate), ms. */
    noCandidateCooldownMs: number;
    /** Sprint-complete threshold (parent WL-0MTHSHN5V008R5L0). Optional for backward compat — defaults to 20. */
    browseItemCount?: number;
  };
  /**
   * Optional shared round-robin registry (WL-0MSSRED76008LGB6) used for
   * rotation-aware selection and probe jitter. When absent, selection falls
   * back to the pre-rotation sortIndex order and probes use the static
   * interval (fail-open).
   */
  registry?: RoundRobinRegistry;
  /**
   * Shared coordination directory — the `.worklog` dir where
   * `downtime-coordination.json` (+ the leader lock/lease) lives. All
   * herdr instances contributing to the same coordination list pass the
   * same value (parent AC3 — single-machine v1).
   *
   * Optional for backward compatibility / fail-open: when ABSENT the
   * worker runs the LEGACY non-coordination flow — every instance polls
   * and dispatches through the direct tier chain (`dispatchDowntimeWork`)
   * exactly as before the refactor (used by existing tests and by
   * configurations that have not wired coordination). Production wiring
   * (`createDowntimeWorker` in index.ts) always passes it.
   */
  coordinationDir?: string;
  /**
   * Stable per-instance id used for leader election and the coordination
   * entry key (parent AC3 `instanceId`). Omitted → generated once at
   * worker construction (per-process id; a restarted instance re-offers
   * under a fresh id and its dead lease expires in the TTL).
   */
  instanceId?: string;
  /** Leader lease TTL seconds (parent AC2 — default 5 minutes). */
  leaseTtlSeconds?: number;
  /**
   * Coordination check-in interval (parent AC3 — default 30 minutes):
   * every instance re-verifies/updates its entry at this cadence, whether
   * leader or not.
   */
  checkInIntervalMs?: number;
  /**
   * Leader coordination check-in interval (WL-0MTOCBP1D009P4U3 — default
   * 4 minutes): the leader re-offers at this cadence; followers stay at
   * 30 min. The value must be < lease TTL (5 min) so renewal is inside.
   */
  leaderCheckInIntervalMs?: number;
}

export interface DowntimeWorkerTickResult {
  polled: boolean;
  dispatched: boolean;
  idle: boolean;
}

export interface DowntimeWorker {
  /** One poll + evaluation + possible dispatch. Call from the scheduler task. */
  tick(): Promise<DowntimeWorkerTickResult>;
  /** Idle-since timestamp of the current idle run (null when busy). */
  readonly idleSince: number | null;
  /** True while a dispatch is in flight. */
  readonly dispatching: boolean;
  /** Timestamp of the last successful dispatch (null until the first). */
  readonly lastDispatchAt: number | null;
  /**
   * Whether the worker is enabled per the current settings (re-read) AND the
   * per-instance in-memory override: effective enabled = `override ??
   * cfg.enabled` (the override takes precedence when set). The getter re-reads
   * the global setting each call, so a settings change applies live while the
   * override stays in force.
   */
  readonly enabled: boolean;
  /**
   * The current per-instance in-memory override (`null` = follow settings;
   * `true`/`false` = force dispatch on/off for this instance).
   */
  readonly override: boolean | null;
  /**
   * True when the current `override === false` was restored from the
   * persisted disable marker (`.herdr-downtime-disabled`) at construction
   * — i.e. the disable survived a pane/plugin restart. False for a live
   * toggle() press and after any explicit re-enable; lets the header show a
   * "restored" notice so a restored disable is never silent
   * (WL-0MT5SG0VU005ARUR).
   */
  readonly restoredFromMarker: boolean;
  /**
   * Flip the per-instance in-memory override: `null` → `false` (disable
   * dispatch for this instance) → `true` (force dispatch on for this
   * instance) → `null` (return to following the global setting), and so on.
   * In-memory only — never written to the settings file, never persisted.
   */
  toggle(): void;
  /**
   * Compute a jittered probe interval (WL-0MSSRED76008LGB6): the effective
   * poll interval is jittered ±50% of the configured `downtimePollIntervalMs`
   * per call (random, injectable RNG via the worker's registry) so instances
   * with identical configuration do not probe in lockstep. Returns the
   * clamped interval for the NEXT probe.
   */
  jitterPollIntervalMs(baseIntervalMs: number): number;
  /**
   * True while the worker is paused in the no-candidate cooldown: no proxy
   * polling, no idle tracking, and no dispatch until the pause expires
   * (WL-0MSI7DQL10016QYX).
   */
  readonly paused: boolean;
  /**
   * Count of consecutive CLI-error dispatch outcomes (three-strike rule).
   * Reset to 0 on a successful dispatch, a genuine no-candidate outcome, or
   * when a cooldown expires.
   */
  readonly errorStrikes: number;
  /**
   * Whether THIS instance currently holds the elected leadership (parent
   * WL-0MST3OJ8S0001ROL AC1): true while the leader lease is valid and
   * owned by this instance. Only the leader polls the proxy and dispatches.
   */
  readonly isLeader: boolean;
  /**
   * The instance id this worker uses for leader election and its
   * coordination entry key (parent AC3 `instanceId`). Stored per worker
   * construction for the process lifetime.
   */
  readonly instanceId: string;
}

/**
 * Compose poller + idle evaluation + tracker + dispatch into the per-tick
 * worker the scheduler loop (F4) registers as a due-work task.
 */
export function createDowntimeWorker(opts: DowntimeWorkerConfig): DowntimeWorker {
  const tracker = createIdleTracker();
  const perSlotTracker = createPerSlotIdleTracker();
  let dispatching = false;
  let lastDispatchAt: number | null = null;
  // No-candidate cooldown (WL-0MSI7DQL10016QYX): timestamp until which the
  // worker is fully paused (no poll, no idle tracking, no dispatch) after a
  // genuine empty backlog OR three consecutive CLI errors. Cancelled early
  // when a coordination check-in re-offers a fresh item
  // (WL-0MTEZ4XZJ006Y9U7). null = not paused.
  let cooldownUntil: number | null = null;
  // Three-strike rule: consecutive CLI-error dispatch outcomes. A successful
  // dispatch, a genuine no-candidate outcome, or an expired cooldown resets it.
  let errorStrikes = 0;
  // Per-instance in-memory enabled override (parent WL-0MSZ4NSOE007AQEF):
  // null (default) = follow the global setting; true/false force dispatch
  // on/off for THIS instance. In-memory only — resets on plugin restart,
  // never written to the shared settings file. Initialized from the optional
  // config so callers can construct a pre-toggled worker.
  let override: boolean | null = opts.override ?? null;
  // Durable disable (WL-0MT5SFP990001FNW): when the per-worklog-root marker
  // exists, the worker starts disabled so a previous `d` press survives a
  // restart. Explicit opts.override wins over the marker (marker is only the
  // fallback when no override is passed).
  let restoredFromMarker = false;
  if (opts.override === undefined && disableMarkerExists(opts.config().cwd)) {
    override = false;
    restoredFromMarker = true;
  }

  // ── Leader-election + coordination state (parent WL-0MST3OJ8S0001ROL) ──
  // One leader-election manager per worker (per process): the instance id
  // is fixed at construction so the lease file owner and the coordination
  // entry key stay stable for the process lifetime. The manager owns the
  // file lock/lease at `<coordinationDir>/downtime-leader.lock` +
  // `downtime-leader-lease.json`. When `coordinationDir` is ABSENT the
  // worker runs the legacy flow (self is always the leader — no election)
  // so existing non-coordination configurations/tests keep working
  // unchanged (fail-open).
  const leaderManager = opts.coordinationDir
    ? createLeaderElectionManager({
        worklogDir: opts.coordinationDir,
        instanceId: opts.instanceId,
        leaseTtlSeconds: opts.leaseTtlSeconds,
      })
    : null;
  const instanceId = leaderManager ? leaderManager.getInstanceId() : (opts.instanceId ?? 'legacy');
  const checkInIntervalMs = opts.checkInIntervalMs ?? DEFAULT_COORDINATION_CHECK_IN_MS;
  const leaderCheckInMs = (opts as { leaderCheckInIntervalMs?: number }).leaderCheckInIntervalMs
    ?? DEFAULT_LEADER_CHECK_IN_MS;
  // Timestamp of the last coordination check-in (30-min cadence, parent
  // AC3). null until the first tick so every instance checks in on startup
  // (first check-in on startup — parent Constraint).
  let lastCheckInAt: number | null = null;
  // Per-tick cached leadership decision (the lease read is cheap but let a
  // tick observe ONE consistent state — an election win mid-tick applies
  // next tick). Legacy mode (no coordinationDir) is always the leader.
  let leaderState = leaderManager ? leaderManager.isLeader() : true;

  // Three-strike pause (WL-0MSI7DQL10016QYX; shared by the CLI-error path
  // and the coordination probe-failure path, WL-0MTEZ4XZJ006Y9U7): N
  // consecutive failures pause the worker entirely and log the persistent
  // error so it is auditable. A single transient failure does NOT pause —
  // it retries on the next idle period. Fail-closed: error logging must
  // never crash the worker.
  const pauseAfterPersistentErrors = async (message: string, error?: string): Promise<void> => {
    errorStrikes += 1;
    if (errorStrikes >= DOWNTIME_ERROR_STRIKE_LIMIT) {
      try {
        await opts.deps.recordError({
          cwd: opts.config().cwd,
          at: new Date().toISOString(),
          message,
          ...(error ? { error } : {}),
        });
      } catch {
        // fail-closed: error logging must never crash the worker
      }
      cooldownUntil = Date.now() + opts.config().noCandidateCooldownMs;
      errorStrikes = 0;
      tracker.record(false);
      perSlotTracker.record([]);
    }
  };

  return {
    get idleSince(): number | null {
      return tracker.idleSince;
    },
    get dispatching(): boolean {
      return dispatching;
    },
    get lastDispatchAt(): number | null {
      return lastDispatchAt;
    },
    get isLeader(): boolean {
      return leaderState;
    },
    get instanceId(): string {
      return instanceId;
    },
    get enabled(): boolean {
      // Effective enabled = override ?? cfg.enabled: the per-instance
      // override takes precedence when set (so `d` can force dispatch on
      // for one pane even when the global setting is off); with no override
      // the worker follows the global setting exactly as before.
      return override ?? opts.config().enabled;
    },
    get override(): boolean | null {
      return override;
    },
    get restoredFromMarker(): boolean {
      return restoredFromMarker;
    },
    toggle(): void {
      // null → false → null cycle: pressing `d` disables dispatch;
      // pressing again returns to following the global setting.
      // No force-enable: a second press never sets override to true.
      // The per-worklog-root marker (WL-0MT5SFP990001FNW) is written on
      // disable and removed on re-enable so the disable survives restarts.
      // A live press (or an explicit re-enable) clears the restored flag so
      // the header notice only reflects the marker-restored state.
      if (override === null) {
        override = false;
        restoredFromMarker = false;
        writeDisableMarker(opts.config().cwd);
      } else {
        override = null;
        restoredFromMarker = false;
        removeDisableMarker(opts.config().cwd);
      }
    },
    jitterPollIntervalMs(baseIntervalMs: number): number {
      // Fail-open: no registry → static interval (no jitter).
      return opts.registry
        ? opts.registry.getEffectivePollInterval(baseIntervalMs)
        : baseIntervalMs;
    },
    get paused(): boolean {
      return cooldownUntil !== null && Date.now() < cooldownUntil;
    },
    get errorStrikes(): number {
      return errorStrikes;
    },
    async tick(): Promise<DowntimeWorkerTickResult> {
      const cfg = opts.config();
      // Short-circuit on the EFFECTIVE enabled state (override ?? settings):
      // while toggled off the worker performs no proxy polling, no idle
      // tracking, and no dispatch — exactly the settings-disabled path.
      if (!(override ?? cfg.enabled)) return { polled: false, dispatched: false, idle: false };

      // ── Sprint Complete auto-disable (parent WL-0MTHSHN5V008R5L0) ────
      // Check sprint completeness: count completed + in_review items vs
      // browseItemCount. When the count meets or exceeds the threshold,
      // write the disable marker (same as `d` shortcut). When below,
      // remove the marker (re-enable dispatch). Fail-closed: any query
      // failure leaves the marker unchanged. Live marker check gates
      // dispatch so the current process respects an auto-written marker
      // without waiting for a restart.
      try {
        const completedCount = await fetchCompletedItemCount();
        if (completedCount !== undefined) {
          const threshold = cfg.browseItemCount ?? 20;
          const isSprintComplete = completedCount >= threshold;
          const markerExists = disableMarkerExists(cfg.cwd);
          if (isSprintComplete && !markerExists) {
            writeDisableMarker(cfg.cwd);
          } else if (!isSprintComplete && markerExists) {
            removeDisableMarker(cfg.cwd);
          }
        }
      } catch {
        // Fail-closed: sprint check failure must never crash the worker.
      }
      // Live marker gate: respect an auto-written (or manually toggled)
      // `.herdr-downtime-disabled` marker immediately, not just at
      // construction. Effective enabled = override ?? (marker ? false : cfg.enabled).
      if (disableMarkerExists(cfg.cwd) && override === null) {
        return { polled: false, dispatched: false, idle: false };
      }

      // ── Leader election + coordination check-in (parent
      // WL-0MST3OJ8S0001ROL AC1/AC2/AC3) ───────────────────────────────────
      // In legacy mode (no coordinationDir) this whole block is skipped: no
      // election, no check-in — the worker is always the leader and uses the
      // direct tier chain below (pre-refactor behavior).
      const tickNow = Date.now();
      if (leaderManager !== null) {
        // ── F5 (WL-0MTF4ABQN0043F4V): self-heal + re-derive EVERY tick ──
        // The pre-fix code derived `leaderState` ONCE at creation and only
        // updated it inside the takeover branch — a lease that expired
        // mid-pause (worker's tick loop stalled in the no-candidate
        // cooldown) left the worker dispatching with a cached leaderState
        // as a zombie. Two changes fix this:
        //
        //  AC2 — self-heal FIRST. refreshLease() now renews only an OWNED
        //  lease regardless of validity (F4 ownership check), so an
        //  owned-but-EXPIRED lease is renewed here instead of silently
        //  no-oped. This must run before the isLeader() re-derivation
        //  below: detectStaleLeader() returns false for our OWN lease, so
        //  without it an expired owned lease would fall through BOTH the
        //  leader branch (isLeader() false) AND the takeover branch
        //  (hasLease true, detectStaleLeader false) — the self-heal would
        //  be starved. Foreign/missing leases are untouched (refreshLease
        //  no-ops on those — F4 fail-safe).
        leaderManager.refreshLease();
        //  AC1 — re-derive leadership every tick (one cheap lease-file
        //  read): a lease that expired mid-pause routes this worker OUT of
        //  zombie dispatch; if ANOTHER instance won the lease during the
        //  pause, this re-derived state yields — never fights the new
        //  leader (AC4).
        leaderState = leaderManager.isLeader();
        if (leaderState) {
          // Leader: self-heal already ran above (fresh acquiredAt this
          // tick — each proxy-poll cycle extends the 5-minute lease,
          // AC2). A failed refresh (rename/IO) is fail-safe: the existing
          // lease stands until it expires, then a new election runs.
        } else if (!leaderManager.hasLease() || leaderManager.detectStaleLeader()) {
          // No leader exists yet (fresh election) OR the elected leader's
          // lease expired (crash / idle) — try to take over NOW. Stale
          // state is cleaned first (an expired lease, or an orphaned lock
          // without a lease, must not block the new election). On success
          // we become the leader this tick; on lock contention (another
          // instance won first — its cleanup+no-op or a valid lease) we
          // stay non-leader and retry on a later tick. Fail-safe: a failed
          // election leaves us non-leader (no dispatch).
          cleanupStaleElection({ worklogDir: opts.coordinationDir! });
          leaderManager.attemptElection();
          leaderState = leaderManager.isLeader();
          if (leaderState) leaderManager.refreshLease();
          // Audit trail (WL-0MSXHAE290067VAL): log the leadership win —
          // initial election or takeover after a stale-lease detection.
          if (leaderState) {
            void appendCoordinationLogEntry(cfg.cwd, {
              kind: 'coordination',
              operation: 'election',
              instanceId,
              at: new Date(tickNow).toISOString(),
            });
          }
        }

        // Coordination check-in (parent AC3 — first on startup, then every
        // 30 minutes): recompute THIS instance's most-important item and
        // verify/update its entry in the shared coordination file. Runs for
        // leader AND non-leader alike — every instance contributes its most
        // important item; the single elected leader dispatches from the list.
        // WL-0MTOCBP1D009P4U3: leader every 4 min (renews lease), followers every 30 min.
        const effectiveCheckInMs = leaderState ? leaderCheckInMs : checkInIntervalMs;
        if (lastCheckInAt === null || tickNow - lastCheckInAt >= effectiveCheckInMs) {
          lastCheckInAt = tickNow;
          try {
            const checkIn = await runCoordinationCheckIn(opts.deps, {
              cwd: cfg.cwd,
              coordinationDir: opts.coordinationDir!,
              instanceId,
            }, tickNow);
            // WL-0MTEZ4XZJ006Y9U7 (AC2): a successful re-offer proves the
            // backlog is dispatchable again — cancel any no-candidate pause
            // so the leader resumes polling/dispatch this very tick. The
            // check-in block runs BEFORE the cooldown gate below, so the
            // pause can never suppress the only mechanism that re-offers
            // work once the coordination file empties.
            // WL-0MTEZ4XZJ006Y9U7 (AC2): any successful write (re-offer
            // or emptied entry) proves CLI health — cancel any pause so
            // polling resumes this tick. A non-update on a paused worker
            // also cancels (the write proved CLI health; dispatch will
            // resume next tick via the poll).
            if (checkIn.updated || checkIn.offered !== null) {
              cooldownUntil = null;
              errorStrikes = 0;
            } else if (cooldownUntil !== null && checkIn.offered !== null) {
              // File already holds the same entry (no write needed) but
              // CLI healthy — also cancel so stale-file probes don't keep
              // the pause alive while work still exists.
              cooldownUntil = null;
              errorStrikes = 0;
            }
          } catch {
            // Fail-safe: a throwing check-in (stub or regression) must never
            // crash the worker — retried at the next cadence.
          }
        }

        // Non-leader short-circuit (AC4): no proxy polling, no idle
        // tracking, no dispatch — the check-in above is the instance's only
        // coordination activity. (Lease takeover was handled above.)
        if (!leaderState) {
          return { polled: false, dispatched: false, idle: false };
        }
      }

      // Cooldown gate (WL-0MTEZ4XZJ006Y9U7 AC2 — ordering): the check-in
      // block above runs FIRST, so a no-candidate pause never suppresses the
      // 30-min re-offer (the only mechanism that re-offers work once the
      // coordination file empties); a fresh re-offer cancels the pause
      // directly. While paused the worker performs NO proxy polling, NO
      // idle tracking, and NO dispatch. The pause is a full stop (user
      // confirmed "pause completely"); once it expires the idle tracker is
      // empty, so a fresh full idle period is required before the next
      // dispatch (no stale idle credit from before the pause).
      if (cooldownUntil !== null) {
        if (Date.now() < cooldownUntil) {
          return { polled: false, dispatched: false, idle: false };
        }
        // ── F5 cooldown-exit hook (AC3) ──
        // Pause expired — resume normal polling. Nothing further is needed
        // here for leadership: the leader block at the top of THIS tick
        // already ran the self-heal refreshLease + per-tick re-derivation
        // BEFORE reaching this gate, so any dispatch decision on this
        // resume tick (or later ones) uses a lease-fresh leaderState — even
        // when the tick loop stalled mid-pause, the first tick after expiry
        // re-derives before poll/dispatch. Belt-and-braces guarantee that
        // the cooldown-exit path can never dispatch on stale leadership.
        cooldownUntil = null; // pause expired — resume normal polling
        errorStrikes = 0; // fresh strike counter after the pause
      }
      if (opts.poller.isPolling()) return { polled: false, dispatched: false, idle: tracker.idleSince !== null };


      const status = await opts.poller.poll();
      if (status === null) {
        tracker.record(false); // endpoint failure/ambiguity → busy
        perSlotTracker.record([]); // fail-closed: ambiguous poll resets every slot timer
        return { polled: true, dispatched: false, idle: false };
      }

      // Per-slot routing (LP-0MSG5TA7Y002GN39): when the proxy serves
      // per-slot identity AND the config asks for 0 < N < total, idle
      // duration is tracked PER SLOT so dispatch requires the SAME N slots
      // continuously free for the full threshold. The global gate in
      // per-slot mode is the per-slot-safe subset (server up + no model
      // switch): a query/lease tied to a busy slot is the operator's own
      // session and must not reset the free slots' timers (spare-capacity
      // dispatch, parent WL-0MT32F90V008UAD2). A slot reporting processing
      // resets only its own timer.
      const perSlotMode =
        Array.isArray(status.slots) &&
        cfg.requiredFreeSlots > 0 &&
        cfg.requiredFreeSlots < status.total_slots;

      let idle: boolean;
      let ready: boolean;
      if (perSlotMode && Array.isArray(status.slots)) {
        const globalIdle = perSlotGlobalIdleChecks(status);
        // Display-only: the global idle tracker also reflects per-slot query
        // activity for the title bar idle indicator — when any slot is
        // processing (including the operator's), the title bar shows "busy",
        // not "idle". The dispatch logic (spare-capacity relaxation) is
        // unaffected because free-slot count comes from perSlotTracker, not
        // tracker.idleSince. (parent WL-0MT65T14L002HTWB)
        const anySlotProcessing = status.slots.some(
          (s) => typeof s.is_processing === 'boolean' && s.is_processing,
        );
        tracker.record(globalIdle && !anySlotProcessing);
        if (globalIdle) {
          perSlotTracker.record(status.slots);
          idle = true;
          ready =
            perSlotTracker.thresholdMetCount(cfg.thresholdMs) >= cfg.requiredFreeSlots;
        } else {
          perSlotTracker.record([]); // global busy → reset every slot timer
          idle = false;
          ready = false;
        }
      } else {
        // Single global tracker (no per-slot data, or N ≤ 0 / N ≥ total):
        // unchanged all-slots-free behaviour (parent AC2 parity).
        idle = evaluateIdle(status, cfg.requiredFreeSlots);
        tracker.record(idle);
        ready = idle && tracker.isThresholdMet(cfg.thresholdMs);
      }
      if (!idle) return { polled: true, dispatched: false, idle: false };
      if (!ready) return { polled: true, dispatched: false, idle: true };
      if (dispatching) return { polled: true, dispatched: false, idle: true };

      // ── Dispatch (parent WL-0MST3OJ8S0001ROL AC4, F5 WL-0MTII48OV008P2QU AC4) ──
      // Single machine-wide slot budget: ONE leader poll → ONE freeSlots
      // snapshot (per-slot free count when `slots` served, else
      // `available_slots`), forwarded to the sole dispatch call. No
      // per-worklog duplication — total concurrently dispatched never exceeds
      // the shared budget (WL-0MT50LKAK001EF5Q single cap source). Per-tier
      // minimums (WL-0MT32F90V008UAD2 AC3): audit needs ≥2 (parent + Phase 2
      // child), single-pane tiers need ≥1; idle-duration gate (configured N)
      // is unchanged and shared.
      const freeSlots =
        Array.isArray(status.slots)
          ? status.slots.filter(
              (s) => typeof s.is_processing === 'boolean' && !s.is_processing,
            ).length
          : status.available_slots;

      // Coordination mode: the elected leader reads the shared coordination
      // list, re-fetches and classifies each entry's item (tier priority:
      // audit → implement → plan → intake) and dispatches the
      // highest-priority available item when a slot opens, removing its
      // entry. The CAS claim + dispatched-marker guards are preserved
      // inside `dispatchClaimedTier` (AC5). The idle-duration gate above
      // has already required ≥ N ≥ 1 free slots continuously, so the
      // dispatch runs only with a real slot available.
      //
      // Legacy mode (no coordinationDir / no fetchItem dep): the direct
      // per-instance tier chain (`dispatchDowntimeWork`) — pre-refactor
      // behavior, retained as the fail-open fallback.
      dispatching = true;
      try {
        const outcome =
          opts.coordinationDir && typeof opts.deps.fetchItem === 'function'
            ? await dispatchFromCoordination(
                opts.deps,
                readCoordinationFile(opts.coordinationDir)?.entries ?? [],
                {
                  model: cfg.model,
                  cwd: cfg.cwd,
                  coordinationDir: opts.coordinationDir,
                  freeSlots,
                  leaseTtlMs: opts.leaseTtlSeconds
                    ? opts.leaseTtlSeconds * 1000
                    : DEFAULT_LEASE_TTL_SECONDS * 1000,
                },
              )
            : await dispatchDowntimeWork(opts.deps, {
                model: cfg.model,
                cwd: cfg.cwd,
                freeSlots,
              });
        if (outcome.dispatched) {
          lastDispatchAt = Date.now();
          errorStrikes = 0; // a successful dispatch proves the CLI is healthy
          // Belt-and-suspenders: even if the proxy does not immediately
          // report busy, require a fresh full idle period before the next
          // dispatch (AC5).
          tracker.record(false);
          perSlotTracker.record([]);
        } else if (outcome.reason === 'no-candidate') {
          // WL-0MTEZ4XZJ006Y9U7 (AC1): in coordination mode the shared file
          // is an OFFER LIST, not the backlog — after a dispatch the leader
          // removes the entry, so an empty file is a TRANSIENT gap while the
          // worklog still has dispatchable work (the pre-fix code paused on
          // it for the full cooldown, stalling ~60 of every 62 minutes).
          // Probe the worklog before pausing; only a GENUINELY empty backlog
          // pauses (legacy non-coordination semantics unchanged):
          //  - probe finds a candidate → no pause, no strike: the 30-min
          //    check-in re-offers it and dispatch resumes;
          //  - probe fails (wl/CLI errors) → fail-closed strike (a broken
          //    lookup must never look like an empty backlog — the
          //    three-strike rule decides when to pause);
          //  - probe finds nothing → genuine empty backlog → pause entirely
          //    and reset the idle tracker (fresh full idle period required
          //    after the pause).
          if (opts.coordinationDir && typeof opts.deps.fetchItem === 'function') {
            const probe = await computeMostImportantItem(opts.deps, cfg.cwd, Date.now());
            if (probe.ok && 'noCandidate' in probe && probe.noCandidate) {
              errorStrikes = 0; // the CLI answered — it is healthy
              cooldownUntil = Date.now() + cfg.noCandidateCooldownMs;
              tracker.record(false);
              perSlotTracker.record([]);
            } else if (!probe.ok) {
              await pauseAfterPersistentErrors(
                `Downtime worker: worklog probe failed while the shared ` +
                `coordination file held no dispatchable entry — ` +
                `${DOWNTIME_ERROR_STRIKE_LIMIT} consecutive errors, pausing ` +
                `dispatch for ${cfg.noCandidateCooldownMs}ms.`,
              );
            }
            // probe.ok with a candidate: no pause — the empty file is a
            // transient gap; the check-in re-offers the candidate.
          } else {
            // Legacy mode — original semantics: no-candidate means a genuine
            // empty backlog; pause entirely for the cooldown.
            errorStrikes = 0; // the CLI answered — it is healthy
            cooldownUntil = Date.now() + cfg.noCandidateCooldownMs;
            tracker.record(false);
            perSlotTracker.record([]);
          }
        } else if (outcome.reason === 'wl-error') {
          // Three-strike rule on CLI errors: a dispatch attempt ending in a
          // wl failure is one strike. Three consecutive strikes pause the
          // worker entirely (no dispatch) AFTER logging the persistent error
          // so the failure is auditable. A single transient error does NOT
          // pause — it retries on the next idle period. Carry the
          // underlying wl error (WL-0MTL4PC0Y005GXTI) so the pause entry is actionable.
          await pauseAfterPersistentErrors(
            `Downtime worker: ${DOWNTIME_ERROR_STRIKE_LIMIT} consecutive ` +
            `wl CLI errors — pausing dispatch for ${cfg.noCandidateCooldownMs}ms.`,
            outcome.error,
          );
        }
        // Any other non-dispatch outcome (dispatch-in-flight, code-freeze
        // skip) is neutral: no strike, no cooldown — the next idle period
        // retries (a freeze skip keeps polling so implement/audit dispatch
        // resumes immediately when the freeze lifts, WL-0MSQ0RPQP00636JY).
        return { polled: true, dispatched: outcome.dispatched, idle: true };
      } finally {
        dispatching = false;
      }
    },
  };
}

// ── Blocked-questions prompt (implemented) ────────────────────────────

/**
 * Instruction appended to every dispatched prompt: when the skill run
 * cannot proceed because answers are needed, record the questions in a
 * comment on the work item, mark it as needing producer review, repeat the
 * questions in the final summary, and stop — never block indefinitely (parent
 * AC6).
 */
export const BLOCKED_QUESTIONS_INSTRUCTION =
  'If you cannot proceed because you need answers, record the questions in a ' +
  'comment on the work item (wl comment add <id> --comment "question: ...") and ' +
  'mark the item as needing producer review (wl update <id> --needs-producer-review ' +
  'true), repeat the questions in your final summary, then stop — do not block ' +
  'indefinitely.';

/** Build the prompt dispatched to a pi agent pane for the given candidate. */
export function buildDowntimePrompt(kind: DowntimeSkillKind, candidate: DowntimeCandidate): string {
  const skill =
    kind === 'plan' ? '/skill:plan'
    : kind === 'audit' ? '/skill:audit'
    : kind === 'implement' ? '/skill:implement'
    : '/skill:intake';
  return [
    `Run ${skill} ${candidate.id} — ${candidate.title}.`,
    BLOCKED_QUESTIONS_INSTRUCTION,
  ].join('\n');
}

/**
 * Build the audit comment added to the item on a successful downtime
 * dispatch: author-visible statement of the automatic dispatch, the skill
 * run, the item, and the UTC timestamp. Newlines in the title are
 * collapsed so the comment stays a single clean line.
 */
export function buildDowntimeDispatchComment(
  itemId: string,
  kind: DowntimeDispatchKind,
  dispatchedAt: string,
  title?: string,
): string {
  const skill =
    kind === 'plan' ? '/skill:plan'
    : kind === 'audit' ? '/skill:audit'
    : kind === 'implement' ? '/skill:implement'
    : kind === 'scheduled' ? 'scheduled prompt'
    : '/skill:intake';
  const suffix = title ? ` (${title.replace(/[\r\n]+/g, ' ')})` : '';
  return `Auto-dispatched by the herdr downtime worker at ${dispatchedAt} — running ${skill} ${itemId}${suffix}.`;
}

// ── Wiring helpers (implemented — F4) ─────────────────────────────────

/**
 * Parse the stdout of `wl next --stage <stage> -n N --json` into typed
 * plan/intake candidates. Accepts both the batch shape the CLI emits for
 * `-n N` (`{ workItems: [{ workItem: {...} }] }`) and the legacy single-item
 * shape (`{ workItem: {...} }`) for backward compatibility. Each candidate
 * carries the query `stage`, the worklog `status` (for the client-side
 * `open` guard) and `sortIndex` (wl next priority order). Malformed JSON or
 * output without any parseable entry yields null (fail-closed); an empty
 * result list yields `[]` (a genuine empty backlog).
 */
export function parseNextCandidatesOutput(
  stdout: string,
  stage: DowntimeStage,
): DowntimeCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  let rawItems: unknown[] | null = null;
  if (parsed !== null && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.workItems)) {
      rawItems = o.workItems;
    } else if (typeof o.workItem === 'object' && o.workItem !== null) {
      rawItems = [o]; // legacy single-item shape with a candidate
    } else if ('workItem' in o) {
      rawItems = []; // legacy single-item shape answered no item → empty backlog
    }
  }
  if (rawItems === null) return null;

  const candidates: DowntimeCandidate[] = [];
  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) continue;
    const nested =
      (entry as { workItem?: unknown }).workItem !== undefined
        ? (entry as { workItem: Record<string, unknown> }).workItem
        : (entry as Record<string, unknown>);
    if (typeof nested !== 'object' || nested === null) continue;
    if (typeof nested.id !== 'string' || nested.id.length === 0) continue;
    candidates.push({
      id: nested.id,
      title: typeof nested.title === 'string' ? nested.title : '',
      stage,
      status: typeof nested.status === 'string' ? nested.status : undefined,
      sortIndex:
        typeof nested.sortIndex === 'number' && Number.isFinite(nested.sortIndex)
          ? nested.sortIndex
          : undefined,
      priority: typeof nested.priority === 'string' ? nested.priority : undefined,
      needsProducerReview:
        nested.needsProducerReview !== undefined ? Boolean(nested.needsProducerReview) : undefined,
    });
  }
  return candidates;
}

/**
 * Parse the stdout of `wl next --stage <stage> --json` into the first
 * candidate. Returns null (no dispatch) for empty output, a null
 * `workItem`, missing ids, or malformed JSON.
 *
 * Superseded by `parseNextCandidatesOutput` for production selection (the
 * downtime worker fetches a batch so marker-excluded candidates do not
 * starve selection); kept exported for callers/tests that use the
 * single-item shape.
 */
export function parseNextItemOutput(stdout: string, stage: DowntimeStage): DowntimeCandidate | null {
  try {
    const parsed = JSON.parse(stdout) as {
      workItem?: { id?: unknown; title?: unknown } | null;
    };
    const raw = parsed?.workItem;
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
    return {
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title : '',
      stage,
    };
  } catch {
    return null;
  }
}

/**
 * Derive the dispatch kind from a prompt built by `buildDowntimePrompt`
 * (the pane name is `Downtime plan` / `Downtime intake` / `Downtime audit` /
 * `Downtime implement`).
 */
export function skillKindFromPrompt(prompt: string): DowntimeSkillKind {
  if (prompt.includes('/skill:audit ')) return 'audit';
  if (prompt.includes('/skill:implement ')) return 'implement';
  return prompt.includes('/skill:plan ') ? 'plan' : 'intake';
}

// ── Rotation-aware selection (WL-0MSSRED76008LGB6) ────────────────────

/**
 * A candidate carrying the fields needed for rotation-aware selection:
 * a stable id, an optional priority level (the round-robin grouping key),
 * and an optional sortIndex (wl next priority order preserved).
 */
export interface RotatableCandidate {
  id: string;
  priority?: string;
  sortIndex?: number;
}

/**
 * Apply round-robin rotation within the highest-priority group of a
 * candidate list. Fail-open design (WL-0MSSRED76008LGB6):
 *
 * - No registry (or an empty/closed registry) → fall back to the plain
 *   sortIndex order (first candidate wins) — the pre-rotation behaviour.
 * - Candidates with no `priority` field → fall back to sortIndex order
 *   (rotation needs the priority grouping key).
 * - The highest-priority group with multiple members rotates through a
 *   shared durable cursor (`advanceCursor` persists the advance).
 * - A single-member group needs no rotation → sortIndex order stands.
 *
 * Candidates are sorted ascending by sortIndex (wl next priority order)
 * before grouping, so the first group always holds the top priority.
 *
 * @param candidates Candidates already filtered/validated by the caller.
 * @param registry Optional shared round-robin registry. When absent,
 *   rotation is skipped entirely (fail-open).
 * @returns The selected candidate, or null when the list is empty.
 */
export function selectWithRotation<T extends RotatableCandidate>(
  candidates: T[],
  registry?: RoundRobinRegistry,
): T | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  if (sorted.length === 1) return sorted[0] ?? null;
  if (!registry) return sorted[0] ?? null;

  // Group by priority level; only rotate within the highest-priority group
  // (candidates are sorted ascending by sortIndex, so the first group holds
  // the top priority). Missing priority on the leader → no rotation
  // possible (fail-open).
  const topPriority = sorted[0]?.priority;
  if (!topPriority) return sorted[0] ?? null;

  const topGroup = sorted.filter((c) => c.priority === topPriority);
  if (topGroup.length <= 1) return sorted[0] ?? null;

  // Rotate: the cursor selects the next member of the tied group and
  // persists the advance (write-then-spawn ordering handled by callers).
  const index = registry.advanceCursor(topPriority, topGroup.length);
  return topGroup[index] ?? topGroup[0] ?? null;
}

// ── Audit-tier selection (WL-0MSI8H3HP000K0RG) ────────────────────────

/**
 * Parse the stdout of `wl list --status completed --stage in_review
 * --root-only --json` (root-only, WL-0MSTLFW14000KPEC: only parent items
 * are audit candidates) into typed audit candidates. Accepts both the bare
 * array shape and the `{ workItems: [...] }` wrapper. Malformed/empty
 * output yields null (fail-closed).
 */
export function parseAuditCandidatesOutput(stdout: string): AuditCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { workItems?: unknown }).workItems)
      ? (parsed as { workItems: unknown[] }).workItems
      : null;
  if (items === null) return null;

  const candidates: AuditCandidate[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    candidates.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '',
      auditedAt: typeof o.auditedAt === 'string' ? o.auditedAt : undefined,
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : undefined,
      sortIndex: typeof o.sortIndex === 'number' && Number.isFinite(o.sortIndex) ? o.sortIndex : undefined,
      priority: typeof o.priority === 'string' ? o.priority : undefined,
      needsProducerReview:
        o.needsProducerReview !== undefined ? Boolean(o.needsProducerReview) : undefined,
    });
  }
  return candidates;
}

/**
 * Parse the item ids from `wl list --status in_progress --json` output
 * (WL-0MT3PHW4I002SNOV): returns the ids of every item currently
 * `in_progress`, or null on malformed output (fail-closed — the
 * active-audit single-flight check treats an unparseable worklog query as
 * a failed check, `{ok:false}`). Accepts the same shapes as the other wl
 * parsers: a `{workItems: [...]}` object with bare item objects, a
 * `{workItems: [{workItem: {...}}]}` wrapper shape, or a bare array.
 * Entries without a usable id are skipped.
 */
export function parseInProgressOutput(stdout: string): Set<string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { workItems?: unknown }).workItems)
      ? (parsed as { workItems: unknown[] }).workItems
      : null;
  if (items === null) return null;

  const ids = new Set<string>();
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    // Accept both bare item objects and the {workItem: {...}} wrapper.
    const wrapped = typeof o.workItem === 'object' && o.workItem !== null
      ? (o.workItem as Record<string, unknown>)
      : undefined;
    const id = typeof wrapped?.id === 'string'
      ? wrapped.id
      : typeof o.id === 'string'
        ? o.id
        : undefined;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return ids;
}

/**
 * Select the next audit candidate from parsed in_review items: the first
 * item WITHOUT a valid audit, sorted ascending by `sortIndex` (heartbeat
 * convention). "Valid audit" reuses `isAuditFresh` from @worklog/shared/icons
 * (fresh = a
 * review icon that is neither ⏳ nor 🔍). Returns null when no candidate is
 * unaudited/stale (or the list is empty). Missing auditedAt/updatedAt means
 * not fresh → selected.
 *
 * Dispatched-marker exclusion (WL-0MSLIY8ZR004QUSY): candidates whose id is
 * present in `dispatchedItemIds` (itemIds the downtime worker has already
 * dispatched for `/skill:audit`) are excluded UNLESS they carry a fresh
 * audit — the exclusion composes with `isAuditFresh` above, so an item
 * whose most recent audit is fresh is governed by the existing freshness
 * logic (fresh → not a candidate, unchanged) and an item with a
 * stale/absent audit since its dispatch is never re-selected. This closes
 * the re-selection loop where a dispatched audit run reverts the item to
 * completed/in_review without recording a fresh audit.
 *
 * 7-day recency filter: a candidate must have been modified within
 * `DOWNTIME_AUDIT_RECENCY_WINDOW_MS` (7 days) to be dispatched. A MISSING
 * `updatedAt` is still included (recency cannot be verified → include, per
 * operator decision — absent data must not silently drop candidates); an
 * unparseable `updatedAt` is excluded (fail-closed: recency cannot be
 * verified). `now` is injectable for deterministic tests.
 */
export function selectAuditCandidate(
  candidates: AuditCandidate[],
  now: number = Date.now(),
  dispatchedItemIds?: ReadonlySet<string>,
  registry?: RoundRobinRegistry,
): AuditCandidate | null {
  const recencyCutoff = now - DOWNTIME_AUDIT_RECENCY_WINDOW_MS;
  const filtered = candidates
    .filter((c) => !isAuditFresh(c.auditedAt, c.updatedAt))
    .filter((c) => !(dispatchedItemIds?.has(c.id) ?? false))
    // Exclude items needing producer review (parent WL-0MTIAL65N004T22F AC1).
    .filter((c) => c.needsProducerReview !== true)
    .filter((c) => {
      if (!c.updatedAt) return true; // missing → include
      const updated = new Date(c.updatedAt).getTime();
      if (Number.isNaN(updated)) return false; // unparseable → fail-closed exclude
      return updated >= recencyCutoff;
    })
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  return selectWithRotation(filtered, registry);
}

/**
 * Turn a parsed audit candidate into a dispatachable `DowntimeCandidate`
 * (stage `audit`) for the audit tier.
 */
export function toDowntimeCandidate(candidate: AuditCandidate): DowntimeCandidate {
  return {
    id: candidate.id,
    title: candidate.title,
    stage: 'audit',
    needsProducerReview: candidate.needsProducerReview,
  };
}

// ── Implement-tier selection (WL-0MSMAYPQP001FLR6) ───────────────────

/**
 * Ordinal rank of a risk level on the canonical scale
 * (Low < Medium < High < Severe/Critical), mirroring the wl next DB filter
 * semantics (packages/shared riskOrdinal) for the belt-and-suspenders
 * client-side guard. Unset/unknown values map to null (fail-closed).
 */
function riskOrdinal(risk: string | undefined | null): number | null {
  // Extract the leading keyword before any delimiter (—, -, :, whitespace).
  // Agents may produce verbose risk fields like "Medium — NVIDIA driver changes…";
  // the belt-and-suspenders guard must recognise the level regardless.
  const normalized = (risk ?? '').trim().toLowerCase().split(/[-:–—\s]+/)[0];
  switch (normalized) {
    case 'low': return 1;
    case 'medium': return 2;
    case 'high': return 3;
    case 'severe':
    case 'critical': return 4;
    default: return null;
  }
}

/**
 * Ordinal rank of an effort level on the canonical scale
 * (Extra Small < Small < Medium < Large < Extra Large), mirroring the wl
 * next DB filter semantics (packages/shared effortOrdinal). Accepts both
 * the short CLI spellings (XS/S/M/L/XL) and long-form spellings,
 * normalized case-insensitively. Unset/unknown values map to null
 * (fail-closed).
 */
function effortOrdinal(effort: string | undefined | null): number | null {
  const normalized = (effort ?? '').trim().toLowerCase();
  // Try exact match on stripped version first (simple cases: "small", "medium",
  // "Extra Small" → "extrasmall"). If that fails, fall back to searching for
  // the keyword anywhere in the string — agents produce verbose fields like
  // "1–4 hours — Small. Diagnostic investigation…" (keyword after the dash).
  const stripped = normalized.replace(/[\s-]+/g, '');
  switch (stripped) {
    case 'xs':
    case 'extrasmall': return 1;
    case 's':
    case 'small': return 2;
    case 'm':
    case 'medium': return 3;
    case 'l':
    case 'large': return 4;
    case 'xl':
    case 'extralarge': return 5;
    default:
      // Fallback: search for the keyword bounded by non-word characters.
      // Checked in order of specificity (longest first) so "small" wins over "s".
      if (/(?:^|\W)extrasmall(?:\W|$)/.test(normalized)) return 1;
      if (/(?:^|\W)xs(?:\W|$)/.test(normalized)) return 1;
      if (/(?:^|\W)small(?:\W|$)/.test(normalized)) return 2;
      if (/(?:^|\W)s(?:\W|$)/.test(normalized)) return 2;
      if (/(?:^|\W)extralarge(?:\W|$)/.test(normalized)) return 5;
      if (/(?:^|\W)large(?:\W|$)/.test(normalized)) return 4;
      if (/(?:^|\W)xl(?:\W|$)/.test(normalized)) return 5;
      if (/(?:^|\W)l(?:\W|$)/.test(normalized)) return 4;
      if (/(?:^|\W)m(?:\W|$)/.test(normalized)) return 3;
      if (/(?:^|\W)medium(?:\W|$)/.test(normalized)) return 3;
      return null;
  }
}

/**
 * Parse the stdout of `wl next --stage plan_complete --risk low --effort
 * small -n N --json` into typed implement candidates. Accepts the
 * `{ workItems: [{ workItem: {...} }] }` shape the CLI emits for a batch
 * (`-n N`); entries without an id are skipped. Malformed JSON or output
 * without a workItems list yields null (fail-closed); an empty list yields
 * `[]` (a genuine empty backlog).
 */
export function parseImplementCandidatesOutput(stdout: string): ImplementCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items =
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { workItems?: unknown }).workItems)
      ? (parsed as { workItems: unknown[] }).workItems
      : null;
  if (items === null) return null;

  const candidates: ImplementCandidate[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as { workItem?: Record<string, unknown> };
    const o = entry.workItem;
    if (typeof o !== 'object' || o === null) continue;
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    candidates.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '',
      status: typeof o.status === 'string' ? o.status : '',
      risk: typeof o.risk === 'string' ? o.risk : undefined,
      effort: typeof o.effort === 'string' ? o.effort : undefined,
      sortIndex: typeof o.sortIndex === 'number' && Number.isFinite(o.sortIndex) ? o.sortIndex : undefined,
      priority: typeof o.priority === 'string' ? o.priority : undefined,
      needsProducerReview:
        o.needsProducerReview !== undefined ? Boolean(o.needsProducerReview) : undefined,
    });
  }
  return candidates;
}

/**
 * Select the next implement candidate from parsed wl next output: the
 * first candidate that is open (`status === 'open'`, AC2), carries risk
 * risk ≤ Medium and effort ≤ Medium (AC1 threshold boundaries,
 * fail-closed on unset/unknown), is not in the dispatched-marker set
 * (kind `implement`, AC6), sorted ascending by `sortIndex` (wl next
 * priority order preserved). Returns null when no candidate qualifies
 * (or the list is empty).
 *
 * Belt-and-suspenders client-side guard (AC1): even though `wl next
 * --risk medium --effort medium` filters server-side, the herdr tier verifies
 * the thresholds again so a malformed/absent server filter can never
 * dispatch a Medium+/Large+ item.
 */
export function selectImplementCandidate(
  candidates: ImplementCandidate[],
  dispatchedItemIds?: ReadonlySet<string>,
  registry?: RoundRobinRegistry,
): ImplementCandidate | null {
  const filtered = candidates
    .filter((c) => c.status === 'open')
    .filter((c) => {
      const risk = riskOrdinal(c.risk);
      if (risk === null || risk > 2) return false; // risk ≤ Medium (1=Low, 2=Medium)
      const effort = effortOrdinal(c.effort);
      if (effort === null || effort > 3) return false; // effort ≤ Medium (1=XS, 2=S, 3=M)
      return true;
    })
    // Exclude items needing producer review (parent WL-0MTIAL65N004T22F AC1).
    .filter((c) => c.needsProducerReview !== true)
    .filter((c) => !(dispatchedItemIds?.has(c.id) ?? false))
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  return selectWithRotation(filtered, registry);
}

/**
 * Turn a parsed implement candidate into a dispatachable `DowntimeCandidate`
 * (stage `implement`) for the implement tier.
 */
export function toImplementCandidate(candidate: ImplementCandidate): DowntimeCandidate {
  return {
    id: candidate.id,
    title: candidate.title,
    stage: 'implement',
    needsProducerReview: candidate.needsProducerReview,
  };
}

// ── Plan/intake selection (RCA WL-0MSRBFFLN005W3VT RC-2 + amplifier) ──

/**
 * Select the next plan/intake candidate from parsed `wl next` batch output:
 * the first candidate that is `status === 'open'` (client-side guard — `wl
 * next --stage X` keeps completed items under a stage filter, so without it
 * a completed/in_review item whose stage matches could be dispatched),
 * excluding candidates in the dispatched-marker change-guard map (id →
 * stage at dispatch): a candidate is excluded while it is still at its
 * dispatched-at stage; a stage advancement (or any stage differing from the
 * recorded one) releases it. Sorted ascending by `sortIndex` (wl next
 * priority order preserved). Returns null when no candidate qualifies.
 *
 * Missing `status` never qualifies (fail-closed: an item whose state cannot
 * be verified is not dispatched) — `parseNextCandidatesOutput` always
 * carries the status from the enriched workItem.
 */
export function selectNextCandidate(
  candidates: DowntimeCandidate[],
  dispatchedStages?: ReadonlyMap<string, string>,
  registry?: RoundRobinRegistry,
): DowntimeCandidate | null {
  const filtered = candidates
    .filter((c) => c.status === 'open')
    // Exclude items needing producer review (parent WL-0MTIAL65N004T22F AC1).
    .filter((c) => c.needsProducerReview !== true)
    .filter((c) => {
      const dispatchedAt = dispatchedStages?.get(c.id);
      // Exclude while still at the dispatched-at stage; a missing recorded
      // stage (legacy entry) never suppresses selection.
      return dispatchedAt === undefined || dispatchedAt !== c.stage;
    })
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  return selectWithRotation(filtered, registry);
}

// ── Critical-first selection (WL-0MT3FM8VA005XBHE, F2) ───────────────
// The critical-first pre-tier dispatches an open critical item at ANY
// stage (idea / intake_complete / plan_complete) with its stage-
// appropriate skill — ahead of EVERY non-critical candidate. Stage→skill
// mapping: idea → /skill:intake, intake_complete → /skill:plan,
// plan_complete → /skill:implement. Implement dispatch keeps the
// implement tier's risk/effort caps (decision Q2); every existing guard
// (CAS claim, dispatched-marker change-guard, single-flight) composes
// unchanged.

/**
 * An open critical work-item candidate, enumerated by
 * `wl list --priority critical --status open` (blocked items included —
 * `wl list` does not exclude dependency-blocked items). Carries the
 * worklog `stage` (needed for the stage→skill mapping), the client-side
 * `status` guard, and the risk/effort fields for the plan_complete caps
 * (decision Q2).
 */
export interface CriticalCandidate {
  id: string;
  title: string;
  /** Worklog status (`open` for selectable items; fail-closed on missing). */
  status: string;
  /** Worklog stage: idea | intake_complete | plan_complete | in_progress | … */
  stage: string;
  risk?: string;
  effort?: string;
  /** wl priority order preserved for deterministic selection. */
  sortIndex?: number;
  /** Worklog priority level (critical) — round-robin grouping key. */
  priority?: string;
  /**
   * Needs producer review flag (parent WL-0MTIAL65N004T22F): when `true`,
   * exclude from critical-tier selection and from dependency-frontier
   * resolution (AC1, AC2).
   */
  needsProducerReview?: boolean;
}

/**
 * Map a critical candidate's worklog stage to the dispatch skill kind.
 * Only dispatchable stages map: `idea` → `intake`, `intake_complete` →
 * `plan`, `plan_complete` → `implement`. Every other stage (in_progress,
 * in_review, completed, …) is NOT a critical-tier dispatch target and
 * maps to null (the tier falls through to the normal order).
 */
export function criticalSkillKind(stage: string): DowntimeSkillKind | null {
  if (stage === 'idea') return 'intake';
  if (stage === 'intake_complete') return 'plan';
  if (stage === 'plan_complete') return 'implement';
  return null;
}

/**
 * Parse the stdout of `wl list --priority critical --status open --json`
 * into typed critical candidates. Accepts the shape the CLI emits for a
 * batch (`{ workItems: [...] }`, flat entries carrying the enriched
 * workItem fields). Entries without an id are skipped; malformed JSON or
 * output without a workItems list yields null (fail-closed); an empty
 * list yields `[]` (a genuine empty critical tier).
 */
export function parseCriticalCandidatesOutput(stdout: string): CriticalCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items =
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { workItems?: unknown }).workItems)
      ? (parsed as { workItems: unknown[] }).workItems
      : null;
  if (items === null) return null;

  const candidates: CriticalCandidate[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    candidates.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '',
      status: typeof o.status === 'string' ? o.status : '',
      stage: typeof o.stage === 'string' ? o.stage : '',
      risk: typeof o.risk === 'string' ? o.risk : undefined,
      effort: typeof o.effort === 'string' ? o.effort : undefined,
      sortIndex: typeof o.sortIndex === 'number' && Number.isFinite(o.sortIndex) ? o.sortIndex : undefined,
      priority: typeof o.priority === 'string' ? o.priority : undefined,
      needsProducerReview:
        o.needsProducerReview !== undefined ? Boolean(o.needsProducerReview) : undefined,
    });
  }
  return candidates;
}

/**
 * Select the next critical-tier candidate from parsed wl list output:
 * the first open candidate at a dispatchable stage (idea /
 * intake_complete / plan_complete), with `plan_complete` gated by the
 * implement caps (risk ≤ Medium / effort ≤ Medium, decision Q2 — an
 * above-caps critical is never implement-dispatched by the downtime
 * worker), excluding candidates in the dispatched-marker change-guard
 * map (id → stage at dispatch — excluded while still at the dispatched-
 * at stage; a stage advancement releases it). Sorted ascending by
 * `sortIndex` (wl priority order) with round-robin tie-break within the
 * critical group (reused `selectWithRotation`; the rotation cursor keys
 * on the `critical` priority, so critical rotation never disturbs
 * non-critical tier cursors). Returns null when no candidate qualifies
 * (or the list is empty).
 */
export function selectCriticalCandidate(
  candidates: CriticalCandidate[],
  dispatchedStages?: ReadonlyMap<string, string>,
  registry?: RoundRobinRegistry,
): CriticalCandidate | null {
  const filtered = candidates
    .filter((c) => c.status === 'open')
    // Dispatchable stages only (idea / intake_complete / plan_complete).
    .filter((c) => criticalSkillKind(c.stage) !== null)
    // Caps retained (Q2): a plan_complete candidate must be risk ≤ Medium
    // / effort ≤ Medium to be implement-dispatched — same ordinal filter
    // semantics as selectImplementCandidate (fail-closed on unset).
    .filter((c) => {
      if (c.stage !== 'plan_complete') return true;
      const risk = riskOrdinal(c.risk);
      if (risk === null || risk > 2) return false; // risk ≤ Medium
      const effort = effortOrdinal(c.effort);
      if (effort === null || effort > 3) return false; // effort ≤ Medium
      return true;
    })
    // Exclude items needing producer review (parent WL-0MTIAL65N004T22F AC1).
    .filter((c) => c.needsProducerReview !== true)
    .filter((c) => {
      const dispatchedAt = dispatchedStages?.get(c.id);
      // Change-guard: exclude while still at the dispatched-at stage; a
      // missing recorded stage (legacy entry) never suppresses selection.
      return dispatchedAt === undefined || dispatchedAt !== c.stage;
    })
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  return selectWithRotation(filtered, registry);
}

/**
 * Parse the stdout of `wl dep list <id> --json` into the blocker refs of
 * the queried item: the outbound edges with direction `depends-on` (items
 * the queried item depends on — its blockers). Edge entries carry only
 * id/title/status/priority; the caller enriches via `wl show` when the
 * full stage/risk/effort/sortIndex fields are needed (frontier caps
 * check, Q2). Malformed JSON or output without an outbound edge list
 * yields null (fail-closed); an item with no outbound depends-on edges
 * yields `[]` (unblocked).
 */
export function parseDepListBlockersOutput(
  stdout: string,
): Array<{ id: string; title: string; status: string; priority?: string }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const outbound =
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { outbound?: unknown }).outbound)
      ? (parsed as { outbound: unknown[] }).outbound
      : null;
  if (outbound === null) return null;

  const blockers: Array<{ id: string; title: string; status: string; priority?: string }> = [];
  for (const raw of outbound as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    // Only dependency edges count as blockers (the item depends on them
    // and is therefore blocked by them).
    if (o.direction !== 'depends-on') continue;
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    blockers.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '',
      status: typeof o.status === 'string' ? o.status : '',
      priority: typeof o.priority === 'string' ? o.priority : undefined,
    });
  }
  return blockers;
}

/**
 * Parse the stdout of `wl show <id> --json` into a full critical
 * candidate (the shape the frontier resolution needs for its
 * stage→skill mapping and implement caps checks). Accepts the CLI's
 * single-item shape `{ workItem: {...} }` with the enriched fields.
 * Malformed output or a missing workItem yields null (fail-closed).
 */
export function parseShownWorkItem(stdout: string): CriticalCandidate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const raw =
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { workItem?: unknown }).workItem !== null &&
    (parsed as { workItem?: unknown }).workItem !== undefined
      ? (parsed as { workItem: Record<string, unknown> }).workItem
      : null;
  if (typeof raw !== 'object' || raw === null) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    status: typeof raw.status === 'string' ? raw.status : '',
    stage: typeof raw.stage === 'string' ? raw.stage : '',
    risk: typeof raw.risk === 'string' ? raw.risk : undefined,
    effort: typeof raw.effort === 'string' ? raw.effort : undefined,
    sortIndex: typeof raw.sortIndex === 'number' && Number.isFinite(raw.sortIndex) ? raw.sortIndex : undefined,
    priority: typeof raw.priority === 'string' ? raw.priority : undefined,
    needsProducerReview:
      raw.needsProducerReview !== undefined ? Boolean(raw.needsProducerReview) : undefined,
  };
}

/**
 * Parse the stdout of `wl show <id> --json` into a coordination item view
 * (`DowntimeItemInfo` — the leader's per-entry classification input).
 * Accepts the same `{ workItem: {...} }` single-item shape as
 * `parseShownWorkItem`, additionally capturing `updatedAt` and (when the
 * CLI serves it) `auditedAt` for the audit-tier freshness check. Malformed
 * output or a missing id yields null (fail-closed).
 */
export function parseShowItemOutput(stdout: string): DowntimeItemInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const raw =
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { workItem?: unknown }).workItem !== null &&
    (parsed as { workItem?: unknown }).workItem !== undefined
      ? (parsed as { workItem: Record<string, unknown> }).workItem
      : null;
  if (typeof raw !== 'object' || raw === null) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  const info: DowntimeItemInfo = {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    status: typeof raw.status === 'string' ? raw.status : undefined,
    stage: typeof raw.stage === 'string' ? raw.stage : undefined,
    priority: typeof raw.priority === 'string' ? raw.priority : undefined,
    risk: typeof raw.risk === 'string' ? raw.risk : undefined,
    effort: typeof raw.effort === 'string' ? raw.effort : undefined,
    auditedAt:
      typeof raw.auditedAt === 'string'
        ? raw.auditedAt
        : raw.auditedAt === null
          ? null
          : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    sortIndex: typeof raw.sortIndex === 'number' && Number.isFinite(raw.sortIndex) ? raw.sortIndex : undefined,
    needsProducerReview:
      raw.needsProducerReview !== undefined ? Boolean(raw.needsProducerReview) : undefined,
  };
  return info;
}

// ── Dependency frontier resolution (WL-0MT3FM8VA005XBHE, F3) ────────
// Decision Q3: when the selected critical candidate is dependency-blocked,
// the downtime worker follows the blocking chain to the nearest OPEN
// blocker and dispatches IT with the blocker's own stage-appropriate
// skill (the dependency frontier). Recursion walks while blockers are
// themselves dependency-blocked; a chain that bottoms in closed or
// non-dispatchable items yields null and the critical tier falls through
// to the normal tier order.

/**
 * Resolve the dependency frontier for a selected critical candidate
 * (decision Q3). When the candidate is dependency-blocked, follow the
 * blocking chain and return the nearest OPEN, dispatchable blocker — the
 * item to dispatch with its own stage-appropriate skill (a blocker at
 * idea → /skill:intake, intake_complete → /skill:plan, plan_complete →
 * /skill:implement with the implement caps applied to the blocker too,
 * Q2). Semantics:
 *
 * - Not dependency-blocked (no blockers under the candidate) → the
 *   candidate itself (dispatch it normally — no frontier redirect).
 * - A direct blocker that is open + dispatchable + within caps and not
 *   itself dependency-blocked → that blocker (nearest open blocker, in
 *   sortIndex order among direct blockers).
 * - A direct blocker that is open but itself dependency-blocked → recurse
 *   into its chain (the blocking chain is followed to the nearest open
 *   unblocked ancestor).
 * - A direct blocker at a non-dispatchable stage (in_progress,
 *   in_review) or above the implement caps → not itself a frontier target;
 *   if it has open blockers beneath, the recursion surfaces the deeper
 *   open ancestor, otherwise the chain bottoms.
 * - Chain bottoms in closed / non-dispatchable items, or a cycle (bounded
 *   recursion) → null: no dispatch from the critical tier, fall through to
 *   the normal tier order.
 * - The injected `fetchBlockers` resolves the blocker edges for an item
 *   (`wl dep list` outbound depends-on edges) and returns null on a wl
 *   failure — fail-closed: resolution yields null (no dispatch) rather
 *   than a silent wrong target.
 *
 * @param candidate The selected open critical candidate.
 * @param fetchBlockers Resolves the blockers of an item id (null = wl
 *   failure).
 * @param opts.maxDepth Upper bound on recursion depth (cycle guard).
 * @returns The frontier dispatch target, or null when the chain bottoms /
 *   cycles / the blocker lookup fails (fall through to normal tiers).
 */
export async function resolveDependencyFrontier(
  candidate: CriticalCandidate,
  fetchBlockers: (itemId: string) => Promise<CriticalCandidate[] | null>,
  opts: { maxDepth?: number } = {},
): Promise<CriticalCandidate | null> {
  const maxDepth = opts.maxDepth ?? 8;
  const visited = new Set<string>();

  /** Caps guard shared with selectCriticalCandidate (Q2 applies to blockers). */
  const dispatchable = (c: CriticalCandidate): boolean =>
    c.status === 'open' &&
    criticalSkillKind(c.stage) !== null &&
    // Exclude review-gated blockers (parent WL-0MTIAL65N004T22F AC2).
    c.needsProducerReview !== true &&
    (c.stage !== 'plan_complete' ||
      ((riskOrdinal(c.risk) ?? 9) <= 2 && (effortOrdinal(c.effort) ?? 9) <= 3));

  // Recursive walk: returns the nearest OPEN dispatchable blocker in the
  // chain beneath `item` (or the item itself when it is unblocked and
  // dispatchable). OPEN dispatchable blockers are tried first (nearest by
  // sortIndex); when an open blocker is itself dependency-blocked, its own
  // chain is walked before accepting it (an open blocker with open
  // descendants must not shadow a deeper unblocked ancestor). Non-
  // dispatchable blockers (in_progress / in_review / closed / capped) are
  // never dispatched themselves but their open descendants are still
  // surfaced by recursing through them. Cycles bottom the walk via
  // `visited` (bounded recursion, decision Q3).
  async function walk(item: CriticalCandidate, depth: number): Promise<CriticalCandidate | null> {
    if (visited.has(item.id) || depth > maxDepth) return null; // cycle / bound
    visited.add(item.id);
    const blockers = await fetchBlockers(item.id);
    if (blockers === null) return null; // wl failure → fail-closed
    if (blockers.length === 0) {
      // Not dependency-blocked: this item IS the frontier target, but only
      // when it is itself a dispatchable open item (a closed / in_progress
      // / in_review / capped leaf is never dispatched).
      return dispatchable(item) ? item : null;
    }
    const sorted = [...blockers].sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
    // 1) Nearest OPEN dispatchable blocker (recursing into its own chain
    //    when it is dependency-blocked).
    for (const blocker of sorted) {
      if (!dispatchable(blocker)) continue;
      const deeper = await walk(blocker, depth + 1);
      if (deeper !== null) return deeper;
    }
    // 2) No open blocker yielded a frontier — recurse through the non-
    //    dispatchable blockers (they may have open ancestors beneath).
    for (const blocker of sorted) {
      if (dispatchable(blocker)) continue;
      const deeper = await walk(blocker, depth + 1);
      if (deeper !== null) return deeper;
    }
    // Chain bottoms in closed / non-dispatchable / capped items → fall
    // through to the normal tier order.
    return null;
  }

  const blockers = await fetchBlockers(candidate.id);
  if (blockers === null) return null; // wl failure → fail-closed
  if (blockers.length === 0) return candidate; // not dependency-blocked
  return walk(candidate, 0);
}

// ── Settings clamps (implemented — wired into settings.ts by F2) ──────

/**
 * Clamp the downtime poll interval: never below the 10s hard floor, default
 * 10s for non-finite input (matches DEFAULT_DOWNTIME_POLL_INTERVAL_MS; the
 * spec's '30s proxy poll' refers to the 30s proxy status refresh).
 */
export function clampDowntimePollInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DOWNTIME_POLL_INTERVAL_MS;
  return Math.max(Math.round(value), DOWNTIME_POLL_INTERVAL_FLOOR_MS);
}

/**
 * Clamp the idle threshold: reject negative/non-finite (fall back to the
 * 60s default, DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS) and floor at 1s to
 * prevent immediate dispatch.
 */
export function clampDowntimeIdleThresholdMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS;
  return Math.max(Math.round(value), DOWNTIME_IDLE_THRESHOLD_FLOOR_MS);
}

/**
 * Clamp the required-free-slots count: a non-negative integer; 0 = all
 * slots. Negative/non-finite input falls back to 0 (all slots, the
 * strictest safe default).
 */
export function clampDowntimeRequiredFreeSlots(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS;
  return Math.round(value);
}

/**
 * Clamp the no-candidate cooldown: reject negative/non-finite (fall back to
 * the 60-minute default) and floor at 60s so the pause cannot be disabled or
 * set trivially small (WL-0MSI7DQL10016QYX).
 */
export function clampDowntimeNoCandidateCooldownMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS;
  return Math.max(Math.round(value), DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS);
}

// ── Round-robin helpers (WL-0MTJE0FXC006WAOX) ──────────────────────────

/** Internal tier-group entry: a CoordinationEntry paired with its dispatch info. */
type TierEntry = { entry: CoordinationEntry; info: DowntimeItemInfo; skill: DowntimeSkillKind };

/**
 * Sort a tier group by round-robin cursor order (WL-0MTJE0FXC006WAOX).
 *
 * Uses `loadRoundRobinCursor` (fail-open → `{}` → file order) to order
 * entries: unknown/new roots first (never penalised), known roots oldest
 * last-served first; stable sort preserves file order for timestamp ties.
 *
 * This is a pure sort — it does NOT advance the cursor. Advancement
 * happens only when the dispatched entry is consumed (every `removeEntry`
 * path).
 */
export function sortEntriesByRoundRobin(
  group: TierEntry[],
  coordinationDir: string,
): TierEntry[] {
  if (group.length <= 1) return group;

  // Load cursor state (fail-open → {}). No lock needed for read-only sort.
  const cursor = loadRoundRobinCursor(coordinationDir);

  // Stable sort: unknown roots first, then oldest known first.
  return [...group].sort((a, b) => {
    const rootA = a.entry.worklogRoot ?? a.entry.directory;
    const rootB = b.entry.worklogRoot ?? b.entry.directory;

    const aKnown = rootA in cursor;
    const bKnown = rootB in cursor;

    // Unknown roots sort before known roots.
    if (!aKnown && bKnown) return -1;
    if (aKnown && !bKnown) return 1;

    // Both known: oldest timestamp first (stable sort preserves file order for ties).
    if (aKnown && bKnown) {
      const tsA = new Date(cursor[rootA]).getTime();
      const tsB = new Date(cursor[rootB]).getTime();
      const diff = tsA - tsB;
      if (diff !== 0) return diff;
    }

    // Both unknown or timestamp tie: stable sort (preserve original file order).
    return 0;
  });
}

/**
 * Advance the round-robin cursor for a given root (WL-0MTJE0FXC006WAOX).
 *
 * Calls `advanceRoot` from the cursor module under the coordination lock.
 * Fail-open: lock contention or I/O error silently tolerates the missed
 * advance (the project will be selected sooner on the next cycle).
 *
 * This is called AFTER `removeEntry` on every consumed-entry path:
 * - critical tier dispatched
 * - critical tier spawn-failed / marker-write-failed
 * - non-critical tier dispatched
 * - non-critical tier spawn-failed / marker-write-failed
 */
export function advanceRoundRobinCursor(
  coordinationDir: string,
  root: string,
  now: number,
): void {
  if (root.length === 0) return;
  advanceRoot(coordinationDir, root, now);
}
