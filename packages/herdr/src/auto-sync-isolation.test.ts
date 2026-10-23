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
 */

import { describe, it, expect } from 'vitest';

import {
  REPO_ROOT,
  evaluateLargeDbBudget,
  percentile,
  readLargeDbBudget,
  runSyncInFlightScenario,
  runSyncLockContentionScenario,
  type LargeDbEvaluationInput,
} from '../test/perf/large-db-harness.js';

const repoRoot = REPO_ROOT;

/** p95 of the given samples (0 when empty). */
function p95(values: number[]): number {
  return percentile(values, 0.95) ?? 0;
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

    // — Off the TUI event loop (AC2): starting the sync must not block.
    expect(report.spawnBlockingMs).toBeLessThanOrEqual(200);

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
    // same host), and event-loop blocking keeps the same headroom.
    const wallBase = p95(report.baseline.map((s) => s.wallMs));
    const wallWith = p95(report.withSync.map((s) => s.wallMs));
    expect(wallWith).toBeLessThanOrEqual(Math.max(wallBase + 500, wallBase * 3));
    const blBase = p95(report.baseline.map((s) => s.eventLoopBlockedMs));
    const blWith = p95(report.withSync.map((s) => s.eventLoopBlockedMs));
    expect(blWith).toBeLessThanOrEqual(Math.max(200, blBase * 3));

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
    for (const sample of report.underWriterLock) {
      expect(sample.spawns).toBe(1);
    }
    const wallBase = p95(report.baseline.map((s) => s.wallMs));
    const wallUnder = p95(report.underWriterLock.map((s) => s.wallMs));
    expect(wallUnder).toBeLessThanOrEqual(Math.max(wallBase + 500, wallBase * 3));
    const blBase = p95(report.baseline.map((s) => s.eventLoopBlockedMs));
    const blUnder = p95(report.underWriterLock.map((s) => s.eventLoopBlockedMs));
    expect(blUnder).toBeLessThanOrEqual(Math.max(200, blBase * 3));
  });
});
