/**
 * packages/herdr/src/downtime-worker.orchestrator.test.ts — worker
 * orchestration, cooldowns, per-slot routing, rotation and probe-jitter
 * tests
 *
 * Split out of the monolithic `downtime-worker.test.ts`
 * (WL-0MV28X3SL005R5KX / WL-0MV4VJE8V00478ZF) to keep each test file focused
 * on one concern. Covers:
 *   - the `createDowntimeWorker` orchestrator and its dispatch loop,
 *   - the no-candidate cooldown,
 *   - the three-strike rule on CLI errors,
 *   - `parseLlamaStatus` optional per-slot `slots` parsing,
 *   - the per-slot idle-tracking / routing modes,
 *   - `selectWithRotation` round-robin tie-break and its tier wiring,
 *   - the worker probe jitter (`jitterPollIntervalMs`).
 *
 * Shared scaffolding (`makeDeps`, status fixtures, etc.) is imported from
 * `downtime-worker.fixtures.ts`; no setup logic is re-implemented here.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateIdle,
  parseLlamaStatus,
  createDowntimePoller,
  dispatchDowntimeWork,
  dispatchFromCoordination,
  createDowntimeWorker,
  selectImplementCandidate,
  selectNextCandidate,
  selectAuditCandidate,
  selectWithRotation,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  type LlamaStatus,
  type DowntimeCandidate,
  type DowntimeWorkerDeps,
  type AuditCandidate,
  type ImplementCandidate,
} from './downtime-worker.js';
import { createRoundRobinRegistry } from './downtime-round-robin.js';
import { LEASE_FILE, LEADER_LOCK_FILE, isLeaseValid } from './leader-election.js';
import { writeCoordinationFile } from './coordination.js';
import {
  idleAllSlotsFree,
  perSlotAllFree,
  perSlotTwoFree,
  perSlotOneProcessing,
  jsonResponseFixture,
  makeDeps,
  createTempDirTracker,
} from './downtime-worker.fixtures.js';

// ── Worker orchestrator (AC1/AC5) ─────────────────────────────────────

describe('downtime worker orchestrator (createDowntimeWorker)', () => {
  function makeWorker(overrides: {
    enabled?: boolean;
    thresholdMs?: number;
    cooldownMs?: number;
    status?: unknown;
    deps?: Partial<DowntimeWorkerDeps>;
    mode?: 'cheap' | 'fast';
    concurrentDispatchCap?: number;
  } = {}) {
    const cfg = {
      enabled: overrides.enabled ?? true,
      thresholdMs: overrides.thresholdMs ?? DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: overrides.cooldownMs ?? 3_600_000,
      // Mode-aware spawn config inputs (WL-0MT50S9JW001DHME).
      ...(overrides.mode !== undefined ? { mode: overrides.mode } : {}),
      ...(overrides.concurrentDispatchCap !== undefined
        ? { concurrentDispatchCap: overrides.concurrentDispatchCap }
        : {}),
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponseFixture(overrides.status ?? idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      ...overrides.deps,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg, fetcher };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing (no poll, no dispatch) when disabled', async () => {
    const { worker, deps, fetcher } = makeWorker({ enabled: false });
    const result = await worker.tick();
    expect(result).toEqual({ polled: false, dispatched: false, idle: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('treats a busy status as busy and never dispatches', async () => {
    const { worker, deps } = makeWorker({ status: { ...idleAllSlotsFree, local_active_query: true } });
    const result = await worker.tick();
    expect(result.idle).toBe(false);
    expect(worker.idleSince).toBeNull();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('treats remote-only traffic as idle and dispatches after the threshold (local_active_query=false)', async () => {
    // Integration (AC2): a stub status with local_active_query=false
    // (remote streams in flight, local slots free) must be treated as idle
    // and dispatch after the idle threshold.
    const { worker, deps, cfg } = makeWorker({
      status: { ...idleAllSlotsFree, local_active_query: false },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince).toBe(start);

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch until the idle duration reaches the threshold (AC1)', async () => {
    const { worker, deps, cfg } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince).toBe(start);

    vi.setSystemTime(start + cfg.thresholdMs - 1);
    const before = await worker.tick();
    expect(before.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(worker.lastDispatchAt).toBe(start + cfg.thresholdMs);
  });

  it('tick forwards a mode-aware spawnConfig with the genuine free-slot snapshot (WL-0MT50S9JW001DHME)', async () => {
    const { worker, deps, cfg } = makeWorker({ mode: 'cheap' });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();

    vi.setSystemTime(start + cfg.thresholdMs);
    await worker.tick();

    // idleAllSlotsFree: 4 of 4 slots free, total 4 → forwarded verbatim so
    // the spawn boundary never has to reach back into the worker.
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        spawnConfig: { mode: 'cheap', slotBudget: 4, freeSlots: 4, concurrentDispatchCap: 1 },
      }),
    );
  });

  it('tick omits spawnConfig when the proxy mode is unknown (conservative serial default)', async () => {
    const { worker, deps, cfg } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();

    vi.setSystemTime(start + cfg.thresholdMs);
    await worker.tick();

    const call = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).not.toHaveProperty('spawnConfig');
  });

  it('requires a fresh full idle period after a dispatch (AC5)', async () => {
    const { worker, deps, cfg } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + cfg.thresholdMs);
    await worker.tick();
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    // Still idle at the next tick: the tracker was reset after dispatch, so
    // no second dispatch until another full idle period has elapsed.
    vi.setSystemTime(start + cfg.thresholdMs + DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
    const next = await worker.tick();
    expect(next.dispatched).toBe(false);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(worker.idleSince).toBe(start + cfg.thresholdMs + DEFAULT_DOWNTIME_POLL_INTERVAL_MS);

    vi.setSystemTime(start + cfg.thresholdMs + DEFAULT_DOWNTIME_POLL_INTERVAL_MS + cfg.thresholdMs);
    const after = await worker.tick();
    expect(after.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(2);
  });

  it('a busy poll (proxy busy after dispatch) resets the idle run', async () => {
    const { worker, deps, cfg, fetcher } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + cfg.thresholdMs);
    await worker.tick();
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    fetcher.mockResolvedValueOnce(jsonResponseFixture({ ...idleAllSlotsFree, local_active_query: true }));
    vi.setSystemTime(start + cfg.thresholdMs + DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
    const busy = await worker.tick();
    expect(busy.idle).toBe(false);
    expect(worker.idleSince).toBeNull();

    // Back to idle: a full new run is required before the next dispatch.
    vi.setSystemTime(start + cfg.thresholdMs + 60_000);
    const reIdle = await worker.tick();
    expect(reIdle.idle).toBe(true);
    expect(reIdle.dispatched).toBe(false);
    vi.setSystemTime(start + cfg.thresholdMs + 60_000 + cfg.thresholdMs);
    const reDispatch = await worker.tick();
    expect(reDispatch.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(2);
  });

  it('re-reads settings each tick so changes apply without a restart', async () => {
    const { worker, deps, cfg } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();

    cfg.thresholdMs = 60_000; // operator changes the setting live
    vi.setSystemTime(start + 60_000);
    const result = await worker.tick();
    expect(result.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('does not start a second dispatch while one is in flight (worker single-flight)', async () => {
    let release!: () => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = () => resolve({ ok: true });
    });
    const { worker, deps } = makeWorker({
      deps: { spawnAgentPane: vi.fn().mockImplementation(() => gate) },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

    const first = worker.tick();
    const second = await worker.tick();
    expect(second.dispatched).toBe(false);

    release();
    const firstResult = await first;
    expect(firstResult.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });
});

// ── No-candidate cooldown (WL-0MSI7DQL10016QYX) ──────────────────────

describe('downtime no-candidate cooldown (createDowntimeWorker)', () => {
  /** Empty backlog in BOTH stages → the worker should pause. */
  function makeEmptyBacklogWorker(overrides: {
    cooldownMs?: number;
    deps?: Partial<DowntimeWorkerDeps>;
  } = {}) {
    const cfg = {
      enabled: true,
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: overrides.cooldownMs ?? 3_600_000,
    };
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      ...overrides.deps,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg, fetcher };
  }

  // ── Coordination-dir worker fixture (F2 — cooldown lease maintenance) ──

  /** Tmp dirs created by makeCoordinationWorker — cleaned up in afterEach. */
  const coordinationTmpDirs = createTempDirTracker();

  function makeCoordinationWorker(overrides: {
    instanceId?: string;
    leaseTtlSeconds?: number;
    cooldownMs?: number;
    deps?: Partial<DowntimeWorkerDeps>;
    /** Pre-seed another instance's valid lease BEFORE the worker is created. */
    seedLease?: { instanceId: string; atMs: number };
  } = {}) {
    const coordDir = coordinationTmpDirs.make('cd-wl-0MTF4A4V3-');
    const instanceId = overrides.instanceId ?? 'inst-a';
    const leaseTtlSeconds = overrides.leaseTtlSeconds ?? 300;
    if (overrides.seedLease) {
      writeLease(coordDir, overrides.seedLease.instanceId, leaseTtlSeconds, overrides.seedLease.atMs);
    }
    const cfg = {
      enabled: true,
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: overrides.cooldownMs ?? 3_600_000,
    };
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      // fetchItem is REQUIRED for coordination dispatch (dispatchFromCoordination).
      // Default: returns dispatchable info for any item id.
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: { id: 'WL-FAKE', title: 'Fake', status: 'open', stage: 'intake_complete' },
      }),
      ...overrides.deps,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      coordinationDir: coordDir,
      instanceId,
      leaseTtlSeconds,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg, fetcher, coordDir, instanceId, leaseTtlSeconds };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    coordinationTmpDirs.cleanup();
  });

  it('enters the cooldown only after a genuine no-candidate outcome', async () => {
    const { worker, deps } = makeEmptyBacklogWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // idle run starts
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS); // threshold met → dispatch attempt

    const result = await worker.tick();

    expect(result.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(worker.paused).toBe(true);
  });

  it('dispatches a due scheduled prompt instead of entering the no-candidate cooldown (AC6)', async () => {
    // Scheduled tier first (WL-0MSS1Q5ER007QDKX): even with a genuinely
    // empty backlog behind it, a DUE prompt dispatches — it never reaches
    // the backlog tiers, so it never triggers the no-candidate cooldown.
    const { worker, deps } = makeEmptyBacklogWorker({
      deps: {
        getDueScheduledPrompt: vi.fn().mockResolvedValue({
          id: '/skill:refactor',
          prompt: '/skill:refactor',
          intervalDays: 3,
          lastTriggeredAt: null,
        }),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // idle run starts
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS); // threshold met → dispatch attempt

    const result = await worker.tick();

    expect(result.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      '/skill:refactor',
      expect.objectContaining({ paneName: 'Downtime /skill:refactor' }),
    );
    expect(worker.paused).toBe(false); // a dispatch — not the empty-backlog pause
    expect(worker.errorStrikes).toBe(0);
  });

  it('performs no proxy polling, no idle tracking and no dispatch while paused', async () => {
    const { worker, deps, fetcher } = makeEmptyBacklogWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick(); // enters cooldown
    expect(worker.paused).toBe(true);

    const pollsBefore = fetcher.mock.calls.length;
    const idleBefore = worker.idleSince;
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 60_000); // still within the pause
    const result = await worker.tick();

    expect(result).toEqual({ polled: false, dispatched: false, idle: false });
    expect(fetcher.mock.calls.length).toBe(pollsBefore); // no poll
    expect(worker.idleSince).toBe(idleBefore); // no idle tracking
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(worker.paused).toBe(true);
  });

  it('resumes polling once the cooldown expires and requires a fresh full idle period', async () => {
    let backlogEmpty = true;
    const { worker, deps } = makeEmptyBacklogWorker({
      deps: {
        getNextItem: vi.fn().mockImplementation(() =>
          Promise.resolve(
            backlogEmpty
              ? { ok: true, candidate: null }
              : { ok: true, candidate: { id: 'WL-NEW', title: 'New item', stage: 'intake_complete' } },
          ),
        ),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick(); // empty backlog → cooldown
    expect(worker.paused).toBe(true);

    // The project's backlog fills back up while the worker is paused.
    backlogEmpty = false;
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000); // pause expires
    const resumed = await worker.tick();
    expect(resumed.polled).toBe(true);
    expect(resumed.dispatched).toBe(false); // fresh idle run — no stale credit
    expect(worker.paused).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    // A full new idle period must elapse before the next dispatch.
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    const afterFreshIdle = await worker.tick();
    expect(afterFreshIdle.dispatched).toBe(true); // candidate now available
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('does not enter the cooldown on a transient wl error (fail closed to busy)', async () => {
    const { worker, deps } = makeEmptyBacklogWorker({
      deps: { getNextItem: vi.fn().mockResolvedValue({ ok: false }) },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

    const result = await worker.tick();

    expect(result.dispatched).toBe(false);
    expect(worker.paused).toBe(false); // a single error is NOT an empty backlog
    expect(worker.errorStrikes).toBe(1); // ...but it IS the first strike
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // WL-0MTJPYM53003ORCV: every strike is logged (per-strike observability).
    expect(deps.recordError).toHaveBeenCalledTimes(1);
  });

  it('does not enter the cooldown when the dispatch guard reports in-flight', async () => {
    // Hold the module-level dispatch single-flight guard with an outer
    // in-flight dispatch; the worker's own dispatch call then returns
    // `dispatch-in-flight`, which must NOT trigger the cooldown.
    let release!: () => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = () => resolve({ ok: true });
    });
    const outerDeps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-X', title: 'Outer', stage: 'intake_complete' },
      }),
      spawnAgentPane: vi.fn().mockImplementation(() => gate),
    });
    const outer = dispatchDowntimeWork(outerDeps, { model: 'plan', cwd: '/repo' });

    const { worker } = makeEmptyBacklogWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    const result = await worker.tick();
    expect(result.dispatched).toBe(false);
    expect(worker.paused).toBe(false); // in-flight guard is not an empty backlog

    release();
    await outer;
  });

  it('does not enter the cooldown on a code-freeze skip (the freeze never pauses the worker)', async () => {
    // Frozen + empty plan/intake backlog → reason 'code-freeze' (never
    // 'no-candidate'): the worker must keep polling so implement/audit
    // dispatch resumes immediately when the freeze lifts (WL-0MSQ0RPQP00636JY).
    const { worker, deps } = makeEmptyBacklogWorker({
      deps: {
        readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

    const result = await worker.tick();

    expect(result.dispatched).toBe(false);
    expect(worker.paused).toBe(false); // a freeze skip is NOT an empty backlog
    expect(worker.errorStrikes).toBe(0); // ...and not a CLI-error strike either
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('re-reads the cooldown setting each tick so a change applies on the next cooldown entry', async () => {
    const { worker, cfg } = makeEmptyBacklogWorker({ cooldownMs: 3_600_000 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick(); // enters cooldown with 3_600_000 (expires at 4_840_000)
    expect(worker.paused).toBe(true);

    // Operator lowers the cooldown live; the in-progress pause keeps its
    // original expiry, but the NEXT cooldown entry uses the new value.
    cfg.noCandidateCooldownMs = 60_000;
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000); // original pause expires
    await worker.tick(); // resumes, starts a fresh idle run

    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS); // fresh threshold met
    await worker.tick(); // empty backlog again → 60s cooldown (new value)
    expect(worker.paused).toBe(true);

    // With the NEW 60s value the pause expires long before the old 60-min
    // default would have: at +61s the worker has resumed polling.
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 61_000);
    const resumed = await worker.tick();
    expect(resumed.polled).toBe(true);
    expect(worker.paused).toBe(false);
  });

  // ── Cooldown lease maintenance (parent F2 — holes A & B regression) ──

  /** Read the current lease file from the coordination directory. */
  function readLease(coordDir: string) {
    const raw = readFileSync(join(coordDir, LEASE_FILE), 'utf-8');
    return JSON.parse(raw) as { leaderId: string; acquiredAt: string; ttlSeconds: number };
  }

  /** Write a lease file directly (simulates another instance winning election). */
  function writeLease(coordDir: string, instanceId: string, ttlSeconds: number, nowMs: number) {
    const lease = {
      leaderId: instanceId,
      acquiredAt: new Date(nowMs).toISOString(),
      ttlSeconds,
    };
    writeFileSync(join(coordDir, LEASE_FILE), JSON.stringify(lease));
    // Also write the lock file so hasLease() returns true.
    writeFileSync(join(coordDir, LEADER_LOCK_FILE), instanceId);
  }

  it('keeps refreshing the lease during the no-candidate cooldown pause (AC1)', async () => {
    // While a leader is paused in the no-candidate cooldown, the lease file
    // mtime/content keeps advancing (refresh continues during the pause).
    // Sibling fix (e842208580) already runs the leader block BEFORE the
    // cooldown gate, so lease refreshes each tick during the pause.
    const { worker, coordDir } = makeCoordinationWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);

    // Tick 1: election → A wins lease, refreshLease
    await worker.tick();
    expect(worker.isLeader).toBe(true);
    expect(worker.paused).toBe(false);

    const leaseAfterElection = readLease(coordDir);
    expect(leaseAfterElection.leaderId).toBe('inst-a');

    // Tick 2: threshold met → dispatch attempt → no-candidate → cooldown
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick();
    expect(worker.paused).toBe(true);
    expect(worker.isLeader).toBe(true);

    // Tick 3 during cooldown: lease should refresh (leader block runs first)
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 60_000);
    await worker.tick();

    const leaseDuringPause = readLease(coordDir);
    expect(leaseDuringPause.leaderId).toBe('inst-a');
    // Content-based pin (fake timers control Date.now — robust vs fs mtime
    // granularity): the lease acquiredAt must have ADVANCED during the pause.
    expect(new Date(leaseDuringPause.acquiredAt).getTime()).toBeGreaterThan(
      new Date(leaseAfterElection.acquiredAt).getTime(),
    );
    // Belt: the pause itself is still in effect (no premature resume).
    expect(worker.paused).toBe(true);
  });

  it('renews the lease on cooldown exit BEFORE dispatch (even if expired mid-pause) (AC2)', async () => {
    // On cooldown exit, the lease is renewed BEFORE any dispatch decision
    // (belt: even if tick loop stalled mid-pause, the lease expired).
    const { worker, coordDir } = makeCoordinationWorker({
      leaseTtlSeconds: 300, // 5 min TTL
    });
    const start = 1_000_000;
    vi.setSystemTime(start);

    // Tick 1: election → A wins lease
    await worker.tick();
    expect(worker.isLeader).toBe(true);

    // Tick 2: threshold met → dispatch attempt → no-candidate → cooldown
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick();
    expect(worker.paused).toBe(true);
    expect(worker.isLeader).toBe(true);

    // Stalled tick loop: advance time PAST lease TTL (300s) but still within
    // the cooldown (3.6M ms) — simulate a frozen tick loop mid-pause.
    // Lease TTL = 300s; we advance 400s into the cooldown → lease expired.
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 400_000);
    // Do NOT tick — simulate the loop being frozen.

    // Now advance to cooldown expiry.
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000 + 1_000);

    // The resume tick: leader block runs (cached leaderState=true)
    // but refreshLease no-ops on our expired lease (Hole A — isLeader returns
    // false because lease expired).
    // Cooldown gate clears. Then poll/dispatch.
    await worker.tick();

    // AC2 assertion: lease must be VALID after the exit tick (renewed BEFORE
    // any dispatch decision). On current code the lease is still expired
    // (refreshLease no-oped), so this FAILS — proving Hole A.
    const leaseAfterExit = readLease(coordDir);
    const leaseValid = isLeaseValid(leaseAfterExit);
    expect(leaseValid).toBe(true);
    expect(leaseAfterExit.leaderId).toBe('inst-a');
    // Belt: the lease was RENEWED at exit — its acquiredAt must postdate the
    // stalled period (current code keeps the stale acquiredAt → FAILS).
    expect(new Date(leaseAfterExit.acquiredAt).getTime()).toBeGreaterThan(
      start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 400_000,
    );
  });

  it('re-derives leadership every tick: expired lease routes to election, no zombie dispatch (AC3)', async () => {
    // leaderState is re-derived every tick: an expired lease while
    // leaderState === true routes into the election/takeover path instead of
    // zombie dispatch.
    const { worker, deps, coordDir } = makeCoordinationWorker({
      leaseTtlSeconds: 300,
    });
    const start = 1_000_000;
    vi.setSystemTime(start);

    // Tick 1: election → A wins lease
    await worker.tick();
    expect(worker.isLeader).toBe(true);

    // Tick 2: threshold met → dispatch attempt → no-candidate → cooldown
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick();
    expect(worker.paused).toBe(true);
    expect(worker.isLeader).toBe(true);

    // Mid-pause, B wins the election with a FRESH lease and a FRESH
    // coordination entry (a live instance refreshes its entry on its own
    // check-in cadence — write it at resume time so pruneStaleEntries does
    // NOT delete it before A's dispatch tick; the entry must be present for
    // the zombie dispatch to be observable).
    const resumeTime = start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000 + 1_000;
    vi.setSystemTime(resumeTime);
    writeLease(coordDir, 'inst-b', 300, resumeTime);

    const entryB = {
      instanceId: 'inst-b',
      workItemId: 'WL-B1',
      directory: '/repo-b',
      assignedAt: new Date(resumeTime).toISOString(),
      lastUpdated: new Date(resumeTime).toISOString(),
    };
    writeCoordinationFile(coordDir, { version: 1, entries: [entryB] });

    // Resume tick at cooldown expiry: leader block runs (cached
    // leaderState=true) → refreshLease no-ops (B holds the lease → isLeader
    // false) → leaderState STAYS true (Hole B). Cooldown gate clears → a
    // FRESH idle run starts (tracker was reset on cooldown entry), so no
    // dispatch happens on THIS tick — the zombie dispatch is decided on the
    // NEXT tick after the idle threshold.
    await worker.tick();

    // Second tick: idle threshold met → dispatch decision. On current code
    // (leaderState cached true) A reads B's entry and spawns A PANE — the
    // zombie. After F5 (per-tick re-derivation) leaderState=false → the
    // non-leader short-circuit returns BEFORE poll/dispatch.
    vi.setSystemTime(resumeTime + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick();

    // AC3 assertion: A must NOT dispatch B's item (B is the live leader).
    // On current code (cached leaderState=true): spawnAgentPane IS called →
    // FAIL (RED). After F5: leaderState re-derived false → GREEN.
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    // Also assert A is no longer leader (re-derived state).
    expect(worker.isLeader).toBe(false);
  });

  it('stays silent when a valid foreign lease is held by another instance (AC4)', async () => {
    // Non-leader with a valid lease held by another live instance stays
    // silent (existing AC3 behavior preserved — regression guard). B's lease
    // is pre-seeded BEFORE worker creation, so leaderState=false at startup
    // (fixture passes coordination opts TOP-LEVEL as required).
    const start = 1_000_000;
    vi.setSystemTime(start);
    const { worker, deps, fetcher } = makeCoordinationWorker({
      seedLease: { instanceId: 'inst-b', atMs: start },
    });

    // Tick: leaderState at creation = isLeader() → false (lease owned by B).
    // Leader block: leaderState false → hasLease=true, detectStaleLeader=false
    // (B's lease is valid) → no election. Then: if (!leaderState) return.
    const result = await worker.tick();

    expect(result.polled).toBe(false);
    expect(result.dispatched).toBe(false);
    expect(result.idle).toBe(false);
    expect(worker.isLeader).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled(); // no poll
  });
});

// ── Three-strike rule on CLI errors ───────────────────────────────────

describe('three-strike rule on CLI errors (createDowntimeWorker)', () => {
  /** Every dispatch attempt ends in a wl CLI error ({ok:false} both tiers). */
  function makeErrorWorker(overrides: { deps?: Partial<DowntimeWorkerDeps> } = {}) {
    const cfg = {
      enabled: true,
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
    };
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: false }),
      ...overrides.deps,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg, fetcher };
  }

  it('pauses and records the persistent error after 3 consecutive CLI errors', async () => {
    const { worker, deps } = makeErrorWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // idle run starts
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS); // threshold met

    const s1 = await worker.tick(); // strike 1
    expect(s1.dispatched).toBe(false);
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(1);

    const s2 = await worker.tick(); // strike 2
    expect(s2.dispatched).toBe(false);
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(2);

    const s3 = await worker.tick(); // strike 3 → pause + log
    expect(s3.dispatched).toBe(false);
    expect(worker.paused).toBe(true);
    expect(worker.errorStrikes).toBe(0); // counter reset once paused
    // WL-0MTJPYM53003ORCV: every strike is logged — 3 per-strike entries
    // (attempt 1/2/3), not just the pause marker at strike 3.
    expect(deps.recordError).toHaveBeenCalledTimes(3);
    const event3 = (deps.recordError as ReturnType<typeof vi.fn>).mock.calls[2][0];
    expect(event3.cwd).toBe('/repo');
    expect(event3.message).toContain('3 consecutive');
    expect(event3.attempt).toBe(3);
    expect(Number.isNaN(Date.parse(event3.at))).toBe(false);
  });

  it('an audit-tier wl failure counts toward the three-strike rule (WL-0MSLWJ2KP0002SV0)', async () => {
    // The wl-error comes from the AUDIT tier ({ok:false}) while the
    // plan/intake tiers are GENUINELY empty ({ok:true, candidate:null}): the
    // only possible strike source is the audit lookup, proving a broken
    // audit query cannot silently pass as "no audit candidates" forever —
    // three consecutive failures pause the worker and log recordError.
    const { worker, deps } = makeErrorWorker({
      deps: {
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: false }),
        getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

    const s1 = await worker.tick();
    expect(s1.dispatched).toBe(false);
    expect(worker.errorStrikes).toBe(1);
    expect(worker.paused).toBe(false);
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1);

    const s2 = await worker.tick();
    expect(s2.dispatched).toBe(false);
    expect(worker.errorStrikes).toBe(2);
    // WL-0MTJPYM53003ORCV: strikes 1 and 2 are already logged per-strike.
    expect(deps.recordError).toHaveBeenCalledTimes(2);

    const s3 = await worker.tick(); // strike 3 → pause + durable trace
    expect(s3.dispatched).toBe(false);
    expect(worker.paused).toBe(true);
    expect(worker.errorStrikes).toBe(0);
    expect(deps.recordError).toHaveBeenCalledTimes(3);
    expect(deps.recordError).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('resumes with a fresh strike counter once the pause expires', async () => {
    const { worker, deps } = makeErrorWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick(); // strike 1
    await worker.tick(); // strike 2
    await worker.tick(); // strike 3 → paused
    expect(worker.paused).toBe(true);

    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000); // pause expires
    const resumed = await worker.tick();
    expect(resumed.polled).toBe(true);
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(0);

    // A fresh error is strike 1 again — not a strike 4.
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick();
    expect(worker.errorStrikes).toBe(1);
    expect(worker.paused).toBe(false);
  });

  it('resets the strike counter on a successful dispatch', async () => {
    const { worker, deps } = makeErrorWorker({
      deps: {
        getNextItem: vi
          .fn()
          .mockResolvedValueOnce({ ok: false }) // tier 2 error
          .mockResolvedValueOnce({ ok: false }) // tier 3 error → strike 1
          .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' } })
          .mockResolvedValue({ ok: false }), // errors afterwards
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

    await worker.tick(); // strike 1
    expect(worker.errorStrikes).toBe(1);

    await worker.tick(); // successful dispatch → strikes reset
    expect(worker.errorStrikes).toBe(0);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    // A fresh full idle period is required after the dispatch (AC5) before
    // the next dispatch attempt.
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS); // fresh idle run starts
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 480_000); // fresh threshold met
    await worker.tick(); // strike 1 (fresh — not a strike 2)
    expect(worker.errorStrikes).toBe(1);
    await worker.tick(); // strike 2
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(2);

    await worker.tick(); // strike 3 → paused
    expect(worker.paused).toBe(true);
    // WL-0MTJPYM53003ORCV: per-strike logging — 1 (pre-dispatch strike) +
    // 3 (fresh strikes 1-3) = 4 recordError calls.
    expect(deps.recordError).toHaveBeenCalledTimes(4);
  });

  it('does not strike on a no-candidate outcome (CLI answered — healthy)', async () => {
    const { worker, deps } = makeErrorWorker({
      deps: {
        getNextItem: vi
          .fn()
          .mockResolvedValueOnce({ ok: false })
          .mockResolvedValueOnce({ ok: false }) // strike 1
          .mockResolvedValue({ ok: true, candidate: null }), // genuine empty backlog
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

    await worker.tick(); // strike 1 → recordError logged
    expect(worker.errorStrikes).toBe(1);
    expect(deps.recordError).toHaveBeenCalledTimes(1);

    const result = await worker.tick(); // no-candidate → cooldown, strikes reset
    expect(result.dispatched).toBe(false);
    expect(worker.paused).toBe(true); // genuine empty backlog pauses the worker
    expect(worker.errorStrikes).toBe(0);
    // recordError was called for strike 1; no-candidate does NOT add a strike
    expect(deps.recordError).toHaveBeenCalledTimes(1);
  });

  // ── Per-strike logging (WL-0MTJPYM53003ORCV) ────────────────────────

  it('records a persistent error on EVERY strike (1, 2, and 3), not just strike 3', async () => {
    const { worker, deps } = makeErrorWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

    await worker.tick(); // strike 1
    expect(worker.errorStrikes).toBe(1);
    expect(deps.recordError).toHaveBeenCalledTimes(1);

    await worker.tick(); // strike 2
    expect(worker.errorStrikes).toBe(2);
    expect(deps.recordError).toHaveBeenCalledTimes(2);

    await worker.tick(); // strike 3 → pause + log
    expect(worker.errorStrikes).toBe(0);
    expect(deps.recordError).toHaveBeenCalledTimes(3);
  });

  it('per-strike log entries carry attempt/probeContext/timeoutMs on every strike (WL-0MTJPYM53003ORCV)', async () => {
    const { worker, deps } = makeErrorWorker({
      deps: {
        // Carry a stderr-ish message so stderrExcerpt is populated from the
        // error string (fetcher.ts builds error from stderr||stdout||message).
        getNextItem: vi.fn().mockResolvedValue({ ok: false, error: 'SQLITE_BUSY: database is locked' }),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

    await worker.tick(); // strike 1
    const event1 = (deps.recordError as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event1.cwd).toBe('/repo');
    expect(event1.attempt).toBe(1);
    expect(event1.probeContext).toBe('dispatch-cli');
    expect(event1.timeoutMs).toBe(10_000);
    expect(event1.stderrExcerpt).toBe('SQLITE_BUSY: database is locked');
    expect(Number.isNaN(Date.parse(event1.at))).toBe(false);

    await worker.tick(); // strike 2
    const event2 = (deps.recordError as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(event2.attempt).toBe(2);
    expect(event2.probeContext).toBe('dispatch-cli');
    expect(event2.stderrExcerpt).toBe('SQLITE_BUSY: database is locked');

    await worker.tick(); // strike 3
    const event3 = (deps.recordError as ReturnType<typeof vi.fn>).mock.calls[2][0];
    expect(event3.attempt).toBe(3);
    expect(event3.probeContext).toBe('dispatch-cli');
  });

  it('stderr excerpt is truncated to 200 chars with [truncated] marker (WL-0MTJPYM53003ORCV)', async () => {
    const longStderr = 'database is locked '.repeat(50); // > 200 chars
    const { worker, deps } = makeErrorWorker({
      deps: {
        getNextItem: vi.fn().mockResolvedValue({ ok: false, error: longStderr }),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick(); // strike 1
    const event = (deps.recordError as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.stderrExcerpt.length).toBeLessThanOrEqual(200 + '[truncated]'.length);
    expect(event.stderrExcerpt.endsWith('[truncated]')).toBe(true);
    expect(event.stderrExcerpt.length).toBe(200 + '[truncated]'.length);
  });

  it('probeContext is dispatch-cli for the legacy dispatch path (WL-0MTJPYM53003ORCV)', async () => {
    // The makeErrorWorker fixture runs in legacy (non-coordination) mode,
    // so all errors flow through the dispatch-cli path.
    const { worker, deps } = makeErrorWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

    await worker.tick(); // strike 1
    const event1 = (deps.recordError as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event1.probeContext).toBe('dispatch-cli');

    await worker.tick(); // strike 2
    const event2 = (deps.recordError as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(event2.probeContext).toBe('dispatch-cli');
  });
});

// ── Per-slot idle tracking (WL-0MSP28F5Z008DAUA, parent WL-0MSG7P9N8009PCKG) ──
// Test-first suite for same-slot idle tracking, deferred follow-up Q7 of
// WL-0MSF49FMW009M06K. The proxy feature LP-0MSG5TA7Y002GN39 serves per-slot
// details (`slots: [{slot_id, is_processing}]`) in GET /llama/local/status;
// when `downtimeRequiredFreeSlots` N < total slots, the worker must track idle
// duration PER SLOT IDENTITY so the SAME N slots are free for the full
// threshold — never any-N transient availability.
//
// The proxy (observability.py) serves `slot_id` as an INTEGER
// (`slot.get("id", i)`); `parseLlamaStatus` coerces numeric ids to strings
// and clamps negatives to 0 (WL-0MSVRMAWM007QNR5 — the Aug 15-16
// zero-dispatch regression fix). Regression tests mirror the live payload
// at parse level and end-to-end through the worker tick.

// ── parseLlamaStatus: optional per-slot fields (AC1/AC2) ───────────────

describe('parseLlamaStatus per-slot slots array', () => {
  const base = {
    llama_server_running: true,
    model_switch_in_progress: false,
    available_slots: 4,
    total_slots: 4,
  };

  it('exposes the slots array when the payload serves it', () => {
    const status = parseLlamaStatus({
      ...base,
      slots: [
        { slot_id: 'slot-1', is_processing: false },
        { slot_id: 'slot-2', is_processing: true },
      ],
    });
    expect(status).not.toBeNull();
    expect(status!.slots).toEqual([
      { slot_id: 'slot-1', is_processing: false },
      { slot_id: 'slot-2', is_processing: true },
    ]);
  });

  it('leaves slots undefined when the payload does not serve it (backward compatible)', () => {
    const status = parseLlamaStatus(base);
    expect(status).not.toBeNull();
    expect(status!.slots).toBeUndefined();
  });

  it('parses an empty slots array as valid (zero free slots — never dispatches)', () => {
    const status = parseLlamaStatus({ ...base, slots: [] });
    expect(status).not.toBeNull();
    expect(status!.slots).toEqual([]);
  });

  it('treats a non-array slots field as ambiguous → null (busy, fail-closed)', () => {
    expect(parseLlamaStatus({ ...base, slots: 'not-an-array' })).toBeNull();
    expect(parseLlamaStatus({ ...base, slots: { slot_id: 'x', is_processing: false } })).toBeNull();
  });

  it('treats an entry missing slot_id as malformed → null', () => {
    expect(parseLlamaStatus({ ...base, slots: [{ is_processing: false }] })).toBeNull();
  });

  it('treats an empty-string slot_id as malformed → null (zero-length guard preserved)', () => {
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: '', is_processing: false }] })).toBeNull();
  });

  it('coerces numeric slot_ids to strings (proxy contract: int, WL-0MSVRMAWM007QNR5)', () => {
    const status = parseLlamaStatus({
      ...base,
      slots: [
        { slot_id: 0, is_processing: false },
        { slot_id: 3, is_processing: true },
      ],
    });
    expect(status).not.toBeNull();
    expect(status!.slots).toEqual([
      { slot_id: '0', is_processing: false },
      { slot_id: '3', is_processing: true },
    ]);
  });

  it('clamps negative numeric slot_ids to 0 (WL-0MSVRMAWM007QNR5)', () => {
    const status = parseLlamaStatus({
      ...base,
      slots: [{ slot_id: -2, is_processing: false }],
    });
    expect(status).not.toBeNull();
    expect(status!.slots).toEqual([{ slot_id: '0', is_processing: false }]);
  });

  it('treats a non-finite or non-integer numeric slot_id as malformed → null (fail-closed)', () => {
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: Number.NaN, is_processing: false }] })).toBeNull();
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: Number.POSITIVE_INFINITY, is_processing: false }] })).toBeNull();
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: 1.5, is_processing: false }] })).toBeNull();
  });

  it('regression: parses the live proxy payload (integer slot_ids, WL-0MSVRMAWM007QNR5)', () => {
    // observability.py serves `"slot_id": slot.get("id", i)` — an integer —
    // per slot. Before the fix, parseLlamaStatus rejected the numeric
    // slot_id and every 30s poll failed closed to busy — the Aug 15-16
    // zero-dispatch regression. Mirror the live payload exactly.
    const livePayload = {
      llama_server_running: true,
      local_active_query: false,
      model_switch_in_progress: false,
      available_slots: 4,
      total_slots: 4,
      slots: [
        { slot_id: 0, is_processing: false },
        { slot_id: 1, is_processing: false },
        { slot_id: 2, is_processing: false },
        { slot_id: 3, is_processing: false },
      ],
    };
    const status = parseLlamaStatus(livePayload);
    expect(status).not.toBeNull();
    expect(status!.slots!.map((s) => s.slot_id)).toEqual(['0', '1', '2', '3']);
    // The coerced payload is a valid idle status for the default N=0 AND
    // for per-slot mode (0 < N < total) — dispatch can resume.
    expect(evaluateIdle(status!, 0)).toBe(true);
    expect(evaluateIdle(status!, 2)).toBe(true);
  });

  it('treats a non-boolean or missing is_processing as malformed → null', () => {
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: 'slot-1', is_processing: 'yes' }] })).toBeNull();
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: 'slot-1' }] })).toBeNull();
  });

  it('treats duplicate slot_ids as malformed → null', () => {
    expect(
      parseLlamaStatus({
        ...base,
        slots: [
          { slot_id: 'slot-1', is_processing: false },
          { slot_id: 'slot-1', is_processing: true },
        ],
      }),
    ).toBeNull();
  });
});

// ── Worker routing: per-slot mode vs fallback (WL-0MSG7P9N8009PCKG AC) ─
describe('downtime worker per-slot routing (createDowntimeWorker)', () => {
  function makePerSlotWorker(overrides: {
    requiredFreeSlots?: number;
    thresholdMs?: number;
    status?: unknown;
    deps?: Partial<DowntimeWorkerDeps>;
  } = {}) {
    const cfg = {
      enabled: true,
      thresholdMs: overrides.thresholdMs ?? DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: overrides.requiredFreeSlots ?? 2,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponseFixture(overrides.status ?? perSlotTwoFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      ...overrides.deps,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg, fetcher };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes to per-slot mode: dispatches with only N of total slots free (same slots, full threshold)', async () => {
    // perSlotTwoFree: 2 of 4 slots free. Legacy all-slots-free mode would
    // NEVER dispatch (available 2 < 4); per-slot mode dispatches after the
    // threshold because the SAME 2 slots have been free throughout.
    const { worker, deps, cfg } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    // idleSince is null because slots 3,4 are processing — the title bar
    // must show "busy", not "idle". Dispatch is unaffected (perSlotTracker
    // still counts the 2 free slots for spare-capacity dispatch).
    expect(worker.idleSince).toBeNull();

    vi.setSystemTime(start + cfg.thresholdMs - 1);
    const before = await worker.tick();
    expect(before.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('AC1 spare-capacity: 3 slots/1 busy with the operator session active (query+lease) still dispatches into the 2 free slots', async () => {
    // parent ACL1: 2 of 3 slots continuously free for the full threshold →
    // dispatch fires even though 1 slot is occupied by an active
    // (query + lease) session — exactly the operator working in the TUI
    // while the downtime worker uses the spare capacity.
    const operatorSessionPayload = {
      llama_server_running: true,
      local_active_query: true,
      model_switch_in_progress: false,
      local_lease_active: true,
      available_slots: 2,
      total_slots: 3,
      slots: [
        { slot_id: 'slot-1', is_processing: true },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: false },
      ],
    };
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({
      requiredFreeSlots: 2,
      status: operatorSessionPayload,
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // 2 free → per-slot idle run starts
    // idleSince is null because slot-1 is processing — title bar shows
    // "busy" even though dispatch fires into free slots.
    expect(worker.idleSince).toBeNull();

    vi.setSystemTime(start + cfg.thresholdMs - 1);
    const before = await worker.tick();
    expect(before.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true); // dispatch into the 2 free slots
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalled();
  });

  it('AC2 spare-capacity: a mid-query (processing) busy slot does NOT reset the free slots\' timers', async () => {
    // parent AC2: with N free of total in per-slot mode, idle is evaluated
    // from the free slots only. A processing slot 1 does not reset slot-2 /
    // slot-3 timers — dispatch still fires once the free slots have been
    // continuously free for the full threshold (the busy slot is the
    // operator's own mid-query session).
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // perSlotTwoFree (slot-1, slot-2 free) → timers start

    // slot-1 goes mid-query while slot-2 stays free; the global query signal
    // also fires. Spare-capacity relaxation: only slot-1's timer resets.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotTwoFree));
    vi.setSystemTime(start + cfg.thresholdMs - 10_000);
    const mid = await worker.tick();
    expect(mid.idle).toBe(true); // free count still ≥ N=2 (slot-1 busy)

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true); // slot-2 ran the full threshold
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('AC3 tier minimums flow from the poll: 1 free slot skips the audit tier, plan dispatches (worker end-to-end)', async () => {
    // N=1 with a single free slot: the idle gate is satisfied (1 ≥ N), but
    // the AUDIT tier needs ≥2 free slots (parent WL-0MT32F90V008UAD2 AC3) —
    // the worker must pass the polled free count into the tier selection so
    // the audit candidate is skipped and the plan pane dispatches instead.
    const oneFreePayload = {
      llama_server_running: true,
      model_switch_in_progress: false,
      local_lease_active: true,
      available_slots: 1,
      total_slots: 3,
      slots: [
        { slot_id: 'slot-1', is_processing: true },
        { slot_id: 'slot-2', is_processing: true },
        { slot_id: 'slot-3', is_processing: false },
      ],
    };
    const { worker, deps, cfg } = makePerSlotWorker({
      requiredFreeSlots: 1,
      status: oneFreePayload,
      deps: {
        getNextAuditCandidate: vi.fn().mockResolvedValue({
          ok: true,
          candidate: { id: 'WL-AUD', title: 'Audit me', stage: 'audit' },
        }),
        getNextItem: vi.fn().mockResolvedValue({
          ok: true,
          candidate: { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete', status: 'open' },
        }),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // 1 free slot ≥ N=1 → per-slot idle run starts
    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();

    // The worker saw freeSlots=1: the audit candidate was never consulted
    // and the plan pane dispatched.
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(at.dispatched).toBe(true);
    expect((deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('/skill:plan WL-PLAN');
  });

  it('regression: a live proxy payload (integer slot_ids) idles and dispatches (WL-0MSVRMAWM007QNR5)', async () => {
    // observability.py serves `"slot_id": slot.get("id", i)` — an integer —
    // for each slot. Before the fix, parseLlamaStatus rejected the numeric
    // slot_id, so every poll failed closed to busy and the worker never
    // dispatched (the Aug 15-16 zero-dispatch regression). This mirrors the
    // live payload end-to-end: poll → parse → idle run → threshold → dispatch.
    const livePayload = {
      llama_server_running: true,
      local_active_query: false,
      model_switch_in_progress: false,
      available_slots: 4,
      total_slots: 4,
      slots: [
        { slot_id: 0, is_processing: false },
        { slot_id: 1, is_processing: false },
        { slot_id: 2, is_processing: false },
        { slot_id: 3, is_processing: false },
      ],
    };
    const { worker, deps, cfg } = makePerSlotWorker({ status: livePayload });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince ?? null).not.toBeNull(); // idle run starts

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('a slot starting processing resets only its own timer: other slots keep their run and can dispatch', async () => {
    // N=1. slot-1 goes processing at +10s while slot-2 stays free. The poll
    // stays per-slot idle (free count 3 ≥ 1), slot-2's timer continues, and
    // dispatch fires at the original threshold — not delayed by slot-1.
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({ requiredFreeSlots: 1 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // all 4 free → timers start

    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotOneProcessing));
    vi.setSystemTime(start + 10_000);
    const mid = await worker.tick();
    expect(mid.idle).toBe(true); // free count 3 ≥ N=1 → still idle

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('a processing slot that must count toward N delays dispatch by its own fresh run', async () => {
    // Per-slot mode with 4 slots, N=2: slot-1 is processing from +10s to
    // +20s while slot-2 stays free. slot-1's OWN timer resets, so dispatch
    // cannot fire at the original threshold (only slot-2 has a full
    // continuous run); it fires only after slot-1's fresh run completes.
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // slot-1, slot-2 free → their timers start

    const fourSlots = (s1: boolean): LlamaStatus => ({
      ...perSlotAllFree,
      available_slots: (s1 ? 0 : 1) + 1, // slot-2 free + slot-1 free
      total_slots: 4,
      slots: [
        { slot_id: 'slot-1', is_processing: s1 },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: true },
        { slot_id: 'slot-4', is_processing: true },
      ],
    });
    fetcher.mockResolvedValueOnce(jsonResponseFixture(fourSlots(true)));
    vi.setSystemTime(start + 10_000);
    await worker.tick(); // slot-1 processing → its own timer resets

    fetcher.mockResolvedValueOnce(jsonResponseFixture(fourSlots(false)));
    vi.setSystemTime(start + 20_000);
    await worker.tick(); // slot-1 free again → restarts its run

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(false); // only slot-2 has a full continuous run

    vi.setSystemTime(start + 20_000 + cfg.thresholdMs);
    const after = await worker.tick();
    expect(after.dispatched).toBe(true); // slot-1 completed its fresh run
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('a global busy poll resets ALL per-slot timers (fresh full idle period required)', async () => {
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // all free → timers start

    // model_switch_in_progress is a GLOBAL gate in per-slot mode (spare-
    // capacity relaxation, parent WL-0MT32F90V008UAD2 AC2) — it resets
    // every slot timer. A per-slot query/lease signal is NOT global
    // anymore and is covered by the dedicated spare-capacity tests.
    fetcher.mockResolvedValueOnce(jsonResponseFixture({ ...perSlotAllFree, model_switch_in_progress: true }));
    vi.setSystemTime(start + 10_000);
    await worker.tick(); // global busy → every slot timer reset

    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + 20_000);
    await worker.tick(); // free again → timers restart at +20s

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(false); // no slot has a full run since +20s

    vi.setSystemTime(start + 20_000 + cfg.thresholdMs);
    const after = await worker.tick();
    expect(after.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('an ambiguous poll (null status) resets ALL per-slot timers (fail-closed)', async () => {
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // all free → timers start

    fetcher.mockResolvedValueOnce(jsonResponseFixture(null));
    vi.setSystemTime(start + 10_000);
    await worker.tick(); // ambiguous → busy → every slot timer reset

    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + 20_000);
    await worker.tick(); // free again → timers restart at +20s

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(false);

    vi.setSystemTime(start + 20_000 + cfg.thresholdMs);
    const after = await worker.tick();
    expect(after.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('without usable per-slot data, fails closed (never dispatches on any-N availability)', async () => {
    // No usable per-slot detail + 0 < N < total: the worker fails closed
    // (WL-0MUXVPXAZ005RESW) — never dispatching on the untrusted count —
    // and records the distinct `slots-unavailable` reason.
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({
      requiredFreeSlots: 2,
      status: { ...idleAllSlotsFree, slots: undefined, available_slots: 4 },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    const first = await worker.tick();
    expect(first.idle).toBe(false);
    expect(worker.blockReason).toBe('no-slots');

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalled(); // still polling — just never dispatching
  });

  it('with per-slot data but N=0, falls back to all-slots-free (per-slot mode only when 0 < N < total)', async () => {
    // Slots are present but N=0 (all slots): per-slot mode is NOT active —
    // all-slots-free applies, so 2 of 4 free is busy and never dispatches.
    const { worker, deps, cfg } = makePerSlotWorker({
      requiredFreeSlots: 0,
      status: perSlotTwoFree,
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    const first = await worker.tick();
    expect(first.idle).toBe(false);

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  // ── Title bar idle display (parent WL-0MT65T14L002HTWB) ────────────
  // The global idle tracker (`worker.idleSince`) drives the title bar
  // `[⏳ downtime idle Xs]` indicator. In per-slot mode the relaxed
  // per-slot global gate deliberately ignores query/busy signals for
  // DISPATCH; the DISPLAY must still reflect actual per-slot activity.
  // idleSince (the display signal) is null whenever ANY slot is
  // processing — the title bar shows `[downtime busy]` — while dispatch
  // into free slots is unaffected.

  it('display: title bar shows busy when ANY slot is processing (incl. the operator\'s)', async () => {
    // perSlotTwoFree: slots 3,4 processing. The title-bar display must show
    // "busy" (idleSince null) even though the per-slot dispatch gate (2
    // free slots) is satisfied.
    const { worker, cfg } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince).toBeNull(); // → `[downtime busy]` in the title bar

    // Even after the dispatch threshold elapses, the display stays busy
    // while a slot is processing (dispatch itself fires per usual).
    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true); // dispatch still fires (spare capacity)
    expect(worker.idleSince).toBeNull(); // display never flips to idle mid-query
  });

  it('display: title bar shows idle ONLY when every slot is free', async () => {
    // perSlotAllFree: all 4 slots free — no active processing anywhere, so
    // the display can honestly show the idle counter.
    const { worker, fetcher, cfg } = makePerSlotWorker({
      requiredFreeSlots: 2,
      status: perSlotAllFree,
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince).toBe(start); // → `[⏳ downtime idle 0:00]`

    // Keep the status for the second tick (default is perSlotTwoFree which
    // has processing slots). Check BELOW the dispatch threshold so the tick
    // does not dispatch (which would reset idleSince by design).
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + cfg.thresholdMs - 10_000);
    await worker.tick();
    expect(worker.idleSince).toBe(start); // run start stays fixed while free
  });

  it('display: a slot starting processing resets the idle counter; freeing it restarts a fresh run', async () => {
    // Demonstrates that the display (idleSince) tracks actual per-slot
    // processing state — completely independent of dispatch logic.
    const { worker, fetcher, cfg } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // perSlotTwoFree: slots 3,4 processing → display busy
    expect(worker.idleSince).toBeNull();

    // All slots free → the idle counter starts.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + 10_000);
    await worker.tick();
    expect(worker.idleSince).toBe(start + 10_000); // → `[⏳ downtime idle 0:00]`

    // slot-1 goes processing → display flips back to busy.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotOneProcessing));
    vi.setSystemTime(start + 20_000);
    await worker.tick();
    expect(worker.idleSince).toBeNull(); // → `[downtime busy]`

    // Free slots (3) ≥ N=2 and their timers (since +10s) exceed threshold.
    // Dispatch fires into the 3 free slots while display shows busy.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotOneProcessing));
    vi.setSystemTime(start + 20_000 + cfg.thresholdMs);
    const at = await worker.tick();
    expect(worker.idleSince).toBeNull(); // display stays busy (slot still processing)
    expect(at.dispatched).toBe(true); // dispatch fires (3 ≥ 2 free)
  });

  it('display: transition back to all-free after processing restarts the idle counter', async () => {
    // After a busy period, the display should start counting again once
    // all slots are free.
    const { worker, fetcher } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // perSlotTwoFree: slots 3,4 processing → busy
    expect(worker.idleSince).toBeNull();

    // All slots free → idle counter starts at current time.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + 10_000);
    await worker.tick();
    expect(worker.idleSince).toBe(start + 10_000);

    // slot-1 goes processing → display resets to busy.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotOneProcessing));
    vi.setSystemTime(start + 20_000);
    await worker.tick();
    expect(worker.idleSince).toBeNull();

    // All slots free again → display should now count from +20s.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + 30_000);
    await worker.tick();
    expect(worker.idleSince).toBe(start + 30_000); // fresh count from +30s
  });

  it('display: global busy (server down / model switch) also resets idleSince to busy', async () => {
    const { worker, fetcher } = makePerSlotWorker({
      requiredFreeSlots: 2,
      status: perSlotAllFree,
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince).toBe(start);

    // model_switch_in_progress is a GLOBAL gate — display shows busy.
    fetcher.mockResolvedValueOnce(
      jsonResponseFixture({ ...perSlotAllFree, model_switch_in_progress: true }),
    );
    vi.setSystemTime(start + 10_000);
    await worker.tick();
    expect(worker.idleSince).toBeNull(); // → `[downtime busy]`
  });
});

// ── Rotation-aware selection (WL-0MSSRED76008LGB6 / WL-0MSW6CKBY007RB7O) ──

describe('selectWithRotation (round-robin tie-break)', () => {
  const mk = (id: string, priority: string, sortIndex: number) => ({
    id, priority, sortIndex,
  });

  it('empty list → null', () => {
    expect(selectWithRotation([])).toBeNull();
  });

  it('single candidate → that candidate (no rotation)', () => {
    const c = mk('a', 'high', 1);
    expect(selectWithRotation([c])?.id).toBe('a');
  });

  it('no registry → first by sortIndex (fail-open pre-rotation behaviour)', () => {
    const items = [mk('a', 'high', 2), mk('b', 'high', 1)];
    expect(selectWithRotation(items)?.id).toBe('b'); // lowest sortIndex
  });

  it('candidates without priority → first by sortIndex (fail-open)', () => {
    const items = [{ id: 'x', sortIndex: 5 }, { id: 'y', sortIndex: 3 }];
    expect(selectWithRotation(items)?.id).toBe('y');
  });

  it('rotates through tied top-priority group, skipping lower priority', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-worker-rotation', rng: () => 0.5 });
    const items = [
      mk('low1', 'low', 10),
      mk('high1', 'high', 1),
      mk('high2', 'high', 2),
      mk('medium1', 'medium', 5),
    ];
    // Cursor starts at 0 → selects high1; advances to 1 → high2; then back to high1
    expect(selectWithRotation(items, registry)?.id).toBe('high1');
    expect(selectWithRotation(items, registry)?.id).toBe('high2');
    expect(selectWithRotation(items, registry)?.id).toBe('high1');
  });

  it('single-member top group → no rotation (higher priority still wins)', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-worker-single', rng: () => 0.5 });
    const items = [mk('crit1', 'critical', 1), mk('high1', 'high', 2), mk('high2', 'high', 3)];
    // critical group has 1 member → always crit1, regardless of cursor
    expect(selectWithRotation(items, registry)?.id).toBe('crit1');
    expect(selectWithRotation(items, registry)?.id).toBe('crit1');
  });

  it('priority-first preserved: lower-priority candidate never selected while higher tier has members', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-worker-priority', rng: () => 0.5 });
    const items = [
      mk('med1', 'medium', 10),
      mk('med2', 'medium', 11),
      mk('low1', 'low', 20),
    ];
    // Only medium group has members → rotation within medium only
    expect(selectWithRotation(items, registry)?.id).toBe('med1');
    expect(selectWithRotation(items, registry)?.id).toBe('med2');
    expect(selectWithRotation(items, registry)?.id).toBe('med1');
  });
});

describe('rotation-aware selection wired into tiers', () => {
  it('selectImplementCandidate rotates within tied priority when registry given', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-implement', rng: () => 0.5 });
    const candidates: ImplementCandidate[] = [
      { id: 'A', title: 'A', status: 'open', priority: 'high', sortIndex: 1, risk: 'low', effort: 'small' },
      { id: 'B', title: 'B', status: 'open', priority: 'high', sortIndex: 2, risk: 'low', effort: 'small' },
    ];
    expect(selectImplementCandidate(candidates, undefined, registry)?.id).toBe('A');
    expect(selectImplementCandidate(candidates, undefined, registry)?.id).toBe('B');
    expect(selectImplementCandidate(candidates, undefined, registry)?.id).toBe('A');
  });

  it('selectNextCandidate rotates within tied priority when registry given', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-next', rng: () => 0.5 });
    const candidates: DowntimeCandidate[] = [
      { id: 'X', title: 'X', stage: 'plan', status: 'open', priority: 'high', sortIndex: 1 },
      { id: 'Y', title: 'Y', stage: 'plan', status: 'open', priority: 'high', sortIndex: 2 },
    ];
    expect(selectNextCandidate(candidates, undefined, registry)?.id).toBe('X');
    expect(selectNextCandidate(candidates, undefined, registry)?.id).toBe('Y');
  });

  it('selectAuditCandidate rotates within tied priority when registry given', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-audit', rng: () => 0.5 });
    const now = Date.now();
    const candidates: AuditCandidate[] = [
      { id: 'P', title: 'P', priority: 'high', sortIndex: 1, updatedAt: new Date(now).toISOString() },
      { id: 'Q', title: 'Q', priority: 'high', sortIndex: 2, updatedAt: new Date(now).toISOString() },
    ];
    expect(selectAuditCandidate(candidates, now, undefined, registry)?.id).toBe('P');
    expect(selectAuditCandidate(candidates, now, undefined, registry)?.id).toBe('Q');
  });
});

// ── Probe jitter (WL-0MSSRED76008LGB6 / WL-0MSW6DEI9005XH8Q) ──────────

describe('worker probe jitter (jitterPollIntervalMs)', () => {
  it('returns jittered interval within ±50% when a registry is provided', () => {
    const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-jitter-deps', rng: () => 0.75 });
    const { worker } = (() => {
      const cfg = {
        enabled: true,
        thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: '/repo',
        noCandidateCooldownMs: 3_600_000,
      };
      const w = createDowntimeWorker({
        poller: createDowntimePoller('http://proxy:8000'),
        deps: makeDeps(),
        registry,
        config: () => ({ ...cfg }),
      });
      return { worker: w };
    })();
    // rng 0.75 → factor 1.25 → 10_000 * 1.25 = 12_500
    expect(worker.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS)).toBe(12_500);
  });

  it('returns the static interval when no registry is provided (fail-open)', () => {
    const { worker } = (() => {
      const cfg = {
        enabled: true,
        thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: '/repo',
        noCandidateCooldownMs: 3_600_000,
      };
      const w = createDowntimeWorker({
        poller: createDowntimePoller('http://proxy:8000'),
        deps: makeDeps(),
        config: () => ({ ...cfg }),
      });
      return { worker: w };
    })();
    expect(worker.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS)).toBe(10_000);
  });

  it('two workers with different RNG produce different jitter values', () => {
    const r1 = createRoundRobinRegistry({ worklogDir: '/tmp/rr-jitter-a', rng: () => 0.1 });
    const r2 = createRoundRobinRegistry({ worklogDir: '/tmp/rr-jitter-b', rng: () => 0.9 });
    const mk = (registry: typeof r1) => createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000'),
      deps: makeDeps(),
      registry,
      config: () => ({ enabled: true, thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, requiredFreeSlots: 0, model: 'plan', cwd: '/repo', noCandidateCooldownMs: 3_600_000 }),
    });
    const w1 = mk(r1);
    const w2 = mk(r2);
    // rng 0.1 → 0.6× = 6_000; rng 0.9 → 1.4× = 14_000
    expect(w1.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS)).toBe(6_000);
    expect(w2.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS)).toBe(14_000);
    expect(w1.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS)).not.toBe(w2.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS));
  });
});
