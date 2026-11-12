/**
 * packages/herdr/src/downtime-worker.continuable-hold.replay.test.ts — the
 * cross-tick starvation replay for the continuable-hold rule
 * (WL-0MWCAMU2M007Y3PC, parent WL-0MW9X7EJ6009EL6E).
 *
 * The unit / dispatch-entry matrix lives in
 * `downtime-worker.continuable-hold.test.ts` (WL-0MWBT76WY00298AY). This file
 * adds the acceptance verification the parent requires:
 *
 *  AC1/AC2 — the starve scenario `[implement (budget-refused), plan]` is
 *            replayed on CONSECUTIVE ticks and the plan dispatches on the
 *            FIRST tick, deterministically, in both head-scan paths
 *            (`dispatchFromHerdrList` normal + critical-first, and
 *            `dispatchFromOwnHead` own-backlog fallback) and across
 *            registered roots. The plan's claim + dispatch marker + pane
 *            spawn are all asserted, not just the outcome.
 *  AC3     — a budget-only refusal is neutral end-to-end: no error strike, no
 *            no-candidate cooldown and no attempt-budget charge (no marker and
 *            no producer-review flag), so the very next poll can dispatch the
 *            prep candidate.
 *
 * AC4/AC5 are pinned at the dispatch-entry level in the unit matrix; AC6 is a
 * documentation check and AC7 is the shared full-suite run.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDowntimePoller,
  createDowntimeWorker,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  dispatchDowntimeWork,
  dispatchFromCoordination,
  type DowntimeHerdrItem,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import {
  idleAllSlotsFree,
  jsonResponseFixture,
  makeDeps,
  makeTempDir,
} from './downtime-worker.fixtures.js';

// ── Scenario fixtures ─────────────────────────────────────────────────

const SPRINT = 2;

/** A dispatchable `implement` head item (open, plan_complete). */
function implementItem(id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem {
  return {
    id,
    title: `Implement ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'high',
    risk: 'Low',
    effort: 'S',
    sortIndex: 1,
    ...overrides,
  };
}

/** A dispatchable `plan` head item (open, intake_complete). */
function planItem(id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem {
  return {
    id,
    title: `Plan ${id}`,
    status: 'open',
    stage: 'intake_complete',
    priority: 'high',
    sortIndex: 2,
    ...overrides,
  };
}

/** An in-view item no scan will dispatch (producer-review gate). */
function filteredItem(id: string): DowntimeHerdrItem {
  return implementItem(id, { needsProducerReview: true });
}

/** Refuse only the given budgeted kind; admit everything else. */
function budgetRefusal(kind: 'implement' | 'audit', reason: string, live = 2, max = 2) {
  return vi.fn(async (input: { kind: string }) =>
    input.kind === kind
      ? { admitted: false as const, live, max, reason }
      : { admitted: true as const, live: 0, max },
  );
}

/** Own-root canonical ranking: the in-view head, plus `tail` beyond it. */
function rankedOwnHead(head: DowntimeHerdrItem[], tail: DowntimeHerdrItem[]) {
  return vi.fn(async (_cwd: string, limit = SPRINT) => ({
    ok: true as const,
    items: limit <= SPRINT ? head : [...head, ...tail],
  }));
}

/** The leader deps slice needs a `fetchItem` seam even with zero offers. */
function leaderDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return makeDeps({
    fetchItem: vi
      .fn()
      .mockResolvedValue({ ok: true, info: { id: 'WL-X', status: 'open', stage: 'idea' } }),
    ...overrides,
  });
}

function dispatchLeader(deps: DowntimeWorkerDeps, coordinationDir: string, extra = {}) {
  return dispatchFromCoordination(deps, [], {
    model: 'plan',
    cwd: '/leader-root',
    coordinationDir,
    browseItemCount: SPRINT,
    ...extra,
  });
}

// ── AC1/AC2: dispatchFromHerdrList (normal + critical-first) ──────────

describe('cross-tick starve replay — dispatchFromHerdrList (AC1/AC2)', () => {
  it('normal scan dispatches the plan on the FIRST tick, deterministically', async () => {
    for (let run = 0; run < 3; run += 1) {
      const admitHostDispatch = budgetRefusal('implement', 'host-budget-implement');
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [implementItem('WL-IMP'), planItem('WL-PLAN')],
        }),
        admitHostDispatch,
      });

      const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      // The plan — not the budget-refused implement — wins the first tick.
      expect(first.dispatched).toBe(true);
      expect(first.kind).toBe('plan');
      expect(first.candidate?.id).toBe('WL-PLAN');
      // Claim + marker + spawn all completed for the plan.
      expect(deps.claimItem).toHaveBeenCalledWith(
        'WL-PLAN',
        { status: 'open', stage: 'intake_complete' },
        '/repo',
      );
      expect(deps.recordDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'WL-PLAN', kind: 'plan', selectionPath: 'normal-scan' }),
      );
      expect(deps.spawnAgentPane).toHaveBeenCalledWith(
        expect.stringContaining('/skill:plan WL-PLAN'),
        expect.anything(),
      );
      // The refused implement was never claimed or spawned, and the budget
      // seam is only consulted for the budgeted kind.
      expect(deps.spawnAgentPane).not.toHaveBeenCalledWith(
        expect.stringContaining('/skill:implement'),
        expect.anything(),
      );
      expect(admitHostDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'implement', itemId: 'WL-IMP' }),
      );
      expect(admitHostDispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'plan' }),
      );
    }
  });

  it('consecutive normal-scan ticks keep dispatching the plan (never starves)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [implementItem('WL-IMP'), planItem('WL-PLAN')],
      }),
      admitHostDispatch: budgetRefusal('implement', 'host-budget-implement'),
    });

    const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    for (const outcome of [first, second]) {
      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('WL-PLAN');
    }
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(2);
  });

  it('critical-first scan dispatches the plan on the FIRST tick, deterministically', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [
          implementItem('WL-CRIT-IMP', { priority: 'critical', sortIndex: 1 }),
          planItem('WL-CRIT-PLAN', { priority: 'critical', sortIndex: 2 }),
        ],
      }),
      admitHostDispatch: budgetRefusal('implement', 'host-budget-implement'),
    });

    const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(first.dispatched).toBe(true);
    expect(first.candidate?.id).toBe('WL-CRIT-PLAN');
    expect(deps.claimItem).toHaveBeenCalledWith(
      'WL-CRIT-PLAN',
      { status: 'open', stage: 'intake_complete' },
      '/repo',
    );
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'WL-CRIT-PLAN',
        kind: 'plan',
        selectionPath: 'critical-first',
      }),
    );
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-CRIT-PLAN'),
      expect.anything(),
    );
  });
});

// ── AC1/AC2: dispatchFromOwnHead own-backlog fallback ────────────────

describe('cross-tick starve replay — dispatchFromOwnHead fallback (AC1/AC2)', () => {
  it('dispatches the plan on the FIRST tick and again on the next', async () => {
    const deps = leaderDeps({
      getHerdrListHead: rankedOwnHead(
        [filteredItem('WL-VIEW-1'), filteredItem('WL-VIEW-2')],
        [implementItem('WL-IMP'), planItem('WL-PLAN')],
      ),
      admitHostDispatch: budgetRefusal('implement', 'host-budget-implement'),
    });
    const coordinationDir = makeTempDir('herdr-hold-replay-own-');

    const first = await dispatchLeader(deps, coordinationDir);
    const second = await dispatchLeader(deps, coordinationDir);

    for (const outcome of [first, second]) {
      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('WL-PLAN');
    }
    expect(deps.claimItem).toHaveBeenCalledWith('WL-PLAN', expect.anything(), '/leader-root');
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'WL-PLAN',
        kind: 'plan',
        selectionPath: 'own-backlog',
      }),
    );
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-PLAN'),
      expect.anything(),
    );
  });
});

// ── AC1/AC2: registered-root sweep crosses the refused root ──────────

describe('cross-tick starve replay — registered-root sweep (AC1/AC2)', () => {
  it('crosses the refused root and dispatches the plan on the FIRST tick and the next', async () => {
    const firstRoot = makeTempDir('herdr-hold-replay-root-a-');
    const secondRoot = makeTempDir('herdr-hold-replay-root-b-');
    const deps = leaderDeps({
      getHerdrListHead: vi.fn(async (cwd: string) => ({
        ok: true as const,
        items:
          cwd === firstRoot
            ? [implementItem('WL-REFUSED')]
            : cwd === secondRoot
              ? [planItem('WL-PLAN-B')]
              : [],
      })),
      admitHostDispatch: budgetRefusal('implement', 'host-budget-implement'),
    });
    const coordinationDir = makeTempDir('herdr-hold-replay-sweep-');
    const extra = { registeredRoots: [firstRoot, secondRoot] };

    const first = await dispatchLeader(deps, coordinationDir, extra);
    const second = await dispatchLeader(deps, coordinationDir, extra);

    for (const outcome of [first, second]) {
      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('WL-PLAN-B');
    }
    expect(deps.claimItem).toHaveBeenCalledWith('WL-PLAN-B', expect.anything(), secondRoot);
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'WL-PLAN-B',
        kind: 'plan',
        selectionPath: 'registered-root-sweep',
      }),
    );
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-PLAN-B'),
      expect.anything(),
    );
  });
});

// ── AC3: the neutral refusal end-to-end (no strike/cooldown/charge) ──

describe('worker cross-tick neutral refusal (AC3)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a budget-only refusal never strikes, never arms the cooldown and never charges the attempt budget', async () => {
    vi.useFakeTimers();
    const start = 1_000_000;
    vi.setSystemTime(start);

    const admitHostDispatch = budgetRefusal('implement', 'host-budget-implement');
    const getHerdrListHead = vi.fn().mockResolvedValue({
      ok: true,
      items: [implementItem('WL-IMP')],
    });
    const markNeedsProducerReview = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ getHerdrListHead, admitHostDispatch, markNeedsProducerReview });
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const worker = createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000', fetcher),
      deps,
      config: () => ({
        enabled: true,
        thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: '/repo',
        noCandidateCooldownMs: 3_600_000,
        browseItemCount: 20,
      }),
    });

    await worker.tick(); // idle run starts
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    const refused = await worker.tick();

    // No dispatch, but the tick is a NEUTRAL budget hold, not a failure.
    expect(refused.dispatched).toBe(false);
    expect(worker.errorStrikes).toBe(0);
    // No no-candidate cooldown armed (a cooldown would pause every tick).
    expect(worker.paused).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // No attempt-budget charge: no dispatch marker, no failure trace and no
    // producer-review flag for the refused candidate.
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.recordDispatchFailure).not.toHaveBeenCalled();
    expect(markNeedsProducerReview).not.toHaveBeenCalled();
    expect(admitHostDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'implement', itemId: 'WL-IMP' }),
    );

    // Because no cooldown was armed, adding the prep candidate dispatches on
    // the very next poll — far inside the 1 h no-candidate cooldown.
    getHerdrListHead.mockResolvedValue({
      ok: true,
      items: [implementItem('WL-IMP'), planItem('WL-PLAN')],
    });
    vi.setSystemTime(
      start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
    );
    const resumed = await worker.tick();

    expect(resumed.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-PLAN'),
      expect.anything(),
    );
  });
});
