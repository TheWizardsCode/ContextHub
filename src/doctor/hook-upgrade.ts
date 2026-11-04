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
 * Canonical v3 pre-push hook content — the SINGLE SOURCE OF TRUTH for the
 * committed `.githooks/pre-push` template (branch-policy enforcement +
 * context-budget gate + scope-aware full-suite gate on dev/main pushes +
 * worktree→main test-cache mirroring + worklog sync). Embedded here (rather
 * than read from disk) so the generator works from a dist/ install; `wl init`
 * (src/commands/init.ts) imports this same constant so freshly installed hooks
 * never drift from the committed template (WL-0MT33QNTL006LHQA,
 * WL-0MVHP5S01006GDDV).
 *
 * This text carries the RISE-0MVSS1KVV002TJUL improvements (WL-0MW2N56M2004PSRP):
 * `--project-root` pinned to the pushed tree, the HEAD-vs-pushed-SHA warning,
 * the all-zero (ref deletion) guard, the failure log + tail, the
 * `mirrored gate cache entry` wording and the defensive cache-mirror plumbing.
 * It is byte-for-byte the hook `tce-the-rising` committed under
 * RISE-0MVSS1KVV002TJUL; `wl doctor upgrade` is therefore a no-op for a project
 * that already carries it, instead of silently downgrading it. The expected
 * text is pinned by the checked-in fixture
 * `tests/fixtures/pre-push-hook.expected.sh` (tests/doctor-hook-upgrade.test.ts)
 * — update all three together. Contract: docs/dev/pre-push-hook.md.
 */
export const PRE_PUSH_HOOK_CONTENT = [
        '#!/bin/sh',
        '# worklog:pre-push-hook:v3',
        '# 1. Enforce branch naming policy: block pushes to protected branches.',
        '# 2. Context-budget regression gate (F6, SA-0MSLK7XNZ00366YY): fail the push',
        '#    when the startup context surface exceeds committed thresholds.',
        '# 3. Scope-aware full-suite gate (RISE-0MVSS1KVV002TJUL): run the FULL suite',
        '#    (run_tests.py --scope full) for a push targeting refs/heads/dev or',
        '#    refs/heads/main, and refuse the push when it is not green. This hook is',
        '#    the repository\'s integration checkpoint — implement.py finish validates',
        '#    changed scope only, so the full suite first runs here',
        '#    (SA-0MVECQUGF0064U81). The gate produces the full-suite cache entry the',
        '#    post-push verification and the audit skill read read-only.',
        '# 4. Auto-sync Worklog data before pushing (committed hooks).',
        '#',
        '# Set TEST_SCOPE_SKIP=1 to bypass the full-suite gate (not recommended — it is',
        '#   the only way to skip it).',
        '# Set WORKLOG_SKIP_PRE_PUSH=1 to bypass worklog sync (it does NOT skip the',
        '#   full-suite gate).',
        '# Set BRANCH_POLICY_SKIP=1 to bypass branch policy check (not recommended).',
        '# Set CONTEXT_BUDGET_SKIP=1 to bypass the context-budget gate (not recommended).',
        '#',
        '# Contract and cache-evidence flow: docs/dev/pre-push-hook.md',
        'set -e',
        '',
        '# ── Read the pushed refs ONCE, before any exit path ─────────────────────────',
        '# git feeds one line per pushed ref on stdin:',
        '#   <local_ref> <local_sha> <remote_ref> <remote_sha>',
        '# stdin is consumed by the first reader, so capture everything the gates below',
        '# need here — a later `read` would see EOF and silently skip the gate.',
        '#',
        '# need_full_suite: at least one ref targets dev/main and is not a deletion',
        '#   (a ref deletion has an all-zero local sha, so there is no tree to test).',
        '# skip_worklog_sync: the push carries refs/worklog/data (the sync\'s own ref;',
        '#   syncing while pushing it would loop).',
        'need_full_suite=0',
        'skip_worklog_sync=0',
        'gated_shas=""',
        'while read local_ref local_sha remote_ref remote_sha; do',
        '  [ -n "$remote_ref" ] || continue',
        '  case "$remote_ref" in',
        '    refs/heads/dev|refs/heads/main)',
        '      case "$local_sha" in',
        '        # All zeros means "delete this ref": nothing to test.',
        '        *[!0]*)',
        '          need_full_suite=1',
        '          gated_shas="$gated_shas $local_sha"',
        '          ;;',
        '      esac',
        '      ;;',
        '    refs/worklog/data)',
        '      skip_worklog_sync=1',
        '      ;;',
        '  esac',
        'done',
        '',
        '# ── Branch policy enforcement ────────────────────────────────────────────────',
        '# Check that the current branch is not a protected branch.',
        'if [ "$BRANCH_POLICY_SKIP" != "1" ]; then',
        '  current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"',
        '  # Protected branches that agents must never push to.',
        '  blocked_branches="main master HEAD"',
        '  for blocked in $blocked_branches; do',
        '    if [ "$current_branch" = "$blocked" ]; then',
        '      echo "ERROR: Push to \'$current_branch\' is blocked by branch policy." >&2',
        '      echo "  Regular agents must NOT push directly to main." >&2',
        '      echo "  Work in feature branches (wl-<id>-<desc>) and push into dev." >&2',
        '      echo "  See the framework ship skill for the push-to-dev workflow." >&2',
        '      exit 1',
        '    fi',
        '  done',
        'fi',
        '',
        '# ── Context-budget regression gate ──────────────────────────────────────────',
        '# Fail the push when the pi session startup context surface exceeds the',
        '# committed thresholds (docs/dev/context-budget.thresholds.json). The gate is',
        '# fail-open when the tooling or thresholds file is absent (e.g. worktrees of',
        '# old commits, or repositories that do not ship the context-audit skill).',
        '# measure_context.py is resolved first from the local skill/context-audit/',
        '# path, then from the installed global symlink',
        '# (~/.pi/agent/skills/context-audit/scripts/measure_context.py) installed by',
        '# the framework\'s install_pi.sh.',
        'if [ "$CONTEXT_BUDGET_SKIP" != "1" ]; then',
        '  repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"',
        '  if [ -f "$repo_root/skill/context-audit/scripts/measure_context.py" ]; then',
        '    measure="$repo_root/skill/context-audit/scripts/measure_context.py"',
        '  elif [ -f "$HOME/.pi/agent/skills/context-audit/scripts/measure_context.py" ]; then',
        '    measure="$HOME/.pi/agent/skills/context-audit/scripts/measure_context.py"',
        '  else',
        '    measure=""',
        '  fi',
        '  thresholds="$repo_root/docs/dev/context-budget.thresholds.json"',
        '  if [ -n "$repo_root" ] && [ -n "$measure" ] && [ -f "$measure" ] && [ -f "$thresholds" ]; then',
        '    # Pass --repo-root explicitly: when the global symlink is used, the',
        '    # script\'s default repo-root resolves to the symlink target (the framework',
        '    # checkout) instead of the project being pushed.',
        '    if python3 "$measure" --repo-root "$repo_root" --include-hidden --thresholds "$thresholds" >/dev/null 2>&1; then',
        '      :',
        '    else',
        '      echo "ERROR: Context budget exceeded committed thresholds." >&2',
        '      echo "  Run: python3 $measure --repo-root $repo_root --include-hidden --thresholds $thresholds" >&2',
        '      echo "  See docs/dev/context-budget.md. Set CONTEXT_BUDGET_SKIP=1 to bypass." >&2',
        '      exit 1',
        '    fi',
        '  fi',
        'fi',
        '',
        '# ── Cache evidence bridge: mirror worktree gate entries to the main checkout ─',
        '# A linked worktree resolves its test cache inside itself',
        '# (<worktree>/.worklog/cache, else <git-dir>/test-cache — see',
        '# test_cache.cache_dir()), while the post-push verification and the audit',
        '# skill read the MAIN checkout\'s <main>/.worklog/cache. Without this bridge a',
        '# green gate run leaves no evidence the main checkout can see (AC4,',
        '# RISE-0MVSS1KVV002TJUL; durable fix: SA-0MVEJIRZ60017H4V).',
        '#',
        '# Keys are content-addressed (normalized command + git state), so copying an',
        '# entry the main cache lacks is always safe — an identical key is an identical',
        '# run. An existing entry is never overwritten, and cache plumbing must never',
        '# decide a push: every failure here is a warning.',
        'mirror_suite_cache() {',
        '  wt_root="$1"',
        '  [ -n "$wt_root" ] || return 0',
        '  if [ -d "$wt_root/.worklog" ]; then',
        '    wt_cache="$wt_root/.worklog/cache"',
        '  else',
        '    git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null || true)"',
        '    [ -n "$git_dir" ] || return 0',
        '    wt_cache="$git_dir/test-cache"',
        '  fi',
        '  [ -d "$wt_cache" ] && [ -n "$(ls -A "$wt_cache" 2>/dev/null)" ] || return 0',
        '',
        '  common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"',
        '  [ -n "$common_dir" ] || return 0',
        '  case "$common_dir" in',
        '    /*) main_git_dir="$common_dir" ;;',
        '    *) main_git_dir="$wt_root/$common_dir" ;;',
        '  esac',
        '  main_root="$(dirname "$main_git_dir")"',
        '  # Same checkout (a main-checkout push): the entries are already in place.',
        '  [ "$main_root" != "$wt_root" ] || return 0',
        '  [ -d "$main_root/.worklog" ] || return 0',
        '  main_cache="$main_root/.worklog/cache"',
        '  mkdir -p "$main_cache" 2>/dev/null || return 0',
        '',
        '  for entry in "$wt_cache"/*; do',
        '    [ -d "$entry" ] || continue',
        '    name="$(basename "$entry")"',
        '    [ -e "$main_cache/$name" ] && continue',
        '    if cp -a "$entry" "$main_cache/$name" 2>/dev/null; then',
        '      echo "pre-push: mirrored gate cache entry $name into $main_cache" >&2',
        '    else',
        '      echo "pre-push: warning: could not mirror cache entry $name into $main_cache" >&2',
        '    fi',
        '  done',
        '  return 0',
        '}',
        '',
        '# ── Scope-aware full-suite gate (RISE-0MVSS1KVV002TJUL) ─────────────────────',
        '# Runs for pushes targeting dev/main only; partial runs are never full-suite',
        '# evidence, so the gate always runs scope=full. No timeout or concurrency',
        '# mechanism is introduced here: run_tests.py applies .pi/test-config.json\'s',
        '# timeoutPerCommand per command and acquires the shared host test semaphore.',
        'if [ "$need_full_suite" = "1" ] && [ "$TEST_SCOPE_SKIP" != "1" ]; then',
        '  repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"',
        '  runner=""',
        '  if [ -n "$repo_root" ] && [ -f "$repo_root/skill/test/scripts/run_tests.py" ]; then',
        '    # Repo-local runner (repos that vendor the framework skills).',
        '    runner="$repo_root/skill/test/scripts/run_tests.py"',
        '  elif [ -n "$HOME" ] && [ -f "$HOME/.pi/agent/skills/test/scripts/run_tests.py" ]; then',
        '    # Installed global runner (install_pi.sh); this repository\'s layout.',
        '    runner="$HOME/.pi/agent/skills/test/scripts/run_tests.py"',
        '  fi',
        '',
        '  if [ -z "$runner" ]; then',
        '    echo "ERROR: run_tests.py not found — cannot run the full-suite gate for a dev/main push." >&2',
        '    echo "  Looked for: <repo>/skill/test/scripts/run_tests.py and" >&2',
        '    echo "              \\$HOME/.pi/agent/skills/test/scripts/run_tests.py" >&2',
        '    echo "  Install the framework skills (scripts/install_pi.sh), then re-push." >&2',
        '    echo "  Set TEST_SCOPE_SKIP=1 to bypass (not recommended)." >&2',
        '    exit 1',
        '  fi',
        '',
        '  # The gate tests the tree that is checked out, so warn loudly when no gated',
        '  # ref matches HEAD (e.g. `git push origin other-branch:dev`): the run still',
        '  # gates, but its verdict — and the cache evidence it mirrors — describe the',
        '  # checked-out tree, not the pushed commit.',
        '  head_sha="$(git rev-parse HEAD 2>/dev/null || true)"',
        '  head_pushed=0',
        '  for sha in $gated_shas; do',
        '    if [ "$sha" = "$head_sha" ]; then',
        '      head_pushed=1',
        '    fi',
        '  done',
        '  if [ "$head_pushed" != "1" ]; then',
        '    echo "WARNING: the checked-out HEAD ($head_sha) is not the ref being pushed to dev/main." >&2',
        '    echo "  The gate and its cache evidence describe the checked-out tree; check out the" >&2',
        '    echo "  pushed commit to produce evidence for that commit." >&2',
        '  fi',
        '',
        '  echo "pre-push: full-suite gate for a dev/main push — running run_tests.py --scope full --strict-git-env" >&2',
        '  gate_log="${TMPDIR:-/tmp}/rise-pre-push-test-gate.$$.json"',
        '  if python3 "$runner" --scope full --strict-git-env --project-root "$repo_root" --json >"$gate_log"; then',
        '    echo "pre-push: full suite green (cached runs make repeat pushes cheap)" >&2',
        '    rm -f "$gate_log"',
        '    mirror_suite_cache "$repo_root"',
        '  else',
        '    echo "ERROR: Full test suite failed — pushes to dev/main require a green suite." >&2',
        '    if [ -s "$gate_log" ]; then',
        '      echo "--- run_tests.py output (tail) ---" >&2',
        '      tail -n 40 "$gate_log" >&2 || true',
        '      echo "--- end of run_tests.py output ---" >&2',
        '    fi',
        '    rm -f "$gate_log"',
        '    echo "  Run: python3 \\"$runner\\" --scope full  (or implement.py finish) and fix the failures." >&2',
        '    echo "  Set TEST_SCOPE_SKIP=1 to bypass (not recommended)." >&2',
        '    exit 1',
        '  fi',
        'fi',
        '',
        '# ── Worklog sync ─────────────────────────────────────────────────────────────',
        'if [ "$WORKLOG_SKIP_PRE_PUSH" = "1" ]; then',
        '  echo "worklog: pre-push sync skipped (WORKLOG_SKIP_PRE_PUSH=1)" >&2',
        '  exit 0',
        'fi',
        '',
        '# Skip when running inside a temp worktree created by withTempWorktree',
        '# for internal sync operations. These worktrees don\'t have worklog',
        '# initialized and the push is already done with --no-verify as defense.',
        'case "$PWD" in',
        '  *tmp-worktree-*)',
        '    exit 0',
        '    ;;',
        'esac',
        '',
        '# Skip when inside a git worktree (not the main checkout).',
        '# Worktrees are for feature development and typically don\'t have worklog',
        '# initialized. The sync should run from the main checkout. This early exit is',
        '# deliberately AFTER the full-suite gate: a dev push from an implement',
        '# worktree must still be gated (RISE-0MVSS1KVV002TJUL AC3).',
        'if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then',
        '  echo "worklog: pre-push sync skipped (linked worktree; sync from the main checkout)" >&2',
        '  exit 0',
        'fi',
        '',
        '# A refs/worklog/data-only push skips the sync to avoid infinite loops.',
        'if [ "$skip_worklog_sync" = "1" ]; then',
        '  exit 0',
        'fi',
        '',
        'if command -v wl >/dev/null 2>&1; then',
        '  WL=wl',
        'elif command -v worklog >/dev/null 2>&1; then',
        '  WL=worklog',
        'else',
        '  echo "worklog: wl/worklog not found; skipping pre-push sync" >&2',
        '  exit 0',
        'fi',
        '',
        '# Force the data branch to refs/worklog/data regardless of config.',
        '# This prevents the sync from accidentally pushing to a standard branch',
        '# if the user has overridden syncBranch in their worklog config.',
        '"$WL" sync --git-branch refs/worklog/data || {',
        '  echo "worklog: pre-push sync failed (pushing anyway)" >&2',
        '  exit 0',
        '}',
        'exit 0',
        '',
      ].join('\n');

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
      return PRE_PUSH_HOOK_CONTENT;
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
