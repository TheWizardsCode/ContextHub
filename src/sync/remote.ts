/**
 * src/sync/remote.ts — remote worklog-ref reading and delta replay.
 *
 * Concern: materialising the remote worklog ref (`refs/worklog/remotes/…`),
 * reading the serialized JSONL at it (full snapshot or delta), and — for a
 * reader with no full-snapshot base — walking the remote ref history and
 * replaying each commit's JSONL in order so a delta tip can be applied on the
 * newest full snapshot (WL-0MT2KZ5GJ000OJIP, design §6.2 trigger 1).
 *
 * Extracted verbatim from `src/sync.ts` (WL-0MVP9RW4Z006VLW1, child 5 of 6 of
 * the WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). The three public
 * helpers are re-exported from the barrel; this module imports only
 * lower-layer modules (`./refs.js`, `./repo-context.js`, `./git-exec.js`,
 * `./merge*.js` and `../jsonl.js`) so the layering stays acyclic.
 */

import { WorkItem, Comment, DependencyEdge, AuditResult } from '../types.js';
import { importFromJsonlContent } from '../jsonl.js';
import { execAsync, execGitCaptureStdout, escapeShellArg } from './git-exec.js';
import { fetchTargetRef } from './refs.js';
import { getRepoRoot, getRepoRelativePath, assertDataFileInCwdRepo } from './repo-context.js';
import type {
  GitTarget,
  DeltaReplayResult,
} from './types.js';
import { mergeWorkItems } from './merge.js';
import { mergeComments, mergeAuditResults, mergeDependencyEdges } from './merge-collateral.js';

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
