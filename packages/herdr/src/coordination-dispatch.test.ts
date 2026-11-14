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
 *    takeover; 5-min check-in cadence (WL-0MTMPSCL8000O45H)
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDowntimeWorker,
  createDowntimePoller,
  classifyItemForDispatch,
  dispatchDowntimeWork,
  dispatchFromCoordination,
  runCoordinationCheckIn,
  computeMostImportantItem,
  coordinationTierRank,
  DOWNTIME_AUDIT_RECENCY_WINDOW_MS,
  DOWNTIME_DISPATCH_EXTEND_MAX,
  DOWNTIME_DISPATCH_EXTEND_MAX_ROUNDS,
  type DowntimeWorker,
  type DowntimeWorkerDeps,
  type DowntimeItemInfo,
  type DowntimeHerdrItem,
  type ScheduledPrompt,
} from './downtime-worker.js';
import { createLeaderElectionManager, LEASE_FILE } from './leader-election.js';
import { probeCoordinationLeafAuditAdmission } from './downtime-worker.gates.js';
import { threeSlotPoolStatus, writeDowntimeLog } from './downtime-worker.fixtures.js';
import { readCoordinationLogEntries, type CoordinationLogEntry } from './downtime-log.js';
import { defaultSettings } from './settings.js';
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
    assignee: overrides.assignee,
    deletedBy: overrides.deletedBy,
  };
}

/** Minimal deps mock for the coordination dispatch path. */
function makeCoordinationDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Leaf-vs-parent audit scope (WL-0MVV1EZ8G006PSBE, C2): the neutral
    // `parent` default keeps today's all-slots-style audit gate.
    getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Herdr list head (WL-0MTK1ILM2009QYB2): the canonical ranking the
    // check-in / probe consume. Default: genuinely empty backlog.
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    // Claim rollback (WL-0MT32F908002YFFA / WL-0MW5JE0SZ0057K30): placement
    // runs after the claim, so an anchor-unavailable abort rolls it back.
    rollbackClaim: vi.fn().mockResolvedValue(true),
    recordError: vi.fn().mockResolvedValue(undefined),
    getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
    recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
    readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
    fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-X', stage: 'idea' }) }),
    // Active-audit single-flight (WL-0MT3PHW4I002SNOV) — also read by the
    // leaf-band coordination probe (WL-0MVV1F130009VZ1P): no audit in flight
    // by default so the relaxed leaf admission is reachable.
    getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
    // Review-queue depth gate (WL-0MT2UQWOR007CYY9 / WL-0MTTSWC1X005P4VD):
    // shallow (empty) queue by default so the gate is INACTIVE and existing
    // tests dispatch implement offers unchanged.
    getReviewQueueCount: vi.fn().mockResolvedValue(0),
    // Item-scoped in-flight guard (WL-0MUBEZ6PE002WLP4 / F4): available query,
    // no live panes by default → the guard is inert for existing tests.
    getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
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
    assignee: overrides.assignee,
    deletedBy: overrides.deletedBy,
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
  it('dispatches risk-effort for plan_complete with unknown/missing risk or effort (WL-0MTTSWCJR003OMN7)', () => {
    expect(classifyItemForDispatch(itemInfo({ id: 'WL-1', status: 'open', stage: 'plan_complete' }))).toBe('risk-effort');
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
  it('maps an OPEN item stuck on the retired in_progress stage to risk-effort (WL-0MTTSWCJR003OMN7 / WL-0MTYL7DX9000MZOH)', () => {
    // Retired-stage recovery: the item is dispatchable via the risk-effort
    // evaluation, whose claim migrates the stage to a valid value.
    expect(classifyItemForDispatch(itemInfo({ id: 'WL-1', status: 'open', stage: 'in_progress' }))).toBe('risk-effort');
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

  it('dispatches a retired-stage offer via risk-effort with an atomic stage-migrating claim (WL-0MTYL7DX9000MZOH AC2/AC3)', async () => {
    // An OPEN item stuck on the retired `in_progress` stage is dispatchable:
    // the claim CASes on the item's ACTUAL stage and migrates the stored
    // stage to plan_complete in the same atomic update — never a hard
    // wl-error strike, never a 60-min pause.
    const entry = makeEntry('inst-retired', 'WL-RETIRED', '/worklog/root');
    writeCoordinationFile(testDir, { version: 1, entries: [entry] });
    const claimItem = vi.fn().mockResolvedValue({ ok: true });
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-RETIRED', status: 'open', stage: 'in_progress' }) }),
      claimItem,
    });

    const outcome = await dispatchFromCoordination(deps, [entry], { model: 'plan', cwd: '/repo', coordinationDir: testDir });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('risk-effort');
    // CAS guard = the item's actual retired stage (race-safe) + migration.
    const claimArgs = claimItem.mock.calls[0];
    expect(claimArgs[0]).toBe('WL-RETIRED');
    expect(claimArgs[1]).toEqual({ status: 'open', stage: 'in_progress' });
    expect(claimArgs[3]).toBe('plan_complete');
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('/skill:effort-and-risk WL-RETIRED');
    // Dispatched entry removed so the owner re-queues its next head.
    expect(getEntry(testDir, 'inst-retired')).toBe(null);
  });

  it('a retired-stage offer never blocks a healthy offer behind it (containment, WL-0MTYL7DX9000MZOH AC4)', async () => {
    // File order: the poisoned (retired-stage) offer first, a healthy
    // implement offer second. If the poisoned offer hard-struck, the healthy
    // offer would never dispatch and the leader would 60-min pause. After the
    // fix, the retired-stage offer DISPATCHES (or at worst skips) and the
    // healthy offers are still served.
    const entries = [
      makeEntry('inst-poison', 'WL-POISON', '/root/a'),
      makeEntry('inst-healthy', 'WL-HEALTHY', '/root/b'),
    ];
    const claimItem = vi.fn()
      .mockResolvedValueOnce({ ok: true }); // poison dispatched (recovery)
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn()
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-POISON', status: 'open', stage: 'in_progress' }) })
        .mockResolvedValueOnce({ ok: true, info: itemInfo({ id: 'WL-HEALTHY', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) }),
      claimItem,
    });

    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    // ONE dispatch per cycle: the poison offer recovered and dispatched,
    // with NO wl-error outcome (no strike, no 60-min pause for the leader).
    expect(outcome.reason).not.toBe('wl-error');
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('risk-effort');
    const claimArgs = claimItem.mock.calls[0];
    expect(claimArgs[3]).toBe('plan_complete');
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

  it('forwards the resolved Dispatcher anchor pane id into the spawn opts (C0)', async () => {
    const deps = makeCoordinationDeps({
      getDispatcherAnchor: vi.fn().mockResolvedValue({ paneId: 'wD:pANCHOR', workspaceId: 'wD' }),
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-PLAN', status: 'open', stage: 'intake_complete' }) }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const outcome = await dispatchFromCoordination(deps, [makeEntry('inst-1', 'WL-PLAN')], { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(deps.getDispatcherAnchor).toHaveBeenCalled();
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-PLAN'),
      expect.objectContaining({ anchorId: 'wD:pANCHOR' }),
    );
  });

  it('stops the cycle (keeps the offer) when the Dispatcher anchor cannot be provisioned', async () => {
    const entry = makeEntry('inst-1', 'WL-PLAN');
    writeCoordinationFile(testDir, { version: 1, entries: [entry] });
    const deps = makeCoordinationDeps({
      getDispatcherAnchor: vi.fn().mockResolvedValue(null),
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-PLAN', status: 'open', stage: 'intake_complete' }) }),
      spawnAgentPane: vi.fn(),
    });
    const outcome = await dispatchFromCoordination(deps, [entry], { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('anchor-unavailable');
    // Placement now runs AFTER the CAS claim (WL-0MW5JE0SZ0057K30): the item
    // is claimed, then rolled back on the anchor failure so it stays
    // re-selectable. No pane is ever created.
    expect(deps.claimItem).toHaveBeenCalled();
    expect(deps.rollbackClaim).toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // The offer stays in the file (anchor failure is transient, not stale).
    expect(getEntry(testDir, 'inst-1')).not.toBe(null);
  });

  it('legacy wiring without getDispatcherAnchor spawns without an anchorId key', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-PLAN', status: 'open', stage: 'intake_complete' }) }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const outcome = await dispatchFromCoordination(deps, [makeEntry('inst-1', 'WL-PLAN')], { model: 'plan', cwd: '/repo', coordinationDir: testDir });
    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-PLAN'),
      expect.not.objectContaining({ anchorId: expect.anything() }),
    );
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
    // named `Downtime <id>` (AC3 spawn path). Scheduled (background)
    // dispatches default to `localPreference: 'remote-ok'`
    // (WL-0MVLJTV03000KIQZ, C4-AC1).
    expect(deps.spawnAgentPane).toHaveBeenCalledWith('/skill:refactor', {
      model: 'plan',
      cwd: '/repo',
      paneName: 'Downtime /skill:refactor',
      // Scheduled prompts dispatch at the scheduled-prompt priority default
      // (`high`, WL-0MVIDWJ090090J3Q AC3) — the entry declares none.
      priority: 'high',
      localPreference: 'remote-ok',
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
// Stale entries are removed eagerly (no pane, no marker).
//
// Rewritten for WL-0MWFIZ8H5005FVNN (post-dispatch round-robin charge): the
// round-robin cursor is charged when an offer is CONSUMED, not when a root is
// selected. Selection is a pure read, so an entry dropped by the filter chain
// charges nothing and only the root whose offer actually dispatches is charged.
// The old comments here documented selection-time charging (WL-0MTQ2FGSK004CBRK)
// and are deliberately replaced, not deleted.

describe('dispatchFromCoordination eligibility re-check (WL-0MTOC170J001QMIT)', () => {
  // RED BASELINE (WL-0MWFIZ8H5005FVNN): the post-dispatch charge lands in
  // WL-0MWFJT3H9008A0LM, which flips this spec to `it(...)`. It currently
  // fails because the selected (stale) root is charged at selection time while
  // the dispatching root is never charged.
  it.fails('removes a needsProducerReview entry without charging it and charges the dispatching root', async () => {
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
    // Rewritten for WL-0MWFIZ8H5005FVNN (dispatch-driven charge): the stale
    // contexthub offer was dropped by the filter chain, so its root is NOT
    // charged; the root that actually dispatched (sorraagents) IS charged.
    // (The old assertion — "selected root advanced" — encoded the selection-
    // time charging this change removes.)
    const after = loadRoundRobinCursor(testDir);
    expect(after['/roots/contexthub']).toBe(before['/roots/contexthub']); // filter-chain drop: no charge
    expect(after['/roots/sorraagents']).not.toBe(before['/roots/sorraagents']); // dispatch charges its own root
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

  // Flipped to `it(...)` by WL-0MWFJSVXT0033M9M (pure selection): selection no
  // longer writes, so a tick that dispatches nothing leaves the cursor intact.
  it('when all entries are stale the result is no-candidate with all stale removed and the cursor byte-identical', async () => {
    const a = makeEntry('inst-a', 'WL-A', '/roots/a');
    const b = makeEntry('inst-b', 'WL-B', '/roots/b');
    writeCoordinationFile(testDir, { version: 1, entries: [a, b] });
    const { saveRoundRobinCursor, ROUND_ROBIN_BY_ROOT_FILE_NAME } = await import('./downtime-round-robin-by-root.js');
    saveRoundRobinCursor(testDir, { '/roots/a': '2026-09-01T00:00:00.000Z', '/roots/b': '2026-09-01T00:00:00.000Z' });
    const cursorPath = join(testDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
    const before = readFileSync(cursorPath, 'utf8');
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
    // Rewritten for WL-0MWFIZ8H5005FVNN: nothing was consumed, so the tick
    // must leave the cursor byte-identical — selection performs no write.
    // (The old assertion encoded selection-time charging — WL-0MTQ2FGSK004CBRK.)
    expect(readFileSync(cursorPath, 'utf8')).toBe(before);
  });
});

// ── Dispatch-driven round-robin charge (WL-0MWFIZ8H5005FVNN) ────────────
//
// RED BASELINE (TDD): the specs below encode the NEW contract — selection is a
// pure read and the cursor is charged only when an offer is CONSUMED
// (`dispatched`, `spawn-failed`, `marker-write-failed`). They were wrapped in
// `it.fails(...)` so the red baseline commits green (the repo's documented TDD
// pattern, as used by the registered-root sweep and clamps suites). The
// implementation children flip each spec to `it(...)`:
//   - WL-0MWFJSVXT0033M9M (pure selection) → DONE: the selection-purity specs
//     (this file's "a tick where every offer is held" and the all-stale spec;
//     plus the selection-purity block in downtime-round-robin-by-root.test.ts)
//     now run as plain `it(...)`.
//   - WL-0MWFJT3H9008A0LM (consumed-offer charge) → the charge table (both the
//     positive charge rows and the neutral rows' positive control), the
//     non-front-dispatch fixtures, the needsProducerReview rewrite and the
//     four-root fairness spec.
//   - WL-0MWFJTCJ5004BKE4 (sweep charge) → the sweep specs in
//     coordination-registered-root-sweep.test.ts.
// Every spec fails on the pre-change code for a CHARGE-SEMANTICS reason — an
// advanced cursor where none should be, or an unadvanced dispatching root —
// never for a compile/import error.

const CHARGE_ROOT_A = '/roots/charge-a';
const CHARGE_ROOT_B = '/roots/charge-b';
const CHARGE_SEED_A = '2026-01-01T00:00:00.000Z';
const CHARGE_SEED_B = '2026-01-02T00:00:00.000Z';
const CHARGE_NOW = Date.parse('2026-01-03T00:00:00.000Z');
const HELD_ITEM_ID = 'WL-HELD-A';

/** An implement candidate. */
function implementCandidate(id: string, overrides: Partial<DowntimeItemInfo> = {}): DowntimeItemInfo {
  return itemInfo({ id, status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S', ...overrides });
}

/**
 * Deps for a two-root charge fixture: `heldRoot`'s implement offer is KEPT but
 * skipped by the review-queue gate (the selected root consumes nothing), while
 * `dispatchItem` in the other root drives the outcome under test.
 */
function chargeFixtureDeps(opts: {
  heldRoot: string;
  heldItemId: string;
  dispatchItem: DowntimeItemInfo;
  overrides?: Partial<DowntimeWorkerDeps>;
}): DowntimeWorkerDeps {
  return makeCoordinationDeps({
    // A deep queue only for the held root holds its non-critical implement
    // offer without removing it — a neutral hold that must never charge.
    getReviewQueueCount: vi.fn(async (root: string) => (root === opts.heldRoot ? 20 : 0)),
    fetchItem: vi.fn(async (id: string) => ({
      ok: true as const,
      info: id === opts.heldItemId
        ? implementCandidate(opts.heldItemId)
        : opts.dispatchItem,
    })),
    ...opts.overrides,
  });
}

/**
 * Control probe: a minimal fresh tick must charge the root whose offer is
 * CONSUMED. Used by the neutral-outcome rows so each row depends on the
 * consumed-offer charge existing (WL-0MWFJT3H9008A0LM) — otherwise a neutral
 * row would already be green under pure selection alone (WL-0MWFJSVXT0033M9M)
 * and could not pin the charge contract.
 */
async function expectConsumedOfferChargeLive(): Promise<void> {
  const { loadRoundRobinCursor, saveRoundRobinCursor } = await import('./downtime-round-robin-by-root.js');
  const root = '/roots/charge-live';
  const seed = '2020-01-01T00:00:00.000Z';
  const nowMs = Date.parse('2026-01-05T00:00:00.000Z');
  saveRoundRobinCursor(testDir, { [root]: seed });
  const entry = makeEntry('inst-live', 'WL-LIVE', root);
  writeCoordinationFile(testDir, { version: 1, entries: [entry] });
  const deps = makeCoordinationDeps({
    fetchItem: vi.fn(async (id: string) => ({ ok: true as const, info: implementCandidate(id) })),
  });
  const outcome = await dispatchFromCoordination(
    deps,
    [entry],
    { model: 'plan', cwd: root, coordinationDir: testDir },
    nowMs,
  );
  expect(outcome.dispatched).toBe(true);
  expect(loadRoundRobinCursor(testDir)[root]).toBe(new Date(nowMs).toISOString());
}

describe('dispatch-driven round-robin charge (WL-0MWFIZ8H5005FVNN)', () => {
  it.fails('charges the DISPATCHING root B when the selected root A holds its offer (non-front dispatch)', async () => {
    const { loadRoundRobinCursor, saveRoundRobinCursor } = await import('./downtime-round-robin-by-root.js');
    saveRoundRobinCursor(testDir, { [CHARGE_ROOT_A]: CHARGE_SEED_A, [CHARGE_ROOT_B]: CHARGE_SEED_B });
    const entryA = makeEntry('inst-held-a', HELD_ITEM_ID, CHARGE_ROOT_A);
    const entryB = makeEntry('inst-b', 'WL-DISPATCH-B', CHARGE_ROOT_B);
    writeCoordinationFile(testDir, { version: 1, entries: [entryA, entryB] });

    const deps = chargeFixtureDeps({
      heldRoot: CHARGE_ROOT_A,
      heldItemId: HELD_ITEM_ID,
      dispatchItem: implementCandidate('WL-DISPATCH-B'),
    });
    const outcome = await dispatchFromCoordination(
      deps,
      [entryA, entryB],
      { model: 'plan', cwd: CHARGE_ROOT_A, coordinationDir: testDir },
      CHARGE_NOW,
    );

    expect(outcome.dispatched).toBe(true); // B dispatched
    const after = loadRoundRobinCursor(testDir);
    expect(after[CHARGE_ROOT_A]).toBe(CHARGE_SEED_A); // selected-but-held root: never charged
    expect(after[CHARGE_ROOT_B]).toBe(new Date(CHARGE_NOW).toISOString()); // dispatching root charged
  });

  it.fails('charges the DISPATCHING root A when the selected root B holds its offer (mirrored non-front dispatch)', async () => {
    const { loadRoundRobinCursor, saveRoundRobinCursor } = await import('./downtime-round-robin-by-root.js');
    // Mirror: B is cursor-oldest (selected) and holds; A (second position) dispatches.
    saveRoundRobinCursor(testDir, { [CHARGE_ROOT_A]: CHARGE_SEED_B, [CHARGE_ROOT_B]: CHARGE_SEED_A });
    const entryA = makeEntry('inst-a', 'WL-DISPATCH-A', CHARGE_ROOT_A);
    const entryB = makeEntry('inst-held-b', 'WL-HELD-B', CHARGE_ROOT_B);
    writeCoordinationFile(testDir, { version: 1, entries: [entryA, entryB] });

    const deps = chargeFixtureDeps({
      heldRoot: CHARGE_ROOT_B,
      heldItemId: 'WL-HELD-B',
      dispatchItem: implementCandidate('WL-DISPATCH-A'),
    });
    const outcome = await dispatchFromCoordination(
      deps,
      [entryA, entryB],
      { model: 'plan', cwd: CHARGE_ROOT_A, coordinationDir: testDir },
      CHARGE_NOW,
    );

    expect(outcome.dispatched).toBe(true);
    const after = loadRoundRobinCursor(testDir);
    expect(after[CHARGE_ROOT_B]).toBe(CHARGE_SEED_A); // selected-but-held root: never charged
    expect(after[CHARGE_ROOT_A]).toBe(new Date(CHARGE_NOW).toISOString()); // dispatching root charged
  });

  it('selection purity: a tick where every offer is held leaves the cursor file byte-identical', async () => {
    const { saveRoundRobinCursor, ROUND_ROBIN_BY_ROOT_FILE_NAME } = await import('./downtime-round-robin-by-root.js');
    saveRoundRobinCursor(testDir, { [CHARGE_ROOT_A]: CHARGE_SEED_A, [CHARGE_ROOT_B]: CHARGE_SEED_B });
    const cursorPath = join(testDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
    const before = readFileSync(cursorPath, 'utf8');

    const deps = makeCoordinationDeps({
      // EVERY root's queue is deep: both implement offers are kept but held.
      getReviewQueueCount: vi.fn(async () => 20),
      fetchItem: vi.fn(async (id: string) => ({ ok: true as const, info: implementCandidate(id) })),
    });
    const entries = [
      makeEntry('inst-a', 'WL-A', CHARGE_ROOT_A),
      makeEntry('inst-b', 'WL-B', CHARGE_ROOT_B),
    ];
    const outcome = await dispatchFromCoordination(
      deps,
      entries,
      { model: 'plan', cwd: CHARGE_ROOT_A, coordinationDir: testDir },
      CHARGE_NOW,
    );

    expect(outcome.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(readFileSync(cursorPath, 'utf8')).toBe(before);
  });

  // Table-driven per-outcome contract: the outcome classes named in the
  // parent ACs (WL-0MWFIZ8H5005FVNN). Each row is one offer outcome; `charges`
  // says whether the dispatching root is charged.
  type ChargeTableRow = {
    outcome: string;
    charges: boolean;
    item: DowntimeItemInfo;
    overrides?: Partial<DowntimeWorkerDeps>;
  };
  const auditCandidate = (id: string): DowntimeItemInfo =>
    itemInfo({ id, status: 'completed', stage: 'in_review', updatedAt: new Date(CHARGE_NOW - 60_000).toISOString() });
  const table: ChargeTableRow[] = [
    { outcome: 'dispatched', charges: true, item: implementCandidate('WL-CONSUME') },
    {
      outcome: 'spawn-failed',
      charges: true,
      item: implementCandidate('WL-SPAWN-FAILED'),
      overrides: { spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'boom', exitCode: 1 }) },
    },
    {
      outcome: 'marker-write-failed',
      charges: true,
      item: implementCandidate('WL-MARKER-FAILED'),
      overrides: {
        recordDispatch: vi.fn().mockResolvedValue(false),
        // Rollback also fails → the claimed item is stranded; the offer is
        // consumed (removed) so the dispatching root is charged.
        rollbackClaim: vi.fn().mockResolvedValue(false),
      },
    },
    {
      outcome: 'claim-failed',
      charges: false,
      item: implementCandidate('WL-CLAIM-FAILED'),
      overrides: { claimItem: vi.fn().mockResolvedValue({ ok: false, reason: 'stale' }) },
    },
    {
      outcome: 'claim-rolled-back',
      charges: false,
      item: implementCandidate('WL-CLAIM-ROLLED-BACK'),
      overrides: {
        recordDispatch: vi.fn().mockResolvedValue(false),
        rollbackClaim: vi.fn().mockResolvedValue(true),
      },
    },
    {
      outcome: 'reservation admit:false',
      charges: false,
      item: implementCandidate('WL-RESERVED'),
      overrides: {
        reserveLocalCapacity: vi.fn().mockResolvedValue({
          status: 'refused',
          refusal: { reason: 'queue-full', retryAfterSeconds: 12 },
        }),
      },
    },
    {
      outcome: 'anchor-unavailable',
      charges: false,
      item: implementCandidate('WL-ANCHOR'),
      overrides: { getDispatcherAnchor: vi.fn().mockResolvedValue(null) },
    },
    {
      outcome: 'host-budget-implement',
      charges: false,
      item: implementCandidate('WL-HOST-BUDGET'),
      overrides: {
        admitHostDispatch: vi.fn().mockResolvedValue({ admitted: false, live: 2, max: 2, reason: 'host-budget-implement' }),
        rollbackClaim: vi.fn().mockResolvedValue(true),
      },
    },
    {
      outcome: 'audit-budget-saturated',
      charges: false,
      item: auditCandidate('WL-AUDIT-BUDGET'),
      overrides: {
        admitHostDispatch: vi.fn().mockResolvedValue({ admitted: false, live: 1, max: 1, reason: 'audit-budget-saturated' }),
        rollbackClaim: vi.fn().mockResolvedValue(true),
      },
    },
    {
      outcome: 'non-dispatchable filter-chain removal',
      charges: false,
      item: implementCandidate('WL-FILTERED', { needsProducerReview: true }),
    },
  ];

  for (const row of table) {
    it.fails(`${row.charges ? 'charges' : 'does not charge'} on \`${row.outcome}\``, async () => {
      const { loadRoundRobinCursor, saveRoundRobinCursor } = await import('./downtime-round-robin-by-root.js');
      saveRoundRobinCursor(testDir, { [CHARGE_ROOT_A]: CHARGE_SEED_A, [CHARGE_ROOT_B]: CHARGE_SEED_B });
      const entryA = makeEntry('inst-held-a', HELD_ITEM_ID, CHARGE_ROOT_A);
      const entryB = makeEntry('inst-outcome', row.item.id, CHARGE_ROOT_B);
      writeCoordinationFile(testDir, { version: 1, entries: [entryA, entryB] });
      const deps = chargeFixtureDeps({
        heldRoot: CHARGE_ROOT_A,
        heldItemId: HELD_ITEM_ID,
        dispatchItem: row.item,
        overrides: row.overrides ?? {},
      });
      await dispatchFromCoordination(
        deps,
        [entryA, entryB],
        { model: 'plan', cwd: CHARGE_ROOT_A, coordinationDir: testDir },
        CHARGE_NOW,
      );

      const after = loadRoundRobinCursor(testDir);
      // The selected-but-held root must never be charged — selection is pure
      // (this half fails on the current code for EVERY row).
      expect(after[CHARGE_ROOT_A]).toBe(CHARGE_SEED_A);
      if (row.charges) {
        expect(after[CHARGE_ROOT_B]).toBe(new Date(CHARGE_NOW).toISOString());
      } else {
        expect(after[CHARGE_ROOT_B]).toBe(CHARGE_SEED_B);
        // A neutral hold must not charge — but "nothing charges" is also true
        // before the charge exists at all. Pin the positive half so this row
        // stays RED until the consumed-offer charge lands (WL-0MWFJT3H9008A0LM).
        await expectConsumedOfferChargeLive();
      }
    });
  }

  it.fails('four-root fairness: no admissible root is skipped while surplus capacity exists', async () => {
    const { saveRoundRobinCursor } = await import('./downtime-round-robin-by-root.js');
    const roots = ['/roots/fair-1', '/roots/fair-2', '/roots/fair-3', '/roots/fair-4'];
    saveRoundRobinCursor(testDir, {
      [roots[0]]: '2025-12-01T00:00:00.000Z',
      [roots[1]]: '2025-12-02T00:00:00.000Z',
      [roots[2]]: '2025-12-03T00:00:00.000Z',
      [roots[3]]: '2025-12-04T00:00:00.000Z',
    });
    // roots[0] always holds (deep review queue); the other three always offer
    // an admissible implement. Under the CURRENT code the selected-but-held
    // root is charged while a non-front winner is not, letting one productive
    // root dispatch twice in a row (R2,R2,R3,R4,...) while its peers wait.
    const deps = makeCoordinationDeps({
      getReviewQueueCount: vi.fn(async (root: string) => (root === roots[0] ? 20 : 0)),
      fetchItem: vi.fn(async (id: string) => ({ ok: true as const, info: implementCandidate(id) })),
    });
    // The coordination file rotates like the real append-only check-in: a
    // consumed offer is removed and its owner re-offers at the TAIL.
    let order = roots.map((root, index) => makeEntry(`inst-fair-${index}`, `WL-FAIR-${index}`, root));
    const dispatched: string[] = [];
    const dispatchedAt: number[] = [];
    for (let tick = 0; tick < 6; tick++) {
      writeCoordinationFile(testDir, { version: 1, entries: order });
      const nowMs = Date.parse('2026-01-04T00:00:00.000Z') + tick * 1_000;
      const outcome = await dispatchFromCoordination(
        deps,
        [...order],
        { model: 'plan', cwd: '/roots/leader', coordinationDir: testDir },
        nowMs,
      );
      expect(outcome.dispatched).toBe(true);
      const spawnCalls = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls;
      const spawnOpts = spawnCalls[tick][1] as { cwd: string };
      dispatched.push(spawnOpts.cwd);
      dispatchedAt.push(nowMs);
      const consumed = order.find((entry) => (entry.worklogRoot ?? entry.directory) === spawnOpts.cwd);
      expect(consumed).toBeDefined();
      order = [
        ...order.filter((entry) => entry !== consumed),
        makeEntry(consumed!.instanceId, consumed!.workItemId, spawnOpts.cwd),
      ];
    }

    // The permanently held root never consumes a dispatch slot.
    expect(dispatched).not.toContain(roots[0]);
    // No productive root dispatches twice in a row while its peers hold
    // admissible offers and surplus capacity exists.
    for (let i = 1; i < dispatched.length; i++) {
      expect(dispatched[i]).not.toBe(dispatched[i - 1]);
    }
    // Every productive root is served at least twice in the six-tick window.
    for (const root of roots.slice(1)) {
      expect(dispatched.filter((cwd) => cwd === root).length).toBeGreaterThanOrEqual(2);
    }
    // The cursor records exactly who was served: every tick charges the root
    // that dispatched at that tick (and nothing else). This half keeps the spec
    // RED until the consumed-offer charge lands (WL-0MWFJT3H9008A0LM).
    const { loadRoundRobinCursor } = await import('./downtime-round-robin-by-root.js');
    const cursor = loadRoundRobinCursor(testDir);
    const chargedRoots = Object.keys(cursor).filter(
      (root) => Date.parse(cursor[root]) >= Date.parse('2026-01-04T00:00:00.000Z'),
    );
    expect(chargedRoots.sort()).toEqual([...new Set(dispatched)].sort());
    for (let i = 0; i < dispatched.length; i++) {
      expect(cursor[dispatched[i]]).toBe(new Date(dispatchedAt[i]).toISOString());
    }
  });
});



// ── runCoordinationCheckIn ────────────────────────────────────────────

// ── Non-terminal pane-close cooldown on the coordination path ─────────
// (WL-0MUKYERLZ006ELL5)

describe('dispatchFromCoordination non-terminal cooldown (WL-0MUKYERLZ006ELL5)', () => {
  const COOLDOWN_MS = 30 * 60 * 1000;

  /** A temp worklog root carrying one non-terminal plan pane-close entry. */
  function rootWithClose(timestamp: string): string {
    const root = mkdtempSync(join(tmpdir(), 'herdr-cooldown-root-'));
    mkdirSync(join(root, '.worklog'), { recursive: true });
    writeFileSync(
      join(root, '.worklog', 'downtime-dispatches.log'),
      JSON.stringify({
        entryType: 'pane-close',
        itemId: 'WL-COOL',
        kind: 'plan',
        stage: 'intake_complete',
        reasonCode: 'agent-ended-no-terminal',
        outcome: 'requires-attention',
        timestamp,
        closed: true,
      }) + '\n',
      'utf8',
    );
    return root;
  }

  it('keeps the offer but skips it with the neutral cooldown reason', async () => {
    const root = rootWithClose(new Date().toISOString());
    try {
      const entry = makeEntry('inst-cool', 'WL-COOL', root);
      writeCoordinationFile(testDir, { version: 1, entries: [entry] });
      const deps = makeCoordinationDeps({
        fetchItem: vi.fn().mockResolvedValue({
          ok: true,
          info: itemInfo({ id: 'WL-COOL', status: 'open', stage: 'intake_complete' }),
        }),
      });

      const outcome = await dispatchFromCoordination(deps, [entry], {
        model: 'plan',
        cwd: '/repo',
        coordinationDir: testDir,
        nonTerminalCooldownMs: COOLDOWN_MS,
      });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('non-terminal-cooldown');
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      // The offer is KEPT (still valid) — it dispatches once the cooldown ends.
      expect(getEntry(testDir, 'inst-cool')).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dispatches a cooldown-elapsed offer normally', async () => {
    const root = rootWithClose(new Date(Date.now() - COOLDOWN_MS - 1_000).toISOString());
    try {
      const entry = makeEntry('inst-cool2', 'WL-COOL', root);
      writeCoordinationFile(testDir, { version: 1, entries: [entry] });
      const deps = makeCoordinationDeps({
        fetchItem: vi.fn().mockResolvedValue({
          ok: true,
          info: itemInfo({ id: 'WL-COOL', status: 'open', stage: 'intake_complete' }),
        }),
      });

      const outcome = await dispatchFromCoordination(deps, [entry], {
        model: 'plan',
        cwd: '/repo',
        coordinationDir: testDir,
        nonTerminalCooldownMs: COOLDOWN_MS,
      });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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

  it('offers the head using the effective browseItemCount (AC1, WL-0MUNS8X97007C9H9)', async () => {
    const getHerdrListHead = vi.fn().mockResolvedValue({
      ok: true,
      items: [headItem({ id: 'WL-IMP', stage: 'idea', status: 'open' })],
    });
    const deps = makeCoordinationDeps({ getHerdrListHead });
    await runCoordinationCheckIn(deps, {
      cwd: '/repo',
      coordinationDir: testDir,
      instanceId: 'inst-1',
      browseItemCount: 33,
    });
    expect(getHerdrListHead).toHaveBeenCalledWith('/repo', 33);
  });

  it('clamps an out-of-range browseItemCount on the check-in offer path', async () => {
    const getHerdrListHead = vi.fn().mockResolvedValue({
      ok: true,
      items: [headItem({ id: 'WL-IMP', stage: 'idea', status: 'open' })],
    });
    const deps = makeCoordinationDeps({ getHerdrListHead });
    await runCoordinationCheckIn(deps, {
      cwd: '/repo',
      coordinationDir: testDir,
      instanceId: 'inst-1',
      browseItemCount: 999,
    });
    expect(getHerdrListHead).toHaveBeenCalledWith('/repo', 50);
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

  it('writes a bounded v2 offers array from the per-bucket nominees (one head read for all three buckets)', async () => {
    const getHerdrListHead = vi.fn().mockResolvedValue({
      ok: true,
      items: [
        headItem({ id: 'WL-IMP', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S' }),
        headItem({ id: 'WL-AUD', stage: 'in_review', status: 'completed', updatedAt: new Date(Date.now() - 60_000).toISOString() }),
        headItem({ id: 'WL-PREP', stage: 'intake_complete', status: 'open' }),
      ],
    });
    const deps = makeCoordinationDeps({ getHerdrListHead });
    const result = await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    expect(result.offered).toBe('WL-IMP');
    expect(getHerdrListHead).toHaveBeenCalledTimes(1);
    const entry = getEntry(testDir, 'inst-1');
    expect(entry?.workItemId).toBe('WL-IMP');
    // The v2 `offers` payload is the canonical per-bucket nominee array
    // (implement → audit → prep) computed from the single head read.
    expect((entry as unknown as { offers?: Array<{ kind: string; workItemId: string }> }).offers).toEqual([
      { kind: 'implement', workItemId: 'WL-IMP' },
      { kind: 'audit', workItemId: 'WL-AUD' },
      { kind: 'prep', workItemId: 'WL-PREP' },
    ]);
  });

  it('orders the offers by canonical bucket, not window order — workItemId mirrors the first (implement) offer', async () => {
    const getHerdrListHead = vi.fn().mockResolvedValue({
      ok: true,
      // AUD appears first in the WINDOW (it is the window-first candidate),
      // but the v2 offers payload follows the canonical bucket order
      // implement → audit → prep (parent AC2: buckets, not a second ranking),
      // and `workItemId` mirrors offers[0] so a v1-era leader reads the
      // implement nominee (parent AC9).
      items: [
        headItem({ id: 'WL-AUD', stage: 'in_review', status: 'completed', updatedAt: new Date(Date.now() - 60_000).toISOString() }),
        headItem({ id: 'WL-IMP', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S' }),
      ],
    });
    const deps = makeCoordinationDeps({ getHerdrListHead });
    const result = await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    expect(result.offered).toBe('WL-IMP');
    const entry = getEntry(testDir, 'inst-1');
    expect(entry?.workItemId).toBe('WL-IMP');
    expect((entry as unknown as { offers?: Array<{ kind: string; workItemId: string }> }).offers).toEqual([
      { kind: 'implement', workItemId: 'WL-IMP' },
      { kind: 'audit', workItemId: 'WL-AUD' },
    ]);
  });

  it('offers only the buckets present in the window — no read to widen for a missing bucket', async () => {
    const getHerdrListHead = vi.fn().mockResolvedValue({
      ok: true,
      items: [
        headItem({ id: 'WL-IMP', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S' }),
        headItem({ id: 'WL-AUD', stage: 'in_review', status: 'completed', updatedAt: new Date(Date.now() - 60_000).toISOString() }),
      ],
    });
    const deps = makeCoordinationDeps({ getHerdrListHead });
    await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1' });
    // The missing prep bucket nominated nothing and was NOT sought beyond the
    // window (parent AC3): still exactly one head read.
    expect(getHerdrListHead).toHaveBeenCalledTimes(1);
    const entry = getEntry(testDir, 'inst-1');
    expect((entry as unknown as { offers?: Array<{ kind: string; workItemId: string }> }).offers).toEqual([
      { kind: 'implement', workItemId: 'WL-IMP' },
      { kind: 'audit', workItemId: 'WL-AUD' },
    ]);
  });

  it('falls back to a single-offer entry when the visible window yields nothing and the offer comes from the whole-backlog extension', async () => {
    // The only window item is freshly dispatched (marker exclusion filters the
    // WHOLE window); the whole-backlog extension then finds the next
    // implement. The entry carries ONE offer (the window partition is empty —
    // AC3: the window is never widened to fill a bucket), so a v1-era leader
    // keeps reading exactly the pre-tier-aware offer.
    const root = mkdtempSync(join(tmpdir(), 'herdr-checkin-ext-'));
    try {
      writeDowntimeLog(root, [
        { kind: 'implement', operation: 'dispatch', itemId: 'WL-IMP-1', stage: 'plan_complete', dispatchedAt: new Date(Date.now() - 60_000).toISOString() },
      ] as never);
      const getHerdrListHead = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          items: [headItem({ id: 'WL-IMP-1', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S' })],
        })
        .mockResolvedValue({
          ok: true,
          items: [
            headItem({ id: 'WL-IMP-1', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S' }),
            headItem({ id: 'WL-IMP-2', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S' }),
          ],
        });
      const deps = makeCoordinationDeps({ getHerdrListHead });
      const result = await runCoordinationCheckIn(deps, { cwd: root, coordinationDir: testDir, instanceId: 'inst-1' });
      expect(result.offered).toBe('WL-IMP-2');
      const entry = getEntry(testDir, 'inst-1');
      expect(entry?.workItemId).toBe('WL-IMP-2');
      expect((entry as unknown as { offers?: Array<{ kind: string; workItemId: string }> }).offers).toEqual([
        { kind: 'implement', workItemId: 'WL-IMP-2' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Empty-offer attribution (WL-0MVR8FKMU009XTED AC1/AC5) ────────────
//
// Every emptied check-in records the machine-readable reason why nothing was
// offered: `empty-window`, `all-window-items-held` (with the observed
// scheduling-hold sentinels), `all-window-items-gated` (with the dominant
// gate), and the dedicated hold tokens. The no-candidate result semantics (and
// therefore the cooldown) are UNCHANGED — only the explanation is added.

describe('runCoordinationCheckIn empty-offer attribution (WL-0MVR8FKMU009XTED)', () => {
  /** Read the check-in entries written for this root (the writes are fire-and-forget). */
  async function checkinEntries(root: string): Promise<Array<Record<string, unknown>>> {
    const entries = await readCoordinationLogEntries(root);
    return entries
      .filter((entry) => entry.operation === 'checkin')
      .map((entry) => entry as unknown as Record<string, unknown>);
  }

  it('dispatcher-claimed items are never attributed to all-window-items-held (WL-0MW51OB1Y0073TLG)', async () => {
    // The downtime dispatcher claims the items it auto-dispatches. That claim
    // means "an agent is on it", so it must not be reported as a scheduling
    // hold: a window refused for another reason stays all-window-items-gated.
    const root = mkdtempSync(join(tmpdir(), 'herdr-attrib-dispatcher-'));
    try {
      const deps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [
            headItem({
              id: 'WL-D1',
              stage: 'idea',
              status: 'completed',
              assignee: 'dispatcher',
            }),
            headItem({
              id: 'WL-D2',
              stage: 'idea',
              status: 'completed',
              assignee: 'dispatcher',
            }),
          ],
        }),
      });
      writeCoordinationFile(testDir, { version: 1, entries: [makeEntry('inst-1', 'WL-D1', root)] });
      const result = await runCoordinationCheckIn(deps, {
        cwd: root,
        coordinationDir: testDir,
        instanceId: 'inst-1',
      });
      expect(result.offered).toBe(null);
      await vi.waitFor(async () => {
        const emptied = (await checkinEntries(root)).filter((entry) => entry.workItemId === null);
        expect(emptied.length).toBeGreaterThan(0);
        const last = emptied[emptied.length - 1];
        expect(last.reason).toBe('all-window-items-gated');
        expect(last.dominantGate).toBe('not-dispatchable');
        expect(last.heldAssignees).toBeUndefined();
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC5: a fully-held window yields all-window-items-held with the observed sentinel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-attrib-held-'));
    try {
      const deps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [
            headItem({ id: 'WL-H1', stage: 'idea', status: 'open', assignee: 'Map' }),
            headItem({ id: 'WL-H2', stage: 'plan_complete', status: 'open', assignee: 'Map' }),
          ],
        }),
      });
      // Seed an own entry so the removal is observable.
      writeCoordinationFile(testDir, { version: 1, entries: [makeEntry('inst-1', 'WL-H1', root)] });
      const result = await runCoordinationCheckIn(deps, {
        cwd: root,
        coordinationDir: testDir,
        instanceId: 'inst-1',
      });
      // The no-candidate semantics are unchanged: nothing is offered and the
      // own entry is removed (the caller's cooldown decision is untouched).
      expect(result.offered).toBe(null);
      expect(result.updated).toBe(true);
      expect(getEntry(testDir, 'inst-1')).toBe(null);
      await vi.waitFor(async () => {
        const emptied = (await checkinEntries(root)).filter((entry) => entry.workItemId === null);
        expect(emptied.length).toBeGreaterThan(0);
        expect(emptied[emptied.length - 1]).toMatchObject({
          reason: 'all-window-items-held',
          windowSize: 2,
          heldAssignees: ['Map'],
          workItemId: null,
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC5: a genuinely empty window still empties the entry and records empty-window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-attrib-empty-'));
    try {
      const deps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
      });
      writeCoordinationFile(testDir, { version: 1, entries: [makeEntry('inst-1', 'WL-A', root)] });
      const result = await runCoordinationCheckIn(deps, {
        cwd: root,
        coordinationDir: testDir,
        instanceId: 'inst-1',
      });
      expect(result.updated).toBe(true);
      expect(getEntry(testDir, 'inst-1')).toBe(null);
      await vi.waitFor(async () => {
        const emptied = (await checkinEntries(root)).filter((entry) => entry.workItemId === null);
        expect(emptied[emptied.length - 1]).toMatchObject({
          reason: 'empty-window',
          windowSize: 0,
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records all-window-items-gated with the gate that rejected the most items', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-attrib-gated-'));
    try {
      const deps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [
            headItem({ id: 'WL-G1', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'XL' }),
            headItem({ id: 'WL-G2', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'XL' }),
            headItem({ id: 'WL-G3', stage: 'idea', status: 'open', needsProducerReview: true }),
          ],
        }),
      });
      await runCoordinationCheckIn(deps, { cwd: root, coordinationDir: testDir, instanceId: 'inst-1' });
      await vi.waitFor(async () => {
        const emptied = (await checkinEntries(root)).filter((entry) => entry.workItemId === null);
        expect(emptied[emptied.length - 1]).toMatchObject({
          reason: 'all-window-items-gated',
          windowSize: 3,
          dominantGate: 'effort-cap',
          gateCounts: { 'effort-cap': 2, 'producer-review': 1 },
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records the code-freeze token when every remaining offer is freeze-paused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-attrib-freeze-'));
    try {
      const deps = makeCoordinationDeps({
        readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [headItem({ id: 'WL-F1', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S' })],
        }),
      });
      await runCoordinationCheckIn(deps, { cwd: root, coordinationDir: testDir, instanceId: 'inst-1' });
      await vi.waitFor(async () => {
        const emptied = (await checkinEntries(root)).filter((entry) => entry.workItemId === null);
        expect(emptied[emptied.length - 1]).toMatchObject({
          reason: 'code-freeze',
          dominantGate: 'code-freeze',
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records the review-queue-hold token when the deep queue is the only reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-attrib-review-'));
    try {
      const deps = makeCoordinationDeps({
        getReviewQueueCount: vi.fn().mockResolvedValue(99),
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [headItem({ id: 'WL-R1', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S' })],
        }),
      });
      await runCoordinationCheckIn(deps, {
        cwd: root,
        coordinationDir: testDir,
        instanceId: 'inst-1',
        browseItemCount: 2,
      });
      await vi.waitFor(async () => {
        const emptied = (await checkinEntries(root)).filter((entry) => entry.workItemId === null);
        expect(emptied[emptied.length - 1]).toMatchObject({ reason: 'review-queue-hold' });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records the attempt-budget-exhausted token when the budget is the only reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-attrib-budget-'));
    try {
      const attempts = Array.from({ length: 3 }, () => ({
        kind: 'plan',
        operation: 'dispatch',
        itemId: 'WL-B1',
        stage: 'intake_complete',
        // Stale markers: the dispatched-marker exclusion only applies while
        // the marker is FRESH, so an old timestamp leaves the attempt budget
        // as the sole rejecting gate (the point of this pin).
        dispatchedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      }));
      writeDowntimeLog(root, attempts as never);
      const deps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [headItem({ id: 'WL-B1', stage: 'intake_complete', status: 'open' })],
        }),
        markNeedsProducerReview: vi.fn().mockResolvedValue(true),
      });
      await runCoordinationCheckIn(deps, {
        cwd: root,
        coordinationDir: testDir,
        instanceId: 'inst-1',
        maxAttempts: 3,
      });
      await vi.waitFor(async () => {
        const emptied = (await checkinEntries(root)).filter((entry) => entry.workItemId === null);
        expect(emptied[emptied.length - 1]).toMatchObject({ reason: 'attempt-budget-exhausted' });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records the in-flight-hold token when a live pane holds the only critical item', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-attrib-inflight-'));
    try {
      const deps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [
            headItem({
              id: 'WL-I1',
              stage: 'plan_complete',
              status: 'open',
              priority: 'critical',
              risk: 'Low',
              effort: 'S',
            }),
          ],
        }),
        getRunningDowntimePanes: vi.fn().mockResolvedValue({
          ok: true,
          count: 1,
          paneIds: ['w1:p1'],
          records: [
            {
              paneId: 'w1:p1',
              label: 'Downtime triggered implement Crit WL-I1 - WL-I1',
              agent: 'pi',
              agentStatus: 'working',
            },
          ],
        }),
      });
      await runCoordinationCheckIn(deps, { cwd: root, coordinationDir: testDir, instanceId: 'inst-1' });
      await vi.waitFor(async () => {
        const emptied = (await checkinEntries(root)).filter((entry) => entry.workItemId === null);
        expect(emptied[emptied.length - 1]).toMatchObject({ reason: 'in-flight-hold' });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC1: a wl error keeps the entry and still records the wl-error reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-attrib-wlerror-'));
    try {
      const deps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: false, error: 'wl exploded' }),
      });
      writeCoordinationFile(testDir, { version: 1, entries: [makeEntry('inst-1', 'WL-KEPT', root)] });
      const result = await runCoordinationCheckIn(deps, {
        cwd: root,
        coordinationDir: testDir,
        instanceId: 'inst-1',
      });
      expect(result).toEqual({ offered: 'WL-KEPT', updated: false });
      expect(getEntry(testDir, 'inst-1')?.workItemId).toBe('WL-KEPT');
      await vi.waitFor(async () => {
        const entries = await checkinEntries(root);
        expect(entries[entries.length - 1]).toMatchObject({
          reason: 'wl-error',
          workItemId: 'WL-KEPT',
          error: 'wl exploded',
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Leader per-offer rejection attribution (AC2) ───────────────────────
//
// Every coordination entry the leader rejects at dispatch time records its
// work item, its worklog root and the gate that rejected it, so the terminal
// reason can never collapse a starved offer list into a bare `no-candidate`.

describe('dispatchFromCoordination per-offer rejection attribution (WL-0MVR8FKMU009XTED)', () => {
  it('AC2: records every rejected offer with its root and gate; the reason is unchanged', async () => {
    const entry = makeEntry('inst-held', 'WL-HELD', '/roots/held');
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: itemInfo({ id: 'WL-HELD', status: 'open', stage: 'plan_complete', assignee: 'Map' }),
      }),
    });
    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
    });
    // Additive only: the terminal reason is exactly what it was before.
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(outcome.offerRejections).toEqual([
      { workItemId: 'WL-HELD', worklogRoot: '/roots/held', gate: 'assignee-hold', assignee: 'Map' },
    ]);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('AC3: an audit offer skipped by the slot budget is attributed as audit-slot-min', async () => {
    const entry = makeEntry('inst-audit', 'WL-AUD', '/roots/audit');
    // The offer must exist in the coordination file for the "entry kept"
    // assertion below to mean anything.
    writeCoordinationFile(testDir, { version: 1, entries: [entry] });
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: itemInfo({
          id: 'WL-AUD',
          status: 'completed',
          stage: 'in_review',
          updatedAt: new Date().toISOString(),
        }),
      }),
    });
    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 1, // raw slot budget below DOWNTIME_AUDIT_MIN_FREE_SLOTS
      effectiveFreeSlots: 1,
    });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.offerRejections).toEqual([
      { workItemId: 'WL-AUD', worklogRoot: '/roots/audit', gate: 'audit-slot-min' },
    ]);
    // The offer is KEPT (still valid once a slot frees up).
    expect(getEntry(testDir, 'inst-audit')).not.toBeNull();
  });

  it('AC2: a per-entry fetch failure is attributed as wl-error with its root', async () => {
    const entry = makeEntry('inst-broken', 'WL-BROKEN', '/roots/broken');
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: false, error: 'wl timeout' }),
    });
    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
    });
    expect(outcome.reason).toBe('wl-error');
    expect(outcome.offerRejections).toEqual([
      { workItemId: 'WL-BROKEN', worklogRoot: '/roots/broken', gate: 'wl-error' },
    ]);
  });
});

// ── Worker integration: leader vs non-leader (AC4) ────────────────────

function makeStatusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 4,
    total_slots: 4,
    // Per-slot detail is required under the fail-closed contract
    // (WL-0MUXVPXAZ005RESW).
    slots: [
      { slot_id: 'slot-1', is_processing: false },
      { slot_id: 'slot-2', is_processing: false },
      { slot_id: 'slot-3', is_processing: false },
      { slot_id: 'slot-4', is_processing: false },
    ],
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
  requiredFreeSlots?: number;
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
      requiredFreeSlots: opts.requiredFreeSlots ?? 1,
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

  it('AC2: the terminal decision records each rejected offer with its root and gate', async () => {
    // A peer offer held by the producer sentinel: the leader rejects it at
    // dispatch time. The decision log must name the offer and the gate
    // instead of collapsing it into a bare `no-candidate`.
    writeCoordinationFile(testDir, {
      version: 1,
      entries: [makeEntry('inst-peer', 'WL-HELD', '/roots/held')],
    });
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: itemInfo({ id: 'WL-HELD', status: 'open', stage: 'plan_complete', assignee: 'Map' }),
      }),
      recordDecision,
    });
    const { worker } = makeCoordWorker({
      coordinationDir: testDir,
      instanceId: 'inst-a',
      depsOverrides: deps,
    });
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    try {
      await worker.tick(); // election + first check-in (own head empty)
      await worker.tick(); // idle run starts
      vi.setSystemTime(10_000_000 + 60_001);
      await worker.tick(); // idle threshold met → dispatch attempt
      const terminal = recordDecision.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((entry) => entry.operation === 'no-dispatch')
        .find((entry) => entry.reason === 'no-candidate');
      expect(terminal).toBeDefined();
      expect(terminal?.offerRejections).toEqual([
        {
          workItemId: 'WL-HELD',
          worklogRoot: '/roots/held',
          gate: 'assignee-hold',
          assignee: 'Map',
        },
      ]);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
// (AC2) run the check-in BEFORE the cooldown gate and cancel the
// pause when a fresh re-offer lands.

describe('no-candidate cooldown in coordination mode (WL-0MTEZ4XZJ006Y9U7)', () => {
  it('does not pause when the coordination file is empty but the worklog still has candidates (AC1/AC3)', async () => {
    // Scenario from the live bug: ≥2 dispatchable candidates, N free slots,
    // single-entry coordination file. After the leader dispatches the entry
    // the file is EMPTY, so the next dispatch attempt returns no-candidate —
    // but the worklog still has a candidate (B), so the worker must NOT
    // enter the 60-min cooldown. WL-0MTMPSCL8000O45H: the owner re-offers
    // immediately after dispatch (entry-missing observer), so the second
    // dispatch arrives at the next idle threshold — not on the 4-min
    // boundary. Non-leaders stay at 5 min (WL-0MTMPSCL8000O45H, was 30 min
    // pre-WL-0MTMPSCL8000O45H, WL-0MTOCBP1D009P4U3).
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

      // WL-0MTMPSCL8000O45H: the owner re-offers B on its next tick (own
      // entry missing). The next idle threshold tick dispatches it — gap is
      // only one idle window, not the 4-min cadence. First dispatch resets
      // the idle clock, so the next dispatch needs a fresh threshold.
      vi.setSystemTime(T0 + 120_001);
      const second = await worker.tick(); // fresh idle run starts + immediate re-offer (own entry missing)
      expect(getEntry(testDir, 'inst-a')?.workItemId).toBe('WL-B'); // re-offer landed immediately
      vi.setSystemTime(T0 + 180_001);
      const attempt = await worker.tick(); // idle threshold met → dispatch B
      expect(attempt.dispatched).toBe(true);
      expect(worker.paused).toBe(false);
      const gap = (worker.lastDispatchAt ?? 0) - firstDispatchAt;
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

  // ── Peer-offer presence cancels the pause (parent WL-0MVP7QHUB003ZA2A
  // AC2/AC3) ──────────────────────────────────────────────────────────
  // Live incident (2026-10-26): leader `956ca7b9` had an EMPTY own root, so
  // its no-candidate probe found nothing and armed the 60-minute full stop
  // while ContextHub's offer (`WL-0MVK0UO3Q002TXW6`) sat in the shared file,
  // undispatched, for the rest of the pause. The probe answers only "is the
  // LEADER's own backlog empty?" — a peer entry holding a dispatchable item
  // is NOT an empty backlog, so the pause must never arm on that cycle, and
  // an offer appearing DURING a pause must cancel it at the leader's next
  // check-in (the check-in runs before the cooldown gate).
  //
  // RED WITNESS: both specs below are `it.fails` — today the peer entry is
  // invisible to the pause decision (own-root probe only), so the pause arms
  // and starves the offer. Feature 4 (WL-0MVP9UJ6S009LLK4) flips them.
  describe('peer-offer presence cancels the no-candidate pause (WL-0MVP7QHUB003ZA2A AC2/AC3)', () => {
    /** A second instance offering its own root's head. */
    const peerRoot = () => join(testDir, 'peer-root');

    it('does not pause when a peer entry holds a dispatchable offer while the own root is empty (AC2)', async () => {
      vi.useFakeTimers();
      const T0 = 40_000_000;
      vi.setSystemTime(T0);
      try {
        // The LEADER's own root is genuinely empty (no head to offer)…
        const deps = makeCoordinationDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
          fetchItem: vi.fn().mockResolvedValue({
            ok: true,
            info: itemInfo({ id: 'WL-PEER', status: 'open', stage: 'intake_complete' }),
          }),
          // The peer's offer is classified DISPATCHABLE, but its CAS claim is
          // lost this cycle (another pane won the race) — the offer is KEPT
          // (still valid) and the cycle ends `no-candidate` because the
          // leader's own root is empty. This is the exact starvation window:
          // a live offer exists yet this cycle yielded nothing.
          claimItem: vi.fn().mockResolvedValue({ ok: false, reason: 'stale' }),
        });
        // …while a PEER's entry holds a dispatchable item. Its claim is lost
        // this cycle (another pane won the CAS race), so the offer is KEPT
        // and the cycle ends `no-candidate` — the exact starvation window.
        writeCoordinationFile(testDir, {
          version: 1,
          entries: [makeEntry('inst-b', 'WL-PEER', peerRoot())],
        });
        const { worker } = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-a', depsOverrides: deps });

        await worker.tick(); // election + empty check-in
        expect(worker.isLeader).toBe(true);
        vi.setSystemTime(T0 + 60_001);
        const cycle = await worker.tick(); // no-candidate (own root empty)

        expect(cycle.dispatched).toBe(false);
        // The peer's offer survives the cycle — it is still dispatchable.
        expect(getEntry(testDir, 'inst-b')).not.toBeNull();
        // POST-FIX: a live peer offer means the pause must NOT arm (today it
        // does → RED), so the offer list keeps being polled.
        expect(worker.paused).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels a live pause at the next leader check-in when a peer offer appears, then dispatches it (AC3)', async () => {
      vi.useFakeTimers();
      const T0 = 50_000_000;
      vi.setSystemTime(T0);
      try {
        const deps = makeCoordinationDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
          fetchItem: vi.fn().mockResolvedValue({
            ok: true,
            info: itemInfo({ id: 'WL-PEER', status: 'open', stage: 'intake_complete' }),
          }),
        });
        const { worker } = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-a', depsOverrides: deps });

        // Genuinely nothing anywhere → the pause arms exactly as today.
        await worker.tick();
        vi.setSystemTime(T0 + 60_001);
        await worker.tick();
        expect(worker.paused).toBe(true);

        // A peer's offer appears WHILE the leader is paused.
        writeCoordinationFile(testDir, {
          version: 1,
          entries: [makeEntry('inst-b', 'WL-PEER', peerRoot())],
        });

        // The leader's next check-in (4-min cadence, WL-0MTOCBP1D009P4U3)
        // runs BEFORE the cooldown gate: a live peer entry must cancel the
        // pause (today the check-in only inspects the leader's OWN entry →
        // RED) and polling resumes immediately.
        vi.setSystemTime(T0 + 60_001 + 4 * 60_000 + 1_000);
        const resumed = await worker.tick();
        expect(resumed.polled).toBe(true);
        expect(worker.paused).toBe(false);

        // The peer's offer then dispatches after a fresh full idle period —
        // never starved for the 60-minute pause (the dispatch may land on the
        // resume tick itself or on the next threshold tick).
        vi.setSystemTime(T0 + 60_001 + 4 * 60_000 + 60_001 + 2_000);
        await worker.tick();
        expect(deps.spawnAgentPane).toHaveBeenCalledWith(
          expect.stringContaining('WL-PEER'),
          expect.objectContaining({ cwd: peerRoot() }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('still pauses when the only entry is the leader’s own (no peer offer) (AC2 discriminator)', async () => {
      vi.useFakeTimers();
      const T0 = 60_000_000;
      vi.setSystemTime(T0);
      try {
        const deps = makeCoordinationDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
          // The leader's own offer cannot be dispatched (lost CAS) → it is
          // KEPT, the cycle ends `no-candidate`, and a SELF entry must not
          // suppress the pause.
          fetchItem: vi.fn().mockResolvedValue({
            ok: true,
            info: itemInfo({ id: 'WL-OWN', status: 'open', stage: 'intake_complete' }),
          }),
          claimItem: vi.fn().mockResolvedValue({ ok: false, reason: 'stale' }),
        });
        const { worker } = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-a', depsOverrides: deps });

        // The leader's own check-in removes its own entry when it has
        // nothing to offer, so the SELF entry is written AFTER tick 1 — it
        // must then be present in the dispatch-time entry snapshot.
        await worker.tick();
        writeCoordinationFile(testDir, {
          version: 1,
          entries: [makeEntry('inst-a', 'WL-OWN', '/repo')],
        });
        vi.setSystemTime(T0 + 60_001);
        await worker.tick();

        expect(getEntry(testDir, 'inst-a')).not.toBeNull();
        expect(worker.paused).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
// Root cause B2: the gate originally lived only in the legacy tier chain (dead
// while the Herdr head is non-empty), so non-critical implements kept
// dispatching into a deep review queue. These tests pin the gate on the live
// leader path (`dispatchFromCoordination`) and the offer computation
// (`computeMostImportantItem` / `runCoordinationCheckIn`): audits (the queue
// drain), plan, intake and critical implements flow unconditionally; only
// NON-CRITICAL implement offers are held while the OWNING root's review queue
// is deep; a deep queue never pauses the worker (check-ins continue).

describe('review-queue depth gate — coordination leader path (WL-0MTTSWC1X005P4VD)', () => {
  const implementOffer = (id: string, priority?: string) =>
    itemInfo({ id, status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S', priority });

  it('AC1: an AUDIT offer dispatches while another root is deep (queue drain never gated)', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'WL-AUD') {
          return { ok: true, info: itemInfo({ id, status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString() }) };
        }
        return { ok: true, info: implementOffer(id) };
      }),
      // The IMPLEMENTING root's queue is deep; the audit root's is shallow.
      getReviewQueueCount: vi.fn().mockImplementation(async (root: string) =>
        root === '/impl-root' ? 999 : 0,
      ),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entries = [
      makeEntry('inst-aud', 'WL-AUD', '/audit-root'),
      makeEntry('inst-impl', 'WL-IMPL', '/impl-root'),
    ];
    // Seed the coordination file so entry removal/retention is observable.
    writeCoordinationFile(testDir, { version: 1, entries });
    const outcome = await dispatchFromCoordination(deps, entries, { model: 'plan', cwd: '/repo', coordinationDir: testDir, browseItemCount: 20 });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    const spawnCall = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(spawnCall).toContain('/skill:audit WL-AUD');
    // The held implement entry was NOT removed — it stays for a later cycle.
    expect(getEntry(testDir, 'inst-impl')).not.toBe(null);
  });

  it('AC2: a deep queue holds a NON-CRITICAL implement offer (entry kept) and reports review-queue-hold', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: implementOffer('WL-IMPL', 'high') }),
      getReviewQueueCount: vi.fn().mockResolvedValue(25),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entry = makeEntry('inst-impl', 'WL-IMPL', '/impl-root');
    writeCoordinationFile(testDir, { version: 1, entries: [entry] });
    const outcome = await dispatchFromCoordination(deps, [entry], { model: 'plan', cwd: '/repo', coordinationDir: testDir, browseItemCount: 20 });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('review-queue-hold');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // The offer is KEPT (the queue may drain at any moment; the next cycle
    // then dispatches it) — unlike a stale/frozen offer, a held offer is not
    // dropped.
    expect(getEntry(testDir, 'inst-impl')).not.toBe(null);
  });

  it('AC2: a CRITICAL implement offer dispatches even when the queue is deep', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: implementOffer('WL-CRIT', 'critical') }),
      getReviewQueueCount: vi.fn().mockResolvedValue(999),
    });
    const outcome = await dispatchFromCoordination(deps, [makeEntry('inst-crit', 'WL-CRIT', '/impl-root')], { model: 'plan', cwd: '/repo', coordinationDir: testDir, browseItemCount: 20 });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
  });

  it('AC2: a PLAN offer dispatches while the queue is deep', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-PLAN', status: 'open', stage: 'intake_complete' }) }),
      getReviewQueueCount: vi.fn().mockResolvedValue(999),
    });
    const outcome = await dispatchFromCoordination(deps, [makeEntry('inst-plan', 'WL-PLAN', '/impl-root')], { model: 'plan', cwd: '/repo', coordinationDir: testDir, browseItemCount: 20 });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('shallow queue: a non-critical implement offer dispatches unchanged', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: implementOffer('WL-IMPL', 'high') }),
      getReviewQueueCount: vi.fn().mockResolvedValue(19), // below threshold
    });
    const outcome = await dispatchFromCoordination(deps, [makeEntry('inst-impl', 'WL-IMPL', '/impl-root')], { model: 'plan', cwd: '/repo', coordinationDir: testDir, browseItemCount: 20 });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
  });

  it('fail-closed: a count-query failure (null) holds non-critical implements', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: implementOffer('WL-IMPL', 'high') }),
      getReviewQueueCount: vi.fn().mockResolvedValue(null),
    });
    const outcome = await dispatchFromCoordination(deps, [makeEntry('inst-impl', 'WL-IMPL', '/impl-root')], { model: 'plan', cwd: '/repo', coordinationDir: testDir, browseItemCount: 20 });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('review-queue-hold');
  });

  it('computeMostImportantItem: a deep queue holds a non-critical implement head → reviewQueueHold (never noCandidate)', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [headItem({ id: 'WL-IMP', title: 'Impl', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S', priority: 'high' })],
      }),
      getReviewQueueCount: vi.fn().mockResolvedValue(25),
    });
    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(true);
    expect('noCandidate' in result && result.noCandidate).toBe(false);
    expect('reviewQueueHold' in result && result.reviewQueueHold).toBe(true);
  });

  it('computeMostImportantItem: the next dispatchable head item is offered while the head implement is held', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [
          headItem({ id: 'WL-IMP', title: 'Impl', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S', priority: 'high', sortIndex: 10 }),
          headItem({ id: 'WL-AUD', title: 'Audit', status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString(), sortIndex: 20 }),
        ],
      }),
      getReviewQueueCount: vi.fn().mockResolvedValue(25),
    });
    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(true);
    if (!('candidate' in result)) throw new Error('expected a candidate');
    // The held implement is skipped; the deeper AUDIT (queue drain) is offered.
    expect(result.candidate.id).toBe('WL-AUD');
    expect(result.kind).toBe('audit');
  });

  it('computeMostImportantItem: a critical implement is still offered while the queue is deep', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [headItem({ id: 'WL-CRIT', title: 'Crit', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S', priority: 'critical' })],
      }),
      getReviewQueueCount: vi.fn().mockResolvedValue(999),
    });
    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(true);
    if (!('candidate' in result)) throw new Error('expected a candidate');
    expect(result.candidate.id).toBe('WL-CRIT');
    expect(result.kind).toBe('implement');
  });

  it('runCoordinationCheckIn: a reviewQueueHold result removes the own (unofferable) entry', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [headItem({ id: 'WL-IMP', title: 'Impl', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S', priority: 'high' })],
      }),
      getReviewQueueCount: vi.fn().mockResolvedValue(25),
    });
    writeCoordinationFile(testDir, { version: 1, entries: [makeEntry('inst-1', 'WL-OLD', '/repo')] });
    const result = await runCoordinationCheckIn(deps, { cwd: '/repo', coordinationDir: testDir, instanceId: 'inst-1', browseItemCount: 20 });
    expect(result.offered).toBe(null);
    expect(getEntry(testDir, 'inst-1')).toBe(null);
  });

  it('worker tick: a deep queue with only a held implement offer never pauses and keeps polling (AC2/AC3)', async () => {
    vi.useFakeTimers();
    const T0 = 40_000_000;
    vi.setSystemTime(T0);
    try {
      // The only coordination entry is a non-critical implement in a DEEP root.
      const entry = makeEntry('inst-impl', 'WL-IMPL', '/impl-root');
      writeCoordinationFile(testDir, { version: 1, entries: [entry] });
      const deps = makeCoordinationDeps({
        fetchItem: vi.fn().mockResolvedValue({ ok: true, info: implementOffer('WL-IMPL', 'high') }),
        getReviewQueueCount: vi.fn().mockResolvedValue(25),
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }), // nothing else offerable
      });
      const { worker } = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-lead', depsOverrides: deps });

      await worker.tick(); // election + check-in + first poll (idle run starts)
      expect(worker.isLeader).toBe(true);
      vi.setSystemTime(T0 + 60_001);
      const attempt = await worker.tick(); // threshold met → hold → review-queue-hold
      expect(attempt.dispatched).toBe(false);
      expect(attempt.polled).toBe(true);
      // NOT paused: a deep-queue hold is neutral (no no-candidate cooldown).
      expect(worker.paused).toBe(false);
      expect(worker.errorStrikes).toBe(0);
      // The offer is still there for a later cycle.
      expect(getEntry(testDir, 'inst-impl')).not.toBe(null);

      // The queue drains below the threshold → the very next idle tick
      // dispatches the previously-held implement (resume is immediate — the
      // neutral hold never reset the warm idle run).
      (deps.getReviewQueueCount as ReturnType<typeof vi.fn>).mockResolvedValue(10);
      vi.setSystemTime(T0 + 120_002);
      const resumed = await worker.tick();
      expect(resumed.dispatched).toBe(true);
      expect(worker.paused).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('worker tick: a deep queue never suppresses the coordination check-in (RCA root cause A regression)', async () => {
    vi.useFakeTimers();
    const T0 = 50_000_000;
    vi.setSystemTime(T0);
    try {
      const deps = makeCoordinationDeps({
        // The instance's own head holds a non-critical implement while deep
        // (head non-empty → offer computation consults the gate each check-in).
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [headItem({ id: 'WL-IMP', title: 'Impl', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S', priority: 'high' })],
        }),
        getReviewQueueCount: vi.fn().mockResolvedValue(25),
        fetchItem: vi.fn().mockResolvedValue({ ok: true, info: implementOffer('WL-IMP', 'high') }),
      });
      // An OLD entry already floats for this instance; with the queue deep
      // and its head a held non-critical implement, the check-in must REMOVE
      // it (nothing offerable) — but the removal only happens if the
      // check-in actually RAN (the sprint-complete auto-disable that halted
      // check-ins before leader-election is removed).
      writeCoordinationFile(testDir, { version: 1, entries: [makeEntry('inst-x', 'WL-OLD', '/repo')] });
      const { worker } = makeCoordWorker({ coordinationDir: testDir, instanceId: 'inst-x', depsOverrides: deps });

      // Tick 1: election + FIRST check-in still lands while the queue is deep.
      await worker.tick();
      expect(worker.isLeader).toBe(true);
      expect(worker.lastDispatchAt).toBe(null); // nothing dispatched — held
      // The check-in ran: the hold result removed the own (unofferable) entry
      // rather than floating a held implement.
      expect(getEntry(testDir, 'inst-x')).toBe(null); // own stale offer removed by the check-in
      // The worker is NOT disabled by queue depth — polling continues.
      vi.setSystemTime(T0 + 60_001);
      const attempt = await worker.tick();
      expect(attempt.polled).toBe(true);
      expect(worker.paused).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Critical-first offer on the coordination path (WL-0MU6UL3XY001M3VT) ──
// A critical item blocked by a NON-SAFETY filter (stale dispatched marker,
// review-queue depth hold) must still be OFFERED — otherwise the check-in
// floats a lower-priority head item and the leader never dispatches the
// critical work. Safety gates (needsProducerReview, code-freeze split-by-
// skill) still apply to the offer.

describe('critical-first offer on coordination path (WL-0MU6UL3XY001M3VT)', () => {
  const criticalHead = (id: string, sortIndex = 10): DowntimeHerdrItem =>
    headItem({ id, title: `Crit ${id}`, status: 'open', stage: 'plan_complete', priority: 'critical', risk: 'Low', effort: 'S', sortIndex });
  const nonCriticalHead = (id: string, sortIndex = 100): DowntimeHerdrItem =>
    headItem({ id, title: `Impl ${id}`, status: 'open', stage: 'plan_complete', priority: 'high', risk: 'Low', effort: 'S', sortIndex });

  it('computeMostImportantItem: a critical implement with a stale marker is still offered ahead of a non-critical head item', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [criticalHead('CR-1'), nonCriticalHead('IMP-1')],
      }),
    });
    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(true);
    if (!('candidate' in result)) throw new Error('expected a candidate');
    expect(result.candidate.id).toBe('CR-1');
    expect(result.kind).toBe('implement');
  });

  it('computeMostImportantItem: the lowest sortIndex critical item is offered first', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [
          criticalHead('CR-2', 20),
          criticalHead('CR-1', 10), // lower sortIndex → wins
        ],
      }),
    });
    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(true);
    if (!('candidate' in result)) throw new Error('expected a candidate');
    expect(result.candidate.id).toBe('CR-1');
  });

  it('computeMostImportantItem: needsProducerReview critical item is NOT offered (safety gate)', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [
          { ...criticalHead('CR-PR'), needsProducerReview: true },
          nonCriticalHead('IMP-1'),
        ],
      }),
    });
    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(true);
    if (!('candidate' in result)) throw new Error('expected a candidate');
    // Safety gate blocks the critical item; the non-critical head is offered.
    expect(result.candidate.id).toBe('IMP-1');
  });

  it('computeMostImportantItem: a frozen critical IMPLEMENT is not offered (split-by-skill), critical plan still is', async () => {
    const frozenDeps = makeCoordinationDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [
          criticalHead('CR-FREEZE-IMP'),
          headItem({ id: 'CR-FREEZE-PLAN', title: 'Crit plan', status: 'open', stage: 'intake_complete', priority: 'critical', sortIndex: 20 }),
        ],
      }),
    });
    const result = await computeMostImportantItem(frozenDeps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(true);
    if (!('candidate' in result)) throw new Error('expected a candidate');
    // Implement-kind critical paused by the freeze; plan-kind critical still offers.
    expect(result.candidate.id).toBe('CR-FREEZE-PLAN');
    expect(result.kind).toBe('plan');
  });
});

// ── Regression: one dispatch per in-flight critical item (F2) ──────────
// Parent WL-0MUBEZ6PE002WLP4 / F2 WL-0MUBVKS5I007LSWB (AC5.2).
//
// The coordination path has no dispatched-marker check at leader dispatch
// time (docs/dev/downtime-dispatcher.md), and `computeMostImportantItem`'s
// critical-first scan offers a critical item regardless of whether a pane for
// it is already working. When the item's status has reverted to `open` at its
// marker's stage (the H5 precondition confirmed by F1 WL-0MUBVKPLP006RRDJ),
// the offer is re-floated and the leader's CAS claim succeeds — a duplicate.
//
// These cases are RED for the in-flight variants before F4
// (WL-0MUBVKYH5009CGBI) lands and GREEN after; the suite asserts on OFFER and
// DISPATCH counts so a second cycle can never pass unnoticed.

describe('in-flight guard on the coordination offer path (WL-0MUBVKS5I007LSWB / AC5.2)', () => {
  const inFlightCritical = (id: string, sortIndex = 10): DowntimeHerdrItem =>
    headItem({ id, title: `Crit ${id}`, status: 'open', stage: 'plan_complete', priority: 'critical', risk: 'Low', effort: 'S', sortIndex });
  const fallbackNonCritical = (id: string, sortIndex = 100): DowntimeHerdrItem =>
    headItem({ id, title: `Impl ${id}`, status: 'open', stage: 'plan_complete', priority: 'high', risk: 'Low', effort: 'S', sortIndex });

  /** A live `working` downtime pane whose label suffix is the item id. */
  const livePaneFor = (itemId: string) => ({
    ok: true as const,
    count: 1,
    paneIds: ['w1:p1'],
    records: [
      {
        paneId: 'w1:p1',
        label: `Downtime triggered implement Crit ${itemId} - ${itemId}`,
        agent: 'pi',
        agentStatus: 'working',
      },
    ],
  });

  it(
    'AC5.2: an in-flight critical item is not offered by computeMostImportantItem; the non-critical fallback is chosen (RED pre-fix)',
    async () => {
      const deps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [inFlightCritical('CR-DUP'), fallbackNonCritical('IMP-1')],
        }),
        getRunningDowntimePanes: vi.fn().mockResolvedValue(livePaneFor('CR-DUP')),
      });

      const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);

      expect(result.ok).toBe(true);
      if (!('candidate' in result)) throw new Error('expected a candidate');
      // Post-fix: the in-flight critical is withheld, so the non-critical
      // fallback is offered instead (never an empty cycle).
      expect(result.candidate.id).toBe('IMP-1');
      expect(result.kind).toBe('implement');
    },
  );

  it(
    'AC5.2/AC2.10: the leader re-checks at dispatch time — an offer computed before the pane appeared is rejected (RED pre-fix)',
    async () => {
      const deps = makeCoordinationDeps({
        // The offer was computed while no pane existed (TOCTOU): the entry is
        // already on the offer list when the pane appears.
        fetchItem: vi.fn().mockResolvedValue({
          ok: true,
          info: itemInfo({ id: 'CR-DUP', status: 'open', stage: 'plan_complete', priority: 'critical', risk: 'Low', effort: 'S' }),
        }),
        getRunningDowntimePanes: vi.fn().mockResolvedValue(livePaneFor('CR-DUP')),
      });

      const outcome = await dispatchFromCoordination(
        deps,
        [makeEntry('inst-lead', 'CR-DUP', '/impl-root')],
        { model: 'plan', cwd: '/repo', coordinationDir: testDir },
      );

      // Post-fix: the leader's dispatch-time validation rejects the in-flight
      // offer — no pane, no duplicate.
      expect(outcome.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    },
  );

  it(
    'AC5.2: two consecutive owner/leader cycles over a critical item re-offered after dispatch dispatch exactly once',
    async () => {
      // Faithful two-cycle simulation of the H5 status revert: the owner
      // offers its critical head, the leader dispatches it, then the item's
      // status is observed `open` again at the same stage so the owner
      // RE-OFFERS it at the next check-in while the spawned pane is still
      // working. Pre-fix the leader re-dispatches; post-fix the in-flight
      // guard withholds the offer and the leader rejects the stale entry.
      const root = mkdtempSync(join(tmpdir(), 'herdr-coord-inflight-'));
      mkdirSync(join(root, '.worklog'), { recursive: true });
      try {
        // Cycle 1: no pane yet → the owner offers, the leader dispatches.
        writeCoordinationFile(testDir, {
          version: 1,
          entries: [makeEntry('inst-lead', 'CR-DUP', root)],
        });
        const deps = makeCoordinationDeps({
          fetchItem: vi.fn().mockResolvedValue({
            ok: true,
            info: itemInfo({ id: 'CR-DUP', status: 'open', stage: 'plan_complete', priority: 'critical', risk: 'Low', effort: 'S' }),
          }),
          getHerdrListHead: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, items: [inFlightCritical('CR-DUP')] })
            .mockResolvedValue({ ok: true, items: [inFlightCritical('CR-DUP')] }),
          // Cycle 1: no pane yet for BOTH the owner's offer and the leader's
          // re-check. Cycle 2+: the spawned pane is live and working.
          getRunningDowntimePanes: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
            .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
            .mockResolvedValue(livePaneFor('CR-DUP')),
        });

        // Cycle 1 — owner offers, leader dispatches.
        const offer1 = await computeMostImportantItem(deps, root, Date.now(), 20);
        expect('candidate' in offer1 && offer1.candidate.id).toBe('CR-DUP');
        writeCoordinationFile(testDir, {
          version: 1,
          entries: [makeEntry('inst-lead', 'CR-DUP', root)],
        });
        const first = await dispatchFromCoordination(
          deps,
          readCoordinationFile(testDir)?.entries ?? [],
          { model: 'plan', cwd: root, coordinationDir: testDir },
        );
        expect(first.dispatched).toBe(true);

        // Cycle 2 — the item is observed `open` again (H5): the owner
        // re-offers it, and the leader must reject the in-flight offer.
        const offer2 = await computeMostImportantItem(deps, root, Date.now(), 20);
        expect('candidate' in offer2).toBe(false); // withheld as in-flight
        writeCoordinationFile(testDir, {
          version: 1,
          entries: [makeEntry('inst-lead', 'CR-DUP', root)],
        });
        const second = await dispatchFromCoordination(
          deps,
          readCoordinationFile(testDir)?.entries ?? [],
          { model: 'plan', cwd: root, coordinationDir: testDir },
        );

        expect(second.dispatched).toBe(false);
        expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('AC2.7: only in-flight criticals remain → inFlightHold (not noCandidate, so the worker never pauses)', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [inFlightCritical('CR-ONLY')] }),
      getRunningDowntimePanes: vi.fn().mockResolvedValue(livePaneFor('CR-ONLY')),
    });

    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);

    expect(result.ok).toBe(true);
    expect('candidate' in result).toBe(false);
    expect('noCandidate' in result && result.noCandidate).toBe(false);
    expect('inFlightHold' in result && result.inFlightHold).toBe(true);
  });

  it('AC2.8: the pane query uses the OFFER\'s own root, never the leader root (cross-root invariant)', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [inFlightCritical('CR-CROSS')] }),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
    });

    await computeMostImportantItem(deps, '/offer-root', Date.now(), 20);

    // The in-flight query must target the offer's OWN worklog root.
    expect(deps.getRunningDowntimePanes).toHaveBeenCalledWith('/offer-root');
    expect(deps.getRunningDowntimePanes).not.toHaveBeenCalledWith('/leader-root');
  });

  it('AC2.10: the leader re-check queries the OFFER root (cross-root), not the leader root', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: itemInfo({ id: 'CR-CROSS', status: 'open', stage: 'plan_complete', priority: 'critical', risk: 'Low', effort: 'S' }),
      }),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
    });

    await dispatchFromCoordination(
      deps,
      [makeEntry('inst-x', 'CR-CROSS', '/offer-root')],
      { model: 'plan', cwd: '/leader-root', coordinationDir: testDir },
    );

    expect(deps.getRunningDowntimePanes).toHaveBeenCalledWith('/offer-root');
    expect(deps.getRunningDowntimePanes).not.toHaveBeenCalledWith('/leader-root');
  });

  it('AC6.1: a leader coordination dispatch records selectionPath=coordination-offer', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: itemInfo({ id: 'WL-COORD', status: 'open', stage: 'plan_complete', priority: 'critical', risk: 'Low', effort: 'S' }),
      }),
      recordDispatch: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchFromCoordination(
      deps,
      [makeEntry('inst-lead', 'WL-COORD', '/offer-root')],
      { model: 'plan', cwd: '/leader-root', coordinationDir: testDir },
    );

    expect(outcome.dispatched).toBe(true);
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ selectionPath: 'coordination-offer', selectionReason: 'leader-offer' }),
    );
  });

  it('AC2.3: a terminal (`done`) pane for the item does NOT block the offer (no idle-pane deadlock)', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [inFlightCritical('CR-DONE')],
      }),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({
        ok: true,
        count: 0,
        paneIds: [],
        records: [
          {
            paneId: 'w1:p9',
            label: 'Downtime triggered implement Crit CR-DONE - CR-DONE',
            agent: 'pi',
            agentStatus: 'done',
          },
        ],
      }),
    });

    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);

    expect(result.ok).toBe(true);
    if (!('candidate' in result)) throw new Error('expected a candidate');
    expect(result.candidate.id).toBe('CR-DONE');
    expect(result.kind).toBe('implement');
  });
});

// ── Own-backlog fallback — leader selection contract (WL-0MUZPBQQ3001DAM6) ──
// Parent WL-0MUU4XFU90008E24: when the sprint-view head yields no dispatchable
// candidate, the coordination-mode leader MAY fall back to its OWN worklog
// backlog (items beyond the sprint-view window). This child pins the SELECTION
// contract only (parent AC1, AC2, AC3, AC9):
//
//   * it dispatches an eligible non-critical item that sits beyond the live
//     sprint-view window in the LEADER'S OWN root;
//   * it never reads another instance's/root's hidden backlog (own `cwd` only);
//   * it preserves the canonical ranking (the same `getHerdrListHead` order —
//     a bounded window extension, never a second ranking);
//   * the fallback window is bounded by `DOWNTIME_DISPATCH_EXTEND_MAX`;
//   * it fails open (a `{ok:false}`/throwing/empty lookup leaves the original
//     terminal reason unchanged).
//
// RED WITNESS. The fallback does not exist yet, so every body asserts the
// post-implementation behaviour and is committed with `it.fails` — the suite
// stays GREEN while the assertions are RED (the repo's documented TDD pattern;
// see `docs/dev/downtime-dispatcher-post-fix-verification.md`). The
// implementation child WL-0MUUZPBSYW004I5D3 flips each `it.fails` to `it` once
// the fallback lands (the RED→GREEN transition is the dependency evidence).
describe('own-backlog fallback — leader selection contract (WL-0MUZPBQQ3001DAM6)', () => {
  // The live sprint-view window used by every case (== DEFAULT_BROWSE_ITEM_COUNT).
  const SPRINT = 20;

  /** A full in-view head whose every item is filtered by the producer-review gate. */
  const filteredInView = (): DowntimeHerdrItem[] =>
    Array.from({ length: SPRINT }, (_, i) =>
      headItem({
        id: `WL-VIEW-${String(i).padStart(2, '0')}`,
        title: `Filtered in-view ${i}`,
        status: 'open',
        stage: 'plan_complete',
        priority: 'high',
        risk: 'Low',
        effort: 'S',
        needsProducerReview: true,
        sortIndex: i,
      }),
    );

  /** An eligible, dispatchable non-critical implement item. */
  const eligibleBacklog = (id: string, sortIndex = 1000): DowntimeHerdrItem =>
    headItem({
      id,
      title: `Backlog ${id}`,
      status: 'open',
      stage: 'plan_complete',
      priority: 'high',
      risk: 'Low',
      effort: 'S',
      sortIndex,
    });

  /**
   * Leader-own-root `getHerdrListHead` mock modelling the canonical ranking:
   * a window at/below the sprint view returns only the filtered head; a larger
   * window returns the filtered head followed by the ranked out-of-view tail.
   */
  const rankedOwnRoot = (
    tail: readonly DowntimeHerdrItem[],
    inView: DowntimeHerdrItem[] = filteredInView(),
  ) =>
    vi.fn(async (_cwd: string, limit = SPRINT) => ({
      ok: true as const,
      items: limit <= SPRINT ? inView : [...inView, ...tail],
    }));

  const dispatch = (deps: DowntimeWorkerDeps, entries: CoordinationEntry[] = []) =>
    dispatchFromCoordination(deps, entries, {
      model: 'plan',
      cwd: '/leader-root',
      coordinationDir: testDir,
      browseItemCount: SPRINT,
    });

  it(
    'AC1: dispatches an eligible non-critical item beyond the sprint-view window from the leader own root',
    async () => {
      const getHerdrListHead = rankedOwnRoot([eligibleBacklog('WL-BACKLOG-1')]);
      const deps = makeCoordinationDeps({ getHerdrListHead });

      const outcome = await dispatch(deps);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('WL-BACKLOG-1');
      // Dispatched against the leader's OWN root (claim + spawn cwd).
      expect(deps.claimItem).toHaveBeenCalledWith('WL-BACKLOG-1', expect.anything(), '/leader-root');
      expect(deps.spawnAgentPane).toHaveBeenCalledWith(
        expect.stringContaining('/skill:implement WL-BACKLOG-1'),
        expect.objectContaining({ cwd: '/leader-root' }),
      );
    },
  );

  it(
    'AC4: an own-backlog dispatch forwards the settings-default preference (remote-ok) to the pane',
    async () => {
      // `index.ts` supplies `loadSettings().downtimeLocalPreference`, so with
      // no key persisted the settings default reaches the own-backlog pane
      // (WL-0MVNUHWH500196K1 AC4).
      expect(defaultSettings.downtimeLocalPreference).toBe('remote-ok');
      const getHerdrListHead = rankedOwnRoot([eligibleBacklog('WL-BACKLOG-PREF')]);
      const deps = makeCoordinationDeps({ getHerdrListHead });

      const outcome = await dispatchFromCoordination(deps, [], {
        model: 'plan',
        cwd: '/leader-root',
        coordinationDir: testDir,
        browseItemCount: SPRINT,
        localPreference: defaultSettings.downtimeLocalPreference,
      });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-BACKLOG-PREF');
      expect(deps.spawnAgentPane).toHaveBeenCalledWith(
        expect.stringContaining('/skill:implement WL-BACKLOG-PREF'),
        expect.objectContaining({ localPreference: 'remote-ok' }),
      );
    },
  );

  it(
    'AC5: an explicit local-preferred setting is forwarded verbatim by the own-backlog fallback',
    async () => {
      const getHerdrListHead = rankedOwnRoot([eligibleBacklog('WL-BACKLOG-LOCAL')]);
      const deps = makeCoordinationDeps({ getHerdrListHead });

      const outcome = await dispatchFromCoordination(deps, [], {
        model: 'plan',
        cwd: '/leader-root',
        coordinationDir: testDir,
        browseItemCount: SPRINT,
        localPreference: 'local-preferred',
      });

      expect(outcome.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledWith(
        expect.stringContaining('/skill:implement WL-BACKLOG-LOCAL'),
        expect.objectContaining({ localPreference: 'local-preferred' }),
      );
    },
  );

  it(
    'AC1: falls back when every in-view item is filtered, not only when the view is literally empty',
    async () => {
      const getHerdrListHead = rankedOwnRoot([eligibleBacklog('WL-FILTERED-BACKLOG')]);
      const deps = makeCoordinationDeps({ getHerdrListHead });

      const outcome = await dispatch(deps);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-FILTERED-BACKLOG');
      // The leader's own root was read at all (own-root scope).
      expect(getHerdrListHead).toHaveBeenCalledWith('/leader-root', expect.any(Number));
    },
  );

  it(
    'AC2: reads only the leader own root — another root hidden backlog is never selected',
    async () => {
      const getHerdrListHead = vi.fn(async (cwd: string, limit = SPRINT) => ({
        ok: true as const,
        items:
          limit <= SPRINT
            ? filteredInView()
            : [
                ...filteredInView(),
                ...(cwd === '/leader-root'
                  ? [eligibleBacklog('WL-OWN-BACKLOG')]
                  : [eligibleBacklog('WL-OTHER-BACKLOG')]),
              ],
      }));
      const deps = makeCoordinationDeps({
        getHerdrListHead,
        // The other root's coordination offer is stale/non-dispatchable, so
        // nothing from the offer list survives and the fallback must run.
        fetchItem: vi.fn().mockResolvedValue({
          ok: true,
          info: itemInfo({ id: 'WL-OTHER-ITEM', status: 'in_progress', stage: 'in_progress' }),
        }),
      });

      const outcome = await dispatch(deps, [makeEntry('inst-other', 'WL-OTHER-ITEM', '/other-root')]);

      expect(outcome.candidate?.id).toBe('WL-OWN-BACKLOG');
      expect(outcome.candidate?.id).not.toBe('WL-OTHER-BACKLOG');
      // The fallback lookup is never issued against another root.
      expect(getHerdrListHead).not.toHaveBeenCalledWith('/other-root', expect.any(Number));
    },
  );

  it(
    'AC3: preserves canonical ranking order (first ranked eligible wins, not id/insertion order)',
    async () => {
      // Canonical ranking places WL-RANK-Z ahead of WL-RANK-A.
      const getHerdrListHead = rankedOwnRoot([
        eligibleBacklog('WL-RANK-Z', 1000),
        eligibleBacklog('WL-RANK-A', 2000),
      ]);
      const deps = makeCoordinationDeps({ getHerdrListHead });

      const outcome = await dispatch(deps);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-RANK-Z');
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    },
  );

  it(
    'AC3: skips a ranked out-of-view item blocked by a safety gate and dispatches the next eligible',
    async () => {
      const getHerdrListHead = rankedOwnRoot([
        headItem({
          id: 'WL-RANK-GATED',
          status: 'open',
          stage: 'plan_complete',
          priority: 'high',
          risk: 'Low',
          effort: 'S',
          needsProducerReview: true,
          sortIndex: 1000,
        }),
        eligibleBacklog('WL-RANK-ELIGIBLE', 2000),
      ]);
      const deps = makeCoordinationDeps({ getHerdrListHead });

      const outcome = await dispatch(deps);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-RANK-ELIGIBLE');
    },
  );

  it(
    'AC9: the fallback window grows geometrically and is capped by the round bound',
    async () => {
      const getHerdrListHead = rankedOwnRoot([eligibleBacklog('WL-BOUNDED')]);
      const deps = makeCoordinationDeps({ getHerdrListHead });

      await dispatch(deps);

      const limits = (getHerdrListHead as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[1] as number,
      );
      expect(limits.length).toBeGreaterThan(0);
      // WL-0MW9XS0XR007K1TH AC2 supersedes the bounded critical-only extension:
      // the fallback walks the WHOLE ranked backlog, so one geometry step
      // legitimately exceeds `SPRINT + DOWNTIME_DISPATCH_EXTEND_MAX`.
      // What must hold is that the walk is a growing window over the SAME
      // ranking path, and that it stays bounded by the round cap.
      expect(limits[0]).toBe(SPRINT);
      expect(limits[1]).toBeGreaterThanOrEqual(SPRINT + DOWNTIME_DISPATCH_EXTEND_MAX);
      expect(limits.length).toBeLessThanOrEqual(DOWNTIME_DISPATCH_EXTEND_MAX_ROUNDS + 1);
    },
  );

  it(
    'AC9 fail-open: a {ok:false} own-root lookup leaves the original terminal reason unchanged',
    async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: false, error: 'boom' });
      const deps = makeCoordinationDeps({ getHerdrListHead });

      const outcome = await dispatch(deps);

      expect(getHerdrListHead).toHaveBeenCalledWith('/leader-root', expect.any(Number));
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    },
  );

  it(
    'AC9 fail-open: a throwing own-root lookup leaves the original terminal reason unchanged',
    async () => {
      const getHerdrListHead = vi.fn().mockRejectedValue(new Error('boom'));
      const deps = makeCoordinationDeps({ getHerdrListHead });

      const outcome = await dispatch(deps);

      expect(getHerdrListHead).toHaveBeenCalledWith('/leader-root', expect.any(Number));
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
    },
  );

  it(
    'AC9 fail-open: an empty fallback tail leaves the original terminal reason unchanged',
    async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [] });
      const deps = makeCoordinationDeps({ getHerdrListHead });

      const outcome = await dispatch(deps);

      expect(getHerdrListHead).toHaveBeenCalledWith('/leader-root', expect.any(Number));
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
    },
  );

  // ── Leadership step-down surface (WL-0MUZPBRX3007STFK) ───────────────
  //
  // `dispatchFromCoordination` does NOT own the leader-election manager (the
  // worker loop does, `downtime-worker.ts`), so it cannot call
  // `releaseLeadership()` itself. Instead it surfaces a machine-readable
  // `ownBacklogDispatch` flag on the outcome — the worker loop steps down
  // exactly once per successful own-backlog dispatch, and never for a normal
  // in-view dispatch (parent AC4). These tests pin that surface; the
  // worker-level `releaseLeadership()` call-count and the next-tick
  // non-leader observation are pinned in `downtime-worker.test.ts` /
  // `integration-leader-dispatch.test.ts`.

  /**
   * Read the step-down surface without a compile-time dependency on the
   * (not-yet-declared) field — this test item changes no production code, so
   * the flag is read through a narrow structural cast rather than widening
   * `DowntimeDispatchOutcome` here.
   */
  const hasOwnBacklogFlag = (outcome: { dispatched: boolean }): boolean =>
    (outcome as { ownBacklogDispatch?: boolean }).ownBacklogDispatch === true;

  it(
    'step-down surface AC1: a successful own-backlog dispatch flags ownBacklogDispatch',
    async () => {
      const getHerdrListHead = rankedOwnRoot([eligibleBacklog('WL-BACKLOG-STEPDOWN')]);
      const deps = makeCoordinationDeps({ getHerdrListHead });

      const outcome = await dispatch(deps);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-BACKLOG-STEPDOWN');
      // The stage-appropriate dispatch completes before the surface is set.
      expect(deps.claimItem).toHaveBeenCalled();
      expect(deps.recordDispatch).toHaveBeenCalled();
      expect(deps.spawnAgentPane).toHaveBeenCalled();
      expect(hasOwnBacklogFlag(outcome)).toBe(true);
    },
  );

  it(
    'step-down surface AC2: a normal in-view (offer-list) dispatch does NOT flag ownBacklogDispatch',
    async () => {
      // An eligible offer in the shared list — the dispatch never reaches the
      // own-backlog fallback, so no step-down is surfaced.
      const deps = makeCoordinationDeps({
        fetchItem: vi.fn().mockResolvedValue({
          ok: true,
          info: itemInfo({ id: 'WL-INVIEW', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }),
        }),
      });

      const outcome = await dispatch(deps, [makeEntry('inst-inview', 'WL-INVIEW', '/leader-root')]);

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(hasOwnBacklogFlag(outcome)).toBe(false);
      // The own-root fallback read never ran.
      expect(deps.getHerdrListHead).not.toHaveBeenCalled();
    },
  );

  it(
    'step-down surface AC3: when the fallback finds no eligible item no step-down is surfaced and the reason is unchanged',
    async () => {
      // The only out-of-view item is blocked by a safety gate (producer
      // review) — the fallback finds nothing to dispatch, so leadership must
      // be retained and the pre-existing terminal reason reported.
      const gatedTail = headItem({
        id: 'WL-OOV-GATED',
        status: 'open',
        stage: 'plan_complete',
        priority: 'high',
        risk: 'Low',
        effort: 'S',
        needsProducerReview: true,
        sortIndex: 1000,
      });
      const getHerdrListHead = vi.fn(async (_cwd: string, limit = SPRINT) => ({
        ok: true as const,
        items: limit <= SPRINT ? filteredInView() : [...filteredInView(), gatedTail],
      }));
      const deps = makeCoordinationDeps({ getHerdrListHead });

      const outcome = await dispatch(deps);

      // The fallback was attempted (post-implementation) — RED before it lands.
      expect(getHerdrListHead).toHaveBeenCalledWith('/leader-root', expect.any(Number));
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
      expect(hasOwnBacklogFlag(outcome)).toBe(false);
      expect(deps.claimItem).not.toHaveBeenCalled();
    },
  );
});

// ── Audit-batch coordination continuation (parent AC4/AC6e/f) ────────
//
// Test-first specs for the coordination-mode half of the depth-aware audit
// batch (parent WL-0MVEDM8OT007WDRS AC3/AC4/AC6). On the production leader
// path the continuation target comes from the leader's OWN Herdr head (the
// existing bounded own-backlog window extension — never a second ranking):
//
//  - AC4: the leader does NOT release leadership mid-batch; the own-backlog
//    hand-off (`ownBacklogDispatch` -> worker `releaseLeadership()`) is
//    deferred until the batch ends (cap reached / depth dropped).
//  - AC6f: each continuation selects a DISTINCT item (dispatched-marker
//    exclusion applies exactly as in a fresh dispatch).
//  - AC3: any non-`dispatched` outcome ends the batch — no continuation
//    metadata and no leadership hand-off.
//
// These bodies were committed RED under `it.fails` by WL-0MVFE0T0M009ZCPM and
// flipped to `it` by the implementation child WL-0MVFE1DD8000D8T2 (see
// `docs/dev/downtime-dispatcher-post-fix-verification.md`). The
// `ownBacklogDispatch` field is read through a narrow structural cast (the
// same pattern as the step-down surface tests above).
describe('audit-batch coordination continuation (parent AC4/AC6e/f)', () => {
  /** Sprint-view window used by the leader-own-head continuation specs. */
  const BATCH_SPRINT = 2;

  /** True when the outcome asks the worker loop to step down leadership. */
  const ownBacklogFlag = (outcome: { dispatched: boolean }): boolean =>
    (outcome as { ownBacklogDispatch?: boolean }).ownBacklogDispatch === true;

  const auditInfo = (id: string) =>
    itemInfo({
      id,
      status: 'completed',
      stage: 'in_review',
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });

  const auditHead = (id: string, sortIndex = 0): DowntimeHerdrItem =>
    headItem({
      id,
      status: 'completed',
      stage: 'in_review',
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      sortIndex,
    });

  const dispatchBatch = (
    deps: DowntimeWorkerDeps,
    entries: CoordinationEntry[] = [],
    auditBatchRemaining?: number,
  ) =>
    dispatchFromCoordination(deps, entries, {
      model: 'plan',
      cwd: '/leader-root',
      coordinationDir: testDir,
      browseItemCount: BATCH_SPRINT,
      auditBatchMax: 3,
      ...(auditBatchRemaining !== undefined ? { auditBatchRemaining } : {}),
    });

  it('AC4: a continuation comes from the leader own head and does NOT hand off leadership mid-batch', async () => {
    // Continuation targets live beyond the sprint view (the own-backlog
    // window extension); a mutation lets each continuation see the next
    // distinct target.
    const tail = [auditHead('WL-AUD-2', 1), auditHead('WL-AUD-3', 2)];
    const getHerdrListHead = vi.fn(async (_cwd: string, limit = BATCH_SPRINT) => ({
      ok: true as const,
      items: limit <= BATCH_SPRINT ? [] : [...tail],
    }));
    const deps = makeCoordinationDeps({
      getHerdrListHead,
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: auditInfo('WL-AUD-1') }),
    });

    // First audit comes from the coordination OFFER list.
    const first = await dispatchBatch(deps, [makeEntry('inst-audit', 'WL-AUD-1', '/leader-root')]);
    expect(first.dispatched).toBe(true);
    expect(first.kind).toBe('audit');
    expect(first.candidate?.id).toBe('WL-AUD-1');
    expect(first.auditBatch?.remaining).toBe(2);
    expect(ownBacklogFlag(first)).toBe(false);

    // Continuation #1 — sourced from the leader's OWN head extension.
    // The dispatched target leaves the head, so the next read sees the next
    // distinct item (the shift models the work item leaving the sprint view
    // once it is claimed by the dispatched pane).
    const second = await dispatchBatch(deps, [], 2);
    expect(second.dispatched).toBe(true);
    expect(second.candidate?.id).toBe('WL-AUD-2');
    expect(second.auditBatch?.remaining).toBe(1);
    // AC4: still mid-batch — leadership is NOT handed off yet.
    expect(ownBacklogFlag(second)).toBe(false);

    // Continuation #2 consumes the cap -> batch ends -> hand off ONCE.
    tail.shift(); // WL-AUD-2 was just dispatched
    const third = await dispatchBatch(deps, [], 1);
    expect(third.dispatched).toBe(true);
    expect(third.candidate?.id).toBe('WL-AUD-3');
    expect(third.auditBatch?.remaining).toBe(0);
    expect(ownBacklogFlag(third)).toBe(true);
  });

  it('AC4: every audit-batch continuation pane carries the settings-default preference (remote-ok)', async () => {
    // Two ranked audits beyond the sprint view keep the batch armed
    // (depth >= threshold); the first seed comes from the coordination offer.
    const tail = [auditHead('WL-AUD-2P', 1), auditHead('WL-AUD-3P', 2)];
    const getHerdrListHead = vi.fn(async (_cwd: string, limit = BATCH_SPRINT) => ({
      ok: true as const,
      items: limit <= BATCH_SPRINT ? [] : [...tail],
    }));
    const deps = makeCoordinationDeps({
      getHerdrListHead,
      // The offered item must classify as an AUDIT (the batch seed).
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: auditInfo('WL-AUD-1P') }),
    });

    const first = await dispatchFromCoordination(
      deps,
      [makeEntry('inst-audit', 'WL-AUD-1P', '/leader-root')],
      {
        model: 'plan',
        cwd: '/leader-root',
        coordinationDir: testDir,
        browseItemCount: BATCH_SPRINT,
        auditBatchMax: 3,
        localPreference: defaultSettings.downtimeLocalPreference,
      },
    );
    expect(first.dispatched).toBe(true);
    expect(first.kind).toBe('audit');
    expect(first.auditBatch?.remaining).toBe(2);

    // Continuation from the leader's own head consumes one unit of budget.
    const second = await dispatchFromCoordination(deps, [], {
      model: 'plan',
      cwd: '/leader-root',
      coordinationDir: testDir,
      browseItemCount: BATCH_SPRINT,
      auditBatchMax: 3,
      auditBatchRemaining: 2,
      localPreference: defaultSettings.downtimeLocalPreference,
    });
    expect(second.dispatched).toBe(true);
    expect(second.candidate?.id).toBe('WL-AUD-2P');
    expect(second.auditBatch?.remaining).toBe(1);

    // Both the first audit pane and the continuation carry the default.
    const spawnCalls = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls;
    expect(spawnCalls).toHaveLength(2);
    for (const call of spawnCalls) {
      expect((call[1] as { localPreference?: string }).localPreference).toBe('remote-ok');
    }
  });

  it('AC6f: a dispatched marker in the leader own head prevents a duplicate continuation target', async () => {
    // The leader root is a REAL temp dir so the dispatch log marker is read.
    const leaderRoot = testDir;
    writeDowntimeLog(leaderRoot, [
      {
        itemId: 'WL-AUD-DUP',
        kind: 'audit',
        dispatchedAt: new Date().toISOString(),
        stage: 'in_review',
      },
    ]);
    const getHerdrListHead = vi.fn(async (_cwd: string, limit = BATCH_SPRINT) => ({
      ok: true as const,
      items: limit <= BATCH_SPRINT ? [] : [auditHead('WL-AUD-DUP', 1), auditHead('WL-AUD-NEXT', 2)],
    }));
    const deps = makeCoordinationDeps({ getHerdrListHead });

    const outcome = await dispatchFromCoordination(deps, [], {
      model: 'plan',
      cwd: leaderRoot,
      coordinationDir: testDir,
      browseItemCount: BATCH_SPRINT,
      auditBatchMax: 3,
      auditBatchRemaining: 2,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('WL-AUD-NEXT'); // never the dispatched duplicate
    expect(outcome.auditBatch?.remaining).toBe(1);
  });

  it('AC3: a failed CAS claim ends the batch (no continuation metadata, no hand-off)', async () => {
    const getHerdrListHead = vi.fn(async (_cwd: string, limit = BATCH_SPRINT) => ({
      ok: true as const,
      items: limit <= BATCH_SPRINT ? [] : [auditHead('WL-AUD-CLAIM', 1)],
    }));
    const deps = makeCoordinationDeps({
      getHerdrListHead,
      claimItem: vi.fn().mockResolvedValue({ ok: false, reason: 'stale' }),
    });

    const outcome = await dispatchBatch(deps, [], 2);

    expect(outcome.dispatched).toBe(false);
    expect(ownBacklogFlag(outcome)).toBe(false);
    // The batch is over after any non-dispatched outcome.
    expect(outcome.auditBatch?.active).toBe(false);
  });

  it('AC3/AC4: the batch-local exclusion set prevents re-selecting an item dispatched in this batch', async () => {
    // No dispatched marker exists for WL-AUD-DONE: the batch-local set alone
    // must exclude it, so a continuation can never re-seed the same item even
    // before its marker round-trips through the downtime log.
    const getHerdrListHead = vi.fn(async (_cwd: string, limit = BATCH_SPRINT) => ({
      ok: true as const,
      items: limit <= BATCH_SPRINT ? [] : [auditHead('WL-AUD-DONE', 1), auditHead('WL-AUD-FRESH', 2)],
    }));
    const deps = makeCoordinationDeps({ getHerdrListHead });

    const outcome = await dispatchFromCoordination(deps, [], {
      model: 'plan',
      cwd: '/leader-root',
      coordinationDir: testDir,
      browseItemCount: BATCH_SPRINT,
      auditBatchMax: 3,
      auditBatchRemaining: 2,
      auditBatchDispatchedIds: ['WL-AUD-DONE'],
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('WL-AUD-FRESH');
    expect(outcome.auditBatchContinuation).toBe(true);
    expect(outcome.auditBatch?.remaining).toBe(1);
    // Mid-batch continuation -> leadership is NOT handed off yet (AC4).
    expect(ownBacklogFlag(outcome)).toBe(false);
  });
});

// ── Priority-aware locality preference across dispatch paths ───────────
// WL-0MVNUIW77000VYAX AC4: the preference is resolved ONCE at the dispatch
// boundary, so the coordination offer, the own-backlog fallback and the
// audit-batch continuation all inherit the same rule.
describe('priority-aware locality preference at every dispatch path (WL-0MVNUIW77000VYAX AC4)', () => {
  const SPRINT = 20;

  const filteredInView = (): DowntimeHerdrItem[] =>
    Array.from({ length: SPRINT }, (_, i) =>
      headItem({
        id: `WL-VIEW-PREF-${String(i).padStart(2, '0')}`,
        status: 'open',
        stage: 'plan_complete',
        priority: 'high',
        risk: 'Low',
        effort: 'S',
        needsProducerReview: true,
        sortIndex: i,
      }),
    );

  const backlogAt = (id: string, priority: string): DowntimeHerdrItem =>
    headItem({
      id,
      status: 'open',
      stage: 'plan_complete',
      priority,
      risk: 'Low',
      effort: 'S',
      sortIndex: 1000,
    });

  const rankedOwnRoot = (tail: readonly DowntimeHerdrItem[]) =>
    vi.fn(async (_cwd: string, limit = SPRINT) => ({
      ok: true as const,
      items: limit <= SPRINT ? filteredInView() : [...filteredInView(), ...tail],
    }));

  it('AC4: a coordination offer resolves from the offered item priority', async () => {
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: itemInfo({
          id: 'WL-OFFER-LOW',
          status: 'open',
          stage: 'plan_complete',
          priority: 'low',
          risk: 'Low',
          effort: 'S',
        }),
      }),
    });

    const outcome = await dispatchFromCoordination(
      deps,
      [makeEntry('inst-low', 'WL-OFFER-LOW', '/offer-root')],
      {
        model: 'plan',
        cwd: '/leader-root',
        coordinationDir: testDir,
        localPreferenceMode: 'priority-rule',
      },
    );

    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:implement WL-OFFER-LOW'),
      expect.objectContaining({ localPreference: 'local-preferred' }),
    );
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionPath: 'coordination-offer',
        localPreference: 'local-preferred',
        localPreferenceReason: 'priority-low',
      }),
    );
  });

  it('AC4: the own-backlog fallback applies the same rule to a low-priority item', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: rankedOwnRoot([backlogAt('WL-BACKLOG-LOW', 'low')]),
    });

    const outcome = await dispatchFromCoordination(deps, [], {
      model: 'plan',
      cwd: '/leader-root',
      coordinationDir: testDir,
      browseItemCount: SPRINT,
      localPreferenceMode: 'priority-rule',
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('WL-BACKLOG-LOW');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:implement WL-BACKLOG-LOW'),
      expect.objectContaining({ localPreference: 'local-preferred' }),
    );
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionPath: 'own-backlog',
        localPreference: 'local-preferred',
        localPreferenceReason: 'priority-low',
      }),
    );
  });

  it('AC4/AC5: an audit-batch continuation with no priority records the default reason', async () => {
    const BATCH_SPRINT = 2;
    const auditHead = (id: string, sortIndex = 0): DowntimeHerdrItem =>
      headItem({
        id,
        status: 'completed',
        stage: 'in_review',
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        sortIndex,
      });
    const tail = [auditHead('WL-AUD-PREF-2', 1), auditHead('WL-AUD-PREF-3', 2)];
    const getHerdrListHead = vi.fn(async (_cwd: string, limit = BATCH_SPRINT) => ({
      ok: true as const,
      items: limit <= BATCH_SPRINT ? [] : [...tail],
    }));
    const deps = makeCoordinationDeps({
      getHerdrListHead,
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: itemInfo({
          id: 'WL-AUD-PREF-1',
          status: 'completed',
          stage: 'in_review',
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      }),
    });

    const opts = {
      model: 'plan',
      cwd: '/leader-root',
      coordinationDir: testDir,
      browseItemCount: BATCH_SPRINT,
      auditBatchMax: 3,
      localPreferenceMode: 'priority-rule' as const,
    };
    const first = await dispatchFromCoordination(deps, [], {
      ...opts,
      auditBatchRemaining: 2,
    });

    expect(first.dispatched).toBe(true);
    expect(first.candidate?.id).toBe('WL-AUD-PREF-2');
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'WL-AUD-PREF-2',
        localPreference: 'remote-ok',
        localPreferenceReason: 'default',
      }),
    );
  });
});

// ── Leaf-aware audit gate on the coordination leader path (C5,
// WL-0MVV1F130009VZ1P) ────────────────────────────────────────────────
//
// The leader's offer loop must apply the SAME per-item audit minimum (C3,
// WL-0MVV1EZVB007M1LR) and the SAME relaxed-tick pin (C4,
// WL-0MVV1F0HK009JQAP) as the direct path. These tests pin the two paths
// together: for an identical payload/candidate set they must reach the same
// decision (dispatch/skip + reason), attribute the same per-offer gate and
// record the same observation token.

describe('leaf-aware audit gate on the coordination leader path (WL-0MVV1F130009VZ1P)', () => {
  /** A completed/in_review root that classifies as an audit candidate. */
  const auditInfo = (id: string): DowntimeItemInfo =>
    itemInfo({
      id,
      status: 'completed',
      stage: 'in_review',
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
  /** The same audit candidate once it is a Herdr-list head item. */
  const auditHead = (id: string): DowntimeHerdrItem =>
    headItem({
      id,
      status: 'completed',
      stage: 'in_review',
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
  const planInfo = (id: string): DowntimeItemInfo =>
    itemInfo({ id, status: 'open', stage: 'intake_complete' });
  const planHead = (id: string): DowntimeHerdrItem =>
    headItem({ id, status: 'open', stage: 'intake_complete' });

  // ── C3: the per-item leaf-aware minimum on the offer loop ──────────

  describe('C3 — per-item leaf-aware audit minimum on the offer loop', () => {
    it('dispatches a LEAF audit offer with only a single free slot', async () => {
      const deps = makeCoordinationDeps({
        fetchItem: vi.fn().mockResolvedValue({ ok: true, info: auditInfo('WL-LEAF') }),
        getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
      });
      const entries = [makeEntry('inst-a', 'WL-LEAF', '/roots/a')];

      const outcome = await dispatchFromCoordination(deps, entries, {
        model: 'plan',
        cwd: '/repo',
        coordinationDir: testDir,
        freeSlots: 1,
      });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('audit');
      expect(outcome.candidate?.id).toBe('WL-LEAF');
      expect((deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
        '/skill:audit WL-LEAF',
      );
    });

    it('still skips a PARENT audit offer in the leaf band (fail-closed)', async () => {
      const deps = makeCoordinationDeps({
        fetchItem: vi.fn().mockResolvedValue({ ok: true, info: auditInfo('WL-PARENT') }),
        // The neutral default is `parent`; asserted explicitly for clarity.
        getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
      });
      const entries = [makeEntry('inst-a', 'WL-PARENT', '/roots/a')];

      const outcome = await dispatchFromCoordination(deps, entries, {
        model: 'plan',
        cwd: '/repo',
        coordinationDir: testDir,
        freeSlots: 1,
      });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
      expect(outcome.offerRejections).toEqual([
        { workItemId: 'WL-PARENT', worklogRoot: '/roots/a', gate: 'audit-slot-min' },
      ]);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    });
  });

  // ── Parity: identical payload/candidate set, identical decision ─────

  describe('parity — the direct and coordination paths decide identically', () => {
    /** The decision facets the two paths must agree on. */
    const decision = (outcome: {
      dispatched: boolean;
      kind?: string;
      reason?: string;
      candidate?: { id: string };
    }): { dispatched: boolean; kind?: string; reason?: string; itemId?: string } => ({
      dispatched: outcome.dispatched,
      ...(outcome.kind !== undefined ? { kind: outcome.kind } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.candidate !== undefined ? { itemId: outcome.candidate.id } : {}),
    });

    it('leaf audit with 1 free slot: both dispatch the same audit candidate', async () => {
      const directDeps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [auditHead('WL-LEAF')] }),
        getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
      });
      const coordDeps = makeCoordinationDeps({
        fetchItem: vi.fn().mockResolvedValue({ ok: true, info: auditInfo('WL-LEAF') }),
        getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
      });

      const direct = await dispatchDowntimeWork(directDeps, {
        model: 'plan',
        cwd: '/repo',
        freeSlots: 1,
      });
      const coordination = await dispatchFromCoordination(
        coordDeps,
        [makeEntry('inst-a', 'WL-LEAF', '/roots/a')],
        { model: 'plan', cwd: '/repo', coordinationDir: testDir, freeSlots: 1 },
      );

      expect(decision(direct)).toEqual({ dispatched: true, kind: 'audit', itemId: 'WL-LEAF' });
      // The parity assertion: identical payload/candidates → identical decision.
      expect(decision(coordination)).toEqual(decision(direct));
    });

    it('parent audit with 1 free slot: both skip', async () => {
      const directDeps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [auditHead('WL-PARENT')] }),
        getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
      });
      const coordDeps = makeCoordinationDeps({
        fetchItem: vi.fn().mockResolvedValue({ ok: true, info: auditInfo('WL-PARENT') }),
        getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
      });

      const direct = await dispatchDowntimeWork(directDeps, {
        model: 'plan',
        cwd: '/repo',
        freeSlots: 1,
      });
      const coordination = await dispatchFromCoordination(
        coordDeps,
        [makeEntry('inst-a', 'WL-PARENT', '/roots/a')],
        { model: 'plan', cwd: '/repo', coordinationDir: testDir, freeSlots: 1 },
      );

      expect(decision(direct)).toEqual({ dispatched: false, reason: 'no-candidate' });
      // The parity assertion: identical payload/candidates → identical decision.
      expect(decision(coordination)).toEqual(decision(direct));
    });

    it('relaxed pin: both dispatch only the pinned audit and never the plan candidate', async () => {
      const directDeps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [planHead('WL-PLAN'), auditHead('WL-LEAF')],
        }),
        getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
        getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
      });
      const coordDeps = makeCoordinationDeps({
        fetchItem: vi.fn().mockImplementation(async (id: string) => ({
          ok: true,
          info: id === 'WL-PLAN' ? planInfo('WL-PLAN') : auditInfo('WL-LEAF'),
        })),
        getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
      });

      const direct = await dispatchDowntimeWork(directDeps, {
        model: 'plan',
        cwd: '/repo',
        freeSlots: 1,
        pinnedAuditItemId: 'WL-LEAF',
      });
      const coordination = await dispatchFromCoordination(
        coordDeps,
        [makeEntry('inst-plan', 'WL-PLAN', '/roots/a'), makeEntry('inst-a', 'WL-LEAF', '/roots/a')],
        {
          model: 'plan',
          cwd: '/repo',
          coordinationDir: testDir,
          freeSlots: 1,
          pinnedAuditItemId: 'WL-LEAF',
        },
      );

      expect(decision(direct)).toEqual({ dispatched: true, kind: 'audit', itemId: 'WL-LEAF' });
      // The parity assertion: identical payload/candidates → identical decision.
      expect(decision(coordination)).toEqual(decision(direct));
      // The relaxed slot never leaks to the single-pane tier on EITHER path.
      expect(directDeps.getNextItem).not.toHaveBeenCalled();
      expect((coordDeps.spawnAgentPane as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    });
  });

  // ── C4: the relaxed-tick pin is not leaked to single-pane tiers ─────

  describe('C4 — a relaxed tick reports non-audit offers as slots-unavailable', () => {
    it('attributes every non-pinned offer and holds the pinned slot', async () => {
      const deps = makeCoordinationDeps({
        fetchItem: vi.fn().mockImplementation(async (id: string) => ({
          ok: true,
          info: id === 'WL-PLAN' ? planInfo('WL-PLAN') : auditInfo('WL-PARENT'),
        })),
        getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
      });
      const entries = [
        makeEntry('inst-plan', 'WL-PLAN', '/roots/a'),
        makeEntry('inst-parent', 'WL-PARENT', '/roots/a'),
      ];

      const outcome = await dispatchFromCoordination(deps, entries, {
        model: 'plan',
        cwd: '/repo',
        coordinationDir: testDir,
        freeSlots: 1,
        pinnedAuditItemId: 'WL-LEAF',
      });

      // The relaxed budget belongs to the pinned audit item only: the plan
      // offer is a slots-unavailable rejection, not a dispatchable candidate.
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('leaf-audit-pin-hold');
      expect(outcome.offerRejections).toEqual([
        { workItemId: 'WL-PLAN', worklogRoot: '/roots/a', gate: 'slots-unavailable' },
        { workItemId: 'WL-PARENT', worklogRoot: '/roots/a', gate: 'audit-slot-min' },
      ]);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      expect(deps.getNextItem).not.toHaveBeenCalled();
    });
  });

  // ── Fail-closed contract of the offer peek ──────────────────────────

  describe('probeCoordinationLeafAuditAdmission — fail-closed', () => {
    const evidence = { freeSlots: 1, thresholdMetCount: 1, requiredFreeSlots: 2 };
    const leafAudit = async () => ({ ok: true as const, info: auditInfo('WL-LEAF') });
    const offer = { workItemId: 'WL-LEAF', worklogRoot: '/roots/a' };

    it('treats an empty offer list as no candidate (no relaxation)', async () => {
      const probe = await probeCoordinationLeafAuditAdmission(
        { fetchItem: leafAudit, getActiveAudit: vi.fn() },
        [],
        evidence,
      );
      expect(probe).toEqual({ kind: 'no-candidate' });
    });

    it('fails closed when the item-fetch seam is unwired', async () => {
      const probe = await probeCoordinationLeafAuditAdmission(
        { getActiveAudit: vi.fn() },
        [offer],
        evidence,
      );
      expect(probe).toEqual({ kind: 'unavailable' });
    });

    it('fails closed when every offer fetch fails', async () => {
      const probe = await probeCoordinationLeafAuditAdmission(
        {
          fetchItem: vi.fn().mockResolvedValue({ ok: false }),
          getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
        },
        [offer],
        evidence,
      );
      expect(probe).toEqual({ kind: 'unavailable' });
    });

    it('never relaxes while an audit is already in flight', async () => {
      const probe = await probeCoordinationLeafAuditAdmission(
        {
          fetchItem: leafAudit,
          getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: true }),
          getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
        },
        [offer],
        evidence,
      );
      expect(probe).toEqual({ kind: 'unavailable' });
    });

    it('reports a parent/unknown scope as non-leaf (budget-skip evidence)', async () => {
      const probe = await probeCoordinationLeafAuditAdmission(
        {
          fetchItem: leafAudit,
          getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
          getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: false }),
        },
        [offer],
        evidence,
      );
      expect(probe).toEqual({ kind: 'non-leaf', itemId: 'WL-LEAF', scope: 'parent' });
    });

    it('admits a trusted leaf offer with the band evidence', async () => {
      const probe = await probeCoordinationLeafAuditAdmission(
        {
          fetchItem: leafAudit,
          getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
          getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
        },
        [offer],
        evidence,
      );
      expect(probe).toEqual({
        kind: 'admitted',
        admission: { itemId: 'WL-LEAF', ...evidence },
      });
    });
  });

  // ── AC4: the observation tokens on the coordination path ────────────

  describe('AC4 — observation tokens are recorded by the coordination path', () => {
    it('records leaf-audit-admission and dispatches the offered leaf audit', async () => {
      // Seed the leader's own offer so its check-in re-offers the same item.
      writeCoordinationFile(testDir, {
        version: 1,
        entries: [makeEntry('inst-a', 'WL-LEAF', '/repo')],
      });
      const recordDecision = vi.fn().mockResolvedValue(undefined);
      const worker = makeCoordWorker({
        coordinationDir: testDir,
        instanceId: 'inst-a',
        thresholdMs: 60_000,
        requiredFreeSlots: 2,
        pollPayloads: [threeSlotPoolStatus(1) as unknown as Record<string, unknown>],
        depsOverrides: {
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [auditHead('WL-LEAF')] }),
          fetchItem: vi.fn().mockResolvedValue({ ok: true, info: auditInfo('WL-LEAF') }),
          getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
          getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
          recordDecision,
        },
      });

      vi.useFakeTimers();
      vi.setSystemTime(10_000_000);
      try {
        await worker.worker.tick(); // idle run starts
        vi.setSystemTime(10_000_000 + 60_000);
        const at = await worker.worker.tick(); // threshold met → relaxed admission

        expect(at.dispatched).toBe(true);
        expect((worker.deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
          '/skill:audit WL-LEAF',
        );

        const admission = recordDecision.mock.calls
          .map((call) => call[0] as CoordinationLogEntry)
          .find((entry) => entry.reason === 'leaf-audit-admission');
        expect(admission).toMatchObject({
          reason: 'leaf-audit-admission',
          freeSlots: 1,
          thresholdMetCount: 1,
          requiredFreeSlots: 2,
          leafAuditItemId: 'WL-LEAF',
          leafAuditScope: 'leaf',
        });
        expect(worker.worker.blockReason).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('records audit-tier-budget-skipped when the only offered audit is a parent', async () => {
      writeCoordinationFile(testDir, {
        version: 1,
        entries: [makeEntry('inst-a', 'WL-PARENT', '/repo')],
      });
      const recordDecision = vi.fn().mockResolvedValue(undefined);
      const worker = makeCoordWorker({
        coordinationDir: testDir,
        instanceId: 'inst-a',
        thresholdMs: 60_000,
        requiredFreeSlots: 2,
        pollPayloads: [threeSlotPoolStatus(1) as unknown as Record<string, unknown>],
        depsOverrides: {
          getHerdrListHead: vi.fn().mockResolvedValue({
            ok: true,
            items: [auditHead('WL-PARENT')],
          }),
          fetchItem: vi.fn().mockResolvedValue({ ok: true, info: auditInfo('WL-PARENT') }),
          getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
          getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
          recordDecision,
        },
      });

      vi.useFakeTimers();
      vi.setSystemTime(10_000_000);
      try {
        await worker.worker.tick();
        vi.setSystemTime(10_000_000 + 60_000);
        const at = await worker.worker.tick();

        expect(at.dispatched).toBe(false);
        expect(worker.deps.spawnAgentPane).not.toHaveBeenCalled();

        const skipped = recordDecision.mock.calls
          .map((call) => call[0] as CoordinationLogEntry)
          .find((entry) => entry.reason === 'audit-tier-budget-skipped');
        expect(skipped).toMatchObject({
          reason: 'audit-tier-budget-skipped',
          skippedTier: 'audit',
          leafAuditItemId: 'WL-PARENT',
          leafAuditScope: 'parent',
        });
        // A relaxed tick that found only a parent is NOT an admission.
        expect(
          recordDecision.mock.calls
            .map((call) => call[0] as CoordinationLogEntry)
            .some((entry) => entry.reason === 'leaf-audit-admission'),
        ).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('records the same leaf-audit-admission evidence as the direct path', async () => {
      // Direct path: the tick-level probe over the leader's own audit candidate.
      const directDecision = vi.fn().mockResolvedValue(undefined);
      const directDeps = makeCoordinationDeps({
        getNextAuditCandidate: vi.fn().mockResolvedValue({
          ok: true,
          candidate: { id: 'WL-LEAF', title: 'Leaf', stage: 'audit' },
        }),
        getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
        getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
        recordDecision: directDecision,
      });
      const directWorker = createDowntimeWorker({
        poller: createDowntimePoller(
          'http://localhost:8000',
          makeFetcher([threeSlotPoolStatus(1) as unknown as Record<string, unknown>]) as never,
          5000,
        ),
        deps: directDeps,
        config: () => ({
          enabled: true,
          thresholdMs: 60_000,
          requiredFreeSlots: 2,
          model: 'plan',
          cwd: '/repo',
          noCandidateCooldownMs: 3_600_000,
        }),
      });

      // Coordination path: the same payload offered through the leader file.
      writeCoordinationFile(testDir, {
        version: 1,
        entries: [makeEntry('inst-a', 'WL-LEAF', '/repo')],
      });
      const coordDecision = vi.fn().mockResolvedValue(undefined);
      const coordWorker = makeCoordWorker({
        coordinationDir: testDir,
        instanceId: 'inst-a',
        thresholdMs: 60_000,
        requiredFreeSlots: 2,
        pollPayloads: [threeSlotPoolStatus(1) as unknown as Record<string, unknown>],
        depsOverrides: {
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [auditHead('WL-LEAF')] }),
          fetchItem: vi.fn().mockResolvedValue({ ok: true, info: auditInfo('WL-LEAF') }),
          getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'leaf' }),
          getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
          recordDecision: coordDecision,
        },
      });

      vi.useFakeTimers();
      vi.setSystemTime(10_000_000);
      try {
        await directWorker.tick();
        await coordWorker.worker.tick();
        vi.setSystemTime(10_000_000 + 60_000);
        expect((await directWorker.tick()).dispatched).toBe(true);
        expect((await coordWorker.worker.tick()).dispatched).toBe(true);

        const pick = (calls: unknown[]): Record<string, unknown> | undefined => {
          const entries = calls.map((call) => (call as [Record<string, unknown>])[0]);
          const admission = entries.find((entry) => entry.reason === 'leaf-audit-admission');
          if (admission === undefined) return undefined;
          const {
            reason,
            freeSlots,
            thresholdMetCount,
            requiredFreeSlots,
            leafAuditItemId,
            leafAuditScope,
          } = admission;
          return {
            reason,
            freeSlots,
            thresholdMetCount,
            requiredFreeSlots,
            leafAuditItemId,
            leafAuditScope,
          };
        };

        const direct = pick(directDecision.mock.calls);
        const coordination = pick(coordDecision.mock.calls);
        expect(direct).toBeDefined();
        expect(coordination).toEqual(direct);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ── Host-wide dispatch budget on the coordination path (F3) ────────────
//
// WL-0MVXY0YG7009JMHI AC1: both dispatcher paths funnel through ONE admission
// read in `dispatchClaimedTier`, so the machine-wide implement cap cannot be
// bypassed by the leader's offer path. The direct path is asserted in
// `downtime-worker.dispatch.test.ts`; the ledger itself in
// `host-dispatch-budget.machine.test.ts`.
describe('host-wide dispatch budget (F3)', () => {
  it('consults the ledger exactly once and reports the neutral refusal', async () => {
    const admitHostDispatch = vi
      .fn()
      .mockResolvedValue({ admitted: false, live: 2, max: 2, reason: 'host-budget-implement' });
    const deps = makeCoordinationDeps({
      admitHostDispatch,
      // The claim succeeded, so the refusal path rolls it back.
      rollbackClaim: vi.fn().mockResolvedValue(true),
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: itemInfo({ id: 'WL-IMP', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }),
      }),
    });

    const outcome = await dispatchFromCoordination(deps, [makeEntry('inst-1', 'WL-IMP')], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
    });

    // AC1: exactly one admission read per dispatch attempt.
    expect(admitHostDispatch).toHaveBeenCalledTimes(1);
    expect(admitHostDispatch).toHaveBeenCalledWith({
      itemId: 'WL-IMP',
      kind: 'implement',
      // The offer's OWN worklog root — the cross-root claim invariant.
      cwd: '/worklog/root',
    });
    // AC2: refusal evidence, no lane, no marker.
    expect(outcome).toMatchObject({
      dispatched: false,
      reason: 'host-budget-implement',
      budget: { live: 2, max: 2 },
    });
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    // AC5: neutral — the tick never reports 'no-candidate', so the worker
    // enters neither the cooldown nor a strike.
    expect(outcome.reason).not.toBe('no-candidate');
  });
});

// ── Audit-budget refusal on the offer path (WL-0MWDDHVF2004PTYX) ─────────
//
// The proxy-derived audit budget (`audit-budget-saturated` /
// `audit-budget-unknown`) refuses an OFFERED audit at admission. Before
// WL-0MWDDHVF2004PTYX those outcomes matched none of the offer loop's
// special cases and fell through unmasked — a tick with only audit refusals
// could report `host-budget-implement` (an implement hold recorded later in
// the same scan) or `no-candidate`, hiding a missing proxy endpoint (the
// 2026-11-12 incident: ~130 consecutive `host-budget-implement` ticks and
// zero `audit-budget-*` entries while `/llama/local/audit/status` answered
// 404). The audit refusal is now recorded as its OWN neutral hold
// (`auditBudgetHold`, why-origin AC1), ranked ABOVE the implement/host rung
// in the terminal chain (AC2), carries the failing exchange as `detail`
// (AC3), and is attributed in the per-offer rejection payload (AC5).
function auditRefusalDeps(
  reason: string,
  detail?: string,
  live = 0,
  max = 0,
): { deps: ReturnType<typeof makeCoordinationDeps>; entry: CoordinationEntry } {
  const entry = makeEntry('inst-audit', 'WL-AUD', '/roots/audit');
  const deps = makeCoordinationDeps({
    admitHostDispatch: vi.fn().mockResolvedValue({
      admitted: false,
      live,
      max,
      reason,
      ...(detail !== undefined ? { detail } : {}),
    }),
    fetchItem: vi.fn().mockResolvedValue({
      ok: true,
      info: itemInfo({
        id: 'WL-AUD',
        status: 'completed',
        stage: 'in_review',
        updatedAt: new Date().toISOString(),
      }),
    }),
  });
  return { deps, entry };
}

describe('audit-budget refusal on the offer path (WL-0MWDDHVF2004PTYX)', () => {
  it('AC1: an audit-only refusal reports the audit-budget reason with detail and attribution (never host-budget-implement, never no-candidate)', async () => {
    const { deps, entry } = auditRefusalDeps('audit-budget-unknown', 'http-404');
    writeCoordinationFile(testDir, { version: 1, entries: [entry] });

    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
    });

    // The tick names the AUDIT gate — the exact incident it fixes.
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('audit-budget-unknown');
    // The failing exchange is emitted in the same decision entry (AC3).
    expect(outcome.detail).toBe('http-404');
    expect(outcome.reason).not.toBe('host-budget-implement');
    expect(outcome.reason).not.toBe('no-candidate');
    // AC4: neutral — no pane, no marker, no claim left stranded.
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    // AC5: the per-offer rejection payload names the audit gate.
    expect(outcome.offerRejections).toEqual([
      { workItemId: 'WL-AUD', worklogRoot: '/roots/audit', gate: 'audit-budget' },
    ]);
    // The offer is KEPT — still valid once the proxy answers.
    expect(getEntry(testDir, 'inst-audit')).not.toBeNull();
  });

  it('AC2: an audit refusal OUTRANKS an implement refusal in the same tick', async () => {
    const auditEntry = makeEntry('inst-audit', 'WL-AUD', '/roots/audit');
    const implementEntry = makeEntry('inst-imp', 'WL-IMP', '/roots/impl');
    writeCoordinationFile(testDir, {
      version: 1,
      entries: [auditEntry, implementEntry],
    });
    const deps = makeCoordinationDeps({
      admitHostDispatch: vi.fn(async (input: { kind: string }) =>
        input.kind === 'audit'
          ? {
              admitted: false,
              live: 1,
              max: 1,
              reason: 'audit-budget-saturated',
            }
          : { admitted: false, live: 2, max: 2, reason: 'host-budget-implement' },
      ),
      fetchItem: vi.fn(async (itemId: string) => ({
        ok: true as const,
        info: itemInfo(
          itemId === 'WL-AUD'
            ? {
                id: 'WL-AUD',
                status: 'completed',
                stage: 'in_review',
                updatedAt: new Date().toISOString(),
              }
            : {
                id: 'WL-IMP',
                status: 'open',
                stage: 'plan_complete',
                risk: 'Low',
                effort: 'S',
              },
        ),
      })),
    });

    const outcome = await dispatchFromCoordination(deps, [auditEntry, implementEntry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 2,
      effectiveFreeSlots: 2,
    });

    // The audit rung beats the ambient implement-cap statement: the tick
    // explains the TIER that is actually dead, not the one that is merely full.
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('audit-budget-saturated');
    expect(outcome.budget).toEqual({ live: 1, max: 1 });
    expect(outcome.reason).not.toBe('host-budget-implement');
    // Both offers are attributed — the audit with its own gate token.
    expect(outcome.offerRejections).toEqual([
      { workItemId: 'WL-AUD', worklogRoot: '/roots/audit', gate: 'audit-budget' },
    ]);
  });

  it('AC3: the failing exchange detail reaches the outcome for http-404, timeout and bad-body', async () => {
    for (const detail of ['http-404', 'timeout', 'bad-body'] as const) {
      const { deps, entry } = auditRefusalDeps('audit-budget-unknown', detail);
      const outcome = await dispatchFromCoordination(deps, [entry], {
        model: 'plan',
        cwd: '/repo',
        coordinationDir: testDir,
      });
      expect(outcome.reason).toBe('audit-budget-unknown');
      expect(outcome.detail).toBe(detail);
    }
  });

  it('AC7: an audit refusal alongside a successful dispatch does not pollute the success outcome', async () => {
    const auditEntry = makeEntry('inst-audit', 'WL-AUD', '/roots/audit');
    const implementEntry = makeEntry('inst-imp', 'WL-IMP', '/roots/impl');
    writeCoordinationFile(testDir, {
      version: 1,
      entries: [auditEntry, implementEntry],
    });
    const deps = makeCoordinationDeps({
      // Refuse the audit offer; admit the implement offer so it dispatches.
      admitHostDispatch: vi.fn(async (input: { kind: string }) =>
        input.kind === 'audit'
          ? {
              admitted: false,
              live: 1,
              max: 1,
              reason: 'audit-budget-unknown',
              detail: 'seam-absent',
            }
          : { admitted: true, live: 0, max: 2 },
      ),
      fetchItem: vi.fn(async (itemId: string) => ({
        ok: true as const,
        info: itemInfo(
          itemId === 'WL-AUD'
            ? {
                id: 'WL-AUD',
                status: 'completed',
                stage: 'in_review',
                updatedAt: new Date().toISOString(),
              }
            : {
                id: 'WL-IMP',
                status: 'open',
                stage: 'plan_complete',
                risk: 'Low',
                effort: 'S',
              },
        ),
      })),
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    });

    const outcome = await dispatchFromCoordination(deps, [auditEntry, implementEntry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 2,
      effectiveFreeSlots: 2,
    });

    // The implement offer dispatches; the recorded audit hold must NOT leak
    // budget/detail/rejections onto the success outcome.
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.reason).toBeUndefined();
    expect(outcome.budget).toBeUndefined();
    expect(outcome.detail).toBeUndefined();
    expect(outcome.offerRejections).toBeUndefined();
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });
});

// ── Per-bucket nominees from one head read (parent WL-0MWDDHQON0015T3P AC2/AC3) ──
//
// Tier-aware offers (WL-0MWDDHQON0015T3P): each instance advertises the head
// of EVERY dispatch bucket (`implement` / `audit` / `prep` — the union of
// plan/intake/risk-effort) so a budget-refused head cannot hide the root's
// other backlog. This slice (WL-0MWDVMYAC0064JNW) defines the OFFER-COMPUTATION
// contract: all three nominees are drawn from the SAME sprint-view window the
// single-offer path uses today, partitioned per bucket — one
// `getHerdrListHead` call per computation, no new ranking/scoring logic, and
// the single-offer path's fail-open, stall-scan short-circuit and sequential
// filters preserved per bucket.
//
// GREEN (F2, WL-0MWDVMZNV0011FDT): `computeMostImportantItem` now returns the
// single offer (`{ok:true, kind, candidate}`) PLUS a `nominees` array — the
// per-bucket candidates of the same window, in canonical bucket order. The
// four bodies below (`it.fails` until this slice) now run as plain `it`; the
// two plain `it` bodies pin contracts that are preserved unchanged.
describe('per-bucket nominees from one head read (parent AC2/AC3)', () => {
  /**
   * Post-F2 per-bucket nominee — the v2 `offers` entry shape F1's check-in
   * write path consumes (`{kind, workItemId}`, at most one per bucket).
   */
  interface NomineeWitness {
    kind: 'implement' | 'audit' | 'prep';
    workItemId: string;
  }

  /** Read the per-bucket surface from a computation result. */
  const nomineesOf = (result: unknown): NomineeWitness[] | undefined =>
    (result as { nominees?: NomineeWitness[] }).nominees;

  // Mixed-kind window fixtures in CANONICAL Herdr list order (the window IS
  // the ranking — no new priority/age/scoring logic may re-order it).
  const implementItem = (id: string, sortIndex = 100): DowntimeHerdrItem =>
    headItem({ id, title: `Implement ${id}`, status: 'open', stage: 'plan_complete', priority: 'high', risk: 'Low', effort: 'S', sortIndex });
  const auditItem = (id: string, sortIndex = 100): DowntimeHerdrItem =>
    headItem({ id, title: `Audit ${id}`, status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString(), sortIndex });
  /** Prep-bucket item (plan tier in the classification). */
  const prepItem = (id: string, sortIndex = 100): DowntimeHerdrItem =>
    headItem({ id, title: `Prep ${id}`, status: 'open', stage: 'intake_complete', sortIndex });

  it('AC1: each nominee is the canonical FIRST item of its bucket in window order — a lower sortIndex later in the window never displaces it', async () => {
    const deps = makeCoordinationDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        // Window order = the canonical ranking. The SECOND item of each bucket
        // carries a lower sortIndex (which other logic would rank higher):
        // per-bucket selection must keep the window-first item, otherwise a
        // new scoring rule crept in.
        items: [
          implementItem('WL-IMP-1', 500),
          auditItem('WL-AUD-1', 500),
          prepItem('WL-PREP-1', 500),
          implementItem('WL-IMP-2', 1),
          auditItem('WL-AUD-2', 1),
          prepItem('WL-PREP-2', 1),
        ],
      }),
    });

    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(true);
    expect(nomineesOf(result)).toEqual([
      { kind: 'implement', workItemId: 'WL-IMP-1' },
      { kind: 'audit', workItemId: 'WL-AUD-1' },
      { kind: 'prep', workItemId: 'WL-PREP-1' },
    ]);
  });

  it('AC2: exactly ONE getHerdrListHead call computes all three nominees (no per-bucket wl spawn)', async () => {
    const getHerdrListHead = vi.fn().mockResolvedValue({
      ok: true,
      items: [implementItem('WL-IMP-1'), auditItem('WL-AUD-1'), prepItem('WL-PREP-1')],
    });
    const deps = makeCoordinationDeps({ getHerdrListHead });

    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(true);
    expect(nomineesOf(result)).toHaveLength(3);
    // The single sprint-view read served every bucket — no additional wl list
    // spawn per bucket, and exactly the sprint view was requested.
    expect(getHerdrListHead).toHaveBeenCalledTimes(1);
    expect(getHerdrListHead).toHaveBeenCalledWith('/repo', expect.any(Number));
  });

  it('AC3: a bucket empty in the window nominates NOTHING and the window is not widened', async () => {
    const getHerdrListHead = vi.fn().mockResolvedValue({
      ok: true,
      // No idea / intake_complete / risk-effort item anywhere → the prep
      // bucket is empty; the computation must not re-read to find one.
      items: [implementItem('WL-IMP-1'), auditItem('WL-AUD-1')],
    });
    const deps = makeCoordinationDeps({ getHerdrListHead });

    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(true);
    expect(nomineesOf(result)).toEqual([
      { kind: 'implement', workItemId: 'WL-IMP-1' },
      { kind: 'audit', workItemId: 'WL-AUD-1' },
    ]);
    // No widening read for the missing prep bucket.
    expect(getHerdrListHead).toHaveBeenCalledTimes(1);
  });

  it('AC3: per-bucket filters preserved — a fresh dispatch marker on the implement head skips to the NEXT offerable implement, other buckets unaffected', async () => {
    // WL-IMP-1 was just dispatched at its current stage → the implement-bucket
    // exclusion skips it and nominates the next offerable implement, while
    // the audit and prep buckets still nominate their own canonical heads
    // (the same sequential filters the single-offer path applies today).
    const root = mkdtempSync(join(tmpdir(), 'herdr-nominees-'));
    try {
      writeDowntimeLog(root, [
        { kind: 'implement', operation: 'dispatch', itemId: 'WL-IMP-1', stage: 'plan_complete', dispatchedAt: new Date(Date.now() - 60_000).toISOString() },
      ] as never);
      const deps = makeCoordinationDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [implementItem('WL-IMP-1'), auditItem('WL-AUD-1'), prepItem('WL-PREP-1'), implementItem('WL-IMP-2')],
        }),
      });

      const result = await computeMostImportantItem(deps, root, Date.now(), 20);
      expect(result.ok).toBe(true);
      expect(nomineesOf(result)).toEqual([
        { kind: 'implement', workItemId: 'WL-IMP-2' },
        { kind: 'audit', workItemId: 'WL-AUD-1' },
        { kind: 'prep', workItemId: 'WL-PREP-1' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC3: preserve the {ok:false} fail-open contract — a head lookup failure yields no nominees and never throws (the caller keeps its entry)', async () => {
    const getHerdrListHead = vi.fn().mockResolvedValue({ ok: false, error: 'wl exploded' });
    const deps = makeCoordinationDeps({ getHerdrListHead });

    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe('wl exploded');
    // The single aborted read, exactly as today — never a per-bucket retry.
    expect(getHerdrListHead).toHaveBeenCalledTimes(1);
    expect((result as { nominees?: unknown }).nominees).toBeUndefined();
  });

  it('AC3: preserve the stall-scan short-circuit — a resumed stalled pane yields stalledResume BEFORE any head read (no per-bucket read either)', async () => {
    const getHerdrListHead = vi.fn().mockResolvedValue({
      ok: true,
      items: [implementItem('WL-IMP-1'), auditItem('WL-AUD-1'), prepItem('WL-PREP-1')],
    });
    const deps = makeCoordinationDeps({
      getHerdrListHead,
      scanStalledPanes: vi.fn().mockResolvedValue([
        {
          pane: { paneId: 'pane-1', label: 'Downtime triggered implement Some item - WL-STALLED', agent: 'pi', agentStatus: 'idle' },
          item: { id: 'WL-STALLED', status: 'open', stage: 'plan_complete', title: 'Some item', updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
          cwd: '/repo',
          kind: 'implement',
        },
      ]),
      resumeStalledPane: vi.fn().mockResolvedValue({ resumed: true, reason: 'prompt', paneId: 'pane-1', itemId: 'WL-STALLED', kind: 'implement' }),
    });

    const result = await computeMostImportantItem(deps, '/repo', Date.now(), 20);
    expect(result.ok).toBe(true);
    if (!('stalledResume' in result)) throw new Error('expected stalledResume');
    expect(result.stalledResume).toBe(true);
    // Short-circuit before the (single shared) head read — preserved per bucket.
    expect(getHerdrListHead).not.toHaveBeenCalled();
  });
});

// ── v2 leader offer iteration: filter chain, drain-aware tie-break, partial removal, regression (parent WL-0MWDDHQON0015T3P AC4–AC8) ──
//
// Tier-aware offers (WL-0MWDDHQON0015T3P): one entry per instance carries up
// to three BUCKET nominees (`implement` / `audit` / `prep` — parent AC1), and
// the elected leader iterates the offers INSIDE an entry, applying the
// existing, UNMODIFIED sequential filter chain to each (parent AC4: classify
// → attempt budget → non-terminal cooldown → per-root code freeze → CPU gate
// → audit slot minimum/pin → review-queue hold → host-budget admission →
// CAS claim — no gate duplicated, relaxed or reordered). When several offers
// are simultaneously admissible, selection follows the DRAIN-AWARE tie-break
// (parent AC5): audit while the root's review queue is at/over
// `browseItemCount`, else prep, else implement — the fixed implement-first
// ladder is deliberately NOT implemented (precedent WL-0MW9X7EJ6009EL6E).
// On a successful dispatch ONLY the dispatched offer is removed — the entry
// keeps its remaining offers and an unchanged `lastUpdated` (parent AC6), so
// the motivating 2/2-cap regression (parent AC7: an implement head refused by
// the machine-wide cap no longer hides the entry's prep work; the tick never
// ends `no-candidate`) is fixed. Cross-root round-robin still governs ROOT
// order — tier choice happens only inside an entry, so no root gains an
// unfair share (parent AC8; pinned in coordination-cross-root.test.ts).
//
// LANDED WITH F3 (WL-0MWDVN2HN004CQ1O). These bodies were committed RED under
// `it.fails` by the test-first sibling WL-0MWDVN11K008HYVU and now run as
// plain `it`: the leader iterates an entry's v2 `offers` payload (a v2-shaped
// entry has no top-level `workItemId` at all), so `entryOffers` derives its
// offer list from `offers` alone, and the partial-removal assertions rely on
// F1 (WL-0MWDVMVX50012RSU) parsing `offers` back from the file.

/** The v2 per-bucket offer payload (F1, WL-0MWDVMVX50012RSU) — at most one per bucket. */
interface CoordOfferWitness {
  kind: 'implement' | 'audit' | 'prep';
  workItemId: string;
}

/** A v2 entry: the outer fields unchanged, the bucket payload in `offers`. */
type V2EntryWitness = Omit<CoordinationEntry, 'workItemId'> & {
  offers: CoordOfferWitness[];
};

/** Build a v2-shaped entry (offers payload, NO top-level `workItemId`). */
function v2Entry(instanceId: string, worklogRoot: string, offers: CoordOfferWitness[]): CoordinationEntry {
  const now = new Date().toISOString();
  return {
    instanceId,
    worklogRoot,
    directory: worklogRoot,
    assignedAt: now,
    lastUpdated: now,
    offers,
  } as unknown as CoordinationEntry;
}

const offerImplement = (workItemId: string): CoordOfferWitness => ({ kind: 'implement', workItemId });
const offerAudit = (workItemId: string): CoordOfferWitness => ({ kind: 'audit', workItemId });
const offerPrep = (workItemId: string): CoordOfferWitness => ({ kind: 'prep', workItemId });

/** fetchItem mock keyed by item id, with a fallback for unknown ids. */
function fetchById(specs: Record<string, Partial<DowntimeItemInfo> & { id: string }>) {
  return vi.fn(async (id: string) => {
    const spec = specs[id];
    if (spec === undefined) return { ok: true, info: itemInfo({ id, stage: 'idea' }) };
    return { ok: true, info: itemInfo(spec) };
  });
}

/** Read the surviving entry from the coordination file after a dispatch. */
function fileEntryAfterDispatch(): V2EntryWitness | null {
  const data = readCoordinationFile(testDir);
  if (data === null || data.entries.length === 0) return null;
  return data.entries[0] as unknown as V2EntryWitness;
}

describe('sequential filter chain on the v2 offer path (parent AC4)', () => {
  it('a multi-offer dispatch consults EVERY seam-based chain limb for the admissible offers — classify, per-root code freeze, CPU gate, review-queue hold, host-budget admission and the CAS claim', async () => {
    const fetched: string[] = [];
    const deps = makeCoordinationDeps({
      fetchItem: vi.fn(async (id: string) => {
        fetched.push(id);
        if (id === 'WL-AUD') {
          return {
            ok: true,
            info: itemInfo({ id, status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString() }),
          } as const;
        }
        return { ok: true, info: itemInfo({ id, status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) } as const;
      }),
      // Per-root code freeze + CPU gate are read once per tick, BEFORE the
      // offer loop — the enumeration must still prove they ran for the cycle.
      readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
      readHostCpu: vi.fn().mockReturnValue({ ok: true, percent: 10, source: 'proc-stat' }),
      // Review-queue hold: shallow queue so the implement offer is ADMISSIBLE
      // (the deep-queue hold is pinned by the audit-drain arm test below).
      getReviewQueueCount: vi.fn().mockResolvedValue(0),
      // Host-budget admission: consulted at the claim boundary for the
      // budgeted implement kind.
      admitHostDispatch: vi.fn().mockResolvedValue({ admitted: true, live: 0, max: 2 }),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
    });
    const entry = v2Entry('inst-1', '/roots/a', [offerImplement('WL-IMP'), offerAudit('WL-AUD')]);
    writeCoordinationFile(testDir, { version: 2, entries: [entry] });

    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 2,
      browseItemCount: 5,
      cpuGatePercent: 50,
    });

    expect(outcome.dispatched).toBe(true);
    // 1. classify — EVERY offered item is re-fetched and re-classified at
    //    dispatch time (a stale offer is dropped at dispatch, never by age).
    expect(fetched).toEqual(expect.arrayContaining(['WL-IMP', 'WL-AUD']));
    // 4. per-root code freeze — consulted.
    expect(deps.readCodeFreezeStatus).toHaveBeenCalled();
    // 5. CPU gate — consulted (fail-open reading, below the threshold).
    expect(deps.readHostCpu).toHaveBeenCalled();
    // 7. review-queue hold — consulted for the implement offer.
    expect(deps.getReviewQueueCount).toHaveBeenCalled();
    // 8. host-budget admission — the surviving offer is budgeted (implement
    //    kind) and consults the machine-wide ledger exactly once.
    expect(deps.admitHostDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'WL-IMP', kind: 'implement', cwd: '/roots/a' }),
    );
    // 9. CAS claim — the surviving offer is claimed against ITS OWN root
    //    (the cross-root claim invariant, WL-0MTQ14W7L003II5A).
    expect(deps.claimItem).toHaveBeenCalledWith(expect.anything(), expect.anything(), '/roots/a');
  });

  it('attempt-budget limb: a budget-exhausted offer is rejected with the neutral token (per-offer attribution) and the entry\u2019s other offer dispatches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-attrib-budget-'));
    try {
      // One prior dispatch at the current stage with maxAttempts=1 → the
      // implement offer has exhausted its budget; the prep offer is untouched.
      writeDowntimeLog(root, [
        {
          kind: 'implement',
          operation: 'dispatch',
          itemId: 'WL-IMP',
          stage: 'plan_complete',
          dispatchedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ] as never);
      const entry = v2Entry('inst-1', root, [offerImplement('WL-IMP'), offerPrep('WL-PREP')]);
      writeCoordinationFile(testDir, { version: 2, entries: [entry] });
      const deps = makeCoordinationDeps({
        getReviewQueueCount: vi.fn().mockResolvedValue(0),
        fetchItem: fetchById({
          'WL-IMP': { id: 'WL-IMP', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
          'WL-PREP': { id: 'WL-PREP', status: 'open', stage: 'intake_complete' },
        }),
      });

      const outcome = await dispatchFromCoordination(deps, [entry], {
        model: 'plan',
        cwd: '/repo',
        coordinationDir: testDir,
        freeSlots: 2,
        browseItemCount: 5,
        maxAttempts: 1,
      });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      // The rejection is attributed to the OFFER (workItemId), not the
      // instance — per-offer, not per-instance (parent AC4 / offer-attribution).
      expect(outcome.offerRejections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workItemId: 'WL-IMP', gate: 'attempt-budget-exhausted' }),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('non-terminal-cooldown limb: a same-kind offer in the pane-close cooldown is skipped neutrally and the entry\u2019s other offer dispatches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-cooldown-root-'));
    try {
      mkdirSync(join(root, '.worklog'), { recursive: true });
      writeFileSync(
        join(root, '.worklog', 'downtime-dispatches.log'),
        JSON.stringify({
          entryType: 'pane-close',
          itemId: 'WL-IMP',
          kind: 'implement',
          stage: 'plan_complete',
          reasonCode: 'agent-ended-no-terminal',
          outcome: 'requires-attention',
          timestamp: new Date().toISOString(),
          closed: true,
        }) + '\n',
        'utf-8',
      );
      const entry = v2Entry('inst-1', root, [offerImplement('WL-IMP'), offerPrep('WL-PREP')]);
      writeCoordinationFile(testDir, { version: 2, entries: [entry] });
      const deps = makeCoordinationDeps({
        getReviewQueueCount: vi.fn().mockResolvedValue(0),
        fetchItem: fetchById({
          'WL-IMP': { id: 'WL-IMP', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
          'WL-PREP': { id: 'WL-PREP', status: 'open', stage: 'intake_complete' },
        }),
      });

      const outcome = await dispatchFromCoordination(deps, [entry], {
        model: 'plan',
        cwd: '/repo',
        coordinationDir: testDir,
        freeSlots: 2,
        browseItemCount: 5,
        nonTerminalCooldownMs: 3_600_000,
      });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.offerRejections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workItemId: 'WL-IMP', gate: 'non-terminal-cooldown' }),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CPU-gate limb: an audit/implement offer under CPU saturation is skipped (KEPT, not removed) and a prep offer dispatches', async () => {
    const entry = v2Entry('inst-1', '/roots/a', [offerImplement('WL-IMP'), offerPrep('WL-PREP')]);
    writeCoordinationFile(testDir, { version: 2, entries: [entry] });
    const deps = makeCoordinationDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(0),
      readHostCpu: vi.fn().mockReturnValue({ ok: true, percent: 90, source: 'proc-stat' }),
      fetchItem: fetchById({
        'WL-IMP': { id: 'WL-IMP', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
        'WL-PREP': { id: 'WL-PREP', status: 'open', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 2,
      browseItemCount: 5,
      cpuGatePercent: 50,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.offerRejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workItemId: 'WL-IMP', gate: 'cpu-saturated' }),
      ]),
    );
  });

  it('audit-slot-minimum/pin limb: in the single-free-slot band a parent-scoped audit offer is skipped with the audit-slot-min token and a prep offer dispatches', async () => {
    const entry = v2Entry('inst-1', '/roots/a', [offerAudit('WL-AUD'), offerPrep('WL-PREP')]);
    writeCoordinationFile(testDir, { version: 2, entries: [entry] });
    const deps = makeCoordinationDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(0),
      // Leaf band (freeSlots=1): only a TRUSTED LEAF may consume the single
      // free slot — the neutral `parent` scope (the default) is rejected.
      getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
      fetchItem: fetchById({
        'WL-AUD': { id: 'WL-AUD', status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString() },
        'WL-PREP': { id: 'WL-PREP', status: 'open', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 1,
      browseItemCount: 5,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.offerRejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workItemId: 'WL-AUD', gate: 'audit-slot-min' }),
      ]),
    );
  });
});

describe('drain-aware tie-break over admissible offers (parent AC5)', () => {
  it('audit-drain arm: while the root review queue is at/over browseItemCount, an ADMISSIBLE audit offer dispatches even when prep and implement are also offered', async () => {
    // The audit offer is the LAST entry in the array — the tie-break is not
    // array order. The implement head is review-HELD (deep queue, non-critical)
    // and the prep offer is admissible, but arm 1 (audit-drain) wins.
    const entry = v2Entry('inst-1', '/roots/a', [
      offerImplement('WL-IMP'),
      offerPrep('WL-PREP'),
      offerAudit('WL-AUD'),
    ]);
    writeCoordinationFile(testDir, { version: 2, entries: [entry] });
    const deps = makeCoordinationDeps({
      // Queue at the drain threshold (>= browseItemCount) → the implement
      // offer is held by the review-queue gate and the audit arm arms.
      getReviewQueueCount: vi.fn().mockResolvedValue(5),
      fetchItem: fetchById({
        'WL-IMP': { id: 'WL-IMP', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
        'WL-PREP': { id: 'WL-PREP', status: 'open', stage: 'intake_complete' },
        'WL-AUD': { id: 'WL-AUD', status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString() },
      }),
    });

    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 2,
      browseItemCount: 5,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    const spawn = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(String(spawn[0])).toContain('WL-AUD');
    expect(spawn[1].cwd).toBe('/roots/a');
    // The deep queue review-hold is attributed to the IMPLEMENT offer —
    // the hold is per offer, never a whole-instance skip.
    expect(outcome.offerRejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workItemId: 'WL-IMP', gate: 'review-queue-hold' }),
      ]),
    );
  });

  it('prep arm: with a shallow review queue and a prep offer admissible, the PREP offer dispatches ahead of implement (no fixed implement-first ladder)', async () => {
    const entry = v2Entry('inst-1', '/roots/a', [offerImplement('WL-IMP'), offerPrep('WL-PREP')]);
    writeCoordinationFile(testDir, { version: 2, entries: [entry] });
    const deps = makeCoordinationDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(0),
      fetchItem: fetchById({
        'WL-IMP': { id: 'WL-IMP', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
        'WL-PREP': { id: 'WL-PREP', status: 'open', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 2,
      browseItemCount: 5,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    const spawn = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(String(spawn[0])).toContain('WL-PREP');
  });

  it('implement arm: with a shallow queue and NO prep offer, an ADMISSIBLE implement offer dispatches even when an audit offer is also present', async () => {
    // The audit offer does NOT win in a shallow queue — the audit-drain arm
    // is gated on the review queue depth (a fixed audit-first ladder is not
    // implemented either).
    const entry = v2Entry('inst-1', '/roots/a', [offerAudit('WL-AUD'), offerImplement('WL-IMP')]);
    writeCoordinationFile(testDir, { version: 2, entries: [entry] });
    const deps = makeCoordinationDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(0),
      fetchItem: fetchById({
        'WL-AUD': { id: 'WL-AUD', status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString() },
        'WL-IMP': { id: 'WL-IMP', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
      }),
    });

    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 2,
      browseItemCount: 5,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    const spawn = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(String(spawn[0])).toContain('WL-IMP');
  });
});

describe('only the dispatched offer is removed (partial removal, parent AC6)', () => {
  it('dispatch-on-FIRST-offer removes only that offer — the entry survives with the remaining offer and an unchanged lastUpdated', async () => {
    const entry = v2Entry('inst-1', '/roots/a', [offerPrep('WL-PREP'), offerImplement('WL-IMP')]);
    writeCoordinationFile(testDir, { version: 2, entries: [entry] });
    const deps = makeCoordinationDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(0),
      fetchItem: fetchById({
        'WL-PREP': { id: 'WL-PREP', status: 'open', stage: 'intake_complete' },
        'WL-IMP': { id: 'WL-IMP', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
      }),
    });

    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 2,
      browseItemCount: 5,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan'); // the FIRST offer (prep) is chosen
    // Only the dispatched offer is removed: the entry REMAINS with the
    // implement offer — no whole-entry removal, no owner re-check-in.
    expect(getEntry(testDir, 'inst-1')).not.toBeNull();
    const after = fileEntryAfterDispatch();
    expect(after?.offers).toEqual([offerImplement('WL-IMP')]);
    expect(after?.lastUpdated).toBe(entry.lastUpdated);
  });

  it('dispatch-on-SECOND-offer without a new check-in retains the FIRST offer with an unchanged lastUpdated', async () => {
    const entry = v2Entry('inst-1', '/roots/a', [offerImplement('WL-IMP'), offerPrep('WL-PREP')]);
    writeCoordinationFile(testDir, { version: 2, entries: [entry] });
    const deps = makeCoordinationDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(0),
      fetchItem: fetchById({
        'WL-IMP': { id: 'WL-IMP', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
        'WL-PREP': { id: 'WL-PREP', status: 'open', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 2,
      browseItemCount: 5,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan'); // the SECOND offer (prep) is chosen
    // The FIRST offer (implement) is retained — dispatch never touches the
    // owner's entry metadata: no new check-in ran, lastUpdated is unchanged.
    expect(getEntry(testDir, 'inst-1')).not.toBeNull();
    const after = fileEntryAfterDispatch();
    expect(after?.offers).toEqual([offerImplement('WL-IMP')]);
    expect(after?.lastUpdated).toBe(entry.lastUpdated);
  });

  it('an entry whose LAST offer dispatches is removed entirely (as today)', async () => {
    const entry = v2Entry('inst-1', '/roots/a', [offerImplement('WL-IMP')]);
    writeCoordinationFile(testDir, { version: 2, entries: [entry] });
    const deps = makeCoordinationDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(0),
      fetchItem: fetchById({
        'WL-IMP': { id: 'WL-IMP', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
      }),
    });

    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 2,
      browseItemCount: 5,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(getEntry(testDir, 'inst-1')).toBeNull();
  });
});

describe('2/2 implement-cap regression (parent AC7)', () => {
  it('with an implement cap of 2/2 and an offered implement head, the entry\u2019s PREP nominee dispatches and the tick never reports no-candidate', async () => {
    const entry = v2Entry('inst-1', '/roots/a', [offerImplement('WL-IMP'), offerPrep('WL-PREP')]);
    writeCoordinationFile(testDir, { version: 2, entries: [entry] });
    const deps = makeCoordinationDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(0),
      // Machine-wide implement ledger at the cap (2/2): any implement
      // dispatch is refused with the neutral hold.
      admitHostDispatch: vi.fn().mockResolvedValue({ admitted: false, live: 2, max: 2, reason: 'host-budget-implement' }),
      fetchItem: fetchById({
        'WL-IMP': { id: 'WL-IMP', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
        'WL-PREP': { id: 'WL-PREP', status: 'open', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      freeSlots: 2,
      browseItemCount: 5,
    });

    // The prep nominee dispatches — the budget-refused implement head can
    // no longer hide the root's prep work (the 2026-11-12 stall).
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    const spawn = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(String(spawn[0])).toContain('WL-PREP');
    // NEUTRAL, never the empty-backlog pause: the cap refusal and the prep
    // dispatch are both non-`no-candidate`.
    expect(outcome.reason).not.toBe('no-candidate');
    // The implement head is still valid work — retained (only the dispatched
    // offer was removed), so the next tick re-checks the ledger.
    const after = fileEntryAfterDispatch();
    expect(after?.offers).toEqual([offerImplement('WL-IMP')]);
    expect(after?.lastUpdated).toBe(entry.lastUpdated);
  });
});
