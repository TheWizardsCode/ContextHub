/**
 * Contract tests for the Herdr default-view refresh benchmark
 * (F1 of parent WL-0MV02VA29009WBEN).
 *
 * These assert the observable contract of the harness rather than absolute
 * timings (which are host-dependent): it seeds the requested dataset, drives
 * the default-view refresh data path against a REAL `wl` binary, reports
 * positive warm/cold latencies, and — the regression guard — records the
 * number of `wl` child processes spawned per refresh.
 *
 * The benchmark is executed as a SUBPROCESS: the vitest test setup installs a
 * global `child_process` mock and prepends `tests/cli/mock-bin` to PATH, both
 * of which would otherwise break the harness's real `wl` spawns. The
 * subprocess receives a PATH with the mock-bin entries removed.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');

/** PATH entries excluding the vitest `tests/cli/mock-bin` shims. */
function realPathEntries(): string[] {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .filter((dir) => !dir.includes('mock-bin'));
}

/** True when a real `wl` binary is resolvable outside the mock-bin. */
function hasWl(): boolean {
  return realPathEntries().some((dir) => {
    try {
      return fs.existsSync(path.join(dir, 'wl'));
    } catch {
      return false;
    }
  });
}

describe.skipIf(!hasWl())('herdr-refresh-perf benchmark harness', () => {
  it('seeds the dataset and reports warm/cold latency plus the wl spawn count', () => {
    const proc = spawnSync(
      'npx',
      [
        'tsx',
        'bench/herdr-refresh-perf.ts',
        '--items',
        '30',
        '--parents',
        '5',
        '--children-per-parent',
        '2',
        '--iterations',
        '1',
        '--json',
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: realPathEntries().join(path.delimiter) },
        encoding: 'utf-8',
        timeout: 120_000,
      },
    );

    expect(proc.status, proc.stderr || proc.stdout).toBe(0);
    const stdout = String(proc.stdout ?? '');
    const result = JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
      itemCount: number;
      expandedParents: number;
      childrenPerParent: number;
      iterations: number;
      warmMs: number;
      coldMs: number;
      coldSpawns: number;
      warmSpawns: number;
      coldReadWorkSpawns: number;
      targetMs: number;
      withinTarget: boolean;
      dbPath: string;
    };

    expect(result.itemCount).toBe(30);
    expect(result.expandedParents).toBe(5);
    expect(result.childrenPerParent).toBe(2);
    expect(result.iterations).toBe(1);

    // Positive, finite latencies for both phases.
    expect(result.warmMs).toBeGreaterThan(0);
    expect(result.coldMs).toBeGreaterThan(0);
    expect(Number.isFinite(result.warmMs)).toBe(true);
    expect(Number.isFinite(result.coldMs)).toBe(true);

    // Consolidated cold refresh (WL-0MV5CBQ6L005SPAG): the default view now
    // spawns only `wl next` plus the three mandatory-subset queries (critical,
    // in_review review queue, actively-worked in-progress —
    // WL-0MV6KV22S004NYIU). The
    // review-queue state is deduplicated against the mandatory in_review
    // subset, and the actionable count plus expanded children are read
    // in-process from SQLite — previously this was ~25 spawns at 20 expanded
    // parents. Assert the reduction with headroom for the in-process fallback.
    expect(result.coldSpawns).toBeLessThanOrEqual(6);
    expect(result.warmSpawns).toBeLessThanOrEqual(6);
    expect(result.coldSpawns).toBeGreaterThanOrEqual(1);

    // The cold phase genuinely did read work (cache was invalidated).
    expect(result.coldReadWorkSpawns).toBeGreaterThan(0);

    expect(result.targetMs).toBe(2000);
    expect(typeof result.withinTarget).toBe('boolean');
    expect(result.dbPath.endsWith('worklog.db')).toBe(true);
  }, 120_000);
});
