/**
 * Hook upgrade module — detects and upgrades outdated git hooks
 * installed in .git/hooks/ from committed versions in .githooks/.
 */

import * as fs from 'fs';
import * as path from 'path';

// Markers used by Worklog to identify its own hooks.
const WORKLOG_MARKERS = [
  'worklog:pre-push-hook:',
  'worklog:post-pull-hook:',
  'worklog:post-checkout-hook:',
] as const;

// Hooks in .githooks/ that should be tracked
const HOOK_NAMES = [
  'pre-push',
  'post-checkout',
  'post-merge',
  'post-rewrite',
  'worklog-post-pull',
] as const;

/**
 * Whether a file appears to be a Worklog-managed hook.
 */
function hasWorklogMarker(content: string): boolean {
  return WORKLOG_MARKERS.some(marker => content.includes(marker));
}

/**
 * Whether a hook is outdated.
 *
 * A hook is considered outdated when:
 * - It lacks the safe `--git-branch refs/worklog/data` guard, or
 * - It contains hardcoded paths like `/tmp/Worklog/...` or absolute paths to
 *   `.git/hooks/` for the central post-pull script (should use `$(dirname "$0")`),
 * - Its content differs from the committed `.githooks/` version.
 */
function isHookOutdated(installed: string, committed: string): boolean {
  // If they are identical, not outdated
  if (installed.trim() === committed.trim()) return false;

  // Outdated if missing the safe --git-branch guard
  if (!installed.includes('--git-branch refs/worklog/data')) return true;

  // Outdated if installed hook contains hardcoded absolute paths to .git/hooks/
  // instead of using the relative $(dirname "$0") approach
  const hasHardcodedPaths = /exec\s+["']\/[^"']*["']\s*["']worklog-post-pull["']/.test(installed);
  if (hasHardcodedPaths) return true;

  // If content differs at all, it is outdated (the committed .githooks/ version
  // is the source of truth)
  return true;
}

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
  upgraded: string[]; // names of hooks that would be upgraded
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
 */
export function listOutdatedHooks(
  githooksDir: string = '.githooks',
  hooksDir: string = '.git/hooks'
): HookInfo[] {
  const info: HookInfo[] = [];

  // Check if .githooks directory exists
  if (!fs.existsSync(githooksDir)) {
    return info;
  }

  const gitHooksPath = path.isAbsolute(hooksDir) ? hooksDir : path.resolve(hooksDir);
  if (!fs.existsSync(gitHooksPath)) {
    // No hooks directory at all — all hooks are "not-installed"
    for (const name of HOOK_NAMES) {
      const committedPath = path.join(githooksDir, name);
      if (fs.existsSync(committedPath)) {
        info.push({
          name,
          hookPath: path.join(gitHooksPath, name),
          committedPath,
          committedContent: fs.readFileSync(committedPath, 'utf-8'),
          status: 'not-installed',
        });
      }
    }
    return info;
  }

  for (const name of HOOK_NAMES) {
    const committedPath = path.join(githooksDir, name);
    if (!fs.existsSync(committedPath)) {
      continue;
    }

    const committedContent = fs.readFileSync(committedPath, 'utf-8');
    const hookPath = path.join(gitHooksPath, name);

    if (!fs.existsSync(hookPath)) {
      info.push({
        name,
        hookPath,
        committedPath,
        committedContent,
        status: 'not-installed',
      });
      continue;
    }

    const currentContent = fs.readFileSync(hookPath, 'utf-8');

    // Only consider worklog-managed hooks for upgrade
    if (!hasWorklogMarker(currentContent)) {
      // Not a worklog hook — skip
      continue;
    }

    if (isHookOutdated(currentContent, committedContent)) {
      info.push({
        name,
        hookPath,
        committedPath,
        committedContent,
        currentContent,
        status: 'outdated',
        reason: `Hook '${name}' is outdated and would be upgraded from .githooks/${name}`,
      });
    } else {
      info.push({
        name,
        hookPath,
        committedPath,
        committedContent,
        currentContent,
        status: 'up-to-date',
      });
    }
  }

  return info;
}

/**
 * Perform a dry-run: return what would be upgraded without making changes.
 */
export function dryRunHooks(
  githooksDir?: string,
  hooksDir?: string
): HookDryRunResult {
  const outdatedHooks = listOutdatedHooks(githooksDir, hooksDir);
  const upgraded: string[] = [];
  let outdatedCount = 0;
  let upToDateCount = 0;
  let notInstalledCount = 0;

  const hooks = outdatedHooks.map(h => {
    const hookResult = {
      name: h.name,
      hookPath: h.hookPath,
      status: h.status,
      reason: h.reason,
      upgraded: [] as string[],
    };

    if (h.status === 'outdated') {
      outdatedCount++;
      upgraded.push(h.name);
      hookResult.upgraded.push(h.name);
    } else if (h.status === 'up-to-date') {
      upToDateCount++;
    } else {
      notInstalledCount++;
    }

    return hookResult;
  });

  return {
    success: true,
    dryRun: true,
    hooks,
    upgraded,
    outdatedCount,
    upToDateCount,
    notInstalledCount,
  };
}

/**
 * Apply hook upgrades (confirm mode): replace outdated hooks with committed versions.
 */
export function upgradeHooks(
  githooksDir?: string,
  hooksDir?: string
): HookUpgradeResult {
  const outdatedHooks = listOutdatedHooks(githooksDir, hooksDir);
  const upgraded: string[] = [];
  const skipped: string[] = [];
  let error: string | undefined;

  const hooks = outdatedHooks.map(h => {
    if (h.status === 'outdated') {
      const hookPath = h.hookPath;
      try {
        // Ensure the hooks directory exists
        const hookDir = path.dirname(hookPath);
        if (!fs.existsSync(hookDir)) {
          fs.mkdirSync(hookDir, { recursive: true });
        }

        fs.writeFileSync(hookPath, h.committedContent, {
          encoding: 'utf-8',
          mode: 0o755,
        });

        upgraded.push(h.name);
        return {
          name: h.name,
          hookPath,
          status: 'up-to-date' as const,
          reason: 'Upgraded from .githooks/',
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        error = `Failed to upgrade hook '${h.name}': ${message}`;
        skipped.push(h.name);
        return {
          name: h.name,
          hookPath,
          status: 'outdated' as const,
          reason: `Upgrade failed: ${message}`,
        };
      }
    } else if (h.status === 'up-to-date') {
      skipped.push(h.name);
      return {
        name: h.name,
        hookPath: h.hookPath,
        status: 'up-to-date' as const,
      };
    } else {
      skipped.push(h.name);
      return {
        name: h.name,
        hookPath: h.hookPath,
        status: 'not-installed' as const,
      };
    }
  });

  return {
    success: !error,
    confirmed: true,
    hooks,
    upgraded,
    skipped,
    error,
  };
}
