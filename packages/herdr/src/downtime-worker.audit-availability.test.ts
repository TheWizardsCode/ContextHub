/**
 * packages/herdr/src/downtime-worker.audit-availability.test.ts — the
 * fail-closed audit-availability GET client (parent WL-0MW95GBEG005ERHS,
 * child WL-0MWAMSCOP003R837).
 *
 * The client is the counterpart of `createLocalReserver`
 * (`downtime-worker.local-reservation.ts`) and `createDowntimePoller`
 * (`downtime-worker.poller.ts`): ONE bounded GET whose failure classification
 * is a TYPED outcome, so the dispatcher's policy (fail closed with a named
 * reason) never has to guess from an empty value.
 *
 * The proxy side (sibling llm item LP-0MW95FYMH006XYNK) has SHIPPED —
 * validated 2026-11-13, `GET /llama/local/audit/availability` answers `200`.
 * Every exchange here is still driven by an injected fetcher double, so the
 * unit suite never touches a network (the live check lives in
 * `downtime-worker.audit-availability.live.test.ts`).
 *
 * Traceability: each test cites the work-item AC it serves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuditAvailabilityClient } from './downtime-worker.audit-availability.js';
import { AUDIT_AVAILABILITY_PATH } from './downtime-worker.constants.js';
import { AUDIT_AVAILABILITY_PATH_ENV } from './downtime-worker.constants.js';
import {
  createAuditAvailabilityClient as barrelCreate,
  type AuditAvailabilityFetcher,
} from './downtime-worker.js';
import { jsonResponseFixture } from './downtime-worker.fixtures.js';

/** A usable proxy payload: two audit slots, one taken, admission open. */
const AVAILABLE_BODY = { cap: 2, live: 1, available: true };

/** A `AuditAvailabilityFetcher` double resolving one Response fixture. */
function fixtureFetcher(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(jsonResponseFixture(body, status));
}

/** Build the client with a fetcher double (casts the mock to the seam type). */
function clientWith(
  fetcher: ReturnType<typeof fixtureFetcher> | ReturnType<typeof vi.fn>,
  timeoutMs?: number,
) {
  return createAuditAvailabilityClient(
    'http://proxy:8000',
    fetcher as unknown as AuditAvailabilityFetcher,
    timeoutMs,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createAuditAvailabilityClient — the usable exchange (AC1)', () => {
  it('AC1: GETs {proxyUrl}{AUDIT_AVAILABILITY_PATH} and resolves the typed availability', async () => {
    const fetcher = fixtureFetcher(AVAILABLE_BODY);

    await expect(clientWith(fetcher)()).resolves.toEqual({
      status: 'ok',
      availability: { cap: 2, live: 1, available: true },
    });

    // Exactly one exchange per call, and it is a GET asking for JSON — never
    // a POST (the read has no request body).
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`http://proxy:8000${AUDIT_AVAILABILITY_PATH}`);
    expect(init.method).toBe('GET');
    expect(init.headers.accept).toBe('application/json');
  });

  it('AC2: normalises the proxy URL with the reserve client\'s trailing-slash convention', async () => {
    // A configured proxy URL may or may not end in `/` (the reserve client
    // strips every trailing slash), and both must form ONE documented URL.
    for (const proxyUrl of ['http://proxy:8000', 'http://proxy:8000/', 'http://proxy:8000///']) {
      const fetcher = fixtureFetcher(AVAILABLE_BODY);
      const client = createAuditAvailabilityClient(
        proxyUrl,
        fetcher as unknown as AuditAvailabilityFetcher,
      );

      await client();

      expect(fetcher.mock.calls[0][0]).toBe(`http://proxy:8000${AUDIT_AVAILABILITY_PATH}`);
    }
  });

  it('AC1/AC4: the proxy\'s own optional detail (leases, reclaimed, reason) survives the round trip', async () => {
    const fetcher = fixtureFetcher({
      cap: 1,
      live: 1,
      available: false,
      leases: [{ id: 'lease-1', expires_at: 1_763_000_000_000 }],
      reclaimed: 1,
      reason: 'audit-budget-saturated',
    });

    await expect(clientWith(fetcher)()).resolves.toEqual({
      status: 'ok',
      availability: {
        cap: 1,
        live: 1,
        available: false,
        leases: [{ id: 'lease-1', expiresAt: 1_763_000_000_000 }],
        reclaimed: 1,
        reason: 'audit-budget-saturated',
      },
    });
  });
});

describe('createAuditAvailabilityClient — path override (parent AC1)', () => {
  afterEach(() => {
    delete process.env[AUDIT_AVAILABILITY_PATH_ENV];
  });

  it('uses HERDR_AUDIT_AVAILABILITY_PATH when set, without recreating the client', async () => {
    delete process.env[AUDIT_AVAILABILITY_PATH_ENV];
    const fetcher = fixtureFetcher(AVAILABLE_BODY);
    const client = clientWith(fetcher);

    process.env[AUDIT_AVAILABILITY_PATH_ENV] = '/llama/local/audit/v2';
    await client();

    // Resolved per call: the override takes effect on the next read.
    expect(fetcher.mock.calls[0][0]).toBe('http://proxy:8000/llama/local/audit/v2');
  });

  it('falls back to the shipped path when the override is empty', async () => {
    process.env[AUDIT_AVAILABILITY_PATH_ENV] = '   ';
    const fetcher = fixtureFetcher(AVAILABLE_BODY);

    await clientWith(fetcher)();

    expect(fetcher.mock.calls[0][0]).toBe(`http://proxy:8000${AUDIT_AVAILABILITY_PATH}`);
  });
});

describe('createAuditAvailabilityClient — failure classification (AC3)', () => {
  it('AC3: a 404 is endpoint-absent (the proxy predates the endpoint), distinct from unreachable', async () => {
    await expect(clientWith(fixtureFetcher({ detail: 'Not Found' }, 404))()).resolves.toEqual({
      status: 'endpoint-absent',
      reason: 'http-404',
    });
  });

  it('AC3: a 5xx and a wire-contract 400 are unreachable, each naming the exchange', async () => {
    for (const [status, reason] of [
      [500, 'http-500'],
      [503, 'http-503'],
      [400, 'http-400'],
    ] as const) {
      const fetcher = fixtureFetcher({ error: 'boom' }, status);

      await expect(clientWith(fetcher)()).resolves.toEqual({
        status: 'unreachable',
        reason,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('AC3: a network rejection is unreachable/network — never thrown to the caller', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('fetch failed'), { name: 'TypeError' }));

    await expect(clientWith(fetcher)()).resolves.toEqual({
      status: 'unreachable',
      reason: 'network',
    });
  });

  it('AC3: a fetcher that throws synchronously is still a typed network outcome (never throws)', async () => {
    const fetcher = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(clientWith(fetcher)()).resolves.toEqual({
      status: 'unreachable',
      reason: 'network',
    });
  });

  it('AC3: the request is bounded by the timeout — the abort fires and resolves unreachable/timeout', async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    const fetcher = vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      seenSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
        );
      });
    });

    const pending = clientWith(fetcher, 25)();
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toEqual({ status: 'unreachable', reason: 'timeout' });
    // The bound is enforced by aborting the request, not by ignoring it.
    expect(seenSignal).toBeDefined();
    expect(seenSignal?.aborted).toBe(true);
  });

  it('AC3: a non-JSON body is unparsable/bad-body', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    await expect(clientWith(fetcher)()).resolves.toEqual({
      status: 'unparsable',
      reason: 'bad-body',
    });
  });
});

describe('createAuditAvailabilityClient — a rejected payload is never ok (AC4)', () => {
  it('AC4: a 2xx payload without the proxy\'s availability verdict is unparsable, never ok with partial data', async () => {
    // `cap` and `live` are present and plausible; only the proxy's OWN verdict
    // is missing. Deriving `available` locally would let a garbage payload
    // admit an audit — the parser refuses, so the client must too.
    const fetcher = fixtureFetcher({ cap: 2, live: 1 });

    await expect(clientWith(fetcher)()).resolves.toEqual({
      status: 'unparsable',
      reason: 'bad-body',
    });
  });

  it('AC4: a 2xx payload with a negative cap is unparsable (a malformed count never reads as capacity)', async () => {
    const fetcher = fixtureFetcher({ cap: -1, live: 0, available: true });

    const outcome = await clientWith(fetcher)();

    expect(outcome).toEqual({ status: 'unparsable', reason: 'bad-body' });
    expect(outcome.status).not.toBe('ok');
  });
});

describe('createAuditAvailabilityClient — timer hygiene (AC3)', () => {
  it('AC3: the abort timer is cleared after a successful call (no open handle)', async () => {
    vi.useFakeTimers();

    await clientWith(fixtureFetcher(AVAILABLE_BODY))();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('AC3: the abort timer is cleared after an unusable exchange (no open handle)', async () => {
    vi.useFakeTimers();

    await clientWith(fixtureFetcher({ error: 'boom' }, 500))();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('barrel wiring (AC1)', () => {
  it('AC1: re-exports the client from the downtime-worker barrel for the dispatcher deps', () => {
    expect(barrelCreate).toBe(createAuditAvailabilityClient);
  });
});
