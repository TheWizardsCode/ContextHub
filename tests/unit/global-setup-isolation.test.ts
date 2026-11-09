import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Global test setup isolation (WL-0MW3JIYIR002RCP8).
 *
 * `tests/setup-tests.ts` is evaluated once per vitest worker *before* the test
 * file. Any module it reaches is therefore in the registry when that file's
 * hoisted `vi.mock(...)` registrations apply, so a module under test loaded
 * through the setup keeps its REAL binding while the test asserts on the mock.
 *
 * That is exactly how `tests/github-sync/comments-module.test.ts` flaked: the
 * setup's lazy `import('./cli/cli-helpers.js')` reached `src/jsonl.ts` →
 * `src/github.ts`, the real `createGithubIssueCommentAsync` ran (through the
 * `tests/cli/mock-bin/gh` stub, so it resolved instead of throwing), and the
 * mock assertions saw 0 calls — but only when the setup's floating import won
 * the race, i.e. intermittently in full-suite runs.
 *
 * The setup must stay a leaf of the harness graph: env scrubbing, the
 * `child_process` mocks and PATH setup only. Shutdown cleanup belongs to
 * `tests/cli/cli-helpers.ts`, which installs it at module load and is the only
 * module that tracks PIDs.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const SETUP_PATH = path.join(repoRoot, 'tests', 'setup-tests.ts');

/** Application and CLI-helper prefixes the setup must never reach. */
const FORBIDDEN_PREFIXES = ['../src/', './cli/', './test-utils.js'];

/** Every static and dynamic import specifier in a TS source text. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripComments(source))) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Drop `//` line and block comments so a comment that *mentions* an import (as
 * the setup file's root-cause note does) is not mistaken for one.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('global test setup isolation', () => {
  it('imports no application or CLI-helper modules', () => {
    const specifiers = importSpecifiers(fs.readFileSync(SETUP_PATH, 'utf8'));
    const offenders = specifiers.filter((specifier) =>
      FORBIDDEN_PREFIXES.some((prefix) => specifier.startsWith(prefix))
    );

    expect(
      offenders,
      `tests/setup-tests.ts must not import application/CLI modules — they are ` +
        `loaded before a test file's vi.mock() registrations and leave the ` +
        `module under test bound to the real implementation ` +
        `(WL-0MW3JIYIR002RCP8). Move the dependency into the test that needs ` +
        `it. Offending specifier(s): ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('leaves shutdown cleanup to cli-helpers, which installs the handlers itself', async () => {
    const before = process.listeners('SIGTERM').length;

    await import('../cli/cli-helpers.js');

    expect(process.listeners('SIGTERM').length).toBe(before + 1);
  });
});
