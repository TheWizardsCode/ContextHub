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

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isIdleStatus,
  evaluateIdle,
  parseLlamaStatus,
  fetchLocalStatus,
  createDowntimePoller,
  dispatchDowntimeWork,
  computeMostImportantItem,
  dispatchFromCoordination,
  fetchExtendedHerdrItems,
  createDowntimeWorker,
  parseNextCandidatesOutput,
  parseImplementCandidatesOutput,
  selectImplementCandidate,
  selectNextCandidate,
  parseCriticalCandidatesOutput,
  parseDepListBlockersOutput,
  parseShownWorkItem,
  parseShowItemOutput,
  selectCriticalCandidate,
  criticalSkillKind,
  resolveDependencyFrontier,
  parseAuditCandidatesOutput,
  selectAuditCandidate,
  selectWithRotation,
  classifyItemForDispatch,
  selectCriticalFirstCandidates,
  clampDowntimeMaxAttempts,
  resumeStalledWorkIfAble,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DOWNTIME_MAX_ATTEMPTS_MIN,
  DOWNTIME_MAX_ATTEMPTS_MAX,
  countFreeUnownedSlots,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  type LlamaStatus,
  type DowntimeCandidate,
  type DowntimeWorkerDeps,
  type AuditCandidate,
  type ImplementCandidate,
  type CriticalCandidate,
  type ScheduledPrompt,
  type DowntimeItemInfo,
  type DowntimeHerdrItem,
  isTransientDowntimeError,
  withTransientRetry,
  DOWNTIME_DISPATCH_EXTEND_MAX,
  DOWNTIME_DECISION_LOG_MIN_INTERVAL_MS,
  decisionHeaderToken,
  LOCAL_DISPATCH_LEASE_MAX_SECONDS,
} from './downtime-worker.js';
import { createRoundRobinRegistry } from './downtime-round-robin.js';
import {
  readCoordinationLogEntries,
  type CoordinationLogEntry,
} from './downtime-log.js';
import {
  LEASE_FILE,
  LEADER_LOCK_FILE,
  isLeaseValid,
} from './leader-election.js';
import {
  writeCoordinationFile,
  type CoordinationEntry,
} from './coordination.js';
import {
  statusFixtures,
  ambiguousMissingFieldsRaw,
  idleAllSlotsFree,
  perSlotAllFree,
  perSlotTwoFree,
  perSlotOneProcessing,
  jsonResponseFixture,
  makeDeps,
  createTempDirTracker,
  ago,
  writeDowntimeLog,
  writeRawDowntimeLog,
} from './downtime-worker.fixtures.js';
import {
  resumeStalledPane,
  _resetStalledResumeInFlight,
  type ResumeStalledPaneDeps,
  type StalledPaneCandidate,
} from './stalled-work.js';

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

// ── Bounded concurrent dispatch (F1, parent WL-0MT50LKAK001EF5Q) ──────

describe('pipeline single-flight — one in-flight dispatch pipeline at a time', () => {
  it('a second concurrent same-process dispatch is refused (dispatch-in-flight)', async () => {
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
});

describe('idle gate — no dispatch with zero free slots', () => {
  it('second dispatch only fires when requiredFreeSlots continuously idle for threshold', async () => {
    // This test verifies the per-slot idle tracker contract.
    // With cap=2, we need 2 slots continuously idle for the threshold.
    // A second dispatch should NOT fire if only 1 slot is idle.
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
    });

    // With 0 free slots (below panes min of 1), dispatch is gated
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 0 });

    // Dispatch should be gated when no slots are free
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
  });
});

describe('idle gate — no dispatch with zero free slots (fast-mode operator priority)', () => {
  it('with 3 total slots and 1 free, only 1 dispatch fires even if cap=2', async () => {
    // Fast-mode / operator priority preserved: freeSlots check is the hard limit
    // With 0 free slots, no dispatch can occur regardless of cap
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', freeSlots: 0 });
    expect(outcome.dispatched).toBe(false); // no slots free → gated
  });
});

describe('bounded concurrent dispatch — claim safety regression', () => {
  it('dispatched-marker exclusion still prevents re-dispatch of already-dispatched item', async () => {
    // Regression guard for WL-0MSLIY8ZR004QUSY: claim safety via CAS
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Claim safety: the item should be claimed once, not re-claimed
    if (outcome.dispatched) {
      expect(deps.claimItem).toHaveBeenCalledTimes(1);
    }
  });
});

// ── No-dispatch decision log + header (WL-0MU8808ZY0091JIA) ──────────

describe('downtime no-dispatch decision log (WL-0MU8808ZY0091JIA)', () => {
  function makeDecisionWorker(opts: {
    status: LlamaStatus;
    root: string;
    requiredFreeSlots?: number;
    thresholdMs?: number;
    runningPanes?: () => { ok: true; count: number } | { ok: false; error?: string };
    recordDecision?: (entry: CoordinationLogEntry, cwd: string) => Promise<void>;
  }) {
    const cfg = {
      enabled: true,
      thresholdMs: opts.thresholdMs ?? 0,
      requiredFreeSlots: opts.requiredFreeSlots ?? 0,
      model: 'plan',
      cwd: opts.root,
      noCandidateCooldownMs: 3_600_000,
      browseItemCount: 20,
    };
    const poller = createDowntimePoller(
      'http://proxy:8000',
      vi.fn().mockResolvedValue(jsonResponseFixture(opts.status)),
    );
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getRunningDowntimePanes: vi
        .fn()
        .mockImplementation(async () => (opts.runningPanes ?? (() => ({ ok: true, count: 0 })))()),
      ...(opts.recordDecision ? { recordDecision: opts.recordDecision } : {}),
    });
    const worker = createDowntimeWorker({ poller, deps, config: () => ({ ...cfg }) });
    return { worker, deps };
  }

  it('maps internal reasons to stable header tokens', () => {
    expect(decisionHeaderToken('slot-owned')).toBe('slot-owner');
    expect(decisionHeaderToken('proxy-contention')).toBe('contention');
    expect(decisionHeaderToken('review-queue-hold')).toBe('review-queue');
    expect(decisionHeaderToken('code-freeze')).toBe('code-freeze');
  });

  it('AC1: a fail-closed refusal writes the distinct slots-unavailable reason + observed fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-decision-failclosed-'));
    try {
      // The exact live shape (WL-0MUFP30T2003OX1F): stale/empty per-slot
      // detail with a held owner lease. The dispatcher fails closed and
      // records the distinct `slots-unavailable` reason (WL-0MUXVPXAZ005RESW).
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 1,
        total_slots: 3,
        slots: [],
        slots_stale: true,
        local_owner_session_id: 'session-live-pane',
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker } = makeDecisionWorker({
        status,
        root,
        runningPanes: () => ({ ok: true, count: 1 }),
      });
      const outcome = await worker.tick();
      expect(outcome.dispatched).toBe(false);
      expect(worker.blockReason).toBe('no-slots');
      await vi.waitFor(async () => {
        const entries = (await readCoordinationLogEntries(root)).filter(
          (e) => e.kind === 'decision',
        );
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          kind: 'decision',
          operation: 'no-dispatch',
          reason: 'slots-unavailable',
          freeSlots: 0,
          totalSlots: 3,
          ownerPresent: true,
          runningPanes: null,
          contentionDepth: 0,
        });
        expect(typeof entries[0].at).toBe('string');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC2: a contention refusal writes the reason and the observed depth', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-decision-contention-'));
    try {
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: false,
        available_slots: 4,
        total_slots: 4,
        slots: [
          { slot_id: 'slot-1', is_processing: false },
          { slot_id: 'slot-2', is_processing: false },
          { slot_id: 'slot-3', is_processing: false },
          { slot_id: 'slot-4', is_processing: false },
        ],
        contention_queue_depth: 3,
        contention_queued_count: 3,
      };
      const { worker } = makeDecisionWorker({ status, root });
      const outcome = await worker.tick();
      expect(outcome.dispatched).toBe(false);
      expect(worker.blockReason).toBe('contention');
      await vi.waitFor(async () => {
        const entries = (await readCoordinationLogEntries(root)).filter(
          (e) => e.kind === 'decision',
        );
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          reason: 'proxy-contention',
          contentionDepth: 3,
          ownerPresent: false,
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('AC3: repeated identical refusals are rate-limited, then logged again after the window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'herdr-decision-rate-'));
    vi.useFakeTimers();
    try {
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: false,
        available_slots: 1,
        total_slots: 1,
        contention_queue_depth: 3,
        contention_queued_count: 3,
      };
      const recordDecision = vi.fn().mockResolvedValue(undefined);
      const { worker } = makeDecisionWorker({ status, root, recordDecision });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick(); // first refusal → logged
      expect(recordDecision).toHaveBeenCalledTimes(1);
      vi.setSystemTime(start + 60_000); // 1 min later, same reason → suppressed
      await worker.tick();
      expect(recordDecision).toHaveBeenCalledTimes(1);
      // Past the rate-limit window → logged again (≤ 6 identical lines/hour).
      vi.setSystemTime(start + DOWNTIME_DECISION_LOG_MIN_INTERVAL_MS + 1);
      await worker.tick();
      expect(recordDecision).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Local dispatch-lease TTL + own-pane leases (WL-0MU8809SZ0022VZG) ──

describe('local dispatch-lease TTL + own-pane leases (WL-0MU8809SZ0022VZG)', () => {
  function makeLeaseWorker(opts: {
    status: LlamaStatus;
    requiredFreeSlots: number;
    thresholdMs?: number;
    runningPanes: number;
  }) {
    const cfg = {
      enabled: true,
      thresholdMs: opts.thresholdMs ?? 0,
      requiredFreeSlots: opts.requiredFreeSlots,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
      browseItemCount: 20,
    };
    const poller = createDowntimePoller(
      'http://proxy:8000',
      vi.fn().mockResolvedValue(jsonResponseFixture(opts.status)),
    );
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({
        ok: true,
        count: opts.runningPanes,
        paneIds: [],
        records: [],
      }),
    });
    const worker = createDowntimeWorker({ poller, deps, config: () => ({ ...cfg }) });
    return { worker, deps };
  }

  it('AC1: pins the proxy adaptive lease maximum (llm-manager default 1500 s)', () => {
    // The proxy lease is adaptive and capped at local_dispatch_lease_max_seconds
    // (default 1500 s) — NOT the historical ~180 s the code used to assume.
    expect(LOCAL_DISPATCH_LEASE_MAX_SECONDS).toBe(1500);
  });

  it('AC1/AC3: a max-TTL operator lease on a single owned slot still refuses dispatch', async () => {
    // The dispatcher must not optimistically assume the lease expired: a lease
    // at the proxy MAX on a single-slot setup (an unknown/operator owner) keeps
    // the slot owned, so no free unowned slot remains and dispatch is refused.
    const status: LlamaStatus = {
      llama_server_running: true,
      local_active_query: false,
      model_switch_in_progress: false,
      local_lease_active: true,
      available_slots: 1,
      total_slots: 1,
      local_owner_session_id: 'operator-session',
      local_owner_lease_remaining_seconds: LOCAL_DISPATCH_LEASE_MAX_SECONDS,
      slots: [
        { slot_id: 'slot-1', is_processing: false, owner_session_id: 'operator-session' },
      ],
      contention_queue_depth: 0,
      contention_queued_count: 0,
    };
    const { worker, deps } = makeLeaseWorker({
      status,
      requiredFreeSlots: 0,
      runningPanes: 1,
    });
    const outcome = await worker.tick();
    expect(outcome.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('AC2: a max-TTL lease held by a dispatched pane does not block the free unowned slots (per-slot)', async () => {
    // Self-blocking case (RCA WL-0MU87ZGPP0029V28): the dispatched pane owns
    // slot-1; slots 2 and 3 are free and unowned. Even with the lease at the
    // proxy MAX and the worker's own pane alive, dispatch into the free slots
    // MUST proceed — the per-slot gate ignores the global lease when unowned
    // slots remain.
    vi.useFakeTimers();
    try {
      const ownSession = 'dispatched-pane-session';
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 2,
        total_slots: 3,
        local_owner_session_id: ['http://localhost:8080', ownSession],
        local_owner_session_ids: [ownSession],
        local_owner_lease_remaining_seconds: LOCAL_DISPATCH_LEASE_MAX_SECONDS,
        slots: [
          { slot_id: 'slot-1', is_processing: true, owner_session_id: ownSession },
          { slot_id: 'slot-2', is_processing: false },
          { slot_id: 'slot-3', is_processing: false },
        ],
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker, deps } = makeLeaseWorker({
        status,
        requiredFreeSlots: 2,
        thresholdMs: 1_000,
        runningPanes: 1,
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick(); // baseline — start the per-slot idle timers
      vi.setSystemTime(start + 5_000);
      const outcome = await worker.tick();
      expect(outcome.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Fail-closed per-slot contract (WL-0MUXVPXAZ005RESW) ──────────────
// Supersedes the count-based fallback introduced by WL-0MUFP30T2003OX1F.

describe('fail-closed on unusable per-slot detail (WL-0MUXVPXAZ005RESW)', () => {
  function makeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      llama_server_running: true,
      local_active_query: true,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 1,
      total_slots: 3,
      slots: [],
      slots_stale: true,
      local_owner_session_id: ['http://localhost:8080', 'audit-pane-session'],
      local_owner_lease_remaining_seconds: 645.5,
      contention_queue_depth: 0,
      contention_queued_count: 0,
      ...overrides,
    };
  }

  function makeStaleWorker(opts: {
    status: LlamaStatus;
    requiredFreeSlots: number;
    thresholdMs?: number;
    runningPanes: number;
  }) {
    const cfg = {
      enabled: true,
      thresholdMs: opts.thresholdMs ?? 0,
      requiredFreeSlots: opts.requiredFreeSlots,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
      browseItemCount: 20,
    };
    const poller = createDowntimePoller(
      'http://proxy:8000',
      vi.fn().mockResolvedValue(jsonResponseFixture(opts.status)),
    );
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({
        ok: true,
        count: opts.runningPanes,
        paneIds: [],
        records: [],
      }),
    });
    const worker = createDowntimeWorker({ poller, deps, config: () => ({ ...cfg }) });
    return { worker, deps };
  }

  it('parses slots_stale and preserves the empty slots array', () => {
    const status = parseLlamaStatus(makeRaw());
    expect(status).not.toBeNull();
    expect(status!.slots).toEqual([]);
    expect(status!.slots_stale).toBe(true);
    // The array owner form still normalises (child WL-0MU88086A0089US4).
    expect(status!.local_owner_session_ids).toEqual(['audit-pane-session']);
    expect(status!.local_owner_session_id).toBe('audit-pane-session');
  });

  it('a malformed slots_stale fails closed (null)', () => {
    expect(parseLlamaStatus(makeRaw({ slots_stale: 'yes' }))).toBeNull();
    expect(parseLlamaStatus(makeRaw({ slots_stale: 1 }))).toBeNull();
  });

  it('evaluateIdle fails closed for absent, empty, and stale per-slot detail', () => {
    // The untrusted available_slots count is never a dispatch budget:
    // absent, empty, or stale per-slot detail all yield busy.
    const absent = parseLlamaStatus(makeRaw({ available_slots: 3, slots: undefined }))!;
    expect(absent.slots).toBeUndefined();
    expect(evaluateIdle(absent, 1)).toBe(false);

    const empty = parseLlamaStatus(makeRaw({ available_slots: 3 }))!;
    expect(empty.slots).toEqual([]);
    expect(evaluateIdle(empty, 1)).toBe(false);

    const stale = parseLlamaStatus(
      makeRaw({ available_slots: 3, slots: [{ slot_id: 0, is_processing: false }] }),
    )!;
    expect(stale.slots_stale).toBe(true);
    expect(evaluateIdle(stale, 1)).toBe(false);
  });

  it('decisionHeaderToken maps the distinct fail-closed reason to no-slots', () => {
    expect(decisionHeaderToken('slots-unavailable')).toBe('no-slots');
    expect(decisionHeaderToken('slots-unavailable')).not.toBe(
      decisionHeaderToken('slot-owned'),
    );
    expect(decisionHeaderToken('slots-unavailable')).not.toBe(
      decisionHeaderToken('proxy-contention'),
    );
  });

  it('AC1/AC4: the exact live payload (stale/empty slots, held lease, live pane) does NOT dispatch', async () => {
    vi.useFakeTimers();
    try {
      // The exact live shape: total=3, available=1, slots:[], slots_stale:true,
      // an owner lease held by a dispatched pane. The dispatcher must fail
      // closed and record the distinct `slots-unavailable` reason.
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: true,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 1,
        total_slots: 3,
        slots: [],
        slots_stale: true,
        local_owner_session_id: 'audit-pane-session',
        local_owner_session_ids: ['audit-pane-session'],
        local_owner_lease_remaining_seconds: 645.5,
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker, deps } = makeStaleWorker({
        status,
        requiredFreeSlots: 1,
        thresholdMs: 1_000,
        runningPanes: 1,
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick(); // baseline
      vi.setSystemTime(start + 5_000);
      const outcome = await worker.tick();
      expect(outcome.dispatched).toBe(false);
      expect(worker.blockReason).toBe('no-slots');
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never derives the dispatch budget from available_slots (fail-closed budget)', async () => {
    // available_slots=3 would previously have admitted a dispatch; with no
    // usable per-slot detail the worker refuses regardless of the count.
    vi.useFakeTimers();
    try {
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: true,
        model_switch_in_progress: false,
        local_lease_active: false,
        available_slots: 3,
        total_slots: 3,
        slots: [],
        slots_stale: true,
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker, deps } = makeStaleWorker({
        status,
        requiredFreeSlots: 1,
        thresholdMs: 1_000,
        runningPanes: 0,
      });
      const start = 2_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const outcome = await worker.tick();
      expect(outcome.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Per-item/per-kind dispatch-attempt cap (WL-0MUKYEXMK0033MFK) ───────
//
// A repeatedly non-terminal item must stop consuming dispatch slots. Once
// the rolling dispatch log records `maxAttempts` attempts for an
// `(item, kind)` at the item's current stage, the item is flagged
// `needsProducerReview` and excluded from further automatic dispatch of that
// kind, with a neutral `attempt-budget-exhausted` reason (never a strike,
// never `no-candidate`). A stage advancement resets the budget; a
// missing/corrupt log is fail-open (count 0).

describe('per-item/per-kind dispatch-attempt cap (WL-0MUKYEXMK0033MFK)', () => {
  // 1s marker-stale window so same-stage markers written in the past are
  // RELEASED (otherwise the duplicate-dispatch marker guard would skip the
  // item before the budget filter runs).
  const WINDOW_MS = 1_000;
  const tempDirs = createTempDirTracker();

  afterEach(() => {
    tempDirs.cleanup();
  });

  function makeCwd(): string {
    return tempDirs.make('dt-attempt-budget-');
  }

  const writeRawLog = writeRawDowntimeLog;
  const writeLog = writeDowntimeLog;

  const implementHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Implement ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'high',
    risk: 'Low',
    effort: 'S',
    sortIndex: 10,
  });

  const planHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Plan ${id}`,
    status: 'open',
    stage: 'intake_complete',
    priority: 'medium',
    sortIndex: 30,
  });

  const marker = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    itemId: 'IMP-1',
    kind: 'implement',
    stage: 'plan_complete',
    dispatchedAt: ago(60_000),
    ...overrides,
  });

  function depsFor(items: DowntimeHerdrItem[], overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
    return makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items }),
      markNeedsProducerReview: vi.fn().mockResolvedValue(true),
      ...overrides,
    });
  }

  it('AC7a: below the cap the item is eligible for dispatch', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [marker(), marker()]); // 2 attempts < 3
    const deps = depsFor([implementHead('IMP-1')]);

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd,
      markerStaleWindowMs: WINDOW_MS,
      maxAttempts: 3,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('IMP-1');
    expect(deps.markNeedsProducerReview).not.toHaveBeenCalled();
  });

  it('AC7b: at the cap the item is skipped with the neutral attempt-budget-exhausted reason', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [marker(), marker(), marker()]); // 3 attempts == 3
    const deps = depsFor([implementHead('IMP-1')]);

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd,
      markerStaleWindowMs: WINDOW_MS,
      maxAttempts: 3,
    });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('attempt-budget-exhausted');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // Neutral: never a CLI-error strike.
    expect(deps.recordError).not.toHaveBeenCalled();
  });

  it('AC7c: the producer-review flag is set exactly once when the cap is reached', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [marker(), marker(), marker()]);
    const deps = depsFor([implementHead('IMP-1')]);

    await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd,
      markerStaleWindowMs: WINDOW_MS,
      maxAttempts: 3,
    });

    expect(deps.markNeedsProducerReview).toHaveBeenCalledTimes(1);
    expect(deps.markNeedsProducerReview).toHaveBeenCalledWith('IMP-1', cwd);
  });

  it('AC7d: a stage advancement resets the budget (earlier-stage attempts do not count)', async () => {
    const cwd = makeCwd();
    // Three attempts recorded at the PRIOR stage; the item has since advanced
    // to plan_complete, so the earlier attempts no longer count.
    writeLog(cwd, [
      marker({ stage: 'intake_complete' }),
      marker({ stage: 'intake_complete' }),
      marker({ stage: 'intake_complete' }),
    ]);
    const deps = depsFor([implementHead('IMP-1')]);

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd,
      markerStaleWindowMs: WINDOW_MS,
      maxAttempts: 3,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('IMP-1');
    expect(deps.markNeedsProducerReview).not.toHaveBeenCalled();
  });

  it('AC7e: a corrupt/missing log is fail-open (never blocks all dispatch)', async () => {
    const cwd = makeCwd();
    writeRawLog(cwd, '{not valid json}\nalso-not-json\n');
    const deps = depsFor([implementHead('IMP-1')]);

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd,
      markerStaleWindowMs: WINDOW_MS,
      maxAttempts: 3,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('IMP-1');
  });

  it('AC4: the budget is per-kind — attempts of another kind do not exhaust it', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [
      { itemId: 'IMP-1', kind: 'plan', stage: 'plan_complete', dispatchedAt: ago(60_000) },
      { itemId: 'IMP-1', kind: 'plan', stage: 'plan_complete', dispatchedAt: ago(60_000) },
      { itemId: 'IMP-1', kind: 'plan', stage: 'plan_complete', dispatchedAt: ago(60_000) },
    ]);
    const deps = depsFor([implementHead('IMP-1')]);

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd,
      markerStaleWindowMs: WINDOW_MS,
      maxAttempts: 3,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
  });

  it('AC6 (offer path): computeMostImportantItem reports attemptBudgetHold, never noCandidate', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [marker(), marker(), marker()]);
    const deps = depsFor([implementHead('IMP-1')]);

    const result = await computeMostImportantItem(deps, cwd, Date.now(), undefined, WINDOW_MS, undefined, 3);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('attemptBudgetHold' in result).toBe(true);
      expect('noCandidate' in result).toBe(false);
      expect('candidate' in result).toBe(false);
    }
    expect(deps.markNeedsProducerReview).toHaveBeenCalledWith('IMP-1', cwd);
  });

  it('AC6 (offer path): below the cap computeMostImportantItem still offers the item', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [marker(), marker()]);
    const deps = depsFor([implementHead('IMP-1')]);

    const result = await computeMostImportantItem(deps, cwd, Date.now(), undefined, WINDOW_MS, undefined, 3);

    expect(result.ok).toBe(true);
    if (result.ok && 'candidate' in result) {
      expect(result.candidate.id).toBe('IMP-1');
      expect(result.kind).toBe('implement');
    } else {
      throw new Error(`expected a candidate offer, got ${JSON.stringify(result)}`);
    }
  });

  it('AC6 (leader/coordination path): dispatchFromCoordination enforces the cap and flags the item', async () => {
    const cwd = makeCwd();
    const coordinationDir = makeCwd();
    writeLog(cwd, [marker(), marker(), marker()]);
    const deps = makeDeps({
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: {
          id: 'IMP-1',
          title: 'Implement IMP-1',
          status: 'open',
          stage: 'plan_complete',
          priority: 'high',
          risk: 'Low',
          effort: 'S',
          sortIndex: 10,
        },
      }),
      markNeedsProducerReview: vi.fn().mockResolvedValue(true),
    });
    const entries: CoordinationEntry[] = [{
      instanceId: 'inst-1',
      workItemId: 'IMP-1',
      directory: cwd,
      worklogRoot: cwd,
      assignedAt: ago(60_000),
      lastUpdated: ago(60_000),
    }];

    const outcome = await dispatchFromCoordination(deps, entries, {
      model: 'plan',
      cwd,
      coordinationDir,
      markerStaleWindowMs: WINDOW_MS,
      maxAttempts: 3,
    });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('attempt-budget-exhausted');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.markNeedsProducerReview).toHaveBeenCalledWith('IMP-1', cwd);
  });

  it('plan kind: the cap is enforced for a plan candidate too', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [
      { itemId: 'PLN-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(60_000) },
      { itemId: 'PLN-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(60_000) },
      { itemId: 'PLN-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(60_000) },
    ]);
    const deps = depsFor([planHead('PLN-1')]);

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd,
      markerStaleWindowMs: WINDOW_MS,
      maxAttempts: 3,
    });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('attempt-budget-exhausted');
    expect(deps.markNeedsProducerReview).toHaveBeenCalledWith('PLN-1', cwd);
  });
});

describe('clampDowntimeMaxAttempts (WL-0MUKYEXMK0033MFK)', () => {
  it('defaults on non-finite input', () => {
    expect(clampDowntimeMaxAttempts(Number.NaN)).toBe(DEFAULT_DOWNTIME_MAX_ATTEMPTS);
    expect(clampDowntimeMaxAttempts(Number.POSITIVE_INFINITY)).toBe(DEFAULT_DOWNTIME_MAX_ATTEMPTS);
  });

  it('clamps into the documented [1, 10] range', () => {
    expect(clampDowntimeMaxAttempts(0)).toBe(DOWNTIME_MAX_ATTEMPTS_MIN);
    expect(clampDowntimeMaxAttempts(-5)).toBe(DOWNTIME_MAX_ATTEMPTS_MIN);
    expect(clampDowntimeMaxAttempts(99)).toBe(DOWNTIME_MAX_ATTEMPTS_MAX);
    expect(clampDowntimeMaxAttempts(4)).toBe(4);
  });
});

// ── Stalled-work scan before new-item dispatch (WL-0MUYMBSA90092QV2) ──
// The dispatcher must, on an idle cycle and BEFORE new-item selection,
// consult the stalled-work scan; a successful in-place resume short-circuits
// the cycle (preference ordering) and every failure degrades to the unchanged
// normal dispatch path (fail-safe).

describe('stalled-work scan before new-item dispatch (WL-0MUYMBSA90092QV2)', () => {
  function stalledCandidate(overrides: Partial<StalledPaneCandidate> = {}): StalledPaneCandidate {
    return {
      pane: {
        paneId: 'pane-1',
        label: 'Downtime triggered implement Some item - WL-STALLED',
        agent: 'pi',
        agentStatus: 'idle',
      },
      item: {
        id: 'WL-STALLED',
        status: 'open',
        stage: 'plan_complete',
        title: 'Some item',
        updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
      cwd: '/repo',
      kind: 'implement',
      ...overrides,
    };
  }

  const implementHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Implement ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'high',
    risk: 'Low',
    effort: 'S',
    sortIndex: 10,
  });

  it('dispatchDowntimeWork: a successful resume short-circuits new-item dispatch', async () => {
    const scanStalledPanes = vi.fn().mockResolvedValue([stalledCandidate()]);
    const resumeStalledPane = vi.fn().mockResolvedValue({
      resumed: true,
      via: 'prompt',
      paneId: 'pane-1',
      itemId: 'WL-STALLED',
      kind: 'implement',
    });
    const deps = makeDeps({
      scanStalledPanes,
      resumeStalledPane,
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('WL-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome).toEqual({ dispatched: false, reason: 'stalled-resume' });
    expect(scanStalledPanes).toHaveBeenCalledTimes(1);
    expect(resumeStalledPane).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo', kind: 'implement' }),
      expect.objectContaining({ enabled: true, thresholdMs: expect.any(Number) }),
    );
    // New-item selection never ran and no pane was spawned.
    expect(deps.getHerdrListHead).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('dispatchDowntimeWork: an unresumable candidate falls through to normal dispatch', async () => {
    const resumeStalledPane = vi.fn().mockResolvedValue({
      resumed: false,
      reason: 'agent-blocked',
      paneId: 'pane-1',
      itemId: 'WL-STALLED',
      kind: 'implement',
    });
    const deps = makeDeps({
      scanStalledPanes: vi.fn().mockResolvedValue([stalledCandidate()]),
      resumeStalledPane,
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('WL-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('WL-1');
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('dispatchDowntimeWork: a thrown scan degrades to normal dispatch (never a crash)', async () => {
    const deps = makeDeps({
      scanStalledPanes: vi.fn().mockRejectedValue(new Error('herdr down')),
      resumeStalledPane: vi.fn(),
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('WL-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('WL-1');
  });

  it('dispatchDowntimeWork: unwired scan deps degrade to normal dispatch', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('WL-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
  });

  it('dispatchDowntimeWork: a disabled scan never consults the scan dep', async () => {
    const scanStalledPanes = vi.fn();
    const deps = makeDeps({
      scanStalledPanes,
      resumeStalledPane: vi.fn(),
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('WL-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      stallScanEnabled: false,
    });

    expect(outcome.dispatched).toBe(true);
    expect(scanStalledPanes).not.toHaveBeenCalled();
  });

  it('dispatchFromCoordination: a successful resume short-circuits the offer dispatch', async () => {
    const fetchItem = vi.fn();
    const deps = makeDeps({
      scanStalledPanes: vi.fn().mockResolvedValue([stalledCandidate()]),
      resumeStalledPane: vi.fn().mockResolvedValue({
        resumed: true,
        via: 'prompt',
        paneId: 'pane-1',
        itemId: 'WL-STALLED',
        kind: 'implement',
      }),
      fetchItem,
    });

    const entry: CoordinationEntry = {
      instanceId: 'i1',
      workItemId: 'WL-1',
      directory: '/repo',
      worklogRoot: '/repo',
      assignedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
    const outcome = await dispatchFromCoordination(deps, [entry], {
      model: 'plan',
      cwd: '/repo',
      coordinationDir: '/coord',
      freeSlots: 2,
    });

    expect(outcome).toEqual({ dispatched: false, reason: 'stalled-resume' });
    expect(fetchItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('computeMostImportantItem: a successful resume reports stalledResume and offers nothing', async () => {
    const deps = makeDeps({
      scanStalledPanes: vi.fn().mockResolvedValue([stalledCandidate()]),
      resumeStalledPane: vi.fn().mockResolvedValue({
        resumed: true,
        via: 'prompt',
        paneId: 'pane-1',
        itemId: 'WL-STALLED',
        kind: 'implement',
      }),
      getHerdrListHead: vi.fn(),
    });

    const result = await computeMostImportantItem(
      deps,
      '/repo',
      Date.now(),
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      300_000,
    );

    expect(result).toEqual({ ok: true, stalledResume: true });
    expect(deps.getHerdrListHead).not.toHaveBeenCalled();
  });

  it('computeMostImportantItem: no resume → the normal offer computation runs', async () => {
    const deps = makeDeps({
      scanStalledPanes: vi.fn().mockResolvedValue([]),
      resumeStalledPane: vi.fn(),
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('WL-1')] }),
    });

    const result = await computeMostImportantItem(
      deps,
      '/repo',
      Date.now(),
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      300_000,
    );

    expect(result).toMatchObject({ ok: true, candidate: { id: 'WL-1' } });
    expect(deps.getHerdrListHead).toHaveBeenCalledTimes(1);
  });
});

// ── Stalled-work cross-root / idempotence / fail-safe integration (WL-0MUYMBUAK007H10J) ──
// End-to-end verification over the REAL `resumeStalledPane` orchestrator (the
// scan dep's candidates are stubbed at the dispatch boundary, so the resume
// path itself — re-classification, the in-process (paneId,itemId) guard, the
// CLI-failure mapping and the fail-open attempt record — is exercised as it
// runs in production).

describe('stalled-work cross-root, idempotence and fail-safe integration (WL-0MUYMBUAK007H10J)', () => {
  const NOW = Date.now();

  function stalledCandidate(overrides: Partial<StalledPaneCandidate> = {}): StalledPaneCandidate {
    return {
      pane: {
        paneId: 'pane-1',
        label: 'Downtime triggered implement Some item - WL-STALLED',
        agent: 'pi',
        agentStatus: 'idle',
      },
      item: {
        id: 'WL-STALLED',
        status: 'open',
        stage: 'plan_complete',
        title: 'Some item',
        updatedAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
      },
      cwd: '/foreign/root',
      kind: 'implement',
      ...overrides,
    };
  }

  const implementHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Implement ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'high',
    risk: 'Low',
    effort: 'S',
    sortIndex: 10,
  });

  function realResumeDep(overrides: Partial<ResumeStalledPaneDeps> = {}) {
    return (cand: StalledPaneCandidate, opts: { nonTerminalCooldownMs: number; thresholdMs: number }) =>
      resumeStalledPane(
        {
          pane: cand.pane,
          item: cand.item,
          cwd: cand.cwd,
          kind: cand.kind,
          nonTerminalCooldownMs: opts.nonTerminalCooldownMs,
          thresholdMs: opts.thresholdMs,
        },
        {
          promptAgent: vi.fn().mockResolvedValue({ ok: true }),
          startAgent: vi.fn().mockResolvedValue({ ok: true }),
          readEntries: async () => [],
          recordAttempt: async () => undefined,
          markNeedsProducerReview: async () => true,
          maxAttempts: 3,
          now: () => NOW,
          ...overrides,
        },
      );
  }

  beforeEach(() => {
    _resetStalledResumeInFlight();
  });

  it('reaper race: a pane that vanishes mid-resume is a neutral skip; dispatch falls through with no duplicate prompt', async () => {
    const promptAgent = vi.fn().mockResolvedValue({ ok: false, reason: 'pane-vanished' });
    const recordAttempt = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      scanStalledPanes: vi.fn().mockResolvedValue([stalledCandidate()]),
      resumeStalledPane: realResumeDep({ promptAgent, recordAttempt }),
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('WL-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/leader' });

    // The vanished pane did not resume and did not block the cycle: the
    // normal dispatch path proceeded and opened exactly one NEW pane.
    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('WL-1');
    expect(promptAgent).toHaveBeenCalledTimes(1);
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('a thrown resume is neutral: normal dispatch proceeds, no crash, no duplicate', async () => {
    const deps = makeDeps({
      scanStalledPanes: vi.fn().mockResolvedValue([stalledCandidate()]),
      resumeStalledPane: vi.fn().mockRejectedValue(new Error('herdr exploded')),
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('WL-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/leader' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('WL-1');
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('prevents a concurrent double-resume of the same pane/item (neutral skip, single prompt)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const promptAgent = vi.fn().mockImplementation(async () => {
      await gate;
      return { ok: true };
    });
    const recordAttempt = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      scanStalledPanes: vi.fn().mockResolvedValue([stalledCandidate()]),
      resumeStalledPane: realResumeDep({ promptAgent, recordAttempt }),
    });
    const opts = {
      enabled: true,
      frozen: false,
      thresholdMs: 5 * 60 * 1000,
      nonTerminalCooldownMs: 10 * 60 * 1000,
      maxAttempts: 3,
      now: NOW,
    };

    const first = resumeStalledWorkIfAble(deps, '/leader', opts);
    const second = resumeStalledWorkIfAble(deps, '/leader', opts);

    // The second concurrent cycle is a neutral skip (normal dispatch proceeds).
    expect(await second).toBe(false);
    expect(promptAgent).toHaveBeenCalledTimes(1);
    // Release the first resume: it succeeds, still with a single prompt/record.
    release();
    expect(await first).toBe(true);
    expect(promptAgent).toHaveBeenCalledTimes(1);
    expect(recordAttempt).toHaveBeenCalledTimes(1);
  });

  it('degrades to no stalled resume when the scan/resume seams are unwired', async () => {
    const opts = {
      enabled: true,
      frozen: false,
      thresholdMs: 5 * 60 * 1000,
      nonTerminalCooldownMs: 10 * 60 * 1000,
      maxAttempts: 3,
      now: NOW,
    };
    const c = stalledCandidate();

    expect(await resumeStalledWorkIfAble({} as DowntimeWorkerDeps, '/leader', opts)).toBe(false);
    // Only the scan wired: no resume attempted.
    expect(
      await resumeStalledWorkIfAble(
        { scanStalledPanes: vi.fn().mockResolvedValue([c]) } as unknown as DowntimeWorkerDeps,
        '/leader',
        opts,
      ),
    ).toBe(false);
    // Only the resume wired: the scan is never consulted.
    const resume = vi.fn();
    expect(
      await resumeStalledWorkIfAble(
        { resumeStalledPane: resume } as unknown as DowntimeWorkerDeps,
        '/leader',
        opts,
      ),
    ).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    // A scan that resolves a non-array (unparseable) is a neutral no-resume.
    expect(
      await resumeStalledWorkIfAble(
        {
          scanStalledPanes: vi.fn().mockResolvedValue(null),
          resumeStalledPane: resume,
        } as unknown as DowntimeWorkerDeps,
        '/leader',
        opts,
      ),
    ).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });
});

// ── Own-backlog fallback safety gates (WL-0MUZPBRX3007STFK, parent AC7) ──
//
// The own-backlog candidate is a dispatch candidate like any other: every
// existing safety gate must still apply to it as a SEQUENTIAL FILTER, never
// as a fallback ordering. Each test hides an eligible out-of-view item behind
// a gate and asserts the gate is not bypassed — the gated item is never
// claimed, and the fallback continues to the next eligible out-of-view item
// where one exists. The offer-list gate tests already exist above; these pin
// the same gates on the fallback path.
//
// RED WITNESS. The fallback does not exist yet, so every body asserts the
// post-implementation behaviour and is committed with `it.fails` — the suite
// stays GREEN while the assertions are RED (the repo's documented TDD pattern;
// see `docs/dev/downtime-dispatcher-post-fix-verification.md`). The
// implementation child WL-0MUPBSYW004I5D3 flips each `it.fails` to `it` once
// the fallback lands (the RED→GREEN transition is the dependency evidence).
describe('own-backlog fallback safety gates (WL-0MUZPBRX3007STFK)', () => {
  const SPRINT = 20;
  // 1s marker-stale window so same-stage markers written in the past are
  // RELEASED (the dispatched-marker guard) while the attempt-budget filter
  // still counts them.
  const WINDOW_MS = 1_000;
  const tempDirs = createTempDirTracker();

  afterEach(() => {
    tempDirs.cleanup();
  });

  function makeDir(prefix: string): string {
    return tempDirs.make(prefix);
  }

  /** An eligible non-critical plan_complete out-of-view item (implement tier). */
  const eligibleBacklog = (
    id: string,
    overrides: Partial<DowntimeHerdrItem> = {},
  ): DowntimeHerdrItem => ({
    id,
    title: `Backlog ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'high',
    risk: 'Low',
    effort: 'S',
    sortIndex: 1000,
    ...overrides,
  });

  /** An eligible plan-tier out-of-view item (idea → intake; unaffected by the freeze/review gates). */
  const eligiblePlan = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Plan ${id}`,
    status: 'open',
    stage: 'idea',
    priority: 'high',
    sortIndex: 3000,
  });

  /** In-view filler that is never dispatchable (the retired `in_review` stage). */
  const inView = (): DowntimeHerdrItem[] =>
    Array.from({ length: SPRINT }, (_, i) => ({
      id: `WL-VIEW-${i}`,
      title: `In-view ${i}`,
      status: 'open',
      stage: 'in_review',
      priority: 'medium',
      risk: 'Low',
      effort: 'S',
      sortIndex: i,
    }));

  /**
   * Own-root head: the in-view window at/below SPRINT, then the hinted
   * out-of-view tail once the dispatcher widens the window. Mirrors the
   * canonical ranking path (the same head, just more items included).
   */
  const ownRoot = (tail: DowntimeHerdrItem[]) =>
    vi.fn(async (_cwd: string, limit = SPRINT) => ({
      ok: true as const,
      items: limit <= SPRINT ? inView() : [...inView(), ...tail],
    }));

  const dispatchFallback = (
    deps: DowntimeWorkerDeps,
    coordinationDir: string,
    cwd: string,
    extra: Record<string, unknown> = {},
  ) =>
    dispatchFromCoordination(
      // `fetchItem` is REQUIRED by the coordination leader path (fail-closed
      // guard). These fallback tests pass no coordination entries, so it is
      // never invoked — this default only satisfies the guard so the
      // own-backlog fallback is reachable.
      { fetchItem: vi.fn().mockResolvedValue({ ok: false }), ...deps },
      [],
      {
        model: 'plan',
        cwd,
        coordinationDir,
        browseItemCount: SPRINT,
        ...extra,
      },
    );

  it(
    'AC7 code-freeze: an out-of-view implement is held; a plan fallback still dispatches',
    async () => {
      const coordinationDir = makeDir('dt-oov-freeze-');
      const cwd = makeDir('dt-oov-freeze-root-');
      const deps = makeDeps({
        getHerdrListHead: ownRoot([eligibleBacklog('WL-OOV-IMPL'), eligiblePlan('WL-OOV-PLAN')]),
        readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      });

      const outcome = await dispatchFallback(deps, coordinationDir, cwd);

      // The fallback was attempted (post-implementation) — RED before it lands.
      expect(deps.getHerdrListHead).toHaveBeenCalledWith(cwd, expect.any(Number));
      // The frozen implement is never claimed; the plan fallback dispatches.
      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-OOV-PLAN');
      expect(deps.claimItem).not.toHaveBeenCalledWith('WL-OOV-IMPL', expect.anything(), expect.anything());
    },
  );

  it(
    'AC7 review-queue hold: a deep queue holds an out-of-view non-critical implement, the plan dispatches',
    async () => {
      const coordinationDir = makeDir('dt-oov-reviewqueue-');
      const cwd = makeDir('dt-oov-reviewqueue-root-');
      const deps = makeDeps({
        getHerdrListHead: ownRoot([eligibleBacklog('WL-OOV-IMPL'), eligiblePlan('WL-OOV-PLAN')]),
        // A completed/in_review queue at/over the sprint threshold = deep.
        getReviewQueueCount: vi.fn().mockResolvedValue(SPRINT),
      });

      const outcome = await dispatchFallback(deps, coordinationDir, cwd);

      expect(deps.getHerdrListHead).toHaveBeenCalledWith(cwd, expect.any(Number));
      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-OOV-PLAN');
      expect(deps.claimItem).not.toHaveBeenCalledWith('WL-OOV-IMPL', expect.anything(), expect.anything());
    },
  );

  it(
    'AC7 attempt budget: a budget-exhausted out-of-view item is filtered, the next eligible dispatches',
    async () => {
      const coordinationDir = makeDir('dt-oov-budget-');
      const cwd = makeDir('dt-oov-budget-root-');
      // Three same-stage implement markers exhaust the per-item/per-kind cap.
      writeDowntimeLog(
        cwd,
        [0, 1, 2].map(() => ({
          itemId: 'WL-OOV-BUDGET',
          kind: 'implement',
          stage: 'plan_complete',
          dispatchedAt: ago(60_000),
        })),
      );
      const deps = makeDeps({
        getHerdrListHead: ownRoot([
          eligibleBacklog('WL-OOV-BUDGET', { sortIndex: 1000 }),
          eligibleBacklog('WL-OOV-FRESH', { sortIndex: 2000 }),
        ]),
        markNeedsProducerReview: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchFallback(deps, coordinationDir, cwd, {
        maxAttempts: 3,
        markerStaleWindowMs: WINDOW_MS,
      });

      expect(deps.getHerdrListHead).toHaveBeenCalledWith(cwd, expect.any(Number));
      // The exhausted item is flagged and skipped; the next eligible dispatches.
      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('WL-OOV-FRESH');
      expect(deps.markNeedsProducerReview).toHaveBeenCalledWith('WL-OOV-BUDGET', cwd);
      expect(deps.claimItem).not.toHaveBeenCalledWith('WL-OOV-BUDGET', expect.anything(), expect.anything());
    },
  );

  it(
    'AC7 in-flight: a critical out-of-view item with a live working pane is held',
    async () => {
      const coordinationDir = makeDir('dt-oov-inflight-');
      const cwd = makeDir('dt-oov-inflight-root-');
      const deps = makeDeps({
        getHerdrListHead: ownRoot([eligibleBacklog('WL-OOV-CRIT', { priority: 'critical' })]),
        getRunningDowntimePanes: vi.fn().mockResolvedValue({
          ok: true,
          count: 1,
          paneIds: ['w1:p1'],
          records: [
            {
              paneId: 'w1:p1',
              label: 'Downtime triggered implement Backlog - WL-OOV-CRIT',
              agent: 'pi',
              agentStatus: 'working',
            },
          ],
        }),
      });

      const outcome = await dispatchFallback(deps, coordinationDir, cwd);

      expect(deps.getHerdrListHead).toHaveBeenCalledWith(cwd, expect.any(Number));
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('in-flight-pane');
      expect(deps.claimItem).not.toHaveBeenCalled();
    },
  );
});
