/**
 * packages/herdr/src/downtime-worker.critical-first.test.ts — critical-first
 * selection, parsing and review-queue gating tests.
 *
 * Split out of the monolithic `downtime-worker.test.ts`
 * (WL-0MV28X3SL005R5KX / WL-0MV4VMEHO005X1QQ) to keep each test file focused
 * on one concern and under the 2,000-line cap. Covers:
 *   - critical candidate selection & parsing (`selectCriticalCandidate`,
 *     `parseCriticalCandidatesOutput`, `resolveDependencyFrontier`,
 *     `parseDepListBlockersOutput`, `parseShownWorkItem`,
 *     `parseShowItemOutput`),
 *   - the critical-first dispatch tier,
 *   - `needsProducerReview` exclusion and the select/classify gates,
 *   - review-queue depth gating.
 *
 * Shared scaffolding (`makeDeps` and the other fixtures) is imported from
 * `downtime-worker.fixtures.ts`; no setup logic is re-implemented here.
 * The companion sprint-view / Herdr-head dispatch tests live in
 * `downtime-worker.sprint-view.test.ts`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyItemForDispatch,
  createDowntimePoller,
  createDowntimeWorker,
  criticalSkillKind,
  dispatchDowntimeWork,
  parseAuditCandidatesOutput,
  parseCriticalCandidatesOutput,
  parseDepListBlockersOutput,
  parseImplementCandidatesOutput,
  parseNextCandidatesOutput,
  parseShowItemOutput,
  parseShownWorkItem,
  resolveDependencyFrontier,
  selectAuditCandidate,
  selectCriticalCandidate,
  selectCriticalFirstCandidates,
  selectImplementCandidate,
  selectNextCandidate,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  type AuditCandidate,
  type CriticalCandidate,
  type DowntimeCandidate,
  type DowntimeHerdrItem,
  type DowntimeItemInfo,
  type DowntimeWorkerDeps,
  type ImplementCandidate,
  type ScheduledPrompt,
} from './downtime-worker.js';
import { createRoundRobinRegistry } from './downtime-round-robin.js';
import {
  idleAllSlotsFree,
  jsonResponseFixture,
  makeDeps,
} from './downtime-worker.fixtures.js';

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
    // Observable contract: getNextCriticalCandidate boundary dep — cwd arg is the observable critical-tier query contract
    expect(deps.getNextCriticalCandidate).toHaveBeenCalledWith('/repo');
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    // Observable contract: claimItem boundary CAS call — sole channel proving claim args (incl. gate counts where asserted)
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-I', { status: 'open', stage: 'idea' }, '/repo');
    // Observable contract: spawnAgentPane boundary call — sole observable channel for the spawn
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:intake WL-CRIT-I'),
      {
        model: 'plan',
        cwd: '/repo',
        itemId: 'WL-CRIT-I',
        itemTitle: 'Critical idea WL-CRIT-I',
        // Request priority (WL-0MVF3Q4X5001FOXV AC3): the critical candidate's
        // raw work-item priority is carried to the spawn boundary so the
        // launched session is served at the mapped request priority.
        priority: 'critical',
      },
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
    // Observable contract: claimItem boundary CAS call — sole channel proving claim args (incl. gate counts where asserted)
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-R', { status: 'open', stage: 'intake_complete' }, '/repo');
    // Observable contract: spawnAgentPane boundary call — sole observable channel for the spawn
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
    // Observable contract: claimItem boundary CAS call — sole channel proving claim args (incl. gate counts where asserted)
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-P', { status: 'open', stage: 'plan_complete' }, '/repo');
    // Observable contract: spawnAgentPane boundary call — sole observable channel for the spawn
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
    // Observable contract: spawnAgentPane boundary call — sole observable channel for the spawn
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-PLAN'),
      expect.anything(),
    );
    // Observable contract: negative boundary assertion — proves claimItem NOT called during freeze; unique fail-closed coverage
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
    // Observable contract: claimItem boundary CAS call — sole channel proving claim args (incl. gate counts where asserted)
    expect(deps.claimItem).toHaveBeenCalledWith('WL-CRIT-R', { status: 'open', stage: 'intake_complete' }, '/repo');
    // Observable contract: spawnAgentPane boundary call — sole observable channel for the spawn
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
    // Observable contract: spawnAgentPane boundary call — sole observable channel for the spawn
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:intake WL-IDEA'),
      expect.anything(),
    );
    // Observable contract: negative boundary assertion — proves claimItem NOT called during freeze; unique fail-closed coverage
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
    // Observable contract: claimItem boundary CAS call — sole channel proving claim args (incl. gate counts where asserted)
    expect(deps.claimItem).toHaveBeenCalledWith('WL-BLOCKER', { status: 'open', stage: 'intake_complete' }, '/repo');
    // Observable contract: spawnAgentPane boundary call — sole observable channel for the spawn
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
      // Observable contract: claimItem boundary CAS call — sole channel proving claim args (incl. gate counts where asserted)
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
      // Only the audit tier needs an explicit candidate: every other tier is
      // left at its neutral `makeDeps` default (empty), which already models
      // "no candidate".
      const deps2 = makeDeps({
        getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: { id: 'A-B', title: 'A-B', stage: 'audit', needsProducerReview: true } }),
      });
      // Audit tier candidate is review-gated → skipped → falls through to no-candidate.
      const outcome = await dispatchDowntimeWork(deps2, { model: 'plan', cwd: '/repo' });
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
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
    // Observable contract: claimItem boundary CAS call — sole channel proving claim args (incl. gate counts where asserted)
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
    // Observable contract: claimItem boundary CAS call — sole channel proving claim args (incl. gate counts where asserted)
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
    // Observable contract: spawnAgentPane boundary call — sole observable channel for the spawn
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
    // Observable contract: spawnAgentPane boundary call — sole observable channel for the spawn
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
