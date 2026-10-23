/**
 * packages/herdr/src/large-db-spawn-cap.test.ts — F5 spawn-burst ratchet
 * (WL-0MVJV2PC2008PY64).
 *
 * The parent epic's ≤ ~300 MB per-pane RSS ceiling (AC 5) is guaranteed by a
 * combination of a documented cap on concurrent `wl` spawns (enforced by the
 * fetcher semaphore) and the per-spawn peak-RSS budget the F1 refresh ratchet
 * records. That guarantee has two halves:
 *
 *   1. POLICY — `evaluateSpawnCapReport` must fail loudly on every observable
 *      violation (cap exceeded, reads dropped, event loop blocked, aggregate
 *      RSS bound over the ceiling): exercised against synthetic reports.
 *   2. MEASURED — a real burst of distinct cold single-item reads through the
 *      fetcher's exec seam must observe AT MOST the documented cap of `wl`
 *      processes in flight (the production semaphore), record exactly one
 *      spawn per read, keep the event loop within the ≤ ~200 ms input bound,
 *      and keep the derived aggregate bound `cap × per-spawn peak` inside the
 *      documented RSS ceiling. The same burst with the cap widened is the
 *      `uncapped` reference (the fan-out the budget bounds).
 *
 * The full-scale profile (~2,600 items / ~100 MB) runs on demand:
 * `npm run test:perf:large -- --spawn-burst 12`.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import {
  DEFAULT_WL_SPAWN_CAP,
  LARGE_DB_PROFILES,
  REPO_ROOT,
  defaultLargeDbBudget,
  evaluateSpawnCapReport,
  readLargeDbBudget,
  runSpawnConcurrencyScenario,
  type SpawnCapScenarioReport,
} from '../test/perf/large-db-harness.js';

/** A fully-passing synthetic scenario (independent of the harness). */
function syntheticReport(
  overrides: {
    capped?: Partial<SpawnCapScenarioReport['capped']>;
    uncapped?: Partial<SpawnCapScenarioReport['uncapped']>;
  } = {},
): SpawnCapScenarioReport {
  const basePhase = {
    cap: DEFAULT_WL_SPAWN_CAP,
    burst: 8,
    peakConcurrentSpawns: DEFAULT_WL_SPAWN_CAP,
    spawns: 8,
    peakRssPerSpawnMb: 110,
    aggregateRssBoundMb: 220,
    eventLoopBlockedMs: 12,
    maxEventLoopBlockedMs: 8,
    wallMs: 420,
  };
  return {
    profile: 'default',
    target: 'src',
    datasetItems: 300,
    capped: { ...basePhase, ...overrides.capped },
    uncapped: {
      ...basePhase,
      cap: 8,
      peakConcurrentSpawns: 8,
      aggregateRssBoundMb: 880,
      ...overrides.uncapped,
    },
    ok: false,
    violations: [],
  };
}

describe('F5 spawn-cap budget policy', () => {
  const budget = defaultLargeDbBudget();

  it('accepts a burst that respects the documented cap and RSS ceiling', () => {
    const evaluation = evaluateSpawnCapReport(syntheticReport(), budget);
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.ok).toBe(true);
  });

  it('flags an observed concurrency above the cap', () => {
    const evaluation = evaluateSpawnCapReport(
      syntheticReport({ capped: { peakConcurrentSpawns: 3 } }),
      budget,
    );
    expect(evaluation.ok).toBe(false);
    expect(evaluation.violations.join('\n')).toContain('spawn cap exceeded');
  });

  it('flags a burst that dropped reads (spawn accounting mismatch)', () => {
    const evaluation = evaluateSpawnCapReport(
      syntheticReport({ capped: { spawns: 6 } }),
      budget,
    );
    expect(evaluation.violations.join('\n')).toContain('spawn accounting');
  });

  it('flags an aggregate RSS bound over the documented ceiling', () => {
    // cap × per-spawn peak must stay ≤ the budgeted 300 MB; 2 × 160 breaches
    // it even though the individual spawn is under the per-spawn budget.
    const evaluation = evaluateSpawnCapReport(
      syntheticReport({
        capped: { peakRssPerSpawnMb: 160, aggregateRssBoundMb: 320 },
      }),
      budget,
    );
    expect(evaluation.violations.join('\n')).toContain('aggregate spawn-RSS bound');
  });

  it('flags queued reads that blocked the event loop (input must never lock)', () => {
    const evaluation = evaluateSpawnCapReport(
      syntheticReport({ capped: { eventLoopBlockedMs: 900 } }),
      budget,
    );
    expect(evaluation.violations.join('\n')).toContain('event loop blocked');
  });

  it('reads the documented cap from the checked-in budget file', () => {
    const checkedIn = readLargeDbBudget(REPO_ROOT);
    expect(checkedIn.acTargets.wlSpawnCap).toBe(DEFAULT_WL_SPAWN_CAP);
    expect(checkedIn.acTargets.paneAggregateRssMb).toBe(300);
  });
});

describe(
  'F5 spawn-cap measured ratchet',
  { timeout: 300_000 },
  () => {
    /**
     * The measured half is skipped on a loaded host (> 0.75 load/core): the 1 ms event-loop
     * probe counts OS descheduling as "blocked", so under external CPU
     * contention an absolute timing reading describes the host, not the
     * plugin (the documented F1 policy gates regressions on CPU time for the
     * same reason). The absolute AC1/AC5 numbers are measured at full scale
     * by F7's `--ac-report` on a quiet reference host; the deterministic
     * cap/RSS/no-drop policy is covered by the synthetic tests above
     * regardless.
     */
    it('keeps a real read burst inside the documented cap, loop and RSS bounds', async () => {
      const report = await runSpawnConcurrencyScenario({
        profile: 'default',
        // A modest default-suite burst; the on-demand full-scale run uses
        // `--spawn-burst 12` at `--profile full`.
        burst: 6,
      });

      // The production semaphore is the enforcement: the observed peak
      // simultaneous child processes never exceeds the documented cap, and
      // the uncapped reference of the SAME burst exceeds it (so the bound is
      // meaningful, not vacuous).
      expect(report.capped.peakConcurrentSpawns).toBeLessThanOrEqual(
        report.capped.cap,
      );
      expect(report.uncapped.peakConcurrentSpawns).toBeGreaterThan(
        report.capped.peakConcurrentSpawns,
      );

      // Nothing was dropped: every burst read spawned exactly once.
      expect(report.capped.spawns).toBe(report.capped.burst);

      // Queued reads never blocked input: total event-loop blocking during a
      // spawn-heavy burst stays well inside the parent AC 1 ≤ ~200 ms bound.
      // The 1 ms probe counts OS descheduling as blocked, so the absolute
      // reading is only valid on a quiet host (check AFTER the measurement:
      // a 1-min average sampled at collection time misses contention spikes).
      // The absolute AC1 number is measured at full scale by F7's
      // `--ac-report` on a quiet reference host; the deterministic cap/RSS/
      // no-drop policy above holds regardless.
      const loadPerCore = os.loadavg()[0] / Math.max(1, os.cpus().length);
      if (loadPerCore <= 0.75) {
        expect(report.capped.eventLoopBlockedMs).toBeLessThanOrEqual(200);
      } else {
        console.warn(
          `[spawn-cap] host load ${loadPerCore.toFixed(2)}/core — absolute event-loop ` +
            `assertion skipped (measured ${report.capped.eventLoopBlockedMs} ms)`,
        );
      }

      // RSS: the per-spawn peaks were recorded by the CLI's own spawn
      // instrumentation and the documented aggregate bound (cap × peak) holds.
      expect(report.capped.peakRssPerSpawnMb).toBeGreaterThan(0);
      const budget = defaultLargeDbBudget();
      if (report.capped.aggregateRssBoundMb !== null) {
        expect(report.capped.aggregateRssBoundMb).toBeLessThanOrEqual(
          budget.acTargets.paneAggregateRssMb,
        );
      }

      const evaluation = evaluateSpawnCapReport(report, budget);
      const violations =
        loadPerCore <= 0.75
          ? evaluation.violations
          : evaluation.violations.filter((violation) => !violation.includes('event loop blocked'));
      expect(violations, violations.join('\n')).toEqual([]);
      if (loadPerCore <= 0.75) expect(report.ok).toBe(true);

      // Same fixture logic as the refresh ratchet (nested + dependency-edged).
      expect(report.datasetItems).toBe(LARGE_DB_PROFILES.default.items);
    });
  },
);
