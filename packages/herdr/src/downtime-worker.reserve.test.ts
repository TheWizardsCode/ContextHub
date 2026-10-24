/**
 * packages/herdr/src/downtime-worker.reserve.test.ts — contract tests for the
 * local-proxy reservation handshake (parent WL-0MVIKRFP0005JDL8, slice C1)
 *
 * Pins the `POST {proxyUrl}/llama/local/reserve` contract BEFORE any client
 * code exists, so the reserve client (C2) and the one-per-idle-window guard
 * (C3) are built against fixed shapes and tolerant-parsing behaviour.
 *
 * Traceability (C1-AC4): every test name cites the PARENT AC it serves.
 *   - `AC1` — the reserve client contract: a granted ticket (gate id + TTL)
 *     or a `429 { reason, retry_after_s }` refusal, surfaced through one
 *     typed accessor.
 *   - `AC2` — failure-mode back-compat: endpoint absent (404), server error
 *     (500), timeout and malformed payloads all fail OPEN to `null` (today's
 *     polling behaviour), never a throw.
 *
 * Fixtures live in `downtime-worker.fixtures.ts` (C1-AC2) so no test needs an
 * ad-hoc inline response object.
 */

import { describe, expect, it } from 'vitest';

import {
  LOCAL_FALLBACK_REASON_HEADER,
  LOCAL_PREFERENCE_HEADER,
  LOCAL_RESERVATION_HEADER,
  LOCAL_RESERVE_PATH,
  LOCAL_ROUTE_HEADER,
  parseLocalReservationResponse,
} from './downtime-worker.js';
import {
  reserveEndpointAbsent,
  reserveGranted,
  reserveRefused429,
  reserveServerError,
  reserveTimeout,
} from './downtime-worker.fixtures.js';

/** Parse a fixture exactly as the C2 client will after reading the response. */
function parse(fixture: { status: number; body: unknown }) {
  return parseLocalReservationResponse(fixture.body, fixture.status);
}

describe('reservation contract constants (AC1)', () => {
  it('AC1: exposes the reservation header and the C4 preference/route headers', () => {
    // The granted ticket id travels on the pane's FIRST request under
    // `X-Local-Reservation`; the C4 knobs share the `X-Local-*` namespace.
    expect(LOCAL_RESERVATION_HEADER).toBe('X-Local-Reservation');
    expect(LOCAL_PREFERENCE_HEADER).toBe('X-Local-Preference');
    expect(LOCAL_ROUTE_HEADER).toBe('X-Local-Route');
    expect(LOCAL_FALLBACK_REASON_HEADER).toBe('X-Local-Fallback-Reason');
  });

  it('AC1: pins the reserve endpoint path documented in the parent', () => {
    expect(LOCAL_RESERVE_PATH).toBe('/llama/local/reserve');
  });
});

describe('parseLocalReservationResponse — granted ticket (AC1)', () => {
  it('AC1: a granted body parses to a typed ticket with a finite TTL', () => {
    const result = parse(reserveGranted());

    expect(result).toEqual({
      status: 'granted',
      ticket: { ticketId: 'tkt-granted-1', ttlSeconds: 30 },
    });
  });

  it('AC1: additive proxy fields never break an otherwise valid grant', () => {
    // Strict-but-tolerant parsing: the proxy may add fields at any time.
    const result = parse(reserveGranted({ proxy_build: '2026-10-23', admit: true }));

    expect(result).toEqual({
      status: 'granted',
      ticket: { ticketId: 'tkt-granted-1', ttlSeconds: 30 },
    });
  });

  it('AC1: a renamed ticket/TTL field is still read through the tolerant accessor', () => {
    // Risky assumption in the work item: the exact granted-body field names
    // are unknown until the proxy lands, so the accessor accepts aliases.
    const result = parse(
      reserveGranted({
        ticket_id: undefined,
        ticket: 'tkt-aliased',
        ttl_s: undefined,
        ttl_seconds: 20,
      }),
    );

    expect(result).toEqual({
      status: 'granted',
      ticket: { ticketId: 'tkt-aliased', ttlSeconds: 20 },
    });
  });

  it('AC1: a missing ticket id fails open to null', () => {
    expect(parse(reserveGranted({ ticket_id: undefined }))).toBeNull();
    expect(parse(reserveGranted({ ticket_id: '' }))).toBeNull();
  });

  it('AC1: a non-positive or non-finite TTL is not a usable ticket → null', () => {
    expect(parse(reserveGranted({ ttl_s: 0 }))).toBeNull();
    expect(parse(reserveGranted({ ttl_s: -5 }))).toBeNull();
    expect(parse(reserveGranted({ ttl_s: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parse(reserveGranted({ ttl_s: Number.NaN }))).toBeNull();
    expect(parse(reserveGranted({ ttl_s: '30' }))).toBeNull();
    expect(parse(reserveGranted({ ttl_s: undefined }))).toBeNull();
  });
});

describe('parseLocalReservationResponse — 429 refusal (AC1)', () => {
  it('AC1: a 429 body parses to a typed refusal with reason and retry_after_s', () => {
    const result = parse(reserveRefused429());

    expect(result).toEqual({
      status: 'refused',
      refusal: { reason: 'prefill-gate', retryAfterSeconds: 12 },
    });
  });

  it('AC1: accepts any non-empty refusal reason (the parent list is not exhaustive)', () => {
    for (const reason of ['reserved-fallback', 'prefill-gate', 'queue-full', 'a-new-reason']) {
      expect(parse(reserveRefused429({ reason }))).toEqual({
        status: 'refused',
        refusal: { reason, retryAfterSeconds: 12 },
      });
    }
  });

  it('AC1: a missing, empty or non-string reason fails open to null', () => {
    expect(parse(reserveRefused429({ reason: undefined }))).toBeNull();
    expect(parse(reserveRefused429({ reason: '' }))).toBeNull();
    expect(parse(reserveRefused429({ reason: 42 }))).toBeNull();
  });

  it('AC1: a negative or non-finite retry_after_s fails open to null', () => {
    expect(parse(reserveRefused429({ retry_after_s: -1 }))).toBeNull();
    expect(parse(reserveRefused429({ retry_after_s: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parse(reserveRefused429({ retry_after_s: Number.NaN }))).toBeNull();
    expect(parse(reserveRefused429({ retry_after_s: '12' }))).toBeNull();
    expect(parse(reserveRefused429({ retry_after_s: undefined }))).toBeNull();
  });

  it('AC1: a zero retry_after_s (immediate retry) is a valid refusal', () => {
    expect(parse(reserveRefused429({ retry_after_s: 0 }))).toEqual({
      status: 'refused',
      refusal: { reason: 'prefill-gate', retryAfterSeconds: 0 },
    });
  });
});

describe('parseLocalReservationResponse — fail-open failure modes (AC2)', () => {
  it('AC2: an absent reserve endpoint (404) fails open to null', () => {
    // An older proxy has no reserve handler: dispatch must keep today's
    // polling behaviour rather than crash or block.
    expect(parse(reserveEndpointAbsent)).toBeNull();
  });

  it('AC2: a 500 server error fails open to null', () => {
    expect(parse(reserveServerError)).toBeNull();
  });

  it('AC2: a timed-out call fails open to null with no throw', () => {
    expect(() => parse(reserveTimeout)).not.toThrow();
    expect(parse(reserveTimeout)).toBeNull();
  });

  it('AC2: a non-JSON / garbage body fails open to null', () => {
    expect(parseLocalReservationResponse('<html>502 bad gateway</html>', 200)).toBeNull();
    expect(parseLocalReservationResponse(undefined, 200)).toBeNull();
    expect(parseLocalReservationResponse(null, 200)).toBeNull();
    expect(parseLocalReservationResponse([1, 2, 3], 200)).toBeNull();
  });

  it('AC2: a 429 with an unparseable body fails open to null', () => {
    expect(parseLocalReservationResponse(null, 429)).toBeNull();
    expect(parseLocalReservationResponse('rate limited', 429)).toBeNull();
  });
});
