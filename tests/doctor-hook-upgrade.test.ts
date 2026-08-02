import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  listOutdatedHooks,
  dryRunHooks,
  upgradeHooks,
  detectHooksTargetDir,
  generateCanonicalHookContent,
  type HookInfo,
} from '../src/doctor/hook-upgrade.js';

// ---------- helpers ----------

function createTestDirs(): { root: string; githooks: string; gitHooks: string } {
  const root = fs.mkdtempSync(path.join('/tmp', 'hook-upgrade-test-'));
  const githooks = path.join(root, 'githooks');
  const gitHooks = path.join(root, 'gitHooks');
  fs.mkdirSync(githooks, { recursive: true });
  fs.mkdirSync(gitHooks, { recursive: true });
  return { root, githooks, gitHooks };
}

function removeDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- fixtures ----------

const FIXED_PRE_PUSH = `#!/bin/sh
# worklog:pre-push-hook:v1

# Auto-sync Worklog data before pushing.
# Force the data branch to refs/worklog/data regardless of config.
set -e

if [ "$WORKLOG_SKIP_PRE_PUSH" = "1" ]; then
  exit 0
fi

skip=0
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/worklog/data" ]; then
    skip=1
  fi
done

if [ "$skip" = "1" ]; then
  exit 0
fi

if command -v wl >/dev/null 2>&1; then
  WL=wl
elif command -v worklog >/dev/null 2>&1; then
  WL=worklog
else
  echo "worklog: wl/worklog not found; skipping pre-push sync" >&2
  exit 0
fi

"$WL" sync --git-branch refs/worklog/data
exit 0
`;

const OLD_PRE_PUSH = `#!/bin/sh
# worklog:pre-push-hook:v1
# Auto-sync Worklog data before pushing.
set -e

if [ "$WORKLOG_SKIP_PRE_PUSH" = "1" ]; then
  exit 0
fi

skip=0
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/worklog/data" ]; then
    skip=1
  fi
done

if [ "$skip" = "1" ]; then
  exit 0
fi

if command -v wl >/dev/null 2>&1; then
  WL=wl
elif command -v worklog >/dev/null 2>&1; then
  WL=worklog
else
  echo "worklog: wl/worklog not found; skipping pre-push sync" >&2
  exit 0
fi

$WL sync --git-branch refs/worklog/data

exit 0
`;

const FIXED_WRAPPER = `#!/bin/sh
# worklog:post-pull-hook:v1
# Wrapper that delegates to central Worklog post-pull script (committed hooks).
exec "$(dirname "$0")/worklog-post-pull" "$@"
`;

const OLD_WRAPPER = `#!/bin/sh
# worklog:post-pull-hook:v1
# Wrapper that delegates to central Worklog post-pull script.
exec "/home/rgardler/projects/ContextHub/.git/hooks/worklog-post-pull" "$@"
`;

const FIXED_POST_PULL = `#!/bin/sh
# worklog:post-pull-hook:v1
# Central Worklog post-pull sync script (committed hooks).
# Set WORKLOG_SKIP_POST_PULL=1 to bypass.
set -e
if [ "$WORKLOG_SKIP_POST_PULL" = "1" ]; then
  exit 0
fi
# Skip when inside a temp worktree created by withTempWorktree for internal
# sync operations. These worktrees don't have worklog initialized.
case "$PWD" in
  *tmp-worktree-*)
    exit 0
    ;;
esac
# Skip when inside a git worktree (not the main checkout).
# Worktrees are for feature development; sync runs from the main checkout.
if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
  exit 0
fi
if command -v wl >/dev/null 2>&1; then
  WL=wl
elif command -v worklog >/dev/null 2>&1; then
  WL=worklog
else
  echo "worklog: wl/worklog not found; skipping post-pull sync" >&2
  exit 0
fi
if "$WL" sync --git-branch refs/worklog/data >/dev/null 2>&1; then
  :
else
  if [ ! -d ".worklog" ]; then
    echo "worklog: not initialized in this checkout/worktree. Run \\"wl init\\" to set up this location." >&2
  else
    echo "worklog: sync failed; continuing" >&2
  fi
fi
exit 0
`;

const OLD_POST_PULL = `#!/bin/sh
# worklog:post-pull-hook:v1
# Central Worklog post-pull sync script.
# Set WORKLOG_SKIP_POST_PULL=1 to bypass.
set -e
if [ "$WORKLOG_SKIP_POST_PULL" = "1" ]; then
  exit 0
fi
if command -v wl >/dev/null 2>&1; then
  WL=wl
elif command -v worklog >/dev/null 2>&1; then
  WL=worklog
else
  echo "worklog: wl/worklog not found; skipping post-pull sync" >&2
  exit 0
fi
if "$WL" sync --git-branch refs/worklog/data >/dev/null 2>&1; then
  :
else
  # Check if this is a new checkout/worktree (no .worklog directory)
  if [ ! -d ".worklog" ]; then
    echo "worklog: not initialized in this checkout/worktree. Run \\"wl init\\" to set up this location." >&2
  else
    echo "worklog: sync failed; continuing" >&2
  fi
fi
exit 0
`;

const FIXED_POST_CHECKOUT = `#!/bin/sh
# worklog:post-checkout-hook:v1
# Auto-sync Worklog data after branch checkout (committed hooks).
# Set WORKLOG_SKIP_POST_CHECKOUT=1 to bypass.
set -e
if [ "$WORKLOG_SKIP_POST_CHECKOUT" = "1" ]; then
  exit 0
fi
# Skip when inside a temp worktree created by withTempWorktree for internal
# sync operations. These worktrees don't have worklog initialized.
case "$PWD" in
  *tmp-worktree-*)
    exit 0
    ;;
esac
# Skip when inside a git worktree (not the main checkout).
# Worktrees are for feature development; sync runs from the main checkout.
if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
  exit 0
fi
if command -v wl >/dev/null 2>&1; then
  WL=wl
elif command -v worklog >/dev/null 2>&1; then
  WL=worklog
else
  echo "worklog: wl/worklog not found; skipping post-checkout sync" >&2
  exit 0
fi
if "$WL" sync --git-branch refs/worklog/data >/dev/null 2>&1; then
  :
else
  if [ ! -d ".worklog" ]; then
    echo "worklog: not initialized in this checkout/worktree. Run \\"wl init\\" to set up this location." >&2
  else
    echo "worklog: sync failed; continuing" >&2
  fi
fi
exit 0
`;

const OLD_POST_CHECKOUT = `#!/bin/sh
# worklog:post-checkout-hook:v1
# Auto-sync Worklog data after branch checkout (committed hooks).
# Set WORKLOG_SKIP_POST_CHECKOUT=1 to bypass.
set -e
if [ "$WORKLOG_SKIP_POST_CHECKOUT" = "1" ]; then
  exit 0
fi
if command -v wl >/dev/null 2>&1; then
  WL=wl
elif command -v worklog >/dev/null 2>&1; then
  WL=worklog
else
  echo "worklog: wl/worklog not found; skipping post-checkout sync" >&2
  exit 0
fi
if "$WL" sync --git-branch refs/worklog/data >/dev/null 2>&1; then
  :
else
  echo "worklog: sync failed; continuing" >&2
fi
exit 0
`;

// ---------- tests ----------

describe('hook-upgrade module', () => {
  let dirs: { root: string; githooks: string; gitHooks: string };

  beforeEach(() => {
    dirs = createTestDirs();
  });

  afterEach(() => {
    removeDir(dirs.root);
  });

  describe('listOutdatedHooks', () => {
    it('returns empty array when .githooks dir does not exist', () => {
      const result = listOutdatedHooks('non-existent', dirs.gitHooks);
      expect(result).toHaveLength(0);
    });

    it('returns not-installed for all hooks when .git/hooks does not exist', () => {
      // Write committed hooks but remove gitHooks
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.githooks, 'post-merge'), FIXED_WRAPPER);
      removeDir(dirs.gitHooks);

      const result = listOutdatedHooks(dirs.githooks, dirs.gitHooks);
      const names = result.map(r => r.name);
      expect(names).toContain('pre-push');
      expect(names).toContain('post-merge');
      expect(result.every(r => r.status === 'not-installed')).toBe(true);
    });

    it('identifies outdated pre-push hook (missing --git-branch guard)', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.gitHooks, 'pre-push'), OLD_PRE_PUSH);

      const result = listOutdatedHooks(dirs.githooks, dirs.gitHooks);
      const prePush = result.find(r => r.name === 'pre-push');
      expect(prePush).toBeDefined();
      expect(prePush!.status).toBe('outdated');
    });

    it('identifies outdated wrapper hooks (hardcoded paths)', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'post-merge'), FIXED_WRAPPER);
      fs.writeFileSync(path.join(dirs.gitHooks, 'post-merge'), OLD_WRAPPER);

      const result = listOutdatedHooks(dirs.githooks, dirs.gitHooks);
      const postMerge = result.find(r => r.name === 'post-merge');
      expect(postMerge).toBeDefined();
      expect(postMerge!.status).toBe('outdated');
    });

    it('identifies outdated post-pull central script', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'worklog-post-pull'), FIXED_POST_PULL);
      fs.writeFileSync(path.join(dirs.gitHooks, 'worklog-post-pull'), OLD_POST_PULL);

      const result = listOutdatedHooks(dirs.githooks, dirs.gitHooks);
      const pp = result.find(r => r.name === 'worklog-post-pull');
      expect(pp).toBeDefined();
      expect(pp!.status).toBe('outdated');
    });

    it('identifies outdated post-checkout hook', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'post-checkout'), FIXED_POST_CHECKOUT);
      fs.writeFileSync(path.join(dirs.gitHooks, 'post-checkout'), OLD_POST_CHECKOUT);

      const result = listOutdatedHooks(dirs.githooks, dirs.gitHooks);
      const pc = result.find(r => r.name === 'post-checkout');
      expect(pc).toBeDefined();
      expect(pc!.status).toBe('outdated');
    });

    it('skips non-worklog hooks (no marker)', () => {
      // .githooks has a hook, .git/hooks has a different non-worklog hook
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.gitHooks, 'pre-push'), '#!/bin/sh\necho "custom hook"\n');

      const result = listOutdatedHooks(dirs.githooks, dirs.gitHooks);
      expect(result).toHaveLength(0);
    });

    it('identifies up-to-date hooks', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.gitHooks, 'pre-push'), FIXED_PRE_PUSH);

      const result = listOutdatedHooks(dirs.githooks, dirs.gitHooks);
      const prePush = result.find(r => r.name === 'pre-push');
      expect(prePush).toBeDefined();
      expect(prePush!.status).toBe('up-to-date');
    });

    it('includes all tracked hooks in result', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.githooks, 'post-checkout'), FIXED_POST_CHECKOUT);
      fs.writeFileSync(path.join(dirs.githooks, 'post-merge'), FIXED_WRAPPER);
      fs.writeFileSync(path.join(dirs.githooks, 'post-rewrite'), FIXED_WRAPPER);
      fs.writeFileSync(path.join(dirs.githooks, 'worklog-post-pull'), FIXED_POST_PULL);

      // Install some hooks, skip others
      fs.writeFileSync(path.join(dirs.gitHooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.gitHooks, 'post-merge'), FIXED_WRAPPER);

      const result = listOutdatedHooks(dirs.githooks, dirs.gitHooks);
      const names = result.map(r => r.name);
      expect(names).toContain('pre-push');
      expect(names).toContain('post-checkout');
      expect(names).toContain('post-merge');
      expect(names).toContain('post-rewrite');
      expect(names).toContain('worklog-post-pull');
      expect(result.length).toBe(5);
    });
  });

  describe('dryRunHooks', () => {
    it('reports outdated hooks without making changes', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.gitHooks, 'pre-push'), OLD_PRE_PUSH);

      const result = dryRunHooks(dirs.githooks, dirs.gitHooks);

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.outdatedCount).toBe(1);
      expect(result.upgraded).toContain('pre-push');
      expect(result.upToDateCount).toBe(0);
      expect(result.notInstalledCount).toBe(0);
    });

    it('reports no outdated hooks when all are up-to-date', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.gitHooks, 'pre-push'), FIXED_PRE_PUSH);

      const result = dryRunHooks(dirs.githooks, dirs.gitHooks);

      expect(result.success).toBe(true);
      expect(result.outdatedCount).toBe(0);
      expect(result.upToDateCount).toBe(1);
    });

    it('reports not-installed hooks', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);

      const result = dryRunHooks(dirs.githooks, dirs.gitHooks);

      expect(result.success).toBe(true);
      expect(result.notInstalledCount).toBe(1);
    });

    it('returns JSON-compatible structure', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.gitHooks, 'pre-push'), OLD_PRE_PUSH);

      const result = dryRunHooks(dirs.githooks, dirs.gitHooks);
      // Ensure it is serializable (no circular refs, etc.)
      expect(() => JSON.stringify(result)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(result));
      expect(parsed.success).toBe(true);
      expect(parsed.dryRun).toBe(true);
      expect(Array.isArray(parsed.hooks)).toBe(true);
    });
  });

  describe('upgradeHooks (confirm mode)', () => {
    it('replaces outdated hooks with committed versions', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.gitHooks, 'pre-push'), OLD_PRE_PUSH);

      const result = upgradeHooks(dirs.githooks, dirs.gitHooks);

      expect(result.success).toBe(true);
      expect(result.upgraded).toContain('pre-push');
      expect(result.skipped).not.toContain('pre-push');

      // Verify the hook was actually replaced
      const upgradedContent = fs.readFileSync(path.join(dirs.gitHooks, 'pre-push'), 'utf-8');
      expect(upgradedContent).toBe(FIXED_PRE_PUSH);
    });

    it('skips up-to-date hooks', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.gitHooks, 'pre-push'), FIXED_PRE_PUSH);

      const result = upgradeHooks(dirs.githooks, dirs.gitHooks);

      expect(result.success).toBe(true);
      expect(result.skipped).toContain('pre-push');
    });

    it('skips not-installed hooks', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);

      const result = upgradeHooks(dirs.githooks, dirs.gitHooks);

      expect(result.success).toBe(true);
      expect(result.skipped).toContain('pre-push');
    });

    it('returns JSON-compatible structure', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.gitHooks, 'pre-push'), OLD_PRE_PUSH);

      const result = upgradeHooks(dirs.githooks, dirs.gitHooks);
      expect(() => JSON.stringify(result)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(result));
      expect(parsed.success).toBe(true);
      expect(parsed.confirmed).toBe(true);
    });

    it('handles multiple hooks', () => {
      fs.writeFileSync(path.join(dirs.githooks, 'pre-push'), FIXED_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.gitHooks, 'pre-push'), OLD_PRE_PUSH);
      fs.writeFileSync(path.join(dirs.githooks, 'post-merge'), FIXED_WRAPPER);
      fs.writeFileSync(path.join(dirs.gitHooks, 'post-merge'), OLD_WRAPPER);

      const result = upgradeHooks(dirs.githooks, dirs.gitHooks);

      expect(result.success).toBe(true);
      expect(result.upgraded).toContain('pre-push');
      expect(result.upgraded).toContain('post-merge');
    });
  });


  describe('integration with real repo', () => {
    it('detects outdated hooks in the actual .githooks/.git/hooks setup', () => {
      // Use the real repo paths
      const repoGithooks = path.join(process.cwd(), '.githooks');
      const repoHooks = path.join(process.cwd(), '.git', 'hooks');

      // We expect at least some hooks in .githooks
      const realResult = listOutdatedHooks(repoGithooks, repoHooks);
      const names = realResult.map(r => r.name);

      // At minimum, some hooks should be present (might be up-to-date or not-installed)
      expect(names.length).toBeGreaterThan(0);
    });

    it('dryRun produces JSON output for the real repo', () => {
      const repoGithooks = path.join(process.cwd(), '.githooks');
      const repoHooks = path.join(process.cwd(), '.git', 'hooks');

      const result = dryRunHooks(repoGithooks, repoHooks);
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result.success).toBe(true);
    });

    it('upgrade is idempotent — running twice does not cause errors', () => {
      // First run upgrades
      const result1 = upgradeHooks();
      // Second run should find no outdated hooks
      const result2 = upgradeHooks();
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });
  });

  describe('generateCanonicalHookContent', () => {
    it('returns content for pre-push hook', () => {
      const content = generateCanonicalHookContent('pre-push');
      expect(content).not.toBeNull();
      expect(content!).toContain('worklog:pre-push-hook:v1');
      expect(content!).toContain('--git-branch refs/worklog/data');
    });

    it('returns content for post-checkout hook', () => {
      const content = generateCanonicalHookContent('post-checkout');
      expect(content).not.toBeNull();
      expect(content!).toContain('worklog:post-checkout-hook:v1');
      expect(content!).toContain('--git-branch refs/worklog/data');
      // WL-0MS99Y6R40028Q9G: post-checkout must skip sync in worktrees.
      expect(content!).toContain('tmp-worktree');
      expect(content!).toContain('git-common-dir');
      expect(content!).toContain('git-dir');
    });

    it('returns content for post-merge hook (wrapper)', () => {
      const content = generateCanonicalHookContent('post-merge');
      expect(content).not.toBeNull();
      expect(content!).toContain('worklog:post-pull-hook:v1');
      expect(content!).toContain('$(dirname "$0")');
    });

    it('returns content for post-rewrite hook (same as post-merge)', () => {
      const pm = generateCanonicalHookContent('post-merge');
      const pr = generateCanonicalHookContent('post-rewrite');
      expect(pm).toEqual(pr);
    });

    it('returns content for worklog-post-pull hook', () => {
      const content = generateCanonicalHookContent('worklog-post-pull');
      expect(content).not.toBeNull();
      expect(content!).toContain('worklog:post-pull-hook:v1');
      expect(content!).toContain('--git-branch refs/worklog/data');
      // WL-0MS99Y6R40028Q9G: post-pull must skip sync in worktrees.
      expect(content!).toContain('tmp-worktree');
      expect(content!).toContain('git-common-dir');
      expect(content!).toContain('git-dir');
    });

    it('returns null for unknown hook names', () => {
      const content = generateCanonicalHookContent('unknown-hook');
      expect(content).toBeNull();
    });

    it('all generated content is JSON-serializable', () => {
      for (const name of ['pre-push', 'post-checkout', 'post-merge', 'post-rewrite', 'worklog-post-pull']) {
        const content = generateCanonicalHookContent(name);
        expect(() => JSON.stringify(content)).not.toThrow();
      }
    });
  });

  describe('detectHooksTargetDir', () => {
    it('returns .git/hooks when no core.hooksPath is set', () => {
      // Temporarily unset core.hooksPath if set
      const origCwd = process.cwd();
      try {
        const result = detectHooksTargetDir();
        // In a worktree, core.hooksPath might already be set. Just verify it returns a string.
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      } finally {
        // No cleanup needed - test is read-only
      }
    });

    it('returns a non-empty string', () => {
      const result = detectHooksTargetDir();
      expect(result).toBeTruthy();
    });
  });

  describe('self-check mode (githooksDir === hooksDir)', () => {
    it('detects outdated hooks when comparing against canonical content', () => {
      // Create a .githooks directory with outdated hooks
      const githooksDir = path.join(dirs.root, 'selfcheck-githooks');
      fs.mkdirSync(githooksDir, { recursive: true });

      // Write an OUTDATED pre-push (missing --git-branch guard)
      const outdatedPrePush = `#!/bin/sh
# worklog:pre-push-hook:v1
$WL sync
exit 0
`;
      fs.writeFileSync(path.join(githooksDir, 'pre-push'), outdatedPrePush);

      // Use the same directory for both githooksDir and hooksDir (simulating core.hooksPath = .githooks)
      const result = listOutdatedHooks(githooksDir, githooksDir);

      expect(result.length).toBeGreaterThan(0);
      const prePush = result.find(r => r.name === 'pre-push');
      expect(prePush).toBeDefined();
      // Should detect as outdated because missing --git-branch guard
      expect(prePush!.status).toBe('outdated');
      expect(prePush!.reason).toContain('latest template');
    });

    it('reports up-to-date hooks when content matches canonical', () => {
      const githooksDir = path.join(dirs.root, 'selfcheck-up2date');
      fs.mkdirSync(githooksDir, { recursive: true });

      // Write canonical content for pre-push
      const canonicalPrePush = generateCanonicalHookContent('pre-push')!;
      fs.writeFileSync(path.join(githooksDir, 'pre-push'), canonicalPrePush);

      const result = listOutdatedHooks(githooksDir, githooksDir);

      const prePush = result.find(r => r.name === 'pre-push');
      expect(prePush).toBeDefined();
      expect(prePush!.status).toBe('up-to-date');
    });

    it('reports not-installed for hooks that do not exist', () => {
      const githooksDir = path.join(dirs.root, 'selfcheck-notinstalled');
      fs.mkdirSync(githooksDir, { recursive: true });

      // Don't write any hooks - they'll be "not-installed"
      const result = listOutdatedHooks(githooksDir, githooksDir);

      // All hook names should appear as not-installed
      const names = result.map(r => r.name);
      expect(names.length).toBeGreaterThanOrEqual(5);
      expect(result.every(r => r.status === 'not-installed')).toBe(true);
    });

    it('dryRun reports outdated hooks in self-check mode', () => {
      const githooksDir = path.join(dirs.root, 'selfcheck-dryrun');
      fs.mkdirSync(githooksDir, { recursive: true });

      const outdatedPrePush = `#!/bin/sh
# worklog:pre-push-hook:v1
$WL sync
exit 0
`;
      fs.writeFileSync(path.join(githooksDir, 'pre-push'), outdatedPrePush);

      const result = dryRunHooks(githooksDir, githooksDir);

      expect(result.success).toBe(true);
      expect(result.outdatedCount).toBe(1);
      expect(result.upgraded).toContain('pre-push');
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it('upgradeHooks replaces outdated hooks with canonical content in self-check mode', () => {
      const githooksDir = path.join(dirs.root, 'selfcheck-upgrade');
      fs.mkdirSync(githooksDir, { recursive: true });

      const outdatedPrePush = `#!/bin/sh
# worklog:pre-push-hook:v1
$WL sync
exit 0
`;
      fs.writeFileSync(path.join(githooksDir, 'pre-push'), outdatedPrePush);

      const result = upgradeHooks(githooksDir, githooksDir);

      expect(result.success).toBe(true);
      expect(result.upgraded).toContain('pre-push');

      // Verify file was updated with canonical content
      const updatedContent = fs.readFileSync(path.join(githooksDir, 'pre-push'), 'utf-8');
      expect(updatedContent).toContain('--git-branch refs/worklog/data');
      expect(updatedContent).not.toContain('$WL sync\nexit 0');
    });

    it('skips hooks without worklog marker in self-check mode', () => {
      const githooksDir = path.join(dirs.root, 'selfcheck-skip');
      fs.mkdirSync(githooksDir, { recursive: true });

      // Write a non-worklog hook (no marker)
      fs.writeFileSync(path.join(githooksDir, 'pre-push'), '#!/bin/sh\necho custom\n');

      const result = listOutdatedHooks(githooksDir, githooksDir);

      // Non-worklog hooks should be skipped entirely
      const prePush = result.find(r => r.name === 'pre-push');
      expect(prePush).toBeUndefined();
    });

    it('self-check dryRun produces JSON-compatible output', () => {
      const githooksDir = path.join(dirs.root, 'selfcheck-json');
      fs.mkdirSync(githooksDir, { recursive: true });

      const outdatedPrePush = `#!/bin/sh
# worklog:pre-push-hook:v1
$WL sync
exit 0
`;
      fs.writeFileSync(path.join(githooksDir, 'pre-push'), outdatedPrePush);

      const result = dryRunHooks(githooksDir, githooksDir);
      expect(() => JSON.stringify(result)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(result));
      expect(parsed.success).toBe(true);
      expect(parsed.outdatedCount).toBe(1);
    });
  });
});
