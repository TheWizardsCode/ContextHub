/**
 * Sync functionality for merging local and remote work items with conflict resolution.
 *
 * Shared type declarations live in `./sync/types.js`, git subprocess plumbing
 * in `./sync/git-exec.js`, the merge decision predicates in
 * `./sync/merge-predicates.js`, the field-level merge implementations in
 * `./sync/field-merge.js`, the public merge entry point in `./sync/merge.js`
 * and the collateral (comment / audit-result / dependency-edge) merges in
 * `./sync/merge-collateral.js` (WL-0MVP9QLWU003NV41); the public names are
 * re-exported below so the surface of this module is unchanged.
 */

import { WorkItem, Comment, DependencyEdge, AuditResult } from './types.js';
import type { ClaimHoldDecision } from './claim-hold.js';
import type { SyncPhaseTimings } from './sync-phase-timings.js';
import { importFromJsonlContent } from './jsonl.js';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { withinWorktreeContext, killProcessesForWorktree } from './process-lifecycle.js';
import { gitExecAsync, execAsync, execGitCaptureStdout, escapeShellArg } from './sync/git-exec.js';
import type {
  GitTarget,
  IncomingCommit,
  SyncAllowedAuthors,
  AuthorIdentityOptions,
  AuthorIdentityViolation,
  AuthorIdentityResult,
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


/**
 * Cross-project prefix filter (SA-0MSC0BM1V0032UYT) — defense-in-depth.
 *
 * `assertDataFileInCwdRepo` (WL-0MSAH26DD001XXST) blocks syncs whose data
 * file lives in a different git repo than the process cwd, but a stale
 * long-running process (loaded pre-fix modules) or a bypassed repo-context
 * check can still reach the merge step with foreign data. This filter makes
 * the merge itself prefix-aware: work items whose ID prefix does not match
 * the project prefix are never imported, and their comments, dependency
 * edges and audit results are dropped with them.
 *
 * IDs without a '-' separator cannot be classified and are kept, matching
 * `wl doctor foreign-items` behaviour.
 *
 * @param id - The work item ID (e.g. `WL-0MSAH2A71000MUA3`).
 * @param projectPrefix - The project's configured prefix (e.g. `WL`), matched case-insensitively.
 * @returns True when the item belongs to the project (or is unclassifiable).
 */
export function isOwnProjectItemId(id: string, projectPrefix: string): boolean {
  const dash = id.indexOf('-');
  if (dash <= 0) {
    return true; // no dash, or leading dash — cannot be classified (consistent with doctor)
  }
  return id.slice(0, dash).toUpperCase() === projectPrefix.toUpperCase();
}

/**
 * Filter remote sync data so only records belonging to the project prefix
 * can enter the merge. Comments, dependency edges and audit results that
 * reference dropped foreign items are removed with them.
 *
 * @param items - Remote work items fetched from the remote ref.
 * @param comments - Remote comments.
 * @param edges - Remote dependency edges.
 * @param audits - Remote audit results.
 * @param projectPrefix - The project's configured prefix (case-insensitive).
 * @returns The filtered sets plus the IDs of dropped foreign items (for observability).
 */
export function filterRemoteDataByPrefix(
  items: WorkItem[],
  comments: Comment[],
  edges: DependencyEdge[],
  audits: AuditResult[],
  projectPrefix: string
): {
  items: WorkItem[];
  comments: Comment[];
  edges: DependencyEdge[];
  audits: AuditResult[];
  droppedItems: string[];
} {
  const allowedItemIds = new Set<string>();
  const keptItems: WorkItem[] = [];
  const droppedItems: string[] = [];

  for (const item of items) {
    if (isOwnProjectItemId(item.id, projectPrefix)) {
      allowedItemIds.add(item.id);
      keptItems.push(item);
    } else {
      droppedItems.push(item.id);
    }
  }

  const keptComments = comments.filter(c => allowedItemIds.has(c.workItemId));
  const keptEdges = edges.filter(e => allowedItemIds.has(e.fromId) && allowedItemIds.has(e.toId));
  const keptAudits = audits.filter(a => allowedItemIds.has(a.workItemId));

  return {
    items: keptItems,
    comments: keptComments,
    edges: keptEdges,
    audits: keptAudits,
    droppedItems,
  };
}

/**
 * Sync author-identity gate (WL-0MSOYWWS4009HTCB).
 *
 * Refuses to merge worklog data when the remote ref contains commits authored
 * by an identity other than the store's configured identity — a second store
 * with an empty/foreign git identity can otherwise silently overwrite work
 * items and invalidate audits. Pure + deterministic: the same input always
 * yields the same result, so dry-run and normal syncs report the same refusal.
 */

/** Normalize email for comparison: trimmed, lowercased. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Resolve whether whitelist allows all authors. */
function isAllowAllAuthors(allowedAuthors: SyncAllowedAuthors | undefined, allowForeignAuthor: boolean): boolean {
  if (allowForeignAuthor) return true;
  if (allowedAuthors === null || allowedAuthors === true) return true;
  return false;
}

/** Check if email is in whitelist (case-insensitive, trimmed). Always false for empty/allow-all. */
function isEmailWhitelisted(email: string, allowedAuthors: SyncAllowedAuthors | undefined): boolean {
  if (!Array.isArray(allowedAuthors) || allowedAuthors.length === 0) return false;
  const normalized = normalizeEmail(email);
  return allowedAuthors.some((entry) => typeof entry === 'string' && normalizeEmail(entry) === normalized);
}


/**
 * Inspect the author emails of commits on the remote tracking ref since the
 * last-known sync point (parent AC1):
 *
 *   git log <remoteTrackingRef> --format=%h%x09%ae [--not <lastSyncedRef>]
 *
 * The combined `%h%x09%ae` format carries both the short hash and the author
 * email per line (a superset of `--format=%ae`) so the gate can name offending
 * commits in its refusal message. When `lastSyncedRef` is absent/invalid the
 * whole remote ref history is scanned (no `--not` exclusion).
 */
export async function getRemoteAuthorCommits(
  remoteTrackingRef: string,
  lastSyncedRef?: string
): Promise<IncomingCommit[]> {
  const args = ['log', remoteTrackingRef, '--format=%h%x09%ae'];
  if (lastSyncedRef && lastSyncedRef.trim()) {
    args.push('--not', lastSyncedRef.trim());
  }

  let stdout: string;
  try {
    stdout = await execGitCaptureStdout(args);
  } catch {
    // Unreadable/missing ref → no incoming commits to gate.
    return [];
  }

  const commits: IncomingCommit[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [hash, email] = line.split('\t');
    commits.push({ hash: hash || '', authorEmail: email ?? '' });
  }
  return commits;
}

/**
 * Pure gate decision over the incoming commits (parent AC2/AC3 + plan Q2/Q3):
 *
 *   - EMPTY author email → unconditional refusal. `allowForeignAuthor` never
 *     bypasses the empty-email gate (Q3).
 *   - email differs from `expectedAuthorEmail` → refused by default; allowed
 *     when `allowForeignAuthor=true`.
 *   - `expectedAuthorEmail` undefined (user.email unset) → only the
 *     empty-email gate applies; the foreign-email comparison is skipped (Q2).
 *
 * The refusal message names the offending commit(s) and the remote ref.
 */
export function checkAuthorIdentity(
  commits: IncomingCommit[],
  options: AuthorIdentityOptions
): AuthorIdentityResult {
  const { remoteTrackingRef, expectedAuthorEmail, allowForeignAuthor = false, allowedAuthors } = options;
  const violations: AuthorIdentityViolation[] = [];
  const allowAll = isAllowAllAuthors(allowedAuthors, allowForeignAuthor);

  for (const commit of commits) {
    const email = (commit.authorEmail || '').trim();
    if (email === '') {
      violations.push({ commit: commit.hash, authorEmail: '', reason: 'empty-email' });
    } else if (allowAll) {
      // allow-all (whitelist null/true or CLI flag) — skip foreign check, empty already handled
      continue;
    } else if (expectedAuthorEmail !== undefined) {
      const matchesExpected = normalizeEmail(email) === normalizeEmail(expectedAuthorEmail);
      const whitelisted = isEmailWhitelisted(email, allowedAuthors);
      if (!matchesExpected && !whitelisted) {
        violations.push({ commit: commit.hash, authorEmail: email, reason: 'foreign-email' });
      }
    }
    // expectedAuthorEmail undefined -> only empty gate applies (already handled)
  }

  const allowed = violations.length === 0;
  const message = allowed ? '' : buildIdentityRefusalMessage(remoteTrackingRef, violations, expectedAuthorEmail);
  return { allowed, violations, message };
}

function buildIdentityRefusalMessage(
  remoteTrackingRef: string,
  violations: AuthorIdentityViolation[],
  expectedAuthorEmail: string | undefined
): string {
  const detailLines = violations.map(v =>
    v.reason === 'empty-email'
      ? `- ${v.commit}: empty author email`
      : `- ${v.commit}: author email '${v.authorEmail}' does not match configured user.email '${expectedAuthorEmail}'`
  );
  return (
    `Refusing to merge worklog data from ${remoteTrackingRef}: ` +
    `${violations.length} incoming commit(s) fail the author-identity gate.\n` +
    detailLines.join('\n')
  );
}

/**
 * Read the repo's configured `user.email` (the store identity the gate
 * compares incoming commit authors against). Returns undefined when the key
 * is unset or git is unavailable — the caller then skips the foreign-email
 * comparison entirely (plan Q2) while still enforcing the empty-email gate.
 */
export async function getConfiguredUserEmail(): Promise<string | undefined> {
  try {
    const { stdout } = await gitExecAsync('git config user.email');
    const email = stdout.trim();
    return email || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Path of the last-synced-ref state file (mirrors the last-sync-time
 * pattern). Persists the remote tracking ref tip after each successful
 * non-dry-run sync so the next sync only inspects commits since that point.
 */
export function getLastSyncedRefPath(dataFilePath: string): string {
  return path.join(path.dirname(dataFilePath), 'last-synced-ref');
}

/**
 * Read the last-known sync point (remote tracking ref tip). Returns undefined
 * when the state file is absent, empty, or unreadable — the gate then scans
 * the whole remote ref history.
 */
export function readLastSyncedRef(dataFilePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(getLastSyncedRefPath(dataFilePath), 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the last-known sync point after a successful non-dry-run sync.
 */
export function writeLastSyncedRef(dataFilePath: string, refSha: string): void {
  try {
    fs.writeFileSync(getLastSyncedRefPath(dataFilePath), `${refSha}\n`, 'utf8');
  } catch {
    // Non-critical state file; a failed write only means the next sync scans
    // more history than necessary (the gate still runs).
  }
}

/**
 * Resolve the tip SHA of the remote tracking ref (used to persist
 * last-synced-ref). Returns undefined when the ref cannot be resolved.
 */
export async function getRemoteTrackingRefSha(remoteTrackingRef: string): Promise<string | undefined> {
  try {
    const { stdout } = await gitExecAsync(`git rev-parse ${escapeShellArg(remoteTrackingRef)}`);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wire the author-identity gate into a sync flow (parent AC4): inspect the
 * incoming commits on the remote tracking ref since the last sync point and
 * throw a refusal error naming the offending commit(s) + remote ref when the
 * gate fails. Runs after the remote fetch, before any merge/import
 * side-effects. Dry-run and normal modes report the refusal identically.
 */
export async function enforceAuthorIdentityGate(
  remoteTrackingRef: string,
  dataFilePath: string,
  options: { expectedAuthorEmail?: string; allowForeignAuthor?: boolean; allowedAuthors?: SyncAllowedAuthors }
): Promise<void> {
  const lastSyncedRef = readLastSyncedRef(dataFilePath);
  const commits = await getRemoteAuthorCommits(remoteTrackingRef, lastSyncedRef);
  const result = checkAuthorIdentity(commits, {
    remoteTrackingRef,
    expectedAuthorEmail: options.expectedAuthorEmail,
    allowForeignAuthor: options.allowForeignAuthor,
    allowedAuthors: options.allowedAuthors,
  });
  if (!result.allowed) {
    throw new Error(result.message);
  }
}
async function getRepoRoot(): Promise<string> {
  const { stdout } = await execAsync('git rev-parse --show-toplevel');
  return stdout.trim();
}

/**
 * Find the git repo root that owns `filePath` (by running git from the file's
 * directory). Returns null when the file is not inside a git repository.
 */
async function getRepoRootForPath(filePath: string): Promise<string | null> {
  const dir = path.dirname(path.resolve(filePath));
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: dir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Cross-project sync guard (WL-0MSAH26DD001XXST).
 *
 * `wl sync --worklog-dir <proj>/.worklog` run from inside a DIFFERENT git
 * repo used to fetch the cwd repo's remote worklog ref (because the `-f`
 * default was resolved from the cwd before the override applied) and merge
 * it into <proj>'s database, then push the polluted union back to <proj>'s
 * remote. This guard fails loudly whenever the data file lives in a
 * different git repository than the process cwd, so a sync can never merge
 * foreign-prefix items from another project.
 */
export async function assertDataFileInCwdRepo(dataFilePath: string): Promise<void> {
  let cwdRepoRoot: string | null = null;
  try {
    cwdRepoRoot = (await getRepoRoot()).trim() || null;
  } catch {
    // cwd is not inside a git repository; existing code paths report that.
  }

  const dataRepoRoot = await getRepoRootForPath(dataFilePath);

  if (cwdRepoRoot && dataRepoRoot && cwdRepoRoot !== dataRepoRoot) {
    throw new Error(
      `Cross-project sync blocked: data file '${dataFilePath}' belongs to git repository '${dataRepoRoot}', ` +
      `but this command is running inside git repository '${cwdRepoRoot}'. ` +
      `Merging would combine two projects' worklog data (WL-0MSAH26DD001XXST). ` +
      `Run 'wl sync' from inside '${dataRepoRoot}' or remove the --worklog-dir flag.`
    );
  }
  if (cwdRepoRoot && !dataRepoRoot) {
    throw new Error(
      `Cross-project sync blocked: data file '${dataFilePath}' is not inside a git repository, ` +
      `but this command is running inside git repository '${cwdRepoRoot}'. ` +
      `Run 'wl sync' from inside a directory in the same repository as '${dataFilePath}'.`
    );
  }
  if (!cwdRepoRoot && dataRepoRoot) {
    throw new Error(
      `Cross-project sync blocked: data file '${dataFilePath}' belongs to git repository '${dataRepoRoot}', ` +
      `but the current directory is not inside a git repository. ` +
      `Run 'wl sync' from inside '${dataRepoRoot}'.`
    );
  }
}

async function fetchRemote(remote: string): Promise<void> {
  await execAsync(`git fetch ${escapeShellArg(remote)}`);
}

function getRemoteTrackingRef(remote: string, branchOrRef: string): string {
  // For a named branch like "worklog-data", track it as refs/remotes/origin/worklog-data.
  // For an explicit ref like "refs/worklog/data", DO NOT track it under refs/remotes/...
  // because that namespace is reserved for remote-tracking branches and can collide with
  // real branches like "worklog/data" and/or reject non-fast-forward updates.
  //
  // Instead, keep a local-only tracking ref under refs/worklog/remotes/<remote>/...
  if (branchOrRef.startsWith('refs/')) {
    const suffix = branchOrRef.slice('refs/'.length);
    return `refs/worklog/remotes/${remote}/${suffix}`;
  }

  return `refs/remotes/${remote}/${branchOrRef}`;
}

// Exposed for unit tests.
export const _testOnly_getRemoteTrackingRef = getRemoteTrackingRef;

async function refExists(ref: string): Promise<boolean> {
  try {
    await execAsync(`git show-ref --verify --quiet ${escapeShellArg(ref)}`);
    return true;
  } catch {
    return false;
  }
}

async function fetchTargetRef(target: GitTarget): Promise<{ hasRemote: boolean; remoteTrackingRef: string }> {
  const remoteTrackingRef = getRemoteTrackingRef(target.remote, target.branch);

  if (target.branch.startsWith('refs/')) {
    // Default git fetch refspec does not include custom refs/*, so fetch it explicitly.
    // If it doesn't exist yet, treat as "no remote".
    try {
      await execAsync(
        // Force-update the local tracking ref so stale/colliding local refs don't block sync.
        `git fetch ${escapeShellArg(target.remote)} ${escapeShellArg(`+${target.branch}:${remoteTrackingRef}`)}`
      );
    } catch {
      // Avoid silently treating fetch failures as "ref missing"; that can lead to overwriting
      // an existing remote data ref from an orphan branch.
      let remoteExists = false;
      try {
        const { stdout } = await execAsync(
          `git ls-remote --exit-code ${escapeShellArg(target.remote)} ${escapeShellArg(target.branch)}`
        );
        remoteExists = !!stdout.trim();
      } catch {
        remoteExists = false;
      }

      if (remoteExists) {
        throw new Error(`Failed to fetch existing remote ref ${target.branch} from ${target.remote}`);
      }

      return { hasRemote: false, remoteTrackingRef };
    }

    const hasRemote = await refExists(remoteTrackingRef);
    if (!hasRemote) {
      // If the remote ref exists but we can't materialize a local tracking ref,
      // treat it as an error to avoid overwriting the remote from an orphan branch.
      let remoteExists = false;
      try {
        const { stdout } = await execAsync(
          `git ls-remote --exit-code ${escapeShellArg(target.remote)} ${escapeShellArg(target.branch)}`
        );
        remoteExists = !!stdout.trim();
      } catch {
        remoteExists = false;
      }

      if (remoteExists) {
        throw new Error(`Failed to create local tracking ref for ${target.branch} from ${target.remote}`);
      }
    }

    return { hasRemote, remoteTrackingRef };
  }

  // Standard branch fetch. This will populate refs/remotes/<remote>/<branch>.
  await execAsync(`git fetch ${escapeShellArg(target.remote)} ${escapeShellArg(target.branch)}`);
  return { hasRemote: await refExists(remoteTrackingRef), remoteTrackingRef };
}

function getRepoRelativePath(repoRootPath: string, filePath: string): { absolutePath: string; relativePath: string } {
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(repoRootPath, absolutePath);
  return { absolutePath, relativePath };
}

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

function removeWorktreeFiles(worktreePath: string): void {
  for (const name of fs.readdirSync(worktreePath)) {
    if (name === '.git') continue;
    fs.rmSync(path.join(worktreePath, name), { recursive: true, force: true });
  }
}

async function listTrackedFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await execAsync(`git -C ${escapeShellArg(worktreePath)} ls-files -z`);
  if (!stdout) return [];
  return stdout.split('\0').map(s => s.trim()).filter(Boolean);
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function withTempWorktree<T>(
  repoRootPath: string,
  target: GitTarget,
  run: (worktreePath: string) => Promise<T>,
  options?: { forceOrphan?: boolean }
): Promise<T> {
  const worklogDir = path.join(repoRootPath, '.worklog');
  ensureDir(worklogDir);

  const tmpRoot = fs.mkdtempSync(path.join(worklogDir, 'tmp-worktree-'));
  const worktreePath = path.join(tmpRoot, 'wt');

  // When forceOrphan is set (ref rewrite), bypass the remote fetch entirely:
  // fetching the polluted remote ref would re-import foreign items into the
  // local tracking ref. Instead create a fresh orphan branch from HEAD.
  const { hasRemote, remoteTrackingRef } = options?.forceOrphan
    ? { hasRemote: false, remoteTrackingRef: '' }
    : await fetchTargetRef(target);
  const baseRef = hasRemote ? remoteTrackingRef : 'HEAD';

  try {
    try {
      await execAsync(`git worktree add --detach ${escapeShellArg(worktreePath)} ${escapeShellArg(baseRef)}`);
    } catch (err) {
      // Unborn-HEAD translation (SA-0MSG57UNY009DE51): when the worktree
      // would be created from local HEAD on a repo with no commits yet, git
      // fails with a cryptic error. Surface an actionable message naming the
      // cause and remedy instead.
      if (baseRef === 'HEAD') {
        const raw = (err as Error).message || '';
        if (/HEAD/.test(raw) && /(not a commit|invalid reference|cannot be created from|not a valid object name)/i.test(raw)) {
          throw new Error(
            'Cannot sync: this repository has no commits yet, so git cannot create ' +
            'a temporary worktree from HEAD. Create an initial commit first ' +
            '(e.g. `git commit --allow-empty -m "chore: initial"`), or run ' +
            '`wl sync --no-push` to keep worklog data local.'
          );
        }
      }
      throw err;
    }

    // If remote branch doesn't exist, create an orphan branch in the temp worktree.
    if (!hasRemote) {
      // Create an orphan local branch name; it doesn't need to include refs/.
      const localBranchName = target.branch.startsWith('refs/') ? target.branch.slice('refs/'.length) : target.branch;

      // If the local branch already exists (e.g. from a previous sync), delete it
      // first so that `checkout --orphan` can succeed.
      try {
        await execAsync(`git show-ref --verify --quiet ${escapeShellArg('refs/heads/' + localBranchName)}`);
        // Branch exists — delete it so the orphan checkout below can recreate it.
        await execAsync(`git branch -D ${escapeShellArg(localBranchName)}`);
      } catch {
        // Branch does not exist — this is the first sync, proceed normally.
      }

      await execAsync(`git -C ${escapeShellArg(worktreePath)} checkout --orphan ${escapeShellArg(localBranchName)}`);
      // `checkout --orphan` keeps the index populated with the previously checked-out files.
      // Clear the index + working tree so the branch starts empty.
      try {
        await execAsync(`git -C ${escapeShellArg(worktreePath)} rm -rf .`);
      } catch {
        // ignore
      }
      removeWorktreeFiles(worktreePath);
      try {
        await execAsync(`git -C ${escapeShellArg(worktreePath)} clean -fdx`);
      } catch {
        // ignore
      }
    }

    // Set worktree context so that any child processes spawned inside
    // `run()` are automatically registered with the process lifecycle
    // module for cleanup.
    const restore = withinWorktreeContext(worktreePath);
    try {
      return await run(worktreePath);
    } finally {
      restore();
    }
  } finally {
    // Kill any tracked processes spawned inside the worktree BEFORE
    // removing it, to prevent orphaned processes.
    try {
      killProcessesForWorktree(worktreePath);
    } catch {
      // ignore — best-effort cleanup
    }
    try {
      await execAsync(`git worktree remove --force ${escapeShellArg(worktreePath)}`);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
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
