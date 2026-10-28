/**
 * tests/helpers/repo-file-walk.ts — race-tolerant walker for repo-wide guard
 * tests.
 *
 * Guard tests such as the icons import guard (`tests/unit/icons.test.ts`,
 * WL-0MT2GMTAZ003VKVL) walk the whole checkout looking for a forbidden
 * pattern. On a host where several agents work in parallel that walk races
 * the filesystem: linked worktrees under `.worklog/worktrees/` are created and
 * removed by other agents while the walk is in progress, so a path that was
 * listed a moment ago can already be gone by the time it is stat'ed or read.
 * The pre-existing `readdirSync` + `statSync` + `readFileSync` walk turned
 * that into a spurious `ENOENT` failure of the guard (WL-0MVSLXT79008D4X6).
 *
 * Rules this helper implements:
 *
 * 1. Directories whose *name* is excluded (`node_modules`, `dist`, `.git`,
 *    `.worklog`, `coverage`) are never entered, so the vast majority of the
 *    churn (worktrees, builds) is never touched in the first place.
 * 2. Symlinks are never followed — a symlink into an unbuilt `dist/` (the
 *    root `status-stage-rules.js` shim is one) would otherwise raise ENOENT
 *    in a fresh checkout or worktree.
 * 3. An entry or directory that vanishes mid-walk (`ENOENT`/`ENOTDIR`) is
 *    skipped: it no longer exists, so it cannot be part of the checked tree.
 * 4. Any other filesystem error propagates, so a genuine problem (I/O error,
 *    unreadable path) still fails the guard rather than silently passing it.
 *
 * Every repo-wide guard test should walk through this helper instead of
 * re-implementing the traversal.
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Directory names that are never descended into during a repo-wide walk. */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.git',
  '.worklog',
  'coverage',
]);

/** File extensions considered source files by the guard walkers. */
const SOURCE_FILE_RE = /\.(?:ts|js|mjs|cjs)$/;

/** Directory entry surface the walk needs (a `Dirent` satisfies it). */
export interface RepoWalkDirent {
  name: string;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Minimal filesystem surface used by the walk; injectable for race tests. */
export interface RepoWalkFs {
  readdirSync(dir: string, options: { withFileTypes: true }): RepoWalkDirent[];
  readFileSync(path: string, encoding: 'utf8'): string;
  lstatSync(path: string): { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean };
}

const nodeFs: RepoWalkFs = {
  readdirSync: (dir, options) => readdirSync(dir, options),
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  lstatSync: (path) => lstatSync(path),
};

/** Error codes that mean "this path is no longer there", not "this broke". */
const VANISHED_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

function isVanished(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && VANISHED_CODES.has(code);
}

type EntryKind = 'file' | 'dir' | 'symlink' | 'other' | 'vanished';

/**
 * Classify a directory entry without trusting `Dirent` alone: on filesystems
 * that report the entry type as unknown, all three predicates are false and a
 * `lstat` fallback is required to keep the walk from silently visiting
 * nothing.
 */
function classify(full: string, entry: RepoWalkDirent, fs: RepoWalkFs): EntryKind {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  try {
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'dir';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch (err) {
    if (isVanished(err)) return 'vanished';
    throw err;
  }
}

/**
 * Walk `root` depth-first, invoking `visit(path, content)` for every source
 * file found, and return the visited paths.
 *
 * Vanished paths are skipped; other errors are rethrown. `fs` is injectable so
 * the concurrent-removal behaviour can be tested deterministically.
 */
export function walkRepoSourceFiles(
  root: string,
  visit: (filePath: string, content: string) => void,
  fs: RepoWalkFs = nodeFs,
): string[] {
  const visited: string[] = [];

  const walk = (dir: string): void => {
    let entries: RepoWalkDirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // The directory itself was removed (or replaced by a file) while we
      // were walking: nothing left to check below it.
      if (isVanished(err)) return;
      throw err;
    }

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      switch (classify(full, entry, fs)) {
        case 'symlink':
        case 'other':
        case 'vanished':
          continue;
        case 'dir':
          walk(full);
          continue;
        case 'file':
          break;
      }
      if (!SOURCE_FILE_RE.test(entry.name)) continue;

      let content: string;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch (err) {
        if (isVanished(err)) continue;
        throw err;
      }
      visited.push(full);
      visit(full, content);
    }
  };

  walk(root);
  return visited;
}
