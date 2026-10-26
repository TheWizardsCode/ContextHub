/**
 * Sync functionality for merging local and remote work items with conflict resolution.
 *
 * Shared type declarations live in `./sync/types.js`, git subprocess plumbing
 * in `./sync/git-exec.js`, the merge decision predicates in
 * `./sync/merge-predicates.js`, the field-level merge implementations in
 * `./sync/field-merge.js`, the public merge entry point in `./sync/merge.js`
 * and the collateral (comment / audit-result / dependency-edge) merges in
 * `./sync/merge-collateral.js` (WL-0MVP9QLWU003NV41). The mid-layer concerns
 * live in `./sync/author-identity.js` (author-identity gate), `./sync/refs.js`
 * (last-synced/remote refs), `./sync/prefix-filter.js` (cross-project prefix
 * filter) and `./sync/repo-context.js` (repo-root resolution + cross-project
 * guard) (WL-0MVP9R3PU004EGYE); the public names are re-exported below so the
 * surface of this module is unchanged.
 */

import { WorkItem, Comment, DependencyEdge, AuditResult } from './types.js';
import { importFromJsonlContent } from './jsonl.js';
import * as fs from 'fs';
import * as path from 'path';
import { execAsync, execGitCaptureStdout, escapeShellArg } from './sync/git-exec.js';
import { getRemoteTrackingRef, fetchTargetRef } from './sync/refs.js';
import { getRepoRoot, getRepoRelativePath, assertDataFileInCwdRepo } from './sync/repo-context.js';
import { withTempWorktree, listTrackedFiles, ensureDir } from './sync/worktree.js';
import type {
  GitTarget,
  DeltaReplayResult,
} from './sync/types.js';
import { mergeWorkItems } from './sync/merge.js';
import { mergeComments, mergeAuditResults, mergeDependencyEdges } from './sync/merge-collateral.js';

// ── Public type surface (barrel re-export) ────────────────────────────
// The 9 type declarations moved to `./sync/types.js`; re-exporting them here
// keeps all 34 exports importable from `'./sync.js'` unchanged (AC3).
export type {
  GitTarget,
  SyncResult,
  MergeOptions,
  IncomingCommit,
  SyncAllowedAuthors,
  AuthorIdentityOptions,
  AuthorIdentityViolation,
  AuthorIdentityResult,
  DeltaReplayResult,
} from './sync/types.js';

// ── Merged modules (WL-0MVP9QLWU003NV41) ─────────────────────────────
// The merge region of `src/sync.ts` moved to `./sync/{merge-predicates,
// field-merge, merge, merge-collateral}.js`; the public names are
// re-exported here so consumers of `'./sync.js'` are unaffected.
export {
  isRegressionDefault,
  isValueRegression,
  isEmptyMeaningfulField,
  isTerminalStage,
} from './sync/merge-predicates.js';
export { mergeWorkItems } from './sync/merge.js';
export { mergeComments, mergeAuditResults, mergeDependencyEdges } from './sync/merge-collateral.js';

// ── Refs (WL-0MVP9R3PU004EGYE) ───────────────────────────────────────
// The last-synced/remote-ref bookkeeping moved to `./sync/refs.js`; the
// public names are re-exported here so consumers of `'./sync.js'` are
// unaffected.
export {
  getLastSyncedRefPath,
  readLastSyncedRef,
  writeLastSyncedRef,
  getRemoteTrackingRefSha,
  _testOnly_getRemoteTrackingRef,
} from './sync/refs.js';

// ── Repo context (WL-0MVP9R3PU004EGYE) ───────────────────────────────
// The repo-root/cross-project guard moved to `./sync/repo-context.js`; the
// public name is re-exported here so consumers of `'./sync.js'` are unaffected.
export { assertDataFileInCwdRepo } from './sync/repo-context.js';

// ── Prefix filter (WL-0MVP9R3PU004EGYE) ──────────────────────────────
// The cross-project prefix filter moved to `./sync/prefix-filter.js`;
// the public names are re-exported here so consumers of `'./sync.js'`
// are unaffected.
export { isOwnProjectItemId, filterRemoteDataByPrefix } from './sync/prefix-filter.js';

// ── Author identity (WL-0MVP9R3PU004EGYE) ─────────────────────────────
// The author-identity gate moved to `./sync/author-identity.js`; the public
// names are re-exported here so consumers of `'./sync.js'` are unaffected.
export {
  getRemoteAuthorCommits,
  checkAuthorIdentity,
  getConfiguredUserEmail,
  enforceAuthorIdentityGate,
} from './sync/author-identity.js';


/**
 * Fetch the remote worklog ref and return both its content and the remote
 * tracking ref that was materialized. The tracking ref is what the
 * author-identity gate (WL-0MSOYWWS4009HTCB) inspects.
 */
export async function getRemoteDataFileContentWithRef(
  dataFilePath: string,
  target: GitTarget
): Promise<{ content: string | null; remoteTrackingRef: string }> {
  // Cross-project safety guard: never read the remote worklog ref of a
  // different repository than the one owning the data file.
  await assertDataFileInCwdRepo(dataFilePath);

  // Check if we're in a git repository
  await execAsync('git rev-parse --git-dir');

  const repoRootPath = await getRepoRoot();
  const { relativePath } = getRepoRelativePath(repoRootPath, dataFilePath);

  const { hasRemote, remoteTrackingRef } = await fetchTargetRef(target);
  if (!hasRemote) {
    return { content: null, remoteTrackingRef };
  }

  const refAndPath = `${remoteTrackingRef}:${relativePath}`;
  try {
    // Avoid exec() maxBuffer issues for large JSONL.
    return { content: await execGitCaptureStdout(['show', refAndPath]), remoteTrackingRef };
  } catch {
    return { content: null, remoteTrackingRef };
  }
}

export async function getRemoteDataFileContent(dataFilePath: string, target: GitTarget): Promise<string | null> {
  return (await getRemoteDataFileContentWithRef(dataFilePath, target)).content;
}

/**
 * Full-snapshot fallback for the pull side (WL-0MT2KZ5GJ000OJIP, design
 * §6.2 trigger 1): a reader that has NO full snapshot base (brand-new clone,
 * or a store corrupted/cleared since watermarks were lost) cannot apply a
 * remote DELTA tip meaningfully — a delta only carries *changed* records, so
 * merging it onto an empty local store would produce a fragmentary database
 * missing every record untouched since the last full export.
 *
 * This function walks the remote tracking ref HISTORY (`git rev-list`) from
 * oldest to newest and replays each commit's JSONL in order:
 *
 * - a commit whose file parses as a FULL snapshot (kind `full` or legacy
 *   headerless) resets the accumulated state to that commit's records;
 * - each subsequent DELTA commit is merged by-ID onto the accumulated state
 *   (adds/updates only);
 *
 * The newest full snapshot found is therefore the base, and every delta
 * published after it is applied on top — the exact chain a delta tip
 * describes. The full-snapshot cadence (§5.3, default every 10 syncs)
 * guarantees this replay is bounded.
 *
 * Returns null when the chain is unrepairable (no full snapshot anywhere in
 * history, or a commit's file cannot be read) — callers must fail closed and
 * NOT merge the partial delta / push an empty snapshot over a populated
 * remote (AC5 no data loss).
 *
 * @param dataFilePath - path of the local JSONL data file (for the repo-relative path)
 * @param remoteTrackingRef - materialized local tracking ref (e.g.
 *   refs/worklog/remotes/origin/worklog/data) whose history to walk
 */
export async function replayRemoteDeltaChain(
  dataFilePath: string,
  remoteTrackingRef: string
): Promise<DeltaReplayResult | null> {
  await assertDataFileInCwdRepo(dataFilePath);
  await execAsync('git rev-parse --git-dir');

  const repoRootPath = await getRepoRoot();
  const { relativePath } = getRepoRelativePath(repoRootPath, dataFilePath);

  // Oldest → newest so a full snapshot found later replaces earlier state and
  // deltas are applied in publish order. Bounded by the cadence guarantee; cap
  // defensively at 200 commits.
  let revs: string[] = [];
  try {
    const { stdout } = await execAsync(
      `git rev-list --reverse --max-count=200 ${escapeShellArg(remoteTrackingRef)}`
    );
    revs = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
  if (revs.length === 0) return null;

  let accItems: WorkItem[] = [];
  let accComments: Comment[] = [];
  let accEdges: DependencyEdge[] = [];
  let accAudits: AuditResult[] = [];
  let foundFull = false;

  for (const rev of revs) {
    let content: string;
    try {
      content = await execGitCaptureStdout(['show', `${rev}:${relativePath}`]);
    } catch {
      // Commit does not contain the data file (e.g. pre-sync init commits).
      continue;
    }
    let parsed: ReturnType<typeof importFromJsonlContent>;
    try {
      parsed = importFromJsonlContent(content);
    } catch {
      return null; // unreadable stream in history — cannot repair
    }
    if (parsed.kind === 'delta') {
      // Delta: merge onto accumulated state by-ID.
      accItems = mergeWorkItems(accItems, parsed.items).merged;
      accComments = mergeComments(accComments, parsed.comments).merged;
      accEdges = mergeDependencyEdges(accEdges, parsed.dependencyEdges || []).merged;
      accAudits = mergeAuditResults(accAudits, parsed.auditResults || []).merged;
    } else {
      // Full snapshot (or legacy headerless): becomes the new base.
      accItems = parsed.items;
      accComments = parsed.comments;
      accEdges = parsed.dependencyEdges || [];
      accAudits = parsed.auditResults || [];
      foundFull = true;
    }
  }

  return foundFull ? { items: accItems, comments: accComments, dependencyEdges: accEdges, auditResults: accAudits } : null;
}

/**
 * Push the serialized worklog data file to the dedicated remote ref.
 *
 * Delta-aware behavior (WL-0MSAKUBKW006FN8Q): the file passed in is the
 * output of `exportForSync`, which may be either a FULL snapshot or a DELTA
 * (a JSONL subset carrying the sync header). Both are committed to the remote
 * ref tip as a new commit on the existing branch history — which is what
 * allows `replayRemoteDeltaChain` to walk back to the newest full snapshot
 * when a reader has no local base. This function itself is kind-agnostic: it
 * pushes whatever JSONL it is given onto `refs/worklog/data`.
 */
export async function gitPushDataFileToBranch(
  repoDataFilePath: string,
  commitMessage: string,
  target: GitTarget
): Promise<void> {
  // Cross-project safety guard: never push the data file to a different
  // repository's remote ref than the one owning the file.
  await assertDataFileInCwdRepo(repoDataFilePath);
  // SAFETY GUARD: reject pushes to regular branches or tags.
  // Worklog data must only be stored on dedicated refs under refs/worklog/
  // to prevent accidental corruption of the project working tree.
  // See WL-0MQRBT8BS00355AB for the bug this prevents.
  const branch = target.branch;
  if (branch.startsWith('refs/heads/') || branch.startsWith('refs/tags/')) {
    throw new Error(
      `Refusing to push worklog data to '${branch}'. ` +
      `Worklog data must be pushed to a dedicated ref under refs/worklog/ ` +
      `(e.g. refs/worklog/data). Use WORKLOG_SKIP_PRE_PUSH=1 to bypass the pre-push hook.`
    );
  }
  // This pushes ONLY the data file by committing it on a dedicated branch
  // in a temporary worktree based on the remote branch tip.
  await execAsync('git rev-parse --git-dir');

  const repoRootPath = await getRepoRoot();
  const { relativePath } = getRepoRelativePath(repoRootPath, repoDataFilePath);
  const srcAbsPath = path.resolve(repoDataFilePath);

  if (!fs.existsSync(srcAbsPath)) {
    return;
  }

  await withTempWorktree(repoRootPath, target, async (worktreePath) => {
    // Ensure the dedicated data branch contains ONLY the JSONL file.
    // If it was previously polluted with other repo files, we remove them here.
    try {
      const tracked = await listTrackedFiles(worktreePath);
      const others = tracked.filter(p => p !== relativePath);
      if (others.length > 0) {
        for (const p of others) {
          await execAsync(`git -C ${escapeShellArg(worktreePath)} rm -r -- ${escapeShellArg(p)}`);
        }
        await execAsync(`git -C ${escapeShellArg(worktreePath)} clean -fdx`);
      }
    } catch {
      // ignore; we'll still proceed to commit the JSONL file
    }

    const dstAbsPath = path.join(worktreePath, relativePath);
    ensureDir(path.dirname(dstAbsPath));
    fs.copyFileSync(srcAbsPath, dstAbsPath);

    const escapedMsg = escapeShellArg(commitMessage);
    const escapedRel = escapeShellArg(relativePath);

    // Stage and commit only the JSONL file.
    // The data file typically lives under `.worklog/`, which is commonly gitignored in the main repo.
    // Force-add so this dedicated ref can still track it.
    await execAsync(`git -C ${escapeShellArg(worktreePath)} add -f -- ${escapedRel}`);
    const { stdout: staged } = await execAsync(
      `git -C ${escapeShellArg(worktreePath)} diff --cached --name-only -- ${escapedRel}`
    );
    if (!staged.trim()) {
      return;
    }

    await execAsync(`git -C ${escapeShellArg(worktreePath)} commit -m ${escapedMsg}`);

    // Push only this commit to the dedicated ref.
    const pushTarget = target.branch.startsWith('refs/') ? target.branch : `refs/heads/${target.branch}`;
    await execAsync(
      `git -C ${escapeShellArg(worktreePath)} push --no-verify ${escapeShellArg(target.remote)} HEAD:${escapeShellArg(pushTarget)}`
    );
  });
}

/**
 * Rewrite a project's worklog data ref so it contains ONLY the given JSONL,
 * force-pushing a fresh orphan commit that bypasses the polluted remote history.
 *
 * This is the remote-ref cleanup half of `wl doctor foreign-items --apply --push`.
 * Unlike `gitPushDataFileToBranch` (which fetches and merges the remote ref
 * first — re-importing foreign items), this function NEVER fetches the remote:
 * it creates an orphan branch containing only the clean JSONL, force-pushes it
 * to `refs/worklog/data`, and updates the local tracking ref to match.
 *
 * Safety: rejects pushes to regular branches/tags (only dedicated refs under
 * `refs/worklog/` are allowed), matching `gitPushDataFileToBranch`.
 *
 * @param repoDataFilePath - Path to the clean JSONL file to publish.
 * @param commitMessage - Commit message for the rewritten ref.
 * @param target - Git remote + branch/ref target.
 * @returns The SHA of the rewritten ref tip.
 */
export async function rewriteAndForcePushDataFile(
  repoDataFilePath: string,
  commitMessage: string,
  target: GitTarget
): Promise<string> {
  // Cross-project safety guard: never push a data file to a different
  // repository's remote ref than the one owning the file.
  await assertDataFileInCwdRepo(repoDataFilePath);

  // SAFETY GUARD: reject pushes to regular branches or tags.
  // Worklog data must only be stored on dedicated refs under refs/worklog/.
  const branch = target.branch;
  if (branch.startsWith('refs/heads/') || branch.startsWith('refs/tags/')) {
    throw new Error(
      `Refusing to push worklog data to '${branch}'. ` +
      `Worklog data must be pushed to a dedicated ref under refs/worklog/ ` +
      `(e.g. refs/worklog/data).`
    );
  }

  await execAsync('git rev-parse --git-dir');

  const repoRootPath = await getRepoRoot();
  const { relativePath } = getRepoRelativePath(repoRootPath, repoDataFilePath);
  const srcAbsPath = path.resolve(repoDataFilePath);

  if (!fs.existsSync(srcAbsPath)) {
    throw new Error(`Worklog data file not found: ${srcAbsPath}`);
  }

  const remoteTrackingRef = getRemoteTrackingRef(target.remote, branch);
  const pushTarget = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  let tipSha = '';

  await withTempWorktree(repoRootPath, target, async (worktreePath) => {
    const dstAbsPath = path.join(worktreePath, relativePath);
    ensureDir(path.dirname(dstAbsPath));
    fs.copyFileSync(srcAbsPath, dstAbsPath);

    const escapedMsg = escapeShellArg(commitMessage);
    const escapedRel = escapeShellArg(relativePath);

    // Stage and commit only the JSONL file (force-add: .worklog/ is gitignored).
    await execAsync(`git -C ${escapeShellArg(worktreePath)} add -f -- ${escapedRel}`);
    const { stdout: staged } = await execAsync(
      `git -C ${escapeShellArg(worktreePath)} diff --cached --name-only -- ${escapedRel}`
    );
    if (!staged.trim()) {
      throw new Error('Nothing staged for the rewrite; aborting to avoid an empty ref');
    }

    await execAsync(`git -C ${escapeShellArg(worktreePath)} commit -m ${escapedMsg}`);

    // Force-push the orphan commit, replacing the polluted remote ref entirely.
    await execAsync(
      `git -C ${escapeShellArg(worktreePath)} push --force --no-verify ${escapeShellArg(target.remote)} HEAD:${escapeShellArg(pushTarget)}`
    );

    const { stdout } = await execAsync(`git -C ${escapeShellArg(worktreePath)} rev-parse HEAD`);
    tipSha = stdout.trim();
  }, { forceOrphan: true });

  // Update the local tracking ref so a subsequent `wl sync` reads the clean
  // ref (refs/worklog/remotes/<remote>/...) instead of the polluted one.
  if (tipSha) {
    await execAsync(`git update-ref ${escapeShellArg(remoteTrackingRef)} ${escapeShellArg(tipSha)}`);
  }

  return tipSha;
}
