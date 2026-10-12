/**
 * Per-test mock budget enforcement (WL-0MV4VSNI00002WFM).
 *
 * Pins the AST counter in `scripts/check-mock-budget.ts` and — crucially —
 * fails the suite when any split downtime-worker test exceeds the documented
 * cap of {@link MOCK_BUDGET_CAP} `vi.fn()` overrides. The check runs as part
 * of the normal unit suite so a regression cannot slip through; the same
 * script is exposed as `npm run test:mock-budget` for local/CI use.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TARGETS,
  MOCK_BUDGET_CAP,
  countMocksPerTest,
  findMockBudgetViolations,
  formatViolations,
  type SourceFile,
} from '../../scripts/check-mock-budget.js';

/** Scan an inline snippet as if it were a test file. */
const scan = (text: string) => countMocksPerTest(text, 'sample.test.ts');

const source = (path: string, text: string): SourceFile => ({ path, source: text });

describe('countMocksPerTest', () => {
  it('counts each vi.fn() override inside a test block', () => {
    const counts = scan(
      `import { it, vi } from 'vitest';\nit('a', () => {\n  const deps = makeDeps({ x: vi.fn(), y: vi.fn().mockResolvedValue(1) });\n});`,
    );

    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ title: 'a', count: 2 });
  });

  it('ignores mocks created in describe/beforeEach setup (per-test budget only)', () => {
    const counts = scan(
      `describe('d', () => {\n  beforeEach(() => { const setup = vi.fn(); });\n  it('a', () => { expect(1).toBe(1); });\n});`,
    );

    expect(counts).toHaveLength(1);
    expect(counts[0].count).toBe(0);
  });

  it("does not attribute a nested test block's mocks to the outer test", () => {
    const counts = scan(
      `it('outer', () => {\n  const a = vi.fn();\n  it('inner', () => {\n    const b = vi.fn();\n    const c = vi.fn();\n  });\n});`,
    );

    expect(counts.map((c) => ({ title: c.title, count: c.count }))).toEqual([
      { title: 'outer', count: 1 },
      { title: 'inner', count: 2 },
    ]);
  });

  it('handles it.only and it.each forms', () => {
    const counts = scan(
      `it.only('solo', () => { const a = vi.fn(); const b = vi.fn(); });\n` +
        `it.each([1, 2])('row %i', () => { const c = vi.fn(); });`,
    );

    expect(counts.map((c) => c.count)).toEqual([2, 1]);
    expect(counts[1].title).toBe('row %i');
  });

  it('marks dynamic test titles and ignores vi.spyOn / bare vi.fn references', () => {
    const counts = scan(
      "it(`dynamic ${x}`, () => {\n  const spy = vi.spyOn(o, 'm');\n  const ref = vi.fn;\n});",
    );

    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ title: '<dynamic>', count: 0 });
  });

  it('reports the 1-based line of each test', () => {
    const counts = scan(`\n\nit('third line', () => { vi.fn(); });`);

    expect(counts[0].line).toBe(3);
  });

  it('ignores todo/skip declarations with no callback', () => {
    const counts = scan(`it.todo('later');\ntest.skip('skipped');\nit('real', () => { vi.fn(); });`);

    expect(counts.map((c) => c.title)).toEqual(['real']);
  });
});

describe('findMockBudgetViolations', () => {
  it('returns only tests strictly above the cap, sorted by mock count', () => {
    const violations = findMockBudgetViolations(
      [
        source('a.test.ts', `it('ok', () => { vi.fn(); vi.fn(); vi.fn(); vi.fn(); vi.fn(); });`),
        source(
          'b.test.ts',
          `it('six', () => { vi.fn(); vi.fn(); vi.fn(); vi.fn(); vi.fn(); vi.fn(); });`,
        ),
        source(
          'c.test.ts',
          `it('eight', () => { vi.fn(); vi.fn(); vi.fn(); vi.fn(); vi.fn(); vi.fn(); vi.fn(); vi.fn(); });`,
        ),
      ],
      5,
    );

    expect(violations.map((v) => ({ file: v.file, count: v.count }))).toEqual([
      { file: 'c.test.ts', count: 8 },
      { file: 'b.test.ts', count: 6 },
    ]);
  });

  it('uses MOCK_BUDGET_CAP=5 by default', () => {
    expect(MOCK_BUDGET_CAP).toBe(5);
    const atCap = findMockBudgetViolations([
      source('a.test.ts', `it('at cap', () => { vi.fn(); vi.fn(); vi.fn(); vi.fn(); vi.fn(); });`),
    ]);
    expect(atCap).toEqual([]);
  });
});

describe('formatViolations', () => {
  it('summarises a clean scan', () => {
    expect(formatViolations([], 5)).toContain('Mock budget OK');
  });

  it('names every offending test', () => {
    const report = formatViolations(
      [{ file: 'a.test.ts', line: 4, title: 'too many', count: 7, cap: 5 }],
      5,
    );
    expect(report).toContain('a.test.ts:4');
    expect(report).toContain('7 mocks (cap 5)');
    expect(report).toContain('too many');
  });
});

describe('split downtime-worker suite complies with the mock budget', () => {
  const repoRoot = resolve(process.cwd());
  const srcDir = join(repoRoot, 'packages', 'herdr', 'src');

  // Mirror the checker's default target: downtime-worker*.test.ts.
  const pattern = /^downtime-worker.*\.test\.ts$/;
  const targetFiles = readdirSync(srcDir)
    .filter((name) => pattern.test(name))
    .map((name) => join(srcDir, name));

  it('scans the whole split suite', () => {
    expect(DEFAULT_TARGETS).toContain('packages/herdr/src/downtime-worker*.test.ts');
    expect(targetFiles.length).toBeGreaterThanOrEqual(10);
  });

  it(`has no test above ${MOCK_BUDGET_CAP} vi.fn() calls`, () => {
    const violations = findMockBudgetViolations(
      targetFiles.map((path) => ({ path, source: readFileSync(path, 'utf8') })),
      MOCK_BUDGET_CAP,
    );

    expect(formatViolations(violations, MOCK_BUDGET_CAP)).toBe(
      `Mock budget OK: no test exceeds ${MOCK_BUDGET_CAP} vi.fn() calls.`,
    );
    expect(violations).toEqual([]);
  });
});
