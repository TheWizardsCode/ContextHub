/**
 * Contract tests for the `startOn` filter benchmark's query-plan capture
 * (WL-0MWMGEXX3003QJRV, parent WL-0MWM0FDZK007BAD0 AC9).
 *
 * The benchmark note is the evidence that the shipped default filter kept
 * `list` / `search` / `next` inside the existing benchmarks, so the thing that
 * produces that evidence must not quietly degrade into hand-waving:
 *
 *  1. the report carries `EXPLAIN QUERY PLAN` output for the statements the
 *     surfaces actually prepare (captured from the live connection),
 *  2. the shipped surfaces are shown to scan the work-item table / use the FTS
 *     index rather than (wrongly) claiming a `startOn` index scan,
 *  3. the representative `startOn` probe proves the migration's index is
 *     usable, so the note can honestly separate "index exists" from "this read
 *     does not need it",
 *  4. the text report renders the plans (the note quotes it).
 *
 * Runs the `default` fixture (300 items) to keep the suite fast; the method
 * under test is profile-independent.
 */
import { describe, it, expect } from 'vitest';
import {
  START_ON_INDEX_PROBE_SQL,
  formatStartOnFilterBaseline,
  runStartOnFilterBaseline,
  type StartOnFilterBaselineReport,
} from '../../bench/start-on-filter-baseline.js';

const report: StartOnFilterBaselineReport = runStartOnFilterBaseline({
  profile: 'default',
  runs: 3,
});

/** The plan entry a surface runs, or `undefined` when it prepares nothing. */
function entryFor(surface: string) {
  return report.queryPlans.find((entry) => entry.surfaces.includes(surface));
}

describe('startOn filter benchmark — query plans', () => {
  it('captures at least one plan per measured surface plus the index probe', () => {
    // `list` and `next` share the same base read, so the de-duplicated list is
    // the base read + the FTS read + the probe — never fewer.
    expect(report.queryPlans.length).toBeGreaterThanOrEqual(3);
    for (const surface of ['list', 'search', 'next']) {
      expect(entryFor(surface), `no plan captured for '${surface}'`).toBeDefined();
    }
    const probe = report.queryPlans.find((entry) => entry.surfaces.includes('index probe'));
    expect(probe?.sql).toBe(START_ON_INDEX_PROBE_SQL);
  });

  it('records the raw read as a work-item table scan shared by list and next', () => {
    const baseRead = report.queryPlans.find(
      (entry) => entry.sql === 'SELECT * FROM workitems',
    );
    expect(baseRead).toBeDefined();
    expect(baseRead?.plan.join(' | ')).toContain('SCAN workitems');
    expect(baseRead?.surfaces).toEqual(expect.arrayContaining(['list', 'next']));
    // The shipped filter is memory-side, so no read claims the startOn index.
    expect(baseRead?.usesStartOnIndex).toBe(false);
  });

  it('records the FTS plan for search', () => {
    const search = entryFor('search');
    expect(search?.sql).toContain('MATCH ?');
    expect(search?.plan.join(' | ')).toContain('worklog_fts');
    expect(search?.usesStartOnIndex).toBe(false);
  });

  it('shows the startOn index is usable for a SQL-side predicate', () => {
    const probe = report.queryPlans.find((entry) => entry.surfaces.includes('index probe'));
    expect(probe?.usesStartOnIndex).toBe(true);
    expect(probe?.plan.join(' | ')).toContain('idx_workitems_startOn');
  });

  it('never leaves a plan entry empty', () => {
    for (const entry of report.queryPlans) {
      expect(entry.surfaces.length, 'surfaces').toBeGreaterThan(0);
      expect(entry.sql.length, 'sql').toBeGreaterThan(0);
      expect(entry.plan.length, `plan for ${entry.sql}`).toBeGreaterThan(0);
    }
  });

  it('renders the plans in the human-readable report', () => {
    const text = formatStartOnFilterBaseline(report);
    expect(text).toContain('EXPLAIN QUERY PLAN');
    expect(text).toContain('SCAN workitems');
    expect(text).toContain('idx_workitems_startOn');
  });
});
