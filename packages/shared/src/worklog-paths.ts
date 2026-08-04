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
 * `resolveWorklogRoot()` unifies both behind one deterministic strategy
 * (producer-approved, see WL-0MS7TQVK2001X4EG).
 *
 * # Resolution strategy (precedence order)
 *
 * 1. **Nearest valid `.worklog/` wins** — walk up from `startDir` (default
 *    `process.cwd()`). A `.worklog/` is *valid* when it contains either of
 *    the markers `wl init` writes: `config.yaml` (user config) or
 *    `initialized` (init semaphore). A directory containing only
 *    `worklog.db` is a partial/legacy state and is NOT valid.
 * 2. **Invalid `.worklog/` handling** — an existing `.worklog/` without any
 *    valid marker is skipped ONLY when it is:
 *    - a leftover worktree container stub (a `worktrees/` subdirectory and
 *      no markers), or
 *    - the current path is inside a managed worktree
 *      (the path contains `.worklog/worktrees/`).
 *    In every other case the invalid `.worklog/` is a boundary: walking
 *    stops so an unrelated project's `.worklog/` higher up the tree is
 *    never picked up, and an uninitialized subdirectory never falls back to
 *    an initialized repo root.
 * 3. **Git repo-root boundary** — the walk never passes the nearest git
 *    repo root (`git rev-parse --show-toplevel` from `startDir`,
 *    worktree-aware). The repo root's own `.worklog/` is checked before the
 *    boundary stops the walk. Exception: when `startDir` is inside a
 *    managed worktree (`.worklog/worktrees/…`), the walk continues past the
 *    worktree's own git root so the main project's `.worklog/` is found.
 *    Outside git, the walk continues to the filesystem root.
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
 * A `.worklog/` directory is valid when it contains either of the markers
 * written by `wl init`: the user config (`config.yaml`) or the
 * initialization semaphore (`initialized`). A directory containing only
 * `worklog.db` is a partial/legacy state and is NOT valid.
 */
function isValidWorklogDir(wlDir: string): boolean {
  return (
    existsSync(join(wlDir, 'config.yaml')) ||
    existsSync(join(wlDir, 'initialized'))
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
    !existsSync(join(wlDir, 'initialized'))
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

/**
 * Resolve the enclosing git repo top-level from `startDir`, or null.
 *
 * The result is only trusted when the reported root actually contains a
 * `.git` entry (directory or worktree gitfile). Real git only ever reports
 * a top-level with `.git`, so this is a no-op there; it guards against git
 * shims/mocks (e.g. the test mock at tests/cli/mock-bin/git) that fall back
 * to echoing the current directory when no repository is found, which would
 * otherwise turn every directory into a bogus git boundary.
 */
function getGitTopLevel(startDir: string): string | null {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: startDir,
    }).trim();
    if (root && existsSync(join(root, '.git'))) {
      return root;
    }
    return null;
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

  // Nearest-wins filesystem walk, bounded by the enclosing git repo root.
  // Inside a managed worktree the git boundary is lifted so the walk can
  // reach the main project's `.worklog/` above the worktree.
  const repoTop = isInsideManagedWorktree(cwd) ? null : getGitTopLevel(cwd);

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
    if (repoTop && dir === repoTop) break; // Never walk past the git repo root
    const parent = dirname(dir);
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  return undefined;
}
