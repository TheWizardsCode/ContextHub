/**
 * Documentation contract for the `startOn` epic's docs slice
 * (WL-0MWMGEXX3003QJRV, parent WL-0MWM0FDZK007BAD0 AC8/AC9).
 *
 * This slice is documentation-and-evidence only, so the documented contract IS
 * the deliverable. Each assertion pins a fact an operator or maintainer must be
 * able to find without re-deriving it from source:
 *
 *  - `CLI.md`: all three flags, the `createdAt` default, the `""` clear form,
 *    offset acceptance and the `start_on_not_reached` refusal;
 *  - `DATA_FORMAT.md`: the stored field and its default;
 *  - `API.md`: the field on every JSON surface the REST API serves;
 *  - `docs/dev/downtime-dispatcher.md`: the gate and how it composes with the
 *    assignee hold, dependency readiness and `needsProducerReview`;
 *  - `docs/migrations/start_on.md`: the storage invariant and the replaced
 *    title-prefix workflow;
 *  - `docs/benchmarks/start_on_filter_baseline.md`: the before/after figures,
 *    the captured `EXPLAIN QUERY PLAN` evidence and the budget verdict.
 *
 * Help-text assertions live with the behaviour they describe
 * (`tests/cli/create-start-on.test.ts`, `tests/cli/claim-start-on.test.ts`);
 * the query-plan capture has its own suite
 * (`tests/bench/start-on-filter-plans.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

const cliDoc = read('CLI.md');
const dataFormatDoc = read('DATA_FORMAT.md');
const apiDoc = read('API.md');
const dispatcherDoc = read('docs/dev/downtime-dispatcher.md');
const migrationDoc = read('docs/migrations/start_on.md');
const benchmarkDoc = read('docs/benchmarks/start_on_filter_baseline.md');

describe('CLI.md documents the startOn surfaces', () => {
  it('names all three flags', () => {
    expect(cliDoc).toContain('--start-on');
    expect(cliDoc).toContain('--include-not-started');
    expect(cliDoc).toContain('--starts-before');
  });

  it('states the createdAt default and the "" clear form', () => {
    expect(cliDoc).toContain('createdAt');
    expect(cliDoc).toContain('--start-on ""');
  });

  it('accepts an explicit offset and rejects an ambiguous instant', () => {
    expect(cliDoc).toContain('+01:00');
    expect(cliDoc.toLowerCase()).toContain('offset');
    expect(cliDoc).toContain('rejected');
  });

  it('documents the start_on_not_reached refusal', () => {
    expect(cliDoc).toContain('start_on_not_reached');
    expect(cliDoc).toContain('--force-start-on');
  });
});

describe('DATA_FORMAT.md documents the stored field', () => {
  it('shows startOn in the work-item example and field list', () => {
    expect(dataFormatDoc).toContain('"startOn"');
    expect(dataFormatDoc).toContain('**startOn**');
  });

  it('states the effective-instant default', () => {
    expect(dataFormatDoc).toContain('startOn ?? createdAt');
    expect(dataFormatDoc).toContain('createdAt');
    expect(dataFormatDoc).toContain('docs/migrations/start_on.md');
  });
});

describe('API.md documents startOn on every JSON surface', () => {
  it('lists every work-item JSON surface', () => {
    expect(apiDoc).toContain('startOn');
    for (const surface of [
      'POST /items',
      'GET /items/:id',
      'PUT /items/:id',
      'GET /items',
      'children',
      'descendants',
    ]) {
      expect(apiDoc, `missing surface '${surface}'`).toContain(surface);
    }
  });

  it('documents writing the field and the effective default', () => {
    expect(apiDoc).toContain('startOn ?? createdAt');
    expect(apiDoc).toContain('+01:00');
    expect(apiDoc).toContain('createdAt');
  });

  it('states that the REST list is not filtered like the CLI', () => {
    expect(apiDoc).toContain('--include-not-started');
    expect(apiDoc).toContain('start_on_not_reached');
    expect(apiDoc.toLowerCase()).toContain('not** apply');
  });
});

describe('downtime-dispatcher documents scheduling and its composition', () => {
  it('names the gate token and the override', () => {
    expect(dispatcherDoc).toContain('startOnNotReached');
    expect(dispatcherDoc).toContain('--force-start-on');
  });

  it('documents composition with the assignee hold, dependency readiness and needsProducerReview', () => {
    expect(dispatcherDoc).toContain('assignee-hold');
    expect(dispatcherDoc).toContain('dependency readiness');
    expect(dispatcherDoc).toContain('needsProducerReview');
    expect(dispatcherDoc).toContain('producer-review');
  });
});

describe('migration note is accurate and replaces the title-prefix workflow', () => {
  it('names the migration id, schema bump and storage invariant', () => {
    expect(migrationDoc).toContain('20261118-add-start-on');
    expect(migrationDoc).toContain('9 → 10');
    expect(migrationDoc).toContain('startOn ?? createdAt');
    expect(migrationDoc).toContain('idx_workitems_startOn');
  });

  it('explains that scheduling is the field, not a title prefix', () => {
    expect(migrationDoc).toContain('title prefix');
    expect(migrationDoc).toContain('startOn');
  });
});

describe('benchmark note records the before/after evidence', () => {
  it('has separate before and after sections', () => {
    expect(benchmarkDoc).toContain('Results — before');
    expect(benchmarkDoc).toContain('Results — after');
  });

  it('records the measured before and after figures', () => {
    expect(benchmarkDoc).toContain('2,407.35 ms');
    expect(benchmarkDoc).toContain('1,266.17 ms');
    expect(benchmarkDoc).toContain('2,600');
    expect(benchmarkDoc).toContain('Median');
  });

  it('captures the EXPLAIN QUERY PLAN evidence and the index verdict', () => {
    expect(benchmarkDoc).toContain('EXPLAIN QUERY PLAN');
    expect(benchmarkDoc).toContain('SCAN workitems');
    expect(benchmarkDoc).toContain('idx_workitems_startOn');
    expect(benchmarkDoc).toContain('equivalent query plan');
  });

  it('records a verdict against the existing budget file', () => {
    expect(benchmarkDoc).toContain('packages/herdr/test/perf/large-db-budget.json');
    expect(benchmarkDoc).toContain('evaluation.ok');
  });
});
