/**
 * In-process CLI harness cost budget guard
 * (WL-0MVVXG3UW00250V5, child of WL-0MVHVZMCH0092JCY).
 *
 * The in-process harness is exercised ~1200 times per suite run, so its
 * per-call cost is ratcheted the same way the startup import budget is
 * (`bench/startup-import-budget.json` + `tests/cli/startup-import-budget.test.ts`):
 *
 *   1. CONTRACT — `bench/inproc-harness-budget.json` exists, parses, carries
 *      provenance (host, load average, run count, capture date) and a baseline
 *      for each of the four profiled scenarios. A missing, unparseable or
 *      schema-drifted artefact FAILS: in the recorded re-scope branch (child 3,
 *      WL-0MVVXG4B200968BF, decided the dominant cost is production startup,
 *      not harness work) this structural contract plus the measured
 *      order-of-magnitude check IS the guard.
 *   2. POLICY — the limit maths and the clamped host-load factor are exercised
 *      against synthetic budgets/measurements, so they are deterministic.
 *   3. MEASURED — a real, bounded re-measurement of the four scenarios stays
 *      inside `baseline * (1 + headroom) * clampedLoadFactor`.
 *
 * Headroom rationale: the baselines are 2–5 ms medians, so the guard's job is
 * to catch a real regression (a per-call doubling or worse, or a lost/edited
 * baseline), never sub-millisecond load noise. 250 % headroom multiplied by a
 * host-load factor clamped at 8 gives an extremely tolerant limit on a
 * contended host while still failing an order-of-magnitude regression: at
 * load factor 1 the limit is 3.5x the recorded median.
 *
 * The re-measurement is bounded: 3 runs x 4 scenarios of a few milliseconds
 * each plus one throwaway store per run — a few hundred milliseconds of
 * profiling work, comfortably inside the AC's 5 s budget. It never writes the
 * artefact (`runInprocHarnessProfile` is pure) and never touches the
 * repository `.worklog/`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_HEADROOM_PCT,
  INPROC_BUDGET_ARTEFACT_RELATIVE_PATH,
  INPROC_BUDGET_SCENARIOS,
  MAX_HOST_LOAD_FACTOR,
  deriveInprocHarnessBudget,
  evaluateInprocHarnessBudget,
  hostLoadFactor,
  readInprocHarnessBudget,
  type InprocHarnessBudget,
} from '../../bench/inproc-harness-budget.js';
import {
  INPROC_PROFILE_SCENARIOS,
  runInprocHarnessProfile,
  type InprocProfileResult,
  type InprocScenarioMeasurement,
} from '../../bench/inproc-harness-profile.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artefactPath = path.join(repoRoot, INPROC_BUDGET_ARTEFACT_RELATIVE_PATH);

/** A budget with known numbers, independent of the checked-in artefact. */
function syntheticBudget(overrides: Partial<InprocHarnessBudget> = {}): InprocHarnessBudget {
  return {
    schemaVersion: 1,
    workItem: 'WL-SYNTHETIC',
    $comment: 'regenerate with `npm run benchmark:inproc-harness -- --update-budget`',
    capturedAt: '2026-01-01T00:00:00.000Z',
    host: { hostname: 'synthetic', node: 'v0.0.0', loadAverage: [4, 4, 4] },
    runs: 5,
    headroomPct: DEFAULT_HEADROOM_PCT,
    maxHostLoadFactor: MAX_HOST_LOAD_FACTOR,
    method: 'synthetic',
    scenarios: Object.fromEntries(
      INPROC_BUDGET_SCENARIOS.map((name) => [
        name,
        {
          label: name,
          medianMs: 4,
          harnessSideMs: 1,
          productionStartupMs: 2,
          reconciled: true,
        },
      ]),
    ),
    ...overrides,
  };
}

/** A minimal profile result whose scenario medians are set per scenario name. */
function syntheticProfile(medians: Record<string, number>): InprocProfileResult {
  const scenarios = INPROC_BUDGET_SCENARIOS.map(
    (name) =>
      ({
        name,
        label: name,
        command: `node src/cli.ts <scenario ${name}>`,
        argv: [name],
        runs: [],
        runCount: 3,
        median: {
          totalMs: medians[name] ?? 0,
          phases: {},
          buckets: {},
          attributedMs: medians[name] ?? 0,
          residualMs: 0,
          residualSharePct: 0,
        },
        reconciled: true,
        worstResidualSharePct: 0,
        dominant: {} as InprocScenarioMeasurement['dominant'],
        categoryMs: { 'harness-side': 0, 'production-startup': 0, 'command-work': 0 },
        categorySharePct: { 'harness-side': 0, 'production-startup': 0, 'command-work': 0 },
      }) as unknown as InprocScenarioMeasurement,
  );
  return {
    scenarios,
    runs: 3,
    capturedAt: '2026-01-01T00:00:00.000Z',
    host: {
      hostname: 'synthetic',
      platform: 'synthetic',
      release: 'synthetic',
      cpuCount: 1,
      cpuModel: 'synthetic',
      totalMemoryMb: 1024,
      node: 'v0.0.0',
      loadAverage: [1, 1, 1],
    },
  } as unknown as InprocProfileResult;
}

/** Write `body` to a throwaway file and return its path. */
function writeTempArtefact(body: unknown | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inproc-budget-'));
  const file = path.join(dir, 'budget.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
  return file;
}

describe('in-process harness budget: checked-in contract', () => {
  it('covers exactly the profiled scenarios', () => {
    // Keeps the budget module's duplicated list and the profiler's own list in
    // step: a new profiled scenario must be budgeted (and vice versa).
    expect([...INPROC_BUDGET_SCENARIOS]).toEqual(INPROC_PROFILE_SCENARIOS.map((scenario) => scenario.name));
  });

  it('reads the artefact with provenance and a reconciled baseline per scenario', () => {
    const budget = readInprocHarnessBudget(artefactPath);

    expect(budget.schemaVersion).toBe(1);
    expect(budget.runs).toBeGreaterThanOrEqual(3);
    expect(budget.headroomPct).toBeGreaterThan(0);
    expect(budget.maxHostLoadFactor).toBeGreaterThanOrEqual(1);
    expect(budget.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(budget.host.hostname.length).toBeGreaterThan(0);
    expect(budget.host.loadAverage.length).toBeGreaterThanOrEqual(1);
    // The regeneration command is documented in the artefact itself, so an
    // operator who trips the guard knows how to record a deliberate change.
    expect(budget.$comment).toContain('--update-budget');

    for (const name of INPROC_BUDGET_SCENARIOS) {
      const scenario = budget.scenarios[name];
      expect(scenario, `scenario ${name} is budgeted`).toBeDefined();
      expect(scenario.medianMs).toBeGreaterThan(0);
      expect(scenario.harnessSideMs).toBeGreaterThanOrEqual(0);
      expect(scenario.productionStartupMs).toBeGreaterThanOrEqual(0);
      // The baseline must be a reconciled measurement (>= 90 % attributed),
      // otherwise the numbers it ratchets are not trustworthy.
      expect(scenario.reconciled, `scenario ${name} baseline reconciles`).toBe(true);
    }
  });

  it('derives the artefact from a profile run (the --update-budget path)', () => {
    const result = syntheticProfile({ help: 2.5, 'list-json': 4.5, create: 5.5, status: 4.5 });
    const budget = deriveInprocHarnessBudget(result);

    expect(budget.schemaVersion).toBe(1);
    expect(budget.runs).toBe(result.runs);
    expect(budget.headroomPct).toBe(DEFAULT_HEADROOM_PCT);
    expect(budget.scenarios['list-json'].medianMs).toBe(4.5);
    // Deriving and re-reading round-trips through the same validation.
    const roundTripped = readInprocHarnessBudget(writeTempArtefact(budget));
    expect(roundTripped.scenarios.help.medianMs).toBe(2.5);
  });

  it('fails loudly on a missing, unparseable or schema-drifted artefact', () => {
    expect(() => readInprocHarnessBudget(path.join(os.tmpdir(), 'definitely-not-here.json'))).toThrow(
      /not readable/,
    );
    expect(() => readInprocHarnessBudget(writeTempArtefact('{ not json'))).toThrow(/not valid JSON/);

    const wrongVersion = syntheticBudget() as unknown as Record<string, unknown>;
    wrongVersion.schemaVersion = 99;
    expect(() => readInprocHarnessBudget(writeTempArtefact(wrongVersion))).toThrow(/unsupported schemaVersion/);

    const missingScenario = syntheticBudget();
    delete (missingScenario.scenarios as Record<string, unknown>)['status'];
    expect(() => readInprocHarnessBudget(writeTempArtefact(missingScenario))).toThrow(
      /scenario "status" missing/,
    );

    const driftedMedian = syntheticBudget();
    (driftedMedian.scenarios.help as unknown as Record<string, unknown>).medianMs = '2.5';
    expect(() => readInprocHarnessBudget(writeTempArtefact(driftedMedian))).toThrow(
      /"medianMs" is not a number/,
    );
  });
});

describe('in-process harness budget: limit policy', () => {
  it('clamps the host-load factor between 1 and the cap', () => {
    const budget = syntheticBudget(); // captured at load 4, cap 8

    expect(hostLoadFactor(budget, 1)).toBe(1); // a quiet host never tightens below 1x
    expect(hostLoadFactor(budget, 4)).toBe(1);
    expect(hostLoadFactor(budget, 8)).toBe(2);
    expect(hostLoadFactor(budget, 10_000)).toBe(MAX_HOST_LOAD_FACTOR);
  });

  it('passes within baseline + headroom and fails beyond it', () => {
    const budget = syntheticBudget(); // 4 ms baseline, 250 % headroom → 14 ms at factor 1
    const verification = (measuredMs: number, loadNow: number) =>
      evaluateInprocHarnessBudget(
        budget,
        syntheticProfile(Object.fromEntries(INPROC_BUDGET_SCENARIOS.map((n) => [n, measuredMs]))),
        loadNow,
      );

    // 3.5x the baseline is inside the limit on an idle host …
    for (const entry of verification(14, 4)) {
      expect(entry.loadFactor).toBe(1);
      expect(entry.limitMs).toBe(14);
      expect(entry.pass, `${entry.scenario} at 14 ms`).toBe(true);
    }
    // … and an order-of-magnitude regression is not.
    for (const entry of verification(140, 4)) {
      expect(entry.pass, `${entry.scenario} at 140 ms`).toBe(false);
      expect(entry.shareOfLimitPct).toBeGreaterThan(100);
    }
    // A contended host gets the clamped factor: 100 ms passes at 8x (limit 112),
    // while the same measurement would have failed on an idle host.
    for (const entry of verification(100, 10_000)) {
      expect(entry.loadFactor).toBe(MAX_HOST_LOAD_FACTOR);
      expect(entry.limitMs).toBe(112);
      expect(entry.pass, `${entry.scenario} at 100 ms on a saturated host`).toBe(true);
    }
    // …but the clamp is a cap, not a free pass: 200 ms still fails at 8x.
    for (const entry of verification(200, 10_000)) {
      expect(entry.pass, `${entry.scenario} at 200 ms on a saturated host`).toBe(false);
    }
  });

  it('fails a scenario the measurement did not cover instead of silently skipping it', () => {
    const budget = syntheticBudget();
    const partial = syntheticProfile({
      help: 4,
      'list-json': 4,
      create: 4,
      status: 4,
    });
    partial.scenarios = partial.scenarios.filter((scenario) => scenario.name !== 'status');

    const statusEntry = evaluateInprocHarnessBudget(budget, partial, 4).find(
      (entry) => entry.scenario === 'status',
    );
    expect(statusEntry?.pass).toBe(false);
  });
});

describe('in-process harness budget: measured guard', () => {
  it('re-measures the four scenarios inside the budget (bounded, read-only)', async () => {
    const budget = readInprocHarnessBudget(artefactPath);
    const startedAt = Date.now();

    const result = await runInprocHarnessProfile({ runs: 3, warmupRuns: 0, repoRoot });

    // The guard's own cost budget: a few hundred milliseconds of profiling,
    // nowhere near the 5 s the AC allows for the whole guard.
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(5_000);

    expect(result.runs).toBe(3);
    expect(result.scenarios.map((scenario) => scenario.name)).toEqual([...INPROC_BUDGET_SCENARIOS]);

    const verifications = evaluateInprocHarnessBudget(budget, result, os.loadavg()[0]);
    const failures = verifications.filter((entry) => !entry.pass);
    expect(
      failures,
      `per-call cost exceeded the budget: ${failures
        .map((entry) => `${entry.scenario} ${entry.measuredMs} ms > ${entry.limitMs} ms`)
        .join(', ')}`,
    ).toEqual([]);
  }, 60_000);
});
