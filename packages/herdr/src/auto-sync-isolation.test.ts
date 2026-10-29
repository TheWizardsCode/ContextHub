/**
 * packages/herdr/src/auto-sync-isolation.test.ts — F3 auto-sync isolation
 * (WL-0MVJV2O7H003HY9N).
 *
 * The parent epic's ACs demand that a long background `wl sync` can never
 * stall the pane: a concurrent default-view refresh must complete without
 * waiting on the sync or its locks, the sync spawn must stay off the TUI
 * event loop, and the only "hanging" indication is a non-blocking status
 * notice. These tests measure that with the SAME harness/cache/fixture
 * machinery as the F1 ratchet (`large-db-harness.ts`):
 *
 *   1. `runSyncInFlightScenario` — a hooked long sync (the operator-observed
 *      ~36 s) started through the REAL `runSync`; refreshes measured before
 *      and during it prove the refresh never waited (no wait gap), the sync
 *      spawn blocked the event loop ~0 ms, the pane's notice showed
 *      "syncing…", and the spawn/idle guarantees are preserved.
 *   2. `runSyncLockContentionScenario` — a sync-shaped writer holding both
 *      the sync's file lock and a real SQLite write transaction; concurrent
 *      refreshes must complete within the same host-relative budget (the
 *      refresh never shares the sync's handle and never takes its lock).
 *
 * Absolute AC numbers (refresh ≤ 1.5 s p95, ≤ 200 ms event-loop blocking at
 * full scale) are asserted by the F1 budget ratchet once `acTargets.enforced`
 * flips at F7; like F1, these tests gate on CPU/relative headroom so a shared
 * host cannot manufacture a failure, while the no-wait-gap invariant (the
 * actual F3 deliverable) is asserted absolutely.
 *
 * Host-independence (WL-0MVMSE2S0006L56D): the absolute event-loop assertions
 * only apply when the host was measured QUIET across the scenario window —
 * in-window peak load, `/proc/stat` CPU utilisation, and an idle-loop canary
 * (a single trailing 1-min load read missed a host that was ~100 % busy while
 * reading 0.69 load/core). The relative headroom is rate based (blocked ÷
 * wall), because the probe's total grows with the window and a host-stretched
 * refresh inflated it without any product change.
 */

import { describe, it, expect } from 'vitest';
import {
  REPO_ROOT,
  eventLoopHeadroomOk,
  evaluateLargeDbBudget,
  hostContendedForAbsoluteTiming,
  percentile,
  readLargeDbBudget,
  runSyncInFlightScenario,
  runSyncLockContentionScenario,
  type HostConditions,
  type LargeDbEvaluationInput,
} from '../test/perf/large-db-harness.js';

const repoRoot = REPO_ROOT;

/** p95 of the given samples (0 when empty). */
function p95(values: number[]): number {
  return percentile(values, 0.95) ?? 0;
}

/** A representative synthetic host-conditions record (deterministic tests). */
function hostConditions(overrides: Partial<HostConditions> = {}): HostConditions {
  return {
    loadPerCore: { start: 0.2, max: 0.3, end: 0.2, samples: 5 },
    cpuPercent: 10,
    cpuSource: 'proc-stat',
    idleNoise: { durationMs: 250, blockedMs: 1, maxBlockedMs: 1 },
    ...overrides,
  };
}

/** One-line host description for skip warnings (keeps failures diagnosable). */
function describeHost(conditions: HostConditions): string {
  const cpu =
    typeof conditions.cpuPercent === 'number' ? `${Math.round(conditions.cpuPercent)}% cpu` : 'cpu n/a';
  return (
    `load/core ${conditions.loadPerCore.start.toFixed(2)} -> ${conditions.loadPerCore.max.toFixed(2)} max, ` +
    `${cpu}, idle noise ${conditions.idleNoise.blockedMs} ms / ${conditions.idleNoise.durationMs} ms`
  );
}

describe('auto-sync isolation — refresh never waits on a long sync (F3 AC1/AC3)', { timeout: 300_000 }, () => {
  it('a concurrent default-view refresh completes while a long sync is in flight, without waiting', async () => {
    const report = await runSyncInFlightScenario({
      profile: 'default',
      samples: 3,
      // The simulated duration is pure arithmetic (the hook does not sleep).
      // Use a generous 300 s so the "sync was still in flight" invariant is
      // robust on a heavily loaded host (the absolute operator-observed
      // ~36 s evidence lives in the full-scale `--ac-report` AC3 run).
      syncDurationMs: 300_000,
    });

    // — In-flight instrumentation (AC3: start time + PID + elapsed) — the
    // pane reads this exact model to render its notice.
    expect(report.syncStateAtSpawn).toBe('syncing');
    expect(typeof report.syncPid).toBe('number');
    expect(report.syncPid).toBeGreaterThanOrEqual(900_000);

    // — Off the TUI event loop (AC2): starting the sync must not block. The
    // 1 ms probe counts OS descheduling as blocked, so the absolute reading
    // is only meaningful when the host was not CPU-starved DURING the
    // window (WL-0MVMSE2S0006L56D: a single post-run 1-min load sample read
    // 0.69/core on a host whose /proc/stat utilisation was ~100 %). The
    // absolute AC evidence is F7's full-scale `--ac-report` on a quiet host;
    // on a contended host the measured value is reported but not gated.
    const contended = hostContendedForAbsoluteTiming(report.hostConditions);
    if (contended) {
      console.warn(
        `[auto-sync] host contended (${describeHost(report.hostConditions)}) — ` +
          `absolute spawn-blocking assertion skipped (measured ${report.spawnBlockingMs} ms)`,
      );
    } else {
      expect(report.spawnBlockingMs).toBeLessThanOrEqual(200);
    }

    // — Non-blocking status notice (AC2): the pane's render input shows the
    // notice the whole time the sync is in flight.
    expect(report.noticeWhileInFlight).toContain('syncing');
    for (const sample of report.withSync) {
      expect(sample.noticeText).toContain('syncing');
      // The instrumentation PID stays stable across the refresh (no handle
      // reset mid-flight — the pane's elapsed counter never restarts).
      expect(sample.syncPidAtEnd).toBe(report.syncPid);
      expect(sample.syncElapsedAtEndMs).toBeGreaterThanOrEqual(0);
    }

    // — No wait gap (AC3): every refresh finished well before the sync did.
    // A refresh that waited for the sync would end with ~0 ms remaining.
    expect(report.noWaitGap).toBe(true);
    expect(report.minRemainingAtEndMs).toBeGreaterThan(report.syncDurationMs / 2);

    // — Existing guarantees preserved (AC4): the refresh path still issues
    // exactly one consolidated worklist spawn; the sync adds NO spawn to it.
    for (const sample of [...report.baseline, ...report.withSync]) {
      expect(sample.spawns).toBe(1);
      expect(sample.spawnArgs.some((args) => args.includes('sync'))).toBe(false);
    }

    // — Host-load-tolerant budget: during the sync the refresh stays inside
    // the documented F1 wall headroom of its own no-sync baseline (same run,
    // same host), and event-loop blocking keeps the same headroom. The
    // event-loop comparison is RATE based: the probe's total is the sum of
    // every >2 ms delay, so it scales with the window and a host that
    // stretches the refresh (slow CLI spawn) inflates both sides
    // (WL-0MVMSE2S0006L56D — 402 ms against an absolute 200 ms bound with no
    // product change). Absolute numbers stay F7's quiet-host `--ac-report`.
    const wallBase = p95(report.baseline.map((s) => s.wallMs));
    const wallWith = p95(report.withSync.map((s) => s.wallMs));
    expect(wallWith).toBeLessThanOrEqual(Math.max(wallBase + 500, wallBase * 3));
    const blBase = p95(report.baseline.map((s) => s.eventLoopBlockedMs));
    const blWith = p95(report.withSync.map((s) => s.eventLoopBlockedMs));
    expect(
      eventLoopHeadroomOk(blBase, wallBase, blWith, wallWith),
      `event-loop blocking rate ${(blWith / Math.max(1, wallWith)).toFixed(3)} ` +
        `(baseline ${(blBase / Math.max(1, wallBase)).toFixed(3)}; ${Math.round(blBase)} -> ` +
        `${Math.round(blWith)} ms over ${Math.round(wallBase)} -> ${Math.round(wallWith)} ms wall) ` +
        `on host: ${describeHost(report.hostConditions)}`,
    ).toBe(true);

    // NB: there is deliberately NO absolute `blWith <= 200` assertion here.
    // The probe's total scales with the window, so on a shared host a
    // host-stretched refresh crosses the absolute AC bound with no product
    // change (WL-0MVMSE2S0006L56D — 402 ms vs a 200 ms bound at the same
    // blocking RATE as the baseline). Regression detection is fully covered
    // by the rate headroom above; the absolute AC number is asserted at full
    // scale on a quiet host by F7's `--ac-report` AC3 verdict.

    // — The hooked sync settles normally once its work is done.
    expect(report.settledState).toBe('synced');
    expect(report.lastOutcomeSuccess).toBe(true);
  });

  it('absolute AC budget check once the full-scale baseline is enforced (F7 gate)', () => {
    const budget = readLargeDbBudget(repoRoot);
    // F7 recorded a compliant full-scale baseline and flipped the F1 policy to
    // enforce the parent AC targets, so the absolute numbers are now gated at
    // full scale by the budget ratchet and by the end-to-end `--ac-report`
    // (AC3 includes the sync-in-flight measurements). Pin the enforcement and
    // prove the policy rejects a with-sync refresh over the AC2 wall target.
    expect(budget.acTargets.enforced).toBe(true);

    const breaching: LargeDbEvaluationInput = {
      profile: 'full',
      target: 'dist',
      refresh: {
        p95WallMs: budget.acTargets.refreshP95WallMs + 1,
        p95CpuMs: 1,
        eventLoopBlockingP95Ms: 0,
        maxEventLoopBlockedMs: 0,
        spawnsPerRefresh: 1,
        consolidatedWorklistSpawns: 1,
        peakRssPerSpawnMb: 100,
        aggregateSpawnRssMb: 100,
      },
      pane: { peakRssMb: 100, aggregateRssMb: 100 },
      idle: { changed: false, spawns: 0 },
      writeToReflect: { p95ReflectMs: 1 },
    };
    const violations = evaluateLargeDbBudget(breaching, budget).violations.join('\n');
    expect(violations).toContain('AC refreshP95WallMs');
  });

  it('a refresh completes while the sync holds its file lock and a real write transaction (AC3 lock contention)', async () => {
    const report = await runSyncLockContentionScenario({ profile: 'default', samples: 3 });

    // The obstructing sync artifacts were genuinely held during measurement.
    expect(report.syncFileLockHeld).toBe(true);
    expect(report.writerTransactionOpen).toBe(true);
    expect(report.dbItemCount).toBeGreaterThan(0);

    // The refresh never waits on either: the file lock is the JSONL sync lock
    // the pane's in-process scope never touches, and the write transaction is
    // on a DIFFERENT connection than the pane's refresh scope (WAL readers do
    // not block). Same host-relative headroom gate as the in-flight case.
    //
    // Spawn count under the artificial writer: the in-process read correctly
    // FAILS OPEN to the documented per-subset CLI reads when SQLite's short
    // TUI busy_timeout is exceeded, so either one consolidated spawn (the
    // norm) or the bounded fallback fan-out is correct behaviour. What must
    // never happen is an unbounded fan-out or a `wl sync` on the refresh
    // path. The "exactly one consolidated read" invariant is pinned
    // deterministically by the F1/F6 budget ratchet and the F5 spawn-cap
    // suite; here the guarantee under test is no-wait/no-hang.
    for (const sample of report.underWriterLock) {
      expect(sample.spawns).toBeGreaterThanOrEqual(1);
      expect(sample.spawns).toBeLessThanOrEqual(6);
      expect(sample.spawnArgs.some((args) => args.includes('sync'))).toBe(false);
    }
    // Wall-clock and event-loop readings are only comparable when the host
    // was not starved during the window. Contention is judged from the
    // conditions measured DURING the run (in-window load max, /proc/stat
    // utilisation, and the idle-loop canary) rather than a single trailing
    // load-average read (WL-0MVMSE2S0006L56D). The event-loop comparison is
    // rate based so a host-stretched window cannot inflate the absolute
    // total; the absolute numbers are reported by F7's quiet-host
    // `--ac-report`. The structural invariants above still gate here.
    const wallBase = p95(report.baseline.map((s) => s.wallMs));
    const wallUnder = p95(report.underWriterLock.map((s) => s.wallMs));
    const blBase = p95(report.baseline.map((s) => s.eventLoopBlockedMs));
    const blUnder = p95(report.underWriterLock.map((s) => s.eventLoopBlockedMs));
    const contended = hostContendedForAbsoluteTiming(report.hostConditions);
    if (contended) {
      console.warn(
        `[auto-sync] host contended (${describeHost(report.hostConditions)}) — ` +
          `lock-contention wall assertions skipped (wall ${Math.round(wallBase)} -> ` +
          `${Math.round(wallUnder)} ms, loop ${Math.round(blBase)} -> ${Math.round(blUnder)} ms)`,
      );
    } else {
      expect(wallUnder).toBeLessThanOrEqual(Math.max(wallBase + 500, wallBase * 3));
    }
    // The rate-based headroom is asserted on every host: it is window-length
    // independent, so host inflation cannot manufacture a failure, and it
    // rejects a genuine proportional regression (see the policy tests).
    expect(
      eventLoopHeadroomOk(blBase, wallBase, blUnder, wallUnder),
      `event-loop blocking rate ${(blUnder / Math.max(1, wallUnder)).toFixed(3)} ` +
        `(baseline ${(blBase / Math.max(1, wallBase)).toFixed(3)}) on host: ` +
        describeHost(report.hostConditions),
    ).toBe(true);
  });

  describe('host-contention guard policy (deterministic)', () => {
    it('treats a quiet host as uncontended', () => {
      expect(hostContendedForAbsoluteTiming(hostConditions())).toBe(false);
      // Absent/malformed conditions fail open (the caller keeps its gate).
      expect(hostContendedForAbsoluteTiming(undefined)).toBe(false);
    });

    it('flags a host whose CPU utilisation was saturated DURING the window', () => {
      // The failure this guard fixes: the trailing 1-min load read 0.69/core
      // while /proc/stat showed ~100 % utilisation.
      const conditions = hostConditions({
        loadPerCore: { start: 0.66, max: 0.71, end: 0.69, samples: 20 },
        cpuPercent: 100,
      });
      expect(hostContendedForAbsoluteTiming(conditions)).toBe(true);
    });

    it('falls back to the in-window peak load when CPU utilisation is unmeasurable', () => {
      const noCpu = { cpuPercent: null, cpuSource: 'unavailable' as const };
      const quiet = hostConditions({
        ...noCpu,
        loadPerCore: { start: 0.2, max: 0.6, end: 0.3, samples: 12 },
      });
      expect(hostContendedForAbsoluteTiming(quiet)).toBe(false);

      // A spike that ENDED before the window closed: `end` is low but the
      // in-window `max` (sampled during the run) trips the guard.
      const spiked = hostConditions({
        ...noCpu,
        loadPerCore: { start: 0.2, max: 0.9, end: 0.4, samples: 12 },
      });
      expect(hostContendedForAbsoluteTiming(spiked)).toBe(true);
    });

    it('flags ambient idle-loop noise above the window allowance', () => {
      const noisy = hostConditions({
        idleNoise: { durationMs: 250, blockedMs: 60, maxBlockedMs: 40 },
      });
      expect(hostContendedForAbsoluteTiming(noisy)).toBe(true);

      // Timer granularity (~few ms) is not contention.
      const granularity = hostConditions({
        idleNoise: { durationMs: 250, blockedMs: 6, maxBlockedMs: 2 },
      });
      expect(hostContendedForAbsoluteTiming(granularity)).toBe(false);
    });
  });

  describe('event-loop rate headroom policy (deterministic)', () => {
    it('accepts a with-sync rate inside the baseline headroom', () => {
      // Same proportional cost in a 2x longer window (host inflation).
      expect(eventLoopHeadroomOk(60, 1_000, 130, 2_000)).toBe(true);
    });

    it('accepts small absolute readings on a fast window', () => {
      expect(eventLoopHeadroomOk(2, 400, 20, 400)).toBe(true);
    });

    it('rejects a rate regression well beyond the baseline rate and the floor', () => {
      // 40 % of the window blocked vs 2 % in the baseline.
      expect(eventLoopHeadroomOk(20, 1_000, 400, 1_000)).toBe(false);
    });

    it('reproduces the 402 ms false failure only when the rate is also pathological', () => {
      // The reported flake: 402 ms against an absolute 200 ms bound. With a
      // ~2.2 s host-stretched window that is the same rate as the baseline,
      // so the rate gate accepts it; a genuine regression (same 402 ms in a
      // short window) is still rejected.
      expect(eventLoopHeadroomOk(60, 2_200, 402, 2_400)).toBe(true);
      expect(eventLoopHeadroomOk(20, 1_000, 402, 1_000)).toBe(false);
    });
  });
});
