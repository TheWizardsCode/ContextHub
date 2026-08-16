/**
 * Unit tests for downtime-worker.ts — Local-LLM downtime worker contract
 *
 * Test-first contract for the herdr downtime worker (WL-0MSG7ZTC000163FL,
 * parent WL-0MSF49FMW009M06K). Follows the repo convention of a dedicated
 * test-suite feature created before the implementation features
 * (cf. WL-0MQD1N3JD007B0FZ).
 *
 * Green suites test the parts implemented so far (idle detection,
 * blocked-questions prompt, settings clamps, fixture coherence, the poller
 * and fail-closed parsing from WL-0MSG80254005ZNE9, and the idle tracker,
 * dispatch orchestration, pane spawn and worker orchestrator from
 * WL-0MSG80AG700429M8).
 *
 * Implement-tier tests (WL-0MSMAYIKX005LLO4): test-first matrix for the
 * implement dispatch tier — dispatch priority (audit → implement → plan →
 * intake), status=open client-side filter, dispatched-marker exclusion,
 * parseImplementCandidatesOutput / selectImplementCandidate, and
 * implement prompt/pane helpers. Red phase: these fail until the implement
 * tier lands (WL-0MSMAYPQP001FLR6).
 *
 * Per-slot idle-tracking tests (WL-0MSP28F5Z008DAUA, parent
 * WL-0MSG7P9N8009PCKG): test-first suite for same-slot idle tracking —
 * optional `slots` parsing (LP-0MSG5TA7Y002GN39), fail-closed malformed
 * slots, the per-slot idle tracker (Map<slot_id, idleSince> with
 * record()/thresholdMetCount() semantics), per-slot evaluateIdle mode, and
 * worker routing (per-slot mode only when slots present AND 0 < N < total;
 * global-busy resets all slot timers; all-slots-free fallback without
 * per-slot data). Red phase: these fail until the implementation lands
 * (WL-0MSP28LSY007NDYX).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isIdleStatus,
  evaluateIdle,
  parseLlamaStatus,
  fetchLocalStatus,
  createDowntimePoller,
  createIdleTracker,
  createPerSlotIdleTracker,
  dispatchDowntimeWork,
  createDowntimeWorker,
  buildDowntimePrompt,
  buildDowntimePaneArgs,
  spawnDowntimePane,
  buildDowntimeSpawnOptions,
  BLOCKED_QUESTIONS_INSTRUCTION,
  parseNextItemOutput,
  parseNextCandidatesOutput,
  parseImplementCandidatesOutput,
  selectImplementCandidate,
  selectNextCandidate,
  parseAuditCandidatesOutput,
  selectAuditCandidate,
  toDowntimeCandidate,
  skillKindFromPrompt,
  buildDowntimeDispatchComment,
  clampDowntimePollInterval,
  clampDowntimeIdleThresholdMs,
  clampDowntimeRequiredFreeSlots,
  clampDowntimeNoCandidateCooldownMs,
  DOWNTIME_POLL_INTERVAL_FLOOR_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
  DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS,
  type LlamaStatus,
  type LlamaSlot,
  type LlamaStatusFetcher,
  type DowntimeCandidate,
  type DowntimeWorkerDeps,
  type DowntimeSpawn,
  type DowntimeStage,
  type AuditCandidate,
  type ImplementCandidate,
} from './downtime-worker.js';
import {
  statusFixtures,
  ambiguousMissingFieldsRaw,
  idleAllSlotsFree,
  perSlotAllFree,
  perSlotTwoFree,
  perSlotOneProcessing,
  networkErrorFixture,
  timeoutErrorFixture,
  httpErrorResponseFixture,
  jsonResponseFixture,
  type LlamaStatusHttpResponse,
} from './downtime-worker.fixtures.js';

/** Shared deps mock for dispatch tests. */
function makeDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    // Audit tier answers a GENUINELY empty tier by default ({ok:true,
    // candidate:null}); a wl/parse failure is {ok:false} (WL-0MSLWJ2KP0002SV0).
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
    // Code-freeze gate (WL-0MSQ0RPQP00636JY): not frozen by default, so
    // existing dispatch tests exercise the unchanged audit/implement tiers.
    readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
    ...overrides,
  };
}

// ── Fixture coherence (AC1) ───────────────────────────────────────────

describe('downtime worker fixtures', () => {
  it.each(statusFixtures)(
    '$name is classified idle=$expectedIdle by isIdleStatus (N=0)',
    (fixture) => {
      expect(isIdleStatus(fixture.status, 0)).toBe(fixture.expectedIdle);
    },
  );

  it('a raw payload with missing slot fields is treated as busy (fail-closed)', () => {
    const partial = ambiguousMissingFieldsRaw as unknown as LlamaStatus;
    expect(isIdleStatus(partial, 0)).toBe(false);
  });
});

// ── Idle detection (AC2) ──────────────────────────────────────────────

describe('idle detection (isIdleStatus)', () => {
  const idle: LlamaStatus = {
    llama_server_running: true,
    active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 4,
    total_slots: 4,
  };

  it('is idle when the server is up, nothing active, and all slots free', () => {
    expect(isIdleStatus(idle, 0)).toBe(true);
  });

  it('is busy when llama-server is not running', () => {
    expect(isIdleStatus({ ...idle, llama_server_running: false }, 0)).toBe(false);
  });

  it('is busy while a query is active', () => {
    expect(isIdleStatus({ ...idle, active_query: true }, 0)).toBe(false);
  });

  it('is idle during remote-only traffic when local_active_query=false (global active_query true)', () => {
    // Remote provider streams keep the GLOBAL active_query true while the
    // local model is idle with free slots; the proxy's local_active_query is
    // the local-only signal (LP-0MSL2ZLLS009RVKR) and must not block dispatch.
    expect(isIdleStatus({ ...idle, active_query: true, local_active_query: false }, 0)).toBe(true);
  });

  it('is busy when local_active_query=true (a local query is in flight)', () => {
    expect(isIdleStatus({ ...idle, local_active_query: true }, 0)).toBe(false);
  });

  it('is busy while a model switch is in progress', () => {
    expect(isIdleStatus({ ...idle, model_switch_in_progress: true }, 0)).toBe(false);
  });

  it('is busy while a local lease is active', () => {
    expect(isIdleStatus({ ...idle, local_lease_active: true }, 0)).toBe(false);
  });

  it('N=0 (default) requires ALL slots free', () => {
    expect(isIdleStatus({ ...idle, available_slots: 3 }, 0)).toBe(false);
    expect(isIdleStatus({ ...idle, available_slots: 4 }, 0)).toBe(true);
  });

  it('a positive N requires at least N slots free', () => {
    expect(isIdleStatus({ ...idle, available_slots: 2 }, 2)).toBe(true);
    expect(isIdleStatus({ ...idle, available_slots: 1 }, 2)).toBe(false);
  });

  it('N > total_slots can never be idle (never dispatches)', () => {
    expect(isIdleStatus({ ...idle, available_slots: 4 }, 5)).toBe(false);
  });

  it('ambiguous responses (total_slots 0 or missing fields) are busy', () => {
    expect(isIdleStatus({ ...idle, total_slots: 0, available_slots: 0 }, 0)).toBe(false);
    expect(isIdleStatus({ llama_server_running: true } as LlamaStatus, 0)).toBe(false);
  });

  it('non-finite or negative slot counts are busy', () => {
    expect(isIdleStatus({ ...idle, total_slots: Number.NaN }, 0)).toBe(false);
    expect(isIdleStatus({ ...idle, available_slots: -1 }, 0)).toBe(false);
  });
});

// ── Threshold timing (AC1/AC3) ────────────────────────────────────────

describe('threshold timing (idle-duration tracker)', () => {
  const thresholdMs = 240_000;

  it('dispatches only after idle has lasted the full threshold continuously', () => {
    const tracker = createIdleTracker();
    const start = 1_000_000;

    tracker.record(true, start);
    expect(tracker.idleSince).toBe(start);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs - 1)).toBe(false);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs)).toBe(true);
  });

  it('any busy poll resets the idle-since timestamp', () => {
    const tracker = createIdleTracker();
    const start = 1_000_000;

    tracker.record(true, start);
    tracker.record(false, start + 120_000);
    expect(tracker.idleSince).toBeNull();
    expect(tracker.isThresholdMet(thresholdMs, start + 360_000)).toBe(false);
  });

  it('keeps the idle run start fixed across consecutive idle polls', () => {
    const tracker = createIdleTracker();
    const start = 1_000_000;
    tracker.record(true, start);
    tracker.record(true, start + 30_000);
    tracker.record(true, start + 60_000);
    expect(tracker.idleSince).toBe(start);
    expect(tracker.isThresholdMet(thresholdMs, start + 60_000)).toBe(false);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs)).toBe(true);
  });
});

// ── Dispatch selection (AC2) ──────────────────────────────────────────

describe('dispatch selection', () => {
  it('runs /skill:plan on the next intake_complete item', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextItem).toHaveBeenCalledWith('intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenCalledTimes(1);
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('WL-ABC');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-ABC'),
      { model: 'plan', cwd: '/repo' },
    );
  });

  it('claims the item BEFORE the pane spawns with the tier CAS guard', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // The claim carries the expected state the tier selected the item in
    // (RCA WL-0MSRBFFLN005W3VT design point 1 — compare-and-swap).
    expect(deps.claimItem).toHaveBeenCalledWith('WL-ABC', { status: 'open', stage: 'intake_complete' });
    const claimOrder = (deps.claimItem as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const spawnOrder = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(spawnOrder);
  });

  it('falls back to /skill:intake on the next idea item when none is intake_complete', async () => {
    const deps = makeDeps({
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null })
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-DEF', title: 'An idea', stage: 'idea', status: 'open' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
    expect(outcome.kind).toBe('intake');
    expect(outcome.candidate?.id).toBe('WL-DEF');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-DEF', { status: 'open', stage: 'idea' });
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:intake WL-DEF'),
      expect.anything(),
    );
  });

  it('does not dispatch when no item exists in either stage', async () => {
    const deps = makeDeps();

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });
  it('fails closed to wl-error when the intake_complete lookup errors AND the idea lookup errors', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: false }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Tier 2 error does NOT short-circuit: tier 3 is still attempted.
    expect(deps.getNextItem).toHaveBeenCalledTimes(2);
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('wl-error');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('still checks the idea tier after an intake_complete error and dispatches its candidate', async () => {
    const deps = makeDeps({
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-IDE', title: 'An idea', stage: 'idea', status: 'open' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('intake');
    expect(outcome.candidate?.id).toBe('WL-IDE');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-IDE', { status: 'open', stage: 'idea' });
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:intake WL-IDE'),
      expect.anything(),
    );
  });

  it('fails closed to wl-error when the intake_complete lookup errors and idea answers empty', async () => {
    const deps = makeDeps({
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    // Backlog is not provably empty (intake_complete state unknown) → the
    // worker must NOT treat this as a genuine no-candidate (no cooldown).
    expect(outcome.reason).toBe('wl-error');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('fails closed to wl-error when the idea lookup errors after an empty intake_complete stage', async () => {
    const deps = makeDeps({
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null })
        .mockResolvedValueOnce({ ok: false }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('wl-error');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });
});

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
    expect(deps.claimItem).toHaveBeenCalledWith('WL-AUD', { status: 'completed', stage: 'in_review' });
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:audit WL-AUD'),
      { model: 'plan', cwd: '/repo' },
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
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
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

// ── Implement dispatch tier (WL-0MSMAYIKX005LLO4) ────────────────────

describe('dispatch implement tier', () => {
  const implementCandidate: DowntimeCandidate = {
    id: 'WL-IMP',
    title: 'Implement me',
    stage: 'implement',
  };

  it('dispatches /skill:implement on the implement candidate after the audit tier', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('WL-IMP');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextImplementCandidate).toHaveBeenCalledWith('/repo');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-IMP', { status: 'open', stage: 'plan_complete' });
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:implement WL-IMP'),
      { model: 'plan', cwd: '/repo' },
    );
  });

  it('records the implement dispatch with kind implement', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    const event = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.itemId).toBe('WL-IMP');
    expect(event.kind).toBe('implement');
    expect(event.cwd).toBe('/repo');
  });

  it('dispatch priority is audit → implement → plan → intake (audit stays first)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: { id: 'WL-AUD', title: 'Audit me', stage: 'audit' } }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: { id: 'WL-PLN', title: 'Plan me', stage: 'intake_complete' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Audit wins — the implement tier is never consulted when an audit
    // candidate exists (audit is the release gate).
    expect(outcome.kind).toBe('audit');
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    expect(deps.getNextItem).not.toHaveBeenCalled();
  });

  it('falls back to the implement tier when no audit candidate exists, and audit runs first', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('implement');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextItem).not.toHaveBeenCalled();
  });

  it('falls back to plan (intake_complete) when no implement candidate exists', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null),
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-PLN', title: 'Plan me', stage: 'intake_complete' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('plan');
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextItem).toHaveBeenCalledTimes(1);
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
  });

  it('falls back to intake (idea) when no implement or plan candidate exists', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null),
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null }) // intake_complete empty
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-IDE', title: 'An idea', stage: 'idea' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('intake');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
  });

  it('a wl next CLI error at the implement tier does NOT short-circuit the plan/intake fallback', async () => {
    // Mirrors the tier-2 (intake_complete) error handling: getNextImplementCandidate
    // is fail-closed at the deps boundary (a wl failure yields null), so the
    // plan/intake tiers still run. The implement tier itself never signals a
    // hard error — null IS the fail-closed shape (AC6).
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null), // wl error → null
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-PLN', title: 'Plan me', stage: 'intake_complete' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('plan');
    expect(deps.getNextItem).toHaveBeenCalled();
  });

  it('no-candidate when all tiers (audit, implement, plan, intake) are empty', async () => {
    const deps = makeDeps(); // all four tiers empty

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextItem).toHaveBeenCalledTimes(2);
  });
});

// ── Code-freeze gate (WL-0MSQ0RPQP00636JY) ──────────────────────────
// The dispatcher must honour the ship-it code-freeze marker: while frozen
// (or ambiguous — fail-closed), the audit and implement tiers are skipped
// (no new implementation work / audits during a release) and the plan/intake
// tiers still dispatch (low-risk prep). The marker is re-read on EVERY
// dispatch (never cached) so a freeze that starts or ends mid-idle-period is
// honored on the next dispatch attempt. A freeze skip is reason
// 'code-freeze' — never 'no-candidate' — so it cannot trigger the worker's
// no-candidate cooldown: polling continues and resume is immediate.

describe('dispatch code-freeze gate', () => {
  const auditCandidate: DowntimeCandidate = { id: 'WL-AUD', title: 'Audit me', stage: 'audit' };
  const implementCandidate: DowntimeCandidate = { id: 'WL-IMP', title: 'Implement me', stage: 'implement' };
  const planCandidate: DowntimeCandidate = { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete' };

  it('skips the audit and implement tiers while frozen and still dispatches plan', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Frozen → the audit/implement tiers are never consulted.
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    // Plan/intake tiers still dispatch.
    expect(deps.getNextItem).toHaveBeenCalledWith('intake_complete', '/repo');
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-PLAN', { status: 'open', stage: 'intake_complete' });
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-PLAN'),
      expect.anything(),
    );
  });

  it('treats an ambiguous marker as frozen (fail-closed): no audit/implement, plan still dispatches', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('ambiguous'),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('frozen with an empty plan/intake backlog reports code-freeze (never no-candidate)', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    // The freeze itself must never look like a genuine empty backlog: the
    // worker must NOT enter the no-candidate cooldown (polling continues).
    expect(outcome.reason).toBe('code-freeze');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('ambiguous with an empty plan/intake backlog also reports code-freeze', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('ambiguous'),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('code-freeze');
  });

  it('frozen still surfaces wl CLI errors as wl-error (a strike, not hidden by the freeze)', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getNextItem: vi.fn().mockResolvedValue({ ok: false }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('wl-error');
  });

  it('re-reads the marker on every dispatch: implement/audit resume immediately when the freeze lifts', async () => {
    // First dispatch: frozen → no audit/implement, empty plan/intake → code-freeze.
    const freezeStatus = vi.fn().mockReturnValue('frozen');
    const deps = makeDeps({
      readCodeFreezeStatus: freezeStatus,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const frozenOutcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    expect(frozenOutcome.reason).toBe('code-freeze');
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();

    // The freeze lifts (marker now reads not-frozen): the SAME deps object is
    // re-read on the next dispatch — no caching — and the implement tier
    // dispatches again.
    freezeStatus.mockReturnValue('not-frozen');
    deps.getNextImplementCandidate = vi.fn().mockResolvedValue(implementCandidate);

    const resumed = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    expect(resumed.dispatched).toBe(true);
    expect(resumed.kind).toBe('implement');
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:implement WL-IMP'),
      expect.anything(),
    );
  });

  it('not-frozen behaves as before: the audit tier still runs', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledWith('/repo');
  });
});

// ── Implement candidate selection (WL-0MSMAYIKX005LLO4) ──────────────

describe('implement selection (selectImplementCandidate)', () => {
  const open: ImplementCandidate = {
    id: 'WL-OPEN',
    title: 'open item',
    status: 'open',
    risk: 'low',
    effort: 'small',
    sortIndex: 100,
  };
  const completed: ImplementCandidate = {
    id: 'WL-DONE',
    title: 'completed item',
    status: 'completed',
    risk: 'low',
    effort: 'small',
    sortIndex: 200,
  };

  it('selects the first open candidate in wl next priority order (ascending sortIndex)', () => {
    expect(selectImplementCandidate([open, completed])?.id).toBe('WL-OPEN');
  });

  it('excludes completed candidates (status=open client-side filter, AC2)', () => {
    expect(selectImplementCandidate([completed, { ...open, id: 'WL-OPEN2', sortIndex: 300 }])?.id).toBe('WL-OPEN2');
  });

  it('returns null when no open candidate exists', () => {
    expect(selectImplementCandidate([completed])).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(selectImplementCandidate([])).toBeNull();
  });

  it('sorts ascending by sortIndex (wl next priority order preserved)', () => {
    const low = { ...open, id: 'WL-LOW', sortIndex: 50 };
    const high = { ...open, id: 'WL-HIGH', sortIndex: 900 };
    expect(selectImplementCandidate([high, low])?.id).toBe('WL-LOW');
  });

  it('excludes candidates present in the dispatched marker set (kind implement)', () => {
    const dispatched = new Set(['WL-DUP']);
    const dup = { ...open, id: 'WL-DUP', sortIndex: 10 };
    const fresh = { ...open, id: 'WL-FRESH', sortIndex: 20 };
    expect(selectImplementCandidate([dup, fresh], dispatched)?.id).toBe('WL-FRESH');
  });

  it('an empty dispatched set is a no-op', () => {
    expect(selectImplementCandidate([open], new Set())?.id).toBe('WL-OPEN');
  });

  // ── Risk/effort threshold boundaries (AC1) ──────────────────────────
  // Belt-and-suspenders client-side guard: even though `wl next --risk low
  // --effort small` filters server-side, the herdr tier verifies the
  // thresholds again so a malformed/absent server filter can never dispatch
  // a Medium+/Large+ item (fail-closed).

  it('only risk exactly Low is eligible (Medium/High/Critical excluded)', () => {
    const medium = { ...open, id: 'WL-MED', risk: 'medium' as const };
    const high = { ...open, id: 'WL-HIGH-R', risk: 'high' as const };
    const critical = { ...open, id: 'WL-CRIT', risk: 'critical' as const };
    expect(selectImplementCandidate([medium, high, critical, open])?.id).toBe('WL-OPEN');
    expect(selectImplementCandidate([medium])).toBeNull();
    expect(selectImplementCandidate([high])).toBeNull();
    expect(selectImplementCandidate([critical])).toBeNull();
  });

  it('effort Small and Extra Small eligible (Medium/Large/Extra Large excluded)', () => {
    const xs = { ...open, id: 'WL-XS', effort: 'xs' as const };
    const medium = { ...open, id: 'WL-MED-E', effort: 'medium' as const };
    const large = { ...open, id: 'WL-LARGE', effort: 'large' as const };
    const xl = { ...open, id: 'WL-XL', effort: 'xl' as const };
    expect(selectImplementCandidate([medium, large, xl, open])?.id).toBe('WL-OPEN');
    expect(selectImplementCandidate([xs])?.id).toBe('WL-XS');
    expect(selectImplementCandidate([medium])).toBeNull();
    expect(selectImplementCandidate([large])).toBeNull();
    expect(selectImplementCandidate([xl])).toBeNull();
  });

  it('unset/empty risk or effort items are excluded (fail-closed)', () => {
    const noRisk = { ...open, id: 'WL-NORISK', risk: undefined };
    const noEffort = { ...open, id: 'WL-NOEFFORT', effort: undefined };
    expect(selectImplementCandidate([noRisk, open])?.id).toBe('WL-OPEN');
    expect(selectImplementCandidate([noEffort, open])?.id).toBe('WL-OPEN');
    expect(selectImplementCandidate([noRisk])).toBeNull();
    expect(selectImplementCandidate([noEffort])).toBeNull();
  });

  it('recognizes long-form effort spellings (Small / Extra Small)', () => {
    const small = { ...open, id: 'WL-S', effort: 'Small' as const };
    const extraSmall = { ...open, id: 'WL-ES', effort: 'Extra Small' as const };
    expect(selectImplementCandidate([small])?.id).toBe('WL-S');
    expect(selectImplementCandidate([extraSmall])?.id).toBe('WL-ES');
  });
});

describe('parseImplementCandidatesOutput', () => {
  it('parses the wl next -n N { workItems: [{ workItem }] } shape', () => {
    const stdout = JSON.stringify({
      success: true,
      count: 2,
      requested: 10,
      results: [
        { workItem: { id: 'WL-A', title: 'A', status: 'open', risk: 'low', effort: 'small' } },
        { workItem: { id: 'WL-B', title: 'B', status: 'open', risk: 'low', effort: 'xs' } },
      ],
      workItems: [
        { workItem: { id: 'WL-A', title: 'A', status: 'open', risk: 'low', effort: 'small' } },
        { workItem: { id: 'WL-B', title: 'B', status: 'open', risk: 'low', effort: 'xs' } },
      ],
    });
    const parsed = parseImplementCandidatesOutput(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]).toMatchObject({ id: 'WL-A', status: 'open', risk: 'low', effort: 'small' });
    expect(parsed?.[1]).toMatchObject({ id: 'WL-B', status: 'open', effort: 'xs' });
  });

  it('fails closed (null) on malformed JSON', () => {
    expect(parseImplementCandidatesOutput('not json')).toBeNull();
  });

  it('fails closed (null) on output without a workItems list', () => {
    expect(parseImplementCandidatesOutput(JSON.stringify({ success: true }))).toBeNull();
  });

  it('returns an empty array for an empty workItems list', () => {
    expect(parseImplementCandidatesOutput(JSON.stringify({ success: true, count: 0, workItems: [] }))).toEqual([]);
  });

  it('skips entries without an id but keeps valid ones', () => {
    const stdout = JSON.stringify({
      success: true,
      workItems: [{ workItem: { title: 'no id' } }, { workItem: { id: 'WL-OK', title: 'ok' } }],
    });
    const parsed = parseImplementCandidatesOutput(stdout);
    expect(parsed?.length).toBe(1);
    expect(parsed?.[0].id).toBe('WL-OK');
  });
});

describe('implement prompt & pane helpers', () => {
  const candidate: DowntimeCandidate = { id: 'WL-IMP', title: 'Implement me', stage: 'implement' };

  it('builds an /skill:implement prompt', () => {
    const prompt = buildDowntimePrompt('implement', candidate);
    expect(prompt).toContain('/skill:implement WL-IMP');
  });

  it('builds a Downtime implement pane name', () => {
    const args = buildDowntimePaneArgs('implement', 'Run /skill:implement WL-IMP — Implement me.', {
      model: 'plan',
      cwd: '/repo',
    });
    expect(args).toContain('Downtime implement');
    expect(args).toContain('--no-focus');
  });

  it('skillKindFromPrompt detects an implement prompt', () => {
    expect(skillKindFromPrompt('Run /skill:implement WL-IMP — x.')).toBe('implement');
  });

  it('buildDowntimeDispatchComment renders /skill:implement', () => {
    const comment = buildDowntimeDispatchComment('WL-IMP', 'implement', '2026-01-01T00:00:00.000Z');
    expect(comment).toContain('/skill:implement WL-IMP');
  });
});

describe('audit selection (selectAuditCandidate)', () => {
  // Fixed clock so the 7-day recency filter is deterministic (all fixture
  // dates fall within the window).
  const NOW = new Date('2026-01-01T00:05:00.000Z').getTime();
  const fresh: AuditCandidate = {
    id: 'FRESH',
    title: 'fresh',
    auditedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:30.000Z',
    sortIndex: 200,
  };
  const stale: AuditCandidate = {
    id: 'STALE',
    title: 'stale',
    auditedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:02:00.000Z', // >60s later -> stale
    sortIndex: 300,
  };
  const unaudited: AuditCandidate = { id: 'NOAUDIT', title: 'no audit', sortIndex: 100 };

  it('selects an item with a missing audit', () => {
    expect(selectAuditCandidate([fresh, unaudited], NOW)?.id).toBe('NOAUDIT');
  });

  it('does not select an item with a fresh audit', () => {
    expect(selectAuditCandidate([fresh], NOW)).toBeNull();
  });

  it('selects a stale item (audit older than the 60s buffer)', () => {
    expect(selectAuditCandidate([fresh, stale], NOW)).toEqual(stale);
  });

  it('sorts ascending by sortIndex and returns the first', () => {
    expect(selectAuditCandidate([stale, unaudited], NOW)?.id).toBe('NOAUDIT');
    expect(selectAuditCandidate([{ ...unaudited, sortIndex: 500 }, stale], NOW)?.id).toBe('STALE');
  });

  it('returns null on an empty list', () => {
    expect(selectAuditCandidate([], NOW)).toBeNull();
  });

  it('classifies the 60s freshness boundary correctly', () => {
    // auditedAt exactly 60s before updatedAt -> stale (selected)
    const boundaryStale: AuditCandidate = {
      id: 'B1',
      title: 'Boundary stale',
      auditedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    // auditedAt just under 60s before updatedAt -> fresh (not selected)
    const boundaryFresh: AuditCandidate = {
      id: 'B2',
      title: 'Boundary fresh',
      auditedAt: '2026-01-01T00:00:30.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    expect(selectAuditCandidate([boundaryStale], NOW)?.id).toBe('B1');
    expect(selectAuditCandidate([boundaryFresh], NOW)).toBeNull();
  });
});

describe('audit selection 7-day recency (selectAuditCandidate)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = new Date('2026-01-01T12:00:00.000Z').getTime();
  const recentStale: AuditCandidate = {
    id: 'RECENT',
    title: 'modified 6 days ago',
    // audited >60s before updatedAt -> stale audit (selected by freshness)
    auditedAt: new Date(NOW - 6 * DAY_MS - 120_000).toISOString(),
    updatedAt: new Date(NOW - 6 * DAY_MS).toISOString(),
    sortIndex: 100,
  };
  const ancientStale: AuditCandidate = {
    id: 'ANCIENT',
    title: 'modified 8 days ago',
    auditedAt: new Date(NOW - 8 * DAY_MS - 120_000).toISOString(),
    updatedAt: new Date(NOW - 8 * DAY_MS).toISOString(),
    sortIndex: 100,
  };

  it('selects a stale-audit item modified within the last 7 days', () => {
    expect(selectAuditCandidate([ancientStale, recentStale], NOW)?.id).toBe('RECENT');
  });

  it('excludes stale-audit items not modified within the last 7 days', () => {
    expect(selectAuditCandidate([ancientStale], NOW)).toBeNull();
  });

  it('includes a candidate with a missing updatedAt (recency cannot be verified)', () => {
    const missing: AuditCandidate = { id: 'MISSING', title: 'no updatedAt', sortIndex: 100 };
    expect(selectAuditCandidate([missing], NOW)?.id).toBe('MISSING');
  });

  it('excludes a candidate with an unparseable updatedAt (fail-closed)', () => {
    const garbage: AuditCandidate = {
      id: 'GARBAGE',
      title: 'bad date',
      updatedAt: 'not-a-date',
      sortIndex: 100,
    };
    expect(selectAuditCandidate([garbage], NOW)).toBeNull();
  });

  it('includes a candidate modified exactly 7 days ago (boundary inclusive)', () => {
    const boundary: AuditCandidate = {
      id: 'EDGE',
      title: 'exactly 7 days',
      auditedAt: new Date(NOW - 7 * DAY_MS - 120_000).toISOString(),
      updatedAt: new Date(NOW - 7 * DAY_MS).toISOString(),
      sortIndex: 100,
    };
    expect(selectAuditCandidate([boundary], NOW)?.id).toBe('EDGE');
  });

  it('excludes a candidate modified 7 days and 1ms ago', () => {
    const justOutside: AuditCandidate = {
      id: 'OUT',
      title: '7 days + 1ms',
      auditedAt: new Date(NOW - 7 * DAY_MS - 120_001).toISOString(),
      updatedAt: new Date(NOW - 7 * DAY_MS - 1).toISOString(),
      sortIndex: 100,
    };
    expect(selectAuditCandidate([justOutside], NOW)).toBeNull();
  });
});

describe('audit selection dispatched-marker exclusion (selectAuditCandidate)', () => {
  // Regression (WL-0MSGTLSUT002NF29): an item already dispatched for audit
  // by the downtime worker must never be re-selected while it still lacks a
  // fresh audit — even though it is completed/in_review (the dispatched run
  // reverts the status without recording a fresh audit).
  const NOW = new Date('2026-01-01T00:05:00.000Z').getTime();
  const dispatchedUnaudited: AuditCandidate = {
    id: 'WL-DUP',
    title: 'already dispatched, no audit',
    sortIndex: 100,
  };
  const otherUnaudited: AuditCandidate = {
    id: 'WL-OTHER',
    title: 'not dispatched',
    sortIndex: 200,
  };

  it('excludes a candidate present in the dispatched set with no fresh audit (regression)', () => {
    const dispatched = new Set(['WL-DUP']);
    expect(selectAuditCandidate([dispatchedUnaudited], NOW, dispatched)).toBeNull();
  });

  it('selects another candidate when the first is excluded', () => {
    const dispatched = new Set(['WL-DUP']);
    expect(selectAuditCandidate([dispatchedUnaudited, otherUnaudited], NOW, dispatched)?.id).toBe(
      'WL-OTHER',
    );
  });

  it('composes with audit freshness: a fresh audit still excludes the item (unchanged)', () => {
    const freshDispatched: AuditCandidate = {
      id: 'WL-FRESH',
      title: 'fresh audit since dispatch',
      auditedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:30.000Z',
      sortIndex: 100,
    };
    const dispatched = new Set(['WL-FRESH']);
    // isAuditFresh governs: fresh → not a candidate, even without the marker.
    expect(selectAuditCandidate([freshDispatched], NOW)).toBeNull();
    // Marker + fresh audit → still not a candidate (unchanged).
    expect(selectAuditCandidate([freshDispatched], NOW, dispatched)).toBeNull();
  });

  it('a stale/absent audit plus an audit marker is excluded', () => {
    const staleDispatched: AuditCandidate = {
      id: 'WL-STALE',
      title: 'stale audit since dispatch',
      auditedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z', // >60s later -> stale
      sortIndex: 100,
    };
    expect(selectAuditCandidate([staleDispatched], NOW, new Set(['WL-STALE']))).toBeNull();
  });

  it('an item without a marker is selected as before (empty set is a no-op)', () => {
    expect(selectAuditCandidate([dispatchedUnaudited], NOW, new Set())?.id).toBe('WL-DUP');
  });
});

describe('parseAuditCandidatesOutput', () => {
  it('parses a { workItems: [...] } shape', () => {
    const stdout = JSON.stringify({
      success: true,
      count: 1,
      workItems: [{ id: 'WL-1', title: 'A', sortIndex: 100, auditedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:30.000Z' }],
    });
    const parsed = parseAuditCandidatesOutput(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed![0].id).toBe('WL-1');
    expect(parsed![0].sortIndex).toBe(100);
  });

  it('parses a bare array shape', () => {
    const stdout = JSON.stringify([{ id: 'WL-2', title: 'B' }]);
    expect(parseAuditCandidatesOutput(stdout)?.[0].id).toBe('WL-2');
  });

  it('fails closed (null) on malformed JSON', () => {
    expect(parseAuditCandidatesOutput('not json')).toBeNull();
  });

  it('fails closed (null) on output without a list', () => {
    expect(parseAuditCandidatesOutput(JSON.stringify({ success: false }))).toBeNull();
  });

  it('skips items without an id but keeps valid ones', () => {
    const stdout = JSON.stringify({ workItems: [{ title: 'no id' }, { id: 'WL-3', title: 'C' }] });
    const parsed = parseAuditCandidatesOutput(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(1);
    expect(parsed![0].id).toBe('WL-3');
  });

  it('returns an empty array for an empty workItems list', () => {
    expect(parseAuditCandidatesOutput(JSON.stringify({ workItems: [] }))).toEqual([]);
  });
});

describe('audit prompt & pane helpers', () => {
  const candidate: DowntimeCandidate = { id: 'WL-AUD', title: 'Audit me', stage: 'audit' };

  it('builds an /skill:audit prompt', () => {
    const prompt = buildDowntimePrompt('audit', candidate);
    expect(prompt).toContain('/skill:audit WL-AUD');
  });

  it('builds a Downtime audit pane name', () => {
    const args = buildDowntimePaneArgs('audit', 'Run /skill:audit WL-AUD — Audit me.', {
      model: 'plan',
      cwd: '/repo',
    });
    expect(args).toContain('Downtime audit');
    expect(args).toContain('--no-focus');
  });

  it('skillKindFromPrompt detects an audit prompt', () => {
    expect(skillKindFromPrompt('Run /skill:audit WL-AUD — x.')).toBe('audit');
    expect(skillKindFromPrompt('Run /skill:plan WL-1 — x.')).toBe('plan');
    expect(skillKindFromPrompt('Run /skill:intake WL-2 — x.')).toBe('intake');
  });

  it('buildDowntimeDispatchComment renders /skill:audit', () => {
    const comment = buildDowntimeDispatchComment('WL-AUD', 'audit', '2026-01-01T00:00:00.000Z');
    expect(comment).toContain('/skill:audit WL-AUD');
  });

  it('toDowntimeCandidate produces a stage-audit candidate', () => {
    expect(toDowntimeCandidate({ id: 'X', title: 'T' })).toEqual({
      id: 'X',
      title: 'T',
      stage: 'audit',
    });
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

  it('aborts the dispatch (marker-write-failed) when recordDispatch fails — fail-closed', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      // A rejecting marker write (or a stub that throws) must abort BEFORE
      // the pane spawns: an unmarked item is never dispatched (RCA
      // WL-0MSRBFFLN005W3VT design point 2 — marker-before-spawn fail-closed).
      recordDispatch: vi.fn().mockRejectedValue(new Error('audit boom')),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('marker-write-failed');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('aborts the dispatch (marker-write-failed) when recordDispatch resolves false', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      recordDispatch: vi.fn().mockResolvedValue(false),
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
    expect(deps.recordDispatchFailure).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'WL-ABC', kind: 'plan', exitCode: 1 }),
    );
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

// ── Plan/intake selection (RCA WL-0MSRBFFLN005W3VT RC-2 + amplifier) ──

describe('plan/intake selection (selectNextCandidate)', () => {
  const openCandidate = (id: string, sortIndex = 0, stage: DowntimeStage = 'intake_complete') => ({
    id,
    title: id,
    stage,
    status: 'open',
    sortIndex,
  });

  it('selects the first open candidate in wl next priority order (ascending sortIndex)', () => {
    const selected = selectNextCandidate([
      openCandidate('WL-2', 20),
      openCandidate('WL-1', 10),
    ]);
    expect(selected?.id).toBe('WL-1');
  });

  it('excludes a candidate still at its dispatched-at stage (change-guard)', () => {
    const selected = selectNextCandidate(
      [openCandidate('WL-ONCE', 5), openCandidate('WL-NEXT', 20)],
      new Map([['WL-ONCE', 'intake_complete']]),
    );
    // WL-ONCE was dispatched for /skill:plan at intake_complete and is still
    // at intake_complete → excluded; the next candidate is selected.
    expect(selected?.id).toBe('WL-NEXT');
  });

  it('releases a candidate whose stage advanced past its dispatched-at stage', () => {
    // The marker recorded intake_complete but the candidate is now at idea
    // (a different stage) → not suppressed.
    const selected = selectNextCandidate(
      [openCandidate('WL-FREE', 5, 'idea')],
      new Map([['WL-FREE', 'intake_complete']]),
    );
    expect(selected?.id).toBe('WL-FREE');
  });

  it('a legacy marker without a recorded stage never suppresses selection', () => {
    const selected = selectNextCandidate(
      [openCandidate('WL-LEGACY', 5)],
      new Map([['WL-LEGACY', '']]),
    );
    expect(selected?.id).toBe('WL-LEGACY');
  });

  it('excludes completed candidates (client-side open-status guard, amplifier fix)', () => {
    const selected = selectNextCandidate([
      { ...openCandidate('WL-DONE', 5), status: 'completed' },
      openCandidate('WL-OPEN', 10),
    ]);
    expect(selected?.id).toBe('WL-OPEN');
  });

  it('a candidate without a verifiable status is never selected (fail-closed)', () => {
    const selected = selectNextCandidate([
      { id: 'WL-NO-STATUS', title: 'x', stage: 'intake_complete' },
    ]);
    expect(selected).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(selectNextCandidate([])).toBeNull();
  });
});

describe('parseNextCandidatesOutput', () => {
  it('parses the batch shape (wl next -n N) preserving status and sortIndex', () => {
    const candidates = parseNextCandidatesOutput(
      JSON.stringify({
        success: true,
        workItems: [
          { workItem: { id: 'WL-1', title: 'One', status: 'open', sortIndex: 7 } },
          { workItem: { id: 'WL-2', title: 'Two', status: 'completed', sortIndex: 3 } },
        ],
      }),
      'idea',
    );
    expect(candidates).toEqual([
      { id: 'WL-1', title: 'One', stage: 'idea', status: 'open', sortIndex: 7 },
      { id: 'WL-2', title: 'Two', stage: 'idea', status: 'completed', sortIndex: 3 },
    ]);
  });

  it('parses the legacy single-item shape', () => {
    const candidates = parseNextCandidatesOutput(
      JSON.stringify({ success: true, workItem: { id: 'WL-1', title: 'One', status: 'open' } }),
      'intake_complete',
    );
    expect(candidates).toEqual([
      { id: 'WL-1', title: 'One', stage: 'intake_complete', status: 'open', sortIndex: undefined },
    ]);
  });

  it('treats workItem:null as an empty backlog (not a parse failure)', () => {
    const candidates = parseNextCandidatesOutput(
      JSON.stringify({ success: false, workItem: null, reason: 'none' }),
      'idea',
    );
    expect(candidates).toEqual([]);
  });

  it('returns null on malformed JSON (fail-closed)', () => {
    expect(parseNextCandidatesOutput('not json', 'idea')).toBeNull();
    expect(parseNextCandidatesOutput(JSON.stringify({}), 'idea')).toBeNull();
  });
});

describe('buildDowntimeDispatchComment', () => {
  it('states the skill, item id, and ISO timestamp', () => {
    const comment = buildDowntimeDispatchComment('WL-ABC', 'plan', '2026-01-01T00:00:00.000Z');
    expect(comment).toContain('/skill:plan WL-ABC');
    expect(comment).toContain('2026-01-01T00:00:00.000Z');
    expect(comment).toContain('herdr downtime worker');
  });

  it('sanitizes newlines out of the embedded title', () => {
    const comment = buildDowntimeDispatchComment('WL-ABC', 'intake', '2026-01-01T00:00:00.000Z', 'multi\nline\rtitle');
    expect(comment).toContain('multi line title');
    expect(comment).not.toMatch(/[\r\n]/);
  });
});

// ── Single-flight (AC5) ───────────────────────────────────────────────

describe('single-flight dispatch guard', () => {
  it('does not dispatch a second time while one dispatch is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = () => resolve({ ok: true });
    });
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      spawnAgentPane: vi.fn().mockImplementation(() => gate),
    });

    const first = dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    const second = dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    release();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(firstOutcome.dispatched).toBe(true);
    expect(secondOutcome.dispatched).toBe(false);
    expect(secondOutcome.reason).toBe('dispatch-in-flight');
  });

  it('allows a new dispatch once the previous one has completed', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
    });

    const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(2);
  });
});

// ── Endpoint failures & poller (AC6) — implemented in F2 ──────────────

describe('endpoint failures and poller', () => {
  it('network errors are treated as busy and never throw', async () => {
    const fetcher = vi.fn().mockRejectedValue(networkErrorFixture);
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toBeNull();
  });

  it('timeouts are treated as busy and never throw', async () => {
    const fetcher = vi.fn().mockRejectedValue(timeoutErrorFixture);
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toBeNull();
  });

  it('HTTP error statuses are treated as busy', async () => {
    const fetcher = vi.fn().mockResolvedValue(httpErrorResponseFixture);
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toBeNull();
  });

  it('polls GET {proxyUrl}/llama/local/status', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await poller.poll();
    expect(fetcher).toHaveBeenCalledWith('http://proxy:8000/llama/local/status', expect.anything());
  });

  it('normalises a trailing slash on the proxy URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000/', fetcher);
    await poller.poll();
    expect(fetcher).toHaveBeenCalledWith('http://proxy:8000/llama/local/status', expect.anything());
  });

  it('returns the parsed status on a successful poll', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toEqual(idleAllSlotsFree);
  });

  it('treats invalid JSON as busy', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toBeNull();
  });

  it('treats payloads with missing required fields as busy', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(ambiguousMissingFieldsRaw));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toBeNull();
  });

  it('derives local_lease_active from the lease fields when the boolean is absent', async () => {
    const status = parseLlamaStatus({
      llama_server_running: true,
      active_query: false,
      model_switch_in_progress: false,
      available_slots: 4,
      total_slots: 4,
      local_owner_session_id: 'session-1',
      local_owner_lease_remaining_seconds: 120,
    });
    expect(status).not.toBeNull();
    expect(status!.local_lease_active).toBe(true);
    expect(evaluateIdle(status!, 0)).toBe(false);
  });

  it('coalesces overlapping polls (single-flight, no overlapping fetches)', async () => {
    let release!: () => void;
    const gate = new Promise<LlamaStatusHttpResponse>((resolve) => {
      release = () => resolve(jsonResponseFixture(idleAllSlotsFree));
    });
    const fetcher = vi.fn().mockImplementation(() => gate);
    const poller = createDowntimePoller('http://proxy:8000', fetcher);

    const first = poller.poll();
    expect(poller.isPolling()).toBe(true);
    const second = poller.poll();
    release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(idleAllSlotsFree);
    expect(secondResult).toBe(firstResult); // same coalesced result
    expect(poller.isPolling()).toBe(false);
  });

  it('aborts the request after the per-poll timeout (fail closed)', async () => {
    vi.useFakeTimers();
    let receivedSignal: unknown;
    const fetcher = vi.fn((_url: string, init?: { signal?: unknown }) => {
      receivedSignal = init?.signal;
      return new Promise<LlamaStatusHttpResponse>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    const poller = createDowntimePoller('http://proxy:8000', fetcher, 5_000);
    const pollPromise = poller.poll();
    expect(receivedSignal).toBeDefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pollPromise).resolves.toBeNull();
    expect(poller.isPolling()).toBe(false);
    vi.useRealTimers();
  });
});

// ── local_active_query parsing (WL-0MSL2ZQIF006QB4Q) ──────────────────

describe('parseLlamaStatus local_active_query', () => {
  const base = {
    llama_server_running: true,
    active_query: false,
    model_switch_in_progress: false,
    available_slots: 4,
    total_slots: 4,
  };

  it('exposes local_active_query=false when the proxy serves it', () => {
    const status = parseLlamaStatus({ ...base, local_active_query: false });
    expect(status).not.toBeNull();
    expect(status!.local_active_query).toBe(false);
  });

  it('exposes local_active_query=true when the proxy serves it', () => {
    const status = parseLlamaStatus({ ...base, local_active_query: true });
    expect(status).not.toBeNull();
    expect(status!.local_active_query).toBe(true);
  });

  it('leaves local_active_query undefined when absent (pre-fix proxy, backward compatible)', () => {
    const status = parseLlamaStatus(base);
    expect(status).not.toBeNull();
    expect(status!.local_active_query).toBeUndefined();
  });

  it('treats a malformed (non-boolean) local_active_query as ambiguous → busy', () => {
    expect(parseLlamaStatus({ ...base, local_active_query: 'yes' })).toBeNull();
  });
});

// ── Runtime idle evaluation (F2, AC5) ─────────────────────────────────

describe('runtime idle evaluation (evaluateIdle)', () => {
  const idle: LlamaStatus = {
    llama_server_running: true,
    active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 4,
    total_slots: 4,
  };

  it('N=0 (default) requires all slots free', () => {
    expect(evaluateIdle(idle, 0)).toBe(true);
    expect(evaluateIdle({ ...idle, available_slots: 3 }, 0)).toBe(false);
  });

  it('degrades 0 < N < total slots to ALL slots free (fail-closed, no per-slot data)', () => {
    // Without per-slot identity (LP-0MSG5TA7Y002GN39), N=2 with 4 slots
    // must NOT dispatch on "any 2 free" — it requires all 4 free.
    expect(evaluateIdle({ ...idle, available_slots: 2 }, 2)).toBe(false);
    expect(evaluateIdle({ ...idle, available_slots: 4 }, 2)).toBe(true);
  });

  it('N == total slots behaves like all slots free', () => {
    expect(evaluateIdle({ ...idle, available_slots: 4 }, 4)).toBe(true);
    expect(evaluateIdle({ ...idle, available_slots: 3 }, 4)).toBe(false);
  });

  it('N > total slots can never be idle (never dispatches)', () => {
    expect(evaluateIdle({ ...idle, available_slots: 4 }, 5)).toBe(false);
  });

  it('ambiguous responses (total_slots 0) are busy', () => {
    expect(evaluateIdle({ ...idle, total_slots: 0, available_slots: 0 }, 0)).toBe(false);
  });
});

// ── Blocked-questions prompt (AC7) ────────────────────────────────────

describe('blocked-questions prompt instruction', () => {
  const candidate: DowntimeCandidate = {
    id: 'WL-ABC',
    title: 'Some task',
    stage: 'intake_complete',
  };

  it('the plan prompt runs /skill:plan on the item id', () => {
    const prompt = buildDowntimePrompt('plan', candidate);
    expect(prompt).toContain('/skill:plan WL-ABC');
  });

  it('the intake prompt runs /skill:intake on the item id', () => {
    const prompt = buildDowntimePrompt('intake', { ...candidate, stage: 'idea' });
    expect(prompt).toContain('/skill:intake WL-ABC');
  });

  it('instructs recording questions in a comment, flagging needs-producer-review, and stopping', () => {
    const prompt = buildDowntimePrompt('plan', candidate);
    expect(prompt).toContain('comment');
    expect(prompt).toContain('--needs-producer-review true');
    expect(prompt).toContain('stop');
    expect(BLOCKED_QUESTIONS_INSTRUCTION).toContain('wl comment add');
    expect(BLOCKED_QUESTIONS_INSTRUCTION).toContain('wl update <id> --needs-producer-review true');
  });
});

// ── Settings clamps (AC8) ─────────────────────────────────────────────

describe('downtime settings clamps', () => {
  it('clampDowntimePollInterval enforces the 10s floor and keeps valid values', () => {
    expect(clampDowntimePollInterval(5_000)).toBe(DOWNTIME_POLL_INTERVAL_FLOOR_MS);
    expect(clampDowntimePollInterval(10_000)).toBe(10_000);
    expect(clampDowntimePollInterval(45_000)).toBe(45_000);
  });

  it('clampDowntimePollInterval falls back to the 30s default for non-finite values', () => {
    expect(clampDowntimePollInterval(Number.NaN)).toBe(DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
    expect(clampDowntimePollInterval(Infinity)).toBe(DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
  });

  it('clampDowntimeIdleThresholdMs rejects negative and non-finite values', () => {
    expect(clampDowntimeIdleThresholdMs(-1)).toBe(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    expect(clampDowntimeIdleThresholdMs(Number.NaN)).toBe(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
  });

  it('clampDowntimeIdleThresholdMs keeps valid values and floors at 1s', () => {
    expect(clampDowntimeIdleThresholdMs(240_000)).toBe(240_000);
    expect(clampDowntimeIdleThresholdMs(0)).toBe(1_000);
  });

  it('clampDowntimeRequiredFreeSlots maps negative/non-finite to 0 (all slots) and rounds', () => {
    expect(clampDowntimeRequiredFreeSlots(-3)).toBe(0);
    expect(clampDowntimeRequiredFreeSlots(Number.NaN)).toBe(0);
    expect(clampDowntimeRequiredFreeSlots(2.7)).toBe(3);
    expect(clampDowntimeRequiredFreeSlots(2)).toBe(2);
  });

  it('clampDowntimeNoCandidateCooldownMs keeps valid values and floors at 60s', () => {
    expect(clampDowntimeNoCandidateCooldownMs(3_600_000)).toBe(3_600_000);
    expect(clampDowntimeNoCandidateCooldownMs(1_000)).toBe(DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS);
    expect(clampDowntimeNoCandidateCooldownMs(60_000)).toBe(60_000);
  });

  it('clampDowntimeNoCandidateCooldownMs rejects negative and non-finite values', () => {
    expect(clampDowntimeNoCandidateCooldownMs(-1)).toBe(DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS);
    expect(clampDowntimeNoCandidateCooldownMs(Number.NaN)).toBe(DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS);
    expect(clampDowntimeNoCandidateCooldownMs(Infinity)).toBe(DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS);
  });
});

// ── Wiring helpers (F4) ───────────────────────────────────────────────

describe('parseNextItemOutput', () => {
  it('parses the workItem from `wl next --stage <stage> --json`', () => {
    const stdout = JSON.stringify({ success: true, workItem: { id: 'WL-ABC', title: 'Some task' } });
    expect(parseNextItemOutput(stdout, 'intake_complete')).toEqual({
      id: 'WL-ABC',
      title: 'Some task',
      stage: 'intake_complete',
    });
  });

  it('returns null when wl next reports no item (workItem null)', () => {
    const stdout = JSON.stringify({ success: false, workItem: null, reason: 'no items' });
    expect(parseNextItemOutput(stdout, 'idea')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseNextItemOutput('not json', 'idea')).toBeNull();
  });

  it('returns null when the workItem lacks an id', () => {
    const stdout = JSON.stringify({ success: true, workItem: { title: 'no id' } });
    expect(parseNextItemOutput(stdout, 'idea')).toBeNull();
  });
});

describe('skillKindFromPrompt', () => {
  it('derives plan from a /skill:plan prompt and intake otherwise', () => {
    expect(skillKindFromPrompt('Run /skill:plan WL-ABC — Task.')).toBe('plan');
    expect(skillKindFromPrompt('Run /skill:intake WL-DEF — Idea.')).toBe('intake');
  });
});

describe('downtime worker enabled state', () => {
  it('exposes the enabled flag from the per-tick config', async () => {
    const cfg = { enabled: true };
    const worker = createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000'),
      deps: makeDeps(),
      config: () => ({
        enabled: cfg.enabled,
        thresholdMs: 240_000,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: '/repo',
        noCandidateCooldownMs: 3_600_000,
      }),
    });
    expect(worker.enabled).toBe(true);
    cfg.enabled = false;
    expect(worker.enabled).toBe(false);
  });
});

// ── Pane spawn (AC4) ──────────────────────────────────────────────────

describe('downtime pane spawn (send-to-pi.sh)', () => {
  it('builds --pane-name / --no-focus / --cwd / --model args for a plan dispatch', () => {
    const args = buildDowntimePaneArgs('plan', 'Run /skill:plan WL-ABC — Some task.', {
      model: 'plan',
      cwd: '/repo',
    });
    expect(args).toEqual([
      '--pane-name',
      'Downtime plan',
      '--no-focus',
      '--cwd',
      '/repo',
      '--model',
      'plan',
      'Run /skill:plan WL-ABC — Some task.',
    ]);
  });

  it('uses the intake pane name and forwards the configured model', () => {
    const args = buildDowntimePaneArgs('intake', 'Run /skill:intake WL-DEF', {
      model: 'code',
      cwd: '/repo',
    });
    expect(args).toContain('Downtime intake');
    expect(args).toContain('code');
    expect(args).not.toContain('Downtime plan');
  });

  it('spawns via the injectable spawn and unrefs the child', async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() })) as unknown as DowntimeSpawn;

    const spawned = await spawnDowntimePane('/path/to/send-to-pi.sh', ['--no-focus', 'prompt'], { cwd: '/repo' }, spawnFn);

    expect(spawnFn).toHaveBeenCalledWith('/path/to/send-to-pi.sh', ['--no-focus', 'prompt'], {
      cwd: '/repo',
    });
    const handle = (spawnFn as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(handle.unref).toHaveBeenCalled();
    expect(handle.once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(handle.once).toHaveBeenCalledWith('exit', expect.any(Function));
    // No error/exit within the probe window → the pane is assumed opened.
    expect(spawned).toEqual({ ok: true });
  });

  it('resolves {ok:false} with the error trace on a handled spawn error (no unhandled-exception crash)', async () => {
    const handle = {
      unref: vi.fn(),
      once: vi.fn((event: string, listener: (arg: unknown) => void) => {
        if (event === 'error') listener(new Error('ENOENT: send-to-pi.sh'));
      }),
    };
    const spawnFn = vi.fn(() => handle) as unknown as DowntimeSpawn;

    const spawned = await spawnDowntimePane('/path/to/missing.sh', [], { cwd: '/repo' }, spawnFn);

    expect(spawned).toEqual({ ok: false, error: 'ENOENT: send-to-pi.sh' });
    expect(handle.once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(handle.once).toHaveBeenCalledWith('exit', expect.any(Function));
  });

  it('resolves {ok:false} with the exit trace on a non-zero script exit within the probe window', async () => {
    const handle = {
      unref: vi.fn(),
      once: vi.fn((event: string, listener: (arg: unknown) => void) => {
        if (event === 'exit') listener(1);
      }),
    };
    const spawnFn = vi.fn(() => handle) as unknown as DowntimeSpawn;

    const spawned = await spawnDowntimePane('/path/to/send-to-pi.sh', [], { cwd: '/repo' }, spawnFn);

    expect(spawned).toEqual({ ok: false, exitCode: 1 });
  });

  it('treats a signal-killed child (exit code null) as a failure', async () => {
    const handle = {
      unref: vi.fn(),
      once: vi.fn((event: string, listener: (arg: unknown) => void) => {
        if (event === 'exit') listener(null);
      }),
    };
    const spawnFn = vi.fn(() => handle) as unknown as DowntimeSpawn;

    const spawned = await spawnDowntimePane('/path/to/send-to-pi.sh', [], { cwd: '/repo' }, spawnFn);

    expect(spawned).toEqual({ ok: false, exitCode: null });
  });

  it('resolves {ok:true} when the script exits 0 (pane opened — success path unchanged)', async () => {
    const handle = {
      unref: vi.fn(),
      once: vi.fn((event: string, listener: (arg: unknown) => void) => {
        if (event === 'exit') listener(0);
      }),
    };
    const spawnFn = vi.fn(() => handle) as unknown as DowntimeSpawn;

    const spawned = await spawnDowntimePane('/path/to/send-to-pi.sh', [], { cwd: '/repo' }, spawnFn);

    expect(spawned).toEqual({ ok: true });
  });

  it('buildDowntimeSpawnOptions uses detached/ignore options with the resolved cwd', () => {
    const options = buildDowntimeSpawnOptions('/repo');
    expect(options).toEqual({
      detached: true,
      stdio: 'ignore',
      cwd: '/repo',
      env: expect.objectContaining({ HERDR_RESOLVED_CWD: '/repo' }),
    });
  });

  it('buildDowntimeSpawnOptions bounds the dispatched audit fan-out (AUDIT_PHASE2_PARALLELISM=1)', () => {
    const options = buildDowntimeSpawnOptions('/repo');
    // Parent audit + at most one sequential child deep-analysis call fits
    // cheap mode's 2 local slots (WL-0MSORQ1RG005DGUS).
    expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('1');
  });
});

// ── Worker orchestrator (AC1/AC5) ─────────────────────────────────────

describe('downtime worker orchestrator (createDowntimeWorker)', () => {
  function makeWorker(overrides: {
    enabled?: boolean;
    thresholdMs?: number;
    cooldownMs?: number;
    status?: unknown;
    deps?: Partial<DowntimeWorkerDeps>;
  } = {}) {
    const cfg = {
      enabled: overrides.enabled ?? true,
      thresholdMs: overrides.thresholdMs ?? 240_000,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: overrides.cooldownMs ?? 3_600_000,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponseFixture(overrides.status ?? idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      ...overrides.deps,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg, fetcher };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing (no poll, no dispatch) when disabled', async () => {
    const { worker, deps, fetcher } = makeWorker({ enabled: false });
    const result = await worker.tick();
    expect(result).toEqual({ polled: false, dispatched: false, idle: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('treats a busy status as busy and never dispatches', async () => {
    const { worker, deps } = makeWorker({ status: { ...idleAllSlotsFree, active_query: true } });
    const result = await worker.tick();
    expect(result.idle).toBe(false);
    expect(worker.idleSince).toBeNull();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('treats remote-only traffic as idle and dispatches after the threshold (local_active_query=false)', async () => {
    // Integration (AC2): a stub status with global active_query=true but
    // local_active_query=false (remote streams in flight, local slots free)
    // must be treated as idle and dispatch after the idle threshold.
    const { worker, deps, cfg } = makeWorker({
      status: { ...idleAllSlotsFree, active_query: true, local_active_query: false },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince).toBe(start);

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch until the idle duration reaches the threshold (AC1)', async () => {
    const { worker, deps, cfg } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince).toBe(start);

    vi.setSystemTime(start + cfg.thresholdMs - 1);
    const before = await worker.tick();
    expect(before.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(worker.lastDispatchAt).toBe(start + cfg.thresholdMs);
  });

  it('requires a fresh full idle period after a dispatch (AC5)', async () => {
    const { worker, deps, cfg } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + cfg.thresholdMs);
    await worker.tick();
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    // Still idle at the next tick: the tracker was reset after dispatch, so
    // no second dispatch until another full idle period has elapsed.
    vi.setSystemTime(start + cfg.thresholdMs + 30_000);
    const next = await worker.tick();
    expect(next.dispatched).toBe(false);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(worker.idleSince).toBe(start + cfg.thresholdMs + 30_000);

    vi.setSystemTime(start + cfg.thresholdMs + 30_000 + cfg.thresholdMs);
    const after = await worker.tick();
    expect(after.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(2);
  });

  it('a busy poll (proxy busy after dispatch) resets the idle run', async () => {
    const { worker, deps, cfg, fetcher } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + cfg.thresholdMs);
    await worker.tick();
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    fetcher.mockResolvedValueOnce(jsonResponseFixture({ ...idleAllSlotsFree, active_query: true }));
    vi.setSystemTime(start + cfg.thresholdMs + 30_000);
    const busy = await worker.tick();
    expect(busy.idle).toBe(false);
    expect(worker.idleSince).toBeNull();

    // Back to idle: a full new run is required before the next dispatch.
    vi.setSystemTime(start + cfg.thresholdMs + 60_000);
    const reIdle = await worker.tick();
    expect(reIdle.idle).toBe(true);
    expect(reIdle.dispatched).toBe(false);
    vi.setSystemTime(start + cfg.thresholdMs + 60_000 + cfg.thresholdMs);
    const reDispatch = await worker.tick();
    expect(reDispatch.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(2);
  });

  it('re-reads settings each tick so changes apply without a restart', async () => {
    const { worker, deps, cfg } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();

    cfg.thresholdMs = 60_000; // operator changes the setting live
    vi.setSystemTime(start + 60_000);
    const result = await worker.tick();
    expect(result.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('does not start a second dispatch while one is in flight (worker single-flight)', async () => {
    let release!: () => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = () => resolve({ ok: true });
    });
    const { worker, deps } = makeWorker({
      deps: { spawnAgentPane: vi.fn().mockImplementation(() => gate) },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);

    const first = worker.tick();
    const second = await worker.tick();
    expect(second.dispatched).toBe(false);

    release();
    const firstResult = await first;
    expect(firstResult.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });
});

// ── No-candidate cooldown (WL-0MSI7DQL10016QYX) ──────────────────────

describe('downtime no-candidate cooldown (createDowntimeWorker)', () => {
  /** Empty backlog in BOTH stages → the worker should pause. */
  function makeEmptyBacklogWorker(overrides: {
    cooldownMs?: number;
    deps?: Partial<DowntimeWorkerDeps>;
  } = {}) {
    const cfg = {
      enabled: true,
      thresholdMs: 240_000,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: overrides.cooldownMs ?? 3_600_000,
    };
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      ...overrides.deps,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg, fetcher };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enters the cooldown only after a genuine no-candidate outcome', async () => {
    const { worker, deps } = makeEmptyBacklogWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // idle run starts
    vi.setSystemTime(start + 240_000); // threshold met → dispatch attempt

    const result = await worker.tick();

    expect(result.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(worker.paused).toBe(true);
  });

  it('performs no proxy polling, no idle tracking and no dispatch while paused', async () => {
    const { worker, deps, fetcher } = makeEmptyBacklogWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);
    await worker.tick(); // enters cooldown
    expect(worker.paused).toBe(true);

    const pollsBefore = fetcher.mock.calls.length;
    const idleBefore = worker.idleSince;
    vi.setSystemTime(start + 240_000 + 60_000); // still within the pause
    const result = await worker.tick();

    expect(result).toEqual({ polled: false, dispatched: false, idle: false });
    expect(fetcher.mock.calls.length).toBe(pollsBefore); // no poll
    expect(worker.idleSince).toBe(idleBefore); // no idle tracking
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(worker.paused).toBe(true);
  });

  it('resumes polling once the cooldown expires and requires a fresh full idle period', async () => {
    let backlogEmpty = true;
    const { worker, deps } = makeEmptyBacklogWorker({
      deps: {
        getNextItem: vi.fn().mockImplementation(() =>
          Promise.resolve(
            backlogEmpty
              ? { ok: true, candidate: null }
              : { ok: true, candidate: { id: 'WL-NEW', title: 'New item', stage: 'intake_complete' } },
          ),
        ),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);
    await worker.tick(); // empty backlog → cooldown
    expect(worker.paused).toBe(true);

    // The project's backlog fills back up while the worker is paused.
    backlogEmpty = false;
    vi.setSystemTime(start + 240_000 + 3_600_000); // pause expires
    const resumed = await worker.tick();
    expect(resumed.polled).toBe(true);
    expect(resumed.dispatched).toBe(false); // fresh idle run — no stale credit
    expect(worker.paused).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    // A full new idle period must elapse before the next dispatch.
    vi.setSystemTime(start + 240_000 + 3_600_000 + 240_000);
    const afterFreshIdle = await worker.tick();
    expect(afterFreshIdle.dispatched).toBe(true); // candidate now available
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('does not enter the cooldown on a transient wl error (fail closed to busy)', async () => {
    const { worker, deps } = makeEmptyBacklogWorker({
      deps: { getNextItem: vi.fn().mockResolvedValue({ ok: false }) },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);

    const result = await worker.tick();

    expect(result.dispatched).toBe(false);
    expect(worker.paused).toBe(false); // a single error is NOT an empty backlog
    expect(worker.errorStrikes).toBe(1); // ...but it IS the first strike
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordError).not.toHaveBeenCalled();
  });

  it('does not enter the cooldown when the dispatch guard reports in-flight', async () => {
    // Hold the module-level dispatch single-flight guard with an outer
    // in-flight dispatch; the worker's own dispatch call then returns
    // `dispatch-in-flight`, which must NOT trigger the cooldown.
    let release!: () => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = () => resolve({ ok: true });
    });
    const outerDeps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-X', title: 'Outer', stage: 'intake_complete' },
      }),
      spawnAgentPane: vi.fn().mockImplementation(() => gate),
    });
    const outer = dispatchDowntimeWork(outerDeps, { model: 'plan', cwd: '/repo' });

    const { worker } = makeEmptyBacklogWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);
    const result = await worker.tick();
    expect(result.dispatched).toBe(false);
    expect(worker.paused).toBe(false); // in-flight guard is not an empty backlog

    release();
    await outer;
  });

  it('does not enter the cooldown on a code-freeze skip (the freeze never pauses the worker)', async () => {
    // Frozen + empty plan/intake backlog → reason 'code-freeze' (never
    // 'no-candidate'): the worker must keep polling so implement/audit
    // dispatch resumes immediately when the freeze lifts (WL-0MSQ0RPQP00636JY).
    const { worker, deps } = makeEmptyBacklogWorker({
      deps: {
        readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);

    const result = await worker.tick();

    expect(result.dispatched).toBe(false);
    expect(worker.paused).toBe(false); // a freeze skip is NOT an empty backlog
    expect(worker.errorStrikes).toBe(0); // ...and not a CLI-error strike either
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('re-reads the cooldown setting each tick so a change applies on the next cooldown entry', async () => {
    const { worker, cfg } = makeEmptyBacklogWorker({ cooldownMs: 3_600_000 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);
    await worker.tick(); // enters cooldown with 3_600_000 (expires at 4_840_000)
    expect(worker.paused).toBe(true);

    // Operator lowers the cooldown live; the in-progress pause keeps its
    // original expiry, but the NEXT cooldown entry uses the new value.
    cfg.noCandidateCooldownMs = 60_000;
    vi.setSystemTime(start + 240_000 + 3_600_000); // original pause expires
    await worker.tick(); // resumes, starts a fresh idle run

    vi.setSystemTime(start + 240_000 + 3_600_000 + 240_000); // fresh threshold met
    await worker.tick(); // empty backlog again → 60s cooldown (new value)
    expect(worker.paused).toBe(true);

    // With the NEW 60s value the pause expires long before the old 60-min
    // default would have: at +61s the worker has resumed polling.
    vi.setSystemTime(start + 240_000 + 3_600_000 + 240_000 + 61_000);
    const resumed = await worker.tick();
    expect(resumed.polled).toBe(true);
    expect(worker.paused).toBe(false);
  });
});

// ── Three-strike rule on CLI errors ───────────────────────────────────

describe('three-strike rule on CLI errors (createDowntimeWorker)', () => {
  /** Every dispatch attempt ends in a wl CLI error ({ok:false} both tiers). */
  function makeErrorWorker(overrides: { deps?: Partial<DowntimeWorkerDeps> } = {}) {
    const cfg = {
      enabled: true,
      thresholdMs: 240_000,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
    };
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: false }),
      ...overrides.deps,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg, fetcher };
  }

  it('pauses and records the persistent error after 3 consecutive CLI errors', async () => {
    const { worker, deps } = makeErrorWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // idle run starts
    vi.setSystemTime(start + 240_000); // threshold met

    const s1 = await worker.tick(); // strike 1
    expect(s1.dispatched).toBe(false);
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(1);

    const s2 = await worker.tick(); // strike 2
    expect(s2.dispatched).toBe(false);
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(2);

    const s3 = await worker.tick(); // strike 3 → pause + log
    expect(s3.dispatched).toBe(false);
    expect(worker.paused).toBe(true);
    expect(worker.errorStrikes).toBe(0); // counter reset once paused
    expect(deps.recordError).toHaveBeenCalledTimes(1);
    const event = (deps.recordError as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.cwd).toBe('/repo');
    expect(event.message).toContain('3 consecutive');
    expect(Number.isNaN(Date.parse(event.at))).toBe(false);
  });

  it('an audit-tier wl failure counts toward the three-strike rule (WL-0MSLWJ2KP0002SV0)', async () => {
    // The wl-error comes from the AUDIT tier ({ok:false}) while the
    // plan/intake tiers are GENUINELY empty ({ok:true, candidate:null}): the
    // only possible strike source is the audit lookup, proving a broken
    // audit query cannot silently pass as "no audit candidates" forever —
    // three consecutive failures pause the worker and log recordError.
    const { worker, deps } = makeErrorWorker({
      deps: {
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: false }),
        getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);

    const s1 = await worker.tick();
    expect(s1.dispatched).toBe(false);
    expect(worker.errorStrikes).toBe(1);
    expect(worker.paused).toBe(false);
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1);

    const s2 = await worker.tick();
    expect(s2.dispatched).toBe(false);
    expect(worker.errorStrikes).toBe(2);
    expect(deps.recordError).not.toHaveBeenCalled();

    const s3 = await worker.tick(); // strike 3 → pause + durable trace
    expect(s3.dispatched).toBe(false);
    expect(worker.paused).toBe(true);
    expect(worker.errorStrikes).toBe(0);
    expect(deps.recordError).toHaveBeenCalledTimes(1);
    expect(deps.recordError).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('resumes with a fresh strike counter once the pause expires', async () => {
    const { worker, deps } = makeErrorWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);
    await worker.tick(); // strike 1
    await worker.tick(); // strike 2
    await worker.tick(); // strike 3 → paused
    expect(worker.paused).toBe(true);

    vi.setSystemTime(start + 240_000 + 3_600_000); // pause expires
    const resumed = await worker.tick();
    expect(resumed.polled).toBe(true);
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(0);

    // A fresh error is strike 1 again — not a strike 4.
    vi.setSystemTime(start + 240_000 + 3_600_000 + 240_000);
    await worker.tick();
    expect(worker.errorStrikes).toBe(1);
    expect(worker.paused).toBe(false);
  });

  it('resets the strike counter on a successful dispatch', async () => {
    const { worker, deps } = makeErrorWorker({
      deps: {
        getNextItem: vi
          .fn()
          .mockResolvedValueOnce({ ok: false }) // tier 2 error
          .mockResolvedValueOnce({ ok: false }) // tier 3 error → strike 1
          .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' } })
          .mockResolvedValue({ ok: false }), // errors afterwards
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);

    await worker.tick(); // strike 1
    expect(worker.errorStrikes).toBe(1);

    await worker.tick(); // successful dispatch → strikes reset
    expect(worker.errorStrikes).toBe(0);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    // A fresh full idle period is required after the dispatch (AC5) before
    // the next dispatch attempt.
    vi.setSystemTime(start + 240_000 + 240_000); // fresh idle run starts
    await worker.tick();
    vi.setSystemTime(start + 240_000 + 480_000); // fresh threshold met
    await worker.tick(); // strike 1 (fresh — not a strike 2)
    expect(worker.errorStrikes).toBe(1);
    await worker.tick(); // strike 2
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(2);

    await worker.tick(); // strike 3 → paused
    expect(worker.paused).toBe(true);
    expect(deps.recordError).toHaveBeenCalledTimes(1);
  });

  it('does not strike on a no-candidate outcome (CLI answered — healthy)', async () => {
    const { worker, deps } = makeErrorWorker({
      deps: {
        getNextItem: vi
          .fn()
          .mockResolvedValueOnce({ ok: false })
          .mockResolvedValueOnce({ ok: false }) // strike 1
          .mockResolvedValue({ ok: true, candidate: null }), // genuine empty backlog
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);

    await worker.tick(); // strike 1
    expect(worker.errorStrikes).toBe(1);

    const result = await worker.tick(); // no-candidate → cooldown, strikes reset
    expect(result.dispatched).toBe(false);
    expect(worker.paused).toBe(true); // genuine empty backlog pauses the worker
    expect(worker.errorStrikes).toBe(0);
    expect(deps.recordError).not.toHaveBeenCalled(); // no persistent-error log
  });
});

// ── Per-slot idle tracking (WL-0MSP28F5Z008DAUA, parent WL-0MSG7P9N8009PCKG) ──
// Test-first suite for same-slot idle tracking, deferred follow-up Q7 of
// WL-0MSF49FMW009M06K. The proxy feature LP-0MSG5TA7Y002GN39 serves per-slot
// details (`slots: [{slot_id, is_processing}]`) in GET /llama/local/status;
// when `downtimeRequiredFreeSlots` N < total slots, the worker must track idle
// duration PER SLOT IDENTITY so the SAME N slots are free for the full
// threshold — never any-N transient availability.
//
// The proxy (observability.py) serves `slot_id` as an INTEGER
// (`slot.get("id", i)`); `parseLlamaStatus` coerces numeric ids to strings
// and clamps negatives to 0 (WL-0MSVRMAWM007QNR5 — the Aug 15-16
// zero-dispatch regression fix). Regression tests mirror the live payload
// at parse level and end-to-end through the worker tick.

// ── parseLlamaStatus: optional per-slot fields (AC1/AC2) ───────────────

describe('parseLlamaStatus per-slot slots array', () => {
  const base = {
    llama_server_running: true,
    active_query: false,
    model_switch_in_progress: false,
    available_slots: 4,
    total_slots: 4,
  };

  it('exposes the slots array when the payload serves it', () => {
    const status = parseLlamaStatus({
      ...base,
      slots: [
        { slot_id: 'slot-1', is_processing: false },
        { slot_id: 'slot-2', is_processing: true },
      ],
    });
    expect(status).not.toBeNull();
    expect(status!.slots).toEqual([
      { slot_id: 'slot-1', is_processing: false },
      { slot_id: 'slot-2', is_processing: true },
    ]);
  });

  it('leaves slots undefined when the payload does not serve it (backward compatible)', () => {
    const status = parseLlamaStatus(base);
    expect(status).not.toBeNull();
    expect(status!.slots).toBeUndefined();
  });

  it('parses an empty slots array as valid (zero free slots — never dispatches)', () => {
    const status = parseLlamaStatus({ ...base, slots: [] });
    expect(status).not.toBeNull();
    expect(status!.slots).toEqual([]);
  });

  it('treats a non-array slots field as ambiguous → null (busy, fail-closed)', () => {
    expect(parseLlamaStatus({ ...base, slots: 'not-an-array' })).toBeNull();
    expect(parseLlamaStatus({ ...base, slots: { slot_id: 'x', is_processing: false } })).toBeNull();
  });

  it('treats an entry missing slot_id as malformed → null', () => {
    expect(parseLlamaStatus({ ...base, slots: [{ is_processing: false }] })).toBeNull();
  });

  it('treats an empty-string slot_id as malformed → null (zero-length guard preserved)', () => {
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: '', is_processing: false }] })).toBeNull();
  });

  it('coerces numeric slot_ids to strings (proxy contract: int, WL-0MSVRMAWM007QNR5)', () => {
    const status = parseLlamaStatus({
      ...base,
      slots: [
        { slot_id: 0, is_processing: false },
        { slot_id: 3, is_processing: true },
      ],
    });
    expect(status).not.toBeNull();
    expect(status!.slots).toEqual([
      { slot_id: '0', is_processing: false },
      { slot_id: '3', is_processing: true },
    ]);
  });

  it('clamps negative numeric slot_ids to 0 (WL-0MSVRMAWM007QNR5)', () => {
    const status = parseLlamaStatus({
      ...base,
      slots: [{ slot_id: -2, is_processing: false }],
    });
    expect(status).not.toBeNull();
    expect(status!.slots).toEqual([{ slot_id: '0', is_processing: false }]);
  });

  it('treats a non-finite or non-integer numeric slot_id as malformed → null (fail-closed)', () => {
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: Number.NaN, is_processing: false }] })).toBeNull();
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: Number.POSITIVE_INFINITY, is_processing: false }] })).toBeNull();
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: 1.5, is_processing: false }] })).toBeNull();
  });

  it('regression: parses the live proxy payload (integer slot_ids, WL-0MSVRMAWM007QNR5)', () => {
    // observability.py serves `"slot_id": slot.get("id", i)` — an integer —
    // per slot. Before the fix, parseLlamaStatus rejected the numeric
    // slot_id and every 30s poll failed closed to busy — the Aug 15-16
    // zero-dispatch regression. Mirror the live payload exactly.
    const livePayload = {
      llama_server_running: true,
      active_query: false,
      model_switch_in_progress: false,
      available_slots: 4,
      total_slots: 4,
      slots: [
        { slot_id: 0, is_processing: false },
        { slot_id: 1, is_processing: false },
        { slot_id: 2, is_processing: false },
        { slot_id: 3, is_processing: false },
      ],
    };
    const status = parseLlamaStatus(livePayload);
    expect(status).not.toBeNull();
    expect(status!.slots!.map((s) => s.slot_id)).toEqual(['0', '1', '2', '3']);
    // The coerced payload is a valid idle status for the default N=0 AND
    // for per-slot mode (0 < N < total) — dispatch can resume.
    expect(evaluateIdle(status!, 0)).toBe(true);
    expect(evaluateIdle(status!, 2)).toBe(true);
  });

  it('treats a non-boolean or missing is_processing as malformed → null', () => {
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: 'slot-1', is_processing: 'yes' }] })).toBeNull();
    expect(parseLlamaStatus({ ...base, slots: [{ slot_id: 'slot-1' }] })).toBeNull();
  });

  it('treats duplicate slot_ids as malformed → null', () => {
    expect(
      parseLlamaStatus({
        ...base,
        slots: [
          { slot_id: 'slot-1', is_processing: false },
          { slot_id: 'slot-1', is_processing: true },
        ],
      }),
    ).toBeNull();
  });
});

// ── Per-slot idle tracker (AC3/AC4) ───────────────────────────────────

describe('per-slot idle tracker (createPerSlotIdleTracker)', () => {
  const a: LlamaSlot = { slot_id: 'a', is_processing: false };
  const b: LlamaSlot = { slot_id: 'b', is_processing: false };

  it('starts a slot timer on its first free poll and continues it across free polls', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    expect(tracker.idleSince.get('a')).toBe(start);
    expect(tracker.idleSince.get('b')).toBe(start);

    tracker.record([a, b], start + 30_000);
    expect(tracker.idleSince.get('a')).toBe(start); // run start stays fixed
    expect(tracker.idleSince.get('b')).toBe(start);
  });

  it('a slot starting processing resets ONLY its own timer (other timers continue)', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    tracker.record([{ slot_id: 'a', is_processing: true }, b], start + 10_000);

    expect(tracker.idleSince.get('a')).toBeNull(); // own timer reset
    expect(tracker.idleSince.get('b')).toBe(start); // other timer continues
  });

  it('a slot absent from the payload is fail-closed to busy (its timer resets)', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    tracker.record([a], start + 10_000); // b absent

    expect(tracker.idleSince.get('a')).toBe(start);
    expect(tracker.idleSince.get('b')).toBeNull();
  });

  it('an empty record resets every slot timer (global-busy reset path)', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    tracker.record([], start + 10_000);

    expect(tracker.idleSince.get('a')).toBeNull();
    expect(tracker.idleSince.get('b')).toBeNull();
  });

  it('thresholdMetCount counts only slots continuously free for the full threshold', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    expect(tracker.thresholdMetCount(240_000, start + 239_999)).toBe(0);
    expect(tracker.thresholdMetCount(240_000, start + 240_000)).toBe(2);
    expect(tracker.thresholdMetCount(240_000, start + 500_000)).toBe(2);
  });

  it('a reset slot needs a fresh full run before it counts toward the threshold again', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    // a goes processing at +10s (own timer reset) and free again at +20s.
    tracker.record([{ slot_id: 'a', is_processing: true }, b], start + 10_000);
    tracker.record([a, b], start + 20_000);

    // Only b has a full continuous run at start+threshold+5s.
    expect(tracker.thresholdMetCount(240_000, start + 240_000 + 5_000)).toBe(1);
    // a completes its fresh run at start+20s+threshold → both count.
    expect(tracker.thresholdMetCount(240_000, start + 20_000 + 240_000)).toBe(2);
  });
});

// ── evaluateIdle: per-slot mode (AC5 + per-slot free count) ───────────

describe('evaluateIdle per-slot mode (0 < N < total with slots present)', () => {
  const free = (id: string): LlamaSlot => ({ slot_id: id, is_processing: false });
  const busy = (id: string): LlamaSlot => ({ slot_id: id, is_processing: true });
  const perSlot = (slots: LlamaSlot[], available: number, total: number): LlamaStatus => ({
    llama_server_running: true,
    active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: available,
    total_slots: total,
    slots,
  });
  // 4 slots, 2 free (slot-1, slot-2).
  const twoFree = perSlot([free('s1'), free('s2'), busy('s3'), busy('s4')], 2, 4);

  it('uses the per-slot free count when per-slot data is present and 0 < N < total', () => {
    expect(evaluateIdle(twoFree, 2)).toBe(true); // 2 of 4 free — enough
    expect(evaluateIdle(twoFree, 3)).toBe(false); // needs 3 — not enough
  });

  it('per-slot mode still requires the base idle checks (global busy → false)', () => {
    expect(evaluateIdle({ ...twoFree, active_query: true }, 2)).toBe(false);
    expect(evaluateIdle({ ...twoFree, model_switch_in_progress: true }, 2)).toBe(false);
    expect(evaluateIdle({ ...twoFree, local_lease_active: true }, 2)).toBe(false);
    expect(evaluateIdle({ ...twoFree, llama_server_running: false }, 2)).toBe(false);
  });

  it('N=0 (default) still requires ALL slots free even when per-slot data is present', () => {
    expect(evaluateIdle(twoFree, 0)).toBe(false); // 2 < 4 → busy
    expect(evaluateIdle(perSlot([free('s1'), free('s2'), free('s3'), free('s4')], 4, 4), 0)).toBe(true);
  });

  it('N == total still requires ALL slots free even when per-slot data is present', () => {
    expect(evaluateIdle(perSlot([free('s1'), free('s2'), free('s3'), free('s4')], 4, 4), 4)).toBe(true);
    expect(evaluateIdle(perSlot([free('s1'), free('s2'), busy('s3'), free('s4')], 3, 4), 4)).toBe(false);
  });

  it('N > total never idles even with per-slot data', () => {
    expect(evaluateIdle(perSlot([free('s1'), free('s2'), free('s3'), free('s4')], 4, 4), 5)).toBe(false);
  });
});

// ── Worker routing: per-slot mode vs fallback (WL-0MSG7P9N8009PCKG AC) ─

describe('downtime worker per-slot routing (createDowntimeWorker)', () => {
  function makePerSlotWorker(overrides: {
    requiredFreeSlots?: number;
    thresholdMs?: number;
    status?: unknown;
    deps?: Partial<DowntimeWorkerDeps>;
  } = {}) {
    const cfg = {
      enabled: true,
      thresholdMs: overrides.thresholdMs ?? 240_000,
      requiredFreeSlots: overrides.requiredFreeSlots ?? 2,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponseFixture(overrides.status ?? perSlotTwoFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      ...overrides.deps,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg, fetcher };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes to per-slot mode: dispatches with only N of total slots free (same slots, full threshold)', async () => {
    // perSlotTwoFree: 2 of 4 slots free. Legacy all-slots-free mode would
    // NEVER dispatch (available 2 < 4); per-slot mode dispatches after the
    // threshold because the SAME 2 slots have been free throughout.
    const { worker, deps, cfg } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince ?? null).not.toBeNull(); // idle run starts

    vi.setSystemTime(start + cfg.thresholdMs - 1);
    const before = await worker.tick();
    expect(before.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('regression: a live proxy payload (integer slot_ids) idles and dispatches (WL-0MSVRMAWM007QNR5)', async () => {
    // observability.py serves `"slot_id": slot.get("id", i)` — an integer —
    // for each slot. Before the fix, parseLlamaStatus rejected the numeric
    // slot_id, so every poll failed closed to busy and the worker never
    // dispatched (the Aug 15-16 zero-dispatch regression). This mirrors the
    // live payload end-to-end: poll → parse → idle run → threshold → dispatch.
    const livePayload = {
      llama_server_running: true,
      active_query: false,
      model_switch_in_progress: false,
      available_slots: 4,
      total_slots: 4,
      slots: [
        { slot_id: 0, is_processing: false },
        { slot_id: 1, is_processing: false },
        { slot_id: 2, is_processing: false },
        { slot_id: 3, is_processing: false },
      ],
    };
    const { worker, deps, cfg } = makePerSlotWorker({ status: livePayload });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince ?? null).not.toBeNull(); // idle run starts

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('a slot starting processing resets only its own timer: other slots keep their run and can dispatch', async () => {
    // N=1. slot-1 goes processing at +10s while slot-2 stays free. The poll
    // stays per-slot idle (free count 3 ≥ 1), slot-2's timer continues, and
    // dispatch fires at the original threshold — not delayed by slot-1.
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({ requiredFreeSlots: 1 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // all 4 free → timers start

    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotOneProcessing));
    vi.setSystemTime(start + 10_000);
    const mid = await worker.tick();
    expect(mid.idle).toBe(true); // free count 3 ≥ N=1 → still idle

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('a processing slot that must count toward N delays dispatch by its own fresh run', async () => {
    // Per-slot mode with 4 slots, N=2: slot-1 is processing from +10s to
    // +20s while slot-2 stays free. slot-1's OWN timer resets, so dispatch
    // cannot fire at the original threshold (only slot-2 has a full
    // continuous run); it fires only after slot-1's fresh run completes.
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // slot-1, slot-2 free → their timers start

    const fourSlots = (s1: boolean): LlamaStatus => ({
      ...perSlotAllFree,
      available_slots: (s1 ? 0 : 1) + 1, // slot-2 free + slot-1 free
      total_slots: 4,
      slots: [
        { slot_id: 'slot-1', is_processing: s1 },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: true },
        { slot_id: 'slot-4', is_processing: true },
      ],
    });
    fetcher.mockResolvedValueOnce(jsonResponseFixture(fourSlots(true)));
    vi.setSystemTime(start + 10_000);
    await worker.tick(); // slot-1 processing → its own timer resets

    fetcher.mockResolvedValueOnce(jsonResponseFixture(fourSlots(false)));
    vi.setSystemTime(start + 20_000);
    await worker.tick(); // slot-1 free again → restarts its run

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(false); // only slot-2 has a full continuous run

    vi.setSystemTime(start + 20_000 + cfg.thresholdMs);
    const after = await worker.tick();
    expect(after.dispatched).toBe(true); // slot-1 completed its fresh run
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('a global busy poll resets ALL per-slot timers (fresh full idle period required)', async () => {
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // all free → timers start

    fetcher.mockResolvedValueOnce(jsonResponseFixture({ ...perSlotAllFree, active_query: true }));
    vi.setSystemTime(start + 10_000);
    await worker.tick(); // global busy → every slot timer reset

    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + 20_000);
    await worker.tick(); // free again → timers restart at +20s

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(false); // no slot has a full run since +20s

    vi.setSystemTime(start + 20_000 + cfg.thresholdMs);
    const after = await worker.tick();
    expect(after.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('an ambiguous poll (null status) resets ALL per-slot timers (fail-closed)', async () => {
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // all free → timers start

    fetcher.mockResolvedValueOnce(jsonResponseFixture(null));
    vi.setSystemTime(start + 10_000);
    await worker.tick(); // ambiguous → busy → every slot timer reset

    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + 20_000);
    await worker.tick(); // free again → timers restart at +20s

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(false);

    vi.setSystemTime(start + 20_000 + cfg.thresholdMs);
    const after = await worker.tick();
    expect(after.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('without per-slot data and 0 < N < total, falls back to all-slots-free (never any N slots)', async () => {
    // No slots array: evaluateIdle degrades to all-slots-free, so 2 of 4
    // free is BUSY even though N=2 — the worker never dispatches on
    // any-N availability without per-slot identity.
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({
      requiredFreeSlots: 2,
      status: { ...idleAllSlotsFree, available_slots: 2 },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    const first = await worker.tick();
    expect(first.idle).toBe(false); // 2 of 4 free without identity → busy

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalled(); // still polling — never any-N dispatch
  });

  it('with per-slot data but N=0, falls back to all-slots-free (per-slot mode only when 0 < N < total)', async () => {
    // Slots are present but N=0 (all slots): per-slot mode is NOT active —
    // all-slots-free applies, so 2 of 4 free is busy and never dispatches.
    const { worker, deps, cfg } = makePerSlotWorker({
      requiredFreeSlots: 0,
      status: perSlotTwoFree,
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    const first = await worker.tick();
    expect(first.idle).toBe(false);

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });
});
