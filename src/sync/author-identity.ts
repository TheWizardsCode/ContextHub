/**
 * src/sync/author-identity.ts — the sync author-identity gate.
 *
 * Concern: refusing to merge worklog data when the remote ref contains
 * commits authored by an identity other than the store's configured identity
 * (WL-0MSOYWWS4009HTCB) — a second store with an empty/foreign git identity
 * can otherwise silently overwrite work items and invalidate audits. Pure +
 * deterministic: the same input always yields the same result, so dry-run and
 * normal syncs report the same refusal.
 *
 * Extracted verbatim from `src/sync.ts` (WL-0MVP9R3PU004EGYE, child 4 of 6 of
 * the WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). The four public
 * functions are re-exported from the barrel; `normalizeEmail`,
 * `isAllowAllAuthors`, `isEmailWhitelisted` and `buildIdentityRefusalMessage`
 * are module-private helpers and are NOT part of the `./sync.js` public
 * surface.
 */

import { gitExecAsync, execGitCaptureStdout } from './git-exec.js';
import type {
  IncomingCommit,
  SyncAllowedAuthors,
  AuthorIdentityOptions,
  AuthorIdentityViolation,
  AuthorIdentityResult,
} from './types.js';
import { readLastSyncedRef } from './refs.js';

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
