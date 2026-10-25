/**
 * End-to-end parent AC report (F7 — WL-0MVJV2QHO003K6H3).
 *
 * F1–F6 each verify one slice of the parent epic
 * (WL-0MVJC1EQX001QR9W). F7 needs the opposite: one report that proves every
 * parent acceptance criterion holds *together*, after all the fixes, at the
 * operator's real scale. `buildAcReport()` is the deterministic aggregation
 * (pure, so the AC mapping is tested against synthetic measurements here);
 * `runAcReport()` is the evidence run (`npm run test:perf:large --
 * --ac-report`). This suite pins both: the policy mapping exhaustively, and a
 * real (small-scale) end-to-end run so the wiring cannot rot.
 */

import { describe, it, expect } from 'vitest';

import {
  LARGE_DB_PROFILES,
  baselineFromReport,
  buildAcReport,
  defaultLargeDbBudget,
  formatAcReport,
  readLargeDbBudget,
  runAcReport,
  withinSpawnMemoryBudget,
  REPO_ROOT,
  type LargeDbAcReportInputs,
  type LargeDbBudget,
  type LargeDbReport,
  type SpawnCapPhaseReport,
  type SpawnCapScenarioReport,
  type SyncInFlightReport,
  type ExpandReadMetrics,
} from '../test/perf/large-db-harness.js';

const repoRoot = REPO_ROOT;

function phase(overrides: Partial<SpawnCapPhaseReport> = {}): SpawnCapPhaseReport {
  return {
    cap: 1,
    burst: 8,
    peakConcurrentSpawns: 1,
    spawns: 8,
    peakRssPerSpawnMb: 120,
    aggregateRssBoundMb: 120,
    eventLoopBlockedMs: 60,
    maxEventLoopBlockedMs: 30,
    wallMs: 3_000,
    ...overrides,
  };
}

function refreshReport(overrides: Partial<LargeDbReport> = {}): LargeDbReport {
  return {
    profile: 'full',
    target: 'dist',
    invocation: 'synthetic',
    node: 'v22.22.1',
    host: 'synthetic',
    capturedAt: '2026-01-01T00:00:00.000Z',
    samples: 5,
    dataset: {
      items: 2_600,
      descriptionChars: 6_000,
      parentGroups: 40,
      expandedParents: 20,
      dependencyEdges: 259,
      dbSizeMb: 123.7,
      diskSizeMb: 123.7,
      generationMs: 1_000,
    },
    refresh: {
      p50WallMs: 200,
      p95WallMs: 300,
      p50CpuMs: 250,
      p95CpuMs: 350,
      eventLoopBlockingP95Ms: 50,
      maxEventLoopBlockedMs: 40,
      spawnsPerRefresh: 1,
      consolidatedWorklistSpawns: 1,
      consolidatedWorklistReads: 5,
      spawnKinds: { 'cache-hit': 5 },
      peakRssPerSpawnMb: 120,
      aggregateSpawnRssMb: 120,
      inProcessOpensPerRefresh: 1,
      inProcessOpenMsP95: 3,
    },
    pane: { peakRssMb: 500, refreshRssDeltaMb: 100, aggregateRssMb: 220 },
    idle: { changed: false, spawns: 0 },
    writeToReflect: {
      detectMs: [150],
      reflectMs: [600],
      p50DetectMs: 150,
      p95DetectMs: 150,
      p50ReflectMs: 600,
      p95ReflectMs: 700,
    },
    samplesDetail: [],
    ...overrides,
  };
}

function syncInFlightReport(overrides: Partial<SyncInFlightReport> = {}): SyncInFlightReport {
  return {
    profile: 'full',
    target: 'dist',
    invocation: 'synthetic',
    samples: 5,
    syncDurationMs: 36_000,
    syncPid: 123,
    syncStateAtSpawn: 'syncing',
    spawnBlockingMs: 1,
    noticeWhileInFlight: '⟳ syncing… 3s',
    baseline: [],
    withSync: [{ spawns: 1, eventLoopBlockedMs: 20 } as never],
    minRemainingAtEndMs: 30_000,
    noWaitGap: true,
    settledState: 'synced',
    lastOutcomeSuccess: true,
    hostConditions: {
      loadPerCore: { start: 0.2, max: 0.3, end: 0.2, samples: 5 },
      cpuPercent: 10,
      cpuSource: 'proc-stat',
      idleNoise: { durationMs: 250, blockedMs: 0, maxBlockedMs: 0 },
    },
    ...overrides,
  };
}

function spawnCapReport(overrides: Partial<SpawnCapScenarioReport> = {}): SpawnCapScenarioReport {
  return {
    profile: 'full',
    target: 'dist',
    datasetItems: 2_600,
    capped: phase(),
    uncapped: phase({ cap: 8, peakConcurrentSpawns: 8, aggregateRssBoundMb: 960 }),
    ok: true,
    violations: [],
    ...overrides,
  };
}

function expandReport(overrides: Partial<ExpandReadMetrics> = {}): ExpandReadMetrics {
  return {
    profile: 'full',
    target: 'dist',
    datasetItems: 2_600,
    expandSpawns: 0,
    expandWallMs: 40,
    expandChildren: 4,
    childrenMatchCli: true,
    hydratorDepSpawns: 0,
    hydratorDepWallMs: 20,
    hydratorDepItems: 10,
    dependencyRowsMatchCli: true,
    ...overrides,
  };
}

/**
 * A budget with recorded full-scale baselines derived from the synthetic
 * report, so the ratchet verdict in the pure tests is exercised against a
 * complete budget (an empty baseline would fail every evaluation).
 */
function budgetWithBaselines(enforced = false): LargeDbBudget {
  const budget = defaultLargeDbBudget();
  budget.profiles.full = {
    scale: { ...LARGE_DB_PROFILES.full },
    baselines: { dist: baselineFromReport(refreshReport()) },
  };
  budget.acTargets = { ...budget.acTargets, enforced };
  return budget;
}

function acInputs(
  overrides: {
    refresh?: Partial<LargeDbReport>;
    refreshMetrics?: Partial<LargeDbReport['refresh']>;
    idle?: Partial<LargeDbReport['idle']>;
    writeToReflect?: Partial<LargeDbReport['writeToReflect']>;
    sync?: Partial<SyncInFlightReport>;
    spawnCap?: Partial<SpawnCapScenarioReport>;
    expand?: Partial<ExpandReadMetrics>;
    budget?: LargeDbBudget;
  } = {},
): LargeDbAcReportInputs {
  const refresh = refreshReport(overrides.refresh);
  return {
    refresh: {
      ...refresh,
      refresh: { ...refresh.refresh, ...overrides.refreshMetrics },
      idle: { ...refresh.idle, ...overrides.idle },
      writeToReflect: { ...refresh.writeToReflect, ...overrides.writeToReflect },
    },
    syncInFlight: syncInFlightReport(overrides.sync),
    spawnCap: spawnCapReport(overrides.spawnCap),
    expand: expandReport(overrides.expand),
    budget: overrides.budget ?? budgetWithBaselines(),
  };
}

const verdict = (inputs: LargeDbAcReportInputs, id: string) => {
  const report = buildAcReport(inputs);
  return report.acs.find((entry) => entry.id === id);
};

describe('end-to-end parent AC report', () => {
  it('aggregates every parent AC into one met report', () => {
    const report = buildAcReport(acInputs());

    expect(report.acs.map((entry) => entry.id)).toEqual(['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6']);
    expect(report.acs.every((entry) => entry.status === 'met')).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.profile).toBe('full');
    expect(report.target).toBe('dist');
    expect(report.dataset.items).toBe(2_600);
    expect(report.samples).toEqual({ refresh: 5, writeToReflect: 1, syncInFlight: 5 });
    // Every AC carries at least one measured number and its evidence source.
    for (const entry of report.acs) {
      expect(entry.measurements.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeGreaterThan(0);
    }
    // The raw scenario reports are attached so quoted numbers are reproducible.
    expect(report.evidence.refresh.dataset.items).toBe(2_600);
    expect(report.evidence.syncInFlight.noWaitGap).toBe(true);
    expect(report.evidence.spawnCap.capped.peakConcurrentSpawns).toBe(1);
    expect(report.evidence.expand.expandSpawns).toBe(0);
    expect(report.evidence.openBudgetViolations).toEqual([]);
    expect(report.budget.evaluation.ok).toBe(true);
  });

  it('marks AC1 unmet when a refresh blocks the event loop past the budget', () => {
    const inputs = acInputs({ refreshMetrics: { eventLoopBlockingP95Ms: 250 } });
    expect(verdict(inputs, 'AC1')?.status).toBe('unmet');
    expect(buildAcReport(inputs).ok).toBe(false);
  });

  it('marks AC1 unmet when the capped spawn burst blocks input', () => {
    const inputs = acInputs({
      spawnCap: { capped: phase({ eventLoopBlockedMs: 250 }) },
    });
    expect(verdict(inputs, 'AC1')?.status).toBe('unmet');
  });

  it('marks AC2 unmet when a refresh fans out beyond the consolidated read', () => {
    const inputs = acInputs({ refreshMetrics: { spawnsPerRefresh: 5 } });
    expect(verdict(inputs, 'AC2')?.status).toBe('unmet');
  });

  it('marks AC2 unmet when expanding a node falls back to a spawn', () => {
    const inputs = acInputs({ expand: { expandSpawns: 2 } });
    expect(verdict(inputs, 'AC2')?.status).toBe('unmet');
  });

  it('marks AC2 unmet when the refresh misses the wall-clock target', () => {
    const inputs = acInputs({ refreshMetrics: { p95WallMs: 1_600 } });
    expect(verdict(inputs, 'AC2')?.status).toBe('unmet');
  });

  it('marks AC3 unmet when a refresh waits for the in-flight sync', () => {
    const inputs = acInputs({ sync: { noWaitGap: false } });
    expect(verdict(inputs, 'AC3')?.status).toBe('unmet');
  });

  it('marks AC3 unmet when the sync spawn blocks the event loop', () => {
    const inputs = acInputs({ sync: { spawnBlockingMs: 300 } });
    expect(verdict(inputs, 'AC3')?.status).toBe('unmet');
  });

  it('marks AC4 unmet when reflection exceeds two seconds', () => {
    const inputs = acInputs({ writeToReflect: { p95ReflectMs: 2_500 } });
    expect(verdict(inputs, 'AC4')?.status).toBe('unmet');
  });

  it('satisfies AC5 via the capped fan-out when the per-spawn peak exceeds the budget', () => {
    // Route (b): 148.2 MB per spawn > the 130 MB budget, but the cap of 1
    // bounds the aggregate at 148.2 MB — inside the 300 MB pane ceiling, so
    // the AC's OR is met.
    const inputs = acInputs({
      refreshMetrics: { peakRssPerSpawnMb: 148.2 },
      spawnCap: { capped: phase({ peakRssPerSpawnMb: 148.2, aggregateRssBoundMb: 148.2 }) },
    });
    const ac5 = verdict(inputs, 'AC5');
    expect(ac5?.status).toBe('met');
    expect(
      withinSpawnMemoryBudget(148.2, defaultLargeDbBudget().acTargets),
    ).toBe(true);
  });

  it('marks AC5 unmet when both memory routes are missed', () => {
    // 350 MB per spawn: over the 130 MB budget, and cap 1 × 350 = 350 MB >
    // the 300 MB ceiling.
    const inputs = acInputs({
      refreshMetrics: { peakRssPerSpawnMb: 350 },
      spawnCap: { capped: phase({ peakRssPerSpawnMb: 350, aggregateRssBoundMb: 350 }) },
    });
    expect(verdict(inputs, 'AC5')?.status).toBe('unmet');
    expect(withinSpawnMemoryBudget(350, defaultLargeDbBudget().acTargets)).toBe(false);
  });

  it('marks AC6 unmet when an idle tick spawns or the open budget regresses', () => {
    expect(verdict(acInputs({ idle: { spawns: 1 } }), 'AC6')?.status).toBe('unmet');
    expect(
      verdict(acInputs({ refreshMetrics: { inProcessOpenMsP95: 60 } }), 'AC6')?.status,
    ).toBe('unmet');
  });

  it('reports the budget ratchet alongside the AC verdicts', () => {
    const budget = budgetWithBaselines(true);
    const report = buildAcReport(acInputs({ budget }));
    expect(report.budget.enforced).toBe(true);
    expect(report.budget.evaluation.ok).toBe(true);
    expect(report.budget.acTargets.wlSpawnCap).toBe(1);
  });

  it('renders a human summary naming every verdict', () => {
    const text = formatAcReport(buildAcReport(acInputs()));
    expect(text).toContain('ALL 6 PARENT ACs MET');
    for (const id of ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6']) {
      expect(text).toContain(id);
    }
    expect(text).toContain('budget ratchet');
  });

  it('keeps the checked-in budget describing the enforced end-to-end run', () => {
    const budget = readLargeDbBudget(repoRoot);
    expect(budget.acTargets.enforced).toBe(true);
    expect(budget.acTargets.wlSpawnCap).toBe(1);
    expect(budget.commands.acReport).toContain('--ac-report');
    // The full-scale `dist` baseline recorded by F7 is inside the AC targets.
    const fullDist = budget.profiles.full?.baselines.dist;
    expect(fullDist).toBeDefined();
    expect(fullDist?.metrics.refreshP95WallMs).toBeLessThanOrEqual(
      budget.acTargets.refreshP95WallMs,
    );
    expect(fullDist?.metrics.writeToReflectP95Ms).toBeLessThanOrEqual(
      budget.acTargets.writeToReflectP95Ms,
    );
    expect(fullDist?.metrics.spawnsPerRefresh).toBe(budget.acTargets.spawnsPerRefresh);
  });
});

describe('end-to-end parent AC report — measured wiring', { timeout: 240_000 }, () => {
  it('runs every scenario in one pass and aggregates a real report', async () => {
    // A small coherent fixture so the default suite can exercise the full
    // wiring (each scenario generates its own throwaway worklog).
    const report = await runAcReport({
      profile: 'default',
      scale: {
        items: 80,
        descriptionChars: 500,
        commentsPerItem: 1,
        commentChars: 200,
        parentGroups: 5,
        childrenPerParent: 2,
        grandchildrenPerParent: 2,
        dependencyEvery: 10,
        expandedParents: 5,
        browseCount: 20,
      },
      samples: 1,
      writeSamples: 1,
      // Pure arithmetic (no sleep); long enough that even a loaded-host
      // refresh finishes while the simulated sync is still in flight.
      syncDurationMs: 36_000,
      burst: 3,
    });

    expect(report.acs.map((entry) => entry.id)).toEqual(['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6']);
    expect(report.ok).toBe(report.acs.every((entry) => entry.status === 'met'));

    // Structural invariants that hold regardless of host load:
    // zero-spawn expand/hydrator reads (F4) and the consolidated refresh read.
    expect(report.evidence.expand.expandSpawns).toBe(0);
    expect(report.evidence.expand.hydratorDepSpawns).toBe(0);
    expect(report.evidence.expand.childrenMatchCli).toBe(true);
    expect(report.evidence.refresh.refresh.spawnsPerRefresh).toBe(1);
    expect(report.evidence.refresh.idle.spawns).toBe(0);
    // The sync-in-flight refresh never waits for the sync (absolute invariant).
    expect(report.evidence.syncInFlight.noWaitGap).toBe(true);
    expect(report.evidence.syncInFlight.noticeWhileInFlight).toMatch(/syncing/i);
    // The spawn cap held and nothing was dropped.
    expect(report.evidence.spawnCap.capped.peakConcurrentSpawns).toBeLessThanOrEqual(1);
    expect(report.evidence.spawnCap.capped.spawns).toBe(3);
    // The report is one serialisable JSON document.
    expect(JSON.parse(JSON.stringify(report)).acs.length).toBe(6);
    expect(formatAcReport(report)).toContain('parent AC report');
  });
});
