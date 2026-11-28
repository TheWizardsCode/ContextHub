/**
 * packages/herdr/src/downtime-worker.claim-dependency-guard.test.ts —
 * dispatch-time dependency re-check at the claim/spawn boundary (F3 of parent
 * WL-0MWWLLGD2001QKAL, WL-0MWWMPCD2008HSSP).
 *
 * ## What this pins
 *
 *  - AC1: a dispatch attempt at a dependency-blocked item is REFUSED at the
 *    claim boundary even when selection admitted it — no claim, no spawn. The
 *    selection stub is deliberately permissive (a NON-critical implement item,
 *    which the F2 critical-only head guard does not cover) so the test proves
 *    the claim-boundary guard is the thing that refuses.
 *  - AC2: a failed dependency lookup fails CLOSED and records the stable
 *    `dependency-lookup-failed` reason; a live edge records `dependency-blocked`.
 *  - AC3: the guard issues at most ONE blocker read per candidate per tick —
 *    the memo is shared with the F2 selection guard, so a critical candidate
 *    that both guards inspect costs a single `wl dep list`.
 *  - AC4: the reason tokens are the decision-log vocabulary (exported
 *    constants, documented in `docs/dev/downtime-dispatcher.md`).
 *
 * The audit exemption is pinned too: the audit tier re-checks freshness at
 * dispatch time and never consults the dependency seam.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  DEPENDENCY_BLOCKED_REASON,
  DEPENDENCY_LOOKUP_FAILED_REASON,
  createDependencyRecheckMemo,
  isDependencyHoldOutcome,
  memoizeBlockerFetcher,
  recheckDependenciesForClaim,
  type DependencyRecheckResult,
} from './downtime-worker.claim-dependency-guard.js';
import type { CriticalCandidate } from './downtime-worker.parsers.js';
import { dispatchClaimedTier } from './downtime-worker.dispatch-claims.js';
import { dispatchFromHerdrList } from './downtime-worker.dispatch-filter.js';
import { makeDeps } from './downtime-worker.fixtures.js';
import {
  dispatchDowntimeWork,
  type DowntimeCandidate,
  type DowntimeHerdrItem,
} from './downtime-worker.js';

// ── Fixtures ──────────────────────────────────────────────────────────

function blocker(id: string, overrides: Partial<CriticalCandidate> = {}): CriticalCandidate {
  return {
    id,
    title: `Blocker ${id}`,
    status: 'open',
    stage: 'intake_complete',
    risk: 'Medium',
    effort: 'S',
    sortIndex: 10,
    ...overrides,
  };
}

const CANDIDATE: DowntimeCandidate = {
  id: 'WL-DEP',
  title: 'Depends on someone',
  stage: 'plan_complete',
  status: 'open',
  priority: 'high',
  sortIndex: 100,
};

/** A NON-critical implement head item — F2's critical-only guard does not gate it. */
function headItem(id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem {
  return {
    id,
    title: `Head item ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'high',
    risk: 'Medium',
    effort: 'S',
    sortIndex: 100,
    needsProducerReview: false,
    ...overrides,
  };
}

function depsWithBlockers(
  fetchCriticalBlockers: ReturnType<typeof vi.fn>,
  overrides: Parameters<typeof makeDeps>[0] = {},
) {
  return {
    ...makeDeps(overrides),
    fetchCriticalBlockers,
  };
}

// ── Unit: the claim guard's verdicts ──────────────────────────────────

describe('recheckDependenciesForClaim', () => {
  it('admits an unblocked candidate', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue([]);

    const result = await recheckDependenciesForClaim(
      { fetchCriticalBlockers },
      'implement',
      'WL-DEP',
      '/repo',
    );

    expect(result).toEqual({ ok: true });
    expect(fetchCriticalBlockers).toHaveBeenCalledWith('/repo', 'WL-DEP');
  });

  it('refuses a candidate with a live outbound dependency', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue([blocker('WL-BLOCKER')]);

    const result = await recheckDependenciesForClaim(
      { fetchCriticalBlockers },
      'implement',
      'WL-DEP',
      '/repo',
    );

    expect(result).toEqual({
      ok: false,
      reason: DEPENDENCY_BLOCKED_REASON,
      itemId: 'WL-DEP',
    });
  });

  it('ignores terminal blockers (completed/deleted/in_review/done)', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue([
      blocker('WL-DONE', { status: 'completed' }),
      blocker('WL-DELETED', { status: 'deleted' }),
      blocker('WL-REVIEW', { stage: 'in_review' }),
      blocker('WL-DONE-STAGE', { stage: 'done' }),
    ]);

    const result = await recheckDependenciesForClaim(
      { fetchCriticalBlockers },
      'plan',
      'WL-DEP',
      '/repo',
    );

    expect(result).toEqual({ ok: true });
  });

  it('fails CLOSED when the lookup returns the legacy null signal', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue(null);

    const result = await recheckDependenciesForClaim(
      { fetchCriticalBlockers },
      'implement',
      'WL-DEP',
      '/repo',
    );

    expect(result).toEqual({
      ok: false,
      reason: DEPENDENCY_LOOKUP_FAILED_REASON,
      itemId: 'WL-DEP',
    });
  });

  it('fails CLOSED when the lookup throws', async () => {
    const fetchCriticalBlockers = vi.fn().mockRejectedValue(new Error('wl dep list failed'));

    const result = await recheckDependenciesForClaim(
      { fetchCriticalBlockers },
      'implement',
      'WL-DEP',
      '/repo',
    );

    expect(result).toEqual({
      ok: false,
      reason: DEPENDENCY_LOOKUP_FAILED_REASON,
      itemId: 'WL-DEP',
    });
  });

  it('exempts the audit tier (it re-checks freshness instead)', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue([blocker('WL-BLOCKER')]);

    const result = await recheckDependenciesForClaim(
      { fetchCriticalBlockers },
      'audit',
      'WL-DEP',
      '/repo',
    );

    expect(result).toEqual({ ok: true });
    expect(fetchCriticalBlockers).not.toHaveBeenCalled();
  });

  it('is inert without the seam (legacy/test callers unchanged)', async () => {
    const result = await recheckDependenciesForClaim({}, 'implement', 'WL-DEP', '/repo');

    expect(result).toEqual({ ok: true });
  });

  it('reads a candidate at most once per tick when a memo is supplied (AC3)', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue([blocker('WL-BLOCKER')]);
    const memo = createDependencyRecheckMemo();

    const first = await recheckDependenciesForClaim(
      { fetchCriticalBlockers },
      'implement',
      'WL-DEP',
      '/repo',
      memo,
    );
    const second = await recheckDependenciesForClaim(
      { fetchCriticalBlockers },
      'implement',
      'WL-DEP',
      '/repo',
      memo,
    );

    expect(first).toEqual(second);
    expect(fetchCriticalBlockers).toHaveBeenCalledTimes(1);
  });

  it('keys the memo by root as well as item id (cross-root offers)', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue([]);
    const memo = createDependencyRecheckMemo();

    await recheckDependenciesForClaim({ fetchCriticalBlockers }, 'implement', 'WL-DEP', '/a', memo);
    await recheckDependenciesForClaim({ fetchCriticalBlockers }, 'implement', 'WL-DEP', '/b', memo);

    expect(fetchCriticalBlockers).toHaveBeenCalledTimes(2);
  });
});

describe('memoizeBlockerFetcher', () => {
  it('shares one in-flight read between concurrent callers', async () => {
    let resolveRead: (value: CriticalCandidate[]) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise<CriticalCandidate[]>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const memo = createDependencyRecheckMemo();
    const memoized = memoizeBlockerFetcher(fetch, memo);

    const a = memoized('/repo', 'WL-DEP');
    const b = memoized('/repo', 'WL-DEP');
    // The read is deferred to a microtask so the in-flight promise is cached
    // BEFORE the fetch starts (both callers then share that one promise).
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    resolveRead([blocker('WL-BLOCKER')]);

    expect(await a).toBe(await b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('isDependencyHoldOutcome', () => {
  it('recognises both dependency tokens and nothing else', () => {
    expect(isDependencyHoldOutcome({ reason: DEPENDENCY_BLOCKED_REASON })).toBe(true);
    expect(isDependencyHoldOutcome({ reason: DEPENDENCY_LOOKUP_FAILED_REASON })).toBe(true);
    expect(isDependencyHoldOutcome({ reason: 'no-candidate' })).toBe(false);
    expect(isDependencyHoldOutcome({})).toBe(false);
  });
});

// ── AC1/AC2: the claim boundary refuses before claim and spawn ────────

describe('dispatchClaimedTier — dependency re-check before claim', () => {
  it('refuses a blocked candidate with NO claim and NO spawn (AC1)', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue([blocker('WL-BLOCKER')]);
    const deps = depsWithBlockers(fetchCriticalBlockers);

    const outcome = await dispatchClaimedTier(deps, 'implement', CANDIDATE, {
      model: 'plan',
      cwd: '/repo',
    });

    expect(outcome).toMatchObject({ dispatched: false, reason: DEPENDENCY_BLOCKED_REASON });
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it('refuses fail-closed on a failed lookup, recording the reason (AC2)', async () => {
    const fetchCriticalBlockers = vi.fn().mockRejectedValue(new Error('boom'));
    const deps = depsWithBlockers(fetchCriticalBlockers);

    const outcome = await dispatchClaimedTier(deps, 'implement', CANDIDATE, {
      model: 'plan',
      cwd: '/repo',
    });

    expect(outcome).toMatchObject({
      dispatched: false,
      reason: DEPENDENCY_LOOKUP_FAILED_REASON,
    });
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('claims an unblocked candidate (the guard is not a blanket refusal)', async () => {
    const deps = depsWithBlockers(vi.fn().mockResolvedValue([]));

    await dispatchClaimedTier(deps, 'implement', CANDIDATE, {
      model: 'plan',
      cwd: '/repo',
    });

    expect(deps.claimItem).toHaveBeenCalledTimes(1);
  });

  it('exempts the audit tier', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue([blocker('WL-BLOCKER')]);
    const deps = depsWithBlockers(fetchCriticalBlockers);

    await dispatchClaimedTier(
      deps,
      'audit',
      { id: 'WL-AUD', title: 'Audit', stage: 'audit', status: 'completed' },
      { model: 'plan', cwd: '/repo' },
    );

    expect(fetchCriticalBlockers).not.toHaveBeenCalled();
    expect(deps.claimItem).toHaveBeenCalledTimes(1);
  });

  it('reads the candidate once when the same tick memo is reused (AC3)', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue([blocker('WL-BLOCKER')]);
    const deps = depsWithBlockers(fetchCriticalBlockers);
    const memo = createDependencyRecheckMemo();

    const first: DependencyRecheckResult = await recheckDependenciesForClaim(
      deps,
      'implement',
      CANDIDATE.id,
      '/repo',
      memo,
    );
    expect(first.ok).toBe(false);

    // The same candidate re-attempted in the same tick (e.g. the leader's
    // own-backlog fallback): served from the memo, no second `wl dep list`.
    const outcome = await dispatchClaimedTier(deps, 'implement', CANDIDATE, {
      model: 'plan',
      cwd: '/repo',
      dependencyRecheckMemo: memo,
    });

    expect(outcome.reason).toBe(DEPENDENCY_BLOCKED_REASON);
    expect(fetchCriticalBlockers).toHaveBeenCalledTimes(1);
    expect(deps.claimItem).not.toHaveBeenCalled();
  });
});

// ── AC1: a permissive selection cannot dispatch a blocked item ────────

describe('end-to-end: permissive selection still cannot dispatch a blocked item', () => {
  it('refuses a NON-critical implement candidate selection admitted (AC1)', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue([blocker('WL-BLOCKER')]);
    const deps = depsWithBlockers(fetchCriticalBlockers, {
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [headItem('WL-NONCRIT')],
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome).toMatchObject({ dispatched: false, reason: DEPENDENCY_BLOCKED_REASON });
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });
});

// ── AC3: the claim guard SHARES the selection guard's tick memo ───────

describe('shared per-tick memo with the F2 selection guard', () => {
  it('reads a critical candidate ONCE even though both guards inspect it', async () => {
    const fetchCriticalBlockers = vi.fn().mockResolvedValue([]);
    const deps = depsWithBlockers(fetchCriticalBlockers, {
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [headItem('WL-CRIT', { priority: 'critical' })],
      }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // F2's frontier walk ran (the candidate is critical) AND the claim guard
    // ran — both through the SAME per-tick memo, so exactly one dep read.
    expect(fetchCriticalBlockers).toHaveBeenCalledTimes(1);
    expect(fetchCriticalBlockers).toHaveBeenCalledWith('/repo', 'WL-CRIT');
    expect(deps.claimItem).toHaveBeenCalledTimes(1);
  });

  it('reads a redirected blocker once too (F2 redirect then claim guard)', async () => {
    const fetchCriticalBlockers = vi.fn(async (_cwd: string, id: string) =>
      id === 'WL-CRIT' ? [blocker('WL-BLOCKER', { stage: 'plan_complete' })] : [],
    );
    const deps = depsWithBlockers(fetchCriticalBlockers, {
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [headItem('WL-CRIT', { priority: 'critical' })],
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // The redirect target is the blocker; its claim-boundary re-check is served
    // from the SAME memo (F2 already read it while walking the chain).
    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('WL-BLOCKER');
    expect(fetchCriticalBlockers.mock.calls.filter(([, id]) => id === 'WL-BLOCKER')).toHaveLength(1);
  });
});
