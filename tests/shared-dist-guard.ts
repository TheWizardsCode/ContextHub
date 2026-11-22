/**
 * Shared workspace build-freshness guard — the pure, injectable half of the
 * run-once test preflight (WL-0MWHD4CYF008J4LB, parent WL-0MW8G1X3V007CGAE;
 * contract pinned by `tests/unit/shared-dist-freshness.test.ts`).
 *
 * ## Why
 *
 * `tests/**` resolve `@worklog/shared` through the package `exports` map to the
 * **built** output (`packages/shared/dist/`, gitignored). A checkout whose
 * build predates a change under `packages/shared/src` therefore exercises OLD
 * shared code, and a full-suite run fails for work that is already correct and
 * merged — the red looks like a code defect. `sharedDistPreflight()` in
 * `src/cli.ts` catches only a *missing* build, and only for the `wl` CLI;
 * `isDistFresh()` in `bench/wl-startup-perf.ts` checks only the root `dist/`.
 *
 * This module decides, once per test run, whether the build the run actually
 * loads is at least as new as the newest shared source file. It never rebuilds
 * and never writes: it returns `null` (proceed) or one actionable diagnostic
 * naming the resolved directory, the mtimes and the rebuild command. The
 * run-once `globalSetup` wiring that calls it lives in a sibling item.
 *
 * ## Resolution, not guessing
 *
 * Freshness is judged on the package the run **resolves** (through
 * `node_modules/@worklog/shared`, following symlinks), never on a
 * worktree-local `packages/shared` mirror: in a linked worktree the mirror can
 * look fresh while the build the tests load is stale, and vice versa. The
 * repository root named in the rebuild command is derived from the resolved
 * package's `packages/` parent, so a linked-worktree run names the checkout
 * that owns the build.
 *
 * ## Fail-open
 *
 * A guard that fires on a healthy checkout is worse than no guard, so every
 * "cannot judge" outcome is silent: an unresolvable specifier with no
 * discoverable repository root, a package outside a `packages/` workspace, a
 * directory that cannot be read (`EACCES`/`ENOTDIR`/…), and a package with no
 * readable `src/` all return `null`. Only a genuinely absent `dist/` artefact
 * (`ENOENT`) and a genuinely older artefact produce a diagnostic.
 *
 * ## mtime heuristic trade-off
 *
 * Freshness is decided by mtimes, deliberately: a branch switch or a restored
 * file can make `src` look newer than `dist` without a content change — a
 * false positive that costs one `npm run build:shared` — and a copied `dist`
 * can carry an older mtime with newer content. Content hashing is out of scope
 * (it would add a full source+output walk to every run); the parent item
 * records the trade-off as accepted.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

/**
 * Specifier the guard resolves, mirroring `src/cli.ts`'s preflight
 * (`SHARED_DIST_SPECIFIER`): resolving it proves which `packages/shared`
 * directory the run actually loads.
 */
export const SHARED_BUILD_SPECIFIER = '@worklog/shared/worklog-paths';

/** Build artefact path, relative to the shared package directory. */
const PACKAGE_RELATIVE_ARTEFACT = ['dist', 'worklog-paths.js'];

/** Maximum ancestor levels walked when locating the repository root. */
const REPO_ROOT_SEARCH_DEPTH = 8;

/** Resolver signature injected by tests (defaults to `import.meta.resolve`). */
export type SharedBuildResolver = (specifier: string) => string;

/** Options for {@link sharedDistFreshnessDiagnostic} (test seams only). */
export interface SharedBuildFreshnessOptions {
  /**
   * Module URL anchoring repository-root discovery when the artefact cannot be
   * resolved (a wiped build), and the fail-open boundary for the no-root case.
   */
  moduleUrl?: string;
  /** Mirrors runtime module resolution for {@link SHARED_BUILD_SPECIFIER}. */
  resolve?: SharedBuildResolver;
}

interface StatAttempt {
  stat: fs.Stats | null;
  /** `error.code` when the stat failed (`ENOENT`, `EACCES`, `ENOTDIR`, …). */
  code: string | null;
}

function attemptStat(target: string): StatAttempt {
  try {
    return { stat: fs.statSync(target), code: null };
  } catch (error) {
    return { stat: null, code: (error as NodeJS.ErrnoException).code ?? null };
  }
}

/** Realpath when possible so a symlinked `node_modules` names the real build. */
function realpathIfPossible(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function defaultResolver(specifier: string): string {
  const resolver = (import.meta as ImportMeta & {
    resolve?: SharedBuildResolver;
  }).resolve;
  if (typeof resolver !== 'function') {
    throw new Error('import.meta.resolve is unavailable in this runtime');
  }
  return resolver(specifier);
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** Prefixes that declare `@worklog/shared` as a local, in-repo dependency. */
const LOCAL_DEPENDENCY_PREFIXES = ['file:', 'workspace:', 'link:'];

/**
 * True when `dir` is a Worklog repository root for root-discovery purposes.
 *
 * Mirrors `looksLikeWorklogRepo()` in `src/cli.ts`: the workspace package
 * manifest, a surviving `packages/shared` directory, or a root manifest that
 * declares `@worklog/shared` as a local dependency (which survives a
 * whole-directory wipe of `packages/shared`).
 */
function looksLikeWorklogRepo(dir: string): boolean {
  const manifest = attemptStat(
    path.join(dir, 'packages', 'shared', 'package.json')
  );
  if (manifest.stat?.isFile()) return true;
  const sharedDir = attemptStat(path.join(dir, 'packages', 'shared'));
  if (sharedDir.stat?.isDirectory()) return true;
  try {
    const rootManifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
    ) as Record<string, Record<string, string> | undefined>;
    return DEPENDENCY_FIELDS.some((field) => {
      const declared = rootManifest[field]?.['@worklog/shared'];
      return (
        typeof declared === 'string' &&
        LOCAL_DEPENDENCY_PREFIXES.some((prefix) => declared.startsWith(prefix))
      );
    });
  } catch {
    return false;
  }
}

/** Walk up from `moduleUrl` (bounded) to the nearest Worklog repository root. */
function repoRootFromModuleUrl(moduleUrl: string): string | null {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(moduleUrl));
  } catch {
    return null;
  }
  for (let depth = 0; depth <= REPO_ROOT_SEARCH_DEPTH; depth++) {
    if (looksLikeWorklogRepo(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * `<root>/packages/shared` → `<root>` (the checkout that owns the build).
 *
 * Returns `null` when the resolved package is not laid out under a `packages/`
 * workspace directory — a relocated bundle — so the guard never names a
 * guessed rebuild root.
 */
function repoRootFromPackageDir(packageDir: string): string | null {
  const packagesDir = path.dirname(packageDir);
  if (path.basename(packagesDir) !== 'packages') return null;
  return path.dirname(packagesDir);
}

/**
 * Source files excluded from the comparison, mirroring `isGeneratedSource()`
 * in `bench/wl-startup-perf.ts` (whose contract this module deliberately does
 * not change): `scripts/generate-version.cjs` rewrites `src/version.ts` after
 * tsc, and declaration files are compiler output only.
 */
function isBuildInputSource(fullPath: string): boolean {
  return path.basename(fullPath) !== 'version.ts' && !fullPath.endsWith('.d.ts');
}

interface NewestSource {
  path: string;
  mtimeMs: number;
}

/** Newest source file under `dir` (recursive), or `null` when none/unreadable. */
function newestSourceMtime(dir: string): NewestSource | null {
  let newest: NewestSource | null = null;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable directory — cannot judge
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!isBuildInputSource(full)) continue;
      const attempt = attemptStat(full);
      if (attempt.stat === null) continue;
      if (newest === null || attempt.stat.mtimeMs > newest.mtimeMs) {
        newest = { path: full, mtimeMs: attempt.stat.mtimeMs };
      }
    }
  };
  walk(dir);
  return newest;
}

function iso(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString();
}

function missingDiagnostic(input: {
  packageDir: string;
  artefactPath: string;
  repoRoot: string;
}): string {
  return [
    'The @worklog/shared build output is missing — the test run would fail at',
    'its first shared import instead of exercising any shared code.',
    `  Resolved package: ${input.packageDir}`,
    `  Missing artefact: ${input.artefactPath}`,
    '  Rebuild the shared workspace build, then re-run:',
    `    cd ${input.repoRoot} && npm run build:shared`,
  ].join('\n');
}

function staleDiagnostic(input: {
  packageDir: string;
  artefactPath: string;
  artefactMtimeMs: number;
  newestSource: NewestSource;
  repoRoot: string;
}): string {
  return [
    'The @worklog/shared build is older than its sources — the test run',
    'would load stale shared code, so a red suite would not mean broken code.',
    `  Resolved package: ${input.packageDir}`,
    `  Build artefact:   ${input.artefactPath}`,
    `  Artefact mtime:   ${iso(input.artefactMtimeMs)}`,
    `  Newest source:    ${input.newestSource.path}`,
    `  Source mtime:     ${iso(input.newestSource.mtimeMs)}`,
    '  Rebuild the shared workspace build, then re-run:',
    `    cd ${input.repoRoot} && npm run build:shared`,
  ].join('\n');
}

/**
 * Return `null` when the run may proceed, or one actionable diagnostic when
 * the resolved `@worklog/shared` build is older than the newest shared source
 * file (or absent entirely).
 *
 * Never throws and never writes: resolution failure, an unreadable directory,
 * or a package outside a `packages/` workspace all degrade to `null`
 * (fail-open), matching `sharedDistPreflight()`.
 */
export function sharedDistFreshnessDiagnostic(
  options: SharedBuildFreshnessOptions = {}
): string | null {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const resolve = options.resolve ?? defaultResolver;

  let resolvedPath: string | null = null;
  try {
    const resolved = resolve(SHARED_BUILD_SPECIFIER);
    resolvedPath = resolved.startsWith('file:')
      ? fileURLToPath(resolved)
      : resolved;
  } catch {
    resolvedPath = null;
  }

  let packageDir: string;
  let repoRoot: string;
  let artefactPath: string;

  if (resolvedPath !== null) {
    // Follow the symlink a worktree's node_modules points through, so the
    // diagnostic and the freshness comparison name the build that loads.
    artefactPath = realpathIfPossible(resolvedPath);
    packageDir = path.dirname(path.dirname(artefactPath));
    const derivedRoot = repoRootFromPackageDir(packageDir);
    if (derivedRoot === null) return null; // relocated bundle — never guess
    repoRoot = derivedRoot;
  } else {
    // Resolution failed (e.g. the workspace dependency is not installed).
    // Fall back to the artefact expected under a discoverable repository root;
    // with no root there is nothing honest to report (fail-open).
    const discoveredRoot = repoRootFromModuleUrl(moduleUrl);
    if (discoveredRoot === null) return null;
    repoRoot = discoveredRoot;
    packageDir = path.join(repoRoot, 'packages', 'shared');
    artefactPath = path.join(packageDir, ...PACKAGE_RELATIVE_ARTEFACT);
  }

  const artefact = attemptStat(artefactPath);
  if (artefact.stat === null) {
    // A genuinely absent artefact is the actionable case; any other stat
    // failure (EACCES, ENOTDIR, …) means "cannot read" — stay silent.
    return artefact.code === 'ENOENT'
      ? missingDiagnostic({ packageDir, artefactPath, repoRoot })
      : null;
  }
  if (!artefact.stat.isFile()) return null; // cannot judge a non-file artefact

  const newestSource = newestSourceMtime(path.join(packageDir, 'src'));
  if (newestSource === null) return null; // no readable sources — cannot judge
  // Equal mtimes count as fresh: a build that wrote the artefact in the same
  // tick as the newest source is at least as new.
  if (artefact.stat.mtimeMs >= newestSource.mtimeMs) return null;

  return staleDiagnostic({
    packageDir,
    artefactPath,
    artefactMtimeMs: artefact.stat.mtimeMs,
    newestSource,
    repoRoot,
  });
}
