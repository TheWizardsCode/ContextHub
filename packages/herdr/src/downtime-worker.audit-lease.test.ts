/**
 * packages/herdr/src/downtime-worker.audit-lease.test.ts — the bounded
 * audit-lease client (WL-0MWFJH3NW006F5GN AC1/AC5).
 *
 * The client is the counterpart of `createAuditAvailabilityClient`: ONE
 * bounded call per verb — acquire / renew / release — each resolved as a
 * TYPED outcome, so the admission policy (proceed only on 200, map 429/503 to
 * the shared tokens, fail closed on transport) never has to guess from an
 * empty value.
 *
 * The proxy side (sibling llm item LP-0MW95FYMH006XYNK) has SHIPPED — the
 * session-id-stable acquire protocol, `retry_after_s` on 429, and the
 * `audit-budget-unavailable` 503 token are pinned as CAPTURED payloads here
 * (the acquire response expiry shape is unverified, so every verb's 2xx body
 * is read through the tolerant alias normaliser). Every exchange is driven by
 * an injected fetcher double — the live check lives in
 * `downtime-worker.audit-lease.live.test.ts`.
 *
 * Traceability: each test cites the work-item AC it serves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  auditLeaseSessionId,
  createAuditLeaseClient,
  parseAuditLeaseBody,
  parseRetryAfterSeconds,
  type AuditLeaseFetcher,
} from './downtime-worker.audit-lease.js';
import {
  AUDIT_BUDGET_SATURATED_REASON,
  AUDIT_BUDGET_UNAVAILABLE_REASON,
} from './downtime-worker.audit-availability.contract.js';
import { AUDIT_LEASE_PATH, AUDIT_LEASE_RENEW_PATH } from './downtime-worker.constants.js';
import { jsonResponseFixture } from './downtime-worker.fixtures.js';
import { timeoutErrorFixture, networkErrorFixture } from './downtime-worker.fixtures.js';

/** The captured 200 acquire body (expiry served as epoch ms via `expires_at`). */
const ACQUIRE_OK_BODY = { session_id: 'herdr-audit-WL-X', expires_at: 1_770_000_000_000 };
/** The captured 429 payload: the shared saturated token + the bounded cooldown. */
const SATURATED_BODY = { reason: 'audit-budget-saturated', retry_after_s: 30 };
/** The captured 503 payload: the proxy registry-failure token. */
const REGISTRY_FAIL_BODY = { reason: 'audit-budget-unavailable' };

function clientWith(fetcher: ReturnType<typeof vi.fn>, timeoutMs?: number) {
  return createAuditLeaseClient(
    'http://proxy:8000',
    fetcher as unknown as AuditLeaseFetcher,
    timeoutMs,
  );
}

function acquireBody(session: string): string {
  return JSON.stringify({ session_id: session });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('auditLeaseSessionId — stable per dispatch attempt, derived from the item (AC1)', () => {
  it('is deterministic and names the dispatched item', () => {
    expect(auditLeaseSessionId('WL-ABC')).toBe('herdr-audit-WL-ABC');
    expect(auditLeaseSessionId('WL-ABC')).toBe(auditLeaseSessionId('WL-ABC'));
    expect(auditLeaseSessionId('WL-ABC')).not.toBe(auditLeaseSessionId('WL-DEF'));
  });
});

describe('acquire — one bounded POST, 200 is the only usable arm (AC1/AC2)', () => {
  it('POSTs {proxyUrl}{AUDIT_LEASE_PATH} with the session id and resolves ok on 200', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(ACQUIRE_OK_BODY, 200));
    const client = clientWith(fetcher);

    await expect(client.acquire('herdr-audit-WL-X')).resolves.toEqual({
      status: 'ok',
      lease: { sessionId: 'herdr-audit-WL-X', expiresAt: ACQUIRE_OK_BODY.expires_at },
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`http://proxy:8000${AUDIT_LEASE_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe(acquireBody('herdr-audit-WL-X'));
  });

  it('reads the unverified expiry through the tolerant normaliser and pins the alias set', async () => {
    // The acquire response's expiry shape is UNVERIFIED: every documented
    // alias is accepted as epoch-ms or a Date.parse-able string, and the
    // echoed session id wins over the requested one when served.
    expect(parseAuditLeaseBody({ expires_at: 123, session_id: 'echoed' }, 'requested')).toEqual({
      sessionId: 'echoed',
      expiresAt: 123,
    });
    expect(parseAuditLeaseBody({ expiry: '2030-01-01T00:00:00Z' }, 'requested')).toEqual({
      sessionId: 'requested',
      expiresAt: Date.parse('2030-01-01T00:00:00Z'),
    });
    expect(parseAuditLeaseBody({ expiresAt: 456 }, 'requested')).toEqual({
      sessionId: 'requested',
      expiresAt: 456,
    });
    // A non-object body (or one without an expiry) is still a held lease — the
    // 200 status IS the reservation; expiry is evidence only.
    expect(parseAuditLeaseBody(null, 'requested')).toEqual({ sessionId: 'requested' });
    expect(parseAuditLeaseBody('garbage', 'requested')).toEqual({ sessionId: 'requested' });
    // A malformed expiry alias fails closed (no expiry), never a fabricated one.
    expect(parseAuditLeaseBody({ expires_at: 'not-a-date' }, 'requested')).toEqual({
      sessionId: 'requested',
    });
  });

  it('a 429 maps to the shared audit-budget-saturated token and honours the bounded retry_after_s', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(SATURATED_BODY, 429));
    const client = clientWith(fetcher);

    await expect(client.acquire('herdr-audit-WL-X')).resolves.toEqual({
      status: 'saturated',
      reason: AUDIT_BUDGET_SATURATED_REASON,
      retryAfterS: 30,
    });
    // The refusal stands even when the body carries no cooldown (429 is
    // saturation by status) — it simply carries no deferral advice.
    const noAdvice = vi.fn().mockResolvedValue(jsonResponseFixture({}, 429));
    await expect(clientWith(noAdvice).acquire('s')).resolves.toEqual({
      status: 'saturated',
      reason: AUDIT_BUDGET_SATURATED_REASON,
    });
    expect(parseRetryAfterSeconds({ retry_after_s: 12 })).toBe(12);
    expect(parseRetryAfterSeconds({ retry_after_seconds: 12 })).toBe(12);
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
  });

  it('a 503 maps to audit-budget-unavailable — the proxy registry token, never the local unknown', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(REGISTRY_FAIL_BODY, 503));
    await expect(clientWith(fetcher).acquire('s')).resolves.toEqual({
      status: 'unavailable',
      reason: AUDIT_BUDGET_UNAVAILABLE_REASON,
    });
  });

  it('a 404 is endpoint-absent (the sibling endpoint has not shipped), distinct from saturation', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture({}, 404));
    await expect(clientWith(fetcher).acquire('s')).resolves.toEqual({
      status: 'endpoint-absent',
      reason: 'http-404',
    });
  });

  it('every other status and every transport fault fails closed as unreachable with the named exchange', async () => {
    const http500 = vi.fn().mockResolvedValue(jsonResponseFixture({}, 500));
    await expect(clientWith(http500).acquire('s')).resolves.toEqual({
      status: 'unreachable',
      reason: 'http-500',
    });

    const netFail = vi.fn().mockRejectedValue(networkErrorFixture);
    await expect(clientWith(netFail).acquire('s')).resolves.toEqual({
      status: 'unreachable',
      reason: 'network',
    });

    const timedOut = vi.fn().mockRejectedValue(timeoutErrorFixture);
    await expect(clientWith(timedOut).acquire('s')).resolves.toEqual({
      status: 'unreachable',
      reason: 'timeout',
    });
  });

  it('a 2xx body that is not JSON stays a HOLD (status-driven verdict): never a leak-by-fail-closed', async () => {
    // Unlike the availability GET, the acquire carries the answer in the
    // STATUS. A granted-but-odd body must not turn the grant into unparsable —
    // failing closed there would leak a lease herdr never releases.
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(clientWith(fetcher).acquire('s')).resolves.toEqual({
      status: 'ok',
      lease: { sessionId: 's' },
    });
  });

  it('is bounded by the default poll timeout and resolves timeout on abort, never an open handle', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(timeoutErrorFixture));
        }),
    );
    const client = clientWith(fetcher as unknown as ReturnType<typeof vi.fn>);
    const pending = client.acquire('s');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ status: 'unreachable', reason: 'timeout' });
  });
});

describe('renew — one bounded POST to the renew path (AC1/AC5)', () => {
  it('POSTs {proxyUrl}{AUDIT_LEASE_RENEW_PATH} with the session id and resolves ok on 200', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(ACQUIRE_OK_BODY, 200));
    const client = clientWith(fetcher);

    await expect(client.renew('herdr-audit-WL-X')).resolves.toEqual({
      status: 'ok',
      lease: { sessionId: 'herdr-audit-WL-X', expiresAt: ACQUIRE_OK_BODY.expires_at },
    });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`http://proxy:8000${AUDIT_LEASE_RENEW_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(acquireBody('herdr-audit-WL-X'));
  });

  it('a 404 is not-found: renewing a foreign/expired session must never look like success', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture({}, 404));
    await expect(clientWith(fetcher).renew('foreign')).resolves.toEqual({
      status: 'not-found',
      reason: 'http-404',
    });
  });

  it('transport faults fail closed as unreachable', async () => {
    const netFail = vi.fn().mockRejectedValue(networkErrorFixture);
    await expect(clientWith(netFail).renew('s')).resolves.toEqual({
      status: 'unreachable',
      reason: 'network',
    });
  });
});

describe('release — one bounded DELETE, idempotent (AC1/AC3/AC5)', () => {
  it('DELETEs {proxyUrl}{AUDIT_LEASE_PATH}/{encoded session} and resolves ok on 200', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture({}, 200));
    const client = clientWith(fetcher);

    await expect(client.release('herdr-audit-WL-ABC')).resolves.toEqual({ status: 'ok' });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`http://proxy:8000${AUDIT_LEASE_PATH}/${encodeURIComponent('herdr-audit-WL-ABC')}`);
    expect(init.method).toBe('DELETE');
  });

  it('a 404 is a successful no-op (not-found): releasing an unheld session is never an error', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture({}, 404));
    await expect(clientWith(fetcher).release('absent')).resolves.toEqual({
      status: 'not-found',
      reason: 'http-404',
    });
  });

  it('transport faults fail closed as unreachable', async () => {
    const netFail = vi.fn().mockRejectedValue(networkErrorFixture);
    await expect(clientWith(netFail).release('s')).resolves.toEqual({
      status: 'unreachable',
      reason: 'network',
    });
  });
});

describe('wait — the two-session race at the client seam (AC5)', () => {
  it('the SECOND session is refused 429 while the first holds, and the first can renew rather than compete', async () => {
    // A minimal in-process lease registry: the FIRST session id acquires
    // (200), a DIFFERENT session is refused (429), and the first session's
    // re-acquire (retry) RENEWS rather than competes — the AC1 discipline.
    const held = new Set<string>();
    const fetcher = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      const body = JSON.parse(String(init.body ?? '{}')) as { session_id?: string };
      if (init.method === 'POST' && url.endsWith(AUDIT_LEASE_PATH)) {
        if (held.size > 0 && !held.has(body.session_id as string)) {
          return jsonResponseFixture(SATURATED_BODY, 429);
        }
        held.add(body.session_id as string);
        return jsonResponseFixture({ session_id: body.session_id }, 200);
      }
      if (init.method === 'DELETE') {
        // The release verb carries the session in the URL, never a body.
        held.delete(decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)));
        return jsonResponseFixture({}, 200);
      }
      return jsonResponseFixture({}, 404);
    });
    const client = clientWith(fetcher);

    // Host A holds.
    const a = await client.acquire('session-A');
    expect(a).toMatchObject({ status: 'ok' });
    expect(held).toEqual(new Set(['session-A']));

    // Host B (different session) is refused with the bounded cooldown.
    const b = await client.acquire('session-B');
    expect(b).toEqual({
      status: 'saturated',
      reason: AUDIT_BUDGET_SATURATED_REASON,
      retryAfterS: 30,
    });
    expect(held).toEqual(new Set(['session-A']));

    // Host A's retry RENEWS its own lease instead of competing with itself.
    await expect(client.acquire('session-A')).resolves.toMatchObject({ status: 'ok' });

    // Release frees the budget for B.
    await expect(client.release('session-A')).resolves.toEqual({ status: 'ok' });
    expect(held).toEqual(new Set([]));
    await expect(client.acquire('session-B')).resolves.toMatchObject({ status: 'ok' });
  });
});
