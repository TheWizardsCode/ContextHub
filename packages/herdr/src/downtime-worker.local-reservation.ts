/**
 * packages/herdr/src/downtime-worker.local-reservation.ts — the local-capacity
 * reservation handshake (parent WL-0MVIKRFP0005JDL8, slices C1/C2).
 *
 * Single responsibility: the reserve handshake's wire contract — the tolerant
 * response parser, the dispatcher's request builder and the POST client. Every
 * entry point fails open (`null`), so an older proxy can never block or crash
 * a dispatch.
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

  const ticketId = firstNonEmptyString(body, ['ticket_id', 'ticket']);
  const ttlSeconds = firstFiniteNumber(body, ['ttl_s', 'ttl_seconds']);
  if (ticketId === undefined || ttlSeconds === undefined || ttlSeconds <= 0) return null;
  return { status: 'granted', ticket: { ticketId, ttlSeconds } };
}

/**
 * Conservative expected-token estimate sent with a reserve request. The
 * dispatcher cannot know a pane's first-turn size in advance (the prompt is
 * built locally, the response is unconstrained), so ONE documented constant
 * is sent and a real measurement is a one-line change once the proxy
 * documents its interpretation.
 */
export const DEFAULT_LOCAL_RESERVATION_EXPECTED_TOKENS = 8_192;

/**
 * Build the reserve request for a downtime dispatch: background priority
 * (unattended work is polite) and an unknown cache state (a fresh pane's
 * first prefill is not known to be warm, so the proxy decides).
 */
export function buildLocalReservationRequest(
  _candidate: Pick<DowntimeCandidate, 'priority'>,
): LocalReservationRequest {
  return {
    expected_tokens: DEFAULT_LOCAL_RESERVATION_EXPECTED_TOKENS,
    priority: 'background',
    cache_state: 'unknown',
  };
}


/**
 * Create the reserve client for `POST {proxyUrl}/llama/local/reserve`.
 *
 * One call = one POST, bounded by `timeoutMs`; a `429` body is parsed as a
 * refusal (the response is `ok:false` yet carries the deferral advice), a
 * `2xx` body as a grant, and everything else (404/500/abort/network error/
 * garbage) resolves `null`. Never throws, so a broken/older proxy can never
 * block or crash a dispatch (parent AC2).
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
      // non-2xx status carries no usable reservation → fail open.
      if (!res.ok && res.status !== 429) return null;
      let raw: unknown;
      try {
        raw = await res.json();
      } catch {
        return null; // non-JSON / unreadable body
      }
      return parseLocalReservationResponse(raw, res.status);
    } catch {
      return null; // network error / timeout / abort → fail open
    } finally {
      clearTimeout(timer);
    }
  };
}
