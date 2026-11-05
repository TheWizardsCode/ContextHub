/**
 * init hooks — git hook installation for `wl init`.
 *
 * Single responsibility: install the Worklog-managed git hooks — the
 * canonical pre-push hook, the post-pull sync script and its wrapper hooks,
 * and the repository-tracked committed hooks directory (`.githooks`). Holds the
 * hook marker strings and the hook template text; it declares no init flow and
 * never imports `init.ts` or `init.register.ts`.
 *
 * Dependency direction: external packages, `init.constants.ts`,
 * `init.paths.ts` and `../doctor/hook-upgrade.js` (the canonical pre-push hook
 * content) only. `../doctor/hook-upgrade.ts` never imports this module.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PRE_PUSH_HOOK_CONTENT } from '../doctor/hook-upgrade.js';
import { DEFAULT_COMMITTED_HOOKS_DIR } from './init.constants.js';
import { resolveRepoRoot } from './init.paths.js';

const WORKLOG_PRE_PUSH_HOOK_MARKER = 'worklog:pre-push-hook:v3';
const WORKLOG_POST_PULL_HOOK_MARKER = 'worklog:post-pull-hook:v1';
const WORKLOG_POST_CHECKOUT_HOOK_MARKER = 'worklog:post-checkout-hook:v1';

export function installPrePushHook(options: { silent: boolean }): { installed: boolean; skipped: boolean; present: boolean; hookPath?: string; reason?: string } {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
  } catch {
    return { installed: false, skipped: true, present: false, reason: 'not a git repository' };
  }

  let repoRoot = '';
  let hooksPath = '';
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    hooksPath = execSync('git rev-parse --git-path hooks', { encoding: 'utf8' }).trim();
  } catch (e) {
    return { installed: false, skipped: true, present: false, reason: 'unable to locate git hooks directory' };
  }

  const hooksDir = path.isAbsolute(hooksPath) ? hooksPath : path.join(repoRoot, hooksPath);
  const hookFile = path.join(hooksDir, 'pre-push');

  // Canonical v3 pre-push hook (branch policy + context-budget gate +
  // full-suite gate on dev/main pushes + sync), shared with hook-upgrade.ts
  // and matching the committed `.githooks/pre-push` template
  // (WL-0MT33QNTL006LHQA, WL-0MVHP5S01006GDDV).
  const hookScript = PRE_PUSH_HOOK_CONTENT;

  try {
    fs.mkdirSync(hooksDir, { recursive: true });

    if (fs.existsSync(hookFile)) {
      const existing = fs.readFileSync(hookFile, 'utf-8');
      if (existing.includes(WORKLOG_PRE_PUSH_HOOK_MARKER)) {
        return { installed: false, skipped: true, present: true, hookPath: hookFile, reason: 'hook already installed' };
      }
      return { installed: false, skipped: true, present: true, hookPath: hookFile, reason: `pre-push hook already exists at ${hookFile} (not overwriting)` };
    }

    fs.writeFileSync(hookFile, hookScript, { encoding: 'utf-8', mode: 0o755 });
    try {
      fs.chmodSync(hookFile, 0o755);
    } catch {
      // ignore
    }

    if (!options.silent) {
      console.log(`✓ Installed git pre-push hook at ${hookFile}`);
    }
    return { installed: true, skipped: false, present: true, hookPath: hookFile };
  } catch (e) {
    return { installed: false, skipped: true, present: false, hookPath: hookFile, reason: (e as Error).message };
  }
}

export function installPostPullHooks(options: { silent: boolean }): { installed: boolean; skipped: boolean; present: boolean; hookPaths?: string[]; centralScriptPath?: string; reason?: string } {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
  } catch {
    return { installed: false, skipped: true, present: false, reason: 'not a git repository' };
  }

  let repoRoot = '';
  let hooksPath = '';
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    hooksPath = execSync('git rev-parse --git-path hooks', { encoding: 'utf8' }).trim();
  } catch (e) {
    return { installed: false, skipped: true, present: false, reason: 'unable to locate git hooks directory' };
  }

  const hooksDir = path.isAbsolute(hooksPath) ? hooksPath : path.join(repoRoot, hooksPath);
  const hookNames = ['post-merge', 'post-checkout', 'post-rewrite'];
  const hookFiles = hookNames.map(f => path.join(hooksDir, f));

  // Central script that performs the post-pull sync. Hook wrappers will call this
  // central script so we only manage one implementation location.
  const centralScript = path.join(hooksDir, 'worklog-post-pull');
   const centralScriptContent =
     `#!/bin/sh\n` +
     `# ${WORKLOG_POST_PULL_HOOK_MARKER}\n` +
     `# Central Worklog post-pull sync script.\n` +
     `# Set WORKLOG_SKIP_POST_PULL=1 to bypass.\n` +
     `set -e\n` +
     `if [ \"$WORKLOG_SKIP_POST_PULL\" = \"1\" ]; then\n` +
     `  exit 0\n` +
     `fi\n` +
     `# Skip when inside a temp worktree created by withTempWorktree for internal\n` +
     `# sync operations. These worktrees don't have worklog initialized.\n` +
     `case \"$PWD\" in\n` +
     `  *tmp-worktree-*)\n` +
     `    exit 0\n` +
     `    ;;\n` +
     `esac\n` +
     `# Skip when inside a git worktree (not the main checkout).\n` +
     `# Worktrees are for feature development; sync runs from the main checkout.\n` +
     `if [ \"$(git rev-parse --git-dir 2>/dev/null)\" != \"$(git rev-parse --git-common-dir 2>/dev/null)\" ]; then\n` +
     `  exit 0\n` +
     `fi\n` +
     `if command -v wl >/dev/null 2>&1; then\n` +
     `  WL=wl\n` +
     `elif command -v worklog >/dev/null 2>&1; then\n` +
     `  WL=worklog\n` +
     `else\n` +
     `  echo \"worklog: wl/worklog not found; skipping post-pull sync\" >&2\n` +
     `  exit 0\n` +
     `fi\n` +
     `# Run sync but do not fail the checkout/merge if sync is not available or fails\n` +
     `if \"$WL\" sync --git-branch refs/worklog/data >/dev/null 2>&1; then\n` +
     `  :\n` +
     `else\n` +
     `  # Check if this is a new checkout/worktree (no .worklog directory)\n` +
     `  if [ ! -d \".worklog\" ]; then\n` +
     `    echo \"worklog: not initialized in this checkout/worktree. Run \\\"wl init\\\" to set up this location.\" >&2\n` +
     `  else\n` +
     `    echo \"worklog: sync failed; continuing\" >&2\n` +
     `  fi\n` +
     `fi\n` +
     `exit 0\n`;

  // Small wrapper hooks that call the central script. These are the files Git
  // expects to exist: post-merge, post-checkout, post-rewrite.
  const wrapperContent = (centralPath: string) => (
    `#!/bin/sh\n` +
    `# ${WORKLOG_POST_PULL_HOOK_MARKER}\n` +
    `# Wrapper that delegates to central Worklog post-pull script.\n` +
    `exec \"${centralPath}\" \"$@\"\n`
  );

  try {
    fs.mkdirSync(hooksDir, { recursive: true });

    // Ensure central script is present (but don't overwrite user-provided scripts)
    if (fs.existsSync(centralScript)) {
      const existing = fs.readFileSync(centralScript, 'utf-8');
      if (!existing.includes(WORKLOG_POST_PULL_HOOK_MARKER)) {
        return { installed: false, skipped: true, present: true, hookPaths: [centralScript], reason: `central script exists at ${centralScript} (not overwriting)` };
      }
    } else {
      fs.writeFileSync(centralScript, centralScriptContent, { encoding: 'utf-8', mode: 0o755 });
      try { fs.chmodSync(centralScript, 0o755); } catch {}
    }

    const installedPaths: string[] = [];
    for (const hookFile of hookFiles) {
      if (fs.existsSync(hookFile)) {
        const existing = fs.readFileSync(hookFile, 'utf-8');
        if (existing.includes(WORKLOG_POST_PULL_HOOK_MARKER)) {
          // already installed for this hook, skip
          installedPaths.push(hookFile);
          continue;
        }
        // don't overwrite user hooks
        return { installed: false, skipped: true, present: true, hookPaths: installedPaths, reason: `hook already exists at ${hookFile} (not overwriting)` };
      }

      fs.writeFileSync(hookFile, wrapperContent(centralScript), { encoding: 'utf-8', mode: 0o755 });
      try { fs.chmodSync(hookFile, 0o755); } catch {}
      installedPaths.push(hookFile);
    }

    if (!options.silent) {
      console.log(`✓ Installed git post-pull hooks (wrappers) at ${hooksDir}`);
    }
    return { installed: true, skipped: false, present: true, hookPaths: installedPaths, centralScriptPath: centralScript };
  } catch (e) {
    return { installed: false, skipped: true, present: false, hookPaths: hookFiles, reason: (e as Error).message };
  }
}

export function installCommittedHooks(options: { silent: boolean }): { installed: boolean; skipped: boolean; present: boolean; dirPath?: string; files?: string[]; reason?: string } {
  // Create a repository-tracked hooks directory (e.g. .githooks) with our
  // central post-pull script and wrapper hooks. We do NOT change git config
  // here; the user can opt-in by running `git config core.hooksPath .githooks`.
  let repoRoot: string | null = resolveRepoRoot();
  if (!repoRoot) {
    return { installed: false, skipped: true, present: false, reason: 'not a git repository' };
  }

  const dir = path.join(repoRoot, DEFAULT_COMMITTED_HOOKS_DIR);
  const centralScript = path.join(dir, 'worklog-post-pull');
  const hookNames = ['post-merge', 'post-checkout', 'post-rewrite', 'pre-push'];
  const hookFiles = hookNames.map(n => path.join(dir, n));

  const centralScriptContent =
    `#!/bin/sh\n` +
    `# ${WORKLOG_POST_PULL_HOOK_MARKER}\n` +
    `# Central Worklog post-pull sync script (committed hooks).\n` +
    `# Set WORKLOG_SKIP_POST_PULL=1 to bypass.\n` +
    `set -e\n` +
    `if [ \"$WORKLOG_SKIP_POST_PULL\" = \"1\" ]; then\n` +
    `  exit 0\n` +
    `fi\n` +
    `# Skip when inside a temp worktree created by withTempWorktree for internal\n` +
    `# sync operations. These worktrees don't have worklog initialized.\n` +
    `case \"$PWD\" in\n` +
    `  *tmp-worktree-*)\n` +
    `    exit 0\n` +
    `    ;;\n` +
    `esac\n` +
    `# Skip when inside a git worktree (not the main checkout).\n` +
    `# Worktrees are for feature development; sync runs from the main checkout.\n` +
    `if [ \"$(git rev-parse --git-dir 2>/dev/null)\" != \"$(git rev-parse --git-common-dir 2>/dev/null)\" ]; then\n` +
    `  exit 0\n` +
    `fi\n` +
    `if command -v wl >/dev/null 2>&1; then\n` +
    `  WL=wl\n` +
    `elif command -v worklog >/dev/null 2>&1; then\n` +
    `  WL=worklog\n` +
    `else\n` +
    `  echo \"worklog: wl/worklog not found; skipping post-pull sync\" >&2\n` +
    `  exit 0\n` +
    `fi\n` +
    `if \"$WL\" sync --git-branch refs/worklog/data >/dev/null 2>&1; then\n` +
    `  :\n` +
    `else\n` +
    `  if [ ! -d \".worklog\" ]; then\n` +
    `    echo \"worklog: not initialized in this checkout/worktree. Run \\\"wl init\\\" to set up this location.\" >&2\n` +
    `  else\n` +
    `    echo \"worklog: sync failed; continuing\" >&2\n` +
    `  fi\n` +
    `fi\n` +
    `exit 0\n`;

  // The committed wrappers must be portable: `.githooks/` is checked in and
  // shared across clones and machines, so a hardcoded absolute path breaks
  // every other checkout — and `wl doctor upgrade` flags it as outdated
  // immediately after `wl init` (WL-0MW2N56M2004PSRP). Resolve the central
  // script relative to the wrapper instead, matching
  // `generateCanonicalHookContent('post-merge' | 'post-rewrite')`.
  const committedWrapperContent =
    `#!/bin/sh\n` +
    `# ${WORKLOG_POST_PULL_HOOK_MARKER}\n` +
    `# Wrapper that delegates to central Worklog post-pull script (committed hooks).\n` +
    `exec \"$(dirname \"$0\")/worklog-post-pull\" \"$@\"\n`;

   const prePushContent = PRE_PUSH_HOOK_CONTENT;

    const postCheckoutContent =
      `#!/bin/sh\n` +
      `# ${WORKLOG_POST_CHECKOUT_HOOK_MARKER}\n` +
      `# Auto-sync Worklog data after branch checkout (committed hooks).\n` +
      `# Set WORKLOG_SKIP_POST_CHECKOUT=1 to bypass.\n` +
      `set -e\n` +
      `if [ \"$WORKLOG_SKIP_POST_CHECKOUT\" = \"1\" ]; then\n` +
      `  exit 0\n` +
      `fi\n` +
      `# Skip when inside a temp worktree created by withTempWorktree for internal\n` +
      `# sync operations. These worktrees don't have worklog initialized.\n` +
      `case \"$PWD\" in\n` +
      `  *tmp-worktree-*)\n` +
      `    exit 0\n` +
      `    ;;\n` +
      `esac\n` +
      `# Skip when inside a git worktree (not the main checkout).\n` +
      `# Worktrees are for feature development; sync runs from the main checkout.\n` +
      `if [ \"$(git rev-parse --git-dir 2>/dev/null)\" != \"$(git rev-parse --git-common-dir 2>/dev/null)\" ]; then\n` +
      `  exit 0\n` +
      `fi\n` +
      `if command -v wl >/dev/null 2>&1; then\n` +
      `  WL=wl\n` +
      `elif command -v worklog >/dev/null 2>&1; then\n` +
      `  WL=worklog\n` +
      `else\n` +
      `  echo \"worklog: wl/worklog not found; skipping post-checkout sync\" >&2\n` +
      `  exit 0\n` +
      `fi\n` +
      `if \"$WL\" sync --git-branch refs/worklog/data >/dev/null 2>&1; then\n` +
      `  :\n` +
      `else\n` +
      `  if [ ! -d \".worklog\" ]; then\n` +
      `    echo \"worklog: not initialized in this checkout/worktree. Run \\\"wl init\\\" to set up this location.\" >&2\n` +
      `  else\n` +
      `    echo \"worklog: sync failed; continuing\" >&2\n` +
      `  fi\n` +
      `fi\n` +
      `exit 0\n`;

  try {
    fs.mkdirSync(dir, { recursive: true });

    // central script
    if (fs.existsSync(centralScript)) {
      const existing = fs.readFileSync(centralScript, 'utf-8');
      if (!existing.includes(WORKLOG_POST_PULL_HOOK_MARKER)) {
        return { installed: false, skipped: true, present: true, dirPath: dir, reason: `central script exists at ${centralScript} (not overwriting)` };
      }
    } else {
      fs.writeFileSync(centralScript, centralScriptContent, { encoding: 'utf-8', mode: 0o755 });
      try { fs.chmodSync(centralScript, 0o755); } catch {}
    }

    const installed: string[] = [];
    for (const file of hookFiles) {
       if (fs.existsSync(file)) {
         const existing = fs.readFileSync(file, 'utf-8');
         if (existing.includes(WORKLOG_POST_PULL_HOOK_MARKER) || existing.includes(WORKLOG_PRE_PUSH_HOOK_MARKER) || existing.includes(WORKLOG_POST_CHECKOUT_HOOK_MARKER)) {
           installed.push(file);
           continue;
         }
         return { installed: false, skipped: true, present: true, dirPath: dir, files: installed, reason: `hook already exists at ${file} (not overwriting)` };
       }

       const basename = path.basename(file);
       if (basename === 'pre-push') {
         fs.writeFileSync(file, prePushContent, { encoding: 'utf-8', mode: 0o755 });
       } else if (basename === 'post-checkout') {
         fs.writeFileSync(file, postCheckoutContent, { encoding: 'utf-8', mode: 0o755 });
       } else {
         fs.writeFileSync(file, committedWrapperContent, { encoding: 'utf-8', mode: 0o755 });
       }
      try { fs.chmodSync(file, 0o755); } catch {}
      installed.push(file);
    }

    if (!options.silent) {
      console.log(`✓ Wrote committed hooks to ${dir}`);
      console.log(`  To enable these for this repository run: git config core.hooksPath ${DEFAULT_COMMITTED_HOOKS_DIR}`);
    }

    return { installed: true, skipped: false, present: true, dirPath: dir, files: installed };
  } catch (e) {
    return { installed: false, skipped: true, present: false, dirPath: dir, files: hookFiles, reason: (e as Error).message };
  }
}
