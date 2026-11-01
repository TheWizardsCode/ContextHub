/**
 * Regression tests for the shared hermetic fixture git environment
 * (`fixtureGitEnv` in `./git-helpers.js`, WL-0MVWRR4GD001M9LA).
 *
 * `implement.py finish` validates a would-be-commit tree with a temporary
 * `GIT_INDEX_FILE` exported to the suite while it runs (SA-0MVL2NH1G0094FA2 /
 * SA-0MVQHVGFR006W8LG). A fixture that spawns `git` with a spread of
 * `process.env` inherits that override, so its `git add`/`git commit` stage
 * into the *gate's* index instead of the fixture's own repository: the gate
 * then refuses the run as unattributable ("gate evidence invalid: the
 * temporary index changed while the suite ran") and the fixture itself fails
 * with "invalid object ... / Error building trees". These tests pin the
 * fixture-level guard that makes that leak impossible, independently of the
 * suite-wide scrub in `tests/setup-tests.ts`.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createTempDir, cleanupTempDir } from '../test-utils.js';
import { walkRepoSourceFiles } from '../helpers/repo-file-walk.js';
import { fixtureGitEnv, REPOSITORY_OVERRIDE_ENV_VARS } from './git-helpers.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

describe('fixtureGitEnv', () => {
  it('removes every repository-override variable from the ambient environment', () => {
    const previous: Record<string, string | undefined> = {};
    for (const name of REPOSITORY_OVERRIDE_ENV_VARS) {
      previous[name] = process.env[name];
      process.env[name] = `leaked-${name}`;
    }
    try {
      const env = fixtureGitEnv();
      // (a) a copy of the ambient environment: the rest of it is preserved.
      expect(env.HOME).toBe(process.env.HOME);
      // (b) every repository override is gone, GIT_INDEX_FILE included.
      for (const name of REPOSITORY_OVERRIDE_ENV_VARS) {
        expect(env[name], name).toBeUndefined();
      }
    } finally {
      for (const name of REPOSITORY_OVERRIDE_ENV_VARS) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  });

  it('lets an explicitly supplied override win over the scrub', () => {
    const env = fixtureGitEnv({
      GIT_INDEX_FILE: '/tmp/deliberate-gate.index',
      GIT_DIR: '/tmp/deliberate-gitdir',
    });
    expect(env.GIT_INDEX_FILE).toBe('/tmp/deliberate-gate.index');
    expect(env.GIT_DIR).toBe('/tmp/deliberate-gitdir');
  });

  it('keeps the real git reachable (test mock-bin stripped from ambient PATH)', () => {
    const env = fixtureGitEnv();
    const pathParts = (env.PATH || '').split(path.delimiter);
    expect(pathParts.some((p) => path.resolve(p).endsWith('mock-bin'))).toBe(false);
    // An explicit PATH wins untouched.
    const explicit = fixtureGitEnv({ PATH: '/custom/bin' });
    expect(explicit.PATH).toBe('/custom/bin');
  });
});

describe('inherited GIT_INDEX_FILE leak (WL-0MVWRR4GD001M9LA AC3)', () => {
  it('a fixture git add + commit leaves an inherited GIT_INDEX_FILE byte-identical and commits into its own repository', () => {
    const fixtureDir = createTempDir();
    const leakedDir = createTempDir();
    const leakedIndex = path.join(leakedDir, 'leaked-gate.index');
    const original = Buffer.from('gate-index-before\n');
    fs.writeFileSync(leakedIndex, original);
    const previous = process.env.GIT_INDEX_FILE;
    // Mimic the enclosing finish gate: the suite-wide scrub (setup-tests.ts)
    // ran long ago, and the gate exports its temporary index into this suite.
    process.env.GIT_INDEX_FILE = leakedIndex;
    try {
      const run = (args: string[]) =>
        execFileSync('git', args, { cwd: fixtureDir, encoding: 'utf-8', env: fixtureGitEnv() });
      run(['init', '-q']);
      run(['config', 'user.email', 'test@example.com']);
      run(['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(fixtureDir, 'fixture.txt'), 'fixture\n', 'utf8');
      run(['add', 'fixture.txt']);
      run(['commit', '-m', 'fixture commit']);

      // The gate's index was never written to — exactly the leak the finish
      // gate reported as "gate evidence invalid".
      expect(fs.readFileSync(leakedIndex)).toEqual(original);
      // The fixture repository owns the commit and the staged file.
      expect(run(['log', '--oneline'])).toContain('fixture commit');
      expect(run(['ls-files'])).toContain('fixture.txt');
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previous;
      cleanupTempDir(fixtureDir);
      cleanupTempDir(leakedDir);
    }
  });
});

describe('no non-hermetic fixture git environments (WL-0MVWRR4GD001M9LA AC2)', () => {
  it('every git-spawning fixture goes through fixtureGitEnv — no local realGitEnv or inline process.env spread remains', () => {
    // The two files that legitimately name the pattern:
    const self = path.join(__dirname, 'fixture-git-env.test.ts');
    const helper = path.join(__dirname, 'git-helpers.ts');
    // The forbidden non-hermetic patterns: a local realGitEnv-style helper
    // (whatever its name) and the inline `{ ...process.env, PATH: realGitPath() }`
    // spread handed straight to a spawn.
    const forbidden = [
      /\brealGitEnv\s*\(/,
      /\{\s*\.\.\.process\.env\s*,\s*PATH\s*:\s*realGitPath\(\)\s*\}/,
    ];
    const violations: string[] = [];
    walkRepoSourceFiles(path.join(__dirname, '..'), (filePath, content) => {
      if (filePath === self || filePath === helper) return;
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (forbidden.some((re) => re.test(line))) {
          violations.push(`${path.relative(__dirname, filePath)}:${i + 1}: ${line.trim()}`);
        }
      });
    });
    expect(violations).toEqual([]);
  });
});
