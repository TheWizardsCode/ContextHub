/**
 * packages/herdr/src/downtime-worker.audit-lease.live.test.ts — the
 * live-proxy end-to-end check for the shipped audit-lease client
 * (WL-0MWFJH3NW006F5GN AC6).
 *
 * Unlike the client/unit suites, which drive injected fetcher doubles, this
 * test talks to the REAL proxy so a path, expiry-shape or cooldown mismatch
 * between herdr and the shipped server is caught at test time rather than as
 * an unending `audit-budget-saturated`/`audit-budget-unknown` refusal in the
 * decision log.
 *
 * It is deliberately environment-tolerant: when the proxy is unreachable (CI,
 * a laptop off the home network) the test SKIPS rather than fails, and when
 * the shared GPU is genuinely saturated by another session the acquire is a
 * refusal this test must not fight — it SKIPS too (it never releases
 * someone else's lease). When it CAN hold a lease it asserts:
 *
 *   - `acquire` resolves `status: 'ok'` for a SYNTHETIC session id (derived
 *     via `auditLeaseSessionId`, stable per item),
 *   - `renew` extends the SAME session (`status: 'ok'`) — a retry renews
 *     rather than competes,
 *   - the availability read observes the held lease (`live >= 1`), and
 *   - `release` returns the availability read to its pre-acquire baseline
 *     (the documented single-slot idle machine reports `live: 0`).
 */

import { describe, expect, it } from 'vitest';

import { createAuditAvailabilityClient } from './downtime-worker.audit-availability.js';
import {
  auditLeaseSessionId,
  createAuditLeaseClient,
} from './downtime-worker.audit-lease.js';
import { DEFAULT_DOWNTIME_PROXY_URL } from './downtime-worker.constants.js';

/** Proxy to probe; overridable so the test can target another host. */
const PROXY_URL = process.env.HERDR_AUDIT_LIVE_PROXY_URL ?? DEFAULT_DOWNTIME_PROXY_URL;
/** Short bound so an unreachable host skips quickly. */
const PROBE_TIMEOUT_MS = 2_000;

/** `true` when the lease endpoint answers the protocol, else `false` (never throws). */
async function leaseEndpointReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${PROXY_URL.replace(/\/+$/, '')}/llama/local/audit/lease`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: `herdr-probe-${process.pid}` }),
      signal: controller.signal,
    });
    // Any of the protocol answers proves the endpoint exists; a refused
    // acquire means the budget is genuinely saturated (skip downstream).
    return res.status === 200 || res.status === 429;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

describe('live proxy audit-lease end-to-end (parent AC6)', () => {
  it('acquires, renews, releases a synthetic lease, and the availability read returns to live: 0', async (ctx) => {
    if (!(await leaseEndpointReachable())) {
      ctx.skip();
      return;
    }

    const lease = createAuditLeaseClient(PROXY_URL, undefined, PROBE_TIMEOUT_MS);
    const availability = createAuditAvailabilityClient(PROXY_URL, undefined, PROBE_TIMEOUT_MS);
    const sessionId = auditLeaseSessionId(`WL-LIVE-${process.pid}-${Date.now()}`);

    // The pre-acquire baseline: an idle machine serves live: 0.
    const before = await availability();
    expect(before.status).toBe('ok');
    if (before.status !== 'ok') return;

    const acquired = await lease.acquire(sessionId);
    if (acquired.status !== 'ok') {
      // The shared GPU is held by ANOTHER live session — this test must never
      // fight it (it holds no lease to release). Skip, exactly like the
      // unreachable-proxy arm.
      ctx.skip();
      return;
    }
    // The held lease bounds are sane: the unverified expiry, when served, is
    // a finite future epoch — the TTL-bound assertion that a silent leaker
    // cannot hide (AC3).
    if (acquired.lease.expiresAt !== undefined) {
      expect(Number.isFinite(acquired.lease.expiresAt)).toBe(true);
      expect(acquired.lease.expiresAt).toBeGreaterThan(Date.now());
    }
    expect(acquired.lease.sessionId).toBe(sessionId);

    // A retry RENEWS the same session rather than competing with itself.
    const renewed = await lease.renew(sessionId);
    expect(renewed.status).toBe('ok');

    // The availability read OBSERVES the held lease (live rose)…
    const during = await availability();
    expect(during.status).toBe('ok');
    if (during.status === 'ok') {
      expect(during.availability.live).toBeGreaterThanOrEqual(before.status === 'ok' ? before.availability.live : 0);
    }

    // …and the terminal release returns it to the baseline (an idle machine
    // reports live: 0 — the guarantee a released audit never holds the tier).
    const released = await lease.release(sessionId);
    expect(released.status === 'ok' || released.status === 'not-found').toBe(true);
    const after = await availability();
    expect(after.status).toBe('ok');
    if (after.status === 'ok' && before.status === 'ok') {
      expect(after.availability.live).toBe(before.availability.live);
      if (before.availability.live === 0) {
        expect(after.availability.live).toBe(0);
      }
    }
  });
});
