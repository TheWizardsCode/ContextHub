/**
 * packages/herdr/src/downtime-worker.fairness-diagnosis.test.ts — deterministic
 * characterisation tests for the RESIDUAL dispatch-unfairness mechanisms.
 *
 * Parent: WL-0MWKE9VF800101V9 (Dispatcher seems to unevenly distribute work).
 * Work item: WL-0MWKY0R4Z004UU85 (Diagnose residual dispatch-unfairness
 * mechanism, parent AC2 / AC6).
 *
 * Two adjacent defects were already fixed and are NOT re-litigated here:
 * the round-robin cursor was never wired into the dispatch path
 * (WL-0MTQ2FGSK004CBRK) and the post-dispatch charge was dead code
 * (WL-0MWFIZ8H5005FVNN). The brief measured a residual concentration after
 * both landed and named two surviving candidate mechanisms. This suite
 * reproduces each one against the CURRENT selection path, deterministically,
 * with no live coordination directory:
 *
 *  (a) **Selected-root-only rotation.** `dispatchFromCoordinationGated`
 *      splices ONLY the tick's selected root to the front of the entry list
 *      and then iterates the rest in raw coordination-file order
 *      (`downtime-worker.coordination-leader.ts`, the `selectedRoot` splice and
 *      the `for (const entry of entries)` loop). A root that is selected but
 *      whose offers are all HELD is never charged
 *      (`isConsumedDispatchOutcome` is false for a hold), so it stays first
 *      forever and the fall-through behind it is not round-robin: the earliest
 *      admissible root in FILE order wins every tick, even when a peer later in
 *      the file is strictly less recently served.
 *
 *  (b) **Gate asymmetry.** The review-queue hold
 *      (`isImplementHeldByReviewGate`), the CPU gate and the audit-slot
 *      minimum hold ONLY `implement` / `audit` offers; `plan` / `intake` /
 *      `risk-effort` (the `prep` bucket) are never held by them. A root with a
 *      large prep backlog therefore keeps winning slots on a machine whose
 *      other roots have mature implement/audit backlogs stuck behind those
 *      gates.
 *
 * These are now CHARACTERISATION tests of the FIXED behaviour: they originally
 * pinned the biased behaviour so the fix item (WL-0MWKY1839000JM5O) could invert
 * them deliberately. The fix rotates the whole admissible candidate set, so the
 * fall-through is round-robin and these specs assert the fair ordering. If one
 * starts failing because the ordering regressed, the assertion (not the
 * scenario) is the thing to restore.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchFromCoordination,
  type DowntimeWorkerDeps,
  type DowntimeItemInfo,
} from './downtime-worker.js';
import { isImplementHeldByReviewGate } from './downtime-worker.gates.js';
import {
  ROUND_ROBIN_BY_ROOT_FILE_NAME,
  type RoundRobinByRootData,
} from './downtime-round-robin-by-root.js';
import { type CoordinationEntry } from './coordination.js';

// ── Fixtures ──────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'herdr-fairness-diagnosis-'));
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

/** A non-critical implement candidate (eligible unless a gate holds it). */
function implementItem(id: string): DowntimeItemInfo {
  return itemInfo({ id, status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' });
}

/** A prep candidate: `plan` kind (never held by review / CPU / slot gates). */
function planItem(id: string): DowntimeItemInfo {
  return itemInfo({ id, status: 'open', stage: 'intake_complete' });
}

/** One v1-shape offer entry pinned to a distinct worklog root. */
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

/** Seed the round-robin cursor file with fixed timestamps. */
function seedCursor(data: RoundRobinByRootData): void {
  writeFileSync(
    join(testDir, ROUND_ROBIN_BY_ROOT_FILE_NAME),
    JSON.stringify(data),
    'utf-8',
  );
}

/** Minimal dispatch deps; defaults mirror `coordination-dispatch.test.ts`. */
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
    // Shallow (empty) review queue by default: no implement hold.
    getReviewQueueCount: vi.fn().mockResolvedValue(0),
    getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
    ...overrides,
  } as DowntimeWorkerDeps;
}

function spawnedPrompts(deps: DowntimeWorkerDeps): string[] {
  return (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => call[0] as string,
  );
}

/** Longest run of the same element in a sequence (parent AC1 metric). */
function maxConsecutiveRun(sequence: readonly string[]): number {
  let longest = 0;
  let current = 0;
  let previous: string | undefined;
  for (const value of sequence) {
    current = value === previous ? current + 1 : 1;
    previous = value;
    if (current > longest) longest = current;
  }
  return longest;
}

/**
 * Seed the leader's decision log with `length` consecutive dispatches to
 * `root` — the SINGLE run-length accounting source the ordering reads
 * (WL-0MWKY141H002LULI). `dispatchFromCoordination` never appends here, so the
 * seeded run persists for the tick under test.
 */
function seedDecisionLog(cwd: string, root: string, length: number): void {
  mkdirSync(join(cwd, '.worklog'), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= length; i += 1) {
    lines.push(
      JSON.stringify({
        kind: 'decision',
        operation: 'dispatch',
        reason: 'dispatched',
        outcome: 'dispatched',
        dispatchingRoot: root,
        consecutiveRunLength: i,
        at: `2026-01-0${i}T00:00:00.000Z`,
      }),
    );
  }
  writeFileSync(
    join(cwd, '.worklog', 'downtime-coordination.log'),
    `${lines.join('\n')}\n`,
    'utf-8',
  );
}

// ── Mechanism (a): selected-root-only rotation ────────────────────────

describe('mechanism (a): rotation applies to the whole admissible candidate set', () => {
  /**
   * Four roots, interleaved admissible/held offers, pinned by the parent AC1
   * shape. Root A is the least-recently-served root and is DISPATCH-HELD
   * (deep review queue → its non-critical implement offer is held, never
   * charged). Roots B and C both have an admissible prep offer. C is strictly
   * LESS recently served than B.
   *
   * Round-robin serves C first among the admissible roots. The fixed ordering
   * rotates the WHOLE set, so C — not file-order B — wins the fall-through.
   */
  it('fall-through is round-robin: the less-recently-served C beats file-order B', async () => {
    // Root A is oldest (selected) but held; B is the most recently served and
    // C sits between them, so C is the correct round-robin choice.
    seedCursor({
      '/repo/a': '2026-01-01T00:00:00.000Z',
      '/repo/b': '2026-01-03T00:00:00.000Z',
      '/repo/c': '2026-01-02T00:00:00.000Z',
    });

    const deps = makeDeps({
      // Root A's queue is deep → its implement offer is held; the others are shallow.
      getReviewQueueCount: vi.fn().mockImplementation(async (root: string) =>
        root === '/repo/a' ? 999 : 0,
      ),
      fetchItem: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'WL-A') return { ok: true, info: implementItem(id) };
        return { ok: true, info: planItem(id) };
      }),
    });

    // Coordination file order: A (held), B, C. A is selected (oldest), so it is
    // already at the front and the loop falls through to B in file order.
    const entries = [
      makeEntry('inst-a', 'WL-A', '/repo/a'),
      makeEntry('inst-b', 'WL-B', '/repo/b'),
      makeEntry('inst-c', 'WL-C', '/repo/c'),
    ];

    const outcome = await dispatchFromCoordination(deps, entries, {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      browseItemCount: 20,
    });

    expect(outcome.dispatched).toBe(true);
    // Whole-set round-robin: C dispatches, because it is less recently served.
    const prompts = spawnedPrompts(deps);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('WL-C');
    expect(prompts[0]).not.toContain('WL-B');
  });

  it('a held-selected root never monopolises the fall-through across consecutive slots', async () => {
    // Initial cursor: A is oldest and always held; C is less recently served
    // than B, so a round-robin across admissible roots would pick C first.
    seedCursor({
      '/repo/a': '2026-01-01T00:00:00.000Z',
      '/repo/b': '2026-01-03T00:00:00.000Z',
      '/repo/c': '2026-01-02T00:00:00.000Z',
    });

    const baseNow = Date.UTC(2026, 0, 10, 0, 0, 0);
    const dispatched: string[] = [];

    // Three consecutive ticks. Each tick simulates the owner re-offering after
    // its consumed offer was removed (a fresh entries array per tick). The
    // real path charges the DISPATCHING root (B) after every success.
    for (let tick = 0; tick < 3; tick += 1) {
      const deps = makeDeps({
        getReviewQueueCount: vi.fn().mockImplementation(async (root: string) =>
          root === '/repo/a' ? 999 : 0,
        ),
        fetchItem: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'WL-A') return { ok: true, info: implementItem(id) };
          return { ok: true, info: planItem(id) };
        }),
      });
      const entries = [
        makeEntry('inst-a', 'WL-A', '/repo/a'),
        makeEntry('inst-b', 'WL-B', '/repo/b'),
        makeEntry('inst-c', 'WL-C', '/repo/c'),
      ];
      const outcome = await dispatchFromCoordination(
        deps,
        entries,
        {
          model: 'plan',
          cwd: '/repo',
          coordinationDir: testDir,
          browseItemCount: 20,
        },
        // Advance the clock each tick so B's charge is strictly newer than the
        // seeded cursor, exactly as it is across real dispatches.
        baseNow + tick * 60_000,
      );
      expect(outcome.dispatched).toBe(true);
      const prompts = spawnedPrompts(deps);
      expect(prompts).toHaveLength(1);
      dispatched.push(prompts[0].includes('WL-B') ? 'B' : prompts[0].includes('WL-C') ? 'C' : 'other');
    }

    // The bound under test (parent AC1): no root may win more than twice in
    // succession while a peer has an admissible offer. The whole-set order
    // interleaves C and B (C is newer than B after tick 1), so the run is 1
    // and neither admissible root is starved.
    expect(dispatched).toEqual(['C', 'B', 'C']);
    expect(dispatched.filter((root) => root === 'C')).toHaveLength(2);
    expect(dispatched.filter((root) => root === 'B')).toHaveLength(1);
  });
});

// ── Mechanism (b): prep-vs-implement/audit gate asymmetry ─────────────

describe('mechanism (b): prep offers are never held by the implement/audit gates', () => {
  it('the review-queue hold applies to implement only — prep kinds are never held', () => {
    const deepGate = { deep: true, count: 999, threshold: 20 };
    // Prep-tier kinds are exempt from the review-queue hold.
    expect(isImplementHeldByReviewGate('plan', { priority: 'high' }, deepGate)).toBe(false);
    expect(isImplementHeldByReviewGate('intake', {}, deepGate)).toBe(false);
    expect(isImplementHeldByReviewGate('risk-effort', {}, deepGate)).toBe(false);
    // A non-critical implement IS held; a critical implement is never held.
    expect(isImplementHeldByReviewGate('implement', { priority: 'high' }, deepGate)).toBe(true);
    expect(isImplementHeldByReviewGate('implement', { priority: 'critical' }, deepGate)).toBe(false);
    // Audit is the queue drain — never held either.
    expect(isImplementHeldByReviewGate('audit', {}, deepGate)).toBe(false);
  });

  it('a deep review queue holds a mature implement root while a prep root keeps winning', async () => {
    // Root order puts the implement root FIRST, so it is also the selected root
    // unless we make the prep root older. Either way the implement offer is
    // held and the prep offer flows — that asymmetry, not ordering, is under
    // test here.
    seedCursor({
      '/repo/impl': '2026-01-01T00:00:00.000Z', // selected (least recently served)
      '/repo/prep': '2026-01-02T00:00:00.000Z',
    });

    const deps = makeDeps({
      getReviewQueueCount: vi.fn().mockImplementation(async (root: string) =>
        root === '/repo/impl' ? 999 : 0,
      ),
      fetchItem: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'WL-IMPL') return { ok: true, info: implementItem(id) };
        return { ok: true, info: planItem(id) };
      }),
    });

    // File order: the implement root first (and selected). Its offer is held,
    // so dispatch falls through to the prep root.
    const entries = [
      makeEntry('inst-impl', 'WL-IMPL', '/repo/impl'),
      makeEntry('inst-prep', 'WL-PREP', '/repo/prep'),
    ];

    const outcome = await dispatchFromCoordination(deps, entries, {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: testDir,
      browseItemCount: 20,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    const prompts = spawnedPrompts(deps);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('WL-PREP');
    expect(prompts[0]).not.toContain('WL-IMPL');
    // The implement root's queue WAS consulted and found deep — the hold is the
    // only reason the mature implement offer lost to the prep offer.
    expect(deps.getReviewQueueCount).toHaveBeenCalledWith('/repo/impl');
  });

  // ── The concrete asymmetry case (WL-0MWKY1CIJ00462ZD, parent AC2) ──────
  //
  // The asymmetry is a real gate-coverage fact (pinned above), but it must not
  // starve a peer that HAS admissible work. Parent AC2's asymmetry case is the
  // decisive one: a root with only PREP offers versus a peer holding an
  // ADMISSIBLE implement offer (its review queue is shallow, so nothing holds
  // it). The whole-set round-robin + run-length deferral must serve the peer
  // within the bound — the prep root may not win every slot.

  it('a prep-only root does not win every slot while a peer holds an admissible implement offer', async () => {
    // Root A: prep-only, oldest (the natural "large prep backlog" winner).
    // Root B: an ADMISSIBLE non-critical implement offer — its review queue is
    // shallow, so no gate holds it; it is genuinely dispatchable work.
    seedCursor({
      '/repo/prep': '2026-01-01T00:00:00.000Z',
      '/repo/impl': '2026-01-02T00:00:00.000Z',
    });

    const baseNow = Date.UTC(2026, 0, 10, 0, 0, 0);
    const dispatchedKind: string[] = [];

    // Four ticks; each tick the owner re-offers its head after the consumed
    // offer was removed, exactly as the live path does.
    for (let tick = 0; tick < 4; tick += 1) {
      const deps = makeDeps({
        // Both queues shallow → the implement offer is ADMISSIBLE, not held.
        getReviewQueueCount: vi.fn().mockResolvedValue(0),
        fetchItem: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'WL-IMPL') return { ok: true, info: implementItem(id) };
          return { ok: true, info: planItem(id) };
        }),
      });
      const entries = [
        makeEntry('inst-prep', 'WL-PREP', '/repo/prep'),
        makeEntry('inst-impl', 'WL-IMPL', '/repo/impl'),
      ];
      const outcome = await dispatchFromCoordination(
        deps,
        entries,
        {
          model: 'plan',
          cwd: testDir, // decision log is read here (absent → fail-open)
          coordinationDir: testDir,
          browseItemCount: 20,
          // Surplus capacity: the fairness rule's precondition (parent AC1).
          freeSlots: 8,
          effectiveFreeSlots: 8,
        },
        baseNow + tick * 60_000,
      );
      expect(outcome.dispatched).toBe(true);
      const prompt = spawnedPrompts(deps)[0];
      dispatchedKind.push(prompt.includes('WL-IMPL') ? 'implement' : 'plan');
    }

    // The prep-only root does NOT win every slot: the admissible implement peer
    // is served, so the prep supply is never allowed to monopolise.
    expect(dispatchedKind).toContain('implement');
    expect(dispatchedKind.filter((kind) => kind === 'plan')).toHaveLength(2);
    // And the AC1 bound holds throughout — no run longer than twice.
    expect(
      maxConsecutiveRun(
        dispatchedKind.map((kind) => (kind === 'implement' ? '/repo/impl' : '/repo/prep')),
      ),
    ).toBeLessThanOrEqual(2);
  });

  it('the run-length deferral is the mechanism that serves the admissible implement peer', async () => {
    // Seed the run history so the prep root has ALREADY dispatched twice in
    // succession. The round-robin cursor makes the prep root due again, so only
    // the deferral (`deferRunLengthCeilingRoot`) can move the admissible
    // implement peer ahead of it.
    seedCursor({
      '/repo/prep': '2026-01-01T00:00:00.000Z',
      '/repo/impl': '2026-01-02T00:00:00.000Z',
    });
    seedDecisionLog(testDir, '/repo/prep', 2);

    const deps = makeDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(0),
      fetchItem: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'WL-IMPL') return { ok: true, info: implementItem(id) };
        return { ok: true, info: planItem(id) };
      }),
    });
    const entries = [
      makeEntry('inst-prep', 'WL-PREP', '/repo/prep'),
      makeEntry('inst-impl', 'WL-IMPL', '/repo/impl'),
    ];

    const outcome = await dispatchFromCoordination(deps, entries, {
      model: 'plan',
      cwd: testDir,
      coordinationDir: testDir,
      browseItemCount: 20,
      freeSlots: 8,
      effectiveFreeSlots: 8,
    });

    expect(outcome.dispatched).toBe(true);
    const prompt = spawnedPrompts(deps)[0];
    expect(prompt).toContain('WL-IMPL');
    expect(prompt).not.toContain('WL-PREP');
  });
});

/**
 * (The per-offer rejection attribution is scoped to ONE entry: a cross-entry
 * hold on another entry is intentionally NOT carried on this entry's success
 * outcome — see the `rejectionsBeforeEntry` slice in the leader loop. The
 * asymmetry test above therefore observes the hold through the queue read and
 * the dispatched kind, not through cross-entry attribution.)
 */
