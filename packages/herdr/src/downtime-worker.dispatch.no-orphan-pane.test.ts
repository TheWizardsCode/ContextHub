/**
 * packages/herdr/src/downtime-worker.dispatch.no-orphan-pane.test.ts —
 * regression coverage for the "dispatch opened a pane but never ran a command"
 * defect (WL-0MW5JE0SZ0057K30).
 *
 * Root cause: the item-ID tab (and herdr's empty placeholder root pane) was
 * provisioned BEFORE the CAS claim / reservation / host-budget gates, while
 * the placeholder cleanup only ran after a confirmed spawn. A refused tick
 * therefore left an empty pane in a fresh item tab — exactly the live
 * `w3G:p1BK` / `w57:pCV` evidence in the work item.
 *
 * The tests pin the two halves of the fix:
 *
 *  1. **Provisioning happens only once the dispatch is admitted.** A
 *     host-budget refusal (implement or audit) never touches the placement
 *     resolvers, so no tab — and therefore no placeholder pane — is created;
 *     on a successful dispatch the order is claim → admission → provision →
 *     marker → spawn (the F3 contract is unchanged: admission is still after
 *     the CAS claim and before the marker/spawn).
 *  2. **Defence in depth on the abort paths that DID provision.** A
 *     marker-write failure, a spawn failure and an `anchor-unavailable`
 *     failure leave no orphan: the placeholder root pane is closed
 *     (fail-safe — a reused live anchor and unavailable liveness are left
 *     open) and the claim/budget reservation are rolled back.
 *  3. **The pre-placement aborts never provision at all** — a lost claim
 *     (`claim-failed`) and a local-capacity reservation refusal return
 *     before the placement block, so there is no tab and therefore no pane
 *     to leak; and a TTL-below-bound grant is NOT an abort (it fails open
 *     with no ticket forwarded) — provisioning continues and the tab
 *     becomes the dispatch pane, so nothing is orphaned there either.
 *
 * Shared scaffolding (`makeDeps`, etc.) is imported from
 * `downtime-worker.fixtures.ts`; no setup logic is re-implemented here.
 */

import { describe, it, expect, vi } from 'vitest';
import { dispatchDowntimeWork } from './downtime-worker.js';
import { makeDeps } from './downtime-worker.fixtures.js';

const IMPLEMENT_CANDIDATE = {
  id: 'WL-ABC',
  title: 'Some task',
  stage: 'plan_complete' as const,
  status: 'open',
};

const AUDIT_CANDIDATE = {
  id: 'WL-AUD',
  title: 'Audit me',
  stage: 'audit' as const,
};

const ANCHOR_PANE_ID = 'wC:tWL-ABC:p1';
const LEGACY_ANCHOR_PANE_ID = 'wD:LEGACY';

/**
 * Placement deps that WOULD provision an item-ID tab if the pipeline reached
 * them: the project workspace resolves and `getItemTabAnchor` yields the tab's
 * root pane. Spying on them proves whether provisioning happened at all.
 */
function placementDeps() {
  return {
    resolveProjectWorkspace: vi
      .fn()
      .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
    getItemTabAnchor: vi
      .fn()
      .mockResolvedValue({ tabId: 'wC:tWL-ABC', paneId: ANCHOR_PANE_ID }),
  };
}

// ── AC1: a refused dispatch creates no pane ───────────────────────────

describe('no orphaned placeholder pane — admission refusal (WL-0MW5JE0SZ0057K30)', () => {
  it('AC1: an implement-tier host-budget refusal never provisions the item tab', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
      admitHostDispatch: vi.fn().mockResolvedValue({
        admitted: false,
        live: 2,
        max: 2,
        reason: 'host-budget-implement',
      }),
      ...placementDeps(),
      closePane: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('host-budget-implement');
    expect(outcome.budget).toEqual({ live: 2, max: 2 });
    // No provisioning: neither the project-workspace resolver nor the tab
    // creator was reached, so herdr never created a tab (or its root pane).
    expect(deps.resolveProjectWorkspace).not.toHaveBeenCalled();
    expect(deps.getItemTabAnchor).not.toHaveBeenCalled();
    // Nothing to clean up either — and the refused dispatch spammed no pane.
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // The claim is still rolled back so the item is re-selectable.
    expect(deps.rollbackClaim).toHaveBeenCalledWith(
      IMPLEMENT_CANDIDATE.id,
      { status: 'open', stage: 'plan_complete' },
      '/repo',
    );
  });

  it('AC1: an audit-tier host-budget refusal never provisions the item tab', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: AUDIT_CANDIDATE }),
      admitHostDispatch: vi.fn().mockResolvedValue({
        admitted: false,
        live: 1,
        max: 1,
        reason: 'host-budget-audit',
      }),
      ...placementDeps(),
      closePane: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('host-budget-audit');
    expect(deps.resolveProjectWorkspace).not.toHaveBeenCalled();
    expect(deps.getItemTabAnchor).not.toHaveBeenCalled();
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.rollbackClaim).toHaveBeenCalledWith(
      AUDIT_CANDIDATE.id,
      { status: 'completed', stage: 'in_review' },
      '/repo',
    );
  });

  it('AC1/AC5: an admitted dispatch provisions AFTER admission and BEFORE the marker/spawn', async () => {
    const getNextImplementCandidate = vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE);
    const admitHostDispatch = vi.fn().mockResolvedValue({
      admitted: true,
      live: 0,
      max: 2,
    });
    const deps = makeDeps({
      getNextImplementCandidate,
      admitHostDispatch,
      ...placementDeps(),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    const order = (spy: unknown): number =>
      (spy as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    // F3 contract preserved: the CAS claim precedes admission, which precedes
    // the marker and the spawn.
    expect(order(deps.claimItem)).toBeLessThan(order(admitHostDispatch));
    // The fix: placement/provisioning is AFTER admission (a refusal above can
    // therefore never leave a pane) and BEFORE the marker/spawn.
    expect(order(admitHostDispatch)).toBeLessThan(order(deps.resolveProjectWorkspace));
    expect(order(deps.resolveProjectWorkspace)).toBeLessThan(order(deps.getItemTabAnchor));
    expect(order(deps.getItemTabAnchor)).toBeLessThan(order(deps.recordDispatch));
    expect(order(deps.recordDispatch)).toBeLessThan(order(deps.spawnAgentPane));
    // …and the anchor still reaches the spawn so the pane lands in the tab.
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ anchorId: ANCHOR_PANE_ID }),
    );
  });
});

// ── AC2: every pre-spawn abort that DID provision leaves no orphan ────

describe('no orphaned placeholder pane — pre-spawn aborts (WL-0MW5JE0SZ0057K30)', () => {
  it('AC2: a marker-write failure closes the placeholder root pane', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
      recordDispatch: vi.fn().mockResolvedValue(false),
      ...placementDeps(),
      closePane: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('claim-rolled-back');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // The tab WAS just provisioned and the marker aborted the dispatch, so the
    // empty root pane is closed (default liveness: no live downtime panes).
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(deps.closePane).toHaveBeenCalledWith(ANCHOR_PANE_ID, '/repo');
    expect(deps.rollbackClaim).toHaveBeenCalled();
  });

  it('AC2: a spawn failure closes the placeholder root pane', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
      spawnAgentPane: vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'split failed', exitCode: 4 }),
      ...placementDeps(),
      closePane: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('spawn-failed');
    expect(deps.closePane).toHaveBeenCalledTimes(1);
    expect(deps.closePane).toHaveBeenCalledWith(ANCHOR_PANE_ID, '/repo');
    expect(deps.rollbackClaim).toHaveBeenCalled();
  });

  it('AC2: an anchor-unavailable failure rolls the claim back and releases the budget slot', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
      admitHostDispatch: vi.fn().mockResolvedValue({ admitted: true, live: 0, max: 2 }),
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
      getItemTabAnchor: vi.fn().mockResolvedValue(null),
      releaseHostDispatch: vi.fn().mockResolvedValue(undefined),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('anchor-unavailable');
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // Provisioning now runs after the claim, so the claim MUST be rolled back
    // (the pre-fix version never claimed on this path).
    expect(deps.rollbackClaim).toHaveBeenCalledWith(
      IMPLEMENT_CANDIDATE.id,
      { status: 'open', stage: 'plan_complete' },
      '/repo',
    );
    expect(deps.releaseHostDispatch).toHaveBeenCalledWith(
      IMPLEMENT_CANDIDATE.id,
      '/repo',
      { kind: 'implement', reason: 'anchor-unavailable' },
    );
  });
});

// ── AC2: pre-placement aborts — nothing to leak ─────────────────────

describe('no orphaned placeholder pane — pre-placement aborts (WL-0MW5JE0SZ0057K30)', () => {
  it('AC2: a lost claim (claim-failed) returns before any provisioning — no tab, no pane, no cleanup', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
      claimItem: vi.fn().mockResolvedValue({ ok: false, reason: 'stale' }),
      ...placementDeps(),
      closePane: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('claim-failed');
    // The claim was never won (a concurrent agent got there first): the
    // pipeline returns before the reservation/admission/placement gates, so
    // no tab (or placeholder root pane) is ever created and nothing needs
    // closing — the no-orphan guarantee holds by construction.
    expect(deps.resolveProjectWorkspace).not.toHaveBeenCalled();
    expect(deps.getItemTabAnchor).not.toHaveBeenCalled();
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // Nothing was won, so there is nothing to roll back either.
    expect(deps.rollbackClaim).not.toHaveBeenCalled();
  });

  it('AC2: a local-capacity reservation refusal returns before any provisioning — no tab, no pane, no cleanup', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
      reserveLocalCapacity: vi.fn().mockResolvedValue({
        status: 'refused',
        refusal: { reason: 'queue-full', retryAfterSeconds: 12 },
      }),
      ...placementDeps(),
      closePane: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('queue-full');
    expect(outcome.reservation).toMatchObject({
      admit: false,
      retryAfterS: 12,
      projectedWaitS: 12,
    });
    // The refusal returns before the placement block: no tab/placeholder
    // pane is ever created, so the no-orphan guarantee holds by construction.
    expect(deps.resolveProjectWorkspace).not.toHaveBeenCalled();
    expect(deps.getItemTabAnchor).not.toHaveBeenCalled();
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // The claim is rolled back so the item is re-selectable next idle period.
    expect(deps.rollbackClaim).toHaveBeenCalledWith(
      IMPLEMENT_CANDIDATE.id,
      { status: 'open', stage: 'plan_complete' },
      '/repo',
    );
  });

  it('AC2/AC5: a TTL-below-bound grant fails open and provisions — the tab becomes the dispatch pane, never an orphan', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
      reserveLocalCapacity: vi.fn().mockResolvedValue({
        status: 'granted',
        ticket: { ticketId: 'tkt-low-ttl', ttlSeconds: 5 },
      }),
      ...placementDeps(),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // TTL-below-bound is NOT a refusal (AC9): a ticket with less than the
    // documented usable window is never treated as capacity, so the grant
    // fails open — no ticket forwarded — and the pipeline CONTINUES to
    // provision rather than aborting before placement.
    expect(outcome.dispatched).toBe(true);
    expect(deps.resolveProjectWorkspace).toHaveBeenCalled();
    expect(deps.getItemTabAnchor).toHaveBeenCalled();
    // The short-lived ticket is never forwarded to the pane…
    expect(deps.spawnAgentPane).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reservationTicketId: expect.anything() }),
    );
    // …but the anchor still lands the dispatch pane in the provisioned tab,
    // so the placeholder becomes the real pane rather than an orphan.
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ anchorId: ANCHOR_PANE_ID }),
    );
    // The marker records WHY no ticket was forwarded (AC4 exchange naming).
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ reservationUnavailable: 'ttl-below-bound' }),
    );
    expect(deps.rollbackClaim).not.toHaveBeenCalled();
  });
});

// ── AC4: the fail-safe cleanup rules are preserved ───────────────────

describe('no orphaned placeholder pane — cleanup fail-safety (WL-0MW5JE0SZ0057K30)', () => {
  it('AC4: a reused tab whose anchor hosts a live downtime pane is never closed', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'split failed' }),
      ...placementDeps(),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({
        ok: true,
        count: 1,
        paneIds: [ANCHOR_PANE_ID],
        records: [{ paneId: ANCHOR_PANE_ID, label: 'Downtime triggered implement X - WL-ABC' }],
      }),
      closePane: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    // A reused tab's anchor IS the live dispatch pane — closing it would kill
    // a running agent session.
    expect(deps.closePane).not.toHaveBeenCalled();
  });

  it('AC4: unavailable liveness leaves the anchor open (fail-safe)', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'split failed' }),
      ...placementDeps(),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: false, error: 'herdr down' }),
      closePane: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    // Unknown liveness must never authorise a close.
    expect(deps.closePane).not.toHaveBeenCalled();
  });

  it('AC4: the retained legacy Dispatcher anchor is never closed on an abort', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(IMPLEMENT_CANDIDATE),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'split failed' }),
      resolveProjectWorkspace: vi.fn().mockResolvedValue(null),
      getDispatcherAnchor: vi
        .fn()
        .mockResolvedValue({ paneId: LEGACY_ANCHOR_PANE_ID, workspaceId: 'wD' }),
      closePane: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ anchorId: LEGACY_ANCHOR_PANE_ID }),
    );
    // Closing the persisted Dispatcher anchor would re-provision a blank pane.
    expect(deps.closePane).not.toHaveBeenCalled();
  });
});
