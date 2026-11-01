/**
 * packages/herdr/src/downtime-worker.local-reservation.ts — the local-capacity
 * reservation handshake (parent WL-0MVIKRFP0005JDL8, slices C1/C2).
 *
 * Single responsibility: the reserve handshake's wire contract — the tolerant
 * response parser, the dispatcher's request builder and the POST client. Every
 * entry point fails open (an unusable exchange resolves an `unavailable`
 * outcome / `null`), so an older proxy can never block or crash a dispatch.
 *
 * Walk-through of the wire contract and its beneficiary bounds
 * (WL-0MVWEZF4Z004UNYT): the request body uses the proxy's REQUIRED
 * `estimated_tokens` field (AC1); a granted ticket has a 10 s TTL
 * (`DEFAULT_RESERVATION_TTL_SECONDS`, mirroring the proxy's own bound) and is
 * consumable ONLY by the pane's own first request — never by a
 * `--no-extensions` child process (audit runner etc.), which must take its own
 * reservation (AC9). An unusable exchange is a typed `unavailable` outcome
 * naming the failing exchange (AC4), and a `remote-ok` dispatch must not
 * reserve at all (AC8).
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Moved verbatim out of `downtime-worker.ts` by WL-0MVLII0NO007JJBA (extract
 * the downtime-worker dispatch pipeline) and re-exported from the barrel.
 * No behaviour change.
 */

import { LOCAL_RESERVE_PATH } from './downtime-worker.constants.js';
import { DEFAULT_DOWNTIME_POLL_TIMEOUT_MS } from './downtime-worker.poller.js';
import type {
  DowntimeCandidate,
  LocalReservationRequest,
  LocalReservationResult,
  LocalReserveClient,
  LocalReserveFetcher,
} from './downtime-worker.types.js';

// ── Local reservation handshake (parent WL-0MVIKRFP0005JDL8, slice C1) ──
//
// The llama-proxy is adding an atomic reservation handshake: `POST
// {proxyUrl}/llama/local/reserve` returns a gate ticket (granted) or an HTTP
// 429 refusal carrying `{ reason, retry_after_s }`. This slice pins the
// contract — types, header names, wire-body shapes, tolerant parser — BEFORE
// any client exists; the reserve client (C2) and the one-per-idle-window
// guard (C3) are built against it. NOTHING here is called on the dispatch
// path yet (no behaviour change, C1-AC5).
//
// Risky assumption (work item): the exact granted-body field names are only
// known once the proxy lands, so one typed accessor reads a small set of
// aliases and a rename is a one-line change. Additive proxy fields must never
// break parsing.


/** First non-empty string among `keys` (the tolerant alias reader). */
function firstNonEmptyString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** First finite number among `keys`; `undefined` when none is usable. */
function firstFiniteNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Fail-open parse of a reserve-handshake response. Returns a typed
 * {@link LocalReservationResult} for a usable grant (`2xx` with a ticket id
 * and a finite positive TTL) or refusal (`429` with a non-empty reason and a
 * finite non-negative `retry_after_s`), and `null` for EVERY other outcome —
 * endpoint absent (`404`), server error (`500`), timeout (no response), and
 * malformed bodies included. This never throws: an older proxy must leave the
 * caller on today's polling behaviour (parent AC2), and an unusable ticket is
 * never better than no ticket.
 *
 * `httpStatus` is the response status the caller observed; `0` (or any other
 * non-2xx/non-429 value) means "no usable reservation response".
 */
export function parseLocalReservationResponse(
  raw: unknown,
  httpStatus: number,
): LocalReservationResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;

  if (httpStatus === 429) {
    const reason = firstNonEmptyString(body, ['reason']);
    const retryAfterSeconds = firstFiniteNumber(body, ['retry_after_s', 'retry_after_seconds']);
    if (reason === undefined || retryAfterSeconds === undefined || retryAfterSeconds < 0) {
      return null;
    }
    return { status: 'refused', refusal: { reason, retryAfterSeconds } };
  }

  if (!Number.isFinite(httpStatus) || httpStatus < 200 || httpStatus > 299) return null;

  // The granted ticket id: the PROXY'S live contract field is `reservation_id`
  // (verified against the running proxy, 2026-10-31/2026-11-01 — a real grant
  // returns `{"admit":true,"reservation_id":…,"ttl_s":10,…}`). The `ticket_id`
  // / `ticket` accessors remain as aliases for the settling contract, so a
  // rename on either side is a one-line change — and a gate test pins the
  // live `reservation_id` shape so a silent degradation can never recur
  // (WL-0MVWEZF4Z004UNYT AC1/AC5).
  const ticketId = firstNonEmptyString(body, ['reservation_id', 'ticket_id', 'ticket']);
  const ttlSeconds = firstFiniteNumber(body, ['ttl_s', 'ttl_seconds']);
  if (ticketId === undefined || ttlSeconds === undefined || ttlSeconds <= 0) return null;
  return { status: 'granted', ticket: { ticketId, ttlSeconds } };
}

/**
 * Conservative estimated-token estimate sent with a reserve request. The
 * dispatcher cannot know a pane's first-turn size in advance (the prompt is
 * built locally, the response is unconstrained), so ONE documented constant
 * is sent and a real measurement is a one-line change once the proxy
 * documents its interpretation.
 *
 * The NAME mirrors the proxy's REQUIRED wire name `estimated_tokens`
 * (WL-0MVWEZF4Z004UNYT AC1): the pre-fix `expected_tokens` spelling made the
 * proxy answer 400 and the handshake fail open silently.
 */
export const DEFAULT_LOCAL_RESERVATION_ESTIMATED_TOKENS = 8_192;

/**
 * @deprecated Renamed to `DEFAULT_LOCAL_RESERVATION_ESTIMATED_TOKENS` so the
 * constant name mirrors the required wire field `estimated_tokens`
 * (WL-0MVWEZF4Z004UNYT AC1). Kept as a frozen-barrel alias for the split
 * guard's public surface; new code must use the new name.
 */
export const DEFAULT_LOCAL_RESERVATION_EXPECTED_TOKENS = DEFAULT_LOCAL_RESERVATION_ESTIMATED_TOKENS;

/**
 * Client-side bound for a usable granted ticket (WL-0MVWEZF4Z004UNYT AC9):
 * the proxy's own `DEFAULT_RESERVE_TTL_SECONDS = 10` (max 60) is the
 * documented TTL, and a grant with LESS than this window is not treated as
 * capacity by the dispatcher (it was already expired, or expires before the
 * pane could ever consume it). Mirrors the proxy constant at
 * `llm/proxy/proxy/admission_reserve.py:52-53`; the proxy remains the owner
 * of the contract — this is a defensive consumer bound, never a proxy change.
 */
export const DEFAULT_RESERVATION_TTL_SECONDS = 10;

/**
 * Build the reserve request for a downtime dispatch: background priority
 * (unattended work is polite) and an unknown cache state (a fresh pane's
 * first prefill is not known to be warm, so the proxy decides). The wire
 * field is `estimated_tokens`, exactly as the proxy contract requires.
 */
export function buildLocalReservationRequest(
  _candidate: Pick<DowntimeCandidate, 'priority'>,
): LocalReservationRequest {
  return {
    estimated_tokens: DEFAULT_LOCAL_RESERVATION_ESTIMATED_TOKENS,
    priority: 'background',
    cache_state: 'unknown',
  };
}


/**
 * Create the reserve client for `POST {proxyUrl}/llama/local/reserve`.
 *
 * One call = one POST, bounded by `timeoutMs`. Outcomes:
 *   - `429` body → typed refusal (the response is `ok:false` yet carries the
 *     deferral advice);
 *   - `2xx` body → typed grant;
 *   - EVERYTHING ELSE (400/404/5xx/abort/network error/garbage body) → a
 *     typed `{ status: 'unavailable', reason }` outcome whose `reason` NAMES
 *     the failing exchange (`http-<status>` / `timeout` / `bad-body`), so the
 *     dispatch record can tell a broken wire contract from an old proxy and
 *     from a refusal (WL-0MVWEZF4Z004UNYT AC4). Never throws: a
 *     broken/older proxy can never block or crash a dispatch (parent AC2).
 *
 * Beneficiary-bound (AC9): a granted ticket is usable only by the pane's own
 * FIRST request within the `DEFAULT_RESERVATION_TTL_SECONDS` window, never by
 * a `--no-extensions` child process (audit runner etc.) — such children must
 * take their own reservation.
 */
export function createLocalReserver(
  proxyUrl: string,
  fetcher: LocalReserveFetcher = globalThis.fetch as unknown as LocalReserveFetcher,
  timeoutMs: number = DEFAULT_DOWNTIME_POLL_TIMEOUT_MS,
): LocalReserveClient {
  const url = `${proxyUrl.replace(/\/+$/, '')}${LOCAL_RESERVE_PATH}`;
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      // A 429 refusal is meaningful even though `ok` is false; any other
      // non-2xx status carries no usable reservation → an UNAVAILABLE
      // outcome naming the status (AC4) — never a bare null, so a wire
      // contract break (400) can never masquerade as an old proxy.
      if (!res.ok && res.status !== 429) {
        return { status: 'unavailable', reason: `http-${res.status}` };
      }
      let raw: unknown;
      try {
        raw = await res.json();
      } catch {
        return { status: 'unavailable', reason: 'bad-body' }; // non-JSON body
      }
      const parsed = parseLocalReservationResponse(raw, res.status);
      if (parsed === null) {
        // 2xx with an unparseable/expired body → unavailable (AC4).
        return { status: 'unavailable', reason: 'bad-body' };
      }
      return parsed;
    } catch {
      return { status: 'unavailable', reason: 'timeout' }; // network error / timeout / abort → fail open (AC3)
    } finally {
      clearTimeout(timer);
    }
  };
}
