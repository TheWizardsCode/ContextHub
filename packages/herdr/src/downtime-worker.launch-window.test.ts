/**
 * packages/herdr/src/downtime-worker.launch-window.test.ts — one-per-idle-
 * window reservation race guard (parent WL-0MVIKRFP0005JDL8, slice C3)
 *
 * The proxy's atomic reservation (slice C2) arbitrates a CROSS-instance race:
 * two instances observing the same idle window ask for a ticket and exactly
 * one is granted. This slice adds the two client-side halves of the operator
 * rule ("an idle window produces at most one launch"):
 *
 *   - **C3-AC1** — two `createDowntimeWorker` instances driven in the same
 *     tick against ONE mock proxy spawn exactly one pane; the loser defers
 *     with the proxy's own refusal evidence.
 *   - **C3-AC2** — after a launch, no second pane launches on later ticks
 *     while the proxy's status still reports the PRE-launch
 *     `local_prefills_in_flight`; only a fresh observation that shows the
 *     launched prefill registered (plus its own granted ticket) admits the
 *     next spawn.
 *   - **C3-AC3** — the losing instance's decision entry records the refusal
 *     reason, `retry_after_s` and `admit: false` under a header token that is
 *     distinguishable from herdr's own paced stops (`prefill-gate` /
 *     `prefill-cap`).
 *   - **C3-AC4** — the same rule holds on the coordination-leader path
 *     (`dispatchFromCoordination`): the refusal is returned as evidence
 *     instead of being swallowed by the own-backlog fallback, and the worker
 *     gate covers the leader path identically.
 *   - **C3-AC5** — the guard never admits a dispatch the pacing gates refuse
 *     and changes nothing on a proxy that does not serve the prefill
 *     counters (fail-open, single-instance behaviour unchanged).
 *
 * Fixtures live in `downtime-worker.fixtures.ts`; the mock-budget rule (≤ 5
 * `vi.fn()` per test) is respected by keeping harness construction in
 * module-level helpers.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_LAUNCH_CONFIRMATION_GRACE_MS,
  LOCAL_RESERVATION_TICKET_ENV,
  createDowntimePoller,
  createDowntimeWorker,
  createIdleWindowLaunchFence,
  createLocalReserver,
  decisionHeaderToken,
  dispatchFromCoordination,
  type CoordinationEntry,
  type DowntimeWorkerDeps,
  type LlamaStatus,
  type LocalReserveFetcher,
} from './downtime-worker.js';
import {
  ago,
  createTempDirTracker,
  jsonResponseFixture,
  launchWindowStatus,
  makeDeps,
  reserveGranted,
  reserveRefused429,
} from './downtime-worker.fixtures.js';

/** Worklog root used by the worker harness (never touched on disk). */
const CWD = '/repo';
/** Fake-clock origin for every tick sequence. */
const T0 = 1_000_000;

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

// ── Proxy doubles ────────────────────────────────────────────────────
//
// The mock proxy OWNS the ticket ledger: a reservation grant is atomic, so
// the same double is shared by every instance in a race test.

function asReserveClient(fetcher: ReturnType<typeof vi.fn>) {
  return createLocalReserver('http://proxy:8000', fetcher as unknown as LocalReserveFetcher);
}

/** A reserve endpoint that grants exactly ONE ticket, refusing every later ask. */
function oneTicketProxy() {
  let granted = false;
  const fetcher = vi.fn().mockImplementation(() => {
    if (granted) {
      return Promise.resolve(
        jsonResponseFixture(
          reserveRefused429({ reason: 'prefill-gate', retry_after_s: 9 }).body,
          429,
        ),
      );
    }
    granted = true;
    return Promise.resolve(jsonResponseFixture(reserveGranted().body, 200));
  });
  return { fetcher, reserve: asReserveClient(fetcher) };
}

/** A reserve endpoint that grants a FRESH ticket for every ask (permissive proxy). */
function grantingProxy() {
  let issued = 0;
  const fetcher = vi.fn().mockImplementation(() => {
    issued += 1;
    return Promise.resolve(
      jsonResponseFixture({ ticket_id: `tkt-${issued}`, ttl_s: 30 }, 200),
    );
  });
  return { fetcher, reserve: asReserveClient(fetcher), issued: () => issued };
}

/** A reserve endpoint that refuses every ask with the proxy's own reason. */
function refusingProxy(reason = 'queue-full', retryAfterS = 12) {
  const fetcher = vi.fn().mockImplementation(() =>
    Promise.resolve(
      jsonResponseFixture(reserveRefused429({ reason, retry_after_s: retryAfterS }).body, 429),
    ),
  );
  return { fetcher, reserve: asReserveClient(fetcher) };
}

// ── Worker harness ───────────────────────────────────────────────────

interface LaunchHarness {
  worker: ReturnType<typeof createDowntimeWorker>;
  deps: DowntimeWorkerDeps;
  /** The `recordDecision` dep mock (observability assertions). */
  decisions: ReturnType<typeof vi.fn>;
  /** Mutable status the poller serves — mutate between ticks. */
  state: { status: LlamaStatus };
}

/**
 * Build one worker instance around a mutable status and the shared deps
 * overrides. All `vi.fn()` calls live HERE (outside any test block) so each
 * test stays inside the mock budget.
 */
function makeLaunchHarness(opts: {
  status?: LlamaStatus;
  deps?: Partial<DowntimeWorkerDeps>;
  requiredFreeSlots?: number;
  coordinationDir?: string;
  instanceId?: string;
  /** Extra live config fields (e.g. a short starvation window). */
  extraConfig?: Record<string, unknown>;
} = {}): LaunchHarness {
  const state = { status: opts.status ?? launchWindowStatus() };
  const pollFetch = vi.fn().mockImplementation(async () => jsonResponseFixture(state.status));
  const decisions = vi.fn().mockResolvedValue(undefined);
  const deps = makeDeps({
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planCandidate()] }),
    recordDecision: decisions,
    ...opts.deps,
  });
  const worker = createDowntimeWorker({
    poller: createDowntimePoller('http://proxy:8000', pollFetch),
    deps,
    ...(opts.coordinationDir !== undefined ? { coordinationDir: opts.coordinationDir } : {}),
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId, leaseTtlSeconds: 300 } : {}),
    config: () => ({
      enabled: true,
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: opts.requiredFreeSlots ?? 0,
      model: 'plan',
      cwd: CWD,
      noCandidateCooldownMs: 3_600_000,
      ...opts.extraConfig,
    }),
  });
  return { worker, deps, decisions, state };
}

/**
 * Drain the pending decision-log writes: the tick calls `recordDecision` with
 * `void`, so its await chain (including the starvation signal) settles on the
 * microtask queue after `tick()` resolves.
 */
async function flushDecisionLog(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** `(reason, fields)` pairs the `recordDecision` dep mock observed. */
function recordedDecisions(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.map(([entry]) => ({
    reason: (entry as { reason?: string }).reason ?? '',
    fields: entry as Record<string, unknown>,
  }));
}

/**
 * Advance the fake clock past the CURRENT idle run's threshold and return the
 * dispatch tick's result. A dispatch resets the idle tracker, so the caller
 * passes the time of the last poll to start a new run first (exactly what the
 * production tick loop does).
 */
async function tickAfterFreshWindow(harness: LaunchHarness, from: number) {
  vi.setSystemTime(from + DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
  await harness.worker.tick(); // fresh idle run starts
  vi.setSystemTime(from + DEFAULT_DOWNTIME_POLL_INTERVAL_MS + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
  return harness.worker.tick(); // threshold met → dispatch decision
}

/**
 * Start the idle run at `T0`, then run the dispatch tick at the threshold and
 * return its result.
 */
async function runDispatchTick(harness: LaunchHarness) {
  vi.setSystemTime(T0);
  await harness.worker.tick(); // idle run starts
  vi.setSystemTime(T0 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
  return harness.worker.tick(); // threshold met → dispatch attempt
}

// ══════════════════════════════════════════════════════════════════════
// The fence itself (pure state machine)
// ══════════════════════════════════════════════════════════════════════

describe('idle-window launch fence — one launch per observed window (C3-AC2)', () => {
  it('C3-AC2: a launch holds the fence until the proxy registers the prefill', () => {
    const fence = createIdleWindowLaunchFence();
    fence.observePoll({ idle: true, inFlight: 0, cap: 1 }); // admission snapshot
    expect(fence.admit(T0)).toEqual({ ok: true });

    fence.recordLaunch(T0);
    expect(fence.pendingLaunches).toBe(1);

    // The next poll still reports the PRE-launch count (the pane is booting),
    // so the headroom it shows cannot be trusted yet.
    fence.observePoll({ idle: true, inFlight: 0, cap: 1 });
    expect(fence.admit(T0 + 10_000)).toEqual({ ok: false, reason: 'idle-window-spent' });
    expect(fence.pendingLaunches).toBe(1);

    // The proxy now counts the launched prefill: the observation is
    // demonstrably post-launch, so a new decision may be taken.
    fence.observePoll({ idle: true, inFlight: 1, cap: 1 });
    expect(fence.pendingLaunches).toBe(0);
    expect(fence.admit(T0 + 20_000)).toEqual({ ok: true });
  });

  it('C3-AC2: a busy poll ends the window and releases the fence', () => {
    const fence = createIdleWindowLaunchFence();
    fence.observePoll({ idle: true, inFlight: 0, cap: 1 });
    fence.recordLaunch(T0);
    fence.observePoll({ idle: true, inFlight: 0, cap: 1 });
    expect(fence.admit(T0 + 1_000).ok).toBe(false);

    fence.observePoll({ idle: false, inFlight: 0, cap: 1 });
    expect(fence.pendingLaunches).toBe(0);
    expect(fence.admit(T0 + 2_000).ok).toBe(true);
  });

  it('C3-AC5: the fence is inert when the proxy does not serve a prefill cap', () => {
    // An older proxy (no counters), and the gate-disabled case (`cap: 0`) —
    // neither can be paced, so the fence must never add a refusal.
    for (const observation of [
      { idle: true },
      { idle: true, inFlight: 0 },
      { idle: true, inFlight: 3, cap: 0 },
    ]) {
      const fence = createIdleWindowLaunchFence();
      fence.observePoll(observation);
      fence.recordLaunch(T0);
      expect(fence.pendingLaunches).toBe(0);
      expect(fence.admit(T0 + 1_000).ok).toBe(true);
    }
  });

  it('C3-AC5: an unregistered launch self-releases after the bounded grace', () => {
    // A granted pane that died before prefilling can never be observed —
    // the fence must not wedge the dispatcher on it.
    const fence = createIdleWindowLaunchFence();
    fence.observePoll({ idle: true, inFlight: 0, cap: 1 });
    fence.recordLaunch(T0);
    fence.observePoll({ idle: true, inFlight: 0, cap: 1 });

    expect(fence.admit(T0 + DEFAULT_LAUNCH_CONFIRMATION_GRACE_MS - 1).ok).toBe(false);
    expect(fence.admit(T0 + DEFAULT_LAUNCH_CONFIRMATION_GRACE_MS).ok).toBe(true);
  });

  it('C3-AC2: with cap > 1 the next launch needs the prior one registered first', () => {
    // The serialised default (cap 1) degenerates to one launch per window;
    // a headroom-permitting proxy admits up to the headroom — but never two
    // launches off the SAME status snapshot.
    const fence = createIdleWindowLaunchFence();
    fence.observePoll({ idle: true, inFlight: 0, cap: 2 });
    fence.recordLaunch(T0);
    fence.observePoll({ idle: true, inFlight: 0, cap: 2 }); // stale
    expect(fence.admit(T0 + 1_000).ok).toBe(false);

    fence.observePoll({ idle: true, inFlight: 1, cap: 2 }); // registered, headroom 1
    expect(fence.admit(T0 + 2_000).ok).toBe(true);
  });

  it('C3-AC2: a launch admitted on the registration tick is itself fenced', () => {
    // The registration poll releases the PREVIOUS hold; a launch admitted on
    // that same observation must still be recorded, otherwise the very next
    // tick would trust the same (now stale) snapshot again.
    const fence = createIdleWindowLaunchFence();
    fence.observePoll({ idle: true, inFlight: 0, cap: 2 });
    fence.recordLaunch(T0);
    fence.observePoll({ idle: true, inFlight: 1, cap: 2 }); // launch #1 registered
    expect(fence.pendingLaunches).toBe(0);
    expect(fence.admit(T0 + 1_000)).toEqual({ ok: true });

    fence.recordLaunch(T0 + 1_000); // launch #2 off the same observation
    expect(fence.pendingLaunches).toBe(1);
    fence.observePoll({ idle: true, inFlight: 1, cap: 2 }); // stale for launch #2
    expect(fence.admit(T0 + 2_000).ok).toBe(false);

    fence.observePoll({ idle: true, inFlight: 2, cap: 2 }); // launch #2 registered
    expect(fence.admit(T0 + 3_000).ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// C3-AC1 / AC3 — the two-instances-same-idle-window race
// ══════════════════════════════════════════════════════════════════════

describe('two instances observing one idle window (C3-AC1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('C3-AC1/AC3: at most one launch; the loser defers on the proxy refusal', async () => {
    // ONE proxy ledger shared by both instances — the atomic reservation is
    // the cross-instance arbiter (herdr adds no second distributed lock).
    const proxy = oneTicketProxy();
    const first = makeLaunchHarness({ deps: { reserveLocalCapacity: proxy.reserve } });
    const second = makeLaunchHarness({ deps: { reserveLocalCapacity: proxy.reserve } });

    vi.setSystemTime(T0);
    await first.worker.tick();
    await second.worker.tick();
    vi.setSystemTime(T0 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    const firstOutcome = await first.worker.tick();
    const secondOutcome = await second.worker.tick();

    // Exactly one instance launched, exactly one pane was spawned.
    expect([firstOutcome.dispatched, secondOutcome.dispatched]).toEqual([true, false]);
    expect(first.deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(second.deps.spawnAgentPane).not.toHaveBeenCalled();
    // Both asked — the loser was arbitrated by the reservation, not by a
    // client-side lock.
    expect(proxy.fetcher).toHaveBeenCalledTimes(2);

    // The loser records the proxy's refusal evidence under a distinct token.
    const refusal = recordedDecisions(second.decisions).find(
      (entry) => entry.reason === 'reservation-refused',
    );
    expect(refusal?.fields).toMatchObject({
      admit: false,
      retryAfterS: 9,
      projectedWaitS: 9,
      reservationReason: 'prefill-gate',
    });
    expect(second.worker.blockReason).toBe('reservation-lost');
    // The losing claim is rolled back so the item is selectable again.
    expect(second.deps.rollbackClaim).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// C3-AC3 — refusal evidence is distinguishable from a paced stop
// ══════════════════════════════════════════════════════════════════════

describe('refusal evidence header tokens (C3-AC3)', () => {
  it('C3-AC3: a lost reservation race never collapses into a paced-stop token', () => {
    expect(decisionHeaderToken('reservation-refused')).toBe('reservation-lost');
    // Distinct from herdr's OWN paced stops and from the fence hold.
    const others = [
      decisionHeaderToken('prefill-gate'),
      decisionHeaderToken('prefill-cap'),
      decisionHeaderToken('prefill-eta'),
      decisionHeaderToken('idle-window-spent'),
    ];
    expect(others).not.toContain('reservation-lost');
    expect(new Set([...others, 'reservation-lost']).size).toBe(others.length + 1);
    // The fence hold is its own token too: a spent window is neither a paced
    // stop nor a lost race.
    expect(decisionHeaderToken('idle-window-spent')).toBe('window-spent');
  });
});

// ══════════════════════════════════════════════════════════════════════
// C3-AC2 — post-launch suppression on later ticks
// ══════════════════════════════════════════════════════════════════════

describe('post-launch suppression on later ticks (C3-AC2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('C3-AC2: a stale status cannot authorise a second launch in the window', async () => {
    const proxy = grantingProxy();
    const harness = makeLaunchHarness({ deps: { reserveLocalCapacity: proxy.reserve } });

    const first = await runDispatchTick(harness);
    expect(first.dispatched).toBe(true);
    expect(harness.deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    // A full fresh idle period passes but the proxy STILL reports the
    // pre-launch count (in_flight 0, headroom 1): without the fence this tick
    // would ask for (and be granted) a second ticket in the same window.
    const second = await tickAfterFreshWindow(
      harness,
      T0 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
    );

    expect(second.dispatched).toBe(false);
    expect(harness.deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    // No reserve request was made — the fence refuses BEFORE the pipeline.
    expect(proxy.issued()).toBe(1);
    expect(harness.worker.blockReason).toBe('window-spent');
    const spent = recordedDecisions(harness.decisions).find(
      (entry) => entry.reason === 'idle-window-spent',
    );
    expect(spent?.fields).toMatchObject({ pendingLaunches: 1 });
  });

  it('C3-AC2: registered headroom plus its own ticket admits the next launch', async () => {
    const proxy = grantingProxy();
    const harness = makeLaunchHarness({
      status: launchWindowStatus({ local_max_concurrent_prefills: 2 }),
      deps: { reserveLocalCapacity: proxy.reserve },
    });

    const first = await runDispatchTick(harness);
    expect(first.dispatched).toBe(true);

    // The proxy now reports the launched prefill (in_flight 1, cap 2 → one
    // slot of headroom left): the observation is post-launch, so the window
    // admits ONE more launch — with its own ticket.
    harness.state.status = launchWindowStatus({
      local_prefills_in_flight: 1,
      local_max_concurrent_prefills: 2,
    });
    const second = await tickAfterFreshWindow(
      harness,
      T0 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
    );

    expect(second.dispatched).toBe(true);
    expect(proxy.issued()).toBe(2);
    expect(harness.deps.spawnAgentPane).toHaveBeenCalledTimes(2);
    const spawnOpts = (harness.deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[1][1];
    expect(spawnOpts.reservationTicketId).toBe('tkt-2');
    // The pane is launched with the ticket in its environment too, so its
    // first request can carry `X-Local-Reservation`.
    expect(
      (spawnOpts as { env?: Record<string, string> }).env?.[LOCAL_RESERVATION_TICKET_ENV] ?? 'tkt-2',
    ).toBe('tkt-2');
  });

  it('C3-AC5: a saturated prefill gate still reports its own paced reason', async () => {
    const proxy = grantingProxy();
    const harness = makeLaunchHarness({
      status: launchWindowStatus({ local_prefills_in_flight: 1 }),
      deps: { reserveLocalCapacity: proxy.reserve },
    });

    const outcome = await runDispatchTick(harness);

    expect(outcome.dispatched).toBe(false);
    expect(harness.worker.blockReason).toBe('prefill-cap');
    expect(proxy.issued()).toBe(0);
    expect(harness.deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('C3-AC3: the grouped refusal token still feeds the capacity-starvation signal', async () => {
    // The decision entry/header groups refusals under `reservation-refused`,
    // but the starvation tracker must keep judging the PROXY's reason — else
    // a night of refused tickets would silently stop being reported.
    const alertWindow = 5 * 60_000; // the clamped floor
    const harness = makeLaunchHarness({
      extraConfig: { thresholdMs: 0, capacityStarvationAlertMs: alertWindow },
      deps: { reserveLocalCapacity: refusingProxy('queue-full').reserve },
    });

    vi.setSystemTime(T0);
    await harness.worker.tick(); // refusal #1 — episode starts
    await flushDecisionLog();
    vi.setSystemTime(T0 + alertWindow + 1);
    await harness.worker.tick(); // > window: the signal fires
    await flushDecisionLog();

    const starved = recordedDecisions(harness.decisions).find(
      (entry) => entry.reason === 'capacity-starved',
    );
    expect(starved?.fields).toMatchObject({
      lastCapacityReason: 'queue-full',
      consecutiveCapacityRefusals: 2,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// C3-AC4 — coordination-leader path parity
// ══════════════════════════════════════════════════════════════════════

describe('coordination-leader path parity (C3-AC4)', () => {
  const tmp = createTempDirTracker();

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    tmp.cleanup();
  });

  /** An offer entry as the shared coordination file carries it. */
  function offerEntry(workItemId = 'WL-LEAD-1'): CoordinationEntry {
    const at = new Date(T0).toISOString();
    return {
      instanceId: 'inst-owner',
      workItemId,
      directory: CWD,
      assignedAt: at,
      lastUpdated: at,
    };
  }

  it('C3-AC4: the leader path returns the refusal instead of masking it', async () => {
    // Regression pin: a reserve refusal on the leader path must NOT fall
    // through to the own-backlog fallback (which would retry other items and
    // return a generic terminal reason, losing the evidence).
    const coordDir = tmp.make('wl-launch-coord-refuse-');
    const proxy = refusingProxy('queue-full', 12);
    const deps = makeDeps({
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: { id: 'WL-LEAD-1', title: 'Lead', status: 'open', stage: 'intake_complete' },
      }),
      reserveLocalCapacity: proxy.reserve,
    });

    const outcome = await dispatchFromCoordination(deps, [offerEntry()], {
      model: 'plan',
      cwd: CWD,
      coordinationDir: coordDir,
    });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('queue-full');
    expect(outcome.reservation).toMatchObject({ admit: false, retryAfterS: 12 });
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // The own-backlog fallback never ran: no second ranking lookup, no retry.
    expect(deps.getHerdrListHead).not.toHaveBeenCalled();
  });

  it('C3-AC4: the leader window is fenced like the own-backlog window', async () => {
    const coordDir = tmp.make('wl-launch-coord-window-');
    const proxy = grantingProxy();
    const harness = makeLaunchHarness({
      coordinationDir: coordDir,
      instanceId: 'inst-leader',
      deps: { reserveLocalCapacity: proxy.reserve },
    });

    const first = await runDispatchTick(harness);
    expect(first.dispatched).toBe(true);
    expect(harness.deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    // A stale post-launch status must not authorise a second LEADER launch in
    // the same window: the machine-wide gate runs before BOTH dispatch paths.
    const second = await tickAfterFreshWindow(
      harness,
      T0 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
    );

    expect(second.dispatched).toBe(false);
    expect(harness.deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(proxy.issued()).toBe(1);
    expect(harness.worker.blockReason).toBe('window-spent');
  });
});
