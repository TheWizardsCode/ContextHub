/**
 * Regression tests for the dev/main full-suite gate in `.githooks/pre-push`
 * (WL-0MVHP5S01006GDDV).
 *
 * The tests execute the committed hook in a throwaway git repo with a stubbed
 * `run_tests.py`, asserting that:
 *  - the runner is invoked with the canonical flags (`--scope full
 *    --strict-git-env --project-root <pushed tree> --json`) on
 *    `refs/heads/dev` and `refs/heads/main` pushes;
 *  - a non-zero runner exit blocks the push and its output is tailed;
 *  - `TEST_SCOPE_SKIP=1` bypasses the gate;
 *  - feature-branch, tag and `refs/worklog/data` pushes run no tests;
 *  - a ref deletion (all-zero local sha) runs no tests;
 *  - a missing runner hard-fails rather than silently skipping;
 *  - the gate runs even when the worklog-sync bypass is set (the stdin is read
 *    once, before the sync section);
 *  - the checked-out HEAD is compared with the pushed dev/main sha and a
 *    mismatch is warned about;
 *  - a worktree gate run's cache entry is mirrored into the main checkout
 *    (SA-0MVTFMB7K002Y1F3).
 *
 * The backported behaviours (`--project-root`, HEAD-vs-pushed-SHA warning,
 * deletion guard, failure log + tail, `mirrored gate cache entry` wording) come
 * from RISE-0MVSS1KVV002TJUL via WL-0MW2N56M2004PSRP: the embedded template now
 * reproduces `tce-the-rising`'s committed hook byte-for-byte, so
 * `wl doctor upgrade` no longer downgrades it.
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
marker = os.environ.get("STUB_STDOUT_MARKER")
if marker:
    print(marker)
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

function git(cwd: string, args: string[]): string {
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
  return (result.stdout ?? '').trim();
}

interface HookRepo {
  dir: string;
  logFile: string;
  /** Directory the hook is executed from (a linked worktree when set). */
  cwd?: string;
  /** The repository's checked-out HEAD sha. */
  head: string;
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

  return { dir, logFile, head: git(dir, ['rev-parse', 'HEAD']) };
}

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
  invocations: string[];
}

/**
 * Run the committed hook in `repo.dir`, feeding `remoteRef` as the pushed ref
 * on stdin. `localSha` defaults to the repository's HEAD (so the hook's
 * HEAD-vs-pushed-ref check stays quiet unless a test asks otherwise).
 *
 * `HOME` is isolated to a fresh temp dir so the repo-local stub is the
 * resolved runner and the host's installed skills never leak in.
 */
function runHook(
  repo: HookRepo,
  remoteRef: string,
  overrides: NodeJS.ProcessEnv = {},
  localSha?: string,
): HookResult {
  const stdin = `refs/heads/local ${localSha ?? repo.head} ${remoteRef} def456\n`;
  const home = makeTempDir('prepush-home-');

  const result = childProcess.spawnSync('sh', [HOOK_PATH], {
    cwd: repo.cwd ?? repo.dir,
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

const ALL_ZERO = '0'.repeat(40);

describe.skipIf(process.platform === 'win32')(
  'pre-push full-suite gate (WL-0MVHP5S01006GDDV)',
  () => {
    it('runs the full canonical runner on a refs/heads/dev push', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/dev');

      expect(result.status).toBe(0);
      expect(result.invocations).toEqual([
        `--scope full --strict-git-env --project-root ${repo.dir} --json`,
      ]);
      expect(result.stderr).toContain('full-suite gate for a dev/main push');
    });

    it('runs the full canonical runner on a refs/heads/main push', () => {
      const repo = createHookRepo();
      // The current branch is `dev`, so branch policy allows the push to main.
      const result = runHook(repo, 'refs/heads/main');

      expect(result.status).toBe(0);
      expect(result.invocations).toHaveLength(1);
      expect(result.invocations[0]).toContain('--scope full');
    });

    it('pins the project root to the pushed tree (--project-root)', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/dev');

      expect(result.status).toBe(0);
      expect(result.invocations[0]).toContain(`--project-root ${repo.dir}`);
    });

    it('blocks the push when the suite fails', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/dev', { STUB_TEST_EXIT: '1' });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Full test suite failed');
      expect(result.stderr).toContain('TEST_SCOPE_SKIP=1');
      expect(result.invocations).toHaveLength(1);
    });

    it('tails the captured runner output when the suite fails', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/dev', {
        STUB_TEST_EXIT: '1',
        STUB_STDOUT_MARKER: 'FAIL src/broken.test.ts > adds up',
      });

      expect(result.status).not.toBe(0);
      // The run is captured to a log file and its tail is surfaced on stderr.
      expect(result.stderr).toContain('--- run_tests.py output (tail) ---');
      expect(result.stderr).toContain('FAIL src/broken.test.ts > adds up');
      // The runner's raw output is not streamed directly to stdout.
      expect(result.stdout).not.toContain('FAIL src/broken.test.ts');
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
      expect(result.invocations).toHaveLength(1);
      expect(result.invocations[0]).toContain('--scope full');
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

    it('does not run the runner for a dev ref deletion (all-zero local sha)', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/dev', {}, ALL_ZERO);

      expect(result.status).toBe(0);
      expect(result.invocations).toHaveLength(0);
    });

    it('warns when the checked-out HEAD is not the pushed dev/main ref', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/dev', {}, 'a'.repeat(40));

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('is not the ref being pushed to dev/main');
      // The gate still runs: it describes the checked-out tree.
      expect(result.invocations).toHaveLength(1);
    });

    it('does not warn when the pushed ref is the checked-out commit', () => {
      const repo = createHookRepo();
      const result = runHook(repo, 'refs/heads/dev');

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('is not the ref being pushed to dev/main');
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

/** Stub runner that writes a gate cache entry the way `run_tests.py` does. */
const MIRROR_RUNNER = `import os
import pathlib
import subprocess
import sys

log = os.environ.get("STUB_TEST_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(" ".join(sys.argv[1:]) + "\\n")

cache_name = os.environ.get("STUB_CACHE_ENTRY")
if cache_name:
    git_dir = subprocess.check_output(
        ["git", "rev-parse", "--absolute-git-dir"], text=True
    ).strip()
    entry = pathlib.Path(git_dir) / "test-cache" / cache_name
    entry.mkdir(parents=True, exist_ok=True)
    (entry / "result.json").write_text('{"status": "green"}', encoding="utf-8")

sys.exit(int(os.environ.get("STUB_TEST_EXIT", "0")))
`;

/**
 * Create a repo with a linked worktree on branch `feature` and a stubbed
 * `run_tests.py` *inside the worktree* (the hook's local resolution path).
 * The main checkout has a `.worklog/cache` directory — the mirror target.
 */
function createMirrorRepo(): HookRepo {
  const dir = makeTempDir('prepush-mirror-repo-');
  const logFile = path.join(dir, 'runner-invocations.log');

  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Pre-push Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  git(dir, ['branch', '-M', 'dev']);
  fs.mkdirSync(path.join(dir, '.worklog', 'cache'), { recursive: true });

  const worktree = path.join(dir, 'wt');
  git(dir, ['worktree', 'add', '-q', '-b', 'feature', worktree, 'dev']);
  const runnerDir = path.join(worktree, 'skill', 'test', 'scripts');
  fs.mkdirSync(runnerDir, { recursive: true });
  fs.writeFileSync(path.join(runnerDir, 'run_tests.py'), MIRROR_RUNNER);

  return {
    dir,
    logFile,
    cwd: worktree,
    head: git(worktree, ['rev-parse', 'HEAD']),
  };
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe.skipIf(process.platform === 'win32')(
  'pre-push test-cache mirroring (SA-0MVTFMB7K002Y1F3)',
  () => {
    it('pins the project root to the linked worktree being pushed', () => {
      const repo = createMirrorRepo();
      const result = runHook(repo, 'refs/heads/dev');

      expect(result.status).toBe(0);
      expect(result.invocations[0]).toContain(`--project-root ${repo.cwd}`);
    });

    it('mirrors a worktree gate cache entry into the main checkout cache', () => {
      const repo = createMirrorRepo();
      const result = runHook(repo, 'refs/heads/dev', {
        STUB_CACHE_ENTRY: 'entry-abc',
      });

      expect(result.status).toBe(0);
      expect(result.invocations).toHaveLength(1);
      const mirrored = path.join(
        repo.dir,
        '.worklog',
        'cache',
        'entry-abc',
        'result.json',
      );
      expect(fs.readFileSync(mirrored, 'utf8')).toBe('{"status": "green"}');
      expect(result.stderr).toContain('mirrored gate cache entry entry-abc');
    });

    it('leaves a cache entry the main checkout already holds untouched', () => {
      const repo = createMirrorRepo();
      const existing = path.join(
        repo.dir,
        '.worklog',
        'cache',
        'entry-abc',
        'result.json',
      );
      fs.mkdirSync(path.dirname(existing), { recursive: true });
      fs.writeFileSync(existing, '{"status": "already-cached"}');

      const result = runHook(repo, 'refs/heads/dev', {
        STUB_CACHE_ENTRY: 'entry-abc',
      });

      expect(result.status).toBe(0);
      expect(fs.readFileSync(existing, 'utf8')).toBe('{"status": "already-cached"}');
      expect(result.stderr).not.toContain('mirrored gate cache entry entry-abc');
    });

    it.skipIf(isRoot)('never fails the push when a cache entry cannot be mirrored', () => {
      // A copy failure must be reported and swallowed (fail-soft): cache
      // plumbing never decides a push. Skipped as root, where directory
      // permissions cannot deny the copy.
      const repo = createMirrorRepo();
      const mainCache = path.join(repo.dir, '.worklog', 'cache');
      fs.chmodSync(mainCache, 0o500);
      let result: HookResult;
      try {
        result = runHook(repo, 'refs/heads/dev', {
          STUB_CACHE_ENTRY: 'entry-abc',
        });
      } finally {
        fs.chmodSync(mainCache, 0o755);
      }

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('warning: could not mirror cache entry entry-abc');
      expect(fs.existsSync(path.join(mainCache, 'entry-abc'))).toBe(false);
    });
  },
);
