/**
 * packages/herdr/src/downtime-worker.audit-availability.live.test.ts — the
 * live-proxy end-to-end check for the shipped audit-availability read
 * (parent WL-0MWFJ4LRH0025GGX AC4, child WL-0MWFJU0IU003D1J1).
 *
 * Unlike the contract/client suites, which drive injected fetcher doubles, this
 * test talks to the REAL proxy so a path or verdict-shape mismatch between
 * herdr and the shipped server is caught at test time rather than as a
 * constant `audit-budget-unknown` refusal in the decision log.
 *
 * It is deliberately environment-tolerant: when the proxy is unreachable (CI,
 * a laptop off the home network) the test SKIPS rather than fails. When it IS
 * reachable it asserts:
 *
 *   - `createAuditAvailabilityClient` resolves `status: 'ok'` (the shipped
 *     `/llama/local/audit/availability` path answers 2xx with a parsable body),
 *   - the shipped numeric verdict has been coerced to a real boolean, and
 *   - `decideAuditAvailability` maps that read to the admission decision —
 *     `{ active: false, budget: { live, max } }` — with the current machine's
 *     captured snapshot (`cap: 1`, `live: 0`) admitting `{ live: 0, max: 1 }`.
 */

import { describe, expect, it } from 'vitest';

import { createAuditAvailabilityClient } from './downtime-worker.audit-availability.js';
import { DEFAULT_DOWNTIME_PROXY_URL } from './downtime-worker.constants.js';
import { decideAuditAvailability } from './host-dispatch-budget.admission.js';

/** Proxy to probe; overridable so the test can target another host. */
const PROXY_URL = process.env.HERDR_AUDIT_LIVE_PROXY_URL ?? DEFAULT_DOWNTIME_PROXY_URL;
/** Short bound so an unreachable host skips quickly. */
const PROBE_TIMEOUT_MS = 2_000;

/** `true` when the shipped endpoint answers `200`, else `false` (never throws). */
async function shippedEndpointReachable(): Promise<boolean> {
  const url = `${PROXY_URL.replace(/\/+$/, '')}/llama/local/audit/availability`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

describe('live proxy audit-availability end-to-end (parent AC4)', () => {
  it('reads ok and maps to an admitting decision, or skips when unreachable', async (ctx) => {
    if (!(await shippedEndpointReachable())) {
      ctx.skip();
      return;
    }

    const read = createAuditAvailabilityClient(PROXY_URL, undefined, PROBE_TIMEOUT_MS);
    const outcome = await read();
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;

    // The shipped `available` verdict is numeric (0/1); the parser coerces it
    // to a real boolean, so the typed result never leaks the wire shape.
    expect(typeof outcome.availability.available).toBe('boolean');

    const decision = decideAuditAvailability(outcome);
    // The decision quotes the proxy verdict AND its live/cap evidence verbatim.
    expect(decision.active).toBe(!outcome.availability.available);
    expect(decision.budget).toEqual({
      live: outcome.availability.live,
      max: outcome.availability.cap,
    });

    // Current-machine snapshot (validated 2026-11-13): one audit slot, none
    // live, so the read admits with `{ live: 0, max: 1 }`. Guarded on the
    // observed figures so a genuinely-running audit does not make this brittle.
    if (outcome.availability.live === 0 && outcome.availability.cap === 1) {
      expect(outcome.availability.available).toBe(true);
      expect(decision).toEqual({ active: false, budget: { live: 0, max: 1 } });
    }
  });
});
