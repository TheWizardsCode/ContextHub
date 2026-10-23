/**
 * Stage-profile verification (F2 — WL-0MVJV2NNG00771C6).
 *
 * F1 measures the refresh AGGREGATE (parent epic WL-0MVJC1EQX001QR9W); F2 needs
 * per-driver attribution so the epic can decide what F3–F6 fix and what becomes
 * a separate `wl sync` perf item. This suite pins the two things that can
 * regress silently:
 *
 *   1. ATTRIBUTION — the derived rows (`payload build = cold spawn − CLI
 *      start-up`), the pct shares and the median helper are pure functions, so
 *      they are asserted deterministically without running the CLI.
 *   2. MEASURED — a real, small-scale stage-profile run must measure EVERY
 *      documented stage through the real seams: spawned stages record one
 *      spawn with its own CPU/RSS (`read-work` for the cold worklist read,
 *      `cache-hit` for the warm one), in-process stages go through the real
 *      refresh scope, and the render stage exercises the real row model.
 *
 * The full-scale profile (~2,600 items / ~124 MB) is run on demand:
 *
 *     npm run test:perf:large -- --stages
 */

import { describe, it, expect } from 'vitest';

import {
  LARGE_DB_PROFILES,
  attributeStages,
  formatStageProfile,
  medianOf,
  runStageProfile,
  type StageSample,
} from '../test/perf/large-db-harness.js';

/** A synthetic stage sample for the pure attribution tests. */
function stage(
  name: StageSample['stage'],
  wallMs: number,
  cpuMs = wallMs,
  action: StageSample['action'] = 'no-op',
): StageSample {
  return {
    stage: name,
    label: `${name} label`,
    samples: 1,
    wallMs,
    cpuMs,
    spawns: 0,
    peakRssMb: null,
    payloadBytes: null,
    spawnKind: null,
    action,
    note: `${name} note`,
  };
}

describe('stage profile attribution (pure)', () => {
  it('derives the worklist payload-build cost as cold spawn minus CLI start-up', () => {
    const { rows, serialisedBaselineMs } = attributeStages([
      stage('cli-startup', 300),
      stage('worklist-cold', 1000, 900),
      stage('json-parse', 20),
      stage('children-inprocess-cold', 60),
      stage('actionable-count', 5),
      stage('render', 15),
    ]);

    const payloadRow = rows.find((row) => row.row.startsWith('worklist payload build'));
    expect(payloadRow).toBeDefined();
    expect(payloadRow?.wallMs).toBe(700);
    expect(payloadRow?.cpuMs).toBe(600);
    expect(payloadRow?.action).toBe('fix-in-scope');

    // The serialised one-refresh baseline is the sum of the stages one refresh
    // actually runs, NOT the start-up-only or fallback stages.
    expect(serialisedBaselineMs).toBe(1100);
    const coldRow = rows.find((row) => row.row === 'worklist-cold label');
    expect(coldRow?.pct).toBeCloseTo(90.9, 1);
  });

  it('clamps the derived payload build at zero when start-up dominates', () => {
    const { rows } = attributeStages([stage('cli-startup', 500), stage('worklist-cold', 420)]);
    const payloadRow = rows.find((row) => row.row.startsWith('worklist payload build'));
    expect(payloadRow?.wallMs).toBe(0);
    expect(payloadRow?.cpuMs).toBe(0);
  });

  it('keeps the documented stage order and skips stages that were not measured', () => {
    const { rows } = attributeStages([
      stage('render', 10),
      stage('cli-startup', 300),
      stage('worklist-cold', 1000),
    ]);
    const stageRows = rows.filter((row) => !row.row.startsWith('worklist payload build'));
    expect(stageRows.map((row) => row.row)).toEqual([
      'cli-startup label',
      'worklist-cold label',
      'render label',
    ]);
    // No refresh-stage samples beyond worklist-cold/render → baseline is their sum.
    expect(rows.length).toBe(1 + stageRows.length);
  });

  it('computes the median for odd, even and empty sample lists', () => {
    expect(medianOf([5])).toBe(5);
    expect(medianOf([9, 1, 5])).toBe(5);
    expect(medianOf([10, 2, 8, 4])).toBe(6);
    expect(medianOf([])).toBe(0);
  });
});

describe('stage profile (measured, small fixture)', () => {
  it(
    'measures every documented refresh driver through the real seams',
    async () => {
      const report = await runStageProfile({
        profile: 'default',
        scale: {
          items: 90,
          descriptionChars: 800,
          commentsPerItem: 2,
          commentChars: 200,
          parentGroups: 6,
          childrenPerParent: 3,
          grandchildrenPerParent: 2,
          dependencyEvery: 5,
          expandedParents: 4,
          browseCount: 10,
        },
        samples: 1,
      });

      const byStage = new Map(report.stages.map((sample) => [sample.stage, sample]));
      const expected = [
        'cli-startup',
        'worklist-cold',
        'worklist-warm',
        'json-parse',
        'sqlite-open',
        'sqlite-full-read',
        'subset-queries',
        'children-inprocess-cold',
        'children-inprocess-warm',
        'children-cli-per-parent',
        'actionable-count',
        'hydrator-dep-list',
        'render',
      ] as const;
      expect(report.stages.map((sample) => sample.stage)).toEqual([...expected]);

      // Spawned stages: exactly one child each, with its own CPU/RSS and the
      // spawn-record kind that proves which path ran.
      const startup = byStage.get('cli-startup');
      expect(startup?.spawns).toBe(1);
      expect(startup?.spawnKind).toBe('version');
      expect(startup?.peakRssMb).toBeGreaterThan(0);

      const cold = byStage.get('worklist-cold');
      expect(cold?.spawns).toBe(1);
      expect(cold?.spawnKind).toBe('read-work');
      expect(cold?.payloadBytes).toBeGreaterThan(0);
      expect(cold?.peakRssMb).toBeGreaterThan(0);

      const warm = byStage.get('worklist-warm');
      expect(warm?.spawns).toBe(1);
      expect(warm?.spawnKind).toBe('cache-hit');

      expect(byStage.get('children-cli-per-parent')?.spawns).toBe(1);
      expect(byStage.get('hydrator-dep-list')?.spawns).toBe(1);

      // In-process stages: no spawn, real work measured.
      for (const name of [
        'sqlite-open',
        'sqlite-full-read',
        'subset-queries',
        'children-inprocess-cold',
        'children-inprocess-warm',
        'actionable-count',
        'render',
        'json-parse',
      ] as const) {
        const sample = byStage.get(name);
        expect(sample?.spawns, name).toBe(0);
        expect(sample?.wallMs, name).toBeGreaterThan(0);
      }

      // Attribution contains the derived payload-build row plus every stage.
      expect(report.refreshAttribution.serialisedBaselineMs).toBeGreaterThan(0);
      expect(
        report.refreshAttribution.rows.some((row) =>
          row.row.startsWith('worklist payload build'),
        ),
      ).toBe(true);
      expect(report.refreshAttribution.rows.length).toBe(report.stages.length + 1);

      // Payload: measured bytes match the cold spawn, and the documented
      // contract (full WorkItem[] per subset) is recorded as non-trimmable.
      expect(report.payload.bytes).toBe(cold?.payloadBytes);
      expect(report.payload.items).toBeGreaterThan(0);
      expect(report.payload.trimmableWithoutContractChange).toBe(false);
      expect(report.payload.contract).toContain('WorkItem[]');

      // RSS breakdown: every spawn reported its own peak, and the
      // materialisation term is positive (the table read costs heap). Peak
      // ordering across the spawns is only meaningful at full scale (a small
      // fixture is dominated by Node start-up noise), so it is not asserted.
      expect(report.rss.rows).toHaveLength(5);
      expect(report.rss.startupPeakMb).toBeGreaterThan(0);
      expect(report.rss.singleItemReadPeakMb).toBeGreaterThan(0);
      expect(report.rss.worklistSpawnPeakMb).toBeGreaterThan(0);
      expect(report.rss.worklistSpawnPeakMb).toBeGreaterThanOrEqual(
        (report.rss.startupPeakMb as number) - 5,
      );
      const materialisation = report.rss.rows[2];
      expect(materialisation.deltaMb).not.toBeNull();
      expect(materialisation.deltaMb as number).toBeGreaterThanOrEqual(0);
      expect(report.rss.rows[3].deltaMb).toBeGreaterThanOrEqual(0);
      expect(report.rss.rows[4].deltaMb).not.toBeNull();
      expect(report.rss.payloadBytes).toBe(cold?.payloadBytes);

      // The text renderer must surface every stage (report-only deliverable).
      const text = formatStageProfile(report);
      for (const sample of report.stages) expect(text).toContain(sample.stage);

      expect(LARGE_DB_PROFILES.default.items).toBe(300);
    },
    120_000,
  );
});
