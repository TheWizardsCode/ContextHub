/**
 * packages/herdr/src/downtime-worker.starvation.test.ts — integration tests
 * for the capacity-starvation signal (WL-0MVKNC2N50025HXE AC3/AC5).
 *
 * A saturated night silently NOPs by design (the refusal reasons are
 * non-terminal), but it must become DIAGNOSABLE: once capacity refusals have
 * run continuously for the configured window, the tick logs ONE
 * `capacity-starved` OBSERVATION (with the panes holding the model when the
 * scan is wired). This file pins that behaviour end-to-end through
 * `createDowntimeWorker`: the signal fires, carries episode evidence, resets
 * after a successful dispatch, and never replaces or masks the underlying
 * refusal reason/token stream.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createDowntimePoller,
  createDowntimeWorker,
  decisionHeaderToken,
  type LlamaStatus,
} from './downtime-worker.js';
import { jsonResponseFixture, makeDeps } from './downtime-worker.fixtures.js';
import type { CoordinationLogEntry } from './downtime-log.js';
import type { LongRunningPaneObservation } from './long-running-panes.js';

const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const ALERT_WINDOW = 5 * 60 * 1000; // clamped floor — a test-scale window
const LONG_RUNNING = 3 * 60 * 60 * 1000;

/** Schema-v2 fully-saturated pool: both slots generating, no free capacity. */
function saturatedStatus(): LlamaStatus {
  return {
    llama_server_running: true,
    local_active_query: true,
    model_switch_in_progress: false,
    local_lease_active: true,
    available_slots: 0,
    total_slots: 2,
    status_schema_version: 2,
    capacity_hint: 'saturated',
    local_prefills_in_flight: 1,
    local_max_concurrent_prefills: 1,
    prefill_gate_waiters: 1,
    contention_queue_depth: 0,
    slots: [
      { slot_id: 'slot-1', is_processing: true, lease_state: 'generating', phase: 'decode' },
      { slot_id: 'slot-2', is_processing: true, lease_state: 'generating', phase: 'decode' },
    ],
  };
}

interface StarvationWorkerOpts {
  status: LlamaStatus;
  getStatus?: () => LlamaStatus;
  recordDecision?: (entry: CoordinationLogEntry, cwd: string) => Promise<void>;
  scanLongRunning?: (cwd: string) => Promise<LongRunningPaneObservation[]>;
  /** Offer a plan-tier candidate so an idle tick really dispatches. */
  dispatchCandidate?: boolean;
}

function makeStarvationWorker(opts: StarvationWorkerOpts) {
  const poller = createDowntimePoller(
    'http://proxy:8000',
    vi
      .fn()
      .mockImplementation(async () =>
        jsonResponseFixture(opts.getStatus !== undefined ? opts.getStatus() : opts.status),
      ),
  );
  const deps = makeDeps({
    ...(opts.recordDecision !== undefined ? { recordDecision: opts.recordDecision } : {}),
    ...(opts.scanLongRunning !== undefined
      ? { scanLongRunningPanes: opts.scanLongRunning }
      : {}),
    ...(opts.dispatchCandidate === true
      ? {
          getNextItem: vi.fn().mockResolvedValue({
            ok: true,
            candidate: { id: 'WL-IDLE-AGE', title: 'Some task', stage: 'intake_complete' },
          }),
        }
      : {}),
  });
  const worker = createDowntimeWorker({
    poller,
    deps,
    config: () => ({
      enabled: true,
      thresholdMs: 0,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
      browseItemCount: 20,
      capacityStarvationAlertMs: ALERT_WINDOW,
      longRunningThresholdMs: LONG_RUNNING,
    }),
  });
  return { worker, deps };
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Drain the pending decision-log writes: `recordDecision` is invoked with
 * `void` by the tick, so its await chain (including the starvation signal)
 * settles on the microtask queue after `tick()` resolves.
 */
async function flushDecisionLog(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('capacity-starvation signal (WL-0MVKNC2N50025HXE AC3)', () => {
  it('logs one `capacity-starved` observation once the refusal run crosses the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const { worker } = makeStarvationWorker({ status: saturatedStatus(), recordDecision });

    // Tick 1: refusal — episode starts; the only entry is the refusal.
    await worker.tick();
    await flushDecisionLog();
    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(recordDecision.mock.calls[0][0]).toMatchObject({ reason: 'capacity-saturated' });

    // Tick 2, > window later: the refusal is rate-limited (identical reason
    // within 10 min) but the episode now exceeds the window — the signal
    // fires WITHOUT a second refusal line.
    vi.setSystemTime(T0 + ALERT_WINDOW + 1);
    await worker.tick();
    await flushDecisionLog();

    expect(recordDecision).toHaveBeenCalledTimes(2);
    const second = recordDecision.mock.calls[1][0];
    expect(second.reason).toBe('capacity-starved');
    expect(second).toMatchObject({
      kind: 'decision',
      operation: 'no-dispatch',
      freeSlots: 0,
      capacityHint: 'saturated',
      starvedMs: ALERT_WINDOW + 1,
      consecutiveCapacityRefusals: 2,
      lastCapacityReason: 'capacity-saturated',
    });
    expect(Date.parse(second.starvedSince as string)).toBe(T0);
    // No long-running evidence was wired → the field is absent.
    expect(second.longRunningPanes).toBeUndefined();
  });

  it('names the panes holding the model when the long-running scan is wired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const scanLongRunning = vi.fn().mockResolvedValue([
      {
        paneId: 'w45:pK4',
        itemId: 'WL-0MVJC1EQX001QR9W',
        cwd: '/repo',
        kind: 'implement',
        lastActivityAt: T0 - 6 * 60 * 60 * 1000,
        stalledForMs: 6 * 60 * 60 * 1000,
        agentStatus: 'working',
        stage: 'intake_complete',
        title: 'A stuck implementation',
      },
    ] satisfies LongRunningPaneObservation[]);
    const { worker } = makeStarvationWorker({
      status: saturatedStatus(),
      recordDecision,
      scanLongRunning,
    });

    await worker.tick();
    await flushDecisionLog();
    vi.setSystemTime(T0 + ALERT_WINDOW + 1);
    await worker.tick();
    await flushDecisionLog();

    // The scan ran ONCE, for the leader's own root, with the live threshold.
    expect(scanLongRunning).toHaveBeenCalledTimes(1);
    expect(scanLongRunning.mock.calls[0][0]).toBe('/repo');
    expect(scanLongRunning.mock.calls[0][1]).toMatchObject({ thresholdMs: LONG_RUNNING });

    const starved = recordDecision.mock.calls[1][0];
    expect(starved.reason).toBe('capacity-starved');
    expect(starved.longRunningPanes).toEqual([
      expect.objectContaining({
        paneId: 'w45:pK4',
        itemId: 'WL-0MVJC1EQX001QR9W',
        stalledForMs: 6 * 60 * 60 * 1000,
        agentStatus: 'working',
      }),
    ]);
  });

  it('a successful dispatch ends the episode — the next run must re-accumulate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    let current: LlamaStatus = saturatedStatus();
    const { worker, deps } = makeStarvationWorker({
      status: saturatedStatus(),
      getStatus: () => current,
      recordDecision,
      dispatchCandidate: true,
    });

    // Episode 1: a refusal starts it.
    await worker.tick();
    await flushDecisionLog(); // t0 — refusal recorded (episode 1 begins)
    expect(recordDecision.mock.calls.map((c) => (c[0] as CoordinationLogEntry).reason)).toEqual([
      'capacity-saturated',
    ]);

    // A dispatchable (idle) tick — a successful dispatch proves capacity was
    // available, so the episode must end here.
    current = {
      ...saturatedStatus(),
      capacity_hint: 'idle',
      local_active_query: false,
      local_lease_active: false,
      available_slots: 2,
      // Clear the prefill-gate evidence too: a live gate waiter would pace
      // the tick (prefill-gate) instead of dispatching.
      local_prefills_in_flight: 0,
      prefill_gate_waiters: 0,
      slots: [
        { slot_id: 'slot-1', is_processing: false },
        { slot_id: 'slot-2', is_processing: false },
      ],
    };
    vi.setSystemTime(T0 + ALERT_WINDOW + 1);
    const dispatched = await worker.tick();
    expect(dispatched.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    // Episode 2: a fresh refusal run. If the dispatch reset the tracker, the
    // next signal's `starvedSince` is THIS run's first refusal — not t0.
    current = saturatedStatus();
    const episode2Start = T0 + ALERT_WINDOW + 2;
    vi.setSystemTime(episode2Start);
    await worker.tick();
    await flushDecisionLog(); // refusal; same reason within the limiter window → not logged
    vi.setSystemTime(episode2Start + ALERT_WINDOW + 1);
    await worker.tick();
    await flushDecisionLog(); // episode 2 crosses the window → signal fires

    const reasons = recordDecision.mock.calls.map((c) => (c[0] as CoordinationLogEntry).reason);
    const starvedIndex = reasons.indexOf('capacity-starved');
    expect(starvedIndex).toBeGreaterThanOrEqual(0);
    const starved = recordDecision.mock.calls[starvedIndex][0];
    // Proven reset: the episode-two signal anchors to episode two's start,
    // not to the pre-dispatch episode.
    expect(Date.parse(starved.starvedSince as string)).toBe(episode2Start);
    // AC5: the observation never replaces the refusal stream. The dispatch
    // reset makes the limiter allow episode two's refusal as a fresh line.
    expect(reasons.filter((r) => r === 'capacity-saturated')).toHaveLength(2);
  });
});

describe('reason/token stream regression (WL-0MVKNC2N50025HXE AC5)', () => {
  it('`capacity-starved` is a DISTINCT observable reason, never a terminal/blocking token', () => {
    // It must not collide with (or fall through onto) the existing refusal
    // tokens — an operator reading the header sees the standing refusal and
    // the log carries the observation separately.
    for (const token of [
      'no-slots',
      'saturated',
      'contention',
      'slot-owner',
      'review-queue',
      'prefill-gate',
      'prefill-cap',
      'prefill-eta',
    ]) {
      expect(decisionHeaderToken('capacity-starved')).not.toBe(token);
    }
    expect(decisionHeaderToken('capacity-starved')).toBe('capacity-starved');
  });
});
