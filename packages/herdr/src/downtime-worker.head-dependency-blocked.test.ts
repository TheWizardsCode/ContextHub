/**
 * packages/herdr/src/downtime-worker.head-dependency-blocked.test.ts — the
 * dependency-blocked critical-leaf regression for the Herdr-head
 * dispatch/offer paths (F1 of parent WL-0MWWLLGD2001QKAL).
 *
 * ## The invariant being pinned
 *
 * A critical item that carries a live `depends-on` edge to a non-terminal
 * blocker must **never be dispatched at itself** on the Herdr-head path. The
 * nearest open dispatchable blocker is the target (with ITS stage-appropriate
 * skill), or nothing is dispatched this tick. Display/worklist behaviour is
 * untouched: blocked items still appear there (WL-0MV6TFX0600145M2).
 *
 * ## Why this is a RED witness
 *
 * The live head path — `dispatchFromHerdrList` (via `dispatchDowntimeWork`)
 * and the offer computation (`computeMostImportantItem`) — selects critical
 * work through `selectCriticalFirstCandidates`, which today filters only on
 * priority, status, `needsProducerReview` and `classifyItemForDispatch`. It
 * never consults `depends-on`, so the canonical observed shape
 * (`critical` + `stage: plan_complete` + `risk: Medium` + `effort: S` + a
 * live edge to a non-terminal blocker) classifies as `implement` and is
 * dispatched at itself. The legacy tier chain's
 * `resolveDependencyFrontier` is not reached on this path.
 *
 * These specs assert the FIXED behaviour. They were committed by F1 as vitest
 * `it.fails(...)` (the repo's documented TDD pattern — see
 * `downtime-worker.orchestrator.test.ts`, `coordination-dispatch.test.ts` and
 * `host-dispatch-budget.test.ts`) so the suite stayed green while the defect
 * was open; F2 (WL-0MWWMPBL8003X59M, the shared dependency-frontier guard)
 * flipped each body to `it` as it landed. The RED state is recorded in the F1
 * work-item comment.
 *
 * ## Injected blocker seam
 *
 * The guard will consume an injected blocker fetcher named
 * `fetchCriticalBlockers` (the existing `wl dep list` seam, see
 * `index.claim.ts`). The seam is NOT yet on `DowntimeWorkerDeps`, so this
 * file reaches it through an intersection type — the same device the
 * `coordination-registered-root-sweep.test.ts` header documents — keeping the
 * file compilable before the seam exists. F2 MUST keep this seam name (or
 * update this file in the same commit) when it wires the guard.
 *
 * ## Parent AC coverage
 *
 * - **AC1** — chain-bottoms (no candidate / no dispatch) and
 *   frontier-available (dispatch the blocker, never the blocked item), on
 *   both the direct-dispatch and offer paths.
 * - **AC2** — the canonical blocked-leaf shape above is the fixture.
 * - **AC3** — the exclusion holds with `needsProducerReview: false` (the RED
 *   witnesses) AND with the flag `true` (regression pin), proving the flag is
 *   not the guard.
 * - **Fail-closed** — a blocker lookup that throws or yields `null` produces
 *   no dispatch at the blocked item and does not crash the tick.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  computeMostImportantItem,
  dispatchDowntimeWork,
  type CriticalCandidate,
  type DowntimeHerdrItem,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import { makeDeps } from './downtime-worker.fixtures.js';

// ── The future blocker-fetcher seam ─────────────────────────────────────
// `fetchCriticalBlockers(cwd, itemId)` mirrors the legacy `wl dep list`
// seam used by `resolveDependencyFrontier`. It returns the item's outbound
// `depends-on` targets (already enriched), THROWS on a lookup/parse failure,
// and is optional so existing fakes keep compiling. F2 adds it to
// `DowntimeWorkerDeps`/`DowntimeDispatchDeps`; until then the intersection
// below lets these specs inject and read it.
type BlockerFetcher = (cwd: string, itemId: string) => Promise<CriticalCandidate[] | null>;

interface DowntimeWorkerDepsWithBlockers extends DowntimeWorkerDeps {
  fetchCriticalBlockers?: BlockerFetcher;
}

// ── Fixtures ────────────────────────────────────────────────────────────

/**
 * The canonical observed shape reported on `AH-0MWWARFUK009KQM7`:
 * `critical` + `stage: plan_complete` + `risk: Medium` + `effort: S`,
 * deliberately `needsProducerReview: false` so no assertion can lean on that
 * flag for the exclusion.
 */
function blockedLeaf(
  id: string,
  overrides: Partial<DowntimeHerdrItem> = {},
): DowntimeHerdrItem {
  return {
    id,
    title: `Blocked critical leaf ${id}`,
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

/** An OPEN, dispatchable blocker at `intake_complete` (→ `/skill:plan`). */
function openBlocker(id: string): CriticalCandidate {
  return {
    id,
    title: `Open blocker ${id}`,
    status: 'open',
    stage: 'intake_complete',
    priority: 'critical',
    risk: 'Medium',
    effort: 'S',
    sortIndex: 50,
  };
}

/** A NON-dispatchable, non-terminal blocker (`in_progress`) — chain bottoms. */
function nonDispatchableBlocker(id: string): CriticalCandidate {
  return {
    id,
    title: `Non-dispatchable blocker ${id}`,
    status: 'in_progress',
    stage: 'in_progress',
    priority: 'critical',
    risk: 'Medium',
    effort: 'S',
    sortIndex: 60,
  };
}

// ── Test scaffolding ────────────────────────────────────────────────────

/**
 * Build a full deps object whose Herdr head is `items`, with the blocker
 * fetcher injected. `claimItem` / `spawnAgentPane` / `recordDispatch` succeed
 * by default so a dispatch (the pre-fix behaviour) is observable rather than
 * swallowed by an unrelated gate.
 */
function depsWithBlockers(
  items: DowntimeHerdrItem[],
  fetchCriticalBlockers: BlockerFetcher,
  overrides: Partial<DowntimeWorkerDeps> = {},
): DowntimeWorkerDepsWithBlockers {
  return {
    ...makeDeps(overrides),
    fetchCriticalBlockers,
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── AC1: chain bottoms — nothing is dispatched at the blocked item ────────
//
// The blocked leaf's dependency chain bottoms in a non-dispatchable
// (`in_progress`) blocker with no open descendants. The guard must resolve
// the frontier to nothing: no dispatch at the blocked item this tick.

describe('AC1: dependency-blocked critical leaf — chain bottoms (RED witness)', () => {
  it(
    'no dispatch at a plan_complete critical whose dependency chain bottoms in an in_progress blocker',
    async () => {
      const BLOCKED = 'WL-BLOCKED-LEAF';
      const BLOCKER = 'WL-BLOCKER-INPROG';
      const deps = depsWithBlockers(
        [blockedLeaf(BLOCKED)],
        async (_cwd, id) =>
          id === BLOCKED ? [nonDispatchableBlocker(BLOCKER)] : [],
      );

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      // Absence of dispatch AT THE BLOCKED ITEM is the assertion (not merely
      // that some other item was chosen).
      expect(outcome.dispatched).toBe(false);
      expect(outcome.candidate?.id).not.toBe(BLOCKED);
      expect(deps.claimItem).not.toHaveBeenCalledWith(
        BLOCKED,
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it(
    'the offer path also refuses a chain-bottoming blocked item',
    async () => {
      const BLOCKED = 'WL-BLOCKED-LEAF';
      const BLOCKER = 'WL-BLOCKER-INPROG';
      const deps = depsWithBlockers(
        [blockedLeaf(BLOCKED)],
        async (_cwd, id) =>
          id === BLOCKED ? [nonDispatchableBlocker(BLOCKER)] : [],
      );

      const offer = await computeMostImportantItem(deps, '/repo');

      // A chain-bottoming frontier yields no offer: never the blocked item.
      expect(offer).toMatchObject({ ok: true, noCandidate: true });
      expect((offer as { candidate?: { id: string } }).candidate?.id).not.toBe(BLOCKED);
    },
  );
});

// ── AC1/AC2: frontier available — dispatch the nearest open blocker ────────
//
// The blocked leaf's dependency resolves to an OPEN blocker at
// `intake_complete`. The guard must return that blocker as the dispatch
// target with its stage-appropriate skill (`plan`), never the blocked item
// (`implement`).

describe('AC1/AC2: dependency-blocked critical leaf — frontier available (RED witness)', () => {
  it(
    'dispatches the nearest open blocker with its stage-appropriate skill, never the blocked item',
    async () => {
      const BLOCKED = 'WL-BLOCKED-LEAF';
      const BLOCKER = 'WL-BLOCKER-OPEN';
      const deps = depsWithBlockers(
        [blockedLeaf(BLOCKED)],
        async (_cwd, id) => (id === BLOCKED ? [openBlocker(BLOCKER)] : []),
      );

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      // The target is the BLOCKER, with ITS stage-appropriate skill.
      expect(outcome.candidate?.id).toBe(BLOCKER);
      expect(outcome.kind).toBe('plan'); // intake_complete → /skill:plan
      // Explicitly never the blocked item.
      expect(outcome.candidate?.id).not.toBe(BLOCKED);
      expect(deps.claimItem).toHaveBeenCalledWith(
        BLOCKER,
        expect.anything(),
        expect.anything(),
      );
      expect(deps.claimItem).not.toHaveBeenCalledWith(
        BLOCKED,
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it(
    'the offer path offers the blocker, never the blocked item (direct/offer parity)',
    async () => {
      const BLOCKED = 'WL-BLOCKED-LEAF';
      const BLOCKER = 'WL-BLOCKER-OPEN';
      const deps = depsWithBlockers(
        [blockedLeaf(BLOCKED)],
        async (_cwd, id) => (id === BLOCKED ? [openBlocker(BLOCKER)] : []),
      );

      const offer = await computeMostImportantItem(deps, '/repo');

      // Both paths must select the same frontier target (F2's shared guard).
      expect(offer).toMatchObject({ ok: true, candidate: { id: BLOCKER } });
      expect((offer as { candidate?: { id: string } }).candidate?.id).not.toBe(BLOCKED);
    },
  );
});

// ── Fail-closed: a blocker-lookup failure yields no dispatch ──────────────
//
// A `wl dep list` failure must never masquerade as "no blockers": the guard
// fails closed — no dispatch at the blocked item, no crash. A `null` result
// is the same "unavailable" signal (the legacy parser's fail-closed shape).

describe('Fail-closed: a blocker-lookup failure yields no dispatch (RED witness)', () => {
  it(
    'a blocker-fetcher exception fails closed — no dispatch at the blocked item, no crash',
    async () => {
      const BLOCKED = 'WL-BLOCKED-LEAF';
      const deps = depsWithBlockers([blockedLeaf(BLOCKED)], async () => {
        throw new Error('wl dep list failed');
      });

      // Must not reject: a lookup failure is a held tick, not a crash.
      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.candidate?.id).not.toBe(BLOCKED);
    },
  );

  it(
    'a null blocker result fails closed — no dispatch at the blocked item',
    async () => {
      const BLOCKED = 'WL-BLOCKED-LEAF';
      const deps = depsWithBlockers([blockedLeaf(BLOCKED)], async () => null);

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.candidate?.id).not.toBe(BLOCKED);
    },
  );
});

// ── AC3: producer-review variant — the flag is NOT the guard ─────────────
//
// When `needsProducerReview` is true the item is already excluded today by
// the producer-review gate, so this spec is a plain `it` regression pin
// rather than a RED witness. Together with the flag-FALSE RED witnesses
// above it proves the flag is not the dependency guard: the exclusion holds
// without it, and it does not weaken the guard when set.

describe('AC3: producer-review variant — still no dispatch at the blocked item', () => {
  it(
    'a dependency-blocked critical with needsProducerReview: true is still not dispatched',
    async () => {
      const BLOCKED = 'WL-BLOCKED-NPR';
      const BLOCKER = 'WL-BLOCKER-OPEN';
      const deps = depsWithBlockers(
        [blockedLeaf(BLOCKED, { needsProducerReview: true })],
        async (_cwd, id) => (id === BLOCKED ? [openBlocker(BLOCKER)] : []),
      );

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.candidate?.id).not.toBe(BLOCKED);
    },
  );
});
