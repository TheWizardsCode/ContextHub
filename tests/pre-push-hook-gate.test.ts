/**
 * Regression tests for the dev/main full-suite gate in `.githooks/pre-push`
 * (WL-0MVHP5S01006GDDV).
 *
 * The tests execute the committed hook in a throwaway git repo with a stubbed
 * `run_tests.py`, asserting that:
 *  - the runner is invoked with the canonical flags on `refs/heads/dev` and
 *    `refs/heads/main` pushes;
 *  - a non-zero runner exit blocks the push;
 *  - `TEST_SCOPE_SKIP=1` bypasses the gate;
 *  - feature-branch, tag and `refs/worklog/data` pushes run no tests;
 *  - a missing runner hard-fails rather than silently skipping;
 *  - the gate runs even when the worklog-sync bypass is set (the stdin is read
 *    once, before the sync section).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';

const HOOK_PATH = path.join(process.cwd(), '.githooks', 'pre-push');
const MOCK_BIN = path.resolve(process.cwd(), 'tests', 'cli', 'mock-bin');

/**
 * PATH with the suite's mock `git` removed. `tests/setup-tests.ts` prepends
 * `tests/cli/mock-bin` to PATH for every test file; this fixture deliberately
 * uses real git so branch-policy and worktree detection behave as in a push.
 */
function realGitPath(): string {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter((entry) => entry && path.resolve(entry) !== MOCK_BIN)
    .join(path.delimiter);
}

/** Stub runner: records its argv and exits with `STUB_TEST_EXIT` (default 0). */
const STUB_RUNNER = `import os
import sys

log = os.environ.get("STUB_TEST_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(" ".join(sys.argv[1:]) + "\\n")
sys.exit(int(os.environ.get("STUB_TEST_EXIT", "0")))
`;

const trackedDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of trackedDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Drop repository-override `GIT_*` variables inherited from a test sandbox so
 * the throwaway repo's `git` invocations (and the hook's) resolve to it.
 */
function cleanGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Use real git rather than the suite-wide mock (see `realGitPath`).
    PATH: realGitPath(),
    ...extra,
  };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) {
    delete env[key];
  }
  return env;
}

function git(cwd: string, args: string[]): void {
  const result = childProcess.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${result.stderr ?? ''}`,
    );
  }
}

interface HookRepo {
  dir: string;
  logFile: string;
}

/**
 * Create a throwaway git repo on branch `dev` wired with a stubbed
 * `skill/test/scripts/run_tests.py` (the hook's local resolution path).
 * `dev` is not a protected branch, so branch policy lets every test push.
 */
function createHookRepo(options: { withRunner?: boolean } = {}): HookRepo {
  const dir = makeTempDir('prepush-repo-');
  const logFile = path.join(dir, 'runner-invocations.log');

  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Pre-push Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  git(dir, ['branch', '-M', 'dev']);

  if (options.withRunner !== false) {
    const runnerDir = path.join(dir, 'skill', 'test', 'scripts');
    fs.mkdirSync(runnerDir, { recursive: true });
    fs.writeFileSync(path.join(runnerDir, 'run_tests.py'), STUB_RUNNER);
  }

  return { dir, logFile };
}

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
  invocations: string[];
}

/**
 * Run the committed hook in `repo.dir`, feeding `remoteRef` as the pushed ref
 * on stdin. `HOME` is isolated to a fresh temp dir so the repo-local stub is
 * the resolved runner and the host's installed skills never leak in.
 */
function runHook(
  repo: HookRepo,
  remoteRef: string,
  overrides: NodeJS.ProcessEnv = {},
): HookResult {
  const stdin = `refs/heads/local abc123 ${remoteRef} def456\n`;
  const home = makeTempDir('prepush-home-');

  const result = childProcess.spawnSync('sh', [HOOK_PATH], {
    cwd: repo.dir,
    input: stdin,
    encoding: 'utf8',
    env: cleanGitEnv({
      HOME: home,
      // Keep unrelated host checks out of the way.
      CONTEXT_BUDGET_SKIP: '1',
      // The sync section runs after the gate; skip it.
      WORKLOG_SKIP_PRE_PUSH: '1',
      STUB_TEST_LOG: repo.logFile,
      ...overrides,
    }),
  });

  const invocations = fs.existsSync(repo.logFile)
    ? fs.readFileSync(repo.logFile, 'utf8').split('\n').filter(Boolean)
    : [];

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    invocations,
  };
}

describe.skipIf(process.platform === 'win32')(
  'pre-push full-suite gate (WL-0MVHP5S01006GDDV)',
  () => {
    it('runs the full canonical runner on a refs/heads/dev push', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/dev');

      expect(result.status).toBe(0);
      expect(result.invocations).toEqual(['--scope full --strict-git-env']);
      expect(result.stderr).toContain('push gate');
    });

    it('runs the full canonical runner on a refs/heads/main push', () => {
      const repo = createHookRepo();
      // The current branch is `dev`, so branch policy allows the push to main.
      const result = runHook(repo, 'refs/heads/main');

      expect(result.status).toBe(0);
      expect(result.invocations).toEqual(['--scope full --strict-git-env']);
    });

    it('blocks the push when the suite fails', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/dev', { STUB_TEST_EXIT: '1' });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('blocked');
      expect(result.invocations).toHaveLength(1);
    });

    it('TEST_SCOPE_SKIP=1 bypasses the gate', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/dev', {
        STUB_TEST_EXIT: '1',
        TEST_SCOPE_SKIP: '1',
      });

      expect(result.status).toBe(0);
      expect(result.invocations).toHaveLength(0);
    });

    it('runs the gate before the worklog-sync bypass (stdin read once)', () => {
      // WORKLOG_SKIP_PRE_PUSH only disables the sync section; the gate still
      // runs for a dev push because stdin is parsed before that early exit.
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/dev', {
        WORKLOG_SKIP_PRE_PUSH: '1',
      });

      expect(result.status).toBe(0);
      expect(result.invocations).toEqual(['--scope full --strict-git-env']);
    });

    it('does not run the runner for a feature-branch push', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/wl-abc-desc', {
        STUB_TEST_EXIT: '1',
      });

      expect(result.status).toBe(0);
      expect(result.invocations).toHaveLength(0);
    });

    it('does not run the runner for a tag push', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/tags/v1.0.0', {
        STUB_TEST_EXIT: '1',
      });

      expect(result.status).toBe(0);
      expect(result.invocations).toHaveLength(0);
    });

    it('does not run the runner for a refs/worklog/data push', () => {
      const repo = createHookRepo();
      // Leave the sync bypass unset so the worklog-data skip path is exercised.
      const result = runHook(repo, 'refs/worklog/data', {
        STUB_TEST_EXIT: '1',
        WORKLOG_SKIP_PRE_PUSH: '',
      });

      expect(result.status).toBe(0);
      expect(result.invocations).toHaveLength(0);
    });

    it('hard-fails when run_tests.py cannot be found', () => {
      const repo = createHookRepo({ withRunner: false });
      const result = runHook(repo, 'refs/heads/dev');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('run_tests.py not found');
      expect(result.invocations).toHaveLength(0);
    });
  },
);

describe('pre-push gate documentation (WL-0MVHP5S01006GDDV)', () => {
  it('documents the bypass and no longer claims the hook skips the suite', () => {
    const doc = fs.readFileSync(
      path.join(process.cwd(), 'docs', 'dev', 'test-suite-baseline.md'),
      'utf8',
    );
    expect(doc).not.toContain('does not run the test suite today');
    expect(doc).toContain('TEST_SCOPE_SKIP=1');
    expect(doc).toContain('refs/heads/dev');
  });

  it('documents the bypass and marker in the committed hook header', () => {
    const hook = fs.readFileSync(HOOK_PATH, 'utf8');
    expect(hook).toContain('worklog:pre-push-hook:v3');
    expect(hook).toContain('Set TEST_SCOPE_SKIP=1');
  });
});
