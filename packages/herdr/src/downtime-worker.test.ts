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
 *
 * Critical-first tier tests (WL-0MT3I9QJU002S34W, parent
 * WL-0MT3FM8VA005XBHE): test-first matrix for the critical-first pre-tier —
 * an open critical item at ANY stage (idea/intake_complete/plan_complete)
 * wins over every non-critical candidate. Pins the F2/F3/F4 contract:
 * parseCriticalCandidatesOutput / selectCriticalCandidate / criticalSkillKind
 * (critical lookup & selection), resolveDependencyFrontier (dependency
 * frontier, Q3), the getNextCriticalCandidate dep, and the tier order
 * (scheduled-prompts → audit → critical → implement → plan → intake) with
 * freeze split-by-skill (Q1) and cap retention (Q2). Red phase: the new
 * exports do not exist yet — the new tests fail and the existing suite
 * stays green (zero regression) until the implementation slices land
 * (WL-0MT3I9UVU004722X, WL-0MT3I9YNZ007IC5V, WL-0MT3IA1UB005TLVJ).
 *
 * Single-active-audit tests (WL-0MT47BMR7003ZQ66, parent
 * WL-0MT3PHW4I002SNOV): test-first matrix for the audit-tier single-flight
 * guard — audits stay strictly sequential across idle periods (never
 * fan-out). Pins the getActiveAudit dep contract ({ok:true, active:boolean}
 * | {ok:false}), the audit-in-flight tier skip with implement fall-through,
 * the 2h stale-window expiry (recentAuditDispatchedItemIds coverage in
 * downtime-log.test.ts), fail-open on check failure, the 'audit-in-flight'
 * outcome reason (never 'no-candidate'), and the guard composition with
 * code-freeze + free-slot minimums. Red phase: the new exports do not
 * exist yet — the new tests fail and the existing suite stays green (zero
 * regression) until the implementation slice lands (WL-0MT47BQAT00375VB).
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  parseCriticalCandidatesOutput,
  parseDepListBlockersOutput,
  parseShownWorkItem,
  selectCriticalCandidate,
  criticalSkillKind,
  resolveDependencyFrontier,
  parseAuditCandidatesOutput,
  parseInProgressOutput,
  selectAuditCandidate,
  selectWithRotation,
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
  DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS,
  type LlamaStatus,
  type LlamaSlot,
  type LlamaStatusFetcher,
  type DowntimeCandidate,
  type DowntimeWorkerDeps,
  type DowntimeSpawn,
  type DowntimeStage,
  type AuditCandidate,
  type ImplementCandidate,
  type ScheduledPrompt,
  type DowntimeActiveAuditResult,
} from './downtime-worker.js';
import {
  DOWNTIME_DISABLE_MARKER_FILE,
  disableMarkerPath,
  writeDisableMarker,
} from './downtime-disable-marker.js';
import { createRoundRobinRegistry } from './downtime-round-robin.js';
import {
  statusFixtures,
  ambiguousMissingFieldsRaw,
  idleAllSlotsFree,
  perSlotAllFree,
  perSlotTwoFree,
  perSlotOneProcessing,
  perSlotThreeOfFourFree,
  perSlotOneOfThreeFree,
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
    // Active-audit single-flight (WL-0MT3PHW4I002SNOV): no active audit by
    // default ({ok:true, active:false}), so the existing tier tests exercise
    // the unchanged audit tier (backward-compatible default — the audit
    // tier proceeds). The dispatcher consults this dep only after F2 lands;
    // existing tests are unaffected either way.
    getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
    // Scheduled-prompts tier (WL-0MSS1Q5ER007QDKX): no due prompt by
    // default, so existing tier tests exercise the unchanged backlog tiers.
    getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
    recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
    // Critical-first tier (WL-0MT3FM8VA005XBHE): no critical candidate by
    // default, so the existing tier tests exercise the unchanged backlog
    // tiers (regression guard — after F4 the critical tier must fall
    // through to implement → plan → intake when the critical tier is
    // genuinely empty).
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
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
  const thresholdMs = DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS;

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
    tracker.record(true, start + DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
    tracker.record(true, start + 2 * DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
    expect(tracker.idleSince).toBe(start);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs - 1_000)).toBe(false);
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

// ── Scheduled-prompts tier (WL-0MSS1Q5ER007QDKX) ─────────────────────

describe('dispatch scheduled-prompts tier', () => {
  const duePrompt: ScheduledPrompt = {
    id: '/skill:refactor',
    prompt: '/skill:refactor',
    intervalDays: 3,
    lastTriggeredAt: null,
  };

  it('dispatches a due scheduled prompt FIRST (before audit/implement/plan/intake)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      // The backlog tiers must never be consulted — the prompt dispatches
      // instead of reaching them (AC6).
      getNextAuditCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-AUD', title: 'Audit me', stage: 'audit' },
      }),
      getNextImplementCandidate: vi.fn().mockResolvedValue({
        id: 'WL-IMP',
        title: 'Implement me',
        status: 'open',
        risk: 'low',
        effort: 'small',
      } as ImplementCandidate),
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getDueScheduledPrompt).toHaveBeenCalledWith('/repo');
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('scheduled');
    // The prompt text is the dispatch payload — not a skill+work-item wrap.
    expect(deps.spawnAgentPane).toHaveBeenCalledWith('/skill:refactor', {
      model: 'plan',
      cwd: '/repo',
      paneName: 'Downtime /skill:refactor',
    });
    // No pre-dispatch claim — there is no work item (AC4).
    expect(deps.claimItem).not.toHaveBeenCalled();
    // The backlog tiers are never reached (AC6).
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    expect(deps.getNextItem).not.toHaveBeenCalled();
  });

  it('persists lastTriggeredAt and writes the scheduled log marker before the spawn (AC4)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // The trigger timestamp is persisted (atomic config update) and the
    // rolling log marker is written with kind scheduled + noItemComment.
    expect(deps.recordScheduledPromptTrigger).toHaveBeenCalledWith(
      '/repo',
      '/skill:refactor',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: '/skill:refactor',
        kind: 'scheduled',
        cwd: '/repo',
        noItemComment: true,
      }),
    );
    // Marker + persist before spawn: the dispatch is recorded before the
    // pane opens (fail-closed: an unrecorded dispatch never runs).
    const persistOrder =
      (deps.recordScheduledPromptTrigger as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const markerOrder =
      (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const spawnOrder =
      (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(persistOrder).toBeLessThan(markerOrder);
    expect(markerOrder).toBeLessThan(spawnOrder);
  });

  it('falls through to the existing tiers when no prompt is due', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
      getNextAuditCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-AUD', title: 'Audit me', stage: 'audit' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getDueScheduledPrompt).toHaveBeenCalledWith('/repo');
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
  });

  it('skips the scheduled tier while frozen (frozen OR ambiguous are fail-closed, AC5)', async () => {
    for (const freezeStatus of ['frozen', 'ambiguous'] as const) {
      const deps = makeDeps({
        readCodeFreezeStatus: vi.fn().mockReturnValue(freezeStatus),
        getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
        getNextItem: vi.fn().mockResolvedValue({
          ok: true,
          candidate: { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete' },
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      // Scheduled prompts are held by the same freeze gate as audit/implement
      // (no new code changes during a release) — the tier is never consulted.
      expect(deps.getDueScheduledPrompt).not.toHaveBeenCalled();
      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(deps.spawnAgentPane).toHaveBeenCalledWith(
        expect.stringContaining('/skill:plan WL-PLAN'),
        expect.anything(),
      );
    }
  });

  it('a frozen+empty plan/intake backlog reports code-freeze even when a prompt is due (AC5)', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getDueScheduledPrompt).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('code-freeze');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('aborts before spawn when the lastTriggeredAt persist fails (fail-closed, AC4)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      recordScheduledPromptTrigger: vi.fn().mockResolvedValue(false),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('marker-write-failed');
    // No log record, no pane: an unrecorded dispatch never runs; the entry
    // stays due for the next idle slot.
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('aborts before spawn when the log marker cannot be written (fail-closed, AC4)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      recordDispatch: vi.fn().mockResolvedValue(false),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('marker-write-failed');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('records a spawn-failure trace and resolves spawn-failed when the pane fails (AC4)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'ENOENT' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('spawn-failed');
    expect(outcome.error).toBe('ENOENT');
    expect(deps.recordDispatchFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: '/skill:refactor',
        kind: 'scheduled',
        error: 'ENOENT',
        noItemComment: true,
      }),
    );
  });

  it('reports no-candidate (the cooldown trigger) when no prompt is due and the backlog is empty (AC6)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
  });

  it('buildDowntimePaneArgs honours an explicit paneName (Downtime <id> for scheduled prompts)', () => {
    const args = buildDowntimePaneArgs('plan', '/skill:refactor', {
      model: 'plan',
      cwd: '/repo',
      paneName: 'Downtime /skill:refactor',
    });
    expect(args).toEqual([
      '--pane-name',
      'Downtime /skill:refactor',
      '--no-focus',
      '--cwd',
      '/repo',
      '--model',
      'plan',
      '/skill:refactor',
    ]);
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

  it('risk ≤ Medium eligible (High/Critical excluded)', () => {
    const low = { ...open, id: 'WL-LOW', risk: 'low' as const };
    const medium = { ...open, id: 'WL-MED', risk: 'medium' as const };
    const high = { ...open, id: 'WL-HIGH-R', risk: 'high' as const };
    const critical = { ...open, id: 'WL-CRIT', risk: 'critical' as const };
    // medium is first eligible in input order (all share sortIndex 100)
    expect(selectImplementCandidate([medium, low, high, critical, open])?.id).toBe('WL-MED');
    expect(selectImplementCandidate([medium])?.id).toBe('WL-MED');
    expect(selectImplementCandidate([low])?.id).toBe('WL-LOW');
    expect(selectImplementCandidate([high])).toBeNull();
    expect(selectImplementCandidate([critical])).toBeNull();
  });

  it('effort ≤ Medium eligible (Large/Extra Large excluded)', () => {
    const xs = { ...open, id: 'WL-XS', effort: 'xs' as const };
    const small = { ...open, id: 'WL-S', effort: 'small' as const };
    const medium = { ...open, id: 'WL-MED-E', effort: 'medium' as const };
    const large = { ...open, id: 'WL-LARGE', effort: 'large' as const };
    const xl = { ...open, id: 'WL-XL', effort: 'xl' as const };
    // medium is first eligible in input order (all share sortIndex 100)
    expect(selectImplementCandidate([medium, large, xl, open])?.id).toBe('WL-MED-E');
    expect(selectImplementCandidate([xs])?.id).toBe('WL-XS');
    expect(selectImplementCandidate([small])?.id).toBe('WL-S');
    expect(selectImplementCandidate([medium])?.id).toBe('WL-MED-E');
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

  it('recognizes long-form effort spellings (Small / Medium / Extra Small)', () => {
    const small = { ...open, id: 'WL-S', effort: 'Small' as const };
    const medium = { ...open, id: 'WL-M', effort: 'Medium' as const };
    const extraSmall = { ...open, id: 'WL-ES', effort: 'Extra Small' as const };
    expect(selectImplementCandidate([small])?.id).toBe('WL-S');
    expect(selectImplementCandidate([medium])?.id).toBe('WL-M');
    expect(selectImplementCandidate([extraSmall])?.id).toBe('WL-ES');
  });

  it('handles verbose risk/effort descriptions (agent-produced fields)', () => {
    const verboseRisk = { ...open, id: 'WL-VERBOSE-RISK', risk: 'medium — NVIDIA driver changes can affect GPU functionality system-wide. Wrong driver version could worsen the problem. Mitigation: test in non-production context first if possible; have rollback plan.' };
    const verboseEffort = { ...open, id: 'WL-VERBOSE-EFFORT', effort: '1–4 hours (estimate: o=1, m=2, p=4) — Small. Diagnostic investigation + targeted fix on a single system. No code changes expected.' };
    // Verbose descriptions with em-dash should extract the leading keyword
    expect(selectImplementCandidate([verboseRisk])?.id).toBe('WL-VERBOSE-RISK');
    expect(selectImplementCandidate([verboseEffort])?.id).toBe('WL-VERBOSE-EFFORT');
    // High risk should still be excluded even with verbose description
    const highVerbose = { ...open, id: 'WL-HIGH-V', risk: 'high — something went wrong' };
    expect(selectImplementCandidate([highVerbose])).toBeNull();
  });

  it('regression: a critical item with verbose risk/effort fields wins over a medium item (WL-0MSN3FWV5008KQE9 dispatch)', () => {
    // Real-world regression: the downtime dispatcher skipped the critical NVIDIA
    // item because its risk/effort fields carry descriptions, selecting the
    // medium mode-switch item instead.
    const nvidia = {
      ...open,
      id: 'WL-0MT1KJNDK004SNPK',
      title: 'Fix NVIDIA kernel/userspace driver API mismatch (chrome-headless)',
      risk: 'Medium — NVIDIA driver changes can affect GPU functionality system-wide. Wrong driver version could worsen the problem. Mitigation: test in non-production context first if possible; have rollback plan.',
      effort: '1–4 hours (estimate: o=1, m=2, p=4) — Small. Diagnostic investigation + targeted fix on a single system. No code changes expected.',
      sortIndex: 900,
      priority: 'critical',
    };
    const modeSwitch = {
      ...open,
      id: 'WL-0MSN3FWV5008KQE9',
      title: 'Herdr plugin: activity-gated proxy mode switching',
      risk: 'Medium',
      effort: 'Small',
      sortIndex: 1600,
      priority: 'medium',
    };
    // Critical (sortIndex 900) must be selected ahead of medium (sortIndex 1600)
    expect(selectImplementCandidate([modeSwitch, nvidia])?.id).toBe('WL-0MT1KJNDK004SNPK');
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

  it('does not select an item whose updatedAt did not move (flag-only flip, WL-0MSN6ZCTN0027U2R)', () => {
    // The worklog core guarantees (packages/shared/src/database.ts update())
    // that flipping needsProducerReview does NOT bump updatedAt — so after
    // the flip the item still has its pre-audit updatedAt and the audit
    // remains fresh.  selectAuditCandidate must therefore not re-dispatch
    // a redundant /skill:audit for it.
    const afterFlagFlip: AuditCandidate = {
      id: 'FLAGFLIP',
      title: 'flagged for review',
      auditedAt: '2026-01-01T00:00:30.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', // unchanged by the flag flip
      sortIndex: 10,
    };
    expect(selectAuditCandidate([afterFlagFlip], NOW)).toBeNull();
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

describe('parseInProgressOutput (active-audit single-flight)', () => {
  it('parses bare workItems entries into their ids', () => {
    const stdout = JSON.stringify({ success: true, count: 2, workItems: [{ id: 'WL-A' }, { id: 'WL-B' }] });
    expect([...parseInProgressOutput(stdout)!]).toEqual(['WL-A', 'WL-B']);
  });

  it('also accepts the { workItem } wrapper shape inside workItems', () => {
    const stdout = JSON.stringify({ workItems: [{ workItem: { id: 'WL-A' } }, { workItem: { id: 'WL-B' } }] });
    expect([...parseInProgressOutput(stdout)!]).toEqual(['WL-A', 'WL-B']);
  });

  it('fails closed (null) on malformed JSON', () => {
    expect(parseInProgressOutput('not json')).toBeNull();
  });

  it('fails closed (null) on output without a list', () => {
    expect(parseInProgressOutput(JSON.stringify({ success: false }))).toBeNull();
  });

  it('skips entries without an id but keeps valid ones', () => {
    const stdout = JSON.stringify({ workItems: [{ title: 'no id' }, { id: 'WL-A' }] });
    expect([...parseInProgressOutput(stdout)!]).toEqual(['WL-A']);
  });

  it('returns an empty set for an empty workItems list', () => {
    expect([...parseInProgressOutput(JSON.stringify({ workItems: [] }))!]).toEqual([]);
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

  it('BLOCKED_QUESTIONS_INSTRUCTION includes the final-summary directive', () => {
    expect(BLOCKED_QUESTIONS_INSTRUCTION).toContain('repeat the questions in your final summary');
  });

  it('buildDowntimePrompt output includes the final-summary directive', () => {
    const prompt = buildDowntimePrompt('implement', candidate);
    expect(prompt).toContain('repeat the questions in your final summary');
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
    expect(clampDowntimeIdleThresholdMs(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS)).toBe(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    expect(clampDowntimeIdleThresholdMs(0)).toBe(1_000);
  });

  it('clampDowntimeRequiredFreeSlots maps negative/non-finite to the default N=2 and rounds', () => {
    // Spare-capacity default (parent WL-0MT32F90V008UAD2): negative/non-
    // finite input falls back to DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS (2)
    // — the out-of-the-box spare-capacity default, still fail-closed safe.
    expect(clampDowntimeRequiredFreeSlots(-3)).toBe(DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS);
    expect(clampDowntimeRequiredFreeSlots(Number.NaN)).toBe(DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS);
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
        thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
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

// ── Per-instance toggle override (parent WL-0MSZ4NSOE007AQEF) ─────────

describe('downtime worker per-instance override', () => {
  function makeWorker(
    override: boolean | null = null,
    globalEnabled: boolean = true,
  ) {
    const cfg = {
      enabled: globalEnabled,
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
    };
    const worker = createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000'),
      deps: makeDeps(),
      config: () => ({ ...cfg }),
      override,
    });
    return { worker, cfg };
  }

  it('defaults to null (follows global settings)', () => {
    const { worker } = makeWorker();
    expect(worker.override).toBe(null);
    expect(worker.enabled).toBe(true);
  });

  it('toggle() cycles null → false → null (no force-enable)', () => {
    const { worker } = makeWorker();
    // null → false (first press disables)
    expect(worker.override).toBe(null);
    worker.toggle();
    expect(worker.override).toBe(false);
    // false → null (second press returns to follow settings)
    worker.toggle();
    expect(worker.override).toBe(null);
  });

  it('two consecutive toggles return to follow-settings (null→false→null)', () => {
    const { worker, cfg } = makeWorker();
    // First press: disable
    worker.toggle();
    expect(worker.override).toBe(false);
    expect(worker.enabled).toBe(false);
    // Second press: back to follow settings
    worker.toggle();
    expect(worker.override).toBe(null);
    expect(worker.enabled).toBe(cfg.enabled); // follows global
  });

  it('three presses cycle null → false → null → false', () => {
    const { worker } = makeWorker();
    expect(worker.override).toBe(null);
    worker.toggle(); // → false
    expect(worker.override).toBe(false);
    worker.toggle(); // → null
    expect(worker.override).toBe(null);
    worker.toggle(); // → false again (not true)
    expect(worker.override).toBe(false);
  });

  it('tick() short-circuits after disable (override=false)', async () => {
    const { worker } = makeWorker();
    worker.toggle(); // → false
    const result = await worker.tick();
    expect(result).toEqual({ polled: false, dispatched: false, idle: false });
  });

  it('tick() follows global setting after second press (null → false → null)', async () => {
    vi.useFakeTimers();
    try {
      const { worker, cfg } = makeWorker(null, true);
      // First press: disable
      worker.toggle();
      expect(worker.override).toBe(false);
      let result = await worker.tick();
      expect(result).toEqual({ polled: false, dispatched: false, idle: false });

      // Second press: back to follow settings
      worker.toggle();
      expect(worker.override).toBe(null);
      result = await worker.tick();
      expect(result.idle).toBe(false); // normal behavior (global busy)
    } finally {
      vi.useRealTimers();
    }
  });

  it('enabled returns override ?? cfg.enabled (null)', () => {
    const { worker, cfg } = makeWorker();
    // null override → follows global
    expect(worker.enabled).toBe(true);
    cfg.enabled = false;
    expect(worker.enabled).toBe(false);
    cfg.enabled = true;
    // toggle: null → false
    worker.toggle();
    expect(worker.override).toBe(false);
    expect(worker.enabled).toBe(false);
    // toggle: false → null
    worker.toggle();
    expect(worker.override).toBe(null);
    expect(worker.enabled).toBe(cfg.enabled); // follows global
  });

  it('tick() short-circuits when override is false (even if global is true)', async () => {
    const { worker } = makeWorker(false, true);
    const result = await worker.tick();
    expect(result).toEqual({ polled: false, dispatched: false, idle: false });
  });

  it('tick() behaves normally when override is null (follows global)', async () => {
    vi.useFakeTimers();
    try {
      const { worker } = makeWorker(null, true);
      // Busy global → still busy
      const result = await worker.tick();
      expect(result.idle).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two workers with independent overrides toggle independently', () => {
    const { worker: w1 } = makeWorker();
    const { worker: w2 } = makeWorker();
    w1.toggle();
    expect(w1.override).toBe(false);
    expect(w2.override).toBe(null);
    expect(w1.enabled).toBe(false);
    expect(w2.enabled).toBe(true);
    w2.toggle(); // → false
    expect(w2.override).toBe(false);
    w2.toggle(); // → null
    expect(w2.override).toBe(null);
    expect(w2.enabled).toBe(true); // follows global
  });

  it('override forces dispatch on when global setting is false', () => {
    const { worker } = makeWorker(true, false);
    expect(worker.override).toBe(true);
    expect(worker.enabled).toBe(true); // override takes precedence
    expect(worker.tick).toBeDefined();
  });

  it('override set via config is respected (pre-toggled worker)', () => {
    const { worker } = makeWorker(false, true);
    expect(worker.override).toBe(false);
    expect(worker.enabled).toBe(false);
  });
});

// ── Persisted disable marker (WL-0MT5SFP990001FNW) ───────────────────

describe('persisted downtime disable marker (.herdr-downtime-disabled)', () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'herdr-dt-marker-'));
    cwd = join(root, 'worklog-root');
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function markerPath(): string {
    return join(cwd, DOWNTIME_DISABLE_MARKER_FILE);
  }

  function makeWorkerWithCwd(
    extra: Partial<Parameters<typeof createDowntimeWorker>[0]> = {},
  ) {
    const cfg = {
      enabled: true,
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd,
      noCandidateCooldownMs: DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
    };
    const merged = {
      poller: createDowntimePoller('http://proxy:8000'),
      deps: makeDeps(),
      config: () => ({ ...cfg }),
      ...extra,
    };
    const worker = createDowntimeWorker(merged);
    return { worker, cfg };
  }

  it('creates the marker file when toggle() disables (AC1)', () => {
    const { worker } = makeWorkerWithCwd();
    expect(existsSync(markerPath())).toBe(false);
    worker.toggle(); // disable
    expect(worker.override).toBe(false);
    expect(existsSync(markerPath())).toBe(true);
  });

  it('does not rewrite an existing marker (no write when already present, AC1)', () => {
    writeFileSync(markerPath(), 'existing', 'utf8');
    // Direct helper-level check (a worker constructed with a marker present
    // restores override=false, so toggle() would remove it — the no-rewrite
    // guarantee of AC1 belongs to the write helper itself).
    writeDisableMarker(cwd);
    expect(readFileSync(markerPath(), 'utf8')).toBe('existing');
  });

  it('removes the marker when toggle() returns to follow-settings (AC2)', () => {
    const { worker } = makeWorkerWithCwd();
    worker.toggle(); // → false, marker written
    expect(existsSync(markerPath())).toBe(true);
    worker.toggle(); // → null, marker removed
    expect(worker.override).toBe(null);
    expect(existsSync(markerPath())).toBe(false);
  });

  it('removing an absent marker is a no-op (AC2)', () => {
    const { worker } = makeWorkerWithCwd({ override: false });
    worker.toggle(); // → null → remove absent marker
    expect(worker.override).toBe(null);
    expect(existsSync(markerPath())).toBe(false);
  });

  it('restores override=false at init when the marker exists (AC3)', () => {
    writeFileSync(markerPath(), '', 'utf8');
    const { worker } = makeWorkerWithCwd();
    expect(worker.override).toBe(false);
    expect(worker.enabled).toBe(false);
  });

  it('explicit opts.override wins over the marker (AC3)', () => {
    writeFileSync(markerPath(), '', 'utf8');
    const { worker } = makeWorkerWithCwd({ override: true });
    expect(worker.override).toBe(true);
    expect(worker.enabled).toBe(true);
  });

  it('with no marker, override starts null and follows settings (AC4)', () => {
    const { worker } = makeWorkerWithCwd();
    expect(worker.override).toBe(null);
    expect(worker.enabled).toBe(true);
  });

  it('the marker is scoped to the worklog root (AC5)', () => {
    const otherRoot = join(root, 'other-root');
    mkdirSync(otherRoot, { recursive: true });
    writeFileSync(markerPath(), '', 'utf8'); // marker in cwd only
    const { worker: a } = makeWorkerWithCwd();
    const cfgB = {
      enabled: true,
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: otherRoot,
      noCandidateCooldownMs: DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
    };
    const b = createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000'),
      deps: makeDeps(),
      config: () => ({ ...cfgB }),
    });
    expect(a.override).toBe(false);
    expect(b.override).toBe(null);
    expect(b.enabled).toBe(true);
  });

  it('marker-restored disable yields zero dispatch across idle + cooldown windows (AC1/AC6)', async () => {
    writeFileSync(markerPath(), '', 'utf8');
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
    });
    const worker = createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000'),
      deps,
      config: () => ({
        enabled: true,
        thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd,
        noCandidateCooldownMs: DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
      }),
    });
    expect(worker.override).toBe(false); // restored from marker
    vi.useFakeTimers();
    try {
      // Advance well past the idle threshold and the no-candidate cooldown:
      // a disabled worker must short-circuit on EVERY tick (zero polls,
      // zero dispatch, zero pane spawns) regardless of elapsed time.
      vi.setSystemTime(Date.now() + DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS + 60_000);
      const r1 = await worker.tick();
      expect(r1).toEqual({ polled: false, dispatched: false, idle: false });
      const r2 = await worker.tick();
      expect(r2).toEqual({ polled: false, dispatched: false, idle: false });
      expect(deps.getNextItem).not.toHaveBeenCalled();
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
      thresholdMs: overrides.thresholdMs ?? DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
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
    vi.setSystemTime(start + cfg.thresholdMs + DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
    const next = await worker.tick();
    expect(next.dispatched).toBe(false);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(worker.idleSince).toBe(start + cfg.thresholdMs + DEFAULT_DOWNTIME_POLL_INTERVAL_MS);

    vi.setSystemTime(start + cfg.thresholdMs + DEFAULT_DOWNTIME_POLL_INTERVAL_MS + cfg.thresholdMs);
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
    vi.setSystemTime(start + cfg.thresholdMs + DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

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
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS); // threshold met → dispatch attempt

    const result = await worker.tick();

    expect(result.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(worker.paused).toBe(true);
  });

  it('dispatches a due scheduled prompt instead of entering the no-candidate cooldown (AC6)', async () => {
    // Scheduled tier first (WL-0MSS1Q5ER007QDKX): even with a genuinely
    // empty backlog behind it, a DUE prompt dispatches — it never reaches
    // the backlog tiers, so it never triggers the no-candidate cooldown.
    const { worker, deps } = makeEmptyBacklogWorker({
      deps: {
        getDueScheduledPrompt: vi.fn().mockResolvedValue({
          id: '/skill:refactor',
          prompt: '/skill:refactor',
          intervalDays: 3,
          lastTriggeredAt: null,
        }),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // idle run starts
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS); // threshold met → dispatch attempt

    const result = await worker.tick();

    expect(result.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      '/skill:refactor',
      expect.objectContaining({ paneName: 'Downtime /skill:refactor' }),
    );
    expect(worker.paused).toBe(false); // a dispatch — not the empty-backlog pause
    expect(worker.errorStrikes).toBe(0);
  });

  it('performs no proxy polling, no idle tracking and no dispatch while paused', async () => {
    const { worker, deps, fetcher } = makeEmptyBacklogWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick(); // enters cooldown
    expect(worker.paused).toBe(true);

    const pollsBefore = fetcher.mock.calls.length;
    const idleBefore = worker.idleSince;
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 60_000); // still within the pause
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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick(); // empty backlog → cooldown
    expect(worker.paused).toBe(true);

    // The project's backlog fills back up while the worker is paused.
    backlogEmpty = false;
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000); // pause expires
    const resumed = await worker.tick();
    expect(resumed.polled).toBe(true);
    expect(resumed.dispatched).toBe(false); // fresh idle run — no stale credit
    expect(worker.paused).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    // A full new idle period must elapse before the next dispatch.
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick(); // enters cooldown with 3_600_000 (expires at 4_840_000)
    expect(worker.paused).toBe(true);

    // Operator lowers the cooldown live; the in-progress pause keeps its
    // original expiry, but the NEXT cooldown entry uses the new value.
    cfg.noCandidateCooldownMs = 60_000;
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000); // original pause expires
    await worker.tick(); // resumes, starts a fresh idle run

    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS); // fresh threshold met
    await worker.tick(); // empty backlog again → 60s cooldown (new value)
    expect(worker.paused).toBe(true);

    // With the NEW 60s value the pause expires long before the old 60-min
    // default would have: at +61s the worker has resumed polling.
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 61_000);
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
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS); // threshold met

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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    await worker.tick(); // strike 1
    await worker.tick(); // strike 2
    await worker.tick(); // strike 3 → paused
    expect(worker.paused).toBe(true);

    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000); // pause expires
    const resumed = await worker.tick();
    expect(resumed.polled).toBe(true);
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(0);

    // A fresh error is strike 1 again — not a strike 4.
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 3_600_000 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

    await worker.tick(); // strike 1
    expect(worker.errorStrikes).toBe(1);

    await worker.tick(); // successful dispatch → strikes reset
    expect(worker.errorStrikes).toBe(0);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    // A fresh full idle period is required after the dispatch (AC5) before
    // the next dispatch attempt.
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS); // fresh idle run starts
    await worker.tick();
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 480_000); // fresh threshold met
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
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);

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
    expect(tracker.thresholdMetCount(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS - 1)).toBe(0);
    expect(tracker.thresholdMetCount(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS)).toBe(2);
    expect(tracker.thresholdMetCount(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, start + 500_000)).toBe(2);
  });

  it('a reset slot needs a fresh full run before it counts toward the threshold again', () => {
    const tracker = createPerSlotIdleTracker();
    const start = 1_000_000;

    tracker.record([a, b], start);
    // a goes processing at +10s (own timer reset) and free again at +20s.
    tracker.record([{ slot_id: 'a', is_processing: true }, b], start + 10_000);
    tracker.record([a, b], start + 20_000);

    // Only b has a full continuous run at start+threshold+5s.
    expect(tracker.thresholdMetCount(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + 5_000)).toBe(1);
    // a completes its fresh run at start+20s+threshold → both count.
    expect(tracker.thresholdMetCount(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, start + 20_000 + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS)).toBe(2);
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

  it('per-slot mode still requires the relaxed global checks (server up + no model switch)', () => {
    // Spare-capacity relaxation (parent WL-0MT32F90V008UAD2 AC2): in per-slot
    // mode ONLY llama_server_running and model_switch_in_progress remain
    // global gates — query/lease signals are superseded by per-slot
    // is_processing (a busy slot's query/lease is the operator's own session).
    expect(evaluateIdle({ ...twoFree, active_query: true }, 2)).toBe(true); // relaxed: query does NOT block
    expect(evaluateIdle({ ...twoFree, local_active_query: true }, 2)).toBe(true); // relaxed
    expect(evaluateIdle({ ...twoFree, local_lease_active: true }, 2)).toBe(true); // relaxed: lease does NOT block
    expect(evaluateIdle({ ...twoFree, model_switch_in_progress: true }, 2)).toBe(false); // still global
    expect(evaluateIdle({ ...twoFree, llama_server_running: false }, 2)).toBe(false); // still global
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

// ── Spare-capacity dispatch (parent WL-0MT32F90V008UAD2, F1) ──────────
// Tests for the spare-capacity dispatch feature: relaxed global gate in
// per-slot mode (local_active_query / local_lease_active do NOT block),
// the new DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS = 2, per-tier free-slot
// minimums at dispatch selection, and unchanged pre-fix proxy degradation.

/** Per-slot status: 3 of 4 slots free (slot-1 busy), with global query/lease
 * signals active — exactly the "operator session" pattern the spare-capacity
 * dispatch must handle. */
function perSlotThreeOfFourFreeActiveQuery(): LlamaStatus {
  return {
    llama_server_running: true,
    active_query: true,
    model_switch_in_progress: false,
    local_lease_active: true,
    available_slots: 3,
    total_slots: 4,
    slots: [
      { slot_id: 'slot-1', is_processing: true },
      { slot_id: 'slot-2', is_processing: false },
      { slot_id: 'slot-3', is_processing: false },
      { slot_id: 'slot-4', is_processing: false },
    ],
  };
}

describe('spare-capacity dispatch: relaxed global idle gate (per-slot mode)', () => {
  it('per-slot mode: a mid-query (active_query) busy slot does NOT block dispatch into free slots (AC1)', () => {
    // 3 of 4 slots free with active_query=true, local_active_query=true,
    // local_lease_active=true. In the relaxed global gate (AC1), these
    // per-slot query/lease signals are superseded by per-slot is_processing.
    // Only llama_server_running and model_switch_in_progress stay global.
    const status = perSlotThreeOfFourFreeActiveQuery();
    // The new relaxed check: active_query/local_active_query/local_lease
    // are NOT blocking in per-slot mode — 3 free >= N=2.
    expect(evaluateIdle(status, 2)).toBe(true); // spare capacity: 3 >= 2 free
  });

  it('per-slot mode: local_lease_active on a busy slot does NOT block dispatch (AC1)', () => {
    const status: LlamaStatus = {
      llama_server_running: true,
      active_query: false,
      model_switch_in_progress: false,
      local_lease_active: true,
      available_slots: 3,
      total_slots: 4,
      slots: [
        { slot_id: 'slot-1', is_processing: true },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: false },
        { slot_id: 'slot-4', is_processing: false },
      ],
    };
    // local_lease_active is per-slot; in per-slot mode it does NOT block.
    expect(evaluateIdle(status, 2)).toBe(true); // 3 free >= 2
  });

  it('per-slot mode: local_active_query on a busy slot does NOT block dispatch (AC2)', () => {
    const status: LlamaStatus = {
      llama_server_running: true,
      active_query: true,
      model_switch_in_progress: false,
      local_active_query: true,
      local_lease_active: false,
      available_slots: 2,
      total_slots: 3,
      slots: [
        { slot_id: 'slot-1', is_processing: true },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: false },
      ],
    };
    // 2 of 3 free with a mid-query busy slot — per-slot mode should fire.
    expect(evaluateIdle(status, 2)).toBe(true); // AC2: mid-query busy slot
  });

  it('per-slot mode: model_switch_in_progress still blocks dispatch (global gate)', () => {
    const status = perSlotThreeOfFourFreeActiveQuery();
    // model_switch_in_progress is ALWAYS global — even in per-slot mode.
    expect(evaluateIdle({ ...status, model_switch_in_progress: true }, 2)).toBe(false);
  });

  it('per-slot mode: llama_server_running=false still blocks dispatch (global gate)', () => {
    const status = perSlotThreeOfFourFreeActiveQuery();
    // server down is ALWAYS global — even in per-slot mode.
    expect(evaluateIdle({ ...status, llama_server_running: false }, 2)).toBe(false);
  });
});

describe('spare-capacity dispatch: DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS = 2 (AC1)', () => {
  it('DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS should be 2 for out-of-the-box spare-capacity', () => {
    // The new default: 2 of 3 slots must be free for dispatch.
    expect(DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS).toBe(2);
  });
});

describe('spare-capacity dispatch: pre-fix proxy degradation unchanged (AC4)', () => {
  it('pre-fix proxy (no per-slot data): a configured N (0<N<total) degrades to all-slots-free', () => {
    // Without per-slot identity, N=2 with 4 slots should still require ALL
    // slots free (fail-closed degradation, parent AC4).
    const status: LlamaStatus = {
      llama_server_running: true,
      active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 2,
      total_slots: 4,
    };
    // No slots array — all-slots-free path: 2 free < 4 required → busy.
    expect(evaluateIdle(status, 2)).toBe(false); // 2 < 4 → busy (all-slots-free)
    // Even when N equals total (4), 2 < 4 available → still busy.
    expect(evaluateIdle(status, 4)).toBe(false); // 2 < 4 → busy
    // Now with all slots free: 4 === 4 → idle.
    const allFree: LlamaStatus = {
      llama_server_running: true,
      active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 4,
      total_slots: 4,
    };
    expect(evaluateIdle(allFree, 2)).toBe(true); // 4 >= 4 (all-slots-free) → idle
  });

  it('pre-fix proxy with N=0 (default): all-slots-free behavior unchanged', () => {
    const status: LlamaStatus = {
      llama_server_running: true,
      active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 2,
      total_slots: 4,
    };
    // N=0 requires all slots free regardless of per-slot mode.
    expect(evaluateIdle(status, 0)).toBe(false); // 2 < 4 → busy
  });
});

describe('spare-capacity dispatch: ambiguous payloads are busy (AC5)', () => {
  it('missing slot_id fields are treated as busy (fail-closed)', () => {
    const malformed: LlamaStatus = {
      llama_server_running: true,
      active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 3,
      total_slots: 4,
      slots: [
        { slot_id: 'slot-1', is_processing: true },
        { slot_id: 'slot-2', is_processing: false },
      ],
    };
    // The slots array has only 2 entries for 4 total — this is ambiguous.
    // With per-slot mode active (0 < N < total), the free count is 1 < 2.
    expect(evaluateIdle(malformed, 2)).toBe(false);
  });

  it('total_slots 0 is always busy', () => {
    const status: LlamaStatus = {
      llama_server_running: true,
      active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 0,
      total_slots: 0,
    };
    expect(evaluateIdle(status, 2)).toBe(false);
  });

  it('N > total can never be idle', () => {
    const status: LlamaStatus = {
      llama_server_running: true,
      active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 3,
      total_slots: 3,
      slots: [
        { slot_id: 'slot-1', is_processing: false },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: false },
      ],
    };
    // 3 free < 4 required — never idle.
    expect(evaluateIdle(status, 4)).toBe(false);
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
      thresholdMs: overrides.thresholdMs ?? DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
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
    // idleSince is null because slots 3,4 are processing — the title bar
    // must show "busy", not "idle". Dispatch is unaffected (perSlotTracker
    // still counts the 2 free slots for spare-capacity dispatch).
    expect(worker.idleSince).toBeNull();

    vi.setSystemTime(start + cfg.thresholdMs - 1);
    const before = await worker.tick();
    expect(before.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('AC1 spare-capacity: 3 slots/1 busy with the operator session active (query+lease) still dispatches into the 2 free slots', async () => {
    // parent ACL1: 2 of 3 slots continuously free for the full threshold →
    // dispatch fires even though 1 slot is occupied by an active
    // (query + lease) session — exactly the operator working in the TUI
    // while the downtime worker uses the spare capacity.
    const operatorSessionPayload = {
      llama_server_running: true,
      active_query: true,
      local_active_query: true,
      model_switch_in_progress: false,
      local_lease_active: true,
      available_slots: 2,
      total_slots: 3,
      slots: [
        { slot_id: 'slot-1', is_processing: true },
        { slot_id: 'slot-2', is_processing: false },
        { slot_id: 'slot-3', is_processing: false },
      ],
    };
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({
      requiredFreeSlots: 2,
      status: operatorSessionPayload,
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // 2 free → per-slot idle run starts
    // idleSince is null because slot-1 is processing — title bar shows
    // "busy" even though dispatch fires into free slots.
    expect(worker.idleSince).toBeNull();

    vi.setSystemTime(start + cfg.thresholdMs - 1);
    const before = await worker.tick();
    expect(before.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true); // dispatch into the 2 free slots
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalled();
  });

  it('AC2 spare-capacity: a mid-query (processing) busy slot does NOT reset the free slots\' timers', async () => {
    // parent AC2: with N free of total in per-slot mode, idle is evaluated
    // from the free slots only. A processing slot 1 does not reset slot-2 /
    // slot-3 timers — dispatch still fires once the free slots have been
    // continuously free for the full threshold (the busy slot is the
    // operator's own mid-query session).
    const { worker, deps, cfg, fetcher } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // perSlotTwoFree (slot-1, slot-2 free) → timers start

    // slot-1 goes mid-query while slot-2 stays free; the global query signal
    // also fires. Spare-capacity relaxation: only slot-1's timer resets.
    fetcher.mockResolvedValueOnce(jsonResponseFixture({ ...perSlotTwoFree, active_query: true }));
    vi.setSystemTime(start + cfg.thresholdMs - 10_000);
    const mid = await worker.tick();
    expect(mid.idle).toBe(true); // free count still ≥ N=2 (slot-1 busy)

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true); // slot-2 ran the full threshold
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('AC3 tier minimums flow from the poll: 1 free slot skips the audit tier, plan dispatches (worker end-to-end)', async () => {
    // N=1 with a single free slot: the idle gate is satisfied (1 ≥ N), but
    // the AUDIT tier needs ≥2 free slots (parent WL-0MT32F90V008UAD2 AC3) —
    // the worker must pass the polled free count into the tier selection so
    // the audit candidate is skipped and the plan pane dispatches instead.
    const oneFreePayload = {
      llama_server_running: true,
      active_query: true,
      model_switch_in_progress: false,
      local_lease_active: true,
      available_slots: 1,
      total_slots: 3,
      slots: [
        { slot_id: 'slot-1', is_processing: true },
        { slot_id: 'slot-2', is_processing: true },
        { slot_id: 'slot-3', is_processing: false },
      ],
    };
    const { worker, deps, cfg } = makePerSlotWorker({
      requiredFreeSlots: 1,
      status: oneFreePayload,
      deps: {
        getNextAuditCandidate: vi.fn().mockResolvedValue({
          ok: true,
          candidate: { id: 'WL-AUD', title: 'Audit me', stage: 'audit' },
        }),
        getNextItem: vi.fn().mockResolvedValue({
          ok: true,
          candidate: { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete', status: 'open' },
        }),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // 1 free slot ≥ N=1 → per-slot idle run starts
    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();

    // The worker saw freeSlots=1: the audit candidate was never consulted
    // and the plan pane dispatched.
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(at.dispatched).toBe(true);
    expect((deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('/skill:plan WL-PLAN');
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

    // model_switch_in_progress is a GLOBAL gate in per-slot mode (spare-
    // capacity relaxation, parent WL-0MT32F90V008UAD2 AC2) — it resets
    // every slot timer. A per-slot query/lease (active_query) is NOT global
    // anymore and is covered by the dedicated spare-capacity tests.
    fetcher.mockResolvedValueOnce(jsonResponseFixture({ ...perSlotAllFree, model_switch_in_progress: true }));
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

  // ── Title bar idle display (parent WL-0MT65T14L002HTWB) ────────────
  // The global idle tracker (`worker.idleSince`) drives the title bar
  // `[⏳ downtime idle Xs]` indicator. In per-slot mode the relaxed
  // per-slot global gate deliberately ignores query/busy signals for
  // DISPATCH; the DISPLAY must still reflect actual per-slot activity.
  // idleSince (the display signal) is null whenever ANY slot is
  // processing — the title bar shows `[downtime busy]` — while dispatch
  // into free slots is unaffected.

  it('display: title bar shows busy when ANY slot is processing (incl. the operator\'s)', async () => {
    // perSlotTwoFree: slots 3,4 processing. The title-bar display must show
    // "busy" (idleSince null) even though the per-slot dispatch gate (2
    // free slots) is satisfied.
    const { worker, cfg } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince).toBeNull(); // → `[downtime busy]` in the title bar

    // Even after the dispatch threshold elapses, the display stays busy
    // while a slot is processing (dispatch itself fires per usual).
    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true); // dispatch still fires (spare capacity)
    expect(worker.idleSince).toBeNull(); // display never flips to idle mid-query
  });

  it('display: title bar shows idle ONLY when every slot is free', async () => {
    // perSlotAllFree: all 4 slots free — no active processing anywhere, so
    // the display can honestly show the idle counter.
    const { worker, fetcher, cfg } = makePerSlotWorker({
      requiredFreeSlots: 2,
      status: perSlotAllFree,
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince).toBe(start); // → `[⏳ downtime idle 0:00]`

    // Keep the status for the second tick (default is perSlotTwoFree which
    // has processing slots). Check BELOW the dispatch threshold so the tick
    // does not dispatch (which would reset idleSince by design).
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + cfg.thresholdMs - 10_000);
    await worker.tick();
    expect(worker.idleSince).toBe(start); // run start stays fixed while free
  });

  it('display: a slot starting processing resets the idle counter; freeing it restarts a fresh run', async () => {
    // Demonstrates that the display (idleSince) tracks actual per-slot
    // processing state — completely independent of dispatch logic.
    const { worker, fetcher, cfg } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // perSlotTwoFree: slots 3,4 processing → display busy
    expect(worker.idleSince).toBeNull();

    // All slots free → the idle counter starts.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + 10_000);
    await worker.tick();
    expect(worker.idleSince).toBe(start + 10_000); // → `[⏳ downtime idle 0:00]`

    // slot-1 goes processing → display flips back to busy.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotOneProcessing));
    vi.setSystemTime(start + 20_000);
    await worker.tick();
    expect(worker.idleSince).toBeNull(); // → `[downtime busy]`

    // Free slots (3) ≥ N=2 and their timers (since +10s) exceed threshold.
    // Dispatch fires into the 3 free slots while display shows busy.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotOneProcessing));
    vi.setSystemTime(start + 20_000 + cfg.thresholdMs);
    const at = await worker.tick();
    expect(worker.idleSince).toBeNull(); // display stays busy (slot still processing)
    expect(at.dispatched).toBe(true); // dispatch fires (3 ≥ 2 free)
  });

  it('display: transition back to all-free after processing restarts the idle counter', async () => {
    // After a busy period, the display should start counting again once
    // all slots are free.
    const { worker, fetcher } = makePerSlotWorker({ requiredFreeSlots: 2 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // perSlotTwoFree: slots 3,4 processing → busy
    expect(worker.idleSince).toBeNull();

    // All slots free → idle counter starts at current time.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + 10_000);
    await worker.tick();
    expect(worker.idleSince).toBe(start + 10_000);

    // slot-1 goes processing → display resets to busy.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotOneProcessing));
    vi.setSystemTime(start + 20_000);
    await worker.tick();
    expect(worker.idleSince).toBeNull();

    // All slots free again → display should now count from +20s.
    fetcher.mockResolvedValueOnce(jsonResponseFixture(perSlotAllFree));
    vi.setSystemTime(start + 30_000);
    await worker.tick();
    expect(worker.idleSince).toBe(start + 30_000); // fresh count from +30s
  });

  it('display: global busy (server down / model switch) also resets idleSince to busy', async () => {
    const { worker, fetcher } = makePerSlotWorker({
      requiredFreeSlots: 2,
      status: perSlotAllFree,
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince).toBe(start);

    // model_switch_in_progress is a GLOBAL gate — display shows busy.
    fetcher.mockResolvedValueOnce(
      jsonResponseFixture({ ...perSlotAllFree, model_switch_in_progress: true }),
    );
    vi.setSystemTime(start + 10_000);
    await worker.tick();
    expect(worker.idleSince).toBeNull(); // → `[downtime busy]`
  });
});

// ── Rotation-aware selection (WL-0MSSRED76008LGB6 / WL-0MSW6CKBY007RB7O) ──

describe('selectWithRotation (round-robin tie-break)', () => {
  const mk = (id: string, priority: string, sortIndex: number) => ({
    id, priority, sortIndex,
  });

  it('empty list → null', () => {
    expect(selectWithRotation([])).toBeNull();
  });

  it('single candidate → that candidate (no rotation)', () => {
    const c = mk('a', 'high', 1);
    expect(selectWithRotation([c])?.id).toBe('a');
  });

  it('no registry → first by sortIndex (fail-open pre-rotation behaviour)', () => {
    const items = [mk('a', 'high', 2), mk('b', 'high', 1)];
    expect(selectWithRotation(items)?.id).toBe('b'); // lowest sortIndex
  });

  it('candidates without priority → first by sortIndex (fail-open)', () => {
    const items = [{ id: 'x', sortIndex: 5 }, { id: 'y', sortIndex: 3 }];
    expect(selectWithRotation(items)?.id).toBe('y');
  });

  it('rotates through tied top-priority group, skipping lower priority', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-worker-rotation', rng: () => 0.5 });
    const items = [
      mk('low1', 'low', 10),
      mk('high1', 'high', 1),
      mk('high2', 'high', 2),
      mk('medium1', 'medium', 5),
    ];
    // Cursor starts at 0 → selects high1; advances to 1 → high2; then back to high1
    expect(selectWithRotation(items, registry)?.id).toBe('high1');
    expect(selectWithRotation(items, registry)?.id).toBe('high2');
    expect(selectWithRotation(items, registry)?.id).toBe('high1');
  });

  it('single-member top group → no rotation (higher priority still wins)', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-worker-single', rng: () => 0.5 });
    const items = [mk('crit1', 'critical', 1), mk('high1', 'high', 2), mk('high2', 'high', 3)];
    // critical group has 1 member → always crit1, regardless of cursor
    expect(selectWithRotation(items, registry)?.id).toBe('crit1');
    expect(selectWithRotation(items, registry)?.id).toBe('crit1');
  });

  it('priority-first preserved: lower-priority candidate never selected while higher tier has members', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-worker-priority', rng: () => 0.5 });
    const items = [
      mk('med1', 'medium', 10),
      mk('med2', 'medium', 11),
      mk('low1', 'low', 20),
    ];
    // Only medium group has members → rotation within medium only
    expect(selectWithRotation(items, registry)?.id).toBe('med1');
    expect(selectWithRotation(items, registry)?.id).toBe('med2');
    expect(selectWithRotation(items, registry)?.id).toBe('med1');
  });
});

describe('rotation-aware selection wired into tiers', () => {
  it('selectImplementCandidate rotates within tied priority when registry given', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-implement', rng: () => 0.5 });
    const candidates: ImplementCandidate[] = [
      { id: 'A', title: 'A', status: 'open', priority: 'high', sortIndex: 1, risk: 'low', effort: 'small' },
      { id: 'B', title: 'B', status: 'open', priority: 'high', sortIndex: 2, risk: 'low', effort: 'small' },
    ];
    expect(selectImplementCandidate(candidates, undefined, registry)?.id).toBe('A');
    expect(selectImplementCandidate(candidates, undefined, registry)?.id).toBe('B');
    expect(selectImplementCandidate(candidates, undefined, registry)?.id).toBe('A');
  });

  it('selectNextCandidate rotates within tied priority when registry given', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-next', rng: () => 0.5 });
    const candidates: DowntimeCandidate[] = [
      { id: 'X', title: 'X', stage: 'plan', status: 'open', priority: 'high', sortIndex: 1 },
      { id: 'Y', title: 'Y', stage: 'plan', status: 'open', priority: 'high', sortIndex: 2 },
    ];
    expect(selectNextCandidate(candidates, undefined, registry)?.id).toBe('X');
    expect(selectNextCandidate(candidates, undefined, registry)?.id).toBe('Y');
  });

  it('selectAuditCandidate rotates within tied priority when registry given', () => {
        const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-audit', rng: () => 0.5 });
    const now = Date.now();
    const candidates: AuditCandidate[] = [
      { id: 'P', title: 'P', priority: 'high', sortIndex: 1, updatedAt: new Date(now).toISOString() },
      { id: 'Q', title: 'Q', priority: 'high', sortIndex: 2, updatedAt: new Date(now).toISOString() },
    ];
    expect(selectAuditCandidate(candidates, now, undefined, registry)?.id).toBe('P');
    expect(selectAuditCandidate(candidates, now, undefined, registry)?.id).toBe('Q');
  });
});

// ── Probe jitter (WL-0MSSRED76008LGB6 / WL-0MSW6DEI9005XH8Q) ──────────

describe('worker probe jitter (jitterPollIntervalMs)', () => {
  it('returns jittered interval within ±50% when a registry is provided', () => {
    const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-jitter-deps', rng: () => 0.75 });
    const { worker } = (() => {
      const cfg = {
        enabled: true,
        thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: '/repo',
        noCandidateCooldownMs: 3_600_000,
      };
      const w = createDowntimeWorker({
        poller: createDowntimePoller('http://proxy:8000'),
        deps: makeDeps(),
        registry,
        config: () => ({ ...cfg }),
      });
      return { worker: w };
    })();
    // rng 0.75 → factor 1.25 → 10_000 * 1.25 = 12_500
    expect(worker.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS)).toBe(12_500);
  });

  it('returns the static interval when no registry is provided (fail-open)', () => {
    const { worker } = (() => {
      const cfg = {
        enabled: true,
        thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: '/repo',
        noCandidateCooldownMs: 3_600_000,
      };
      const w = createDowntimeWorker({
        poller: createDowntimePoller('http://proxy:8000'),
        deps: makeDeps(),
        config: () => ({ ...cfg }),
      });
      return { worker: w };
    })();
    expect(worker.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS)).toBe(10_000);
  });

  it('two workers with different RNG produce different jitter values', () => {
    const r1 = createRoundRobinRegistry({ worklogDir: '/tmp/rr-jitter-a', rng: () => 0.1 });
    const r2 = createRoundRobinRegistry({ worklogDir: '/tmp/rr-jitter-b', rng: () => 0.9 });
    const mk = (registry: typeof r1) => createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000'),
      deps: makeDeps(),
      registry,
      config: () => ({ enabled: true, thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS, requiredFreeSlots: 0, model: 'plan', cwd: '/repo', noCandidateCooldownMs: 3_600_000 }),
    });
    const w1 = mk(r1);
    const w2 = mk(r2);
    // rng 0.1 → 0.6× = 6_000; rng 0.9 → 1.4× = 14_000
    expect(w1.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS)).toBe(6_000);
    expect(w2.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS)).toBe(14_000);
    expect(w1.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS)).not.toBe(w2.jitterPollIntervalMs(DEFAULT_DOWNTIME_POLL_INTERVAL_MS));
  });
});

// ── Critical-first tier (parent WL-0MT3FM8VA005XBHE) ────────────────────
// Test-first matrix for the critical-first pre-tier: an open critical item
// at ANY stage (idea / intake_complete / plan_complete) is dispatched with
// its stage-appropriate skill ahead of every non-critical candidate. The
// F2/F3/F4 contract being pinned here (parseCriticalCandidatesOutput,
// selectCriticalCandidate, criticalSkillKind, resolveDependencyFrontier,
// the getNextCriticalCandidate dep, and the tier order) is RED until the
// implementation slices land (WL-0MT3I9UVU004722X, WL-0MT3I9YNZ007IC5V,
// WL-0MT3IA1UB005TLVJ) — the tests reference exports that do not exist yet
// and fail as a unit (the rest of this file stays green).

// ── Candidate shapes reused across the critical matrix ──────────────

/** Open critical worklog item at a dispatchable stage. */
function criticalIdea(
  id = 'WL-CRIT-I',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: `Critical idea ${id}`,
    status: 'open',
    stage: 'idea',
    priority: 'critical',
    sortIndex: 100,
    risk: 'low',
    effort: 'small',
    ...overrides,
  };
}

/** Open critical worklog item at intake_complete (plan-ready). */
function criticalReady(
  id = 'WL-CRIT-R',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: `Critical ready ${id}`,
    status: 'open',
    stage: 'intake_complete',
    priority: 'critical',
    sortIndex: 100,
    risk: 'low',
    effort: 'small',
    ...overrides,
  };
}

/** Open critical worklog item at plan_complete (implement-ready). */
function criticalPlanned(
  id = 'WL-CRIT-P',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: `Critical planned ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'critical',
    sortIndex: 100,
    risk: 'medium',
    effort: 'medium',
    ...overrides,
  };
}

// ── Critical-first: selection helpers (F2) ───────────────────────────

describe('critical selection (selectCriticalCandidate)', () => {
  it('selects a critical idea candidate (stage-appropriate intake)', () => {
    const selected = selectCriticalCandidate([criticalIdea()] as never);
    expect(selected?.id).toBe('WL-CRIT-I');
    expect(selected?.stage).toBe('idea');
    expect(criticalSkillKind(selected?.stage ?? '')).toBe('intake');
  });

  it('selects a critical intake_complete candidate (stage-appropriate plan)', () => {
    const selected = selectCriticalCandidate([criticalReady()] as never);
    expect(selected?.id).toBe('WL-CRIT-R');
    expect(selected?.stage).toBe('intake_complete');
    expect(criticalSkillKind(selected?.stage ?? '')).toBe('plan');
  });

  it('selects a critical plan_complete candidate within caps (stage-appropriate implement)', () => {
    const selected = selectCriticalCandidate([criticalPlanned()] as never);
    expect(selected?.id).toBe('WL-CRIT-P');
    expect(selected?.stage).toBe('plan_complete');
    expect(criticalSkillKind(selected?.stage ?? '')).toBe('implement');
  });

  it('stage→skill mapping is exact: idea→intake, intake_complete→plan, plan_complete→implement', () => {
    expect(criticalSkillKind('idea')).toBe('intake');
    expect(criticalSkillKind('intake_complete')).toBe('plan');
    expect(criticalSkillKind('plan_complete')).toBe('implement');
  });

  it('non-dispatchable stages map to null (in_progress / in_review are not targets)', () => {
    expect(criticalSkillKind('in_progress')).toBeNull();
    expect(criticalSkillKind('in_review')).toBeNull();
    expect(criticalSkillKind('completed')).toBeNull();
    expect(criticalSkillKind('')).toBeNull();
  });

  it('deterministic selection: lowest sortIndex wins across stages (sortIndex priority order)', () => {
    const candidates = [
      criticalReady('WL-CRIT-HIGH-IDX', { sortIndex: 900 }),
      criticalIdea('WL-CRIT-LOW-IDX', { sortIndex: 10 }),
      criticalPlanned('WL-CRIT-MID', { sortIndex: 500 }),
    ] as never;
    expect(selectCriticalCandidate(candidates)?.id).toBe('WL-CRIT-LOW-IDX');
  });

  it('plan_complete above the risk cap is NOT implement-selected (caps retained, Q2)', () => {
    const highRisk = criticalPlanned('WL-CRIT-HI-RISK', { risk: 'high' });
    expect(selectCriticalCandidate([highRisk] as never)).toBeNull();
  });

  it('plan_complete above the effort cap is NOT implement-selected (caps retained, Q2)', () => {
    const largeEffort = criticalPlanned('WL-CRIT-HI-EFFORT', { effort: 'large' });
    expect(selectCriticalCandidate([largeEffort] as never)).toBeNull();
  });

  it('a capped-out plan_complete critical does not shadow a within-cap critical sibling', () => {
    const candidates = [
      criticalPlanned('WL-CRIT-HI-RISK', { risk: 'high', sortIndex: 10 }),
      criticalReady('WL-CRIT-OK', { sortIndex: 900 }),
    ] as never;
    // The capped critical is excluded, so the next critical wins (even with
    // a higher sortIndex) — caps never multi-starve the critical tier.
    expect(selectCriticalCandidate(candidates)?.id).toBe('WL-CRIT-OK');
  });

  it('excludes non-open items (status=open client-side guard)', () => {
    const inProgress = criticalIdea('WL-CRIT-INPROG', { status: 'in_progress' });
    expect(selectCriticalCandidate([inProgress] as never)).toBeNull();
  });

  it('excludes candidates still at their dispatched-at stage (dispatched-marker change-guard)', () => {
    const dispatched = new Map([['WL-CRIT-I', 'idea']]);
    const other = criticalReady('WL-CRIT-OTHER');
    const selected = selectCriticalCandidate(
      [criticalIdea(), other] as never,
      dispatched,
    );
    // WL-CRIT-I was dispatched for /skill:intake at idea and is still at idea
    // → excluded; the next critical candidate is selected.
    expect(selected?.id).toBe('WL-CRIT-OTHER');
  });

  it('releases a candidate whose stage advanced past its dispatched-at stage', () => {
    const dispatched = new Map([['WL-CRIT-R', 'intake_complete']]);
    // Now at plan_complete (a different stage) → not suppressed.
    const advanced = criticalPlanned('WL-CRIT-R');
    expect(selectCriticalCandidate([advanced] as never, dispatched)?.id).toBe('WL-CRIT-R');
  });

  it('round-robins within the critical group when a registry is given (tie-break)', () => {
    const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-critical', rng: () => 0.5 });
    const candidates = [
      criticalIdea('WL-CRIT-A', { sortIndex: 1 }),
      criticalIdea('WL-CRIT-B', { sortIndex: 2 }),
    ] as never;
    expect(selectCriticalCandidate(candidates, undefined, registry)?.id).toBe('WL-CRIT-A');
    expect(selectCriticalCandidate(candidates, undefined, registry)?.id).toBe('WL-CRIT-B');
    expect(selectCriticalCandidate(candidates, undefined, registry)?.id).toBe('WL-CRIT-A');
  });

  it('critical rotation does not disturb the non-critical implement tier cursor', () => {
    const registry = createRoundRobinRegistry({ worklogDir: '/tmp/rr-critical-isolated', rng: () => 0.5 });
    const criticals = [
      criticalIdea('WL-CRIT-A', { sortIndex: 1 }),
      criticalIdea('WL-CRIT-B', { sortIndex: 2 }),
    ] as never;
    const implements_: ImplementCandidate[] = [
      { id: 'WL-IMP-A', title: 'A', status: 'open', priority: 'high', sortIndex: 1, risk: 'low', effort: 'small' },
      { id: 'WL-IMP-B', title: 'B', status: 'open', priority: 'high', sortIndex: 2, risk: 'low', effort: 'small' },
    ];
    // Rotate the critical group twice…
    selectCriticalCandidate(criticals, undefined, registry);
    selectCriticalCandidate(criticals, undefined, registry);
    // …the implement tier's own cursor is untouched: still starts at A.
    expect(selectImplementCandidate(implements_, undefined, registry)?.id).toBe('WL-IMP-A');
  });

  it('returns null on an empty list', () => {
    expect(selectCriticalCandidate([] as never)).toBeNull();
  });
});

describe('parseCriticalCandidatesOutput', () => {
  it('parses the wl list batch shape preserving status/stage/risk/effort/sortIndex/priority', () => {
    const candidates = parseCriticalCandidatesOutput(
      JSON.stringify({
        success: true,
        count: 2,
        workItems: [
          criticalIdea('WL-CRIT-I', { sortIndex: 7 }),
          criticalReady('WL-CRIT-R', { sortIndex: 3 }),
        ],
      }),
    );
    expect(candidates).toEqual([
      expect.objectContaining({ id: 'WL-CRIT-I', stage: 'idea', sortIndex: 7, priority: 'critical' }),
      expect.objectContaining({ id: 'WL-CRIT-R', stage: 'intake_complete', sortIndex: 3, priority: 'critical' }),
    ]);
  });

  it('malformed JSON yields null (fail-closed)', () => {
    expect(parseCriticalCandidatesOutput('not json')).toBeNull();
  });

  it('entries without an id are skipped; empty workItems yields []', () => {
    const candidates = parseCriticalCandidatesOutput(
      JSON.stringify({
        success: true,
        count: 0,
        workItems: [{ title: 'no id', stage: 'idea' }],
      }),
    );
    expect(candidates).toEqual([]);
  });
});

// ── Critical-first: dependency frontier (F3, decision Q3) ────────────

describe('resolveDependencyFrontier', () => {
  it('an unblocked critical candidate resolves to itself (no frontier redirect)', async () => {
    const candidate = criticalIdea('WL-CRIT-C');
    const result = await resolveDependencyFrontier(
      candidate as never,
      async () => [],
    );
    expect(result?.id).toBe('WL-CRIT-C');
  });

  it('dispatches the nearest OPEN blocker when the critical candidate is dependency-blocked', async () => {
    const blocker = criticalReady('WL-BLOCK');
    const candidate = criticalIdea('WL-CRIT-C');
    const result = await resolveDependencyFrontier(
      candidate as never,
      async (id) => (id === 'WL-CRIT-C' ? [blocker] : []),
    );
    expect(result?.id).toBe('WL-BLOCK');
    expect(result?.stage).toBe('intake_complete');
  });

  it('recurses through dependency-blocked blockers to the nearest open ancestor', async () => {
    const ancestor = criticalPlanned('WL-ANCESTOR');
    const midBlocker = criticalReady('WL-MID', { status: 'in_progress' });
    const candidate = criticalIdea('WL-CRIT-C');
    const result = await resolveDependencyFrontier(
      candidate as never,
      async (id) => {
        if (id === 'WL-CRIT-C') return [midBlocker];
        if (id === 'WL-MID') return [ancestor];
        return [];
      },
    );
    expect(result?.id).toBe('WL-ANCESTOR');
  });

  it('a chain bottoming in a closed blocker resolves to null (fall through to tiers)', async () => {
    const closed = criticalIdea('WL-CLOSED', { status: 'completed' });
    const candidate = criticalIdea('WL-CRIT-C');
    const result = await resolveDependencyFrontier(
      candidate as never,
      async (id) => (id === 'WL-CRIT-C' ? [closed] : []),
    );
    expect(result).toBeNull();
  });

  it('an in_progress/in_review frontier blocker resolves to null (non-dispatchable stage)', async () => {
    const busy = criticalReady('WL-BUSY', { status: 'in_progress' });
    const candidate = criticalIdea('WL-CRIT-C');
    const result = await resolveDependencyFrontier(
      candidate as never,
      async (id) => (id === 'WL-CRIT-C' ? [busy] : []),
    );
    expect(result).toBeNull();
  });

  it('tolerates cycles (bounded recursion, no infinite loop)', async () => {
    const a = criticalIdea('WL-A');
    const b = criticalReady('WL-B');
    const candidate = criticalIdea('WL-CRIT-C');
    const result = await resolveDependencyFrontier(
      candidate as never,
      async (id) => {
        if (id === 'WL-CRIT-C') return [a];
        if (id === 'WL-A') return [b];
        if (id === 'WL-B') return [a]; // cycle: A ↔ B
        return [];
      },
    );
    // Resolves without hanging; a cycle has no nearest open unblocked
    // ancestor, so the frontier yields null (fall through).
    expect(result).toBeNull();
  });

  it('a blocker above the implement caps is not a valid frontier (caps apply to blockers, Q2)', async () => {
    const capped = criticalPlanned('WL-CAPPED', { risk: 'high' });
    const candidate = criticalIdea('WL-CRIT-C');
    const result = await resolveDependencyFrontier(
      candidate as never,
      async (id) => (id === 'WL-CRIT-C' ? [capped] : []),
    );
    expect(result).toBeNull();
  });
});

describe('parseDepListBlockersOutput', () => {
  it('parses outbound depends-on edges as the blockers of the queried item', () => {
    const blockers = parseDepListBlockersOutput(
      JSON.stringify({
        success: true,
        item: 'WL-CRIT-C',
        inbound: [{ id: 'WL-DEPENDENT', title: 'Depends on me', status: 'open', direction: 'depended-on-by' }],
        outbound: [
          { id: 'WL-BLOCKER', title: 'Blocking item', status: 'open', priority: 'critical', direction: 'depends-on' },
        ],
      }),
    );
    expect(blockers).toEqual([
      { id: 'WL-BLOCKER', title: 'Blocking item', status: 'open', priority: 'critical' },
    ]);
  });

  it('ignores inbound depended-on-by edges (they are dependents, not blockers)', () => {
    const blockers = parseDepListBlockersOutput(
      JSON.stringify({
        success: true,
        item: 'WL-CRIT-C',
        inbound: [{ id: 'WL-DEPENDENT', title: 'Depends on me', status: 'open', direction: 'depended-on-by' }],
        outbound: [],
      }),
    );
    expect(blockers).toEqual([]);
  });

  it('malformed JSON or a missing outbound list yields null (fail-closed)', () => {
    expect(parseDepListBlockersOutput('not json')).toBeNull();
    expect(parseDepListBlockersOutput(JSON.stringify({ success: true, item: 'WL-CRIT-C' }))).toBeNull();
  });
});

describe('parseShownWorkItem', () => {
  it('parses the wl show single-item shape into a full critical candidate', () => {
    const item = parseShownWorkItem(
      JSON.stringify({
        success: true,
        workItem: {
          id: 'WL-BLOCKER',
          title: 'Blocking item',
          status: 'open',
          stage: 'plan_complete',
          risk: 'medium',
          effort: 'medium',
          sortIndex: 3,
          priority: 'critical',
        },
      }),
    );
    expect(item).toEqual({
      id: 'WL-BLOCKER',
      title: 'Blocking item',
      status: 'open',
      stage: 'plan_complete',
      risk: 'medium',
      effort: 'medium',
      sortIndex: 3,
      priority: 'critical',
    });
  });

  it('malformed output or a missing workItem yields null (fail-closed)', () => {
    expect(parseShownWorkItem('not json')).toBeNull();
    expect(parseShownWorkItem(JSON.stringify({ success: true }))).toBeNull();
  });
});

// ── Critical-first: tier wiring (F4, decisions Q1/Q2/Q3) ─────────────

describe('dispatch critical-first tier', () => {
  it('dispatches a critical idea candidate with /skill:intake ahead of ANY non-critical candidate', async () => {
    const deps = makeDeps({
      // Non-critical implement candidate exists and is the old winner —
      // the critical tier must win regardless.
      getNextImplementCandidate: vi.fn().mockResolvedValue({
        id: 'WL-IMP',
        title: 'Non-critical implement',
        stage: 'implement',
      } as DowntimeCandidate),
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalIdea('WL-CRIT-I'),
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('intake');
    expect(outcome.candidate?.id).toBe('WL-CRIT-I');
    expect(deps.getNextCriticalCandidate).toHaveBeenCalledWith('/repo');
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-I', { status: 'open', stage: 'idea' });
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:intake WL-CRIT-I'),
      { model: 'plan', cwd: '/repo' },
    );
  });

  it('dispatches a critical intake_complete candidate with /skill:plan ahead of the implement tier', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue({
        id: 'WL-IMP',
        title: 'Non-critical implement',
        stage: 'implement',
      } as DowntimeCandidate),
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalReady('WL-CRIT-R'),
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('WL-CRIT-R');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-R', { status: 'open', stage: 'intake_complete' });
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-CRIT-R'),
      expect.anything(),
    );
  });

  it('dispatches a critical plan_complete candidate within caps with /skill:implement first', async () => {
    const deps = makeDeps({
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalPlanned('WL-CRIT-P'),
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('WL-CRIT-P');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-P', { status: 'open', stage: 'plan_complete' });
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:implement WL-CRIT-P'),
      expect.anything(),
    );
  });

  it('critical-first tier runs AFTER the audit tier (audit keeps its slot)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-AUD', title: 'Audit me', stage: 'audit' },
      }),
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalIdea('WL-CRIT-I'),
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('audit');
    expect(deps.getNextCriticalCandidate).not.toHaveBeenCalled();
  });

  it('scheduled-prompts tier still runs FIRST (ahead of the critical tier)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue({
        id: '/skill:refactor',
        prompt: '/skill:refactor',
        intervalDays: 3,
        lastTriggeredAt: null,
      } as ScheduledPrompt),
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalIdea('WL-CRIT-I'),
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('scheduled');
    expect(deps.getNextCriticalCandidate).not.toHaveBeenCalled();
  });

  it('empty critical tier falls through to the non-critical tiers unchanged (regression)', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue({
        id: 'WL-IMP',
        title: 'Implement me',
        stage: 'implement',
      } as DowntimeCandidate),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('implement');
    expect(deps.getNextCriticalCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
  });

  it('a critical-tier wl failure fails closed to wl-error (never a silent fall-through)', async () => {
    const deps = makeDeps({
      getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: false }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('wl-error');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('during a code freeze critical implement dispatch PAUSES (fail-closed) while plan/intake tiers still run', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalPlanned('WL-CRIT-P'), // implement-ready, but frozen
      }),
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Frozen → the critical tier is still consulted (a critical plan/intake
    // candidate could still dispatch, Q1), but the implement-ready critical
    // is NOT dispatched (no new code lands mid-release); the non-critical
    // plan/intake tiers still dispatch.
    expect(deps.getNextCriticalCandidate).toHaveBeenCalledTimes(1);
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('WL-PLAN');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-PLAN'),
      expect.anything(),
    );
    expect(deps.claimItem).not.toHaveBeenCalledWith('WL-CRIT-P', expect.anything());
  });

  it('freeze split-by-skill: critical plan/intake dispatch CONTINUES while frozen (Q1)', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalReady('WL-CRIT-R'), // plan-ready
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-R', { status: 'open', stage: 'intake_complete' });
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-CRIT-R'),
      expect.anything(),
    );
  });

  it('ambiguous marker is treated as frozen (fail-closed): critical implement pauses, plan/intake continue', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('ambiguous'),
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalPlanned('WL-CRIT-P'),
      }),
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null }) // intake_complete empty
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-IDEA', title: 'An idea', stage: 'idea' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Frozen: the critical implement candidate is skipped (fail-closed on
    // the ambiguous marker); the intake tier still dispatches.
    expect(outcome.kind).toBe('intake');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:intake WL-IDEA'),
      expect.anything(),
    );
    expect(deps.claimItem).not.toHaveBeenCalledWith('WL-CRIT-P', expect.anything());
  });

  it('no double-dispatch: claim CAS applies to the critical tier (stale claim aborts)', async () => {
    const deps = makeDeps({
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalIdea('WL-CRIT-I'),
      }),
      claimItem: vi.fn().mockResolvedValue({ ok: false, reason: 'stale' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('claim-failed');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('dependency-blocked critical candidate dispatches its frontier blocker with the blocker stage-appropriate skill (Q3)', async () => {
    // The dep returns the frontier-resolved blocker (like getNextItem does):
    // the critical item is dependency-blocked, so the selected candidate IS
    // the nearest open blocker, carrying ITS stage.
    const deps = makeDeps({
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalReady('WL-BLOCKER', { title: 'Blocking work item' }),
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('WL-BLOCKER');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-BLOCKER', { status: 'open', stage: 'intake_complete' });
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-BLOCKER'),
      expect.anything(),
    );
  });

  it('records the critical dispatch with the skill-mapped kind (rolling log + change-guard consistency)', async () => {
    const deps = makeDeps({
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalIdea('WL-CRIT-I'),
      }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    const event = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.itemId).toBe('WL-CRIT-I');
    expect(event.kind).toBe('intake');
    expect(event.stage).toBe('idea');
    expect(event.cwd).toBe('/repo');
  });

  it('single-flight: a concurrent dispatch refuses the critical tier (dispatch-in-flight)', async () => {
    // Gate the pane spawn so the first dispatch is verifiably in flight
    // when the second call arrives (same pattern as the existing
    // single-flight guard test, using the critical-tier candidate).
    let release!: () => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = () => resolve({ ok: true });
    });
    const deps = makeDeps({
      getNextCriticalCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: criticalIdea('WL-CRIT-I'),
      }),
      spawnAgentPane: vi.fn().mockImplementation(() => gate),
    });

    const first = dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    const second = dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    release();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(firstOutcome.dispatched).toBe(true);
    expect(firstOutcome.kind).toBe('intake');
    expect(secondOutcome.dispatched).toBe(false);
    expect(secondOutcome.reason).toBe('dispatch-in-flight');
  });
});
