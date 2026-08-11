/**
 * Shared path resolution helpers for Worklog
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorklogRoot, getGitRepoRoot } from '@worklog/shared/worklog-paths';
/**
 * Module-level override for --worklog-dir CLI option.
 * When set, resolveWorklogDir() returns this path directly,
 * bypassing all filesystem-walking and git-based resolution.
 */
let _worklogDirOverride;
/**
 * Set an explicit worklog directory override.
 * Pass undefined to clear the override and restore normal resolution.
 */
export function setWorklogDirOverride(dir) {
    _worklogDirOverride = dir;
}
/**
 * Get the current worklog directory override, if any.
 */
export function getWorklogDirOverride() {
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
export function applyWorklogDirOverrideFromArgv(argv) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--worklog-dir') {
            const value = argv[i + 1];
            if (value !== undefined) {
                setWorklogDirOverride(value);
                return;
            }
        }
        else if (arg.startsWith('--worklog-dir=')) {
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
export function resolvePiDir(startDir) {
    const cwd = startDir ?? process.cwd();
    const repoRoot = getGitRepoRoot(cwd);
    if (repoRoot) {
        // Walk up from cwd to the repo root (inclusive), returning the nearest
        // directory that owns a .pi/settings.json. Local overrides repo root.
        let dir = cwd;
        while (true) {
            if (fs.existsSync(path.join(dir, '.pi', 'settings.json'))) {
                return dir;
            }
            if (dir === repoRoot)
                break;
            const parent = path.dirname(dir);
            if (parent === dir)
                break; // safety: reached filesystem root
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
export function resolveWorklogDir() {
    // If a --worklog-dir override is active, return it directly
    if (_worklogDirOverride !== undefined) {
        return _worklogDirOverride;
    }
    const root = resolveWorklogRoot();
    if (root) {
        return path.join(root, '.worklog');
    }
    return path.join(process.cwd(), '.worklog');
}
//# sourceMappingURL=worklog-paths.js.map