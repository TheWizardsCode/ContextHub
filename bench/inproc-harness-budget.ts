/**
 * In-process CLI harness cost budget (WL-0MVVXG3UW00250V5, child of
 * WL-0MVHVZMCH0092JCY).
 *
 * The in-process harness (`tests/cli/cli-inproc.ts`) is exercised ~1200 times
 * per suite run, so the per-call cost is guarded exactly like the startup
 * import budget (`bench/startup-budget.ts`): a checked-in artefact
 * (`bench/inproc-harness-budget.json`) records the measured per-scenario
 * median on the reference host, and the guard test
 * (`tests/cli/inproc-harness-budget.test.ts`) fails when a re-measurement
 * exceeds that baseline plus a documented headroom.
 *
 * Re-scope note: child 3 (WL-0MVVXG4B200968BF) recorded that the dominant
 * fresh-store phase is *production startup* (DB open incl. schema creation/
 * migrations), not harness-side work, and re-scoped the improvement into
 * `src/` (follow-up WL-0MVWLBZG4003A803). In that branch the guard still
 * exists but asserts the *documented baseline*: it fails on a missing,
 * unparseable or schema-drifted artefact, and on an order-of-magnitude
 * regression (a per-call doubling that no host-load noise can explain),
 * rather than claiming an un-earned harness improvement.
 *
 * Host-load tolerance: wall time on a shared host is noisy, so the measured
 * median is compared against `budget.medianMs * (1 + headroom/100) *
 * loadFactor`, with `loadFactor = clamp(load1now / load1atCapture, 1,
 * maxHostLoadFactor)` — the same clamped factor convention as the startup
 * import budget, so a saturated host cannot flake the ratchet.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
// Type-only: the budget module must not drag the profiler (and through it the
// CLI module graph) into a plain import. The scenario names are duplicated here
// deliberately and the guard test asserts the two lists agree.
import type { InprocProfileResult, InprocScenarioMeasurement } from './inproc-harness-profile.js';

/** The profiled scenarios the budget covers (mirrors the profiler's own list). */
export const INPROC_BUDGET_SCENARIOS = ['help', 'list-json', 'create', 'status'] as const;

/** Relative to the repository root. */
export const INPROC_BUDGET_ARTEFACT_RELATIVE_PATH = 'bench/inproc-harness-budget.json';

/** The budget schema version (bump on any breaking artefact change). */
export const INPROC_BUDGET_SCHEMA_VERSION = 1;

/** Cap on the host-load factor used to scale the wall-time limit. */
export const MAX_HOST_LOAD_FACTOR = 8;

/**
 * Default wall-time headroom above the recorded median. The per-call median
 * is 4–5 ms, so the headroom is deliberately generous: the guard exists to
 * catch an order-of-magnitude regression or a schema/baseline drift, not
 * sub-millisecond load noise (see the re-scope note in the header).
 */
export const DEFAULT_HEADROOM_PCT = 250;

/** One scenario's recorded budget in the artefact. */
export interface InprocBudgetScenario {
  /** Human label (mirrors the profiler's scenario label). */
  label: string;
  /** Median per-call wall time recorded on the capture host (ms). */
  medianMs: number;
  /** Median harness-side buckets sum (ms) — parsed config + DB open excluded. */
  harnessSideMs: number;
  /** Median production-startup buckets sum (config load + DB open/close, ms). */
  productionStartupMs: number;
  /** The recorded median satisfied the >= 90 % attribution reconciliation. */
  reconciled: boolean;
}

/** The checked-in budget artefact (schema version 1). */
export interface InprocHarnessBudget {
  schemaVersion: number;
  workItem: string;
  $comment: string;
  capturedAt: string;
  host: {
    hostname: string;
    node: string;
    /** 1/5/15-minute load averages at capture time. */
    loadAverage: number[];
  };
  /** Number of measured runs per scenario behind the medians. */
  runs: number;
  /** Wall-time headroom above `medianMs` (percent). */
  headroomPct: number;
  /** Cap on the host-load factor (see `MAX_HOST_LOAD_FACTOR`). */
  maxHostLoadFactor: number;
  /** How the medians are measured (fresh temp store, bench script). */
  method: string;
  scenarios: Record<string, InprocBudgetScenario>;
}

/** Per-scenario verdict of a verification run. */
export interface InprocBudgetVerification {
  scenario: string;
  /** Recorded budget median (ms). */
  budgetMs: number;
  /** Freshly re-measured median for the same scenario (ms). */
  measuredMs: number;
  /** `budgetMs * (1 + headroom) * loadFactor` (ms). */
  limitMs: number;
  /** `clamp(loadNow / loadAtCapture, 1, maxHostLoadFactor)`. */
  loadFactor: number;
  /** True when `measuredMs <= limitMs`. */
  pass: boolean;
  /** `measuredMs / limitMs` as a percentage (transparency only). */
  shareOfLimitPct: number;
}

function repoRootOf(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

/**
 * Read and validate the checked-in budget artefact.
 *
 * Fails loudly (throws) when the artefact is missing, unparseable, or its
 * schema/keys drift: in the re-scope branch the guard is exactly this
 * structural contract plus the measured order-of-magnitude check, so a
 * corrupted or hand-edited budget must never pass silently.
 */
export function readInprocHarnessBudget(artefactPath: string): InprocHarnessBudget {
  let raw: string;
  try {
    raw = fs.readFileSync(artefactPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `in-process harness budget: artefact not readable at ${artefactPath} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Regenerate with: npm run benchmark:inproc-harness -- --update-budget`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`in-process harness budget: artefact is not valid JSON (${artefactPath})`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`in-process harness budget: artefact is not an object (${artefactPath})`);
  }
  const budget = parsed as Partial<InprocHarnessBudget>;
  if (budget.schemaVersion !== INPROC_BUDGET_SCHEMA_VERSION) {
    throw new Error(
      `in-process harness budget: unsupported schemaVersion ${String(budget.schemaVersion)} ` +
        `(expected ${INPROC_BUDGET_SCHEMA_VERSION}); regenerate the artefact`,
    );
  }
  if (!budget.scenarios || typeof budget.scenarios !== 'object') {
    throw new Error(`in-process harness budget: missing "scenarios"`);
  }
  const expectedNames: readonly string[] = INPROC_BUDGET_SCENARIOS;
  for (const name of expectedNames) {
    const entry = budget.scenarios[name];
    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `in-process harness budget: scenario "${name}" missing from the artefact ` +
          `(expected all of ${expectedNames.join(', ')}); regenerate it`,
      );
    }
    for (const key of ['medianMs', 'harnessSideMs', 'productionStartupMs']) {
      if (typeof (entry as Record<string, unknown>)[key] !== 'number') {
        throw new Error(
          `in-process harness budget: scenario "${name}" field "${key}" is not a number`,
        );
      }
    }
    if (typeof entry.reconciled !== 'boolean') {
      throw new Error(`in-process harness budget: scenario "${name}" field "reconciled" is not a boolean`);
    }
  }
  if (typeof budget.headroomPct !== 'number' || budget.headroomPct < 0) {
    throw new Error(`in-process harness budget: "headroomPct" must be a non-negative number`);
  }
  if (typeof budget.maxHostLoadFactor !== 'number' || budget.maxHostLoadFactor < 1) {
    throw new Error(`in-process harness budget: "maxHostLoadFactor" must be >= 1`);
  }
  const load = budget.host?.loadAverage;
  if (!Array.isArray(load) || load.length < 1 || load.some((value) => typeof value !== 'number')) {
    throw new Error(`in-process harness budget: "host.loadAverage" must be an array of numbers`);
  }
  return budget as InprocHarnessBudget;
}

/**
 * The clamped host-load factor for a verification run.
 *
 * `clamp(load1now / load1atCapture, 1, maxHostLoadFactor)` — never below 1
 * (a quiet run must not get an artificially low limit) and never above the
 * cap (a saturated host must not inflate the limit without bound).
 */
export function hostLoadFactor(
  budget: InprocHarnessBudget,
  loadNow1Min: number = os.loadavg()[0],
): number {
  const captured = budget.host.loadAverage[0];
  if (!Number.isFinite(captured) || captured <= 0) return 1;
  const raw = loadNow1Min / captured;
  return Math.min(Math.max(raw, 1), budget.maxHostLoadFactor);
}

/**
 * Verify a fresh profile run against the checked-in budget.
 *
 * Each scenario's freshly re-measured median must stay within
 * `budgetMs * (1 + headroom/100) * loadFactor`. No file is written.
 */
export function evaluateInprocHarnessBudget(
  budget: InprocHarnessBudget,
  result: InprocProfileResult,
  loadNow1Min: number = os.loadavg()[0],
): InprocBudgetVerification[] {
  const factor = hostLoadFactor(budget, loadNow1Min);
  const byName = new Map<string, InprocScenarioMeasurement>(
    result.scenarios.map((scenario) => [scenario.name, scenario]),
  );

  return Object.entries(budget.scenarios).map(([name, entry]) => {
    const measured = byName.get(name);
    const measuredMs = measured ? measured.median.totalMs : Number.POSITIVE_INFINITY;
    const limitMs = entry.medianMs * (1 + budget.headroomPct / 100) * factor;
    return {
      scenario: name,
      budgetMs: entry.medianMs,
      measuredMs: round(measuredMs),
      limitMs: round(limitMs),
      loadFactor: round(factor),
      pass: measuredMs <= limitMs,
      shareOfLimitPct: round((measuredMs / limitMs) * 100),
    };
  });
}

/**
 * Derive a budget artefact from a profile run (the `--update-budget` path).
 *
 * The budget records the same numbers the profile publishes for the default
 * (fresh temp store) regime, plus provenance (host, load, run count, date)
 * and the standing headroom policy.
 */
export function deriveInprocHarnessBudget(
  result: InprocProfileResult,
  headroomPct: number = DEFAULT_HEADROOM_PCT,
): InprocHarnessBudget {
  const scenarios: Record<string, InprocBudgetScenario> = {};
  for (const scenario of result.scenarios) {
    scenarios[scenario.name] = {
      label: scenario.label,
      medianMs: round(scenario.median.totalMs),
      harnessSideMs: round(scenario.categoryMs['harness-side']),
      productionStartupMs: round(scenario.categoryMs['production-startup']),
      reconciled: scenario.reconciled,
    };
  }
  return {
    schemaVersion: INPROC_BUDGET_SCHEMA_VERSION,
    workItem: 'WL-0MVHVZMCH0092JCY',
    $comment:
      'In-process CLI harness per-call cost budget (parent WL-0MVHVZMCH0092JCY; ' +
      'guard test tests/cli/inproc-harness-budget.test.ts). Ratchet: a fresh ' +
      're-measurement must stay within baseline * (1 + headroomPct/100) * ' +
      'clampedLoadFactor; regenerate deliberately with ' +
      '`npm run benchmark:inproc-harness -- --update-budget` after a real ' +
      'per-call change (re-scope follow-up: WL-0MVWLBZG4003A803).',
    capturedAt: result.capturedAt,
    host: {
      hostname: result.host.hostname,
      node: result.host.node,
      loadAverage: result.host.loadAverage,
    },
    runs: result.runs,
    headroomPct,
    maxHostLoadFactor: MAX_HOST_LOAD_FACTOR,
    method:
      'median of N warm runs of the in-process harness against a fresh temp ' +
      'store per run (bench script `npm run benchmark:inproc-harness -- --runs N`, ' +
      'not a vitest test); same-host medians, absolute values are load sensitive',
    scenarios,
  };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
