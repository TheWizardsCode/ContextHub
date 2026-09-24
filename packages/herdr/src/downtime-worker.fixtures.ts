/**
 * packages/herdr/src/downtime-worker.fixtures.ts — mock fixtures for the
 * downtime worker tests
 *
 * Covers every response class for `GET /llama/local/status` required by the
 * test contract (WL-0MSG7ZTC000163FL): idle (all slots free), busy (active
 * query / model switch / local lease / server down / not all slots free),
 * ambiguous (`total_slots` 0 or missing fields), and network error /
 * timeout / HTTP-failure responses for the poller tests (F2).
 */

import type { LlamaStatus } from './downtime-worker.js';

// ── Status payloads ───────────────────────────────────────────────────

export const idleAllSlotsFree: LlamaStatus = {
  llama_server_running: true,
  active_query: false,
  local_active_query: false,
  model_switch_in_progress: false,
  local_lease_active: false,
  available_slots: 4,
  total_slots: 4,
  current_model: 'qwen3-8b',
};

export const busyActiveQuery: LlamaStatus = { ...idleAllSlotsFree, local_active_query: true };
export const busyModelSwitch: LlamaStatus = { ...idleAllSlotsFree, model_switch_in_progress: true };
export const busyLocalLease: LlamaStatus = { ...idleAllSlotsFree, local_lease_active: true };
export const busyServerNotRunning: LlamaStatus = { ...idleAllSlotsFree, llama_server_running: false };

/** available_slots < total_slots → busy with the default N=0 (all slots). */
export const busyNotAllSlotsFree: LlamaStatus = { ...idleAllSlotsFree, available_slots: 2 };

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
  active_query: true,
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

export function jsonResponseFixture(body: unknown, status = 200): LlamaStatusHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

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
