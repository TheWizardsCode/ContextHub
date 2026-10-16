#!/usr/bin/env node
/**
 * packages/herdr/scripts/link-shared.mjs — make the plugin's @worklog/shared
 * resolution live instead of a stale packaged copy (WL-0MVAY631M004RZ3Q).
 *
 * npm installs a `file:` dependency as a PACKAGED COPY inside
 * `packages/herdr/node_modules/@worklog/shared`. That copy silently goes
 * stale whenever `packages/shared` changes: at pane startup the plugin
 * imports a named export that is missing from the old copy and the ESM
 * linker throws (`SyntaxError: ... does not provide an export named ...`),
 * so herdr closes the pane with no explanation.
 *
 * This script replaces any such copy with a relative SYMLINK to the live
 * workspace package (`packages/shared`), matching how npm workspaces wire
 * intra-repo dependencies. The plugin then always reads the current
 * `packages/shared` (whose `dist/` is refreshed by `npm run build`), so a
 * build can never leave a stale copy behind.
 *
 * Usage:
 *   node link-shared.mjs [packages/herdr dir]
 *
 * The directory defaults to this script's parent (the herdr package) and
 * may be passed explicitly so the installer can target a checkout whose
 * script location differs (e.g. a linked git worktree). The script is
 * idempotent and fail-open: if linking is impossible it warns (exit 0) so
 * builds never hard-break on a tooling edge case.
 *
 * The function `linkSharedPackage()` is exported for behavioural tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** `node_modules/@worklog/shared` inside a herdr package. */
export function resolveSharedLinkTarget(herdrDir) {
  return path.join(herdrDir, 'node_modules', '@worklog', 'shared');
}

/**
 * Ensure `packages/herdr/node_modules/@worklog/shared` resolves to the live
 * workspace `packages/shared` (a relative symlink on POSIX).
 *
 * @param {string} herdrDir - the herdr plugin package directory
 * @returns {'linked'|'unchanged'} what the function did
 * @throws when the workspace shared package does not exist.
 */
export function linkSharedPackage(herdrDir) {
  const linkPath = resolveSharedLinkTarget(herdrDir);
  const linkParent = path.dirname(linkPath);
  const workspaceShared = path.resolve(herdrDir, '..', 'shared'); // packages/shared
  if (!fs.existsSync(workspaceShared)) {
    throw new Error(
      `workspace shared package not found at ${workspaceShared} — cannot link @worklog/shared`,
    );
  }
  fs.mkdirSync(linkParent, { recursive: true });

  // On Windows use an absolute junction target (junctions need no admin);
  // elsewhere a relative symlink keeps the link meaningful when the repo
  // is moved as a whole.
  const target = process.platform === 'win32' ? workspaceShared : path.join('..', '..', '..', 'shared');

  // Already linked correctly? Nothing to do.
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() && fs.readlinkSync(linkPath) === target) {
      return 'unchanged';
    }
  } catch {
    // Not present (or not a link) — link it below.
  }

  // Remove whatever npm left behind (a packaged copy, a broken link, ...)
  // and link the live workspace package.
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  return 'linked';
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const herdrDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(scriptDir, '..');
  const result = linkSharedPackage(herdrDir);
  const linkPath = resolveSharedLinkTarget(herdrDir);
  const label = result === 'unchanged' ? 'already linked' : 'linked';
  process.stdout.write(
    `[worklog-plugin] @worklog/shared ${label} to the live workspace package (${path.relative(process.cwd(), linkPath)})\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `[worklog-plugin] WARNING: could not link @worklog/shared to the workspace package: ${err.message}\n`,
    );
    process.exitCode = 0;
  }
}
