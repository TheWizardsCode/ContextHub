/**
 * src/sync/repo-context.ts — repo-root resolution and cross-project guards.
 *
 * Concern: resolving which git repository owns a path (the process cwd and
 * the data file), asserting the data file lives in the same repository as
 * the running command — the cross-project sync guard
 * (WL-0MSAH26DD001XXST) — and computing repo-relative paths for the
 * push/pull plumbing.
 *
 * Extracted verbatim from `src/sync.ts` (WL-0MVP9R3PU004EGYE, child 4 of 6 of
 * the WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). `assertDataFileInCwdRepo`
 * is re-exported from the barrel; `getRepoRoot` and `getRepoRelativePath` are
 * exported for internal cross-module use by the barrel's remaining push/pull
 * code — they are NOT part of the `./sync.js` public surface. `getRepoRootForPath`
 * stays module-private.
 */

import * as path from 'path';
import { execAsync } from './git-exec.js';

export async function getRepoRoot(): Promise<string> {
  const { stdout } = await execAsync('git rev-parse --show-toplevel');
  return stdout.trim();
}

/**
 * Find the git repo root that owns `filePath` (by running git from the file's
 * directory). Returns null when the file is not inside a git repository.
 */
async function getRepoRootForPath(filePath: string): Promise<string | null> {
  const dir = path.dirname(path.resolve(filePath));
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: dir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Cross-project sync guard (WL-0MSAH26DD001XXST).
 *
 * `wl sync --worklog-dir <proj>/.worklog` run from inside a DIFFERENT git
 * repo used to fetch the cwd repo's remote worklog ref (because the `-f`
 * default was resolved from the cwd before the override applied) and merge
 * it into <proj>'s database, then push the polluted union back to <proj>'s
 * remote. This guard fails loudly whenever the data file lives in a
 * different git repository than the process cwd, so a sync can never merge
 * foreign-prefix items from another project.
 */
export async function assertDataFileInCwdRepo(dataFilePath: string): Promise<void> {
  let cwdRepoRoot: string | null = null;
  try {
    cwdRepoRoot = (await getRepoRoot()).trim() || null;
  } catch {
    // cwd is not inside a git repository; existing code paths report that.
  }

  const dataRepoRoot = await getRepoRootForPath(dataFilePath);

  if (cwdRepoRoot && dataRepoRoot && cwdRepoRoot !== dataRepoRoot) {
    throw new Error(
      `Cross-project sync blocked: data file '${dataFilePath}' belongs to git repository '${dataRepoRoot}', ` +
      `but this command is running inside git repository '${cwdRepoRoot}'. ` +
      `Merging would combine two projects' worklog data (WL-0MSAH26DD001XXST). ` +
      `Run 'wl sync' from inside '${dataRepoRoot}' or remove the --worklog-dir flag.`
    );
  }
  if (cwdRepoRoot && !dataRepoRoot) {
    throw new Error(
      `Cross-project sync blocked: data file '${dataFilePath}' is not inside a git repository, ` +
      `but this command is running inside git repository '${cwdRepoRoot}'. ` +
      `Run 'wl sync' from inside a directory in the same repository as '${dataFilePath}'.`
    );
  }
  if (!cwdRepoRoot && dataRepoRoot) {
    throw new Error(
      `Cross-project sync blocked: data file '${dataFilePath}' belongs to git repository '${dataRepoRoot}', ` +
      `but the current directory is not inside a git repository. ` +
      `Run 'wl sync' from inside '${dataRepoRoot}'.`
    );
  }
}

export function getRepoRelativePath(repoRootPath: string, filePath: string): { absolutePath: string; relativePath: string } {
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(repoRootPath, absolutePath);
  return { absolutePath, relativePath };
}
