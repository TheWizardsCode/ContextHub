/**
 * Shared path resolution helpers for Worklog
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

/**
 * Module-level override for --worklog-dir CLI option.
 * When set, resolveWorklogDir() returns this path directly,
 * bypassing all filesystem-walking and git-based resolution.
 */
let _worklogDirOverride: string | undefined;

/**
 * Set an explicit worklog directory override.
 * Pass undefined to clear the override and restore normal resolution.
 */
export function setWorklogDirOverride(dir: string | undefined): void {
  _worklogDirOverride = dir;
}

/**
 * Get the current worklog directory override, if any.
 */
export function getWorklogDirOverride(): string | undefined {
  return _worklogDirOverride;
}

/**
 * Parse `--worklog-dir <path>` (or `--worklog-dir=<path>`) from raw argv and
 * apply the override immediately.
 *
 * This MUST run before any code that resolves the worklog directory (e.g.
 * `createPluginContext()` computing `ctx.dataPath`). Previously the override
 * was only applied in commander's `preAction` hook, which runs after module
 * load — so `wl sync --worklog-dir <proj>/.worklog` computed `ctx.dataPath`
 * (and the `-f/--file` default derived from it) from the process cwd instead
 * of the override, fetching the WRONG project's remote ref while writing to
 * the right project's database (cross-project pollution, WL-0MSAH26DD001XXST).
 */
export function applyWorklogDirOverrideFromArgv(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--worklog-dir') {
      const value = argv[i + 1];
      if (value !== undefined) {
        setWorklogDirOverride(value);
        return;
      }
    } else if (arg.startsWith('--worklog-dir=')) {
      const value = arg.slice('--worklog-dir='.length);
      if (value !== '') {
        setWorklogDirOverride(value);
        return;
      }
    }
  }
  // No --worklog-dir in argv: clear any (possibly stale) override so the
  // override state always reflects the current invocation.
  setWorklogDirOverride(undefined);
}

function getRepoRoot(startDir?: string): string | null {
  try {
    const root = child_process.execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: startDir
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Check if the current working directory is a git worktree.
 * A worktree has a .git file (not a directory) that points to the main repo's git directory.
 */
function isGitWorktree(): boolean {
  try {
    const gitPath = path.join(process.cwd(), '.git');
    const stat = fs.statSync(gitPath);
    return stat.isFile();  // .git is a file in a worktree, directory in main repo
  } catch {
    return false;
  }
}

function hasWorklogConfig(worklogDir: string): boolean {
  const configPath = path.join(worklogDir, 'config.yaml');
  const initPath = path.join(worklogDir, 'initialized');
  return fs.existsSync(configPath) || fs.existsSync(initPath);
}

/**
 * Resolve the project directory that owns the `.pi` settings folder,
 * mirroring resolveWorklogDir()'s git-repo-root discovery:
 *
 *   1. Walk up from `startDir` (default: process.cwd()) toward the git repo
 *      root; the nearest directory with a `.pi/settings.json` wins, so a
 *      local settings file in the working directory or a closer ancestor
 *      overrides the repo root (same local-wins rule as `.worklog`).
 *   2. If no `.pi/settings.json` exists between `startDir` and the repo
 *      root, fall back to the repo root so project-level settings are
 *      shared across the whole repository.
 *   3. Outside a git repository, return `startDir` unchanged.
 *
 * Unlike `.worklog`, worktree isolation is intentionally NOT applied here:
 * `.pi` holds developer configuration (not per-worktree project data), so
 * settings resolve to the nearest project root and are shared.
 *
 * @param startDir - Directory to start walking up from (defaults to process.cwd())
 * @returns The project directory that owns the `.pi` settings folder
 */
export function resolvePiDir(startDir?: string): string {
  const cwd = startDir ?? process.cwd();
  const repoRoot = getRepoRoot(cwd);

  if (repoRoot) {
    // Walk up from cwd to the repo root (inclusive), returning the nearest
    // directory that owns a .pi/settings.json. Local overrides repo root.
    let dir: string = cwd;
    while (true) {
      if (fs.existsSync(path.join(dir, '.pi', 'settings.json'))) {
        return dir;
      }
      if (dir === repoRoot) break;
      const parent = path.dirname(dir);
      if (parent === dir) break; // safety: reached filesystem root
      dir = parent;
    }
    return repoRoot;
  }

  return cwd;
}

export function resolveWorklogDir(): string {
  // If a --worklog-dir override is active, return it directly
  if (_worklogDirOverride !== undefined) {
    return _worklogDirOverride;
  }

  const cwd = process.cwd();
  const cwdWorklog = path.join(cwd, '.worklog');

  // If .worklog exists in the current directory prefer it and avoid
  // invoking `git` unless we need to compare against the repo root.
  if (fs.existsSync(cwdWorklog)) {
    // If this .worklog directory contains configuration/initialized marker
    // we can safely return it without calling out to git.
    if (hasWorklogConfig(cwdWorklog)) {
      return cwdWorklog;
    }

    // Only now call git to inspect the repo root when the cwd .worklog
    // exists but does not appear initialized — preserve previous behavior.
    const repoRoot = getRepoRoot();
    const repoWorklog = repoRoot ? path.join(repoRoot, '.worklog') : null;

    if (repoWorklog && repoWorklog !== cwdWorklog && fs.existsSync(repoWorklog)) {
      if (!hasWorklogConfig(cwdWorklog) && hasWorklogConfig(repoWorklog)) {
        return repoWorklog;
      }
    }

    return cwdWorklog;
  }

  // If we're in a git worktree, don't look for .worklog in the main repo
  // Each worktree should have its own independent .worklog directory
  if (isGitWorktree()) {
    return cwdWorklog;
  }

  // Not in a worktree, so try to find .worklog in the repo root — this
  // requires calling git to find the repo top-level directory.
  const repoRoot = getRepoRoot();
  const repoWorklog = repoRoot ? path.join(repoRoot, '.worklog') : null;

  if (repoWorklog && repoRoot && repoRoot !== cwd) {
    if (fs.existsSync(repoWorklog)) {
      return repoWorklog;
    }
  }

  return cwdWorklog;
}
