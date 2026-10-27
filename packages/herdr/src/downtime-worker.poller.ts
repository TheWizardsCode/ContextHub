/**
 * packages/herdr/src/downtime-worker.poller.ts — downtime-worker local-status
 * poller.
 *
 * Single responsibility: fetch one `GET {proxyUrl}/llama/local/status`
 * payload with a per-poll timeout, parse it fail-closed (schema-v2 slot,
 * lease and advisory fields included) and expose the single-flight poller
 * the worker ticks against.
 *
 * Moved verbatim out of `downtime-worker.ts` (parent WL-0MVF3F9A7000HKP7;
 * child WL-0MVLIHY1P002WP0D). No behaviour change: parsing tolerances, the
 * fail-closed `null` (busy) outcomes, the per-poll timeout and the
 * single-flight semantics are unchanged.
 *
 * Layering: imports only `./downtime-worker.types.js` (types are erased at
 * runtime) and `./downtime-worker.constants.js` (`DOWNTIME_STATUS_PATH`);
 * never the barrel (`downtime-worker.ts`) and never `./stalled-work.js`, so
 * no runtime cycle can form.
 */

import { DOWNTIME_STATUS_PATH } from './downtime-worker.constants.js';
import type {
  DowntimePoller,
  LlamaCapacityHint,
  LlamaSlot,
  LlamaSlotLeaseState,
  LlamaSlotPhase,
  LlamaStatus,
  LlamaStatusFetcher,
} from './downtime-worker.types.js';

// ── Poller (implemented — F2) ────────────────────────────────────────


/** Per-poll timeout: an unresponsive proxy must fail closed, not hang. */
export const DEFAULT_DOWNTIME_POLL_TIMEOUT_MS = 5_000;

/**
 * Parse an optional non-negative finite count from a proxy payload.
 * Returns `undefined` when absent (backward compatible), and `null` when
 * malformed/negative (ambiguous → the caller fails closed to busy).
 */
/**
 * True for an HTTP(S) URL element of the proxy's owner array. The live proxy
 * serves `local_owner_session_id` as `["http://localhost:8080", "<session>"]`
 * where the first element is its own base URL, NOT an owner session.
 */
function isOwnerUrlElement(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Normalise `local_owner_session_id` into the FULL list of owner session ids,
 * accepting both the legacy string form and the current array form
 * `["http://localhost:8080", "herdr-<session>"]`.
 *
 * Array elements that are HTTP(S) URLs (the proxy's own base URL) are not
 * owners and are dropped; every non-empty non-URL string element is retained
 * so a multi-owner payload is never silently truncated (contributing cause 1
 * of RCA WL-0MU87ZGPP0029V28). A legacy string yields a single-element array.
 * Malformed input (number, object, `null`, array of non-strings) yields `[]`
 * — fail-closed, never throws.
 *
 * (WL-0MU88086A0089US4 — parse array local_owner_session_id from llama-proxy)
 */
function parseLocalOwnerSessionIds(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (Array.isArray(value)) {
    return value.filter(
      (el): el is string =>
        typeof el === 'string' && el.length > 0 && !isOwnerUrlElement(el),
    );
  }
  return [];
}

/**
 * The first (primary) owner session id — kept for compatibility with existing
 * call sites (`local_lease_active` derivation). Returns
 * `undefined` when no owner session is reported. See
 * {@link parseLocalOwnerSessionIds}.
 */
function parseLocalOwnerSessionId(value: unknown): string | undefined {
  return parseLocalOwnerSessionIds(value)[0];
}

function parseOptionalCount(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** Schema-v2 enum vocabularies (LP-0MVGDUVGE0024YAI). */
const LEASE_STATES: ReadonlySet<string> = new Set(['generating', 'idle_leased', 'free']);
const CAPACITY_HINTS: ReadonlySet<string> = new Set(['idle', 'prefill_bound', 'saturated']);
const SLOT_PHASES: ReadonlySet<string> = new Set(['prefill', 'decode']);

/**
 * Parse an optional schema-v2 ADVISORY number (ETA / prompt progress).
 * Absent → undefined; explicit null → null (the proxy's "not computable"
 * marker); malformed → undefined. Advisory fields must never reject an
 * otherwise usable poll.
 */
function parseAdvisoryNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** As {@link parseAdvisoryNumber} but for integer counters (context tokens). */
function parseAdvisoryInteger(value: unknown): number | null | undefined {
  const parsed = parseAdvisoryNumber(value);
  return typeof parsed === 'number' && !Number.isInteger(parsed) ? undefined : parsed;
}

/**
 * Parse an optional ADVISORY boolean (prefill calibration flag). Absent →
 * undefined; explicit null → null (the proxy's "not computable" marker,
 * mirroring {@link parseAdvisoryNumber}); malformed (non-boolean) →
 * undefined. Advisory fields must never reject an otherwise usable poll.
 */
function parseAdvisoryBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'boolean') return undefined;
  return value;
}

/**
 * Parse an optional operator-facing ISO timestamp (last local activity).
 * Absent, explicit null and malformed values (non-string, empty, unparseable)
 * all degrade to `undefined` — these fields are evidence only and must never
 * reject an otherwise usable poll (WL-0MVHSZR9C0012NQY).
 */
function parseAdvisoryTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

/** Parse an optional non-empty evidence label (activity source). */
function parseAdvisoryLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

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
    const ownerSession = parseLocalOwnerSessionId(o.local_owner_session_id);
    const leaseSeconds = o.local_owner_lease_remaining_seconds;
    localLeaseActive =
      (ownerSession !== undefined) ||
      (typeof leaseSeconds === 'number' && Number.isFinite(leaseSeconds) && leaseSeconds > 0);
  }

  // Optional degradation flag (LP-0MSVP7XJ6008QPKX): absent on pre-feature
  // proxies. A malformed (non-boolean) value is ambiguous → null (busy,
  // fail-closed), matching the other optional flags. When true the per-slot
  // `slots` detail is unusable (WL-0MUFP30T2003OX1F).
  let slotsStale: boolean | undefined;
  if (o.slots_stale !== undefined) {
    if (typeof o.slots_stale !== 'boolean') return null;
    slotsStale = o.slots_stale;
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
      // Per-slot owner (AC5, WL-0MTYZXSLN008HZOW): OPTIONAL — absent on
      // pre-feature proxies. A non-empty string or finite positive lease
      // means the slot is owned; null/undefined/empty means unowned.
      // Malformed owner values are treated as absent (fail-safe: an
      // unreadable owner must not spuriously mark a free slot busy).
      let ownerSessionId: string | null = null;
      if (typeof slot.owner_session_id === 'string' && slot.owner_session_id.length > 0) {
        ownerSessionId = slot.owner_session_id;
      }
      // Schema v2 (LP-0MVGDUVGE0024YAI): `lease_state` is AVAILABILITY-
      // affecting and fail-closed when malformed/unknown (ambiguous →
      // null/busy). `phase`, `context_tokens` and `prefill_eta_seconds` are
      // advisory and degrade to undefined instead of rejecting the poll.
      let leaseState: LlamaSlotLeaseState | undefined;
      if (slot.lease_state !== undefined) {
        if (typeof slot.lease_state !== 'string' || !LEASE_STATES.has(slot.lease_state)) {
          return null;
        }
        leaseState = slot.lease_state as LlamaSlotLeaseState;
      }
      let phase: LlamaSlotPhase | null | undefined;
      if (slot.phase === null) {
        phase = null;
      } else if (typeof slot.phase === 'string' && SLOT_PHASES.has(slot.phase)) {
        phase = slot.phase as LlamaSlotPhase;
      }
      const contextTokens = parseAdvisoryInteger(slot.context_tokens);
      const prefillEta = parseAdvisoryNumber(slot.prefill_eta_seconds);
      const parsedSlot: LlamaSlot = {
        slot_id: slotId,
        is_processing: slot.is_processing,
      };
      if (ownerSessionId !== null) parsedSlot.owner_session_id = ownerSessionId;
      if (leaseState !== undefined) parsedSlot.lease_state = leaseState;
      if (phase !== undefined) parsedSlot.phase = phase;
      if (contextTokens !== undefined) parsedSlot.context_tokens = contextTokens;
      if (prefillEta !== undefined) parsedSlot.prefill_eta_seconds = prefillEta;
      parsed.push(parsedSlot);
    }
    slots = parsed;
  }

  // Schema-v2 truthful capacity (LP-0MVGDUVGE0024YAI): version, pool
  // summary and admission budget. `capacity_hint` is availability-affecting
  // (fail-closed when malformed); the version and budget are advisory.
  let statusSchemaVersion: number | undefined;
  if (o.status_schema_version !== undefined) {
    if (
      typeof o.status_schema_version === 'number' &&
      Number.isInteger(o.status_schema_version) &&
      o.status_schema_version >= 0
    ) {
      statusSchemaVersion = o.status_schema_version;
    }
  }
  let capacityHint: LlamaCapacityHint | undefined;
  if (o.capacity_hint !== undefined) {
    if (typeof o.capacity_hint !== 'string' || !CAPACITY_HINTS.has(o.capacity_hint)) {
      return null;
    }
    capacityHint = o.capacity_hint as LlamaCapacityHint;
  }
  const prefillBudget = parseAdvisoryNumber(o.prefill_budget_seconds);

  // Proxy-authoritative local idle age (LP-0MVGD9Z8Z0055Y5J,
  // WL-0MVHSZR9C0012NQY). ABSENT on pre-feature proxies → every field stays
  // undefined and the worker falls back to its own idle tracker exactly as
  // before. All three are ADVISORY in the fail-closed sense: a malformed
  // value degrades to `undefined` (backward-compatible fallback) instead of
  // rejecting an otherwise usable poll. `reportedIdleSeconds` additionally
  // rejects non-finite/negative ages, so a bad age can never read as
  // "idle forever".
  const parsedIdleSeconds = parseAdvisoryNumber(o.local_idle_seconds);
  const localIdleSeconds =
    typeof parsedIdleSeconds === 'number' ? parsedIdleSeconds : undefined;
  const localLastActivityAt = parseAdvisoryTimestamp(o.local_last_activity_at);
  const localLastActivitySource = parseAdvisoryLabel(o.local_last_activity_source);

  // Optional contention metrics (AC6, WL-0MTYZXSLN008HZOW): ABSENT on
  // pre-feature proxies → undefined (treated as 0, no contention evidence).
  // A malformed (non-finite / negative) value is ambiguous → null (busy,
  // fail-closed): contention must never be silently under-reported.
  //
  // `contention_queue_depth` is the LIVE depth and the SOLE gate signal;
  // `contention_queued_count` is the CUMULATIVE counter (telemetry only —
  // it must never gate dispatch, WL-0MU1DWXO600153OI).
  const contentionQueueDepth = parseOptionalCount(o.contention_queue_depth);
  if (contentionQueueDepth === null) return null;
  const contentionQueuedCount = parseOptionalCount(o.contention_queued_count);
  if (contentionQueuedCount === null) return null;

  // Prefill serialisation gate (LP-0MVGDUUV3001XFRJ, WL-0MVHSZRZQ00482QX):
  // the three gate counters are AVAILABILITY-affecting — a malformed value is
  // ambiguous → null (busy, fail-closed), exactly like
  // `contention_queue_depth`. ABSENT on pre-feature proxies → undefined (no
  // pacing, today's behaviour). `queue_eta_seconds` is an ETA and therefore
  // ADVISORY: a malformed value degrades to undefined and never blocks.
  const localPrefillsInFlight = parseOptionalCount(o.local_prefills_in_flight);
  if (localPrefillsInFlight === null) return null;
  const localMaxConcurrentPrefills = parseOptionalCount(o.local_max_concurrent_prefills);
  if (localMaxConcurrentPrefills === null) return null;
  const prefillGateWaiters = parseOptionalCount(o.prefill_gate_waiters);
  if (prefillGateWaiters === null) return null;
  const queueEtaSeconds = parseAdvisoryNumber(o.queue_eta_seconds);

  // Prefill-ETA occupancy/calibration advisories
  // (LP-0MVGDUV5E005UWBQ, WL-0MVPUE4SE004QYUT): the occupancy terms and the
  // calibration flag published alongside `queue_eta_seconds`. All three are
  // ADVISORY exactly like `queue_eta_seconds` — absent → undefined (legacy
  // proxy), malformed (non-finite / negative / wrong type) → undefined, and
  // an explicit null ("not computable") is preserved — so a bad advisory
  // value never rejects an otherwise usable poll. Contrast the gate counters
  // above, which keep failing closed.
  const queueEtaOccupancySeconds = parseAdvisoryNumber(o.queue_eta_occupancy_seconds);
  const queueEtaBusySlots = parseAdvisoryNumber(o.queue_eta_busy_slots);
  const prefillEtaCalibrated = parseAdvisoryBoolean(o.prefill_eta_calibrated);

  return {
    llama_server_running: o.llama_server_running,
    local_active_query: localActiveQuery,
    model_switch_in_progress: o.model_switch_in_progress,
    local_lease_active: localLeaseActive,
    available_slots: available,
    total_slots: total,
    current_model: typeof o.current_model === 'string' ? o.current_model : undefined,
    local_owner_session_id:
      parseLocalOwnerSessionId(o.local_owner_session_id),
    local_owner_session_ids:
      parseLocalOwnerSessionIds(o.local_owner_session_id),
    local_owner_lease_remaining_seconds:
      typeof o.local_owner_lease_remaining_seconds === 'number'
        ? o.local_owner_lease_remaining_seconds
        : undefined,
    contention_queue_depth: contentionQueueDepth,
    contention_queued_count: contentionQueuedCount,
    slots,
    slots_stale: slotsStale,
    status_schema_version: statusSchemaVersion,
    capacity_hint: capacityHint,
    prefill_budget_seconds: prefillBudget,
    local_prefills_in_flight: localPrefillsInFlight,
    local_max_concurrent_prefills: localMaxConcurrentPrefills,
    prefill_gate_waiters: prefillGateWaiters,
    queue_eta_seconds: queueEtaSeconds,
    queue_eta_occupancy_seconds: queueEtaOccupancySeconds,
    queue_eta_busy_slots: queueEtaBusySlots,
    prefill_eta_calibrated: prefillEtaCalibrated,
    local_idle_seconds: localIdleSeconds,
    local_last_activity_at: localLastActivityAt,
    local_last_activity_source: localLastActivitySource,
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
