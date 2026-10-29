/**
 * src/sync/worktree.ts — temporary-worktree lifecycle for sync I/O.
 *
 * Concern: creating an isolated, detached temporary git worktree under
 * `.worklog/tmp-worktree-*`, preparing it for a dedicated data ref (including
 * the orphan-branch path used by ref rewrite), running a callback inside it
 * with process-lifecycle tracking, and tearing it down unconditionally —
 * including killing any processes spawned inside it before removal.
 *
 * Extracted verbatim from `src/sync.ts` (WL-0MVP9RW4Z006VLW1, child 5 of 6 of
 * the WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). The helpers are
 * module-internal: they are exported so `./remote.js` and `./push.js` can use
 * them directly, but they are NOT part of the `./sync.js` public surface.
 *
 * Worktree isolation rules that this module implements are documented in
 * `docs/dev/worktree-isolation.md`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { withinWorktreeContext, killProcessesForWorktree } from '../process-lifecycle.js';
import { execAsync, escapeShellArg } from './git-exec.js';
import { fetchTargetRef } from './refs.js';
import type { GitTarget } from './types.js';

export function removeWorktreeFiles(worktreePath: string): void {
  for (const name of fs.readdirSync(worktreePath)) {
    if (name === '.git') continue;
    fs.rmSync(path.join(worktreePath, name), { recursive: true, force: true });
  }
}

export async function listTrackedFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await execAsync(`git -C ${escapeShellArg(worktreePath)} ls-files -z`);
  if (!stdout) return [];
  return stdout.split('\0').map(s => s.trim()).filter(Boolean);
}

export function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export async function withTempWorktree<T>(
  repoRootPath: string,
  target: GitTarget,
  run: (worktreePath: string) => Promise<T>,
  options?: { forceOrphan?: boolean }
): Promise<T> {
  const worklogDir = path.join(repoRootPath, '.worklog');
  ensureDir(worklogDir);

  const tmpRoot = fs.mkdtempSync(path.join(worklogDir, 'tmp-worktree-'));
  const worktreePath = path.join(tmpRoot, 'wt');

  // When forceOrphan is set (ref rewrite), bypass the remote fetch entirely:
  // fetching the polluted remote ref would re-import foreign items into the
  // local tracking ref. Instead create a fresh orphan branch from HEAD.
  const { hasRemote, remoteTrackingRef } = options?.forceOrphan
    ? { hasRemote: false, remoteTrackingRef: '' }
    : await fetchTargetRef(target);
  const baseRef = hasRemote ? remoteTrackingRef : 'HEAD';

  try {
    try {
      await execAsync(`git worktree add --detach ${escapeShellArg(worktreePath)} ${escapeShellArg(baseRef)}`);
    } catch (err) {
      // Unborn-HEAD translation (SA-0MSG57UNY009DE51): when the worktree
      // would be created from local HEAD on a repo with no commits yet, git
      // fails with a cryptic error. Surface an actionable message naming the
      // cause and remedy instead.
      if (baseRef === 'HEAD') {
        const raw = (err as Error).message || '';
        if (/HEAD/.test(raw) && /(not a commit|invalid reference|cannot be created from|not a valid object name)/i.test(raw)) {
          throw new Error(
            'Cannot sync: this repository has no commits yet, so git cannot create ' +
            'a temporary worktree from HEAD. Create an initial commit first ' +
            '(e.g. `git commit --allow-empty -m "chore: initial"`), or run ' +
            '`wl sync --no-push` to keep worklog data local.'
          );
        }
      }
      throw err;
    }

    // If remote branch doesn't exist, create an orphan branch in the temp worktree.
    if (!hasRemote) {
      // Create an orphan local branch name; it doesn't need to include refs/.
      const localBranchName = target.branch.startsWith('refs/') ? target.branch.slice('refs/'.length) : target.branch;

      // If the local branch already exists (e.g. from a previous sync), delete it
      // first so that `checkout --orphan` can succeed.
      try {
        await execAsync(`git show-ref --verify --quiet ${escapeShellArg('refs/heads/' + localBranchName)}`);
        // Branch exists — delete it so the orphan checkout below can recreate it.
        await execAsync(`git branch -D ${escapeShellArg(localBranchName)}`);
      } catch {
        // Branch does not exist — this is the first sync, proceed normally.
      }

      await execAsync(`git -C ${escapeShellArg(worktreePath)} checkout --orphan ${escapeShellArg(localBranchName)}`);
      // `checkout --orphan` keeps the index populated with the previously checked-out files.
      // Clear the index + working tree so the branch starts empty.
      try {
        await execAsync(`git -C ${escapeShellArg(worktreePath)} rm -rf .`);
      } catch {
        // ignore
      }
      removeWorktreeFiles(worktreePath);
      try {
        await execAsync(`git -C ${escapeShellArg(worktreePath)} clean -fdx`);
      } catch {
        // ignore
      }
    }

    // Set worktree context so that any child processes spawned inside
    // `run()` are automatically registered with the process lifecycle
    // module for cleanup.
    const restore = withinWorktreeContext(worktreePath);
    try {
      return await run(worktreePath);
    } finally {
      restore();
    }
  } finally {
    // Kill any tracked processes spawned inside the worktree BEFORE
    // removing it, to prevent orphaned processes.
    try {
      killProcessesForWorktree(worktreePath);
    } catch {
      // ignore — best-effort cleanup
    }
    try {
      await execAsync(`git worktree remove --force ${escapeShellArg(worktreePath)}`);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
