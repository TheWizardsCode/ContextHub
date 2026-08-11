/**
 * Shared path resolution helpers for Worklog
 */
/**
 * Set an explicit worklog directory override.
 * Pass undefined to clear the override and restore normal resolution.
 */
export declare function setWorklogDirOverride(dir: string | undefined): void;
/**
 * Get the current worklog directory override, if any.
 */
export declare function getWorklogDirOverride(): string | undefined;
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
export declare function applyWorklogDirOverrideFromArgv(argv: string[]): void;
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
export declare function resolvePiDir(startDir?: string): string;
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
export declare function resolveWorklogDir(): string;
//# sourceMappingURL=worklog-paths.d.ts.map