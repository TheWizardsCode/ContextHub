/**
 * scripts/repair-shared-package.sh smoke tests (WL-0MVWK20DK004TQZM AC4).
 *
 * Producer decision option B (2026-10-31): the 35-minute outage was caused by
 * manual multi-step recovery, so the runbook ships with a one-command repair
 * script. The script must, against the MAIN checkout:
 *
 *   1. restore deleted tracked files under packages/shared/ from HEAD — per
 *      deleted path, never stash/reset/clean, and never clobbering a
 *      modified-but-present file (non-destructive),
 *   2. rebuild the gitignored dist/ via `npm run build:shared`,
 *   3. verify packages/shared/dist/worklog-paths.js exists.
 *
 * and be idempotent (a healthy checkout exits 0) and fail with a named cause
 * (exit 1) when the rebuild fails. Fixtures run on REAL git (the mock does
 * not implement status/restore) with a hermetic npm stub on PATH.
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
  throw new Error('real git binary not found on PATH (needed for repair-shared tests)');
}

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
  npmLog: string;
  binDir: string;
}

/**
 * A minimal worklog-layout git repo with a live source file and a gitignored
 * dist/, plus the repair script copied in and a hermetic npm stub that:
 * records its invocation, then produces the dist artifact the script verifies
 * (simulating a successful `build:shared`).
 */
function makeRepoFixture(): Fixture {
  const tempBase = makeTempDir('wl-repair-shared-');
  const repoDir = path.join(tempBase, 'repo');
  const home = path.join(tempBase, 'home');
  const npmLog = path.join(tempBase, 'npm-invocations.log');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'packages', 'shared', 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'packages', 'shared', 'dist'), { recursive: true });

  const repoRoot = path.resolve(__dirname, '..', '..');
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'repair-shared-package.sh'),
    path.join(repoDir, 'scripts', 'repair-shared-package.sh'),
  );
  fs.writeFileSync(
    path.join(repoDir, 'packages', 'shared', 'package.json'),
    JSON.stringify({ name: '@worklog/shared', version: '1.0.0' }),
  );
  fs.writeFileSync(
    path.join(repoDir, 'packages', 'shared', 'src', 'worklog-paths.ts'),
    'export const pathsMarker = "tracked";\n',
  );
  // dist is gitignored, exactly as in the real repo (WL-0MVPADZ1Z000FOSG).
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'packages/shared/dist/\n');
  fs.writeFileSync(path.join(repoDir, 'packages', 'shared', 'dist', 'worklog-paths.js'), 'stale\n');

  // Hermetic npm stub: records the invocation, then emits the artifact the
  // script verifies — so the smoke test exercises restore AND rebuild without
  // a real install (install-herdr.test.ts precedent, WL-0MVWL88MO002SQ2B).
  const binDir = path.join(tempBase, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'npm'),
    `#!/usr/bin/env bash\necho "npm $*" >> "${npmLog}"\ncase "$*" in *build:shared*)\n  mkdir -p packages/shared/dist\n  echo 'export const rebuilt = true;' > packages/shared/dist/worklog-paths.js\n  ;; esac\nexit 0\n`,
  );
  fs.chmodSync(path.join(binDir, 'npm'), 0o755);
  const gitBin = realGitBin();
  git(gitBin, ['init', '-q', repoDir], tempBase, home);
  git(gitBin, ['-C', repoDir, 'config', 'user.email', 'test@example.com'], tempBase, home);
  git(gitBin, ['-C', repoDir, 'config', 'user.name', 'Worklog Test'], tempBase, home);
  git(gitBin, ['-C', repoDir, 'add', '-A'], tempBase, home);
  git(gitBin, ['-C', repoDir, 'commit', '-q', '-m', 'init'], tempBase, home);
  return { repoDir, home, gitBin, npmLog, binDir };
}

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

describe('repair-shared-package script', () => {
  itScript('restores a deleted tracked file and rebuilds dist in one run', () => {
    const f = makeRepoFixture();
    // The 2026-10-31 wipe: tracked sources gone AND dist gone.
    fs.rmSync(path.join(f.repoDir, 'packages', 'shared', 'src', 'worklog-paths.ts'));
    fs.rmSync(path.join(f.repoDir, 'packages', 'shared', 'dist'), { recursive: true });

    const result = runScript(
      path.join(f.repoDir, 'scripts', 'repair-shared-package.sh'),
      f.repoDir,
      { HOME: f.home, PATH: scriptPath([f.binDir], f.gitBin) },
    );
    expect(result.status, result.stderr).toBe(0);
    // Restored from HEAD, byte-for-byte.
    expect(fs.readFileSync(path.join(f.repoDir, 'packages', 'shared', 'src', 'worklog-paths.ts'), 'utf8'))
      .toBe('export const pathsMarker = "tracked";\n');
    // dist rebuilt via npm run build:shared (the stub emitted the artifact).
    const log = fs.readFileSync(f.npmLog, 'utf8');
    expect(log).toContain('build:shared');
    const artifact = path.join(f.repoDir, 'packages', 'shared', 'dist', 'worklog-paths.js');
    expect(fs.existsSync(artifact)).toBe(true);
    // The report names the restored count and the verified artifact.
    const parsed = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}');
    expect(parsed.ok).toBe(true);
    expect(parsed.restored).toBe(1);
    expect(parsed.artifact).toBe(artifact);
  });

  itScript('is idempotent — a healthy checkout exits 0', () => {
    const f = makeRepoFixture();

    const first = runScript(
      path.join(f.repoDir, 'scripts', 'repair-shared-package.sh'),
      f.repoDir,
      { HOME: f.home, PATH: scriptPath([f.binDir], f.gitBin) },
    );
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('no deleted tracked files');
    const second = runScript(
      path.join(f.repoDir, 'scripts', 'repair-shared-package.sh'),
      f.repoDir,
      { HOME: f.home, PATH: scriptPath([f.binDir], f.gitBin) },
    );
    expect(second.status).toBe(0);
  });

  itScript('never clobbers a modified-but-present file (non-destructive)', () => {
    const f = makeRepoFixture();
    // Local uncommitted work on a file that still exists must survive; the
    // repair restores only DELETED paths, never the whole directory.
    fs.writeFileSync(
      path.join(f.repoDir, 'packages', 'shared', 'src', 'worklog-paths.ts'),
      'export const localEdit = "mine";\n',
    );

    const result = runScript(
      path.join(f.repoDir, 'scripts', 'repair-shared-package.sh'),
      f.repoDir,
      { HOME: f.home, PATH: scriptPath([f.binDir], f.gitBin) },
    );
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(f.repoDir, 'packages', 'shared', 'src', 'worklog-paths.ts'), 'utf8'))
      .toBe('export const localEdit = "mine";\n');
  });

  itScript('fails (exit 1) with a named cause when the rebuild fails', () => {
    const f = makeRepoFixture();
    fs.rmSync(path.join(f.repoDir, 'packages', 'shared', 'src', 'worklog-paths.ts'));
    // npm that records the invocation but fails — the script must exit 1
    // with a named cause, not silently claim success.
    const failingNpmDir = path.join(f.home, 'bin-failing');
    fs.mkdirSync(failingNpmDir, { recursive: true });
    fs.writeFileSync(
      path.join(failingNpmDir, 'npm'),
      '#!/usr/bin/env bash\nexit 1\n',
    );
    fs.chmodSync(path.join(failingNpmDir, 'npm'), 0o755);

    const result = runScript(
      path.join(f.repoDir, 'scripts', 'repair-shared-package.sh'),
      f.repoDir,
      { HOME: f.home, PATH: scriptPath([failingNpmDir, f.binDir], f.gitBin) },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm run build:shared failed');
  });
});
