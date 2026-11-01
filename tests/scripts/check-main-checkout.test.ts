/**
 * scripts/check-main-checkout.sh regression tests (WL-0MVWK20DK004TQZM AC2).
 *
 * A worktree-scoped agent run deleted every tracked file under
 * packages/shared/ from the MAIN checkout (2026-10-31 recurrence), breaking
 * `wl` machine-wide; the overlapping finish run's guard never verified
 * (`verifies: []` — it aborted at the test gate), so nothing reported the
 * deletions. This check must fail loudly and independently of implement.py
 * finish:
 *
 *   - clean main checkout  → exit 0
 *   - tracked deletion     → exit 1, every deleted path named
 *   - invoked from a linked worktree → still guards the MAIN checkout
 *   - untracked files are ignored (only tracked deletions count)
 *   - --work-item reports through a (stubbed) `wl comment add` so the report
 *     survives an aborted finish run — and the check still fails when `wl`
 *     itself is broken (the wipe's own symptom).
 *
 * Fixtures run on REAL git (the test-suite mock in tests/cli/mock-bin does
 * not implement `status`/`worktree list --porcelain`); each repo is a temp
 * dir with a pinned HOME, fully hermetic.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_TEST_TIMEOUT_MS = 60_000;

function itScript(name: string, fn: () => void): void {
  it(name, fn, SCRIPT_TEST_TIMEOUT_MS);
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * The vitest setup (tests/setup-tests.ts) prepends tests/cli/mock-bin to
 * PATH, whose git mock does NOT implement `status` or `worktree list
 * --porcelain`. These tests need real git mechanics, so resolve the real git
 * binary by searching PATH with the mock-bin entries removed (same pattern as
 * tests/scripts/install-herdr.test.ts).
 */
function realGitBin(): string {
  const mockBinDir = path.resolve(__dirname, '..', 'cli', 'mock-bin');
  const candidates = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '' && path.resolve(dir) !== mockBinDir);
  for (const dir of candidates) {
    const candidate = path.join(dir, 'git');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('real git binary not found on PATH (needed for main-checkout script tests)');
}

/** Run `git` with a pinned HOME in the fixture repo, asserting success. */
function git(gitBin: string, args: string[], cwd: string, tempHome: string) {
  const result = spawnSync(gitBin, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: tempHome },
  });
  expect(result.status, `git ${args.join(' ')} failed: ${result.stderr}`).toBe(0);
  return result;
}

interface Fixture {
  repoDir: string;
  home: string;
  gitBin: string;
}

/**
 * A minimal worklog-layout git repo (scripts/ + packages/shared tracked)
 * with the check script copied in, ready to be mutated per test.
 */
function makeRepoFixture(scriptName: 'check-main-checkout.sh'): Fixture {
  const tempBase = makeTempDir('wl-check-main-checkout-');
  const repoDir = path.join(tempBase, 'repo');
  const home = path.join(tempBase, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'packages', 'shared', 'src'), { recursive: true });

  const repoRoot = path.resolve(__dirname, '..', '..');
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', scriptName),
    path.join(repoDir, 'scripts', scriptName),
  );
  fs.writeFileSync(
    path.join(repoDir, 'packages', 'shared', 'package.json'),
    JSON.stringify({ name: '@worklog/shared', version: '1.0.0' }),
  );
  fs.writeFileSync(
    path.join(repoDir, 'packages', 'shared', 'src', 'worklog-paths.ts'),
    'export const pathsMarker = "tracked";\n',
  );

  const gitBin = realGitBin();
  git(gitBin, ['init', '-q', repoDir], tempBase, home);
  git(gitBin, ['-C', repoDir, 'config', 'user.email', 'test@example.com'], tempBase, home);
  git(gitBin, ['-C', repoDir, 'config', 'user.name', 'Worklog Test'], tempBase, home);
  git(gitBin, ['-C', repoDir, 'add', '-A'], tempBase, home);
  git(gitBin, ['-C', repoDir, 'commit', '-q', '-m', 'init'], tempBase, home);
  return { repoDir, home, gitBin };
}

/** PATH with real git first, the test-suite git mock excluded. */
function scriptPath(extraDirs: string[], gitBin: string): string {
  const mockBinDir = path.resolve(__dirname, '..', 'cli', 'mock-bin');
  const cleanPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '' && path.resolve(dir) !== mockBinDir);
  return [...extraDirs, path.dirname(gitBin), ...cleanPath].join(path.delimiter);
}

function runScript(
  scriptPathAbs: string,
  cwd: string,
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [scriptPathAbs, '--json'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: SCRIPT_TEST_TIMEOUT_MS,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('check-main-checkout script', () => {
  itScript('passes (exit 0) on a clean main checkout', () => {
    const f = makeRepoFixture('check-main-checkout.sh');
    const result = runScript(
      path.join(f.repoDir, 'scripts', 'check-main-checkout.sh'),
      f.repoDir,
      { HOME: f.home, PATH: scriptPath([], f.gitBin) },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"clean": true');
    expect(result.stdout).toContain(f.repoDir);
  });

  itScript('fails (exit 1) naming every deleted tracked path', () => {
    const f = makeRepoFixture('check-main-checkout.sh');
    // A concurrent actor deletes a tracked file under packages/shared.
    fs.rmSync(path.join(f.repoDir, 'packages', 'shared', 'src', 'worklog-paths.ts'));

    const result = runScript(
      path.join(f.repoDir, 'scripts', 'check-main-checkout.sh'),
      f.repoDir,
      { HOME: f.home, PATH: scriptPath([], f.gitBin) },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"clean": false');
    // Every deleted path is named, exactly once, machine-readable.
    expect(result.stdout).toContain('packages/shared/src/worklog-paths.ts');
    const parsed = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}');
    expect(parsed.deletions).toContain('packages/shared/src/worklog-paths.ts');
    // The report also names the one-step recovery path.
    expect(result.stderr).toContain('repair-shared-package.sh');
  });

  itScript('guards the MAIN checkout even when invoked from a linked worktree', () => {
    // 2026-10-31 shape: the deletion landed in the main checkout while the
    // overlapping run was in the worktree. The check must report the MAIN
    // checkout's deletion, never be confused by where it is invoked from.
    const f = makeRepoFixture('check-main-checkout.sh');
    const wtDir = path.join(f.home, '..', 'worktree');
    git(f.gitBin, ['-C', f.repoDir, 'worktree', 'add', '--detach', wtDir, 'HEAD'], f.home, f.home);

    // The main checkout's packages/shared sources are wiped.
    fs.rmSync(path.join(f.repoDir, 'packages', 'shared', 'src', 'worklog-paths.ts'));

    const result = runScript(
      path.join(wtDir, 'scripts', 'check-main-checkout.sh'),
      wtDir,
      { HOME: f.home, PATH: scriptPath([], f.gitBin) },
    );
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}');
    expect(parsed.checkout).toBe(f.repoDir); // the MAIN checkout, not the worktree
    expect(parsed.deletions).toContain('packages/shared/src/worklog-paths.ts');
  });

  itScript('ignores untracked files — only tracked deletions fail the check', () => {
    const f = makeRepoFixture('check-main-checkout.sh');
    fs.writeFileSync(path.join(f.repoDir, 'scratch.txt'), 'untracked\n');

    const result = runScript(
      path.join(f.repoDir, 'scripts', 'check-main-checkout.sh'),
      f.repoDir,
      { HOME: f.home, PATH: scriptPath([], f.gitBin) },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"clean": true');
  });

  itScript('reports through `wl comment add` (survives an aborted finish run) and still fails when wl is broken', () => {
    const f = makeRepoFixture('check-main-checkout.sh');
    fs.rmSync(path.join(f.repoDir, 'packages', 'shared', 'src', 'worklog-paths.ts'));

    // A fake wl that records its invocation (hermetic, no real worklog store)
    // — proves the report is posted to a work item.
    const binDir = path.join(f.home, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const wlLog = path.join(f.home, 'wl.log');
    fs.writeFileSync(
      path.join(binDir, 'wl'),
      `#!/usr/bin/env bash\necho "$@" >> "${wlLog}"\nexit 0\n`,
    );
    fs.chmodSync(path.join(binDir, 'wl'), 0o755);

    const result = runScript(
      path.join(f.repoDir, 'scripts', 'check-main-checkout.sh'),
      f.repoDir,
      {
        HOME: f.home,
        PATH: scriptPath([binDir], f.gitBin),
        CHECK_MAIN_CHECKOUT_WORK_ITEM: 'WL-0MVWK20DK004TQZM',
      },
    );
    expect(result.status).toBe(1); // the deletion still fails the check
    const log = fs.readFileSync(wlLog, 'utf8');
    expect(log).toContain('comment add');
    expect(log).toContain('WL-0MVWK20DK004TQZM');
    expect(log).toContain('packages/shared/src/worklog-paths.ts');

    // When `wl` itself is broken (the wipe's own symptom: the CLI cannot
    // start), the check must still exit non-zero — never silently pass.
    fs.rmSync(path.join(binDir, 'wl'));
    fs.writeFileSync(
      path.join(binDir, 'wl'),
      '#!/usr/bin/env bash\necho "wl: cannot start — the shared workspace build output is missing." >&2\nexit 1\n',
    );
    fs.chmodSync(path.join(binDir, 'wl'), 0o755);
    const broken = runScript(
      path.join(f.repoDir, 'scripts', 'check-main-checkout.sh'),
      f.repoDir,
      {
        HOME: f.home,
        PATH: scriptPath([binDir], f.gitBin),
        CHECK_MAIN_CHECKOUT_WORK_ITEM: 'WL-0MVWK20DK004TQZM',
      },
    );
    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain('"clean": false');
  });
});
