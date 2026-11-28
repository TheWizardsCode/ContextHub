/**
 * Contract tests for the in-process CLI harness profiler
 * (WL-0MVVXFXM6007QZ2L, parent WL-0MVHVZMCH0092JCY AC 1).
 *
 * The profiler is the evidence base for the parent's re-scope decision, so
 * these tests pin the parts a wrong answer would hide:
 *
 *   1. nested phases (config load, DB open) are attributed once — inside
 *      `command_action` — so the buckets sum to the top-level attribution and
 *      never double count,
 *   2. the residual is what is left over and the >= 90 % reconciliation rule
 *      actually fails when the residual is large (pinned on *synthetic* data,
 *      see the convention note below),
 *   3. the dominant-phase classification names a millisecond and percentage
 *      share per bucket and answers harness-side vs production startup,
 *   4. the harness instrumentation is **off by default** (no records, unchanged
 *      output) and records the expected phases when switched on,
 *   5. a full profiler run measures the four AC scenarios and reports medians.
 *
 * Convention — live samples vs the >= 90 % outcome. A live in-process call is
 * a few milliseconds, so the untimed gaps (GC, preemption, event-loop stalls)
 * on a contended host can push the residual share past 10 % on any given run.
 * Assertions over *live* samples therefore check flag/share agreement (the
 * `reconciled` flag matches the reported residual share — the residual is
 * never silently dropped) and a loose coverage bound, never the >= 90 %
 * outcome. The >= 90 % rule itself is pinned deterministically on synthetic
 * records (the attribution tests above) and on the checked-in baseline
 * artefact in the serialised measured project
 * (`tests/cli/inproc-harness-budget.test.ts`). Do not reintroduce a live
 * quiet-host share assertion into this parallel `suite` project.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  ATTRIBUTION_BUCKETS,
  DECISION_GATE_SCENARIO,
  INPROC_PROFILE_SCENARIOS,
  MAX_RESIDUAL_SHARE_PCT,
  attributeRecord,
  classifyDominantCost,
  median,
  runInprocHarnessProfile,
  selectScenarios,
  TOP_LEVEL_PHASES,
  type AttributionBucket,
  type InprocAttribution,
} from '../../bench/inproc-harness-profile.js';
import {
  clearInprocProfileRecords,
  getInprocProfileRecords,
  runInProcess,
  type InprocPhaseMark,
  type InprocProfileRecord,
} from '../cli/cli-inproc.js';
import { writeConfig, writeInitSemaphore } from '../cli/cli-helpers.js';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { setWorklogDirOverride } from '../../src/worklog-paths.js';

function syntheticRecord(totalMs: number, marks: InprocPhaseMark[]): InprocProfileRecord {
  return { commandLine: 'node src/cli.ts list --json', args: ['list', '--json'], totalMs, marks };
}

/**
 * Top-level phases summing to 15.2 ms with 1.1 ms of nested time inside the
 * command action (4.0 ms DB open + 1.0 ms config load counted inside its
 * 10.0 ms).
 */
const SYNTHETIC_MARKS: InprocPhaseMark[] = [
  { phase: 'argv', ms: 0.5 },
  { phase: 'harness_patch', ms: 0.2 },
  { phase: 'worklog_dir_override', ms: 0.1 },
  { phase: 'command_construction', ms: 1.0 },
  { phase: 'plugin_context', ms: 0.5 },
  { phase: 'register_commands', ms: 2.0 },
  { phase: 'command_action', ms: 10.0 },
  { phase: 'config_load', ms: 1.0, nested: true },
  { phase: 'db_open', ms: 4.0, nested: true },
  { phase: 'throttler_drain', ms: 0.3 },
  { phase: 'db_close', ms: 0.4 },
  { phase: 'harness_restore', ms: 0.2 },
];

describe('in-process profile attribution', () => {
  it('counts nested phases once, inside the command action', () => {
    const attribution = attributeRecord(syntheticRecord(16.0, SYNTHETIC_MARKS));

    // The action bucket excludes its nested config load / DB open time.
    expect(attribution.buckets.commandAction).toBeCloseTo(5.0, 5);
    expect(attribution.buckets.dbOpen).toBeCloseTo(4.0, 5);
    expect(attribution.buckets.configLoad).toBeCloseTo(1.0, 5);
    expect(attribution.buckets.dbClose).toBeCloseTo(0.4, 5);
    // Registration is Command construction + built-in registration.
    expect(attribution.buckets.commanderRegistration).toBeCloseTo(3.0, 5);
    expect(attribution.buckets.pluginContext).toBeCloseTo(0.5, 5);
    expect(attribution.buckets.argvAndOverride).toBeCloseTo(0.6, 5);
    // Harness bookkeeping is stream/console patch + restore + throttler drain.
    expect(attribution.buckets.harnessBookkeeping).toBeCloseTo(0.7, 5);

    // Every bucket totals to the top-level attribution, which totals to the
    // call minus the residual: the nested phases were not added twice.
    const bucketSum = ATTRIBUTION_BUCKETS.reduce((sum, bucket: AttributionBucket) => sum + attribution.buckets[bucket], 0);
    expect(bucketSum).toBeCloseTo(attribution.attributedMs, 5);
    expect(attribution.attributedMs).toBeCloseTo(15.2, 5);
    expect(attribution.residualMs).toBeCloseTo(0.8, 5);
    expect(attribution.residualSharePct).toBeCloseTo(5.0, 5);
    expect(attribution.reconciled).toBe(true);
  });

  it('reports a large residual as unreconciled instead of dropping it', () => {
    const attribution = attributeRecord(syntheticRecord(20.0, SYNTHETIC_MARKS));

    expect(attribution.attributedMs).toBeCloseTo(15.2, 5);
    expect(attribution.residualMs).toBeCloseTo(4.8, 5);
    expect(attribution.residualSharePct).toBeCloseTo(24.0, 5);
    expect(attribution.residualSharePct).toBeGreaterThan(MAX_RESIDUAL_SHARE_PCT);
    expect(attribution.reconciled).toBe(false);
  });

  it('names the dominant bucket with its millisecond and percentage share', () => {
    const { buckets, totalMs } = attributeRecord(syntheticRecord(16.0, SYNTHETIC_MARKS));

    const verdict = classifyDominantCost(buckets, totalMs, 'wl list --json');

    expect(verdict.bucket).toBe('commandAction');
    expect(verdict.ms).toBeCloseTo(5.0, 5);
    expect(verdict.sharePct).toBeCloseTo(31.3, 1);
    // Command work is production behaviour, not harness overhead: the verdict
    // must say so rather than implying a fixable dominant phase.
    expect(verdict.verdict).toContain('command');
    expect(verdict.verdict).toContain('31.3');
  });

  it('classifies a DB-open-dominated call as production startup', () => {
    const buckets = emptyBuckets({ dbOpen: 8, dbClose: 1, commanderRegistration: 2, commandAction: 1 });
    const verdict = classifyDominantCost(buckets, 14);

    expect(verdict.bucket).toBe('dbOpen');
    expect(verdict.category).toBe('production-startup');
    expect(verdict.classification).toBe('production-startup');
    expect(verdict.ms).toBeCloseTo(8, 5);
    expect(verdict.sharePct).toBeCloseTo(57.1, 1);
  });

  it('classifies a registration-dominated call as harness-side', () => {
    const buckets = emptyBuckets({ commanderRegistration: 6, pluginContext: 2, configLoad: 0.5 });
    const verdict = classifyDominantCost(buckets, 10);

    expect(verdict.bucket).toBe('commanderRegistration');
    expect(verdict.category).toBe('harness-side');
    expect(verdict.classification).toBe('harness-side');
    expect(verdict.verdict).toContain('harness-side');
  });
});

describe('profiler helpers', () => {
  it('takes the median of an odd, an even and an empty sample', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('selects scenarios by name in declared order and rejects unknown names', () => {
    expect(selectScenarios([])).toEqual(INPROC_PROFILE_SCENARIOS);
    expect(selectScenarios(['status', 'help']).map((scenario) => scenario.name)).toEqual(['help', 'status']);
    expect(() => selectScenarios(['nope'])).toThrow(/unknown scenario\(s\) nope/);
  });
});

describe('harness phase instrumentation', () => {
  const originalProfile = process.env.WL_INPROC_PROFILE;

  beforeEach(() => {
    clearInprocProfileRecords();
  });

  afterEach(() => {
    if (originalProfile === undefined) delete process.env.WL_INPROC_PROFILE;
    else process.env.WL_INPROC_PROFILE = originalProfile;
    setWorklogDirOverride(undefined);
    clearInprocProfileRecords();
  });

  /**
   * Run a small sample of identical live calls and aggregate their attribution
   * (see `aggregateResidual`). A live ~2 ms call can miss the >= 90 % outcome
   * purely from timer granularity and scheduling noise on a loaded host, so the
   * sample is asserted on the host-independent contract instead (see
   * `sampledResidualViolations`). The >= 90 % outcome stays pinned on synthetic
   * data and the serialised baseline.
   */
  async function sampleResidual(commandLine: string, runs = 5): Promise<SampledResidual> {
    const attributions: InprocAttribution[] = [];
    for (let run = 0; run < runs; run += 1) {
      clearInprocProfileRecords();
      const result = await runInProcess(commandLine, 15_000);
      expect(result.exitCode).toBe(0);
      const records = getInprocProfileRecords();
      expect(records).toHaveLength(1);
      const attribution = attributeRecord(records[0]);
      expect(attribution.attributedMs).toBeGreaterThan(0);
      attributions.push(attribution);
    }
    return aggregateResidual(attributions);
  }

  /**
   * Live samples must clear this loose, load-independent bound: the phase marks
   * demonstrably account for the bulk of the call, but the strict >= 90 %
   * outcome is deliberately not required here (see the file header).
   */
  const MAX_LIVE_RESIDUAL_SHARE_PCT = 50;

  /**
   * The contract a live sample must satisfy. Returns the violated checks (empty
   * when the sample is healthy). Extracted so the deliberate-fault test can
   * prove the check actually detects a silently dropped residual.
   */
  function sampledResidualViolations(sample: SampledResidual): string[] {
    const violations: string[] = [];
    if (Math.abs(sample.attributedMs - sample.phaseSumMs) > 1e-6) {
      violations.push(
        `attributedMs ${sample.attributedMs.toFixed(3)} does not equal the phase-mark sum ` +
          `${sample.phaseSumMs.toFixed(3)} — residual silently dropped`,
      );
    }
    if (!sample.flagAgrees) {
      violations.push('reconciled flag disagrees with the reported residual share');
    }
    if (sample.residualSharePct < 0 || sample.residualSharePct > MAX_LIVE_RESIDUAL_SHARE_PCT) {
      violations.push(
        `residual share ${sample.residualSharePct.toFixed(2)} % outside the loose 0–` +
          `${MAX_LIVE_RESIDUAL_SHARE_PCT} % coverage bound`,
      );
    }
    return violations;
  }

  it('records nothing when the switch is off, leaving output unchanged', async () => {
    delete process.env.WL_INPROC_PROFILE;

    const result = await runInProcess('node src/cli.ts --help', 15_000);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: worklog');
    expect(getInprocProfileRecords()).toEqual([]);
  });

  it('records the setup, action and restore phases when switched on', async () => {
    process.env.WL_INPROC_PROFILE = '1';

    const result = await runInProcess('node src/cli.ts --help', 15_000);
    const records = getInprocProfileRecords();

    expect(result.stdout).toContain('Usage: worklog');
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.commandLine).toContain('--help');
    expect(record.args).toEqual(['--help']);
    expect(record.totalMs).toBeGreaterThan(0);

    const phases = record.marks.map((mark) => mark.phase);
    for (const phase of [
      'argv',
      'harness_patch',
      'worklog_dir_override',
      'command_construction',
      'plugin_context',
      'register_commands',
      'command_action',
      'throttler_drain',
      'db_close',
      'harness_restore',
    ] as const) {
      expect(phases).toContain(phase);
    }
    // `--help` performs no data access, so there is no DB open to attribute.
    expect(phases).not.toContain('db_open');

    const attribution = attributeRecord(record);
    expect(attribution.attributedMs).toBeGreaterThan(0);

    const sample = await sampleResidual('node src/cli.ts --help');
    // The reconciled flag must agree with the reported share on every sample, the
    // attributed total must equal the phase-mark sum (no silently dropped
    // residual), and the marks must account for the bulk of the wall time. The
    // strict >= 90 % rule is pinned on synthetic data and the serialised
    // baseline, not on a live quiet host.
    expect(sampledResidualViolations(sample)).toEqual([]);
  });

  it('attributes a data-access command to a nested DB open', async () => {
    const tempDir = createTempDir();
    try {
      writeConfig(tempDir);
      writeInitSemaphore(tempDir);
      process.env.WL_INPROC_PROFILE = '1';
      clearInprocProfileRecords();

      const commandLine = `node src/cli.ts --worklog-dir ${path.join(tempDir, '.worklog')} list --json`;
      const result = await runInProcess(commandLine, 15_000);
      const records = getInprocProfileRecords();

      expect(result.exitCode).toBe(0);
      expect(records).toHaveLength(1);
      const dbMarks = records[0].marks.filter((mark) => mark.phase === 'db_open');
      expect(dbMarks.length).toBeGreaterThan(0);
      // The DB open happens inside the command action, so it is nested.
      expect(dbMarks.every((mark) => mark.nested === true)).toBe(true);

      const attribution = attributeRecord(records[0]);
      // Nested time belongs to its own bucket and to the action window, never
      // to both, so the attribution still reconciles with the measured total.
      expect(attribution.buckets.dbOpen).toBeGreaterThan(0);
      expect(attribution.buckets.commandAction).toBeGreaterThanOrEqual(0);

      const sample = await sampleResidual(commandLine);
      expect(sampledResidualViolations(sample)).toEqual([]);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it('detects a silently dropped residual — deliberate-fault check', () => {
    // A healthy synthetic attribution (16.0 ms wall, 15.2 ms attributed, so a
    // 0.8 ms residual) clears the live-sample contract.
    const healthy = attributeRecord(syntheticRecord(16.0, SYNTHETIC_MARKS));
    expect(sampledResidualViolations(aggregateResidual([healthy]))).toEqual([]);

    // Fault injection: attribute `totalMs` as fully attributed, silently
    // dropping the residual. The reworked contract must catch it rather than
    // reporting a comfortable 0 % residual.
    const droppedResidual: InprocAttribution = { ...healthy, attributedMs: healthy.totalMs };
    expect(sampledResidualViolations(aggregateResidual([droppedResidual]))).toEqual(
      expect.arrayContaining([expect.stringContaining('residual silently dropped')]),
    );

    // A second fault: the reconciled flag disagrees with the reported share
    // (a record that claims reconciliation while exceeding the threshold).
    const unreconciled = attributeRecord(syntheticRecord(20.0, SYNTHETIC_MARKS));
    expect(unreconciled.reconciled).toBe(false);
    const mislabelled: InprocAttribution = { ...unreconciled, reconciled: true };
    expect(sampledResidualViolations(aggregateResidual([mislabelled]))).toEqual(
      expect.arrayContaining([expect.stringContaining('reconciled flag disagrees')]),
    );
  });
});

describe('profiler end to end', () => {
  it('measures the profiled scenarios with medians of at least three runs', async () => {
    const previousCwd = process.cwd();
    const previousProfile = process.env.WL_INPROC_PROFILE;
    delete process.env.WL_INPROC_PROFILE;

    try {
      const result = await runInprocHarnessProfile({ runs: 3, warmupRuns: 0 });

      expect(result.scenarios.map((scenario) => scenario.name)).toEqual([
        'help',
        'cold-open',
        'list-json',
        'create',
        'status',
      ]);
      // The data-access scenarios measure the warm already-initialised regime;
      // `cold-open` measures the first-open bootstrap path (WL-0MVWLBZG4003A803).
      expect(result.scenarios.find((scenario) => scenario.name === 'cold-open')?.storeSetup).toBe('empty');
      expect(result.scenarios.find((scenario) => scenario.name === 'list-json')?.storeSetup).toBe(
        'initialised',
      );
      expect(result.runs).toBe(3);
      // The first call in the process pays module-graph/JIT warm-up and is
      // recorded separately rather than averaged into the warm numbers.
      expect(result.coldStart).not.toBeNull();
      expect(result.coldStart?.totalMs).toBeGreaterThan(0);

      for (const scenario of result.scenarios) {
        expect(scenario.runCount).toBe(3);
        expect(scenario.median.totalMs).toBeGreaterThan(0);
        // Reconciliation is a *quiet-host* property: on a contended host the
        // untimed gaps (preemption, GC, event-loop stalls) can easily exceed
        // 10 % of a 2-5 ms call, so this end-to-end measurement asserts that
        // the flag agrees with the reported share (no silently dropped
        // residual) rather than forcing a quiet-host outcome. The published
        // baseline in bench/inproc-harness-budget.json is reconciled, and the
        // >= 90 % rule itself is pinned on synthetic data in the attribution
        // tests above.
        expect(scenario.reconciled).toBe(
          scenario.median.residualSharePct <= MAX_RESIDUAL_SHARE_PCT,
        );
        expect(scenario.median.residualMs).toBeGreaterThanOrEqual(0);
        for (const bucket of ATTRIBUTION_BUCKETS) {
          expect(scenario.median.buckets[bucket]).toBeGreaterThanOrEqual(0);
        }
        // A warm in-process call is milliseconds, not the ~200 ms seed figure;
        // this bound is deliberately loose so it survives a loaded host.
        expect(scenario.median.totalMs).toBeLessThan(2_000);
      }

      expect(result.decisionGate.scenario).toBe(DECISION_GATE_SCENARIO);
      expect(result.decisionGate.totalMs).toBeGreaterThan(0);
      expect(['harness-side', 'production-startup']).toContain(result.decisionGate.classification);
      expect(result.decisionGate.verdict.length).toBeGreaterThan(0);
      // Temporary stores only: the repository worklog is untouched.
      expect(fs.existsSync(path.join(previousCwd, '.worklog', 'inproc-profile-fixture'))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      if (previousProfile === undefined) delete process.env.WL_INPROC_PROFILE;
      else process.env.WL_INPROC_PROFILE = previousProfile;
      setWorklogDirOverride(undefined);
      clearInprocProfileRecords();
    }
  }, 120_000);
});

/** Build a complete bucket map from a partial one (absent buckets are 0). */
function emptyBuckets(partial: Partial<Record<AttributionBucket, number>>): Record<AttributionBucket, number> {
  const buckets = {} as Record<AttributionBucket, number>;
  for (const bucket of ATTRIBUTION_BUCKETS) buckets[bucket] = partial[bucket] ?? 0;
  return buckets;
}

/**
 * Aggregated attribution over a sample of live calls, plus the derived facts the
 * live-sample contract checks. `phaseSumMs` is the sum of the top-level phase
 * marks, kept separate from `attributedMs` so a fault that inflates the
 * attributed total (silently dropping the residual) is detectable.
 */
interface SampledResidual {
  totalMs: number;
  attributedMs: number;
  phaseSumMs: number;
  residualSharePct: number;
  /** Every record's `reconciled === (residualSharePct <= MAX_RESIDUAL_SHARE_PCT)`. */
  flagAgrees: boolean;
}

/**
 * Pure aggregation over per-call attributions. Kept free of live I/O so the
 * deliberate-fault test can drive it with synthetic records.
 */
function aggregateResidual(attributions: InprocAttribution[]): SampledResidual {
  let totalMs = 0;
  let attributedMs = 0;
  let phaseSumMs = 0;
  let flagAgrees = true;
  for (const attribution of attributions) {
    const phaseSum = TOP_LEVEL_PHASES.reduce((sum, phase) => sum + attribution.phases[phase].ms, 0);
    flagAgrees =
      flagAgrees &&
      attribution.reconciled === (attribution.residualSharePct <= MAX_RESIDUAL_SHARE_PCT);
    totalMs += attribution.totalMs;
    attributedMs += attribution.attributedMs;
    phaseSumMs += phaseSum;
  }
  return {
    totalMs,
    attributedMs,
    phaseSumMs,
    residualSharePct: ((totalMs - attributedMs) / totalMs) * 100,
    flagAgrees,
  };
}
