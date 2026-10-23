/**
 * Shared path resolution helpers for Worklog
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveWorklogRoot, getGitRepoRoot } from '@worklog/shared/worklog-paths';

/**
 * Files whose presence marks a `.worklog/` directory as a *genuine store*
 * rather than a stub materialised from tracked configuration.
 *
 * `.worklog/config.yaml` is tracked in git, so every implement/audit worktree
 * (`git worktree add`) checks it out and therefore has a `.worklog/` directory
 * that looks "valid" to the shared resolver while holding no data at all. The
 * genuine markers are the ones `wl init`/runtime create locally and never
 * commit:
 *
 *   - `initialized` — the init semaphore written by `wl init`;
 *   - `worklog.db` — the SQLite store itself.
 */
export function isGenuineWorklogStore(worklogDir: string): boolean {
  return (
    fs.existsSync(path.join(worklogDir, 'initialized')) ||
    fs.existsSync(path.join(worklogDir, 'worklog.db'))
  );
}

/**
 * Split a path inside a managed worktree (`.worklog/worktrees/<name>/…`) into
 * the worktree root and the project root that owns it.
 *
 * Returns `undefined` for paths that are not inside a managed worktree.
 */
export function splitManagedWorktreePath(
  target: string,
): { projectRoot: string; worktreeRoot: string } | undefined {
  const marker = `${path.sep}${path.join('.worklog', 'worktrees')}${path.sep}`;
  const idx = target.indexOf(marker);
  if (idx < 0) return undefined;
  const projectRoot = target.slice(0, idx) || path.sep;
  const remainder = target.slice(idx + marker.length);
  const name = remainder.split(path.sep)[0];
  if (!name) return undefined;
  return { projectRoot, worktreeRoot: path.join(projectRoot, '.worklog', 'worktrees', name) };
}

/** True when *target* is inside a managed worktree. */
export function isInsideWorktreeRoot(target: string): boolean {
  return splitManagedWorktreePath(path.resolve(target)) !== undefined;
}

/** Store identity reported by a sync (`--json` `sync.store`, sync log). */
export interface StoreIdentity {
  /** Resolved `.worklog` directory the command is operating on. */
  worklogDir: string;
  /** SQLite database path backing it. */
  databasePath: string;
  /** True when the store sits inside a managed worktree (a second store). */
  secondStore: boolean;
  /** The worktree root, when `secondStore` is true. */
  worktreeRoot?: string;
  /** The main checkout's store, when `secondStore` is true and it exists. */
  mainWorklogDir?: string;
}

/**
 * Describe the store a command is operating on and detect the *second store*
 * condition (SA-0MVE34D9B005TUYJ AC2/AC4).
 *
 * @param dataFilePath - The store's JSONL data-file path.
 */
export function detectSecondStore(dataFilePath: string): StoreIdentity {
  const worklogDir = path.dirname(path.resolve(dataFilePath));
  const databasePath = path.join(worklogDir, 'worklog.db');
  const split = splitManagedWorktreePath(path.resolve(dataFilePath));
  if (!split) {
    return { worklogDir, databasePath, secondStore: false };
  }
  const mainWorklogDir = path.join(split.projectRoot, '.worklog');
  return {
    worklogDir,
    databasePath,
    secondStore: true,
    worktreeRoot: split.worktreeRoot,
    mainWorklogDir: fs.existsSync(mainWorklogDir) ? mainWorklogDir : undefined,
  };
}

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
 * The git repo root is discovered via the shared `getGitRepoRoot()` helper
 * (packages/shared/src/worklog-paths.ts) — the same helper the worklog-root
 * resolver uses — so there is no duplicated git discovery.
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
  const repoRoot = getGitRepoRoot(cwd);

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

/**
 * Resolve the `.worklog` directory for the current project.
 *
 * Delegates the canonical resolution to the shared `resolveWorklogRoot()`
 * (packages/shared/src/worklog-paths.ts) so the wl CLI and the herdr
 * plugin share one strategy. The CLI-specific concerns live here:
 *
 *   - `--worklog-dir` override support (see setWorklogDirOverride).
 *   - A never-null fallback: when no valid `.worklog/` exists anywhere,
 *     return `<cwd>/.worklog` (the CLI creates/initializes it on demand).
 */
export function resolveWorklogDir(): string {
  // If a --worklog-dir override is active, return it directly
  if (_worklogDirOverride !== undefined) {
    return _worklogDirOverride;
  }

  const cwd = process.cwd();
  const root = resolveWorklogRoot();

  // ── One store per repo (SA-0MVE34D9B005TUYJ AC4) ──────────────────────
  // Inside a managed worktree (`.worklog/worktrees/<name>`) the checked-out
  // `.worklog/config.yaml` makes the *worktree* look like a valid store root,
  // so `resolveWorklogRoot()` returns it. Binding there would create a second
  // store for the same project prefix — its own DB, its own mutation lock and
  // its own `last-synced-ref` watermark (all derived from the data path), so
  // it silently clobbers the main checkout's store instead of serialising
  // against it.
  //
  // Rule: a worktree `.worklog/` is only used when it is a *genuine* store
  // (created by `wl init`: `initialized` marker and/or `worklog.db`). A stub
  // left by `git worktree add` is skipped in favour of the main checkout's
  // store; when that does not exist either, fail loudly with remediation
  // instead of creating a second store.
  const split = splitManagedWorktreePath(path.resolve(cwd));
  if (split) {
    const candidate = root ? path.join(root, '.worklog') : undefined;
    if (candidate && isGenuineWorklogStore(candidate)) {
      return candidate; // deliberately initialised worktree store
    }
    const mainWorklogDir = path.join(split.projectRoot, '.worklog');
    if (isGenuineWorklogStore(mainWorklogDir)) {
      return mainWorklogDir;
    }
    throw new Error(
      `No worklog store found for this worktree.\n` +
        `  Worktree: ${split.worktreeRoot}\n` +
        `  Checked: ${mainWorklogDir} (no 'initialized' marker or worklog.db)\n` +
        `  Refusing to create a second store for this project prefix — two stores ` +
        `hold independent mutation locks and sync watermarks and can clobber ` +
        `each other.\n` +
        `  Fix: run 'wl init' in the main checkout (${split.projectRoot}), or pass ` +
        `--worklog-dir ${mainWorklogDir} explicitly.`,
    );
  }

  if (root) {
    return path.join(root, '.worklog');
  }
  return path.join(cwd, '.worklog');
}
