/**
 * Full integration tests for the leader-election → coordination → dispatch
 * flow (child WL-0MSXHAKDT005H6VQ, parent WL-0MST3OJ8S0001ROL).
 *
 * End-to-end scenario coverage:
 *  - Multiple instances, leader election, lease expiry, re-election
 *  - Coordination file updates, entry pruning, re-queueing after dispatch
 *  - Full dispatch flow: leader polls → idle detected → dispatch →
 *    remove entry → owner re-queues at its next check-in
 *  - Regression: the pre-dispatch CAS claim prevents double-dispatch
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDowntimeWorker,
  createDowntimePoller,
  type DowntimeWorker,
  type DowntimeWorkerDeps,
  type DowntimeItemInfo,
} from './downtime-worker.js';
import { createLeaderElectionManager, LEASE_FILE } from './leader-election.js';
import {
  writeCoordinationFile,
  getEntry,
  readCoordinationFile,
  COORDINATION_FILE,
  type CoordinationEntry,
} from './coordination.js';

// ── Fixtures ──────────────────────────────────────────────────────────

let dirA: string;
let dirB: string;
let sharedCoord: string;

beforeEach(() => {
  // Two worklog roots + ONE shared coordination dir (single-machine v1:
  // the coordination file lives in the FIRST instance's .worklog). Each
  // instance operates on its own worklog directory.
  dirA = mkdtempSync(join(tmpdir(), 'herdr-it-a-'));
  dirB = mkdtempSync(join(tmpdir(), 'herdr-it-b-'));
  sharedCoord = join(dirA, '.worklog');
});

afterEach(() => {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

function itemInfo(id: string, stage: string, extra: Partial<DowntimeItemInfo> = {}): DowntimeItemInfo {
  return {
    id,
    title: `Item ${id}`,
    status: 'open',
    stage,
    risk: extra.risk,
    effort: extra.effort,
    updatedAt: extra.updatedAt,
    auditedAt: extra.auditedAt,
  };
}

function makeEntry(instanceId: string, workItemId: string, directory: string): CoordinationEntry {
  const now = new Date().toISOString();
  return { instanceId, workItemId, directory, assignedAt: now, lastUpdated: now };
}

function idlePayload(): Record<string, unknown> {
  return {
    llama_server_running: true,
    active_query: false,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 4,
    total_slots: 4,
  };
}

/** Base deps with tier lookups sequenced via overrides. */
function baseDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
    getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
    recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
    readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
    fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo('WL-X', 'idea') }),
    ...overrides,
  } as DowntimeWorkerDeps;
}

function makeWorker(opts: {
  coordinationDir: string;
  instanceId: string;
  cwd: string;
  deps: DowntimeWorkerDeps;
}): DowntimeWorker {
  const fetcher = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => idlePayload(),
  }));
  return createDowntimeWorker({
    coordinationDir: opts.coordinationDir,
    instanceId: opts.instanceId,
    poller: createDowntimePoller('http://localhost:8000', fetcher as never, 5000),
    deps: opts.deps,
    config: () => ({
      enabled: true,
      thresholdMs: 60_000,
      requiredFreeSlots: 1,
      model: 'plan',
      cwd: opts.cwd,
      noCandidateCooldownMs: 3_600_000,
    }),
    leaseTtlSeconds: 300,
    checkInIntervalMs: 30 * 60 * 1000,
  });
}

// ── Integration scenarios ─────────────────────────────────────────────

describe('integration: leader election → coordination → dispatch', () => {
  it('full flow: two instances, one leader, dispatch removes the entry, owner re-queues (AC1/AC2/AC3)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000_000);
    try {
      // Instance A is the leader; instance B offers its item.
      // Sequence B's most-important item: first WL-B1, then (after its item
      // is dispatched) the NEXT item WL-B2 at the following check-in.
      const depsB = baseDeps({
        getNextCriticalCandidate: vi.fn()
          .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-B1', title: 'B one', stage: 'intake_complete', status: 'open' } })
          .mockResolvedValue({ ok: true, candidate: { id: 'WL-B2', title: 'B two', stage: 'plan_complete', status: 'open' } }),
      });
      const depsA = baseDeps({
        getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
        // The leader classifies the coordination entries by re-fetching them.
        fetchItem: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'WL-B1') return { ok: true, info: itemInfo('WL-B1', 'intake_complete') };
          if (id === 'WL-B2') return { ok: true, info: itemInfo('WL-B2', 'plan_complete', { risk: 'Low', effort: 'S' }) };
          return { ok: false };
        }),
      });
      const workerB = makeWorker({ coordinationDir: sharedCoord, instanceId: 'inst-b', cwd: dirB, deps: depsB });
      const workerA = makeWorker({ coordinationDir: sharedCoord, instanceId: 'inst-a', cwd: dirA, deps: depsA });

      // Tick 1: A wins the election and both instances check in.
      await workerA.tick();
      await workerB.tick();
      expect(workerA.isLeader).toBe(true);
      expect(workerB.isLeader).toBe(false);
      // B offered its most-important item WL-B1 in the shared file.
      expect(getEntry(sharedCoord, 'inst-b')?.workItemId).toBe('WL-B1');

      // A becomes idle across the threshold; the leader dispatches B's item.
      await workerA.tick(); // second poll — idle run continues
      vi.setSystemTime(20_000_000 + 60_001);
      const at = await workerA.tick(); // threshold met → dispatch
      expect(at.dispatched).toBe(true);
      // The dispatched entry was REMOVED from the coordination file.
      expect(getEntry(sharedCoord, 'inst-b')).toBe(null);
      // The dispatch targeted B's worklog directory (multi-worklog support).
      const spawnArgs = (depsA.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(String(spawnArgs[0])).toContain('/skill:plan WL-B1');
      expect(spawnArgs[1].cwd).toBe(dirB);

      // B's next 30-min check-in: its old item was dispatched — it re-queues
      // its NEXT most-important item (AC8 re-queue).
      vi.setSystemTime(20_000_000 + 31 * 60_000);
      await workerB.tick();
      expect(getEntry(sharedCoord, 'inst-b')?.workItemId).toBe('WL-B2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lease expiry + re-election: a dead leader is replaced and dispatch resumes (AC2)', async () => {
    // Pre-seed a stale lease for a dead leader.
    const dead = createLeaderElectionManager({ worklogDir: sharedCoord, instanceId: 'dead', leaseTtlSeconds: 300 });
    expect(dead.attemptElection()).toBe(true);
    dead.releaseLeadership();
    const stale = { leaderId: 'dead', acquiredAt: new Date(Date.now() - 400_000).toISOString(), ttlSeconds: 300 };
    writeFileSync(join(sharedCoord, LEASE_FILE), JSON.stringify(stale), 'utf-8');

    const deps = baseDeps({
      getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });
    const worker = makeWorker({ coordinationDir: sharedCoord, instanceId: 'inst-new', cwd: dirA, deps });
    await worker.tick();
    expect(worker.isLeader).toBe(true);
    // The lease now names the new leader.
    const lease = JSON.parse(readFileSync(join(sharedCoord, LEASE_FILE), 'utf-8')) as { leaderId: string };
    expect(lease.leaderId).toBe('inst-new');
  });

  it('rejects double dispatch through the CAS claim: a claimed item is never re-spawned (AC5 regression)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000_000);
    try {
      const entry = makeEntry('inst-b', 'WL-B1', dirB);
      writeCoordinationFile(sharedCoord, { version: 1, entries: [entry] });
      const depsA = baseDeps({
        // Instance B's item is ALREADY claimed by another pane (in_progress).
        fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo('WL-B1', 'in_progress') }),
        spawnAgentPane: vi.fn(),
      });
      const workerA = makeWorker({ coordinationDir: sharedCoord, instanceId: 'inst-a', cwd: dirA, deps: depsA });
      await workerA.tick(); // elect A
      await workerA.tick(); // idle run
      vi.setSystemTime(30_000_000 + 60_001);
      const at = await workerA.tick();
      // An already-in-progress item is classified as not dispatchable —
      // never re-dispatched (no pane, no marker).
      expect(at.dispatched).toBe(false);
      expect(depsA.spawnAgentPane).not.toHaveBeenCalled();
      expect(getEntry(sharedCoord, 'inst-b')).not.toBe(null); // entry intact
    } finally {
      vi.useRealTimers();
    }
  });

  it('stale coordination entries are pruned by the leader dispatch cycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000_000);
    try {
      const stale = makeEntry('inst-dead', 'WL-DEAD', dirB);
      const staleEntry = { ...stale, lastUpdated: new Date(40_000_000 - 400_000).toISOString() };
      writeCoordinationFile(sharedCoord, { version: 1, entries: [staleEntry] });

      const depsA = baseDeps({
        getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
        fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo('WL-DEAD', 'idea') }),
        spawnAgentPane: vi.fn(),
      });
      const workerA = makeWorker({ coordinationDir: sharedCoord, instanceId: 'inst-a', cwd: dirA, deps: depsA });
      await workerA.tick(); // elect A
      await workerA.tick(); // idle
      vi.setSystemTime(40_000_000 + 60_001);
      await workerA.tick(); // dispatch cycle — prunes the stale entry
      // The stale (crashed-instance) entry was pruned during the cycle and
      // never dispatched (its owner is gone; lastUpdated > lease TTL).
      expect(getEntry(sharedCoord, 'inst-dead')).toBe(null);
      expect(depsA.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});