/**
 * packages/herdr/src/downtime-worker.audit-tier.test.ts — audit-tier tests
 *
 * Split out of the monolithic `downtime-worker.test.ts`
 * (WL-0MV28X3SL005R5KX / WL-0MV4V6LJQ0050FZX) to keep each test file focused
 * on one concern.
 *
 * Covers the audit dispatch tier and its fail-closed claim paths:
 *   - `dispatch audit tier` — tier priority, fall-through and wl-error strikes,
 *   - `audit tier interim freshness re-check` — the fresh-audit guard,
 *   - `dispatch active-audit single-flight` — per-worklog sequential audits,
 *   - `dispatch host-wide audit saturation` — machine-wide audit serialisation,
 *   - `dispatch tier free-slot minimums` — per-tier pane/free-slot gates,
 *   - `dispatch audit trail` — claim/marker/spawn ordering and rollback, and
 *   - `dispatch CAS claim race` — compare-and-swap claim races and recovery.
 *
 * Shared scaffolding (`makeDeps`, etc.) is imported from
 * `downtime-worker.fixtures.ts`; no setup logic is re-implemented here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  dispatchDowntimeWork,
  createDowntimeWorker,
  createDowntimePoller,
  DOWNTIME_AUDIT_MIN_FREE_SLOTS,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  type DowntimeCandidate,
  type DowntimeActiveAuditResult,
  type DowntimeWorkerDeps,
  type DowntimeHerdrItem,
} from './downtime-worker.js';
import {
  ago,
  createTempDirTracker,
  idleAllSlotsFree,
  jsonResponseFixture,
  makeDeps,
  writeDowntimeLog,
} from './downtime-worker.fixtures.js';

// ── Audit-tier dispatch (WL-0MSI8H3HP000K0RG) ─────────────────────────

describe('dispatch audit tier', () => {
  const staleCandidate: DowntimeCandidate = {
    id: 'WL-AUD',
    title: 'Audit me',
    stage: 'audit',
  };

  it('dispatches /skill:audit on the audit candidate as the first tier', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: staleCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(outcome.candidate?.id).toBe('WL-AUD');
    expect(deps.getNextItem).not.toHaveBeenCalled();
    // Observable contract: deps.claimItem boundary CAS call — sole channel proving the claim args
    expect(deps.claimItem).toHaveBeenCalledWith('WL-AUD', { status: 'completed', stage: 'in_review' }, '/repo');
    // Observable contract: deps.spawnAgentPane boundary call — sole observable channel for the spawn
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:audit WL-AUD'),
      { model: 'plan', cwd: '/repo', itemId: 'WL-AUD', itemTitle: 'Audit me' },
    );
  });

  it('records the audit dispatch with kind audit', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: staleCandidate }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    const event = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.itemId).toBe('WL-AUD');
    expect(event.kind).toBe('audit');
    expect(event.cwd).toBe('/repo');
  });

  it('when no audit candidate, falls back to audit → plan → intake in order', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null }) // intake_complete empty
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-IDE', title: 'An idea', stage: 'idea' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('intake');
    expect(outcome.candidate?.id).toBe('WL-IDE');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1);
    // Observable contract: Nth tier-ordering (audit→plan→intake fallback) — outcome.kind alone cannot prove sequence; retained per ordering rule
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    // Observable contract: Nth tier-ordering (plan→intake fallback) — retained per ordering rule
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
  });

  it('fails closed to no-candidate when the audit tier answers empty and no plan/intake candidate exists', async () => {
    // The audit tier distinguishes a GENUINELY empty tier ({ok:true,
    // candidate:null}) from a wl failure ({ok:false}, WL-0MSLWJ2KP0002SV0):
    // only the former falls through — all tiers empty -> no dispatch, the
    // no-candidate cooldown unchanged.
    const deps = makeDeps(); // all three tiers empty

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('fails closed to wl-error when the audit-tier lookup errors (a strike, never a silent fall-through)', async () => {
    // WL-0MSLWJ2KP0002SV0: a wl/parse failure in getNextAuditCandidate must
    // NOT fall through to the implement/plan/intake tiers looking healthy —
    // it is a CLI-error strike exactly like the plan/intake tiers' {ok:false}.
    // The audit query state is UNKNOWN, so no lower tier is consulted this
    // cycle (fail-closed to busy; the three-strike rule governs retries).
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: false }),
      getNextImplementCandidate: vi.fn().mockResolvedValue({ id: 'WL-IMP', title: 'Implement me', stage: 'implement' }),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: { id: 'WL-PLN', title: 'Plan me', stage: 'intake_complete' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('wl-error');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1);
    // No fall-through: the implement/plan/intake tiers are never consulted.
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    expect(deps.getNextItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it('falls through to the implement tier when the audit tier answers a genuinely empty set', async () => {
    // {ok:true, candidate:null} (genuinely empty audit tier) falls through to
    // the implement tier — only {ok:false} (wl failure) strikes.
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue({ id: 'WL-IMP', title: 'Implement me', stage: 'implement' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
  });
});

// ── Interim freshness re-check (WL-0MT8KSTOE00871E7) ─────────────────

describe('audit tier interim freshness re-check (WL-0MT8KSTOE00871E7)', () => {
  const auditCandidate: DowntimeCandidate = {
    id: 'WL-AUD',
    title: 'Audit me',
    stage: 'audit',
  };

  it('downgrades to a no-op when a fresh audit was recorded in the interim (no comment, no marker, no spawn)', async () => {
    // AC1: select a stale/un-audited candidate, then a valid audit lands
    // between selection and dispatch — the re-check sees it and the
    // dispatch becomes a no-op; behaviour falls through to the next tier
    // without triggering the no-candidate cooldown.
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      // A fresh audit exists in the interim — dispatch must be skipped.
      hasFreshAudit: vi.fn().mockResolvedValue(true),
      // A plan candidate exists below — the audit tier skip falls through to it.
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-PLN', title: 'Plan me', stage: 'intake_complete' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Falls through to the next tier (plan), NOT the no-candidate cooldown.
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('WL-PLN');
    // No AUDIT dispatch side-effects: the audit candidate is never claimed,
    // no audit comment/marker, no audit spawn.
    // Observable contract: deps.claimItem boundary CAS call — sole channel proving the claim args
    expect(deps.claimItem).toHaveBeenCalledWith('WL-PLN', { status: 'open', stage: 'intake_complete' }, '/repo');
    // Observable contract: negative boundary assertion — proves recordDispatch NOT called with the downgraded marker; unique no-op coverage
    expect(deps.recordDispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'WL-AUD', kind: 'audit' }),
    );
    // Observable contract: deps.spawnAgentPane boundary call — sole observable channel for the spawn
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-PLN'),
      expect.any(Object),
    );
    // The re-check was performed exactly once on the candidate.
    // Observable contract: hasFreshAudit boundary dep — sole channel proving the interim-audit check ran on the right item
    expect(deps.hasFreshAudit).toHaveBeenCalledWith('WL-AUD', '/repo');
  });

  it('skips dispatch entirely and leaves the cooldown untouched when a fresh audit lands and no next-tier candidate exists', async () => {
    // AC1 (no-candidate cooldown guard): a fresh-audit skip with an empty
    // remaining backlog is NOT the no-candidate outcome — the worker keeps
    // polling (the item is already audited; there is simply nothing to do).
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      hasFreshAudit: vi.fn().mockResolvedValue(true),
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null }) // intake_complete empty
        .mockResolvedValueOnce({ ok: true, candidate: null }), // idea empty
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    // Fresh-audit skip is treated as "already audited" — no cooldown, no strike.
    expect(outcome.reason).toBe('fresh-audit-skip');
    expect(outcome.reason).not.toBe('no-candidate');
    expect(outcome.reason).not.toBe('wl-error');
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('records no spawn-failure trace when a fresh audit was recorded during the interim (AC2)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      // Selection re-check: no fresh audit → dispatch proceeds. Spawn-failure
      // re-check: a fresh audit appeared in the interim → no failure trace.
      hasFreshAudit: vi
        .fn()
        .mockResolvedValueOnce(false) // selection: not fresh → dispatch proceeds
        .mockResolvedValueOnce(true), // spawn failure: fresh audit → skip trace
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
      recordDispatch: vi.fn().mockResolvedValue(true),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'ENOENT', exitCode: 1 }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Spawn failed, but a valid audit exists — the push is moot, no failure trace.
    expect(recordDispatchFailureCalled(deps)).toBe(false);
    expect(deps.recordDispatch).toHaveBeenCalledTimes(1); // marker written (unchanged)
    expect(outcome.dispatched).toBe(false);
  });

  it('still appends a spawn-failure trace when no fresh audit was recorded during the interim (unchanged path)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      hasFreshAudit: vi.fn().mockResolvedValue(false),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
      recordDispatch: vi.fn().mockResolvedValue(true),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'ENOENT', exitCode: 1 }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // No fresh audit — the failure trace is recorded exactly as before (AC3).
    expect((deps.recordDispatchFailure as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(outcome.dispatched).toBe(false);
  });

  it('a genuinely unaudited item still dispatches exactly as today (comment + marker + spawn)', async () => {
    // AC3: no fresh audit in the interim — the audit dispatch proceeds
    // unchanged (comment + marker + spawn).
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      hasFreshAudit: vi.fn().mockResolvedValue(false),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
      recordDispatch: vi.fn().mockResolvedValue(true),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    // Observable contract: deps.claimItem boundary CAS call — sole channel proving the claim args
    expect(deps.claimItem).toHaveBeenCalledWith('WL-AUD', { status: 'completed', stage: 'in_review' }, '/repo');
    expect(deps.recordDispatch).toHaveBeenCalledTimes(1); // marker/comment written
    // Observable contract: deps.spawnAgentPane boundary call — sole observable channel for the spawn
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:audit WL-AUD'),
      { model: 'plan', cwd: '/repo', itemId: 'WL-AUD', itemTitle: 'Audit me' },
    );
  });

  it('a hasFreshAudit failure (wl error) is fail-open — the dispatch proceeds as today (conservative default)', async () => {
    // The re-check must never block dispatch on an unanswerable check: a
    // wl/CLI failure in hasFreshAudit fails open (proceed) — never a strike,
    // never a no-candidate, never a silent skip.
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      // Fail-open: the re-check throws but the dispatching continues.
      hasFreshAudit: vi.fn().mockRejectedValue(new Error('wl failed')),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(deps.claimItem).toHaveBeenCalled();
    expect(deps.spawnAgentPane).toHaveBeenCalled();
  });
});

function recordDispatchFailureCalled(deps: DowntimeWorkerDeps): boolean {
  const fn = deps.recordDispatchFailure as ReturnType<typeof vi.fn>;
  return fn.mock.calls.length > 0;
}

// ── Single-active-audit enforcement (WL-0MT3PHW4I002SNOV) ─────────────

describe('dispatch active-audit single-flight (parent WL-0MT3PHW4I002SNOV)', () => {
  const auditCandidate: DowntimeCandidate = {
    id: 'WL-AUD',
    title: 'Audit me',
    stage: 'audit',
  };
  const implementCandidate: DowntimeCandidate = {
    id: 'WL-IMP',
    title: 'Implement me',
    stage: 'implement',
  };

  // Contract of the injected active-audit check (implemented in F2,
  // WL-0MT47BQAT00375VB): {ok:true, active:true} = a non-stale kind=audit
  // dispatch marker maps to an item still in_progress (an audit is running
  // — the audit tier must be skipped); {ok:true, active:false} = none
  // (audit tier proceeds); {ok:false} = the check could not complete
  // (fail-open — skip the audit tier, never block all dispatch).
  const noActiveAudit: DowntimeActiveAuditResult = { ok: true, active: false };
  const activeAudit: DowntimeActiveAuditResult = { ok: true, active: true };
  const checkFailed: DowntimeActiveAuditResult = { ok: false };

  it('dispatches /skill:audit when no non-stale audit marker maps to an in_progress item (AC1/AC3)', async () => {
    // No active audit — including a marker older than the 2h stale window
    // (treated as expired: the audit pane may have crashed without updating
    // the work item) — the audit tier proceeds as today. The stale-window
    // arithmetic itself is pinned in downtime-log.test.ts
    // (recentAuditDispatchedItemIds); here the dep reports the resolved
    // state (active:false).
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(noActiveAudit),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // The single-flight check runs first, then the candidate lookup.
    // Observable contract: getActiveAudit boundary dep — cwd arg is the observable audit-state query contract
    expect(deps.getActiveAudit).toHaveBeenCalledWith('/repo');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1);
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(outcome.candidate?.id).toBe('WL-AUD');
  });

  it('one active audit skips the audit tier and falls through to the implement tier (AC2/AC4)', async () => {
    // A non-stale kind=audit marker maps to an in_progress item: an audit is
    // running. The audit tier is skipped (audits strictly sequential — no
    // fan-out), the candidate lookup is never consulted, and dispatch falls
    // through to the implement tier.
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(activeAudit),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getActiveAudit).toHaveBeenCalledTimes(1);
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('WL-IMP');
  });

  it('an active-audit-check failure fails open: audit tier skipped, dispatch falls through to implement', async () => {
    // Fail-safe (parent constraint): if the active-audit check cannot
    // complete (e.g. worklog query fails) the audit tier is skipped and
    // dispatch falls through to the next tier — it never blocks all
    // dispatch. No audit candidate is consulted this cycle.
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(checkFailed),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('WL-IMP');
  });

  it('an audit-in-flight skip with an empty remaining backlog reports reason audit-in-flight (never no-candidate)', async () => {
    // Mirrors the code-freeze precedent (WL-0MSQ0RPQP00636JY): a skip that
    // is NOT a genuine empty backlog must never enter the no-candidate
    // cooldown — polling continues and the next idle tick re-checks while
    // the audit is still running.
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(activeAudit),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null),
      // plan (intake_complete) and intake (idea) tiers answer genuinely empty.
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('audit-in-flight');
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it('logs the audit-in-flight skip reason to stderr for observability (AC4/AC5)', async () => {
    // The skip must be observable: the worker writes the skip reason to
    // stderr (established observability pattern, cf. scheduler.test.ts
    // 'logs an abandonment to stderr'), so operators can trace why the
    // audit tier did not dispatch instead of seeing a silent fall-through.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const deps = makeDeps({
        getActiveAudit: vi.fn().mockResolvedValue(activeAudit),
        getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.kind).toBe('implement');
      expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
      // Observable contract: stderrSpy observable output stream — sole channel for the skipped/saturated reason log (producer Q1-A/plan-A)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Downtime audit tier skipped: audit-in-flight'),
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('a failed active-audit check with an empty remaining backlog is a wl-error strike, never no-candidate', async () => {
    // Partial information must not pause the worker: when the check failed
    // and every fallback tier answered empty, the backlog is NOT provably
    // empty (an audit may be in flight we could not see) — fail closed to
    // busy (a strike, three-strike rule), never the no-candidate cooldown.
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(checkFailed),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('wl-error');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('runs the active-audit check BEFORE the audit candidate lookup (single check per tick)', async () => {
    // Ordering guard: the single-flight check gates the tier — a candidate
    // is never selected while an active audit exists, and the check is
    // consulted exactly once per tick.
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(noActiveAudit),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    const checkOrder = (deps.getActiveAudit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const lookupOrder = (deps.getNextAuditCandidate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(checkOrder).toBeLessThan(lookupOrder);
    expect(deps.getActiveAudit).toHaveBeenCalledTimes(1);
  });

  it('during a code freeze the audit block is skipped without consulting the active-audit check (guard composition)', async () => {
    // Existing guards preserved (AC6): the code-freeze gate (WL-0MSQ0RPQP00636JY)
    // short-circuits the entire audit tier before the single-flight check —
    // no audits run during a release, active or not.
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(activeAudit),
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getActiveAudit).not.toHaveBeenCalled();
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    // Empty plan/intake backlog during a freeze reports code-freeze (the
    // freeze never enters the no-candidate cooldown — unchanged).
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('code-freeze');
  });

  it('is not consulted when the audit tier is ineligible (1 free slot < the 2-slot audit minimum)', async () => {
    // Free-slot minimum preserved (parent WL-0MT32F90V008UAD2 AC3): below the
    // audit tier's 2-slot minimum the whole audit block is skipped — the
    // single-flight check is not even run; plan (≥1 slot) dispatches.
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(activeAudit),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete', status: 'open' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    expect(deps.getActiveAudit).not.toHaveBeenCalled();
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });
});

// ── Host-wide audit saturation (WL-0MUIVE0YG000UVIA) ──────────────────
//
// The per-worklog active-audit check (WL-0MT3PHW4I002SNOV) only sees audits
// dispatched by THIS project's dispatcher. The 2026-09-26 incident ran four
// downtime audits concurrently on one host — dispatched by DIFFERENT
// projects — saturating the shared Local Proxy and the audit runner's
// host-wide slot. These tests pin the host-wide serialisation gate: when a
// machine-wide active-audit marker is present (`source: 'host-wide'`), a
// second audit is NOT started; the candidate falls through/deferred.
describe('dispatch host-wide audit saturation (WL-0MUIVE0YG000UVIA)', () => {
  const auditCandidate: DowntimeCandidate = {
    id: 'WL-AUD',
    title: 'Audit me',
    stage: 'audit',
  };
  const implementCandidate: DowntimeCandidate = {
    id: 'WL-IMP',
    title: 'Implement me',
    stage: 'implement',
  };

  const hostSaturated: DowntimeActiveAuditResult = {
    ok: true,
    active: true,
    source: 'host-wide',
  };
  const perWorklogActive: DowntimeActiveAuditResult = {
    ok: true,
    active: true,
    source: 'per-worklog',
  };

  it('a host-wide active audit skips the audit tier and falls through to the implement tier (AC1/AC2)', async () => {
    // A second instance/project on the same host sees the machine-wide
    // marker and must NOT start another audit. The audit candidate lookup is
    // never consulted and dispatch falls through to the next tier.
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(hostSaturated),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Observable contract: getActiveAudit boundary dep — cwd arg observable; host-wide skip behaviour
    expect(deps.getActiveAudit).toHaveBeenCalledWith('/repo');
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('WL-IMP');
  });

  it('host-wide saturation with an empty remaining backlog reports audit-host-saturated (never no-candidate)', async () => {
    // A host-wide skip is NOT a genuine empty backlog: it must never enter
    // the no-candidate cooldown — polling continues and the next idle tick
    // re-checks while the remote audit is still running.
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(hostSaturated),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('audit-host-saturated');
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it('distinguishes host-wide from per-worklog saturation: a per-worklog active audit still reports audit-in-flight', async () => {
    // The reason string must not regress the existing per-worklog semantics:
    // only `source: 'host-wide'` produces 'audit-host-saturated'.
    const deps = makeDeps({
      getActiveAudit: vi.fn().mockResolvedValue(perWorklogActive),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('audit-in-flight');
  });

  it('logs audit-host-saturated with the concurrent-audit count and slot state (AC3)', async () => {
    // Contention must be visible: the skip line names the condition and
    // carries the concurrent-audit count (1 — host-wide single-flight) plus
    // the live free-slot / contention queue state so an operator can tell
    // infra saturation from a content problem.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const deps = makeDeps({
        getActiveAudit: vi.fn().mockResolvedValue(hostSaturated),
        getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      });

      const outcome = await dispatchDowntimeWork(deps, {
        model: 'plan',
        cwd: '/repo',
        freeSlots: 2,
        contentionQueueDepth: 0,
      });

      expect(outcome.kind).toBe('implement');
      expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
      // Observable contract: stderrSpy observable output stream — sole channel for the skipped/saturated reason log (producer Q1-A/plan-A)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Downtime audit tier skipped: audit-host-saturated'),
      );
      // Observable contract: stderrSpy observable output stream — sole channel for the skipped/saturated reason log (producer Q1-A/plan-A)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('concurrentAudits=1'),
      );
      // Observable contract: stderrSpy observable output stream — sole channel for the skipped/saturated reason log (producer Q1-A/plan-A)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('contentionQueueDepth=0'),
      );
      // Observable contract: stderrSpy observable output stream — sole channel for the skipped/saturated reason log (producer Q1-A/plan-A)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('freeSlots=2'),
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('dispatch tier free-slot minimums (parent WL-0MT32F90V008UAD2 AC3)', () => {
  const auditCandidate: DowntimeCandidate = {
    id: 'WL-AUD',
    title: 'Audit me',
    stage: 'audit',
  };
  const planCandidate: DowntimeCandidate = {
    id: 'WL-PLAN',
    title: 'Prep task',
    stage: 'intake_complete',
    status: 'open',
  };

  it('audit tier is skipped below 2 free slots: with 1 free slot an audit candidate is NOT dispatched (AC3)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: planCandidate,
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    // 1 free slot: audit needs ≥2 → skipped WITHOUT consulting the lookup
    // (ineligible, not a strike); plan needs ≥1 → dispatches.
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('WL-PLAN');
  });

  it('audit tier dispatches with ≥2 free slots (AC3)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 2 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1);
  });

  it('with exactly 1 free slot the audit skip is ineligible — a genuinely empty plan tier is no-candidate, not a strike', async () => {
    // Mirror of the code-freeze skip: an unmet tier minimum never produces
    // a wl-error strike and never short-circuits the fallback tiers.
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate'); // plan tier answered empty
  });

  it('pane tiers (plan/intake) still dispatch with exactly 1 free slot (AC2)', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('free-slots gate is independent of the idle gate: no freeSlots arg means no gating (backward compatible)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Legacy direct callers (undefined freeSlots) are not gated — existing
    // dispatch behaviour unchanged.
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
  });

  it('scheduled-prompts tier requires the pane minimum ≥1 free slot: 0 free skips it and falls through', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue({
        id: 'SP-1',
        prompt: 'Run /skill:refactor',
        frequency: '3d',
      }),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 0 });

    // 0 free slots: the scheduled prompt (a pane) is ineligible; the plan
    // tier also needs ≥1 — the outcome is a neutral no-candidate (defensive
    // path — via the worker the idle gate already guarantees ≥1 free).
    expect(deps.getDueScheduledPrompt).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
  });

  it('scheduled-prompts tier dispatches with ≥1 free slot (AC3)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue({
        id: 'SP-1',
        prompt: 'Run /skill:refactor',
        frequency: '3d',
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('scheduled');
    expect(deps.recordScheduledPromptTrigger).toHaveBeenCalled();
  });

  it('implement tier is NOT dispatched with 0 free slots: pane minimum ≥1 honored at selection time (F3-fix AC1/AC4)', async () => {
    // Regression for the audit finding (F3 AC2 partial): the implement tier
    // had a 'Pane minimum' comment but no panesEligible guard — a direct
    // dispatchDowntimeWork({freeSlots:0}) dispatched implement. It must be
    // skipped exactly like the other pane tiers (ineligible, never a
    // strike), falling through to the plan tier's defensive no-candidate.
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue({
        id: 'WL-IMP',
        title: 'Implement me',
        stage: 'implement',
      }),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 0 });

    // The implement lookup is never consulted at 0 free slots — ineligible,
    // not a strike, and falls through to the plan tier's defensive
    // no-candidate (via the worker the idle gate already guarantees ≥1).
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('implement tier still dispatches with ≥1 free slot (F3-fix AC2)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue({
        id: 'WL-IMP',
        title: 'Implement me',
        stage: 'implement',
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 1 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('WL-IMP');
  });

  it('implement tier is not gated when freeSlots is undefined: direct legacy callers unaffected (F3-fix AC3)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue({
        id: 'WL-IMP',
        title: 'Implement me',
        stage: 'implement',
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('WL-IMP');
  });
});


// ── Dispatch audit trail (WL-0MSGPI4AR000YOK8) ────────────────────────

describe('dispatch audit trail', () => {
  it('records a plan dispatch with item id, kind, timestamp and cwd', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(deps.recordDispatch).toHaveBeenCalledTimes(1);
    const event = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.itemId).toBe('WL-ABC');
    expect(event.kind).toBe('plan');
    expect(event.cwd).toBe('/repo');
    expect(Number.isNaN(Date.parse(event.dispatchedAt))).toBe(false);
  });

  it('records an intake fallback dispatch', async () => {
    const deps = makeDeps({
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null })
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-DEF', title: 'An idea', stage: 'idea' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('intake');
    const event = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.itemId).toBe('WL-DEF');
    expect(event.kind).toBe('intake');
  });

  it('does not record when nothing is dispatched', async () => {
    const deps = makeDeps();

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it('rolls the claim back (claim-rolled-back) when recordDispatch fails — AC1', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      // A rejecting marker write (or a stub that throws) must abort BEFORE
      // the pane spawns: an unmarked item is never dispatched (RCA
      // WL-0MSRBFFLN005W3VT design point 2 — marker-before-spawn fail-closed).
      // WL-0MT32F908002YFFA AC1: the successful CAS claim is then rolled
      // back so the next idle period can re-select the item.
      recordDispatch: vi.fn().mockRejectedValue(new Error('audit boom')),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('claim-rolled-back');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // Observable contract: rollbackClaim boundary dep — sole channel proving the rollback CAS args
    expect(deps.rollbackClaim).toHaveBeenCalledWith(
      'WL-ABC',
      { status: 'open', stage: 'intake_complete' },
      '/repo',
    );
  });

  it('rolls the claim back (claim-rolled-back) when recordDispatch resolves false — AC1', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      recordDispatch: vi.fn().mockResolvedValue(false),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('claim-rolled-back');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // Observable contract: rollbackClaim boundary dep — sole channel proving the rollback CAS args
    expect(deps.rollbackClaim).toHaveBeenCalledWith(
      'WL-ABC',
      { status: 'open', stage: 'intake_complete' },
      '/repo',
    );
  });

  it('falls back to marker-write-failed when the claim rollback itself fails (fail-closed)', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      recordDispatch: vi.fn().mockRejectedValue(new Error('audit boom')),
      // Concurrent agent already moved the item — nothing to roll back.
      rollbackClaim: vi.fn().mockResolvedValue(false),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('marker-write-failed');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('never crashes when the claim rollback throws (fail-closed)', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      recordDispatch: vi.fn().mockResolvedValue(false),
      rollbackClaim: vi.fn().mockRejectedValue(new Error('wl update boom')),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('marker-write-failed');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('writes the marker BEFORE the pane spawns (marker-before-spawn ordering)', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    const markerOrder = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const spawnOrder = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(markerOrder).toBeLessThan(spawnOrder);
  });

  it('records the dispatched-at stage on plan/intake markers (change-guard input)', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    const event = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.stage).toBe('intake_complete');
  });
});


// ── CAS claim race + fail-closed paths (RCA WL-0MSRBFFLN005W3VT) ───────

describe('dispatch CAS claim race', () => {
  it('a losing pane (stale claim) aborts with no pane, no marker, no success record', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
      // Another pane claimed the item first: the CAS guard fails stale.
      claimItem: vi.fn().mockResolvedValue({ ok: false, reason: 'stale' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('claim-failed');
    // No pane, no marker, no success record — the loser aborts entirely.
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it('a claim wl failure is a wl-error (a strike, never silently discarded)', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
      claimItem: vi.fn().mockResolvedValue({ ok: false, reason: 'error' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('wl-error');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it('a stale audit-tier claim also aborts (no fall-through to other tiers)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: {
          id: 'WL-AUD',
          title: 'Audit me',
          stage: 'audit',
        },
      }),
      claimItem: vi.fn().mockResolvedValue({ ok: false, reason: 'stale' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('claim-failed');
    // The loser does NOT fall through to plan/intake — exactly one dispatch
    // per idle window across panes.
    expect(deps.getNextItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('a spawn error makes the outcome not-success (spawn-failed) with the marker already written', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'ENOENT: send-to-pi.sh' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('spawn-failed');
    expect(outcome.error).toBe('ENOENT: send-to-pi.sh');
    // The marker stands (fail-closed — no re-dispatch of the same item), but
    // the outcome is NOT a success (WL-0MSLWJ3I70031Z8U absorbed).
    expect(deps.recordDispatch).toHaveBeenCalledTimes(1);
    // A failure trace is appended so the audit log distinguishes
    // "attempted" from "opened" (AC2) — it never logs success for a pane
    // that never appeared.
    // Observable contract: recordDispatchFailure boundary dep — failure-trace payload is the observable recovery contract
    expect(deps.recordDispatchFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'WL-ABC',
        kind: 'plan',
        cwd: '/repo',
        error: 'ENOENT: send-to-pi.sh',
      }),
    );
  });

  it('a non-zero script exit makes the outcome not-success (spawn-failed) with the exit trace recorded', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, exitCode: 1 }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('spawn-failed');
    expect(outcome.exitCode).toBe(1);
    // The failure trace carries the exit code for the audit log (AC2).
    // Observable contract: recordDispatchFailure boundary dep — failure-trace payload is the observable recovery contract
    expect(deps.recordDispatchFailure).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'WL-ABC', kind: 'plan', exitCode: 1 }),
    );
  });

  it('rolls the plan claim back on spawn-failed so the item is re-selectable — AC2/AC4', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'ENOENT: send-to-pi.sh' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('spawn-failed');
    // The failure trace is preserved AND the claim is rolled back to the
    // tier's pre-claim state — the item returns to the selectable backlog.
    // Observable contract: recordDispatchFailure boundary dep — failure-trace payload is the observable recovery contract
    expect(deps.recordDispatchFailure).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'WL-ABC', kind: 'plan', error: 'ENOENT: send-to-pi.sh' }),
    );
    // Observable contract: rollbackClaim boundary dep — sole channel proving the rollback CAS args
    expect(deps.rollbackClaim).toHaveBeenCalledWith(
      'WL-ABC',
      { status: 'open', stage: 'intake_complete' },
      '/repo',
    );
  });

  it('rolls an audit claim back to completed/in_review on spawn-failed (audit tier)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-AUD', title: 'Audit me', stage: 'audit', status: 'completed' },
      }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'ENOENT' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('spawn-failed');
    // The audit tier's pre-claim state is completed/in_review, NOT open —
    // rolling back to `open` would silently move the item out of the audit
    // queue (WL-0MT32F908002YFFA AC1/AC2).
    // Observable contract: rollbackClaim boundary dep — sole channel proving the rollback CAS args
    expect(deps.rollbackClaim).toHaveBeenCalledWith(
      'WL-AUD',
      { status: 'completed', stage: 'in_review' },
      '/repo',
    );
  });

  it('marker-write-failed recovery: claim → failure → rollback → re-selection next idle period (AC1/AC4)', async () => {
    // A tiny in-memory item store: the claim flips it to in_progress, the
    // rollback flips it back to open, and getNextItem only offers the item
    // while it is open — so the SECOND idle window selects it again.
    let status: 'open' | 'in_progress' = 'open';
    const recordDispatch = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const deps = makeDeps({
      getNextItem: vi.fn().mockImplementation(async () =>
        status === 'open'
          ? {
              ok: true,
              candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
            }
          : { ok: true, candidate: null },
      ),
      claimItem: vi.fn().mockImplementation(async () => {
        status = 'in_progress';
        return { ok: true };
      }),
      recordDispatch,
      rollbackClaim: vi.fn().mockImplementation(async () => {
        status = 'open';
        return true;
      }),
    });

    const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    expect(first.reason).toBe('claim-rolled-back');
    expect(status).toBe('open');

    const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    expect(second.dispatched).toBe(true);
  });

  it('spawn-failed recovery: claim → failure → rollback → re-selection next idle period (AC2/AC4)', async () => {
    let status: 'open' | 'in_progress' = 'open';
    const spawnAgentPane = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'ENOENT: send-to-pi.sh' })
      .mockResolvedValue({ ok: true });
    const deps = makeDeps({
      getNextItem: vi.fn().mockImplementation(async () =>
        status === 'open'
          ? {
              ok: true,
              candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
            }
          : { ok: true, candidate: null },
      ),
      claimItem: vi.fn().mockImplementation(async () => {
        status = 'in_progress';
        return { ok: true };
      }),
      spawnAgentPane,
      rollbackClaim: vi.fn().mockImplementation(async () => {
        status = 'open';
        return true;
      }),
    });

    const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    expect(first.reason).toBe('spawn-failed');
    expect(status).toBe('open');

    const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    expect(second.dispatched).toBe(true);
  });

  it('a throwing recordDispatchFailure never crashes the dispatch (fail-closed)', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, exitCode: 1 }),
      recordDispatchFailure: vi.fn().mockRejectedValue(new Error('log io boom')),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('spawn-failed');
    expect(outcome.exitCode).toBe(1);
  });

  it('claim → marker → spawn ordering is fixed (claim first, marker before spawn)', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    const claimOrder = (deps.claimItem as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const markerOrder = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const spawnOrder = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(markerOrder);
    expect(markerOrder).toBeLessThan(spawnOrder);
  });
});

// ── Depth-aware audit batch (parent AC6b/AC6c/AC6d/AC6f) ─────────────
//
// Test-first specs for the sequential-in-one-window audit batch (parent
// WL-0MVEDM8OT007WDRS AC2/AC3/AC6). Every continuation must re-check the
// SAME safety gates as a fresh dispatch — only the post-dispatch idle reset
// is deferred:
//
//  - AC6b: depth >= `browseItemCount` with `DOWNTIME_AUDIT_BATCH_MAX = N`
//    yields N sequential audit dispatches in ONE idle window, each a
//    distinct target;
//  - AC6c: an unsatisfied idle-duration gate and sub-2 free slots block ALL
//    dispatch including continuations (`DOWNTIME_AUDIT_MIN_FREE_SLOTS = 2`
//    is never relaxed);
//  - AC6d: a non-stale host-wide/per-worklog active-audit marker blocks a
//    concurrent continuation; the continuation proceeds ONLY after the
//    marker is released;
//  - AC6f: dispatched-marker exclusion prevents the same item being
//    selected twice.
//
// Pinned continuation contract: `dispatchDowntimeWork` (and
// `dispatchFromCoordination`) accept `auditBatchMax` and
// `auditBatchRemaining` (the continuation budget available BEFORE this
// dispatch, owner = the worker tick). A successful continuation returns
// `outcome.auditBatch = { active: true, depth, cap, remaining }` with
// `remaining` decremented by one.
//
// RED WITNESS. The batch surface does not exist yet, so each `it.fails` body
// asserts post-implementation behaviour; the implementation child
// WL-0MVFE1BTB0084T17 flips them to `it`. Green `it` bodies are regression
// pins for invariants that must never be relaxed.
describe('depth-aware audit batch (parent AC6b/AC6c/AC6d/AC6f)', () => {
  const tmp = createTempDirTracker();
  afterEach(() => tmp.cleanup());

  /** A root completed/in_review item with no fresh audit (audit-eligible). */
  const auditItem = (id: string, sortIndex = 0): DowntimeHerdrItem => ({
    id,
    title: `Audit ${id}`,
    status: 'completed',
    stage: 'in_review',
    updatedAt: ago(60_000),
    sortIndex,
  });

  const deepHead = (n = 3): DowntimeHerdrItem[] =>
    Array.from({ length: n }, (_, i) => auditItem(`WL-AUD-${i + 1}`, i));

  // ── AC6b: deep depth reports an active batch ─────────────────────

  it.fails('AC6b: depth >= browseItemCount with auditBatchMax N reports an active batch', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: deepHead(3) }),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 2,
      auditBatchMax: 3,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(outcome.auditBatch?.active).toBe(true);
    expect(outcome.auditBatch?.depth).toBe(3);
    expect(outcome.auditBatch?.cap).toBe(3);
    // cap 3, this is the first dispatch -> two continuations still available.
    expect(outcome.auditBatch?.remaining).toBe(2);
  });

  it.fails('AC6b: a continuation dispatches the next audit target with one fewer remaining', async () => {
    const deps = makeDeps({
      // Distinct target list for the continuation: the first item was already
      // dispatched, so only the remaining two are eligible here.
      getHerdrListHead: vi
        .fn()
        .mockResolvedValue({ ok: true, items: [auditItem('WL-AUD-2', 1), auditItem('WL-AUD-3', 2)] }),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 2,
      auditBatchMax: 3,
      auditBatchRemaining: 2, // continuation of an active batch
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(outcome.candidate?.id).toBe('WL-AUD-2');
    expect(outcome.auditBatch?.active).toBe(true);
    expect(outcome.auditBatch?.remaining).toBe(1);
  });

  // ── AC6c: the safety gates are never relaxed for continuations ─────

  it('AC6c: the audit free-slot minimum is never relaxed below 2', () => {
    expect(DOWNTIME_AUDIT_MIN_FREE_SLOTS).toBe(2);
  });

  it.fails('AC6c: sub-2 free slots block a continuation (no batch engagement)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: deepHead(3) }),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      freeSlots: 1, // audit needs >= 2 — the minimum is NEVER relaxed
      browseItemCount: 2,
      auditBatchMax: 3,
      auditBatchRemaining: 2,
    });

    expect(outcome.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // A blocked continuation never reports an active batch.
    expect(outcome.auditBatch?.active).toBe(false);
  });

  it.fails('AC6c: a worker busy poll mid-window resets the idle run and blocks the continuation', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: deepHead(3) }),
      });
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
          browseItemCount: 2,
          auditBatchMax: 3,
        }),
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
      await worker.tick();
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
      // AC6b deferred the reset: the batch window is still open.
      expect(worker.idleSince).not.toBeNull();

      // A busy poll is an unsatisfied idle gate -> the whole window ends.
      fetcher.mockResolvedValueOnce(
        jsonResponseFixture({ ...idleAllSlotsFree, local_active_query: true }),
      );
      vi.setSystemTime(
        start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
      );
      const busy = await worker.tick();
      expect(busy.idle).toBe(false);
      expect(worker.idleSince).toBeNull();
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1); // no continuation
    } finally {
      vi.useRealTimers();
    }
  });

  // ── AC6d: active-audit markers gate every continuation ─────────────

  it.fails('AC6d: a per-worklog active-audit marker blocks the continuation until released', async () => {
    const getActiveAudit = vi.fn().mockResolvedValue({ ok: true, active: true, source: 'per-worklog' });
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: deepHead(2) }),
      getActiveAudit,
    });

    const blocked = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 2,
      auditBatchMax: 3,
      auditBatchRemaining: 2,
    });
    expect(blocked.dispatched).toBe(false);
    expect(blocked.reason).toBe('audit-in-flight');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    // Marker released (the audit pane closed) -> the SAME continuation budget
    // proceeds without relaxing any gate.
    (getActiveAudit as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, active: false });
    const released = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 2,
      auditBatchMax: 3,
      auditBatchRemaining: 2,
    });
    expect(released.dispatched).toBe(true);
    expect(released.kind).toBe('audit');
    expect(released.auditBatch?.active).toBe(true);
    expect(released.auditBatch?.remaining).toBe(1);
  });

  it.fails('AC6d: a host-wide active-audit marker blocks the continuation until released', async () => {
    const getActiveAudit = vi
      .fn()
      .mockResolvedValue({ ok: true, active: true, source: 'host-wide' });
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: deepHead(2) }),
      getActiveAudit,
    });

    const blocked = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 2,
      auditBatchMax: 3,
      auditBatchRemaining: 2,
    });
    expect(blocked.dispatched).toBe(false);
    expect(blocked.reason).toBe('audit-host-saturated');

    (getActiveAudit as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, active: false });
    const released = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 2,
      auditBatchMax: 3,
      auditBatchRemaining: 2,
    });
    expect(released.dispatched).toBe(true);
    expect(released.auditBatch?.remaining).toBe(1);
  });

  // ── AC3: any non-dispatched outcome ends the batch ────────────────

  it.fails('AC3: a spawn failure ends the batch (no continuation metadata)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi
        .fn()
        .mockResolvedValue({ ok: true, items: [auditItem('WL-AUD-1'), auditItem('WL-AUD-2', 1)] }),
      spawnAgentPane: vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: 'ENOENT', exitCode: 1 }),
    });

    // A successful continuation first, so the batch surface is proven live…
    const live = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 2,
      auditBatchMax: 3,
      auditBatchRemaining: 2,
    });
    expect(live.dispatched).toBe(true);
    expect(live.auditBatch?.active).toBe(true);
    expect(live.auditBatch?.remaining).toBe(1);

    // …then a spawn failure: the item is claimed + marked but the pane never
    // appeared, so the batch ends and no continuation budget is surfaced.
    const failed = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      browseItemCount: 2,
      auditBatchMax: 3,
      auditBatchRemaining: 1,
    });
    expect(failed.dispatched).toBe(false);
    expect(failed.reason).toBe('spawn-failed');
    expect(failed.auditBatch).toBeUndefined();
    expect(deps.rollbackClaim).toHaveBeenCalledTimes(1);
  });

  // ── AC6f: dispatched-marker exclusion across a batch ───────────────

  it.fails('AC6f: a dispatched success marker prevents the same item being selected twice', async () => {
    const cwd = tmp.make('herdr-audit-batch-marker-');
    // Item 1 was already dispatched in this batch: its success marker is
    // fresh and the item is still at the dispatched-at stage -> excluded.
    writeDowntimeLog(cwd, [
      {
        itemId: 'WL-AUD-1',
        kind: 'audit',
        dispatchedAt: new Date().toISOString(),
        stage: 'in_review',
      },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi
        .fn()
        .mockResolvedValue({ ok: true, items: [auditItem('WL-AUD-1'), auditItem('WL-AUD-2', 1)] }),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd,
      browseItemCount: 2,
      auditBatchMax: 3,
      auditBatchRemaining: 2,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('WL-AUD-2'); // never WL-AUD-1 again
    expect(outcome.auditBatch?.active).toBe(true);
    expect(outcome.auditBatch?.remaining).toBe(1);
  });
});

