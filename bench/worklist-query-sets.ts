/**
 * Shared worklist query sets for the Herdr refresh harnesses and tests
 * (WL-0MVI0HH740065Z2T, parent WL-0MVGYLU0S004WZUS AC3).
 *
 * The parent epic replaces the five `wl` read spawns per Herdr refresh tick
 * (four mandatory `wl list` subsets + the `wl next` browse feed) with ONE
 * consolidated `wl worklist --json` read. Both bench harnesses, the
 * spawn-reduction simulation and the bench tests must measure the SAME argv
 * vectors, so they live here in one place: an argv that drifts between
 * harness and test would make the measured reduction describe a workload
 * nobody ships.
 *
 * - `legacy` (default) is byte-identical to the five queries benchmarked by
 *   F10 (WL-0MVFRRS2I000G93J), so the recorded before-numbers stay
 *   comparable.
 * - `consolidated` is the single read; the `wl worklist` command itself lands
 *   in WL-0MVI0HX58009JJRF, so in this slice it is plumbing only — the
 *   harnesses degrade cleanly when the invocation is not available yet.
 */

export type WorklistQuerySet = 'legacy' | 'consolidated';

/** Valid `--query-set` values, in the order shown in error messages. */
export const WORKLIST_QUERY_SET_NAMES = Object.freeze(['legacy', 'consolidated'] as const);

export const DEFAULT_WORKLIST_QUERY_SET: WorklistQuerySet = 'legacy';

/**
 * The legacy five-query refresh set — the F10 baseline, recorded in
 * `bench/herdr-refresh-cycle.ts` and mirrored by `packages/herdr/src/fetcher.ts`.
 * Keep byte-identical: changing one argv changes the measured baseline
 * (WL-0MVFRRS2I000G93J numbers: 159.44 → 83.58 CPU-s/cycle).
 */
export const LEGACY_WORKLIST_QUERIES = Object.freeze([
  Object.freeze(['list', '--priority', 'critical', '--status', 'open,in-progress,blocked,completed', '--json']),
  Object.freeze(['list', '--status', 'completed,in-progress', '--stage', 'in_review', '--root-only', '--json']),
  Object.freeze(['list', '--status', 'in-progress', '--root-only', '--json']),
  Object.freeze(['list', '--status', 'blocked', '--root-only', '--json']),
  Object.freeze(['next', '-n', '20', '--json']),
]) as readonly (readonly string[])[];

/**
 * The single consolidated invocation. One `wl` read per refresh tick, one DB
 * open, one read-cache entry. Implemented by WL-0MVI0HX58009JJRF; until then
 * the harnesses treat a non-zero exit as "not available yet".
 */
export const CONSOLIDATED_WORKLIST_QUERY = Object.freeze(['worklist', '--json']) as readonly string[];

/** Map from set name to the query argv vectors that make up that set. */
export const WORKLIST_QUERY_SETS = Object.freeze({
  legacy: LEGACY_WORKLIST_QUERIES,
  consolidated: Object.freeze([CONSOLIDATED_WORKLIST_QUERY]),
}) as Readonly<Record<WorklistQuerySet, readonly (readonly string[])[]>>;

/** True when `value` is a valid set name. */
export function isWorklistQuerySet(value: string): value is WorklistQuerySet {
  return (WORKLIST_QUERY_SET_NAMES as readonly string[]).includes(value);
}

/**
 * Parse a `--query-set` option value. `undefined` selects the default
 * (`legacy`). An invalid value throws an error naming the valid values so
 * callers can surface the exact message; the harness stays deprecated-silent
 * on defaults.
 */
export function parseWorklistQuerySet(value: string | undefined): WorklistQuerySet {
  if (value === undefined) return DEFAULT_WORKLIST_QUERY_SET;
  if (isWorklistQuerySet(value)) return value;
  throw new Error(
    `Invalid --query-set "${value}": expected one of ${WORKLIST_QUERY_SET_NAMES.join(', ')}`,
  );
}

/** The query argv vectors for a set (legacy: five; consolidated: one). */
export function worklistQueriesFor(set: WorklistQuerySet): readonly (readonly string[])[] {
  return WORKLIST_QUERY_SETS[set];
}

// ── Reduction maths (AC6: computed from measured baselines, not constants) ──

/** A measured window from a harness run (spawn count and CPU usage). */
export interface MeasurementSummary {
  /** Number of `wl` subprocess spawns in the measured window. */
  spawns: number;
  /** Total CPU-seconds consumed by those spawns in the measured window. */
  cpuSeconds: number;
}

/** Ratio/reduction of one metric between a baseline and a candidate run. */
export interface MetricRatio {
  baseline: number;
  candidate: number;
  /** candidate / baseline — 1 = unchanged, < 1 = fewer. */
  ratio: number | null;
  /** 1 - candidate / baseline — 0.8 = 80 % fewer. Null when baseline is 0. */
  reduction: number | null;
}

function ratioOf(baseline: number, candidate: number): MetricRatio {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate) || baseline <= 0) {
    return { baseline, candidate, ratio: null, reduction: null };
  }
  const ratio = candidate / baseline;
  return { baseline, candidate, ratio, reduction: 1 - ratio };
}

/** Spawn-count and CPU reduction, each derived from a measured baseline. */
export interface ReductionSummary {
  spawns: MetricRatio;
  cpuSeconds: MetricRatio;
}

/**
 * Combine a measured legacy baseline and a measured candidate run into the
 * reduction figures the parent epic's AC3 compares (≤ 0.4× CPU, ~5× fewer
 * spawns). Both inputs are measurements — never hard-coded constants — e.g.
 * `computeReduction({ spawns: 5, cpuSeconds: 10 }, { spawns: 1, cpuSeconds: 2.5 })`
 * yields an 80 % spawn reduction and a 75 % CPU reduction.
 */
export function computeReduction(baseline: MeasurementSummary, candidate: MeasurementSummary): ReductionSummary {
  return {
    spawns: ratioOf(baseline.spawns, candidate.spawns),
    cpuSeconds: ratioOf(baseline.cpuSeconds, candidate.cpuSeconds),
  };
}
