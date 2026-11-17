/**
 * packages/herdr/src/downtime-worker.audit-lease.ts — the bounded
 * audit-lease client (WL-0MWFJH3NW006F5GN).
 *
 * Single responsibility: ONE bounded proxy call per verb — `acquire`, `renew`
 * and `release` — each resolved as a TYPED outcome. The counterpart of
 * `createAuditAvailabilityClient` (`downtime-worker.audit-availability.ts`):
 * the availability GET is a point-in-time OBSERVATION that can never arbitrate
 * a cross-host race, while the lease protocol is the proxy's ATOMIC arbiter
 * for the shared audit budget. Herdr's audit admission holds a lease before a
 * dispatch may proceed, maps refusals to the shared tokens, and releases on
 * every terminal path.
 *
 * ## The protocol (LP-0MW95FYMH006XYNK, shipped)
 *
 * ```
 * POST   {proxyUrl}/llama/local/audit/lease          -> 200 acquired/renewed
 *        { "session_id": "<session>" }                 429 { "reason":
 *           "audit-budget-saturated", "retry_after_s": <secs> } when a
 *          DIFFERENT session holds the budget
 *                                                      503 { "reason":
 *           "audit-budget-unavailable" } on a registry failure
 * POST   {proxyUrl}/llama/local/audit/lease/renew    -> 200 extended, 404 foreign/expired
 * DELETE {proxyUrl}/llama/local/audit/lease/{session_id} -> 200 released, 404 already gone
 * ```
 *
 * Session discipline: the session id is DERIVED from the dispatched
 * pane/item (`auditLeaseSessionId`), so it is stable for the lifetime of one
 * dispatch attempt — a retry of the same item ACQUIRES-AND-RENEWS the same
 * session instead of competing against itself, and every abort path can
 * re-derive the id from the item without threading state (the pane-close
 * release and the claim-pipeline release both do exactly that).
 *
 * ## Status-driven verdicts vs the availability read's fail-closed parser
 *
 * The availability GET carries the answer in the BODY (`available` never
 * derived locally), so its parser fails closed on a partial payload. The
 * lease protocol carries the answer in the STATUS (200 = held / renewed /
 * released, 429 = saturated, 503 = registry failure, 404 = absent): the body
 * is evidence only. A 2xx body that does not parse therefore does NOT flip a
 * grant into `unparsable` — a `200` on acquire IS the reservation, and
 * failing closed on a granted-but-odd body would leak a lease herdr never
 * releases. Expiry, when the body serves it, is read through the same
 * tolerant alias normaliser as the availability lease parser and pinned in
 * captured payloads.
 *
 * ## Trust rules
 *
 * The client never throws and never invents capacity. Non-2xx statuses are
 * classified before any body work: `404` -> `endpoint-absent` (acquire) or
 * `not-found` (renew/release), `429` -> `saturated` with the bounded
 * `retry_after_s` honoured as the refusal cooldown, `503` -> `unavailable`
 * (registry failure, distinct from the local fail-closed token), every other
 * status -> `unreachable/http-<status>`. A transport error fails close as
 * `unreachable/timeout|network`. Every arm is usable downstream without
 * further parsing — the audit admission (WL-0MWFJH3NW006F5GN) maps `ok` to
 * admit and every other arm to a named refusal.
 *
 * Layering: imports `./downtime-worker.constants.js`,
 * `./downtime-worker.audit-availability.contract.js` (the shared budget
 * vocabulary) and `./downtime-worker.poller.js` (the shared poll timeout)
 * only — never the barrel, so no runtime cycle can form.
 */

import {
  AUDIT_BUDGET_SATURATED_REASON,
  AUDIT_BUDGET_UNAVAILABLE_REASON,
} from './downtime-worker.audit-availability.contract.js';
import {
  AUDIT_LEASE_PATH,
  AUDIT_LEASE_RENEW_PATH,
} from './downtime-worker.constants.js';
import { DEFAULT_DOWNTIME_POLL_TIMEOUT_MS } from './downtime-worker.poller.js';

// ── Session id discipline ─────────────────────────────────────────────

/**
 * Derive the audit-lease session id from the dispatched pane/item.
 *
 * Stable for one dispatch attempt (and across retries of the same item): a
 * re-dispatch ACQUIRES-AND-RENEWS the prior session instead of competing with
 * it, and every release path — claim-pipeline abort and pane-close — can
 * re-derive the id from the item id without threading state
 * (WL-0MWFJH3NW006F5GN AC1).
 */
export function auditLeaseSessionId(itemId: string): string {
  return `herdr-audit-${itemId}`;
}

// ── Wire types ────────────────────────────────────────────────────────

/**
 * A held audit lease. `expiresAt` is the proxy's served expiry (epoch ms)
 * when the 2xx body carries one — read through the tolerant normaliser; the
 * 200 status itself is the reservation, so an absent/unparseable expiry never
 * degrades a held lease.
 */
export interface AuditLease {
  /** The session id the lease is keyed to (echoed when the body serves one). */
  sessionId: string;
  /** Absolute lease expiry as epoch milliseconds, when the proxy serves it. */
  expiresAt?: number;
}

/**
 * The outcome of one bounded `POST /llama/local/audit/lease` (acquire), the
 * admission gate's only usable acceptance:
 *
 *   - `ok` — the proxy granted or renewed the caller's session (200);
 *   - `saturated` — a DIFFERENT session holds the budget (429); carries the
 *     proxy's `retry_after_s` as the refusal cooldown;
 *   - `unavailable` — the proxy's registry failed (503, `audit-budget-
 *     unavailable`);
 *   - `endpoint-absent` — the proxy predates the endpoint (404, rollout
 *     state);
 *   - `unreachable` — transport fault / unusable status (`timeout` /
 *     `network` / `http-<status>`);
 *   - `unparsable` — reserved for future body-driven arms; the acquire is
 *     status-driven, so a 2xx body never lands here today.
 *
 * Every non-`ok` arm stands alone as the admission refusal evidence.
 */
export type AuditLeaseAcquireOutcome =
  | { status: 'ok'; lease: AuditLease }
  | { status: 'saturated'; reason: typeof AUDIT_BUDGET_SATURATED_REASON; retryAfterS?: number }
  | { status: 'unavailable'; reason: typeof AUDIT_BUDGET_UNAVAILABLE_REASON }
  | { status: 'endpoint-absent'; reason: 'http-404' }
  | { status: 'unreachable'; reason: 'timeout' | 'network' | `http-${number}` }
  | { status: 'unparsable'; reason: 'bad-body' };

/**
 * The outcome of one bounded `POST /llama/local/audit/lease/renew`:
 *
 *   - `ok` — the caller's own session was extended (200);
 *   - `not-found` — a foreign or already-expired session (404; renewing a
 *     foreign lease must never look like success);
 *   - `unreachable` / `unparsable` — as {@link AuditLeaseAcquireOutcome}.
 */
export type AuditLeaseRenewOutcome =
  | { status: 'ok'; lease: AuditLease }
  | { status: 'not-found'; reason: 'http-404' }
  | { status: 'unreachable'; reason: 'timeout' | 'network' | `http-${number}` }
  | { status: 'unparsable'; reason: 'bad-body' };

/**
 * The outcome of one bounded `DELETE /llama/local/audit/lease/{session_id}`:
 *
 *   - `ok` — the lease was released, or was already gone (200; idempotent),
 *   - `not-found` — the session is absent (404; a successful no-op),
 *   - `unreachable` / `unparsable` — as {@link AuditLeaseAcquireOutcome}.
 *
 * Every terminal dispatch path calls release unconditionally; the idempotent
 * `ok`/`not-found` arms make an unheld session a non-event.
 */
export type AuditLeaseReleaseOutcome =
  | { status: 'ok' }
  | { status: 'not-found'; reason: 'http-404' }
  | { status: 'unreachable'; reason: 'timeout' | 'network' | `http-${number}` }
  | { status: 'unparsable'; reason: 'bad-body' };

/**
 * Injectable fetch boundary for the lease client (mirrors
 * {@link AuditAvailabilityFetcher}, widened to the verbs the lease protocol
 * needs — `POST` with a JSON body and `DELETE`). Narrow enough that tests can
 * stub it with a plain object.
 */
export type AuditLeaseFetcher = (
  url: string,
  init: {
    method: 'POST' | 'DELETE';
    headers: Record<string, string>;
    body?: string;
    signal?: unknown;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The audit-lease client: one call per verb, each bounded and resolved as a
 * typed outcome. NEVER throws — a broken or absent proxy endpoint is always
 * reported as a typed arm, so a dispatch tick cannot crash on it.
 */
export interface AuditLeaseClient {
  /** `POST {proxyUrl}{AUDIT_LEASE_PATH}` for `sessionId` (idempotent renew of the same session). */
  acquire(sessionId: string): Promise<AuditLeaseAcquireOutcome>;
  /** `POST {proxyUrl}{AUDIT_LEASE_RENEW_PATH}` for `sessionId`. */
  renew(sessionId: string): Promise<AuditLeaseRenewOutcome>;
  /** `DELETE {proxyUrl}{AUDIT_LEASE_PATH}/{sessionId}` (idempotent). */
  release(sessionId: string): Promise<AuditLeaseReleaseOutcome>;
}

// ── Tolerant normaliser (acquire/renew 2xx body, evidence only) ───────

/** True for a plain JSON object (not `null`, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Session-id aliases the proxy may echo (open vocabulary). */
const SESSION_ID_KEYS: readonly string[] = [
  'session_id',
  'sessionId',
  'lease_id',
  'ticket_id',
  'id',
  'owner',
];
/** Lease-expiry aliases (epoch ms number, or a `Date.parse`-able string). */
const LEASE_EXPIRY_KEYS: readonly string[] = [
  'expires_at',
  'expires_at_ms',
  'expiry',
  'expiresAt',
];
/** Retry-after aliases on a 429 body (seconds). */
const RETRY_AFTER_KEYS: readonly string[] = ['retry_after_s', 'retry_after_seconds'];

/** The value of the FIRST alias present as a non-empty `string`, else `undefined`. */
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

/** The value of the FIRST alias present as a finite non-negative `number`, else `undefined`. */
function firstFiniteNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/**
 * Parse the lease-expiry evidence from a 2xx acquire/renew body: a positive
 * finite epoch-ms number or a `Date.parse`-able ISO-8601 string, read through
 * the documented aliases (the same tolerant rule the availability lease
 * parser pins). `undefined` when the body carries no usable expiry — the 200
 * status is the reservation, so expiry is evidence only.
 */
function parseLeaseExpiry(source: Record<string, unknown>): number | undefined {
  for (const key of LEASE_EXPIRY_KEYS) {
    const value = source[key];
    if (typeof value === 'number') {
      if (Number.isFinite(value) && value > 0) return value;
      return undefined; // a malformed primary alias fails closed
    }
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
      return undefined; // an unparseable primary alias fails closed
    }
  }
  return undefined;
}

/**
 * Tolerant normaliser for a 2xx acquire/renew body (WL-0MWFJH3NW006F5GN AC1).
 *
 * The acquire response's expiry shape is UNVERIFIED, so it is read through
 * the same alias discipline as the availability read and pinned in captured
 * payloads. Never throws. Unlike the availability parser this is
 * EVIDENCE-ONLY: the status is the grant, so a non-object body resolves to
 * the fallback lease rather than flipping a `200` into `unparsable`.
 *
 * @param raw the parsed body (any JSON value).
 * @param fallbackSessionId the session this call asked for — used when the
 *   body does not echo one.
 */
export function parseAuditLeaseBody(
  raw: unknown,
  fallbackSessionId: string,
): AuditLease {
  const lease: AuditLease = { sessionId: fallbackSessionId };
  if (!isPlainObject(raw)) return lease;
  const echoed = firstNonEmptyString(raw, SESSION_ID_KEYS);
  if (echoed !== undefined) lease.sessionId = echoed;
  const expiresAt = parseLeaseExpiry(raw);
  if (expiresAt !== undefined) lease.expiresAt = expiresAt;
  return lease;
}

/**
 * Read the bounded `retry_after_s` cooldown from a 429 body (seconds).
 * `undefined` when absent/unusable — the refusal still stands (429 is
 * saturation by status), it simply carries no deferral advice.
 */
export function parseRetryAfterSeconds(raw: unknown): number | undefined {
  if (!isPlainObject(raw)) return undefined;
  return firstFiniteNumber(raw, RETRY_AFTER_KEYS);
}

// ── Client ────────────────────────────────────────────────────────────

/**
 * One bounded round trip with the shared poll timeout: on expiry the request
 * is ABORTED (never merely ignored) and the call resolves
 * `unreachable/timeout`; the abort timer is cleared on every path so a
 * resolved call never leaves an open handle behind.
 */
async function boundedCall(
  fetcher: AuditLeaseFetcher,
  url: string,
  init: { method: 'POST' | 'DELETE'; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    // `timeout` names OUR abort; anything else (connection refused, DNS
    // failure, a synchronous throw from the fetcher) is a network fault.
    const aborted =
      timedOut ||
      controller.signal.aborted ||
      (error as { name?: unknown } | null | undefined)?.name === 'AbortError';
    throw Object.assign(new Error(aborted ? 'timeout' : 'network'), {
      leaseWireFault: aborted ? 'timeout' : 'network',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Classify a non-2xx status into the shared fail-closed reason vocabulary. */
function transportReason(status: number): `http-${number}` {
  return `http-${status}`;
}

/**
 * Create the audit-lease client for one `proxyUrl`.
 *
 * Defaults to the shipped `/llama/local/audit/lease` path (plus
 * `/renew` and `/{session_id}` built from it); the URL is normalised with the
 * same trailing-slash convention as `createAuditAvailabilityClient` and
 * `createLocalReserver`. Each call is bounded by `timeoutMs` (default
 * `DEFAULT_DOWNTIME_POLL_TIMEOUT_MS`).
 */
export function createAuditLeaseClient(
  proxyUrl: string,
  fetcher: AuditLeaseFetcher = globalThis.fetch as unknown as AuditLeaseFetcher,
  timeoutMs: number = DEFAULT_DOWNTIME_POLL_TIMEOUT_MS,
): AuditLeaseClient {
  const base = proxyUrl.replace(/\/+$/, '');
  return {
    async acquire(sessionId: string): Promise<AuditLeaseAcquireOutcome> {
      const url = `${base}${AUDIT_LEASE_PATH}`;
      try {
        const res = await boundedCall(
          fetcher,
          url,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ session_id: sessionId }),
          },
          timeoutMs,
        );
        if (res.status === 429) {
          let retryAfterS: number | undefined;
          try {
            retryAfterS = parseRetryAfterSeconds(await res.json());
          } catch {
            // no usable body -> no deferral advice; the refusal stands
          }
          return { status: 'saturated', reason: AUDIT_BUDGET_SATURATED_REASON, ...(retryAfterS !== undefined ? { retryAfterS } : {}) };
        }
        if (res.status === 503) return { status: 'unavailable', reason: AUDIT_BUDGET_UNAVAILABLE_REASON };
        if (res.status === 404) return { status: 'endpoint-absent', reason: 'http-404' };
        const isSuccess = Number.isFinite(res.status) && res.status >= 200 && res.status <= 299;
        if (!isSuccess) return { status: 'unreachable', reason: transportReason(res.status) };
        let raw: unknown;
        try {
          raw = await res.json();
        } catch {
          raw = undefined; // status-driven: a granted body that is not JSON stays usable
        }
        return { status: 'ok', lease: parseAuditLeaseBody(raw, sessionId) };
      } catch (error) {
        const fault = (error as { leaseWireFault?: string })?.leaseWireFault;
        return {
          status: 'unreachable',
          reason: fault === 'timeout' ? 'timeout' : 'network',
        };
      }
    },
    async renew(sessionId: string): Promise<AuditLeaseRenewOutcome> {
      const url = `${base}${AUDIT_LEASE_RENEW_PATH}`;
      try {
        const res = await boundedCall(
          fetcher,
          url,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ session_id: sessionId }),
          },
          timeoutMs,
        );
        if (res.status === 404) return { status: 'not-found', reason: 'http-404' };
        const isSuccess = Number.isFinite(res.status) && res.status >= 200 && res.status <= 299;
        if (!isSuccess) return { status: 'unreachable', reason: transportReason(res.status) };
        let raw: unknown;
        try {
          raw = await res.json();
        } catch {
          raw = undefined;
        }
        return { status: 'ok', lease: parseAuditLeaseBody(raw, sessionId) };
      } catch (error) {
        const fault = (error as { leaseWireFault?: string })?.leaseWireFault;
        return {
          status: 'unreachable',
          reason: fault === 'timeout' ? 'timeout' : 'network',
        };
      }
    },
    async release(sessionId: string): Promise<AuditLeaseReleaseOutcome> {
      const url = `${base}${AUDIT_LEASE_PATH}/${encodeURIComponent(sessionId)}`;
      try {
        const res = await boundedCall(
          fetcher,
          url,
          { method: 'DELETE', headers: { accept: 'application/json' } },
          timeoutMs,
        );
        if (res.status === 404) return { status: 'not-found', reason: 'http-404' };
        const isSuccess = Number.isFinite(res.status) && res.status >= 200 && res.status <= 299;
        if (!isSuccess) return { status: 'unreachable', reason: transportReason(res.status) };
        return { status: 'ok' };
      } catch (error) {
        const fault = (error as { leaseWireFault?: string })?.leaseWireFault;
        return {
          status: 'unreachable',
          reason: fault === 'timeout' ? 'timeout' : 'network',
        };
      }
    },
  };
}
