/**
 * packages/herdr/src/downtime-worker.cpu-gate.test.ts — host-CPU dispatch
 * gate behaviour (WL-0MVK0UO3Q002TXW6).
 *
 * Covers AC1–AC4 at the dispatcher boundary:
 *   - fail-open when the seam is unwired / throws / returns an unusable
 *     reading (dispatch unchanged);
 *   - the threshold boundary (`== threshold` blocks, `threshold − ε` allows)
 *     and `0` disabling the gate;
 *   - per-kind scope: audit + implement refused (including a CRITICAL
 *     implement), plan / intake / risk-effort still dispatch;
 *   - the stalled-pane resume is skipped while gated;
 *   - every dispatch path: direct Herdr head, coordination offer, own-backlog
 *     fallback and the audit-batch continuation (coordination entries are
 *     never evicted);
 *   - the neutral `cpu-saturated` terminal reason + decision-log evidence
 *     (measured percent, source, threshold), code-freeze precedence, and the
 *     worker tick wiring.
 *
 * The metric maths itself is pinned in `host-cpu.test.ts`; this suite pins
 * the GATE. `readHostCpu` is always injected — no test reads the real
 * `/proc/stat`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CPU_SATURATED_REASON,
  computeMostImportantItem,
  createDowntimePoller,
  createDowntimeWorker,
  decisionHeaderToken,
  dispatchDowntimeWork,
  dispatchFromCoordination,
  type DowntimeHerdrItem,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import { DEFAULT_DOWNTIME_CPU_GATE_PERCENT } from './host-cpu.js';
import { isCapacityRefusal } from './capacity-starvation.js';
import {
  idleAllSlotsFree,
  jsonResponseFixture,
  makeDeps,
} from './downtime-worker.fixtures.js';
import { writeCoordinationFile, getEntry } from './coordination.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const CWD = '/repo';
const FRESH = new Date(Date.now() - 60_000).toISOString();

/** A `readHostCpu` seam reporting `percent` from the given source. */
function cpuSeam(
  percent: number,
  source: 'proc-stat' | 'loadavg' = 'proc-stat',
): () => { ok: true; percent: number; source: 'proc-stat' | 'loadavg' } {
  return () => ({ ok: true, percent, source });
}

const auditItem = (id = 'AUD-1'): DowntimeHerdrItem => ({
  id,
  title: `Audit ${id}`,
  status: 'completed',
  stage: 'in_review',
  updatedAt: FRESH,
  sortIndex: 10,
});

const implementItem = (id = 'IMP-1', priority = 'high'): DowntimeHerdrItem => ({
  id,
  title: `Implement ${id}`,
  status: 'open',
  stage: 'plan_complete',
  risk: 'Low',
  effort: 'S',
  priority,
  sortIndex: 20,
});

const planItem = (id = 'PLAN-1'): DowntimeHerdrItem => ({
  id,
  title: `Plan ${id}`,
  status: 'open',
  stage: 'intake_complete',
  sortIndex: 30,
});

const intakeItem = (id = 'INT-1'): DowntimeHerdrItem => ({
  id,
  title: `Intake ${id}`,
  status: 'open',
  stage: 'idea',
  sortIndex: 40,
});

/** An open item stuck on the retired `in_progress` stage → risk-effort. */
const riskEffortItem = (id = 'RISK-1'): DowntimeHerdrItem => ({
  id,
  title: `Risk ${id}`,
  status: 'open',
  stage: 'in_progress',
  sortIndex: 50,
});

/** Deps whose Herdr head is the given items. */
function headDeps(
  items: DowntimeHerdrItem[],
  overrides: Partial<DowntimeWorkerDeps> = {},
): DowntimeWorkerDeps {
  return makeDeps({
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items }),
    ...overrides,
  });
}

// ── Fail-open seam (AC1) ──────────────────────────────────────────────

describe('host-CPU gate — fail-open seam (AC1)', () => {
  it.each([
    ['unwired (no readHostCpu dep)', {}],
    ['returns { ok: false }', { readHostCpu: () => ({ ok: false as const }) }],
    ['throws', { readHostCpu: () => { throw new Error('EPERM'); } }],
    [
      'returns NaN',
      { readHostCpu: () => ({ ok: true as const, percent: Number.NaN, source: 'proc-stat' as const }) },
    ],
    [
      'returns an out-of-range percent',
      { readHostCpu: () => ({ ok: true as const, percent: 130, source: 'proc-stat' as const }) },
    ],
  ])('dispatches unchanged when the reading %s', async (_label, overrides) => {
    const deps = headDeps([auditItem()], overrides as Partial<DowntimeWorkerDeps>);
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
  });
});

// ── Threshold boundary + settings clamp (AC2/AC5) ─────────────────────

describe('host-CPU gate — threshold boundary (AC2)', () => {
  it('allows a reading just below the threshold', async () => {
    const deps = headDeps([auditItem()], { readHostCpu: cpuSeam(74.9) });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome.dispatched).toBe(true);
  });

  it('refuses at exactly the threshold (>= semantics)', async () => {
    const deps = headDeps([auditItem()], { readHostCpu: cpuSeam(75) });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('cpu-saturated');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.claimItem).not.toHaveBeenCalled();
  });

  it('refuses above the threshold', async () => {
    const deps = headDeps([auditItem()], { readHostCpu: cpuSeam(90) });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome.reason).toBe('cpu-saturated');
  });

  it('honours a live custom threshold', async () => {
    const deps = headDeps([auditItem()], { readHostCpu: cpuSeam(60) });
    const refused = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: CWD,
      cpuGatePercent: 50,
    });
    expect(refused.reason).toBe('cpu-saturated');

    const allowed = await dispatchDowntimeWork(
      headDeps([auditItem()], { readHostCpu: cpuSeam(49) }),
      { model: 'plan', cwd: CWD, cpuGatePercent: 50 },
    );
    expect(allowed.dispatched).toBe(true);
  });

  it('`0` disables the gate even at 100 %', async () => {
    const deps = headDeps([auditItem()], { readHostCpu: cpuSeam(100) });
    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: CWD,
      cpuGatePercent: 0,
    });
    expect(outcome.dispatched).toBe(true);
  });

  it('an absent threshold falls back to the documented default (75)', async () => {
    expect(DEFAULT_DOWNTIME_CPU_GATE_PERCENT).toBe(75);
    expect(decisionHeaderToken(CPU_SATURATED_REASON)).toBe('cpu-saturated');
    // `cpu-saturated` is NOT a local-capacity refusal (AC4).
    expect(isCapacityRefusal('cpu-saturated')).toBe(false);
  });
});

// ── Per-kind scope (AC2) ──────────────────────────────────────────────

describe('host-CPU gate — per-kind scope (AC2)', () => {
  it('refuses an audit dispatch', async () => {
    const deps = headDeps([auditItem()], { readHostCpu: cpuSeam(90) });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome).toMatchObject({ dispatched: false, reason: 'cpu-saturated' });
  });

  it('refuses an implement dispatch', async () => {
    const deps = headDeps([implementItem()], { readHostCpu: cpuSeam(90) });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome).toMatchObject({ dispatched: false, reason: 'cpu-saturated' });
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('refuses a CRITICAL implement too (safety gate, critical-first scan)', async () => {
    const deps = headDeps([implementItem('CRIT-1', 'critical')], {
      readHostCpu: cpuSeam(90),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome).toMatchObject({ dispatched: false, reason: 'cpu-saturated' });
    expect(deps.claimItem).not.toHaveBeenCalled();
  });

  it.each([
    ['plan', planItem(), 'plan'],
    ['intake', intakeItem(), 'intake'],
    ['risk-effort', riskEffortItem(), 'risk-effort'],
  ])('still dispatches %s work while gated', async (_label, item, kind) => {
    const deps = headDeps([item], { readHostCpu: cpuSeam(90) });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe(kind);
  });

  it('a critical plan still dispatches while a critical implement is held', async () => {
    const deps = headDeps([planItem('CRIT-P')], { readHostCpu: cpuSeam(90) });
    (deps.getHerdrListHead as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      items: [{ ...planItem('CRIT-P'), priority: 'critical' }],
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('a gated implement does not starve a plan candidate behind it', async () => {
    const deps = headDeps([implementItem('IMP-X'), planItem('PLAN-X')], {
      readHostCpu: cpuSeam(90),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('PLAN-X');
  });
});

// ── Neutral semantics + evidence (AC4) ────────────────────────────────

describe('host-CPU gate — neutral reason and evidence (AC4)', () => {
  it('reports the measured percent, source and threshold on the outcome', async () => {
    const deps = headDeps([auditItem()], { readHostCpu: cpuSeam(88, 'loadavg') });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome).toMatchObject({
      dispatched: false,
      reason: 'cpu-saturated',
      hostCpuPercent: 88,
      hostCpuSource: 'loadavg',
      cpuGatePercent: 75,
    });
  });

  it('code-freeze keeps precedence over the CPU gate', async () => {
    const deps = headDeps([auditItem()], {
      readHostCpu: cpuSeam(95),
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(outcome).toMatchObject({ dispatched: false, reason: 'code-freeze' });
    expect(outcome.hostCpuPercent).toBeUndefined();
  });
});

// ── Stalled resume (AC3) ──────────────────────────────────────────────

describe('host-CPU gate — stalled resume (AC3)', () => {
  function stalledDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
    return headDeps([], {
      scanStalledPanes: vi.fn().mockResolvedValue([
        {
          pane: { paneId: 'p1', label: 'Downtime implement X - WL-X', agentStatus: 'idle' },
          item: { id: 'WL-X', title: 'X', status: 'open', stage: 'plan_complete' },
          cwd: CWD,
          kind: 'implement',
          modelCooldown: null,
        },
      ]),
      resumeStalledPane: vi.fn().mockResolvedValue({ resumed: true }),
      ...overrides,
    });
  }

  it('does not resume a stalled pane while gated', async () => {
    const deps = stalledDeps({ readHostCpu: cpuSeam(90) });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(deps.resumeStalledPane).not.toHaveBeenCalled();
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(false);
  });

  it('resumes normally once CPU is below the threshold (unchanged)', async () => {
    const deps = stalledDeps({ readHostCpu: cpuSeam(10) });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: CWD });
    expect(deps.resumeStalledPane).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ dispatched: false, reason: 'stalled-resume' });
  });

  it('the coordination offer computation still offers but never resumes while gated', async () => {
    const deps = stalledDeps({
      readHostCpu: cpuSeam(90),
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [auditItem()] }),
    });
    const result = await computeMostImportantItem(deps, CWD, Date.now(), 20, undefined, undefined, undefined, true, undefined, 75);
    expect(deps.resumeStalledPane).not.toHaveBeenCalled();
    // Offers are NOT gated — the candidate list stays intact (AC4).
    expect('candidate' in result && result.candidate?.id).toBe('AUD-1');
  });
});

// ── Coordination offer path (AC2) ─────────────────────────────────────

describe('host-CPU gate — coordination offer dispatch (AC2/AC4)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'herdr-cpu-gate-coord-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });


  const entry = (instanceId: string, workItemId: string) => ({
    instanceId,
    workItemId,
    directory: CWD,
    assignedAt: FRESH,
    lastUpdated: FRESH,
  });

  function coordinationDeps(
    info: Record<string, unknown>,
    overrides: Partial<DowntimeWorkerDeps> = {},
  ): DowntimeWorkerDeps {
    return makeDeps({
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: {
          id: 'WL-C',
          title: 'Coord item',
          status: 'open',
          stage: 'idea',
          ...info,
        },
      }),
      ...overrides,
    });
  }

  it('refuses an audit offer but KEEPS the coordination entry', async () => {
    const e = entry('inst-audit', 'WL-C');
    writeCoordinationFile(testDir, { version: 1, entries: [e] });
    const deps = coordinationDeps(
      { status: 'completed', stage: 'in_review', updatedAt: FRESH },
      { readHostCpu: cpuSeam(90) },
    );
    const outcome = await dispatchFromCoordination(deps, [e], {
      model: 'plan',
      cwd: CWD,
      coordinationDir: testDir,
    });
    expect(outcome).toMatchObject({ dispatched: false, reason: 'cpu-saturated' });
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    // AC4: a gated tick never removes a coordination entry.
    expect(getEntry(testDir, 'inst-audit')).not.toBe(null);
  });

  it('refuses an implement offer', async () => {
    const e = entry('inst-impl', 'WL-C');
    writeCoordinationFile(testDir, { version: 1, entries: [e] });
    const deps = coordinationDeps(
      { stage: 'plan_complete', risk: 'Low', effort: 'S' },
      { readHostCpu: cpuSeam(90) },
    );
    const outcome = await dispatchFromCoordination(deps, [e], {
      model: 'plan',
      cwd: CWD,
      coordinationDir: testDir,
    });
    expect(outcome.reason).toBe('cpu-saturated');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(getEntry(testDir, 'inst-impl')).not.toBe(null);
  });

  it('still dispatches a plan offer while gated', async () => {
    const e = entry('inst-plan', 'WL-C');
    const deps = coordinationDeps(
      { stage: 'intake_complete' },
      { readHostCpu: cpuSeam(90) },
    );
    const outcome = await dispatchFromCoordination(deps, [e], {
      model: 'plan',
      cwd: CWD,
      coordinationDir: testDir,
    });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });
});

// ── Own-backlog fallback + audit-batch continuation (AC2) ─────────────

describe('host-CPU gate — own-backlog fallback and batch continuation (AC2)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'herdr-cpu-gate-own-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Head lookup returning the sprint-window head on the FIRST call and the
   * extended (beyond-window) tail on the second — the own-backlog path reads
   * the identical ranking twice (never a second ranking).
   */
  function windowDeps(
    tail: DowntimeHerdrItem[],
    overrides: Partial<DowntimeWorkerDeps> = {},
  ): DowntimeWorkerDeps {
    const list = vi.fn().mockImplementation(async (_cwd: string, limit?: number) => ({
      ok: true,
      items: limit !== undefined && limit > 20 ? tail : [],
    }));
    return makeDeps({
      getHerdrListHead: list,
      // Non-leader callers still fail closed on the dep; this suite drives the
      // leader path with no offers, so a stub is enough.
      fetchItem: vi.fn(),
      ...overrides,
    });
  }

  it('refuses an implement target from the own-backlog fallback', async () => {
    const deps = windowDeps([implementItem('TAIL-IMP')], { readHostCpu: cpuSeam(90) });
    const outcome = await dispatchFromCoordination(deps, [], {
      model: 'plan',
      cwd: CWD,
      coordinationDir: testDir,
    });
    expect(outcome).toMatchObject({ dispatched: false, reason: 'cpu-saturated' });
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('still dispatches a plan target from the own-backlog fallback while gated', async () => {
    const deps = windowDeps([planItem('TAIL-PLAN')], { readHostCpu: cpuSeam(90) });
    const outcome = await dispatchFromCoordination(deps, [], {
      model: 'plan',
      cwd: CWD,
      coordinationDir: testDir,
    });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('TAIL-PLAN');
  });

  it('refuses the audit-batch continuation while gated', async () => {
    const deps = windowDeps([auditItem('TAIL-AUD')], { readHostCpu: cpuSeam(90) });
    const outcome = await dispatchFromCoordination(deps, [], {
      model: 'plan',
      cwd: CWD,
      coordinationDir: testDir,
      auditBatchMax: 2,
      auditBatchRemaining: 2,
    });
    expect(outcome).toMatchObject({ dispatched: false, reason: 'cpu-saturated' });
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('runs the audit-batch continuation normally just below the threshold', async () => {
    const deps = windowDeps([auditItem('TAIL-AUD')], { readHostCpu: cpuSeam(20) });
    const outcome = await dispatchFromCoordination(deps, [], {
      model: 'plan',
      cwd: CWD,
      coordinationDir: testDir,
      auditBatchMax: 2,
      auditBatchRemaining: 2,
    });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(outcome.auditBatchContinuation).toBe(true);
  });
});

// ── Worker tick wiring + decision-log evidence (AC4) ──────────────────

describe('host-CPU gate — worker tick decision log (AC4)', () => {
  it('records `cpu-saturated` with the measured CPU evidence and sets the header token', async () => {
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [auditItem()] }),
      readHostCpu: cpuSeam(91, 'proc-stat'),
      recordDecision,
    });
    const worker = createDowntimeWorker({
      poller: createDowntimePoller(
        'http://proxy:8000',
        vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree)),
      ),
      deps,
      config: () => ({
        enabled: true,
        thresholdMs: 0,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: CWD,
        noCandidateCooldownMs: 3_600_000,
        browseItemCount: 20,
        cpuGatePercent: 75,
      }),
    });

    const result = await worker.tick();
    // The decision log write is fired with `void`; let the microtask settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.dispatched).toBe(false);
    const cpuEntry = recordDecision.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((e) => e.reason === 'cpu-saturated');
    expect(cpuEntry).toBeDefined();
    expect(cpuEntry).toMatchObject({
      reason: 'cpu-saturated',
      hostCpuPercent: 91,
      hostCpuSource: 'proc-stat',
      cpuGatePercent: 75,
    });
    expect(worker.blockReason).toBe('cpu-saturated');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('keeps polling (no no-candidate cooldown, no strike) on a gated tick', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementItem()] }),
      readHostCpu: cpuSeam(90),
      recordError,
    });
    const worker = createDowntimeWorker({
      poller: createDowntimePoller(
        'http://proxy:8000',
        vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree)),
      ),
      deps,
      config: () => ({
        enabled: true,
        thresholdMs: 0,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: CWD,
        noCandidateCooldownMs: 3_600_000,
        browseItemCount: 20,
        cpuGatePercent: 75,
      }),
    });

    const first = await worker.tick();
    const second = await worker.tick();
    // Neither tick pauses the worker: the gate is neutral.
    expect(first.dispatched).toBe(false);
    expect(second.polled).toBe(true);
    expect(recordError).not.toHaveBeenCalled();
    expect(worker.blockReason).toBe('cpu-saturated');
  });
});
