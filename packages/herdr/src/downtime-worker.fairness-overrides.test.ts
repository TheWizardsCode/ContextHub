/**
 * packages/herdr/src/downtime-worker.fairness-overrides.test.ts — override
 * precedence over root rotation.
 *
 * Parent: WL-0MWKE9VF800101V9 (Dispatcher seems to unevenly distribute work).
 * Work item: WL-0MWKY0VF5003ZKRO (Override-precedence regression tests for
 * dispatch fairness, parent AC4 / AC6).
 *
 * These tests lock the EXISTING override behaviour before the fairness fix
 * lands (WL-0MWKY1839000JM5O rotates the whole admissible candidate set). The
 * fairness change must buy rotation without demoting an override, so every
 * override below asserts that it still wins when the affected root is the
 * least-recently-served ("due") root. Each test names its override and asserts
 * an OBSERVABLE outcome (dispatch target, hold reason / gate token, and the
 * round-robin cursor charge or no-charge) rather than internal call counts:
 *
 *   1. critical-first
 *   2. priority ordering
 *   3. review-queue depth gate
 *   4. audit slot minimum
 *   5. code-freeze split-by-skill
 *   6. host-wide dispatch budget
 *
 * Deterministic: no live `wl` spawns, no real coordination directory (a
 * per-test temp dir holds the cursor), and the clock is injected where the
 * cursor charge makes it observable.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeMostImportantItem,
  dispatchFromCoordination,
  type DowntimeWorkerDeps,
  type DowntimeItemInfo,
  type DowntimeHerdrItem,
} from './downtime-worker.js';
import {
  ROUND_ROBIN_BY_ROOT_FILE_NAME,
  loadRoundRobinCursor,
  type RoundRobinByRootData,
} from './downtime-round-robin-by-root.js';
import { type CoordinationEntry } from './coordination.js';

// ── Fixtures ──────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'herdr-fairness-overrides-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

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

function implementItem(id: string, priority?: string): DowntimeItemInfo {
  return itemInfo({ id, status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S', priority });
}

function planItem(id: string): DowntimeItemInfo {
  return itemInfo({ id, status: 'open', stage: 'intake_complete' });
}

function auditItem(id: string): DowntimeItemInfo {
  return itemInfo({ id, status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString() });
}

function makeEntry(instanceId: string, workItemId: string, root: string): CoordinationEntry {
  const now = new Date().toISOString();
  return {
    instanceId,
    workItemId,
    directory: root,
    worklogRoot: root,
    assignedAt: now,
    lastUpdated: now,
  };
}

/** Seed the round-robin cursor so the given root is the least recently served. */
function seedDueRoot(root: string, servedAt = '2026-01-01T00:00:00.000Z'): RoundRobinByRootData {
  const data: RoundRobinByRootData = {
    [root]: servedAt,
    '/repo/peer': '2026-01-05T00:00:00.000Z',
  };
  writeFileSync(join(testDir, ROUND_ROBIN_BY_ROOT_FILE_NAME), JSON.stringify(data), 'utf-8');
  return data;
}

function makeDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    rollbackClaim: vi.fn().mockResolvedValue(true),
    recordError: vi.fn().mockResolvedValue(undefined),
    getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
    recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
    readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
    fetchItem: vi.fn().mockResolvedValue({ ok: true, info: itemInfo({ id: 'WL-X', stage: 'idea' }) }),
    getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
    getReviewQueueCount: vi.fn().mockResolvedValue(0),
    getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
    ...overrides,
  } as DowntimeWorkerDeps;
}

function spawnedPrompts(deps: DowntimeWorkerDeps): string[] {
  return (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
}

// ── 1. Critical-first ─────────────────────────────────────────────────

describe('override 1 — critical-first', () => {
  it('offers a critical item ahead of a non-critical one (never demoted by root rotation)', async () => {
    // The canonical head floats a high-priority NON-critical implement; the
    // critical item sits behind it. Critical-first must escalate the critical
    // offer, so the fairness fix (which only changes ROOT order) can never
    // demote it.
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [
          headItem({ id: 'WL-NORMAL', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S', priority: 'high' }),
          headItem({ id: 'WL-CRIT', stage: 'plan_complete', status: 'open', risk: 'Low', effort: 'S', priority: 'critical' }),
        ],
      }),
    });

    const result = await computeMostImportantItem(deps, '/repo/impl', Date.now(), 20);

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('implement');
    expect(result.candidate?.id).toBe('WL-CRIT');
  });
});

// ── 2. Priority ordering ──────────────────────────────────────────────

describe('override 2 — priority ordering', () => {
  it('preserves the canonical head order (no second ranking is introduced)', async () => {
    // The Herdr head is already ranked; the offer must be its FIRST offerable
    // item. A second ranking (e.g. round-robin within a root) would flip this
    // and is explicitly out of contract.
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [
          headItem({ id: 'WL-FIRST', stage: 'intake_complete', status: 'open', priority: 'high' }),
          headItem({ id: 'WL-SECOND', stage: 'intake_complete', status: 'open', priority: 'low' }),
        ],
      }),
    });

    const result = await computeMostImportantItem(deps, '/repo/impl', Date.now(), 20);

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('plan');
    expect(result.candidate?.id).toBe('WL-FIRST');
  });
});

// ── 3. Review-queue depth gate ────────────────────────────────────────

describe('override 3 — review-queue depth gate', () => {
  it('holds a non-critical implement on a deep queue even when its root is due', async () => {
    const root = '/repo/impl';
    seedDueRoot(root);
    const deps = makeDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(999), // deep
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: implementItem('WL-IMPL') }),
    });

    const outcome = await dispatchFromCoordination(
      deps,
      [makeEntry('inst-impl', 'WL-IMPL', root)],
      { model: 'plan', cwd: '/repo', coordinationDir: testDir, browseItemCount: 20 },
    );

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('review-queue-hold');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // The hold is a no-charge outcome: the due root stays least recently served.
    expect(loadRoundRobinCursor(testDir)[root]).toBe('2026-01-01T00:00:00.000Z');
  });
});

// ── 4. Audit slot minimum ─────────────────────────────────────────────

describe('override 4 — audit slot minimum', () => {
  it('skips an audit offer below two free slots even when its root is due', async () => {
    const root = '/repo/audit';
    seedDueRoot(root);
    const deps = makeDeps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: auditItem('WL-AUD') }),
    });

    const outcome = await dispatchFromCoordination(
      deps,
      [makeEntry('inst-audit', 'WL-AUD', root)],
      { model: 'plan', cwd: '/repo', coordinationDir: testDir, freeSlots: 1, effectiveFreeSlots: 1 },
    );

    expect(outcome.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(outcome.offerRejections).toEqual([
      { workItemId: 'WL-AUD', worklogRoot: root, gate: 'audit-slot-min' },
    ]);
    // No-charge: the due audit root's cursor is untouched.
    expect(loadRoundRobinCursor(testDir)[root]).toBe('2026-01-01T00:00:00.000Z');
  });
});

// ── 5. Code-freeze split-by-skill ─────────────────────────────────────

describe('override 5 — code-freeze split-by-skill', () => {
  it('pauses audit/implement during a freeze while plan dispatches', async () => {
    const auditRoot = '/repo/audit';
    const planRoot = '/repo/plan';
    writeFileSync(
      join(testDir, ROUND_ROBIN_BY_ROOT_FILE_NAME),
      JSON.stringify({
        [auditRoot]: '2026-01-01T00:00:00.000Z',
        [planRoot]: '2026-01-02T00:00:00.000Z',
      }),
      'utf-8',
    );
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      fetchItem: vi.fn().mockImplementation(async (id: string) =>
        id === 'WL-AUD'
          ? { ok: true, info: auditItem(id) }
          : { ok: true, info: planItem(id) },
      ),
    });

    const now = Date.UTC(2026, 0, 10, 0, 0, 0);
    const outcome = await dispatchFromCoordination(
      deps,
      [makeEntry('inst-audit', 'WL-AUD', auditRoot), makeEntry('inst-plan', 'WL-PLAN', planRoot)],
      { model: 'plan', cwd: '/repo', coordinationDir: testDir },
      now,
    );

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    const prompts = spawnedPrompts(deps);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('WL-PLAN');
    // Only the dispatching (plan) root is charged; the frozen audit root is not.
    const cursor = loadRoundRobinCursor(testDir);
    expect(cursor[planRoot]).toBe(new Date(now).toISOString());
    expect(cursor[auditRoot]).toBe('2026-01-01T00:00:00.000Z');
  });
});

// ── 6. Host-wide dispatch budget ──────────────────────────────────────

describe('override 6 — host-wide dispatch budget', () => {
  it('reports the budget hold and charges no cursor even when the root is due', async () => {
    const root = '/repo/impl';
    seedDueRoot(root);
    const deps = makeDeps({
      admitHostDispatch: vi.fn().mockResolvedValue({
        admitted: false,
        live: 2,
        max: 2,
        reason: 'host-budget-implement',
      }),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
      rollbackClaim: vi.fn().mockResolvedValue(true),
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: implementItem('WL-IMPL') }),
    });

    const now = Date.UTC(2026, 0, 10, 0, 0, 0);
    const outcome = await dispatchFromCoordination(
      deps,
      [makeEntry('inst-impl', 'WL-IMPL', root)],
      { model: 'plan', cwd: '/repo', coordinationDir: testDir },
      now,
    );

    // The neutral budget refusal wins over rotation: never no-candidate.
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('host-budget-implement');
    expect(outcome.budget).toEqual({ live: 2, max: 2 });
    // No charge: the refused offer is kept and the due root is still due.
    expect(loadRoundRobinCursor(testDir)[root]).toBe('2026-01-01T00:00:00.000Z');
  });
});
