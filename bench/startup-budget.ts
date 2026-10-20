/**
 * Startup import-budget schema, ratchet and regression policy
 * (F2 — WL-0MVFRRAXD001E7AN).
 *
 * The budget file (`bench/startup-import-budget.json`) is the checked-in
 * ratchet for the parent epic's AC1 (WL-0MVFNMSRW002FI6B): warm cache-hit
 * `wl next --json` / `wl list --status open --json` and `wl --version` must
 * stay at p95 <= 0.5 s wall and peak RSS <= 60 MB on the reference host.
 *
 * It records three things:
 *
 *   1. `importGraph` — every repository module statically reachable from
 *      `src/cli.ts`. The ratchet test fails when a module is added and allows
 *      removals, so each slimming change (F4/F6/F7) locks in the improvement
 *      by updating this file deliberately.
 *   2. `baselines` — measured p95 wall / CPU time / peak RSS per invocation
 *      target (`src` = tsx, `dist` = built, what `/usr/local/bin/wl` runs),
 *      captured by `bench/wl-startup-perf.ts`. Both targets are recorded so
 *      the default test suite (which can always run the tsx target) has a
 *      like-for-like reference.
 *   3. `ac1Targets` — the parent AC1 numbers plus `enforced`/`measuredTarget`.
 *      The target is only asserted once F7 has recorded a compliant `dist`
 *      baseline and flips `enforced`; before that the budget is a ratchet
 *      against today's graph, not against a target the tree cannot yet meet.
 *
 * ## Regression policy (host-load tolerant)
 *
 * Shared CI hosts (a Raspberry Pi, the herdr server) inflate wall clock time
 * under contention, so the pass/fail gate is CPU time: `process.resourceUsage`
 * (`user + system`) is recorded per process by the F1 spawn instrumentation
 * (WL-0MVFRR98A008MM19) and is load independent. The recorded p95 CPU time is
 * compared with `cpuHeadroomPct` headroom; wall time and peak RSS are checked
 * against the same budget with their own (wider) documented headroom. Every
 * measurement must also be a genuine fast-path invocation — the expected spawn
 * kind (`cache-hit`, or `version`) must be present for every sample.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ImportGraph } from './startup-import-graph.js';

/** Repository-relative location of the budget file. */
export const BUDGET_RELATIVE_PATH = 'bench/startup-import-budget.json';

/** Current budget schema version. */
export const BUDGET_VERSION = 1;

/** Recorded cost of one measured scenario. */
export interface StartupBudgetScenario {
  /** Spawn-record kind every measured sample must report. */
  expectedKind: string;
  /** p50 wall time (ms) across the recorded runs. */
  p50WallMs: number;
  /** p95 wall time (ms) across the recorded runs. */
  p95WallMs: number;
  /** p95 CPU time (ms, user+system) across the recorded runs. */
  p95CpuMs: number | null;
  /** p95 peak RSS (MiB) across the recorded runs. */
  p95RssMb: number | null;
  /** Highest peak RSS (MiB) observed. */
  maxRssMb: number | null;
}

/** Bare-node floor: the cost of starting node with no application code. */
export interface BareNodeFloor {
  p95WallMs: number;
  p95CpuMs: number | null;
  p95RssMb: number | null;
}

/** One recorded baseline (per invocation target). */
export interface StartupBaseline {
  capturedAt: string;
  node: string;
  host: string;
  runs: number;
  target: 'src' | 'dist' | string;
  /** Exact command used, so the measurement can be reproduced. */
  method: string;
  scenarios: Record<string, StartupBudgetScenario>;
  bareNode: BareNodeFloor;
}

/** Parent AC1 target values and whether they are enforced yet. */
export interface StartupAc1Targets {
  p95WallMs: number;
  peakRssMb: number;
  /** F7 flips this once a compliant baseline is recorded for `measuredTarget`. */
  enforced: boolean;
  /** Target whose baseline is compared with the AC1 numbers. */
  measuredTarget: 'src' | 'dist';
  note: string;
}

/** Host-load tolerance policy for the measured regression test. */
export interface StartupRegressionPolicy {
  /** Sample count the measured regression test uses. */
  runs: number;
  /** Allowed CPU-time growth over the recorded p95 before failing (%). */
  cpuHeadroomPct: number;
  /** Allowed wall-time growth over the recorded p95 before failing (%). */
  wallHeadroomPct: number;
  /** Absolute wall-time slack (ms) on top of the percentage headroom. */
  wallFloorMs: number;
  note: string;
}

/** The checked-in startup import budget. */
export interface StartupBudget {
  version: number;
  $comment?: string;
  entry: string;
  importGraph: {
    moduleCount: number;
    modules: string[];
    external: string[];
  };
  ac1Targets: StartupAc1Targets;
  regression: StartupRegressionPolicy;
  baselines: Record<string, StartupBaseline | undefined>;
}

/** Defaults used when the budget file is first generated / regenerated. */
export function defaultStartupBudget(): StartupBudget {
  return {
    version: BUDGET_VERSION,
    $comment:
      'Startup import budget (parent AC1, WL-0MVFNMSRW002FI6B). Ratchet: a module added to ' +
      'the static import graph of src/cli.ts fails tests/cli/startup-import-budget.test.ts; ' +
      'regenerate deliberately with `npm run benchmark:wl-startup -- --target <src|dist> ' +
      '--update-budget` (removals are improvements and must be recorded the same way).',
    entry: 'src/cli.ts',
    importGraph: { moduleCount: 0, modules: [], external: [] },
    ac1Targets: {
      p95WallMs: 500,
      peakRssMb: 60,
      enforced: false,
      measuredTarget: 'dist',
      note:
        'Parent AC1 target. `enforced` is flipped by F7 (WL-0MVFRROLM002K98B) once the ' +
        'recorded `dist` baseline is within these numbers; until then the budget ratchets ' +
        "today's pre-slimming graph and cost instead of asserting a target the tree cannot " +
        'yet meet.',
    },
    regression: {
      runs: 4,
      cpuHeadroomPct: 50,
      wallHeadroomPct: 200,
      wallFloorMs: 250,
      note:
        'CPU time (process.resourceUsage user+system, from the F1 spawn records) is the ' +
        'load-independent regression gate: a shared/loaded host inflates wall time but not ' +
        'the process CPU consumed. Wall and peak RSS get wider documented headroom.',
    },
    baselines: {},
  };
}

/** Absolute path to the budget file for a repository root. */
export function budgetFilePath(repoRoot: string): string {
  return path.join(repoRoot, BUDGET_RELATIVE_PATH);
}

/** Read and validate the checked-in budget (throws with actionable guidance). */
export function readStartupBudget(repoRoot: string): StartupBudget {
  const file = budgetFilePath(repoRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    throw new Error(
      `startup import budget not found at ${BUDGET_RELATIVE_PATH} — regenerate it with ` +
        '`npm run benchmark:wl-startup -- --target src --update-budget`'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `startup import budget at ${BUDGET_RELATIVE_PATH} is not valid JSON: ${(error as Error).message}`
    );
  }

  const budget = parsed as StartupBudget;
  const problems: string[] = [];
  if (budget.version !== BUDGET_VERSION) {
    problems.push(`version must be ${BUDGET_VERSION} (found ${String(budget.version)})`);
  }
  if (typeof budget.entry !== 'string' || budget.entry === '') problems.push('entry must be a path');
  if (!budget.importGraph || !Array.isArray(budget.importGraph.modules)) {
    problems.push('importGraph.modules must be an array');
  }
  if (!budget.ac1Targets || typeof budget.ac1Targets.p95WallMs !== 'number') {
    problems.push('ac1Targets.p95WallMs must be a number');
  }
  if (!budget.regression || typeof budget.regression.cpuHeadroomPct !== 'number') {
    problems.push('regression.cpuHeadroomPct must be a number');
  }
  if (!budget.baselines || typeof budget.baselines !== 'object') {
    problems.push('baselines must be an object');
  }
  if (problems.length > 0) {
    throw new Error(
      `startup import budget at ${BUDGET_RELATIVE_PATH} is invalid: ${problems.join('; ')} — ` +
        'regenerate it with `npm run benchmark:wl-startup -- --target src --update-budget`'
    );
  }
  return budget;
}

/** Write the budget file (pretty-printed, newline-terminated). */
export function writeStartupBudget(repoRoot: string, budget: StartupBudget): string {
  const file = budgetFilePath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(budget, null, 2)}\n`, 'utf-8');
  return file;
}

/** Outcome of comparing the current import graph with the recorded one. */
export interface ImportRatchetResult {
  ok: boolean;
  /** Modules present in the graph but absent from the budget — a regression. */
  added: string[];
  /** Modules recorded in the budget but no longer reachable — an improvement. */
  removed: string[];
  /** Human-readable explanation (empty when nothing changed). */
  message: string;
}

/**
 * Compare the current static import graph with the budget.
 *
 * Adding a module fails the ratchet. Removing one passes (an improvement) but
 * is reported so it is locked in by a deliberate budget-file update.
 */
export function evaluateImportRatchet(
  graph: Pick<ImportGraph, 'modules'>,
  budget: StartupBudget
): ImportRatchetResult {
  const recorded = new Set(budget.importGraph.modules);
  const current = new Set(graph.modules);
  const added = [...current].filter((module) => !recorded.has(module)).sort();
  const removed = [...recorded].filter((module) => !current.has(module)).sort();

  if (added.length > 0) {
    return {
      ok: false,
      added,
      removed,
      message:
        `${added.length} module(s) were added to the static import graph of ${budget.entry}:\n` +
        added.map((module) => `  + ${module}`).join('\n') +
        `\n\nA startup-fast-path command must not pull new modules into the boot graph unless ` +
        `that is deliberate. If the addition is intended, regenerate the budget with:\n` +
        `  npm run benchmark:wl-startup -- --target src --update-budget\n` +
        `(and include the regenerated ${BUDGET_RELATIVE_PATH} in the change).`,
    };
  }

  return {
    ok: true,
    added,
    removed,
    message:
      removed.length > 0
        ? `${removed.length} module(s) were removed from the static import graph of ` +
          `${budget.entry} (an improvement):\n` +
          removed.map((module) => `  - ${module}`).join('\n') +
          `\nLock it in with: npm run benchmark:wl-startup -- --target src --update-budget`
        : '',
  };
}

/** One policy check (measured value vs. its limit). */
export interface BudgetCheck {
  scenario: string;
  metric: 'p95WallMs' | 'p95CpuMs' | 'p95RssMb' | 'sampleKind' | 'AC1 p95WallMs' | 'AC1 peakRssMb';
  measured: number;
  limit: number;
  ok: boolean;
  detail: string;
}

/** Result of evaluating a measurement against the budget. */
export interface BudgetEvaluation {
  ok: boolean;
  target: string;
  checks: BudgetCheck[];
  violations: string[];
}

/** The subset of a benchmark result the policy needs. */
export interface BudgetEvaluationInput {
  target: string;
  runs: number;
  scenarios: Array<{
    name: string;
    expectedKind: string;
    runs: number;
    kinds: Record<string, number>;
    p95WallMs: number;
    p95CpuMs: number | null;
    p95RssMb: number | null;
  }>;
}

/** Format a check failure for the violation list. */
function violationText(check: BudgetCheck): string {
  return (
    `${check.scenario}: ${check.metric} ${check.measured} exceeds limit ${check.limit} ` +
    `(${check.detail})`
  );
}

/**
 * Evaluate measured startup numbers against the recorded budget.
 *
 * Rules (in order):
 *   1. every scenario must have a recorded baseline for the measured target;
 *   2. every sample must be a genuine fast-path invocation (expected spawn kind);
 *   3. p95 CPU time must stay within `cpuHeadroomPct` (the host-load-tolerant gate);
 *   4. p95 wall time must stay within `wallHeadroomPct` + `wallFloorMs` slack;
 *   5. p95 peak RSS must stay within `cpuHeadroomPct` headroom;
 *   6. when `ac1Targets.enforced` and the measured target is the recorded
 *      `measuredTarget`, the parent AC1 numbers are asserted too.
 */
export function evaluateStartupBudget(
  result: BudgetEvaluationInput,
  budget: StartupBudget
): BudgetEvaluation {
  const checks: BudgetCheck[] = [];
  const violations: string[] = [];
  const policy = budget.regression;
  const baseline = budget.baselines[result.target];

  const push = (check: BudgetCheck): void => {
    checks.push(check);
    if (!check.ok) violations.push(violationText(check));
  };

  if (!baseline) {
    violations.push(
      `no recorded baseline for target '${result.target}' in ${BUDGET_RELATIVE_PATH} — ` +
        `regenerate it with \`npm run benchmark:wl-startup -- --target ${result.target} --update-budget\``
    );
    return { ok: false, target: result.target, checks, violations };
  }

  for (const scenario of result.scenarios) {
    const recorded = baseline.scenarios[scenario.name];
    if (!recorded) {
      violations.push(
        `no recorded baseline for scenario '${scenario.name}' (target '${result.target}') in ` +
          `${BUDGET_RELATIVE_PATH} — regenerate with ` +
          `\`npm run benchmark:wl-startup -- --target ${result.target} --update-budget\``
      );
      continue;
    }

    const expectedHits = scenario.kinds[scenario.expectedKind] ?? 0;
    push({
      scenario: scenario.name,
      metric: 'sampleKind',
      measured: expectedHits,
      limit: scenario.runs,
      ok: expectedHits === scenario.runs,
      detail:
        `every measured sample must be a genuine fast-path invocation ` +
        `(spawn kind '${scenario.expectedKind}'); observed ${JSON.stringify(scenario.kinds)}`,
    });

    const cpuLimit =
      recorded.p95CpuMs === null ? null : recorded.p95CpuMs * (1 + policy.cpuHeadroomPct / 100);
    if (cpuLimit !== null && scenario.p95CpuMs !== null) {
      push({
        scenario: scenario.name,
        metric: 'p95CpuMs',
        measured: scenario.p95CpuMs,
        limit: Math.round(cpuLimit),
        ok: scenario.p95CpuMs <= cpuLimit,
        detail:
          `recorded p95 ${recorded.p95CpuMs} ms + ${policy.cpuHeadroomPct}% CPU headroom ` +
          '(CPU time is the load-independent gate)',
      });
    }

    const wallLimit = recorded.p95WallMs * (1 + policy.wallHeadroomPct / 100) + policy.wallFloorMs;
    push({
      scenario: scenario.name,
      metric: 'p95WallMs',
      measured: scenario.p95WallMs,
      limit: Math.round(wallLimit),
      ok: scenario.p95WallMs <= wallLimit,
      detail:
        `recorded p95 ${recorded.p95WallMs} ms + ${policy.wallHeadroomPct}% wall headroom ` +
        `+ ${policy.wallFloorMs} ms floor`,
    });

    const rssLimit =
      recorded.p95RssMb === null ? null : recorded.p95RssMb * (1 + policy.cpuHeadroomPct / 100);
    if (rssLimit !== null && scenario.p95RssMb !== null) {
      push({
        scenario: scenario.name,
        metric: 'p95RssMb',
        measured: scenario.p95RssMb,
        limit: Math.round(rssLimit * 10) / 10,
        ok: scenario.p95RssMb <= rssLimit,
        detail: `recorded p95 ${recorded.p95RssMb} MiB + ${policy.cpuHeadroomPct}% RSS headroom`,
      });
    }

    if (budget.ac1Targets.enforced && result.target === budget.ac1Targets.measuredTarget) {
      push({
        scenario: scenario.name,
        metric: 'AC1 p95WallMs',
        measured: scenario.p95WallMs,
        limit: budget.ac1Targets.p95WallMs,
        ok: scenario.p95WallMs <= budget.ac1Targets.p95WallMs,
        detail: 'parent AC1 warm cache-hit wall-time target (now enforced)',
      });
      if (scenario.p95RssMb !== null) {
        push({
          scenario: scenario.name,
          metric: 'AC1 peakRssMb',
          measured: scenario.p95RssMb,
          limit: budget.ac1Targets.peakRssMb,
          ok: scenario.p95RssMb <= budget.ac1Targets.peakRssMb,
          detail: 'parent AC1 peak-RSS target (now enforced)',
        });
      }
    }
  }

  return { ok: violations.length === 0, target: result.target, checks, violations };
}
