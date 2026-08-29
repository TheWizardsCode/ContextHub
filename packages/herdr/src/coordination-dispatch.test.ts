/**
 * Tests for the leader-election coordination dispatch (children
 * WL-0MSXHA1B0005G3E5 leader-only dispatch, WL-0MSXHA7LP000QNGP scheduler
 * refactoring, WL-0MSXHAKDT005H6VQ integration — parent
 * WL-0MST3OJ8S0001ROL).
 *
 * Covers:
 *  - classifyItemForDispatch: tier classification from a fetched item
 *  - dispatchFromCoordination: tier priority (audit → implement → plan →
 *    intake), highest-priority entry dispatch, entry removal, guards
 *  - runCoordinationCheckIn: most-important upsert / re-queue after
 *    dispatch / empty-backlog removal / fail-open on wl errors
 *  - Worker integration: leader polls + dispatches from coordination;
 *    non-leader skips proxy polling and dispatches nothing; stale-leader
 *    takeover; 30-min check-in cadence
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDowntimeWorker,
  createDowntimePoller,
  classifyItemForDispatch,
  dispatchFromCoordination,
  runCoordinationCheckIn,
  coordinationTierRank,
  DOWNTIME_AUDIT_RECENCY_WINDOW_MS,
  type DowntimeWorker,
  type DowntimeWorkerDeps,
  type DowntimeItemInfo,
  type ScheduledPrompt,
} from './downtime-worker.js';
import { createLeaderElectionManager, LEASE_FILE } from './leader-election.js';
import {
  writeCoordinationFile,
  readCoordinationFile,
  getEntry,
  COORDINATION_FILE,
  type CoordinationEntry,
  type CoordinationData,
} from './coordination.js';

// ── Fixtures ──────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'herdr-coord-worker-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

const coordPath = () => join(testDir, COORDINATION_FILE);

function makeEntry(instanceId: string, workItemId: string, directory?: string): CoordinationEntry {
  const now = new Date().toISOString();
  return {
    instanceId,
    workItemId,
    directory: directory ?? '/worklog/root',
    assignedAt: now,
    lastUpdated: now,
  };
}

function itemInfo(overrides: Partial<DowntimeItemInfo> & { id: string }): DowntimeItemInfo {
  return {
    id: overrides.id,
    title: overrides.title ?? `Item ${overrides.id}`,
    status: overrides.status ?? 'open',
    stage: overrides.stage ?? 'idea',
    priority: overrides.priority,
    risk: overrides.risk,
    effort: overrides.effort,
    auditedAt: overrides.auditedAt,
    updatedAt: overrides.updatedAt,
  };
}

/** Minimal deps mock for the coordination dispatch path. */
function makeCoordinationDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
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
    fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-X', stage: 'idea' }) }),
    ...overrides,
  } as DowntimeWorkerDeps;
}

// ── classifyItemForDispatch ───────────────────────────────────────────

describe('classifyItemForDispatch', () => {
  it('maps open idea → intake', () => {
    expect(classifyItemForDispatch(itemInfo({ id: 'WL-1', status: 'open', stage: 'idea' }))).toBe('intake');
  });
  it('maps open intake_complete → plan', () => {
    expect(classifyItemForDispatch(itemInfo({ id: 'WL-1', status: 'open', stage: 'intake_complete' }))).toBe('plan');
  });
  it('maps open plan_complete within caps → implement', () => {
    expect(classifyItemForDispatch(itemInfo({ id: 'WL-1', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }))).toBe('implement');
  });
  it('rejects plan_complete above the implement caps (effort Large)', () => {
    expect(classifyItemForDispatch(itemInfo({ id: 'WL-1', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'L' }))).toBeNull();
  });
  it('rejects plan_complete with unknown risk (fail-closed)', () => {
    expect(classifyItemForDispatch(itemInfo({ id: 'WL-1', status: 'open', stage: 'plan_complete' }))).toBeNull();
  });
  it('maps completed/in_review without a fresh audit → audit', () => {
    const now = Date.now();
    expect(classifyItemForDispatch(
      itemInfo({ id: 'WL-1', status: 'completed', stage: 'in_review', updatedAt: new Date(now - 60_000).toISOString() }),
      now,
    )).toBe('audit');
  });
  it('rejects completed/in_review WITH a fresh audit', () => {
    const now = Date.now();
    expect(classifyItemForDispatch(
      itemInfo({
        id: 'WL-1',
        status: 'completed',
        stage: 'in_review',
        updatedAt: new Date(now - 60_000).toISOString(),
        auditedAt: new Date(now - 30_000).toISOString(),
      }),
      now,
    )).toBeNull();
  });
  it('rejects completed items past the 7-day recency window', () => {
    const now = Date.now();
    expect(classifyItemForDispatch(
      itemInfo({ id: 'WL-1', status: 'completed', stage: 'in_review', updatedAt: new Date(now - DOWNTIME_AUDIT_RECENCY_WINDOW_MS - 60_000).toISOString() }),
      now,
    )).toBeNull();
  });
  it('rejects in_progress items (already claimed)', () => {
    expect(classifyItemForDispatch(itemInfo({ id: 'WL-1', status: 'in_progress', stage: 'in_progress' }))).toBeNull();
  });
  it('rejects unknown states (fail-closed)', () => {
    expect(classifyItemForDispatch(itemInfo({ id: 'WL-1', status: 'weird', stage: 'idea' }))).toBeNull();
    expect(classifyItemForDispatch({ id: 'WL-1' })).toBeNull(); // no status at all
  });
});

describe('coordinationTierRank', () => {
  it('orders audit > implement > plan > intake', () => {
    expect(coordinationTierRank('audit')).toBeLessThan(coordinationTierRank('implement'));
    expect(coordinationTierRank('implement')).toBeLessThan(coordinationTierRank('plan'));
    expect(coordinationTierRank('plan')).toBeLessThan(coordinationTierRank('intake'));
  });
  it('ranks null below every tier', () => {
    expect(coordinationTierRank(null)).toBeLessThan(coordinationTierRank('intake'));
  });
});

// ── dispatchFromCoordination ──────────────────────────────────────────

describe('dispatchFromCoordination', () => {
  it('dispatches the highest-priority tier first (implement over intake)', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-IMPL', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-INTAKE', status: 'open', stage: 'idea' }) }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entries = [makeEntry('inst-intake', 'WL-INTAKE'), makeEntry('inst-impl', 'WL-IMPL')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('/skill:implement WL-IMPL');
  });

  it('removes the dispatched entry from the coordination file (owner re-queues later)', async () => {
    const entry = makeEntry('inst-1', 'WL-IMPL', '/worklog/root');
    writeCoordinationFile(testDir, { version: 1, entries: [entry] });
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-IMPL', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) }),
    });
    const outcome = await dispatchFromCoordination(deps, [entry], { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(getEntry(testDir, 'inst-1')).toBe(null);
  });

  it('skips entries whose item is not currently dispatchable (stale/in_progress)', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-OLD', status: 'in_progress', stage: 'in_progress' }) }),
      spawnAgentPane: vi.fn(),
    });
    const outcome = await dispatchFromCoordination(deps, [makeEntry('inst-1', 'WL-OLD')], { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(false);
    expect((deps.spawnAgentPane as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(outcome.reason).toBe('no-candidate');
  });

  it('preserves the CAS claim: a lost claim moves to the next entry', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-A', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-B', status: 'open', stage: 'intake_complete' }) }),
      claimItem: vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'stale' }) // WL-A lost the race
        .mockResolvedValueOnce({ ok: true }), // WL-B wins
    });
    const entries = [makeEntry('inst-a', 'WL-A'), makeEntry('inst-b', 'WL-B')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('/skill:plan WL-B');
  });

  it('gates the audit tier by the code-freeze marker (frozen → plan still runs)', async () => {
    const deps = makeCoordinationDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-AUD', status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString() }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-PLAN', status: 'open', stage: 'intake_complete' }) }),
    });
    const entries = [makeEntry('inst-a', 'WL-AUD'), makeEntry('inst-b', 'WL-PLAN')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('requires the audit tier to have ≥ 2 free slots (spare-capacity guard)', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-AUD', status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString() }) }),
      spawnAgentPane: vi.fn(),
    });
    const entries = [makeEntry('inst-a', 'WL-AUD')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir, freeSlots: 1 });
    expect(outcome.dispatched).toBe(false);
    expect((deps.spawnAgentPane as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('fails closed to wl-error when every entry fetch fails', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: false }),
    });
    const entries = [makeEntry('inst-a', 'WL-A'), makeEntry('inst-b', 'WL-B')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.reason).toBe('wl-error');
  });

  it('tolerates a per-entry fetch failure (fail-open for one broken worklog)', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: false }) // broken instance
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-OK', status: 'open', stage: 'idea' }) }),
    });
    const entries = [makeEntry('inst-bad', 'WL-BAD'), makeEntry('inst-ok', 'WL-OK')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('intake');
  });

  // ── Scheduled-prompts tier (WL-0MSS1Q5ER007QDKX) ────────────────────
  // The coordination (leader) path must check due scheduled prompts FIRST,
  // before ANY coordination-tier work — a due prompt dispatches instead of
  // reaching the backlog tiers (AC3/AC6), gated by the same code-freeze
  // marker as the audit/implement tiers (AC5).

  it('dispatches a due scheduled prompt FIRST in the coordination path', async () => {
    const duePrompt: ScheduledPrompt = { id: '/skill:refactor', prompt: '/skill:refactor', intervalDays: 3, lastTriggeredAt: null };
    const deps = makeCoordinationDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      // The coordination tiers must never be reached — the prompt dispatches
      // instead (AC3 first-stage + AC6 no-cooldown).
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-IMPL', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) }),
    });
    const entries = [makeEntry('inst-impl', 'WL-IMPL')];

    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    expect(deps.getDueScheduledPrompt).toHaveBeenCalledWith('/repo');
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('scheduled');
    // The prompt text is the dispatch payload — no work item wrap, pane
    // named `Downtime <id>` (AC3 spawn path).
    expect(deps.spawnAgentPane).toHaveBeenCalledWith('/skill:refactor', {
      model: 'plan',
      cwd: '/repo',
      paneName: 'Downtime /skill:refactor',
    });
    // No pre-dispatch claim and NO coordination-tier work (AC3/AC4/AC6).
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.fetchItem).not.toHaveBeenCalled();
  });

  it('persists lastTriggeredAt and writes the scheduled log marker before the spawn (AC4)', async () => {
    const duePrompt: ScheduledPrompt = { id: '/skill:refactor', prompt: '/skill:refactor', intervalDays: 3, lastTriggeredAt: null };
    const deps = makeCoordinationDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
    });

    const outcome = await dispatchFromCoordination(deps, [], { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('scheduled');
    // The trigger timestamp is persisted (atomic config update) and the
    // rolling log marker is written with kind scheduled + noItemComment.
    expect(deps.recordScheduledPromptTrigger).toHaveBeenCalledWith(
      '/repo',
      '/skill:refactor',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: '/skill:refactor', kind: 'scheduled', cwd: '/repo', noItemComment: true }),
    );
    // Marker + persist before spawn: the dispatch is recorded before the
    // pane opens (fail-closed: an unrecorded dispatch never runs).
    const persistOrder = (deps.recordScheduledPromptTrigger as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const markerOrder = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const spawnOrder = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(persistOrder).toBeLessThan(markerOrder);
    expect(markerOrder).toBeLessThan(spawnOrder);
  });

  it('aborts the coordination-path spawn when the marker write fails (fail-closed, AC4)', async () => {
    const duePrompt: ScheduledPrompt = { id: '/skill:refactor', prompt: '/skill:refactor', intervalDays: 3, lastTriggeredAt: null };
    const deps = makeCoordinationDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      recordScheduledPromptTrigger: vi.fn().mockResolvedValue(false),
      spawnAgentPane: vi.fn(),
    });

    const outcome = await dispatchFromCoordination(deps, [], { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    // Fail-closed: an unrecorded dispatch never runs — the prompt stays due
    // for the next idle slot and the backlog tiers are NOT reached either.
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('marker-write-failed');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('gates the coordination-path scheduled tier by the code-freeze marker (frozen → tiers still run)', async () => {
    const duePrompt: ScheduledPrompt = { id: '/skill:refactor', prompt: '/skill:refactor', intervalDays: 3, lastTriggeredAt: null };
    const deps = makeCoordinationDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-PLAN', status: 'open', stage: 'intake_complete' }) }),
    });
    const entries = [makeEntry('inst-plan', 'WL-PLAN')];

    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    // Scheduled prompts are held during a freeze (AC5); the audit/implement
    // coordination tiers are skipped but plan/intake still run unchanged.
    expect(deps.getDueScheduledPrompt).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('falls through to the coordination tiers when no prompt is due (AC6)', async () => {
    const deps = makeCoordinationDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-IMPL', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) }),
    });
    const entries = [makeEntry('inst-impl', 'WL-IMPL')];

    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    expect(deps.getDueScheduledPrompt).toHaveBeenCalledWith('/repo');
    // No prompt due → the existing tier pipeline runs unchanged.
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('/skill:implement WL-IMPL');
  });
});

// ── runCoordinationCheckIn ────────────────────────────────────────────

describe('runCoordinationCheckIn', () => {
  it('upserts the instance most-important item on first check-in', async () => {
    const deps = makeCoordinationDeps({
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-IMP', title: 'Most important', stage: 'idea', status: 'open' },
      }),
    });
    const result = await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    expect(result.offered).toBe('WL-IMP');
    const entry = getEntry(testDir, 'inst-1');
    expect(entry?.workItemId).toBe('WL-IMP');
    expect(entry?.directory).toBe('/repo');
  });

  it('updates the entry when the most-important item changes', async () => {
    const deps = makeCoordinationDeps({
      getNextImplementCandidate: vi.fn()
        .mockResolvedValueOnce({ id: 'WL-A', title: 'A', stage: 'implement', status: 'open' })
        .mockResolvedValueOnce({ id: 'WL-B', title: 'B', stage: 'implement', status: 'open' }),
    });
    await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    expect(getEntry(testDir, 'inst-1')?.workItemId).toBe('WL-B');
  });

  it('removes the own entry on a genuine empty backlog', async () => {
    // First offer something, then the backlog empties.
    const deps = makeCoordinationDeps({
      getNextImplementCandidate: vi.fn()
        .mockResolvedValueOnce({ id: 'WL-A', title: 'A', stage: 'implement', status: 'open' })
        .mockResolvedValueOnce(null),
    });
    await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    expect(getEntry(testDir, 'inst-1')).not.toBe(null);
    await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    expect(getEntry(testDir, 'inst-1')).toBe(null);
  });

  it('keeps the existing entry when the computation hits a wl error (fail-open)', async () => {
    const deps = makeCoordinationDeps({
      getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: false }),
      getNextItem: vi.fn().mockResolvedValue({ ok: false }),
    });
    writeCoordinationFile(testDir, { version: 1, entries: [makeEntry('inst-1', 'WL-EXISTING', '/repo')] });
    const result = await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    expect(result.updated).toBe(false);
    expect(getEntry(testDir, 'inst-1')?.workItemId).toBe('WL-EXISTING');
  });
});

// ── Worker integration: leader vs non-leader (AC4) ────────────────────

function makeStatusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    llama_server_running: true,
    active_query: false,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 4,
    total_slots: 4,
    ...overrides,
  };
}

/** A poller stub whose fetcher returns the given payloads in order (last repeats). */
function makeFetcher(payloads: Array<Record<string, unknown> | null>): ReturnType<typeof vi.fn> {
  let idx = 0;
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payloads[Math.min(idx++, payloads.length - 1)] ?? null,
  }));
}

/** Build a real worker wired to the coordination dir + a stub poller. */
function makeCoordWorker(opts: {
  coordinationDir: string;
  instanceId: string;
  depsOverrides?: Partial<DowntimeWorkerDeps>;
  pollPayloads?: Array<Record<string, unknown> | null>;
  thresholdMs?: number;
}): { worker: DowntimeWorker; deps: DowntimeWorkerDeps } {
  const deps = makeCoordinationDeps(opts.depsOverrides);
  const fetcher = makeFetcher(opts.pollPayloads ?? [makeStatusPayload()]);
  const worker = createDowntimeWorker({
    coordinationDir: opts.coordinationDir,
    instanceId: opts.instanceId,
    poller: createDowntimePoller('http://localhost:8000', fetcher as never, 5000),
    deps,
    config: () => ({
      enabled: true,
      thresholdMs: opts.thresholdMs ?? 60_000,
      requiredFreeSlots: 1,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
    }),
    leaseTtlSeconds: 300,
    checkInIntervalMs: 30 * 60 * 1000,
  });
  return { worker, deps };
}

describe('downtime worker leader/non-leader orchestration (coordination mode)', () => {
  it('the first instance wins the election and becomes the leader', async () => {
    const a = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-a' });
    const b = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-b' });
    // A ticks first → wins the file lock.
    await a.worker.tick();
    expect(a.worker.isLeader).toBe(true);
    // B ticks → sees the lease held by A → non-leader, no polling, no dispatch.
    await b.worker.tick();
    expect(b.worker.isLeader).toBe(false);
    // The lease file records A as the leader.
    const lease = JSON.parse(readFileSync(join(testDir, LEASE_FILE), 'utf-8')) as { leaderId: string };
    expect(lease.leaderId).toBe('inst-a');
  });

  it('only the leader polls the proxy and dispatches (AC4)', async () => {
    const entries = [makeEntry('inst-a', 'WL-IMPL', '/repo')];
    writeCoordinationFile(testDir, { version: 1, entries });
    // A's own most-important item IS WL-IMPL (a plan_complete critical), so
    // its startup check-in re-offers the same entry instead of clearing it.
    const a = makeCoordWorker({
      coordinationDir: testDir,
      instanceId: 'inst-a',
      depsOverrides: {
        getNextCriticalCandidate: vi.fn().mockResolvedValue({
          ok: true,
          candidate: { id: 'WL-IMPL', title: 'Impl me', stage: 'plan_complete', status: 'open' },
        }),
        fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-IMPL', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) }),
      },
    });
    const b = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-b' });
    // A leader, B non-leader. All ticks under fake timers so the idle tracker
    // and lease timestamps stay consistent.
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    try {
      await a.worker.tick();
      await b.worker.tick();
      expect(a.worker.isLeader).toBe(true);
      expect(b.worker.isLeader).toBe(false);

      // Leader A polls and (after the idle threshold) dispatches from the
      // coordination file; non-leader B never polls.
      await a.worker.tick(); // starts idle run (second poll — still idle)
      vi.setSystemTime(10_000_000 + 60_001);
      await a.worker.tick(); // threshold met → dispatch
      expect(a.deps.spawnAgentPane).toHaveBeenCalled();
      // The dispatched entry was REMOVED from the coordination file.
      expect(getEntry(testDir, 'inst-a')).toBe(null);
      // B never dispatched.
      expect(b.deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale leader lease triggers takeover by another instance (AC2)', async () => {
    // Pre-seed a STALE lease for a dead leader (expired > 5 min ago).
    const deadLeader = createLeaderElectionManager({ worklogDir: testDir, instanceId: 'dead-leader', leaseTtlSeconds: 300 });
    expect(deadLeader.attemptElection()).toBe(true);
    deadLeader.releaseLeadership(); // drop the lock; keep only the lease
    const leasePath = join(testDir, LEASE_FILE);
    const stale = {
      leaderId: 'dead-leader',
      acquiredAt: new Date(Date.now() - 400_000).toISOString(),
      ttlSeconds: 300,
    };
    writeFileSync(leasePath, JSON.stringify(stale), 'utf-8');

    const a = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-a' });
    await a.worker.tick();
    expect(a.worker.isLeader).toBe(true);
  });

  it('non-leader instances perform the first check-in but never dispatch', async () => {
    const deps = makeCoordinationDeps({
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-MOST', title: 'Most important', stage: 'intake_complete', status: 'open' },
      }),
    });
    const a = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-a', depsOverrides: deps });
    const b = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-b', depsOverrides: deps });
    await a.worker.tick(); // a is leader
    await b.worker.tick(); // b non-leader
    // The non-leader's first check-in offers its most-important item.
    const entry = getEntry(testDir, 'inst-b');
    expect(entry?.workItemId).toBe('WL-MOST');
    // The non-leader does NOT dispatch.
    expect(b.deps.spawnAgentPane).not.toHaveBeenCalled();
  });
});