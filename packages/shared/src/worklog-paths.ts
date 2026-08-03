/**
 * Canonical worklog-root resolution shared by the `wl` CLI and the herdr
 * plugin.
 *
 * Both consumers previously implemented their own, subtly different
 * resolution engines:
 *
 * - `wl`'s `resolveWorklogDir()` (src/worklog-paths.ts) was git-centric:
 *   it used `git rev-parse --show-toplevel`, checked `config.yaml` or the
 *   `initialized` marker, and had special worktree handling.
 * - the herdr plugin's `findWorklogRoot()` (packages/herdr/src/index.ts)
 *   walked the filesystem from `process.cwd()`, accepted `worklog.db` or
 *   `initialized`, skipped invalid `.worklog/` stubs, and had no git
 *   dependency.
 *
 * `resolveWorklogRoot()` unifies both behind one deterministic strategy.
 *
 * # Resolution strategy (precedence order)
 *
 * 1. **Nearest valid `.worklog/` wins** — walk up from `startDir` (default
 *    `process.cwd()`). A `.worklog/` is *valid* when it contains any of:
 *    `config.yaml`, `initialized`, or `worklog.db` (the superset of both
 *    engines' validation rules).
 * 2. **Invalid `.worklog/` handling** — an existing `.worklog/` without any
 *    of those markers is skipped ONLY when it is:
 *    - a leftover worktree container stub (a `worktrees/` subdirectory and
 *      no markers), or
 *    - the current path is inside a managed worktree
 *      (the path contains `.worklog/worktrees/`).
 *    In every other case the invalid `.worklog/` is a boundary: walking
 *    stops so an unrelated project's `.worklog/` higher up the tree is
 *    never picked up.
 * 3. **Git repo-root fallback** — when the walk found nothing (either it
 *    exhausted the tree or stopped at an invalid boundary), resolve the
 *    enclosing git repo root (`git rev-parse --show-toplevel` from
 *    `startDir`). If that repo root has a VALID `.worklog/`, prefer it.
 *    This preserves the `wl` CLI's behavior of preferring an initialized
 *    repo-root `.worklog/` over an uninitialized one in a subdirectory.
 * 4. **Return `undefined`** when no valid root exists. Callers decide how
 *    to surface the uninitialized state (e.g. the `wl` CLI falls back to
 *    `<cwd>/.worklog`; the herdr plugin reports the uninitialized state).
 *
 * # Return value
 *
 * The **project root directory** that owns the valid `.worklog/` — NOT the
 * `.worklog/` path itself (callers append `.worklog` themselves).
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * A `.worklog/` directory is valid when it contains any of the markers
 * written by `wl init` / `wl migrate`: the user config, the initialization
 * semaphore, or the SQLite database.
 */
function isValidWorklogDir(wlDir: string): boolean {
  return (
    existsSync(join(wlDir, 'config.yaml')) ||
    existsSync(join(wlDir, 'initialized')) ||
    existsSync(join(wlDir, 'worklog.db'))
  );
}

/**
 * A `.worklog/` directory is a leftover worktree container when it contains
 * a `worktrees/` subdirectory and no config markers at all. The implement
 * tool's worktree lifecycle creates these (e.g. inside `packages/herdr`)
 * and may leave an empty `worktrees/` behind after cleanup. Such a stub is
 * NOT a project worklog and must not block upward resolution.
 */
function isWorktreeContainerStub(wlDir: string): boolean {
  return (
    existsSync(join(wlDir, 'worktrees')) &&
    !existsSync(join(wlDir, 'config.yaml')) &&
    !existsSync(join(wlDir, 'initialized')) &&
    !existsSync(join(wlDir, 'worklog.db'))
  );
}

/**
 * Whether a path is inside a git worktree managed by the worklog system,
 * i.e. its path contains `.worklog/worktrees/`. Worktree `.worklog/`
 * directories may be incomplete stubs left by `git worktree` setup; the
 * real project root is above them.
 */
function isInsideManagedWorktree(dir: string): boolean {
  return dir.includes(join('.worklog', 'worktrees'));
}

/** Resolve the enclosing git repo top-level from `startDir`, or null. */
function getGitTopLevel(startDir: string): string | null {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: startDir,
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the project root that owns a valid `.worklog/` directory.
 *
 * See the module doc comment for the full strategy and precedence order.
 *
 * @param startDir - Directory to start walking up from (defaults to `process.cwd()`).
 * @returns The project root directory containing a valid `.worklog/`, or
 *   `undefined` when no valid root can be found.
 */
export function resolveWorklogRoot(startDir?: string): string | undefined {
  const cwd = startDir ?? process.cwd();

  // Phase 1: nearest-wins filesystem walk.
  let dir = cwd;
  while (true) {
    const wlDir = join(dir, '.worklog');
    if (existsSync(wlDir)) {
      if (isValidWorklogDir(wlDir)) {
        return dir;
      }
      // Invalid .worklog/: only walk past leftover worktree containers and
      // paths inside a managed worktree; otherwise it is a boundary.
      if (!isWorktreeContainerStub(wlDir) && !isInsideManagedWorktree(dir)) {
        break;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  // Phase 2: git repo-root fallback. Only a VALID repo-root .worklog/
  // overrides the undefined result — an invalid one stays a boundary.
  const repoRoot = getGitTopLevel(cwd);
  if (repoRoot) {
    if (isValidWorklogDir(join(repoRoot, '.worklog'))) {
      return repoRoot;
    }
  }

  return undefined;
}
