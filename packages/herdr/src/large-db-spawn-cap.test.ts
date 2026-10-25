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
 *      spawn per read, keep the event loop within the ≤ ~200 ms input bound
 *      measured as on-CPU time (host descheduling on a shared machine is
 *      excluded from the gate, WL-0MVMSE5LN003KCPQ), and keep the derived
 *      aggregate bound `cap × per-spawn peak` inside the documented RSS
 *      ceiling. The same burst with the cap widened is the `uncapped`
 *      reference (the fan-out the budget bounds).
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
  attributeEventLoopTick,
  defaultLargeDbBudget,
  evaluateSpawnCapReport,
  readLargeDbBudget,
  runSpawnConcurrencyScenario,
  startEventLoopProbe,
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
    eventLoopBusyBlockedMs: 12,
    maxEventLoopBusyBlockedMs: 8,
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
    // Loop-attributable (on-CPU) blocking, not just a late timer.
    const evaluation = evaluateSpawnCapReport(
      syntheticReport({
        capped: { eventLoopBlockedMs: 900, eventLoopBusyBlockedMs: 900 },
      }),
      budget,
    );
    expect(evaluation.violations.join('\n')).toContain('event loop blocked');
  });

  it('does not flag wall-clock delay caused by host descheduling (not loop work)', () => {
    // WL-0MVMSE5LN003KCPQ: on a shared host the 1 ms probe counted OS
    // descheduling (other agents' suites) as "blocked", flaking the measured
    // ratchet with 332 ms of wall delay and ~none of it attributable to the
    // process. The gate is on-CPU blocking (F1's CPU-time policy), so a
    // loaded host cannot fail the absolute AC1 bound.
    const evaluation = evaluateSpawnCapReport(
      syntheticReport({
        capped: { eventLoopBlockedMs: 332.3, eventLoopBusyBlockedMs: 18 },
      }),
      budget,
    );
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.ok).toBe(true);
  });

  it('reads the documented cap from the checked-in budget file', () => {
    const checkedIn = readLargeDbBudget(REPO_ROOT);
    expect(checkedIn.acTargets.wlSpawnCap).toBe(DEFAULT_WL_SPAWN_CAP);
    expect(checkedIn.acTargets.paneAggregateRssMb).toBe(300);
  });
});

describe('event-loop probe CPU attribution', () => {
  const yieldToEventLoop = (ms = 5): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
  /** Block this thread synchronously for `ms` (the loop cannot run timers). */
  const blockLoop = (ms = 120): void => {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      // busy-wait: the loop is blocked by our own synchronous work
    }
  };

  it('attributes a tick to loop work only when the loop thread consumed CPU', () => {
    // synchronous block: the timer ran late AND the loop thread was on CPU
    expect(attributeEventLoopTick(300, 300, 2)).toEqual({
      blockedMs: 298,
      busyBlockedMs: 298,
    });
    // host descheduling: the timer ran late with the process off CPU
    expect(attributeEventLoopTick(300, 1, 2)).toEqual({
      blockedMs: 298,
      busyBlockedMs: 0,
    });
    // a normal tick: inside the timer-granularity tolerance
    expect(attributeEventLoopTick(1.5, 0.2, 2)).toEqual({
      blockedMs: 0,
      busyBlockedMs: 0,
    });
    // partial: half on CPU, half descheduled
    expect(attributeEventLoopTick(9, 4, 2)).toEqual({
      blockedMs: 7,
      busyBlockedMs: 2,
    });
    // CPU can never exceed the interval the loop had (parallel GC/compiler
    // threads on a process-wide clock must not look like loop work)
    expect(attributeEventLoopTick(10, 40, 2)).toEqual({
      blockedMs: 8,
      busyBlockedMs: 8,
    });
  });

  it('records a synchronous block as on-CPU loop blocking', async () => {
    const probe = startEventLoopProbe();
    await yieldToEventLoop();
    blockLoop();
    // The delayed tick is only recorded once the loop is free again.
    await yieldToEventLoop();
    const blocking = probe.stop();
    // A ~120 ms synchronous block consumes ~120 ms of loop-thread CPU whatever
    // the host scheduler does, so the CPU-attributed reading is load-independent.
    expect(blocking.busyBlockedMs).toBeGreaterThan(60);
    expect(blocking.totalBlockedMs).toBeGreaterThanOrEqual(blocking.busyBlockedMs);
  });

  it('reports a wall-clock delay with no CPU use as wall-only (descheduling)', async () => {
    // Frozen CPU clock: exactly the shared-host pattern (the timer runs late
    // because the process was descheduled). Nothing may be attributed to the
    // loop.
    const frozen = { user: 9_000_000, system: 1_000_000 };
    const probe = startEventLoopProbe(2, { readCpuUsage: () => frozen });
    await yieldToEventLoop();
    blockLoop();
    await yieldToEventLoop();
    const blocking = probe.stop();
    expect(blocking.totalBlockedMs).toBeGreaterThan(60);
    expect(blocking.busyBlockedMs).toBe(0);
  });
});

describe(
  'F5 spawn-cap measured ratchet',
  { timeout: 300_000 },
  () => {
    /**
     * The measured half asserts the cap/RSS/no-drop invariants and the
     * input-lag bound that the plugin is responsible for. Input lag is
     * measured as the event-loop delay during which the process was actually
     * on CPU: the 1 ms probe's raw wall delay also counts OS descheduling, so
     * on a shared host (other agents' test suites) a wall reading describes
     * the host, not the plugin. F1 gates regressions on CPU time for the same
     * reason. The absolute AC1/AC5 numbers at full scale are still measured by
     * F7's `--ac-report` on a quiet reference host; the host-independent
     * cap/RSS/no-drop policy is covered by the synthetic tests above too.
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

      // Queued reads never blocked input: total event-loop blocking the
      // process actually spent running code stays inside the parent AC 1
      // ≤ ~200 ms bound. OS descheduling — other agents' suites on a shared
      // host — delays the probe timers without consuming this process's CPU,
      // so like F1's CPU-time gate the absolute bound is asserted on
      // loop-attributable time and the raw wall reading is reported for
      // diagnostics only (WL-0MVMSE5LN003KCPQ).
      const loadPerCore = os.loadavg()[0] / Math.max(1, os.cpus().length);
      expect(report.capped.eventLoopBusyBlockedMs).toBeLessThanOrEqual(200);
      if (report.capped.eventLoopBlockedMs > 200) {
        console.warn(
          `[spawn-cap] wall-clock loop delay ${report.capped.eventLoopBlockedMs} ms exceeds 200 ms ` +
            `but CPU-attributed blocking is ${report.capped.eventLoopBusyBlockedMs} ms — ` +
            `host descheduling at ${loadPerCore.toFixed(2)} load/core, not the plugin`,
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
      expect(evaluation.violations, evaluation.violations.join('\n')).toEqual([]);
      expect(report.ok).toBe(true);

      // Same fixture logic as the refresh ratchet (nested + dependency-edged).
      expect(report.datasetItems).toBe(LARGE_DB_PROFILES.default.items);
    });
  },
);
