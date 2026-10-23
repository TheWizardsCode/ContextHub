/**
 * Contract tests for the shared worklist query sets used by the Herdr refresh
 * harnesses, the spawn-reduction simulation and the bench tests
 * (WL-0MVI0HH740065Z2T, parent WL-0MVGYLU0S004WZUS AC3/AC6).
 *
 * The single exported argv vector matters: if the harness and the test each
 * hard-coded their own `wl worklist` invocation, the measured reduction would
 * describe a workload nobody ships. These tests pin:
 *
 *   - the consolidated set is ONE invocation and the legacy set is exactly the
 *     five F10 queries (baseline comparability),
 *   - selector validation names the valid values,
 *   - the reduction maths is derived from measured numbers (5 → 1 spawn =
 *     80 % reduction), with defined behaviour for a zero baseline.
 */

import { describe, it, expect } from 'vitest';
import {
  CONSOLIDATED_WORKLIST_QUERY,
  DEFAULT_WORKLIST_QUERY_SET,
  LEGACY_WORKLIST_QUERIES,
  WORKLIST_QUERY_SETS,
  WORKLIST_QUERY_SET_NAMES,
  computeReduction,
  isWorklistQuerySet,
  parseWorklistQuerySet,
  worklistQueriesFor,
} from '../../bench/worklist-query-sets.js';

describe('worklist query sets', () => {
  it('defines the consolidated set as one `wl worklist` invocation', () => {
    expect(CONSOLIDATED_WORKLIST_QUERY).toEqual(['worklist', '--json']);
    expect(worklistQueriesFor('consolidated')).toHaveLength(1);
    expect(worklistQueriesFor('consolidated')[0]).toBe(CONSOLIDATED_WORKLIST_QUERY);
    expect(WORKLIST_QUERY_SETS.consolidated).toHaveLength(1);
  });

  it('keeps the legacy set byte-identical to the five F10 queries', () => {
    expect(LEGACY_WORKLIST_QUERIES).toHaveLength(5);
    expect(LEGACY_WORKLIST_QUERIES.map((q) => q[0])).toEqual(['list', 'list', 'list', 'list', 'next']);
    // The critical subset spans all four statuses (child critical items stay visible).
    expect(LEGACY_WORKLIST_QUERIES[0]).toEqual([
      'list',
      '--priority',
      'critical',
      '--status',
      'open,in-progress,blocked,completed',
      '--json',
    ]);
    // The review queue spans completed AND in-progress (re-worked reviews).
    expect(LEGACY_WORKLIST_QUERIES[1]).toEqual([
      'list',
      '--status',
      'completed,in-progress',
      '--stage',
      'in_review',
      '--root-only',
      '--json',
    ]);
    // Every legacy query asks for JSON so the read cache applies.
    expect(LEGACY_WORKLIST_QUERIES.every((q) => q.includes('--json'))).toBe(true);
    expect(DEFAULT_WORKLIST_QUERY_SET).toBe('legacy');
  });

  it('validates the selector and names the valid values', () => {
    expect([...WORKLIST_QUERY_SET_NAMES]).toEqual(['legacy', 'consolidated']);
    expect(isWorklistQuerySet('legacy')).toBe(true);
    expect(isWorklistQuerySet('consolidated')).toBe(true);
    expect(isWorklistQuerySet('bogus')).toBe(false);

    expect(parseWorklistQuerySet(undefined)).toBe('legacy');
    expect(parseWorklistQuerySet('consolidated')).toBe('consolidated');
    expect(() => parseWorklistQuerySet('bogus')).toThrow(
      'Invalid --query-set "bogus": expected one of legacy, consolidated',
    );
  });
});

describe('reduction maths (measured baseline, not constants)', () => {
  it('computes an 80 % spawn reduction for 5 → 1 spawns', () => {
    const reduction = computeReduction(
      { spawns: 5, cpuSeconds: 10 },
      { spawns: 1, cpuSeconds: 2.5 },
    );

    expect(reduction.spawns).toEqual({ baseline: 5, candidate: 1, ratio: 0.2, reduction: 0.8 });
    expect(reduction.cpuSeconds).toEqual({ baseline: 10, candidate: 2.5, ratio: 0.25, reduction: 0.75 });
  });

  it('derives the ratio from whatever baseline is measured (parent AC3 target)', () => {
    // F10 measured ~83.58 CPU-s per 30 s cycle at 4 panes; the epic targets
    // ≤ 0.4× that (≤ 63.8 CPU-s is the pre-F4 cap). The ratio follows the
    // measured inputs, so a different measured baseline changes it.
    const f10 = computeReduction(
      { spawns: 5, cpuSeconds: 83.58 },
      { spawns: 1, cpuSeconds: 33.0 },
    );
    expect(f10.spawns.reduction).toBeCloseTo(0.8, 10);
    expect(f10.cpuSeconds.ratio).toBeCloseTo(33.0 / 83.58, 10);
    expect(f10.cpuSeconds.ratio!).toBeLessThanOrEqual(0.4);

    const otherBaseline = computeReduction(
      { spawns: 10, cpuSeconds: 40 },
      { spawns: 2, cpuSeconds: 10 },
    );
    expect(otherBaseline.spawns.reduction).toBeCloseTo(0.8, 10);
    expect(otherBaseline.cpuSeconds.reduction).toBeCloseTo(0.75, 10);
  });

  it('reports no ratio for a zero baseline instead of dividing by zero', () => {
    const reduction = computeReduction({ spawns: 0, cpuSeconds: 0 }, { spawns: 1, cpuSeconds: 1 });
    expect(reduction.spawns.ratio).toBeNull();
    expect(reduction.spawns.reduction).toBeNull();
    expect(reduction.cpuSeconds.reduction).toBeNull();
  });
});
