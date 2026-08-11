/**
 * Hook upgrade module — detects and upgrades outdated git hooks
 * installed in .git/hooks/ from committed versions in .githooks/.
 */
/**
 * Detect the git hooks target directory based on `core.hooksPath` config.
 * If `core.hooksPath` is set, git uses that directory for hooks.
 * Otherwise, the default `.git/hooks/` is used.
 */
export declare function detectHooksTargetDir(): string;
/**
 * Generate the canonical hook content for a given hook name, matching what
 * `installCommittedHooks()` in `src/commands/init.ts` generates.
 *
 * Used when `core.hooksPath = .githooks` to compare committed hooks against
 * the latest template from the installed ContextHub package.
 *
 * Returns `null` for unknown hook names.
 */
export declare function generateCanonicalHookContent(hookName: string): string | null;
export interface HookInfo {
    name: string;
    hookPath: string;
    committedPath: string;
    committedContent: string;
    currentContent?: string;
    status: 'up-to-date' | 'outdated' | 'not-installed';
    reason?: string;
}
export interface HookDryRunResult {
    success: boolean;
    dryRun: true;
    hooks: Array<{
        name: string;
        hookPath: string;
        status: 'up-to-date' | 'outdated' | 'not-installed';
        reason?: string;
        upgraded: string[];
    }>;
    upgraded: string[];
    outdatedCount: number;
    upToDateCount: number;
    notInstalledCount: number;
}
export interface HookUpgradeResult {
    success: boolean;
    confirmed: true;
    hooks: Array<{
        name: string;
        hookPath: string;
        status: 'up-to-date' | 'outdated' | 'not-installed';
        reason?: string;
    }>;
    upgraded: string[];
    skipped: string[];
    error?: string;
}
/**
 * Scan the repository for git hooks and classify each as up-to-date, outdated,
 * or not-installed.
 *
 * When `hooksDir` resolves to the same directory as `githooksDir` (e.g.
 * `core.hooksPath = .githooks`), the installed hooks ARE the committed hooks.
 * In this case, canonical hook content (generated from latest templates) is
 * used as the "committed" reference instead of reading from the same file.
 */
export declare function listOutdatedHooks(githooksDir?: string, hooksDir?: string): HookInfo[];
/**
 * Perform a dry-run: return what would be upgraded without making changes.
 */
export declare function dryRunHooks(githooksDir?: string, hooksDir?: string): HookDryRunResult;
/**
 * Apply hook upgrades (confirm mode): replace outdated hooks with committed versions.
 */
export declare function upgradeHooks(githooksDir?: string, hooksDir?: string): HookUpgradeResult;
//# sourceMappingURL=hook-upgrade.d.ts.map