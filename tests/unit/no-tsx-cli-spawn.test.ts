/**
 * Regression guard: tests must not reintroduce the `tsx src/cli.ts` subprocess
 * spawn pattern (WL-0MVF9JJUH0077OB8).
 *
 * ## Why a guard
 *
 * Spawning `tsx src/cli.ts` re-transpiles the whole `src/` import graph on
 * every process start: measured 2.5–8 s per spawn (2.81 s idle, ~8 s at load
 * average 10) versus 1.1–1.6 s for the pre-compiled bundle from
 * `tests/cli/cli-bundle.ts`. The CLI suite performs ~150 spawns, so one test
 * reintroducing the raw tsx idiom quietly adds whole minutes to every gate run
 * — and it scales with host load, which is what made the suite both slow and
 * flaky (a loaded run timed out at 60 s in `read-cache-e2e` before the bundle
 * landed).
 *
 * ## What is checked
 *
 * 1. The bundle builder works in this environment (`isBundled()`), so the fast
 *    path is actually in use rather than silently falling back to tsx.
 * 2. No test file outside the allowlist both resolves the tsx binary *and*
 *    references the CLI entry — i.e. spawns the CLI through tsx instead of
 *    the bundle.
 *
 * `execAsync`/`execWithInput` from `tests/cli/cli-helpers.ts` are not flagged:
 * they run the CLI in-process or rewrite the `tsx <cli>` prefix to the bundle
 * automatically, so `tsx ${cliPath}` in a command *string* is fine.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isBundled } from '../cli/cli-bundle.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testsRoot = path.join(repoRoot, 'tests');

/**
 * Files allowed to reference both the tsx binary and the CLI entry.
 *
 * - `test-utils.ts` defines `resolveTsxBin()`.
 * - `cli-bundle.ts` is the fallback path of the bundle helper itself.
 * - `no-tsx-cli-spawn.test.ts` is this scanner; its own source necessarily
 *   contains the two tokens it looks for.
 */
const ALLOWLIST = new Set([
  path.join('tests', 'test-utils.ts'),
  path.join('tests', 'cli', 'cli-bundle.ts'),
  path.join('tests', 'unit', 'no-tsx-cli-spawn.test.ts'),
]);

/** Every `.ts` file under `tests/`, excluding dependency directories. */
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

describe('CLI spawn regression guard', () => {
  it('uses the pre-compiled CLI bundle rather than spawning tsx', () => {
    expect(
      isBundled(),
      'the CLI bundle (tests/cli/cli-bundle.ts) failed to build, so every ' +
        'subprocess-spawning test has fallen back to the slow tsx path'
    ).toBe(true);
  });

  it('has no test file spawning the CLI through tsx outside the allowlist', () => {
    const offenders: string[] = [];
    for (const file of testSourceFiles(testsRoot)) {
      const rel = path.relative(repoRoot, file);
      if (ALLOWLIST.has(rel)) continue;
      const source = fs.readFileSync(file, 'utf-8');
      const resolvesTsx = source.includes('resolveTsxBin(');
      const referencesCliEntry = source.includes('cliPath') || source.includes("'src', 'cli.ts'");
      if (resolvesTsx && referencesCliEntry) offenders.push(rel);
    }

    expect(
      offenders,
      'these tests spawn the CLI through tsx again — use `runCliProcess()` / ' +
        '`cliInvocation()` from tests/cli/cli-bundle.ts instead (same command ' +
        'graph, ~5x cheaper per spawn), or add a documented allowlist entry if ' +
        'the test must observe the real tsx entry point:\n' +
        offenders.map((f) => `  - ${f}`).join('\n')
    ).toEqual([]);
  });
});
