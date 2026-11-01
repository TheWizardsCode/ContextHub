/**
 * packages/herdr/src/downtime-worker.local-reservation.contract.ts — the
 * local-capacity reservation handshake's WIRE types (parent
 * WL-0MVIKRFP0005JDL8, slice C1).
 *
 * Single responsibility: the typed surface of `POST {proxyUrl}/llama/local/
 * reserve` — request body, granted/refused response bodies and the parsed
 * outcomes — shared by the tolerant parser, the reserve client, the dispatch
 * gate and the tests.
 *
 * Split out of `downtime-worker.types.ts` (WL-0MVWEZF4Z004UNYT) to keep that
 * module under the split guard's 1000-line ceiling; `downtime-worker.types.ts`
 * re-exports every name, so the public surface is unchanged.
 */

/**
 * Request body for `POST /llama/local/reserve`: the pane's ESTIMATED token
 * size, its scheduling priority and its cache state. The proxy contract
 * (admission_reserve.py) REQUIRES the field named `estimated_tokens` and
 * answers `400 {"error":"estimated_tokens is required"}` for any other
 * spelling — the original `expected_tokens` name silently degraded the
 * handshake to a fail-open `null` (WL-0MVWEZF4Z004UNYT AC1). The proxy
 * contract is additive-only, so extra fields are permitted and ignored by
 * this consumer.
 */
export interface LocalReservationRequest {
  /** Estimated prompt + completion token size for the turn (proxy contract name). */
  estimated_tokens: number;
  /** Scheduling priority the proxy may use to admit or refuse. */
  priority: LocalReservationPriority;
  /** Whether the proxy's prefix cache is expected to serve this prefill. */
  cache_state: LocalReservationCacheState;
  /** Additive fields are allowed (additive-only proxy contract). */
  [extra: string]: unknown;
}

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
 * Granted reserve response body (`2xx`) — the LIVE proxy contract
 * (verified 2026-11-01 against the running proxy): the gate ticket id is
 * `reservation_id` and the TTL is `ttl_s`. `admit`/`projected_wait_s` and any
 * future fields are additive and ignored. {@link
 * parseLocalReservationResponse} additionally accepts the historical
 * `ticket_id` / `ticket` / `ttl_seconds` aliases while the contract settles.
 */
export interface LocalReservationGrantedBody {
  reservation_id: string;
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

/**
 * An unusable reserve exchange (WL-0MVWEZF4Z004UNYT AC4): the proxy answered
 * but with no usable grant/refusal (e.g. a wire-contract `400`, a `404` on a
 * pre-reserve proxy, a `5xx`), or the call failed/timed out, or the body was
 * unparseable. `reason` names the failing exchange (open vocabulary:
 * `http-<status>` / `timeout` / `bad-body` / `ttl-below-bound`), so a broken
 * contract can NEVER look like an old proxy on the dispatch record. The
 * dispatch gate fails open on it (AC3) but records it as distinct from a 429
 * REFUSAL.
 */
export interface LocalReservationUnavailable {
  /** Short machine-readable name of the failing exchange. */
  reason: string;
}

/**
 * Parsed reservation outcome: a ticket to claim with, a refusal to defer on,
 * or an unusable exchange the caller fails open on.
 */
export type LocalReservationResult =
  | { status: 'granted'; ticket: LocalReservationTicket }
  | { status: 'refused'; refusal: LocalReservationRefusal }
  | { status: 'unavailable'; reason: LocalReservationUnavailable['reason'] };

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
