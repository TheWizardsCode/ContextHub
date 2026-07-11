import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  listOutdatedHooks,
  dryRunHooks,
  upgradeHooks,
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
  echo "worklog: sync failed or not initialized; continuing" >&2
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
  echo "worklog: sync failed or not initialized; continuing" >&2
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
});
