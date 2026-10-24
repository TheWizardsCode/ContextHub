/**
 * packages/herdr/src/downtime-worker.reserve.test.ts — contract tests for the
 * local-proxy reservation handshake (parent WL-0MVIKRFP0005JDL8)
 *
 * Split into two slices:
 *   - C1 (`WL-0MVLJTP51003SME9`): pins the wire contract (constants, types,
 *     tolerant parser) BEFORE any client code exists.
 *   - C2 (`WL-0MVLJTR02007QL7Z`): the reserve CLIENT and the dispatch gate —
 *     granted → launch with the ticket, refused → defer and record,
 *     absent/500/timeout → today's fail-open polling behaviour.
 *
 * Traceability: every test name cites the work-item AC it serves (`C1-AC*`)
 * or, for the C2 slice, the parent AC it carries (`AC1`–`AC6`, matching the
 * C2 work-item's `C2-AC*`).
 *
 * Fixtures live in `downtime-worker.fixtures.ts` so no test needs an ad-hoc
 * inline response object.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_LOCAL_RESERVATION_EXPECTED_TOKENS,
  LOCAL_FALLBACK_REASON_HEADER,
  LOCAL_PREFERENCE_HEADER,
  LOCAL_RESERVATION_HEADER,
  LOCAL_RESERVATION_TICKET_ENV,
  LOCAL_RESERVE_PATH,
  LOCAL_ROUTE_HEADER,
  buildDowntimePaneArgs,
  buildDowntimeSpawnOptions,
  buildLocalReservationRequest,
  createDowntimePoller,
  createDowntimeWorker,
  createLocalReserver,
  decisionHeaderToken,
  parseLocalReservationResponse,
  type DowntimeWorkerDeps,
  type LocalReserveFetcher,
} from './downtime-worker.js';
import {
  ago,
  idleAllSlotsFree,
  jsonResponseFixture,
  makeDeps,
  prefillCapReached,
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

// ══════════════════════════════════════════════════════════════════════
// C2 — reserve client + fail-open dispatch gate
// (WL-0MVLJTR02007QL7Z, parent WL-0MVIKRFP0005JDL8 AC1/AC2/AC4)
// ══════════════════════════════════════════════════════════════════════

/** The worker cwd used by the tick harness (never touched on disk). */
const C2_CWD = '/repo';

/** A dispatchable plan-tier candidate (open at `intake_complete`). */
function planCandidate(id = 'WL-PLAN-1') {
  return {
    id,
    title: `Plan ${id}`,
    status: 'open',
    stage: 'intake_complete',
    priority: 'medium',
    sortIndex: 0,
    updatedAt: ago(60_000),
  };
}

/**
 * Drive a worker through one idle dispatch tick: the first `tick()` starts
 * the idle run, the second runs at the threshold and attempts a dispatch.
 * Mirrors the production tick cadence; no standalone timer is introduced.
 */
async function runDispatchTick(
  deps: DowntimeWorkerDeps,
  opts: { status?: unknown; requiredFreeSlots?: number } = {},
) {
  const pollFetch = vi.fn().mockResolvedValue(jsonResponseFixture(opts.status ?? idleAllSlotsFree));
  const worker = createDowntimeWorker({
    poller: createDowntimePoller('http://proxy:8000', pollFetch),
    deps,
    config: () => ({
      enabled: true,
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: opts.requiredFreeSlots ?? 0,
      model: 'plan',
      cwd: C2_CWD,
      noCandidateCooldownMs: 3_600_000,
    }),
  });
  const start = 1_000_000;
  vi.useFakeTimers();
  try {
    vi.setSystemTime(start);
    await worker.tick(); // idle run starts
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    return await worker.tick(); // dispatch tick
  } finally {
    vi.useRealTimers();
  }
}

/**
 * The `(reason, fields)` pairs a `recordDecision` dep mock observed. The dep
 * contract is `recordDecision(entry, cwd)`, so the entry itself carries the
 * reason and the decision fields.
 */
function recordedDecisions(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.map(([entry]) => ({
    reason: (entry as { reason?: string }).reason ?? '',
    fields: entry as Record<string, unknown>,
  }));
}

/** A `LocalReserveFetcher` double resolving one fixture response. */
function fixtureFetcher(fixture: { status: number; body: unknown }) {
  return vi.fn().mockResolvedValue(jsonResponseFixture(fixture.body, fixture.status));
}

const RESERVE_REQUEST = { expected_tokens: 8192, priority: 'background', cache_state: 'unknown' } as const;

describe('createLocalReserver — reserve client (AC1)', () => {
  it('AC1: POSTs the request to {proxyUrl}/llama/local/reserve and returns the typed ticket', async () => {
    const fetcher = fixtureFetcher(reserveGranted());
    const reserve = createLocalReserver('http://proxy:8000/', fetcher as unknown as LocalReserveFetcher);

    const result = await reserve({ ...RESERVE_REQUEST });

    expect(result).toEqual({
      status: 'granted',
      ticket: { ticketId: 'tkt-granted-1', ttlSeconds: 30 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`http://proxy:8000${LOCAL_RESERVE_PATH}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(RESERVE_REQUEST);
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('AC1: a 429 response is surfaced as a typed refusal (ok=false is still parsed)', async () => {
    const reserve = createLocalReserver(
      'http://proxy:8000',
      fixtureFetcher(reserveRefused429()) as unknown as LocalReserveFetcher,
    );

    await expect(reserve({ ...RESERVE_REQUEST })).resolves.toEqual({
      status: 'refused',
      refusal: { reason: 'prefill-gate', retryAfterSeconds: 12 },
    });
  });

  it('AC3: absent (404) and server-error (500) endpoints fail open to null, one request each', async () => {
    for (const fixture of [reserveEndpointAbsent, reserveServerError]) {
      const fetcher = fixtureFetcher(fixture);
      const reserve = createLocalReserver(
        'http://proxy:8000',
        fetcher as unknown as LocalReserveFetcher,
      );
      await expect(reserve({ ...RESERVE_REQUEST })).resolves.toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('AC3: a timed-out / aborted reserve fails open to null and never throws', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    const reserve = createLocalReserver(
      'http://proxy:8000',
      fetcher as unknown as LocalReserveFetcher,
    );

    await expect(reserve({ ...RESERVE_REQUEST })).resolves.toBeNull();
  });

  it('AC3: a 2xx with an unusable body fails open to null (no throw)', async () => {
    const reserve = createLocalReserver(
      'http://proxy:8000',
      fixtureFetcher({ status: 200, body: '<html>not json</html>' }) as unknown as LocalReserveFetcher,
    );

    await expect(reserve({ ...RESERVE_REQUEST })).resolves.toBeNull();
  });
});

describe('reserve client — request shape (AC1)', () => {
  it('AC1: a downtime dispatch reserves a background, cache-unknown turn', () => {
    const request = buildLocalReservationRequest({ priority: 'critical' });

    expect(request).toEqual({
      expected_tokens: DEFAULT_LOCAL_RESERVATION_EXPECTED_TOKENS,
      priority: 'background',
      cache_state: 'unknown',
    });
  });
});

describe('ticket forwarding to the pane (AC1)', () => {
  it('AC1: pins the pane-launch env var read by the Worklog pi extension', () => {
    // The extension (slice C4) turns this variable into
    // `X-Local-Reservation` on the pane's first request.
    expect(LOCAL_RESERVATION_TICKET_ENV).toBe('PI_LOCAL_RESERVATION_TICKET');
  });

  it('AC1: a granted ticket is forwarded as --reservation-ticket and the pane env', () => {
    const args = buildDowntimePaneArgs('plan', '/skill:plan WL-X', {
      model: 'code',
      cwd: C2_CWD,
      reservationTicketId: 'tkt-granted-1',
    });
    const idx = args.indexOf('--reservation-ticket');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('tkt-granted-1');

    const spawn = buildDowntimeSpawnOptions(C2_CWD, {
      priority: 'low',
      reservationTicketId: 'tkt-granted-1',
    });
    expect(spawn.env[LOCAL_RESERVATION_TICKET_ENV]).toBe('tkt-granted-1');
  });

  it('AC1: no ticket (older proxy / refused) leaves the launch byte-identical', () => {
    const args = buildDowntimePaneArgs('plan', '/skill:plan WL-X', { model: 'code', cwd: C2_CWD });
    expect(args).not.toContain('--reservation-ticket');

    const spawn = buildDowntimeSpawnOptions(C2_CWD, { priority: 'low' });
    expect(spawn.env[LOCAL_RESERVATION_TICKET_ENV]).toBeUndefined();
  });
});

describe('dispatch reserve gate — granted (AC1)', () => {
  it('AC1: a granted ticket releases the spawn, which carries the reservation', async () => {
    const fetchStub = fixtureFetcher(reserveGranted());
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
      recordDecision,
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps);

    expect(outcome.dispatched).toBe(true);
    // Exactly one reserve request — it rides the poll cadence (AC5).
    expect(fetchStub).toHaveBeenCalledTimes(1);
    // Only after the ticket is granted does the pane spawn, carrying it.
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.reservationTicketId).toBe('tkt-granted-1');
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ reservationTicketId: 'tkt-granted-1' }),
    );
    // A grant is not a refusal — no no-dispatch entry is written for it.
    expect(recordedDecisions(recordDecision).some((d) => d.fields.admit === true)).toBe(false);
  });
});

describe('dispatch reserve gate — refused (AC2/AC4)', () => {
  it('AC2/AC4: a 429 refusal defers, records the evidence and never spawns', async () => {
    const fetchStub = fixtureFetcher(reserveRefused429({ reason: 'queue-full', retry_after_s: 12 }));
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
      recordDecision,
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps);

    expect(outcome.dispatched).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    // The spawn path never runs — and no success marker is written.
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    // The claim is rolled back so the item is selectable next idle period.
    expect(deps.rollbackClaim).toHaveBeenCalledTimes(1);
    // The proxy's refusal reason is carried into the decision entry, with
    // the retry advice and `admit: false` evidence (AC2/AC4).
    const refusal = recordedDecisions(recordDecision).find((d) => d.reason === 'queue-full');
    expect(refusal).toBeDefined();
    expect(refusal?.fields).toMatchObject({
      admit: false,
      retryAfterS: 12,
      projectedWaitS: 12,
    });
  });

  it('AC2: each refusal reason keeps its own distinct header token', () => {
    for (const reason of ['reserved-fallback', 'prefill-gate', 'queue-full']) {
      expect(decisionHeaderToken(reason)).toBe(reason);
    }
  });
});

describe('dispatch reserve gate — fail-open backcompat (AC3)', () => {
  it('AC3: a 404 (endpoint absent) dispatches exactly as today, with no retry storm', async () => {
    const fetchStub = fixtureFetcher(reserveEndpointAbsent);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps);

    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.reservationTicketId).toBeUndefined();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('AC3: a 500 (server error) dispatches exactly as today, with no retry storm', async () => {
    const fetchStub = fixtureFetcher(reserveServerError);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps);

    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('AC3: a timed-out reserve dispatches exactly as today — no crash, no stuck pane', async () => {
    const fetchStub = vi.fn().mockRejectedValue(new Error('reserve timed out'));
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps);

    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('AC3: with no reserve client wired the dispatcher is unchanged (today)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
    });

    const outcome = await runDispatchTick(deps);

    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.reservationTicketId).toBeUndefined();
  });
});

describe('dispatch reserve gate — decision-log evidence (AC4)', () => {
  it('AC4: a granted ticket that cannot reach the pane is recorded as released', async () => {
    const fetchStub = fixtureFetcher(reserveGranted());
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
      recordDecision,
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'spawn boom' }),
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps);

    expect(outcome.dispatched).toBe(false);
    const failure = recordedDecisions(recordDecision).find((d) => d.reason === 'spawn-failed');
    expect(failure).toBeDefined();
    // The ticket is never reused: the log shows it released/expired.
    expect(failure?.fields).toMatchObject({
      admit: true,
      reservationTicket: expect.objectContaining({ id: 'tkt-granted-1' }),
      reservationReleased: true,
    });
    expect(failure?.fields.reservationTicket).toHaveProperty('grantedAt');
  });
});

describe('dispatch reserve gate — call-count bounds (AC5)', () => {
  it('AC5: at most one reserve request per poll, riding the existing poll cadence', async () => {
    const fetchStub = fixtureFetcher(reserveGranted());
    const deps = makeDeps({
      getHerdrListHead: vi
        .fn()
        .mockResolvedValue({ ok: true, items: [planCandidate('WL-A'), planCandidate('WL-B')] }),
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps);

    expect(outcome.dispatched).toBe(true);
    // Multiple candidates are ranked, but a poll asks for exactly one ticket.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });
});

describe('dispatch reserve gate — pacing preserved (AC6)', () => {
  it('AC6: prefill-cap pacing refuses before any reserve request (no budget raised)', async () => {
    const fetchStub = fixtureFetcher(reserveGranted());
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
      recordDecision,
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps, {
      status: prefillCapReached,
      requiredFreeSlots: 1,
    });

    expect(outcome.dispatched).toBe(false);
    // The fail-closed pacing gate runs BEFORE the reservation: no ticket is
    // requested and no spawn happens.
    expect(fetchStub).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(recordedDecisions(recordDecision).some((d) => d.reason === 'prefill-cap')).toBe(true);
  });
});
