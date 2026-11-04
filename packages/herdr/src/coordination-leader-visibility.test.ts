/**
 * Worker-integration coverage for leader visibility in the shared coordination
 * file (WL-0MW1VINII003IL7R).
 *
 * Reproduces the 2026-11-04 incident shape end to end: a leader whose own
 * window is EMPTY (so its offer entry is removed — "no dead offers") and whose
 * proxy poll refuses on capacity. Before the fix the coordination file named no
 * dispatcher at all and the refusal was invisible outside the leader's per-root
 * log; now the file names the leader and its last decision token.
 *
 * These tests drive the REAL worker tick (`createDowntimeWorker`), not the
 * coordination helpers, so the write wiring (election + check-in) is proven.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDowntimeWorker,
  createDowntimePoller,
  type DowntimeWorker,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import {
  readCoordinationFile,
  getLeader,
  upsertEntry,
  type CoordinationEntry,
} from './coordination.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'herdr-leader-vis-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.useRealTimers();
});

/** A proxy payload whose per-slot detail is unusable → `slots-unavailable`. */
function staleSlotPayload(): Record<string, unknown> {
  return {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 2,
    total_slots: 2,
    // Fail-closed contract (WL-0MUXVPXAZ005RESW): stale detail is unusable.
    slots_stale: true,
    slots: [
      { slot_id: 0, is_processing: true },
      { slot_id: 1, is_processing: true },
    ],
  };
}

function makeDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Empty Herdr window: this is the incident's triggering condition.
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
    getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
    recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
    readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
    fetchItem: vi.fn().mockResolvedValue({ ok: true, info: { id: 'WL-X', stage: 'idea', status: 'open' } }),
    getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
    getReviewQueueCount: vi.fn().mockResolvedValue(0),
    getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
    ...overrides,
  } as unknown as DowntimeWorkerDeps;
}

function makeWorker(opts: {
  instanceId: string;
  cwd?: string;
  payloads?: Array<Record<string, unknown>>;
  depsOverrides?: Partial<DowntimeWorkerDeps>;
}): DowntimeWorker {
  let idx = 0;
  const payloads = opts.payloads ?? [staleSlotPayload()];
  const fetcher = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payloads[Math.min(idx++, payloads.length - 1)],
  }));
  return createDowntimeWorker({
    coordinationDir: testDir,
    instanceId: opts.instanceId,
    poller: createDowntimePoller('http://localhost:8000', fetcher as never, 5000),
    deps: makeDeps(opts.depsOverrides),
    config: () => ({
      enabled: true,
      thresholdMs: 0,
      requiredFreeSlots: 1,
      model: 'plan',
      cwd: opts.cwd ?? '/repo/leader',
      noCandidateCooldownMs: 3_600_000,
    }),
    leaseTtlSeconds: 300,
    checkInIntervalMs: 30 * 60 * 1000,
    leaderCheckInIntervalMs: 4 * 60 * 1000,
  });
}

function entry(instanceId: string, workItemId: string, root = '/repo/other'): CoordinationEntry {
  const now = new Date().toISOString();
  return { instanceId, workItemId, directory: root, worklogRoot: root, assignedAt: now, lastUpdated: now };
}

describe('leader visibility in the coordination file (WL-0MW1VINII003IL7R)', () => {
  it('names the leader on election, before any decision is recorded', async () => {
    const leader = makeWorker({ instanceId: 'leader-1' });
    await leader.tick();

    expect(leader.isLeader).toBe(true);
    const block = getLeader(testDir);
    expect(block).not.toBeNull();
    expect(block!.instanceId).toBe('leader-1');
    expect(block!.worklogRoot).toBe('/repo/leader');
  });

  it('records the refusal token alongside the leader (the 2026-11-04 shape)', async () => {
    const leader = makeWorker({ instanceId: 'leader-1' });
    // Empty window + stale slot detail: nothing is dispatchable and the reason
    // is capacity, not backlog. This is exactly what went undiagnosed.
    await leader.tick();
    await leader.tick();

    const data = readCoordinationFile(testDir)!;
    // No offer exists (the leader's window was empty) ...
    expect(data.entries).toEqual([]);
    // ... yet the dispatcher IS named, with its standing refusal.
    expect(data.leader).toBeDefined();
    expect(data.leader!.instanceId).toBe('leader-1');
    expect(data.leader!.lastDecisionReason).toBe('slots-unavailable');
    expect(data.leader!.lastDecisionAt).not.toBeNull();
    // The header token is what an operator sees in the worklist; the block
    // carries the underlying decision reason so both agree.
    expect(leader.blockReason).toBe('no-slots');
  });

  it('keeps a peer offer and the leader block independent', async () => {
    upsertEntry(testDir, entry('worker-2', 'WL-PEER'));
    const leader = makeWorker({ instanceId: 'leader-1' });
    await leader.tick();

    const data = readCoordinationFile(testDir)!;
    expect(data.leader!.instanceId).toBe('leader-1');
    // The peer's offer is untouched; the leader added no offer of its own.
    expect(data.entries.map((e) => e.instanceId)).toEqual(['worker-2']);
  });

  it('a non-leader records no leader block', async () => {
    const a = makeWorker({ instanceId: 'inst-a' });
    const b = makeWorker({ instanceId: 'inst-b' });
    await a.tick();
    await b.tick();

    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);
    // The block still names the winner — a follower must never claim it.
    expect(getLeader(testDir)!.instanceId).toBe('inst-a');
  });

  it('refreshes the heartbeat on the leader check-in cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T00:16:00.000Z'));
    const leader = makeWorker({ instanceId: 'leader-1' });
    await leader.tick();
    const first = getLeader(testDir)!;
    expect(first.lastUpdated).toBe('2026-11-04T00:16:00.000Z');

    // Leader cadence is 4 min (< the 10-min stale window): one tick later the
    // block is refreshed, not merely tolerated.
    vi.setSystemTime(new Date('2026-11-04T00:20:30.000Z'));
    await leader.tick();
    const second = getLeader(testDir)!;
    expect(second.lastUpdated).toBe('2026-11-04T00:20:30.000Z');
  });

  it('a block left by a dead leader is not reported as live', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T00:16:00.000Z'));
    const leader = makeWorker({ instanceId: 'leader-1' });
    await leader.tick();
    expect(getLeader(testDir)).not.toBeNull();

    // The leader process dies; eight hours later it must not read as live.
    const later = Date.parse('2026-11-04T08:16:00.000Z');
    expect(getLeader(testDir, { nowMs: later })).toBeNull();
  });
});
