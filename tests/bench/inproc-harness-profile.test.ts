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
 *      actually fails when the residual is large,
 *   3. the dominant-phase classification names a millisecond and percentage
 *      share per bucket and answers harness-side vs production startup,
 *   4. the harness instrumentation is **off by default** (no records, unchanged
 *      output) and records the expected phases when switched on,
 *   5. a full profiler run measures the four AC scenarios and reports medians.
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
  type AttributionBucket,
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
   * Reconciliation is a *share* rule (>= 90 % attributed), so a single ~2 ms
   * call can miss it purely from timer granularity and scheduling noise on a
   * loaded host. The AC standard is the per-scenario median, so a one-call
   * assertion aggregates a small sample of identical calls and compares the
   * summed attributed time with the summed wall time — the same statistic the
   * published tables report, without depending on a single noisy sample.
   */
  async function sampledResidualSharePct(commandLine: string, runs = 5): Promise<number> {
    let totalMs = 0;
    let attributedMs = 0;
    for (let run = 0; run < runs; run += 1) {
      clearInprocProfileRecords();
      const result = await runInProcess(commandLine, 15_000);
      expect(result.exitCode).toBe(0);
      const records = getInprocProfileRecords();
      expect(records).toHaveLength(1);
      const attribution = attributeRecord(records[0]);
      expect(attribution.attributedMs).toBeGreaterThan(0);
      totalMs += attribution.totalMs;
      attributedMs += attribution.attributedMs;
    }
    return ((totalMs - attributedMs) / totalMs) * 100;
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
    expect(await sampledResidualSharePct('node src/cli.ts --help')).toBeLessThanOrEqual(
      MAX_RESIDUAL_SHARE_PCT,
    );
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
      expect(await sampledResidualSharePct(commandLine)).toBeLessThanOrEqual(
        MAX_RESIDUAL_SHARE_PCT,
      );
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});

describe('profiler end to end', () => {
  it('measures the four AC scenarios with medians of at least three runs', async () => {
    const previousCwd = process.cwd();
    const previousProfile = process.env.WL_INPROC_PROFILE;
    delete process.env.WL_INPROC_PROFILE;

    try {
      const result = await runInprocHarnessProfile({ runs: 3, warmupRuns: 0 });

      expect(result.scenarios.map((scenario) => scenario.name)).toEqual([
        'help',
        'list-json',
        'create',
        'status',
      ]);
      expect(result.runs).toBe(3);
      // The first call in the process pays module-graph/JIT warm-up and is
      // recorded separately rather than averaged into the warm numbers.
      expect(result.coldStart).not.toBeNull();
      expect(result.coldStart?.totalMs).toBeGreaterThan(0);

      for (const scenario of result.scenarios) {
        expect(scenario.runCount).toBe(3);
        expect(scenario.median.totalMs).toBeGreaterThan(0);
        expect(scenario.median.residualSharePct).toBeLessThanOrEqual(MAX_RESIDUAL_SHARE_PCT);
        expect(scenario.reconciled).toBe(true);
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
