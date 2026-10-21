/**
 * Regression guard: tests must not spawn a hard-coded `dist/cli.js`
 * (WL-0MVII17N3003FJWT).
 *
 * ## Why a guard
 *
 * `dist/` is gitignored and `npm test` does not rebuild it, so a test that
 * spawns `dist/cli.js` asserts against *whatever build happened to be on
 * disk*, not against `src/`. When a checkout's build lags `src/` the test
 * fails for a reason that has nothing to do with the code under test: the
 * `wl completion bash|zsh > contains all known subcommands` cases failed with
 * `expected completion script to contain "worklist"` purely because `dist/`
 * predated the commit that registered `worklist`. A rebuild fixed the
 * checkout and committed nothing, so the false failure returned on the next
 * stale checkout.
 *
 * `tests/cli/cli-bundle.ts` already solves this class of problem — it builds
 * `src/cli.ts` once per test process, so every spawn runs the current source.
 * `tests/unit/no-tsx-cli-spawn.test.ts` guards the *tsx* idiom
 * (WL-0MVF9JJUH0077OB8); this file is the second guard, covering the
 * hard-coded *`dist/`* idiom that the tsx sweep left behind.
 *
 * ## What is checked
 *
 * 1. No test file outside the documented allowlist hard-codes a `dist/cli.js`
 *    path (`'dist/cli.js'`, or `path.join(..., 'dist', 'cli.js')`).
 * 2. The scanner is proven red-first against a fixture tree, so the guard
 *    cannot pass vacuously — `implement.py finish` rebuilds `dist/` before
 *    running tests, which makes the ambient failure unreproducible.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Files allowed to reference a hard-coded `dist/cli.js`, with the reason each
 * one is intentional. Everything else must spawn through
 * `runCliProcess()` / `cliInvocation()` from `tests/cli/cli-bundle.ts`.
 *
 * - `smoke.test.ts` asserts that the *built* artefact loads — that is its
 *   purpose, so it must keep pointing at `dist/`.
 * - `startup-import-budget.test.ts` measures startup cost of the real entries
 *   and writes its own stub `dist/` into a temp fixture.
 * - `startup-target-freshness.test.ts` pins the `isDistFresh()` contract with
 *   temp fixtures whose mtimes it controls; it never spawns this checkout's
 *   build.
 * - `entry-point-split.test.ts` deliberately exercises the built entry point
 *   via the freshness-aware `resolveStartupTarget('auto')` (it resolves the
 *   path through that helper, not literally). Listed so that hard-coding
 *   `dist/` there in future is a reviewed decision, not a silent slip.
 * - `cli-inproc.ts` strips the CLI entry token from command strings for the
 *   in-process runner; it never spawns a subprocess.
 * - `no-stale-dist-spawn.test.ts` is this scanner — its own patterns and
 *   allowlist necessarily contain the tokens it looks for.
 */
const ALLOWLIST = new Map<string, string>([
  [path.join('tests', 'cli', 'smoke.test.ts'), 'asserts the built artefact loads'],
  [
    path.join('tests', 'cli', 'startup-import-budget.test.ts'),
    'measures real entry-point startup; writes stub dist trees into temp fixtures',
  ],
  [
    path.join('tests', 'unit', 'startup-target-freshness.test.ts'),
    'temp fixtures with controlled mtimes for the isDistFresh() contract',
  ],
  [
    path.join('tests', 'cli', 'entry-point-split.test.ts'),
    'intentionally runs the built entry via resolveStartupTarget(auto)',
  ],
  [
    path.join('tests', 'cli', 'cli-inproc.ts'),
    'in-process runner strips the CLI entry token; never spawns',
  ],
  [
    path.join('tests', 'unit', 'no-stale-dist-spawn.test.ts'),
    'this scanner',
  ],
]);

/**
 * The hard-coded `dist/cli.js` idioms:
 *   - a quoted `dist/cli.js` / `dist\\cli.js` path literal
 *   - quoted path segments `'dist', 'cli.js'` (as `path.join`/`path.resolve`)
 */
const DIST_CLI_PATTERNS = [
  /['"]dist[\\/]cli\.js['"]/,
  /['"]dist['"]\s*,\s*['"]cli\.js['"]/,
];

/** Every `.ts` file under `root/tests`, excluding dependency/fixture dirs. */
function testSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      testSourceFiles(full, found);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Repository-relative paths of test files hard-coding `dist/cli.js`. */
function findOffenders(
  root: string,
  allowlist: Map<string, string> = ALLOWLIST,
  testsDir: string = path.join(root, 'tests')
): string[] {
  const offenders: string[] = [];
  for (const file of testSourceFiles(testsDir)) {
    const rel = path.relative(root, file);
    if (allowlist.has(rel)) continue;
    const source = fs.readFileSync(file, 'utf-8');
    if (DIST_CLI_PATTERNS.some((re) => re.test(source))) offenders.push(rel);
  }
  return offenders;
}

/** The failure message: names each offending file and the helper to use. */
function describeOffenders(offenders: string[]): string {
  return (
    'these tests spawn the CLI through a hard-coded dist/cli.js, so they ' +
    'assert against whatever build happens to be on disk instead of current ' +
    'src/ (a stale build produced a false `missing "worklist"` failure):' +
    '\n' +
    offenders.map((f) => `  - ${f}`).join('\n') +
    '\nuse `runCliProcess()` / `cliInvocation()` from tests/cli/cli-bundle.ts ' +
    'instead, or add a documented allowlist entry if the test must observe ' +
    'the real built artefact.'
  );
}

/** Write `content` to `root/relativePath`, creating parent directories. */
function writeFixture(root: string, relativePath: string, content: string): void {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

describe('stale dist spawn regression guard', () => {
  it('flags a fixture that spawns a hard-coded dist/cli.js', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-stale-dist-fixture-'));
    try {
      writeFixture(
        fixture,
        path.join('tests', 'cli', 'spawns-dist.test.ts'),
        "import * as path from 'path';\n" +
          "const cliPath = path.join(__dirname, '..', '..', 'dist', 'cli.js');\n"
      );
      writeFixture(
        fixture,
        path.join('tests', 'cli', 'spawns-dist-literal.test.ts'),
        "const res = spawnSync(process.execPath, ['dist/cli.js', '--version']);\n"
      );
      writeFixture(
        fixture,
        path.join('tests', 'cli', 'uses-bundle.test.ts'),
        "import { runCliProcess } from './cli-bundle.js';\n" +
          "export const run = () => runCliProcess(['--version']);\n"
      );

      const offenders = findOffenders(fixture, new Map());

      expect(offenders).toEqual([
        path.join('tests', 'cli', 'spawns-dist-literal.test.ts'),
        path.join('tests', 'cli', 'spawns-dist.test.ts'),
      ]);
      const message = describeOffenders(offenders);
      expect(message).toContain('spawns-dist.test.ts');
      expect(message).toContain('runCliProcess()');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('does not flag a fixture that spawns through the bundle helper', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-stale-dist-clean-'));
    try {
      writeFixture(
        fixture,
        path.join('tests', 'cli', 'uses-bundle.test.ts'),
        "import { runCliProcess } from './cli-bundle.js';\n" +
          "export const run = () => runCliProcess(['completion', 'bash']);\n"
      );
      expect(findOffenders(fixture, new Map())).toEqual([]);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('has no test file spawning a hard-coded dist/cli.js outside the allowlist', () => {
    const offenders = findOffenders(repoRoot);
    expect(offenders, describeOffenders(offenders)).toEqual([]);
  });
});
