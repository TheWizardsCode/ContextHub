/**
 * Large-DB refresh budget ratchet (F1 — WL-0MVJV2N3A001LE5G).
 *
 * The parent epic (WL-0MVJC1EQX001QR9W) has no checked-in large-DB harness
 * today, so its acceptance criteria (refresh ≤ ~1.5 s p95, event-loop blocking
 * ≤ ~200 ms, spawn/RSS budgets, write → reflect ≤ 2 s at ~2,600 items /
 * ~100 MB) could only be quoted ad hoc and a regression between the F3–F6 fix
 * items would go unnoticed. This suite is the ratchet:
 *
 *   1. FIXTURE — the generator is deterministic, builds a nested
 *      parent/child + dependency-edge worklog in a throwaway temp `.worklog`
 *      (never the repository's own), and is fast enough for the default suite.
 *   2. POLICY — the regression policy (CPU gate + documented headroom,
 *      spawn/idle invariants, RSS headroom, AC targets only when enforced) is
 *      exercised against synthetic reports so it is deterministic.
 *   3. MEASURED — a real harness run at the recorded `default` profile must
 *      stay inside the recorded budget plus headroom, keeping the documented
 *      no-regression invariants: exactly one consolidated `wl worklist` read
 *      per refresh and zero spawns on an idle tick.
 *
 * The full-scale profile (~2,600 items / ~100 MB) is run on demand:
 * `npm run test:perf:large`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WorklogDatabase } from '../../../src/database.js';
import {
  BUDGET_RELATIVE_PATH,
  LARGE_DB_PROFILES,
  REPO_ROOT,
  baselineFromReport,
  defaultLargeDbBudget,
  evaluateLargeDbBudget,
  generateLargeWorklog,
  parseCliArgs,
  percentile,
  readLargeDbBudget,
  runExpandReadProfile,
  runLargeDbHarness,
  withinAcTargets,
  type LargeDbBaseline,
  type LargeDbBudget,
  type LargeDbEvaluationInput,
  type LargeDbReport,
  type LargeDbScale,
} from '../test/perf/large-db-harness.js';

const repoRoot = REPO_ROOT;

/** A complete synthetic report for policy tests (independent of the harness). */
function syntheticInput(
  overrides: {
    refresh?: Partial<LargeDbEvaluationInput['refresh']>;
    pane?: Partial<LargeDbEvaluationInput['pane']>;
    idle?: Partial<LargeDbEvaluationInput['idle']>;
    writeToReflect?: Partial<LargeDbEvaluationInput['writeToReflect']>;
    profile?: string;
    target?: string;
  } = {},
): LargeDbEvaluationInput {
  return {
    profile: overrides.profile ?? 'default',
    target: overrides.target ?? 'src',
    refresh: {
      p95WallMs: 1000,
      p95CpuMs: 800,
      eventLoopBlockingP95Ms: 40,
      maxEventLoopBlockedMs: 30,
      spawnsPerRefresh: 1,
      consolidatedWorklistSpawns: 1,
      peakRssPerSpawnMb: 100,
      aggregateSpawnRssMb: 100,
      ...overrides.refresh,
    },
    pane: { peakRssMb: 150, aggregateRssMb: 150, ...overrides.pane },
    idle: { changed: false, spawns: 0, ...overrides.idle },
    writeToReflect: { p95ReflectMs: 700, ...overrides.writeToReflect },
  };
}

/** A budget with known numbers, independent of the checked-in file. */
function syntheticBudget(overrides: Partial<LargeDbBudget> = {}): LargeDbBudget {
  const budget = defaultLargeDbBudget();
  budget.profiles = {
    default: {
      scale: { ...LARGE_DB_PROFILES.default },
      baselines: {
        src: {
          capturedAt: '2026-01-01T00:00:00.000Z',
          node: process.version,
          host: 'synthetic',
          target: 'src',
          method: 'synthetic',
          dataset: {
            items: 300,
            descriptionChars: 8000,
            parentGroups: 12,
            expandedParents: 12,
            dependencyEdges: 29,
            dbSizeMb: 2.6,
            diskSizeMb: 2.6,
            generationMs: 250,
          },
          metrics: {
            refreshP50WallMs: 900,
            refreshP95WallMs: 1000,
            refreshP95CpuMs: 800,
            eventLoopBlockingP95Ms: 40,
            maxEventLoopBlockedMs: 30,
            spawnsPerRefresh: 1,
            peakRssPerSpawnMb: 100,
            aggregateSpawnRssMb: 100,
            paneAggregateRssMb: 150,
            writeToReflectP95Ms: 700,
          },
        },
      },
    },
    full: {
      scale: { ...LARGE_DB_PROFILES.full },
      baselines: {},
    },
  };
  return { ...budget, ...overrides };
}

describe('large-DB fixture generator', { timeout: 120_000 }, () => {
  it('builds the requested nested dataset inside a throwaway temp worklog', () => {
    const fixture = generateLargeWorklog(LARGE_DB_PROFILES.default);
    try {
      // Temp-only: the repository's own `.worklog` is never touched.
      expect(fixture.rootDir.startsWith(os.tmpdir())).toBe(true);
      expect(fixture.rootDir.startsWith(repoRoot)).toBe(false);
      expect(fixture.dbPath).toBe(path.join(fixture.worklogDir, 'worklog.db'));
      expect(fs.existsSync(fixture.dbPath)).toBe(true);
      // Ephemeral-JSONL pattern: SQLite is the runtime source of truth.
      expect(fs.existsSync(path.join(fixture.worklogDir, 'worklog-data.jsonl'))).toBe(false);

      expect(fixture.itemCount).toBe(LARGE_DB_PROFILES.default.items);
      expect(fixture.parentIds.length).toBe(LARGE_DB_PROFILES.default.parentGroups);
      expect(fixture.expandedParentIds.length).toBe(LARGE_DB_PROFILES.default.expandedParents);
      // A real large DB is not flat: nested subtrees and dependency edges.
      expect(fixture.dependencyEdges).toBeGreaterThan(0);
      expect(fixture.dbSizeMb).toBeGreaterThan(1);
      // Fast enough for a default-suite run (~20 s ceiling).
      expect(fixture.generationMs).toBeLessThan(20_000);

      const db = new WorklogDatabase(
        'LDB',
        fixture.dbPath,
        path.join(fixture.worklogDir, 'worklog-data.jsonl'),
        true,
        false,
      );
      try {
        const items = db.list({});
        expect(items.length).toBe(fixture.itemCount);
        const nested = items.filter((item) => item.parentId !== null && item.parentId !== undefined);
        expect(nested.length).toBeGreaterThan(fixture.parentIds.length);
        // Nested parents own children and grandchildren (two levels deep).
        const parentIds = new Set(fixture.parentIds);
        const children = nested.filter((item) => parentIds.has(String(item.parentId)));
        expect(children.length).toBeGreaterThan(0);
        const childIds = new Set(children.map((item) => item.id));
        const grandchildren = nested.filter((item) => childIds.has(String(item.parentId)));
        expect(grandchildren.length).toBeGreaterThan(0);

        // Dependency edges, including at least one outbound edge per recorded
        // edge (the generator writes one every `dependencyEvery` items).
        const edgesFrom = items
          .slice(0, 40)
          .filter((item) => db.listDependencyEdgesFrom(item.id).length > 0);
        expect(edgesFrom.length).toBeGreaterThan(0);

        // The default view's mandatory review-queue subset is populated, so the
        // measured refresh exercises a real large-DB cost driver.
        expect(items.some((item) => item.status === 'completed' && item.stage === 'in_review')).toBe(
          true,
        );
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
    expect(fs.existsSync(fixture.rootDir)).toBe(false);
  });

  it('is deterministic for the same seed', () => {
    const first = generateLargeWorklog(LARGE_DB_PROFILES.default);
    const second = generateLargeWorklog(LARGE_DB_PROFILES.default);
    try {
      expect(second.itemCount).toBe(first.itemCount);
      expect(second.dependencyEdges).toBe(first.dependencyEdges);
      expect(second.parentIds).toEqual(first.parentIds);
      expect(second.expandedParentIds).toEqual(first.expandedParentIds);
      expect(second.dbSizeMb).toBe(first.dbSizeMb);
      expect(second.diskSizeMb).toBe(first.diskSizeMb);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  it('scales the on-demand full profile to the parent’s stated large-DB shape', () => {
    // Shape only (no generation): 2,600 items whose descriptions + comments
    // produce ~100 MB on disk (the recorded baseline measured ~124 MB — the
    // operator's own worklog is ~109 MB, so this is the same order of scale).
    const full: LargeDbScale = LARGE_DB_PROFILES.full;
    expect(full.items).toBeGreaterThanOrEqual(2_500);
    expect(full.commentsPerItem).toBeGreaterThan(0);
    const textBytes = full.items * (full.descriptionChars + full.commentsPerItem * full.commentChars);
    expect(textBytes).toBeGreaterThan(40_000_000);
    expect(full.expandedParents).toBeGreaterThanOrEqual(20);
    expect(full.parentGroups * full.childrenPerParent).toBeLessThan(full.items);
  });
});

describe('large-DB budget file', () => {
  it('records both profiles, the parent AC targets and the measurement commands', () => {
    const budget = readLargeDbBudget(repoRoot);
    expect(budget.version).toBe(1);
    expect(Object.keys(budget.profiles).sort()).toEqual(['default', 'full']);
    expect(budget.profiles.default?.scale.items).toBe(LARGE_DB_PROFILES.default.items);
    expect(budget.profiles.full?.scale.items).toBe(LARGE_DB_PROFILES.full.items);

    // The parent AC targets are recorded verbatim so numbers can be re-quoted.
    expect(budget.acTargets.refreshP95WallMs).toBe(1500);
    expect(budget.acTargets.eventLoopBlockingP95Ms).toBe(200);
    expect(budget.acTargets.paneAggregateRssMb).toBe(300);
    expect(budget.acTargets.writeToReflectP95Ms).toBe(2000);
    expect(budget.acTargets.spawnsPerRefresh).toBe(1);
    expect(budget.acTargets.idleSpawns).toBe(0);

    // Reproducible measurements: commands for both profiles plus re-baseline.
    expect(Object.keys(budget.commands)).toEqual(
      expect.arrayContaining(['defaultProfile', 'fullScale', 'rebaseline']),
    );

    // The default-suite ratchet needs a baseline for every target it can pick.
    expect(budget.profiles.default?.baselines.src).toBeDefined();
    expect(budget.profiles.default?.baselines.dist).toBeDefined();

    // A recorded baseline carries the dataset shape and every metric.
    const baseline = budget.profiles.default?.baselines.dist;
    expect(baseline?.target).toBe('dist');
    expect(baseline?.dataset.items).toBe(LARGE_DB_PROFILES.default.items);
    for (const metric of [
      'refreshP95WallMs',
      'refreshP95CpuMs',
      'eventLoopBlockingP95Ms',
      'spawnsPerRefresh',
      'paneAggregateRssMb',
      'writeToReflectP95Ms',
    ] as const) {
      expect(typeof baseline?.metrics[metric], metric).toBe('number');
    }
    expect(fs.existsSync(path.join(repoRoot, BUDGET_RELATIVE_PATH))).toBe(true);
  });

  it('round-trips a report into the recorded baseline shape', () => {
    const budget = syntheticBudget();
    const report = {
      profile: 'default',
      target: 'src',
      node: process.version,
      host: 'synthetic',
      capturedAt: '2026-01-01T00:00:00.000Z',
      invocation: 'node dist/cli.js <argv>',
      samples: 5,
      dataset: {
        items: 300,
        descriptionChars: 8000,
        parentGroups: 12,
        expandedParents: 12,
        dependencyEdges: 29,
        dbSizeMb: 2.6,
        diskSizeMb: 2.6,
        generationMs: 250,
      },
      refresh: {
        p50WallMs: 900,
        p95WallMs: 1000,
        p50CpuMs: 700,
        p95CpuMs: 800,
        eventLoopBlockingP95Ms: 40,
        maxEventLoopBlockedMs: 30,
        spawnsPerRefresh: 1,
        consolidatedWorklistSpawns: 1,
        consolidatedWorklistReads: 5,
        spawnKinds: { 'cache-hit': 5 },
        peakRssPerSpawnMb: 100,
        aggregateSpawnRssMb: 100,
      },
      pane: { peakRssMb: 150, refreshRssDeltaMb: 50, aggregateRssMb: 150 },
      idle: { changed: false, spawns: 0 },
      writeToReflect: {
        detectMs: [160],
        reflectMs: [700],
        p50DetectMs: 160,
        p95DetectMs: 160,
        p50ReflectMs: 700,
        p95ReflectMs: 700,
      },
      samplesDetail: [],
    } as unknown as LargeDbReport;

    const baseline = baselineFromReport(report);
    expect(baseline.target).toBe('src');
    expect(baseline.metrics.refreshP95WallMs).toBe(1000);
    expect(baseline.metrics.paneAggregateRssMb).toBe(150);
    expect(baseline.metrics.writeToReflectP95Ms).toBe(700);
    expect(evaluateLargeDbBudget(report, budget).ok).toBe(true);
  });
});

describe('large-DB budget policy', () => {
  it('accepts a measurement within the recorded budget plus headroom', () => {
    const evaluation = evaluateLargeDbBudget(syntheticInput(), syntheticBudget());
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.ok).toBe(true);
  });

  it('flags a CPU-time regression beyond the documented headroom', () => {
    // 800 ms recorded p95 + 100 % headroom = 1600 ms limit.
    const evaluation = evaluateLargeDbBudget(
      syntheticInput({ refresh: { p95CpuMs: 1700 } }),
      syntheticBudget(),
    );
    expect(evaluation.ok).toBe(false);
    expect(evaluation.violations.join('\n')).toContain('refreshP95CpuMs');
  });

  it('tolerates wall-clock inflation from a loaded host (CPU time is the gate)', () => {
    // 3.4× the recorded wall p95, still inside 200 % + 500 ms, with flat CPU.
    const evaluation = evaluateLargeDbBudget(
      syntheticInput({ refresh: { p95WallMs: 3400, p95CpuMs: 810 } }),
      syntheticBudget(),
    );
    expect(evaluation.violations).toEqual([]);
  });

  it('flags a wall-time regression beyond the documented headroom', () => {
    const evaluation = evaluateLargeDbBudget(
      syntheticInput({ refresh: { p95WallMs: 4000 } }),
      syntheticBudget(),
    );
    expect(evaluation.violations.join('\n')).toContain('refreshP95WallMs');
  });

  it('flags a multi-spawn refresh (the consolidated single read must stay the norm)', () => {
    const evaluation = evaluateLargeDbBudget(
      syntheticInput({ refresh: { spawnsPerRefresh: 5, consolidatedWorklistSpawns: 1 } }),
      syntheticBudget(),
    );
    expect(evaluation.ok).toBe(false);
    expect(evaluation.violations.join('\n')).toContain('spawnsPerRefresh');
  });

  it('flags a refresh that did not issue the consolidated `wl worklist` read', () => {
    const evaluation = evaluateLargeDbBudget(
      syntheticInput({ refresh: { consolidatedWorklistSpawns: 0 } }),
      syntheticBudget(),
    );
    expect(evaluation.violations.join('\n')).toContain('consolidatedWorklistSpawns');
  });

  it('keeps the zero-spawn-when-idle guarantee', () => {
    const spawnEvaluation = evaluateLargeDbBudget(
      syntheticInput({ idle: { spawns: 1 } }),
      syntheticBudget(),
    );
    expect(spawnEvaluation.violations.join('\n')).toContain('idleSpawns');

    const changedEvaluation = evaluateLargeDbBudget(
      syntheticInput({ idle: { changed: true } }),
      syntheticBudget(),
    );
    expect(changedEvaluation.violations.join('\n')).toContain('idleChanged');
  });

  it('flags a per-spawn or aggregate RSS regression', () => {
    const perSpawn = evaluateLargeDbBudget(
      syntheticInput({ refresh: { peakRssPerSpawnMb: 130 } }),
      syntheticBudget(),
    );
    expect(perSpawn.violations.join('\n')).toContain('peakRssPerSpawnMb');

    const aggregate = evaluateLargeDbBudget(
      syntheticInput({ pane: { aggregateRssMb: 200 } }),
      syntheticBudget(),
    );
    expect(aggregate.violations.join('\n')).toContain('paneAggregateRssMb');
  });

  it('flags a write → reflect regression beyond the documented headroom', () => {
    const evaluation = evaluateLargeDbBudget(
      syntheticInput({ writeToReflect: { p95ReflectMs: 4000 } }),
      syntheticBudget(),
    );
    expect(evaluation.violations.join('\n')).toContain('writeToReflectP95Ms');
  });

  it('reports a missing baseline instead of silently passing', () => {
    const evaluation = evaluateLargeDbBudget(
      syntheticInput({ target: 'dist' }),
      syntheticBudget(),
    );
    expect(evaluation.ok).toBe(false);
    expect(evaluation.violations.join('\n')).toContain('no recorded baseline');
    expect(evaluation.violations.join('\n')).toContain('--update-budget');
  });

  it('asserts the parent AC targets only for the enforced full-scale profile', () => {
    const compliantFull = syntheticInput({ profile: 'full', target: 'dist' });
    const budget = syntheticBudget();
    const recorded = budget.profiles.default?.baselines.src as LargeDbBaseline;
    budget.profiles.full = {
      scale: { ...LARGE_DB_PROFILES.full },
      // A recorded full-scale baseline within target (what F7 records).
      baselines: { dist: { ...recorded, target: 'dist' } },
    };

    // Not enforced: AC numbers are report-only.
    expect(evaluateLargeDbBudget(compliantFull, budget).violations).toEqual([]);

    // Enforced and within target: still passes.
    const enforced: LargeDbBudget = {
      ...budget,
      acTargets: { ...budget.acTargets, enforced: true },
    };
    expect(evaluateLargeDbBudget(compliantFull, enforced).violations).toEqual([]);

    // Enforced and over target: the AC numbers are now asserted.
    const overTarget = evaluateLargeDbBudget(
      syntheticInput({
        profile: 'full',
        target: 'dist',
        refresh: { p95WallMs: 1600, eventLoopBlockingP95Ms: 250 },
        pane: { aggregateRssMb: 350 },
      }),
      enforced,
    );
    const violations = overTarget.violations.join('\n');
    expect(violations).toContain('AC refreshP95WallMs');
    expect(violations).toContain('AC eventLoopBlockingP95Ms');
    expect(violations).toContain('AC paneAggregateRssMb');
  });

  it('reports the parent AC verdicts for a measurement', () => {
    const ac = withinAcTargets(
      {
        refresh: {
          p95WallMs: 1600,
          eventLoopBlockingP95Ms: 250,
          peakRssPerSpawnMb: 140,
          spawnsPerRefresh: 5,
        },
        pane: { aggregateRssMb: 350 },
        idle: { spawns: 0 },
        writeToReflect: { p95ReflectMs: 900 },
      } as unknown as LargeDbReport,
      defaultLargeDbBudget(),
    );
    expect(ac.refreshP95WallMs).toBe(false);
    expect(ac.eventLoopBlockingP95Ms).toBe(false);
    expect(ac.peakRssPerSpawnMb).toBe(false);
    expect(ac.paneAggregateRssMb).toBe(false);
    expect(ac.writeToReflectP95Ms).toBe(true);
    expect(ac.spawnsPerRefresh).toBe(false);
    expect(ac.idleSpawns).toBe(true);
  });

  it('computes the nearest-rank percentile used for the p95 samples', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([], 0.95)).toBeNull();
  });

  it('parses the CLI options the documented commands use', () => {
    expect(parseCliArgs(['--profile', 'full', '--json', '--update-budget'])).toMatchObject({
      profile: 'full',
      json: true,
      updateBudget: true,
    });
    expect(parseCliArgs(['--target', 'dist', '--samples', '3'])).toMatchObject({
      target: 'dist',
      samples: 3,
    });
    // F4 expand profile (WL-0MVJV2ORY002MNFF): the on-demand full-scale run.
    expect(parseCliArgs(['--profile', 'full', '--expand', '--json'])).toMatchObject({
      profile: 'full',
      expand: true,
      json: true,
    });
    expect(() => parseCliArgs(['--profile', 'huge'])).toThrow(/default.*full/);
    expect(() => parseCliArgs(['--target', 'nope'])).toThrow(/auto.*src.*dist/);
    expect(() => parseCliArgs(['--unknown'])).toThrow(/unknown option/);
  });
});

describe('large-DB refresh budget — measured ratchet', { timeout: 300_000 }, () => {
  it('keeps a real default-profile refresh inside the recorded budget', async () => {
    const budget = readLargeDbBudget(repoRoot);
    const profile = budget.profiles.default;
    expect(profile).toBeDefined();

    const report = await runLargeDbHarness({
      profile: 'default',
      scale: profile?.scale,
      samples: budget.regression.refreshSamples,
      writeSamples: budget.regression.writeToReflectSamples,
    });

    // Spawn invariants: one consolidated `wl worklist` read per refresh, and
    // a genuinely idle tick that spawns nothing (parent AC 6 / no regression).
    expect(report.refresh.spawnsPerRefresh).toBe(budget.acTargets.spawnsPerRefresh);
    expect(report.refresh.consolidatedWorklistSpawns).toBe(1);
    expect(report.refresh.consolidatedWorklistReads).toBe(report.samples);
    expect(report.idle).toEqual({ changed: false, spawns: 0 });
    // The read cache served the measured refreshes (no cold re-read per sample).
    expect(report.refresh.spawnKinds['cache-hit']).toBeGreaterThan(0);

    // Write → reflect through the event-driven watch path: the watch fires
    // promptly (debounced) rather than waiting for the 30 s polling tick.
    expect(report.writeToReflect.p95DetectMs).toBeLessThan(2000);
    expect(report.writeToReflect.p95ReflectMs).toBeGreaterThan(0);

    // Metrics are real and positive (no silent zeroes).
    expect(report.samples).toBe(budget.regression.refreshSamples);
    expect(report.refresh.p95WallMs).toBeGreaterThan(0);
    expect(report.refresh.p95CpuMs).toBeGreaterThan(0);
    expect(report.dataset.items).toBe(profile?.scale.items);
    expect(report.samplesDetail.length).toBe(report.samples);

    const evaluation = evaluateLargeDbBudget(report, budget);
    expect(evaluation.violations, evaluation.violations.join('\n')).toEqual([]);
    expect(evaluation.ok).toBe(true);
  });

  it('expands a node and reads hydrator deps with zero spawns, matching the CLI rows (F4)', async () => {
    // F4 (WL-0MVJV2ORY002MNFF): the single-parent expand read and the
    // hydrator's batched dependency read must issue ZERO `wl` spawns on the
    // in-process path, and their rows must match the CLI spawn path's
    // ordering / fields / depth / enrichment semantics exactly. The `full`
    // profile (the operator-scale ~2,600-item fixture) is run on demand via
    // `npm run test:perf:large`; this default-profile run pins the no-spawn
    // + parity invariants in the default suite.
    const metrics = await runExpandReadProfile();

    // AC1: zero `wl list --parent` / `wl dep list` spawns while expanding.
    expect(metrics.expandSpawns).toBe(0);
    expect(metrics.hydratorDepSpawns).toBe(0);
    // The expand returned real children (the sampled expanded parent has a
    // populated subtree on every profile).
    expect(metrics.expandChildren).toBeGreaterThan(0);
    // AC1 correctness half: identical rows to the CLI spawn path.
    expect(metrics.childrenMatchCli).toBe(true);
    expect(metrics.dependencyRowsMatchCli).toBe(true);
    // The batched dep read handled all candidates in one pass.
    expect(metrics.hydratorDepItems).toBeGreaterThan(0);
    // Same fixture logic as the refresh ratchet, so the semantics comparison
    // runs on a real (nested + dependency-edged) worklog.
    expect(metrics.datasetItems).toBe(LARGE_DB_PROFILES.default.items);
  });
});
