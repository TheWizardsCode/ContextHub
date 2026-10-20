/**
 * Startup import-budget harness (F2 — WL-0MVFRRAXD001E7AN).
 *
 * The parent epic (WL-0MVFNMSRW002FI6B, AC1) requires the cache-hit read path
 * and `--version` to stop loading command modules, the DB runtime and plugins:
 * warm p95 wall <= 0.5 s and peak RSS <= 60 MB on the reference host. This
 * suite is the ratchet that locks the current import graph and measured cost
 * in, so each subsequent slimming change (F4/F6/F7) can only tighten it:
 *
 *   1. RATCHET — the transitive static-import graph of `src/cli.ts` must be a
 *      subset of the graph recorded in `bench/startup-import-budget.json`.
 *      Adding a module fails the test; removing one is allowed (and prompts a
 *      deliberate budget-file update so the improvement cannot be undone).
 *      Pure AST + filesystem work, well under a second.
 *   2. POLICY — the regression policy (CPU budget + documented headroom,
 *      wall/RSS headroom, AC1 target only once F7 marks it enforced) is
 *      exercised against synthetic measurements so it is deterministic.
 *   3. MEASURED — a real warm cache-hit benchmark run (tsx target, the target
 *      the default suite can always run) must stay inside the recorded
 *      budget plus headroom.
 *   4. TARGETS — the harness builds both `src/` (tsx) and `dist/` (built, what
 *      `/usr/local/bin/wl` runs) invocations, with an actionable error when
 *      `dist/cli.js` has not been built.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { walkStaticImportGraph, CLI_ENTRY } from '../../bench/startup-import-graph.js';
import {
  readStartupBudget,
  evaluateImportRatchet,
  evaluateStartupBudget,
  type StartupBudget,
  type StartupBudgetScenario,
} from '../../bench/startup-budget.js';
import {
  runStartupBenchmark,
  resolveStartupTarget,
  buildStartupInvocation,
  percentile,
  type StartupBenchmarkResult,
  type StartupScenarioMeasurement,
} from '../../bench/wl-startup-perf.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A complete measurement result built from synthetic numbers. */
function syntheticResult(
  overrides: Partial<StartupScenarioMeasurement> = {},
  target: 'src' | 'dist' = 'src'
): StartupBenchmarkResult {
  const scenario: StartupScenarioMeasurement = {
    name: 'next-json',
    label: 'wl next --json (warm cache hit)',
    argv: ['next', '--json'],
    expectedKind: 'cache-hit',
    runs: 5,
    kinds: { 'cache-hit': 5 },
    p50WallMs: 1000,
    p95WallMs: 1200,
    p95CpuMs: 900,
    p95RssMb: 80,
    maxRssMb: 82,
    samples: [],
    ...overrides,
  };
  return {
    target,
    entry: CLI_ENTRY,
    node: process.version,
    host: 'synthetic',
    repoRoot,
    worklogRoot: '/tmp/synthetic-worklog',
    fixture: true,
    runs: scenario.runs,
    capturedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    invocation: 'node dist/cli.js',
    scenarios: [scenario],
    bareNode: { runs: 3, p95WallMs: 450, p95CpuMs: 380, p95RssMb: 58 },
    importGraph: { entry: CLI_ENTRY, modules: [CLI_ENTRY], external: [] },
  };
}

/** Budget with known numbers, independent of the checked-in file. */
function syntheticBudget(overrides: Partial<StartupBudget> = {}): StartupBudget {
  const scenario: StartupBudgetScenario = {
    expectedKind: 'cache-hit',
    p50WallMs: 1000,
    p95WallMs: 1200,
    p95CpuMs: 900,
    p95RssMb: 80,
    maxRssMb: 82,
  };
  return {
    version: 1,
    entry: CLI_ENTRY,
    importGraph: { moduleCount: 1, modules: [CLI_ENTRY], external: [] },
    ac1Targets: {
      p95WallMs: 500,
      peakRssMb: 60,
      enforced: false,
      measuredTarget: 'dist',
      note: 'flipped by F7',
    },
    regression: {
      runs: 5,
      cpuHeadroomPct: 50,
      wallHeadroomPct: 200,
      wallFloorMs: 250,
      note: 'test policy',
    },
    baselines: {
      src: {
        capturedAt: '2026-01-01T00:00:00.000Z',
        node: process.version,
        host: 'synthetic',
        runs: 5,
        target: 'src',
        method: 'synthetic',
        scenarios: { 'next-json': scenario },
        bareNode: { p95WallMs: 450, p95CpuMs: 380, p95RssMb: 58 },
      },
    },
    ...overrides,
  };
}

describe('startup import budget — ratchet', { timeout: 60_000 }, () => {
  it('keeps the static import graph of src/cli.ts within the recorded budget', () => {
    const graph = walkStaticImportGraph({ repoRoot });
    const budget = readStartupBudget(repoRoot);

    expect(graph.entry).toBe(CLI_ENTRY);
    expect(graph.modules.length).toBeGreaterThan(0);
    // A no-duplicates, sorted module list keeps the ratchet diff readable.
    expect(graph.modules).toEqual([...new Set(graph.modules)].sort());

    const ratchet = evaluateImportRatchet(graph, budget);
    expect(ratchet.added, ratchet.message).toEqual([]);
    expect(ratchet.ok).toBe(true);
  });

  it('records a complete, sorted snapshot of the graph in the budget file', () => {
    const budget = readStartupBudget(repoRoot);
    const modules = budget.importGraph.modules;

    expect(modules).toEqual([...new Set(modules)].sort());
    expect(budget.importGraph.moduleCount).toBe(modules.length);
    expect(modules).toContain(CLI_ENTRY);
  });

  it('reports added and removed modules separately', () => {
    const budget = syntheticBudget();
    const ratchet = evaluateImportRatchet(
      { modules: [CLI_ENTRY, 'src/commands/new.ts'] },
      budget
    );

    expect(ratchet.ok).toBe(false);
    expect(ratchet.added).toEqual(['src/commands/new.ts']);
    expect(ratchet.message).toContain('src/commands/new.ts');
    expect(ratchet.message).toContain('bench/startup-import-budget.json');

    // Removals are improvements: allowed, but surfaced so the budget can be
    // tightened deliberately.
    const improved = evaluateImportRatchet({ modules: [] }, budget);
    expect(improved.ok).toBe(true);
    expect(improved.removed).toEqual([CLI_ENTRY]);
  });
});

describe('startup import budget — regression policy', () => {
  it('accepts measurements within the recorded budget plus headroom', () => {
    const evaluation = evaluateStartupBudget(syntheticResult(), syntheticBudget());
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.ok).toBe(true);
  });

  it('flags a CPU-time regression beyond the documented headroom', () => {
    // 900 ms baseline + 50 % headroom = 1350 ms limit.
    const evaluation = evaluateStartupBudget(
      syntheticResult({ p95CpuMs: 1400 }),
      syntheticBudget()
    );

    expect(evaluation.ok).toBe(false);
    expect(evaluation.violations.join('\n')).toContain('p95CpuMs');
    expect(evaluation.violations.join('\n')).toContain('1400');
  });

  it('tolerates wall-clock inflation from a loaded host (CPU time is the gate)', () => {
    // Wall is 3.5x the recorded p95 plus the floor — inside the documented
    // wall headroom (200 % + 250 ms = 3850 ms) while CPU stays flat.
    const evaluation = evaluateStartupBudget(
      syntheticResult({ p95WallMs: 3800, p95CpuMs: 910 }),
      syntheticBudget()
    );
    expect(evaluation.violations).toEqual([]);
  });

  it('flags a wall-time regression beyond the documented headroom', () => {
    const evaluation = evaluateStartupBudget(
      syntheticResult({ p95WallMs: 5000 }),
      syntheticBudget()
    );
    expect(evaluation.violations.join('\n')).toContain('p95WallMs');
  });

  it('requires the measured samples to be genuine cache hits', () => {
    const evaluation = evaluateStartupBudget(
      syntheticResult({ kinds: { 'read-work': 5 } }),
      syntheticBudget()
    );
    expect(evaluation.violations.join('\n')).toContain('cache-hit');
  });

  it('asserts the parent AC1 target only once F7 records it as enforced', () => {
    // Measured 1200 ms / 80 MB violates AC1's 500 ms / 60 MB, but the target
    // is not enforced yet (the baseline is still the pre-slimming graph).
    expect(evaluateStartupBudget(syntheticResult(), syntheticBudget()).violations).toEqual([]);

    // Once F7 records a compliant dist baseline and flips `enforced`, the
    // same numbers are rejected for the measured target.
    const enforced = syntheticBudget({
      ac1Targets: { ...syntheticBudget().ac1Targets, enforced: true, measuredTarget: 'src' },
    });
    const violations = evaluateStartupBudget(syntheticResult(), enforced).violations.join('\n');
    expect(violations).toContain('AC1');
    expect(violations).toContain('500');
    expect(violations).toContain('60');
  });

  it('reports a missing baseline instead of silently passing', () => {
    const evaluation = evaluateStartupBudget(
      syntheticResult({ name: 'unknown-scenario' }),
      syntheticBudget()
    );
    expect(evaluation.ok).toBe(false);
    expect(evaluation.violations.join('\n')).toContain('no recorded baseline');
  });
});

describe('startup import budget — measurement helpers', () => {
  it('computes the p95 sample (max for small samples)', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([], 0.95)).toBeNull();
  });

  it('resolves the src and dist targets with actionable errors', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-startup-target-'));
    try {
      expect(resolveStartupTarget('src', fixture)).toBe('src');
      expect(() => resolveStartupTarget('dist', fixture)).toThrow(/npm run build/);

      fs.mkdirSync(path.join(fixture, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(fixture, 'dist', 'cli.js'), '// stub\n');
      expect(resolveStartupTarget('dist', fixture)).toBe('dist');
      expect(resolveStartupTarget('auto', fixture)).toBe('dist');

      const distInvocation = buildStartupInvocation('dist', fixture);
      expect(distInvocation).toEqual([process.execPath, path.join(fixture, 'dist', 'cli.js')]);
      // The src target resolves tsx from this checkout and runs src/cli.ts.
      const srcInvocation = buildStartupInvocation('src', repoRoot);
      expect(srcInvocation[0]).toBe(process.execPath);
      expect(srcInvocation[srcInvocation.length - 1]).toBe(path.join(repoRoot, 'src', 'cli.ts'));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('startup import budget — measured regression', { timeout: 300_000 }, () => {
  it('warm cache-hit invocations stay within the recorded budget', () => {
    const budget = readStartupBudget(repoRoot);
    const result = runStartupBenchmark({
      repoRoot,
      target: 'src',
      runs: budget.regression.runs,
      warmupRuns: 4,
      bareNodeRuns: 3,
    });

    const evaluation = evaluateStartupBudget(result, budget);
    expect(evaluation.violations, evaluation.violations.join('\n')).toEqual([]);
    // Every measured scenario must have been a served cache hit (or a
    // recorded `--version` spawn), so the numbers describe the fast path.
    for (const scenario of result.scenarios) {
      expect(scenario.kinds[scenario.expectedKind] ?? 0, scenario.name).toBe(scenario.runs);
    }
  });
});
