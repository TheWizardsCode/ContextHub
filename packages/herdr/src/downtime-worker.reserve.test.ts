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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_LOCAL_RESERVATION_ESTIMATED_TOKENS,
  DEFAULT_LOCAL_RESERVATION_EXPECTED_TOKENS,
  DEFAULT_RESERVATION_TTL_SECONDS,
  LOCAL_FALLBACK_REASON_HEADER,
  LOCAL_PREFERENCE_ENV_VAR,
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
  reserveWireContractBroken,
} from './downtime-worker.fixtures.js';
import { defaultSettings, loadSettings } from './settings.js';

/** Parse a fixture exactly as the C2 client will after reading the response. */
function parse(fixture: { status: number; body: unknown }) {
  return parseLocalReservationResponse(fixture.body, fixture.status);
}

/** Write a herdr settings file with the supplied keys and return its path. */
function tempSettingsPathWith(values: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'herdr-reserve-settings-')), 'settings.json');
  writeFileSync(path, JSON.stringify(values), 'utf-8');
  return path;
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

  it('AC5: pins the LIVE proxy grant shape (reservation_id + ttl_s) so a rename can never degrade silently', () => {
    // Captured from the running proxy (2026-11-01, non-dry-run):
    // `{"admit":true,"reservation_id":"…","projected_wait_s":13.1,"ttl_s":10}`.
    // The parser reads `reservation_id` FIRST — without this pin the old
    // `ticket_id` accessor would silently fail open (bad-body) and the ticket
    // would never reach the pane, exactly the silent degradation this item
    // exists to prevent.
    expect(
      parse({
        status: 200,
        body: {
          admit: true,
          reservation_id: 'cc4dfc109cdb8a9aeb90459f410555743fe706ccef9c0617',
          projected_wait_s: 13.1,
          ttl_s: 10,
        },
      }),
    ).toEqual({
      status: 'granted',
      ticket: {
        ticketId: 'cc4dfc109cdb8a9aeb90459f410555743fe706ccef9c0617',
        ttlSeconds: 10,
      },
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
        reservation_id: undefined,
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
    expect(parse(reserveGranted({ reservation_id: undefined }))).toBeNull();
    expect(parse(reserveGranted({ reservation_id: '' }))).toBeNull();
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
  opts: {
    status?: unknown;
    requiredFreeSlots?: number;
    /** Per-turn locality preference (C4-AC1); absent → legacy config shape. */
    localPreference?: 'local-preferred' | 'remote-ok';
    /**
     * Locality precedence opt-in (WL-0MVNUIW77000VYAX AC4); absent → legacy
     * fixed forwarding (no marker fields).
     */
    localPreferenceMode?: 'operator-setting' | 'priority-rule';
  } = {},
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
      ...(opts.localPreference !== undefined ? { localPreference: opts.localPreference } : {}),
      ...(opts.localPreferenceMode !== undefined
        ? { localPreferenceMode: opts.localPreferenceMode }
        : {}),
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

const RESERVE_REQUEST = {
  estimated_tokens: DEFAULT_LOCAL_RESERVATION_ESTIMATED_TOKENS,
  priority: 'background',
  cache_state: 'unknown',
} as const;

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

  it('AC3: absent (404) and server-error (500) endpoints fail open to an unavailable outcome naming the exchange, one request each', async () => {
    for (const [fixture, reason] of [
      [reserveEndpointAbsent, 'http-404'],
      [reserveServerError, 'http-500'],
    ] as const) {
      const fetcher = fixtureFetcher(fixture);
      const reserve = createLocalReserver(
        'http://proxy:8000',
        fetcher as unknown as LocalReserveFetcher,
      );
      // AC4 (WL-0MVWEZF4Z004UNYT): an unusable exchange is a TYPED
      // `unavailable` outcome naming the failing exchange — never a bare
      // null and never a refusal, so a broken contract (400) can never look
      // like an old proxy (404) or a paced stop (429).
      await expect(reserve({ ...RESERVE_REQUEST })).resolves.toEqual({
        status: 'unavailable',
        reason,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('AC4: a wire-contract 400 (missing estimated_tokens) is recorded as http-400, distinct from an old proxy (404)', async () => {
    // The exact 400 the proxy answers for a body without `estimated_tokens`:
    // with the AC1 fix the client never SENDS such a body, but a future
    // rename on either side must surface here as `http-400` — never as the
    // old-proxy fail-open this item's bug hid behind.
    const contractFetcher = fixtureFetcher(reserveWireContractBroken);
    const reserve = createLocalReserver(
      'http://proxy:8000',
      contractFetcher as unknown as LocalReserveFetcher,
    );

    await expect(reserve({ ...RESERVE_REQUEST })).resolves.toEqual({
      status: 'unavailable',
      reason: 'http-400',
    });
  });

  it('AC4: http-400 (contract break) and http-404 (old proxy) are DISTINCT reasons', async () => {
    const contract = await createLocalReserver(
      'http://proxy:8000',
      fixtureFetcher(reserveWireContractBroken) as unknown as LocalReserveFetcher,
    )({ ...RESERVE_REQUEST });
    const absent = await createLocalReserver(
      'http://proxy:8000',
      fixtureFetcher(reserveEndpointAbsent) as unknown as LocalReserveFetcher,
    )({ ...RESERVE_REQUEST });

    expect(contract).toEqual({ status: 'unavailable', reason: 'http-400' });
    expect(absent).toEqual({ status: 'unavailable', reason: 'http-404' });
    // A broken contract can never again look like an old proxy.
    expect(contract).not.toEqual(absent);
  });

  it('AC3: a timed-out / aborted reserve fails open to an unavailable timeout outcome and never throws', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    const reserve = createLocalReserver(
      'http://proxy:8000',
      fetcher as unknown as LocalReserveFetcher,
    );

    await expect(reserve({ ...RESERVE_REQUEST })).resolves.toEqual({
      status: 'unavailable',
      reason: 'timeout',
    });
  });

  it('AC3: a 2xx with an unusable body fails open to an unavailable bad-body outcome (no throw)', async () => {
    const reserve = createLocalReserver(
      'http://proxy:8000',
      fixtureFetcher({ status: 200, body: '<html>not json</html>' }) as unknown as LocalReserveFetcher,
    );

    await expect(reserve({ ...RESERVE_REQUEST })).resolves.toEqual({
      status: 'unavailable',
      reason: 'bad-body',
    });
  });
});

describe('reserve client — request shape (AC1, WL-0MVWEZF4Z004UNYT)', () => {
  it('AC1: a downtime dispatch reserves a background, cache-unknown turn with the proxy contract field estimated_tokens', () => {
    const request = buildLocalReservationRequest({ priority: 'critical' });

    expect(request).toEqual({
      estimated_tokens: DEFAULT_LOCAL_RESERVATION_ESTIMATED_TOKENS,
      priority: 'background',
      cache_state: 'unknown',
    });
  });

  it('AC1: pins the exact wire body against the documented proxy contract (admission_reserve.py)', () => {
    // The proxy handler reads ONLY `estimated_tokens` and answers 400 for
    // any other spelling — the original `expected_tokens` name made this
    // handshake fail open silently (the bug this item fixes). This is the
    // rename-canary: a rename on either side fails HERE, not as a silent
    // null in a dispatch record.
    const body = buildLocalReservationRequest({ priority: 'background' });
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['estimated_tokens']));
    expect(body.estimated_tokens).toBe(DEFAULT_LOCAL_RESERVATION_ESTIMATED_TOKENS);
    expect((body as unknown as Record<string, unknown>).expected_tokens).toBeUndefined();
    // The constant name mirrors the wire field (both renamed together).
    expect(DEFAULT_LOCAL_RESERVATION_ESTIMATED_TOKENS).toBe(8_192);
  });

  it('AC9: pins the documented client-side TTL bound (proxy DEFAULT_RESERVE_TTL_SECONDS = 10)', () => {
    // Mirrors `llm/proxy/proxy/admission_reserve.py` — a grant below this
    // window is never treated as capacity by the dispatcher.
    expect(DEFAULT_RESERVATION_TTL_SECONDS).toBe(10);
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

// ══════════════════════════════════════════════════════════════════════
// Per-turn local preference forwarding (slice C4, parent AC4)
// ══════════════════════════════════════════════════════════════════════

describe('local-preference forwarding to the pane (C4-AC1)', () => {
  it('C4-AC1: forwards --local-preference and HERDR_LOCAL_PREFERENCE for both values', () => {
    for (const preference of ['local-preferred', 'remote-ok'] as const) {
      const args = buildDowntimePaneArgs('plan', '/skill:plan WL-X', {
        model: 'code',
        cwd: C2_CWD,
        localPreference: preference,
      });
      const idx = args.indexOf('--local-preference');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe(preference);
      // The command must stay the final argv token.
      expect(args[args.length - 1]).toBe('/skill:plan WL-X');

      const spawn = buildDowntimeSpawnOptions(C2_CWD, {
        priority: 'low',
        localPreference: preference,
      });
      expect(spawn.env[LOCAL_PREFERENCE_ENV_VAR]).toBe(preference);
    }
  });

  it('C4-AC3: no preference leaves the launch byte-identical (fail-open)', () => {
    // Pin the ambient environment: the suite itself can run inside a
    // `local-preferred` downtime pane (which exports `HERDR_LOCAL_PREFERENCE`), and
    // the fail-open contract must hold regardless — an inherited launcher
    // value must never reach the child pane (WL-0MVP643Q4007BZJ8).
    const savedPreference = process.env[LOCAL_PREFERENCE_ENV_VAR];
    process.env[LOCAL_PREFERENCE_ENV_VAR] = 'local-preferred';
    try {
      const args = buildDowntimePaneArgs('plan', '/skill:plan WL-X', { model: 'code', cwd: C2_CWD });
      expect(args).not.toContain('--local-preference');

      const spawn = buildDowntimeSpawnOptions(C2_CWD, { priority: 'low' });
      expect(spawn.env[LOCAL_PREFERENCE_ENV_VAR]).toBeUndefined();
    } finally {
      if (savedPreference === undefined) delete process.env[LOCAL_PREFERENCE_ENV_VAR];
      else process.env[LOCAL_PREFERENCE_ENV_VAR] = savedPreference;
    }
  });

  it('C4-AC1: a dispatch configured with a preference carries it into the spawn', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
    });

    const outcome = await runDispatchTick(deps, { localPreference: 'remote-ok' });

    expect(outcome.dispatched).toBe(true);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.localPreference).toBe('remote-ok');
  });

  it(
    'AC4/AC5: the settings value reaches the pane — remote-ok by default, local-preferred when persisted',
    async () => {
      // `index.ts` always supplies `loadSettings().downtimeLocalPreference`, so
      // an unconfigured deployment (no persisted key) dispatches with the
      // settings default (WL-0MVNUHWH500196K1 AC4), while an explicit
      // `local-preferred` opt-in is forwarded verbatim and never overridden (AC5).
      expect(defaultSettings.downtimeLocalPreference).toBe('remote-ok');

      for (const preference of ['remote-ok', 'local-preferred'] as const) {
        const deps = makeDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
        });

        const outcome = await runDispatchTick(deps, { localPreference: preference });

        expect(outcome.dispatched).toBe(true);
        const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(spawnOpts.localPreference).toBe(preference);

        // The same value is what the pane-launch helpers put on the wire.
        const args = buildDowntimePaneArgs('plan', '/skill:plan WL-X', {
          model: 'code',
          cwd: C2_CWD,
          localPreference: preference,
        });
        expect(args[args.indexOf('--local-preference') + 1]).toBe(preference);
        const paneSpawn = buildDowntimeSpawnOptions(C2_CWD, {
          priority: 'low',
          localPreference: preference,
        });
        expect(paneSpawn.env[LOCAL_PREFERENCE_ENV_VAR]).toBe(preference);
      }
    },
  );

  it('AC2: a deployment whose setting is the retired local-only forwards remote-ok instead', async () => {
    // loadSettings clamps at load (AC3), so the dispatch seam sees `remote-ok`
    // and never the retired value — the legacy file cannot leak onto the wire.
    const loaded = loadSettings(tempSettingsPathWith({ downtimeLocalPreference: 'local-only' }));
    expect(loaded.downtimeLocalPreference).toBe('remote-ok');
    expect(loaded.downtimeLocalPreferenceExplicit).toBe(false);

    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
    });
    const outcome = await runDispatchTick(deps, { localPreference: loaded.downtimeLocalPreference });

    expect(outcome.dispatched).toBe(true);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.localPreference).toBe('remote-ok');
    const args = buildDowntimePaneArgs('plan', '/skill:plan WL-X', {
      model: 'code',
      cwd: C2_CWD,
      localPreference: spawnOpts.localPreference,
    });
    expect(args[args.indexOf('--local-preference') + 1]).toBe('remote-ok');
    const paneSpawn = buildDowntimeSpawnOptions(C2_CWD, { localPreference: spawnOpts.localPreference });
    expect(paneSpawn.env[LOCAL_PREFERENCE_ENV_VAR]).toBe('remote-ok');
  });
});

describe('priority-aware locality preference (WL-0MVNUIW77000VYAX)', () => {
  /** A dispatchable plan candidate at an explicit priority. */
  function planCandidateAt(priority: string, id: string) {
    return { ...planCandidate(id), priority };
  }

  function dispatchWithHead(priority: string, opts: Parameters<typeof runDispatchTick>[1] = {}) {
    const deps = makeDeps({
      getHerdrListHead: vi
        .fn()
        .mockResolvedValue({ ok: true, items: [planCandidateAt(priority, `WL-${priority.toUpperCase()}`)] }),
    });
    return { deps, run: runDispatchTick(deps, opts) };
  }

  it('AC2/AC6: a low-priority dispatch resolves local-preferred and records priority-low', async () => {
    const { deps, run } = dispatchWithHead('low', { localPreferenceMode: 'priority-rule' });

    const outcome = await run;

    expect(outcome.dispatched).toBe(true);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.localPreference).toBe('local-preferred');
    // The marker records BOTH the resolved preference and its reason.
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ localPreference: 'local-preferred', localPreferenceReason: 'priority-low' }),
    );

    // The same value reaches the wire: the pane launch arg/env the extension
    // reads for `X-Local-Preference` and the route log.
    const args = buildDowntimePaneArgs('plan', '/skill:plan WL-LOW', {
      model: 'code',
      cwd: C2_CWD,
      localPreference: spawnOpts.localPreference,
    });
    expect(args[args.indexOf('--local-preference') + 1]).toBe('local-preferred');
    const paneSpawn = buildDowntimeSpawnOptions(C2_CWD, { localPreference: spawnOpts.localPreference });
    expect(paneSpawn.env[LOCAL_PREFERENCE_ENV_VAR]).toBe('local-preferred');
  });

  it('AC2: a high-priority dispatch keeps the deployment default and records default', async () => {
    const { deps, run } = dispatchWithHead('high', { localPreferenceMode: 'priority-rule' });

    const outcome = await run;

    expect(outcome.dispatched).toBe(true);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.localPreference).toBe('remote-ok');
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ localPreference: 'remote-ok', localPreferenceReason: 'default' }),
    );
  });

  it('AC2: an explicit operator remote-ok wins over the low-priority rule', async () => {
    const { deps, run } = dispatchWithHead('low', {
      localPreference: 'remote-ok',
      localPreferenceMode: 'operator-setting',
    });

    const outcome = await run;

    expect(outcome.dispatched).toBe(true);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.localPreference).toBe('remote-ok');
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ localPreference: 'remote-ok', localPreferenceReason: 'operator-setting' }),
    );
  });

  it('AC4: a legacy caller (no mode) forwards verbatim and adds no marker fields', async () => {
    const { deps, run } = dispatchWithHead('low', { localPreference: 'remote-ok' });

    const outcome = await run;

    expect(outcome.dispatched).toBe(true);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.localPreference).toBe('remote-ok');
    const marker = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(marker.localPreference).toBeUndefined();
    expect(marker.localPreferenceReason).toBeUndefined();
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
    // The proxy's refusal evidence is carried into the decision entry, with
    // the retry advice and `admit: false` (AC2/AC4). Since slice C3 the entry
    // reason is the grouped `reservation-refused` token (header token
    // `reservation-lost`, deliberately distinct from herdr's own paced
    // `prefill-gate`/`prefill-cap`) and the proxy's own vocabulary is
    // preserved in `reservationReason`.
    const refusal = recordedDecisions(recordDecision).find(
      (d) => d.reason === 'reservation-refused',
    );
    expect(refusal).toBeDefined();
    expect(refusal?.fields).toMatchObject({
      reservationReason: 'queue-full',
      admit: false,
      retryAfterS: 12,
      projectedWaitS: 12,
    });
  });

  it('AC2: each refusal reason keeps its own distinct header token', () => {
    for (const reason of ['reserved-fallback', 'prefill-gate', 'queue-full']) {
      expect(decisionHeaderToken(reason)).toBe(reason);
    }
    // The dispatch-path refusal token is reserved for the proxy's verdict and
    // must never collapse into a paced-stop token (slice C3 AGAIN check).
    expect(decisionHeaderToken('reservation-refused')).toBe('reservation-lost');
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

describe('dispatch reserve gate — unavailable distinguishable from refusal (AC4, WL-0MVWEZF4Z004UNYT)', () => {
  it('AC4: a wire-contract 400 still dispatches (fail-open) but the marker names the failing exchange', async () => {
    const fetchStub = fixtureFetcher(reserveWireContractBroken);
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

    // Fail-open is preserved (AC3): the dispatch still proceeds with no ticket.
    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.reservationTicketId).toBeUndefined();
    // AC4: the record names the failing exchange — `http-400`, NOT a bare
    // fail-open, NOT a refusal. The original bug looked exactly like an old
    // proxy; this field makes a broken contract visible again.
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ reservationUnavailable: 'http-400' }),
    );
  });

  it('AC4: a 404 (old proxy) is recorded as http-404, distinct from a refusal (no deferral entry)', async () => {
    const fetchStub = fixtureFetcher(reserveEndpointAbsent);
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
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ reservationUnavailable: 'http-404' }),
    );
    // An unusable exchange is NOT a refusal: no no-dispatch decision entry
    // with `admit:false` and no deferral advice.
    expect(recordedDecisions(recordDecision).some((d) => d.fields.admit === false)).toBe(false);
  });

  it('AC4: a timeout is recorded as timeout, and no client wired records nothing', async () => {
    const fetchStub = vi.fn().mockRejectedValue(new Error('reserve timed out'));
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    expect((await runDispatchTick(deps)).dispatched).toBe(true);
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ reservationUnavailable: 'timeout' }),
    );

    // No client wired (older install): NO reservation fields at all.
    const noClient = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
    });
    expect((await runDispatchTick(noClient)).dispatched).toBe(true);
    const marker = (noClient.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(marker.reservationUnavailable).toBeUndefined();
    expect(marker.reservationSkipped).toBeUndefined();
    expect(marker.reservationTicketId).toBeUndefined();
  });
});

describe('dispatch reserve gate — remote-ok skips, local-preferred reserves (AC8, WL-0MVWEZF4Z004UNYT)', () => {
  it('AC8: a remote-ok dispatch skips the reserve call and records the decision in the marker', async () => {
    const fetchStub = fixtureFetcher(reserveGranted());
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps, {
      localPreference: 'remote-ok',
      localPreferenceMode: 'operator-setting',
    });

    // The remote-ok pane's first request goes remote and could never consume
    // a ticket — NEVER reserve capacity it will not use.
    expect(outcome.dispatched).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.reservationTicketId).toBeUndefined();
    // The record explains the missing ticket (never "reservationTicketId:null,
    // reservation:null" with no deferral reason — the old silent shape).
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ reservationSkipped: 'remote-ok' }),
    );
  });

  it('AC8: a low-priority candidate resolves local-preferred and still reserves, forwarding the ticket', async () => {
    const fetchStub = fixtureFetcher(reserveGranted());
    const deps = makeDeps({
      getHerdrListHead: vi
        .fn()
        .mockResolvedValue({ ok: true, items: [{ ...planCandidate('WL-LOW'), priority: 'low' }] }),
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps, { localPreferenceMode: 'priority-rule' });

    // `low` priority → local-preferred → the pane's first request IS local,
    // so a ticket has a real beneficiary (AC7) — reserve and forward it.
    expect(outcome.dispatched).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.reservationTicketId).toBe('tkt-granted-1');
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ reservationTicketId: 'tkt-granted-1' }),
    );
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ localPreference: 'local-preferred', localPreferenceReason: 'priority-low' }),
    );
  });
});

describe('dispatch reserve gate — TTL bound (AC9, WL-0MVWEZF4Z004UNYT)', () => {
  it('AC9: a grant with less than the documented TTL window is NOT treated as capacity (fail-open, recorded)', async () => {
    const fetchStub = fixtureFetcher(reserveGranted({ ttl_s: 5 }));
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps);

    // The ticket is single-use AND below the usable window: never forwarded,
    // never counted as capacity — the dispatch fails open without it.
    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.reservationTicketId).toBeUndefined();
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ reservationUnavailable: 'ttl-below-bound' }),
    );
    expect(deps.recordDispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ reservationTicketId: 'tkt-granted-1' }),
    );
  });

  it('AC9: a grant at or above the TTL bound is usable capacity (ticket forwarded)', async () => {
    const fetchStub = fixtureFetcher(reserveGranted({ ttl_s: 10 }));
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
      reserveLocalCapacity: createLocalReserver(
        'http://proxy:8000',
        fetchStub as unknown as LocalReserveFetcher,
      ),
    });

    const outcome = await runDispatchTick(deps);

    expect(outcome.dispatched).toBe(true);
    const spawnOpts = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(spawnOpts.reservationTicketId).toBe('tkt-granted-1');
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
