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
  clampDowntimeMarkerStaleWindowMs,
  clampDowntimeMaxAttempts,
  resumeStalledWorkIfAble,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DOWNTIME_MAX_ATTEMPTS_MIN,
  DOWNTIME_MAX_ATTEMPTS_MAX,
  countFreeUnownedSlots,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
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
  appendDowntimeLogEntry,
  readDowntimeLogEntries,
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

describe('parseShowItemOutput audit verdict (WL-0MU308WSF0002JWN)', () => {
  it('reads the TOP-LEVEL auditResult verdict and timestamp', () => {
    const info = parseShowItemOutput(
      JSON.stringify({
        success: true,
        workItem: { id: 'WL-AUD', status: 'completed', stage: 'in_review' },
        auditResult: {
          workItemId: 'WL-AUD',
          readyToClose: false,
          auditedAt: '2026-01-02T00:00:00.000Z',
        },
      }),
    );
    expect(info).toMatchObject({
      id: 'WL-AUD',
      status: 'completed',
      stage: 'in_review',
      auditedAt: '2026-01-02T00:00:00.000Z',
      auditResult: false,
    });
  });

  it('leaves the verdict absent when auditResult is null (no audit recorded)', () => {
    const info = parseShowItemOutput(
      JSON.stringify({ success: true, workItem: { id: 'WL-AUD2', stage: 'in_review' }, auditResult: null }),
    );
    expect(info!.auditResult).toBeUndefined();
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
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-I', { status: 'open', stage: 'idea' }, '/repo');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:intake WL-CRIT-I'),
      { model: 'plan', cwd: '/repo', itemId: 'WL-CRIT-I', itemTitle: 'Critical idea WL-CRIT-I' },
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
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-R', { status: 'open', stage: 'intake_complete' }, '/repo');
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
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-P', { status: 'open', stage: 'plan_complete' }, '/repo');
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
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-R', { status: 'open', stage: 'intake_complete' }, '/repo');
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
    expect(deps.claimItem).toHaveBeenCalledWith('WL-BLOCKER', { status: 'open', stage: 'intake_complete' }, '/repo');
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

// ── needsProducerReview exclusion (WL-0MTIAL65N004T22F) ─────────────
// AC1–AC4: every tier (audit / implement / plan / intake / critical-first
// including frontier blockers and the coordination leader path) excludes
// items with needsProducerReview === true; absent/false/undefined is
// dispatchable; failed/unparseable parsing is fail-safe; clearing the flag
// makes the item dispatchable again.

describe('needsProducerReview exclusion', () => {
  const auditDated = () => new Date(Date.now() - 1000).toISOString();
  const auditCandidate = (overrides: Partial<AuditCandidate> = {}): AuditCandidate => ({
    id: `AUD-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Audit candidate',
    sortIndex: 1,
    updatedAt: auditDated(),
    ...overrides,
  });
  const implementCandidate = (overrides: Partial<ImplementCandidate> = {}): ImplementCandidate => ({
    id: `IMP-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Implement candidate',
    status: 'open',
    risk: 'low',
    effort: 'small',
    sortIndex: 1,
    ...overrides,
  });
  const nextCandidate = (overrides: Partial<DowntimeCandidate> = {}): DowntimeCandidate => ({
    id: `NEXT-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Next candidate',
    stage: 'intake_complete',
    status: 'open',
    sortIndex: 1,
    ...overrides,
  });
  const critCandidate = (overrides: Partial<CriticalCandidate> = {}): CriticalCandidate => ({
    id: `CR-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Critical candidate',
    status: 'open',
    stage: 'idea',
    sortIndex: 1,
    ...overrides,
  });

  describe('selectAuditCandidate', () => {
    it('excludes needsProducerReview === true candidates', () => {
      const blockedAudit = auditCandidate({ id: 'A1', needsProducerReview: true, sortIndex: 1 });
      const allowedAudit = auditCandidate({ id: 'A2', sortIndex: 10 });
      const sel = selectAuditCandidate([blockedAudit, allowedAudit]);
      expect(sel?.id).toBe('A2');
    });
    it('absent/false/undefined needsProducerReview remain dispatchable', () => {
      const falsy = auditCandidate({ id: 'A3', needsProducerReview: false, sortIndex: 1 });
      const absent = auditCandidate({ id: 'A4', sortIndex: 2 });
      expect(selectAuditCandidate([falsy])?.id).toBe('A3');
      expect(selectAuditCandidate([absent])?.id).toBe('A4');
    });
    it('returns null when the tier contains only review-gated candidates', () => {
      const b = auditCandidate({ id: 'A5', needsProducerReview: true, sortIndex: 1 });
      expect(selectAuditCandidate([b])).toBeNull();
    });
    it('clearing needsProducerReview makes the item dispatchable again', () => {
      const c = auditCandidate({ id: 'A6', needsProducerReview: true, sortIndex: 1 });
      expect(selectAuditCandidate([c])).toBeNull();
      // Clear the flag — same candidate object, flag removed → dispatchable.
      c.needsProducerReview = false;
      expect(selectAuditCandidate([c])?.id).toBe('A6');
    });
  });

  describe('selectImplementCandidate', () => {
    it('excludes needsProducerReview === true candidates', () => {
      const blocked = implementCandidate({ id: 'I1', needsProducerReview: true, sortIndex: 1 });
      const allowed = implementCandidate({ id: 'I2', sortIndex: 10 });
      const sel = selectImplementCandidate([blocked, allowed] as ImplementCandidate[]);
      expect(sel?.id).toBe('I2');
    });
    it('absent/false remain dispatchable', () => {
      expect(selectImplementCandidate([implementCandidate({ id: 'I3', needsProducerReview: false, sortIndex: 1 })] as ImplementCandidate[])?.id).toBe('I3');
      expect(selectImplementCandidate([implementCandidate({ id: 'I4', sortIndex: 1 })] as ImplementCandidate[])?.id).toBe('I4');
    });
    it('returns null when only review-gated candidates remain', () => {
      expect(selectImplementCandidate([implementCandidate({ id: 'I5', needsProducerReview: true, sortIndex: 1 })] as ImplementCandidate[])).toBeNull();
    });
    it('clearing the flag makes the item dispatchable again', () => {
      const c = implementCandidate({ id: 'I6', needsProducerReview: true, sortIndex: 1 });
      expect(selectImplementCandidate([c] as ImplementCandidate[])).toBeNull();
      c.needsProducerReview = false;
      expect(selectImplementCandidate([c] as ImplementCandidate[])?.id).toBe('I6');
    });
  });

  describe('selectNextCandidate', () => {
    it('excludes needsProducerReview === true candidates', () => {
      const blocked = nextCandidate({ id: 'N1', needsProducerReview: true, sortIndex: 1, stage: 'intake_complete' });
      const allowed = nextCandidate({ id: 'N2', sortIndex: 10, stage: 'intake_complete' });
      expect(selectNextCandidate([blocked, allowed])?.id).toBe('N2');
    });
    it('absent/false remain dispatchable', () => {
      expect(selectNextCandidate([nextCandidate({ id: 'N3', needsProducerReview: false, sortIndex: 1 })])?.id).toBe('N3');
      expect(selectNextCandidate([nextCandidate({ id: 'N4', sortIndex: 1 })])?.id).toBe('N4');
    });
    it('returns null when only review-gated candidates remain', () => {
      expect(selectNextCandidate([nextCandidate({ id: 'N5', needsProducerReview: true, sortIndex: 1 })])).toBeNull();
    });
    it('clearing the flag makes the item dispatchable again', () => {
      const c = nextCandidate({ id: 'N6', needsProducerReview: true, sortIndex: 1 });
      expect(selectNextCandidate([c])).toBeNull();
      c.needsProducerReview = false;
      expect(selectNextCandidate([c])?.id).toBe('N6');
    });
  });

  describe('selectCriticalCandidate', () => {
    it('excludes needsProducerReview === true candidates', () => {
      const blocked = critCandidate({ id: 'C1', needsProducerReview: true, sortIndex: 1 });
      const allowed = critCandidate({ id: 'C2', sortIndex: 10 });
      expect(selectCriticalCandidate([blocked, allowed] as never)?.id).toBe('C2');
    });
    it('absent/false remain dispatchable', () => {
      expect(selectCriticalCandidate([critCandidate({ id: 'C3', needsProducerReview: false, sortIndex: 1 })] as never)?.id).toBe('C3');
      expect(selectCriticalCandidate([critCandidate({ id: 'C4', sortIndex: 1 })] as never)?.id).toBe('C4');
    });
    it('returns null when only review-gated criticals remain', () => {
      expect(selectCriticalCandidate([critCandidate({ id: 'C5', needsProducerReview: true })] as never)).toBeNull();
    });
  });

  describe('resolveDependencyFrontier (AC2)', () => {
    it('resolves to null when the only blocker is review-gated', async () => {
      const crit: CriticalCandidate = critCandidate({ id: 'C6', stage: 'plan_complete', risk: 'low', effort: 'medium' });
      const fetchBlockers = async (_id: string): Promise<CriticalCandidate[] | null> => [
        { id: 'B1', title: 'Review-gated blocker', status: 'open', stage: 'idea', needsProducerReview: true },
      ];
      expect(await resolveDependencyFrontier(crit, fetchBlockers)).toBeNull();
    });
    it('skips a review-gated direct blocker and still reaches an open ancestor beneath a non-dispatchable wrapper', async () => {
      const crit: CriticalCandidate = critCandidate({ id: 'C7', stage: 'plan_complete', risk: 'low', effort: 'medium' });
      const fetchBlockers = async (id: string): Promise<CriticalCandidate[] | null> => {
        if (id === 'C7') return [{ id: 'MID', title: 'Non-dispatchable wrapper', status: 'open', stage: 'in_review', needsProducerReview: true }];
        if (id === 'MID') return [{ id: 'DEEP', title: 'Open deep blocker', status: 'open', stage: 'idea' }];
        return [];
      };
      // Walk recurses through MID (non-dispatchable but has open descendant) → DEEP.
      expect((await resolveDependencyFrontier(crit, fetchBlockers))?.id).toBe('DEEP');
    });
    it('review-gated plan_complete blockers are excluded (caps-covered + flag)', async () => {
      const crit: CriticalCandidate = critCandidate({ id: 'C8', stage: 'plan_complete', risk: 'low', effort: 'medium' });
      const fetchBlockers = async (_id: string): Promise<CriticalCandidate[] | null> => [
        { id: 'B2', title: 'Gated plan_complete', status: 'open', stage: 'plan_complete', risk: 'low', effort: 'small', needsProducerReview: true },
      ];
      expect(await resolveDependencyFrontier(crit, fetchBlockers)).toBeNull();
    });
  });

  describe('classifyItemForDispatch', () => {
    it('returns null immediately when needsProducerReview === true (AC1 — every tier)', () => {
      for (const info of [
        { id: 'X', status: 'completed', stage: 'in_review', updatedAt: new Date().toISOString(), needsProducerReview: true },
        { id: 'X', status: 'open', stage: 'plan_complete', risk: 'low', effort: 'medium', needsProducerReview: true },
        { id: 'X', status: 'open', stage: 'intake_complete', needsProducerReview: true },
        { id: 'X', status: 'open', stage: 'idea', needsProducerReview: true },
      ] as DowntimeItemInfo[]) {
        expect(classifyItemForDispatch(info)).toBeNull();
      }
    });
    it('dispatches normally when needsProducerReview is false/undefined', () => {
      expect(classifyItemForDispatch({ id: 'I', status: 'open', stage: 'idea', needsProducerReview: false } as DowntimeItemInfo)).toBe('intake');
      expect(classifyItemForDispatch({ id: 'I', status: 'open', stage: 'idea' } as DowntimeItemInfo)).toBe('intake');
    });

    // ── risk-effort dispatch for missing risk/effort (WL-0MTTSWCJR003OMN7) ──
    it('returns risk-effort for plan_complete items with missing risk', () => {
      const info = { id: 'RE1', status: 'open', stage: 'plan_complete', risk: '', effort: 'small' } as DowntimeItemInfo;
      expect(classifyItemForDispatch(info)).toBe('risk-effort');
    });
    it('returns risk-effort for plan_complete items with missing effort', () => {
      const info = { id: 'RE2', status: 'open', stage: 'plan_complete', risk: 'low', effort: '' } as DowntimeItemInfo;
      expect(classifyItemForDispatch(info)).toBe('risk-effort');
    });
    it('returns risk-effort for plan_complete items with both risk and effort missing', () => {
      const info = { id: 'RE3', status: 'open', stage: 'plan_complete', risk: '', effort: '' } as DowntimeItemInfo;
      expect(classifyItemForDispatch(info)).toBe('risk-effort');
    });
    it('returns risk-effort for plan_complete items with undefined risk/effort', () => {
      expect(classifyItemForDispatch({ id: 'RE4', status: 'open', stage: 'plan_complete' } as DowntimeItemInfo)).toBe('risk-effort');
      expect(classifyItemForDispatch({ id: 'RE5', status: 'open', stage: 'plan_complete', risk: null, effort: null } as DowntimeItemInfo)).toBe('risk-effort');
    });
    it('does NOT dispatch risk-effort when plan_complete has valid risk/effort within caps', () => {
      expect(classifyItemForDispatch({ id: 'RE6', status: 'open', stage: 'plan_complete', risk: 'low', effort: 'small' } as DowntimeItemInfo)).toBe('implement');
      expect(classifyItemForDispatch({ id: 'RE7', status: 'open', stage: 'plan_complete', risk: 'medium', effort: 'medium' } as DowntimeItemInfo)).toBe('implement');
    });
    it('classifies ABOVE-cap risk as implement (risk cap removed — high/severe no longer excluded)', () => {
      expect(classifyItemForDispatch({ id: 'RE8', status: 'open', stage: 'plan_complete', risk: 'high', effort: 'small' } as DowntimeItemInfo)).toBe('implement');
      expect(classifyItemForDispatch({ id: 'RE8b', status: 'open', stage: 'plan_complete', risk: 'critical', effort: 'small' } as DowntimeItemInfo)).toBe('implement');
      expect(classifyItemForDispatch({ id: 'RE8c', status: 'open', stage: 'plan_complete', risk: 'severe', effort: 'medium' } as DowntimeItemInfo)).toBe('implement');
    });
    it('returns null when plan_complete has valid effort but ABOVE cap (extra large)', () => {
      expect(classifyItemForDispatch({ id: 'RE9', status: 'open', stage: 'plan_complete', risk: 'low', effort: 'extra large' } as DowntimeItemInfo)).toBeNull();
    });

    // ── blocked status is dispatchable (WL-0MUBUA9C8009N0K5 AC1) ──
    it('classifies blocked items to their stage-appropriate kind', () => {
      expect(classifyItemForDispatch({ id: 'B1', status: 'blocked', stage: 'idea' } as DowntimeItemInfo)).toBe('intake');
      expect(classifyItemForDispatch({ id: 'B2', status: 'blocked', stage: 'intake_complete' } as DowntimeItemInfo)).toBe('plan');
      expect(classifyItemForDispatch({ id: 'B3', status: 'blocked', stage: 'plan_complete', risk: 'high', effort: 'small' } as DowntimeItemInfo)).toBe('implement');
    });
    it('still excludes blocked items needing producer review', () => {
      expect(classifyItemForDispatch({ id: 'B4', status: 'blocked', stage: 'idea', needsProducerReview: true } as DowntimeItemInfo)).toBeNull();
    });
    it('does not classify a blocked item with a non-dispatchable stage', () => {
      expect(classifyItemForDispatch({ id: 'B5', status: 'blocked', stage: 'in_review' } as DowntimeItemInfo)).toBeNull();
      expect(classifyItemForDispatch({ id: 'B6', status: 'blocked', stage: 'done' } as DowntimeItemInfo)).toBeNull();
    });

    // ── retired in_progress stage (WL-0MTTSWCJR003OMN7 — OSL dead zones) ──
    it('dispatches risk-effort for open/in_progress items (retired stage)', () => {
      expect(classifyItemForDispatch({ id: 'IP1', status: 'open', stage: 'in_progress' } as DowntimeItemInfo)).toBe('risk-effort');
      expect(classifyItemForDispatch({ id: 'IP2', status: 'open', stage: 'in_progress', risk: 'low' } as DowntimeItemInfo)).toBe('risk-effort');
      expect(classifyItemForDispatch({ id: 'IP3', status: 'open', stage: 'in_progress', risk: 'low', effort: 'small' } as DowntimeItemInfo)).toBe('risk-effort');
    });
    it('still blocks npr items on in_progress stage', () => {
      expect(classifyItemForDispatch({ id: 'IP4', status: 'open', stage: 'in_progress', needsProducerReview: true } as DowntimeItemInfo)).toBeNull();
    });
  });

  describe('selectCriticalFirstCandidates — blocked critical items (AC2)', () => {
    const crit = (over: Partial<DowntimeHerdrItem>): DowntimeHerdrItem => ({
      id: 'C',
      title: 'Crit',
      status: 'open',
      stage: 'idea',
      priority: 'critical',
      sortIndex: 1,
      ...over,
    });

    it('includes a blocked critical item at its stage-appropriate kind', () => {
      const out = selectCriticalFirstCandidates([
        crit({ id: 'C-BLOCKED-PLAN', status: 'blocked', stage: 'intake_complete' }),
        crit({ id: 'C-BLOCKED-IMPL', status: 'blocked', stage: 'plan_complete', risk: 'High', effort: 'S' }),
      ]);
      expect(out.map((c) => [c.item.id, c.kind])).toEqual([
        ['C-BLOCKED-PLAN', 'plan'],
        ['C-BLOCKED-IMPL', 'implement'],
      ]);
    });

    it('includes open and blocked critical items ordered by sortIndex', () => {
      const out = selectCriticalFirstCandidates([
        crit({ id: 'C-OPEN', status: 'open', stage: 'idea', sortIndex: 20 }),
        crit({ id: 'C-BLOCKED', status: 'blocked', stage: 'idea', sortIndex: 10 }),
      ]);
      expect(out.map((c) => c.item.id)).toEqual(['C-BLOCKED', 'C-OPEN']);
    });

    it('still excludes blocked critical items needing producer review', () => {
      const out = selectCriticalFirstCandidates([
        crit({ id: 'C-NPR', status: 'blocked', stage: 'idea', needsProducerReview: true }),
      ]);
      expect(out).toEqual([]);
    });

    it('does not select a non-critical blocked item', () => {
      const out = selectCriticalFirstCandidates([
        crit({ id: 'C-OTHER', status: 'blocked', stage: 'idea', priority: 'high' }),
      ]);
      expect(out).toEqual([]);
    });
  });

  describe('blocked candidate claim CAS (AC3)', () => {
    it('claims a blocked candidate with its actual blocked status as the CAS guard', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          { id: 'B-PLAN', title: 'Blocked plan', status: 'blocked', stage: 'intake_complete', priority: 'critical', sortIndex: 1 },
        ]}),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('B-PLAN');
      // The CAS guard must match the item's ACTUAL status, not the tier's
      // nominal `open` — otherwise the claim aborts as stale.
      expect(deps.claimItem).toHaveBeenCalledWith(
        'B-PLAN',
        { status: 'blocked', stage: 'intake_complete' },
        '/repo',
      );
    });
  });

  describe('parse* preserves needsProducerReview (AC4 fail-safe)', () => {
    it('parseNextCandidatesOutput preserves true/undefined/absent per candidate', () => {
      const out = JSON.stringify({
        workItems: [
          { workItem: { id: 'P1', title: 'A', status: 'open', priority: 'medium', needsProducerReview: 1 } },
          { workItem: { id: 'P2', title: 'B', status: 'open', priority: 'medium', needsProducerReview: 0 } },
          { workItem: { id: 'P3', title: 'C', status: 'open', priority: 'medium', needsProducerReview: true } },
          { workItem: { id: 'P4', title: 'D', status: 'open', priority: 'medium' } },
        ],
      });
      const c = parseNextCandidatesOutput(out, 'intake_complete')!;
      expect(c.find((x) => x.id === 'P1')!.needsProducerReview).toBe(true);
      expect(c.find((x) => x.id === 'P2')!.needsProducerReview).toBe(false);
      expect(c.find((x) => x.id === 'P3')!.needsProducerReview).toBe(true);
      expect(c.find((x) => x.id === 'P4')!.needsProducerReview).toBeUndefined();
    });
    it('parseImplementCandidatesOutput preserves needsProducerReview', () => {
      const out = JSON.stringify({
        workItems: [{ workItem: { id: 'IM', title: 'X', status: 'open', risk: 'low', effort: 'small', needsProducerReview: true } }],
      });
      expect(parseImplementCandidatesOutput(out)![0]!.needsProducerReview).toBe(true);
    });
    it('parseAuditCandidatesOutput preserves needsProducerReview', () => {
      const out = JSON.stringify({
        workItems: [{ id: 'AU', title: 'A', auditedAt: null, updatedAt: new Date().toISOString(), needsProducerReview: true }],
      });
      expect(parseAuditCandidatesOutput(out)![0]!.needsProducerReview).toBe(true);
    });
    it('parseCriticalCandidatesOutput preserves needsProducerReview', () => {
      const out = JSON.stringify({
        workItems: [{ id: 'CR', title: 'A', status: 'open', stage: 'idea', needsProducerReview: true }],
      });
      expect(parseCriticalCandidatesOutput(out)![0]!.needsProducerReview).toBe(true);
    });
    it('parseShowItemOutput preserves needsProducerReview', () => {
      const out = JSON.stringify({ success: true, workItem: { id: 'SH', title: 'shown', status: 'open', stage: 'idea', needsProducerReview: true } });
      expect(parseShownWorkItem(out)!.needsProducerReview).toBe(true);
    });
    it('dispatch falls through when every candidate in every tier needs review (no-candidate, not wl-error)', async () => {
      // Every tier returns a flagged candidate (or empty) → no-candidate, never a strike.
      const deps2 = makeDeps({
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: { id: 'A-B', title: 'A-B', stage: 'audit', needsProducerReview: true } }),
        getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: false }),
        hasFreshAudit: vi.fn().mockResolvedValue(false),
        getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
        getNextImplementCandidate: vi.fn().mockResolvedValue(null),
        getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      });
      // Audit tier candidate is review-gated → skipped → falls through to no-candidate.
      const outcome = await dispatchDowntimeWork(deps2, { model: 'plan', cwd: '/repo' });
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
    });
  });

  describe('transient retry (WL-0MTOTCETU004YYIU AC3 — bounded backoff)', () => {
    describe('isTransientDowntimeError', () => {
      it('classifies SQLITE_BUSY variants as transient', () => {
        expect(isTransientDowntimeError('SQLITE_BUSY: database is locked')).toBe(true);
        expect(isTransientDowntimeError('SQLITE BUSY: database is locked')).toBe(true);
        expect(isTransientDowntimeError('database is locked')).toBe(true);
        expect(isTransientDowntimeError('database table is locked')).toBe(true);
        expect(isTransientDowntimeError('database busy')).toBe(true);
      });
      it('does not classify timeout/hang as transient (retry would triple 10s wall-clock)', () => {
        // ETIMEDOUT / "timed out" is a hung child (10s per attempt); retrying
        // would be 30s and risks DOWNTIME_RUN_TIMEOUT_MS — strikes correctly.
        expect(isTransientDowntimeError('ETIMEDOUT')).toBe(false);
        expect(isTransientDowntimeError('timed out after 10000ms')).toBe(false);
        expect(isTransientDowntimeError('spawn ETIMEDOUT')).toBe(false);
        expect(isTransientDowntimeError('exceeded timeout of 10000ms')).toBe(false);
        expect(isTransientDowntimeError('operation timeout')).toBe(false);
        expect(isTransientDowntimeError('TIMED OUT')).toBe(false);
      });
      it('is case-insensitive', () => {
        expect(isTransientDowntimeError('Sqlite_Busy: DATABASE IS LOCKED')).toBe(true);
        expect(isTransientDowntimeError('DATABASE BUSY')).toBe(true);
      });
      it('does not classify parse/author-gate errors as transient', () => {
        expect(isTransientDowntimeError('show parse error')).toBe(false);
        expect(isTransientDowntimeError('audit list parse error')).toBe(false);
        expect(isTransientDowntimeError('author identity gate')).toBe(false);
        expect(isTransientDowntimeError('needsProducerReview gate')).toBe(false);
        expect(isTransientDowntimeError('')).toBe(false);
        expect(isTransientDowntimeError('some random error')).toBe(false);
      });
    });

    describe('withTransientRetry', () => {
      it('succeeds on first try without retry', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        await expect(withTransientRetry(fn, 2, 1)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
      });
      it('retries once on transient then succeeds (no strike)', async () => {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
          .mockResolvedValueOnce('ok');
        await expect(withTransientRetry(fn, 2, 1)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
      });
      it('retries twice on two transients then succeeds', async () => {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
          .mockRejectedValueOnce(new Error('database is locked'))
          .mockResolvedValueOnce('ok');
        await expect(withTransientRetry(fn, 2, 1)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
      });
      it('retries up to limit then throws (single strike, not three)', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
        await expect(withTransientRetry(fn, 2, 1)).rejects.toThrow('SQLITE_BUSY');
        expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
      });
      it('fails fast on non-transient (no retry)', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('show parse error'));
        await expect(withTransientRetry(fn, 2, 1)).rejects.toThrow('show parse error');
        expect(fn).toHaveBeenCalledTimes(1);
      });
      it('fails fast on second attempt if second error is non-transient', async () => {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
          .mockRejectedValueOnce(new Error('show parse error'));
        await expect(withTransientRetry(fn, 2, 1)).rejects.toThrow('show parse error');
        expect(fn).toHaveBeenCalledTimes(2);
      });
      it('does not retry timeout variants (fail fast — one strike)', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('timed out after 10000ms'));
        await expect(withTransientRetry(fn, 2, 1)).rejects.toThrow('timed out');
        expect(fn).toHaveBeenCalledTimes(1);
      });
      it('handles non-Error thrown values', async () => {
        const fn = vi
          .fn()
          .mockRejectedValueOnce('SQLITE_BUSY: database is locked')
          .mockResolvedValueOnce('ok');
        await expect(withTransientRetry(fn, 2, 1)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
      });
    });
  });
});

// ── Review-queue depth gate (WL-0MT2UQWOR007CYY9) ──────────────────────
// The implement tier is gated by the depth of the completed/in_review review
// queue: when root items >= browseItemCount, only critical-priority
// implement candidates remain eligible. The gate is re-read live on every
// dispatch (no plugin restart needed), fail-closed on wl error (gate active),
// and uses a neutral reason ('review-queue-hold') when plan/intake are also empty
// — never 'no-candidate', so the worker's cooldown is not triggered.

// ── Review-queue depth gate (WL-0MT2UQWOR007CYY9) ──────────────────────
// The implement tier is gated by the depth of the completed/in_review review
// queue: when root items >= browseItemCount, only critical-priority
// implement candidates remain eligible. The gate is re-read live on every
// dispatch (no plugin restart needed), fail-closed on wl error (gate active),
// and uses a neutral reason ('review-queue-hold') when plan/intake are also empty
// — never 'no-candidate', so the worker's cooldown is not triggered.

describe('review-queue depth gate (WL-0MT2UQWOR007CYY9)', () => {
  const implementCandidate = (overrides: Partial<ImplementCandidate> = {}): ImplementCandidate => ({
    id: `IMP-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Implement candidate',
    status: 'open',
    risk: 'low',
    effort: 'small',
    sortIndex: 1,
    ...overrides,
  });

  const planCandidate: DowntimeCandidate = { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete' };

  // ── AC1: critical bypass ───────────────────────────────────────────
  it('AC1: a critical-priority implement candidate always dispatches regardless of queue depth', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-CRIT', priority: 'critical' }),
      ),
      getReviewQueueCount: vi.fn().mockResolvedValue(999), // deeply queued
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(deps.claimItem).toHaveBeenCalledWith('IMP-CRIT', { status: 'open', stage: 'plan_complete' }, '/repo');
  });

  it('AC1: critical bypass works even when browseItemCount is 1 (queue deep)', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-CRIT2', priority: 'critical' }),
      ),
      getReviewQueueCount: vi.fn().mockResolvedValue(1), // exactly at threshold
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 1 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
  });

  // ── AC2: gate inactive — all priorities eligible ───────────────────
  it('AC2: when reviewQueueCount < browseItemCount, all priorities dispatch unchanged', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-MED', priority: 'medium' }),
      ),
      getReviewQueueCount: vi.fn().mockResolvedValue(10), // under threshold
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(deps.claimItem).toHaveBeenCalledWith('IMP-MED', { status: 'open', stage: 'plan_complete' }, '/repo');
  });

  it('AC2: gate inactive — non-critical (high/low) dispatches when under threshold', async () => {
    for (const priority of ['high', 'low'] as const) {
      const deps = makeDeps({
        getNextImplementCandidate: vi.fn().mockResolvedValue(
          implementCandidate({ id: `IMP-${priority}`, priority }),
        ),
        getReviewQueueCount: vi.fn().mockResolvedValue(0),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
    }
  });

  // ── AC3: gate active — non-critical excluded ───────────────────────
  it('AC3: when reviewQueueCount == browseItemCount, non-critical candidates are excluded', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-NONCRIT', priority: 'high' }),
      ),
      getReviewQueueCount: vi.fn().mockResolvedValue(20), // at threshold
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    // Non-critical candidate gated → falls through to plan/intake
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('AC3: gate active — only non-critical candidates: implement resolves null, falls through to plan', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-LOW', priority: 'low' }),
      ),
      getReviewQueueCount: vi.fn().mockResolvedValue(25),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    // Plan tier should be reached
    expect(deps.getNextItem).toHaveBeenCalledWith('intake_complete', '/repo');
  });

  it('AC3: gate boundary — count == browseItemCount - 1: gate NOT active, all priorities dispatch', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-UNDER', priority: 'high' }),
      ),
      getReviewQueueCount: vi.fn().mockResolvedValue(19), // one below threshold
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
  });

  it('AC3: gate boundary — count == browseItemCount: gate active, non-critical excluded', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-AT', priority: 'high' }),
      ),
      getReviewQueueCount: vi.fn().mockResolvedValue(20),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    // Non-critical gated, no plan/intake → review-queue-hold
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('review-queue-hold');
  });

  // ── AC4: gate applies ONLY to implement tier ───────────────────────
  it('AC4: audit tier is NOT affected by the review-queue gate', async () => {
    const auditCandidate: DowntimeCandidate = { id: 'WL-AUD', title: 'Audit me', stage: 'audit' };
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getReviewQueueCount: vi.fn().mockResolvedValue(999), // deeply queued
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-GATED', priority: 'high' }),
      ),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    // Audit tier still dispatches regardless of review-queue depth
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
  });

  it('AC4: plan tier dispatches even when the review-queue gate is deep', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-GATED', priority: 'high' }),
      ),
      getReviewQueueCount: vi.fn().mockResolvedValue(999),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  // ── AC5: bounded timeout and fail-closed ───────────────────────────
  it('AC5: a getReviewQueueCount error (null) activates the gate — only critical dispatches', async () => {
    const deps = makeDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(null), // gate active on error
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-NONCRIT', priority: 'medium' }),
      ),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    // Non-critical gated by error → review-queue-hold (no-candidate not triggered)
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('review-queue-hold');
  });

  it('AC5: fail-closed — queue error + critical candidate: critical still dispatches', async () => {
    const deps = makeDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(null), // gate active on error
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-CRIT', priority: 'critical' }),
      ),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
  });

  // ── AC6: neutral reason (never 'no-candidate') ─────────────────────
  it('AC6: gate skip with empty plan AND intake reports review-queue-hold, never no-candidate', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-GATED', priority: 'high' }),
      ),
      getReviewQueueCount: vi.fn().mockResolvedValue(25),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }), // plan empty
      // intake (idea tier) is attempted but the review-queue-hold check short-circuits
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    // Gate skip with empty plan/intake → review-queue-hold, NOT no-candidate
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('review-queue-hold');
    // No cooldown triggered — polling continues
  });

  it('AC6: non-gated empty backlog still reports no-candidate (unchanged)', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(null),
      getReviewQueueCount: vi.fn().mockResolvedValue(0), // not gated
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
  });

  // ── Default browseItemCount ────────────────────────────────────────
  it('uses default browseItemCount of 20 when not provided', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-DEFAULT', priority: 'high' }),
      ),
      getReviewQueueCount: vi.fn().mockResolvedValue(20),
      // No browseItemCount passed — defaults to 20
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Gate active at default threshold → non-critical excluded
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('review-queue-hold');
  });

  it('default browseItemCount — count 19 still dispatches non-critical', async () => {
    const deps = makeDeps({
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-DEFAULT', priority: 'high' }),
      ),
      getReviewQueueCount: vi.fn().mockResolvedValue(19),
      // No browseItemCount — defaults to 20
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
  });

  // ── Root-only counting ─────────────────────────────────────────────
  it('root-only: the queue count uses --root-only (child items excluded)', async () => {
    // This tests the implementation uses the correct wl query. The
    // getReviewQueueCount mock returns whatever the caller passes.
    // The real implementation uses --root-only so children are excluded.
    const deps = makeDeps({
      getReviewQueueCount: vi.fn().mockResolvedValue(5),
      getNextImplementCandidate: vi.fn().mockResolvedValue(
        implementCandidate({ id: 'IMP-ROOT', priority: 'high' }),
      ),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

    // Under threshold → gate not active → implement dispatches
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
  });
});

// ── Review-queue depth gate on the LIVE Herdr-head path (WL-0MTTSWC1X005P4VD) ──
// Root cause B2: the original gate lived ONLY in the legacy tier chain, which
// is unreachable while the Herdr head is non-empty (the production state), so
// non-critical implements kept dispatching into a deep review queue. These
// tests pin the gate on the LIVE `dispatchFromHerdrList` path (exercised via
// `dispatchDowntimeWork` with a populated `getHerdrListHead`): audits (the
// queue drain), plan, intake and critical implements flow unconditionally;
// only NON-CRITICAL implement candidates are held; a deep queue with nothing
// audit-needed reports 'review-queue-hold' (never 'no-candidate').

describe('review-queue depth gate — live Herdr-head path (WL-0MTTSWC1X005P4VD)', () => {
  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString();
  const auditHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Audit ${id}`,
    status: 'completed',
    stage: 'in_review',
    updatedAt: fresh,
    sortIndex: 10,
  });
  const implementHead = (id: string, priority = 'high'): DowntimeHerdrItem => ({
    id,
    title: `Implement ${id}`,
    status: 'open',
    stage: 'plan_complete',
    risk: 'Low',
    effort: 'S',
    priority,
    sortIndex: 20,
  });
  const planHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Plan ${id}`,
    status: 'open',
    stage: 'intake_complete',
    sortIndex: 30,
  });
  const intakeHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Intake ${id}`,
    status: 'open',
    stage: 'idea',
    sortIndex: 40,
  });

  it('AC1: with a deep queue an AUDIT candidate still dispatches even behind a held non-critical implement', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1'), auditHead('AUD-1')] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(999),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(outcome.candidate?.id).toBe('AUD-1');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:audit AUD-1'),
      expect.anything(),
    );
  });

  it('AC1: an audit-first deep queue dispatches the audit (the gate is implement-only)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [auditHead('AUD-1'), implementHead('IMP-1')] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(999),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
  });

  it('AC2: a deep queue HOLDS a non-critical implement — nothing audit-needed left → review-queue-hold (never no-candidate)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(25),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('review-queue-hold');
    expect(outcome.reason).not.toBe('no-candidate');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('AC2: a CRITICAL implement dispatches even when the queue is deep', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-CRIT', 'critical')] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(999),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('IMP-CRIT');
  });

  it('AC2: PLAN and INTAKE candidates flow while the queue is deep', async () => {
    // Plan candidate deeper than a held implement → plan dispatches.
    const planDeps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1'), planHead('PLN-1')] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(999),
    });
    const planOutcome = await dispatchDowntimeWork(planDeps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
    expect(planOutcome.dispatched).toBe(true);
    expect(planOutcome.kind).toBe('plan');
    expect(planOutcome.candidate?.id).toBe('PLN-1');

    // Intake candidate behind a held implement → intake dispatches.
    const intakeDeps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1'), intakeHead('IDE-1')] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(999),
    });
    const intakeOutcome = await dispatchDowntimeWork(intakeDeps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
    expect(intakeOutcome.dispatched).toBe(true);
    expect(intakeOutcome.kind).toBe('intake');
    expect(intakeOutcome.candidate?.id).toBe('IDE-1');
  });

  it('shallow queue: a non-critical implement dispatches unchanged (threshold not met)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(10),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
  });

  it('AC5 boundary: count == browseItemCount HOLDS; count == browseItemCount - 1 dispatches', async () => {
    const atThreshold = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(20),
    });
    const held = await dispatchDowntimeWork(atThreshold, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
    expect(held.dispatched).toBe(false);
    expect(held.reason).toBe('review-queue-hold');

    const underThreshold = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(19),
    });
    const dispatched = await dispatchDowntimeWork(underThreshold, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
    expect(dispatched.dispatched).toBe(true);
    expect(dispatched.kind).toBe('implement');
  });

  it('AC5 fail-closed: a count-query failure (null) activates the gate on the live path', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(null),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('review-queue-hold');
  });

  it('the review gate is never consulted while frozen (code-freeze already pauses implements)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1'), planHead('PLN-1')] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(25),
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });
    // Freeze skips the implement; plan still dispatches. The gate read is
    // skipped entirely under a freeze (single shared read in the caller).
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });
});

// ── Worker keeps polling while the review queue is deep (WL-0MTTSWC1X005P4VD) ──
// RCA root cause A regression: queue depth used to WRITE the disable marker
// and early-return BEFORE leader-election/check-in (the 21:53Z silence). The
// sprint-complete auto-disable is removed; a deep queue only ever yields the
// neutral 'review-queue-hold' reason, which never triggers the no-candidate
// cooldown — the worker keeps checking in and keeps polling.

describe('worker keeps polling while the review queue is deep (WL-0MTTSWC1X005P4VD)', () => {
  // Both tests below install fake timers; restore the real clock after each
  // one so the leaked fake timer state cannot affect later describe blocks
  // (the split of the pane suites removed the earlier incidental
  // `vi.useRealTimers()` that previously masked this leak).
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDeepQueueWorker(overrides: Partial<DowntimeWorkerDeps> = {}) {
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
      // Deep queue + only a non-critical implement candidate remains.
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [] }),
      getReviewQueueCount: vi.fn().mockResolvedValue(25),
      getNextImplementCandidate: vi.fn().mockResolvedValue({
        id: 'IMP-HELD',
        title: 'Held implement',
        stage: 'implement',
        status: 'open',
        priority: 'high',
      }),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }), // plan+intake empty
      ...overrides,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg };
  }

  it('a deep queue never triggers the no-candidate cooldown (review-queue-hold is neutral)', async () => {
    vi.useFakeTimers();
    const start = 1_000_000;
    vi.setSystemTime(start);
    const { worker, deps } = makeDeepQueueWorker();
    await worker.tick(); // idle run starts
    expect(worker.idleSince).toBe(start);

    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    const at = await worker.tick();
    // Held: no dispatch, but NOT no-candidate → the worker must NOT pause.
    expect(at.dispatched).toBe(false);
    expect(at.polled).toBe(true);
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(0);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    // Queue thins below the threshold → dispatch resumes on the very next
    // idle tick (no stale cooldown blocking it — the neutral hold never
    // reset the idle run, so the warm run is immediately dispatchable).
    (deps.getReviewQueueCount as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    vi.setSystemTime(start + DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS + DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
    const resumed = await worker.tick();
    expect(resumed.dispatched).toBe(true);
    expect(worker.paused).toBe(false);
    // The implement pane actually spawned (tick results carry no kind field).
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:implement IMP-HELD'),
      expect.anything(),
    );
  });

  it('queue depth alone never short-circuits a tick (no disable marker write)', async () => {
    vi.useFakeTimers();
    const start = 2_000_000;
    vi.setSystemTime(start);
    const { worker } = makeDeepQueueWorker({ getReviewQueueCount: vi.fn().mockResolvedValue(999) });
    // Previously the sprint-complete auto-disable returned BEFORE the poll
    // ({polled:false}) when the count crossed browseItemCount. Now the worker
    // always polls — the deep queue only gates implement dispatch inside the
    // dispatch call (which returns the neutral review-queue-hold).
    const result = await worker.tick();
    expect(result.polled).toBe(true);
    expect(worker.paused).toBe(false);
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

// ── Owner lease + contention + pane liveness (parent WL-0MTYZXSLN008HZOW,
//    pane bound removed by WL-0MU2EP6JL006A1U3) ──────────────────────
//
// Regression suite for single-slot over-dispatch. The dispatcher must honour
// the Local Proxy owner lease, exclude owned slots from the free count, and
// back off on proxy contention. The RUNNING-PANE BOUND that was added
// alongside these is deliberately GONE (WL-0MU2EP6JL006A1U3): dispatched
// panes stay open until an operator closes them, so a live-pane count can
// never be the concurrency limiter — the LLM idle check is.

describe('parseLlamaStatus: contention + per-slot owner (AC5/AC6)', () => {
  const base = {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 1,
    total_slots: 1,
  };

  it('parses contention_queue_depth (the live gate signal) when served', () => {
    const status = parseLlamaStatus({ ...base, contention_queue_depth: 4 });
    expect(status).not.toBeNull();
    expect(status!.contention_queue_depth).toBe(4);
  });

  it('leaves contention_queue_depth undefined when absent (backward compatible)', () => {
    const status = parseLlamaStatus(base);
    expect(status).not.toBeNull();
    expect(status!.contention_queue_depth).toBeUndefined();
  });

  it('treats a negative or non-finite contention_queue_depth as ambiguous → busy', () => {
    expect(parseLlamaStatus({ ...base, contention_queue_depth: -1 })).toBeNull();
    expect(parseLlamaStatus({ ...base, contention_queue_depth: Number.NaN })).toBeNull();
    expect(parseLlamaStatus({ ...base, contention_queue_depth: 'many' })).toBeNull();
  });

  it('parses the cumulative contention_queued_count as telemetry (not a gate)', () => {
    const status = parseLlamaStatus({ ...base, contention_queued_count: 13 });
    expect(status).not.toBeNull();
    expect(status!.contention_queued_count).toBe(13);
  });

  it('leaves contention_queued_count undefined when absent (backward compatible)', () => {
    const status = parseLlamaStatus(base);
    expect(status).not.toBeNull();
    expect(status!.contention_queued_count).toBeUndefined();
  });

  it('treats a negative or non-finite contention_queued_count as ambiguous → busy', () => {
    expect(parseLlamaStatus({ ...base, contention_queued_count: -1 })).toBeNull();
    expect(parseLlamaStatus({ ...base, contention_queued_count: Number.NaN })).toBeNull();
    expect(parseLlamaStatus({ ...base, contention_queued_count: 'many' })).toBeNull();
  });

  it('keeps the live depth distinct from the cumulative count', () => {
    const status = parseLlamaStatus({
      ...base,
      contention_queue_depth: 0,
      contention_queued_count: 13,
    });
    expect(status).not.toBeNull();
    expect(status!.contention_queue_depth).toBe(0);
    expect(status!.contention_queued_count).toBe(13);
  });

  it('parses a per-slot owner_session_id', () => {
    const status = parseLlamaStatus({
      ...base,
      slots: [{ slot_id: 'slot-1', is_processing: false, owner_session_id: 'sess-1' }],
    });
    expect(status).not.toBeNull();
    expect(status!.slots![0].owner_session_id).toBe('sess-1');
  });

  it('omits owner_session_id from the slot shape when absent (backward compatible)', () => {
    const status = parseLlamaStatus({
      ...base,
      slots: [{ slot_id: 'slot-1', is_processing: false }],
    });
    expect(status).not.toBeNull();
    expect(status!.slots![0]).toEqual({ slot_id: 'slot-1', is_processing: false });
  });
});

// ── Critical-first scan on Herdr-head path (WL-0MU6UL3XY001M3VT) ──────
// Regression tests for the critical-first scan that bypasses non-safety
// filters (dispatched-marker, review-queue gate) for critical items on
// the Herdr-head dispatch path.

describe('critical-first scan on Herdr-head path (WL-0MU6UL3XY001M3VT)', () => {
  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString();

  const criticalPlanned = (id: string): DowntimeHerdrItem => ({
    id, title: `Critical plan ${id}`, status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'critical',
    sortIndex: 10,
  });
  const criticalIdea = (id: string): DowntimeHerdrItem => ({
    id, title: `Critical idea ${id}`, status: 'open', stage: 'idea',
    priority: 'critical',
    sortIndex: 20,
  });
  const criticalIntake = (id: string): DowntimeHerdrItem => ({
    id, title: `Critical intake ${id}`, status: 'open', stage: 'intake_complete',
    priority: 'critical',
    sortIndex: 30,
  });
  const nonCriticalImplement = (id: string): DowntimeHerdrItem => ({
    id, title: `Implement ${id}`, status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'medium',
    sortIndex: 100,
  });

  describe('AC4(a) — critical item bypasses non-safety filters', () => {
    it('a critical item with a stale dispatched marker dispatches ahead of a non-critical item', async () => {
      // End-to-end incident simulation: a critical plan item carries a
      // STANDING implement dispatch marker in the rolling log (its
      // implementation aborted → status reset to open, marker never
      // cleared). The normal loop would skip it forever; the critical-first
      // scan must bypass the marker and escalate it ahead of the
      // non-critical item.
      const root = mkdtempSync(join(tmpdir(), 'herdr-crit-scan-marker-'));
      mkdirSync(join(root, '.worklog'), { recursive: true });
      writeFileSync(
        join(root, '.worklog', 'downtime-dispatches.log'),
        JSON.stringify({
          at: new Date(now - 3_600_000).toISOString(),
          cwd: root,
          kind: 'implement',
          itemId: 'CR-1',
          stage: 'plan_complete',
          dispatchedAt: new Date(now - 3_600_000).toISOString(),
          message: 'Dispatched CR-1',
        }) + '\n',
      );
      try {
        const deps = makeDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
            criticalPlanned('CR-1'),
            nonCriticalImplement('IMP-1'),
          ]}),
          claimItem: vi.fn().mockResolvedValue({ ok: true }),
          spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
          recordDispatch: vi.fn().mockResolvedValue(true),
        });

        const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });

        expect(outcome.dispatched).toBe(true);
        expect(outcome.kind).toBe('implement');
        expect(outcome.candidate?.id).toBe('CR-1');
        expect(deps.claimItem).toHaveBeenCalledWith(
          'CR-1', { status: 'open', stage: 'plan_complete' }, root,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('critical item dispatches via risk-effort tier when stage is in_progress', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          {
            id: 'CR-2', title: 'Critical retired stage', status: 'open',
            stage: 'in_progress', priority: 'critical',
            risk: 'Low', effort: 'S', sortIndex: 10,
          },
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('risk-effort');
      expect(outcome.candidate?.id).toBe('CR-2');
    });

    it('a critical plan item dispatches via the plan tier (intake_complete stage)', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          criticalIntake('CR-PLAN'),
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('CR-PLAN');
    });

    it('a critical idea item dispatches via the intake tier', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          criticalIdea('CR-INTAKE'),
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('intake');
      expect(outcome.candidate?.id).toBe('CR-INTAKE');
    });
  });

  describe('AC4(b) — safety gates block critical escalation', () => {
    it('needsProducerReview === true blocks a critical item from critical-first scan', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          {
            ...criticalPlanned('CR-PR'),
            needsProducerReview: true,
          },
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      // Safety gate blocks critical → falls through to non-critical.
      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('IMP-1');
    });

    it('code-freeze blocks critical implement but allows critical plan/intake', async () => {
      const freezeDeps = makeDeps({
        readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          criticalPlanned('CR-FREEZE-IMP'),
          criticalIntake('CR-FREEZE-PLAN'),
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(freezeDeps, { model: 'plan', cwd: '/repo' });

      // Critical implement is freeze-blocked; critical plan dispatches.
      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('CR-FREEZE-PLAN');
    });

    it('active-audit single-flight is audit-tier scoped: an in-flight audit does not block open critical escalation', async () => {
      // The active-audit single-flight gate filters AUDIT-kind candidates
      // (a second audit pane must not start). An OPEN critical item is never
      // audit-kind, so — matching the legacy critical-tier ordering — it is
      // escalated even while an audit is in flight.
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          criticalPlanned('CR-AUDIT'),
          nonCriticalImplement('IMP-1'),
        ]}),
        getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: true }),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('CR-AUDIT');
    });
  });

  describe('lowest sortIndex wins when multiple critical items exist', () => {
    it('dispatches the lowest-sortIndex critical item first', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          criticalPlanned('CR-2'),  // sortIndex: 10
          criticalIdea('CR-1'),    // sortIndex: 20
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      // CR-2 has lower sortIndex (10) than CR-1 (20).
      expect(outcome.candidate?.id).toBe('CR-2');
    });
  });

  describe('no critical items — normal processing unchanged', () => {
    it('non-critical items dispatch as usual when no critical items exist', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('IMP-1');
    });
  });
});

// ── Herdr-head dispatch threads needsProducerReview (WL-0MU72WJ8C0005GIE) ──
//
// The live Herdr-head dispatch path (`dispatchFromHerdrList` → normal scan)
// builds its `classifyItemForDispatch` input from the Herdr item fields. Before
// the fix (022f1b24) it OMITTED `needsProducerReview`, so a non-critical item
// flagged for producer review was dispatched anyway — even though the offer
// path (`computeMostImportantItem`, which passes the item object directly)
// already honoured the flag. These tests pin AC1–AC3: the flag blocks a
// non-critical plan_complete / idea candidate, the direct path agrees with the
// offer path, and clearing the flag restores dispatchability.

describe('Herdr-head dispatch threads needsProducerReview (WL-0MU72WJ8C0005GIE)', () => {
  const implementItem = (id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem => ({
    id,
    title: `Non-critical ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'medium',
    risk: 'Low',
    effort: 'S',
    sortIndex: 10,
    ...overrides,
  });

  const intakeItem = (id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem => ({
    id,
    title: `Idea ${id}`,
    status: 'open',
    stage: 'idea',
    priority: 'medium',
    sortIndex: 10,
    ...overrides,
  });

  const dispatchDeps = (items: DowntimeHerdrItem[]): DowntimeWorkerDeps => makeDeps({
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
  });

  describe('AC2 — the flag blocks a non-critical candidate on dispatchDowntimeWork', () => {
    it('blocks a plan_complete item (implement) and dispatches the next eligible item', async () => {
      const deps = dispatchDeps([
        implementItem('NPR-GATED', { needsProducerReview: true, sortIndex: 1 }),
        implementItem('NPR-ALLOWED', { needsProducerReview: false, sortIndex: 2 }),
      ]);

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('NPR-ALLOWED');
      // The gated item was never claimed.
      expect(deps.claimItem).not.toHaveBeenCalledWith('NPR-GATED', expect.any(Object), '/repo');
    });

    it('blocks an idea item (intake) and dispatches the next eligible item', async () => {
      const deps = dispatchDeps([
        intakeItem('NPR-IDEA-GATED', { needsProducerReview: true, sortIndex: 1 }),
        intakeItem('NPR-IDEA-ALLOWED', { needsProducerReview: false, sortIndex: 2 }),
      ]);

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('intake');
      expect(outcome.candidate?.id).toBe('NPR-IDEA-ALLOWED');
      expect(deps.claimItem).not.toHaveBeenCalledWith('NPR-IDEA-GATED', expect.any(Object), '/repo');
    });

    it('dispatches nothing when every candidate is review-gated', async () => {
      const deps = dispatchDeps([
        implementItem('NPR-ONLY', { needsProducerReview: true }),
      ]);

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(deps.claimItem).not.toHaveBeenCalled();
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    });

    it('clearing the flag restores dispatchability (same item shape)', async () => {
      const gated = implementItem('NPR-CLEAR', { needsProducerReview: true });
      const blocked = await dispatchDowntimeWork(dispatchDeps([gated]), { model: 'plan', cwd: '/repo' });
      expect(blocked.dispatched).toBe(false);

      gated.needsProducerReview = false;
      const released = await dispatchDowntimeWork(dispatchDeps([gated]), { model: 'plan', cwd: '/repo' });
      expect(released.dispatched).toBe(true);
      expect(released.candidate?.id).toBe('NPR-CLEAR');
    });
  });

  describe('AC3 — direct and offer paths agree on the producer-review gate', () => {
    it('both the direct dispatch and the offer skip the gated item and pick the same next item', async () => {
      const items = [
        implementItem('NPR-PARITY-GATED', { needsProducerReview: true, sortIndex: 1 }),
        implementItem('NPR-PARITY-ALLOWED', { needsProducerReview: false, sortIndex: 2 }),
      ];

      const direct = await dispatchDowntimeWork(dispatchDeps(items), { model: 'plan', cwd: '/repo' });
      const offer = await computeMostImportantItem(dispatchDeps(items), '/repo');

      expect(direct.dispatched).toBe(true);
      expect(direct.candidate?.id).toBe('NPR-PARITY-ALLOWED');
      expect(offer).toMatchObject({ ok: true, candidate: { id: 'NPR-PARITY-ALLOWED' } });
    });

    it('the offer reports no candidate when every candidate is review-gated', async () => {
      const offer = await computeMostImportantItem(
        dispatchDeps([implementItem('NPR-OFFER-ONLY', { needsProducerReview: true })]),
        '/repo',
      );

      expect(offer).toMatchObject({ ok: true, noCandidate: true });
    });
  });
});

// ── RCA: duplicate re-dispatch of a critical in-flight item ─────────────
// Parent WL-0MUBEZ6PE002WLP4 / F1 WL-0MUBVKPLP006RRDJ (AC1.1).
//
// RED WITNESS (pre-fix). The critical-first scan
// (`dispatchFromHerdrList` → `selectCriticalFirstCandidates`) bypasses the
// dispatched-marker exclusion UNCONDITIONALLY, so the only thing preventing a
// second dispatch is the CAS claim inside `dispatchClaimedTier`. When the
// item's status has reverted to `open` at its marker's stage (H5 — e.g. an
// aborted `implement.py start` reset it, or `wl reviewed <id> true` released
// it) while the first dispatch's pane is still live, the CAS succeeds and a
// SECOND pane is spawned for the same in-flight item. H1 (marker bypass)
// therefore cannot duplicate on its own; H1+H5 is the confirmed pair.
//
// The item is modelled as `open` at `plan_complete` on BOTH cycles (the
// status revert) with a live `working` downtime pane whose label suffix is
// the item id (the in-flight signal F3 consumes) and a fresh marker in the
// rolling log (written by cycle 1's dispatch). The claim is stubbed to
// succeed on both cycles, matching the genuine DB `open` state.
//
// `it.fails` keeps the suite green while the defect is open: the test body
// asserts the FIXED behaviour and therefore fails pre-fix. F3
// (WL-0MUBVKXQJ000L8EO) flips it to `it` once the item-scoped in-flight
// guard lands; the RED→GREEN transition is the AC5.5 dependency evidence.
describe('RCA: critical in-flight re-dispatch with a live pane (WL-0MUBEZ6PE002WLP4 / AC1.1)', () => {
  const criticalInFlight = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Critical in-flight ${id}`,
    status: 'open',
    stage: 'plan_complete',
    risk: 'Low',
    effort: 'S',
    priority: 'critical',
    sortIndex: 10,
  });

  it(
    'two idle cycles over a critical item open at its marker stage with a live pane dispatch exactly once (RED pre-fix)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'herdr-crit-inflight-'));
      mkdirSync(join(root, '.worklog'), { recursive: true });
      // A fresh implement marker written by cycle 1's dispatch — the item is
      // STILL at the marker's dispatched-at stage (`plan_complete`) on cycle 2.
      writeFileSync(
        join(root, '.worklog', 'downtime-dispatches.log'),
        JSON.stringify({
          at: new Date().toISOString(),
          cwd: root,
          kind: 'implement',
          itemId: 'CR-DUP',
          stage: 'plan_complete',
          dispatchedAt: new Date().toISOString(),
          message: 'Dispatched CR-DUP',
        }) + '\n',
      );
      try {
        const deps = makeDeps({
          // The item is re-observed OPEN at its marker's stage on every cycle
          // (the status revert, H5). The critical-first scan re-selects it.
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalInFlight('CR-DUP')] }),
          // The CAS claim succeeds on both cycles because the DB genuinely
          // says `open` at `plan_complete` (H5 is the necessary partner of H1).
          claimItem: vi.fn().mockResolvedValue({ ok: true }),
          spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
          recordDispatch: vi.fn().mockResolvedValue(true),
          // Cycle 1 sees NO pane (the dispatch has not happened yet); by cycle
          // 2 the spawned pane is live and `working`. Pre-fix
          // `dispatchFromHerdrList` never consults this, so cycle 2 duplicates.
          getRunningDowntimePanes: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
            .mockResolvedValue({
              ok: true,
              count: 1,
              paneIds: ['w1:p1'],
              records: [
                {
                  paneId: 'w1:p1',
                  label: 'Downtime triggered implement Critical in-flight CR-DUP - CR-DUP',
                  agent: 'pi',
                  agentStatus: 'working',
                },
              ],
            }),
        });

        const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });
        const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });

        // Cycle 1 dispatches the critical item.
        expect(first.dispatched).toBe(true);
        expect(first.candidate?.id).toBe('CR-DUP');
        // Cycle 2 must NOT dispatch: a live working pane for the item exists.
        // Pre-fix this observes 2 spawns (the duplicate); post-fix exactly 1.
        expect(second.dispatched).toBe(false);
        expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

// ── Regression: one dispatch per in-flight critical item (F2) ──────────
// Parent WL-0MUBEZ6PE002WLP4 / F2 WL-0MUBVKS5I007LSWB (AC5.1, AC5.3,
// AC5.4, AC5.6). Promotes F1's RED witness
// (WL-0MUBVKPLP006RRDJ) into the permanent, path-covering suite.
//
// The critical-first scan bypasses the dispatched-marker exclusion
// UNCONDITIONALLY and the CAS claim succeeds when the item's status has
// reverted to `open` at its marker's stage (H5), so a live pane does not
// currently prevent a second dispatch. These cases are RED for the in-flight
// variants before F3 (WL-0MUBVKXQJ000L8EO) lands and GREEN after.

describe('one dispatch per in-flight critical item (WL-0MUBVKS5I007LSWB / AC5)', () => {
  const criticalPlannedInFlight = (id: string): DowntimeHerdrItem => ({
    id, title: `Critical in-flight ${id}`, status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'critical', sortIndex: 10,
  });
  const nonCriticalStale = (id: string): DowntimeHerdrItem => ({
    id, title: `Stale ${id}`, status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'medium', sortIndex: 100,
  });

  /** A `herdr pane list` record set with one pane for *itemId* at *status*. */
  const paneRecord = (itemId: string, agentStatus: string) => ({
    paneId: 'w1:p1',
    label: `Downtime triggered implement Critical in-flight ${itemId} - ${itemId}`,
    agent: 'pi',
    agentStatus,
  });

  /**
   * A live working pane result. `records` is the item-scoped signal F3
   * consumes (additive on RunningPanesResult); `count` stays the owner-lease
   * qualifier only — never a dispatch limit (WL-0MU2EP6JL006A1U3).
   */
  const liveWorkingPane = (itemId: string) => ({
    ok: true as const,
    count: 1,
    paneIds: ['w1:p1'],
    records: [paneRecord(itemId, 'working')],
  });

  describe('AC5.1 — Herdr-head path: two cycles, exactly one dispatch', () => {
    it('two idle cycles over a critical item open at its marker stage with a live working pane dispatch once (RED pre-fix)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'herdr-head-inflight-'));
      mkdirSync(join(root, '.worklog'), { recursive: true });
      writeFileSync(
        join(root, '.worklog', 'downtime-dispatches.log'),
        JSON.stringify({
          at: new Date().toISOString(), cwd: root, kind: 'implement', itemId: 'CR-INFLIGHT',
          stage: 'plan_complete', dispatchedAt: new Date().toISOString(), message: 'Dispatched CR-INFLIGHT',
        }) + '\n',
      );
      try {
        const deps = makeDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalPlannedInFlight('CR-INFLIGHT')] }),
          claimItem: vi.fn().mockResolvedValue({ ok: true }),
          spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
          recordDispatch: vi.fn().mockResolvedValue(true),
          // Cycle 1: no pane yet. Cycle 2: the spawned pane is live and working.
          getRunningDowntimePanes: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
            .mockResolvedValue(liveWorkingPane('CR-INFLIGHT')),
        });

        const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });
        const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });

        expect(first.dispatched).toBe(true);
        expect(second.dispatched).toBe(false);
        expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC5.4 — live-pane variants', () => {
    it('a live `working` pane blocks the second cycle (stage advancement irrelevant while open)', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalPlannedInFlight('CR-W')] }),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
        // Cycle 1: no pane yet. Cycle 2: the spawned pane is live and working.
        getRunningDowntimePanes: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
          .mockResolvedValue(liveWorkingPane('CR-W')),
      });

      const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
      const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(first.dispatched).toBe(true);
      expect(second.dispatched).toBe(false);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    });

    it('a `done` pane does NOT block dispatch (no idle-pane deadlock, AC2.3)', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalPlannedInFlight('CR-DONE')] }),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
        getRunningDowntimePanes: vi.fn().mockResolvedValue({
          ok: true, count: 0, paneIds: [], records: [paneRecord('CR-DONE', 'done')],
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('CR-DONE');
    });

    it('an `exited` pane does NOT block dispatch (no idle-pane deadlock, AC2.3)', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalPlannedInFlight('CR-EXIT')] }),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
        getRunningDowntimePanes: vi.fn().mockResolvedValue({
          ok: true, count: 0, paneIds: [], records: [paneRecord('CR-EXIT', 'exited')],
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('CR-EXIT');
    });

    it('a failed/unparseable pane query never duplicating: the fresh marker still holds the second cycle (AC2.2/AC3.3)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'herdr-head-panefail-'));
      mkdirSync(join(root, '.worklog'), { recursive: true });
      writeFileSync(
        join(root, '.worklog', 'downtime-dispatches.log'),
        JSON.stringify({
          at: new Date().toISOString(), cwd: root, kind: 'implement', itemId: 'CR-PANEFAIL',
          stage: 'plan_complete', dispatchedAt: new Date().toISOString(), message: 'Dispatched CR-PANEFAIL',
        }) + '\n',
      );
      try {
        const deps = makeDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalPlannedInFlight('CR-PANEFAIL')] }),
          claimItem: vi.fn().mockResolvedValue({ ok: true }),
          spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
          recordDispatch: vi.fn().mockResolvedValue(true),
          // Cycle 1: pane query succeeds (none) so the dispatch proceeds.
          // Cycle 2: herdr is unavailable — the in-flight state cannot be
          // proven, so the fresh marker must hold the second dispatch.
          getRunningDowntimePanes: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
            .mockResolvedValue({ ok: false, error: 'herdr down' }),
        });

        const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });
        const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });

        expect(first.dispatched).toBe(true);
        expect(second.dispatched).toBe(false);
        expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC5.3 — stale-marker coverage beyond the critical tier', () => {
    it('a non-critical item at the same stage with a fresh marker and a live pane is not re-dispatched', async () => {
      const root = mkdtempSync(join(tmpdir(), 'herdr-head-noncrit-'));
      mkdirSync(join(root, '.worklog'), { recursive: true });
      writeFileSync(
        join(root, '.worklog', 'downtime-dispatches.log'),
        JSON.stringify({
          at: new Date().toISOString(), cwd: root, kind: 'implement', itemId: 'IMP-STALE',
          stage: 'plan_complete', dispatchedAt: new Date().toISOString(), message: 'Dispatched IMP-STALE',
        }) + '\n',
      );
      try {
        const deps = makeDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [nonCriticalStale('IMP-STALE')] }),
          claimItem: vi.fn().mockResolvedValue({ ok: true }),
          spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
          recordDispatch: vi.fn().mockResolvedValue(true),
          getRunningDowntimePanes: vi.fn().mockResolvedValue({
            ok: true, count: 1, paneIds: ['w1:p1'],
            records: [{ paneId: 'w1:p1', label: 'Downtime triggered implement Stale IMP-STALE - IMP-STALE', agent: 'pi', agentStatus: 'working' }],
          }),
        });

        const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });
        const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });

        expect(first.dispatched).toBe(false);
        expect(second.dispatched).toBe(false);
        expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC5.6 — no idle-pane deadlock: a completed skill still advances to its next tier', () => {
    it('an item whose previous skill completed (pane present, agent not working) still dispatches its next tier', async () => {
      // The pane for the item is still OPEN but its agent is `done`: the item
      // is at intake_complete with a completed intake pane. It must dispatch
      // the plan tier, not deadlock on the stale pane.
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [{ id: 'WL-NEXT', title: 'Next tier', status: 'open', stage: 'intake_complete', priority: 'high', risk: 'Low', effort: 'S', sortIndex: 10 }],
        }),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
        getRunningDowntimePanes: vi.fn().mockResolvedValue({
          ok: true, count: 0, paneIds: [],
          records: [{ paneId: 'w1:p1', label: 'Downtime triggered intake Next tier - WL-NEXT', agent: 'pi', agentStatus: 'done' }],
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('WL-NEXT');
    });
  });
});

// ── Dispatch-window extension — Herdr head-cap starvation (WL-0MU6UL3GQ0015AA5) ──
// The dispatcher iterates the Herdr list head, which is windowed: mandatory
// items (critical + completed/in_review) are always included and consume
// slots, so when they are numerous the first genuinely dispatchable candidate
// can fall beyond the window. These tests reproduce the 2026-09-18 starvation
// (a 30-item head, all blocked; the only dispatchable item was the 22nd
// "other", cut off by the cap) and assert the bounded window extension finds
// it in the SAME ranking order.
//
// Blocking is done by CLASSIFICATION SHAPE (a non-dispatchable stage for
// open items, out-of-recency for completed/in_review) rather than by the
// `needsProducerReview` flag: the window-extension tests deliberately isolate
// the window mechanism from the review gate. (The flag now blocks on this
// path too — the field is threaded into `classifyItemForDispatch` as of
// WL-0MU72WJ8C0005GIE / 022f1b24.)

describe('sprint-view-only dispatch window (WL-0MUNS8X97007C9H9; supersedes WL-0MU6UL3GQ0015AA5 AC1/AC4)', () => {
  const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  /**
   * A non-dispatchable filler item: `open` status but a stage with no dispatch
   * kind (`in_review`). Previously these filler items were made
   * non-dispatchable by an above-cap risk, but the implement risk cap was
   * removed (WL-0MUBUA9C8009N0K5); the non-dispatchable stage is now the
   * stable filler shape.
   */
  const blockedImplement = (id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem => ({
    id,
    title: `Blocked ${id}`,
    status: 'open',
    stage: 'in_review',
    priority: 'medium',
    risk: 'High',
    effort: 'S',
    sortIndex: 100,
    ...overrides,
  });

  /** A completed/in_review item outside the audit recency window (never dispatchable). */
  const blockedReview = (id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem => ({
    id,
    title: `Blocked review ${id}`,
    status: 'completed',
    stage: 'in_review',
    priority: 'medium',
    updatedAt: OLD,
    sortIndex: 2,
    ...overrides,
  });

  /** 1 blocked critical + 8 blocked completed/in_review = the 9 mandatory slots. */
  const mandatorySet = (): DowntimeHerdrItem[] => [
    blockedImplement('CG-CRIT', { priority: 'critical', sortIndex: 1 }),
    ...Array.from({ length: 8 }, (_, i) => blockedReview(`CG-REV${i + 1}`, { sortIndex: 2 + i })),
  ];

  /** 21 blocked "other" items fill the remaining window slots (total head = 30). */
  const blockedOthers = (): DowntimeHerdrItem[] =>
    Array.from({ length: 21 }, (_, i) => blockedImplement(`CG-BLK${i + 1}`, { sortIndex: 20 + i }));

  /** The only genuinely dispatchable item (high, idea, no markers, not review-gated). */
  const dispatchableIntake = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Dispatchable ${id}`,
    status: 'open',
    stage: 'idea',
    priority: 'high',
    sortIndex: 999,
  });

  /** A dispatchable CRITICAL implement item (the AC4 escape-hatch shape). */
  const dispatchableCriticalImplement = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Critical ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'critical',
    risk: 'Low',
    effort: 'S',
    sortIndex: 500,
  });

  const fullHead = (): DowntimeHerdrItem[] => [...mandatorySet(), ...blockedOthers()];

  describe('AC1 — head limit equals the live sprint-view browseItemCount', () => {
    it('direct dispatch passes the effective browseItemCount to getHerdrListHead', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [dispatchableIntake('CG-INWINDOW')] });
      const deps = makeDeps({ getHerdrListHead });

      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

      expect(getHerdrListHead).toHaveBeenCalledWith('/repo', 20);
    });

    it('clamps an out-of-range browseItemCount to the supported [1, 50] range', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [dispatchableIntake('CG-INWINDOW')] });
      const deps = makeDeps({ getHerdrListHead });

      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 999 });
      expect(getHerdrListHead).toHaveBeenLastCalledWith('/repo', 50);

      getHerdrListHead.mockClear();
      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 0 });
      expect(getHerdrListHead).toHaveBeenLastCalledWith('/repo', 1);
    });

    it('defaults to the sprint-view default (20) when browseItemCount is undefined', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [dispatchableIntake('CG-INWINDOW')] });
      const deps = makeDeps({ getHerdrListHead });

      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(getHerdrListHead).toHaveBeenCalledWith('/repo', 20);
    });

    it('computeMostImportantItem passes the effective browseItemCount to getHerdrListHead', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [dispatchableIntake('CG-INWINDOW')] });
      const deps = makeDeps({ getHerdrListHead });

      await computeMostImportantItem(deps, '/repo', Date.now(), 33);

      expect(getHerdrListHead).toHaveBeenCalledWith('/repo', 33);
    });

    it('re-reads the live browseItemCount on every dispatch cycle (settings change applies without restart)', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [dispatchableIntake('CG-INWINDOW')] });
      const deps = makeDeps({ getHerdrListHead });

      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 15 });
      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 40 });

      expect(getHerdrListHead).toHaveBeenNthCalledWith(1, '/repo', 15);
      expect(getHerdrListHead).toHaveBeenNthCalledWith(2, '/repo', 40);
    });
  });

  describe('AC3 — regression: the dispatchable item beyond the window cap is found', () => {
    it('regression (WL-0MU6UL3GQ0015AA5 updated): a non-critical item beyond the sprint view is NOP, not dispatched', async () => {
      const initialHead = fullHead();
      const target = dispatchableIntake('CG-0MTZO0YIM000VAIQ');
      const getHerdrListHead = vi.fn()
        .mockResolvedValueOnce({ ok: true, items: initialHead })
        .mockResolvedValueOnce({ ok: true, items: [...initialHead, target] });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

      // The out-of-window item is NON-critical: the sprint-view-only contract
      // reports no-candidate instead of dispatching hidden backlog work
      // (supersedes WL-0MU6UL3GQ0015AA5 for non-critical work).
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      expect(deps.claimItem).not.toHaveBeenCalled();
      // The critical-only extension still consulted the SAME ranking path
      // (never a second ranking).
      expect(getHerdrListHead).toHaveBeenCalledTimes(2);
      expect(getHerdrListHead).toHaveBeenNthCalledWith(
        2,
        '/repo',
        initialHead.length + DOWNTIME_DISPATCH_EXTEND_MAX,
      );
    });

    it('the coordination check-in offer (computeMostImportantItem) also no-ops on a non-critical out-of-window item', async () => {
      const initialHead = fullHead();
      const target = dispatchableIntake('CG-OFFER');
      const getHerdrListHead = vi.fn()
        .mockResolvedValueOnce({ ok: true, items: initialHead })
        .mockResolvedValueOnce({ ok: true, items: [...initialHead, target] });
      const deps = makeDeps({ getHerdrListHead });

      const result = await computeMostImportantItem(deps, '/repo');

      expect(result).toMatchObject({ ok: true, noCandidate: true });
      expect(getHerdrListHead).toHaveBeenCalledTimes(2);
    });

    it('prefers an in-window candidate over the extended window (no extra lookup when the head suffices)', async () => {
      const inWindow = dispatchableIntake('CG-INWINDOW');
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [inWindow, ...blockedOthers()] });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('CG-INWINDOW');
      // The head already yielded a candidate — the extension never runs.
      expect(getHerdrListHead).toHaveBeenCalledTimes(1);
    });

    it('stays code-freeze under a freeze even when a non-critical item lies beyond the window', async () => {
      // Under a freeze, audit/implement candidates are paused; a non-critical
      // item beyond the sprint view is not an escape hatch, so the terminal
      // reason stays derived from the in-view flags.
      const initialHead = fullHead();
      const target = dispatchableIntake('CG-FROZEN-OUT-OF-WINDOW');
      const getHerdrListHead = vi.fn()
        .mockResolvedValueOnce({ ok: true, items: initialHead })
        .mockResolvedValueOnce({ ok: true, items: [...initialHead, target] });
      const deps = makeDeps({
        readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
        getHerdrListHead,
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('code-freeze');
    });
  });

  describe('AC2 — bounded extension, no worklist regression, terminal reasons preserved', () => {
    it('stays no-candidate when the extended window adds nothing (mock ignores the limit)', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: fullHead() }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      expect(deps.claimItem).not.toHaveBeenCalled();
    });

    it('reports code-freeze when a frozen head plus extension still yields no candidate', async () => {
      const deps = makeDeps({
        readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
        // Both the head and the extension return the same blocked items.
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: fullHead() }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('code-freeze');
    });

    it('the extension never invents a new failure: a failed extended lookup degrades to no-candidate', async () => {
      const getHerdrListHead = vi.fn()
        .mockResolvedValueOnce({ ok: true, items: fullHead() })
        .mockResolvedValueOnce({ ok: false, error: 'boom' });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
      expect(getHerdrListHead).toHaveBeenCalledTimes(2);
    });
  });

  describe('AC4 — critical items remain dispatchable', () => {
    it('a critical item in the head still dispatches while every non-critical item is filtered', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({
        ok: true,
        items: [dispatchableCriticalImplement('CG-CRIT-DISPATCH'), ...blockedOthers()],
      });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('CG-CRIT-DISPATCH');
    });

    it('the critical-only extension still reaches an out-of-window critical item', async () => {
      const initialHead = fullHead();
      const target = dispatchableCriticalImplement('CG-CRIT-OUT-OF-WINDOW');
      const getHerdrListHead = vi.fn()
        .mockResolvedValueOnce({ ok: true, items: initialHead })
        .mockResolvedValueOnce({ ok: true, items: [...initialHead, target] });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('CG-CRIT-OUT-OF-WINDOW');
    });
  });

  describe('fetchExtendedHerdrItems — critical-only escape hatch primitive', () => {
    const item = (id: string, priority = 'medium'): DowntimeHerdrItem => ({
      id,
      title: `Item ${id}`,
      status: 'open',
      stage: 'idea',
      priority,
    });

    it('returns only newly visible CRITICAL items, preserving the canonical order', async () => {
      const current = [item('A')];
      const dep = vi.fn().mockResolvedValue({
        ok: true,
        items: [item('A'), item('B'), item('C', 'critical'), item('D'), item('E', 'critical')],
      });
      const deps = makeDeps({ getHerdrListHead: dep });

      const extended = await fetchExtendedHerdrItems(deps, '/repo', current);

      expect(extended.map((i) => i.id)).toEqual(['C', 'E']);
      expect(extended.every((i) => i.priority === 'critical')).toBe(true);
      expect(dep).toHaveBeenCalledWith('/repo', 1 + DOWNTIME_DISPATCH_EXTEND_MAX);
    });

    it('never returns a non-critical item beyond the sprint view (AC4)', async () => {
      const current = [item('A')];
      const dep = vi.fn().mockResolvedValue({
        ok: true,
        items: [item('A'), item('B', 'high'), item('C'), item('D', 'low')],
      });
      const deps = makeDeps({ getHerdrListHead: dep });

      expect(await fetchExtendedHerdrItems(deps, '/repo', current)).toEqual([]);
    });

    it('returns [] when the extended head adds nothing (limit-ignoring dep)', async () => {
      const current = [item('A')];
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [item('A')] }),
      });

      expect(await fetchExtendedHerdrItems(deps, '/repo', current)).toEqual([]);
    });

    it('fails open to [] on a {ok:false} extended lookup', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
      });

      expect(await fetchExtendedHerdrItems(deps, '/repo', [item('A')])).toEqual([]);
    });

    it('fails open to [] when the extended lookup throws', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockRejectedValue(new Error('boom')),
      });

      expect(await fetchExtendedHerdrItems(deps, '/repo', [item('A')])).toEqual([]);
    });
  });
});

// ── Dispatched success-marker staleness — live Herdr-head path
//    (WL-0MU6UL0RJ008IHGT AC1/AC2/AC4) ─────────────────────────────
//
// A SUCCESS dispatch marker (no `outcome`) historically excluded its item
// forever: a pane that spawned but whose agent never advanced the item
// (crash, manual close, silent failure) stranded it permanently — the item
// was invisible to the tier that would retry it. These tests pin the live
// `dispatchFromHerdrList`/`computeMostImportantItem` marker filter: a marker
// excludes ONLY while the item is STILL at the marker's dispatched-at stage
// AND the marker is fresh (age <= the configured staleness window). The
// times are relative to REAL `Date.now()` because the dispatch path reads
// the clock itself. Items here are NON-critical so they exercise the normal
// (non-critical-first) filter path.
describe('dispatched success-marker staleness on the live path (WL-0MU6UL0RJ008IHGT)', () => {
  const WINDOW_MS = 24 * 60 * 60 * 1000; // default 24h
  const tempCwds = createTempDirTracker();

  afterEach(() => {
    tempCwds.cleanup();
  });

  function makeCwd(): string {
    return tempCwds.make('dt-stale-marker-');
  }

  const writeLog = writeDowntimeLog;

  const planHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Plan ${id}`,
    status: 'open',
    stage: 'intake_complete',
    priority: 'medium',
    sortIndex: 30,
  });
  const implementHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Implement ${id}`,
    status: 'open',
    stage: 'plan_complete',
    risk: 'Low',
    effort: 'S',
    priority: 'medium',
    sortIndex: 20,
  });

  it('AC1: a stale success marker at the unchanged stage no longer excludes — the item is re-dispatched', async () => {
    const cwd = makeCwd();
    // Plan marker written >24h ago for an item STILL at intake_complete — the
    // pane spawned but never advanced it. Must be released on the live path.
    writeLog(cwd, [
      { itemId: 'PLN-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(WINDOW_MS + 60_000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('PLN-1');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan PLN-1'),
      expect.anything(),
    );
  });

  it('a FRESH success marker at the unchanged stage still excludes (no double dispatch)', async () => {
    const cwd = makeCwd();
    // Plan marker 1h ago for an item still at intake_complete → genuinely
    // in-flight; the tier must skip it and report the neutral no-candidate.
    writeLog(cwd, [
      { itemId: 'PLN-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(60 * 60 * 1000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('AC2: an item that ADVANCED past the marker stage is released regardless of age', async () => {
    const cwd = makeCwd();
    // Marker says intake_complete but the item is now at plan_complete — the
    // history released it via the change-guard; it must still release today.
    writeLog(cwd, [
      { itemId: 'IMP-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(60 * 1000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('IMP-1');
  });

  it('id-guard tier: a stale IMPLEMENT marker at the unchanged stage is released', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [
      { itemId: 'IMP-1', kind: 'implement', stage: 'plan_complete', dispatchedAt: ago(WINDOW_MS + 60_000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('IMP-1');
  });

  it('id-guard tier: a fresh IMPLEMENT marker still excludes (duplicate-dispatch protection)', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [
      { itemId: 'IMP-1', kind: 'implement', stage: 'plan_complete', dispatchedAt: ago(60 * 60 * 1000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('id-guard tier: a legacy implement marker WITHOUT a stage keeps excluding while fresh, releases when stale', async () => {
    const cwd = makeCwd();
    // Fresh legacy marker (no stage field — pre-change-guard entry): the
    // id-guard must NOT weaken protection → still excluded.
    writeLog(cwd, [{ itemId: 'IMP-1', kind: 'implement', dispatchedAt: ago(60 * 60 * 1000) }]);
    const freshDeps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
    });
    const freshOutcome = await dispatchDowntimeWork(freshDeps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(freshOutcome.dispatched).toBe(false);
    expect(freshOutcome.reason).toBe('no-candidate');

    // Same legacy marker but stale → the age TTL releases it.
    writeLog(cwd, [{ itemId: 'IMP-1', kind: 'implement', dispatchedAt: ago(WINDOW_MS + 60_000) }]);
    const staleDeps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
    });
    const staleOutcome = await dispatchDowntimeWork(staleDeps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(staleOutcome.dispatched).toBe(true);
    expect(staleOutcome.kind).toBe('implement');
  });

  it('computeMostImportantItem releases a stale marker at the unchanged stage (offers re-triable item)', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [
      { itemId: 'PLN-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(WINDOW_MS + 60_000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });
    const result = await computeMostImportantItem(deps, cwd, Date.now(), undefined, WINDOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok && 'candidate' in result) {
      expect(result.candidate.id).toBe('PLN-1');
      expect(result.kind).toBe('plan');
    } else {
      throw new Error(`expected a candidate offer, got ${JSON.stringify(result)}`);
    }
  });

  it('computeMostImportantItem keeps excluding a FRESH marker at the unchanged stage (no offer)', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [
      { itemId: 'PLN-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(60 * 60 * 1000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });
    const result = await computeMostImportantItem(deps, cwd, Date.now(), undefined, WINDOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok) expect('noCandidate' in result).toBe(true);
  });
});

// ── Non-terminal pane-close cooldown — live paths (WL-0MUKYERLZ006ELL5) ──

describe('non-terminal pane-close cooldown on the live paths (WL-0MUKYERLZ006ELL5)', () => {
  const COOLDOWN_MS = DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS;
  const tempCwds = createTempDirTracker();

  afterEach(() => {
    tempCwds.cleanup();
  });

  function makeCwd(): string {
    return tempCwds.make('dt-nonterminal-cooldown-');
  }

  const writeLog = writeDowntimeLog;

  const planHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Plan ${id}`,
    status: 'open',
    stage: 'intake_complete',
    priority: 'medium',
    sortIndex: 30,
  });

  /** A non-terminal pane-close entry for the plan candidate. */
  function closeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      entryType: 'pane-close',
      itemId: 'PLN-1',
      kind: 'plan',
      stage: 'intake_complete',
      reasonCode: 'agent-ended-no-terminal',
      outcome: 'requires-attention',
      timestamp: ago(60_000),
      closed: true,
      ...overrides,
    };
  }

  it('AC1: a recent non-terminal close holds re-dispatch with the neutral cooldown reason', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry()]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, nonTerminalCooldownMs: COOLDOWN_MS });

    expect(outcome.dispatched).toBe(false);
    // Distinguishable from 'no-candidate' so the no-candidate cooldown is
    // not entered and no strike is recorded (AC3/AC5).
    expect(outcome.reason).toBe('non-terminal-cooldown');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.recordError).not.toHaveBeenCalled();
    expect(deps.recordDispatchFailure).not.toHaveBeenCalled();
  });

  it('AC2: a close older than cooldownMs releases the item (dispatches normally)', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry({ timestamp: ago(COOLDOWN_MS + 1) })]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, nonTerminalCooldownMs: COOLDOWN_MS });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('PLN-1');
  });

  it('AC3: stage advancement mid-cooldown releases the item immediately', async () => {
    const cwd = makeCwd();
    // Dispatched at `idea`; the item has since advanced to `intake_complete`.
    writeLog(cwd, [closeEntry({ stage: 'idea' })]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, nonTerminalCooldownMs: COOLDOWN_MS });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('PLN-1');
  });

  it('AC4: a terminal close (reasonCode none) does not apply the cooldown', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry({ reasonCode: 'none', outcome: 'closed-as-plan-complete' })]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, nonTerminalCooldownMs: COOLDOWN_MS });

    expect(outcome.dispatched).toBe(true);
  });

  it('applies the cooldown per-kind: an intake close does not hold a plan re-dispatch', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry({ kind: 'intake', itemId: 'PLN-1' })]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, nonTerminalCooldownMs: COOLDOWN_MS });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('AC7: computeMostImportantItem reports a distinct cooldown hold, never noCandidate', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry()]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const result = await computeMostImportantItem(deps, cwd, Date.now(), undefined, undefined, COOLDOWN_MS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('nonTerminalCooldownHold' in result).toBe(true);
      expect('noCandidate' in result).toBe(false);
      // The offer-computation hold is NOT a candidate offer.
      expect('candidate' in result).toBe(false);
    }
  });

  it('AC7: computeMostImportantItem offers a cooldown-elapsed item normally', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry({ timestamp: ago(COOLDOWN_MS + 1) })]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const result = await computeMostImportantItem(deps, cwd, Date.now(), undefined, undefined, COOLDOWN_MS);

    expect(result.ok).toBe(true);
    if (result.ok && 'candidate' in result) {
      expect(result.candidate.id).toBe('PLN-1');
      expect(result.kind).toBe('plan');
    } else {
      throw new Error(`expected a candidate offer, got ${JSON.stringify(result)}`);
    }
  });
});

// ── clampDowntimeMarkerStaleWindowMs (WL-0MU6UL0RJ008IHGT AC3) ────────

describe('clampDowntimeMarkerStaleWindowMs', () => {
  it('defaults on non-finite/negative input', () => {
    expect(clampDowntimeMarkerStaleWindowMs(NaN)).toBe(DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS);
    expect(clampDowntimeMarkerStaleWindowMs(-1)).toBe(DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS);
    expect(clampDowntimeMarkerStaleWindowMs(0)).toBe(60 * 60 * 1000); // clamped to 1h floor
  });

  it('clamps into the documented [1h, 7d] range', () => {
    expect(clampDowntimeMarkerStaleWindowMs(30 * 60 * 1000)).toBe(60 * 60 * 1000); // below floor
    expect(clampDowntimeMarkerStaleWindowMs(8 * 24 * 60 * 60 * 1000)).toBe(7 * 24 * 60 * 60 * 1000); // above ceiling
    const mid = 6 * 60 * 60 * 1000;
    expect(clampDowntimeMarkerStaleWindowMs(mid)).toBe(mid);
  });
});

// ── Dispatch-log selection provenance + pane enrichment (F6) ───────────
// WL-0MUBVL251006JAQ0 (parent WL-0MUBEZ6PE002WLP4, AC6.1–AC6.3).

describe('dispatch log: selection path/reason + pane id enrichment (WL-0MUBVL251006JAQ0 / F6)', () => {
  const critical = (): DowntimeHerdrItem => ({
    id: 'CR-SEL', title: 'Crit sel', status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'critical', sortIndex: 10,
  });
  const nonCritical = (): DowntimeHerdrItem => ({
    id: 'IMP-SEL', title: 'Impl sel', status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'high', sortIndex: 100,
  });

  it('AC6.1: a critical-first dispatch records selectionPath/selectionReason', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [critical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'CR-SEL',
        selectionPath: 'critical-first',
        selectionReason: 'no-live-pane',
      }),
    );
  });

  it('AC6.1: a normal-scan dispatch records selectionPath/selectionReason', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [nonCritical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'IMP-SEL',
        selectionPath: 'normal-scan',
        selectionReason: 'non-critical',
      }),
    );
  });

  it('AC6.2/AC6.3: a successful dispatch appends an enrichment entry with the resolved paneId, preserving marker fields', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [critical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
      recordDispatchEnrichment: vi.fn().mockResolvedValue(undefined),
      // 1st call (pre-spawn in-flight guard): no pane. 2nd call (post-spawn
      // enrichment resolver): the pane is live.
      getRunningDowntimePanes: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
        .mockResolvedValue({
          ok: true, count: 1, paneIds: ['w1:p1'],
          records: [{ paneId: 'w1:p1', label: 'Downtime triggered implement Crit sel - CR-SEL', agent: 'pi', agentStatus: 'working' }],
        }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    const markerCall = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const enrichCall = (deps.recordDispatchEnrichment as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(enrichCall).toMatchObject({
      itemId: markerCall.itemId,
      kind: markerCall.kind,
      stage: markerCall.stage,
      dispatchedAt: markerCall.dispatchedAt,
      paneId: 'w1:p1',
      enrichment: true,
      noItemComment: true,
    });
  });

  it('AC6.3: an unresolved pane id is recorded as null, and the dispatch still succeeds', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [critical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
      recordDispatchEnrichment: vi.fn().mockResolvedValue(undefined),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect((deps.recordDispatchEnrichment as ReturnType<typeof vi.fn>).mock.calls[0][0].paneId).toBeNull();
  });

  it('AC6.3: a throwing enrichment dep never affects the dispatch outcome (fail-open)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [critical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
      recordDispatchEnrichment: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('AC6.3: an absent enrichment dep is a no-op (legacy callers unchanged)', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [critical()] }),
      recordDispatch: vi.fn().mockResolvedValue(true),
    });
    // makeDeps omits recordDispatchEnrichment by default.
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    expect(outcome.dispatched).toBe(true);
  });
});
// ── AC Tests: per-slot owner-lease gate (WL-0MU8807BI008C9ME) ──────────

// ── parseLlamaStatus: array local_owner_session_id (blocking dep fix) ──

describe('parseLlamaStatus: array local_owner_session_id (WL-0MU88086A0089US4)', () => {
  function makeBase(): Record<string, unknown> {
    return {
      llama_server_running: true,
      local_active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 3,
      total_slots: 3,
      contention_queue_depth: 0,
      contention_queued_count: 0,
    };
  }

  it('AC1: legacy string payload preserves the owner (WL-0MU88086A0089US4)', () => {
    const raw = {
      ...makeBase(),
      local_owner_session_id: 'herdr-1789775322-722064-10708',
    };
    const result = parseLlamaStatus(raw);
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_id).toBe('herdr-1789775322-722064-10708');
  });

  it('AC2: current 2-element array payload parses; URL element ignored, session recovered', () => {
    const raw = {
      ...makeBase(),
      local_lease_active: undefined, // omit so it derives from array/lease_seconds
      local_owner_session_id: ['http://localhost:8080', 'herdr-1789775322-722064-10708'],
      local_owner_lease_remaining_seconds: 30,
    };
    const result = parseLlamaStatus(raw);
    expect(result).not.toBeNull();
    // The session ID (2nd element) is extracted; the URL (1st element) is dropped.
    expect(result!.local_owner_session_id).toBe('herdr-1789775322-722064-10708');
    // local_lease_active derives from lease_seconds > 0.
    expect(result!.local_lease_active).toBe(true);
  });

  it('AC3: malformed owner (number) → fail-closed (busy / undefined), no throw', () => {
    const raw = {
      ...makeBase(),
      local_owner_session_id: 42,
    };
    const result = parseLlamaStatus(raw);
    // A non-string, non-array number is ambiguous → undefined for this field.
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_id).toBeUndefined();
  });

  it('AC3b: malformed owner (object) → fail-closed', () => {
    const raw = {
      ...makeBase(),
      local_owner_session_id: { id: 'bad' },
    };
    const result = parseLlamaStatus(raw);
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_id).toBeUndefined();
  });

  it('AC3c: malformed owner (empty array) → fail-closed', () => {
    const raw = {
      ...makeBase(),
      local_owner_session_id: [],
    };
    const result = parseLlamaStatus(raw);
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_id).toBeUndefined();
  });

  it('AC4: contract test pins exact array shape [url, session]', () => {
    // Reproduces the exact live-proxy shape observed on 2026-09-19.
    const raw = {
      ...makeBase(),
      local_owner_session_id: ['http://localhost:8080', 'herdr-1789776793-744802-10480'],
      local_owner_lease_remaining_seconds: 29.99,
    };
    const result = parseLlamaStatus(raw);
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_id).toBe('herdr-1789776793-744802-10480');
  });

  it('AC5: fetchLocalStatus never throws on array shape', async () => {
    const arrayPayload = {
      ...makeBase(),
      local_owner_session_id: ['http://localhost:8080', 'herdr-test'],
    };
    const poller = createDowntimePoller(
      'http://proxy:8000',
      vi.fn().mockResolvedValue(jsonResponseFixture(arrayPayload)),
    );
    const worker = createDowntimeWorker({
      poller,
      deps: makeDeps(),
      config: () => ({
        enabled: true,
        thresholdMs: 0,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: '/repo',
        noCandidateCooldownMs: 3_600_000,
      }),
    });
    // Should not throw — poller must handle the array shape.
    const result = await worker.tick();
    expect(result).toBeDefined();
  });
});

describe('parseLlamaStatus: local_owner_session_ids normalization (WL-0MU88086A0089US4)', () => {
  function makeBase(): Record<string, unknown> {
    return {
      llama_server_running: true,
      local_active_query: false,
      model_switch_in_progress: false,
      local_lease_active: false,
      available_slots: 3,
      total_slots: 3,
      contention_queue_depth: 0,
      contention_queued_count: 0,
    };
  }

  it('captures every session in the array and drops the proxy URL element', () => {
    const result = parseLlamaStatus({
      ...makeBase(),
      local_owner_session_id: ['http://localhost:8080', 'session-a', 'session-b'],
    });
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_ids).toEqual(['session-a', 'session-b']);
    expect(result!.local_owner_session_id).toBe('session-a');
  });

  it('normalises a legacy string owner to a single-element array', () => {
    const result = parseLlamaStatus({
      ...makeBase(),
      local_owner_session_id: 'legacy-session',
    });
    expect(result).not.toBeNull();
    expect(result!.local_owner_session_ids).toEqual(['legacy-session']);
    expect(result!.local_owner_session_id).toBe('legacy-session');
  });

  it('yields an empty owner list for malformed input (fail-closed, no throw)', () => {
    const malformedInputs: unknown[] = [
      42,
      { id: 'bad' },
      [],
      ['http://localhost:8080'],
      [42],
      ['http://localhost:8080', 42],
    ];
    for (const malformed of malformedInputs) {
      const result = parseLlamaStatus({
        ...makeBase(),
        local_owner_session_id: malformed,
      });
      expect(result).not.toBeNull();
      expect(result!.local_owner_session_ids).toEqual([]);
      expect(result!.local_owner_session_id).toBeUndefined();
    }
  });

  it('marks local_lease_active from a multi-session array even without lease seconds', () => {
    const result = parseLlamaStatus({
      ...makeBase(),
      local_lease_active: undefined,
      local_owner_session_id: ['http://localhost:8080', 'session-a', 'session-b'],
    });
    expect(result).not.toBeNull();
    expect(result!.local_lease_active).toBe(true);
  });
});

// ── Per-slot owner-lease gate in tick() (WL-0MU8807BI008C9ME AC1-AC4) ──

describe('tick(): owner-lease gate must be per-slot (WL-0MU8807BI008C9ME)', () => {
  function makePerSlotWorker(opts: {
    status: LlamaStatus;
    runningPanes: () => { ok: true; count: number } | { ok: false; error?: string };
    requiredFreeSlots?: number;
  }) {
    const cfg = {
      enabled: true,
      thresholdMs: 1_000,
      requiredFreeSlots: opts.requiredFreeSlots ?? 2,
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
      getRunningDowntimePanes: vi.fn().mockImplementation(async () => opts.runningPanes()),
    });
    const worker = createDowntimeWorker({ poller, deps, config: () => ({ ...cfg }) });
    return { worker, deps };
  }

  it('AC1: per-slot 3-slots: 1 owned+busy, 2 free unowned, held lease + runningPanes → dispatch proceeds (RCA regression)', async () => {
    // Regression for the overnight stall: cheap mode (3 slots), one slot
    // owned by a dispatched agent, 2 free unowned → dispatch MUST fire.
    vi.useFakeTimers();
    try {
      const ownedSlot = 'http://localhost:8080';
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 2,
        total_slots: 3,
        local_owner_session_id: ownedSlot,
        local_owner_lease_remaining_seconds: 120,
        slots: [
          { slot_id: 'slot-1', is_processing: true, owner_session_id: ownedSlot },
          { slot_id: 'slot-2', is_processing: false },
          { slot_id: 'slot-3', is_processing: false },
        ],
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker, deps } = makePerSlotWorker({
        status,
        runningPanes: () => ({ ok: true, count: 1 }),
        requiredFreeSlots: 2,
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick(); // first tick — establish idle baseline
      vi.setSystemTime(start + 5_000);
      const outcome = await worker.tick();
      // THE FIX: dispatch MUST proceed because 2 free unowned slots exist.
      expect(outcome.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC2: count-based status (no slots), owner lease held, runningPanes > 0 → dispatch refused (single-slot protection preserved)', async () => {
    vi.useFakeTimers();
    try {
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 1,
        total_slots: 1,
        local_owner_session_id: 'session-live',
        local_owner_lease_remaining_seconds: 120,
      };
      // No `slots` array → count-based mode.
      const { worker, deps } = makePerSlotWorker({
        status,
        runningPanes: () => ({ ok: true, count: 1 }),
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const blocked = await worker.tick();
      expect(blocked.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC3: per-slot status where every slot is owned → dispatch refused', async () => {
    vi.useFakeTimers();
    try {
      const ownerA = 'http://localhost:8080';
      const ownerB = 'http://localhost:8081';
      const ownerC = 'http://localhost:8082';
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 0,
        total_slots: 3,
        local_owner_session_id: ownerA,
        local_owner_lease_remaining_seconds: 60,
        // AC3: EVERY slot carries a live owner lease, including slot-3 which
        // is idle by `is_processing` but owned. countFreeUnownedSlots === 0
        // is the per-slot gate signal — the worker must refuse.
        slots: [
          { slot_id: 'slot-1', is_processing: true, owner_session_id: ownerA },
          { slot_id: 'slot-2', is_processing: true, owner_session_id: ownerB },
          { slot_id: 'slot-3', is_processing: false, owner_session_id: ownerC },
        ],
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker, deps } = makePerSlotWorker({
        status,
        runningPanes: () => ({ ok: true, count: 1 }),
        requiredFreeSlots: 2,
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const blocked = await worker.tick();
      expect(blocked.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC4: audit-tier minimum (DOWNTIME_AUDIT_MIN_FREE_SLOTS = 2) evaluated against per-slot unowned-free count', async () => {
    vi.useFakeTimers();
    try {
      // Only 1 free unowned slot — below audit-tier minimum of 2.
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 1,
        total_slots: 3,
        local_owner_session_id: 'http://localhost:8080',
        local_owner_lease_remaining_seconds: 60,
        slots: [
          { slot_id: 'slot-1', is_processing: true, owner_session_id: 'http://localhost:8080' },
          { slot_id: 'slot-2', is_processing: true }, // processing, not free
          { slot_id: 'slot-3', is_processing: false }, // free unowned
        ],
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker, deps } = makePerSlotWorker({
        status,
        runningPanes: () => ({ ok: true, count: 0 }),
        requiredFreeSlots: 2, // audit minimum
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const blocked = await worker.tick();
      // 1 free unowned < requiredFreeSlots=2 → blocked.
      expect(blocked.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC1b: per-slot with 0 runningPanes but lease held → dispatch proceeds (operator lease on spare slots)', async () => {
    // When the worker has NO running panes, even a held lease doesn't block.
    vi.useFakeTimers();
    try {
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 2,
        total_slots: 3,
        local_owner_session_id: 'http://localhost:8080',
        local_owner_lease_remaining_seconds: 60,
        slots: [
          { slot_id: 'slot-1', is_processing: true, owner_session_id: 'http://localhost:8080' },
          { slot_id: 'slot-2', is_processing: false },
          { slot_id: 'slot-3', is_processing: false },
        ],
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const { worker, deps } = makePerSlotWorker({
        status,
        runningPanes: () => ({ ok: true, count: 0 }),
        requiredFreeSlots: 2,
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const result = await worker.tick();
      expect(result.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC5: cheap-mode dispatch is recorded in downtime-dispatches.log while a previously dispatched agent is still working', async () => {
    // Integration evidence for the RCA (WL-0MU8807BI008C9ME): with a
    // previously dispatched agent STILL alive (`runningPanes > 0`) and
    // holding the shared owner lease, the per-slot gate must still dispatch
    // into the 2 free unowned slots AND record the dispatch in the rolling
    // log at <cwd>/.worklog/downtime-dispatches.log — the observable
    // behaviour the RCA said never happened.
    const root = mkdtempSync(join(tmpdir(), 'herdr-perslot-log-'));
    vi.useFakeTimers();
    try {
      const status: LlamaStatus = {
        llama_server_running: true,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: true,
        available_slots: 2,
        total_slots: 3,
        // Array form served by the live proxy: [url, session].
        local_owner_session_id: ['http://localhost:8080', 'dispatched-pane-session'],
        local_owner_lease_remaining_seconds: 90,
        slots: [
          { slot_id: 'slot-1', is_processing: true, owner_session_id: 'dispatched-pane-session' },
          { slot_id: 'slot-2', is_processing: false },
          { slot_id: 'slot-3', is_processing: false },
        ],
        contention_queue_depth: 0,
        contention_queued_count: 0,
      };
      const cfg = {
        enabled: true,
        thresholdMs: 1_000,
        requiredFreeSlots: 2,
        model: 'plan',
        cwd: root,
        noCandidateCooldownMs: 3_600_000,
        browseItemCount: 20,
      };
      const poller = createDowntimePoller(
        'http://proxy:8000',
        vi.fn().mockResolvedValue(jsonResponseFixture(status)),
      );
      const deps = makeDeps({
        getNextItem: vi.fn().mockResolvedValue({
          ok: true,
          candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
        }),
        // A previously dispatched agent is STILL working.
        getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
        // Real rolling-log write (the plugin's recordDispatch contract):
        // the dispatch marker must land in downtime-dispatches.log.
        recordDispatch: vi.fn(async (event) => {
          await appendDowntimeLogEntry(event.cwd, JSON.stringify(event));
          return true;
        }),
      });
      const worker = createDowntimeWorker({ poller, deps, config: () => ({ ...cfg }) });

      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick(); // baseline poll — start the per-slot timer
      vi.setSystemTime(start + 5_000);
      const outcome = await worker.tick();

      expect(outcome.dispatched).toBe(true);
      const entries = await readDowntimeLogEntries(root);
      const marker = entries.find((e) => e.kind === 'plan' && e.itemId === 'WL-ABC');
      expect(marker).toBeDefined();
      expect(marker!.dispatchedAt).toBeDefined();
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
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
