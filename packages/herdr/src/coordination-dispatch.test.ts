/**
 * Tests for the leader-election coordination dispatch (children
 * WL-0MSXHA1B0005G3E5 leader-only dispatch, WL-0MSXHA7LP000QNGP scheduler
 * refactoring, WL-0MSXHAKDT005H6VQ integration — parent
 * WL-0MST3OJ8S0001ROL).
 *
 * Covers:
 *  - classifyItemForDispatch: tier classification from a fetched item
 *  - dispatchFromCoordination: OFFER-list dispatch in file order (each
 *    entry offers its instance's own Herdr list head — WL-0MTK1ILM2009QYB2
 *    "dispatcher == Herdr list head"; no re-ranking), eligibility
 *    re-check at dispatch time, entry removal, guards
 *  - runCoordinationCheckIn: most-important (Herdr head) upsert / re-queue
 *    after dispatch / empty-backlog removal / fail-open on wl errors
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
  computeMostImportantItem,
  coordinationTierRank,
  DOWNTIME_AUDIT_RECENCY_WINDOW_MS,
  type DowntimeWorker,
  type DowntimeWorkerDeps,
  type DowntimeItemInfo,
  type DowntimeHerdrItem,
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
    sortIndex: overrides.sortIndex,
    needsProducerReview: overrides.needsProducerReview,
  };
}

/** Minimal deps mock for the coordination dispatch path. */
function makeCoordinationDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Herdr list head (WL-0MTK1ILM2009QYB2): the canonical ranking the
    // check-in / probe consume. Default: genuinely empty backlog.
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
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

/** Build a Herdr selection-list head item (fetcher → smart-selection shape). */
function headItem(overrides: Partial<DowntimeHerdrItem> & { id: string }): DowntimeHerdrItem {
  return {
    id: overrides.id,
    title: overrides.title ?? `Head ${overrides.id}`,
    status: overrides.status ?? 'open',
    stage: overrides.stage ?? 'idea',
    priority: overrides.priority,
    risk: overrides.risk,
    effort: overrides.effort,
    auditedAt: overrides.auditedAt,
    updatedAt: overrides.updatedAt,
    sortIndex: overrides.sortIndex,
    needsProducerReview: overrides.needsProducerReview,
  };
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
  it('dispatches the first eligible OFFER in file order (no re-ranking — WL-0MTK1ILM2009QYB2)', async () => {
    // Two offers of DIFFERENT dispatch kinds: intake (idea) first in the
    // file, implement (plan_complete) second. The leader does NOT re-rank
    // by tier priority — file order wins: the intake offer dispatches.
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-INTAKE', status: 'open', stage: 'idea' }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-IMPL', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entries = [makeEntry('inst-intake', 'WL-INTAKE'), makeEntry('inst-impl', 'WL-IMPL')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('intake');
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('/skill:intake WL-INTAKE');
    // Only ONE offer dispatched per cycle; the second remains queued for
    // the owner's next check-in cycle.
    expect((deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
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

  // No cross-entry re-ranking (WL-0MTK1ILM2009QYB2): the leader dispatches
  // OFFERS in FILE ORDER. Each offer is its root's Herdr list head (the
  // check-in offers the first item of the owner's own Herdr selection
  // list, where smart-selection already places critical items first), so
  // the leader never re-prioritizes a later critical offer over an
  // earlier eligible one (the global critical override + sortIndex
  // tie-break + round-robin cursor are retired).

  it('dispatches the first eligible offer even when a later offer is critical (file order)', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-AUDIT', status: 'open', stage: 'idea', priority: 'high' }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-CRIT', status: 'open', stage: 'idea', priority: 'critical' }) }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entries = [makeEntry('inst-audit', 'WL-AUDIT'), makeEntry('inst-crit', 'WL-CRIT')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('intake');
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('/skill:intake WL-AUDIT');
  });

  it('dispatches a critical offer with its stage-appropriate skill when it is first in the file', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-CRIT', status: 'open', stage: 'idea', priority: 'critical' }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-PLAN', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S', priority: 'high' }) }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entries = [makeEntry('inst-crit', 'WL-CRIT'), makeEntry('inst-plan', 'WL-PLAN')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('intake');
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('/skill:intake WL-CRIT');
  });

  it('dispatches a critical implement offer before a later audit offer when first in the file', async () => {
    const deps = makeCoordinationDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-CRIT', status: 'open', stage: 'plan_complete', risk: 'Medium', effort: 'S', priority: 'critical' }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-AUDIT', status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString(), priority: 'high' }) }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entries = [makeEntry('inst-crit', 'WL-CRIT'), makeEntry('inst-audit', 'WL-AUDIT')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('/skill:implement WL-CRIT');
  });

  it('respects code-freeze: critical implement offer is dropped when frozen (plan offer still runs)', async () => {
    const deps = makeCoordinationDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-CRIT', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S', priority: 'critical' }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-PLAN', status: 'open', stage: 'intake_complete', priority: 'high' }) }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entries = [makeEntry('inst-crit', 'WL-CRIT'), makeEntry('inst-plan', 'WL-PLAN')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    // The frozen critical implement offer was dropped (stale for the
    // dispatch window) so the owner re-offers its next head.
    expect(getEntry(testDir, 'inst-crit')).toBe(null);
  });

  it('respects caps: above-caps critical plan_complete offer is dropped (plan offer still runs)', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-CRIT', status: 'open', stage: 'plan_complete', risk: 'High', effort: 'L', priority: 'critical' }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-PLAN', status: 'open', stage: 'intake_complete', priority: 'high' }) }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entries = [makeEntry('inst-crit', 'WL-CRIT'), makeEntry('inst-plan', 'WL-PLAN')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('a lost CAS claim on the first offer moves to the next offer', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-CRIT', status: 'open', stage: 'idea', priority: 'critical' }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-PLAN', status: 'open', stage: 'intake_complete', priority: 'high' }) }),
      claimItem: vi.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'stale' })
        .mockResolvedValueOnce({ ok: true }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entries = [makeEntry('inst-crit', 'WL-CRIT'), makeEntry('inst-plan', 'WL-PLAN')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('dispatches the first critical offer in file order (no sortIndex re-ranking)', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-CRIT-A', status: 'open', stage: 'idea', priority: 'critical', sortIndex: 200 }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-CRIT-B', status: 'open', stage: 'intake_complete', priority: 'critical', sortIndex: 100 }) }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entries = [makeEntry('inst-a', 'WL-CRIT-A'), makeEntry('inst-b', 'WL-CRIT-B')];
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    // File order wins over the sortIndex tie-break: WL-CRIT-A (first) with
    // its stage-appropriate skill (idea → intake).
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('intake');
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('/skill:intake WL-CRIT-A');
  });

  // WL-0MTJDSCSX007NNSE: offer-list dispatch across cycles. Round-robin
  // alternation (downtime-round-robin-by-root) is retired by
  // WL-0MTK1ILM2009QYB2 — consumed entries are REMOVED, so the next cycle
  // serves the next offer in file order; the owner re-offers its new Herdr
  // head at its next check-in.
  it('serves offers in file order across dispatch cycles (consumed entries removed)', async () => {
    const entryA = makeEntry('inst-a', 'WL-PLAN-A', '/roots/contexthub');
    const entryB = makeEntry('inst-b', 'WL-PLAN-B', '/roots/sorraagents');
    writeCoordinationFile(testDir, { version: 1, entries: [entryA, entryB] });
    const planA = itemInfo({ id: 'WL-PLAN-A', status: 'open', stage: 'intake_complete', priority: 'high' });
    const planB = itemInfo({ id: 'WL-PLAN-B', status: 'open', stage: 'intake_complete', priority: 'high' });

    // Cycle 1: the first file entry (A) dispatches and is removed.
    const deps1 = makeCoordinationDeps({ fetchItem: vi.fn().mockImplementation(async (id: string) => ({ ok: true, info: id === 'WL-PLAN-A' ? planA : planB })) });
    const out1 = await dispatchFromCoordination(deps1, readCoordinationFile(testDir)?.entries ?? [], { model: 'plan', cwd: '/roots/contexthub', coordinationDir: testDir });
    expect(out1.dispatched).toBe(true);
    const firstCall = (deps1.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(firstCall).toContain('WL-PLAN-A');
    expect(getEntry(testDir, 'inst-a')).toBe(null); // removed
    expect(getEntry(testDir, 'inst-b')).not.toBe(null); // still queued

    // Cycle 2: only B remains → B dispatches (file order after removal).
    const deps2 = makeCoordinationDeps({ fetchItem: vi.fn().mockImplementation(async (id: string) => ({ ok: true, info: id === 'WL-PLAN-A' ? planA : planB })) });
    const out2 = await dispatchFromCoordination(deps2, readCoordinationFile(testDir)?.entries ?? [], { model: 'plan', cwd: '/roots/contexthub', coordinationDir: testDir });
    expect(out2.dispatched).toBe(true);
    const secondCall = (deps2.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(secondCall).toContain('WL-PLAN-B');
    expect(getEntry(testDir, 'inst-b')).toBe(null);
  });

  it('a later critical offer from another project does not jump an earlier eligible offer (file order)', async () => {
    const planA = itemInfo({ id: 'WL-PLAN-A', status: 'open', stage: 'intake_complete', priority: 'high' });
    const critB = itemInfo({ id: 'WL-CRIT-B', status: 'open', stage: 'idea', priority: 'critical' });
    const entryPlanA = makeEntry('inst-a', 'WL-PLAN-A', '/roots/contexthub');
    const entryCritB = makeEntry('inst-b', 'WL-CRIT-B', '/roots/sorraagents');
    const deps = makeCoordinationDeps({ fetchItem: vi.fn().mockResolvedValueOnce({ ok: true, info: planA }).mockResolvedValueOnce({ ok: true, info: critB }) });
    const outcome = await dispatchFromCoordination(deps, [entryPlanA, entryCritB], { model: 'plan', cwd: '/roots/contexthub', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('WL-PLAN-A');
  });

  it('cursor persists across a simulated leader restart (file survives re-read)', async () => {
    const { loadRoundRobinCursor, saveRoundRobinCursor, ROUND_ROBIN_BY_ROOT_FILE_NAME } = await import('./downtime-round-robin-by-root.js');
    const { join } = await import('node:path');
    const { readFileSync } = await import('node:fs');
    saveRoundRobinCursor(testDir, { '/roots/contexthub': '2026-09-02T00:00:00.000Z' });
    const reloaded = loadRoundRobinCursor(testDir);
    expect(reloaded['/roots/contexthub']).toBe('2026-09-02T00:00:00.000Z');
    const raw = readFileSync(join(testDir, ROUND_ROBIN_BY_ROOT_FILE_NAME), 'utf-8');
    expect(JSON.parse(raw)['/roots/contexthub']).toBe('2026-09-02T00:00:00.000Z');
  });
});


// ── Eligibility re-check at dispatch time (WL-0MTMPIQBE001J41P / WL-0MTOC170J001QMIT) ─
// Entries are never pruned by age; dispatch-time fetchItem+classify is the sole gate.
// Stale entries are removed eagerly (no pane, no marker, cursor NOT advanced) and the
// next eligible entry in file order is dispatched.

describe('dispatchFromCoordination eligibility re-check (WL-0MTOC170J001QMIT)', () => {
  it('removes a needsProducerReview entry without cursor advance and dispatches next eligible', async () => {
    const stale = makeEntry('inst-stale', 'WL-STALE', '/roots/contexthub');
    const ok = makeEntry('inst-ok', 'WL-OK', '/roots/sorraagents');
    writeCoordinationFile(testDir, { version: 1, entries: [stale, ok] });
    // Pre-seed cursor so we can assert NOT advanced for stale root
    const { loadRoundRobinCursor, saveRoundRobinCursor } = await import('./downtime-round-robin-by-root.js');
    saveRoundRobinCursor(testDir, { '/roots/contexthub': '2026-09-01T00:00:00.000Z', '/roots/sorraagents': '2026-09-01T00:00:00.000Z' });
    const before = loadRoundRobinCursor(testDir);

    const deps = makeCoordinationDeps({
      fetchItem: vi.fn(async (id: string) => {
        if (id === 'WL-STALE') return { ok: true, info: itemInfo({ id: 'WL-STALE', status: 'open', stage: 'idea', needsProducerReview: true }) } as const;
        return { ok: true, info: itemInfo({ id: 'WL-OK', status: 'open', stage: 'idea' }) } as const;
      }),
    });
    const outcome = await dispatchFromCoordination(deps, [stale, ok], { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    expect(outcome.dispatched).toBe(true);
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('WL-OK');
    // Stale entry eagerly removed, no pane/marker for it
    expect(getEntry(testDir, 'inst-stale')).toBe(null);
    // The round-robin cursor is retired (WL-0MTK1ILM2009QYB2) — dispatch
    // does NOT advance it for ANY root (offers are consumed in file order).
    const after = loadRoundRobinCursor(testDir);
    expect(after).toEqual(before);
    // Exactly one spawn, for the eligible entry
    expect((deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('removes closed / completed-not-in_review entries and dispatches next eligible', async () => {
    const closed = makeEntry('inst-closed', 'WL-CLOSED', '/roots/a');
    const ok = makeEntry('inst-ok', 'WL-OK2', '/roots/b');
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn(async (id: string) => {
        if (id === 'WL-CLOSED') return { ok: true, info: itemInfo({ id: 'WL-CLOSED', status: 'closed', stage: 'in_review' }) } as const;
        return { ok: true, info: itemInfo({ id: 'WL-OK2', status: 'open', stage: 'intake_complete' }) } as const;
      }),
    });
    const outcome = await dispatchFromCoordination(deps, [closed, ok], { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(getEntry(testDir, 'inst-closed')).toBe(null);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('removes an entry whose completed/in_review item now has a fresh audit', async () => {
    const now = Date.now();
    const freshAudit = makeEntry('inst-aud', 'WL-AUD', '/roots/a');
    const ok = makeEntry('inst-ok', 'WL-OK3', '/roots/b');
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn(async (id: string) => {
        if (id === 'WL-AUD') return {
          ok: true,
          info: itemInfo({
            id: 'WL-AUD',
            status: 'completed',
            stage: 'in_review',
            updatedAt: new Date(now - 10_000).toISOString(),
            auditedAt: new Date(now - 5_000).toISOString(), // fresh (<60s after updatedAt)
          }),
        } as const;
        return { ok: true, info: itemInfo({ id: 'WL-OK3', status: 'open', stage: 'idea' }) } as const;
      }),
    });
    // Need actual file entries for removeEntry to act on
    writeCoordinationFile(testDir, { version: 1, entries: [freshAudit, ok] });
    const outcome = await dispatchFromCoordination(deps, [freshAudit, ok], { model: 'plan', cwd: '/repo', coordinationDir: testDir }, now);
    expect(outcome.dispatched).toBe(true);
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('WL-OK3');
    expect(getEntry(testDir, 'inst-aud')).toBe(null);
  });

  it('removes in_progress and done statuses without dispatching them', async () => {
    const ip = makeEntry('inst-ip', 'WL-IP', '/roots/a');
    const done = makeEntry('inst-done', 'WL-DONE', '/roots/b');
    const ok = makeEntry('inst-ok', 'WL-OK4', '/roots/c');
    writeCoordinationFile(testDir, { version: 1, entries: [ip, done, ok] });
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn(async (id: string) => {
        if (id === 'WL-IP') return { ok: true, info: itemInfo({ id: 'WL-IP', status: 'in_progress', stage: 'in_progress' }) } as const;
        if (id === 'WL-DONE') return { ok: true, info: itemInfo({ id: 'WL-DONE', status: 'completed', stage: 'completed' }) } as const;
        return { ok: true, info: itemInfo({ id: 'WL-OK4', status: 'open', stage: 'idea' }) } as const;
      }),
    });
    const outcome = await dispatchFromCoordination(deps, [ip, done, ok], { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(getEntry(testDir, 'inst-ip')).toBe(null);
    expect(getEntry(testDir, 'inst-done')).toBe(null);
    expect((deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('removes above-caps plan_complete entries and dispatches next', async () => {
    const caps = makeEntry('inst-caps', 'WL-CAPS', '/roots/a');
    const ok = makeEntry('inst-ok', 'WL-OK5', '/roots/b');
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn(async (id: string) => {
        if (id === 'WL-CAPS') return { ok: true, info: itemInfo({ id: 'WL-CAPS', status: 'open', stage: 'plan_complete', risk: 'High', effort: 'L' }) } as const;
        return { ok: true, info: itemInfo({ id: 'WL-OK5', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) } as const;
      }),
    });
    writeCoordinationFile(testDir, { version: 1, entries: [caps, ok] });
    const outcome = await dispatchFromCoordination(deps, [caps, ok], { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(getEntry(testDir, 'inst-caps')).toBe(null);
  });

  it('does NOT prune by wall-clock age: old lastUpdated still dispatches (WL-0MTMPIQBE001J41P)', async () => {
    const oldEntry: CoordinationEntry = { ...makeEntry('inst-old', 'WL-OLDAGE', '/roots/a'), lastUpdated: new Date(Date.now() - 400_000).toISOString() };
    writeCoordinationFile(testDir, { version: 1, entries: [oldEntry] });
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-OLDAGE', status: 'open', stage: 'idea' }) }),
    });
    const outcome = await dispatchFromCoordination(deps, [oldEntry], { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(getEntry(testDir, 'inst-old')).toBe(null); // removed via dispatch path, not prune
  });

  it('when all entries are stale the result is no-candidate with all stale removed and cursor untouched', async () => {
    const a = makeEntry('inst-a', 'WL-A', '/roots/a');
    const b = makeEntry('inst-b', 'WL-B', '/roots/b');
    writeCoordinationFile(testDir, { version: 1, entries: [a, b] });
    const { loadRoundRobinCursor, saveRoundRobinCursor } = await import('./downtime-round-robin-by-root.js');
    saveRoundRobinCursor(testDir, { '/roots/a': '2026-09-01T00:00:00.000Z', '/roots/b': '2026-09-01T00:00:00.000Z' });
    const before = loadRoundRobinCursor(testDir);
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-X', status: 'in_progress', stage: 'in_progress' }) }),
      spawnAgentPane: vi.fn(),
    });
    const outcome = await dispatchFromCoordination(deps, [a, b], { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(getEntry(testDir, 'inst-a')).toBe(null);
    expect(getEntry(testDir, 'inst-b')).toBe(null);
    const after = loadRoundRobinCursor(testDir);
    expect(after).toEqual(before); // cursor NOT advanced for stale-only cycle
  });
});



// ── runCoordinationCheckIn ────────────────────────────────────────────

describe('runCoordinationCheckIn', () => {
  it('upserts the instance most-important item on first check-in (Herdr head offer)', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [headItem({ id: 'WL-IMP', title: 'Most important', stage: 'idea', status: 'open' })],
      }),
    });
    const result = await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    expect(result.offered).toBe('WL-IMP');
    const entry = getEntry(testDir, 'inst-1');
    expect(entry?.workItemId).toBe('WL-IMP');
    expect(entry?.directory).toBe('/repo');
  });

  it('updates the entry when the most-important (Herdr head) item changes', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn()
        .mockResolvedValueOnce({ ok: true, items: [headItem({ id: 'WL-A', stage: 'idea', status: 'open' })] })
        .mockResolvedValueOnce({ ok: true, items: [headItem({ id: 'WL-B', stage: 'intake_complete', status: 'open' })] }),
    });
    await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    expect(getEntry(testDir, 'inst-1')?.workItemId).toBe('WL-B');
  });

  it('removes the own entry on a genuine empty backlog', async () => {
    // First offer something, then the backlog empties.
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn()
        .mockResolvedValueOnce({ ok: true, items: [headItem({ id: 'WL-A', stage: 'idea', status: 'open' })] })
        .mockResolvedValueOnce({ ok: true, items: [] }),
    });
    await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    expect(getEntry(testDir, 'inst-1')).not.toBe(null);
    await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    expect(getEntry(testDir, 'inst-1')).toBe(null);
  });

  it('keeps the existing entry when the computation hits a wl error (fail-open)', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: false }),
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
    checkInIntervalMs: 30 * 60 * 1000, // follower cadence (explicit)
    leaderCheckInIntervalMs: 4 * 60 * 1000, // leader cadence (WL-0MTOCBP1D009P4U3)
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
    // A's own Herdr list head IS WL-IMPL (plan_complete within caps), so
    // its startup check-in re-offers the same entry instead of clearing it.
    const a = makeCoordWorker({
      coordinationDir: testDir,
      instanceId: 'inst-a',
      depsOverrides: {
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [headItem({ id: 'WL-IMPL', title: 'Impl me', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S' })],
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
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [headItem({ id: 'WL-MOST', title: 'Most important', stage: 'intake_complete', status: 'open' })],
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

// ── No-candidate cooldown semantics in coordination mode ───────────────
// (WL-0MTEZ4XZJ006Y9U7): the empty coordination FILE must not be mistaken
// for an empty BACKLOG. After a successful dispatch the leader removes the
// entry, leaving the file transiently empty while the worklog still has
// dispatchable candidates — pausing on that wastes ~60 of every 62 minutes
// (the 1-hour no-candidate cooldown). The fix: (AC1) probe the worklog
// before entering the cooldown, pausing only on a genuinely empty backlog;
// (AC2) run the 30-min check-in BEFORE the cooldown gate and cancel the
// pause when a fresh re-offer lands.

describe('no-candidate cooldown in coordination mode (WL-0MTEZ4XZJ006Y9U7)', () => {
  it('does not pause when the coordination file is empty but the worklog still has candidates (AC1/AC3)', async () => {
    // Scenario from the live bug: ≥2 dispatchable candidates, N free slots,
    // single-entry coordination file. After the leader dispatches the entry
    // the file is EMPTY, so the next dispatch attempt returns no-candidate —
    // but the worklog still has a candidate (B), so the worker must NOT
    // enter the 60-min cooldown; the leader's 4-min check-in re-offers B
    // and dispatch resumes well within min(noCandidateCooldownMs,
    // leaderCheckInMs). Non-leaders stay at 30 min (WL-0MTOCBP1D009P4U3).
    vi.useFakeTimers();
    const T0 = 10_000_000;
    vi.setSystemTime(T0);
    try {
      // Single-entry coordination file: this instance offers its item A.
      writeCoordinationFile(testDir, { version: 1, entries: [makeEntry('inst-a', 'WL-A', '/repo')] });
      const deps = makeCoordinationDeps({
        // The instance's Herdr list head: A first (first check-in), then B
        // (mirrors the dispatched-marker exclusion after A is consumed).
        getHerdrListHead: vi.fn()
          .mockResolvedValueOnce({ ok: true, items: [headItem({ id: 'WL-A', title: 'A', stage: 'intake_complete', status: 'open' })] })
          .mockResolvedValue({ ok: true, items: [headItem({ id: 'WL-B', title: 'B', stage: 'intake_complete', status: 'open' })] }),
        // The leader classifies each offered entry by re-fetching its item.
        fetchItem: vi.fn().mockImplementation(async (id: string) => ({
          ok: true,
          info: itemInfo({ id, status: 'open', stage: 'intake_complete', title: id }),
        })),
      });
      const { worker } = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-a', depsOverrides: deps });

      // Tick 1: election + first check-in (offers A) + poll (idle run starts).
      await worker.tick();
      expect(worker.isLeader).toBe(true);
      expect(getEntry(testDir, 'inst-a')?.workItemId).toBe('WL-A');

      // Idle threshold met → the leader dispatches A and removes the entry,
      // leaving the coordination file EMPTY.
      vi.setSystemTime(T0 + 60_001);
      const first = await worker.tick();
      expect(first.dispatched).toBe(true);
      const firstDispatchAt = worker.lastDispatchAt ?? 0;
      expect(getEntry(testDir, 'inst-a')).toBe(null);

      // A fresh full idle period elapses, then the empty-file dispatch
      // attempt returns no-candidate. The worker probes the worklog (B is
      // dispatchable) and must NOT enter the 60-min cooldown.
      vi.setSystemTime(T0 + 120_001);
      await worker.tick(); // fresh idle run starts
      vi.setSystemTime(T0 + 180_001);
      const attempt = await worker.tick(); // empty-file dispatch attempt
      expect(attempt.dispatched).toBe(false);
      expect(worker.paused).toBe(false); // BUG (pre-fix): 60-min cooldown entered

      // The leader's 4-min check-in re-offers B and the next idle evaluation
      // dispatches it — well inside noCandidateCooldownMs=60min.
      // 4 min from T0 is 240k; we tick there (check-in due → re-offer B).
      vi.setSystemTime(T0 + 4 * 60_000 + 1);
      const second = await worker.tick(); // leader check-in due → re-offer B
      // Dispatch may land on this same tick (idle already met) or next idle
      // tick — either way the gap from first dispatch stays bounded by the
      // 4-min cadence + idle threshold. Poll until dispatched (≤ 1 extra tick).
      let gap = (worker.lastDispatchAt ?? 0) - firstDispatchAt;
      if (!second.dispatched) {
        vi.setSystemTime(T0 + 4 * 60_000 + 60_002);
        const extra = await worker.tick();
        expect(extra.dispatched).toBe(true);
        gap = (worker.lastDispatchAt ?? 0) - firstDispatchAt;
      } else {
        expect(second.dispatched).toBe(true);
      }
      expect(getEntry(testDir, 'inst-a')).toBe(null);
      expect(gap).toBeLessThan(5 * 60_000 + 60_002);
      expect(gap).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the check-in during a genuine-empty pause and cancels the pause on a re-offer (AC2)', async () => {
    vi.useFakeTimers();
    const T0 = 20_000_000;
    vi.setSystemTime(T0);
    try {
      // Genuinely empty worklog first: the worker enters the cooldown.
      const deps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
        fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-NEW', status: 'open', stage: 'intake_complete' }) }),
      });
      const { worker } = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-a', depsOverrides: deps });

      await worker.tick(); // election + check-in (nothing to offer) + first poll
      vi.setSystemTime(T0 + 60_001);
      const attempt = await worker.tick(); // idle threshold met → no-candidate → probe empty → cooldown
      expect(attempt.dispatched).toBe(false);
      expect(worker.paused).toBe(true); // genuine-empty pause IS entered
      expect(getEntry(testDir, 'inst-a')).toBe(null); // nothing offered

      // The pause is a full stop: a tick before the 4-min boundary stays paused.
      vi.setSystemTime(T0 + 3 * 60_000);
      const midPause = await worker.tick();
      expect(midPause.polled).toBe(false);
      expect(midPause.dispatched).toBe(false);
      expect(worker.paused).toBe(true);

      // Work appears while the worker is paused. The leader's 4-min check-in
      // must STILL RUN (not suppressed by the pause) and its re-offer cancels
      // the pause. Keep time monotonic forward (T0 → 60k → 3min → 4min → 4min+60k).
      (deps.getHerdrListHead as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        items: [headItem({ id: 'WL-NEW', title: 'New', stage: 'intake_complete', status: 'open' })],
      });
      vi.setSystemTime(T0 + 4 * 60_000 + 1000);
      const resumed = await worker.tick();
      expect(getEntry(testDir, 'inst-a')?.workItemId).toBe('WL-NEW'); // check-in landed during the pause
      expect(worker.paused).toBe(false); // check-in cancels pause
      expect(resumed.polled).toBe(true); // polling resumed immediately

      // The re-offered item dispatches promptly (fresh full idle period).
      vi.setSystemTime(T0 + 4 * 60_000 + 60_001 + 1000);
      const dispatched = await worker.tick();
      expect(dispatched.dispatched).toBe(true);
      expect(worker.paused).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed to the three-strike rule when the pre-cooldown probe errors — never a silent pause (AC1)', async () => {
    vi.useFakeTimers();
    const T0 = 30_000_000;
    vi.setSystemTime(T0);
    try {
      // The Herdr head lookup fails (CLI error): the probe cannot prove the
      // backlog is empty, so the worker must NOT pause — it records a strike
      // (fail closed to the existing three-strike rule).
      const deps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: false }),
      });
      const { worker } = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-a', depsOverrides: deps });

      await worker.tick(); // election + check-in (lookups fail → entry kept) + poll
      vi.setSystemTime(T0 + 60_001);
      await worker.tick(); // threshold met → empty-file no-candidate → probe fails → strike 1
      expect(worker.paused).toBe(false); // never a silent pause
      expect(worker.errorStrikes).toBe(1);

      vi.setSystemTime(T0 + 120_001);
      await worker.tick(); // strike 2 (idle run stays warm)
      vi.setSystemTime(T0 + 180_001);
      await worker.tick(); // strike 3 → three-strike pause
      expect(worker.paused).toBe(true);
      expect(deps.recordError).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});