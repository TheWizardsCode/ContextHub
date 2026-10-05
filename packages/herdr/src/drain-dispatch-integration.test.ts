/**
 * Integration tests for the drain-pause dispatch signal (F5, parent
 * WL-0MUL0KO7Q003O7YJ).
 *
 * These are true integration tests: they wire the REAL mode-switch worker's
 * `getIsDraining()` state into the REAL downtime worker's
 * `config().drainPaused` — the exact production wiring in index.ts
 * (`drainPaused: modeSwitchHolder.worker?.getIsDraining() ?? false`,
 * F2 WL-0MUNMCZ2K003DZ50) — and assert the full loop:
 *
 *   1. while the mode-switch worker is draining, the downtime worker polls
 *      and tracks idle but does NOT dispatch a new work item;
 *   2. once the drain completes (the proxy switches to cheap), the very next
 *      idle tick dispatches normally;
 *   3. while NOT draining, dispatch works normally (fail-open baseline);
 *   4. an operator command during the drain cancels it, so the downtime
 *      worker resumes dispatching on the next tick (the drain signal is live).
 *
 * The F2 unit tests pin the `drainPaused` config contract in isolation; the
 * F4 tests pin the mode-switch drain state machine in isolation. These tests
 * pin the WIRING between them, which neither unit suite covers.
 *
 * Run: npx vitest run packages/herdr/src/drain-dispatch-integration.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createDowntimeWorker,
  createDowntimePoller,
  type DowntimeWorkerDeps,
  type LlamaStatus,
} from './downtime-worker.js';
import {
  createModeSwitchWorker,
  type AdminApiFetcher,
  type ProxyMode,
} from './mode-switch-worker.js';
import { idleAllSlotsFree, jsonResponseFixture } from './downtime-worker.fixtures.js';

// ── Test helpers ──────────────────────────────────────────────────────

let clock: number;

function now(): number {
  return clock;
}

function advance(ms: number): void {
  clock += ms;
}

/** Build a per-slot `/llama/local/status` payload (LP-0MSG5TA7Y002GN39). */
function perSlotStatus(overrides: Partial<LlamaStatus> = {}): LlamaStatus {
  return {
    llama_server_running: true,
    active_query: false,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 3,
    total_slots: 3,
    slots: [
      { slot_id: 'slot-1', is_processing: false },
      { slot_id: 'slot-2', is_processing: false },
      { slot_id: 'slot-3', is_processing: false },
    ],
    ...overrides,
  };
}

/**
 * 1 of 3 slots free, with the operator's session holding the two busy slots:
 * the per-slot idle-entry gate passes (≥1 free) but the cheap pool's drain
 * budget (≥2 free) is unmet → the mode-switch worker enters drain.
 */
function perSlotDrainPending(): LlamaStatus {
  return perSlotStatus({
    active_query: true,
    local_active_query: true,
    local_lease_active: true,
    available_slots: 1,
    total_slots: 3,
    slots: [
      { slot_id: 'slot-1', is_processing: true },
      { slot_id: 'slot-2', is_processing: true },
      { slot_id: 'slot-3', is_processing: false },
    ],
  });
}

/** 2 of 3 slots free — the drain-completion budget is met. */
function perSlotDrainComplete(): LlamaStatus {
  return perSlotStatus({
    active_query: true,
    local_active_query: true,
    local_lease_active: true,
    available_slots: 2,
    total_slots: 3,
    slots: [
      { slot_id: 'slot-1', is_processing: true },
      { slot_id: 'slot-2', is_processing: false },
      { slot_id: 'slot-3', is_processing: false },
    ],
  });
}

interface MockAdminApi {
  fetcher: AdminApiFetcher;
}

/** A minimal admin API: `GET /admin/mode` always `fast`, `POST` always 200. */
function mockAdminApi(): MockAdminApi {
  let mode: ProxyMode = 'fast';
  const fetcher: AdminApiFetcher = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'POST') {
      mode = JSON.parse(init?.body ?? '{}').mode ?? mode;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ mode }) };
  };
  return { fetcher };
}

/**
 * Dispatch-capable downtime-worker deps (mirrors the shared `makeDeps` in
 * downtime-worker.test.ts): an empty Herdr list falls through to the legacy
 * tier chain, where the intake tier resolves the stubbed candidate and the
 * pane spawn succeeds.
 */
function makeDeps(): DowntimeWorkerDeps {
  return {
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    getNextItem: vi.fn().mockResolvedValue({
      ok: true,
      candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
    }),
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    rollbackClaim: vi.fn().mockResolvedValue(true),
    recordError: vi.fn().mockResolvedValue(undefined),
    getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
    recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
    readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
    hasFreshAudit: vi.fn().mockResolvedValue(false),
    getReviewQueueCount: vi.fn().mockResolvedValue(0),
    getRunningDowntimePanes: vi
      .fn()
      .mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
  };
}

/**
 * Build a downtime worker whose `drainPaused` reads the live mode-switch drain
 * state — the production index.ts wiring.
 */
function makeWiredDowntimeWorker(modeSwitch: ReturnType<typeof createModeSwitchWorker>) {
  const deps = makeDeps();
  const poller = createDowntimePoller(
    'http://proxy:8000',
    vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree)),
  );
  const worker = createDowntimeWorker({
    poller,
    deps,
    config: () => ({
      enabled: true,
      // A zero threshold makes the idle run dispatch on its first idle tick,
      // so the tests isolate the drain signal rather than idle timing.
      thresholdMs: 0,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
      drainPaused: modeSwitch.getIsDraining(),
    }),
  });
  return { worker, deps };
}

// ── Drain-pause integration ───────────────────────────────────────────

describe('mode-switch drain → downtime dispatch integration', () => {
  it('pauses new dispatches while draining, then resumes once the drain completes', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const modeSwitch = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);

    // Idle window met + proxy idle but only 1 free slot → enter drain.
    await modeSwitch.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: perSlotDrainPending(),
    });
    expect(modeSwitch.getIsDraining()).toBe(true);

    const { worker, deps } = makeWiredDowntimeWorker(modeSwitch);

    // While draining: the worker polls (so the mode-switch worker keeps
    // observing free slots) but never spawns a new pane.
    const paused = await worker.tick();
    expect(paused).toEqual({ polled: true, dispatched: false, idle: true });
    expect(worker.blockReason).toBe('draining');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    // The cheap budget frees → the drain completes and the proxy switches to
    // cheap.
    await modeSwitch.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: perSlotDrainComplete(),
    });
    expect(modeSwitch.getIsDraining()).toBe(false);
    expect(modeSwitch.getLastKnownMode()).toBe('cheap');

    // The next idle tick dispatches normally (the drain signal is live).
    const resumed = await worker.tick();
    expect(resumed.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('dispatches normally while NOT draining (fail-open baseline)', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    // Never ticked → not draining.
    const modeSwitch = createModeSwitchWorker({ fetcher: api.fetcher, now });
    expect(modeSwitch.getIsDraining()).toBe(false);

    const { worker, deps } = makeWiredDowntimeWorker(modeSwitch);

    const result = await worker.tick();
    expect(result.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('an operator command during drain cancels it, so dispatch resumes on the next tick', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const modeSwitch = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await modeSwitch.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: perSlotDrainPending(),
    });
    expect(modeSwitch.getIsDraining()).toBe(true);

    const { worker, deps } = makeWiredDowntimeWorker(modeSwitch);
    const paused = await worker.tick();
    expect(paused.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    // The operator returns: the drain is abandoned and the idle clock resets.
    modeSwitch.onOperatorCommand('http://proxy');
    expect(modeSwitch.getIsDraining()).toBe(false);

    // Dispatch resumes on the next tick — the drain signal was live, not
    // cached at worker construction.
    const resumed = await worker.tick();
    expect(resumed.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });
});
