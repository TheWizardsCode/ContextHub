/**
 * packages/herdr/src/downtime-worker.head-dependency-guard.test.ts — the
 * shared dependency-frontier guard for the Herdr-head dispatch/offer paths
 * (F2 of parent WL-0MWWLLGD2001QKAL, WL-0MWWMPBL8003X59M).
 *
 * ## What this pins
 *
 * `resolveHeadDependencyFrontier` is the ONE place the head/coordination paths
 * consult a work item's outbound `depends-on` edges. The direct dispatcher
 * (`dispatchFromHerdrList`) and the offer computation (`computeMostImportantItem`)
 * both call it, so they cannot drift:
 *
 *  - unblocked → the candidate is its own target;
 *  - dependency-blocked + resolvable → the nearest open dispatchable blocker is
 *    the target, carrying ITS stage-appropriate skill;
 *  - dependency-blocked + chain bottoms → no target (nothing dispatched at the
 *    blocked item);
 *  - blocker lookup throws / returns `null` → FAIL CLOSED with the stable
 *    `dependency-lookup-failed` reason (never a silent wrong target).
 *
 * The behavioural witnesses (both paths, both outcomes) live in
 * `downtime-worker.head-dependency-blocked.test.ts`; this file unit-tests the
 * guard itself and asserts the two call sites share it (no duplicated frontier
 * logic).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  computeMostImportantItem,
  dispatchDowntimeWork,
  resolveHeadDependencyFrontier,
  type CriticalCandidate,
  type DowntimeHerdrItem,
} from './downtime-worker.js';
import type { CriticalFirstCandidate } from './downtime-worker.dispatch-filter.js';
import { makeDeps } from './downtime-worker.fixtures.js';

// ── Fixtures ────────────────────────────────────────────────────────────

function headItem(
  id: string,
  overrides: Partial<DowntimeHerdrItem> = {},
): DowntimeHerdrItem {
  return {
    id,
    title: `Head item ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'critical',
    risk: 'Medium',
    effort: 'S',
    sortIndex: 100,
    needsProducerReview: false,
    ...overrides,
  };
}

function blocker(
  id: string,
  overrides: Partial<CriticalCandidate> = {},
): CriticalCandidate {
  return {
    id,
    title: `Blocker ${id}`,
    status: 'open',
    stage: 'intake_complete',
    risk: 'Medium',
    effort: 'S',
    sortIndex: 50,
    ...overrides,
  };
}

const HEAD: CriticalFirstCandidate = { item: headItem('WL-HEAD'), kind: 'implement' };

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Unit: the guard's verdicts ──────────────────────────────────────────

describe('resolveHeadDependencyFrontier', () => {
  it('returns the candidate unchanged when it is not dependency-blocked', async () => {
    const fetchBlockers = vi.fn().mockResolvedValue([]);

    const result = await resolveHeadDependencyFrontier(HEAD, fetchBlockers, '/repo');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The ORIGINAL object, so callers can detect "no redirect".
    expect(result.target).toBe(HEAD);
    expect(fetchBlockers).toHaveBeenCalledWith('/repo', 'WL-HEAD');
  });

  it('redirects a dependency-blocked candidate to the nearest open blocker with its own skill', async () => {
    const fetchBlockers = vi.fn(async (_cwd: string, id: string) =>
      id === 'WL-HEAD' ? [blocker('WL-BLOCKER', { sortIndex: 10 }), blocker('WL-LATER', { sortIndex: 20 })] : [],
    );

    const result = await resolveHeadDependencyFrontier(HEAD, fetchBlockers, '/repo');

    expect(result.ok).toBe(true);
    if (!result.ok || result.target === null) throw new Error('expected redirect');
    expect(result.target.item.id).toBe('WL-BLOCKER');
    // intake_complete → /skill:plan (the BLOCKER's stage, not the head's).
    expect(result.target.kind).toBe('plan');
  });

  it('walks through a blocking blocker to the nearest open ancestor', async () => {
    // HEAD → MID (dependency-blocked) → ANCESTOR (open, dispatchable).
    const fetchBlockers = vi.fn(async (_cwd: string, id: string) => {
      if (id === 'WL-HEAD') return [blocker('WL-MID', { stage: 'plan_complete' })];
      if (id === 'WL-MID') return [blocker('WL-ANCESTOR', { stage: 'idea' })];
      return [];
    });

    const result = await resolveHeadDependencyFrontier(HEAD, fetchBlockers, '/repo');

    expect(result.ok).toBe(true);
    if (!result.ok || result.target === null) throw new Error('expected redirect');
    expect(result.target.item.id).toBe('WL-ANCESTOR');
    expect(result.target.kind).toBe('intake'); // idea → /skill:intake
  });

  it('returns no target when the dependency chain bottoms in a non-dispatchable blocker', async () => {
    const fetchBlockers = vi.fn(async (_cwd: string, id: string) =>
      id === 'WL-HEAD'
        ? [blocker('WL-INPROG', { status: 'in_progress', stage: 'in_progress' })]
        : [],
    );

    const result = await resolveHeadDependencyFrontier(HEAD, fetchBlockers, '/repo');

    expect(result).toEqual({ ok: true, target: null });
  });

  it('fails closed when the blocker lookup throws', async () => {
    const fetchBlockers = vi.fn().mockRejectedValue(new Error('wl dep list failed'));

    const result = await resolveHeadDependencyFrontier(HEAD, fetchBlockers, '/repo');

    expect(result).toEqual({ ok: false, reason: 'dependency-lookup-failed', itemId: 'WL-HEAD' });
  });

  it('fails closed when the blocker lookup returns the legacy null signal', async () => {
    const fetchBlockers = vi.fn().mockResolvedValue(null);

    const result = await resolveHeadDependencyFrontier(HEAD, fetchBlockers, '/repo');

    expect(result).toEqual({ ok: false, reason: 'dependency-lookup-failed', itemId: 'WL-HEAD' });
  });

  it('is inert when the seam is absent (legacy/test callers unchanged)', async () => {
    const result = await resolveHeadDependencyFrontier(HEAD, undefined, '/repo');

    expect(result).toEqual({ ok: true, target: HEAD });
  });
});

// ── Both paths share the guard (no duplicated frontier logic) ────────────

/**
 * A blocked critical head item whose blocker resolves to an open `intake_complete`
 * item, with an observable blocker fetcher. No `vi.fn()` overrides beyond the
 * fetcher: `makeDeps` already answers the neutral "nothing else to do".
 */
function depsWithFetcher(items: DowntimeHerdrItem[], fetchCriticalBlockers: ReturnType<typeof vi.fn>) {
  return {
    ...makeDeps(),
    fetchCriticalBlockers,
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
  };
}

describe('direct-dispatch and offer paths consult the SAME guard', () => {
  it('both paths resolve the blocked candidate through the injected blocker fetcher', async () => {
    const blocked = headItem('WL-HEAD');
    const fetchBlockers = vi.fn(async (_cwd: string, id: string) =>
      id === 'WL-HEAD' ? [blocker('WL-BLOCKER')] : [],
    );

    const directDeps = depsWithFetcher([blocked], fetchBlockers);
    await dispatchDowntimeWork(directDeps, { model: 'plan', cwd: '/repo' });

    const offerDeps = depsWithFetcher([blocked], fetchBlockers);
    await computeMostImportantItem(offerDeps, '/repo');

    // One call per path for the blocked candidate — the shared guard, not two
    // independent frontier implementations.
    expect(fetchBlockers).toHaveBeenCalledWith('/repo', 'WL-HEAD');
    expect(fetchBlockers.mock.calls.filter(([, id]) => id === 'WL-HEAD').length).toBeGreaterThanOrEqual(2);
  });

  it('the direct path fails closed with the stable dependency-lookup-failed reason', async () => {
    const deps = depsWithFetcher([headItem('WL-HEAD')], vi.fn().mockRejectedValue(new Error('boom')));

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('dependency-lookup-failed');
    expect(outcome.candidate?.id).not.toBe('WL-HEAD');
  });

  it('the offer path fails closed with the dependency-lookup-failed attribution', async () => {
    const deps = depsWithFetcher([headItem('WL-HEAD')], vi.fn().mockResolvedValue(null));

    const offer = await computeMostImportantItem(deps, '/repo');

    expect(offer).toMatchObject({
      ok: true,
      noCandidate: true,
      attribution: { reason: 'dependency-lookup-failed' },
    });
    expect((offer as { candidate?: { id: string } }).candidate?.id).not.toBe('WL-HEAD');
  });
});
