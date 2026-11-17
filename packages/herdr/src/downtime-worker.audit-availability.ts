/**
 * packages/herdr/src/downtime-worker.audit-availability.ts — the fail-closed
 * audit-availability GET client (parent WL-0MW95GBEG005ERHS, child
 * WL-0MWAMSCOP003R837).
 *
 * Single responsibility: ONE bounded `GET {proxyUrl}{AUDIT_AVAILABILITY_PATH}`
 * per call, resolved as a TYPED outcome. The counterpart of
 * `createLocalReserver` (`downtime-worker.local-reservation.ts`) and
 * `createDowntimePoller` (`downtime-worker.poller.ts`): the failure
 * classification is spelled out here so the dispatcher's policy (fail closed
 * with a named reason, parent AC3) never has to guess from an empty value.
 *
 * ## Why a typed outcome rather than `null`
 *
 * The audit gate must REFUSE with a named reason when the proxy cannot answer,
 * and must be able to say WHICH exchange failed (`endpoint-absent`,
 * `unreachable`/`http-<status>`, `unreachable`/`timeout`,
 * `unreachable`/`network`, `unparsable`/`bad-body`). An empty result would
 * collapse "the proxy predates the endpoint" (a rollout state) into "the proxy
 * is down" (an incident) and into "the payload is garbage" (a contract break)
 * — three different operator actions.
 *
 * ## Trust rules
 *
 * The client never throws and never invents availability: a 2xx body is `ok`
 * ONLY when `parseAuditAvailabilityResponse` accepts it (fail-closed parser,
 * `downtime-worker.audit-availability.contract.ts`), so a partial or malformed
 * payload is `unparsable` — never `ok` with partial data (AC4). `404` is
 * classified BEFORE the general non-2xx case, so "the sibling proxy item has
 * not shipped" is distinguishable from every other unusable exchange (AC3).
 *
 * The proxy endpoint is the SHIPPED `GET /llama/local/audit/availability`
 * (LP-0MW95FYMH006XYNK), validated 2026-11-13; it is resolved per call via
 * `resolveAuditAvailabilityPath()` so `HERDR_AUDIT_AVAILABILITY_PATH` can point
 * herdr at a renamed endpoint without a rebuild. The audit gate
 * (WL-0MWAMSDNW000SL0E) is its first consumer.
 *
 * Layering: imports `./downtime-worker.constants.js`,
 * `./downtime-worker.poller.js` (the shared poll timeout) and
 * `./downtime-worker.audit-availability.contract.js` only — never the barrel
 * (`downtime-worker.ts`), so no runtime cycle can form.
 */

import {
  parseAuditAvailabilityResponse,
  type AuditAvailability,
} from './downtime-worker.audit-availability.contract.js';
import { resolveAuditAvailabilityPath } from './downtime-worker.constants.js';
import { DEFAULT_DOWNTIME_POLL_TIMEOUT_MS } from './downtime-worker.poller.js';

// ── Client surface (types) ────────────────────────────────────────────

/**
 * The outcome of one audit-availability read. Every arm is usable by the
 * dispatcher without further parsing:
 *
 *   - `ok` — the proxy answered 2xx with a payload the pinned parser accepts;
 *   - `endpoint-absent` — the proxy predates the endpoint (`404`), i.e. the
 *     sibling proxy item has not shipped;
 *   - `unreachable` — the proxy could not be reached (`timeout` / `network`)
 *     or answered an unusable status (`http-<status>`);
 *   - `unparsable` — 2xx with a body the pinned parser rejects (`bad-body`).
 *
 * `endpoint-absent`, `unreachable` and `unparsable` all fail CLOSED in the
 * audit gate (parent AC3) with a named reason — the arm and its `reason` are
 * the evidence.
 */
export type AuditAvailabilityOutcome =
  | { status: 'ok'; availability: AuditAvailability }
  | { status: 'endpoint-absent'; reason: 'http-404' }
  | { status: 'unreachable'; reason: 'timeout' | 'network' | `http-${number}` }
  | { status: 'unparsable'; reason: 'bad-body' };

/**
 * Injectable GET boundary for the audit-availability read (mirrors the
 * reserve handshake's `LocalReserveFetcher` seam; narrow enough that tests can
 * stub it with a plain object). The typed method is `GET` — the read has no
 * request body.
 */
export type AuditAvailabilityFetcher = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: unknown },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The audit-availability client: one call = one bounded GET, resolved as a
 * typed outcome. NEVER throws — a broken or absent proxy endpoint is always
 * reported as a typed arm, so a dispatch tick cannot crash on it.
 */
export type AuditAvailabilityClient = () => Promise<AuditAvailabilityOutcome>;

// ── Client ────────────────────────────────────────────────────────────

/**
 * Create the client for `GET {proxyUrl}{resolveAuditAvailabilityPath()}`.
 *
 * The path is resolved PER CALL (default `AUDIT_AVAILABILITY_PATH`, the
 * shipped `/llama/local/audit/availability`), so the
 * `HERDR_AUDIT_AVAILABILITY_PATH` override takes effect without recreating the
 * client.
 *
 * The URL is normalised with the same trailing-slash convention as
 * `createLocalReserver` (every trailing `/` is stripped before the path is
 * appended), so a configured `http://proxy:8000/` and `http://proxy:8000`
 * form ONE documented request URL.
 *
 * One call = one GET, bounded by `timeoutMs` (default
 * `DEFAULT_DOWNTIME_POLL_TIMEOUT_MS`, the poller's own bound): on expiry the
 * request is ABORTED, never merely ignored, and the call resolves
 * `unreachable`/`timeout`. The abort timer is cleared on every path — a
 * resolved read never leaves an open handle behind (AC3/AC5).
 */
export function createAuditAvailabilityClient(
  proxyUrl: string,
  fetcher: AuditAvailabilityFetcher = globalThis.fetch as unknown as AuditAvailabilityFetcher,
  timeoutMs: number = DEFAULT_DOWNTIME_POLL_TIMEOUT_MS,
): AuditAvailabilityClient {
  const base = proxyUrl.replace(/\/+$/, '');
  return async () => {
    const url = `${base}${resolveAuditAvailabilityPath()}`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const res = await fetcher(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      // The observed status is authoritative — never `res.ok`, which a
      // response double or a middleware could set inconsistently.
      const isSuccess = Number.isFinite(res.status) && res.status >= 200 && res.status <= 299;
      if (!isSuccess) {
        // Checked BEFORE the general non-2xx case: "the proxy predates the
        // endpoint" (a rollout state) is not "the proxy is broken".
        if (res.status === 404) return { status: 'endpoint-absent', reason: 'http-404' };
        return { status: 'unreachable', reason: `http-${res.status}` };
      }
      let raw: unknown;
      try {
        raw = await res.json();
      } catch {
        return { status: 'unparsable', reason: 'bad-body' }; // non-JSON body
      }
      const availability = parseAuditAvailabilityResponse(raw, res.status);
      if (availability === null) {
        // 2xx with a body the pinned parser rejects (AC4): never `ok` with
        // partial data — a garbage payload can never admit an audit.
        return { status: 'unparsable', reason: 'bad-body' };
      }
      return { status: 'ok', availability };
    } catch (error) {
      // `timeout` names OUR abort; anything else (connection refused, DNS
      // failure, a synchronous throw from the fetcher) is a network fault.
      const aborted =
        timedOut ||
        controller.signal.aborted ||
        (error as { name?: unknown } | null)?.name === 'AbortError';
      return { status: 'unreachable', reason: aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  };
}
