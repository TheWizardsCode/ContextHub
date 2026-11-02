import { execAsync } from './cli-helpers.js';
import * as path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Initialize a lightweight git repo with an empty commit. Uses quiet flags
// and a single command to reduce process startup and filesystem I/O.
export async function initRepo(dir: string): Promise<void> {
  await execAsync('git init -q', { cwd: dir });
  // Configure user and create an empty commit (fast, no file I/O)
  await execAsync('git config user.email "test@example.com" && git config user.name "Test User" && git commit --allow-empty -m "init" -q', { cwd: dir });
}

export async function initBareRepo(dir: string): Promise<void> {
  await execAsync('git init --bare -q', { cwd: dir });
}

// ── Hermetic fixture git environment (WL-0MVWRR4GD001M9LA) ────────────────

/** Repository-override git variables that must never reach a fixture command.
 * Mirrors `skill/shared/git_sandbox.py::REPOSITORY_OVERRIDE_ENV_VARS`, plus
 * `GIT_INDEX_FILE`, which that module pops separately in `fixture_git_env()`. */
export const REPOSITORY_OVERRIDE_ENV_VARS: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
];

const mockBinDir = path.join(__dirname, 'mock-bin');

/** PATH without the test mock-bin so fixture subprocesses run the real git
 * binary (the suite setup prepends `tests/cli/mock-bin`, whose git shim
 * falls back to exiting 0 — a hermetic fixture must reach real git). */
export function realGitPath(): string {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter((p) => path.resolve(p) !== path.resolve(mockBinDir))
    .join(path.delimiter);
}

/** Hermetic environment for fixture git commands: the real git on PATH and no
 * inherited repository override, so *cwd* alone decides the repository.
 *
 * Mirrors `skill/shared/git_sandbox.py::fixture_git_env()`. Beyond the
 * suite-wide scrub in `tests/setup-tests.ts`, an ambient `GIT_INDEX_FILE`
 * must be dropped per fixture: `implement.py finish` validates a would-be
 * commit with a temporary index exported to the suite, and a fixture's
 * `git add`/`git commit` would otherwise stage into THAT index instead of its
 * own repository — corrupting the enclosing gate's evidence and failing the
 * fixture itself (WL-0MVWRR4GD001M9LA).
 *
 * An explicitly supplied base value wins over the scrub, so a test that
 * deliberately targets an index / `GIT_DIR` can pass them in `base`. Do NOT
 * spread the ambient `process.env` into `base` — pass no argument to scrub
 * the ambient environment instead. */
export function fixtureGitEnv(base?: NodeJS.ProcessEnv): Record<string, string> {
  const source = base ?? process.env;
  const env: Record<string, string> = { ...(source as Record<string, string>) };
  // Keep the real git reachable: drop the test mock-bin from PATH unless the
  // caller pinned an explicit PATH.
  if (base === undefined || base.PATH === undefined) {
    env.PATH = realGitPath();
  }
  for (const name of REPOSITORY_OVERRIDE_ENV_VARS) {
    delete env[name];
    const explicit = base?.[name];
    if (explicit !== undefined) env[name] = explicit;
  }
  return env;
}

