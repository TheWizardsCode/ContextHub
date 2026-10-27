/**
 * packages/herdr/src/downtime-worker.fixtures.ts — mock fixtures for the
 * downtime worker tests
 *
 * Covers every response class for `GET /llama/local/status` required by the
 * test contract (WL-0MSG7ZTC000163FL): idle (all slots free), busy (active
 * query / model switch / local lease / server down / not all slots free),
 * ambiguous (`total_slots` 0 or missing fields), and network error /
 * timeout / HTTP-failure responses for the poller tests (F2).
 *
 * Also hosts the shared test scaffolding (WL-0MV4V0V8Z003PBQ2): the
 * `makeDeps` mock factory, temporary-directory helpers, and downtime-log
 * writers, so every split test file imports one module instead of
 * re-implementing the same setup.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import { DOWNTIME_LOG_FILE } from './downtime-log.js';
import type {
  DowntimeWorkerDeps,
  LlamaStatus,
  LocalReservationGrantedBody,
  LocalReservationRefusedBody,
} from './downtime-worker.js';

// ── Status payloads ───────────────────────────────────────────────────

/** Every slot idle → the worker may dispatch freely (all-free availability signal). */
export const idleAllSlotsFree: LlamaStatus = {
  llama_server_running: true,
  local_active_query: false,
  model_switch_in_progress: false,
  local_lease_active: false,
  available_slots: 4,
  total_slots: 4,
  current_model: 'qwen3-8b',
  // Per-slot detail is the ONLY trusted availability source under the
  // fail-closed contract (WL-0MUXVPXAZ005RESW); an idle fixture therefore
  // carries a consistent all-free slot array.
  slots: [
    { slot_id: 'slot-1', is_processing: false },
    { slot_id: 'slot-2', is_processing: false },
    { slot_id: 'slot-3', is_processing: false },
    { slot_id: 'slot-4', is_processing: false },
  ],
  // Normalised owner-session list (WL-0MU88086A0089US4): always present on
  // the parsed status, empty when the proxy reports no owner.
  local_owner_session_ids: [],
};

/** A live query is queued on the proxy → slots effectively busy. */
export const busyActiveQuery: LlamaStatus = { ...idleAllSlotsFree, local_active_query: true };
/** A model switch is in progress → slots effectively busy. */
export const busyModelSwitch: LlamaStatus = { ...idleAllSlotsFree, model_switch_in_progress: true };
/** An in-flight local lease is held → slots effectively busy. */
export const busyLocalLease: LlamaStatus = { ...idleAllSlotsFree, local_lease_active: true };
/** The llama server is not running → nothing can be dispatched. */
export const busyServerNotRunning: LlamaStatus = { ...idleAllSlotsFree, llama_server_running: false };

/** available_slots < total_slots → busy with the default N=0 (all slots). */
export const busyNotAllSlotsFree: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 2,
  slots: [
    { slot_id: 'slot-1', is_processing: true },
    { slot_id: 'slot-2', is_processing: true },
    { slot_id: 'slot-3', is_processing: false },
    { slot_id: 'slot-4', is_processing: false },
  ],
};

/** `total_slots` 0 with everything else idle → ambiguous → busy. */
export const ambiguousZeroTotalSlots: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 0,
  total_slots: 0,
};

// ── Per-slot status payloads (WL-0MSG7P9N8009PCKG) ────────────────────

/** All 4 slots free, with per-slot identity served (LP-0MSG5TA7Y002GN39). */
export const perSlotAllFree: LlamaStatus = {
  ...idleAllSlotsFree,
  slots: [
    { slot_id: 'slot-1', is_processing: false },
    { slot_id: 'slot-2', is_processing: false },
    { slot_id: 'slot-3', is_processing: false },
    { slot_id: 'slot-4', is_processing: false },
  ],
};

/** Only 2 of 4 slots free (slot-3, slot-4 processing) with per-slot identity. */
export const perSlotTwoFree: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 2,
  slots: [
    { slot_id: 'slot-1', is_processing: false },
    { slot_id: 'slot-2', is_processing: false },
    { slot_id: 'slot-3', is_processing: true },
    { slot_id: 'slot-4', is_processing: true },
  ],
};

/** 3 of 4 slots free — only slot-1 processing. */
export const perSlotOneProcessing: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 3,
  slots: [
    { slot_id: 'slot-1', is_processing: true },
    { slot_id: 'slot-2', is_processing: false },
    { slot_id: 'slot-3', is_processing: false },
    { slot_id: 'slot-4', is_processing: false },
  ],
};

/**
 * 3 of 4 slots free — only slot-1 processing, with the GLOBAL query/lease
 * signals active (the processing slot IS the operator's active session;
 * spare-capacity dispatch must still fire into the 3 free slots).
 */
export const perSlotThreeOfFourFree: LlamaStatus = {
  ...perSlotOneProcessing,
  local_active_query: true,
  local_lease_active: true,
};

/**
 * 1 of 3 slots free (slot-3 free — the 3-slot proxy with an operator
 * session occupying a slot). Spare-capacity dispatch must NOT fire: N=2 of
 * 3 requires TWO slots continuously free (default N=2, parent AC1).
 */
export const perSlotOneOfThreeFree: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 1,
  total_slots: 3,
  slots: [
    { slot_id: 'slot-1', is_processing: true },
    { slot_id: 'slot-2', is_processing: true },
    { slot_id: 'slot-3', is_processing: false },
  ],
};

// ── Owner-lease / contention fixtures (WL-0MTYZXSLN008HZOW) ───────────

/**
 * A single-slot status that is IDLE but OWNED: the slot is not processing
 * yet a live Local Proxy lease is held (`owner_session_id`), so the slot
 * must NEVER be considered free for a new dispatch (AC2/AC5,
 * WL-0MTYZXSLN008HZOW).
 */
export const singleSlotIdleOwned: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 1,
  total_slots: 1,
  local_lease_active: true,
  local_owner_session_id: 'session-live-pane',
  local_owner_lease_remaining_seconds: 120,
  slots: [{ slot_id: 'slot-1', is_processing: false, owner_session_id: 'session-live-pane' }],
};

/**
 * Multi-slot status with an idle-but-owned slot: slot-1 is free by
 * `is_processing` but owned by a live lease, so only 2 of 3 slots are
 * genuinely free for dispatch.
 */
export const perSlotIdleOwned: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 3,
  total_slots: 3,
  local_lease_active: true,
  local_owner_session_id: 'session-live-pane',
  local_owner_lease_remaining_seconds: 120,
  slots: [
    { slot_id: 'slot-1', is_processing: false, owner_session_id: 'session-live-pane' },
    { slot_id: 'slot-2', is_processing: false },
    { slot_id: 'slot-3', is_processing: false },
  ],
};

/**
 * Multi-slot status where only ONE unowned slot is free: slot-1 is owned
 * (idle), slot-2 is processing, slot-3 is unowned-free. Per-slot mode with
 * N=2 must NOT be idle (only 1 genuinely free slot).
 */
export const perSlotOwnedOneUnowned: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 1,
  total_slots: 3,
  local_lease_active: true,
  local_owner_session_id: 'session-live-pane',
  local_owner_lease_remaining_seconds: 120,
  slots: [
    { slot_id: 'slot-1', is_processing: false, owner_session_id: 'session-live-pane' },
    { slot_id: 'slot-2', is_processing: true },
    { slot_id: 'slot-3', is_processing: false },
  ],
};

/**
 * Idle status where the proxy reports queued (contending) local requests:
 * the CURRENT queue depth (`contention_queue_depth`) is > 0, so the
 * dispatcher must back off (AC6, WL-0MTYZXSLN008HZOW).
 */
export const idleWithContention: LlamaStatus = {
  ...idleAllSlotsFree,
  contention_queue_depth: 3,
};

/**
 * The wedge regression fixture (WL-0MU1DWXO600153OI): the proxy's
 * CUMULATIVE `contention_queued_count` is > 0 (left over from past queue
 * events) while the LIVE `contention_queue_depth` is 0 (nothing queued
 * now) and the slot is free. The dispatcher must treat this as idle and
 * dispatch — the cumulative counter is telemetry only, never a gate.
 */
export const idleWithCumulativeContention: LlamaStatus = {
  ...idleAllSlotsFree,
  contention_queue_depth: 0,
  contention_queued_count: 13,
};

// ── Prefill serialisation gate fixtures (WL-0MVHSZRZQ00482QX) ─────────
//
// The llama-proxy serialises local prefills (LP-0MVGDUUV3001XFRJ) and
// publishes the gate state: `local_prefills_in_flight`,
// `local_max_concurrent_prefills`, `prefill_gate_waiters`, and the
// prefill-ETA guard's `queue_eta_seconds` / `prefill_budget_seconds`.
//
// `prefillPacingStatus()` builds a schema-v2 pool with the gate fields
// served; the named fixtures pin the individual pacing transitions so the
// parser, the pacing helper and the tick-level gates can share one shape.

// The proxy's ADVISORY occupancy/calibration terms
// (LP-0MVGDUV5E005UWBQ, `prefill_eta.py:status_estimate`): the wait behind
// OTHER prefills (`queue_eta_occupancy_seconds`), how many slots that wait is
// composed of (`queue_eta_busy_slots`) and whether the estimate has enough
// samples to be actionable (`prefill_eta_calibrated`). Declared on
// `LlamaStatus` (WL-0MVPUE4SE004QYUT); the regression fixtures and their
// witnesses landed test-first (WL-0MVPUDYHD000QI0K). Absent on a legacy proxy,
// so the factory injects them only when supplied.

/** `prefillPacingStatus` overrides: any `LlamaStatus` field (incl. the advisory terms). */
export type PrefillPacingOverrides = Partial<LlamaStatus>;

/**
 * Schema-v2 status with the prefill-gate fields served. Defaults: four
 * free/idle_leased slots, cap `1`, nothing in flight, no waiters, a 120 s
 * admission budget and a 0 s queue ETA — i.e. TODAY's behaviour (dispatch
 * admitted) with the new fields present. Override one field per fixture.
 */
export function prefillPacingStatus(overrides: PrefillPacingOverrides = {}): LlamaStatus {
  const {
    queue_eta_occupancy_seconds,
    queue_eta_busy_slots,
    prefill_eta_calibrated,
    ...statusOverrides
  } = overrides;
  const status: LlamaStatus = {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: true,
    available_slots: 0,
    total_slots: 4,
    status_schema_version: 2,
    capacity_hint: 'idle',
    local_prefills_in_flight: 0,
    local_max_concurrent_prefills: 1,
    prefill_gate_waiters: 0,
    prefill_budget_seconds: 120,
    queue_eta_seconds: 0,
    slots: [
      {
        slot_id: 'slot-1',
        is_processing: false,
        owner_session_id: 'sess-1',
        lease_state: 'idle_leased',
      },
      { slot_id: 'slot-2', is_processing: false, lease_state: 'free' },
      { slot_id: 'slot-3', is_processing: false, lease_state: 'free' },
      { slot_id: 'slot-4', is_processing: false, lease_state: 'free' },
    ],
    contention_queue_depth: 0,
    contention_queued_count: 0,
    ...statusOverrides,
  };
  // Advisory fields appear only when the fixture supplies them, so a fixture
  // built without them keeps the legacy (absent) shape byte-for-byte.
  if (queue_eta_occupancy_seconds !== undefined) {
    status.queue_eta_occupancy_seconds = queue_eta_occupancy_seconds;
  }
  if (queue_eta_busy_slots !== undefined) {
    status.queue_eta_busy_slots = queue_eta_busy_slots;
  }
  if (prefill_eta_calibrated !== undefined) {
    status.prefill_eta_calibrated = prefill_eta_calibrated;
  }
  return status;
}

/**
 * The serialisation cap is saturated: ONE prefill is in flight with a cap
 * of `1`, so the prefill capacity budget is `0` for this tick (three slots
 * remain genuinely free — the regression this item exists to fix).
 */
export const prefillCapReached: LlamaStatus = prefillPacingStatus({
  local_prefills_in_flight: 1,
  slots: [
    {
      slot_id: 'slot-1',
      is_processing: true,
      lease_state: 'generating',
      phase: 'prefill',
      prefill_eta_seconds: 45,
    },
    { slot_id: 'slot-2', is_processing: false, lease_state: 'free' },
    { slot_id: 'slot-3', is_processing: false, lease_state: 'free' },
    { slot_id: 'slot-4', is_processing: false, lease_state: 'free' },
  ],
});

/** Requests waiting on the proxy's prefill gate → contention evidence. */
export const prefillGateContended: LlamaStatus = prefillPacingStatus({
  prefill_gate_waiters: 2,
});

/** `queue_eta_seconds` (300 s) is above the 120 s admission budget. */
export const prefillQueueEtaOverBudget: LlamaStatus = prefillPacingStatus({
  queue_eta_seconds: 300,
});

/**
 * A per-slot prefill ETA (300 s) is above the 120 s budget while the
 * capacity headroom is still positive (cap `2`, one prefill in flight), so
 * only the ETA deferral can explain the paced tick.
 */
export const prefillSlotEtaOverBudget: LlamaStatus = prefillPacingStatus({
  local_max_concurrent_prefills: 2,
  local_prefills_in_flight: 1,
  slots: [
    {
      slot_id: 'slot-1',
      is_processing: true,
      lease_state: 'generating',
      phase: 'prefill',
      prefill_eta_seconds: 300,
    },
    { slot_id: 'slot-2', is_processing: false, lease_state: 'free' },
    { slot_id: 'slot-3', is_processing: false, lease_state: 'free' },
    { slot_id: 'slot-4', is_processing: false, lease_state: 'free' },
  ],
});

// ── Occupancy/calibration regression fixtures (WL-0MVPUDYHD000QI0K) ───
//
// Reconstructed from the leader's `prefill-eta` decision records in
// `.worklog/downtime-coordination.log` (parent WL-0MVPRZU0A000TSWD): the
// dispatcher deferred every tick with `capacityHint: idle`, `freeSlots 2/2`,
// `prefillsInFlight: 0`, `prefillGateWaiters: 0`, `queueEtaSeconds: 97.5`,
// `prefillBudgetSeconds: 60`, `queueEtaOccupancySeconds: 0`,
// `queueEtaBusySlots: 0`, `prefillEtaCalibrated: false`.

/**
 * The incident pool: TWO slots, both genuinely free, nothing prefilling, no
 * gate waiters, and an UNCALIBRATED proxy whose 97.5 s queue ETA is the
 * newcomer's OWN cold prefill against a 60 s admission budget. Deferring on
 * it is the livelock this parent exists to fix (never dispatch ⇒ never
 * calibrate ⇒ stay pessimistic). Occupancy terms are zero, so the whole ETA
 * is the own-prefill cost.
 */
export const prefillIdleUncalibrated: LlamaStatus = prefillPacingStatus({
  local_active_query: false,
  local_lease_active: false,
  available_slots: 2,
  total_slots: 2,
  capacity_hint: 'idle',
  local_prefills_in_flight: 0,
  local_max_concurrent_prefills: 1,
  prefill_gate_waiters: 0,
  prefill_budget_seconds: 60,
  queue_eta_seconds: 97.5,
  queue_eta_occupancy_seconds: 0,
  queue_eta_busy_slots: 0,
  prefill_eta_calibrated: false,
  slots: [
    { slot_id: 'slot-1', is_processing: false, lease_state: 'free' },
    { slot_id: 'slot-2', is_processing: false, lease_state: 'free' },
  ],
});

/**
 * The same idle pool on a CALIBRATED proxy, isolating the occupancy rule from
 * the calibration prerequisite: `queue_eta_seconds` is high (300 s) but no
 * slot is busy and the occupancy terms are zero, so the ETA is entirely the
 * newcomer's own prefill and must never defer dispatch.
 */
export const prefillIdleZeroOccupancy: LlamaStatus = prefillPacingStatus({
  ...prefillIdleUncalibrated,
  queue_eta_seconds: 300,
  prefill_eta_calibrated: true,
});

/**
 * The LEGACY twin of the incident pool (parent AC4, this item AC4): a
 * pre-feature proxy that publishes NONE of the prefill-gate fields — no cap,
 * no gate counters, no `queue_eta_seconds` / `prefill_budget_seconds`, and
 * none of the advisory occupancy/calibration terms
 * (`queue_eta_occupancy_seconds`, `queue_eta_busy_slots`,
 * `prefill_eta_calibrated`) — on the same idle 2-slot pool. An absent
 * ETA/budget/calibration flag never blocks dispatch: the tick keeps exactly
 * today's free-slot-only budget, erring towards dispatch.
 */
export const prefillLegacyIdlePool: LlamaStatus = {
  ...idleAllSlotsFree,
  available_slots: 2,
  total_slots: 2,
  slots: [
    { slot_id: 'slot-1', is_processing: false },
    { slot_id: 'slot-2', is_processing: false },
  ],
};

/**
 * A genuinely contended pool: one slot is prefilling and the newcomer's wait
 * behind it (`queue_eta_occupancy_seconds`) is 300 s — well above the 60 s
 * admission budget — while the capacity headroom is still positive (cap `2`,
 * one in flight), so only the occupancy ETA can explain a paced tick. The
 * busy slot deliberately carries NO per-slot `prefill_eta_seconds`, so the
 * retained `prefill-eta` deferral must come from the occupancy term.
 */
export const prefillBusyOccupancy: LlamaStatus = prefillPacingStatus({
  local_active_query: true,
  available_slots: 1,
  total_slots: 2,
  capacity_hint: 'prefill_bound',
  local_prefills_in_flight: 1,
  local_max_concurrent_prefills: 2,
  prefill_gate_waiters: 0,
  prefill_budget_seconds: 60,
  queue_eta_seconds: 320,
  queue_eta_occupancy_seconds: 300,
  queue_eta_busy_slots: 1,
  prefill_eta_calibrated: true,
  slots: [
    { slot_id: 'slot-1', is_processing: true, lease_state: 'generating', phase: 'prefill' },
    { slot_id: 'slot-2', is_processing: false, lease_state: 'free' },
  ],
});

/**
 * Idle status that ALSO serves the prefill-serialisation counters needed to
 * judge a one-per-idle-window launch (parent WL-0MVIKRFP0005JDL8, slice C3).
 * Defaults model the serialised proxy: four free slots, nothing prefilling,
 * cap `1`. Override one field per scenario (e.g. raise `cap` to model a
 * proxy that would otherwise admit a second concurrent launch, or keep
 * `local_prefills_in_flight` at `0` to model the STALE status that follows a
 * launch before the new pane's prefill registers).
 */
export function launchWindowStatus(overrides: Partial<LlamaStatus> = {}): LlamaStatus {
  return {
    ...idleAllSlotsFree,
    local_prefills_in_flight: 0,
    local_max_concurrent_prefills: 1,
    prefill_gate_waiters: 0,
    ...overrides,
  };
}

/** Raw `herdr pane list` output with two live downtime panes + noise. */
export const herdrPaneListRaw: string = JSON.stringify({
  id: 'cli:pane:list',
  result: {
    panes: [
      {
        pane_id: 'w1:p1',
        label: 'Downtime triggered implement Some item - WL-ABC',
        agent: 'pi',
        agent_status: 'working',
      },
      {
        pane_id: 'w1:p2',
        label: 'Downtime triggered audit Another item - WL-DEF',
        agent: 'pi',
        agent_status: 'idle',
      },
      {
        pane_id: 'w1:p3',
        label: 'Manually triggered implement Foo - WL-XYZ',
        agent: 'pi',
        agent_status: 'working',
      },
      { pane_id: 'w1:p4', label: 'Work Items', agent_status: 'unknown' },
      {
        pane_id: 'w1:p5',
        label: 'Downtime triggered plan Finished - WL-GHI',
        agent: 'pi',
        agent_status: 'done',
      },
    ],
  },
});

/** Raw (unparsed) response missing the numeric slot fields → ambiguous. */
export const ambiguousMissingFieldsRaw: Record<string, unknown> = {
  llama_server_running: true,
  current_model: 'qwen3-8b',
};

/** Shape of the fixture used to stub the parsed proxy status in worker tests. */
export interface LlamaStatusFixture {
  name: string;
  status: LlamaStatus;
  /** Expected classification with requiredFreeSlots = 0 (all slots). */
  expectedIdle: boolean;
  note: string;
}

/** The corpus used by the fixture-coherence test. */
export const statusFixtures: LlamaStatusFixture[] = [
  {
    name: 'idle: all slots free',
    status: idleAllSlotsFree,
    expectedIdle: true,
    note: 'server up, no query/switch/lease, all 4/4 slots free',
  },
  {
    name: 'busy: local active query',
    status: busyActiveQuery,
    expectedIdle: false,
    note: 'local_active_query true',
  },
  {
    name: 'busy: model switch in progress',
    status: busyModelSwitch,
    expectedIdle: false,
    note: 'model_switch_in_progress true',
  },
  {
    name: 'busy: local lease active',
    status: busyLocalLease,
    expectedIdle: false,
    note: 'local_lease_active true',
  },
  {
    name: 'busy: server not running',
    status: busyServerNotRunning,
    expectedIdle: false,
    note: 'llama_server_running false',
  },
  {
    name: 'busy: not all slots free',
    status: busyNotAllSlotsFree,
    expectedIdle: false,
    note: 'available 2 < total 4 → busy with N=0 (all slots)',
  },
  {
    name: 'ambiguous: total_slots 0',
    status: ambiguousZeroTotalSlots,
    expectedIdle: false,
    note: 'total_slots 0 → ambiguous → busy',
  },
];

// ── Reservation handshake fixtures (parent WL-0MVIKRFP0005JDL8, slice C1) ──
//
// The reserve handshake (`POST /llama/local/reserve`) is pinned by
// `downtime-worker.reserve.test.ts` before any client exists. One fixture per
// real response class the proxy may produce: granted ticket, `429` refusal,
// endpoint absent, server error and timeout — so no contract test needs an
// ad-hoc inline response object (C1-AC2).

/**
 * A mocked reserve-handshake response: the HTTP status the caller observed
 * plus the parsed body. `status: 0` models "no response at all" (timeout /
 * network abort) — the fail-open path an older or unreachable proxy takes.
 */
export interface LocalReservationHttpFixture<Body = unknown> {
  status: number;
  body: Body;
}

/**
 * Granted ticket (`2xx`): the gate ticket id and its TTL in seconds. Override
 * any field to model an alias rename or an invalid variant the tolerant
 * parser must reject.
 */
export function reserveGranted(
  overrides: Record<string, unknown> = {},
): LocalReservationHttpFixture<LocalReservationGrantedBody> {
  return {
    status: 200,
    body: { ticket_id: 'tkt-granted-1', ttl_s: 30, ...overrides },
  };
}

/**
 * Refused ticket (`429`): `{ reason, retry_after_s }`. The dispatcher must
 * defer by `retry_after_s` and record the reason instead of launching.
 */
export function reserveRefused429(
  overrides: Record<string, unknown> = {},
): LocalReservationHttpFixture<LocalReservationRefusedBody> {
  return {
    status: 429,
    body: { reason: 'prefill-gate', retry_after_s: 12, ...overrides },
  };
}

/** Older proxy with no reserve handler → `404`, no body → fail open to null. */
export const reserveEndpointAbsent: LocalReservationHttpFixture<null> = {
  status: 404,
  body: null,
};

/** The proxy failed on the reserve path → `500`, no body → fail open to null. */
export const reserveServerError: LocalReservationHttpFixture<null> = {
  status: 500,
  body: null,
};

/** The call timed out or was aborted → no HTTP status, no body → fail open. */
export const reserveTimeout: LocalReservationHttpFixture<null> = {
  status: 0,
  body: null,
};

// ── HTTP response / error fixtures (poller tests, F2) ─────────────────

/**
 * Minimal structural Response for the poller contract (the DOM `Response`
 * type is not part of this project's tsconfig lib). Node's real `Response`
 * satisfies the shape at runtime.
 */
export interface LlamaStatusHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Build a minimal fetch-style `Response` double returning the given body. */
export function jsonResponseFixture(body: unknown, status = 200): LlamaStatusHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** A non-2xx `Response` double for error-path tests. */
export const httpErrorResponseFixture: LlamaStatusHttpResponse = jsonResponseFixture(
  { error: 'boom' },
  500,
);

/** fetch() rejecting (connection refused / DNS failure). */
export const networkErrorFixture: Error = Object.assign(new Error('fetch failed'), {
  name: 'TypeError',
});

/** fetch() aborting on timeout. */
export const timeoutErrorFixture: Error = Object.assign(
  new Error('The operation was aborted'),
  { name: 'AbortError' },
);

// ── Shared test scaffolding (WL-0MV4V0V8Z003PBQ2) ─────────────────────

// ── Per-test mock budget (WL-0MV4VSNI00002WFM) ────────────────────────
//
// The split downtime-worker suite allows at most **5** `vi.fn()` calls per
// `it()`/`test()` block. The ~20 mocks `makeDeps()` creates are shared
// infrastructure and are excluded — the budget bounds the *per-test
// overrides* a reader must hold in their head, which is where the original
// 13k-line file's 664 mocks came from.
//
// Rationale: analysis of the 718 split tests found an average of ~5.2 mocks
// per original describe block and a maximum of 6 per test. A cap of 5 keeps
// every focused test green while forcing genuinely overloaded tests to
// extract setup (the two original 6-mock tests now share a helper instead).
//
// Enforcement: `npm run test:mock-budget` (`scripts/check-mock-budget.ts`,
// Option B of the intake) parses each `downtime-worker*.test.ts` with the
// TypeScript compiler API and fails when any test exceeds the cap. The same
// check runs in the unit suite (`tests/unit/mock-budget.test.ts`), so it is
// part of the normal test gate. Extract extra setup into this module (or a
// local helper) rather than raising the cap.

/**
 * Default mocked `DowntimeWorkerDeps` for dispatch tests, with every dep
 * answering a neutral "nothing to do" result so a test only overrides the
 * dep it exercises. Merges `overrides` over the defaults (last write wins).
 */
export function makeDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    // Herdr list head (WL-0MTK1ILM2009QYB2): empty by default so legacy tests that
    // stub per-tier lookups keep passing (the head path is inert on empty).
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Audit tier answers a GENUINELY empty tier by default ({ok:true,
    // candidate:null}); a wl/parse failure is {ok:false} (WL-0MSLWJ2KP0002SV0).
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Active-audit single-flight (WL-0MT3PHW4I002SNOV): no active audit by
    // default ({ok:true, active:false}), so the existing tier tests exercise
    // the unchanged audit tier (backward-compatible default — the audit
    // tier proceeds). The dispatcher consults this dep only after F2 lands;
    // existing tests are unaffected either way.
    getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    // Claim rollback (WL-0MT32F908002YFFA): default success so the recovery
    // paths report 'claim-rolled-back' unless a test forces a failed rollback.
    rollbackClaim: vi.fn().mockResolvedValue(true),
    recordError: vi.fn().mockResolvedValue(undefined),
    // Scheduled-prompts tier (WL-0MSS1Q5ER007QDKX): no due prompt by
    // default, so existing tier tests exercise the unchanged backlog tiers.
    getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
    recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
    // Critical-first tier (WL-0MT3FM8VA005XBHE): no critical candidate by
    // default, so the existing tier tests exercise the unchanged backlog
    // tiers (regression guard — after F4 the critical tier must fall
    // through to implement → plan → intake when the critical tier is
    // genuinely empty).
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Code-freeze gate (WL-0MSQ0RPQP00636JY): not frozen by default, so
    // existing dispatch tests exercise the unchanged audit/implement tiers.
    readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
    // Interim freshness re-check (WL-0MT8KSTOE00871E7): no fresh audit by
    // default, so existing dispatch tests exercise the unchanged path.
    hasFreshAudit: vi.fn().mockResolvedValue(false),
    // Review-queue depth gate (WL-0MT2UQWOR007CYY9): empty queue by default
    // so the gate is inactive and existing tests exercise the unchanged path.
    getReviewQueueCount: vi.fn().mockResolvedValue(0),
    // Item-scoped in-flight guard (WL-0MUBEZ6PE002WLP4 / F3): an available
    // query reporting NO live panes by default, so the guard is inert and
    // existing tests escalate critical items unchanged. Tests that exercise
    // the guard override this with `records` carrying a live working pane.
    getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
    ...overrides,
  };
}

/**
 * Create a unique temporary directory under the OS temp root, prefixed with
 * `prefix`. The caller owns cleanup; prefer `createTempDirTracker()` when a
 * describe block creates several directories.
 */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Registry returned by `createTempDirTracker()`. */
export interface TempDirTracker {
  /** Create, remember and return a new unique temp directory. */
  make(prefix: string): string;
  /** Remove every directory created by this tracker (idempotent). */
  cleanup(): void;
}

/**
 * Per-describe temporary-directory registry: `make()` creates a unique temp
 * directory and records it, `cleanup()` removes them all (call it from
 * `afterEach`). Centralises the `mkdtempSync` + `rmSync` boilerplate that was
 * duplicated across describe blocks.
 */
export function createTempDirTracker(): TempDirTracker {
  const dirs: string[] = [];
  return {
    make(prefix: string): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup(): void {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * ISO timestamp for a moment `ms` milliseconds in the past. Dispatch paths
 * read the real `Date.now()`, so tests that seed dispatch markers use this
 * rather than a fake clock.
 */
export function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/**
 * Write a raw string to the downtime dispatch log at
 * `<cwd>/.worklog/<DOWNTIME_LOG_FILE>`, creating the `.worklog` directory
 * when absent.
 */
export function writeRawDowntimeLog(cwd: string, raw: string): void {
  mkdirSync(join(cwd, '.worklog'), { recursive: true });
  writeFileSync(join(cwd, '.worklog', DOWNTIME_LOG_FILE), raw, 'utf8');
}

/**
 * Write `entries` to the downtime dispatch log as JSONL (one JSON object per
 * line, trailing newline), creating the `.worklog` directory when absent.
 */
export function writeDowntimeLog(cwd: string, entries: Array<Record<string, unknown>>): void {
  writeRawDowntimeLog(cwd, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
