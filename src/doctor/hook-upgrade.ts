/**
 * Hook upgrade module — detects and upgrades outdated git hooks
 * installed in .git/hooks/ from committed versions in .githooks/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

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

/**
 * Detect the git hooks target directory based on `core.hooksPath` config.
 * If `core.hooksPath` is set, git uses that directory for hooks.
 * Otherwise, the default `.git/hooks/` is used.
 */
export function detectHooksTargetDir(): string {
  try {
    const result = execSync('git config core.hooksPath', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (result) return result;
  } catch {
    // git not available or not a git repo — fall through
  }
  return '.git/hooks';
}

/**
 * Generate the canonical hook content for a given hook name, matching what
 * `installCommittedHooks()` in `src/commands/init.ts` generates.
 *
 * Used when `core.hooksPath = .githooks` to compare committed hooks against
 * the latest template from the installed ContextHub package.
 *
 * Returns `null` for unknown hook names.
 */
export function generateCanonicalHookContent(hookName: string): string | null {
  switch (hookName) {
        case 'pre-push': {
      return [
        '#!/bin/sh',
        '# worklog:pre-push-hook:v1',
        '# Auto-sync Worklog data before pushing (committed hooks).',
        '# Set WORKLOG_SKIP_PRE_PUSH=1 to bypass.',
        'set -e',
        'if [ "$WORKLOG_SKIP_PRE_PUSH" = "1" ]; then',
        '  exit 0',
        'fi',
        '# Skip when inside a temp worktree created by withTempWorktree.',
        'case "$PWD" in',
        '  *tmp-worktree-*)',
        '    exit 0',
        '    ;;',
        'esac',
        '# Skip when inside a git worktree (not the main checkout).',
        'if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then',
        '  exit 0',
        'fi',
        'skip=0',
        'while read local_ref local_sha remote_ref remote_sha; do',
        '  if [ "$remote_ref" = "refs/worklog/data" ]; then',
        '    skip=1',
        '  fi',
        'done',
        'if [ "$skip" = "1" ]; then',
        '  exit 0',
        'fi',
        'if command -v wl >/dev/null 2>&1; then',
        '  WL=wl',
        'elif command -v worklog >/dev/null 2>&1; then',
        '  WL=worklog',
        'else',
        '  echo "worklog: wl/worklog not found; skipping pre-push sync" >&2',
        '  exit 0',
        'fi',
        '$WL sync --git-branch refs/worklog/data || {',
        '  echo "worklog: pre-push sync failed (pushing anyway)" >&2',
        '  exit 0',
        '}',
        'exit 0',
        '',
      ].join('\n');
    }
case 'post-checkout': {
      return [
        '#!/bin/sh',
        '# worklog:post-checkout-hook:v1',
        '# Auto-sync Worklog data after branch checkout (committed hooks).',
        '# Set WORKLOG_SKIP_POST_CHECKOUT=1 to bypass.',
        'set -e',
        'if [ "$WORKLOG_SKIP_POST_CHECKOUT" = "1" ]; then',
        '  exit 0',
        'fi',
        '# Skip when inside a temp worktree created by withTempWorktree for internal',
        '# sync operations. These worktrees don\'t have worklog initialized.',
        'case "$PWD" in',
        '  *tmp-worktree-*)',
        '    exit 0',
        '    ;;',
        'esac',
        '# Skip when inside a git worktree (not the main checkout).',
        '# Worktrees are for feature development; sync runs from the main checkout.',
        'if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then',
        '  exit 0',
        'fi',
        'if command -v wl >/dev/null 2>&1; then',
        '  WL=wl',
        'elif command -v worklog >/dev/null 2>&1; then',
        '  WL=worklog',
        'else',
        '  echo "worklog: wl/worklog not found; skipping post-checkout sync" >&2',
        '  exit 0',
        'fi',
        'if "$WL" sync --git-branch refs/worklog/data >/dev/null 2>&1; then',
        '  :',
        'else',
        '  if [ ! -d ".worklog" ]; then',
        '    echo "worklog: not initialized in this checkout/worktree. Run \\\"wl init\\\" to set up this location." >&2',
        '  else',
        '    echo "worklog: sync failed; continuing" >&2',
        '  fi',
        'fi',
        'exit 0',
        '',
      ].join('\n');
    }
    case 'post-merge':
    case 'post-rewrite': {
      return [
        '#!/bin/sh',
        '# worklog:post-pull-hook:v1',
        '# Wrapper that delegates to central Worklog post-pull script (committed hooks).',
        'exec "$(dirname "$0")/worklog-post-pull" "$@"',
        '',
      ].join('\n');
    }
    case 'worklog-post-pull': {
      return [
        '#!/bin/sh',
        '# worklog:post-pull-hook:v1',
        '# Central Worklog post-pull sync script (committed hooks).',
        '# Set WORKLOG_SKIP_POST_PULL=1 to bypass.',
        'set -e',
        'if [ "$WORKLOG_SKIP_POST_PULL" = "1" ]; then',
        '  exit 0',
        'fi',
        '# Skip when inside a temp worktree created by withTempWorktree for internal',
        '# sync operations. These worktrees don\'t have worklog initialized.',
        'case "$PWD" in',
        '  *tmp-worktree-*)',
        '    exit 0',
        '    ;;',
        'esac',
        '# Skip when inside a git worktree (not the main checkout).',
        '# Worktrees are for feature development; sync runs from the main checkout.',
        'if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then',
        '  exit 0',
        'fi',
        'if command -v wl >/dev/null 2>&1; then',
        '  WL=wl',
        'elif command -v worklog >/dev/null 2>&1; then',
        '  WL=worklog',
        'else',
        '  echo "worklog: wl/worklog not found; skipping post-pull sync" >&2',
        '  exit 0',
        'fi',
        'if "$WL" sync --git-branch refs/worklog/data >/dev/null 2>&1; then',
        '  :',
        'else',
        '  if [ ! -d ".worklog" ]; then',
        '    echo "worklog: not initialized in this checkout/worktree. Run \\\"wl init\\\" to set up this location." >&2',
        '  else',
        '    echo "worklog: sync failed; continuing" >&2',
        '  fi',
        'fi',
        'exit 0',
        '',
      ].join('\n');
    }
    default:
      return null;
  }
}

// Reference: generateCanonicalHookContent() content matches the template
// strings in src/commands/init.ts -> installCommittedHooks(). Any updates
// to the hook templates in init.ts should be mirrored here.

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
 *
 * When `hooksDir` resolves to the same directory as `githooksDir` (e.g.
 * `core.hooksPath = .githooks`), the installed hooks ARE the committed hooks.
 * In this case, canonical hook content (generated from latest templates) is
 * used as the "committed" reference instead of reading from the same file.
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
  const resolvedGithooks = path.resolve(githooksDir);

  // When githooksDir === hooksDir, we're doing a self-check (e.g.,
  // core.hooksPath = .githooks). Use canonical generated content as the
  // "committed" reference instead of reading from the same file.
  const isSelfCheck = resolvedGithooks === gitHooksPath;

  if (!fs.existsSync(gitHooksPath)) {
    // No hooks directory at all — all hooks are "not-installed"
    for (const name of HOOK_NAMES) {
      const committedPath = path.join(githooksDir, name);
      const committedContent = isSelfCheck
        ? generateCanonicalHookContent(name) || ''
        : (fs.existsSync(committedPath) ? fs.readFileSync(committedPath, 'utf-8') : '');
      if (!committedContent) continue;
      info.push({
        name,
        hookPath: path.join(gitHooksPath, name),
        committedPath: isSelfCheck ? path.join(gitHooksPath, name) : committedPath,
        committedContent,
        status: 'not-installed',
      });
    }
    return info;
  }

  for (const name of HOOK_NAMES) {
    const committedPath = path.join(githooksDir, name);
    const hookPath = path.join(gitHooksPath, name);

    // Generate or read committed content
    const committedContent = isSelfCheck
      ? generateCanonicalHookContent(name) || ''
      : (fs.existsSync(committedPath) ? fs.readFileSync(committedPath, 'utf-8') : '');

    if (!committedContent) continue;

    if (!fs.existsSync(hookPath)) {
      info.push({
        name,
        hookPath,
        committedPath: isSelfCheck ? hookPath : committedPath,
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
        committedPath: isSelfCheck ? hookPath : committedPath,
        committedContent,
        currentContent,
        status: 'outdated',
        reason: isSelfCheck
          ? `Hook '${name}' is outdated and would be upgraded to the latest template`
          : `Hook '${name}' is outdated and would be upgraded from .githooks/${name}`,
      });
    } else {
      info.push({
        name,
        hookPath,
        committedPath: isSelfCheck ? hookPath : committedPath,
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
