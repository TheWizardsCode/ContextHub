#!/usr/bin/env node
/**
 * scripts/check-mock-budget.ts — enforce a per-test mock budget
 * (WL-0MV4VSNI00002WFM, child of WL-0MV28X3SL005R5KX).
 *
 * The downtime-worker test suite was split out of the 13k-line
 * `downtime-worker.test.ts`, which carried 664 `vi.fn()` calls. Splitting the
 * file alone does not stop mock density creeping back up, so this checker
 * parses every targeted `*.test.ts` file with the TypeScript compiler API and
 * counts the `vi.fn()` calls lexically inside each `it()` / `test()` block.
 * Any test above {@link MOCK_BUDGET_CAP} fails the check.
 *
 * The shared `makeDeps()` fixture (see `downtime-worker.fixtures.ts`) creates
 * ~20 default mocks per call; those live in the fixture module, not in a test
 * block, so they are deliberately outside the budget — the budget bounds the
 * *per-test overrides* a reader has to hold in their head.
 *
 * Usage:
 *   npm run test:mock-budget            # default targets, exit 1 on violation
 *   npx tsx scripts/check-mock-budget.ts --json
 *   npx tsx scripts/check-mock-budget.ts --cap 6 packages/herdr/src
 *
 * Default targets: every `packages/herdr/src/downtime-worker*.test.ts` file.
 * Any file/directory/glob passed on the command line replaces the defaults.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

/** Maximum number of `vi.fn()` overrides allowed inside a single test block. */
export const MOCK_BUDGET_CAP = 5;

/** Default target directories/globs, relative to the repository root. */
export const DEFAULT_TARGETS = ['packages/herdr/src/downtime-worker*.test.ts'];

/** Names on the `it`/`test` call stem that introduce a test runnable. */
const TEST_STEM_NAMES = new Set([
  'it',
  'test',
]);

/** A single test block and its mock count. */
export interface TestMockCount {
  /** Repository-relative path of the file containing the test. */
  file: string;
  /** 1-based line of the test call. */
  line: number;
  /** The test title, or `<dynamic>` when it is not a static string. */
  title: string;
  /** Number of `vi.fn()` calls lexically inside the test callback. */
  count: number;
}

/** A test block whose mock count exceeds the budget. */
export interface MockBudgetViolation extends TestMockCount {
  /** The cap the test exceeded. */
  cap: number;
}

/** A file to scan, decoupled from disk so the checker is unit-testable. */
export interface SourceFile {
  /** Path reported on violations (ideally repository-relative). */
  path: string;
  /** Full source text. */
  source: string;
}

function isFunctionLike(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** `it`/`test` or a modifier on that stem (`.only`, `.each`, `.concurrent`, …). */
function isTestCallee(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr) && TEST_STEM_NAMES.has(expr.text)) return true;
  // `it.each([...])(...)` — the callback lives on the outer call whose callee
  // is a call on the `it`/`test` stem; treat that outer call as the test.
  if (ts.isCallExpression(expr) && isTestCallee(expr.expression)) return true;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    TEST_STEM_NAMES.has(expr.expression.text)
  ) {
    return true;
  }
  return false;
}

/** True for a `vi.fn()` call expression. */
function isViFnCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'vi' &&
    node.expression.name.text === 'fn'
  );
}

/**
 * Count `vi.fn()` calls lexically inside a test callback body. Nested test
 * blocks are not descended into — each test owns its own budget.
 */
function countViFnCalls(body: ts.ConciseBody): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (isViFnCall(node)) count += 1;
    // A nested `it`/`test` is a separate test; its mocks belong to it.
    if (ts.isCallExpression(node) && isTestCallee(node.expression)) return;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return count;
}

function staticTitle(arg: ts.Expression | undefined): string {
  if (!arg) return '<dynamic>';
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return '<dynamic>';
}

function findTestCallback(
  args: readonly ts.Expression[],
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  // Direct form: `it('name', fn)`. `.each` form: `it.each(t)('name', fn)` has
  // the callback in the same (only) argument list of the outer call.
  return args.find(isFunctionLike);
}

/**
 * Parse one source file and return every `it()`/`test()` block with the
 * number of `vi.fn()` calls inside it.
 */
export function countMocksPerTest(source: string, filePath = 'test.ts'): TestMockCount[] {
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind,
  );

  const results: TestMockCount[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCallee(node.expression)) {
      const callback = findTestCallback(node.arguments);
      if (callback) {
        results.push({
          file: filePath,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          title: staticTitle(node.arguments[0]),
          count: countViFnCalls(callback.body),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

/** Return only the tests whose mock count exceeds `cap`, sorted by count desc. */
export function findMockBudgetViolations(
  files: readonly SourceFile[],
  cap: number = MOCK_BUDGET_CAP,
): MockBudgetViolation[] {
  const violations: MockBudgetViolation[] = [];
  for (const file of files) {
    for (const test of countMocksPerTest(file.source, file.path)) {
      if (test.count > cap) violations.push({ ...test, cap });
    }
  }
  return violations.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

/** Human-readable report for the CLI. */
export function formatViolations(
  violations: readonly MockBudgetViolation[],
  cap: number = MOCK_BUDGET_CAP,
): string {
  if (violations.length === 0) {
    return `Mock budget OK: no test exceeds ${cap} vi.fn() calls.`;
  }
  const lines = [
    `Mock budget exceeded: ${violations.length} test block(s) over the cap of ${cap} vi.fn() calls.`,
    'Extract shared setup into a fixture/helper instead of stacking per-test mocks.',
    '',
  ];
  for (const v of violations) {
    lines.push(`  ${v.file}:${v.line} — ${v.count} mocks (cap ${v.cap}) — ${v.title}`);
  }
  return lines.join('\n');
}

function expandTargets(targets: readonly string[], cwd: string): string[] {
  const files = new Set<string>();
  for (const target of targets) {
    if (target.includes('*')) {
      const dir = dirname(target);
      const pattern = basename(target);
      const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
      const absDir = resolve(cwd, dir);
      let entries: string[] = [];
      try {
        entries = readdirSync(absDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (regex.test(entry)) files.add(join(absDir, entry));
      }
      continue;
    }
    const abs = resolve(cwd, target);
    try {
      if (statSync(abs).isDirectory()) {
        for (const entry of readdirSync(abs)) {
          if (entry.endsWith('.test.ts')) files.add(join(abs, entry));
        }
      } else {
        files.add(abs);
      }
    } catch {
      // Unresolvable target — ignored; run from the repository root.
    }
  }
  return [...files].sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CliOptions {
  cap: number;
  json: boolean;
  targets: string[];
}

function parseArgs(argv: readonly string[]): CliOptions {
  let cap = MOCK_BUDGET_CAP;
  let json = false;
  const targets: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--cap') {
      cap = Number(argv[++i]);
    } else if (arg.startsWith('--cap=')) {
      cap = Number(arg.slice('--cap='.length));
    } else {
      targets.push(arg);
    }
  }
  return { cap, json, targets: targets.length > 0 ? targets : [...DEFAULT_TARGETS] };
}

function main(argv: readonly string[]): number {
  const { cap, json, targets } = parseArgs(argv);
  const cwd = process.cwd();
  const files: SourceFile[] = expandTargets(targets, cwd).map((path) => ({
    path: relative(cwd, path) || path,
    source: readFileSync(path, 'utf8'),
  }));

  const violations = findMockBudgetViolations(files, cap);
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          success: violations.length === 0,
          cap,
          scanned: files.length,
          violations,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${formatViolations(violations, cap)}\n`);
  }
  return violations.length === 0 ? 0 : 1;
}

// Only run the CLI when executed directly (import.meta is available under
// tsx/ESM); importing this module for unit tests must not execute the check.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-mock-budget failed: ${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
